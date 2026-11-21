// Chunk model helpers (panel side). Pure.
import { fnv1a } from './text.js';

const SUBFRAME_MIN_CHARS = 200;
const SUBFRAME_MIN_W = 200;
const SUBFRAME_MIN_H = 100;

function frameHost(url) {
  try { return new URL(url).hostname || 'frame'; } catch { return 'frame'; }
}

// perFrame: [{ frameId, result }] with the main frame first. result.blocks come from the agent.
// A sub-frame (frameId != 0) is kept only if its text is at least 200 characters AND its viewport is at least
// 200x100 (ad and tracker frames are small or empty). Its chunks follow the main frame's, led by a pseudo heading
// chunk "Embedded frame: {host}". When the main frame is a selection, frames are ignored.
export function renumberFrames(perFrame) {
  const list = Array.isArray(perFrame) ? perFrame : [];
  const mainSelection = list.some((f) => f && f.frameId === 0 && f.result && f.result.source === 'selection');
  const chunks = [];
  let frames = 0;
  let n = 0;
  for (const f of list) {
    const blocks = f && f.result && Array.isArray(f.result.blocks) ? f.result.blocks : [];
    if (!blocks.length) continue;
    const sub = f.frameId !== 0;
    if (sub) {
      if (mainSelection || f.result.source === 'selection') continue;
      const chars = blocks.reduce((s, b) => s + (b && typeof b.text === 'string' ? b.text.length : 0), 0);
      const vp = f.result.viewport || {};
      if (chars < SUBFRAME_MIN_CHARS || !(vp.w >= SUBFRAME_MIN_W) || !(vp.h >= SUBFRAME_MIN_H)) continue;
    }
    frames++;
    if (sub) {
      n++;
      chunks.push({ id: 'c' + n, frameId: f.frameId, localId: '', kind: 'h', level: 3, text: `Embedded frame: ${frameHost(f.result.url)}`, pseudo: true });
    }
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

// Structured extras of the main frame for the prompt: metadata, outline (mapped to chunk ids), links, form fields.
// Returns {} for selections and for pages without structured data.
export function buildStructure(result, chunks) {
  if (!result || result.source === 'selection') return {};
  const byLocal = new Map();
  for (const c of chunks || []) if (c.frameId === 0 && !c.pseudo) byLocal.set(c.localId, c.id);
  const out = {};
  const m = result.meta;
  if (m && Object.values(m).some((v) => v)) out.meta = m;
  const outline = (Array.isArray(result.outline) ? result.outline : [])
    .map((o) => ({ level: o.level, text: o.text, id: byLocal.get(o.localId) }))
    .filter((o) => o.id);
  if (outline.length) out.outline = outline;
  if (Array.isArray(result.links) && result.links.length) out.links = result.links.slice(0, 40);
  if (Array.isArray(result.forms) && result.forms.length) out.forms = result.forms.slice(0, 40);
  return out;
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
