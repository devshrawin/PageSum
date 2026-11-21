// Drives the side panel UI modules (nav, tools, guide, compare, history) against a small fake DOM, the real content
// scripts (through a fake chrome) and the mock Gemini server. No browser needed.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMock } from './mock-gemini.js';
import { installPanelDom, byClass, byText, findAll } from './helpers/paneldom.js';
import { installChrome } from './helpers/fakechrome.js';
import { el, makeEnv } from './helpers/fakedom.js';
import { app, states, newState } from '../extension/panel/tabs.js';
import { sanitize } from '../extension/lib/storage.js';
import { resetJsonStyles } from '../extension/lib/gemini.js';
import { initNav, setTab, onTabChange, currentTab } from '../extension/panel/nav.js';
import { initTools, renderTools } from '../extension/panel/tools.js';
import { initGuide, renderGuide, onGuideTargetLost } from '../extension/panel/guide.js';
import { initCompare, renderCompare } from '../extension/panel/compare.js';
import { initHistory, renderHistory, recordHistory } from '../extension/panel/history.js';
import { makeEntry } from '../extension/lib/history.js';

let mock;
let ui;
let realFetch;
before(async () => {
  mock = await startMock();
  realFetch = globalThis.fetch;
  // Send Gemini calls to the mock server.
  globalThis.fetch = (url, init) => realFetch(String(url).replace('https://generativelanguage.googleapis.com/v1beta', mock.url), init);
});
after(async () => { globalThis.fetch = realFetch; await mock.close(); });
beforeEach(() => { mock.reset(); resetJsonStyles(); states.clear(); app.shownTabId = null; app.windowId = 1; ui = installPanelDom(); });
afterEach(() => { for (const s of states.values()) { if (s.tool && s.tool.ctrl) s.tool.ctrl.abort(); } states.clear(); ui.uninstall(); delete globalThis.chrome; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(15); }
  throw new Error('timed out waiting for condition');
}
const settings = (key, over = {}) => sanitize({ apiKey: key, language: 'English', ...over });
const chunk = (id, text, kind = 'p') => ({ id, frameId: 0, localId: id.replace('c', 'b'), kind, text });

function fakeArea() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? { [k]: structuredClone(m.get(k)) } : {}; },
    async set(o) { for (const [k, v] of Object.entries(o)) m.set(k, structuredClone(v)); },
    async remove(k) { m.delete(k); },
    _m: m,
  };
}
function installStorage(extra = {}) {
  const local = fakeArea();
  const base = globalThis.chrome || {};
  globalThis.chrome = { ...base, runtime: { id: 'ext-id', openOptionsPage() {}, ...(base.runtime || {}) }, storage: { local, session: fakeArea(), onChanged: { addListener() {} } }, ...extra };
  return local;
}
function showPage(key, over = {}) {
  const st = newState(1);
  st.url = 'https://a.com/x';
  st.urlKey = 'https://a.com/x';
  st.access = 'ok';
  st.view = 'summary';
  st.page = { title: 'T', url: 'https://a.com/x', source: 'article', kind: 'html', truncated: false, originalLength: 20, chunks: [chunk('c1', 'Title', 'h'), chunk('c2', 'First paragraph.')], ...over };
  st.conv.nonce = 'fixednonce';
  states.set(1, st);
  app.shownTabId = 1;
  app.settings = settings(key);
  return st;
}

/* ---------------------------------------------------------------- nav ---- */

test('tab bar: click, arrow keys, Home and End switch tabs and keep ARIA state in step', () => {
  initNav();
  const seen = [];
  onTabChange((t) => seen.push(t));
  const sel = () => ['page', 'tools', 'guide', 'compare', 'history'].filter((t) => ui.$('tab-' + t).getAttribute('aria-selected') === 'true');
  assert.deepEqual(sel(), ['page']);
  assert.equal(ui.$('panel-page').hidden, false);
  assert.equal(ui.$('panel-tools').hidden, true);
  ui.$('tab-tools').click();
  assert.deepEqual(sel(), ['tools']);
  assert.equal(ui.$('panel-tools').hidden, false);
  assert.equal(ui.$('panel-page').hidden, true);
  assert.equal(ui.$('tab-tools').tabIndex, 0);
  assert.equal(ui.$('tab-page').tabIndex, -1);
  ui.$('tabbar').fire('keydown', { key: 'ArrowRight' });
  assert.equal(currentTab(), 'guide');
  assert.equal(ui.$('tab-guide').focused, true, 'focus follows the arrow key');
  ui.$('tabbar').fire('keydown', { key: 'ArrowLeft' });
  ui.$('tabbar').fire('keydown', { key: 'ArrowLeft' });
  assert.equal(currentTab(), 'page');
  ui.$('tabbar').fire('keydown', { key: 'ArrowLeft' });
  assert.equal(currentTab(), 'history', 'wraps around');
  ui.$('tabbar').fire('keydown', { key: 'Home' });
  assert.equal(currentTab(), 'page');
  ui.$('tabbar').fire('keydown', { key: 'End' });
  assert.equal(currentTab(), 'history');
  ui.$('tabbar').fire('keydown', { key: 'a' });
  assert.equal(currentTab(), 'history');
  assert.ok(seen.includes('guide') && seen.includes('history'));
  setTab('page');
});

/* -------------------------------------------------------------- tools ---- */

test('tools: blocked views replace the panel, a readable page shows eight actions', () => {
  initTools();
  renderTools(null);
  assert.equal(ui.$('toolsBlocked').hidden, false);
  assert.equal(ui.$('toolsMain').hidden, true);
  assert.match(ui.$('toolsBlockedText').textContent, /Open a web page/);
  const bad = newState(2);
  bad.view = 'restricted';
  bad.restrictedReason = "Chrome doesn't let extensions read this page.";
  renderTools(bad);
  assert.equal(ui.$('toolsBlockedText').textContent, "Chrome doesn't let extensions read this page.");
  bad.view = 'needKey';
  renderTools(bad);
  assert.match(ui.$('toolsBlockedText').textContent, /API key/);
  const st = showPage('ok');
  renderTools(st);
  assert.equal(ui.$('toolsBlocked').hidden, true);
  assert.equal(ui.$('toolGrid').querySelectorAll('button').length, 8);
  assert.equal(ui.$('toolOptions').hidden, true);
});

async function pick(id, st) {
  ui.$('toolGrid').querySelectorAll('button').find((b) => b.getAttribute('data-tool') === id).click();
  assert.equal(st.tool.action, id);
}
async function run(st) {
  ui.$('toolRun').click();
  await until(() => st.tool.status !== 'running');
}

test('tools: Extract table builds a real table with source buttons, and Copy CSV guards formulas', async () => {
  initTools();
  const st = showPage('json-table');
  renderTools(st);
  await pick('table', st);
  assert.equal(ui.$('toolOptions').hidden, false);
  assert.equal(ui.$('toolTitle').textContent, 'Extract table');
  ui.$('tableWhat').value = 'all products with price';
  await run(st);
  assert.equal(st.tool.status, 'done');
  const res = ui.$('toolResult');
  const table = res.querySelector('table');
  assert.ok(table);
  assert.deepEqual(table.querySelectorAll('th').map((th) => th.textContent), ['Name', 'Name (2)', 'Price', 'Source']);
  const cites = res.querySelectorAll('button.cite');
  assert.deepEqual(cites.map((b) => b.getAttribute('data-cite')), ['c1', 'c2']);
  assert.equal(cites[0].getAttribute('aria-label'), 'Source 1: Title');
  const copy = byText(res, /^Copy CSV$/).find((n) => n.tagName === 'BUTTON');
  copy.click();
  await sleep(10);
  assert.equal(ui.clipboard.text, 'Name,Name (2),Price\r\nA,x,\r\n"\'=HYPERLINK(""http://evil"",""click"")",y,-12.5');
  byText(res, /^Copy Markdown$/).find((n) => n.tagName === 'BUTTON').click();
  await sleep(10);
  assert.ok(ui.clipboard.text.startsWith('| Name | Name (2) | Price |\n| --- | --- | --- |'));
  assert.ok(mock.requests.at(-1).body.contents[0].parts.at(-1).text.includes('Extract all products with price'));
});

test('tools: Explain renders markdown with Copy; Save to history writes a local entry; sensitive pages are not saved', async () => {
  const local = installStorage();
  initTools();
  const st = showPage('ok');
  st.page.chunks = [chunk('c1', 'Title', 'h'), chunk('c2', 'First paragraph.')];
  app.settings = settings('ok');
  renderTools(st);
  await pick('explain', st);
  await run(st);
  const res = ui.$('toolResult');
  assert.equal(st.tool.result.type, 'markdown');
  assert.ok(byText(res, /TL;DR/).length > 0);
  const save = byText(res, /Save to history/).find((n) => n.tagName === 'BUTTON');
  save.click();
  await until(() => local._m.has('history'));
  const hist = local._m.get('history');
  assert.equal(hist.entries.length, 1);
  assert.equal(hist.entries[0].label, 'Explain simply');
  assert.equal(hist.entries[0].kind, 'tool');
  // a sensitive page: nothing saved, the reason is shown
  st.sensitive = { sensitive: true, reason: 'banking' };
  await run(st);
  byText(ui.$('toolResult'), /Save to history/).find((n) => n.tagName === 'BUTTON').click();
  await sleep(40);
  assert.equal(local._m.get('history').entries.length, 1);
  assert.match(ui.$('toast').textContent, /Not saved to history \(banking page\)/);
});

test('tools: Action items lists tasks and dates with source buttons; Copy as Markdown', async () => {
  initTools();
  const st = showPage('json-items');
  renderTools(st);
  await pick('actionItems', st);
  await run(st);
  const res = ui.$('toolResult');
  assert.ok(byText(res, /Send the report/).length > 0);
  assert.ok(byText(res, /Review budget/).length > 0);
  assert.deepEqual(res.querySelectorAll('button.cite').map((b) => b.getAttribute('data-cite')), ['c1', 'c1']);
  byText(res, /Copy as Markdown/).find((n) => n.tagName === 'BUTTON').click();
  await sleep(10);
  assert.ok(ui.clipboard.text.startsWith('## Tasks\n- [ ] Send the report (Ann, 2026-12-01)\n- [ ] Review budget (soon)'));
});

test('tools: Quiz flashcards flip with aria-pressed, the quiz checks answers', async () => {
  initTools();
  const st = showPage('json-quiz');
  renderTools(st);
  await pick('quiz', st);
  await run(st);
  const res = ui.$('toolResult');
  const flash = byClass(res, 'flash')[0];
  assert.equal(flash.getAttribute('aria-pressed'), 'false');
  const answer = byClass(flash, 'flash-a')[0];
  assert.equal(answer.hidden, true);
  flash.click();
  assert.equal(flash.getAttribute('aria-pressed'), 'true');
  assert.equal(answer.hidden, false);
  flash.click();
  assert.equal(answer.hidden, true);
  const radios = findAll(res, (n) => n.tagName === 'INPUT' && n.getAttribute('type') === 'radio');
  assert.equal(radios.length, 4);
  radios[1].checked = true;
  byText(res, /Check answers/).find((n) => n.tagName === 'BUTTON').click();
  assert.equal(byClass(res, 'is-right').length, 1);
  assert.match(byClass(res, 'is-right')[0].textContent, /b/);
  assert.ok(byText(res, /1 of 1 correct/).length > 0);
});

test('tools: Form helper shows drafts, "Enter this yourself" for sensitive fields, and outlines a field without writing into it', async () => {
  const body = el('body', {}, el('p', {}, 'Sign up. '.repeat(40)),
    el('form', {}, el('input', { type: 'email', 'aria-label': 'Email address', required: '' }), el('input', { type: 'password', 'aria-label': 'Password' })));
  const env = makeEnv({ body, href: 'https://a.com/x' });
  installChrome({ envs: { 1: env }, tabs: { 1: { id: 1, url: 'https://a.com/x', title: 'T', windowId: 1, active: true } } });
  installStorage();
  initTools();
  const st = showPage('json-form');
  renderTools(st);
  await pick('form', st);
  ui.$('formContext').value = 'My email is me@example.com';
  await run(st);
  assert.equal(st.tool.status, 'done', JSON.stringify(st.tool.error && st.tool.error.message));
  const res = ui.$('toolResult');
  const cards = byClass(res, 'field-card');
  assert.equal(cards.length, 2, 'the invented e9 field was dropped');
  assert.ok(byText(cards[0], /me@example\.com/).length > 0);
  assert.ok(byText(cards[1], /Enter this yourself/).length > 0);
  assert.equal(byText(cards[1], /hunter2/).length, 0, 'a sensitive field never shows a draft');
  assert.ok(byText(res, /never types into the page/).length > 0);
  byText(cards[0], /Show on page/).find((n) => n.tagName === 'BUTTON').click();
  await until(() => env.html.childNodes.some((n) => /pagesum-ov-target/.test(n.className || '')));
  assert.equal(env.html.childNodes.filter((n) => /pagesum-ov-/.test(n.className || '')).length, 2);
});

test('tools: an error shows the error card with Retry; Stop leaves the panel ready', async () => {
  initTools();
  const st = showPage('badkey');
  renderTools(st);
  await pick('explain', st);
  await run(st);
  assert.equal(st.tool.status, 'error');
  assert.ok(byText(ui.$('toolResult'), /Invalid API key/).length > 0);
  assert.equal(ui.$('toolRun').hidden, false);
});

/* -------------------------------------------------------------- guide ---- */

function guideSetup() {
  const body = el('body', {},
    el('a', { href: 'https://github.com/a/b/settings', id: 'settings-link' }, 'Settings'),
    el('button', {}, 'Delete repository'));
  const env = makeEnv({ body, href: 'https://github.com/a/b' });
  installChrome({ envs: { 1: env }, tabs: { 1: { id: 1, url: 'https://github.com/a/b', title: 'Repo', windowId: 1, active: true } } });
  installStorage();
  const st = showPage('json-guide', { url: 'https://github.com/a/b' });
  st.url = 'https://github.com/a/b';
  return { env, st };
}
const overlay = (env) => env.html.childNodes.filter((n) => /pagesum-ov-/.test(n.className || ''));

test('guide: goal, plan, steps with caution badges, Next/Back/Done, and nothing is ever clicked', async () => {
  const { env, st } = guideSetup();
  initGuide();
  renderGuide(st);
  assert.equal(ui.$('guideStartBox').hidden, false);
  assert.equal(ui.$('guidePlan').hidden, true);
  ui.$('guideStart').click();                                    // empty goal: nothing happens
  assert.equal(st.guide, undefined === st.guide ? undefined : null);
  ui.$('guideGoal').value = 'Delete my repository';
  ui.$('guideStart').click();
  await until(() => st.guide && st.guide.plan);
  await until(() => !ui.$('guidePlan').hidden);
  assert.equal(ui.$('guideStartBox').hidden, true);
  const steps = ui.$('guideSteps').children;
  assert.equal(steps.length, 3);
  assert.equal(steps[0].getAttribute('aria-current'), 'step');
  assert.match(steps[0].textContent, /Click Settings\./);
  assert.ok(byText(steps[0], /Link: Settings/).length > 0, 'element chip shows the role and label');
  assert.match(ui.$('guideDropped').textContent, /1 suggested step referred to elements not on the page and was removed\./);
  assert.equal(ui.$('guideDropped').hidden, false);
  await until(() => overlay(env).length === 2);
  assert.equal(ui.$('guideBack').disabled, true);

  ui.$('guideNext').click();
  await until(() => st.guide.index === 1);
  await until(() => overlay(env).length === 0);                  // a step without an element shows text only
  assert.equal(ui.$('guideSteps').children[0].classList.contains('is-done'), true);
  ui.$('guideNext').click();
  await until(() => st.guide.index === 2);
  await until(() => overlay(env).length === 2);
  const last = ui.$('guideSteps').children[2];
  assert.ok(byText(last, /Can't be undone: check before you click/).length > 0, 'the local destructive warning badge');
  assert.equal(ui.$('guideNext').disabled, true, 'last step');
  ui.$('guideBack').click();
  await until(() => st.guide.index === 1);
  ui.$('guideDone').click();
  await until(() => st.guide === null);
  await until(() => ui.$('guidePlan').hidden);
  assert.equal(overlay(env).length, 0);
  assert.equal(env.html.childNodes.length > 0, true);
});

test('guide: a lost target shows the message, Next becomes Skip; an unreadable page shows an error card', async () => {
  const { st } = guideSetup();
  initGuide();
  ui.$('guideGoal').value = 'x';
  ui.$('guideStart').click();
  await until(() => st.guide && st.guide.plan && !ui.$('guidePlan').hidden);
  assert.equal(ui.$('guideLost').hidden, true);
  onGuideTargetLost(st, st.guide.plan.steps[st.guide.index].elementId);
  assert.equal(ui.$('guideLost').hidden, false);
  assert.equal(ui.$('guideNext').textContent, 'Skip');
  onGuideTargetLost(st, 'e99');                                  // not the shown step: ignored
  const blocked = newState(3);
  blocked.view = 'restricted';
  blocked.restrictedReason = 'No.';
  renderGuide(blocked);
  assert.equal(ui.$('guideBlocked').hidden, false);
  assert.equal(ui.$('guideBlockedText').textContent, 'No.');
});

/* ------------------------------------------------------------ history ---- */

test('history: list, search, expand with citations, delete, export and clear all', async () => {
  const local = installStorage();
  const mk = (title, url, md, over = {}) => makeEntry({ url, title, kind: 'summary', label: 'Medium summary', markdown: md, sourceText: (id) => ({ c1: 'The quoted passage.' }[id]), now: Date.now(), ...over });
  await local.set({ history: { v: 1, entries: [mk('Quarterly report', 'https://a.com/q', '**TL;DR:** Revenue grew [c1].'), mk('Weather', 'https://b.com/w', 'Rain tomorrow.')] } });
  app.settings = settings('ok');
  initHistory();
  await renderHistory();
  assert.equal(ui.$('historyList').children.length, 2);
  assert.equal(ui.$('historyEmpty').hidden, true);
  ui.$('historySearch').value = 'revenue';
  ui.$('historySearch').fire('input');
  await until(() => ui.$('historyList').children.length === 1);
  assert.match(ui.$('historyList').children[0].textContent, /Quarterly report/);
  ui.$('historySearch').value = 'zzz';
  ui.$('historySearch').fire('input');
  await until(() => ui.$('historyList').children.length === 0);
  assert.equal(ui.$('historyEmpty').textContent, 'No matches.');
  ui.$('historySearch').value = '';
  ui.$('historySearch').fire('input');
  await until(() => ui.$('historyList').children.length === 2);

  byClass(ui.$('historyList'), 'history-head')[0].click();      // expand the first entry
  await until(() => byClass(ui.$('historyList'), 'history-body').length === 1);
  const cite = ui.$('historyList').querySelector('button.cite');
  assert.equal(cite.getAttribute('data-cite'), 'c1');
  assert.equal(cite.getAttribute('title'), 'The quoted passage.');
  const e = cite.fire('click');
  assert.equal(e.stopped, true, 'the Page tab handler never sees history citations');
  assert.match(ui.$('toast').textContent, /Open this page to highlight the source/);

  ui.$('historyExport').click();                                // builds a Blob download without throwing
  const del = byText(ui.$('historyList'), /^Delete$/).find((n) => n.tagName === 'BUTTON');
  del.click();
  await until(() => local._m.get('history').entries.length === 1);
  ui.$('historyClear').click();
  await until(() => !local._m.has('history'));
  await until(() => ui.$('historyEmpty').textContent.startsWith('Nothing saved yet'));
  assert.equal(ui.$('historyClear').disabled, true);
});

test('history: recordHistory skips quietly when off, with a notice for sensitive pages, and keeps only cited sources', async () => {
  const local = installStorage();
  const st = showPage('ok');
  st.page.chunks = [chunk('c1', 'The first source passage.'), chunk('c2', 'Another passage.')];
  app.settings = settings('ok');
  const r = await recordHistory(st, { label: 'Medium summary', markdown: 'Fact [c1].' });
  assert.deepEqual(r, { saved: true });
  const e = local._m.get('history').entries[0];
  assert.deepEqual(e.sources, { c1: 'The first source passage.' });
  assert.equal(e.chat, undefined);
  app.settings = settings('ok', { historyEnabled: false });
  assert.deepEqual(await recordHistory(st, { label: 'x', markdown: 'y' }), { saved: false });
  app.settings = settings('ok');
  st.sensitive = { sensitive: true, reason: 'login' };
  assert.deepEqual(await recordHistory(st, { label: 'x', markdown: 'y' }), { saved: false, skipped: 'Not saved to history (login page).' });
  st.sensitive = { sensitive: false, reason: null };
  st.page.kind = 'image';
  assert.deepEqual(await recordHistory(st, { label: 'x', markdown: 'y' }), { saved: false });
  st.page.kind = 'pdf';
  app.settings = settings('ok', { historySaveChat: true });
  await recordHistory(st, { label: 'PDF summary', markdown: 'On page 3 [p3].', chat: [{ role: 'user', text: 'q' }, { role: 'model', text: 'a' }] });
  const pdf = local._m.get('history').entries[0];
  assert.deepEqual(pdf.sources, { p3: 'Page 3' });
  assert.equal(pdf.kind, 'pdf');
  assert.equal(pdf.chat.length, 2);
});

/* ------------------------------------------------------------ compare ---- */

function compareSetup(grant = true) {
  const envs = {};
  const tabs = {};
  for (let i = 1; i <= 3; i++) {
    const url = `https://site${i}.example.com/p`;
    envs[i] = makeEnv({ body: el('body', {}, el('h1', {}, 'Product ' + i), el('p', {}, 'The product description is long enough to read. '.repeat(8))), href: url, title: 'Product ' + i });
    tabs[i] = { id: i, url, title: 'Product ' + i, windowId: 1, active: i === 1 };
  }
  tabs[4] = { id: 4, url: 'chrome://extensions', title: 'Extensions', windowId: 1 };
  const fake = installChrome({ envs, tabs, grant });
  installStorage();
  const st = showPage('json-compare');
  st.tabId = 1;
  ui.$('compareResult').parentNode = ui.$('panel-compare');   // the fake DOM is flat: restore the nesting the click handler relies on
  return { envs, tabs, ...fake };
}

test('compare: Choose tabs asks for "tabs", lists readable tabs with the current one checked, caps at four', async () => {
  const { rec } = compareSetup();
  initCompare();
  ui.$('compareChoose').click();
  await until(() => !ui.$('compareTabs').hidden);
  assert.deepEqual(rec.permissionRequests[0], { permissions: ['tabs'] });
  const boxes = ui.$('compareTabs').querySelectorAll('input');
  assert.equal(boxes.length, 3, 'the chrome:// tab is not offered');
  assert.deepEqual(boxes.map((b) => b.checked), [true, false, false]);
  assert.equal(ui.$('compareRun').disabled, true, 'needs at least two');
  assert.equal(ui.$('compareFocusBox').hidden, false);
  boxes[1].checked = true;
  boxes[1].fire('change');
  assert.equal(ui.$('compareRun').disabled, false);
});

test('compare: one prompt for the missing sites, a table with source buttons that switch tabs and highlight', async () => {
  const { rec, envs } = compareSetup();
  initCompare();
  ui.$('compareChoose').click();
  await until(() => !ui.$('compareTabs').hidden);
  const boxes = ui.$('compareTabs').querySelectorAll('input');
  boxes[1].checked = true; boxes[1].fire('change');
  ui.$('compareFocus').value = 'price';
  ui.$('compareRun').click();
  await until(() => ui.$('compareResult').querySelector('table'));
  const originRequest = rec.permissionRequests.find((r) => r.origins);
  assert.deepEqual(originRequest.origins.sort(), ['https://site1.example.com/*', 'https://site2.example.com/*']);
  const table = ui.$('compareResult').querySelector('table');
  const heads = table.querySelectorAll('th').filter((th) => th.getAttribute('scope') === 'col').map((th) => th.textContent);
  assert.equal(heads.length, 3);
  assert.match(heads[1], /Product 1/);
  assert.ok(byText(ui.$('compareResult'), /A is cheaper, B is faster\./).length > 0);
  assert.ok(byText(ui.$('compareResult'), /Verdict: /).length > 0);
  const cites = ui.$('compareResult').querySelectorAll('button.cite').map((b) => b.getAttribute('data-cite'));
  assert.deepEqual(cites, ['t1c1', 't2c1']);
  const e = ui.$('compareResult').querySelectorAll('button.cite')[1].fire('click');
  assert.equal(e.stopped, true);
  await until(() => rec.tabUpdates.some((u) => u.id === 2 && u.props.active === true));
  await until(() => envs[2].highlights.size === 1, 3000);
  assert.ok(byText(ui.$('compareResult'), /^Copy CSV$/).length > 0);
  assert.match(mock.requests.at(-1).body.contents[0].parts[0].text, /Focus \(trusted, from the user\): price$/);
});

test('compare: a refused site permission explains why and sends nothing to Gemini', async () => {
  const { rec } = compareSetup((req) => !!req.permissions);   // the tab list is allowed, sites are not
  initCompare();
  ui.$('compareChoose').click();
  await until(() => !ui.$('compareTabs').hidden);
  const boxes = ui.$('compareTabs').querySelectorAll('input');
  boxes[1].checked = true; boxes[1].fire('change');
  ui.$('compareRun').click();
  await until(() => byText(ui.$('compareResult'), /needs access to those sites to compare them/).length > 0);
  assert.ok(rec.permissionRequests.some((r) => r.origins));
  assert.equal(mock.requests.filter((r) => r.url.includes('generateContent')).length, 0);
});

test('compare: refusing the tab list permission is explained', async () => {
  compareSetup(false);
  initCompare();
  ui.$('compareChoose').click();
  await until(() => byText(ui.$('compareResult'), /permission to see the tab list/).length > 0);
  renderCompare();
});

/* --------------------------------------------------------- page tab ---- */

import { initPage, renderState } from '../extension/panel/page.js';

test('page tab: views, the sensitive idle variant, "Never on this site" and the footer follow the active tab', async () => {
  const local = installStorage();
  initNav();
  initPage();
  app.settings = settings('ok');
  const st = showPage('ok');
  st.view = 'restricted';
  st.restrictedReason = 'No access here.';
  renderState(st);
  assert.equal(ui.$('view-restricted').hidden, false);
  assert.equal(ui.$('restrictedText').textContent, 'No access here.');
  assert.equal(ui.$('footer').hidden, true);

  st.view = 'idle';
  st.sensitive = { sensitive: true, reason: 'banking' };
  st.idleLabel = 'Summarise anyway';
  renderState(st);
  assert.equal(ui.$('view-idle').hidden, false);
  assert.equal(ui.$('summariseBtn').textContent, 'Summarise anyway');
  assert.equal(ui.$('sensitiveText').hidden, false);
  assert.equal(ui.$('sensitiveText').textContent, 'This page looks like a banking page. Its text would be sent to Google.');
  assert.equal(ui.$('neverSiteBtn').hidden, false);

  ui.$('neverSiteBtn').click();
  await until(() => st.sensitive.reason === 'blocklist');
  assert.deepEqual(local._m.get('settings').siteBlocklist, ['a.com']);
  assert.equal(ui.$('sensitiveText').textContent, 'This site is on your blocklist. Its text would be sent to Google.');
  assert.equal(ui.$('neverSiteBtn').hidden, true, 'already blocklisted');

  st.sensitive = { sensitive: false, reason: null };
  st.idleLabel = '';
  renderState(st);
  assert.equal(ui.$('sensitiveText').hidden, true);
  assert.equal(ui.$('summariseBtn').textContent, 'Summarise this page');

  st.view = 'summary';
  st.conv.summaryRaw = '**TL;DR:** Fact [c1].';
  st.conv.summaries.medium = st.conv.summaryRaw;
  st.conv.length = 'medium';
  st.conv.chatLength = 'medium';
  renderState(st);
  assert.equal(ui.$('footer').hidden, false, 'summary on the Page tab shows the composer');
  assert.equal(ui.$('summaryBody').querySelectorAll('button.cite').length, 1);
  setTab('tools');
  renderState(st);
  assert.equal(ui.$('footer').hidden, true, 'no composer on another tab');
  setTab('page');
  renderState(st);
  assert.equal(ui.$('footer').hidden, false);
});

test('page tab: clicking a citation injects the agent if needed and highlights the passage (fuzzy when the node map is gone)', async () => {
  const body = el('body', {}, el('p', {}, 'First paragraph with enough text to be found by the highlighter later on. '.repeat(3)));
  const env = makeEnv({ body, href: 'https://a.com/x' });
  const { rec } = installChrome({ envs: { 1: env }, tabs: { 1: { id: 1, url: 'https://a.com/x', title: 'T', windowId: 1, active: true } } });
  installStorage();
  initNav();
  initPage();
  const st = showPage('ok');
  const text = 'First paragraph with enough text to be found by the highlighter later on.';
  st.page.chunks = [chunk('c1', text)];
  // content handler is on #content; wire the cite button under it (the fake DOM is flat)
  ui.$('summaryBody').parentNode = ui.$('content');
  st.conv.summaryRaw = 'Fact [c1].';
  st.conv.summaries.medium = st.conv.summaryRaw;
  renderState(st);
  const btn = ui.$('summaryBody').querySelector('button.cite');
  btn.fire('click');
  await until(() => env.highlights && env.highlights.size === 1);
  assert.ok(rec.injects.length >= 1, 'the agent was injected on demand');
  assert.equal(env.PS.store, null, 'no extraction happened: the fuzzy path found the text');
});
