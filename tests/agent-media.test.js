// content/media.js against the fake DOM: video info and seek, transcript panel, self PDF fetch, visual hints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { el, makeEnv } from './helpers/fakedom.js';
import { bytesToBase64 } from '../extension/lib/pdf.js';

const FILES = ['core.js', 'media.js'];
const mk = (body, over = {}) => makeEnv({ body, ...over }).load(FILES);
const video = (props = {}) => el('video', { __props: props });

test('videoInfo: null without a player; duration/currentTime/title with one; NaN and Infinity become 0', () => {
  assert.deepEqual(mk(el('body', {})).call('videoInfo', {}), { ok: true, data: null });
  const v = video({ duration: 754.5, currentTime: 12.25 });
  const env = mk(el('body', {}, v), { title: 'My video - YouTube' });
  assert.deepEqual(env.call('videoInfo', {}).data, { duration: 754.5, currentTime: 12.25, title: 'My video - YouTube' });
  assert.equal(mk(el('body', {}, video({ duration: NaN, currentTime: 0 }))).call('videoInfo', {}).data.duration, 0);
  assert.equal(mk(el('body', {}, video({ duration: Infinity, currentTime: 0 }))).call('videoInfo', {}).data.duration, 0);
});

test('seek sets the player time, clamped to 0..86400 and to the duration', () => {
  const v = video({ duration: 600, currentTime: 0 });
  const env = mk(el('body', {}, v));
  assert.deepEqual(env.call('seek', { seconds: 125 }), { ok: true, data: {} });
  assert.equal(v.currentTime, 125);
  env.call('seek', { seconds: 99999 });
  assert.equal(v.currentTime, 600, 'clamped to the duration');
  env.call('seek', { seconds: -5 });
  assert.equal(v.currentTime, 0);
  env.call('seek', { seconds: NaN });
  assert.equal(v.currentTime, 0);
  env.call('seek', { seconds: 'abc' });
  assert.equal(v.currentTime, 0);
  env.call('seek', {});
  assert.equal(v.currentTime, 0);
  const live = video({ duration: Infinity, currentTime: 0 });
  mk(el('body', {}, live)).call('seek', { seconds: 1e9 });
  assert.equal(live.currentTime, 86400, 'unknown duration: only the 86400 cap applies');
  assert.deepEqual(mk(el('body', {})).call('seek', { seconds: 5 }), { ok: true, data: {} }, 'no player: nothing happens');
});

test('readTranscriptPanel reads timestamp and text rows; rows missing either are skipped', () => {
  const row = (t, text) => el('ytd-transcript-segment-renderer', {},
    el('div', { class: 'segment-timestamp' }, t), el('yt-formatted-string', { class: 'segment-text' }, text));
  const body = el('body', {}, row('0:05', '  Hello   there '), row('1:02:03', 'Late'), row('', 'no time'),
    el('ytd-transcript-segment-renderer', {}, el('div', { class: 'segment-timestamp' }, '0:09')));
  const r = mk(body).call('readTranscriptPanel', {});
  assert.deepEqual(r.data, { segments: [{ t: '0:05', text: 'Hello there' }, { t: '1:02:03', text: 'Late' }] });
  assert.deepEqual(mk(el('body', {})).call('readTranscriptPanel', {}).data, { segments: [] });
});

function fakeFetch(bytes, { ok = true, status = 200, length } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return {
      ok, status,
      headers: { get: (n) => (n.toLowerCase() === 'content-length' && length !== undefined ? String(length) : null) },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };
  fn.calls = calls;
  return fn;
}

test('fetchSelfPdf: same-origin fetch of location.href, base64 in slices, async result', async () => {
  const bytes = new Uint8Array(70000).map((_, i) => i % 251);
  const env = mk(el('body', {}), { href: 'https://a.com/paper.pdf' });
  env.sandbox.btoa = btoa;
  env.sandbox.fetch = fakeFetch(bytes);
  const r = await env.callAsync('fetchSelfPdf', { maxBytes: 1024 * 1024 });
  assert.equal(r.ok, true);
  assert.equal(r.data.bytes, 70000);
  assert.equal(r.data.base64, bytesToBase64(bytes));
  assert.equal(env.sandbox.fetch.calls[0].url, 'https://a.com/paper.pdf');
  assert.equal(env.sandbox.fetch.calls[0].init.credentials, 'same-origin');
});

test('fetchSelfPdf: too large by header or by size, and http errors come back as { ok: false }', async () => {
  const bytes = new Uint8Array(3000);
  let env = mk(el('body', {}));
  env.sandbox.btoa = btoa;
  env.sandbox.fetch = fakeFetch(bytes, { length: 999999 });
  assert.deepEqual((await env.callAsync('fetchSelfPdf', { maxBytes: 1000 })).data, { tooLarge: true, bytes: 999999 });
  env = mk(el('body', {}));
  env.sandbox.fetch = fakeFetch(bytes);
  assert.deepEqual((await env.callAsync('fetchSelfPdf', { maxBytes: 1000 })).data, { tooLarge: true, bytes: 3000 });
  env = mk(el('body', {}));
  env.sandbox.fetch = fakeFetch(bytes, { ok: false, status: 403 });
  const bad = await env.callAsync('fetchSelfPdf', {});
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'exception');
  assert.match(bad.error.message, /403/);
});

test('visualHints: visible canvas and image areas clipped to the viewport, text length, tiny text share', () => {
  const rect = (left, top, width, height) => ({ __rect: { left, top, width, height } });
  const body = el('body', {},
    el('canvas', rect(0, 0, 512, 384)),                       // 196608
    el('canvas', { ...rect(0, 0, 999, 999), __invisible: true }),
    el('img', rect(900, 700, 300, 300)),                      // clipped to 124 x 68 = 8432
    el('video', rect(-100, -100, 200, 200)),                  // clipped to 100 x 100 = 10000
    el('p', {}, 'tiny one'), el('p', {}, 'tiny two'), el('p', {}, 'normal text'), el('p', {}, 'normal again'));
  const env = mk(body);
  env.sandbox.getComputedStyle = (p) => ({ fontSize: /tiny/.test(p.textContent) ? '8px' : '14px' });
  const h = env.call('visualHints', {}).data;
  assert.equal(h.viewportArea, 1024 * 768);
  assert.equal(h.canvasArea, 196608);
  assert.equal(h.imgArea, 8432 + 10000);
  assert.equal(h.textChars, 'tiny onetiny twonormal textnormal again'.length);
  assert.equal(h.tinyTextRatio, 0.5);
});

test('visualHints on an empty page is all zeros', () => {
  const h = mk(el('body', {})).call('visualHints', {}).data;
  assert.deepEqual([h.textChars, h.canvasArea, h.imgArea, h.tinyTextRatio], [0, 0, 0, 0]);
});

test('media.js is injected once: handlers are registered a single time', () => {
  const env = mk(el('body', {}));
  const keys = Object.keys(env.PS.handlers).sort();
  assert.deepEqual(keys, ['fetchSelfPdf', 'ping', 'readTranscriptPanel', 'seek', 'videoInfo', 'visualHints']);
  env.load(FILES);
  assert.deepEqual(Object.keys(env.PS.handlers).sort(), keys);
});
