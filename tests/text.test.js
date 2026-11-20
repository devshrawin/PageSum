import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, truncateText, fnv1a, normalizeUrlKey, isRestrictedUrl, pageKind } from '../extension/lib/text.js';

test('cleanText: NBSP and zero-width', () => {
  assert.equal(cleanText('a\u00A0b\u200Bc\uFEFFd'), 'a bcd');
});
test('cleanText: CRLF and space collapse', () => {
  assert.equal(cleanText('a   b\t\tc\r\nd \r e'), 'a b c\nd\ne');
});
test('cleanText: blank-line collapse', () => {
  assert.equal(cleanText('a\n\n\n\n\nb'), 'a\n\nb');
});
test('cleanText: consecutive duplicate lines dropped', () => {
  assert.equal(cleanText('Menu\nMenu\nBody\nMenu'), 'Menu\nBody\nMenu');
});
test('cleanText: bullet-only and pipe-only lines dropped', () => {
  assert.equal(cleanText('a\n-\n |  | \n- item\n|\nb'), 'a\n- item\nb');
});

test('truncateText: under limit unchanged', () => {
  const r = truncateText('hello', 10);
  assert.deepEqual(r, { text: 'hello', truncated: false, originalLength: 5 });
});
test('truncateText: cuts at last paragraph break', () => {
  const t = 'aaaa aaaa\n\nbbbb bbbb\n\ncccc cccc';
  const r = truncateText(t, 22);
  assert.equal(r.text, 'aaaa aaaa\n\nbbbb bbbb');
  assert.equal(r.truncated, true);
  assert.equal(r.originalLength, t.length);
});
test('truncateText: falls back to whitespace when break is before 80%', () => {
  const t = 'aa\n\n' + 'word '.repeat(30);
  const r = truncateText(t, 50);
  assert.ok(r.truncated);
  assert.ok(r.text.length <= 50 && r.text.length > 40);
  assert.ok(r.text.endsWith('word'));
});
test('truncateText: hard cut when no whitespace', () => {
  const r = truncateText('x'.repeat(100), 30);
  assert.equal(r.text.length, 30);
});

test('fnv1a known values', () => {
  assert.equal(fnv1a(''), '811c9dc5');
  assert.equal(fnv1a('a'), 'e40c292c');
});

test('normalizeUrlKey', () => {
  assert.equal(normalizeUrlKey('https://a.com/p?utm_source=x&id=2&fbclid=z'), 'https://a.com/p?id=2');
  assert.equal(normalizeUrlKey('https://a.com/p#section'), 'https://a.com/p');
  assert.equal(normalizeUrlKey('https://a.com/app#/route/1'), 'https://a.com/app#/route/1');
  assert.equal(normalizeUrlKey('https://a.com/app#!/x'), 'https://a.com/app#!/x');
  assert.equal(normalizeUrlKey('https://a.com/p/'), 'https://a.com/p');
  assert.equal(normalizeUrlKey('https://a.com/'), 'https://a.com/');
  assert.equal(normalizeUrlKey('https://a.com/?gclid=1&mc_cid=2&mc_eid=3&ref_src=4'), 'https://a.com/');
});

test('isRestrictedUrl: every row', () => {
  for (const u of ['chrome://extensions', 'chrome-extension://abc/x.html', 'edge://settings', 'about:blank',
    'devtools://devtools/x', 'view-source:https://a.com', 'chrome-search://local-ntp', 'chrome-untrusted://x',
    'data:text/html,hi', 'blob:https://a.com/1', 'javascript:alert(1)', '']) {
    const r = isRestrictedUrl(u);
    assert.equal(r.ok, false, u);
    assert.equal(r.kind, 'restricted', u);
    assert.equal(r.reason, "Chrome doesn't let extensions read this page.");
  }
  assert.deepEqual(isRestrictedUrl('https://chromewebstore.google.com/detail/x'), { ok: false, kind: 'webstore', reason: "Chrome doesn't let extensions read the Web Store." });
  assert.equal(isRestrictedUrl('https://chrome.google.com/webstore/detail/x').kind, 'webstore');
  assert.equal(isRestrictedUrl('https://chrome.google.com/other').ok, true);
  // v2: a .pdf path is no longer restricted (PDF is supported); only a blob: PDF gets the special message.
  assert.deepEqual(isRestrictedUrl('https://a.com/Paper.PDF'), { ok: true });
  const blobPdf = isRestrictedUrl('blob:https://a.com/1', { title: 'paper.pdf' });
  assert.equal(blobPdf.ok, false);
  assert.equal(blobPdf.kind, 'pdf');
  assert.match(blobPdf.reason, /temporary in-page file/);
  assert.equal(isRestrictedUrl('blob:https://a.com/1', { title: 'Some page' }).kind, 'restricted');
  const f = isRestrictedUrl('file:///C:/x/test.html');
  assert.equal(f.ok, true);
  assert.equal(f.kind, 'file');
  assert.match(f.reason, /Allow access to file URLs/);
  assert.deepEqual(isRestrictedUrl('https://example.com/a'), { ok: true });
});

test('pageKind', () => {
  assert.equal(pageKind('https://www.youtube.com/watch?v=1'), 'youtube');
  assert.equal(pageKind('https://m.youtube.com/shorts/abc'), 'youtube');
  assert.equal(pageKind('https://youtube.com/watch?v=1'), 'youtube');
  assert.equal(pageKind('https://www.youtube.com/'), 'normal');
  assert.equal(pageKind('https://www.youtube.com/@chan'), 'normal');
  assert.equal(pageKind('https://example.com/watch'), 'normal');
  assert.equal(pageKind('https://example.com/a/Paper.PDF'), 'pdf');
  assert.equal(pageKind('https://example.com/a.pdf?x=1'), 'pdf');
  assert.equal(pageKind('https://example.com/a.pdf.html'), 'normal');
});
