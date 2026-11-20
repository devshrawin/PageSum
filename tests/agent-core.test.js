import { test } from 'node:test';
import assert from 'node:assert/strict';
import { t, el, makeEnv } from './helpers/fakedom.js';

const mk = (over = {}) => makeEnv({ body: el('body', {}, el('p', {}, 'x')), ...over }).load(['core.js', 'extract.js', 'highlight.js']);

test('ping answers with the agent version', () => {
  assert.deepEqual(mk().call('ping', {}), { ok: true, data: { v: 2 } });
});

test('call() allowlist: unknown names (including prototype names) return unknown_command', () => {
  const env = mk();
  for (const name of ['nope', 'constructor', '__proto__', 'toString', 'hasOwnProperty', '', 5, null, undefined, 'seek', 'guideShow']) {
    const r = env.call(name, {});
    assert.equal(r.ok, false, String(name));
    assert.equal(r.error.code, 'unknown_command', String(name));
  }
});

test('phase 1 exposes exactly ping, extract, highlight and clearHighlight', () => {
  assert.deepEqual(Object.keys(mk().PS.handlers).sort(), ['clearHighlight', 'extract', 'highlight', 'ping']);
});

test('non-object args are coerced to {} and never crash a handler', () => {
  const env = mk();
  assert.equal(env.call('ping', 'junk').ok, true);
  assert.equal(env.call('ping', null).ok, true);
  assert.equal(env.call('ping', [1, 2]).ok, true);
  assert.equal(env.call('extract', { maxRawChars: 'abc', maxChunkChars: -5, ignoreSelection: 'yes' }).ok, true);
  assert.equal(env.call('highlight', { localId: { evil: 1 }, text: 12345 }).ok, true);
});

test('arg helpers clamp numbers and cap strings', () => {
  const U = mk().PS.util;
  assert.equal(U.num(NaN, 0, 86400, 0), 0);
  assert.equal(U.num('abc', 0, 86400, 7), 7);
  assert.equal(U.num(-5, 0, 86400, 0), 0);
  assert.equal(U.num(1e12, 0, 86400, 0), 86400);
  assert.equal(U.num('42', 0, 100, 0), 42);
  assert.equal(U.str('x'.repeat(5000)).length, 500);
  assert.equal(U.str('x'.repeat(5000), 700).length, 700);
  assert.equal(U.str(null), '');
  assert.equal(U.str(12), '12');
});

test('a handler that throws gives { ok: false } instead of throwing', () => {
  const env = mk();
  env.PS.register('boom', () => { throw new Error('kaboom ' + 'x'.repeat(500)); });
  const r = env.call('boom', {});
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'exception');
  assert.ok(r.error.message.startsWith('kaboom'));
  assert.ok(r.error.message.length <= 200);
});

test('pure helpers: collapse, rawToCollapsed, splitSentences', () => {
  const U = mk().PS.util;
  assert.equal(U.collapse(' a  \t b​ c\n'), ' a b c ');
  assert.equal(U.rawToCollapsed('a \t\n b', 0), 0);
  assert.equal(U.rawToCollapsed('a \t\n b', 1), 1);
  assert.equal(U.rawToCollapsed('a \t\n b', 3), 2, 'inside a whitespace run counts the run once');
  assert.equal(U.rawToCollapsed('a \t\n b', 6), 3);
  const sp = U.splitSentences('One. Two! Three? ' + 'x'.repeat(50), 20);
  assert.deepEqual(JSON.parse(JSON.stringify(sp.map((s) => s.text))), ['One. Two! Three?', 'x'.repeat(20), 'x'.repeat(20), 'x'.repeat(10)]);
  assert.deepEqual(JSON.parse(JSON.stringify(U.splitSentences('short', 20))), [{ text: 'short', start: 0, end: 5 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(U.splitSentences('  ', 20))), []);
});

test('events use the typed envelope', () => {
  const env = mk();
  assert.equal(env.PS.emit('navigated', { href: 'https://a.com/' }), true);
  assert.deepEqual(JSON.parse(JSON.stringify(env.sent[0])), { v: 2, src: 'pagesum-agent', type: 'agent/event', event: 'navigated', data: { href: 'https://a.com/' } });
});

test('teardown when chrome.runtime.id is gone (extension reloaded): listeners removed, highlight cleared, no events', () => {
  const body = el('body', {}, el('p', {}, 'Some readable paragraph text that is long enough to find again later. '.repeat(5)));
  const env = makeEnv({ body }).load();
  const blk = env.call('extract', {}).data.blocks[0];
  assert.equal(env.call('highlight', { localId: blk.localId, text: blk.text }).data.found, 'exact');
  assert.equal(env.highlights.size, 1);
  assert.ok(env.listeners.keydown.length >= 1);

  env.sandbox.chrome.runtime.id = undefined;
  assert.equal(env.PS.emit('escape', {}), false);
  assert.equal(env.sent.length, 0, 'nothing sent after the context is gone');
  assert.equal(env.PS.dead, true);
  assert.equal(env.highlights.size, 0, 'highlight cleared');
  assert.equal((env.listeners.keydown || []).length, 0);
  assert.equal((env.listeners.popstate || []).length, 0);
  assert.equal((env.listeners.hashchange || []).length, 0);
  const r = env.call('ping', {});
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'dead');
});

test('the agent never listens for page messages and uses the Navigation API when present', () => {
  const env = makeEnv({ body: el('body', {}), hasNavigation: true }).load(['core.js']);
  assert.equal(env.listeners.message, undefined);
  assert.ok(env.listeners['nav:navigatesuccess'].length === 1);
  const plainEnv = makeEnv({ body: el('body', {}) }).load(['core.js']);
  assert.equal(plainEnv.listeners.message, undefined);
  assert.ok(plainEnv.listeners.popstate.length === 1 && plainEnv.listeners.hashchange.length === 1);
});

test('node helper sanity: text nodes know when they are connected', () => {
  const n = t('x');
  const p = el('p', {}, n);
  assert.equal(n.isConnected, false);
  const env = makeEnv({ body: el('body', {}, p) });
  assert.equal(n.isConnected, true);
  p.remove();
  assert.equal(n.isConnected, false);
  void env;
});
