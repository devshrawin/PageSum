// A small JSON Schema validator for the subset PageSum sends to Gemini (spec 8.2 / B10). Pure.
// Gemini strips minLength / maxLength server-side, so every answer is validated here as well.
// Supported: type (string or array, incl. "null"), properties, required, additionalProperties:false, enum,
// items, minItems/maxItems, minimum/maximum, minLength/maxLength, format "date", anyOf.
// validate(schema, value) -> { ok, errors: string[] } with error paths like "steps[2].action".

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;            // string number boolean object undefined
}

function matchesType(t, v) {
  const actual = typeOf(v);
  if (t === 'integer') return actual === 'number' && Number.isInteger(v);
  if (t === 'number') return actual === 'number' && Number.isFinite(v);
  return t === actual;
}

function isRealDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

const joinKey = (path, key) => (path ? `${path}.${key}` : key);

function check(schema, value, path, errors, opts) {
  const at = path || '(root)';
  if (!schema || typeof schema !== 'object') return;

  if (Array.isArray(schema.anyOf)) {
    const ok = schema.anyOf.some((s) => { const e = []; check(s, value, path, e, opts); return e.length === 0; });
    if (!ok) errors.push(`${at}: does not match any allowed shape`);
    return;
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(t, value))) {
      errors.push(`${at}: expected ${types.join(' or ')}, got ${typeOf(value)}`);
      return;
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((e) => e === value)) {
    errors.push(`${at}: not one of the allowed values`);
  }

  const t = typeOf(value);
  if (t === 'string') {
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
    if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength}`);
    if (opts.formats !== false && schema.format === 'date' && !isRealDate(value)) errors.push(`${at}: not a date (YYYY-MM-DD)`);
  } else if (t === 'number') {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) errors.push(`${at}: below ${schema.minimum}`);
    if (Number.isFinite(schema.maximum) && value > schema.maximum) errors.push(`${at}: above ${schema.maximum}`);
  } else if (t === 'array') {
    if (Number.isFinite(schema.minItems) && value.length < schema.minItems) errors.push(`${at}: fewer than ${schema.minItems} items`);
    if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) errors.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, i) => check(schema.items, item, `${path}[${i}]`, errors, opts));
  } else if (t === 'object') {
    const props = schema.properties || {};
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${joinKey(path, key)}: missing`);
    }
    for (const key of Object.keys(value)) {
      if (Object.prototype.hasOwnProperty.call(props, key)) check(props[key], value[key], joinKey(path, key), errors, opts);
      else if (schema.additionalProperties === false) errors.push(`${joinKey(path, key)}: not allowed`);
    }
  }
}

// opts.formats === false: ignore "format" (a model that writes "soon" in a date field is cleaned by the normaliser).
export function validate(schema, value, opts) {
  const errors = [];
  check(schema, value, '', errors, opts || {});
  return { ok: errors.length === 0, errors };
}
