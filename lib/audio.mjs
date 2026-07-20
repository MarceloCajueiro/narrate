// ffmpeg glue: concatenate the per-chunk WAVs and loudness-normalize to MP3.
// Uses the system `ffmpeg`/`ffprobe` binaries — no audio libraries.

import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';

function ffmpeg(args) {
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.error && r.error.code === 'ENOENT') {
    throw new Error('ffmpeg not found — install it ("brew install ffmpeg").');
  }
  if (r.status !== 0) {
    throw new Error(`ffmpeg failed: ${(r.stderr || '').slice(-500)}`);
  }
  return r;
}

// Concatenate WAV chunks into one WAV. Re-encodes (not -c copy) so the output
// header/duration are correct regardless of per-chunk quirks.
export function concatWavs(wavPaths, outWav) {
  const listFile = `${outWav}.list.txt`;
  const list = wavPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  writeFileSync(listFile, `${list}\n`);
  try {
    ffmpeg([
      '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
      '-c:a', 'pcm_s16le', '-ar', '24000', '-ac', '1', outWav,
    ]);
  } finally {
    unlinkSync(listFile);
  }
}

// Two-pass loudnorm to the target LUFS. The TTS output is ~-23 LUFS (too quiet);
// this brings it to broadcast/podcast level. Pass 1 measures, pass 2 applies the
// measured values (with offset) — the accurate way per ffmpeg docs.
export function normalizeToMp3(inWav, outMp3, lufs = -16) {
  const measure = spawnSync(
    'ffmpeg',
    ['-i', inWav, '-af', `loudnorm=I=${lufs}:TP=-1:LRA=11:print_format=json`, '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 1 << 26 },
  );
  const m = (measure.stderr || '').match(/\{[\s\S]*?\}/);
  if (!m) throw new Error('loudnorm measurement failed (no JSON in ffmpeg output)');
  const s = JSON.parse(m[0]);

  const filter =
    `loudnorm=I=${lufs}:TP=-1:LRA=11:` +
    `measured_I=${s.input_i}:measured_TP=${s.input_tp}:measured_LRA=${s.input_lra}:` +
    `measured_thresh=${s.input_thresh}:offset=${s.target_offset}:print_format=summary`;

  ffmpeg(['-y', '-i', inWav, '-af', filter, '-ar', '44100', '-ac', '2', '-b:a', '192k', outMp3]);
}

export function probeDuration(file) {
  const r = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    { encoding: 'utf8' },
  );
  if (r.error && r.error.code === 'ENOENT') {
    throw new Error('ffprobe not found — install it ("brew install ffmpeg").');
  }
  return parseFloat((r.stdout || '0').trim()) || 0;
}
