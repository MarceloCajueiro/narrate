// Split text into TTS-sized chunks. Each chunk becomes one TTS call, so we keep
// them under ~2000 chars (the endpoint slows/times out on denser input) while
// breaking only at natural boundaries: paragraph first, sentence if a single
// paragraph is too long.

export function chunkText(text, target = 2000) {
  const blocks = text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);

  // Break any paragraph longer than `target` into units, preferring sentence
  // boundaries and falling back to words so no unit ever exceeds `target`.
  const units = [];
  for (const b of blocks) {
    if (b.length <= target) {
      units.push(b);
      continue;
    }
    let cur = '';
    for (const s of b.split(/(?<=[.!?…])\s+/)) {
      for (const piece of s.length > target ? hardSplit(s, target) : [s]) {
        if (cur && cur.length + piece.length + 1 > target) {
          units.push(cur);
          cur = piece;
        } else {
          cur = cur ? `${cur} ${piece}` : piece;
        }
      }
    }
    if (cur) units.push(cur);
  }

  // Pack units into chunks up to `target`.
  const chunks = [];
  let buf = '';
  for (const u of units) {
    if (buf && buf.length + u.length + 1 > target) {
      chunks.push(buf);
      buf = u;
    } else {
      buf = buf ? `${buf}\n${u}` : u;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

// Last resort for a "sentence" with no punctuation longer than target: split on
// word boundaries into <=target pieces.
function hardSplit(s, target) {
  const pieces = [];
  let cur = '';
  for (const w of s.split(/\s+/)) {
    if (cur && cur.length + w.length + 1 > target) {
      pieces.push(cur);
      cur = w;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  if (cur) pieces.push(cur);
  return pieces;
}
