// Runs extractPage against a tiny fake DOM, inside a vm context that has no module scope.
// That also proves the function is self-contained (it is serialised by executeScript).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { extractPage } from '../extension/lib/extract.js';

function t(v) { return { nodeType: 3, nodeValue: v, parentNode: null }; }
function el(tag, attrs = {}, ...kids) {
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    attrs,
    id: attrs.id || '',
    parentNode: null,
    childNodes: kids.map((k) => (typeof k === 'string' ? t(k) : k)),
    getAttribute(n) { return n in attrs ? String(attrs[n]) : null; },
    hasAttribute(n) { return n in attrs; },
    get textContent() {
      return this.childNodes.map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join('');
    },
    get innerText() { return this.textContent; },
    closest(sel) {
      for (let n = this; n; n = n.parentNode) if (n.nodeType === 1 && n.tagName === sel.toUpperCase()) return n;
      return null;
    },
    checkVisibility() { return !attrs.__invisible; },
  };
  for (const c of node.childNodes) c.parentNode = node;
  return node;
}
function all(root, tag) {
  const out = [];
  (function w(n) { if (n.nodeType !== 1) return; if (n.tagName === tag.toUpperCase()) out.push(n); n.childNodes.forEach(w); })(root);
  return out;
}

function run(body, { selection = '', title = 'Doc title', opts = {} } = {}) {
  const document = {
    title,
    contentType: 'text/html',
    documentElement: { lang: 'en' },
    body,
    querySelectorAll(sel) { return sel === 'article' ? all(body, 'article') : []; },
    querySelector(sel) {
      if (sel === 'main') return all(body, 'main')[0] || null;
      if (sel === 'h1') return all(body, 'h1')[0] || null;
      if (sel === '[role="main"]') return null;
      return null;
    },
  };
  const sandbox = { window: { getSelection: () => selection }, document, location: { href: 'https://example.com/a' } };
  const fn = vm.runInNewContext(`(${extractPage.toString()})`, sandbox);
  return fn({ ignoreSelection: false, maxRawChars: 100000, ...opts });
}

const para = (n) => 'Sentence number one is here. '.repeat(n);

test('prefers the single qualifying article, drops nav/footer/aside/hidden/noise', () => {
  const body = el('body', {},
    el('nav', {}, 'NAVIGATION LINKS'),
    el('div', { class: 'cookie-banner' }, 'We use cookies'),
    el('article', {},
      el('header', {}, el('h1', {}, 'The Headline')),
      el('p', {}, para(20)),
      el('div', { __invisible: true }, 'HIDDEN TEXT'),
      el('div', { 'aria-hidden': 'true' }, 'ARIA HIDDEN'),
      el('ul', {}, el('li', {}, 'first item'), el('li', {}, 'second item')),
      el('pre', {}, 'let x = 1;\nlet y = 2;'),
      el('script', {}, 'alert(1)'),
    ),
    el('aside', {}, 'SIDEBAR'),
    el('footer', {}, 'FOOTER LINKS'),
  );
  const r = run(body);
  assert.equal(r.source, 'article');
  assert.equal(r.title, 'Doc title');
  assert.equal(r.lang, 'en');
  assert.ok(r.text.includes('\n\n## The Headline\n\n'), 'header inside article is kept');
  assert.ok(r.text.includes('\n- first item'));
  assert.ok(r.text.includes('```\nlet x = 1;\nlet y = 2;\n```'));
  for (const bad of ['NAVIGATION', 'cookies', 'HIDDEN TEXT', 'ARIA HIDDEN', 'SIDEBAR', 'FOOTER', 'alert(1)']) {
    assert.ok(!r.text.includes(bad), bad);
  }
});

test('selection of 40+ chars wins unless ignored', () => {
  const sel = 'This is a user selected paragraph of text, long enough.';
  const body = el('body', {}, el('p', {}, para(30)));
  const r = run(body, { selection: `  ${sel}  ` });
  assert.equal(r.source, 'selection');
  assert.equal(r.text, sel);
  assert.equal(r.selectionLength, sel.length);
  const r2 = run(body, { selection: sel, opts: { ignoreSelection: true } });
  assert.equal(r2.source, 'body');
  assert.equal(r2.selectionLength, sel.length);
  const r3 = run(body, { selection: 'short' });
  assert.equal(r3.source, 'body');
});

test('several articles: longest only if 2x the second, else body', () => {
  const a1 = el('article', {}, el('p', {}, para(40)));
  const a2 = el('article', {}, el('p', {}, para(40)));
  assert.equal(run(el('body', {}, a1, a2)).source, 'body');
  const big = el('article', {}, el('p', {}, para(100)));
  const small = el('article', {}, el('p', {}, para(20)));
  assert.equal(run(el('body', {}, big, small)).source, 'article');
});

test('main is used when no article; falls back to body when main is thin', () => {
  const body = el('body', {}, el('div', {}, 'outside main'), el('main', {}, el('p', {}, para(30))));
  assert.equal(run(body).source, 'main');
  const thin = el('body', {}, el('p', {}, para(30)), el('main', {}, 'tiny'));
  assert.equal(run(thin).source, 'body');
});

test('short result inside a root retries with body', () => {
  const body = el('body', {}, el('p', {}, para(30)),
    el('article', {}, el('p', {}, 'x'.repeat(10)), el('div', { __invisible: true }, para(40))));
  // article innerText counts hidden text in the fake, so it qualifies, but its visible text is < 200
  const r = run(body);
  assert.equal(r.source, 'body');
  assert.ok(r.text.includes('Sentence number one'));
});

test('title falls back to h1; maxRawChars stops the walk', () => {
  const body = el('body', {}, el('h1', {}, 'H1 Title'), el('p', {}, para(50)));
  const r = run(body, { title: '  ' });
  assert.equal(r.title, 'H1 Title');
  const big = el('body', {}, ...Array.from({ length: 200 }, () => el('p', {}, para(5))));
  const r2 = run(big, { opts: { maxRawChars: 2000 } });
  assert.ok(r2.text.length < 2000 + 400);
});
