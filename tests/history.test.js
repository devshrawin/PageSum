import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeEntry, addEntry, pruneHistory, searchHistory, exportMarkdown, citedIds, loadHistory, saveHistory,
  addToHistory, deleteFromHistory, clearHistory, MAX_MARKDOWN,
} from '../extension/lib/history.js';

const NOW = Date.parse('2026-11-20T10:00:00Z');
const base = (over = {}) => makeEntry({
  url: 'https://example.com/post?utm_source=x', title: 'A post', kind: 'summary', label: 'Medium summary',
  markdown: '**TL;DR:** Fact [c1]. More [c2, c9].', sourceText: (id) => ({ c1: 'The first passage.', c2: 'The   second\npassage.' }[id] || null), now: NOW, ...over,
});

test('citedIds in order of first appearance, without repeats', () => {
  assert.deepEqual(citedIds('a [c2] b [c1, c2] [p3] [t=1:02] [x1] [link](http://x)'), ['c2', 'c1', 'p3', 't=1:02']);
  assert.deepEqual(citedIds(''), []);
});

test('makeEntry: caps markdown, keeps only cited sources that resolve, derives host and urlKey', () => {
  const e = base();
  assert.match(e.id, /^[0-9a-f]{12}$/);
  assert.equal(e.savedAt, NOW);
  assert.equal(e.host, 'example.com');
  assert.equal(e.urlKey, 'https://example.com/post');
  assert.deepEqual(e.sources, { c1: 'The first passage.', c2: 'The second passage.' });
  const long = base({ markdown: 'x'.repeat(30000) + ' [c1]', sourceText: () => 'p'.repeat(900) });
  assert.equal(long.markdown.length, MAX_MARKDOWN);
  assert.deepEqual(long.sources, {}, 'the cap cut the citation off, so no source is kept');
  const cut = base({ markdown: 'short [c1]', sourceText: () => 's'.repeat(900) });
  assert.equal(cut.sources.c1.length, 300);
  assert.equal(base({ chat: [{ role: 'user', text: 'q' }] }).chat, undefined, 'chat only when historySaveChat');
  const withChat = base({ saveChat: true, chat: Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'model' : 'user', text: 'm' + i })) });
  assert.equal(withChat.chat.length, 20);
  assert.equal(withChat.chat[19].text, 'm29');
});

test('addEntry: newest first; the same urlKey + label is replaced and moves to the top', () => {
  let h = { v: 1, entries: [] };
  h = addEntry(h, base({ title: 'one', now: 1 }));
  h = addEntry(h, base({ url: 'https://other.com/', title: 'two', now: 2 }));
  h = addEntry(h, base({ label: 'Short summary', title: 'three', now: 3 }));
  assert.deepEqual(h.entries.map((e) => e.title), ['three', 'two', 'one']);
  h = addEntry(h, base({ title: 'one again', now: 4 }));
  assert.deepEqual(h.entries.map((e) => e.title), ['one again', 'three', 'two']);
  assert.equal(addEntry(null, base()).entries.length, 1);
});

test('pruneHistory: by count and by bytes, dropping the oldest', () => {
  const entries = Array.from({ length: 350 }, (_, i) => base({ title: 't' + i, now: 1000 - i }));
  const byCount = pruneHistory({ v: 1, entries });
  assert.equal(byCount.entries.length, 300);
  assert.equal(byCount.entries[0].title, 't0');
  const fat = Array.from({ length: 10 }, (_, i) => base({ title: 'fat' + i, markdown: 'y'.repeat(15000) }));
  const byBytes = pruneHistory({ v: 1, entries: fat }, { maxBytes: 50000 });
  assert.ok(JSON.stringify(byBytes).length <= 50000);
  assert.equal(byBytes.entries[0].title, 'fat0', 'the newest survive');
  assert.ok(byBytes.entries.length < 10 && byBytes.entries.length >= 1);
  assert.equal(pruneHistory({ v: 1, entries: fat }, { maxBytes: 10 }).entries.length, 1, 'never empties the library');
});

test('searchHistory: every token, case-insensitive, over title, host and markdown without citations', () => {
  const a = base({ title: 'Quarterly Report', markdown: 'Revenue grew [c1] by ten percent.' });
  const b = base({ url: 'https://news.example.org/x', title: 'Weather', markdown: 'Rain tomorrow.' });
  const list = [a, b];
  assert.deepEqual(searchHistory(list, '').length, 2);
  assert.deepEqual(searchHistory(list, 'revenue').map((e) => e.title), ['Quarterly Report']);
  assert.deepEqual(searchHistory(list, 'REVENUE ten').map((e) => e.title), ['Quarterly Report']);
  assert.deepEqual(searchHistory(list, 'revenue rain'), [], 'all tokens must match');
  assert.deepEqual(searchHistory(list, 'news.example').map((e) => e.title), ['Weather'], 'host is searched');
  assert.deepEqual(searchHistory(list, 'c1'), [], 'citation markers are not searchable text');
  assert.deepEqual(searchHistory(list, 'quarterly').length, 1);
});

test('exportMarkdown: footnotes for cited sources and text-fragment links; unresolved ids dropped', () => {
  const md = exportMarkdown([base(), base({ url: 'https://other.com/a', title: 'Other', label: 'PDF summary', markdown: 'Nothing cited here.' })]);
  const parts = md.split('\n\n---\n\n');
  assert.equal(parts.length, 2);
  assert.ok(parts[0].startsWith('## A post\nhttps://example.com/post?utm_source=x\n*Medium summary, 2026-11-20T10:00:00.000Z*\n\n'));
  assert.ok(parts[0].includes('**TL;DR:** Fact[^1]. More[^2].'), parts[0]);
  assert.ok(parts[0].includes('[^1]: "The first passage." (https://example.com/post?utm_source=x#:~:text=The%20first%20passage.)'));
  assert.ok(parts[0].includes('[^2]: "The second passage." (https://example.com/post?utm_source=x#:~:text=The%20second%20passage.)'));
  assert.ok(!parts[0].includes('c9') && !parts[0].includes('[c'));
  assert.ok(parts[1].startsWith('## Other\nhttps://other.com/a\n*PDF summary,'));
  assert.ok(!parts[1].includes('[^'));
  assert.equal(exportMarkdown([]), '\n');
});

function fakeArea(opts = {}) {
  const m = new Map();
  let fails = opts.failFirst || 0;
  return {
    async get(k) { return m.has(k) ? { [k]: structuredClone(m.get(k)) } : {}; },
    async set(o) {
      if (fails > 0) { fails--; throw new Error('QUOTA_BYTES quota exceeded'); }
      for (const [k, v] of Object.entries(o)) m.set(k, structuredClone(v));
    },
    async remove(k) { m.delete(k); },
    _m: m,
  };
}

test('storage: add, replace, delete, clear', async () => {
  const area = fakeArea();
  assert.deepEqual((await loadHistory(area)).entries, []);
  const a = base({ title: 'a' });
  assert.equal(await addToHistory(a, area), true);
  await addToHistory(base({ title: 'b', url: 'https://b.com/' }), area);
  await addToHistory(base({ title: 'a2' }), area);
  const h = await loadHistory(area);
  assert.deepEqual(h.entries.map((e) => e.title), ['a2', 'b']);
  await deleteFromHistory(h.entries[0].id, area);
  assert.deepEqual((await loadHistory(area)).entries.map((e) => e.title), ['b']);
  await clearHistory(area);
  assert.deepEqual((await loadHistory(area)).entries, []);
});

test('storage full: prune to 2 MB and retry once, otherwise report failure', async () => {
  const fat = Array.from({ length: 12 }, (_, i) => base({ title: 'f' + i, markdown: 'z'.repeat(19000), url: 'https://f.com/' + i }));
  const area = fakeArea({ failFirst: 1 });
  assert.equal(await saveHistory({ v: 1, entries: fat }, area), true);
  assert.equal((await loadHistory(area)).entries.length, 12);
  assert.equal(await saveHistory({ v: 1, entries: fat }, fakeArea({ failFirst: 2 })), false);
  // a corrupt value reads as an empty library
  const odd = fakeArea();
  await odd.set({ history: { v: 7, entries: 'x' } });
  assert.deepEqual((await loadHistory(odd)).entries, []);
});
