import { test } from 'node:test';
import assert from 'node:assert/strict';
import { t, el, makeEnv, plain } from './helpers/fakedom.js';
import { findPassage, mapCollapsedOffset } from '../extension/lib/fuzzy.js';

const FILL = 'Filler sentence so that the page has enough readable text to count as a page. '.repeat(4);

function setup({ reduced = true, highlightApi = true } = {}) {
  const node = t('The committee agreed to publish the final report next month.');
  const p = el('p', {}, node);
  const body = el('body', {}, el('p', {}, FILL), p, el('p', {}, FILL + 'tail'));
  const env = makeEnv({ body, reduced, highlightApi }).load();
  const r = env.call('extract', { maxRawChars: 100000 });
  const blk = r.data.blocks.find((b) => b.text.startsWith('The committee'));
  return { env, node, p, body, blk };
}
const currentRange = (env) => [...env.highlights.values()][0].ranges[0];

test('exact path builds a range from the remembered text nodes and highlights it', () => {
  const { env, node, blk } = setup();
  const r = env.call('highlight', { localId: blk.localId, text: blk.text });
  assert.deepEqual(r, { ok: true, data: { found: 'exact' } });
  assert.deepEqual([...env.highlights.keys()], ['pagesum-cite']);
  const range = currentRange(env);
  assert.equal(range.startContainer, node);
  assert.equal(range.endContainer, node);
  assert.equal(range.startOffset, 0);
  assert.equal(range.endOffset, node.nodeValue.length);
});

test('exact path converts collapsed offsets back to raw offsets', () => {
  const node = t('  The committee\n   agreed to publish the report. ');
  const body = el('body', {}, el('p', {}, FILL), el('p', {}, node), el('p', {}, FILL + 'tail'));
  const env = makeEnv({ body }).load();
  const blk = env.call('extract', {}).data.blocks.find((b) => b.text.startsWith('The committee'));
  assert.equal(blk.text, 'The committee agreed to publish the report.');
  const r = env.call('highlight', { localId: blk.localId, text: blk.text });
  assert.equal(r.data.found, 'exact');
  const range = currentRange(env);
  assert.equal(range.startOffset, node.nodeValue.indexOf('The'));
  assert.equal(range.endOffset, node.nodeValue.indexOf('report.') + 'report.'.length);
});

test('a multi-node block spans from the first node start to the last node end', () => {
  const a = t('Alpha beta ');
  const b = t('gamma');
  const c = t(' delta epsilon.');
  const body = el('body', {}, el('p', {}, FILL), el('p', {}, a, el('b', {}, b), c), el('p', {}, FILL + 'tail'));
  const env = makeEnv({ body }).load();
  const blk = env.call('extract', {}).data.blocks.find((x) => x.text.startsWith('Alpha'));
  assert.equal(blk.text, 'Alpha beta gamma delta epsilon.');
  assert.equal(env.call('highlight', { localId: blk.localId, text: blk.text }).data.found, 'exact');
  const range = currentRange(env);
  assert.equal(range.startContainer, a);
  assert.equal(range.endContainer, c);
  assert.equal(range.endOffset, c.nodeValue.length);
});

test('a detached node falls back to the fuzzy search', () => {
  const { env, p, body, blk } = setup();
  p.remove(); // original node leaves the page...
  const moved = t('The committee agreed to publish the final report next month.');
  body.appendChild(el('div', {}, el('span', {}, moved))); // ...and the same text shows up elsewhere
  const r = env.call('highlight', { localId: blk.localId, text: blk.text });
  assert.equal(r.data.found, 'fuzzy');
  const range = currentRange(env);
  assert.equal(range.startContainer, moved);
  assert.equal(range.startOffset, 0);
  assert.equal(range.endOffset, moved.nodeValue.length);
});

test('a reused local id (text differs) does not highlight the wrong block', () => {
  const { env, blk } = setup();
  const r = env.call('highlight', { localId: blk.localId, text: 'Filler sentence so that the page has enough readable text' });
  assert.equal(r.data.found, 'fuzzy', 'verified against the passed text, not the stale id');
  assert.equal(currentRange(env).startContainer.nodeValue.startsWith('Filler'), true);
});

test('fuzzy tolerates a changed tail (prefix match)', () => {
  const { env, p, body, blk } = setup();
  p.remove();
  const edited = t('The committee agreed to publish the final report next month, after some edits were made.');
  body.appendChild(el('p', {}, edited));
  const r = env.call('highlight', { localId: blk.localId, text: blk.text });
  assert.equal(r.data.found, 'fuzzy');
  assert.equal(currentRange(env).startContainer, edited);
});

test('none when the passage is gone; nothing is highlighted', () => {
  const { env, p, blk } = setup();
  p.remove();
  const r = env.call('highlight', { localId: blk.localId, text: blk.text });
  assert.deepEqual(r, { ok: true, data: { found: 'none' } });
  assert.equal(env.highlights.size, 0);
  assert.equal(env.call('highlight', { localId: 'b999', text: '' }).data.found, 'none');
});

test('highlight scrolls the passage into view and flashes an outline', () => {
  const { env, p, blk } = setup({ reduced: true });
  env.call('highlight', { localId: blk.localId, text: blk.text });
  assert.deepEqual(plain(p.scrolled), [{ block: 'center', behavior: 'auto' }]);
  const flash = env.html.childNodes.find((n) => n.className === 'pagesum-ov-flash');
  assert.ok(flash, 'flash overlay appended to documentElement');
  assert.equal(flash.style.left, '7px');
  assert.equal(flash.style.top, '17px');
  assert.equal(flash.style.width, '126px');
  assert.equal(flash.style.height, '24px');
  env.call('clearHighlight', {});
  assert.equal(env.html.childNodes.includes(flash), false);
});

test('smooth scrolling unless the user prefers reduced motion; flash waits for the scroll', async () => {
  const { env, p, blk } = setup({ reduced: false });
  env.call('highlight', { localId: blk.localId, text: blk.text });
  assert.deepEqual(plain(p.scrolled), [{ block: 'center', behavior: 'smooth' }]);
  assert.equal(env.html.childNodes.some((n) => n.className === 'pagesum-ov-flash'), false);
  await new Promise((r) => setTimeout(r, 480));
  assert.equal(env.html.childNodes.some((n) => n.className === 'pagesum-ov-flash'), true);
  env.call('clearHighlight', {});
});

test('without the Custom Highlight API it still works (outline only)', () => {
  const { env, blk } = setup({ highlightApi: false });
  const r = env.call('highlight', { localId: blk.localId, text: blk.text });
  assert.equal(r.data.found, 'exact');
  assert.equal(env.html.childNodes.some((n) => n.className === 'pagesum-ov-flash'), true);
  assert.equal(env.call('clearHighlight', {}).ok, true);
});

test('a new highlight replaces the old one; clearHighlight empties CSS.highlights', () => {
  const { env, blk } = setup();
  env.call('highlight', { localId: blk.localId, text: blk.text });
  const first = currentRange(env);
  env.call('highlight', { localId: blk.localId, text: blk.text });
  assert.equal(env.highlights.size, 1);
  assert.notEqual(currentRange(env), first);
  assert.deepEqual(env.call('clearHighlight', {}), { ok: true, data: {} });
  assert.equal(env.highlights.size, 0);
});

test('Esc on the page clears an active highlight and tells the panel', () => {
  const { env, blk } = setup();
  env.call('highlight', { localId: blk.localId, text: blk.text });
  env.fire('keydown', { key: 'Enter' });
  assert.equal(env.highlights.size, 1);
  assert.equal(env.sent.length, 0);
  env.fire('keydown', { key: 'Escape' });
  assert.equal(env.highlights.size, 0);
  assert.equal(env.sent.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(env.sent[0])), { v: 2, src: 'pagesum-agent', type: 'agent/event', event: 'escape', data: {} });
  env.fire('keydown', { key: 'Escape' });
  assert.equal(env.sent.length, 1, 'nothing to clear, nothing sent');
});

test('navigation clears the highlight and emits "navigated" once, only if the URL changed', async () => {
  const { env, blk } = setup();
  env.call('highlight', { localId: blk.localId, text: blk.text });
  env.fire('popstate', {});
  await new Promise((r) => setTimeout(r, 620));
  assert.equal(env.sent.length, 0, 'same href: no event');
  assert.equal(env.highlights.size, 1);
  env.sandbox.location.href = 'https://example.com/next';
  env.fire('popstate', {});
  env.fire('hashchange', {});
  await new Promise((r) => setTimeout(r, 620));
  assert.equal(env.sent.length, 1, 'debounced to one event');
  assert.equal(env.sent[0].event, 'navigated');
  assert.equal(env.sent[0].data.href, 'https://example.com/next');
  assert.equal(env.highlights.size, 0);
});

test('findPassage in content/core.js behaves exactly like lib/fuzzy.js (10 fixtures)', () => {
  const env = makeEnv({ body: el('body', {}) }).load(['core.js']);
  const fixtures = [
    ['Intro. The quick brown fox jumps over the lazy dog. Outro.', 'the quick brown fox'],
    ['He said “it’s fine”  and left\nquickly.', 'said "it\'s fine" and left quickly'],
    ['The committee met on Tuesday and agreed to publish something else. After.', 'The committee met on Tuesday and agreed to publish the final report next month'],
    ['Something else. and then the budget was approved by a large majority of members. After.', 'Totally different opening and then the budget was approved by a large majority of members'],
    ['some text here', 'not present at all in the haystack text'],
    ['abc def', ''],
    ['hello world', 'zzz'],
    ['Emoji 😀 inside text and more words follow here', 'inside text and more words'],
    ['​Zero‍width chars⁠ here', 'zerowidth chars here'],
    ['Straße and ﬁnd the CAFÉ now', 'strasse and find the café'],
  ];
  for (const [hay, needle] of fixtures) {
    const a = findPassage(hay, needle);
    const b = JSON.parse(JSON.stringify(env.PS.util.findPassage(hay, needle)));
    assert.deepEqual(b, a ? JSON.parse(JSON.stringify(a)) : null, needle);
  }
  for (const [raw, idx] of [['a \t\n b  c', 3], ['   x', 1], ['a​b', 1], ['plain', 9], ['', 0]]) {
    assert.equal(env.PS.util.mapCollapsedOffset(raw, idx), mapCollapsedOffset(raw, idx));
  }
});

test('a table chunk highlights from its first to its last cell text (markdown text is not on the page)', () => {
  const first = t('Ann');
  const last = t('42');
  const tbl = el('table', {}, el('tr', {}, el('th', {}, 'Name'), el('th', {}, 'Age')), el('tr', {}, el('td', {}, first), el('td', {}, last)));
  const body = el('body', {}, el('p', {}, FILL), tbl, el('p', {}, FILL + 'tail'));
  const env = makeEnv({ body }).load();
  const blk = env.call('extract', { structured: true }).data.blocks.find((b) => b.kind === 'table');
  assert.ok(blk.text.includes('| Ann | 42 |'));
  const r = env.call('highlight', { localId: blk.localId, text: blk.text });
  assert.equal(r.data.found, 'exact');
  const range = currentRange(env);
  assert.equal(range.startContainer.nodeValue, 'Name');
  assert.equal(range.endContainer, last);
  assert.equal(range.endOffset, 2);
  tbl.remove();
  assert.equal(env.call('highlight', { localId: blk.localId, text: blk.text }).data.found, 'none');
});

test('the fuzzy fallback also searches open shadow roots', () => {
  const inShadow = t('A passage that lives inside the shadow root of a custom element on this page.');
  const host = el('div', { __shadow: [el('p', {}, inShadow)] });
  const body = el('body', {}, el('p', {}, FILL), host, el('p', {}, FILL + 'tail'));
  const env = makeEnv({ body }).load();
  env.call('extract', { structured: true });
  const r = env.call('highlight', { localId: 'nope', text: inShadow.nodeValue });
  assert.equal(r.data.found, 'fuzzy');
  assert.equal(currentRange(env).startContainer, inShadow);
});
