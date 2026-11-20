import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, parseInline, renderMarkdown } from '../extension/lib/markdown.js';

test('headings map to levels 3 and 4', () => {
  const b = parseMarkdown('# A\n## B\n### C\n###### D');
  assert.deepEqual(b.map((x) => x.level), [3, 3, 4, 4]);
  assert.deepEqual(b[0].c, [{ t: 'text', v: 'A' }]);
});

test('ul and ol merging', () => {
  const b = parseMarkdown('- a\n* b\n+ c\n\n1. x\n2) y');
  assert.equal(b.length, 2);
  assert.equal(b[0].t, 'ul');
  assert.equal(b[0].items.length, 3);
  assert.equal(b[1].t, 'ol');
  assert.equal(b[1].items.length, 2);
});

test('indented items flatten into one list', () => {
  const b = parseMarkdown('- a\n  - b\n- c');
  assert.equal(b.length, 1);
  assert.equal(b[0].items.length, 3);
});

test('paragraph lines join with a space; blank line splits', () => {
  const b = parseMarkdown('one\ntwo\n\nthree');
  assert.equal(b.length, 2);
  assert.deepEqual(b[0].c, [{ t: 'text', v: 'one two' }]);
});

test('fences, including unclosed', () => {
  const b = parseMarkdown('```js\nconst a = 1;\n\nb\n```\nafter');
  assert.deepEqual(b[0], { t: 'pre', v: 'const a = 1;\n\nb' });
  assert.equal(b[1].t, 'p');
  const u = parseMarkdown('text\n```\nopen forever\nstill');
  assert.deepEqual(u[1], { t: 'pre', v: 'open forever\nstill' });
});

test('bold, italic, code', () => {
  assert.deepEqual(parseInline('a **b** *c* `d` __e__ _f_'), [
    { t: 'text', v: 'a ' }, { t: 'strong', c: [{ t: 'text', v: 'b' }] }, { t: 'text', v: ' ' },
    { t: 'em', c: [{ t: 'text', v: 'c' }] }, { t: 'text', v: ' ' }, { t: 'code', v: 'd' }, { t: 'text', v: ' ' },
    { t: 'strong', c: [{ t: 'text', v: 'e' }] }, { t: 'text', v: ' ' }, { t: 'em', c: [{ t: 'text', v: 'f' }] },
  ]);
});

test('no markup inside code spans', () => {
  assert.deepEqual(parseInline('`**x**`'), [{ t: 'code', v: '**x**' }]);
});

test('underscore only at word boundaries', () => {
  assert.deepEqual(parseInline('snake_case_name'), [{ t: 'text', v: 'snake_case_name' }]);
});

test('unclosed markers are literal', () => {
  assert.deepEqual(parseInline('**bold start'), [{ t: 'text', v: '**bold start' }]);
  assert.deepEqual(parseInline('a *b'), [{ t: 'text', v: 'a *b' }]);
  assert.deepEqual(parseInline('`code'), [{ t: 'text', v: '`code' }]);
  assert.deepEqual(parseInline('[label](https://a.com'), [{ t: 'text', v: '[label](https://a.com' }]);
});

test('XSS: raw HTML stays literal text', () => {
  const s = '<img src=x onerror=alert(1)>';
  assert.deepEqual(parseInline(s), [{ t: 'text', v: s }]);
  assert.deepEqual(parseMarkdown(s), [{ t: 'p', c: [{ t: 'text', v: s }] }]);
});

test('XSS: javascript: and data: links become text', () => {
  assert.deepEqual(parseInline('[x](javascript:alert(1))'), [{ t: 'text', v: 'x' }]);
  assert.deepEqual(parseInline('[x](data:text/html,<script>alert(1)</script>)'), [{ t: 'text', v: 'x' }]);
  assert.deepEqual(parseInline('[x](JaVaScRiPt:alert(1))'), [{ t: 'text', v: 'x' }]);
  assert.deepEqual(parseInline('[x](/relative)'), [{ t: 'text', v: 'x' }]);
});

test('https links kept', () => {
  assert.deepEqual(parseInline('[x](https://a.com)'), [{ t: 'link', href: 'https://a.com/', c: [{ t: 'text', v: 'x' }] }]);
  const w = parseInline('[w](https://en.wikipedia.org/wiki/A_(b))');
  assert.equal(w[0].href, 'https://en.wikipedia.org/wiki/A_(b)');
});

// Tiny DOM stub: proves renderMarkdown only uses createElement/createTextNode/textContent/setAttribute.
function fakeDoc() {
  const mk = (name) => ({
    nodeName: name, children: [], attrs: {}, _text: '',
    appendChild(c) { this.children.push(c); return c; },
    setAttribute(k, v) { this.attrs[k] = v; },
    set textContent(v) { this._text = v; },
    get textContent() { return this._text; },
  });
  return {
    createElement: (n) => mk(n.toUpperCase()),
    createTextNode: (t) => ({ nodeName: '#text', data: t }),
    createDocumentFragment: () => mk('#fragment'),
  };
}

test('renderMarkdown builds the expected tree', () => {
  const f = renderMarkdown('## T\n\n**a** [l](https://a.com)\n\n- i\n\n```\ncode\n```', fakeDoc());
  assert.deepEqual(f.children.map((c) => c.nodeName), ['H3', 'P', 'UL', 'PRE']);
  const p = f.children[1];
  assert.equal(p.children[0].nodeName, 'STRONG');
  const a = p.children[2];
  assert.equal(a.nodeName, 'A');
  assert.equal(a.attrs.href, 'https://a.com/');
  assert.equal(a.attrs.target, '_blank');
  assert.equal(a.attrs.rel, 'noopener noreferrer');
  assert.equal(f.children[3].children[0].textContent, 'code');
});
