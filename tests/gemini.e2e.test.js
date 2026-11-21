import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMock } from './mock-gemini.js';
import { streamGenerate, listModels, buildRequestBody, extractChunk, parts } from '../extension/lib/gemini.js';
import { GeminiError } from '../extension/lib/errors.js';
import { createCache, deleteCache } from '../extension/lib/cachectl.js';
import { bytesToBase64 } from '../extension/lib/pdf.js';

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

// ======================= phase 2: PDF, image, YouTube, explicit cache =======================

const model = 'gemini-3.5-flash-lite';
const send = (apiKey, partsList, extra = {}) => streamGenerate({
  apiKey, model, baseUrl: mock.url,
  body: buildRequestBody({ system: 'SYS', contents: [{ role: 'user', parts: partsList }], ...extra }),
});
const b64 = bytesToBase64(new TextEncoder().encode('%PDF-1.4 fake bytes'));

test('pdf: the first part is inlineData application/pdf with base64 and a resolution level', async () => {
  const r = await send('pdf', [parts.inline('application/pdf', b64, 'MEDIA_RESOLUTION_LOW'), parts.text('Summarise')]);
  assert.equal(r.text, '**TL;DR:** Hello world');
  const sent = mock.lastRequest.body.contents[0].parts;
  assert.equal(sent[0].inlineData.mimeType, 'application/pdf');
  assert.equal(sent[0].inlineData.data, b64);
  assert.deepEqual(sent[0].mediaResolution, { level: 'MEDIA_RESOLUTION_LOW' });
  assert.ok(!/[?&]key=/.test(mock.lastRequest.url));
  // the mock really checks: a text-only request is rejected
  assert.equal(await code(send('pdf', [parts.text('no pdf here')])), 'bad_request');
});

test('image: the first part is inlineData image/jpeg', async () => {
  const r = await send('image', [parts.inline('image/jpeg', b64), parts.text('What is on screen?')]);
  assert.equal(r.text, '**TL;DR:** Hello world');
  assert.equal(mock.lastRequest.body.contents[0].parts[0].inlineData.mimeType, 'image/jpeg');
  assert.equal(await code(send('image', [parts.inline('image/png', b64)])), 'bad_request');
});

test('youtube: only the canonical watch URL is accepted as fileData', async () => {
  const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const r = await send('youtube', [parts.fileUri(url), parts.text('Summarise the video')]);
  assert.equal(r.text, '**TL;DR:** Hello world');
  assert.equal(mock.lastRequest.body.contents[0].parts[0].fileData.fileUri, url);
  assert.equal(await code(send('youtube', [parts.fileUri('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=x')])), 'bad_request');
});

test('youtube-private: a 400 about the video file maps to video_unavailable; a text-only request still works', async () => {
  const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  assert.equal(await code(send('youtube-private', [parts.fileUri(url), parts.text('x')])), 'video_unavailable');
  assert.equal(await code(send('youtube-private', [parts.text('x')])), 'none', 'a text-only request (the transcript) is fine');
});

test('explicit cache: create, then generate with cachedContent and no systemInstruction, then delete', async () => {
  mock.reset();
  const contents = [{ role: 'user', parts: [{ text: 'page' }] }, { role: 'model', parts: [{ text: 'summary' }] }];
  const c = await createCache({ apiKey: 'cache-ok', model, system: 'SYS', contents, baseUrl: mock.url });
  assert.equal(c.name, 'cachedContents/abc');
  assert.ok(c.expireAt > Date.now() + 10 * 60 * 1000);
  const create = mock.requests[0];
  assert.equal(create.url, '/v1beta/cachedContents');
  assert.equal(create.headers['x-goog-api-key'], 'cache-ok');
  assert.equal(create.body.model, `models/${model}`);
  assert.equal(create.body.ttl, '900s');

  const tail = [{ role: 'user', parts: [{ text: 'follow-up question' }] }];
  const r = await streamGenerate({ apiKey: 'cache-ok', model, baseUrl: mock.url, body: buildRequestBody({ system: 'SYS', contents: tail, cachedContent: c.name }) });
  assert.equal(r.text, '**TL;DR:** Hello world');
  const gen = mock.lastRequest.body;
  assert.equal(gen.cachedContent, 'cachedContents/abc');
  assert.equal(gen.systemInstruction, undefined);
  assert.deepEqual(gen.contents, tail);

  // the mock rejects a cachedContent request that still carries a systemInstruction
  const bad = { ...buildRequestBody({ system: 'SYS', contents: tail }), cachedContent: 'cachedContents/abc' };
  assert.equal(await code(streamGenerate({ apiKey: 'cache-ok', model, baseUrl: mock.url, body: bad })), 'bad_request');

  await deleteCache({ apiKey: 'cache-ok', name: c.name, baseUrl: mock.url });
  assert.equal(mock.lastRequest.method, 'DELETE');
  assert.equal(mock.lastRequest.url, '/v1beta/cachedContents/abc');
});

test('explicit cache: an unsupported model refuses creation; the caller can carry on uncached', async () => {
  const e = await createCache({ apiKey: 'cache-unsupported', model, system: 'S', contents: [], baseUrl: mock.url }).catch((x) => x);
  assert.ok(e instanceof GeminiError);
  assert.equal(e.code, 'bad_request');
  const r = await streamGenerate({ apiKey: 'cache-unsupported', model, baseUrl: mock.url, body });
  assert.ok(r.text);
});

test('the mock records every request in order', async () => {
  mock.reset();
  await run('ok');
  await run('ok');
  assert.equal(mock.requests.length, 2);
  assert.equal(mock.requests[0].method, 'POST');
});
