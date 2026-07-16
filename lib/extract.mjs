// Extract plain narratable text from a document.
//   .pdf         -> `pdftotext` (poppler), then reflowed into paragraphs
//   .html/.htm   -> tags stripped
//   .md/.txt/... -> markdown markup stripped
// No parsing libraries: PDF relies on the system `pdftotext` binary.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

export function extractText(inputPath) {
  const ext = extname(inputPath).toLowerCase();

  if (ext === '.pdf') {
    let raw;
    try {
      // -layout keeps reading order; we reflow the physical line breaks below.
      raw = execFileSync('pdftotext', ['-layout', inputPath, '-'], {
        encoding: 'utf8',
        maxBuffer: 1 << 28,
      });
    } catch (e) {
      throw new Error(
        `pdftotext failed (is poppler installed? "brew install poppler"): ${e.message}`,
      );
    }
    return reflowPdf(raw);
  }

  const raw = readFileSync(inputPath, 'utf8');
  if (ext === '.html' || ext === '.htm') return stripHtml(raw);
  return stripMarkdown(raw); // .md, .txt, and anything else
}

// pdftotext keeps one line per physical line and repeats page numbers. Drop the
// bare page numbers and re-join wrapped lines into paragraphs (blank line = break).
function reflowPdf(text) {
  const paras = [];
  let buf = [];
  for (const line of text.split('\n')) {
    const s = line.replace(/\f/g, '').trim();
    if (/^\d{1,4}$/.test(s)) continue; // page number on its own line
    if (!s) {
      if (buf.length) { paras.push(buf.join(' ')); buf = []; }
      continue;
    }
    buf.push(s);
  }
  if (buf.length) paras.push(buf.join(' '));
  return paras.map((p) => p.replace(/\s+/g, ' ').trim()).join('\n\n');
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|br|tr|section|article)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripMarkdown(md) {
  return md
    .replace(/```[\s\S]*?```/g, '') // fenced code blocks
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/^#{1,6}\s*/gm, '') // heading markers
    .replace(/^\s*>\s?/gm, '') // blockquotes
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links -> text
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1') // bold/italic
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
