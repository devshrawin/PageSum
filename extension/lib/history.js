// Local history library (spec 12.1). Lives in chrome.storage.local, never leaves the browser. Pure helpers plus
// small storage functions with an injectable area.
import { normalizeUrlKey } from './text.js';
import { parseCiteToken, stripCitations } from './citations.js';
import { textFragmentUrl } from './fuzzy.js';

export const MAX_ENTRIES = 300;
export const MAX_BYTES = 3_000_000;
export const MAX_MARKDOWN = 20000;
const MAX_SOURCE = 300;
const MAX_CHAT = 20;

function newId() {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

// Every citation id used in the markdown, in order of first appearance.
export function citedIds(markdown) {
  const out = [];
  const src = String(markdown || '');
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== '[') continue;
    const tok = parseCiteToken(src, i);
    if (!tok) continue;
    for (const id of tok.ids) if (!out.includes(id)) out.push(id);
    i = tok.end - 1;
  }
  return out;
}

// sourceText(id) -> the passage a citation points at (or null). Only cited ids are kept, each cut to 300 chars.
export function makeEntry({ url, title, kind, label, markdown, sourceText, chat, saveChat = false, now = Date.now() }) {
  const md = String(markdown || '').slice(0, MAX_MARKDOWN);
  const sources = {};
  for (const id of citedIds(md)) {
    const t = sourceText ? sourceText(id) : null;
    if (t) sources[id] = String(t).replace(/\s+/g, ' ').trim().slice(0, MAX_SOURCE);
  }
  const entry = {
    id: newId(), savedAt: now, url: String(url || ''), urlKey: normalizeUrlKey(url || ''), title: String(title || '').slice(0, 300),
    host: hostOf(url), kind, label, markdown: md, sources,
  };
  if (saveChat && Array.isArray(chat) && chat.length) entry.chat = chat.slice(-MAX_CHAT).map((m) => ({ role: m.role, text: String(m.text).slice(0, 4000) }));
  return entry;
}

// Newest first. An entry with the same urlKey and label is replaced and moves to the top.
export function addEntry(history, entry) {
  const entries = (history && Array.isArray(history.entries) ? history.entries : [])
    .filter((e) => !(e.urlKey === entry.urlKey && e.label === entry.label));
  return { v: 1, entries: [entry, ...entries] };
}

export function pruneHistory(history, { maxEntries = MAX_ENTRIES, maxBytes = MAX_BYTES } = {}) {
  const entries = history.entries.slice(0, maxEntries);
  const h = { v: 1, entries };
  while (h.entries.length > 1 && JSON.stringify(h).length > maxBytes) h.entries = h.entries.slice(0, -1);
  return h;
}

// Every whitespace-separated token must occur in title + host + markdown (citations stripped). Empty query: all.
export function searchHistory(entries, query) {
  const tokens = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return entries.slice();
  return entries.filter((e) => {
    const hay = `${e.title} ${e.host} ${stripCitations(e.markdown)}`.toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
}

function exportOne(e) {
  const order = citedIds(e.markdown).filter((id) => e.sources && e.sources[id]);
  const num = new Map(order.map((id, i) => [id, i + 1]));
  let md = '';
  const src = e.markdown;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '[') {
      const tok = parseCiteToken(src, i);
      if (tok) {
        const marks = [...new Set(tok.ids.filter((id) => num.has(id)))].map((id) => `[^${num.get(id)}]`).join('');
        md = md.replace(/[ \t]+$/, '') + marks;
        i = tok.end - 1;
        continue;
      }
    }
    md += src[i];
  }
  const foot = order.map((id) => {
    const text = e.sources[id];
    const link = /^c\d+$/.test(id) ? ` (${textFragmentUrl(e.url, text)})` : '';
    return `[^${num.get(id)}]: "${text.replace(/"/g, "'")}"${link}`;
  });
  const date = new Date(e.savedAt).toISOString();
  return `## ${e.title || e.url}\n${e.url}\n*${e.label}, ${date}*\n\n${md.trim()}${foot.length ? '\n\n' + foot.join('\n') : ''}`;
}

export function exportMarkdown(entries) {
  return entries.map(exportOne).join('\n\n---\n\n') + '\n';
}

/* ---------- storage ---------- */

export async function loadHistory(area = chrome.storage.local) {
  const r = await area.get('history');
  const h = r && r.history;
  return h && h.v === 1 && Array.isArray(h.entries) ? h : { v: 1, entries: [] };
}

// Saves after pruning. On a storage-full error it prunes to 2 MB and retries once, then gives up with false.
export async function saveHistory(history, area = chrome.storage.local) {
  let h = pruneHistory(history);
  try {
    await area.set({ history: h });
    return true;
  } catch {
    h = pruneHistory(h, { maxBytes: 2_000_000 });
    try { await area.set({ history: h }); return true; } catch { return false; }
  }
}

export async function addToHistory(entry, area = chrome.storage.local) {
  return saveHistory(addEntry(await loadHistory(area), entry), area);
}

export async function deleteFromHistory(id, area = chrome.storage.local) {
  const h = await loadHistory(area);
  return saveHistory({ v: 1, entries: h.entries.filter((e) => e.id !== id) }, area);
}

export async function clearHistory(area = chrome.storage.local) {
  await area.remove('history');
}
