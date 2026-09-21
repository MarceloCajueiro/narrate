---
name: narrate
description: Turn a document into a narrated audio file (text-to-speech) with Gemini. Extracts text from a PDF, Markdown, HTML, or text file, chunks it, synthesizes each chunk with retry/resume, and loudness-normalizes the result to MP3. Use when the user wants to narrate a document, "read this PDF aloud", make an audiobook or podcast from a file, convert a document/article/report to speech, or generate a voice-over of written text. The narration language is chosen explicitly (or auto-detected).
user_invocable: true
---

# narrate — document → narrated audio (Gemini TTS)

Takes a document and produces a single narrated MP3. Handles the whole pipeline:
text extraction → chunking → per-chunk TTS (with timeout, retry, and resume) →
concatenation → loudness normalization.

## How it works

- **Extract** — PDF via the system `pdftotext` (poppler); Markdown/HTML/text parsed directly. Page numbers and markup are stripped, paragraphs reflowed.
- **Chunk** — split at paragraph/sentence boundaries into ~2000-char pieces (one TTS call each). Denser input times out, so chunks stay small.
- **Synthesize** — each chunk is one Gemini TTS call over the REST API. Timeout scales with chunk size; up to 5 retries with backoff (rides out the preview endpoint's intermittent `no audio` / timeout / transient 429). A fixed, unspoken style header keeps the voice timbre consistent across chunks.
- **Resume** — every chunk WAV is cached in a workdir. Re-running the same command **reuses** finished chunks and only redoes what's missing — so a long document that hits a rate limit just needs a re-run, nothing is lost.
- **Normalize** — chunks are concatenated and loudness-normalized (two-pass `loudnorm`) to the target LUFS, then encoded to MP3. Raw TTS is ~−23 LUFS (too quiet); the default −16 LUFS is spoken-word/podcast level.

## Prerequisites

- `node` (v18+, for native `fetch`) — no `npm install`.
- `ffmpeg` + `ffprobe` (`brew install ffmpeg`).
- `pdftotext` (`brew install poppler`) — only needed for PDF input.
- A **Gemini API key** in `GEMINI_API_KEY` (environment or `~/.env`). Get one at https://aistudio.google.com/apikey.

The script ships inside this skill, next to this file. Run it with the path of the directory this SKILL.md was loaded from - that path is already known and always correct.

## Steps

### 1. Get the input
Either a path to a `.pdf`, `.md`, `.txt`, or `.html` file, **or text directly**. The tool auto-detects: if the argument is an existing file it's read; otherwise it's narrated as-is. So `narrate.mjs "Era uma vez…" --lang pt-BR` works with no file. For long/multi-line text, use `--text "…"` (or still write it to a file).

### 2. Decide the narration language
Ask the user (or infer from the document) which **language** to narrate in, and pass it as `--lang` (e.g. `English`, `pt-BR`, `Spanish`). If the text is long and unambiguously in one language you may omit `--lang` and let Gemini auto-detect — but when in doubt, set it explicitly. This is the one setting worth confirming up front.

### 3. (Optional) Pick a voice and style
Default voice is `Sadachbia` (warm, professorial). Offer alternatives if the tone calls for it — e.g. `Kore` (calm), `Charon` (deep, contemplative), `Algenib` (agile narrator). Full voice list: https://ai.google.dev/gemini-api/docs/speech-generation#voices. Optional `--style "calm, unhurried pace"` refines delivery.

### 4. Run it
```bash
# SKILL_DIR = the directory holding this SKILL.md, i.e. the one you just read
node "$SKILL_DIR/narrate.mjs" <input-or-text> --lang <language> [--voice <name>] [--out <file.mp3>]
```
`<input-or-text>` is a file path or the text itself (auto-detected). When narrating inline text and no `--out` is given, the output filename is derived from the first words of the text.
For a **long** document (tens of chunks), warn the user it can take a while and may hit the free-tier rate limit — if it stops with failures, just run the **same command again** to resume.

### 5. Deliver
Give the user the output MP3 path and its duration (printed at the end). Do not auto-play it.

## Options (see `--help`)

- `--text <text>` — narrate this text directly (instead of a file path).
- `--lang <language>` — narration language (default: auto-detect).
- `--voice <name>` — Gemini prebuilt voice (default: `Sadachbia`).
- `--style <text>` — extra delivery direction, prepended unspoken.
- `--out <file>` — output MP3 (default: `<input-basename>.mp3`).
- `--loudness <LUFS>` — target loudness (default: `-16`; use `-14` for YouTube).
- `--voice`/`--model`/`--concurrency`/`--workdir`/`--key` — see `--help`.

## Fixed decisions (unless the user asks otherwise)

- One self-contained MP3 out; no background music, no video.
- Loudness normalized to −16 LUFS.
- Chunk cache kept next to the output (`<out>.chunks/`) so re-runs resume. Changing the voice, style, language, model or the text itself invalidates it and re-synthesizes; only the *same* command resumes. Mention it can be deleted to force a clean re-run.
