// Citation tokens: [c12], [c12, c15], [p3], [t=12:34], [t2c4] (compare form). Pure.

const ID = '(?:t\\d+c\\d+|c\\d+|p\\d+|t=\\d{1,2}:\\d{2}(?::\\d{2})?)';
const RE_TOKEN = new RegExp(`^\\[\\s*(${ID}(?:\\s*,\\s*${ID})*)\\s*\\]`);
const MAX_IDS = 6;

// At src[i] === '[': returns { ids, end } (end is the index after the closing bracket) or null.
// A token directly followed by '(' is a markdown link, not a citation.
export function parseCiteToken(src, i = 0) {
  if (src[i] !== '[') return null;
  const m = RE_TOKEN.exec(src.slice(i, i + 200));
  if (!m) return null;
  const ids = m[1].split(',').map((s) => s.trim());
  if (ids.length > MAX_IDS) return null;
  const end = i + m[0].length;
  if (src[end] === '(') return null;
  return { ids, end };
}

// lists: arrays of ids in render order. Returns Map id -> 1-based number by first appearance.
export function numberCitations(lists) {
  const map = new Map();
  for (const ids of lists) {
    for (const id of ids) if (!map.has(id)) map.set(id, map.size + 1);
  }
  return map;
}

// While streaming: drop an unfinished trailing token such as "[c1" or "[c12, c1" so it never flickers.
const RE_PARTIAL = /\[\s*(?:t\d*c?\d*|c\d*|p\d*|t=[\d:]*)(?:\s*,\s*[^\]]*)?$|\[\s*$/;
export function stripPartialCite(raw) {
  return String(raw == null ? '' : raw).replace(RE_PARTIAL, '');
}

// Removes every citation token and the spaces before it (used by Copy and translate input).
export function stripCitations(raw) {
  const src = String(raw == null ? '' : raw);
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src[i] === '[') {
      const tok = parseCiteToken(src, i);
      if (tok) {
        out = out.replace(/[ \t]+$/, '');
        i = tok.end;
        continue;
      }
    }
    out += src[i];
    i++;
  }
  return out;
}

// Resolver factories. A resolver maps an id to { text } (truthy) when the id is valid, else null.
export function chunkResolver(chunks) {
  const byId = new Map();
  for (const c of chunks || []) if (!c.pseudo) byId.set(c.id, c);   // "Embedded frame" markers are not citable
  return (id) => {
    const c = byId.get(id);
    return c ? { text: c.text } : null;
  };
}

export function pdfResolver(maxPage) {
  return (id) => {
    const m = /^p(\d+)$/.exec(id);
    if (!m) return null;
    const n = Number(m[1]);
    if (n < 1) return null;
    if (Number.isFinite(maxPage) && maxPage > 0 && n > maxPage) return null;
    return { text: `Page ${n}` };
  };
}

export function videoResolver(durationSec) {
  return (id) => {
    const m = /^t=(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(id);
    if (!m) return null;
    const secs = (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3]);
    if (Number.isFinite(durationSec) && durationSec > 0 && secs > durationSec + 5) return null;
    return { text: id.slice(2) };
  };
}
