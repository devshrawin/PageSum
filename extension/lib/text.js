// Pure text helpers. No chrome.* access.

export function cleanText(raw) {
  let s = String(raw == null ? '' : raw)
    .replace(/ /g, ' ')
    .replace(/[​-‍﻿]/g, '');
  s = s.replace(/\r\n?/g, '\n');
  const out = [];
  let prev = null; // previous non-empty line
  for (let line of s.split('\n')) {
    line = line.replace(/[ \t]+/g, ' ').trim();
    if (line === '') { out.push(''); continue; }
    if (/^[-|\s]*$/.test(line)) continue; // only '-' or '|'
    if (line === prev) continue;
    prev = line;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function truncateText(text, maxChars) {
  const originalLength = text.length;
  if (originalLength <= maxChars) return { text, truncated: false, originalLength };
  let cut = text.lastIndexOf('\n\n', maxChars);
  if (cut < 0.8 * maxChars) {
    const head = text.slice(0, maxChars + 1);
    const m = /\s\S*$/.exec(head);
    cut = m && m.index > 0 ? m.index : maxChars;
  }
  return { text: text.slice(0, cut).trimEnd(), truncated: true, originalLength };
}

export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const TRACKING = /^(utm_.*|fbclid|gclid|mc_cid|mc_eid|ref_src)$/i;

export function normalizeUrlKey(url) {
  let u;
  try { u = new URL(url); } catch { return String(url); }
  if (!(u.hash.startsWith('#/') || u.hash.startsWith('#!'))) u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '') || '/';
  return u.toString();
}

const RESTRICTED_SCHEMES = new Set([
  'chrome:', 'chrome-extension:', 'edge:', 'about:', 'devtools:', 'view-source:',
  'chrome-search:', 'chrome-untrusted:', 'data:', 'blob:', 'javascript:',
]);

export const MSG_RESTRICTED = "Chrome doesn't let extensions read this page.";
export const MSG_WEBSTORE = "Chrome doesn't let extensions read the Web Store.";
export const MSG_PDF = "PDFs aren't supported yet. Open the article as a web page instead.";
export const MSG_FILE = "To read local files, turn on 'Allow access to file URLs' for PageSum in chrome://extensions.";

export function isRestrictedUrl(url) {
  if (!url) return { ok: false, kind: 'restricted', reason: MSG_RESTRICTED };
  let u;
  try { u = new URL(url); } catch { return { ok: false, kind: 'restricted', reason: MSG_RESTRICTED }; }
  if (RESTRICTED_SCHEMES.has(u.protocol)) return { ok: false, kind: 'restricted', reason: MSG_RESTRICTED };
  if (u.hostname === 'chromewebstore.google.com' ||
      (u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore'))) {
    return { ok: false, kind: 'webstore', reason: MSG_WEBSTORE };
  }
  if (/\.pdf$/i.test(u.pathname)) return { ok: false, kind: 'pdf', reason: MSG_PDF };
  if (u.protocol === 'file:') return { ok: true, kind: 'file', reason: MSG_FILE };
  return { ok: true };
}

export function pageKind(url) {
  let u;
  try { u = new URL(url); } catch { return 'normal'; }
  const hostOk = ['www.youtube.com', 'm.youtube.com', 'youtube.com'].includes(u.hostname);
  if (hostOk && (u.pathname.startsWith('/watch') || u.pathname.startsWith('/shorts'))) return 'youtube';
  return 'normal';
}
