// Per-tab state, tab following, access checks and agent injection (spec section 4).
// This module owns TabState and the load/show/navigate logic. It never touches the DOM: it asks the UI
// (panel/page.js, wired in sidepanel.js) to draw through the hooks given to initTabs().
import { getSettings, getCacheEntry, deleteCacheEntry } from '../lib/storage.js';
import {
  isRestrictedUrl, pageKind, normalizeUrlKey, MSG_FILE, MSG_RESTRICTED, MSG_PDF_UNSUPPORTED,
} from '../lib/text.js';
import { renumberFrames, selectChunks, chunkHash } from '../lib/chunks.js';
import { validateAgentEvent, isTrustedAgentSender } from '../lib/messages.js';
import { makeNonce } from '../lib/prompts.js';
import { redactKey } from '../lib/errors.js';

// Injected together, in this order, with chrome.scripting.executeScript({ files }). Later phases append
// 'content/media.js' (phase 2) and 'content/guide.js' (phase 3).
export const CONTENT_FILES = ['content/core.js', 'content/extract.js', 'content/highlight.js'];
export const CSS_FILES = ['content/agent.css'];

export const AUTO_DELAY_MS = 1000;      // a tab must stay shown this long before an automatic summary (spec B12)
const ACTIVATE_DEBOUNCE_MS = 300;
const NAVIGATE_DEBOUNCE_MS = 700;
const MAX_STREAMS = 2;

export const app = { settings: null, windowId: null, shownTabId: null };
export const states = new Map();

let hooks = {
  render() {}, setTitle() {}, startSummary() {}, abortUi() {},
};

/* ---------- state ---------- */

export function newConv() {
  return {
    length: 'medium',
    summaries: {},            // { short?, medium?, detailed? } raw markdown with citation tokens
    chatLength: null,
    messages: [],             // [{ role, text }]
    summaryRaw: '',
    summaryNote: '',
    summaryError: null,       // { err, retry } while the summary card shows an error
    nonce: makeNonce(),       // fixed for the whole conversation so the prompt prefix stays byte-identical
    pendingAnswer: null,      // { q, raw } while a chat answer streams
  };
}

export function newState(tabId) {
  return {
    tabId,
    urlKey: '', url: '', title: '',
    access: 'unknown',        // 'unknown' | 'ok' | 'need' | 'restricted'
    restrictedReason: '',
    kind: 'html',             // 'html' | 'pdf' | 'youtube' | 'selection' (pdf/youtube flows arrive in phase 2)
    view: 'init',             // 'init' | 'needKey' | 'restricted' | 'needAccess' | 'empty' | 'idle' | 'summary'
    host: '', origin: '',     // for the needAccess view
    page: null,               // PageModel, null until extracted
    hash: '',
    stale: false,
    conv: newConv(),
    ctrl: null,               // AbortController of the in-flight request for THIS tab
    streamAt: 0,
    cache: null,              // explicit cache handle (phase 2)
    guide: null, tool: null,  // phase 3
    notices: [],              // [{ key?, text, action?: { label, run } }]
    pending: null,            // 'empty' view: the extraction to use if the user presses "Try anyway"
    ignoreSelection: false,
    loadGen: 0, loading: false, refreshing: false,
    autoPending: false, autoTimer: 0, shownAt: 0,
  };
}

export function ensureState(tabId) {
  let st = states.get(tabId);
  if (!st) { st = newState(tabId); states.set(tabId, st); }
  return st;
}

export const getState = (tabId) => states.get(tabId) || null;
export const shownState = () => (app.shownTabId == null ? null : states.get(app.shownTabId) || null);
export const isShown = (st) => !!st && st.tabId === app.shownTabId;

function notify(st) {
  if (isShown(st)) hooks.render(st);
}

export function addNotice(st, notice) {
  if (notice.key) st.notices = st.notices.filter((n) => n.key !== notice.key);
  st.notices.push(notice);
}
export function removeNotice(st, key) {
  st.notices = st.notices.filter((n) => n.key !== key);
}

export function abortStream(st) {
  if (st.ctrl) {
    const c = st.ctrl;
    st.ctrl = null;
    c.abort();
  }
  st.conv.pendingAnswer = null;
}

// Starting a third concurrent stream aborts the oldest background one (spec 4.1).
export function enforceStreamLimit(except) {
  const live = [...states.values()].filter((s) => s.ctrl && s !== except);
  while (live.length >= MAX_STREAMS) {
    live.sort((a, b) => a.streamAt - b.streamAt);
    const victim = live.find((s) => !isShown(s)) || live[0];
    live.splice(live.indexOf(victim), 1);
    abortStream(victim);
    hooks.abortUi(victim);
  }
}

export function resetState(st) {
  abortStream(st);
  clearTimeout(st.autoTimer);
  Object.assign(st, {
    urlKey: '', page: null, hash: '', stale: false, conv: newConv(), notices: [], pending: null,
    ignoreSelection: false, autoPending: false, view: 'init', access: 'unknown', restrictedReason: '',
    guide: null, tool: null, cache: null,
  });
}

/* ---------- agent access ---------- */

// Command channel panel -> agent (spec 6.1). The agent has no inbound listener; every call is an executeScript.
export async function callAgent(tabId, name, args, { frameIds, allFrames } = {}) {
  const target = frameIds ? { tabId, frameIds } : { tabId, allFrames: !!allFrames };
  const out = await chrome.scripting.executeScript({
    target,
    func: (n, a) => (globalThis.__PageSum ? globalThis.__PageSum.call(n, a) : { ok: false, error: { code: 'no_agent' } }),
    args: [name, args ?? {}],
  });
  return out.map((r) => ({ frameId: r.frameId, ...(r.result || { ok: false, error: { code: 'no_result' } }) }));
}

// Throws when the tab can't be read (no activeTab grant and no host permission, or a restricted page).
export async function ensureAgent(tabId, { allFrames = false } = {}) {
  try {
    const r = await callAgent(tabId, 'ping', {}, { frameIds: [0] });
    if (r[0] && r[0].ok) return;
  } catch { /* not injected yet, or no access: injecting below throws if there is truly no access */ }
  const target = { tabId, allFrames };
  await chrome.scripting.executeScript({ target, files: CONTENT_FILES });
  await chrome.scripting.insertCSS({ target, files: CSS_FILES });
}

export function originPattern(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    // hostname, not host: a match pattern with a port is easy to get wrong and a bad pattern makes the request throw.
    return { origin: `${u.protocol}//${u.hostname}/*`, host: u.hostname };
  } catch { return null; }
}

async function extractModel(tabId, { ignoreSelection }) {
  const maxChars = app.settings.maxChars;
  const out = await callAgent(tabId, 'extract', {
    ignoreSelection, maxRawChars: maxChars * 2, maxChunkChars: 600, structured: false,
  }, { frameIds: [0] });
  const main = out[0];
  if (!main || !main.ok) throw new Error((main && main.error && main.error.code) || 'no_result');
  const res = main.data;
  const { chunks, frames } = renumberFrames([{ frameId: 0, result: res }]);
  const sel = selectChunks(chunks, maxChars);
  const model = {
    title: res.title || '',
    url: res.url || '',
    source: res.source,
    kind: 'html',
    chunks: sel.chunks,
    truncated: sel.truncated || !!res.truncatedRaw,
    originalLength: sel.originalLength,
    frames,
    selectionLength: res.selectionLength || 0,
    hasPasswordField: !!res.hasPasswordField,
  };
  return { res, model, hash: chunkHash(sel.chunks) };
}

const totalChars = (model) => model.chunks.reduce((n, c) => n + c.text.length, 0);

/* ---------- load ---------- */

// Sensitive-page guard (spec 12.3) arrives in phase 3. One place to hook it in.
function isSensitive() { return { sensitive: false, reason: null }; }

export async function load(tabId, { ignoreSelection, force = false } = {}) {
  const st = ensureState(tabId);
  const gen = ++st.loadGen;
  const superseded = () => st.loadGen !== gen;
  if (ignoreSelection !== undefined) st.ignoreSelection = !!ignoreSelection;
  abortStream(st);
  clearTimeout(st.autoTimer);
  st.loading = true;
  st.view = 'init';
  st.notices = [];
  st.pending = null;
  st.autoPending = false;
  notify(st);
  try {
    app.settings = await getSettings();
    if (superseded()) return;
    if (!app.settings.apiKey) { st.view = 'needKey'; return; }

    let tab = null;
    try { tab = await chrome.tabs.get(tabId); } catch { tab = null; }
    if (superseded()) return;
    if (!tab) { setRestricted(st, MSG_RESTRICTED); return; }
    st.url = tab.url || '';
    st.title = tab.title || '';
    hooks.setTitle(st);

    let chk = { ok: true };
    if (tab.url) {
      chk = isRestrictedUrl(tab.url, { title: tab.title });
      if (!chk.ok) { setRestricted(st, chk.reason); return; }
      const kind = pageKind(tab.url);
      if (kind === 'pdf') { setRestricted(st, MSG_PDF_UNSUPPORTED); return; } // phase 2 replaces this with the PDF flow
      st.kind = kind === 'youtube' ? 'youtube' : 'html';
    }

    try {
      // Phase 2: allFrames: app.settings.readFrames, with a main-frame-only retry (spec 4.3 step 4 and 18.8).
      await ensureAgent(tabId, { allFrames: false });
    } catch (err) {
      if (superseded()) return;
      if (chk.kind === 'file') { setRestricted(st, MSG_FILE); return; }
      setNeedAccess(st, tab.url || '');
      return;
    }
    if (superseded()) return;

    let got;
    try {
      got = await extractModel(tabId, { ignoreSelection: st.ignoreSelection });
    } catch (err) {
      if (superseded()) return;
      logError(err);
      setNeedAccess(st, tab.url || '');
      return;
    }
    if (superseded()) return;
    const { res, model, hash } = got;
    if (res.contentType === 'application/pdf') { setRestricted(st, MSG_PDF_UNSUPPORTED); return; }
    st.access = 'ok';
    if (res.title) { st.title = res.title; hooks.setTitle(st); }

    if (model.source !== 'selection' && totalChars(model) < 200) {
      st.pending = { res, model, hash };
      st.view = 'empty';
      return;
    }
    await continueWith(st, got, { force, superseded });
  } finally {
    if (!superseded()) { st.loading = false; notify(st); armAuto(st); }
  }
}

function setRestricted(st, reason) {
  st.access = 'restricted';
  st.restrictedReason = reason;
  st.view = 'restricted';
}

function setNeedAccess(st, url) {
  st.access = 'need';
  const o = url ? originPattern(url) : null;
  st.host = o ? o.host : '';
  st.origin = o ? o.origin : '';
  st.view = 'needAccess';
}

// "Try anyway" on the empty view, and the normal path once a page has enough text.
export async function continueWith(st, { res, model, hash }, { force = false, superseded = () => false } = {}) {
  const url = res.url || st.url || '';
  st.page = model;
  st.hash = hash;
  st.urlKey = normalizeUrlKey(url);
  st.stale = false;
  st.conv = newConv();
  st.notices = [];
  if (model.source === 'selection') {
    st.notices.push({
      key: 'selection',
      text: `Summarising your selection (${model.selectionLength || totalChars(model)} characters).`,
      action: { label: 'Use whole page', run: () => load(st.tabId, { ignoreSelection: true }) },
    });
  }
  if (model.truncated) {
    st.notices.push({ key: 'truncated', text: `Long page: only the first ${totalChars(model)} of ${model.originalLength} characters were used.` });
  }
  if (pageKind(url) === 'youtube') {
    st.notices.push({ key: 'youtube', text: "Video transcripts aren't read. This summary covers the visible page text (title, description, comments)." });
  }

  let entry = null;
  if (force) {
    try { await deleteCacheEntry(st.urlKey); } catch (err) { logError(err); }
  } else {
    try {
      entry = await getCacheEntry(st.urlKey);
      if (entry && entry.textHash !== hash) { await deleteCacheEntry(st.urlKey); entry = null; }
    } catch (err) { logError(err); entry = null; }
  }
  if (superseded()) return;

  const summaries = entry && entry.summaries ? { ...entry.summaries } : {};
  let useLen = null;
  if (entry) {
    if (entry.chatLength && summaries[entry.chatLength]) useLen = entry.chatLength;
    else if (summaries[app.settings.defaultLength]) useLen = app.settings.defaultLength;
  }
  if (useLen) {
    st.conv.summaries = summaries;
    st.conv.length = useLen;
    st.conv.chatLength = useLen;
    st.conv.messages = Array.isArray(entry.messages) ? entry.messages.slice(-20) : [];
    st.conv.summaryRaw = summaries[useLen];
    st.view = 'summary';
    return;
  }
  if (force) {
    st.view = 'summary';
    hooks.startSummary(st, app.settings.defaultLength);
    return;
  }
  if (app.settings.autoSummarize && !isSensitive(st).sensitive) {
    st.autoPending = true;     // fires after the tab has stayed shown for AUTO_DELAY_MS (armAuto)
    st.view = 'init';
  } else {
    st.view = 'idle';
  }
}

// "Try anyway" on the empty view.
export async function tryAnyway(st) {
  const p = st.pending;
  if (!p || st.loading) return;
  st.pending = null;
  st.loading = true;
  st.view = 'init';
  notify(st);
  try {
    await continueWith(st, p);
  } finally {
    st.loading = false;
    notify(st);
    armAuto(st);
  }
}

// B12: never spend quota on a tab that was only passed through (ctrl-tab bursts).
export function armAuto(st) {
  clearTimeout(st.autoTimer);
  if (!st.autoPending || !isShown(st) || st.loading) return;
  const wait = Math.max(0, AUTO_DELAY_MS - (Date.now() - st.shownAt));
  st.autoTimer = setTimeout(() => {
    if (!st.autoPending || !isShown(st) || st.loading || !st.page) return;
    st.autoPending = false;
    st.view = 'summary';
    hooks.startSummary(st, app.settings.defaultLength);
  }, wait);
}

/* ---------- show / refresh / navigate ---------- */

export function show(tabId, activatedAt = Date.now()) {
  const prev = shownState();
  if (prev && prev.tabId !== tabId) clearTimeout(prev.autoTimer);
  app.shownTabId = tabId;
  const st = ensureState(tabId);
  st.shownAt = activatedAt;
  hooks.render(st);
  if (st.loading) return;
  const reload = !st.page || ['needKey', 'restricted', 'needAccess', 'empty'].includes(st.view);
  if (reload) { load(tabId); return; }
  armAuto(st);
  refresh(st);
}

const STALE_KEY = 'stale';

// Silent re-extraction when a tab is shown again or its content may have changed. Costs no quota.
export async function refresh(st) {
  if (st.refreshing || st.loading || !st.page || st.ctrl) return;
  st.refreshing = true;
  let changed = false;
  try {
    await ensureAgent(st.tabId);
    const got = await extractModel(st.tabId, { ignoreSelection: st.page.source !== 'selection' });
    if (!st.page || st.ctrl || st.loading) return;
    if (got.hash === st.hash) {
      st.page = { ...st.page, chunks: got.model.chunks };     // same text: refresh local ids so highlights stay exact
      return;                                                  // nothing visible changed: no redraw
    }
    const hasConversation = Object.keys(st.conv.summaries).length > 0;
    if (hasConversation) {
      if (!st.stale) {
        st.stale = true;
        changed = true;
        addNotice(st, {
          key: STALE_KEY,
          text: 'This page changed since the summary.',
          action: { label: 'Re-summarise', run: () => load(st.tabId, { force: true }) },
        });
      }
    } else if (st.view !== 'summary') {
      st.page = got.model;
      st.hash = got.hash;
      changed = true;
    }
  } catch { /* access lost or tab gone: keep what we have */ } finally {
    st.refreshing = false;
    if (changed) notify(st);
  }
}

export async function onNavigated(tabId, href) {
  const st = states.get(tabId);
  if (!st || st.loading) return;
  let url = href;
  if (!url) {
    try { url = (await chrome.tabs.get(tabId)).url; } catch { return; }
  }
  const key = url ? normalizeUrlKey(url) : '';
  const shown = tabId === app.shownTabId;
  if (st.urlKey && key && key !== st.urlKey) {
    resetState(st);                       // new page: new conversation, guide cleared
    if (shown) load(tabId); else notify(st);
    return;
  }
  if (!st.urlKey) {                       // never read successfully (needAccess / restricted / needKey)
    if (shown) load(tabId);
    return;
  }
  if (shown) refresh(st);                 // same URL: content may have changed (hash check)
}

/* ---------- init and chrome events ---------- */

function logError(err) {
  console.error(redactKey(String((err && err.message) || err)));
}

export async function initTabs(h) {
  hooks = { ...hooks, ...h };
  const win = await chrome.windows.getCurrent();
  app.windowId = win.id;

  let activateTimer = 0;
  chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
    if (windowId !== app.windowId) return;
    const at = Date.now();
    clearTimeout(activateTimer);
    activateTimer = setTimeout(() => show(tabId, at), ACTIVATE_DEBOUNCE_MS);
  });

  const navTimers = new Map();
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    const st = states.get(tabId);
    if (!st) return;
    if (typeof info.title === 'string' && info.title) {
      st.title = info.title;
      if (isShown(st)) hooks.setTitle(st);
    }
    if (info.url === undefined && info.status !== 'complete') return;
    clearTimeout(navTimers.get(tabId));
    navTimers.set(tabId, setTimeout(() => { navTimers.delete(tabId); onNavigated(tabId); }, NAVIGATE_DEBOUNCE_MS));
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    const st = states.get(tabId);
    if (!st) return;
    abortStream(st);
    clearTimeout(st.autoTimer);
    clearTimeout(navTimers.get(tabId));
    navTimers.delete(tabId);
    // Phase 2: delete this tab's explicit cache best-effort here.
    states.delete(tabId);
    if (app.shownTabId === tabId) app.shownTabId = null;
  });

  // The service worker records an activeTab grant when the icon or Alt+Shift+S is used.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session' || !changes.activeTabGrant) return;
    const g = changes.activeTabGrant.newValue;
    const st = shownState();
    if (!g || !st || g.tabId !== st.tabId || st.loading) return;
    if (st.access === 'need' || st.access === 'unknown' || st.view === 'needAccess') load(st.tabId);
  });

  // Agent events (spec 6.2): the only page-originated channel. Validated, and the tab id comes from the sender.
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!isTrustedAgentSender(sender, chrome.runtime.id)) return false;
    const v = validateAgentEvent(msg);
    if (!v.ok) return false;
    if (sender.tab.windowId !== app.windowId) return false;
    const st = states.get(sender.tab.id);
    if (!st) return false;
    if (v.event === 'navigated' && sender.frameId === 0) onNavigated(sender.tab.id, v.data.href);
    // 'escape' needs no action (the agent already cleared its highlight). 'guideTargetLost' is handled in phase 3.
    return false;
  });

  const tabs = await chrome.tabs.query({ active: true, windowId: app.windowId });
  if (tabs && tabs[0] && tabs[0].id != null) show(tabs[0].id);
  else hooks.render(null);
}
