// Page tab: summary, chat and click-to-source citations (v1 logic moved here, now on chunks and per-tab state).
// It draws the state of the SHOWN tab. Streams for other tabs keep writing into their own TabState (spec 4.1).
import { saveSettings, putCacheEntry } from '../lib/storage.js';
import { GeminiError, redactKey } from '../lib/errors.js';
import { parseTimecode } from '../lib/youtube.js';
import { normalizeUrlKey, fnv1a } from '../lib/text.js';
import { DEFAULT_MODEL } from '../lib/models.js';
import { renderMarkdown } from '../lib/markdown.js';
import {
  chunkResolver, pdfResolver, videoResolver, stripPartialCite, stripCitations,
} from '../lib/citations.js';
import { $, el, announce, toast, copyText, buildErrorCard, icon } from './dom.js';
import {
  app, shownState, isShown, load, tryAnyway, abortStream, enforceStreamLimit, addNotice, removeNotice, dropCache,
  callAgent, ensureAgent,
} from './tabs.js';
import { runRequest } from './request.js';
import { currentTab } from './nav.js';
import { recordHistory } from './history.js';
import { captureScreenshot } from './media.js';

const VIEWS = ['init', 'needKey', 'restricted', 'needAccess', 'empty', 'idle', 'summary'];
const CUT_NOTE = '\n\n*(Answer cut off.)*';

/* ---------- small helpers ---------- */

function logError(err) {
  console.error(redactKey(String((err && err.message) || err)));
}

let rafId = 0;
let rafFn = null;
function scheduleRender(fn) {
  rafFn = fn;
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    const f = rafFn;
    rafFn = null;
    if (f) f();
  });
}
function cancelRender() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  rafFn = null;
}

const resolverCache = new WeakMap();
// Which citation ids are valid for this tab: chunk ids for pages, p1..pN for a PDF, times for a video.
function resolverFor(st) {
  if (!app.settings || !app.settings.citations || !st.page) return undefined;
  const page = st.page;
  if (page.kind === 'image') return undefined;
  if (page.kind === 'pdf') return pdfResolver(page.pdf && page.pdf.pages);
  if (page.kind === 'video') return videoResolver(page.video && page.video.duration);
  let r = resolverCache.get(page.chunks);
  if (!r) { r = chunkResolver(page.chunks); resolverCache.set(page.chunks, r); }
  return r;
}

// streaming: hide an unfinished "[c1" so it never flickers
function renderMd(st, raw, streaming) {
  return renderMarkdown(streaming ? stripPartialCite(raw) : raw, document, { resolveCite: resolverFor(st) });
}

const modelOpts = () => ({
  currentModel: app.settings && app.settings.model,
  onSwitchModel: async () => {
    app.settings = await saveSettings({ model: DEFAULT_MODEL });
    updateModelLabel();
    const st = shownState();
    const retry = st && st.conv.summaryError ? st.conv.summaryError.retry
      : st && st.conv.pendingAnswer && st.conv.pendingAnswer.error ? st.conv.pendingAnswer.error.retry : null;
    if (retry) retry();
  },
});

function asGeminiError(err) {
  if (err instanceof GeminiError) return err;
  logError(err);
  return new GeminiError('network', { message: err && err.message });
}

/* ---------- view routing ---------- */

export function setTitle(st) {
  const t = $('pageTitle');
  const text = (st && (st.title || st.url)) || '';
  t.textContent = text || 'PageSum';
  t.title = text;
}

function setView(name) {
  for (const v of VIEWS) $('view-' + v).hidden = v !== name;
  $('footer').hidden = name !== 'summary' || currentTab() !== 'page';
}

function renderNotices(st) {
  const box = $('notices');
  box.replaceChildren();
  if (!st) return;
  for (const n of st.notices) {
    const row = el('div', { class: 'notice' }, n.icon ? icon(n.icon) : null, el('span', { class: 'txt', text: n.text }));
    if (n.action) {
      const b = el('button', { type: 'button', class: 'link', text: n.action.label });
      b.addEventListener('click', n.action.run);
      row.appendChild(b);
    }
    const x = el('button', { type: 'button', class: 'btn btn-icon btn-sm', 'aria-label': 'Dismiss notice' }, icon('close'));
    x.addEventListener('click', () => {
      st.notices = st.notices.filter((m) => m !== n);
      renderNotices(st);
    });
    row.appendChild(x);
    box.appendChild(row);
  }
}

// Draws the whole panel for one TabState (or "no tab").
export function renderState(st) {
  cancelRender();
  if (!st) {
    setTitle(null);
    renderNotices(null);
    $('restrictedText').textContent = "Chrome doesn't let extensions read this page.";
    setView('restricted');
    return;
  }
  setTitle(st);
  renderNotices(st);
  setView(st.view);
  if (st.view === 'restricted') $('restrictedText').textContent = st.restrictedReason;
  else if (st.view === 'needAccess') renderNeedAccess(st);
  else if (st.view === 'idle') renderIdle(st);
  else if (st.view === 'needKey') { $('keyMsg').textContent = ''; $('keyInput').focus(); }
  else if (st.view === 'summary') renderSummaryView(st);
  updateModelLabel();
}

// Idle view: the "Summarise" button, or the privacy variant for a page that looks sensitive.
function renderIdle(st) {
  $('summariseBtn').textContent = st.idleLabel || 'Summarise this page';
  const s = st.sensitive;
  const text = $('sensitiveText');
  const never = $('neverSiteBtn');
  if (s && s.sensitive) {
    text.textContent = s.reason === 'blocklist'
      ? 'This site is on your blocklist. Its text would be sent to Google.'
      : `This page looks like a ${SENSITIVE_WORDS[s.reason] || 'sensitive'} page. Its text would be sent to Google.`;
    text.hidden = false;
    never.hidden = s.reason === 'blocklist';
  } else {
    text.hidden = true;
    never.hidden = true;
  }
}

const SENSITIVE_WORDS = { login: 'login', banking: 'banking', health: 'health', payment: 'payment' };

function renderNeedAccess(st) {
  $('needAccessTitle').textContent = "PageSum can't read this tab yet.";
  $('allowSiteBtn').hidden = !st.origin;
  $('allowSiteBtn').textContent = st.host ? `Allow on ${st.host}` : 'Allow on this site';
  $('needAccessHint').textContent = 'Or click the PageSum icon while on this tab (one-time access).';
}

function updateModelLabel() {
  $('modelLabel').textContent = app.settings ? app.settings.model : '';
  $('beyondToggle').checked = !app.settings || app.settings.beyondPage !== false;
}

/* ---------- summary view ---------- */

function setLengthUI(len) {
  for (const b of $('lengthGroup').querySelectorAll('button')) {
    const on = b.dataset.length === len;
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
  }
}

const isSummaryStreaming = (st) => !!st.ctrl && !st.conv.pendingAnswer;

function drawSummary(st) {
  if (!isShown(st)) return;
  const conv = st.conv;
  const body = $('summaryBody');
  body.replaceChildren(renderMd(st, conv.summaryRaw, isSummaryStreaming(st)));
  if (conv.summaryNote) body.appendChild(el('span', { class: 'stopped', text: conv.summaryNote }));
}

function renderSummaryView(st) {
  const conv = st.conv;
  setLengthUI(conv.length);
  const box = $('summaryError');
  if (conv.summaryError) {
    $('summaryBody').hidden = true;
    box.replaceChildren(buildErrorCard(conv.summaryError.err, conv.summaryError.retry, modelOpts()));
    box.hidden = false;
  } else {
    box.hidden = true;
    $('summaryBody').hidden = false;
    drawSummary(st);
  }
  renderChat(st);
  updateControls(st);
}

function canChat(st) {
  return !!st && !st.ctrl && st.view === 'summary' && !!st.conv.summaries[st.conv.chatLength || st.conv.length];
}

function updateControls(st) {
  if (!st || !isShown(st)) return;
  const busy = !!st.ctrl;
  for (const b of $('lengthGroup').querySelectorAll('button')) b.disabled = busy;
  $('regenBtn').disabled = busy;
  $('copyBtn').disabled = !st.conv.summaryRaw;
  $('stopBtn').hidden = !busy;
  $('summaryBody').setAttribute('aria-busy', isSummaryStreaming(st) ? 'true' : 'false');
  const chat = canChat(st);
  $('question').disabled = !chat;
  $('sendBtn').disabled = !chat;
  $('newChatBtn').disabled = busy;
}

/* ---------- chat DOM (rebuilt from state, so a tab switch loses nothing) ---------- */

function modelBubble(st, raw, { streaming = false, pending = false } = {}) {
  const body = el('div', { class: 'md' });
  const copy = el('button', { type: 'button', class: 'link link-muted', text: 'Copy' });
  const wrap = el('div', { class: 'msg-model' + (pending ? ' pending' : '') }, body, el('div', { class: 'bubble-tools' }, copy));
  if (raw) body.replaceChildren(renderMd(st, raw, streaming));
  else copy.hidden = true;
  copy.addEventListener('click', () => copyText(stripCitations(raw), copy, 'Copy'));
  return { wrap, body, copy };
}

function renderChat(st) {
  const chat = $('chat');
  chat.replaceChildren();
  for (const m of st.conv.messages) {
    if (m.role === 'user') chat.appendChild(el('div', { class: 'msg-user', text: m.text }));
    else chat.appendChild(modelBubble(st, m.text).wrap);
  }
  const p = st.conv.pendingAnswer;
  if (!p) return;
  chat.appendChild(el('div', { class: 'msg-user', text: p.q }));
  if (p.error) {
    const b = modelBubble(st, '', { pending: true });
    b.body.hidden = true;
    b.wrap.insertBefore(buildErrorCard(p.error.err, p.error.retry, modelOpts()), b.wrap.querySelector('.bubble-tools'));
    chat.appendChild(b.wrap);
  } else {
    const b = modelBubble(st, p.raw, { streaming: true, pending: true });
    if (!p.raw) b.body.replaceChildren(el('span', { class: 'thinking', text: 'Thinking…' }));
    if (p.stopped) b.body.appendChild(el('span', { class: 'stopped', text: '(stopped)' }));
    chat.appendChild(b.wrap);
  }
}

function drawPending(st) {
  if (!isShown(st) || !st.conv.pendingAnswer) return;
  const node = $('chat').querySelector('.msg-model.pending .md');
  if (!node) { renderChat(st); return; }
  node.replaceChildren(renderMd(st, st.conv.pendingAnswer.raw, true));
  scrollBottom();
}

function scrollBottom() {
  const c = $('content');
  c.scrollTop = c.scrollHeight;
}

/* ---------- cache ---------- */

async function saveEntry(st) {
  if (!st.urlKey || !st.page || st.page.kind === 'image') return;   // a screenshot summary is not worth keeping
  try {
    await putCacheEntry(st.urlKey, {
      textHash: st.hash,
      kind: st.kind,
      source: st.page.source,
      chunks: st.page.chunks.map(({ id, frameId, localId, kind, level, text }) => ({ id, frameId, localId, kind, ...(level ? { level } : {}), text })),
      summaries: st.conv.summaries,
      chatLength: st.conv.chatLength,
      messages: st.conv.messages.slice(-20),
    });
  } catch (err) { logError(err); }
}

/* ---------- history ---------- */

const LENGTH_LABEL = { short: 'Short', medium: 'Medium', detailed: 'Detailed' };

// Saves the current summary (and, if the setting is on, the chat) to the history library.
async function saveToHistory(st) {
  const conv = st.conv;
  const length = conv.chatLength || conv.length;
  const markdown = conv.summaries[length];
  if (!markdown || !st.page) return;
  const kindWord = st.page.kind === 'pdf' ? 'PDF summary' : st.page.kind === 'video' ? 'Video summary' : `${LENGTH_LABEL[length] || 'Medium'} summary`;
  try {
    const r = await recordHistory(st, { label: kindWord, markdown, chat: conv.messages });
    if (r.skipped) {
      addNotice(st, { key: 'history-skip', text: r.skipped });
      if (isShown(st)) renderNotices(st);
    }
  } catch (err) { logError(err); }
}

/* ---------- streaming ---------- */

// Called by tabs.js when it aborts a background stream to stay within the concurrency limit.
export function abortUi(st) {
  if (st.conv.summaryRaw && !st.conv.summaries[st.conv.length]) st.conv.summaryNote = '(stopped)';
  if (isShown(st)) renderState(st);
}

export async function startSummary(st, length) {
  abortStream(st);
  dropCache(st);                       // a new summary starts a new conversation: the old context cache is useless
  enforceStreamLimit(st);
  const settings = app.settings;
  const conv = st.conv;
  conv.length = length;
  conv.chatLength = length;
  conv.messages = [];
  conv.summaryRaw = '';
  conv.summaryNote = '';
  conv.summaryError = null;
  conv.pendingAnswer = null;
  st.view = 'summary';
  const ctrl = new AbortController();
  st.ctrl = ctrl;
  st.streamAt = Date.now();
  if (isShown(st)) { setView('summary'); renderSummaryView(st); }
  try {
    const r = await runRequest(st, {
      settings, windowId: app.windowId, kind: 'summary', length,
      signal: ctrl.signal,
      onText: (t) => {
        if (st.ctrl !== ctrl) return;
        conv.summaryRaw = t;
        if (isShown(st)) scheduleRender(() => drawSummary(st));
      },
    });
    if (st.ctrl !== ctrl) return;
    if (isShown(st)) cancelRender();
    let text = r.text;
    if (r.finishReason === 'MAX_TOKENS') text += CUT_NOTE;
    conv.summaryRaw = text;
    conv.summaries[length] = text;
    st.ctrl = null;
    if (isShown(st)) { drawSummary(st); updateControls(st); announce('Summary ready'); }
    await saveEntry(st);
    await saveToHistory(st);
  } catch (err) {
    if (st.ctrl !== ctrl) return;
    if (isShown(st)) cancelRender();
    st.ctrl = null;
    if (err instanceof GeminiError && err.code === 'aborted') {
      conv.summaryNote = '(stopped)';
    } else {
      conv.summaryError = { err: asGeminiError(err), retry: () => startSummary(st, length) };
    }
    if (isShown(st)) renderSummaryView(st);
  }
  if (isShown(st)) {
    updateControls(st);
    if (canChat(st)) $('question').focus();
  }
}

// "Read from screenshot" (spec 8.8): capture the visible area of the shown tab, then summarise it like a page.
// The screenshot stays in memory (st.media) so follow-up questions reuse it. Nothing is cached or saved.
export async function startVision(st) {
  const base = st.page || (st.pending && st.pending.model);
  if (!base) return;
  abortStream(st);
  let shot;
  try {
    shot = await captureScreenshot(app.windowId);
  } catch (err) {
    // capture_denied: show the card in the summary view with a retry
    st.page = st.page || { ...base, chunks: [], kind: 'image', source: 'screenshot' };
    st.conv = { ...st.conv, summaryError: { err: asGeminiError(err), retry: () => startVision(st) } };
    st.view = 'summary';
    if (isShown(st)) renderState(st);
    return;
  }
  const url = base.url || st.url;
  st.page = { ...base, kind: 'image', source: 'screenshot', chunks: [], truncated: false, originalLength: 0, selectionLength: 0, meta: undefined, outline: undefined, links: undefined, forms: undefined };
  st.kind = 'image';
  st.media = { kind: 'image', ...shot };
  st.hash = fnv1a(`shot:${shot.bytes}`);
  st.urlKey = st.urlKey || normalizeUrlKey(url);
  st.access = 'ok';
  st.pending = null;
  st.stale = false;
  st.autoPending = false;
  st.conv.summaries = {};
  st.conv.summaryError = null;
  removeNotice(st, 'vision-offer');
  addNotice(st, { key: 'screenshot', icon: 'camera', text: 'Based on a screenshot of the visible area only.' });
  await startSummary(st, app.settings.defaultLength);
}

function onLengthPick(len) {
  const st = shownState();
  if (!st || st.ctrl || len === st.conv.length) return;
  const conv = st.conv;
  if (conv.summaries[len]) {
    conv.length = len;
    conv.chatLength = len;
    conv.messages = [];
    conv.pendingAnswer = null;
    conv.summaryRaw = conv.summaries[len];
    conv.summaryNote = '';
    conv.summaryError = null;
    renderSummaryView(st);
    saveEntry(st);
  } else {
    startSummary(st, len);
  }
}

/* ---------- chat ---------- */

function submitQuestion() {
  const st = shownState();
  const input = $('question');
  const q = input.value.trim();
  if (!q || !canChat(st)) return;
  input.value = '';
  autoGrow();
  runAnswer(st, q);
}

async function runAnswer(st, q) {
  enforceStreamLimit(st);
  const settings = app.settings;
  const conv = st.conv;
  const pending = { q, raw: '', error: null };
  conv.pendingAnswer = pending;
  const ctrl = new AbortController();
  st.ctrl = ctrl;
  st.streamAt = Date.now();
  if (isShown(st)) { renderChat(st); updateControls(st); scrollBottom(); }
  const length = conv.chatLength || conv.length;
  try {
    const r = await runRequest(st, {
      settings, windowId: app.windowId, kind: 'answer', length, summary: conv.summaries[length],
      messages: [...conv.messages, { role: 'user', text: q }],
      signal: ctrl.signal,
      onText: (t) => {
        if (st.ctrl !== ctrl) return;
        pending.raw = t;
        if (isShown(st)) scheduleRender(() => drawPending(st));
      },
    });
    if (st.ctrl !== ctrl) return;
    if (isShown(st)) cancelRender();
    let text = r.text;
    if (r.finishReason === 'MAX_TOKENS') text += CUT_NOTE;
    conv.messages.push({ role: 'user', text: q }, { role: 'model', text });
    conv.messages = conv.messages.slice(-20);
    conv.pendingAnswer = null;
    st.ctrl = null;
    if (isShown(st)) { renderChat(st); updateControls(st); announce('Answer ready'); }
    await saveEntry(st);
    if (settings.historySaveChat) await saveToHistory(st);
  } catch (err) {
    if (st.ctrl !== ctrl) return;
    if (isShown(st)) cancelRender();
    st.ctrl = null;
    if (err instanceof GeminiError && err.code === 'aborted') {
      pending.stopped = true;
    } else {
      pending.error = { err: asGeminiError(err), retry: () => runAnswer(st, q) };
    }
    if (isShown(st)) renderChat(st);
  }
  if (isShown(st)) {
    updateControls(st);
    if (canChat(st)) $('question').focus();
    scrollBottom();
  }
}

function autoGrow() {
  const t = $('question');
  t.style.height = 'auto';
  const lh = parseFloat(getComputedStyle(t).lineHeight) || 20;
  const max = lh * 5 + 14;
  t.style.height = Math.min(t.scrollHeight, max) + 'px';
}

/* ---------- click to source ---------- */

const NO_REACH = "Can't reach the page. Click the PageSum icon while on this tab.";

// Opens a PDF at a page: the Chrome PDF viewer honours #page=N, and no permission is needed.
async function goToPdfPage(st, n) {
  const base = String(st.url || st.page.url || '').split('#')[0];
  if (!base) { toast(NO_REACH); return; }
  try { await chrome.tabs.update(st.tabId, { url: `${base}#page=${n}` }); } catch { toast(NO_REACH); }
}

async function seekVideo(st, timecode) {
  const seconds = parseTimecode(timecode);
  if (seconds == null) return;
  try {
    let out = await callAgent(st.tabId, 'seek', { seconds }, { frameIds: [0] });
    if (out[0] && !out[0].ok && out[0].error && out[0].error.code === 'no_agent') {
      await ensureAgent(st.tabId);
      out = await callAgent(st.tabId, 'seek', { seconds }, { frameIds: [0] });
    }
    if (!out[0] || !out[0].ok) toast(NO_REACH);
  } catch { toast(NO_REACH); }
}

async function onCite(id) {
  const st = shownState();
  if (!st || !st.page) return;
  const page = st.page;
  if (page.kind === 'pdf') {
    const m = /^p(\d+)$/.exec(id);
    if (m) goToPdfPage(st, Number(m[1]));
    return;
  }
  if (page.kind === 'video') {
    if (id.startsWith('t=')) seekVideo(st, id.slice(2));
    return;
  }
  const chunk = page.chunks.find((c) => c.id === id);
  if (!chunk || chunk.pseudo) { toast("That passage isn't on the page any more."); return; }
  const args = { localId: chunk.localId, text: chunk.text };
  const opts = { frameIds: [chunk.frameId] };
  try {
    let out = await callAgent(st.tabId, 'highlight', args, opts);
    if (out[0] && !out[0].ok && out[0].error && out[0].error.code === 'no_agent') {
      await ensureAgent(st.tabId, { allFrames: !!st.frames });      // the page was reloaded since the summary
      out = await callAgent(st.tabId, 'highlight', args, opts);
    }
    const r = out[0];
    if (!r || !r.ok) toast(NO_REACH);
    else if (r.data.found === 'none') toast("That passage isn't on the page any more.");
  } catch {
    toast(NO_REACH);
  }
}

async function clearPageHighlight() {
  const st = shownState();
  if (!st || st.access !== 'ok') return;
  try { await callAgent(st.tabId, 'clearHighlight', {}, { frameIds: [0] }); } catch { /* tab gone or no access */ }
}

/* ---------- needKey / needAccess ---------- */

async function saveKeyFromCard() {
  const k = $('keyInput').value.trim();
  if (!k) { $('keyMsg').textContent = 'Paste your API key first.'; return; }
  $('keyMsg').textContent = '';
  app.settings = await saveSettings({ apiKey: k });
  $('keyInput').value = '';
  const st = shownState();
  if (st) load(st.tabId);
}

function requestAccess(origins) {
  const st = shownState();
  if (!st) return;
  // chrome.permissions.request needs the click's user gesture: it must be the first thing the handler does.
  chrome.permissions.request({ origins }).then((granted) => {
    if (granted) load(st.tabId);
    else {
      addNotice(st, { key: 'access-denied', text: "Access wasn't granted. You can also click the PageSum icon while on the tab." });
      if (isShown(st)) renderState(st);
    }
  }).catch((err) => {
    logError(err);
    addNotice(st, { key: 'access-denied', text: "Chrome couldn't ask for access to this site." });
    if (isShown(st)) renderState(st);
  });
}

/* ---------- wiring ---------- */

export function initPage() {
  $('settingsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('moreSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('keySave').addEventListener('click', saveKeyFromCard);
  $('keyInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveKeyFromCard(); });
  $('keyShow').addEventListener('click', () => {
    const i = $('keyInput');
    const show = i.type === 'password';
    i.type = show ? 'text' : 'password';
    $('keyShow').textContent = show ? 'Hide' : 'Show';
  });

  $('allowSiteBtn').addEventListener('click', () => {
    const st = shownState();
    if (st && st.origin) requestAccess([st.origin]);
  });
  $('allowAllBtn').addEventListener('click', () => requestAccess(['<all_urls>']));

  $('tryAnyway').addEventListener('click', () => { const st = shownState(); if (st) tryAnyway(st); });
  $('summariseBtn').addEventListener('click', () => { const st = shownState(); if (st && st.page) startSummary(st, app.settings.defaultLength); });
  // "Never on this site": add the host to the blocklist (the setting is stored normalised, one host per entry).
  $('neverSiteBtn').addEventListener('click', async () => {
    const st = shownState();
    if (!st || !st.page) return;
    let host = '';
    try { host = new URL(st.page.url || st.url).hostname; } catch { host = ''; }
    if (!host) return;
    app.settings = await saveSettings({ siteBlocklist: [...app.settings.siteBlocklist, host] });
    st.sensitive = { sensitive: true, reason: 'blocklist' };
    toast(`${host} will never be summarised automatically or saved.`);
    renderState(st);
  });

  const group = $('lengthGroup');
  for (const b of group.querySelectorAll('button')) b.addEventListener('click', () => onLengthPick(b.dataset.length));
  group.addEventListener('keydown', (e) => {
    const st = shownState();
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'];
    if (!keys.includes(e.key) || !st || st.ctrl) return;
    e.preventDefault();
    const btns = [...group.querySelectorAll('button')];
    const cur = btns.findIndex((b) => b.getAttribute('aria-checked') === 'true');
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    const next = btns[(cur + dir + btns.length) % btns.length];
    next.focus();
    onLengthPick(next.dataset.length);
  });

  $('regenBtn').addEventListener('click', () => { const st = shownState(); if (st && !st.ctrl && st.page) startSummary(st, st.conv.length); });
  $('copyBtn').addEventListener('click', () => { const st = shownState(); if (st) copyText(stripCitations(st.conv.summaryRaw), $('copyLabel'), 'Copy'); });
  $('stopBtn').addEventListener('click', () => {
    const st = shownState();
    if (st && st.ctrl) st.ctrl.abort();
  });
  $('sendBtn').addEventListener('click', submitQuestion);
  $('beyondToggle').checked = !app.settings || app.settings.beyondPage !== false;
  $('beyondToggle').addEventListener('change', async () => {
    app.settings = await saveSettings({ beyondPage: $('beyondToggle').checked });
    toast($('beyondToggle').checked ? 'Answers can go beyond this page' : 'Answers stay on this page');
  });
  $('newChatBtn').addEventListener('click', () => {
    const st = shownState();
    if (!st || st.ctrl) return;
    st.conv.messages = [];
    st.conv.pendingAnswer = null;
    dropCache(st);
    renderChat(st);
    saveEntry(st);
    $('question').focus();
  });
  const q = $('question');
  q.addEventListener('input', autoGrow);
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submitQuestion();
    }
  });

  // One delegated handler for every citation button (summary and chat answers).
  $('content').addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('button.cite') : null;
    if (b && b.dataset.cite) onCite(b.dataset.cite);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') clearPageHighlight();
  });
}

export { updateModelLabel };
