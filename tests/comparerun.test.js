import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMock } from './mock-gemini.js';
import { el, makeEnv } from './helpers/fakedom.js';
import { installChrome } from './helpers/fakechrome.js';
import {
  runCompare, selectableTabs, originsFor, compareTable, locateCite, hostOfTab, ASLEEP, MAX_COMPARE_TABS,
} from '../extension/panel/comparerun.js';
import { sanitize } from '../extension/lib/storage.js';
import { resetJsonStyles } from '../extension/lib/gemini.js';

let mock;
before(async () => { mock = await startMock(); });
after(async () => { await mock.close(); delete globalThis.chrome; });
beforeEach(() => { mock.reset(); resetJsonStyles(); });

const settings = (over = {}) => sanitize({ apiKey: 'json-compare', language: 'English', ...over });
const PARA = 'This paragraph describes the product in enough words to count as readable page text. ';
const page = (title, extra = '') => el('body', {}, el('h1', {}, title), el('p', {}, PARA.repeat(5) + extra));
const T = (id, url, title) => ({ id, url, title, windowId: 1 });
const reqs = () => mock.requests.filter((r) => r.url.includes(':streamGenerateContent'));

function setup(n = 3, over = {}) {
  const envs = {};
  const tabs = {};
  for (let i = 1; i <= n; i++) {
    const url = `https://site${i}.example.com/p`;
    envs[i] = makeEnv({ body: page('Product ' + i), href: url, title: 'Product ' + i });
    tabs[i] = T(i, url, 'Product ' + i);
  }
  Object.assign(tabs, over.tabs || {});
  return { envs, tabs, ...installChrome({ envs, tabs }) };
}

test('selectableTabs: restricted pages are left out; originsFor: one hostname pattern per site', () => {
  const list = [T(1, 'https://a.com/x', 'A'), T(2, 'chrome://extensions', 'Ext'), T(3, 'https://chromewebstore.google.com/d', 'Store'), T(4, 'https://a.com:8080/y', 'A2'), T(5, 'file:///C:/x.html', 'Local'), T(6, '', 'No url')];
  assert.deepEqual(selectableTabs(list).map((t) => t.id), [1, 4, 5]);
  assert.deepEqual(originsFor(selectableTabs(list)), ['https://a.com/*']);
  assert.deepEqual(originsFor([T(1, 'https://b.com/', ''), T(2, 'http://c.org/', '')]), ['https://b.com/*', 'http://c.org/*']);
  assert.equal(hostOfTab({ url: 'https://a.com:81/x' }), 'a.com');
  assert.equal(MAX_COMPARE_TABS, 4);
});

test('runCompare: reads each tab, namespaces chunk ids, sends one block per tab, cleans the answer', async () => {
  const { tabs } = setup(3);
  const { rows, result } = await runCompare({ tabs: [tabs[1], tabs[2], tabs[3]], focus: 'price and speed', settings: settings(), baseUrl: mock.url });
  assert.deepEqual(rows.map((r) => r.ok), [true, true, true]);
  assert.deepEqual(result.tabs.map((t) => t.key), ['t1', 't2', 't3']);
  assert.deepEqual(result.tabs[1].chunks.slice(0, 2).map((c) => c.id), ['t2c1', 't2c2']);
  const text = reqs()[0].body.contents[0].parts[0].text;
  for (const k of ['t1', 't2', 't3']) assert.match(text, new RegExp(`<untrusted_page_content id="[0-9a-f]{8}-${k}">\\nTab ${k}: Product ${k.slice(1)}`));
  assert.equal((text.match(/<untrusted_page_content id=/g) || []).length, 3);
  assert.ok(text.includes('[t1c1] ## Product 1'));
  assert.ok(text.endsWith('Focus (trusted, from the user): price and speed'));
  assert.ok(reqs()[0].body.systemInstruction.parts[0].text.includes('- Return only JSON that matches the schema.'));
  // the fixture: t3 is a selected tab here, so its value survives; t2's wrong-prefix source is dropped
  const price = result.criteria[0];
  assert.deepEqual(price.values.map((v) => [v.tab, v.value, v.sources]), [['t1', '$5', ['t1c1']], ['t2', '$7', ['t2c1']], ['t3', 'ghost', []]]);
  assert.deepEqual(result.criteria[1].values.map((v) => [v.tab, v.value]), [['t1', null], ['t2', 'fast'], ['t3', null]]);
  assert.equal(result.summary, 'A is cheaper, B is faster.');
  assert.equal(result.verdict, 'Pick A for price.');
});

test('a value for a tab that was not selected is dropped', async () => {
  const { tabs } = setup(2);
  const { result } = await runCompare({ tabs: [tabs[1], tabs[2]], focus: '', settings: settings(), baseUrl: mock.url });
  assert.deepEqual(result.criteria[0].values.map((v) => v.tab), ['t1', 't2'], 'the fixture mentions t3; it is not in the selection');
  assert.ok(reqs()[0].body.contents[0].parts[0].text.includes('Pick the 5 to 10 criteria that matter most'));
});

test('an asleep tab becomes a row error and the rest are still compared (k follows the tabs that were read)', async () => {
  const { tabs } = setup(3, { tabs: {} });
  tabs[2].discarded = true;
  const { rows, result } = await runCompare({ tabs: [tabs[1], tabs[2], tabs[3]], focus: '', settings: settings(), baseUrl: mock.url });
  assert.deepEqual(rows.map((r) => r.ok), [true, false, true]);
  assert.equal(rows[1].error, ASLEEP);
  assert.deepEqual(result.tabs.map((t) => [t.key, t.tabId]), [['t1', 1], ['t2', 3]]);
  assert.ok(reqs()[0].body.contents[0].parts[0].text.includes('Tab t2: Product 3'));
});

test('fewer than two readable tabs: no request, a message and the row errors', async () => {
  const { tabs, envs } = setup(3);
  tabs[2].discarded = true;
  envs[3].denied = true;
  tabs[3].url = 'https://site3.example.com/p';
  const r = await runCompare({ tabs: [tabs[1], tabs[2], tabs[3]], focus: '', settings: settings(), baseUrl: mock.url });
  assert.equal(r.result, null);
  assert.match(r.message, /at least two readable tabs/);
  assert.equal(r.rows[2].ok, false);
  assert.match(r.rows[2].error, /can't read this tab/);
  assert.equal(reqs().length, 0);
  const restricted = setup(2);
  restricted.tabs[1].url = 'chrome://extensions';
  const r2 = await runCompare({ tabs: [restricted.tabs[1], restricted.tabs[2]], focus: '', settings: settings(), baseUrl: mock.url });
  assert.equal(r2.rows[0].error, "Chrome doesn't let extensions read this page.");
  assert.equal(r2.result, null);
});

test('per-tab budget: max(10,000, maxChars / n) characters, whole chunks only', async () => {
  const kids = Array.from({ length: 60 }, (_, i) => el('p', {}, `Paragraph ${i}. ` + 'q'.repeat(400)));
  const { tabs, envs } = setup(2);
  envs[1] = makeEnv({ body: el('body', {}, el('h1', {}, 'Big'), ...kids), href: 'https://site1.example.com/p', title: 'Product 1' });
  installChrome({ envs, tabs });
  const { result } = await runCompare({ tabs: [tabs[1], tabs[2]], focus: '', settings: settings({ maxChars: 20000 }), baseUrl: mock.url });
  const sum = result.tabs[0].chunks.reduce((n, c) => n + c.text.length, 0);
  assert.ok(sum <= 10000 && sum > 9000, `sum=${sum}`);
});

test('at most four tabs are used', async () => {
  const { tabs } = setup(5);
  const { rows } = await runCompare({ tabs: [1, 2, 3, 4, 5].map((i) => tabs[i]), focus: '', settings: settings(), baseUrl: mock.url });
  assert.equal(rows.length, 4);
});

test('compareTable and locateCite', async () => {
  const { tabs } = setup(2);
  const { result } = await runCompare({ tabs: [tabs[1], tabs[2]], focus: '', settings: settings(), baseUrl: mock.url });
  const t = compareTable(result);
  assert.deepEqual(t.columns, ['Criterion', 'Product 1', 'Product 2']);
  assert.deepEqual(t.rows[0], ['Price', '$5', '$7']);
  assert.deepEqual(t.rows[1], ['Speed', null, 'fast']);
  const hit = locateCite(result, 't2c1');
  assert.equal(hit.tab.tabId, 2);
  assert.equal(hit.chunk.id, 't2c1');
  assert.equal(locateCite(result, 't2c999'), null);
  assert.equal(locateCite(result, 'c1'), null);
  assert.equal(locateCite(null, 't1c1'), null);
});
