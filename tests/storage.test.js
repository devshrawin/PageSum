import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS, getSettings, saveSettings, pruneCache, putCacheEntry, getCacheEntry, deleteCacheEntry, clearCache,
} from '../extension/lib/storage.js';

function fakeArea() {
  const m = new Map();
  return {
    async get(key) { return m.has(key) ? { [key]: structuredClone(m.get(key)) } : {}; },
    async set(obj) { for (const [k, v] of Object.entries(obj)) m.set(k, structuredClone(v)); },
    async remove(key) { m.delete(key); },
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

test('pruneCache keeps the 30 newest', () => {
  const entries = {};
  for (let i = 0; i < 45; i++) entries['u' + i] = { at: i };
  const out = pruneCache({ entries });
  const keys = Object.keys(out.entries);
  assert.equal(keys.length, 30);
  assert.ok(keys.includes('u44') && keys.includes('u15'));
  assert.ok(!keys.includes('u14'));
});

test('putCacheEntry sets at, getCacheEntry reads, delete and clear work', async () => {
  const a = fakeArea();
  const before = Date.now();
  await putCacheEntry('k1', { textHash: 'h', source: 'article', summaries: { medium: 's' }, chatLength: 'medium', messages: [] }, a);
  const e = await getCacheEntry('k1', a);
  assert.ok(e.at >= before);
  assert.equal(e.summaries.medium, 's');
  assert.equal(await getCacheEntry('nope', a), null);
  await deleteCacheEntry('k1', a);
  assert.equal(await getCacheEntry('k1', a), null);
  await putCacheEntry('k2', { textHash: 'h' }, a);
  await clearCache(a);
  assert.equal(await getCacheEntry('k2', a), null);
});

test('putCacheEntry prunes beyond 30', async () => {
  const a = fakeArea();
  for (let i = 0; i < 35; i++) await putCacheEntry('k' + i, { textHash: 'h' }, a);
  assert.equal(Object.keys((await a.get('cache')).cache.entries).length, 30);
});
