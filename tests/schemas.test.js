import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../extension/lib/jsonschema.js';
import {
  GUIDE_SCHEMA, ACTION_ITEMS_SCHEMA, QUIZ_SCHEMA, FORM_SCHEMA, TABLE_SCHEMA, COMPARE_SCHEMA,
  normalizeGuide, normalizeActionItems, normalizeQuiz, normalizeForm, rectangularize, normalizeCompare,
} from '../extension/lib/schemas.js';

const resolve = (id) => (['c1', 'c2', 'c3', 't1c1', 't1c2', 't2c1'].includes(id) ? { text: id } : null);

const valid = {
  guide: { feasible: true, summary: 's', steps: [{ elementId: 'e1', action: 'click', instruction: 'Click it', valueHint: null, caution: null }, { elementId: null, action: 'scroll', instruction: 'Scroll down', caution: 'external' }] },
  items: { items: [{ task: 'Send report', owner: null, due: '2026-12-01', dueText: null, sources: ['c1'] }], dates: [{ date: null, text: 'next Friday', what: 'review', sources: [] }] },
  quiz: { cards: [{ q: 'Q', a: 'A', sources: ['c1'] }], quiz: [{ q: 'Q', choices: ['a', 'b', 'c', 'd'], answer: 2, why: 'because', sources: ['c2'] }] },
  form: { fields: [{ elementId: 'e1', explanation: 'Your email', format: null, draft: 'a@b.com' }] },
  table: { columns: ['Name', 'Price'], rows: [{ cells: ['A', null], sources: ['c1'] }], notes: null },
  compare: { criteria: [{ name: 'Price', values: [{ tab: 't1', value: '$5', sources: ['t1c1'] }, { tab: 't2', value: null, sources: [] }] }], summary: 'sum', verdict: null },
};

test('every schema accepts a valid fixture', () => {
  assert.equal(validate(GUIDE_SCHEMA, valid.guide).ok, true);
  assert.equal(validate(ACTION_ITEMS_SCHEMA, valid.items).ok, true);
  assert.equal(validate(QUIZ_SCHEMA, valid.quiz).ok, true);
  assert.equal(validate(FORM_SCHEMA, valid.form).ok, true);
  assert.equal(validate(TABLE_SCHEMA, valid.table).ok, true);
  assert.equal(validate(COMPARE_SCHEMA, valid.compare).ok, true);
});

test('every schema rejects invalid fixtures (two each)', () => {
  const r = (schema, v) => assert.equal(validate(schema, v).ok, false, JSON.stringify(v));
  r(GUIDE_SCHEMA, { feasible: true, summary: 's' });                                                    // steps missing
  r(GUIDE_SCHEMA, { ...valid.guide, steps: [{ ...valid.guide.steps[0], action: 'hover' }] });           // bad action
  r(GUIDE_SCHEMA, { ...valid.guide, steps: Array.from({ length: 13 }, () => valid.guide.steps[0]) });   // too many steps
  r(ACTION_ITEMS_SCHEMA, { items: [] });
  r(ACTION_ITEMS_SCHEMA, { ...valid.items, items: [{ ...valid.items.items[0], due: '12/01/2026' }] });
  r(QUIZ_SCHEMA, { ...valid.quiz, quiz: [{ ...valid.quiz.quiz[0], choices: ['a', 'b'] }] });
  r(QUIZ_SCHEMA, { ...valid.quiz, quiz: [{ ...valid.quiz.quiz[0], answer: 4 }] });
  r(FORM_SCHEMA, { fields: [{ elementId: 'e1' }] });
  r(FORM_SCHEMA, { fields: 'none' });
  r(TABLE_SCHEMA, { columns: [], rows: [] });
  r(TABLE_SCHEMA, { columns: ['A'], rows: [{ cells: [1], sources: [] }] });
  r(COMPARE_SCHEMA, { ...valid.compare, criteria: [] });
  r(COMPARE_SCHEMA, { ...valid.compare, criteria: [{ name: 'x', values: [{ tab: 't9', value: null, sources: [] }] }] });
});

test('normalizeGuide caps instruction (300) and valueHint (120) and steps (12)', () => {
  const g = normalizeGuide({ feasible: true, summary: 's', steps: [{ elementId: 'e1', action: 'type', instruction: 'x'.repeat(500), valueHint: 'y'.repeat(300), caution: null }] });
  assert.equal(g.steps[0].instruction.length, 300);
  assert.equal(g.steps[0].valueHint.length, 120);
  assert.equal(g.steps[0].caution, null);
  const many = normalizeGuide({ feasible: true, summary: 's', steps: Array.from({ length: 20 }, () => ({ elementId: null, action: 'read', instruction: 'i', caution: null })) });
  assert.equal(many.steps.length, 12);
  assert.equal(many.steps[0].valueHint, null);
});

test('normalizeActionItems nulls bad dates, keeps the wording, and filters sources through the resolver', () => {
  const out = normalizeActionItems({
    items: [
      { task: 'A', owner: 'Ann', due: '2026-12-01', dueText: null, sources: ['c1', 'c99', 'p3'] },
      { task: 'B', owner: null, due: 'next week', dueText: 'next week', sources: [] },
      { task: 'C', owner: null, due: '2026-1-5', dueText: '5 Jan', sources: ['c2'] },
    ],
    dates: [{ date: '2026-11-30', text: '30 Nov', what: 'deadline', sources: ['c3', 'bogus'] }, { date: 'soon', text: 'soon', what: 'x', sources: [] }],
  }, resolve);
  assert.deepEqual(out.items.map((i) => [i.due, i.dueText, i.sources]), [['2026-12-01', null, ['c1']], [null, 'next week', []], [null, '5 Jan', ['c2']]]);
  assert.deepEqual(out.dates.map((d) => [d.date, d.text, d.sources]), [['2026-11-30', '30 Nov', ['c3']], [null, 'soon', []]]);
});

test('normalizeQuiz filters sources', () => {
  const out = normalizeQuiz(valid.quiz, (id) => (id === 'c1' ? {} : null));
  assert.deepEqual(out.cards[0].sources, ['c1']);
  assert.deepEqual(out.quiz[0].sources, []);
});

test('rectangularize pads, trims, caps cells and makes column names unique', () => {
  const out = rectangularize({
    columns: ['Name', 'Name', ' Price ', 'Name'],
    rows: [
      { cells: ['a'], sources: ['c1', 'zz'] },
      { cells: ['a', 'b', 'c', 'd', 'extra', 'more'], sources: [] },
      { cells: ['x'.repeat(900), null, '', 'ok'], sources: ['c2'] },
    ],
    notes: 'n',
  }, resolve);
  assert.deepEqual(out.columns, ['Name', 'Name (2)', 'Price', 'Name (3)']);
  assert.deepEqual(out.rows[0], { cells: ['a', null, null, null], sources: ['c1'] });
  assert.deepEqual(out.rows[1].cells, ['a', 'b', 'c', 'd']);
  assert.equal(out.rows[2].cells[0].length, 500);
  assert.deepEqual(out.rows[2].cells.slice(1), [null, '', 'ok']);
  assert.equal(out.notes, 'n');
  assert.equal(rectangularize({ columns: ['A'], rows: [], notes: null }, resolve).notes, null);
});

test('normalizeCompare: drops other tabs, mismatched or unresolved sources, fills missing tabs with null', () => {
  const data = {
    criteria: [
      { name: 'Price', values: [
        { tab: 't1', value: '$5', sources: ['t1c1', 't2c1', 't1c9'] },     // t2c1 belongs to another tab, t1c9 does not resolve
        { tab: 't3', value: 'not selected', sources: ['t3c1'] },
        { tab: 't1', value: 'duplicate', sources: [] },
      ] },
      { name: 'Speed', values: [{ tab: 't2', value: 'fast', sources: ['t2c1'] }] },
    ],
    summary: 'sum', verdict: null,
  };
  const out = normalizeCompare(data, ['t1', 't2'], resolve);
  assert.deepEqual(out.criteria[0].values, [{ tab: 't1', value: '$5', sources: ['t1c1'] }, { tab: 't2', value: null, sources: [] }]);
  assert.deepEqual(out.criteria[1].values, [{ tab: 't1', value: null, sources: [] }, { tab: 't2', value: 'fast', sources: ['t2c1'] }]);
  assert.equal(out.summary, 'sum');
  assert.equal(out.verdict, null);
});

test('normalizeForm: drops unknown ids and forces draft to null for sensitive fields', () => {
  const fields = [{ id: 'e1', sensitive: false }, { id: 'e2', sensitive: true }];
  const out = normalizeForm({
    fields: [
      { elementId: 'e1', explanation: 'Email', format: 'x@y', draft: 'me@example.com' },
      { elementId: 'e2', explanation: 'Card number', format: null, draft: '4111 1111 1111 1111' },
      { elementId: 'e9', explanation: 'invented', format: null, draft: 'x' },
    ],
  }, fields);
  assert.deepEqual(out.fields.map((f) => [f.elementId, f.draft]), [['e1', 'me@example.com'], ['e2', null]]);
});
