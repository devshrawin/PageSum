import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequestBody, parts } from '../extension/lib/gemini.js';

const contents = [{ role: 'user', parts: [{ text: 'hi' }] }];
const schema = { type: 'object', properties: { a: { type: 'string' } } };

test('buildRequestBody: plain body has system, contents and no generationConfig', () => {
  const b = buildRequestBody({ system: 'SYS', contents });
  assert.deepEqual(b, { systemInstruction: { parts: [{ text: 'SYS' }] }, contents });
  assert.equal(b.generationConfig, undefined);
});

test('buildRequestBody: json with responseFormat (default)', () => {
  const b = buildRequestBody({ system: 'S', contents, json: schema });
  assert.deepEqual(b.generationConfig, { responseFormat: { text: { mimeType: 'APPLICATION_JSON', schema } } });
  const explicit = buildRequestBody({ system: 'S', contents, json: schema, jsonStyle: 'responseFormat' });
  assert.deepEqual(explicit.generationConfig, b.generationConfig);
});

test('buildRequestBody: json with the legacy pair', () => {
  const b = buildRequestBody({ system: 'S', contents, json: schema, jsonStyle: 'legacy' });
  assert.deepEqual(b.generationConfig, { responseMimeType: 'application/json', responseJsonSchema: schema });
});

test('buildRequestBody: cachedContent omits systemInstruction', () => {
  const b = buildRequestBody({ system: 'S', contents, cachedContent: 'cachedContents/abc' });
  assert.equal(b.cachedContent, 'cachedContents/abc');
  assert.equal(b.systemInstruction, undefined);
  assert.deepEqual(b.contents, contents);
});

test('buildRequestBody never sends sampling fields', () => {
  const s = JSON.stringify(buildRequestBody({ system: 'S', contents, json: schema }));
  for (const k of ['temperature', 'topP', 'topK', 'maxOutputTokens']) assert.ok(!s.includes(k), k);
});

test('parts builders', () => {
  assert.deepEqual(parts.text('x'), { text: 'x' });
  assert.deepEqual(parts.inline('application/pdf', 'QQ=='), { inlineData: { mimeType: 'application/pdf', data: 'QQ==' } });
  assert.deepEqual(parts.inline('application/pdf', 'QQ==', 'MEDIA_RESOLUTION_LOW'),
    { inlineData: { mimeType: 'application/pdf', data: 'QQ==' }, mediaResolution: { level: 'MEDIA_RESOLUTION_LOW' } });
  assert.deepEqual(parts.fileUri('https://www.youtube.com/watch?v=abcdefghijk'), { fileData: { fileUri: 'https://www.youtube.com/watch?v=abcdefghijk' } });
  assert.deepEqual(parts.fileUri('u', 'MEDIA_RESOLUTION_LOW'), { fileData: { fileUri: 'u' }, mediaResolution: { level: 'MEDIA_RESOLUTION_LOW' } });
});
