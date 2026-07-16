// Gemini TTS over the REST API — zero dependencies (native fetch + node:fs).
// The model returns raw PCM (16-bit, mono, 24 kHz) as base64; we wrap it in a
// WAV header ourselves so ffmpeg can concat/normalize it downstream.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

// Output format of Gemini TTS (do not change unless the model changes).
const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2; // 16-bit

// Turn off the content filters so legitimate long-form text (books, essays,
// religious or spiritual content) isn't blocked mid-document. Remove if you
// want the model defaults back.
const SAFETY_OFF = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
].map((category) => ({ category, threshold: 'BLOCK_NONE' }));

function pcmToWav(pcm) {
  const blockAlign = CHANNELS * BYTES_PER_SAMPLE;
  const byteRate = SAMPLE_RATE * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// One TTS call. Returns raw PCM bytes. Throws on HTTP error, timeout, or a
// response with no audio (the preview endpoint occasionally returns none).
export async function ttsSingle({ text, voice, model, apiKey, timeoutMs = 90000 }) {
  const url = `${ENDPOINT}/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
    safetySettings: SAFETY_OFF,
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`timeout after ${timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }

  const data = await res.json();
  const b64 = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!b64) {
    const reason = data?.candidates?.[0]?.finishReason ?? data?.promptFeedback?.blockReason ?? 'unknown';
    throw new Error(`no audio in response (reason=${reason})`);
  }
  return Buffer.from(b64, 'base64');
}

export function writeWav(path, pcm) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, pcmToWav(pcm));
}
