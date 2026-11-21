// Table exporters (spec 10.7). Pure.

const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[-+]?\d+(\.\d+)?$/;

// One CSV cell. Formula-injection guard: a cell that starts with = + - @ tab or CR is prefixed with an apostrophe
// so a spreadsheet shows it as text, except plain numbers such as -12.5 or +3. Then RFC 4180 quoting.
export function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (FORMULA_START.test(s) && !PLAIN_NUMBER.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s) || /^ | $/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// Header row plus rows, joined by ',' and CRLF, no trailing newline. rows: arrays of cells.
export function toCsv(columns, rows) {
  return [columns, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

const mdCell = (v) => (v === null || v === undefined ? '' : String(v).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|'));

export function toMarkdownTable(columns, rows) {
  const line = (cells) => `| ${cells.map(mdCell).join(' | ')} |`;
  return [line(columns), `| ${columns.map(() => '---').join(' | ')} |`, ...rows.map(line)].join('\n');
}

// JSON array of objects keyed by the column names (made unique if they repeat). Nulls are kept.
export function toJsonRecords(columns, rows) {
  const seen = new Map();
  const keys = columns.map((c) => {
    const base = String(c);
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });
  return JSON.stringify(rows.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] === undefined ? null : r[i]]))), null, 2);
}
