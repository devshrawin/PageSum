// Passage matching helpers. Pure.
// findPassage and mapCollapsedOffset have an identical copy in content/core.js (classic script,
// cannot import). tests/static.test.js checks the two copies stay the same. Edit both together.

export function normalizeForMatch(s) {
  let out = '';
  let lastSpace = true;
  for (const ch of String(s == null ? '' : s)) {
    for (let c of ch.normalize('NFKC')) {
      if (/[​-‍⁠﻿]/.test(c)) continue;
      if (/[‘’‚‛]/.test(c)) c = "'";
      else if (/[“”„‟]/.test(c)) c = '"';
      else if (/[‐-―−]/.test(c)) c = '-';
      if (/\s/.test(c)) {
        if (!lastSpace) { out += ' '; lastSpace = true; }
        continue;
      }
      out += c.toLowerCase();
      lastSpace = false;
    }
  }
  return out.replace(/ $/, '');
}

export function findPassage(hay, needle) {
  function norm(s) {
    var t = '';
    var starts = [];
    var ends = [];
    var lastSpace = true;
    var i = 0;
    s = String(s == null ? '' : s);
    for (var ch of s) {
      var n = ch.normalize('NFKC');
      for (var c of n) {
        if (/[​-‍⁠﻿]/.test(c)) continue;
        if (/[‘’‚‛]/.test(c)) c = "'";
        else if (/[“”„‟]/.test(c)) c = '"';
        else if (/[‐-―−]/.test(c)) c = '-';
        if (/\s/.test(c)) {
          if (!lastSpace) { t += ' '; starts.push(i); ends.push(i + ch.length); lastSpace = true; }
          continue;
        }
        var lc = c.toLowerCase();
        for (var k = 0; k < lc.length; k++) { starts.push(i); ends.push(i + ch.length); }
        t += lc;
        lastSpace = false;
      }
      i += ch.length;
    }
    return { t: t, starts: starts, ends: ends };
  }
  var h = norm(hay);
  var nd = norm(needle).t.replace(/ $/, '');
  if (!nd) return null;
  var at = h.t.indexOf(nd);
  if (at >= 0) return { start: h.starts[at], end: h.ends[at + nd.length - 1], how: 'exact' };
  if (nd.length < 12) return null;
  var words = nd.split(' ');
  var pre = words.slice(0, 8).join(' ');
  if (pre.length >= 24 && pre.length < nd.length) {
    at = h.t.indexOf(pre);
    if (at >= 0) {
      var endN = Math.min(at + nd.length, h.t.length);
      return { start: h.starts[at], end: h.ends[endN - 1], how: 'prefix' };
    }
  }
  var suf = words.slice(-8).join(' ');
  if (suf.length >= 24 && suf.length < nd.length) {
    at = h.t.lastIndexOf(suf);
    if (at >= 0) {
      var sufEnd = at + suf.length;
      var startN = Math.max(0, sufEnd - nd.length);
      return { start: h.starts[startN], end: h.ends[sufEnd - 1], how: 'suffix' };
    }
  }
  return null;
}

export function mapCollapsedOffset(raw, collapsedIdx) {
  var isWs = function (ch) { return /\s/.test(ch); };
  var isZw = function (ch) { return /[​-‍⁠]/.test(ch); };
  var n = raw.length;
  var c = 0;
  var i = 0;
  while (i < n) {
    if (c === collapsedIdx) return i;
    if (isWs(raw[i])) {
      while (i < n && (isWs(raw[i]) || isZw(raw[i]))) i++;
      c++;
    } else if (isZw(raw[i])) {
      i++;
    } else {
      i++;
      c++;
    }
  }
  return n;
}

function enc(s) {
  return encodeURIComponent(s).replace(/-/g, '%2D');
}

export function textFragmentUrl(url, passage) {
  const base = String(url == null ? '' : url).split('#')[0];
  const words = String(passage == null ? '' : passage).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return base;
  if (words.length <= 10) return `${base}#:~:text=${enc(words.join(' '))}`;
  return `${base}#:~:text=${enc(words.slice(0, 5).join(' '))},${enc(words.slice(-5).join(' '))}`;
}
