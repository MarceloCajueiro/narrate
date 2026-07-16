# narrate

Turn a document into a narrated audio file — **PDF, Markdown, HTML, or plain text → one MP3.**

`narrate` extracts the text, splits it into speakable chunks, synthesizes each with
[Gemini TTS](https://ai.google.dev/gemini-api/docs/speech-generation), and stitches the
result into a single loudness-normalized MP3. It's built for **long** documents: every
chunk is cached, so if a run hits a rate limit you just run it again and it resumes.

- 📄 **PDF / Markdown / HTML / text** in, **MP3** out
- 🗣️ Any [Gemini voice](https://ai.google.dev/gemini-api/docs/speech-generation#voices), any language (`--lang`)
- ♻️ **Resumable** — per-chunk cache; re-run to pick up where it stopped
- 🔊 **Loudness-normalized** to podcast level (−16 LUFS by default)
- 📦 **Zero npm dependencies** — native `fetch` + the system `ffmpeg`/`pdftotext`
- 🤖 Installable as a [Claude Code](https://docs.claude.com/en/docs/claude-code) skill

---

## Requirements

- [Node](https://nodejs.org) v18+ (for native `fetch`) — no `npm install`.
- [`ffmpeg`](https://ffmpeg.org) + `ffprobe` — `brew install ffmpeg`
- [`pdftotext`](https://poppler.freedesktop.org/) — `brew install poppler` (only for PDF input)
- A **Gemini API key** — get one free at [aistudio.google.com/apikey](https://aistudio.google.com/apikey)

Set the key in your environment (or in `~/.env`):

```bash
export GEMINI_API_KEY=your-key-here
```

---

## Quick start

```bash
git clone https://github.com/MarceloCajueiro/narrate.git
cd narrate

# Narrate a PDF in English
node narrate.mjs report.pdf --lang English

# Markdown in Brazilian Portuguese, a specific voice and output path
node narrate.mjs chapter.md --lang pt-BR --voice Kore --out chapter.mp3
```

Output goes to `<input-basename>.mp3` unless you pass `--out`.

---

## Options

| Option | Default | What it does |
|---|---|---|
| `--lang <language>` | auto | Narration language, e.g. `English`, `pt-BR`, `Spanish`. Auto-detected if omitted; set it when the text is short/ambiguous or to pin the accent. |
| `--voice <name>` | `Sadachbia` | Gemini prebuilt voice. [Full list.](https://ai.google.dev/gemini-api/docs/speech-generation#voices) |
| `--style <text>` | — | Extra delivery direction (unspoken), e.g. `"calm, contemplative pace"`. |
| `--out <file>` | `<input>.mp3` | Output MP3 path. |
| `--loudness <LUFS>` | `-16` | Target loudness. Use `-14` for YouTube. |
| `--model <id>` | `gemini-3.1-flash-tts-preview` | TTS model. |
| `--concurrency <n>` | `2` | Parallel TTS calls. |
| `--workdir <dir>` | `<out>.chunks/` | Per-chunk WAV cache (kept between runs to resume). |
| `--key <ENV_VAR>` | `GEMINI_API_KEY` | Env var holding the API key (falls back to `~/.env`). |

A few good voices for narration: `Sadachbia` (warm, professorial), `Kore` (calm),
`Charon` (deep, contemplative), `Algenib` (agile). Language is inferred from the text —
`--lang` mainly helps with short/ambiguous input or accent.

---

## How it works

1. **Extract** — PDF via `pdftotext` (poppler), then reflowed into paragraphs; Markdown/HTML/text parsed directly with markup/tags stripped.
2. **Chunk** — split at paragraph, then sentence, then word boundaries so no chunk exceeds ~2000 chars (denser input makes the TTS endpoint time out).
3. **Synthesize** — one Gemini TTS call per chunk over the REST API. Timeout scales with chunk size; up to 5 retries with backoff to ride out the preview endpoint's occasional hiccups. A fixed, unspoken style header keeps the voice consistent across chunks.
4. **Resume** — each chunk WAV is cached in the workdir; a re-run reuses finished chunks and only redoes the missing ones. Nothing is lost to a mid-run rate limit.
5. **Normalize** — chunks are concatenated and two-pass `loudnorm`-ed to the target LUFS (raw TTS is ~−23 LUFS, too quiet), then encoded to MP3.

---

## Notes & limits

- **Long documents cost time and quota.** A book-length PDF is dozens of TTS calls. On the free tier you may hit the daily/rate limit — the run stops with the failed chunk numbers; **run the same command again** to resume once quota is back (or enable billing).
- **The chunk cache** lives at `<out>.chunks/`. Delete it to force a clean re-run.
- **Voice consistency** relies on the fixed style header being byte-identical across chunks — don't vary `--style`/`--lang` between resumed runs of the same output.
- Content safety filters are disabled so long-form text (books, essays) isn't blocked mid-document. See `lib/tts.mjs` to change that.

---

## Install as a Claude Code skill

```
/plugin marketplace add MarceloCajueiro/narrate
/plugin install narrate@cajueiro-plugins
```

Then ask Claude to "narrate this PDF in English" and it will drive the tool.

---

## License

MIT © Marcelo Cajueiro — [cajueiro.tech](https://cajueiro.tech)
