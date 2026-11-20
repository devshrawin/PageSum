import { getSettings, saveSettings, getCacheEntry, putCacheEntry, deleteCacheEntry } from './lib/storage.js';
import {
  cleanText, truncateText, fnv1a, normalizeUrlKey, isRestrictedUrl, pageKind,
  MSG_RESTRICTED, MSG_PDF, MSG_FILE,
} from './lib/text.js';
import { extractPage } from './lib/extract.js';
import { buildSystemPrompt, buildContents, makeNonce } from './lib/prompts.js';
import { streamGenerate, buildRequestBody } from './lib/gemini.js';
import { GeminiError, userMessage, redactKey } from './lib/errors.js';
import { DEFAULT_MODEL } from './lib/models.js';
import { renderMarkdown } from './lib/markdown.js';

const $ = (id) => document.getElementById(id);
const VIEWS = ['init', 'needKey', 'restricted', 'empty', 'idle', 'summary'];
const CUT_NOTE = '\n\n*(Answer cut off.)*';

const S = {
  state: 'init',
  settings: null,
  tab: null,
  page: null,
  hash: '',
  urlKey: '',
  nonce: makeNonce(),
  length: 'medium',
  chatLength: null,
  summaries: {},
  summaryRaw: '',
  summaryNote: '',
  messages: [],
  busy: false,
  ctrl: null,
  pending: null,
  notices: [],
  retry: null,
};

let rafId = 0;
let rafFn = null;

/* ---------- small helpers ---------- */

function announce(text) {
  const s = $('status');
  s.textContent = '';
  setTimeout(() => { s.textContent = text; }, 30);
}

function setView(name) {
  S.state = name;
  for (const v of VIEWS) $('view-' + v).hidden = v !== name;
  $('footer').hidden = name !== 'summary';
}

function setTitle(t) {
  const el = $('pageTitle');
  el.textContent = t || 'PageSum';
  el.title = t || '';
}

function showRestricted(reason) {
  setView('restricted');
  $('restrictedText').textContent = reason;
}

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

function logError(err) {
  console.error(redactKey(String((err && err.message) || err)));
}

/* ---------- notices ---------- */

function renderNotices() {
  const box = $('notices');
  box.replaceChildren();
  for (const n of S.notices) {
    const row = document.createElement('div');
    row.className = 'notice';
    const txt = document.createElement('span');
    txt.className = 'txt';
    txt.textContent = n.text;
    row.appendChild(txt);
    if (n.action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'link-btn small';
      b.textContent = n.action.label;
      b.addEventListener('click', n.action.run);
      row.appendChild(b);
    }
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'icon-btn';
    x.setAttribute('aria-label', 'Dismiss notice');
    x.textContent = '×';
    x.addEventListener('click', () => {
      S.notices = S.notices.filter((m) => m !== n);
      renderNotices();
    });
    row.appendChild(x);
    box.appendChild(row);
  }
}

/* ---------- error card ---------- */

function buildErrorCard(err, onRetry) {
  const info = userMessage(err, { currentModel: S.settings && S.settings.model });
  const card = document.createElement('div');
  card.className = 'err-card';
  const h = document.createElement('h3');
  h.textContent = info.title;
  const p = document.createElement('p');
  p.textContent = info.body;
  card.append(h, p);
  const actions = document.createElement('div');
  actions.className = 'actions';
  const mk = (label, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn';
    b.textContent = label;
    b.addEventListener('click', fn);
    actions.appendChild(b);
  };
  for (const a of info.actions) {
    if (a === 'retry') mk('Retry', onRetry);
    else if (a === 'settings') mk('Settings', () => chrome.runtime.openOptionsPage());
    else if (a === 'switchModel') {
      mk('Switch to default model', async () => {
        S.settings = await saveSettings({ model: DEFAULT_MODEL });
        updateModelLabel();
        onRetry();
      });
    }
  }
  if (actions.childElementCount) card.appendChild(actions);
  announce(info.title);
  return card;
}

/* ---------- controls ---------- */

function canChat() {
  return !S.busy && S.state === 'summary' && !!S.summaries[S.chatLength || S.length];
}

function updateControls() {
  const busy = S.busy;
  for (const b of $('lengthGroup').querySelectorAll('button')) b.disabled = busy;
  $('regenBtn').disabled = busy;
  $('copyBtn').disabled = !S.summaryRaw;
  $('stopBtn').hidden = !busy;
  const chat = canChat();
  $('question').disabled = !chat;
  $('sendBtn').disabled = !chat;
  $('newChatBtn').disabled = busy;
}

function setLengthUI(len) {
  for (const b of $('lengthGroup').querySelectorAll('button')) {
    const on = b.dataset.length === len;
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
  }
}

function updateModelLabel() {
  $('modelLabel').textContent = S.settings ? S.settings.model : '';
}

function renderSummary() {
  const body = $('summaryBody');
  body.replaceChildren(renderMarkdown(S.summaryRaw, document));
  if (S.summaryNote) {
    const n = document.createElement('span');
    n.className = 'stopped';
    n.textContent = S.summaryNote;
    body.appendChild(n);
  }
}

function setBusy(b) {
  S.busy = b;
  $('summaryBody').setAttribute('aria-busy', b ? 'true' : 'false');
  updateControls();
}

function scrollBottom() {
  const c = $('content');
  c.scrollTop = c.scrollHeight;
}

/* ---------- chat DOM ---------- */

function clearChatDom() {
  $('chat').replaceChildren();
}

function addUserBubble(text) {
  const d = document.createElement('div');
  d.className = 'msg-user';
  d.textContent = text;
  $('chat').appendChild(d);
  return d;
}

function addModelBubble(raw) {
  const wrap = document.createElement('div');
  wrap.className = 'msg-model';
  const body = document.createElement('div');
  body.className = 'md';
  const tools = document.createElement('div');
  tools.className = 'bubble-tools';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'link-btn';
  copy.textContent = 'Copy';
  copy.hidden = true;
  tools.appendChild(copy);
  wrap.append(body, tools);
  const bubble = { wrap, body, tools, copy, raw: raw || '' };
  copy.addEventListener('click', () => copyText(bubble.raw, copy, 'Copy'));
  if (raw) { body.replaceChildren(renderMarkdown(raw, document)); copy.hidden = false; }
  $('chat').appendChild(wrap);
  return bubble;
}

function restoreChatDom() {
  clearChatDom();
  for (const m of S.messages) {
    if (m.role === 'user') addUserBubble(m.text);
    else addModelBubble(m.text);
  }
}

async function copyText(text, labelEl, idleLabel) {
  try {
    await navigator.clipboard.writeText(text);
    labelEl.textContent = 'Copied';
  } catch {
    labelEl.textContent = 'Copy failed';
  }
  setTimeout(() => { labelEl.textContent = idleLabel; }, 1500);
}

/* ---------- cache ---------- */

async function saveEntry() {
  if (!S.urlKey || !S.page) return;
  try {
    await putCacheEntry(S.urlKey, {
      textHash: S.hash,
      source: S.page.source,
      summaries: S.summaries,
      chatLength: S.chatLength,
      messages: S.messages.slice(-20),
    });
  } catch (err) { logError(err); }
}

/* ---------- page loading ---------- */

async function loadPage({ ignoreSelection = false } = {}) {
  cancelStream();
  setView('init');
  S.notices = [];
  renderNotices();
  S.summaries = {};
  S.messages = [];
  S.chatLength = null;
  S.summaryRaw = '';
  S.summaryNote = '';

  let tab = null;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs && tabs[0];
  } catch (err) { logError(err); }
  if (!tab || tab.id == null) { showRestricted(MSG_RESTRICTED); return; }
  S.tab = tab;
  setTitle(tab.title || tab.url || '');

  const chk = isRestrictedUrl(tab.url || '');
  if (!chk.ok) { showRestricted(chk.reason); return; }

  let res = null;
  try {
    const out = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPage,
      args: [{ ignoreSelection, maxRawChars: S.settings.maxChars * 2 }],
    });
    res = out && out[0] && out[0].result;
  } catch (err) {
    showRestricted(chk.kind === 'file' ? MSG_FILE : MSG_RESTRICTED);
    return;
  }
  if (!res) { showRestricted(chk.kind === 'file' ? MSG_FILE : MSG_RESTRICTED); return; }
  if (res.contentType === 'application/pdf') { showRestricted(MSG_PDF); return; }
  if (res.title) setTitle(res.title);

  const cleaned = cleanText(res.text);
  if (res.source !== 'selection' && cleaned.length < 200) {
    S.pending = { res, cleaned };
    setView('empty');
    return;
  }
  await continueWith(res, cleaned);
}

async function continueWith(res, cleaned) {
  const tr = truncateText(cleaned, S.settings.maxChars);
  const url = res.url || (S.tab && S.tab.url) || '';
  S.page = {
    title: res.title || (S.tab && S.tab.title) || '',
    url,
    source: res.source,
    text: tr.text,
    truncated: tr.truncated,
    originalLength: tr.originalLength,
  };
  S.hash = fnv1a(tr.text);
  S.urlKey = normalizeUrlKey(url);

  S.notices = [];
  if (res.source === 'selection') {
    S.notices.push({
      text: `Summarising your selection (${res.selectionLength} characters).`,
      action: { label: 'Use whole page', run: () => loadPage({ ignoreSelection: true }) },
    });
  }
  if (tr.truncated) {
    S.notices.push({ text: `Long page: only the first ${tr.text.length} of ${tr.originalLength} characters were used.` });
  }
  if (pageKind(url) === 'youtube') {
    S.notices.push({ text: "Video transcripts aren't read. This summary covers the visible page text (title, description, comments)." });
  }
  renderNotices();

  let entry = null;
  try {
    entry = await getCacheEntry(S.urlKey);
    if (entry && entry.textHash !== S.hash) {
      await deleteCacheEntry(S.urlKey);
      entry = null;
    }
  } catch (err) { logError(err); entry = null; }

  S.summaries = (entry && entry.summaries) ? { ...entry.summaries } : {};
  let useLen = null;
  if (entry) {
    if (entry.chatLength && S.summaries[entry.chatLength]) useLen = entry.chatLength;
    else if (S.summaries[S.settings.defaultLength]) useLen = S.settings.defaultLength;
  }

  if (useLen) {
    S.length = useLen;
    S.chatLength = useLen;
    S.messages = Array.isArray(entry.messages) ? entry.messages.slice(-20) : [];
    S.summaryRaw = S.summaries[useLen];
    S.summaryNote = '';
    showSummaryView();
    restoreChatDom();
    updateControls();
    $('question').focus();
    return;
  }
  S.messages = [];
  S.chatLength = null;
  if (S.settings.autoSummarize) startSummary(S.settings.defaultLength);
  else setView('idle');
}

function showSummaryView() {
  setView('summary');
  setLengthUI(S.length);
  $('summaryError').hidden = true;
  $('summaryBody').hidden = false;
  renderSummary();
  updateModelLabel();
}

/* ---------- streaming ---------- */

function cancelStream() {
  if (S.ctrl) {
    const c = S.ctrl;
    S.ctrl = null;
    c.abort();
  }
  cancelRender();
  if (S.busy) S.busy = false;
}

async function startSummary(length) {
  cancelStream();
  S.length = length;
  S.chatLength = length;
  S.messages = [];
  S.summaryRaw = '';
  S.summaryNote = '';
  clearChatDom();
  showSummaryView();
  const ctrl = new AbortController();
  S.ctrl = ctrl;
  setBusy(true);
  S.retry = () => startSummary(length);
  try {
    const contents = buildContents({ page: S.page, nonce: S.nonce, length, summary: null, messages: [] });
    const r = await streamGenerate({
      apiKey: S.settings.apiKey,
      model: S.settings.model,
      body: buildRequestBody({ system: buildSystemPrompt(S.settings.language), contents }),
      signal: ctrl.signal,
      onText: (t) => {
        if (S.ctrl !== ctrl) return;
        S.summaryRaw = t;
        scheduleRender(renderSummary);
      },
    });
    if (S.ctrl !== ctrl) return;
    cancelRender();
    let text = r.text;
    if (r.finishReason === 'MAX_TOKENS') text += CUT_NOTE;
    S.summaryRaw = text;
    S.summaries[length] = text;
    renderSummary();
    await saveEntry();
    announce('Summary ready');
  } catch (err) {
    if (S.ctrl !== ctrl) return;
    cancelRender();
    if (err instanceof GeminiError && err.code === 'aborted') {
      S.summaryNote = '(stopped)';
      renderSummary();
    } else {
      if (!(err instanceof GeminiError)) logError(err);
      const card = buildErrorCard(err instanceof GeminiError ? err : new GeminiError('network', { message: err && err.message }), () => startSummary(length));
      $('summaryBody').hidden = true;
      const box = $('summaryError');
      box.replaceChildren(card);
      box.hidden = false;
    }
  }
  if (S.ctrl === ctrl) {
    S.ctrl = null;
    setBusy(false);
    if (canChat()) $('question').focus();
  }
}

function onLengthPick(len) {
  if (S.busy || len === S.length) return;
  if (S.summaries[len]) {
    S.length = len;
    S.chatLength = len;
    S.messages = [];
    S.summaryRaw = S.summaries[len];
    S.summaryNote = '';
    clearChatDom();
    showSummaryView();
    updateControls();
    saveEntry();
  } else {
    startSummary(len);
  }
}

/* ---------- chat ---------- */

function submitQuestion() {
  const input = $('question');
  const q = input.value.trim();
  if (!q || !canChat()) return;
  input.value = '';
  autoGrow();
  addUserBubble(q);
  const bubble = addModelBubble();
  runAnswer(q, bubble);
  scrollBottom();
}

async function runAnswer(q, bubble) {
  cancelRender();
  const ctrl = new AbortController();
  S.ctrl = ctrl;
  setBusy(true);
  bubble.wrap.querySelector('.err-card')?.remove();
  bubble.body.hidden = false;
  bubble.copy.hidden = true;
  bubble.raw = '';
  const think = document.createElement('span');
  think.className = 'thinking';
  think.textContent = 'Thinking…';
  bubble.body.replaceChildren(think);
  const summary = S.summaries[S.chatLength || S.length];
  const draw = () => { bubble.body.replaceChildren(renderMarkdown(bubble.raw, document)); scrollBottom(); };
  try {
    const contents = buildContents({
      page: S.page, nonce: S.nonce, length: S.chatLength || S.length, summary,
      messages: [...S.messages, { role: 'user', text: q }],
    });
    const r = await streamGenerate({
      apiKey: S.settings.apiKey,
      model: S.settings.model,
      body: buildRequestBody({ system: buildSystemPrompt(S.settings.language), contents }),
      signal: ctrl.signal,
      onText: (t) => {
        if (S.ctrl !== ctrl) return;
        bubble.raw = t;
        scheduleRender(draw);
      },
    });
    if (S.ctrl !== ctrl) return;
    cancelRender();
    let text = r.text;
    if (r.finishReason === 'MAX_TOKENS') text += CUT_NOTE;
    bubble.raw = text;
    draw();
    bubble.copy.hidden = false;
    S.messages.push({ role: 'user', text: q }, { role: 'model', text });
    S.messages = S.messages.slice(-20);
    await saveEntry();
    announce('Answer ready');
  } catch (err) {
    if (S.ctrl !== ctrl) return;
    cancelRender();
    if (err instanceof GeminiError && err.code === 'aborted') {
      draw();
      const n = document.createElement('span');
      n.className = 'stopped';
      n.textContent = '(stopped)';
      bubble.body.appendChild(n);
    } else {
      if (!(err instanceof GeminiError)) logError(err);
      bubble.body.hidden = true;
      bubble.wrap.insertBefore(
        buildErrorCard(err instanceof GeminiError ? err : new GeminiError('network', { message: err && err.message }), () => runAnswer(q, bubble)),
        bubble.tools,
      );
    }
  }
  if (S.ctrl === ctrl) {
    S.ctrl = null;
    setBusy(false);
    if (canChat()) $('question').focus();
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

/* ---------- needKey ---------- */

async function saveKeyFromCard() {
  const k = $('keyInput').value.trim();
  if (!k) { $('keyMsg').textContent = 'Paste your API key first.'; return; }
  $('keyMsg').textContent = '';
  S.settings = await saveSettings({ apiKey: k });
  $('keyInput').value = '';
  loadPage();
}

/* ---------- wiring ---------- */

function wire() {
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
  $('tryAnyway').addEventListener('click', async () => {
    if (!S.pending) return;
    const { res, cleaned } = S.pending;
    S.pending = null;
    setView('init');
    await continueWith(res, cleaned);
  });
  $('summariseBtn').addEventListener('click', () => startSummary(S.settings.defaultLength));

  const group = $('lengthGroup');
  for (const b of group.querySelectorAll('button')) b.addEventListener('click', () => onLengthPick(b.dataset.length));
  group.addEventListener('keydown', (e) => {
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'];
    if (!keys.includes(e.key) || S.busy) return;
    e.preventDefault();
    const btns = [...group.querySelectorAll('button')];
    const cur = btns.findIndex((b) => b.getAttribute('aria-checked') === 'true');
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    const next = btns[(cur + dir + btns.length) % btns.length];
    next.focus();
    onLengthPick(next.dataset.length);
  });

  $('regenBtn').addEventListener('click', () => { if (!S.busy) startSummary(S.length); });
  $('copyBtn').addEventListener('click', () => copyText(S.summaryRaw, $('copyLabel'), '⧉'));
  $('stopBtn').addEventListener('click', () => { if (S.ctrl) S.ctrl.abort(); });
  $('sendBtn').addEventListener('click', submitQuestion);
  $('newChatBtn').addEventListener('click', () => {
    if (S.busy) return;
    S.messages = [];
    clearChatDom();
    saveEntry();
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

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    try {
      const was = S.settings;
      S.settings = await getSettings();
      updateModelLabel();
      if (S.state === 'needKey' && S.settings.apiKey && !(was && was.apiKey)) loadPage();
    } catch (err) { logError(err); }
  });
}

async function init() {
  wire();
  try {
    S.settings = await getSettings();
  } catch (err) {
    logError(err);
    showRestricted('Could not read settings.');
    return;
  }
  if (!S.settings.apiKey) { setView('needKey'); $('keyInput').focus(); return; }
  await loadPage();
}

init();
