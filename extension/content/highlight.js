// PageSum page agent: click-to-source highlight (spec 8.3). CLASSIC script, runs after core.js and extract.js.
// Marks a passage with the CSS Custom Highlight API and a short outline flash. It only draws; it never changes the page.
(function () {
  'use strict';
  var PS = globalThis.__PageSum;
  if (!PS || PS.v !== 2 || PS.highlightLoaded) return;
  PS.highlightLoaded = true;
  var U = PS.util;

  var HL_NAME = 'pagesum-cite';
  var FLASH_MS = 1200;
  var SMOOTH_DELAY_MS = 400;     // let a smooth scroll settle before measuring the flash box
  var active = false;
  var flashEl = null;
  var flashTimers = [];

  var HAY_SKIP = {};
  'SCRIPT STYLE NOSCRIPT TEMPLATE SVG CANVAS IFRAME OBJECT EMBED VIDEO AUDIO'.split(' ').forEach(function (t) { HAY_SKIP[t] = true; });

  function clearFlash() {
    while (flashTimers.length) clearTimeout(flashTimers.pop());
    if (flashEl) {
      try { flashEl.remove(); } catch (e) { /* ignore */ }
      flashEl = null;
    }
  }

  function clearHighlight() {
    clearFlash();
    try { if (typeof CSS !== 'undefined' && CSS.highlights) CSS.highlights.delete(HL_NAME); } catch (e) { /* ignore */ }
    active = false;
  }

  function reducedMotion() {
    try { return !!(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; }
  }

  function drawFlash(range) {
    clearFlash();
    var r = null;
    try { r = range.getBoundingClientRect(); } catch (e) { r = null; }
    if (!r || !(r.width > 0) || !(r.height > 0)) return;
    var d = document.createElement('div');
    d.className = 'pagesum-ov-flash';
    d.style.left = Math.max(0, r.left - 3) + 'px';
    d.style.top = Math.max(0, r.top - 3) + 'px';
    d.style.width = (r.width + 6) + 'px';
    d.style.height = (r.height + 6) + 'px';
    document.documentElement.appendChild(d);
    flashEl = d;
    flashTimers.push(setTimeout(clearFlash, FLASH_MS));
  }

  function show(range) {
    var hasApi = false;
    try { hasApi = typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight === 'function'; } catch (e) { hasApi = false; }
    if (hasApi) CSS.highlights.set(HL_NAME, new Highlight(range));
    active = true;
    var smooth = !reducedMotion();
    var node = range.startContainer;
    var target = node && node.nodeType === 1 ? node : (node && (node.parentElement || node.parentNode));
    try {
      if (target && target.scrollIntoView) target.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
    } catch (e) { /* ignore */ }
    if (smooth) flashTimers.push(setTimeout(function () { drawFlash(range); }, SMOOTH_DELAY_MS));
    else drawFlash(range);
  }

  // Exact path: the block's remembered text nodes are all still on the page with the same text.
  function exactRange(blk, text) {
    if (blk && blk.span && (!text || blk.text === text)) {
      // Table chunks: the markdown text is not on the page, so mark from the first to the last cell text.
      var sp = blk.span;
      if (!sp.first || !sp.last || !sp.first.isConnected || !sp.last.isConnected) return null;
      var tr = document.createRange();
      tr.setStart(sp.first, 0);
      tr.setEnd(sp.last, (sp.last.nodeValue || '').length);
      return tr;
    }
    if (!blk || !blk.segments || !blk.segments.length) return null;
    if (text && blk.text !== text) return null; // localId was reused by a newer extraction
    for (var i = 0; i < blk.segments.length; i++) {
      var s = blk.segments[i];
      var n = s.node;
      if (!n || !n.isConnected) return null;
      var raw = n.nodeValue || '';
      var have = s.raw ? raw.substr(s.skip, s.cLen) : U.collapse(raw).substr(s.skip, s.cLen);
      if (have !== blk.text.substr(s.cStart, s.cLen)) return null;
    }
    var first = blk.segments[0];
    var last = blk.segments[blk.segments.length - 1];
    var r = document.createRange();
    var fr = first.node.nodeValue || '';
    var lr = last.node.nodeValue || '';
    r.setStart(first.node, first.raw ? first.skip : U.mapCollapsedOffset(fr, first.skip));
    r.setEnd(last.node, last.raw ? last.skip + last.cLen : U.mapCollapsedOffset(lr, last.skip + last.cLen));
    return r;
  }

  // Fuzzy fallback: the visible text of the whole body as one collapsed haystack, searched with findPassage.
  function fuzzyRange(text) {
    if (!text || !document.body) return null;
    var hay = '';
    var idx = [];
    (function w(n) {
      if (n.nodeType === 3) {
        var v = U.collapse(n.nodeValue || '');
        var skip = 0;
        if (!v) return;
        if (v.charAt(0) === ' ' && (hay === '' || hay.charAt(hay.length - 1) === ' ')) { v = v.slice(1); skip = 1; }
        if (!v) return;
        idx.push({ node: n, start: hay.length, len: v.length, skip: skip });
        hay += v;
        return;
      }
      if (n.nodeType !== 1) return;
      var tag = (n.tagName || '').toUpperCase();
      if (HAY_SKIP[tag]) return;
      if (n.checkVisibility && !n.checkVisibility()) return;
      var block = U.isBlockTag(tag);
      if (block && hay && hay.charAt(hay.length - 1) !== ' ') hay += ' ';
      var kids = n.childNodes;
      for (var i = 0; i < kids.length; i++) w(kids[i]);
      if (n.shadowRoot && n.shadowRoot.childNodes) {
        for (var j = 0; j < n.shadowRoot.childNodes.length; j++) w(n.shadowRoot.childNodes[j]);
      }
      if (block && hay && hay.charAt(hay.length - 1) !== ' ') hay += ' ';
    })(document.body);
    var m = U.findPassage(hay, text);
    if (!m) return null;
    var a = null;
    var b = null;
    var i;
    for (i = 0; i < idx.length; i++) {
      if (idx[i].start + idx[i].len > m.start) { a = idx[i]; break; }
    }
    for (i = idx.length - 1; i >= 0; i--) {
      if (idx[i].start < m.end) { b = idx[i]; break; }
    }
    if (!a || !b) return null;
    var aLocal = Math.max(0, m.start - a.start);
    var bLocal = Math.min(b.len, m.end - b.start);
    var r = document.createRange();
    r.setStart(a.node, U.mapCollapsedOffset(a.node.nodeValue || '', a.skip + aLocal));
    r.setEnd(b.node, U.mapCollapsedOffset(b.node.nodeValue || '', b.skip + bLocal));
    return r;
  }

  function highlight(localId, text) {
    clearHighlight();
    var store = PS.store;
    var blk = store && store.blocks ? store.blocks.get(localId) : null;
    var range = null;
    var how = 'none';
    try { range = exactRange(blk, text); } catch (e) { range = null; }
    if (range) how = 'exact';
    else {
      try { range = fuzzyRange(text || (blk && blk.text) || ''); } catch (e) { range = null; }
      if (range) how = 'fuzzy';
    }
    if (!range) return 'none';
    show(range);
    return how;
  }

  PS.escapables.push({ active: function () { return active; }, clear: clearHighlight });
  PS.navHooks.push(clearHighlight);
  PS.teardownFns.push(clearHighlight);

  PS.register('highlight', function (a) {
    return { found: highlight(U.str(a.localId, 40), U.str(a.text, 700)) };
  });
  PS.register('clearHighlight', function () {
    clearHighlight();
    return {};
  });
})();
