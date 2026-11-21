// PageSum page agent: extraction (spec 7.2, phase 1). CLASSIC script, runs after core.js.
// Emits text BLOCKS (heading / paragraph / list item / ...) instead of one string, and keeps a live text-node
// map per block in the isolated world so a citation click can highlight the exact passage.
// The returned value contains no DOM references (it must be structured-clonable).
(function () {
  'use strict';
  var PS = globalThis.__PageSum;
  if (!PS || PS.v !== 2 || PS.extractLoaded) return;
  PS.extractLoaded = true;
  var U = PS.util;

  var SKIP_TAGS = {};
  'SCRIPT STYLE NOSCRIPT TEMPLATE SVG CANVAS IFRAME FRAME OBJECT EMBED VIDEO AUDIO PICTURE IMG BUTTON SELECT OPTION INPUT TEXTAREA DIALOG'.split(' ').forEach(function (t) { SKIP_TAGS[t] = true; });
  var CHROME_TAGS = { NAV: true, FOOTER: true, ASIDE: true, HEADER: true, FORM: true };
  var SKIP_ROLES = { navigation: true, banner: true, contentinfo: true, complementary: true, search: true, menu: true, menubar: true, toolbar: true };
  var NOISE = /\b(cookie|consent|gdpr|newsletter|subscribe|share|social|related|advert|ad-|promo|popup|modal|breadcrumb)\b/i;

  function textLen(el) { return (el.innerText || '').length; }

  function isVisible(el) {
    if (el.checkVisibility) return el.checkVisibility({ checkVisibilityCSS: true });
    var cs = getComputedStyle(el);
    return !(cs.display === 'none' || cs.visibility === 'hidden');
  }

  function insideArticle(el) { return !!(el.closest && el.closest('article')); }

  // Same rules as v1. lenient (selection mode): the user picked this text, so only the hard skips apply.
  function shouldSkip(el, root, lenient) {
    var tag = (el.tagName || '').toUpperCase();
    if (SKIP_TAGS[tag]) return true;
    if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true;
    if (!isVisible(el)) return true;
    if (lenient) return false;
    if (el !== root && CHROME_TAGS[tag] && !insideArticle(el)) return true;
    var role = el.getAttribute('role');
    if (role && SKIP_ROLES[role.toLowerCase()]) return true;
    var cls = (el.getAttribute('class') || '') + ' ' + (el.id || '');
    if (NOISE.test(cls) && (el.textContent || '').length < 2000) return true;
    return false;
  }

  // Walk `root` and emit blocks. ctx: { maxRaw, maxChunk, range (selection mode), lenient }.
  function collectBlocks(root, ctx) {
    var blocks = [];            // { localId, kind, level?, text }
    var store = new Map();      // localId -> { text, kind, segments }
    var total = 0;
    var truncated = false;
    var nextId = 0;
    var buf = '';
    var segs = [];              // { node, cStart, cLen, skip, raw? } with offsets into buf
    var kinds = [];             // stack of { kind, level? } for the innermost heading / li / quote / pre / caption / table row
    var range = ctx.range || null;

    function done() { return truncated; }

    // extra: { noSplit, span } (table chunks are never cut at sentence ends; span = first/last text node for highlighting)
    function emit(text, segments, kind, level, extra) {
      var ex = extra || {};
      var pieces = text.length > ctx.maxChunk && !ex.noSplit ? U.splitSentences(text, ctx.maxChunk) : [{ text: text, start: 0, end: text.length }];
      for (var p = 0; p < pieces.length; p++) {
        var pc = pieces[p];
        var last = blocks.length ? blocks[blocks.length - 1] : null;
        if (last && last.text === pc.text) continue; // identical to the previous block
        var ps = [];
        for (var s = 0; s < segments.length; s++) {
          var sg = segments[s];
          var a = Math.max(sg.cStart, pc.start);
          var b = Math.min(sg.cStart + sg.cLen, pc.end);
          if (a < b) ps.push({ node: sg.node, cStart: a - pc.start, cLen: b - a, skip: sg.skip + (a - sg.cStart), raw: !!sg.raw });
        }
        var id = 'b' + (nextId++);
        var blk = { localId: id, kind: kind, text: pc.text };
        if (level) blk.level = level;
        blocks.push(blk);
        store.set(id, { text: pc.text, kind: kind, segments: ps, span: ex.span || null });
        total += pc.text.length;
      }
      if (total > ctx.maxRaw) truncated = true;
    }

    function flush() {
      if (buf) {
        var text = buf.replace(/\s+$/, '');
        // A table row of nothing but separators carries no information.
        if (text && !/^[|\s-]*$/.test(text)) {
          var top = kinds.length ? kinds[kinds.length - 1] : null;
          emit(text, segs, top ? top.kind : 'p', top ? top.level : 0);
        }
      }
      buf = '';
      segs = [];
    }

    // Append a (possibly clipped) text node to the current block.
    function addText(node, so, eo) {
      var raw = node.nodeValue || '';
      var full = U.collapse(raw);
      var k0 = so > 0 ? U.rawToCollapsed(raw, so) : 0;
      var k1 = eo < raw.length ? U.rawToCollapsed(raw, eo) : full.length;
      var v = full.slice(k0, k1);
      var skip = k0;
      if (!v) return;
      if (v.charAt(0) === ' ' && (buf === '' || buf.charAt(buf.length - 1) === ' ')) { v = v.slice(1); skip++; }
      if (!v) return;
      segs.push({ node: node, cStart: buf.length, cLen: v.length, skip: skip });
      buf += v;
    }

    function inRange(n) {
      if (!range) return true;
      try { return range.intersectsNode(n); } catch (e) { return false; }
    }

    function walkPre(el) {
      flush();
      var text = '';
      var psegs = [];
      (function g(n) {
        if (n.nodeType === 3) {
          if (!inRange(n)) return;
          var raw = n.nodeValue || '';
          var so = range && n === range.startContainer ? range.startOffset : 0;
          var eo = range && n === range.endContainer ? range.endOffset : raw.length;
          var v = raw.slice(so, eo);
          if (!v) return;
          psegs.push({ node: n, cStart: text.length, cLen: v.length, skip: so, raw: true });
          text += v;
          return;
        }
        if (n.nodeType !== 1) return;
        var t = (n.tagName || '').toUpperCase();
        if (t === 'SCRIPT' || t === 'STYLE') return;
        var kids = n.childNodes;
        for (var i = 0; i < kids.length; i++) g(kids[i]);
      })(el);
      if (/\S/.test(text)) emit(text, psegs, 'pre', 0);
    }

    function walkChildren(el) {
      var kids = el.childNodes;
      for (var i = 0; i < kids.length; i++) {
        if (done()) return;
        walk(kids[i]);
      }
      // Open shadow roots are read after the element's light children. Closed roots cannot be read.
      if (ctx.structured && el.shadowRoot && el.shadowRoot.childNodes) {
        var sk = el.shadowRoot.childNodes;
        for (var j = 0; j < sk.length; j++) {
          if (done()) return;
          walk(sk[j]);
        }
      }
    }

    // ---- structured: tables as markdown (spec 7.5) ----

    var layoutDepth = 0;
    var links = [];
    var linkSeen = {};

    function noteLink(a) {
      if (links.length >= 40) return;
      var raw = a.getAttribute('href');
      if (!raw) return;
      var abs;
      try { abs = new URL(raw, location.href); } catch (e) { return; }
      if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return;
      var href = abs.href;
      if (linkSeen[href]) return;
      var text = U.collapse(a.textContent || '').trim();
      if (!text) text = U.collapse(a.getAttribute('aria-label') || '').trim();
      linkSeen[href] = true;
      links.push({ text: text.slice(0, 80), href: href });
    }

    function cellText(cell, nodes) {
      var out = '';
      (function g(n) {
        if (n.nodeType === 3) {
          var v = U.collapse(n.nodeValue || '');
          if (v) { nodes.push(n); out += v; }
          return;
        }
        if (n.nodeType !== 1) return;
        var t = (n.tagName || '').toUpperCase();
        if (SKIP_TAGS[t] && t !== 'BUTTON') return;
        if (n.hasAttribute('hidden') || n.getAttribute('aria-hidden') === 'true' || !isVisible(n)) return;
        var kids = n.childNodes;
        for (var i = 0; i < kids.length; i++) g(kids[i]);
      })(cell);
      out = out.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
      return out.length > 200 ? out.slice(0, 200) : out;
    }

    // Returns [{ text, first, last }] chunks of at most 20 body rows (header repeated), or null for layout tables.
    function tableChunks(table) {
      var rows = [];
      var nested = false;
      (function w(n) {
        var kids = n.childNodes;
        for (var i = 0; i < kids.length; i++) {
          var k = kids[i];
          if (k.nodeType !== 1) continue;
          var t = k.tagName.toUpperCase();
          if (t === 'TABLE') { nested = true; return; }
          if (t === 'TR') { if (!shouldSkip(k, root, ctx.lenient)) rows.push(k); } else w(k);
          if (nested) return;
        }
      })(table);
      var hasTable = function (n) {
        for (var i = 0; i < n.childNodes.length; i++) {
          var k = n.childNodes[i];
          if (k.nodeType === 1 && (k.tagName === 'TABLE' || hasTable(k))) return true;
        }
        return false;
      };
      if (!nested) for (var ri = 0; ri < rows.length; ri++) if (hasTable(rows[ri])) { nested = true; break; }
      if (nested || rows.length < 2) return null;
      var cellsOf = function (tr) {
        var out = [];
        for (var i = 0; i < tr.childNodes.length; i++) {
          var c = tr.childNodes[i];
          if (c.nodeType === 1 && (c.tagName === 'TD' || c.tagName === 'TH')) out.push(c);
        }
        return out;
      };
      var grid = rows.map(function (tr) {
        var nodes = [];
        var cells = cellsOf(tr).map(function (c) { return cellText(c, nodes); });
        return { cells: cells, nodes: nodes, tr: tr, th: cellsOf(tr).length > 0 && cellsOf(tr).every(function (c) { return c.tagName === 'TH'; }) };
      });
      var cols = 0;
      grid.forEach(function (r) { cols = Math.max(cols, r.cells.length); });
      if (cols < 2) return null;
      var header = null;
      var body = grid;
      var inThead = grid[0].tr.parentNode && grid[0].tr.parentNode.tagName === 'THEAD';
      if (inThead || grid[0].th) { header = grid[0]; body = grid.slice(1); }
      var head = [];
      for (var c = 0; c < cols; c++) head.push(header && header.cells[c] ? header.cells[c] : 'Column ' + (c + 1));
      var line = function (cells) {
        var cs = [];
        for (var i = 0; i < cols; i++) cs.push(cells[i] || '');
        return '| ' + cs.join(' | ') + ' |';
      };
      var sep = '| ' + head.map(function () { return '---'; }).join(' | ') + ' |';
      var out = [];
      for (var start = 0; start < body.length || (start === 0 && !body.length); start += 20) {
        var part = body.slice(start, start + 20);
        var nodes = [];
        if (start === 0 && header) nodes = nodes.concat(header.nodes);
        part.forEach(function (r) { nodes = nodes.concat(r.nodes); });
        var text = [line(head), sep].concat(part.map(function (r) { return line(r.cells); })).join('\n');
        out.push({ text: text, first: nodes[0] || null, last: nodes[nodes.length - 1] || null });
        if (!body.length) break;
      }
      return out;
    }

    function walk(node) {
      if (done()) return;
      if (node.nodeType === 3) {
        if (!inRange(node)) return;
        var raw = node.nodeValue || '';
        var so = range && node === range.startContainer ? range.startOffset : 0;
        var eo = range && node === range.endContainer ? range.endOffset : raw.length;
        addText(node, so, eo);
        return;
      }
      if (node.nodeType !== 1) return;
      if (shouldSkip(node, root, ctx.lenient)) return;
      if (range && !inRange(node)) return;
      var tag = node.tagName.toUpperCase();

      if (tag === 'PRE') { walkPre(node); return; }
      if (ctx.structured && tag === 'A' && node.hasAttribute('href')) noteLink(node);
      if (ctx.structured && tag === 'TABLE') {
        var tc = tableChunks(node);
        if (tc) {
          flush();
          for (var q = 0; q < tc.length && !done(); q++) {
            emit(tc[q].text, [], 'table', 0, { noSplit: true, span: tc[q].first && tc[q].last ? { first: tc[q].first, last: tc[q].last } : null });
          }
          return;
        }
        // Layout table (one column, or nested tables): its rows and cells read as plain paragraphs.
        layoutDepth++;
        flush();
        walkChildren(node);
        flush();
        layoutDepth--;
        return;
      }
      if (layoutDepth > 0 && (tag === 'TR' || tag === 'TD' || tag === 'TH')) {
        flush();
        walkChildren(node);
        flush();
        return;
      }
      if (/^H[1-6]$/.test(tag)) {
        flush();
        kinds.push({ kind: 'h', level: Number(tag.charAt(1)) });
        walkChildren(node);
        flush();
        kinds.pop();
        return;
      }
      if (tag === 'LI' || tag === 'BLOCKQUOTE' || tag === 'FIGCAPTION' || tag === 'TR') {
        flush();
        kinds.push({ kind: tag === 'LI' ? 'li' : tag === 'BLOCKQUOTE' ? 'quote' : tag === 'FIGCAPTION' ? 'caption' : 'table' });
        walkChildren(node);
        flush();
        kinds.pop();
        return;
      }
      if (tag === 'TD' || tag === 'TH') {
        // Cells of one row are joined with " | " into a single block.
        if (buf) buf += buf.charAt(buf.length - 1) === ' ' ? '| ' : ' | ';
        walkChildren(node);
        return;
      }
      if (tag === 'BR') { flush(); return; }
      if (U.isBlockTag(tag)) {
        flush();
        walkChildren(node);
        flush();
        return;
      }
      walkChildren(node);
    }

    walk(root);
    flush();
    return { blocks: blocks, store: store, truncated: truncated, total: total, links: links };
  }

  function pickRoot() {
    var root = null;
    var source = 'body';
    var articles = Array.prototype.slice.call(document.querySelectorAll('article'))
      .map(function (el) { return { el: el, n: textLen(el) }; })
      .filter(function (a) { return a.n >= 500; })
      .sort(function (a, b) { return b.n - a.n; });
    if (articles.length === 1 || (articles.length > 1 && articles[0].n >= 2 * articles[1].n)) {
      root = articles[0].el;
      source = 'article';
    }
    if (!root) {
      var m = document.querySelector('main');
      if (m && textLen(m) >= 500) { root = m; source = 'main'; }
      else {
        var rm = document.querySelector('[role="main"]');
        if (rm && textLen(rm) >= 500) { root = rm; source = 'main'; }
      }
    }
    if (!root) root = document.body;
    return { root: root, source: source };
  }

  /* ---------- structured extras (spec 7.5): metadata and form field labels ---------- */

  function metaContent(sel) {
    var m = null;
    try { m = document.querySelector(sel); } catch (e) { m = null; }
    return m ? U.collapse(m.getAttribute('content') || '').trim().slice(0, 300) : '';
  }

  function readMeta() {
    var canonical = '';
    try {
      var l = document.querySelector('link[rel="canonical"]');
      var h = l ? String(l.getAttribute('href') || '') : '';
      if (h) {
        var u = new URL(h, location.href);
        if (u.protocol === 'http:' || u.protocol === 'https:') canonical = u.href.slice(0, 300);
      }
    } catch (e) { canonical = ''; }
    return {
      description: metaContent('meta[name="description"]'),
      siteName: metaContent('meta[property="og:site_name"]'),
      author: metaContent('meta[name="author"]'),
      published: metaContent('meta[property="article:published_time"]'),
      ogType: metaContent('meta[property="og:type"]'),
      canonical: canonical,
    };
  }

  // Label of a form control, in this order: aria-label, aria-labelledby, label[for], wrapping label,
  // placeholder, title, alt of a child image, own text. Never reads what the user typed.
  // Phase 3 (guide) reuses this through PS.util.makeLabeler.
  U.makeLabeler = function () {
    var byFor = null;
    function labelMap() {
      if (byFor) return byFor;
      byFor = {};
      (function w(n) {
        if (n.nodeType !== 1) return;
        if (n.tagName === 'LABEL' && n.getAttribute('for') && byFor[n.getAttribute('for')] === undefined) {
          byFor[n.getAttribute('for')] = U.collapse(n.textContent || '').trim();
        }
        for (var i = 0; i < n.childNodes.length; i++) w(n.childNodes[i]);
      })(document.body);
      return byFor;
    }
    // opts.noText: never fall back to the element's own text (textarea and password fields can hold what the user typed)
    return function (el, opts) {
      var t = U.collapse(el.getAttribute('aria-label') || '').trim();
      if (!t) {
        var ids = String(el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
        if (ids.length && document.getElementById) {
          t = ids.map(function (id) {
            var r = document.getElementById(id);
            return r ? U.collapse(r.textContent || '').trim() : '';
          }).filter(Boolean).join(' ');
        }
      }
      if (!t && el.id) t = labelMap()[el.id] || '';
      if (!t && el.closest) {
        var wrap = el.closest('label');
        if (wrap) t = U.collapse(wrap.textContent || '').trim();
      }
      if (!t) t = U.collapse(el.getAttribute('placeholder') || '').trim();
      if (!t) t = U.collapse(el.getAttribute('title') || '').trim();
      if (!t) {
        var img = null;
        for (var i = 0; i < el.childNodes.length; i++) if (el.childNodes[i].tagName === 'IMG') { img = el.childNodes[i]; break; }
        if (img) t = U.collapse(img.getAttribute('alt') || '').trim();
      }
      if (!t && !(opts && opts.noText)) t = U.collapse(el.textContent || '').trim();
      return t.slice(0, 80);
    };
  };

  var FIELD_SKIP_TYPES = { hidden: true, submit: true, button: true, image: true, reset: true };

  function readForms() {
    var labeler = U.makeLabeler();
    var out = [];
    (function w(n) {
      if (out.length >= 40 || n.nodeType !== 1) return;
      var tag = n.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
        var type = tag === 'INPUT' ? String(n.getAttribute('type') || 'text').toLowerCase() : tag.toLowerCase();
        if (!FIELD_SKIP_TYPES[type] && !n.hasAttribute('hidden') && isVisible(n)) {
          out.push({ label: labeler(n), type: type, required: n.hasAttribute('required') || n.getAttribute('aria-required') === 'true' });
        }
        return;
      }
      for (var i = 0; i < n.childNodes.length; i++) w(n.childNodes[i]);
    })(document.body);
    return out;
  }

  PS.register('extract', function (args) {
    var maxRaw = U.num(args.maxRawChars, 1000, 4000000, 120000);
    var maxChunk = U.num(args.maxChunkChars, 100, 5000, 600);
    var ignoreSelection = !!args.ignoreSelection;
    var structured = !!args.structured;

    var sel =window.getSelection ? window.getSelection() : null;
    var selText = sel ? String(sel).trim() : '';

    var title = (document.title || '').trim();
    if (!title) {
      var h1 = document.querySelector('h1');
      title = h1 ? (h1.textContent || '').trim() : '';
    }
    var pw = false;
    try { pw = !!document.querySelector('input[type="password"]'); } catch (e) { pw = false; }

    var result = {
      url: String(location.href),
      title: title,
      lang: (document.documentElement && document.documentElement.lang) || '',
      contentType: document.contentType,
      selectionLength: selText.length,
      hasPasswordField: pw,
      viewport: { w: Math.round(Number(window.innerWidth) || 0), h: Math.round(Number(window.innerHeight) || 0) },
      source: 'body',
      blocks: [],
      truncatedRaw: false,
    };

    var out = null;

    if (!ignoreSelection && selText.length >= 40) {
      var range = sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
      if (range) {
        var anc = range.commonAncestorContainer;
        var rootEl = anc && anc.nodeType === 3 ? (anc.parentElement || anc.parentNode) : anc;
        if (rootEl) out = collectBlocks(rootEl, { maxRaw: maxRaw, maxChunk: maxChunk, range: range, lenient: true });
      }
      if (!out || !out.blocks.length) {
        // Selection without a usable range (for example inside a form field): keep it as one block with no node map.
        var pieces = U.splitSentences(selText, maxChunk);
        var blocks = [];
        var store = new Map();
        pieces.forEach(function (pc, i) {
          var bid = 'b' + i;
          blocks.push({ localId: bid, kind: 'p', text: pc.text });
          store.set(bid, { text: pc.text, kind: 'p', segments: [] });
        });
        out = { blocks: blocks, store: store, truncated: false, total: selText.length };
      }
      result.source = 'selection';
    } else {
      var pick = pickRoot();
      out = collectBlocks(pick.root, { maxRaw: maxRaw, maxChunk: maxChunk, structured: structured });
      result.source = pick.source;
      if (out.total < 200 && pick.root !== document.body) {
        out = collectBlocks(document.body, { maxRaw: maxRaw, maxChunk: maxChunk, structured: structured });
        result.source = 'body';
      }
      if (structured) {
        result.meta = readMeta();
        result.links = out.links || [];
        result.forms = readForms();
      }
    }
    if (structured && result.source !== 'selection') {
      result.outline = out.blocks
        .filter(function (b) { return b.kind === 'h' && b.level <= 4; })
        .slice(0, 60)
        .map(function (b) { return { level: b.level, text: b.text.slice(0, 200), localId: b.localId }; });
    }

    PS.store = { gen: ++PS.gen, blocks: out.store };
    result.blocks = out.blocks;
    result.truncatedRaw = !!out.truncated;
    return result;
  });
})();
