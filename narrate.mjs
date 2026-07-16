#!/usr/bin/env node
// narrate — turn a document into a narrated audio file with Gemini TTS.
// Zero dependencies: native fetch + the system ffmpeg/pdftotext binaries.
//
//   node narrate.mjs <input.(pdf|md|txt|html)> [options]
//
// See `--help` for options, or the README for the full walkthrough.

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { extractText } from './lib/extract.mjs';
import { chunkText } from './lib/chunk.mjs';
import { ttsSingle, writeWav } from './lib/tts.mjs';
import { concatWavs, normalizeToMp3, probeDuration } from './lib/audio.mjs';

const MODEL = 'gemini-3.1-flash-tts-preview';
const DEFAULT_VOICE = 'Sadachbia'; // warm, professorial; see README for the full list
const DEFAULT_LOUDNESS = -16; // LUFS — spoken-word/podcast standard

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i++; }
    } else args._.push(a);
  }
  return args;
}

const HELP = `narrate — document -> narrated audio (Gemini TTS)

Usage:
  node narrate.mjs <input> [options]
  node narrate.mjs "some text to narrate" [options]

Input:
  A path to a .pdf, .md, .txt, or .html file — or text typed directly.
  If the argument isn't an existing file it's narrated as-is (also --text "…").

Options:
  --text <text>      Narrate this text directly (overrides the positional input).
  --out <file>       Output MP3 (default: <input-basename-or-text-slug>.mp3).
  --lang <language>  Narration language, e.g. "English", "pt-BR", "Spanish".
                     Default: auto (Gemini infers it from the text). Set this
                     when the text is short/ambiguous or to pin the accent.
  --voice <name>     Gemini prebuilt voice (default: ${DEFAULT_VOICE}).
  --style <text>     Extra style/direction, e.g. "calm, contemplative pace".
                     Prepended (unspoken) to guide delivery.
  --loudness <LUFS>  Target loudness (default: ${DEFAULT_LOUDNESS}; use -14 for YouTube).
  --model <id>       TTS model (default: ${MODEL}).
  --key <ENV_VAR>    Env var holding the API key (default: GEMINI_API_KEY).
                     Falls back to ~/.env if not set in the environment.
  --concurrency <n>  Parallel TTS calls (default: 2).
  --workdir <dir>    Where per-chunk WAVs are cached (default: <out>.chunks/).
                     Kept between runs so a re-run resumes instead of redoing.
  --help             Show this help.

Examples:
  node narrate.mjs report.pdf --lang English
  node narrate.mjs chapter.md --lang pt-BR --voice Kore --out chapter.mp3
  node narrate.mjs "Era uma vez um cara muito legal." --lang pt-BR
`;

// Filename-safe slug from the first few words of inline text.
function slug(text) {
  const s = text
    .toLowerCase()
    .normalize('NFD') // split accents off base letters; [^a-z0-9] then drops them
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 5)
    .join('-');
  return s || 'narration';
}

// Style header prepended (unspoken) to every chunk. Kept byte-identical across
// chunks so the voice timbre stays consistent along a long document.
function buildHeader({ lang, style }) {
  if (!lang && !style) return '';
  const lines = [
    'Style instructions for the narration below (do not read these words aloud, they are direction only):',
  ];
  if (lang) lines.push(`Narrate in ${lang}.`);
  if (style) lines.push(style);
  lines.push('', 'Transcript:', '');
  return lines.join('\n');
}

function getApiKey(varName) {
  if (process.env[varName]) return process.env[varName];
  try {
    const line = readFileSync(join(homedir(), '.env'), 'utf8')
      .split('\n')
      .find((l) => l.startsWith(`${varName}=`));
    if (line) return line.slice(varName.length + 1).trim().replace(/^["']|["']$/g, '');
  } catch { /* no ~/.env */ }
  return null;
}

// Run `worker` over items with at most `n` in flight. Returns results in order.
async function pool(items, n, worker) {
  const results = new Array(items.length);
  let i = 0;
  async function run() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._.length === 0) {
    process.stdout.write(HELP);
    process.exit(args.help ? 0 : 1);
  }

  // Input is a file path OR text typed directly. If the first argument is an
  // existing file, read it; otherwise treat --text (or the words) as the text.
  const firstArg = args._[0];
  const asPath = firstArg ? resolve(firstArg) : null;
  const isFile = asPath && existsSync(asPath) && statSync(asPath).isFile();

  let text;
  let baseName;
  if (typeof args.text === 'string') {
    text = args.text;
    baseName = slug(text);
  } else if (isFile) {
    console.log(`[narrate] extracting text from ${basename(asPath)}…`);
    text = extractText(asPath);
    baseName = basename(asPath, extname(asPath));
  } else if (args._.length) {
    text = args._.join(' ');
    baseName = slug(text);
  } else {
    throw new Error('nothing to narrate — pass a file path or some text (or --text "…").');
  }
  if (!text.trim()) throw new Error('no text to narrate (input was empty).');

  const out = resolve(args.out || `${baseName}.mp3`);
  const workdir = resolve(args.workdir || `${out}.chunks`);
  const voice = args.voice || DEFAULT_VOICE;
  const model = args.model || MODEL;
  const loudness = Number(args.loudness ?? DEFAULT_LOUDNESS);
  const concurrency = Math.max(1, Number(args.concurrency ?? 2));
  const keyVar = args.key || 'GEMINI_API_KEY';
  const maxRetries = 5;

  const apiKey = getApiKey(keyVar);
  if (!apiKey) throw new Error(`API key not found. Set ${keyVar} in the environment or ~/.env.`);

  const header = buildHeader({ lang: args.lang && String(args.lang), style: args.style && String(args.style) });

  const chunks = chunkText(text);
  const totalChars = chunks.reduce((n, c) => n + c.length, 0);
  if (!chunks.length) throw new Error('no text extracted from input');
  console.log(`[narrate] ${chunks.length} chunks, ${totalChars} chars. voice=${voice}, model=${model}`);
  mkdirSync(workdir, { recursive: true });

  const t0 = Date.now();
  const failures = [];
  const wavPaths = await pool(chunks, concurrency, async (chunk, idx) => {
    const n = idx + 1;
    const wav = join(workdir, `chunk_${String(n).padStart(3, '0')}.wav`);
    if (existsSync(wav)) {
      console.log(`[narrate] chunk ${n}/${chunks.length} cached, reusing.`);
      return wav;
    }
    // Timeout scales with chunk size (denser text takes longer to synthesize).
    const timeoutMs = Math.max(90000, chunk.length * 60);
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[narrate] chunk ${n}/${chunks.length} (${chunk.length} chars), attempt ${attempt}…`);
        const pcm = await ttsSingle({ text: header + chunk, voice, model, apiKey, timeoutMs });
        writeWav(wav, pcm);
        return wav;
      } catch (e) {
        console.log(`[narrate] chunk ${n} attempt ${attempt} failed: ${e.message.slice(0, 120)}`);
        await sleep(3000 * attempt); // backoff (also eases transient 429s)
      }
    }
    failures.push(n);
    return null;
  });

  if (failures.length) {
    console.error(`\n[narrate] ${failures.length} chunk(s) failed after retries: ${failures.join(', ')}`);
    console.error('[narrate] Re-run the same command to resume — cached chunks are reused.');
    process.exit(1);
  }

  const fullWav = join(workdir, '_full.wav');
  console.log(`[narrate] concatenating ${wavPaths.length} chunks…`);
  concatWavs(wavPaths, fullWav);

  console.log(`[narrate] normalizing to ${loudness} LUFS and encoding MP3…`);
  normalizeToMp3(fullWav, out, loudness);

  const dur = probeDuration(out);
  const mm = Math.floor(dur / 60);
  const ss = String(Math.floor(dur % 60)).padStart(2, '0');
  console.log(`\n[narrate] done -> ${out}`);
  console.log(`[narrate] duration ${mm}:${ss} · ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min to generate`);
  console.log(`[narrate] chunk cache kept at ${workdir} (delete to force a full re-run).`);
}

if (resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(`[narrate] error: ${e.message}`);
    process.exit(1);
  });
}
