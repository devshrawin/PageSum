// PageSum page agent: core. CLASSIC script, injected on demand with chrome.scripting.executeScript({ files }).
// Order: core.js, extract.js, highlight.js, media.js (phase 3 adds guide.js).
// Everything shares globalThis.__PageSum, which lives in the extension's isolated world: the page cannot see it.
// The agent has no inbound message listener (spec B5). The panel calls __PageSum.call(name, args) via executeScript.
// The agent never acts on the page (spec B11): no clicks, no typing, no navigation. A static test enforces it.
(function () {
  'use strict';
  var G = globalThis;
  if (G.__PageSum && G.__PageSum.v === 2) return; // already loaded: re-injection is a no-op

  var HAS = Object.prototype.hasOwnProperty;
  var PS = {
    v: 2,
    dead: false,
    gen: 0,
    store: null,                       // { gen, blocks: Map(localId -> { text, kind, segments }) } (extract.js)
    handlers: Object.create(null),     // the command allowlist: only registered names can be called
    escapables: [],                    // { active(), clear() }: Esc on the page clears whatever is showing (highlight, guide)
    navHooks: [],                      // functions called when the page URL changed
    teardownFns: [],
    util: {},
  };
  G.__PageSum = PS;

  /* ---------- pure helpers (also exercised directly by tests) ---------- */

  var U = PS.util;

  U.num = function (v, min, max, dflt) {
    var n = Number(v);
    if (!isFinite(n)) n = dflt;
    return Math.min(max, Math.max(min, n));
  };

  U.str = function (v, max) {
    var s = v == null ? '' : String(v);
    return s.slice(0, max == null ? 500 : max);
  };

  // Whitespace as the browser renders it: zero-width characters removed, runs of whitespace (including NBSP) become one space.
  U.collapse = function (raw) {
    return String(raw == null ? '' : raw).replace(/[​-‍⁠]/g, '').replace(/\s+/g, ' ');
  };

  // Number of collapsed characters before raw index r (inverse direction of mapCollapsedOffset).
  U.rawToCollapsed = function (raw, r) {
    var c = 0;
    var i = 0;
    var n = Math.min(r, raw.length);
    while (i < n) {
      if (/\s/.test(raw[i])) {
        while (i < raw.length && (/\s/.test(raw[i]) || /[​-‍⁠]/.test(raw[i]))) i++;
        c++;
      } else if (/[​-‍⁠]/.test(raw[i])) {
        i++;
      } else {
        i++;
        c++;
      }
    }
    return c;
  };

  // Cut at sentence ends (". ", "! ", "? " optionally followed by a closing quote or bracket), hard-cut at max when there is none.
  // Returns trimmed pieces as { text, start, end } with offsets into the given text.
  U.splitSentences = function (text, max) {
    var out = [];
    var n = text.length;
    var start = 0;
    while (start < n) {
      while (start < n && /\s/.test(text[start])) start++;
      if (start >= n) break;
      var end = n;
      if (n - start > max) {
        var limit = start + max;
        var best = -1;
        var re = /[.!?]["')\]]?(?=\s)/g;
        re.lastIndex = start;
        var m;
        while ((m = re.exec(text)) !== null) {
          var e = m.index + m[0].length;
          if (e > limit) break;
          best = e;
        }
        end = best > start ? best : limit;
      }
      var tEnd = end;
      while (tEnd > start && /\s/.test(text[tEnd - 1])) tEnd--;
      if (tEnd > start) out.push({ text: text.slice(start, tEnd), start: start, end: tEnd });
      start = end;
    }
    return out;
  };

  // IDENTICAL COPY of lib/fuzzy.js findPassage and mapCollapsedOffset (checked by tests/static.test.js).
  function findPassage(hay, needle) {
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

  function mapCollapsedOffset(raw, collapsedIdx) {
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
  U.findPassage = findPassage;
  U.mapCollapsedOffset = mapCollapsedOffset;

  // Tags that start a new text block (extraction) or a word break (highlight haystack).
  var BLOCKISH = {};
  ('P DIV SECTION ARTICLE MAIN BLOCKQUOTE PRE UL OL DL TABLE THEAD TBODY TFOOT TR FIGURE FIGCAPTION DD DT LI HR BR ' +
    'H1 H2 H3 H4 H5 H6 HEADER FOOTER NAV ASIDE FORM FIELDSET DETAILS SUMMARY ADDRESS').split(' ').forEach(function (t) { BLOCKISH[t] = true; });
  U.isBlockTag = function (tag) { return BLOCKISH[tag] === true; };

  /* ---------- lifecycle: alive check, teardown, events ---------- */

  function alive() {
    if (PS.dead) return false;
    var ok = false;
    try { ok = typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id; } catch (e) { ok = false; }
    if (!ok) { PS.teardown(); return false; }
    return true;
  }
  PS.alive = alive;

  PS.teardown = function () {
    if (PS.dead) return;
    PS.dead = true;
    clearTimeout(navTimer);
    for (var i = 0; i < PS.teardownFns.length; i++) {
      try { PS.teardownFns[i](); } catch (e) { /* ignore */ }
    }
    PS.teardownFns = [];
    try { window.removeEventListener('keydown', onKey, true); } catch (e) { /* ignore */ }
    try { window.removeEventListener('popstate', onNav); window.removeEventListener('hashchange', onNav); } catch (e) { /* ignore */ }
    try { if (window.navigation && window.navigation.removeEventListener) window.navigation.removeEventListener('navigatesuccess', onNav); } catch (e) { /* ignore */ }
    PS.store = null;
  };

  // Page -> panel event (spec 6.2). The panel may be closed; that is fine.
  PS.emit = function (event, data) {
    if (!alive()) return false;
    try {
      var p = chrome.runtime.sendMessage({ v: 2, src: 'pagesum-agent', type: 'agent/event', event: event, data: data || {} });
      if (p && typeof p.catch === 'function') p.catch(function () { /* panel closed */ });
    } catch (e) { /* extension context gone */ }
    return true;
  };

  var lastHref = String(location.href);
  var navTimer = 0;
  function onNav() {
    clearTimeout(navTimer);
    navTimer = setTimeout(function () {
      if (!alive()) return;
      var href = String(location.href);
      if (href === lastHref) return;
      lastHref = href;
      for (var h = 0; h < PS.navHooks.length; h++) { try { PS.navHooks[h](); } catch (e) { /* ignore */ } }
      PS.emit('navigated', { href: href });
    }, 500);
  }

  function onKey(e) {
    if (!e || e.key !== 'Escape') return;
    if (!alive()) return;
    var any = false;
    for (var i = 0; i < PS.escapables.length; i++) {
      var x = PS.escapables[i];
      if (x.active()) { any = true; x.clear(); }
    }
    if (any) PS.emit('escape', {});
  }

  try {
    window.addEventListener('keydown', onKey, true);
    if (window.navigation && typeof window.navigation.addEventListener === 'function') window.navigation.addEventListener('navigatesuccess', onNav);
    // Backstop when the Navigation API does not reach this world (spec 18.9): href changes are deduplicated in onNav.
    window.addEventListener('popstate', onNav);
    window.addEventListener('hashchange', onNav);
  } catch (e) { /* no window (never in a real page) */ }

  /* ---------- command dispatch (the allowlist) ---------- */

  PS.register = function (name, fn) {
    PS.handlers[name] = fn;
  };

  function fail(code, message) {
    return { ok: false, error: { code: code, message: message || code } };
  }

  // Never throws. Returns { ok: true, data } or { ok: false, error: { code, message } } (a Promise of that for async handlers).
  PS.call = function (name, args) {
    try {
      if (PS.dead) return fail('dead');
      if (typeof name !== 'string' || !HAS.call(PS.handlers, name)) return fail('unknown_command', 'Unknown command');
      var a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
      var data = PS.handlers[name](a);
      if (data && typeof data.then === 'function') {
        // Async handler (fetchSelfPdf): executeScript waits for the promise.
        return data.then(
          function (d) { return { ok: true, data: d === undefined ? {} : d }; },
          function (e) { return fail('exception', U.str(e && e.message, 200)); }
        );
      }
      return { ok: true, data: data === undefined ? {} : data };
    } catch (e) {
      return fail('exception', U.str(e && e.message, 200));
    }
  };

  PS.register('ping', function () { return { v: 2 }; });
})();
