import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS, getSettings, saveSettings, sanitize, migrateStorage, pruneCache,
  putCacheEntry, getCacheEntry, deleteCacheEntry, clearCache,
} from '../extension/lib/storage.js';
import { normalizeHostEntry, hostMatchesList } from '../extension/lib/sensitive.js';

function fakeArea() {
  const m = new Map();
  return {
    async get(key) { return m.has(key) ? { [key]: structuredClone(m.get(key)) } : {}; },
    async set(obj) { for (const [k, v] of Object.entries(obj)) m.set(k, structuredClone(v)); },
    async remove(key) { for (const k of Array.isArray(key) ? key : [key]) m.delete(k); },
    _m: m,
  };
}

test('getSettings merges defaults', async () => {
  const a = fakeArea();
  assert.deepEqual(await getSettings(a), DEFAULT_SETTINGS);
  await a.set({ settings: { apiKey: 'k', maxChars: 1 } });
  const s = await getSettings(a);
  assert.equal(s.apiKey, 'k');
  assert.equal(s.model, 'gemini-3.5-flash-lite');
  assert.equal(s.maxChars, 5000); // clamped
  assert.equal(s.schemaVersion, 2);
});

test('v2 defaults match the spec', () => {
  assert.equal(DEFAULT_SETTINGS.schemaVersion, 2);
  assert.equal(DEFAULT_SETTINGS.citations, true);
  assert.equal(DEFAULT_SETTINGS.structuredExtraction, true);
  assert.equal(DEFAULT_SETTINGS.readFrames, true);
  assert.equal(DEFAULT_SETTINGS.vision, 'ask');
  assert.equal(DEFAULT_SETTINGS.youtubeMode, 'video');
  assert.equal(DEFAULT_SETTINGS.explicitCache, false);
  assert.equal(DEFAULT_SETTINGS.translateTarget, 'English');
  assert.equal(DEFAULT_SETTINGS.historyEnabled, true);
  assert.equal(DEFAULT_SETTINGS.historySaveChat, false);
  assert.equal(DEFAULT_SETTINGS.sensitiveGuard, true);
  assert.deepEqual(DEFAULT_SETTINGS.siteBlocklist, []);
});

test('saveSettings patches and clamps', async () => {
  const a = fakeArea();
  await saveSettings({ apiKey: ' abc ' }, a);
  await saveSettings({ language: '', maxChars: 9e9 }, a);
  const s = await getSettings(a);
  assert.equal(s.apiKey, 'abc');
  assert.equal(s.language, '');
  assert.equal(s.maxChars, 400000);
  assert.equal(s.defaultLength, 'medium');
});

test('v1 settings object keeps key/model/length and gains v2 defaults', async () => {
  const a = fakeArea();
  await a.set({ settings: { apiKey: 'KEY', model: 'gemini-3.8-flash', defaultLength: 'short', language: 'French', maxChars: 30000, autoSummarize: false } });
  const s = await getSettings(a);
  assert.equal(s.apiKey, 'KEY');
  assert.equal(s.model, 'gemini-3.8-flash');
  assert.equal(s.defaultLength, 'short');
  assert.equal(s.language, 'French');
  assert.equal(s.maxChars, 30000);
  assert.equal(s.autoSummarize, false);
  assert.equal(s.citations, true);
  assert.equal(s.schemaVersion, 2);
});

test('enums are sanitised, booleans coerced, blocklist normalised', () => {
  const s = sanitize({
    vision: 'bogus', youtubeMode: 'x', citations: 0, readFrames: '', explicitCache: 1, translateTarget: '  ',
    siteBlocklist: ['https://Foo.com/x', 'foo.com', '*.Bank.com', 'not a host!', '', 42],
  });
  assert.equal(s.vision, 'ask');
  assert.equal(s.youtubeMode, 'video');
  assert.equal(s.citations, false);
  assert.equal(s.readFrames, false);
  assert.equal(s.explicitCache, true);
  assert.equal(s.translateTarget, 'English');
  assert.deepEqual(s.siteBlocklist, ['foo.com', '*.bank.com', '42']);
  assert.equal(sanitize({ vision: 'auto' }).vision, 'auto');
  assert.equal(sanitize({ youtubeMode: 'transcript' }).youtubeMode, 'transcript');
  const many = sanitize({ siteBlocklist: Array.from({ length: 300 }, (_, i) => `h${i}.com`) });
  assert.equal(many.siteBlocklist.length, 200);
});

test('normalizeHostEntry and hostMatchesList', () => {
  assert.equal(normalizeHostEntry('https://Foo.com/x?y#z'), 'foo.com');
  assert.equal(normalizeHostEntry('  *.Example.COM '), '*.example.com');
  assert.equal(normalizeHostEntry('foo.com:8080'), 'foo.com');
  assert.equal(normalizeHostEntry('bad host'), '');
  assert.equal(hostMatchesList('www.bank.com', ['*.bank.com']), true);
  assert.equal(hostMatchesList('bank.com', ['*.bank.com']), true);
  assert.equal(hostMatchesList('notbank.com', ['*.bank.com']), false);
  assert.equal(hostMatchesList('a.foo.com', ['foo.com']), false);
});

test('migrateStorage rewrites settings, removes the v1 session cache, and is idempotent', async () => {
  const local = fakeArea();
  const session = fakeArea();
  await local.set({ settings: { apiKey: 'K', model: 'm1', defaultLength: 'detailed', maxChars: 1000 } });
  await session.set({ cache: { entries: { u: { at: 1 } } }, cache2: { entries: { u2: { at: 2 } } } });
  await migrateStorage(local, session);
  const once = (await local.get('settings')).settings;
  assert.equal(once.apiKey, 'K');
  assert.equal(once.model, 'm1');
  assert.equal(once.defaultLength, 'detailed');
  assert.equal(once.maxChars, 5000);
  assert.equal(once.schemaVersion, 2);
  assert.equal(once.citations, true);
  assert.deepEqual(await session.get('cache'), {});
  assert.ok((await session.get('cache2')).cache2, 'v2 cache untouched');
  await migrateStorage(local, session);
  assert.deepEqual((await local.get('settings')).settings, once);
  // nothing stored: nothing written
  const empty = fakeArea();
  await migrateStorage(empty, fakeArea());
  assert.deepEqual(await empty.get('settings'), {});
});

test('pruneCache keeps the 20 newest', () => {
  const entries = {};
  for (let i = 0; i < 45; i++) entries['u' + i] = { at: i };
  const out = pruneCache({ entries });
  const keys = Object.keys(out.entries);
  assert.equal(keys.length, 20);
  assert.ok(keys.includes('u44') && keys.includes('u25'));
  assert.ok(!keys.includes('u24'));
});

test('putCacheEntry writes cache2 with v and at; get, delete and clear work', async () => {
  const a = fakeArea();
  const before = Date.now();
  await putCacheEntry('k1', { textHash: 'h', source: 'article', summaries: { medium: 's' }, chatLength: 'medium', messages: [] }, a);
  const e = await getCacheEntry('k1', a);
  assert.ok(e.at >= before);
  assert.equal(e.v, 2);
  assert.equal(e.summaries.medium, 's');
  assert.ok((await a.get('cache2')).cache2.entries.k1);
  assert.deepEqual(await a.get('cache'), {});
  assert.equal(await getCacheEntry('nope', a), null);
  await deleteCacheEntry('k1', a);
  assert.equal(await getCacheEntry('k1', a), null);
  await putCacheEntry('k2', { textHash: 'h' }, a);
  await clearCache(a);
  assert.equal(await getCacheEntry('k2', a), null);
});

test('putCacheEntry prunes beyond 20', async () => {
  const a = fakeArea();
  for (let i = 0; i < 25; i++) await putCacheEntry('k' + i, { textHash: 'h' }, a);
  assert.equal(Object.keys((await a.get('cache2')).cache2.entries).length, 20);
});
