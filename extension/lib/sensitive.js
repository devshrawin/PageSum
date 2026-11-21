// Sensitive-page guard helpers. Pure.
// Phase 1 ships only the host-list helpers that settings need.
// classifySensitive (spec 12.3) is below.

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

// Spec 12.3. Rules are checked in order and the first hit wins:
// blocklist, login, banking, health, payment. Returns { sensitive, reason } with reason null when not sensitive.
const RE_LOGIN_PATH = /\/(login|signin|sign-in|logon|auth|password|reset-password|2fa|mfa)\b/i;
const RE_BANKING = /\b(bank|banking|netbanking|credit ?union|paypal|wise\.com|revolut|brokerage|demat)\b/i;
const RE_HEALTH = /\b(mychart|patient|health ?record|pharmacy|prescription|lab results|insurance claim)\b/i;
const RE_PAYMENT_PATH = /\/(checkout|payment|billing|pay)\b/i;

export function classifySensitive({ url, title, hasPasswordField, blocklist } = {}) {
  let host = '';
  let path = '';
  try { const u = new URL(url); host = u.hostname; path = u.pathname; } catch { /* no usable URL */ }
  const t = String(title == null ? '' : title);
  if (host && hostMatchesList(host, blocklist)) return { sensitive: true, reason: 'blocklist' };
  if (hasPasswordField || RE_LOGIN_PATH.test(path)) return { sensitive: true, reason: 'login' };
  if (RE_BANKING.test(host) || RE_BANKING.test(t)) return { sensitive: true, reason: 'banking' };
  if (RE_HEALTH.test(host) || RE_HEALTH.test(t) || RE_HEALTH.test(path)) return { sensitive: true, reason: 'health' };
  if (RE_PAYMENT_PATH.test(path)) return { sensitive: true, reason: 'payment' };
  return { sensitive: false, reason: null };
}
