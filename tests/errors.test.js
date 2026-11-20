import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiError, mapHttpError, mapFetchError, mapFinishReason, userMessage, redactKey } from '../extension/lib/errors.js';

const badKeyBody = JSON.stringify({
  error: {
    code: 400,
    message: 'API key not valid. Please pass a valid API key.',
    status: 'INVALID_ARGUMENT',
    details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }],
  },
});

test('bad key (ErrorInfo reason)', () => {
  const e = mapHttpError(400, badKeyBody);
  assert.ok(e instanceof GeminiError);
  assert.equal(e.code, 'bad_key');
  const m = userMessage(e, { currentModel: 'x' });
  assert.equal(m.title, 'Invalid API key');
  assert.deepEqual(m.actions, ['settings']);
});

test('bad key by message only', () => {
  const e = mapHttpError(400, JSON.stringify({ error: { message: 'API key not valid.' } }));
  assert.equal(e.code, 'bad_key');
});

test('region', () => {
  const e = mapHttpError(400, JSON.stringify({ error: { message: 'User location is not supported for the API use.' } }));
  assert.equal(e.code, 'region');
  assert.deepEqual(userMessage(e, {}).actions, []);
});

test('bad_request redacts and truncates', () => {
  const key = 'AIza' + 'a'.repeat(35);
  const e = mapHttpError(400, JSON.stringify({ error: { message: `bad ${key} ` + 'x'.repeat(400) } }));
  assert.equal(e.code, 'bad_request');
  const m = userMessage(e, {});
  assert.ok(m.body.length <= 200);
  assert.ok(!m.body.includes(key));
  assert.deepEqual(m.actions, ['retry']);
});

test('401 and 403 forbidden', () => {
  assert.equal(mapHttpError(403, '{}').code, 'forbidden');
  assert.equal(mapHttpError(401, 'not json').code, 'forbidden');
  assert.deepEqual(userMessage(mapHttpError(403, '{}'), {}).actions, ['settings']);
});

test('404 model not found', () => {
  const e = mapHttpError(404, JSON.stringify({ error: { code: 404, message: 'models/x is not found' } }));
  assert.equal(e.code, 'model_not_found');
  const m = userMessage(e, { currentModel: 'gemini-0-fake' });
  assert.match(m.body, /gemini-0-fake/);
  assert.deepEqual(m.actions, ['switchModel', 'settings']);
});

test('429 daily quota', () => {
  const body = JSON.stringify({ error: { code: 429, message: 'quota', details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'm', quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] },
  ] } });
  const e = mapHttpError(429, body);
  assert.equal(e.code, 'quota');
  const m = userMessage(e, { currentModel: 'gemini-3.8-flash' });
  assert.match(m.body, /Daily free quota for gemini-3\.8-flash is used up/);
  assert.deepEqual(m.actions, ['retry', 'switchModel']);
});

test('429 with RetryInfo', () => {
  const body = JSON.stringify({ error: { code: 429, message: 'quota', details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' },
  ] } });
  const e = mapHttpError(429, body);
  assert.equal(e.retryAfterSec, 37);
  assert.match(userMessage(e, { currentModel: 'm' }).body, /Try again in 37s/);
});

test('retryDelay ceil and default 60', () => {
  const e = mapHttpError(429, JSON.stringify({ error: { details: [{ retryDelay: '1.5s' }] } }));
  assert.equal(e.retryAfterSec, 2);
  const e2 = mapHttpError(429, '{}');
  assert.match(userMessage(e2, { currentModel: 'm' }).body, /60s/);
});

test('array-wrapped body', () => {
  const e = mapHttpError(400, '[' + badKeyBody + ']');
  assert.equal(e.code, 'bad_key');
});

test('non-JSON body', () => {
  const e = mapHttpError(502, '<html>Bad gateway</html>');
  assert.equal(e.code, 'server');
});

test('5xx server', () => {
  for (const s of [500, 502, 503, 504]) assert.equal(mapHttpError(s, '{}').code, 'server');
  const m = userMessage(mapHttpError(503, '{}'), {});
  assert.equal(m.title, 'Gemini is busy');
  assert.deepEqual(m.actions, ['retry']);
});

test('other non-OK', () => {
  const e = mapHttpError(418, JSON.stringify({ error: { message: 'teapot' } }));
  assert.equal(e.code, 'http');
  const m = userMessage(e, {});
  assert.equal(m.title, 'Unexpected error (418)');
  assert.equal(m.body, 'teapot');
});

test('mapFetchError', () => {
  const abort = new Error('x'); abort.name = 'AbortError';
  assert.equal(mapFetchError(abort).code, 'aborted');
  assert.equal(mapFetchError(new TypeError('fetch failed')).code, 'network');
  assert.equal(userMessage(new GeminiError('network'), {}).title, "Can't reach Gemini");
  assert.equal(userMessage(new GeminiError('timeout'), {}).title, 'Gemini stopped responding');
  assert.deepEqual(userMessage(new GeminiError('aborted'), {}), { title: '', body: '', actions: [] });
});

test('mapFinishReason', () => {
  for (const r of ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY']) assert.equal(mapFinishReason(r).code, 'blocked');
  assert.equal(mapFinishReason('RECITATION').code, 'recitation');
  assert.equal(mapFinishReason('OTHER').code, 'empty');
  assert.equal(mapFinishReason('MALFORMED_FUNCTION_CALL').code, 'empty');
  assert.equal(mapFinishReason('STOP'), null);
  assert.equal(mapFinishReason('MAX_TOKENS'), null);
  assert.equal(mapFinishReason(null), null);
  assert.deepEqual(userMessage(new GeminiError('blocked'), {}).actions, []);
  assert.deepEqual(userMessage(new GeminiError('recitation'), {}).actions, ['retry']);
  assert.equal(userMessage(new GeminiError('empty'), {}).title, 'Empty response');
});

test('switchModel hidden when current model is the default', () => {
  const e = mapHttpError(404, '{}');
  assert.deepEqual(userMessage(e, { currentModel: 'gemini-3.5-flash-lite' }).actions, ['settings']);
  const q = mapHttpError(429, '{}');
  assert.deepEqual(userMessage(q, { currentModel: 'gemini-3.5-flash-lite' }).actions, ['retry']);
});

test('redactKey', () => {
  const key = 'AIza' + 'B1_-x'.repeat(7);
  assert.equal(key.length, 39);
  const out = redactKey(`url?key=${key} and again ${key}`);
  assert.ok(!out.includes(key));
  assert.ok(out.includes('AIza…[redacted]'));
  assert.equal(redactKey('nothing here'), 'nothing here');
});
