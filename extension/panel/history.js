// History tab (spec 12.1) and the helper that saves summaries and tool results into it.
// Everything stays in chrome.storage.local. Sensitive-looking pages are never saved.
import { $, el, icon, toast, copyText } from './dom.js';
import { app, shownState } from './tabs.js';
import { callAgent } from './agent.js';
import { renderMarkdown } from '../lib/markdown.js';
import { stripCitations } from '../lib/citations.js';
import {
  makeEntry, addToHistory, loadHistory, deleteFromHistory, clearHistory, searchHistory, exportMarkdown,
} from '../lib/history.js';

const REASON_WORDS = { blocklist: 'blocked site', login: 'login page', banking: 'banking page', health: 'health page', payment: 'payment page' };

function sourceTextFor(page) {
  if (page.kind === 'pdf') return (id) => (/^p\d+$/.test(id) ? `Page ${id.slice(1)}` : null);
  if (page.kind === 'video') return (id) => (id.startsWith('t=') ? id.slice(2) : null);
  const byId = new Map((page.chunks || []).map((c) => [c.id, c.text]));
  return (id) => byId.get(id) || null;
}

const KIND = { html: 'summary', pdf: 'pdf', video: 'video' };

// Saves one entry. Returns { saved: true } or { saved: false, skipped?: 'text for a notice' }.
// opts: { kind?, label, markdown, chat? }. Skips quietly when history is off, and with a notice for sensitive pages.
export async function recordHistory(st, opts) {
  const s = app.settings;
  const page = st.page;
  if (!s || !s.historyEnabled || !page || page.kind === 'image' || !st.urlKey) return { saved: false };
  if (st.sensitive && st.sensitive.sensitive) {
    return { saved: false, skipped: `Not saved to history (${REASON_WORDS[st.sensitive.reason] || 'sensitive page'}).` };
  }
  if (!opts.markdown) return { saved: false };
  const entry = makeEntry({
    url: page.url || st.url, title: page.title || st.title, kind: opts.kind || KIND[page.kind] || 'summary', label: opts.label,
    markdown: opts.markdown, sourceText: sourceTextFor(page), chat: opts.chat, saveChat: !!s.historySaveChat,
  });
  const ok = await addToHistory(entry);
  return ok ? { saved: true } : { saved: false, skipped: 'Could not save to history (storage is full).' };
}

/* ---------- the tab ---------- */

let query = '';
const expanded = new Set();
let shownEntries = [];

const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

function citeResolver(entry) {
  return (id) => (entry.sources && entry.sources[id] ? { text: entry.sources[id] } : null);
}

function card(entry) {
  const open = expanded.has(entry.id);
  const head = el('button', { type: 'button', class: 'history-head', 'aria-expanded': open ? 'true' : 'false' },
    el('span', { class: 'history-title', text: entry.title || entry.url }),
    el('span', { class: 'history-meta' }, el('span', { text: entry.host }), el('span', { text: fmtDate(entry.savedAt) }), el('span', { class: 'badge', text: entry.label })));
  head.addEventListener('click', () => { if (expanded.has(entry.id)) expanded.delete(entry.id); else expanded.add(entry.id); renderHistory(); });
  const c = el('div', { class: 'history-card', 'data-id': entry.id }, head);
  if (!open) {
    c.appendChild(el('p', { class: 'history-snippet', text: stripCitations(entry.markdown).replace(/\s+/g, ' ').trim().slice(0, 160) }));
    return c;
  }
  const body = el('div', { class: 'history-body md' });
  body.appendChild(renderMarkdown(entry.markdown, document, { resolveCite: citeResolver(entry) }));
  const copyLabel = el('span', { text: 'Copy' });
  const copy = el('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, icon('copy'), copyLabel);
  copy.addEventListener('click', () => copyText(stripCitations(entry.markdown), copyLabel, 'Copy'));
  const del = el('button', { type: 'button', class: 'btn btn-danger btn-sm', 'aria-label': `Delete ${entry.title || 'entry'}` }, icon('trash'), el('span', { text: 'Delete' }));
  del.addEventListener('click', async () => { await deleteFromHistory(entry.id); expanded.delete(entry.id); renderHistory(); });
  c.append(body, el('div', { class: 'res-actions' }, copy, del));
  return c;
}

export async function renderHistory() {
  const all = (await loadHistory()).entries;
  shownEntries = searchHistory(all, query);
  const list = $('historyList');
  list.replaceChildren(...shownEntries.map(card));
  const empty = $('historyEmpty');
  let msg = '';
  if (!all.length) msg = app.settings && !app.settings.historyEnabled ? 'History is turned off in Settings.' : 'Nothing saved yet. Summaries are saved here once they finish.';
  else if (!shownEntries.length) msg = 'No matches.';
  empty.textContent = msg;
  empty.hidden = !msg;
  $('historyExport').disabled = !all.length;
  $('historyClear').disabled = !all.length;
}

// Clicking a citation in a saved summary: highlight the passage if the shown tab is that page.
async function onHistoryCite(entry, id) {
  const st = shownState();
  const text = entry.sources && entry.sources[id];
  if (!text) return;
  if (!/^c\d+$/.test(id)) { toast(text); return; }
  if (!st || st.access !== 'ok' || st.urlKey !== entry.urlKey) { toast('Open this page to highlight the source.'); return; }
  try {
    const out = await callAgent(st.tabId, 'highlight', { localId: '', text }, { frameIds: [0] });
    if (out[0] && out[0].ok && out[0].data.found === 'none') toast("That passage isn't on the page any more.");
  } catch { toast("Can't reach the page. Click the PageSum icon while on this tab."); }
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const a = document.createElement('a');
  a.setAttribute('href', url);
  a.setAttribute('download', name);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function initHistory() {
  $('historySearch').addEventListener('input', () => { query = $('historySearch').value; renderHistory(); });
  $('historyExport').addEventListener('click', async () => {
    const all = (await loadHistory()).entries;
    if (!all.length) return;
    const day = new Date().toISOString().slice(0, 10);
    download(`pagesum-history-${day}.md`, exportMarkdown(all));
  });
  $('historyClear').addEventListener('click', async () => {
    const n = (await loadHistory()).entries.length;
    if (!n) return;
    if (!confirm(`Delete all ${n} saved summaries? This can't be undone.`)) return;
    await clearHistory();
    expanded.clear();
    renderHistory();
  });
  // Citation buttons inside the history list are handled here, not by the Page tab's handler.
  $('historyList').addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('button.cite') : null;
    if (!b) return;
    e.stopPropagation();
    const holder = b.closest('.history-card');
    const entry = shownEntries.find((x) => holder && x.id === holder.getAttribute('data-id'));
    if (entry) onHistoryCite(entry, b.getAttribute('data-cite'));
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.history || changes.settings) && !$('panel-history').hidden) renderHistory();
  });
}

