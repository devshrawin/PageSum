// Sensitive-page guard helpers. Pure.
// Phase 1 ships only the host-list helpers that settings need.
// classifySensitive (spec 12.3) is added in phase 3.

// 'https://Foo.com/x' -> 'foo.com'; '*.Bank.com' stays '*.bank.com'; garbage -> ''.
export function normalizeHostEntry(entry) {
  let s = String(entry == null ? '' : entry).trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.split(/[/?#]/)[0];
  s = s.replace(/^[^@]*@/, '').replace(/:\d+$/, '').replace(/\.+$/, '');
  let wild = false;
  if (s.startsWith('*.')) { wild = true; s = s.slice(2); }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(s)) return '';
  return wild ? '*.' + s : s;
}

// Exact host, or '*.example.com' matches example.com and any subdomain of it
// ('notbank.com' does not match '*.bank.com').
export function hostMatchesList(host, list) {
  const h = String(host == null ? '' : host).toLowerCase();
  if (!h) return false;
  for (const raw of Array.isArray(list) ? list : []) {
    const e = normalizeHostEntry(raw);
    if (!e) continue;
    if (e.startsWith('*.')) {
      const base = e.slice(2);
      if (h === base || h.endsWith('.' + base)) return true;
    } else if (h === e) return true;
  }
  return false;
}
