import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterModelList, DEFAULT_MODEL, MODEL_PRESETS } from '../extension/lib/models.js';

const G = ['generateContent', 'countTokens'];

test('filterModelList', () => {
  const list = filterModelList([
    { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: G },
    { name: 'models/gemini-3.8-pro', supportedGenerationMethods: G },
    { name: 'models/gemini-3.8-flash', supportedGenerationMethods: G },
    { name: 'models/gemini-3.8-flash-image', supportedGenerationMethods: G },
    { name: 'models/gemini-3-flash-tts', supportedGenerationMethods: G },
    { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/gemini-live-2.5-flash', supportedGenerationMethods: G },
    { name: 'models/gemini-2.5-flash-native-audio', supportedGenerationMethods: G },
    { name: 'models/gemini-no-generate', supportedGenerationMethods: ['countTokens'] },
    { name: 'models/gemma-3-27b', supportedGenerationMethods: G },
    { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: G },
  ]);
  assert.deepEqual(list, ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.8-pro']);
});

test('filterModelList tolerates junk', () => {
  assert.deepEqual(filterModelList(undefined), []);
  assert.deepEqual(filterModelList([null, {}]), []);
});

test('presets include the default', () => {
  assert.ok(MODEL_PRESETS.some((m) => m.id === DEFAULT_MODEL));
  assert.equal(MODEL_PRESETS.length, 5);
});
