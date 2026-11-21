// Per-tab state, tab following, access checks and loading (spec section 4).
// This module owns TabState and the load/show/navigate logic. It never touches the DOM: it asks the UI
// (panel/page.js, wired in sidepanel.js) to draw through the hooks given to initTabs().
import { getSettings, getCacheEntry, deleteCacheEntry } from '../lib/storage.js';
import {
  isRestrictedUrl, pageKind, normalizeUrlKey, fnv1a, MSG_FILE, MSG_RESTRICTED,
} from '../lib/text.js';
import { renumberFrames, selectChunks, chunkHash, buildStructure } from '../lib/chunks.js';
import { validateAgentEvent, isTrustedAgentSender } from '../lib/messages.js';
import { makeNonce } from '../lib/prompts.js';
import { redactKey, GeminiError } from '../lib/errors.js';
import { videoIdFromUrl, canonicalVideoUrl, estimateVideoTokens, LONG_VIDEO_SECONDS } from '../lib/youtube.js';
import { shouldOfferVision } from '../lib/vision.js';
import { classifySensitive } from '../lib/sensitive.js';
import { deleteCache } from '../lib/cachectl.js';
import { callAgent, ensureAgent, CONTENT_FILES, CSS_FILES } from './agent.js';
import { loadPdf, PdfAccessError, readVideoInfo, readVisualHints } from './media.js';

export { callAgent, ensureAgent, CONTENT_FILES, CSS_FILES };

export const AUTO_DELAY_MS = 1000;      // a tab must stay shown this long before an automatic summary (spec B12)
const ACTIVATE_DEBOUNCE_MS = 300;
const NAVIGATE_DEBOUNCE_MS = 700;
const MAX_STREAMS = 2;
const VIDEO_TEXT_CHARS = 8000;          // title / description / comments sent next to a YouTube video

export const app = { settings: null, windowId: null, shownTabId: null };
export const states = new Map();

let hooks = {
  render() {}, setTitle() {}, startSummary() {}, startVision() {}, abortUi() {}, guideTargetLost() {}, guideContinue() {},
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
    kind: 'html',             // 'html' | 'pdf' | 'youtube' | 'image'
    view: 'init',             // 'init' | 'needKey' | 'restricted' | 'needAccess' | 'empty' | 'idle' | 'summary'
    host: '', origin: '',     // for the needAccess view
    page: null,               // PageModel (kind html | pdf | video | image), null until extracted
    hash: '',
    stale: false,
    conv: newConv(),
    ctrl: null,               // AbortController of the in-flight request for THIS tab
    streamAt: 0,
    cache: null,              // explicit context cache handle { name, expireAt, model, summary } (spec 8.7)
    media: null,              // PDF bytes / screenshot / transcript kept for follow-ups (never persisted)
    idleLabel: '',            // label of the idle view's button ("Summarise video")
    frames: false,            // the agent is injected into embedded frames too
    guide: null, tool: null,  // phase 3: GuideState and the last quick-action result
    sensitive: null,          // { sensitive, reason } from the privacy guard (spec 12.3)
    notices: [],              // [{ key?, text, action?: { label, run } }]
    pending: null,            // 'empty' view: the extraction to use if the user presses "Try anyway"
    ignoreSelection: false,
    loadGen: 0, loading: false, refreshing: false,
    autoPending: false, autoVision: false, autoTimer: 0, shownAt: 0,
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

// Deletes this tab's explicit context cache (best effort). Called on New chat, re-summarise, navigation and tab close.
export function dropCache(st) {
  const c = st.cache;
  st.cache = null;
  if (c && c.name && app.settings && app.settings.apiKey) deleteCache({ apiKey: app.settings.apiKey, name: c.name }).catch(() => {});
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
  if (st.tool && st.tool.ctrl) st.tool.ctrl.abort();
  dropCache(st);
  clearTimeout(st.autoTimer);
  Object.assign(st, {
    urlKey: '', page: null, hash: '', stale: false, conv: newConv(), notices: [], pending: null, media: null,
    ignoreSelection: false, autoPending: false, autoVision: false, idleLabel: '', view: 'init', access: 'unknown',
    restrictedReason: '', guide: null, tool: null, sensitive: null,
  });
}

/* ---------- access helpers ---------- */

export function originPattern(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    // hostname, not host: a match pattern with a port is easy to get wrong and a bad pattern makes the request throw.
    return { origin: `${u.protocol}//${u.hostname}/*`, host: u.hostname };
  } catch { return null; }
}

/* ---------- extraction ---------- */

async function extractModel(tabId, { ignoreSelection, frames }) {
  const settings = app.settings;
  const maxChars = settings.maxChars;
  const args = {
    ignoreSelection, maxRawChars: maxChars * 2, maxChunkChars: 600, structured: !!settings.structuredExtraction,
  };
  let out;
  if (frames) {
    try { out = await callAgent(tabId, 'extract', args, { allFrames: true }); } catch { out = null; }
  }
  if (!out) out = await callAgent(tabId, 'extract', args, { frameIds: [0] });
  const main = out.find((o) => o.frameId === 0);
  if (!main || !main.ok) throw new Error((main && main.error && main.error.code) || 'no_result');
  const res = main.data;
  const perFrame = [{ frameId: 0, result: res }];
  for (const o of out.filter((x) => x.frameId !== 0 && x.ok).sort((a, b) => a.frameId - b.frameId)) {
    perFrame.push({ frameId: o.frameId, result: o.data });
  }
  const { chunks, frames: frameCount } = renumberFrames(perFrame);
  const sel = selectChunks(chunks, maxChars);
  const model = {
    title: res.title || '',
    url: res.url || '',
    source: res.source,
    kind: 'html',
    chunks: sel.chunks,
    truncated: sel.truncated || !!res.truncatedRaw,
    originalLength: sel.originalLength,
    frames: frameCount,
    selectionLength: res.selectionLength || 0,
    hasPasswordField: !!res.hasPasswordField,
    ...buildStructure(res, sel.chunks),
  };
  return { res, model, hash: chunkHash(sel.chunks) };
}

const totalChars = (model) => model.chunks.reduce((n, c) => n + c.text.length, 0);

/* ---------- load ---------- */

// Privacy guard (spec 12.3). A host on the user's blocklist is always honoured; the login / banking / health /
// payment heuristics only apply while sensitiveGuard is on.
export function sensitiveFor(st, model, settings) {
  const c = classifySensitive({
    url: model.url || st.url, title: model.title || st.title, hasPasswordField: !!model.hasPasswordField, blocklist: settings.siteBlocklist,
  });
  if (c.reason === 'blocklist') return c;
  return settings.sensitiveGuard ? c : { sensitive: false, reason: null };
}

export async function load(tabId, { ignoreSelection, force = false } = {}) {
  const st = ensureState(tabId);
  const gen = ++st.loadGen;
  const superseded = () => st.loadGen !== gen;
  if (ignoreSelection !== undefined) st.ignoreSelection = !!ignoreSelection;
  abortStream(st);
  dropCache(st);
  clearTimeout(st.autoTimer);
  st.loading = true;
  st.view = 'init';
  st.notices = [];
  st.pending = null;
  st.autoPending = false;
  st.autoVision = false;
  st.idleLabel = '';
  st.media = null;
  st.sensitive = null;
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
      if (kind === 'pdf') { st.kind = 'pdf'; await loadPdfTab(st, tab, { force, superseded }); return; }
      st.kind = kind === 'youtube' ? 'youtube' : 'html';
    }

    const extraNotices = [];
    try {
      const inj = await ensureAgent(tabId, { allFrames: !!app.settings.readFrames });
      st.frames = inj.frames;
      if (inj.skipped) extraNotices.push({ key: 'frames-skipped', text: 'Embedded frames skipped.' });
    } catch (err) {
      if (superseded()) return;
      if (chk.kind === 'file') { setRestricted(st, MSG_FILE); return; }
      setNeedAccess(st, tab.url || '');
      return;
    }
    if (superseded()) return;

    let got;
    try {
      got = await extractModel(tabId, { ignoreSelection: st.ignoreSelection, frames: st.frames });
    } catch (err) {
      if (superseded()) return;
      logError(err);
      setNeedAccess(st, tab.url || '');
      return;
    }
    if (superseded()) return;
    got.extraNotices = extraNotices;
    if (got.res.contentType === 'application/pdf') { st.kind = 'pdf'; await loadPdfTab(st, tab, { force, superseded }); return; }
    st.access = 'ok';
    if (got.res.title) { st.title = got.res.title; hooks.setTitle(st); }

    if (st.kind === 'youtube' && got.model.source !== 'selection') {
      const vm = await toVideoModel(st, got);
      if (superseded()) return;
      if (vm) { got.model = vm.model; got.hash = vm.hash; }
    }

    // Vision (spec 8.8): is this page mostly a picture or canvas, or is its text tiny?
    if (app.settings.vision !== 'off' && got.model.kind === 'html' && got.model.source !== 'selection') {
      const hints = await readVisualHints(tabId);
      if (superseded()) return;
      got.offer = shouldOfferVision(hints, totalChars(got.model));
    }
    const autoVision = !!got.offer && app.settings.vision === 'auto' && app.settings.autoSummarize;

    if (got.model.kind === 'html' && got.model.source !== 'selection' && totalChars(got.model) < 200 && !autoVision) {
      st.pending = got;
      st.notices = [...extraNotices];
      if (got.offer && app.settings.vision === 'ask') addNotice(st, visionNotice(st));
      st.view = 'empty';
      return;
    }
    await continueWith(st, got, { force, superseded });
  } finally {
    if (!superseded()) {
      st.loading = false;
      if (st.guide && st.guide.needsContinue && st.view !== 'needKey') {
        st.guide.needsContinue = false;
        addNotice(st, { key: 'guide-continue', text: 'Page changed.', action: { label: 'Continue guide', run: () => hooks.guideContinue(st) } });
      }
      notify(st);
      armAuto(st);
    }
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

function visionNotice(st) {
  return {
    key: 'vision-offer',
    icon: 'camera',
    text: 'Little readable text.',
    action: { label: 'Read from screenshot', run: () => hooks.startVision(st) },
  };
}

// YouTube watch page: the video itself goes to Gemini by URL, the page text (title, description) rides along.
async function toVideoModel(st, got) {
  const id = videoIdFromUrl(got.res.url || st.url);
  if (!id) return null;
  const info = await readVideoInfo(st.tabId);
  const sel = selectChunks(got.model.chunks, VIDEO_TEXT_CHARS);
  return {
    hash: fnv1a(`video:${id}`),
    model: {
      title: got.model.title, url: got.model.url, source: 'video', kind: 'video',
      chunks: sel.chunks, truncated: false, originalLength: sel.originalLength, frames: got.model.frames,
      selectionLength: 0, hasPasswordField: false,
      video: { id, canonical: canonicalVideoUrl(id), duration: info ? info.duration : 0 },
    },
  };
}

// PDF tab: fetch the bytes (no quota used), check the size, then summarise like any page. Nothing is injected
// into the Chrome PDF viewer unless the panel's own fetch fails (fetchSelfPdf fallback).
async function loadPdfTab(st, tab, { force, superseded }) {
  const url = tab.url || st.url;
  let pdf;
  try {
    pdf = await loadPdf(st.tabId, url);
  } catch (err) {
    if (superseded()) return;
    if (err instanceof PdfAccessError) {
      if (err.kind === 'file') setRestricted(st, MSG_FILE); else setNeedAccess(st, url);
      return;
    }
    const e = err instanceof GeminiError ? err : new GeminiError('network', { message: err && err.message });
    if (!(err instanceof GeminiError)) logError(err);
    // Show the problem as an error card in the summary view. A page stub keeps show() from reloading on every visit.
    st.access = 'ok';
    st.urlKey = normalizeUrlKey(url);
    st.page = { title: tab.title || '', url, source: 'pdf', kind: 'pdf', chunks: [], truncated: false, originalLength: 0, frames: 0, selectionLength: 0, hasPasswordField: false, pdf: { bytes: 0, pages: null, level: undefined } };
    st.conv = newConv();
    st.conv.summaryError = { err: e, retry: e.code === 'too_large' ? null : () => load(st.tabId) };
    st.view = 'summary';
    return;
  }
  if (superseded()) return;
  st.access = 'ok';
  st.media = { kind: 'pdf', ...pdf };
  const model = {
    title: tab.title || '', url, source: 'pdf', kind: 'pdf', chunks: [], truncated: false, originalLength: 0,
    frames: 0, selectionLength: 0, hasPasswordField: false,
    pdf: { bytes: pdf.bytes, pages: pdf.pages, level: pdf.level },
  };
  await continueWith(st, { res: { url, title: model.title }, model, hash: fnv1a(`pdf:${pdf.bytes}:${pdf.pages}`), extraNotices: [] }, { force, superseded });
}

// "Try anyway" on the empty view, and the normal path once a page has enough text.
export async function continueWith(st, got, { force = false, superseded = () => false } = {}) {
  const { res, model, hash } = got;
  const settings = app.settings;
  const url = res.url || st.url || '';
  st.page = model;
  st.hash = hash;
  st.urlKey = normalizeUrlKey(url);
  st.stale = false;
  st.conv = newConv();
  st.sensitive = sensitiveFor(st, model, settings);
  st.notices = [...(got.extraNotices || [])];
  if (model.source === 'selection') {
    st.notices.push({
      key: 'selection',
      text: `Summarising your selection (${model.selectionLength || totalChars(model)} characters).`,
      action: { label: 'Use whole page', run: () => load(st.tabId, { ignoreSelection: true }) },
    });
  }
  if (model.truncated && model.kind === 'html') {
    st.notices.push({ key: 'truncated', text: `Long page: only the first ${totalChars(model)} of ${model.originalLength} characters were used.` });
  }
  if (model.kind === 'html' && pageKind(url) === 'youtube') {
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
    else if (summaries[settings.defaultLength]) useLen = settings.defaultLength;
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
  const autoVision = !!got.offer && settings.vision === 'auto' && settings.autoSummarize;
  if (got.offer && settings.vision === 'ask') addNotice(st, visionNotice(st));
  if (force) {
    st.view = 'summary';
    hooks.startSummary(st, settings.defaultLength);
    return;
  }
  // Long video: asking first protects the free quota (about 100 tokens per second of video).
  if (model.kind === 'video' && settings.youtubeMode === 'video' && model.video.duration > LONG_VIDEO_SECONDS) {
    const mins = Math.round(model.video.duration / 60);
    const k = Math.round(estimateVideoTokens(model.video.duration) / 1000);
    addNotice(st, { key: 'long-video', icon: 'info', text: `This video is ${mins} min (about ${k}k tokens of your free quota).` });
    st.idleLabel = 'Summarise video';
    st.view = 'idle';
    return;
  }
  if (st.sensitive.sensitive) {
    // No automatic request and nothing saved to history. The user can still press the button.
    st.idleLabel = 'Summarise anyway';
    st.view = 'idle';
    return;
  }
  if (settings.autoSummarize) {
    st.autoPending = true;     // fires after the tab has stayed shown for AUTO_DELAY_MS (armAuto)
    st.autoVision = autoVision;
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
    if (st.autoVision) { st.autoVision = false; hooks.startVision(st); } else hooks.startSummary(st, app.settings.defaultLength);
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
  if (reload && !(st.page && st.page.kind === 'pdf')) { load(tabId); return; }
  armAuto(st);
  refresh(st);
}

const STALE_KEY = 'stale';

// Silent re-extraction when a tab is shown again or its content may have changed. Costs no quota.
// Only for ordinary pages: a PDF, a video and a screenshot don't change under the summary.
export async function refresh(st) {
  if (st.refreshing || st.loading || !st.page || st.ctrl || st.page.kind !== 'html') return;
  st.refreshing = true;
  let changed = false;
  try {
    const inj = await ensureAgent(st.tabId, { allFrames: !!(app.settings && app.settings.readFrames) });
    st.frames = inj.frames;
    const got = await extractModel(st.tabId, { ignoreSelection: st.page.source !== 'selection', frames: st.frames });
    if (!st.page || st.ctrl || st.loading) return;
    if (got.hash === st.hash) {
      // same text: refresh local ids so highlights stay exact; structure (links, outline ids) follows the new ids
      st.page = { ...st.page, ...got.model, source: st.page.source };
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
    // A guide survives a move within the same site ("Page changed. Continue guide"); a different site clears it.
    const keep = st.guide && sameOrigin(st.url, url) ? st.guide : null;
    resetState(st);                       // new page: new conversation
    if (keep) st.guide = { ...keep, needsContinue: true, lost: false };
    st.url = url;
    if (shown) load(tabId); else notify(st);
    return;
  }
  if (!st.urlKey) {                       // never read successfully (needAccess / restricted / needKey)
    if (shown) load(tabId);
    return;
  }
  if (shown) refresh(st);                 // same URL: content may have changed (hash check)
}

function sameOrigin(a, b) {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
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
    dropCache(st);
    clearTimeout(st.autoTimer);
    clearTimeout(navTimers.get(tabId));
    navTimers.delete(tabId);
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
    if (v.event === 'guideTargetLost' && sender.frameId === 0) hooks.guideTargetLost(st, v.data.elementId);
    // 'escape' needs no action: the agent already cleared whatever it was showing.
    return false;
  });

  const tabs = await chrome.tabs.query({ active: true, windowId: app.windowId });
  if (tabs && tabs[0] && tabs[0].id != null) show(tabs[0].id);
  else hooks.render(null);
}
