import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMock } from './mock-gemini.js';
import { streamGenerate, listModels, buildRequestBody, extractChunk } from '../extension/lib/gemini.js';
import { GeminiError } from '../extension/lib/errors.js';

let mock;
before(async () => { mock = await startMock(); });
after(async () => { await mock.close(); });

const body = buildRequestBody({ system: 'SYS', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] });
const run = (apiKey, extra = {}) => streamGenerate({ apiKey, model: 'gemini-3.5-flash-lite', body, baseUrl: mock.url, ...extra });
const code = async (p) => { try { await p; } catch (e) { assert.ok(e instanceof GeminiError, String(e)); return e.code; } return 'none'; };

test('ok: streams text, onText grows, request is well-formed', async () => {
  const seen = [];
  const r = await run('ok', { onText: (t) => seen.push(t) });
  assert.equal(r.text, '**TL;DR:** Hello world');
  assert.equal(r.finishReason, 'STOP');
  assert.deepEqual(seen, ['**TL;DR:** Hello', '**TL;DR:** Hello world']);
  const req = mock.lastRequest;
  assert.equal(req.method, 'POST');
  assert.equal(req.headers['x-goog-api-key'], 'ok');
  assert.ok(req.url.startsWith('/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse'));
  assert.ok(!/[?&]key=/.test(req.url));
  assert.equal(req.headers['content-type'], 'application/json');
  assert.ok(req.body.systemInstruction);
  assert.deepEqual(req.body.contents, [{ role: 'user', parts: [{ text: 'hi' }] }]);
  assert.equal(req.body.generationConfig, undefined);
});

test('thought parts are excluded', async () => {
  const r = await run('thought');
  assert.equal(r.text, 'Visible answer');
});

test('MAX_TOKENS returns normally', async () => {
  const r = await run('maxtokens');
  assert.equal(r.text, 'cut');
  assert.equal(r.finishReason, 'MAX_TOKENS');
});

test('HTTP failures map to codes', async () => {
  assert.equal(await code(run('badkey')), 'bad_key');
  assert.equal(await code(run('notfound')), 'model_not_found');
  assert.equal(await code(run('busy')), 'server');
  const d = await run('quota-day').catch((e) => e);
  assert.equal(d.code, 'quota');
  assert.equal(d.detail.daily, true);
  const m = await run('quota-min').catch((e) => e);
  assert.equal(m.code, 'quota');
  assert.equal(m.retryAfterSec, 37);
  assert.equal(m.detail.daily, false);
});

test('blocked, empty, midstream error', async () => {
  assert.equal(await code(run('blocked')), 'blocked');
  assert.equal(await code(run('empty')), 'empty');
  assert.equal(await code(run('midstream-error')), 'server');
});

test('stall hits the idle timeout', async () => {
  const t0 = Date.now();
  assert.equal(await code(run('stall', { idleMs: 150 })), 'timeout');
  assert.ok(Date.now() - t0 < 3000);
});

test('abort signal gives aborted', async () => {
  const ac = new AbortController();
  const p = run('ok', { signal: ac.signal, onText: () => ac.abort() });
  assert.equal(await code(p), 'aborted');
  const pre = new AbortController();
  pre.abort();
  assert.equal(await code(run('ok', { signal: pre.signal })), 'aborted');
});

test('network failure maps to network', async () => {
  const e = await streamGenerate({ apiKey: 'ok', model: 'm', body, baseUrl: 'http://127.0.0.1:1/v1beta' }).catch((x) => x);
  assert.equal(e.code, 'network');
});

test('listModels filters the fixture and sends the key as a header', async () => {
  const ids = await listModels({ apiKey: 'ok', baseUrl: mock.url });
  assert.deepEqual(ids, ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.8-pro']);
  assert.equal(mock.lastRequest.headers['x-goog-api-key'], 'ok');
  assert.ok(!/key=/.test(mock.lastRequest.url));
  assert.equal(await code(listModels({ apiKey: 'badkey', baseUrl: mock.url })), 'bad_key');
});

test('extractChunk', () => {
  assert.deepEqual(extractChunk({}), { text: '', finishReason: null, blockReason: null, error: null });
  const c = extractChunk({ candidates: [{ content: { parts: [{ text: 'a', thought: true }, { text: 'b' }, { text: 'c' }] }, finishReason: 'STOP' }], promptFeedback: { blockReason: 'SAFETY' } });
  assert.equal(c.text, 'bc');
  assert.equal(c.finishReason, 'STOP');
  assert.equal(c.blockReason, 'SAFETY');
});
