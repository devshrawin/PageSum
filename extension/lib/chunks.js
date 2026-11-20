// Chunk model helpers (panel side). Pure.
import { fnv1a } from './text.js';

// perFrame: [{ frameId, result }] with the main frame first. result.blocks come from the agent.
export function renumberFrames(perFrame) {
  const chunks = [];
  let frames = 0;
  let n = 0;
  for (const f of Array.isArray(perFrame) ? perFrame : []) {
    const blocks = f && f.result && Array.isArray(f.result.blocks) ? f.result.blocks : [];
    if (!blocks.length) continue;
    frames++;
    for (const b of blocks) {
      if (!b || typeof b.text !== 'string' || !b.text) continue;
      n++;
      const c = { id: 'c' + n, frameId: f.frameId, localId: String(b.localId), kind: b.kind || 'p', text: b.text };
      if (b.level) c.level = b.level;
      chunks.push(c);
    }
  }
  return { chunks, frames };
}

// Keeps whole chunks, in order, until adding the next would exceed maxChars. Always keeps at least one.
export function selectChunks(chunks, maxChars) {
  const all = Array.isArray(chunks) ? chunks : [];
  const originalLength = all.reduce((s, c) => s + c.text.length, 0);
  const out = [];
  let sum = 0;
  for (const c of all) {
    if (out.length && sum + c.text.length > maxChars) break;
    out.push(c);
    sum += c.text.length;
  }
  return { chunks: out, truncated: out.length < all.length, originalLength };
}

// Page text can never close the untrusted block, and can never forge a source id.
export function sanitizeForBlock(text) {
  return String(text == null ? '' : text)
    .replace(/<\/?untrusted_page_content/gi, '[tag removed]')
    .replace(/\[(?=\s*[ctpe](?:\d|=\d))/gi, '[ ');
}

function prefixFor(c) {
  if (c.kind === 'h') return (c.level && c.level >= 4) ? '### ' : '## ';
  if (c.kind === 'li') return '- ';
  if (c.kind === 'quote') return '> ';
  return '';
}

export function formatChunksForPrompt(chunks, { ids = true } = {}) {
  const lines = [];
  for (const c of chunks) {
    const text = sanitizeForBlock(c.text);
    const multi = c.kind === 'pre' || c.kind === 'table';
    if (multi) lines.push(ids ? `[${c.id}]\n${text}` : text);
    else lines.push((ids ? `[${c.id}] ` : '') + prefixFor(c) + text);
  }
  return lines.join('\n');
}

export function chunkHash(chunks) {
  return fnv1a((chunks || []).map((c) => c.text).join('\n'));
}
