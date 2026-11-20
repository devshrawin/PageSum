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
function harness({ tabs, active, key = 'k', settings = {}, bodies = {} }) {
  const local = fakeArea();
  const session = fakeArea();
  if (key !== null) local.set({ settings: { apiKey: key, ...settings } });
  const listeners = { activated: [], updated: [], removed: [], changed: [], message: [] };
  const envs = {};
  for (const [id, body] of Object.entries(bodies)) envs[id] = makeEnv({ body, href: tabs[id].url, title: tabs[id].title });
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
        const env = envs[target.tabId];
        if (!env || env.denied) throw new Error('Cannot access contents of the page. Extension manifest must request permission to access the respective host.');
        if (files) { env.load(files.map((f) => path.basename(f))); return [{ frameId: 0, result: null }]; }
        const fn = vm.runInContext(`(${func.toString()})`, env.ctx);
        return [{ frameId: 0, result: plain(fn(...args)) }];
      },
      async insertCSS() {},
    },
    storage: { local, session, onChanged: { addListener: (f) => listeners.changed.push(f) } },
  };
  globalThis.chrome = chrome;
  H = { chrome, listeners, envs, local, session, tabs, calls: { render: [], startSummary: [], abortUi: [] } };
  H.hooks = {
    render: (st) => H.calls.render.push(st && st.view),
    setTitle() {},
    startSummary: (st, len) => { H.calls.startSummary.push([st.tabId, len]); },
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

test('restricted urls show the v1 messages; a pdf shows the phase-1 interim message', async () => {
  const h = harness({ tabs: { 1: tabOf(1, 'chrome://extensions'), 2: tabOf(2, 'https://chromewebstore.google.com/x'), 3: tabOf(3, 'https://a.com/p.pdf'), 4: tabOf(4, 'blob:https://a.com/1', 'doc.pdf') }, active: 1 });
  await initTabs(h.hooks);
  await sleep(40);
  assert.equal(states.get(1).view, 'restricted');
  assert.equal(states.get(1).restrictedReason, "Chrome doesn't let extensions read this page.");
  await load(2);
  assert.equal(states.get(2).restrictedReason, "Chrome doesn't let extensions read the Web Store.");
  await load(3);
  assert.equal(states.get(3).view, 'restricted');
  assert.match(states.get(3).restrictedReason, /PDFs aren't supported yet/);
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
