import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSseParser } from '../extension/lib/sse.js';

function collect() {
  const got = [];
  const p = createSseParser((d) => got.push(d));
  return { got, p };
}

test('single event', () => {
  const { got, p } = collect();
  p.push('data: {"a":1}\n\n');
  assert.deepEqual(got, ['{"a":1}']);
});

test('multiple events in one chunk', () => {
  const { got, p } = collect();
  p.push('data: one\n\ndata: two\n\ndata:three\n\n');
  assert.deepEqual(got, ['one', 'two', 'three']);
});

test('one event split across 3 chunks at arbitrary positions', () => {
  const { got, p } = collect();
  const s = 'data: {"text":"hello world"}\n\n';
  p.push(s.slice(0, 5));
  p.push(s.slice(5, 17));
  assert.deepEqual(got, []);
  p.push(s.slice(17));
  assert.deepEqual(got, ['{"text":"hello world"}']);
});

test('every split position works, including inside CRLF', () => {
  const s = 'data: a\r\n\r\ndata: b\r\n\r\n';
  for (let i = 0; i <= s.length; i++) {
    const { got, p } = collect();
    p.push(s.slice(0, i));
    p.push(s.slice(i));
    assert.deepEqual(got, ['a', 'b'], `split at ${i}`);
  }
});

test('CRLF separators', () => {
  const { got, p } = collect();
  p.push('data: x\r\n\r\ndata: y\r\n\r\n');
  assert.deepEqual(got, ['x', 'y']);
});

test('multi-line data joined with newline', () => {
  const { got, p } = collect();
  p.push('data: line1\ndata: line2\n\n');
  assert.deepEqual(got, ['line1\nline2']);
});

test('comments and other fields ignored', () => {
  const { got, p } = collect();
  p.push(': keepalive\n\nevent: message\nid: 7\nretry: 100\ndata: ok\n\n');
  assert.deepEqual(got, ['ok']);
});

test('end() flushes unterminated final event', () => {
  const { got, p } = collect();
  p.push('data: first\n\ndata: last');
  assert.deepEqual(got, ['first']);
  p.end();
  assert.deepEqual(got, ['first', 'last']);
});

test('end() with nothing buffered emits nothing', () => {
  const { got, p } = collect();
  p.push('data: a\n\n');
  p.end();
  assert.deepEqual(got, ['a']);
});
