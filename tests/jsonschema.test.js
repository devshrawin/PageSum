import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../extension/lib/jsonschema.js';

const ok = (schema, v) => assert.deepEqual(validate(schema, v), { ok: true, errors: [] }, JSON.stringify(v));
const bad = (schema, v, re) => {
  const r = validate(schema, v);
  assert.equal(r.ok, false, JSON.stringify(v));
  if (re) assert.ok(r.errors.some((e) => re.test(e)), `${r.errors.join(' | ')} should match ${re}`);
  return r;
};

test('types, including a type array with null', () => {
  ok({ type: 'string' }, 'x');
  bad({ type: 'string' }, 5, /expected string, got number/);
  ok({ type: ['string', 'null'] }, null);
  ok({ type: ['string', 'null'] }, 'x');
  bad({ type: ['string', 'null'] }, 3, /string or null/);
  ok({ type: 'boolean' }, false);
  bad({ type: 'boolean' }, 'false');
  ok({ type: 'array' }, []);
  bad({ type: 'array' }, {});
  ok({ type: 'object' }, {});
  bad({ type: 'object' }, null);
  bad({ type: 'object' }, []);
});

test('integer vs number', () => {
  ok({ type: 'integer' }, 3);
  bad({ type: 'integer' }, 3.5);
  ok({ type: 'number' }, 3.5);
  ok({ type: 'number' }, 3);
  bad({ type: 'number' }, NaN);
  bad({ type: 'number' }, '3');
});

test('required and additionalProperties: false', () => {
  const s = { type: 'object', required: ['a'], additionalProperties: false, properties: { a: { type: 'string' }, b: { type: 'number' } } };
  ok(s, { a: 'x' });
  ok(s, { a: 'x', b: 1 });
  bad(s, { b: 1 }, /^a: missing$/);
  bad(s, { a: 'x', c: 1 }, /^c: not allowed$/);
  ok({ type: 'object', properties: { a: { type: 'string' } } }, { a: 'x', extra: 1 });   // extra keys allowed by default
});

test('enum, including null', () => {
  const s = { type: ['string', 'null'], enum: ['a', 'b', null] };
  ok(s, 'a');
  ok(s, null);
  bad(s, 'c', /allowed values/);
  bad({ enum: [1, 2] }, '1');
});

test('minItems / maxItems and minimum / maximum', () => {
  const arr = { type: 'array', minItems: 2, maxItems: 3, items: { type: 'string' } };
  bad(arr, ['a'], /fewer than 2/);
  ok(arr, ['a', 'b']);
  bad(arr, ['a', 'b', 'c', 'd'], /more than 3/);
  const n = { type: 'integer', minimum: 0, maximum: 3 };
  ok(n, 0);
  ok(n, 3);
  bad(n, -1, /below 0/);
  bad(n, 4, /above 3/);
});

test('minLength / maxLength (stripped server-side, so checked here) and format date', () => {
  bad({ type: 'string', minLength: 3 }, 'ab', /shorter/);
  bad({ type: 'string', maxLength: 3 }, 'abcd', /longer/);
  ok({ type: 'string', minLength: 1, maxLength: 3 }, 'abc');
  const d = { type: ['string', 'null'], format: 'date' };
  ok(d, '2026-11-20');
  ok(d, null);
  bad(d, '2026-13-01', /date/);
  bad(d, '2026-02-30', /date/);
  bad(d, '20/11/2026', /date/);
});

test('opts.formats === false ignores "format" (everything else is still checked)', () => {
  const d = { type: ['string', 'null'], format: 'date' };
  assert.equal(validate(d, 'soon').ok, false);
  assert.equal(validate(d, 'soon', { formats: false }).ok, true);
  assert.equal(validate(d, 5, { formats: false }).ok, false, 'the type is still enforced');
  const s = { type: 'object', required: ['d'], properties: { d: d } };
  assert.equal(validate(s, { d: 'next week' }, { formats: false }).ok, true);
  assert.equal(validate(s, {}, { formats: false }).ok, false);
});

test('nested arrays and objects give error paths like steps[2].action', () => {
  const schema = {
    type: 'object', required: ['steps'],
    properties: {
      steps: { type: 'array', items: { type: 'object', required: ['action'], properties: { action: { type: 'string', enum: ['click', 'type'] }, tags: { type: 'array', items: { type: 'string' } } } } },
    },
  };
  ok(schema, { steps: [{ action: 'click' }, { action: 'type', tags: ['a'] }] });
  const r = bad(schema, { steps: [{ action: 'click' }, { action: 'type' }, { action: 'hover' }] }, /^steps\[2\]\.action: not one of/);
  assert.equal(r.errors.length, 1);
  bad(schema, { steps: [{ action: 'click', tags: ['a', 5] }] }, /^steps\[0\]\.tags\[1\]: expected string/);
  bad(schema, { steps: [{}] }, /^steps\[0\]\.action: missing$/);
  bad(schema, {}, /^steps: missing$/);
  bad(schema, 'x', /^\(root\): expected object/);
});

test('anyOf', () => {
  const s = { anyOf: [{ type: 'string' }, { type: 'integer' }] };
  ok(s, 'x');
  ok(s, 4);
  bad(s, 4.5, /any allowed shape/);
  bad(s, null);
});

test('a missing or odd schema accepts anything', () => {
  ok({}, 5);
  ok(null, 5);
  ok(undefined, 'x');
});
