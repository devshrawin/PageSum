import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCiteToken, numberCitations, stripPartialCite, stripCitations,
  chunkResolver, pdfResolver, videoResolver,
} from '../extension/lib/citations.js';
import { parseInline, renderMarkdown } from '../extension/lib/markdown.js';

test('parseCiteToken: accepted forms', () => {
  assert.deepEqual(parseCiteToken('[c1]', 0), { ids: ['c1'], end: 4 });
  assert.deepEqual(parseCiteToken('x [c1, c22] y', 2), { ids: ['c1', 'c22'], end: 11 });
  assert.deepEqual(parseCiteToken('[ c1 ,c2 ]', 0).ids, ['c1', 'c2']);
  assert.deepEqual(parseCiteToken('[t2c3]', 0).ids, ['t2c3']);
  assert.deepEqual(parseCiteToken('[p4]', 0).ids, ['p4']);
  assert.deepEqual(parseCiteToken('[t=1:02:03]', 0).ids, ['t=1:02:03']);
  assert.deepEqual(parseCiteToken('[t=12:34]', 0).ids, ['t=12:34']);
  assert.deepEqual(parseCiteToken('[c1, p2, t=0:05]', 0).ids, ['c1', 'p2', 't=0:05']);
});

test('parseCiteToken: rejections', () => {
  for (const s of ['[c]', '[x1]', '[c1', '[c1,]', '[]', '[C1]', 'c1]', '[c1 c2]']) assert.equal(parseCiteToken(s, 0), null, s);
  assert.equal(parseCiteToken('[c1, c2, c3, c4, c5, c6, c7]', 0), null, '7 ids');
  assert.ok(parseCiteToken('[c1, c2, c3, c4, c5, c6]', 0), '6 ids ok');
  assert.equal(parseCiteToken('[c1](http://x)', 0), null, 'link stays a link');
  assert.equal(parseCiteToken('abc', 0), null);
});

test('numberCitations: order of first appearance, repeats keep their number', () => {
  const m = numberCitations([['c5'], ['c2', 'c5'], ['c9', 'c2']]);
  assert.deepEqual([...m.entries()], [['c5', 1], ['c2', 2], ['c9', 3]]);
});

test('stripPartialCite: only a trailing unfinished token', () => {
  assert.equal(stripPartialCite('Hello [c1'), 'Hello ');
  assert.equal(stripPartialCite('Hello [c'), 'Hello ');
  assert.equal(stripPartialCite('Hello [c12, c1'), 'Hello ');
  assert.equal(stripPartialCite('Hello [t=1:0'), 'Hello ');
  assert.equal(stripPartialCite('Hello [p'), 'Hello ');
  assert.equal(stripPartialCite('Hello ['), 'Hello ');
  assert.equal(stripPartialCite('Hello [c1] and more'), 'Hello [c1] and more');
  assert.equal(stripPartialCite('See [the docs] now'), 'See [the docs] now');
  assert.equal(stripPartialCite('mid [c1 text'), 'mid [c1 text');
  assert.equal(stripPartialCite('plain'), 'plain');
});

test('stripCitations: removes tokens and the space before them', () => {
  assert.equal(stripCitations('One fact [c1]. Two [c2, c3] and three [c4].'), 'One fact. Two and three.');
  assert.equal(stripCitations('a [c1] [c2] b'), 'a b');
  assert.equal(stripCitations('keep [link](http://x) and [c1](http://y)'), 'keep [link](http://x) and [c1](http://y)');
  assert.equal(stripCitations('keep [c999x] as is'), 'keep [c999x] as is');
  assert.equal(stripCitations('line one [c1]\nline two'), 'line one\nline two');
});

test('resolvers', () => {
  const r = chunkResolver([{ id: 'c1', text: 'alpha' }, { id: 'c2', text: 'beta' }]);
  assert.deepEqual(r('c1'), { text: 'alpha' });
  assert.equal(r('c3'), null);
  assert.equal(r('p1'), null);
  const p = pdfResolver(5);
  assert.ok(p('p5'));
  assert.equal(p('p6'), null);
  assert.equal(p('p0'), null);
  assert.ok(pdfResolver(null)('p999'));
  const v = videoResolver(100);
  assert.ok(v('t=1:40'));
  assert.ok(v('t=1:45'));
  assert.equal(v('t=1:46'), null);
  assert.ok(videoResolver(null)('t=1:02:03'));
});

// ---- markdown rendering ----

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
const findAll = (n, name, out = []) => { if (n.nodeName === name) out.push(n); (n.children || []).forEach((c) => findAll(c, name, out)); return out; };

test('parseInline: cite nodes only when opts.cite is set (v1 behaviour otherwise)', () => {
  assert.deepEqual(parseInline('a [c1] b'), [{ t: 'text', v: 'a [c1] b' }]);
  const n = parseInline('a [c1, c2] b', { cite: true });
  assert.deepEqual(n.map((x) => x.t), ['text', 'cite', 'text']);
  assert.deepEqual(n[1].ids, ['c1', 'c2']);
  // a cite-shaped link is still a link
  const l = parseInline('[c1](https://a.com)', { cite: true });
  assert.equal(l[0].t, 'link');
  // cites inside bold are found
  assert.equal(parseInline('**x [c1]**', { cite: true })[0].c[1].t, 'cite');
});

test('renderMarkdown: cite buttons are numbered, labelled and carry data-cite', () => {
  const resolve = chunkResolver([{ id: 'c12', text: 'The first passage text.' }, { id: 'c15', text: 'Second ' + 'x'.repeat(300) }]);
  const f = renderMarkdown('**TL;DR:** Fact one [c12]. Fact two [c15, c12].\n\n- bullet [c15]', fakeDoc(), { resolveCite: resolve });
  const sups = findAll(f, 'SUP');
  assert.equal(sups.length, 3);
  assert.equal(sups[0].attrs.class, 'cites');
  const buttons = findAll(f, 'BUTTON');
  assert.deepEqual(buttons.map((b) => b.textContent), ['1', '2', '1', '2']);
  assert.deepEqual(buttons.map((b) => b.attrs['data-cite']), ['c12', 'c15', 'c12', 'c15']);
  assert.equal(buttons[0].attrs.type, 'button');
  assert.equal(buttons[0].attrs.class, 'cite');
  assert.equal(buttons[0].attrs['aria-label'], 'Source 1: The first passage text.');
  assert.equal(buttons[1].attrs['aria-label'].length, 'Source 2: '.length + 60);
  assert.equal(buttons[1].attrs.title.length, 160);
});

test('renderMarkdown: unknown ids are removed; a node with none left disappears; numbering skips them', () => {
  const resolve = chunkResolver([{ id: 'c2', text: 'two' }]);
  const f = renderMarkdown('A [c99]. B [c2, c98]. C [c7].', fakeDoc(), { resolveCite: resolve });
  const buttons = findAll(f, 'BUTTON');
  assert.deepEqual(buttons.map((b) => b.attrs['data-cite']), ['c2']);
  assert.equal(buttons[0].textContent, '1');
  assert.equal(findAll(f, 'SUP').length, 1);
  const p = f.children[0];
  const text = p.children.filter((c) => c.nodeName === '#text').map((c) => c.data).join('');
  assert.ok(!text.includes('[c'), text);
});

test('renderMarkdown: without resolveCite the token is literal text', () => {
  const f = renderMarkdown('plain [c1] text', fakeDoc());
  assert.equal(findAll(f, 'BUTTON').length, 0);
  assert.equal(f.children[0].children[0].data, 'plain [c1] text');
});

test('renderMarkdown: no raw HTML from the model leaks through a cite label', () => {
  const resolve = chunkResolver([{ id: 'c1', text: '<img src=x onerror=alert(1)>' }]);
  const f = renderMarkdown('x [c1]', fakeDoc(), { resolveCite: resolve });
  const b = findAll(f, 'BUTTON')[0];
  assert.equal(b.textContent, '1'); // passage text only goes into attributes, as a plain string
  assert.equal(findAll(f, 'IMG').length, 0);
});
