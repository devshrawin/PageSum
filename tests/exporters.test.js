import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, toCsv, toMarkdownTable, toJsonRecords } from '../extension/lib/exporters.js';

test('csvCell: formula-injection guard prefixes an apostrophe', () => {
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell('+x'), "'+x");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell('-cmd'), "'-cmd");
  assert.equal(csvCell('=HYPERLINK("http://evil","click")'), '"\'=HYPERLINK(""http://evil"",""click"")"');
  assert.equal(csvCell('\tTAB'), "'\tTAB");
  assert.equal(csvCell('\rCR'), '"\'\rCR"');
});

test('csvCell: plain numbers are kept, including negative and signed ones', () => {
  assert.equal(csvCell('-12.5'), '-12.5');
  assert.equal(csvCell('+3'), '+3');
  assert.equal(csvCell('42'), '42');
  assert.equal(csvCell(7), '7');
  assert.equal(csvCell('-12.5.1'), "'-12.5.1", 'not a plain number');
  assert.equal(csvCell('-'), "'-");
});

test('csvCell: quotes are doubled, commas / newlines / edge spaces wrap, null is empty', () => {
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
  assert.equal(csvCell(' lead'), '" lead"');
  assert.equal(csvCell('trail '), '"trail "');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(''), '');
  assert.equal(csvCell('plain'), 'plain');
});

test('toCsv: header then rows, CRLF, no trailing newline', () => {
  const out = toCsv(['Name', 'Price'], [['A', '5'], ['B, Inc', null]]);
  assert.equal(out, 'Name,Price\r\nA,5\r\n"B, Inc",');
  assert.ok(!out.endsWith('\r\n'));
  assert.equal(toCsv(['A'], []), 'A');
  assert.equal(toCsv(['=bad'], [['=1']]), "'=bad\r\n'=1");
});

test('toMarkdownTable: pipes escaped, newlines flattened, null empty', () => {
  const out = toMarkdownTable(['Name', 'Note'], [['A|B', 'x\r\ny'], ['C', null]]);
  assert.equal(out, '| Name | Note |\n| --- | --- |\n| A\\|B | x y |\n| C |  |');
});

test('toJsonRecords: keyed by column, nulls kept, duplicate columns made unique, 2-space indent', () => {
  const out = toJsonRecords(['Name', 'Name', 'Price'], [['A', 'B', null], ['C']]);
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed, [{ Name: 'A', 'Name (2)': 'B', Price: null }, { Name: 'C', 'Name (2)': null, Price: null }]);
  assert.ok(out.startsWith('[\n  {\n    "Name": "A"'));
  assert.equal(toJsonRecords(['A'], []), '[]');
});
