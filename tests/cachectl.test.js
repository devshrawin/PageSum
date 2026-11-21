import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldUseExplicitCache, estimateTokens, createCache, deleteCache, unsupportedModels, markUnsupported,
  cacheIsFresh, CACHE_MIN_TOKENS, UNSUPPORTED_MS,
} from '../extension/lib/cachectl.js';
import { GeminiError } from '../extension/lib/errors.js';

test('shouldUseExplicitCache: disabled, small and unsupported-model gates', () => {
  const base = { enabled: true, estTokens: 40000, model: 'm1', unsupported: new Set() };
  assert.equal(shouldUseExplicitCache(base), true);
  assert.equal(shouldUseExplicitCache({ ...base, enabled: false }), false);
  assert.equal(shouldUseExplicitCache({ ...base, estTokens: 32767 }), false);
  assert.equal(shouldUseExplicitCache({ ...base, estTokens: 32768 }), true);
  assert.equal(shouldUseExplicitCache({ ...base, unsupported: new Set(['m1']) }), false);
  assert.equal(shouldUseExplicitCache({ ...base, unsupported: new Set(['other']) }), true);
  assert.equal(shouldUseExplicitCache({ ...base, unsupported: undefined }), true);
  assert.equal(CACHE_MIN_TOKENS, 32768);
});

test('estimateTokens: chars/4, PDF pages at LOW or MEDIUM, video at 100/s', () => {
  assert.equal(estimateTokens({ chars: 400 }), 100);
  assert.equal(estimateTokens({ chars: 401 }), 101);
  assert.equal(estimateTokens({ pdfPages: 10 }), 5600);
  assert.equal(estimateTokens({ pdfPages: 10, pdfLevel: 'MEDIA_RESOLUTION_LOW' }), 2800);
  assert.equal(estimateTokens({ videoSec: 60 }), 6000);
  assert.equal(estimateTokens({ chars: 4000, pdfPages: 2, videoSec: 1 }), 1000 + 1120 + 100);
  assert.equal(estimateTokens(), 0);
});

test('unsupported map: entries expire after 24 h and old ones are dropped', () => {
  const now = 1_000_000;
  const m = markUnsupported({}, 'a', now);
  assert.equal(m.a, now + UNSUPPORTED_MS);
  assert.deepEqual([...unsupportedModels(m, now + 1000)], ['a']);
  assert.deepEqual([...unsupportedModels(m, now + UNSUPPORTED_MS + 1)], []);
  const m2 = markUnsupported({ a: now - 5, b: now + 10 }, 'c', now);
  assert.deepEqual(Object.keys(m2).sort(), ['b', 'c']);
  assert.deepEqual([...unsupportedModels(null)], []);
});

test('cacheIsFresh: usable until 30 s before it expires', () => {
  const c = { name: 'cachedContents/x', expireAt: 100000 };
  assert.equal(cacheIsFresh(c, 69999), true);
  assert.equal(cacheIsFresh(c, 70001), false);
  assert.equal(cacheIsFresh(null, 0), false);
  assert.equal(cacheIsFresh({ expireAt: 1e12 }, 0), false, 'no name');
});

function fakeFetch(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
    return responder(url, init);
  };
  fn.calls = calls;
  return fn;
}
const reply = (status, obj) => ({ ok: status < 300, status, text: async () => JSON.stringify(obj) });

test('createCache: body shape, key header only, name and expiry parsed', async () => {
  const f = fakeFetch(() => reply(200, { name: 'cachedContents/abc-123', expireTime: '2030-01-01T00:00:00Z' }));
  const contents = [{ role: 'user', parts: [{ text: 'page' }] }, { role: 'model', parts: [{ text: 'summary' }] }];
  const r = await createCache({ apiKey: 'SECRETKEY', model: 'gemini-3.5-flash-lite', system: 'SYS', contents, baseUrl: 'http://x/v1beta', fetchImpl: f });
  assert.deepEqual(r, { name: 'cachedContents/abc-123', expireAt: Date.parse('2030-01-01T00:00:00Z') });
  const c = f.calls[0];
  assert.equal(c.url, 'http://x/v1beta/cachedContents');
  assert.ok(!/key=/.test(c.url), 'the key is never in the URL');
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers['x-goog-api-key'], 'SECRETKEY');
  assert.deepEqual(c.body, {
    model: 'models/gemini-3.5-flash-lite',
    systemInstruction: { parts: [{ text: 'SYS' }] },
    contents,
    ttl: '900s',
  });
  assert.ok(!JSON.stringify(c.body).includes('SECRETKEY'));
  await createCache({ apiKey: 'k', model: 'm', system: 's', contents, ttlSec: 60, baseUrl: 'http://x', fetchImpl: f });
  assert.equal(f.calls[1].body.ttl, '60s');
});

test('createCache: without expireTime the ttl is used; errors map to GeminiError', async () => {
  const before = Date.now();
  const ok = await createCache({ apiKey: 'k', model: 'm', system: 's', contents: [], ttlSec: 100, baseUrl: 'http://x', fetchImpl: fakeFetch(() => reply(200, { name: 'cachedContents/z' })) });
  assert.ok(ok.expireAt >= before + 100000 && ok.expireAt <= Date.now() + 100000);
  const bad = await createCache({ apiKey: 'k', model: 'm', system: 's', contents: [], baseUrl: 'http://x', fetchImpl: fakeFetch(() => reply(400, { error: { message: 'Cached content is too small' } })) }).catch((e) => e);
  assert.ok(bad instanceof GeminiError);
  assert.equal(bad.code, 'bad_request');
  const net = await createCache({ apiKey: 'k', model: 'm', system: 's', contents: [], baseUrl: 'http://x', fetchImpl: async () => { throw new TypeError('offline'); } }).catch((e) => e);
  assert.equal(net.code, 'network');
  const weird = await createCache({ apiKey: 'k', model: 'm', system: 's', contents: [], baseUrl: 'http://x', fetchImpl: fakeFetch(() => reply(200, { name: '../evil' })) }).catch((e) => e);
  assert.equal(weird.code, 'bad_request', 'an unexpected name is refused');
});

test('deleteCache: DELETE with the key header, errors swallowed, odd names ignored', async () => {
  const f = fakeFetch(() => reply(200, {}));
  await deleteCache({ apiKey: 'K', name: 'cachedContents/abc', baseUrl: 'http://x/v1beta', fetchImpl: f });
  assert.equal(f.calls[0].url, 'http://x/v1beta/cachedContents/abc');
  assert.equal(f.calls[0].init.method, 'DELETE');
  assert.equal(f.calls[0].init.headers['x-goog-api-key'], 'K');
  await deleteCache({ apiKey: 'K', name: '../models', baseUrl: 'http://x', fetchImpl: f });
  await deleteCache({ apiKey: 'K', name: undefined, baseUrl: 'http://x', fetchImpl: f });
  assert.equal(f.calls.length, 1);
  await assert.doesNotReject(deleteCache({ apiKey: 'K', name: 'cachedContents/abc', baseUrl: 'http://x', fetchImpl: async () => { throw new Error('boom'); } }));
});
