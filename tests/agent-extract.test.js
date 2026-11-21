// Runs content/core.js + content/extract.js against a fake DOM inside a vm context (no module scope).
// This replaces the v1 extract.test.js: the v1 cases are kept, adapted to the block output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { t, el, makeEnv, plain } from './helpers/fakedom.js';

function run(body, { selection = null, title = 'Doc title', opts = {}, head = null } = {}) {
  const env = makeEnv({ body, title, selection, head }).load(['core.js', 'extract.js']);
  const r = env.call('extract', { ignoreSelection: false, maxRawChars: 100000, ...opts });
  assert.equal(r.ok, true, JSON.stringify(r));
  return { ...r.data, env };
}
const texts = (r) => r.blocks.map((b) => b.text);
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
  const head = r.blocks.find((b) => b.text === 'The Headline');
  assert.ok(head, 'header inside article is kept');
  assert.equal(head.kind, 'h');
  assert.equal(head.level, 1);
  const li = r.blocks.filter((b) => b.kind === 'li');
  assert.deepEqual(li.map((b) => b.text), ['first item', 'second item']);
  const pre = r.blocks.find((b) => b.kind === 'pre');
  assert.equal(pre.text, 'let x = 1;\nlet y = 2;');
  const all = texts(r).join('\n');
  for (const bad of ['NAVIGATION', 'cookies', 'HIDDEN TEXT', 'ARIA HIDDEN', 'SIDEBAR', 'FOOTER', 'alert(1)']) {
    assert.ok(!all.includes(bad), bad);
  }
});

test('selection mode: the selected range wins unless ignored, and clips to the range', () => {
  const sel = 'This is a user selected paragraph of text, long enough.';
  const node = t(`AAA ${sel} ZZZ`);
  const other = el('p', {}, para(30));
  const body = el('body', {}, el('p', {}, node), other);
  const selection = { startNode: node, startOffset: 4, endNode: node, endOffset: 4 + sel.length, text: `  ${sel}  ` };
  const r = run(body, { selection });
  assert.equal(r.source, 'selection');
  assert.deepEqual(texts(r), [sel]);
  assert.equal(r.selectionLength, sel.length);
  const r2 = run(body, { selection, opts: { ignoreSelection: true } });
  assert.equal(r2.source, 'body');
  assert.equal(r2.selectionLength, sel.length);
  const r3 = run(body, { selection: { ...selection, text: 'short' } });
  assert.equal(r3.source, 'body');
});

test('selection across two paragraphs gives two clipped blocks that map back to their nodes', () => {
  const n1 = t('First paragraph starts here and goes on for a while.');
  const n2 = t('Second paragraph ends here and then stops.');
  const body = el('body', {}, el('div', {}, el('p', {}, n1), el('p', {}, n2)));
  const text = 'paragraph starts here and goes on for a while. Second paragraph ends';
  const selection = { startNode: n1, startOffset: 6, endNode: n2, endOffset: 'Second paragraph ends'.length, text };
  const r = run(body, { selection });
  assert.equal(r.source, 'selection');
  assert.deepEqual(texts(r), ['paragraph starts here and goes on for a while.', 'Second paragraph ends']);
  const blk = r.env.PS.store.blocks.get(r.blocks[0].localId);
  assert.equal(blk.segments.length, 1);
  assert.equal(blk.segments[0].node, n1);
  assert.equal(blk.segments[0].skip, 6);
});

test('selection without a usable range falls back to one block with no node map', () => {
  const body = el('body', {}, el('p', {}, para(30)));
  const env = makeEnv({ body }).load(['core.js', 'extract.js']);
  env.sandbox.getSelection = () => ({ toString: () => 'x'.repeat(10) + ' selected text that is long enough to count here', rangeCount: 0 });
  const r = env.call('extract', { maxRawChars: 100000 });
  assert.equal(r.data.source, 'selection');
  assert.equal(r.data.blocks.length, 1);
  assert.deepEqual(plain(env.PS.store.blocks.get('b0').segments), []);
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
  // the article's innerText counts the hidden text in the fake, so it qualifies, but its visible text is < 200
  const r = run(body);
  assert.equal(r.source, 'body');
  assert.ok(texts(r).join(' ').includes('Sentence number one'));
});

test('title falls back to h1; maxRawChars stops the walk and sets truncatedRaw', () => {
  const body = el('body', {}, el('h1', {}, 'H1 Title'), el('p', {}, para(50)));
  const r = run(body, { title: '  ' });
  assert.equal(r.title, 'H1 Title');
  const big = el('body', {}, ...Array.from({ length: 200 }, (_, i) => el('p', {}, `Paragraph ${i}. ` + para(5))));
  const r2 = run(big, { opts: { maxRawChars: 2000 } });
  assert.equal(r2.truncatedRaw, true);
  const sum = r2.blocks.reduce((n, b) => n + b.text.length, 0);
  assert.ok(sum < 2000 + 400, `sum=${sum}`);
  assert.equal(run(body).truncatedRaw, false);
});

test('blocks per p/h/li/quote/caption/table row, with kinds and levels', () => {
  const body = el('body', {},
    el('h2', {}, 'Section'),
    el('p', {}, para(10)),
    el('blockquote', {}, el('p', {}, 'A quoted line that is long enough to matter.')),
    el('ul', {}, el('li', {}, el('p', {}, 'Nested paragraph in list item'))),
    el('figure', {}, el('figcaption', {}, 'Figure caption text')),
    el('table', {}, el('tr', {}, el('th', {}, 'Name'), el('th', {}, 'Age')), el('tr', {}, el('td', {}, 'Ann'), el('td', {}, '31'))),
  );
  const r = run(body);
  const by = (k) => r.blocks.filter((b) => b.kind === k).map((b) => b.text);
  assert.deepEqual(r.blocks.find((b) => b.kind === 'h'), { localId: 'b0', kind: 'h', level: 2, text: 'Section' });
  assert.deepEqual(by('quote'), ['A quoted line that is long enough to matter.']);
  assert.deepEqual(by('li'), ['Nested paragraph in list item']);
  assert.deepEqual(by('caption'), ['Figure caption text']);
  assert.deepEqual(by('table'), ['Name | Age', 'Ann | 31']);
  assert.ok(by('p')[0].startsWith('Sentence number one'));
  r.blocks.forEach((b, i) => assert.equal(b.localId, 'b' + i, 'sequential local ids'));
});

test('inline elements stay in one block and whitespace collapses across nodes', () => {
  const body = el('body', {}, el('p', {}, '  Hello ', el('b', {}, ' brave  '), el('i', {}, 'new\n\n'), ' world  today​!  '), el('p', {}, para(10)));
  const r = run(body);
  assert.equal(r.blocks[0].text, 'Hello brave new world today!');
});

test('a 1,500-char paragraph is split into pieces of at most 600 chars at sentence ends', () => {
  const long = Array.from({ length: 22 }, (_, i) => `Sentence ${i} is a reasonably long line about nothing in particular at all.`).join(' ');
  const r = run(el('body', {}, el('p', {}, long)));
  assert.ok(r.blocks.length >= 3, `pieces=${r.blocks.length}`);
  for (const b of r.blocks) {
    assert.ok(b.text.length <= 600, `len=${b.text.length}`);
    assert.ok(/[.!?]$/.test(b.text), `ends at a sentence boundary: ${b.text.slice(-10)}`);
  }
  assert.equal(r.blocks.map((b) => b.text).join(' '), long.trim());
});

test('hard cut at 600 when there is no sentence boundary; pieces keep a segment each', () => {
  const word = Array.from({ length: 150 }, (_, i) => i.toString(36).padStart(10, 'q')).join('');
  const r = run(el('body', {}, el('p', {}, word)));
  assert.deepEqual(r.blocks.map((b) => b.text.length), [600, 600, 300]);
  assert.equal(r.blocks.map((b) => b.text).join(''), word);
  r.blocks.forEach((b) => assert.equal(r.env.PS.store.blocks.get(b.localId).segments.length, 1));
});

test('segments record the node, offset in the block and collapsed skip', () => {
  const n1 = t('  Hello ');
  const n2 = t(' world');
  const n3 = t('!');
  const r = run(el('body', {}, el('p', {}, n1, el('b', {}, n2), n3), el('p', {}, para(10))));
  const blk = r.env.PS.store.blocks.get('b0');
  assert.equal(blk.text, 'Hello world!');
  const s = blk.segments.map((x) => ({ same: x.node, cStart: x.cStart, cLen: x.cLen, skip: x.skip }));
  assert.equal(s[0].same, n1);
  assert.deepEqual([s[0].cStart, s[0].cLen, s[0].skip], [0, 6, 1]);   // 'Hello ' (leading space dropped)
  assert.equal(s[1].same, n2);
  assert.deepEqual([s[1].cStart, s[1].cLen, s[1].skip], [6, 5, 1]);   // 'world' (leading space merged into the previous one)
  assert.equal(s[2].same, n3);
  assert.deepEqual([s[2].cStart, s[2].cLen, s[2].skip], [11, 1, 0]);  // '!'
});

test('pre blocks are verbatim with raw segments', () => {
  const n = t('line one\n  line two');
  const r = run(el('body', {}, el('p', {}, para(10)), el('pre', {}, el('code', {}, n))));
  const pre = r.blocks.find((b) => b.kind === 'pre');
  assert.equal(pre.text, 'line one\n  line two');
  const seg = r.env.PS.store.blocks.get(pre.localId).segments[0];
  assert.equal(seg.raw, true);
  assert.equal(seg.node, n);
});

test('a block identical to the previous one is dropped', () => {
  const r = run(el('body', {}, el('p', {}, para(10)), el('p', {}, 'Same line twice.'), el('p', {}, 'Same line twice.'), el('p', {}, 'Different line.')));
  assert.deepEqual(texts(r).filter((x) => x.includes('Same line') || x.includes('Different')), ['Same line twice.', 'Different line.']);
});

test('the result is plain data (no nodes) and structured-clonable', () => {
  const body = el('body', {}, el('h1', {}, 'T'), el('p', {}, para(10)));
  const r = run(body);
  delete r.env;
  const json = JSON.stringify(r);
  assert.ok(json.length > 10);
  for (const b of r.blocks) assert.deepEqual(Object.keys(b).filter((k) => !['localId', 'kind', 'level', 'text'].includes(k)), []);
  for (const k of ['url', 'title', 'lang', 'contentType', 'source', 'selectionLength', 'blocks', 'truncatedRaw', 'hasPasswordField']) assert.ok(k in r, k);
  assert.doesNotThrow(() => structuredClone(plain(r)));
});

test('hasPasswordField is reported', () => {
  const login = el('body', {}, el('p', {}, para(10)), el('input', { type: 'password' }));
  assert.equal(run(login).hasPasswordField, true);
  assert.equal(run(el('body', {}, el('p', {}, para(10)))).hasPasswordField, false);
});

test('re-injection is a no-op: same namespace, handlers registered once', () => {
  const env = makeEnv({ body: el('body', {}, el('p', {}, para(10))) }).load(['core.js', 'extract.js']);
  const ns = env.PS;
  const before = Object.keys(ns.handlers).sort();
  env.load(['core.js', 'extract.js']);
  assert.equal(env.PS, ns);
  assert.deepEqual(Object.keys(env.PS.handlers).sort(), before);
  assert.equal(env.call('extract', {}).ok, true);
});

test('each extraction replaces the store generation', () => {
  const env = makeEnv({ body: el('body', {}, el('p', {}, para(10))) }).load(['core.js', 'extract.js']);
  env.call('extract', {});
  const g1 = env.PS.store.gen;
  env.call('extract', {});
  assert.equal(env.PS.store.gen, g1 + 1);
});

// ======================= phase 2: structured extraction =======================

const S = { structured: true };
const tr = (...cells) => el('tr', {}, ...cells);
const td = (x) => el('td', {}, x);
const th = (x) => el('th', {}, x);
const dataTable = (rows, headerCells = ['Name', 'Age']) => el('table', {},
  el('thead', {}, tr(...headerCells.map(th))),
  el('tbody', {}, ...rows.map((r) => tr(...r.map(td)))));

test('structured: a data table becomes one markdown chunk with header and separator', () => {
  const body = el('body', {}, el('p', {}, para(10)), dataTable([['Ann', '31'], ['Bob', '4|2']]));
  const r = run(body, { opts: S });
  const tb = r.blocks.filter((b) => b.kind === 'table');
  assert.equal(tb.length, 1);
  assert.equal(tb[0].text, '| Name | Age |\n| --- | --- |\n| Ann | 31 |\n| Bob | 4\\|2 |');
});

test('structured: tables longer than 20 body rows split into chunks of 20 with the header repeated', () => {
  const rows = Array.from({ length: 45 }, (_, i) => [`n${i}`, `v${i}`]);
  const r = run(el('body', {}, el('p', {}, para(10)), dataTable(rows)), { opts: S });
  const tb = r.blocks.filter((b) => b.kind === 'table');
  assert.equal(tb.length, 3);
  for (const b of tb) assert.ok(b.text.startsWith('| Name | Age |\n| --- | --- |\n'));
  assert.deepEqual(tb.map((b) => b.text.split('\n').length - 2), [20, 20, 5]);
  assert.ok(tb[1].text.includes('| n20 | v20 |'));
});

test('structured: header from first-row th, else generated Column n; cells are capped and newlines flattened', () => {
  const noThead = el('table', {}, tr(th('A'), th('B')), tr(td('1'), td('2')));
  let r = run(el('body', {}, el('p', {}, para(10)), noThead), { opts: S });
  assert.equal(r.blocks.find((b) => b.kind === 'table').text, '| A | B |\n| --- | --- |\n| 1 | 2 |');
  const plainTable = el('table', {}, tr(td('x'), td('y')), tr(td('z'), td('w')));
  r = run(el('body', {}, el('p', {}, para(10)), plainTable), { opts: S });
  assert.equal(r.blocks.find((b) => b.kind === 'table').text, '| Column 1 | Column 2 |\n| --- | --- |\n| x | y |\n| z | w |');
  const big = el('table', {}, tr(th('H1'), th('H2')), tr(td('a'.repeat(500)), td('line1\nline2')));
  r = run(el('body', {}, el('p', {}, para(10)), big), { opts: S });
  const lines = r.blocks.find((b) => b.kind === 'table').text.split('\n');
  assert.equal(lines[2], `| ${'a'.repeat(200)} | line1 line2 |`);
});

test('structured: layout tables (one column, or nested tables) read as paragraphs', () => {
  const one = el('table', {}, tr(td('Only one column here with some text.')), tr(td('Second row of the same single column.')));
  let r = run(el('body', {}, el('p', {}, para(10)), one), { opts: S });
  assert.equal(r.blocks.some((b) => b.kind === 'table'), false);
  assert.ok(texts(r).includes('Only one column here with some text.'));
  const nested = el('table', {}, tr(td(el('table', {}, tr(td('inner a'), td('inner b')), tr(td('inner c'), td('inner d')))), td('outer cell text')), tr(td('x'), td('y')));
  r = run(el('body', {}, el('p', {}, para(10)), nested), { opts: S });
  // the outer table is layout (paragraphs); the inner 2x2 table is data and becomes its own markdown chunk
  assert.ok(texts(r).includes('outer cell text'));
  const tb = r.blocks.filter((b) => b.kind === 'table');
  assert.equal(tb.length, 1);
  assert.ok(tb[0].text.includes('inner a'));
  assert.ok(!tb[0].text.includes('outer cell text'));
});

test('without structured the v1 row format is kept and no extras are returned', () => {
  const r = run(el('body', {}, el('p', {}, para(10)), dataTable([['Ann', '31']])));
  assert.deepEqual(r.blocks.filter((b) => b.kind === 'table').map((b) => b.text), ['Name | Age', 'Ann | 31']);
  for (const k of ['meta', 'outline', 'links', 'forms']) assert.equal(k in r, false, k);
});

test('structured: metadata comes from head tags, each capped at 300 chars; canonical must be http(s)', () => {
  const head = el('head', {},
    el('meta', { name: 'description', content: 'A ' + 'long '.repeat(100) }),
    el('meta', { property: 'og:site_name', content: 'Example News' }),
    el('meta', { name: 'author', content: 'Jane Doe' }),
    el('meta', { property: 'article:published_time', content: '2026-11-02T10:00:00Z' }),
    el('meta', { property: 'og:type', content: 'article' }),
    el('link', { rel: 'canonical', href: '/canonical-path' }));
  const r = run(el('body', {}, el('p', {}, para(10))), { opts: S, head });
  assert.equal(r.meta.description.length, 300);
  assert.equal(r.meta.siteName, 'Example News');
  assert.equal(r.meta.author, 'Jane Doe');
  assert.equal(r.meta.published, '2026-11-02T10:00:00Z');
  assert.equal(r.meta.ogType, 'article');
  assert.equal(r.meta.canonical, 'https://example.com/canonical-path');
  const bad = run(el('body', {}, el('p', {}, para(10))), { opts: S, head: el('head', {}, el('link', { rel: 'canonical', href: 'javascript:alert(1)' })) });
  assert.equal(bad.meta.canonical, '');
  assert.equal(bad.meta.description, '');
});

test('structured: outline lists h1-h4 with their local ids (not h5)', () => {
  const body = el('body', {}, el('h1', {}, 'One'), el('p', {}, para(10)), el('h2', {}, 'Two'), el('h4', {}, 'Four'), el('h5', {}, 'Five'));
  const r = run(body, { opts: S });
  assert.deepEqual(r.outline.map((o) => [o.level, o.text]), [[1, 'One'], [2, 'Two'], [4, 'Four']]);
  for (const o of r.outline) assert.equal(r.blocks.find((b) => b.localId === o.localId).text, o.text);
});

test('structured: links are http(s) only, resolved, deduplicated and capped at 40; text falls back to aria-label', () => {
  const a = (href, text, extra = {}) => el('a', { href, ...extra }, text);
  const links = [
    a('/pricing', 'Pricing'), a('https://example.com/pricing', 'Pricing again'), a('mailto:x@y.com', 'Mail'),
    a('javascript:alert(1)', 'JS'), a('https://other.com/x', ''), a('https://icon.com/', '', { 'aria-label': 'Icon link' }),
    a('#frag', 'Frag'),
  ];
  for (let i = 0; i < 60; i++) links.push(a(`https://many.com/${i}`, `Link ${i}`));
  const r = run(el('body', {}, el('p', {}, para(10)), el('p', {}, ...links)), { opts: S });
  assert.equal(r.links.length, 40);
  assert.deepEqual(r.links[0], { text: 'Pricing', href: 'https://example.com/pricing' });
  assert.equal(r.links.filter((l) => l.href === 'https://example.com/pricing').length, 1);
  assert.ok(!r.links.some((l) => /^(mailto|javascript):/.test(l.href)));
  assert.deepEqual(r.links[1], { text: '', href: 'https://other.com/x' });
  assert.deepEqual(r.links[2], { text: 'Icon link', href: 'https://icon.com/' });
  assert.equal(r.links[3].href, 'https://example.com/a#frag');
  assert.equal(run(el('body', {}, el('p', {}, para(10), a('https://x.com/' + 'y'.repeat(300), 'T'.repeat(200)))), { opts: S }).links[0].text.length, 80);
});

test('structured: form labels with type and required, in labelling order, and never any value', () => {
  const secret = el('input', { type: 'text', 'aria-label': 'Secret box' });
  Object.defineProperty(secret, 'value', { get() { throw new Error('the agent must not read values'); } });
  const body = el('body', {}, el('p', {}, para(10)),
    el('form', {},
      el('label', { for: 'em' }, 'Email address'), el('input', { id: 'em', type: 'email', required: '' }),
      el('label', {}, 'Wrapped label ', el('input', { type: 'text' })),
      el('input', { type: 'text', placeholder: 'Search the site' }),
      el('span', { id: 'lb' }, 'Labelled by'), el('input', { type: 'text', 'aria-labelledby': 'lb' }),
      secret,
      el('select', { 'aria-label': 'Country' }), el('textarea', { title: 'Comments' }),
      el('input', { type: 'hidden', name: 'csrf' }), el('input', { type: 'submit' }),
      el('input', { type: 'text', 'aria-label': 'Invisible', __invisible: true }),
      el('input', { type: 'password', 'aria-label': 'Password', required: '' })));
  const r = run(body, { opts: S });
  assert.deepEqual(r.forms, [
    { label: 'Email address', type: 'email', required: true },
    { label: 'Wrapped label', type: 'text', required: false },
    { label: 'Search the site', type: 'text', required: false },
    { label: 'Labelled by', type: 'text', required: false },
    { label: 'Secret box', type: 'text', required: false },
    { label: 'Country', type: 'select', required: false },
    { label: 'Comments', type: 'textarea', required: false },
    { label: 'Password', type: 'password', required: true },
  ]);
  assert.equal(r.hasPasswordField, true);
});

test('structured: an open shadow root is read after the light children; plain extraction ignores it', () => {
  const host = el('div', { __shadow: [el('p', {}, 'Text inside the shadow root of a web component.')] }, el('p', {}, 'Light child paragraph text.'));
  const body = el('body', {}, el('p', {}, para(10)), host);
  const withShadow = run(body, { opts: S });
  const t2 = texts(withShadow);
  assert.ok(t2.indexOf('Text inside the shadow root of a web component.') > t2.indexOf('Light child paragraph text.'));
  const without = run(el('body', {}, el('p', {}, para(10)), el('div', { __shadow: [el('p', {}, 'Hidden in shadow')] }, el('p', {}, 'light'))));
  assert.ok(!texts(without).some((x) => x.includes('Hidden in shadow')));
});

test('structured results stay plain data and report the viewport (for the iframe filter)', () => {
  const r = run(el('body', {}, el('h1', {}, 'T'), el('p', {}, para(10)), dataTable([['a', 'b']])), { opts: S });
  delete r.env;
  assert.doesNotThrow(() => structuredClone(plain(r)));
  assert.deepEqual(plain(r.viewport), { w: 1024, h: 768 });
});

test('structured selection mode returns no extras', () => {
  const n = t('This is a user selected paragraph of text, long enough to count.');
  const body = el('body', {}, el('p', {}, n), el('p', {}, para(20)));
  const r = run(body, { selection: { startNode: n, startOffset: 0, endNode: n, endOffset: n.nodeValue.length, text: n.nodeValue }, opts: S });
  assert.equal(r.source, 'selection');
  for (const k of ['meta', 'outline', 'links', 'forms']) assert.equal(k in r, false, k);
});
