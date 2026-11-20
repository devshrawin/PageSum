import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAgentEvent, isTrustedAgentSender } from '../extension/lib/messages.js';

const env = (event, data, over = {}) => ({ v: 2, src: 'pagesum-agent', type: 'agent/event', event, data, ...over });

test('validateAgentEvent accepts the three events', () => {
  assert.deepEqual(validateAgentEvent(env('navigated', { href: 'https://a.com/x' })), { ok: true, event: 'navigated', data: { href: 'https://a.com/x' } });
  assert.deepEqual(validateAgentEvent(env('guideTargetLost', { elementId: 'e12' })), { ok: true, event: 'guideTargetLost', data: { elementId: 'e12' } });
  assert.deepEqual(validateAgentEvent(env('escape', {})), { ok: true, event: 'escape', data: {} });
  assert.equal(validateAgentEvent(env('escape')).ok, true, 'data optional for escape');
});

test('validateAgentEvent: extra keys are ignored', () => {
  const r = validateAgentEvent(env('navigated', { href: 'https://a.com/', evil: '<script>' }, { extra: 1 }));
  assert.deepEqual(r.data, { href: 'https://a.com/' });
});

test('validateAgentEvent rejects wrong envelope, unknown events and bad payloads', () => {
  assert.equal(validateAgentEvent(null).ok, false);
  assert.equal(validateAgentEvent('x').ok, false);
  assert.equal(validateAgentEvent(env('navigated', { href: 'https://a.com' }, { v: 1 })).ok, false);
  assert.equal(validateAgentEvent(env('navigated', { href: 'https://a.com' }, { src: 'page' })).ok, false);
  assert.equal(validateAgentEvent(env('navigated', { href: 'https://a.com' }, { type: 'x' })).ok, false);
  assert.equal(validateAgentEvent(env('hello', {})).ok, false);
  assert.equal(validateAgentEvent(env('constructor', {})).ok, false);
  assert.equal(validateAgentEvent(env('navigated', { href: 'not a url' })).ok, false);
  assert.equal(validateAgentEvent(env('navigated', { href: 5 })).ok, false);
  assert.equal(validateAgentEvent(env('navigated', { href: 'https://a.com/' + 'x'.repeat(2100) })).ok, false);
  assert.equal(validateAgentEvent(env('navigated', {})).ok, false);
  assert.equal(validateAgentEvent(env('guideTargetLost', { elementId: 'x1' })).ok, false);
  assert.equal(validateAgentEvent(env('guideTargetLost', { elementId: 'e12345' })).ok, false);
  assert.equal(validateAgentEvent(env('guideTargetLost', { elementId: 'e1; drop' })).ok, false);
});

test('isTrustedAgentSender', () => {
  const good = { id: 'abc', tab: { id: 3 }, frameId: 0 };
  assert.equal(isTrustedAgentSender(good, 'abc'), true);
  assert.equal(isTrustedAgentSender({ ...good, id: 'other' }, 'abc'), false, 'foreign extension');
  assert.equal(isTrustedAgentSender({ id: 'abc', frameId: 0 }, 'abc'), false, 'no tab');
  assert.equal(isTrustedAgentSender({ id: 'abc', tab: {}, frameId: 0 }, 'abc'), false);
  assert.equal(isTrustedAgentSender({ id: 'abc', tab: { id: 3 } }, 'abc'), false, 'no frameId');
  assert.equal(isTrustedAgentSender(null, 'abc'), false);
  assert.equal(isTrustedAgentSender({ tab: { id: 3 }, frameId: 0 }, undefined), false);
});
