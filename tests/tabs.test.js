// Integration test for panel/tabs.js: a fake chrome.* API whose executeScript runs the REAL content scripts
// (extension/content/*.js) inside vm sandboxes with the fake DOM. No browser involved.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import { el, t, makeEnv, plain } from './helpers/fakedom.js';
import {
  initTabs, show, load, app, states, ensureState, resetState, tryAnyway, onNavigated,
  enforceStreamLimit, AUTO_DELAY_MS,
} from '../extension/panel/tabs.js';
import { putCacheEntry } from '../extension/lib/storage.js';
import { MSG_FILE } from '../extension/lib/text.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PARA = 'The committee met on Tuesday and agreed to publish the final report next month. ';
const articleBody = (extra = '') => el('body', {}, el('article', {}, el('h1', {}, 'Big Title'), el('p', {}, PARA.repeat(12) + extra), el('p', {}, 'Second paragraph here. ' + PARA.repeat(4))));

function fakeArea() {
  const m = new Map();
  return {
    async get(key) { return m.has(key) ? { [key]: structuredClone(m.get(key)) } : {}; },
    async set(obj) { for (const [k, v] of Object.entries(obj)) m.set(k, structuredClone(v)); },
    async remove(key) { for (const k of Array.isArray(key) ? key : [key]) m.delete(k); },
  };
}

let H;
function harness({ tabs, active, key = 'k', settings = {}, bodies = {}, subs = {} }) {
  const local = fakeArea();
  const session = fakeArea();
  if (key !== null) local.set({ settings: { apiKey: key, ...settings } });
  const listeners = { activated: [], updated: [], removed: [], changed: [], message: [] };
  const envs = {};
  for (const [id, body] of Object.entries(bodies)) envs[id] = makeEnv({ body, href: tabs[id].url, title: tabs[id].title });
  // sub-frames: subs[tabId] = [{ frameId, env }]
  const frameList = (tabId) => [{ frameId: 0, env: envs[tabId] }, ...(subs[tabId] || [])];
  const chrome = {
    runtime: { id: 'ext-id', openOptionsPage() {}, onMessage: { addListener: (f) => listeners.message.push(f) } },
    windows: { getCurrent: async () => ({ id: 1 }) },
    tabs: {
      get: async (id) => { if (!tabs[id]) throw new Error('No tab'); return tabs[id]; },
      query: async () => (active == null ? [] : [tabs[active]]),
      onActivated: { addListener: (f) => listeners.activated.push(f) },
      onUpdated: { addListener: (f) => listeners.updated.push(f) },
      onRemoved: { addListener: (f) => listeners.removed.push(f) },
    },
    scripting: {
      async executeScript({ target, files, func, args }) {
        const main = envs[target.tabId];
        if (!main || main.denied) throw new Error('Cannot access contents of the page. Extension manifest must request permission to access the respective host.');
        let targets;
        if (target.frameIds) targets = frameList(target.tabId).filter((f) => target.frameIds.includes(f.frameId));
        else if (target.allFrames) {
          if (H.frameThrows) throw new Error('Cannot access a frame: extension manifest must request permission');
          targets = frameList(target.tabId);
        } else targets = [frameList(target.tabId)[0]];
        H.injects.push({ files: !!files, allFrames: !!target.allFrames, frameIds: target.frameIds });
        const out = [];
        for (const f of targets) {
          if (files) { f.env.load(files.map((x) => path.basename(x))); out.push({ frameId: f.frameId, result: null }); continue; }
          const fn = vm.runInContext(`(${func.toString()})`, f.env.ctx);
          out.push({ frameId: f.frameId, result: plain(await fn(...args)) });
        }
        return out;
      },
      async insertCSS() {},
    },
    storage: { local, session, onChanged: { addListener: (f) => listeners.changed.push(f) } },
  };
  globalThis.chrome = chrome;
  H = { chrome, listeners, envs, subs, local, session, tabs, injects: [], calls: { render: [], startSummary: [], startVision: [], abortUi: [] } };
  H.hooks = {
    render: (st) => H.calls.render.push(st && st.view),
    setTitle() {},
    startSummary: (st, len) => { H.calls.startSummary.push([st.tabId, len]); },
    startVision: (st) => { H.calls.startVision.push(st.tabId); },
    abortUi: (st) => H.calls.abortUi.push(st.tabId),
  };
  return H;
}

beforeEach(() => { states.clear(); app.settings = null; app.shownTabId = null; app.windowId = null; });
afterEach(() => {
  for (const st of states.values()) resetState(st);
  states.clear();
  delete globalThis.chrome;
});

const tabOf = (id, url, title = 'Page') => ({ id, url, title, windowId: 1 });

test('load: injects the agent, extracts chunks and schedules the automatic summary after 1 s', async () => {
  const h = harness({ tabs: { 1: tabOf(1, 'https://example.com/a?utm_source=x') }, active: 1, bodies: { 1: articleBody() } });
  await initTabs(h.hooks);
  const st = states.get(1);
  await sleep(60);
  assert.equal(st.loading, false);
  assert.equal(st.access, 'ok');
  assert.equal(st.page.source, 'article');
  assert.equal(st.page.chunks[0].id, 'c1');
  assert.equal(st.page.chunks[0].text, 'Big Title');
  assert.equal(st.page.chunks[0].kind, 'h');
  assert.match(st.hash, /^[0-9a-f]{8}$/);
  assert.equal(st.urlKey, 'https://example.com/a');
  assert.equal(st.view, 'init', 'waiting for the 1 s rule');
  assert.equal(st.autoPending, true);
  assert.deepEqual(h.calls.startSummary, []);
  await sleep(AUTO_DELAY_MS + 100);
  assert.deepEqual(h.calls.startSummary, [[1, 'medium']]);
  assert.equal(st.view, 'summary');
  assert.equal(st.autoPending, false);
});

test('B12: a tab that is only passed through never starts a summary', async () => {
  const h = harness({
    tabs: { 1: tabOf(1, 'https://a.com/1'), 2: tabOf(2, 'https://b.com/2') }, active: 1,
    bodies: { 1: articleBody(), 2: articleBody('Different text for tab two. ') },
  });
  await initTabs(h.hooks);
  await sleep(120);
  show(2);                       // user moves on before one second has passed
  await sleep(AUTO_DELAY_MS + 250);
  assert.deepEqual(h.calls.startSummary, [[2, 'medium']], 'only the tab that stayed shown is summarised');
  assert.equal(states.get(1).autoPending, true, 'tab 1 stays pending (no quota spent)');
  show(1);                       // coming back re-arms the 1 s wait
  await sleep(300);
  assert.equal(h.calls.startSummary.length, 1);
  await sleep(AUTO_DELAY_MS);
  assert.deepEqual(h.calls.startSummary.map((c) => c[0]), [2, 1]);
});

test('autoSummarize off: idle view, no automatic request', async () => {
  const h = harness({ tabs: { 1: tabOf(1, 'https://a.com/') }, active: 1, settings: { autoSummarize: false }, bodies: { 1: articleBody() } });
  await initTabs(h.hooks);
  await sleep(AUTO_DELAY_MS + 150);
  assert.equal(states.get(1).view, 'idle');
  assert.deepEqual(h.calls.startSummary, []);
});

test('no API key: needKey view and nothing is injected', async () => {
  const h = harness({ tabs: { 1: tabOf(1, 'https://a.com/') }, active: 1, key: null, bodies: { 1: articleBody() } });
  await initTabs(h.hooks);
  await sleep(40);
  assert.equal(states.get(1).view, 'needKey');
  assert.equal(h.envs[1].ctx.__PageSum, undefined, 'the agent was never injected');
});

test('restricted urls show the v1 messages; a blob PDF explains why it cannot be read', async () => {
  const h = harness({ tabs: { 1: tabOf(1, 'chrome://extensions'), 2: tabOf(2, 'https://chromewebstore.google.com/x'), 4: tabOf(4, 'blob:https://a.com/1', 'doc.pdf') }, active: 1 });
  await initTabs(h.hooks);
  await sleep(40);
  assert.equal(states.get(1).view, 'restricted');
  assert.equal(states.get(1).restrictedReason, "Chrome doesn't let extensions read this page.");
  await load(2);
  assert.equal(states.get(2).restrictedReason, "Chrome doesn't let extensions read the Web Store.");
  await load(4);
  assert.match(states.get(4).restrictedReason, /temporary in-page file/);
});

test('needAccess: executeScript fails on an http page; origin pattern and host are offered', async () => {
  const h = harness({ tabs: { 1: tabOf(1, 'https://shop.example.com:8443/cart?id=1') }, active: 1, bodies: { 1: articleBody() } });
  h.envs[1].denied = true;
  await initTabs(h.hooks);
  await sleep(40);
  const st = states.get(1);
  assert.equal(st.view, 'needAccess');
  assert.equal(st.access, 'need');
  assert.equal(st.host, 'shop.example.com');
  assert.equal(st.origin, 'https://shop.example.com/*');
});

test('needAccess without a url (no grant means no tab.url): only the icon hint and all-sites button apply', async () => {
  const h = harness({ tabs: { 1: tabOf(1, undefined) }, active: 1, bodies: { 1: articleBody() } });
  h.envs[1].denied = true;
  await initTabs(h.hooks);
  await sleep(40);
  const st = states.get(1);
  assert.equal(st.view, 'needAccess');
  assert.equal(st.origin, '');
  assert.equal(st.host, '');
});

test('file: pages that cannot be injected show the file-access hint', async () => {
  const h = harness({ tabs: { 1: tabOf(1, 'file:///C:/x/test.html') }, active: 1, bodies: { 1: articleBody() } });
  h.envs[1].denied = true;
  await initTabs(h.hooks);
  await sleep(40);
  assert.equal(states.get(1).view, 'restricted');
  assert.equal(states.get(1).restrictedReason, MSG_FILE);
});

test('an activeTab grant from the service worker reloads the shown needAccess tab', async () => {
  const h = harness({ tabs: { 1: tabOf(1, 'https://a.com/') }, active: 1, bodies: { 1: articleBody() } });
  h.envs[1].denied = true;
  await initTabs(h.hooks);
  await sleep(40);
  assert.equal(states.get(1).view, 'needAccess');
  h.envs[1].denied = false;
  for (const f of h.listeners.changed) f({ activeTabGrant: { newValue: { tabId: 2, at: 1 } } }, 'session');   // another tab: ignored
  await sleep(40);
  assert.equal(states.get(1).view, 'needAccess');
  for (const f of h.listeners.changed) f({ activeTabGrant: { newValue: { tabId: 1, at: 2 } } }, 'session');
  await sleep(80);
  assert.equal(states.get(1).access, 'ok');
  assert.ok(states.get(1).page);
  for (const f of h.listeners.changed) f({ activeTabGrant: { newValue: { tabId: 1, at: 3 } } }, 'local');      // wrong area: ignored
});

test('empty page: "empty" view, then Try anyway continues with what was extracted', async () => {
  const body = el('body', {}, el('p', {}, 'Tiny page.'));
  const h = harness({ tabs: { 1: tabOf(1, 'https://a.com/') }, active: 1, bodies: { 1: body } });
  await initTabs(h.hooks);
  await sleep(60);
  const st = states.get(1);
  assert.equal(st.view, 'empty');
  assert.ok(st.pending);
  await tryAnyway(st);
  assert.ok(st.page);
  assert.equal(st.page.chunks[0].text, 'Tiny page.');
  assert.equal(st.view, 'init', 'then the usual auto-summary wait');
  assert.equal(st.autoPending, true);
});

test('a selection becomes the page and shows the selection notice with a "Use whole page" action', async () => {
  const sel = 'This is a user selected paragraph of text, long enough to count.';
  const n = t(sel);
  const body = el('body', {}, el('p', {}, n), el('p', {}, PARA.repeat(20)));
  const h = harness({ tabs: { 1: tabOf(1, 'https://a.com/') }, active: 1 });
  h.envs[1] = makeEnv({ body, selection: { startNode: n, startOffset: 0, endNode: n, endOffset: sel.length, text: sel } });
  await initTabs(h.hooks);
  await sleep(60);
  const st = states.get(1);
  assert.equal(st.page.source, 'selection');
  assert.deepEqual(st.page.chunks.map((c) => c.text), [sel]);
  assert.ok(st.notices.some((x) => x.key === 'selection' && /selection/.test(x.text) && x.action.label === 'Use whole page'));
  st.notices.find((x) => x.key === 'selection').action.run();
  await sleep(80);
  assert.equal(st.page.source, 'body');
});

test('cache: a stored summary with the same text hash restores the conversation without a request', async () => {
  const h = harness({ tabs: { 1: tabOf(1, 'https://a.com/x') }, active: 1, bodies: { 1: articleBody() } });
  await initTabs(h.hooks);
  await sleep(60);
  const st = states.get(1);
  await putCacheEntry(st.urlKey, {
    textHash: st.hash, source: 'article', summaries: { medium: 'CACHED [c1]' }, chatLength: 'medium',
    messages: [{ role: 'user', text: 'q' }, { role: 'model', text: 'a' }],
  }, h.session);
  h.calls.startSummary.length = 0;
  await load(1);
  assert.equal(st.view, 'summary');
  assert.equal(st.conv.summaryRaw, 'CACHED [c1]');
  assert.equal(st.conv.messages.length, 2);
  assert.equal(st.autoPending, false);
  await sleep(AUTO_DELAY_MS + 100);
  assert.deepEqual(h.calls.startSummary, []);
  // a different text hash invalidates the entry
  await putCacheEntry(st.urlKey, { textHash: 'deadbeef', summaries: { medium: 'OLD' }, chatLength: 'medium', messages: [] }, h.session);
  await load(1);
  assert.notEqual(st.view, 'summary');
});

test('navigation to a new URL resets the conversation and reloads; same URL keeps it', async () => {
  const h = harness({ tabs: { 1: tabOf(1, 'https://a.com/one') }, active: 1, bodies: { 1: articleBody() } });
  await initTabs(h.hooks);
  await sleep(60);
  const st = states.get(1);
  st.autoPending = false; st.view = 'summary';
  st.conv.summaries.medium = 'S';
  st.conv.messages.push({ role: 'user', text: 'q' });
  let aborted = false;
  st.ctrl = { abort() { aborted = true; } };
  h.tabs[1].url = 'https://a.com/one#section';           // same page (fragment only)
  for (const f of h.listeners.updated) f(1, { url: h.tabs[1].url }, h.tabs[1]);
  await sleep(850);
  assert.equal(aborted, false);
  assert.equal(st.conv.summaries.medium, 'S');

  h.tabs[1].url = 'https://a.com/two';
  h.envs[1].sandbox.location.href = 'https://a.com/two';
  for (const f of h.listeners.updated) f(1, { url: h.tabs[1].url }, h.tabs[1]);
  await sleep(900);
  assert.equal(aborted, true, 'the in-flight stream of the old page is aborted');
  assert.deepEqual(st.conv.summaries, {});
  assert.deepEqual(st.conv.messages, []);
  assert.equal(st.urlKey, 'https://a.com/two');
});

test('a background tab that navigates is reset lazily and loaded when shown', async () => {
  const h = harness({
    tabs: { 1: tabOf(1, 'https://a.com/one'), 2: tabOf(2, 'https://b.com/') }, active: 1,
    bodies: { 1: articleBody(), 2: articleBody('other ') },
  });
  await initTabs(h.hooks);
  await sleep(60);
  show(2);
  await sleep(60);
  h.tabs[1].url = 'https://a.com/elsewhere';
  h.envs[1].sandbox.location.href = 'https://a.com/elsewhere';
  await onNavigated(1);
  assert.equal(states.get(1).page, null);
  assert.equal(states.get(1).view, 'init');
  show(1);
  await sleep(80);
  assert.equal(states.get(1).urlKey, 'https://a.com/elsewhere');
});

test('silent refresh on show: changed text after a summary sets stale and the Re-summarise notice; unchanged text does not', async () => {
  const h = harness({ tabs: { 1: tabOf(1, 'https://a.com/x'), 2: tabOf(2, 'https://b.com/') }, active: 1, bodies: { 1: articleBody(), 2: articleBody('b ') } });
  await initTabs(h.hooks);
  await sleep(60);
  const st = states.get(1);
  st.autoPending = false; st.view = 'summary'; st.conv.summaries.medium = 'S';
  show(2); await sleep(40);
  show(1); await sleep(80);
  assert.equal(st.stale, false, 'same text: no notice');
  assert.equal(st.notices.some((n) => n.key === 'stale'), false);

  const p = h.envs[1].body.childNodes[0].childNodes[1];    // first paragraph of the article
  p.childNodes[0].nodeValue = 'The page was completely rewritten after the summary was made, with entirely new content here. '.repeat(10);
  show(2); await sleep(40);
  show(1); await sleep(80);
  assert.equal(st.stale, true);
  const n = st.notices.find((x) => x.key === 'stale');
  assert.ok(n && n.action.label === 'Re-summarise');
  assert.equal(st.page.chunks.some((c) => c.text.includes('completely rewritten')), false, 'the summarised chunks are kept so old citations still resolve');
});

test('Re-summarise (load with force) drops the cache entry and starts a summary at once', async () => {
  const h = harness({ tabs: { 1: tabOf(1, 'https://a.com/x') }, active: 1, bodies: { 1: articleBody() } });
  await initTabs(h.hooks);
  await sleep(60);
  const st = states.get(1);
  await putCacheEntry(st.urlKey, { textHash: st.hash, summaries: { medium: 'CACHED' }, chatLength: 'medium', messages: [] }, h.session);
  h.calls.startSummary.length = 0;
  await load(1, { force: true });
  assert.deepEqual(h.calls.startSummary, [[1, 'medium']]);
  assert.equal(st.conv.summaryRaw, '');
});

test('agent events: untrusted senders and bad envelopes are ignored; a trusted navigated event reloads', async () => {
  const h = harness({ tabs: { 1: tabOf(1, 'https://a.com/one') }, active: 1, bodies: { 1: articleBody() } });
  await initTabs(h.hooks);
  await sleep(60);
  const st = states.get(1);
  st.autoPending = false;
  const env = (href) => ({ v: 2, src: 'pagesum-agent', type: 'agent/event', event: 'navigated', data: { href } });
  const send = (msg, sender) => h.listeners.message.forEach((f) => f(msg, sender));
  h.tabs[1].url = 'https://a.com/two';
  send(env('https://a.com/two'), { id: 'someone-else', tab: { id: 1, windowId: 1 }, frameId: 0 });
  send({ v: 1 }, { id: 'ext-id', tab: { id: 1, windowId: 1 }, frameId: 0 });
  send(env('https://a.com/two'), { id: 'ext-id', tab: { id: 1, windowId: 2 }, frameId: 0 });   // other window
  send(env('https://a.com/two'), { id: 'ext-id', tab: { id: 1, windowId: 1 }, frameId: 3 });   // sub-frame
  send(env('https://a.com/two'), { id: 'ext-id', tab: { id: 99, windowId: 1 }, frameId: 0 });  // untracked tab
  await sleep(60);
  assert.equal(st.urlKey, 'https://a.com/one', 'nothing changed yet');
  h.envs[1].sandbox.location.href = 'https://a.com/two';
  send(env('https://a.com/two'), { id: 'ext-id', tab: { id: 1, windowId: 1 }, frameId: 0 });
  await sleep(100);
  assert.equal(st.urlKey, 'https://a.com/two');
});

test('closing a tab aborts its stream and drops its state', async () => {
  const h = harness({ tabs: { 1: tabOf(1, 'https://a.com/') }, active: 1, bodies: { 1: articleBody() } });
  await initTabs(h.hooks);
  await sleep(60);
  let aborted = false;
  states.get(1).ctrl = { abort() { aborted = true; } };
  h.listeners.removed.forEach((f) => f(1));
  assert.equal(aborted, true);
  assert.equal(states.has(1), false);
});

test('at most 2 concurrent streams: starting a third aborts the oldest background one', async () => {
  const h = harness({ tabs: { 1: tabOf(1, 'https://a.com/') }, active: 1, bodies: { 1: articleBody() } });
  await initTabs(h.hooks);
  await sleep(60);
  const mk = (id, at) => { const s = ensureState(id); const c = { aborted: false, abort() { this.aborted = true; } }; s.ctrl = c; s.streamAt = at; return c; };
  const c2 = mk(2, 100);
  const c3 = mk(3, 200);
  app.shownTabId = 1;
  enforceStreamLimit(states.get(1));
  assert.equal(c2.aborted, true, 'oldest background stream aborted');
  assert.equal(c3.aborted, false);
  assert.deepEqual(h.calls.abortUi, [2]);
  assert.equal(states.get(2).ctrl, null);
});

// ======================= phase 2: PDF, YouTube, vision, frames, structured extraction =======================

const PDF3 = Buffer.from(['%PDF-1.4', '2 0 obj << /Type /Pages /Count 3 >> endobj', '3 0 obj << /Type /Page >> endobj', '4 0 obj << /Type /Page >> endobj', '5 0 obj << /Type /Page >> endobj', '%%EOF'].join('\n'), 'latin1');
const MB = 1024 * 1024;

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return handler(url, init); };
  fn.calls = calls;
  return fn;
}
const pdfResponse = (bytes, { length } = {}) => ({
  ok: true, status: 200,
  headers: { get: (n) => (n.toLowerCase() === 'content-length' && length !== undefined ? String(length) : null) },
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});
let savedFetch;
let savedXhr;
beforeEach(() => { savedFetch = globalThis.fetch; savedXhr = globalThis.XMLHttpRequest; });
afterEach(() => { globalThis.fetch = savedFetch; globalThis.XMLHttpRequest = savedXhr; });

test('pdf tab: the panel fetches the bytes (nothing injected), counts pages and schedules the auto-summary', async () => {
  const h = harness({ tabs: { 1: tabOf(1, 'https://a.com/docs/paper.pdf?dl=1#page=2', 'paper.pdf') }, active: 1 });
  globalThis.fetch = fakeFetch(() => pdfResponse(new Uint8Array(PDF3)));
  await initTabs(h.hooks);
  await sleep(80);
  const st = states.get(1);
  assert.equal(st.kind, 'pdf');
  assert.equal(st.page.kind, 'pdf');
  assert.equal(st.page.source, 'pdf');
  assert.deepEqual(st.page.chunks, []);
  assert.equal(st.page.pdf.pages, 3);
  assert.equal(st.page.pdf.bytes, PDF3.length);
  assert.equal(st.page.pdf.level, undefined);
  assert.equal(st.media.b64, PDF3.toString('base64'));
  assert.equal(st.access, 'ok');
  assert.equal(st.urlKey, 'https://a.com/docs/paper.pdf?dl=1');
  assert.equal(globalThis.fetch.calls[0].url, 'https://a.com/docs/paper.pdf?dl=1#page=2');
  assert.equal(globalThis.fetch.calls[0].init.credentials, 'include');
  assert.equal(h.injects.length, 0, 'the PDF viewer page is never injected');
  assert.equal(st.autoPending, true);
  await sleep(AUTO_DELAY_MS + 100);
  assert.deepEqual(h.calls.startSummary, [[1, 'medium']]);
});

test('pdf tab: too large (by Content-Length) shows the Too large card without downloading', async () => {
  const h = harness({ tabs: { 1: tabOf(1, 'https://a.com/big.pdf') }, active: 1 });
  let read = false;
  globalThis.fetch = fakeFetch(() => ({ ...pdfResponse(new Uint8Array(10), { length: 34 * MB }), arrayBuffer: async () => { read = true; return new ArrayBuffer(0); } }));
  await initTabs(h.hooks);
  await sleep(60);
  const st = states.get(1);
  assert.equal(st.view, 'summary');
  assert.equal(st.conv.summaryError.err.code, 'too_large');
  assert.equal(st.conv.summaryError.err.message, 'This PDF is 34 MB; the limit is 20 MB.');
  assert.equal(st.conv.summaryError.retry, null);
  assert.equal(read, false);
  assert.equal(st.autoPending, false);
  assert.ok(st.page, 'a stub page stops show() reloading on every visit');
});

test('pdf tab: a PDF over 5 MB or 50 pages is read at LOW resolution', async () => {
  const h = harness({ tabs: { 1: tabOf(1, 'https://a.com/m.pdf') }, active: 1 });
  const big = new Uint8Array(6 * MB);
  big.set(PDF3);
  globalThis.fetch = fakeFetch(() => pdfResponse(big));
  await initTabs(h.hooks);
  await sleep(150);
  assert.equal(states.get(1).page.pdf.level, 'MEDIA_RESOLUTION_LOW');
});

test('pdf tab: when the panel fetch fails the page agent fetches its own URL', async () => {
  const h = harness({ tabs: { 1: tabOf(1, 'https://a.com/paper.pdf') }, active: 1, bodies: { 1: articleBody() } });
  globalThis.fetch = fakeFetch(() => { throw new TypeError('Failed to fetch'); });
  h.envs[1].sandbox.btoa = btoa;
  h.envs[1].sandbox.fetch = fakeFetch(() => pdfResponse(new Uint8Array(PDF3)));
  await initTabs(h.hooks);
  await sleep(100);
  const st = states.get(1);
  assert.equal(st.page.kind, 'pdf');
  assert.equal(st.page.pdf.pages, 3);
  assert.equal(st.media.b64, PDF3.toString('base64'));
  assert.equal(h.envs[1].sandbox.fetch.calls[0].url, 'https://a.com/paper.pdf');
});

test('pdf tab: no access at all shows needAccess with the host', async () => {
  const h = harness({ tabs: { 1: tabOf(1, 'https://docs.example.org/paper.pdf') }, active: 1, bodies: { 1: articleBody() } });
  h.envs[1].denied = true;
  globalThis.fetch = fakeFetch(() => { throw new TypeError('Failed to fetch'); });
  await initTabs(h.hooks);
  await sleep(60);
  const st = states.get(1);
  assert.equal(st.view, 'needAccess');
  assert.equal(st.host, 'docs.example.org');
});

test('pdf tab: a local file uses XHR, and shows the file-access hint when that fails', async () => {
  const h = harness({ tabs: { 1: tabOf(1, 'file:///C:/docs/paper.pdf') }, active: 1 });
  globalThis.fetch = fakeFetch(() => { throw new Error('fetch must not be used for file: URLs'); });
  class OkXhr { open(m, u) { this.url = u; } send() { this.response = new Uint8Array(PDF3).buffer; setTimeout(() => this.onload(), 0); } }
  globalThis.XMLHttpRequest = OkXhr;
  await initTabs(h.hooks);
  await sleep(80);
  assert.equal(states.get(1).page.pdf.pages, 3);
  class BadXhr { open() {} send() { setTimeout(() => this.onerror(), 0); } }
  globalThis.XMLHttpRequest = BadXhr;
  await load(1);
  assert.equal(states.get(1).view, 'restricted');
  assert.equal(states.get(1).restrictedReason, MSG_FILE);
});

test('pdf tab: cached summary restores without a request; show() does not reload a PDF', async () => {
  const h = harness({ tabs: { 1: tabOf(1, 'https://a.com/paper.pdf'), 2: tabOf(2, 'https://b.com/') }, active: 1, bodies: { 2: articleBody() } });
  globalThis.fetch = fakeFetch(() => pdfResponse(new Uint8Array(PDF3)));
  await initTabs(h.hooks);
  await sleep(80);
  const st = states.get(1);
  await putCacheEntry(st.urlKey, { textHash: st.hash, summaries: { medium: 'PDF SUMMARY [p2]' }, chatLength: 'medium', messages: [] }, h.session);
  await load(1);
  assert.equal(st.view, 'summary');
  assert.equal(st.conv.summaryRaw, 'PDF SUMMARY [p2]');
  const n = globalThis.fetch.calls.length;
  show(2); await sleep(50);
  show(1); await sleep(80);
  assert.equal(globalThis.fetch.calls.length, n, 'no refetch when returning to the tab');
});

// ---- YouTube ----

const ytBody = (props, extra = '') => el('body', {}, el('h1', {}, 'Video title'), el('p', {}, 'Description of the video. ' + PARA.repeat(3) + extra), el('video', { __props: props }));
const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s';

test('youtube: the video becomes the page (id, canonical URL, duration), the page text rides along, auto-summary is scheduled', async () => {
  const h = harness({ tabs: { 1: tabOf(1, YT, 'Video') }, active: 1, bodies: { 1: ytBody({ duration: 300, currentTime: 0 }) } });
  await initTabs(h.hooks);
  await sleep(80);
  const st = states.get(1);
  assert.equal(st.page.kind, 'video');
  assert.equal(st.page.source, 'video');
  assert.deepEqual(st.page.video, { id: 'dQw4w9WgXcQ', canonical: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', duration: 300 });
  assert.ok(st.page.chunks.length >= 2);
  assert.equal(st.notices.some((n) => n.key === 'youtube'), false, 'the v1 "transcripts aren\'t read" notice is gone');
  assert.equal(st.autoPending, true);
  assert.equal(st.view, 'init');
});

test('youtube: a video over 20 minutes asks first (idle view, cost notice, no auto-summary)', async () => {
  const h = harness({ tabs: { 1: tabOf(1, YT) }, active: 1, bodies: { 1: ytBody({ duration: 45 * 60, currentTime: 0 }) } });
  await initTabs(h.hooks);
  await sleep(AUTO_DELAY_MS + 150);
  const st = states.get(1);
  assert.equal(st.view, 'idle');
  assert.equal(st.idleLabel, 'Summarise video');
  assert.equal(st.autoPending, false);
  const n = st.notices.find((x) => x.key === 'long-video');
  assert.equal(n.text, 'This video is 45 min (about 270k tokens of your free quota).');
  assert.deepEqual(h.calls.startSummary, []);
});

test('youtube: transcript mode has no cost guard; an unknown duration (0) does not trigger it either', async () => {
  const long = harness({ tabs: { 1: tabOf(1, YT) }, active: 1, settings: { youtubeMode: 'transcript' }, bodies: { 1: ytBody({ duration: 3 * 3600, currentTime: 0 }) } });
  await initTabs(long.hooks);
  await sleep(80);
  assert.equal(states.get(1).view, 'init');
  assert.equal(states.get(1).autoPending, true);
  for (const x of states.values()) resetState(x); states.clear();
  const unknown = harness({ tabs: { 1: tabOf(1, YT) }, active: 1, bodies: { 1: ytBody({ duration: NaN, currentTime: 0 }) } });
  await initTabs(unknown.hooks);
  await sleep(80);
  assert.equal(states.get(1).page.video.duration, 0);
  assert.equal(states.get(1).autoPending, true);
});

test('youtube pages without a video id (channel page) stay ordinary pages with the v1 notice', async () => {
  const h = harness({ tabs: { 1: tabOf(1, 'https://www.youtube.com/watch?v=short') }, active: 1, bodies: { 1: ytBody({ duration: 100, currentTime: 0 }) } });
  await initTabs(h.hooks);
  await sleep(80);
  const st = states.get(1);
  assert.equal(st.page.kind, 'html');
  assert.ok(st.notices.some((n) => n.key === 'youtube'));
});

// ---- vision ----

const visualBody = () => el('body', {}, el('canvas', { __rect: { left: 0, top: 0, width: 900, height: 700 } }), el('p', {}, 'Chart'));

test('vision "ask": a canvas page with little text offers "Read from screenshot" on the empty view', async () => {
  const h = harness({ tabs: { 1: tabOf(1, 'https://app.example.com/') }, active: 1, bodies: { 1: visualBody() } });
  await initTabs(h.hooks);
  await sleep(80);
  const st = states.get(1);
  assert.equal(st.view, 'empty');
  const n = st.notices.find((x) => x.key === 'vision-offer');
  assert.equal(n.text, 'Little readable text.');
  assert.equal(n.action.label, 'Read from screenshot');
  n.action.run();
  assert.deepEqual(h.calls.startVision, [1]);
  assert.deepEqual(h.calls.startSummary, []);
});

test('vision "off" or a normal page: no offer. A blank page without visual content: no offer either', async () => {
  const off = harness({ tabs: { 1: tabOf(1, 'https://a.com/') }, active: 1, settings: { vision: 'off' }, bodies: { 1: visualBody() } });
  await initTabs(off.hooks);
  await sleep(80);
  assert.equal(states.get(1).notices.some((x) => x.key === 'vision-offer'), false);
  for (const x of states.values()) resetState(x); states.clear();
  const normal = harness({ tabs: { 1: tabOf(1, 'https://a.com/') }, active: 1, bodies: { 1: articleBody() } });
  await initTabs(normal.hooks);
  await sleep(80);
  assert.equal(states.get(1).notices.some((x) => x.key === 'vision-offer'), false);
  for (const x of states.values()) resetState(x); states.clear();
  const blank = harness({ tabs: { 1: tabOf(1, 'https://a.com/') }, active: 1, bodies: { 1: el('body', {}, el('p', {}, 'Tiny page.')) } });
  await initTabs(blank.hooks);
  await sleep(80);
  assert.equal(states.get(1).view, 'empty');
  assert.equal(states.get(1).notices.some((x) => x.key === 'vision-offer'), false);
});

test('vision "auto": skips the empty view and captures after the 1 s rule (never on a passing tab)', async () => {
  const h = harness({ tabs: { 1: tabOf(1, 'https://a.com/') }, active: 1, settings: { vision: 'auto' }, bodies: { 1: visualBody() } });
  await initTabs(h.hooks);
  await sleep(80);
  const st = states.get(1);
  assert.equal(st.view, 'init');
  assert.equal(st.autoVision, true);
  assert.equal(st.autoPending, true);
  assert.deepEqual(h.calls.startVision, []);
  await sleep(AUTO_DELAY_MS + 100);
  assert.deepEqual(h.calls.startVision, [1]);
  assert.deepEqual(h.calls.startSummary, []);
});

// ---- iframes ----

const frameBody = (text) => el('body', {}, el('p', {}, text));
const FRAME_TEXT = 'Text that lives inside an embedded documentation frame, long enough to keep. '.repeat(4);

test('frames: a big enough same-origin frame is merged after the main frame under an "Embedded frame" heading', async () => {
  const h = harness({
    tabs: { 1: tabOf(1, 'https://a.com/') }, active: 1, bodies: { 1: articleBody() },
    subs: {
      1: [
        { frameId: 5, env: makeEnv({ body: frameBody(FRAME_TEXT), href: 'https://docs.a.com/embed', innerWidth: 600, innerHeight: 400 }) },
        { frameId: 6, env: makeEnv({ body: frameBody(FRAME_TEXT), href: 'https://ads.example.net/ad', innerWidth: 300, innerHeight: 50 }) },
        { frameId: 7, env: makeEnv({ body: frameBody('tiny'), href: 'https://x.example.net/', innerWidth: 600, innerHeight: 400 }) },
      ],
    },
  });
  await initTabs(h.hooks);
  await sleep(100);
  const st = states.get(1);
  const frameChunks = st.page.chunks.filter((c) => c.frameId !== 0);
  assert.equal(frameChunks[0].pseudo, true);
  assert.equal(frameChunks[0].text, 'Embedded frame: docs.a.com');
  assert.equal(frameChunks.length, 2, 'heading + one paragraph; the small and the empty frames are dropped');
  assert.equal(frameChunks[1].frameId, 5);
  assert.equal(st.page.frames, 2);
  assert.ok(h.injects.some((i) => i.allFrames && i.files));
  const ids = st.page.chunks.map((c) => c.id);
  assert.deepEqual(ids, ids.map((_, i) => 'c' + (i + 1)), 'chunk ids stay sequential across frames');
});

test('frames: partial permissions make allFrames fail; the main frame is used and a notice says so', async () => {
  const h = harness({ tabs: { 1: tabOf(1, 'https://a.com/') }, active: 1, bodies: { 1: articleBody() } });
  h.frameThrows = true;
  await initTabs(h.hooks);
  await sleep(100);
  const st = states.get(1);
  assert.equal(st.access, 'ok');
  assert.equal(st.frames, false);
  assert.ok(st.page.chunks.length > 1);
  assert.ok(st.notices.some((n) => n.key === 'frames-skipped' && n.text === 'Embedded frames skipped.'));
});

test('frames: readFrames off injects the main frame only', async () => {
  const h = harness({
    tabs: { 1: tabOf(1, 'https://a.com/') }, active: 1, settings: { readFrames: false }, bodies: { 1: articleBody() },
    subs: { 1: [{ frameId: 5, env: makeEnv({ body: frameBody(FRAME_TEXT), href: 'https://docs.a.com/embed', innerWidth: 600, innerHeight: 400 }) }] },
  });
  await initTabs(h.hooks);
  await sleep(100);
  assert.equal(states.get(1).page.chunks.some((c) => c.frameId !== 0), false);
  assert.equal(h.injects.some((i) => i.allFrames), false);
});

// ---- structured extraction through the panel ----

test('structured extraction: the page model carries meta, an outline mapped to chunk ids, links and form labels', async () => {
  const head = el('head', {}, el('meta', { name: 'description', content: 'A page about committees' }));
  const body = el('body', {}, el('article', {}, el('h1', {}, 'Big Title'), el('p', {}, PARA.repeat(12)), el('h2', {}, 'Second part'), el('p', {}, PARA.repeat(5) + ' '), el('a', { href: 'https://a.com/pricing' }, 'Pricing')));
  const h = harness({ tabs: { 1: tabOf(1, 'https://a.com/') }, active: 1 });
  h.envs[1] = makeEnv({ body, head, href: 'https://a.com/' });
  await initTabs(h.hooks);
  await sleep(100);
  const st = states.get(1);
  assert.equal(st.page.meta.description, 'A page about committees');
  assert.deepEqual(st.page.outline.map((o) => [o.level, o.text, o.id]), [[1, 'Big Title', 'c1'], [2, 'Second part', st.page.chunks.find((c) => c.text === 'Second part').id]]);
  assert.deepEqual(st.page.links, [{ text: 'Pricing', href: 'https://a.com/pricing' }]);
});

test('structured extraction can be switched off in settings', async () => {
  const head = el('head', {}, el('meta', { name: 'description', content: 'D' }));
  const h = harness({ tabs: { 1: tabOf(1, 'https://a.com/') }, active: 1, settings: { structuredExtraction: false } });
  h.envs[1] = makeEnv({ body: articleBody(), head, href: 'https://a.com/' });
  await initTabs(h.hooks);
  await sleep(100);
  const st = states.get(1);
  assert.equal(st.page.meta, undefined);
  assert.equal(st.page.outline, undefined);
});
