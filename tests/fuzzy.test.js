import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeForMatch, findPassage, mapCollapsedOffset, textFragmentUrl } from '../extension/lib/fuzzy.js';

test('normalizeForMatch: case, quotes, dashes, NBSP, zero-width, whitespace', () => {
  assert.equal(normalizeForMatch('  It’s “Quoted” – text here​  '), 'it\'s "quoted" - text here');
  assert.equal(normalizeForMatch('A\n\t B'), 'a b');
  assert.equal(normalizeForMatch('ﬁnd'), 'find'); // NFKC ligature
  assert.equal(normalizeForMatch(null), '');
});

test('findPassage: exact', () => {
  const hay = 'Intro text. The quick brown fox jumps over the lazy dog. Outro.';
  const r = findPassage(hay, 'the quick brown fox');
  assert.equal(r.how, 'exact');
  assert.equal(hay.slice(r.start, r.end), 'The quick brown fox');
});

test('findPassage: exact across curly quotes, NBSP and whitespace differences', () => {
  const hay = 'He said “it’s fine”  and left\nquickly.';
  const r = findPassage(hay, 'said "it\'s fine" and left quickly');
  assert.equal(r.how, 'exact');
  assert.equal(hay.slice(r.start, r.end), 'said “it’s fine”  and left\nquickly');
});

test('findPassage: prefix match when the tail of the passage changed', () => {
  const original = 'The committee met on Tuesday and agreed to publish the final report next month without any further changes';
  const hay = 'Before. The committee met on Tuesday and agreed to publish something else entirely. After.';
  const r = findPassage(hay, original);
  assert.equal(r.how, 'prefix');
  assert.equal(r.start, hay.indexOf('The committee'));
  assert.ok(r.end > r.start && r.end <= hay.length);
});

test('findPassage: suffix match when the head of the passage changed', () => {
  const original = 'Totally different opening words here and then the budget was approved by a large majority of members';
  const hay = 'Before. Something else. and then the budget was approved by a large majority of members. After.';
  const r = findPassage(hay, original);
  assert.equal(r.how, 'suffix');
  assert.equal(hay.slice(r.end - 'members'.length, r.end), 'members');
  assert.ok(r.start >= 0 && r.start < r.end);
});

test('findPassage: null when nothing matches, and short needles are exact only', () => {
  assert.equal(findPassage('some text here', 'not present at all in the haystack text'), null);
  assert.equal(findPassage('abc def ghi', ''), null);
  // short needle (< 12 chars) that is absent does not fall back to prefix/suffix
  assert.equal(findPassage('hello world', 'zzz'), null);
  assert.equal(findPassage('hello world', 'hello').how, 'exact');
});

test('mapCollapsedOffset: tabs, newlines, leading spaces, zero-width', () => {
  const raw = 'a \t\n b  c';
  // collapsed: "a b c" -> indexes 0:'a' 1:' ' 2:'b' 3:' ' 4:'c'
  assert.equal(mapCollapsedOffset(raw, 0), 0);
  assert.equal(mapCollapsedOffset(raw, 1), 1);
  assert.equal(mapCollapsedOffset(raw, 2), raw.indexOf('b'));
  assert.equal(mapCollapsedOffset(raw, 3), raw.indexOf('b') + 1);
  assert.equal(mapCollapsedOffset(raw, 4), raw.indexOf('c'));
  assert.equal(mapCollapsedOffset(raw, 5), raw.length);
  assert.equal(mapCollapsedOffset(raw, 99), raw.length);
  const lead = '   x';
  assert.equal(mapCollapsedOffset(lead, 1), 3);
  // zero-width chars are not counted: 'ab' index 1 maps at or just before 'b', and index 2 is the end
  assert.ok([1, 2].includes(mapCollapsedOffset('a​b', 1)));
  assert.equal(mapCollapsedOffset('a​b', 2), 3);
});

test('textFragmentUrl: short passage, long passage, encoding, existing hash', () => {
  assert.equal(textFragmentUrl('https://a.com/p', 'one two three'), 'https://a.com/p#:~:text=one%20two%20three');
  const long = 'w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11 w12';
  assert.equal(textFragmentUrl('https://a.com/p', long), 'https://a.com/p#:~:text=w1%20w2%20w3%20w4%20w5,w8%20w9%20w10%20w11%20w12');
  assert.equal(textFragmentUrl('https://a.com/p#old', 'x'), 'https://a.com/p#:~:text=x');
  const enc = textFragmentUrl('https://a.com/', 'well-known, fish & chips');
  assert.ok(enc.includes('well%2Dknown%2C%20fish%20%26%20chips'), enc);
  assert.equal(textFragmentUrl('https://a.com/p', '   '), 'https://a.com/p');
});
