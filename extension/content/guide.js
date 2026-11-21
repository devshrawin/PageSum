// PageSum page agent: guide mode (spec section 9). CLASSIC script, runs after core.js and extract.js.
// Scans the interactive elements of the page and draws an outline plus a tooltip around ONE of them.
// It never acts on the page: no click, no typing, no focus, no navigation. There are no buttons in the overlay
// (all controls live in the side panel, so a page cannot spoof or intercept them), and it never reads what the
// user typed (no field values, no selected option, no textarea or password text).
(function () {
  'use strict';
  var PS = globalThis.__PageSum;
  if (!PS || PS.v !== 2 || PS.guideLoaded) return;
  PS.guideLoaded = true;
  var U = PS.util;

  var ROLES = {};
  'button link tab menuitem checkbox radio switch combobox textbox'.split(' ').forEach(function (r) { ROLES[r] = true; });
  var SKIP = { SCRIPT: true, STYLE: true, NOSCRIPT: true, TEMPLATE: true };
  var FIELD_SKIP_TYPES = { hidden: true, submit: true, button: true, image: true, reset: true };
  var LANDMARKS = { HEADER: 'Header', NAV: 'Navigation', MAIN: 'Main', FOOTER: 'Footer', ASIDE: 'Sidebar' };
  var SENSITIVE_AUTOCOMPLETE = /^(cc-|current-password|new-password|one-time-code)/;
  var SENSITIVE_WORDS = /ssn|social security|cvv|cvc|card number|iban|routing|pin\b|passport|aadhaar|pan\b/i;

  var scanId = 0;
  var elements = new Map();      // 'e1' -> { el, fp }
  var overlay = null;

  function visible(el) {
    if (el.hasAttribute('hidden')) return false;
    if (el.checkVisibility && !el.checkVisibility()) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function isCandidate(el) {
    var tag = el.tagName;
    if (tag === 'A') return el.hasAttribute('href');
    if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'SUMMARY') return true;
    if (tag === 'INPUT') return String(el.getAttribute('type') || '').toLowerCase() !== 'hidden';
    var role = el.getAttribute('role');
    if (role && ROLES[role.toLowerCase()]) return true;
    if (el.getAttribute('contenteditable') === 'true') return true;
    var ti = el.getAttribute('tabindex');
    return ti !== null && ti !== '-1';
  }

  function roleOf(el) {
    var explicit = el.getAttribute('role');
    if (explicit) return explicit.toLowerCase();
    var tag = el.tagName;
    if (tag === 'A') return 'link';
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'INPUT') {
      var t = String(el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio') return t;
      if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image') return 'button';
      if (t === 'range') return 'slider';
      return 'textbox';
    }
    if (el.getAttribute('contenteditable') === 'true') return 'textbox';
    return tag.toLowerCase();
  }

  // Nearest landmark (with its aria-label, or a generic name) or the closest heading before it, up to 40 chars.
  function regionOf(el) {
    for (var n = el; n && n.nodeType === 1 && n !== document.body; n = n.parentNode) {
      var aria = n.getAttribute && n.getAttribute('aria-label');
      var tag = n.tagName;
      var isLandmark = LANDMARKS[tag] || n.getAttribute('role') === 'region' || n.getAttribute('role') === 'navigation' || n.getAttribute('role') === 'banner';
      if (isLandmark && n !== el) return U.collapse(aria || LANDMARKS[tag] || '').trim().slice(0, 40);
      var parent = n.parentNode;
      if (!parent || !parent.childNodes) continue;
      var kids = parent.childNodes;
      var idx = -1;
      for (var i = 0; i < kids.length; i++) if (kids[i] === n) { idx = i; break; }
      for (var j = idx - 1; j >= 0; j--) {
        var k = kids[j];
        if (k.nodeType === 1 && /^H[1-3]$/.test(k.tagName)) return U.collapse(k.textContent || '').trim().slice(0, 40);
      }
    }
    return '';
  }

  function linkHref(el) {
    var raw = el.getAttribute('href');
    if (!raw) return undefined;
    try {
      var u = new URL(raw, location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
      return (u.origin + u.pathname).slice(0, 80);
    } catch (e) { return undefined; }
  }

  function optionTexts(sel) {
    var out = [];
    (function w(n) {
      for (var i = 0; i < n.childNodes.length && out.length < 10; i++) {
        var c = n.childNodes[i];
        if (c.nodeType !== 1) continue;
        if (c.tagName === 'OPTION') out.push(U.collapse(c.textContent || '').trim().slice(0, 40));
        else if (c.tagName === 'OPTGROUP') w(c);
      }
    })(sel);
    return out;
  }

  // A hint for finding the same element again after the page changes. Never sent to Gemini.
  function selectorHint(el) {
    var id = el.id;
    if (id && !/\d{3,}|[:]/.test(id)) {
      var same = 0;
      try { same = document.querySelectorAll('#' + id).length; } catch (e) { same = 0; }
      if (same === 1) return '#' + id;
    }
    var tid = el.getAttribute('data-testid');
    if (tid) return '[data-testid="' + String(tid).slice(0, 60) + '"]';
    var parts = [];
    for (var n = el, d = 0; n && n.nodeType === 1 && n !== document.body && d < 4; n = n.parentNode, d++) {
      var tag = n.tagName.toLowerCase();
      var idx = 1;
      var p = n.parentNode;
      if (p && p.childNodes) {
        for (var i = 0; i < p.childNodes.length && p.childNodes[i] !== n; i++) if (p.childNodes[i].nodeType === 1 && p.childNodes[i].tagName === n.tagName) idx++;
      }
      parts.unshift(tag + ':nth-of-type(' + idx + ')');
    }
    return parts.join('>').slice(0, 120);
  }

  function labelFn() {
    var l = U.makeLabeler();
    return function (el) {
      var noText = el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && String(el.getAttribute('type') || '').toLowerCase() === 'password');
      return l(el, { noText: noText });
    };
  }

  function inViewport(el) {
    var r = el.getBoundingClientRect();
    var vw = Number(window.innerWidth) || 0;
    var vh = Number(window.innerHeight) || 0;
    return r.left < vw && r.top < vh && r.left + r.width > 0 && r.top + r.height > 0;
  }

  // Candidate elements in document order. Open shadow roots are walked. A matching element is not descended into
  // (nested matches are dropped, keeping the outermost).
  function candidates(predicate, limit) {
    var out = [];
    (function w(n) {
      if (out.length >= limit || n.nodeType !== 1) return;
      if (SKIP[n.tagName]) return;
      if (n.hasAttribute('hidden') || (n.checkVisibility && !n.checkVisibility())) return;
      if (predicate(n)) { out.push(n); return; }
      for (var i = 0; i < n.childNodes.length; i++) w(n.childNodes[i]);
      if (n.shadowRoot && n.shadowRoot.childNodes) for (var j = 0; j < n.shadowRoot.childNodes.length; j++) w(n.shadowRoot.childNodes[j]);
    })(document.body || document.documentElement);
    return out;
  }

  function register(list, build) {
    scanId++;
    elements = new Map();
    var infos = [];
    var ordered = list.filter(inViewport).concat(list.filter(function (e) { return !inViewport(e); }));
    for (var i = 0; i < ordered.length; i++) {
      var el = ordered[i];
      var id = 'e' + (i + 1);
      var info = build(el, id);
      elements.set(id, { el: el, fp: { role: info.role, label: info.label, region: info.region, selectorHint: info.selectorHint } });
      infos.push(info);
    }
    return infos;
  }

  PS.register('scanInteractive', function (a) {
    var max = U.num(a.max, 1, 250, 250);
    var label = labelFn();
    var list = candidates(isCandidate, 1000).filter(visible).slice(0, 1000);
    var infos = register(list.slice(0, Math.max(max, 1) * 4), function (el, id) {
      var role = roleOf(el);
      var info = {
        id: id, role: role, tag: el.tagName.toLowerCase(), label: label(el), region: regionOf(el),
        disabled: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
        required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
        inViewport: inViewport(el), selectorHint: selectorHint(el),
      };
      if (el.tagName === 'INPUT') info.type = String(el.getAttribute('type') || 'text').toLowerCase();
      // (Object.assign, so this file contains no property assignments that a static check for page writes could confuse)
      if (role === 'link') { var h = linkHref(el); if (h) Object.assign(info, { href: h }); }
      if (role === 'checkbox' || role === 'radio') Object.assign(info, { checked: el.checked === true || el.getAttribute('aria-checked') === 'true' });
      if (el.tagName === 'SELECT') info.options = optionTexts(el);
      return info;
    }).slice(0, max);
    // keep the registry in step with what is returned
    var keep = new Set(infos.map(function (i) { return i.id; }));
    elements.forEach(function (_, id) { if (!keep.has(id)) elements.delete(id); });
    return { elements: infos, scanId: scanId };
  });

  function isField(el) {
    var tag = el.tagName;
    if (tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') return false;
    return !(tag === 'INPUT' && FIELD_SKIP_TYPES[String(el.getAttribute('type') || 'text').toLowerCase()]);
  }

  PS.register('scanForm', function (a) {
    var max = U.num(a.max, 1, 80, 80);
    var label = labelFn();
    var list = candidates(isField, 400).filter(visible).filter(function (el) {
      return !!(el.closest && el.closest('form')) || !!label(el);
    }).slice(0, max);
    var fields = register(list, function (el, id) {
      var tag = el.tagName.toLowerCase();
      var type = tag === 'input' ? String(el.getAttribute('type') || 'text').toLowerCase() : tag;
      var lab = label(el);
      var ac = String(el.getAttribute('autocomplete') || '').toLowerCase();
      var ml = Number(el.getAttribute('maxlength'));
      var info = {
        id: id, role: roleOf(el), tag: tag, type: type, label: lab, region: regionOf(el),
        disabled: el.hasAttribute('disabled'), required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
        autocomplete: ac.slice(0, 30), inputmode: String(el.getAttribute('inputmode') || '').slice(0, 20),
        pattern: String(el.getAttribute('pattern') || '').slice(0, 60),
        min: String(el.getAttribute('min') || '').slice(0, 20), max: String(el.getAttribute('max') || '').slice(0, 20),
        inViewport: inViewport(el), selectorHint: selectorHint(el),
        sensitive: type === 'password' || SENSITIVE_AUTOCOMPLETE.test(ac) || SENSITIVE_WORDS.test(lab + ' ' + String(el.getAttribute('name') || '')),
      };
      if (isFinite(ml) && ml > 0) info.maxLength = ml;
      if (tag === 'select') info.options = optionTexts(el);
      return info;
    });
    return { fields: fields, scanId: scanId };
  });

  /* ---------- overlay ---------- */

  function reducedMotion() {
    try { return !!(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; }
  }

  function raf(fn) {
    return typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16);
  }

  function position() {
    if (!overlay) return;
    var r = overlay.el.getBoundingClientRect();
    var vw = Number(window.innerWidth) || 0;
    var vh = Number(window.innerHeight) || 0;
    var b = overlay.box.style;
    b.left = Math.max(0, r.left - 3) + 'px';
    b.top = Math.max(0, r.top - 3) + 'px';
    b.width = (r.width + 6) + 'px';
    b.height = (r.height + 6) + 'px';
    var tipH = (overlay.tip.getBoundingClientRect().height) || 56;
    var below = r.top + r.height + 8 + tipH <= vh || r.top - tipH - 8 < 0;
    var t = overlay.tip.style;
    t.top = Math.max(4, below ? r.top + r.height + 8 : r.top - tipH - 8) + 'px';
    t.left = Math.max(8, Math.min(r.left, vw - 288)) + 'px';
  }

  function schedule() {
    if (!overlay || overlay.raf) return;
    overlay.raf = raf(function () { if (overlay) { overlay.raf = 0; position(); } });
  }

  function targetOk(el) {
    return !!el.isConnected && (!el.checkVisibility || el.checkVisibility());
  }

  function guideClear() {
    if (!overlay) return {};
    var o = overlay;
    overlay = null;
    try { window.removeEventListener('scroll', o.onScroll, true); window.removeEventListener('resize', o.onScroll); } catch (e) { /* ignore */ }
    if (o.ro) { try { o.ro.disconnect(); } catch (e) { /* ignore */ } }
    if (o.mo) { try { o.mo.disconnect(); } catch (e) { /* ignore */ } }
    clearTimeout(o.moTimer);
    try { o.box.remove(); o.tip.remove(); } catch (e) { /* ignore */ }
    return {};
  }

  PS.register('guideShow', function (a) {
    var id = U.str(a.elementId, 12);
    var rec = elements.get(id);
    guideClear();
    if (!rec) return { found: false };
    // The panel says which element it means (role and label from ITS scan). If the registry has been replaced by a
    // later scan, this id may now be a different element: refuse rather than outline the wrong thing.
    if (a.expectRole !== undefined && U.str(a.expectRole, 40) !== rec.fp.role) return { found: false };
    if (a.expectLabel !== undefined && U.str(a.expectLabel, 80) !== rec.fp.label) return { found: false };
    var el = rec.el;
    if (!targetOk(el) || !visible(el)) return { found: false };
    // Re-validate against the scan: the element must still be what it was (same role and label).
    var label = labelFn();
    if (roleOf(el) !== rec.fp.role || label(el) !== rec.fp.label) return { found: false };

    var step = U.num(a.step, 1, 99, 1);
    var total = U.num(a.total, 1, 99, 1);
    var caution = !!a.caution;
    var box = document.createElement('div');
    box.className = 'pagesum-ov-target' + (caution ? ' pagesum-ov-warn' : '');
    var tip = document.createElement('div');
    tip.className = 'pagesum-ov-tip' + (caution ? ' pagesum-ov-warn' : '');
    tip.textContent = (caution ? 'Careful. ' : '') + 'Step ' + step + '/' + total + ': ' + U.str(a.text, 300);
    document.documentElement.appendChild(box);
    document.documentElement.appendChild(tip);
    overlay = { el: el, id: id, box: box, tip: tip, raf: 0, ro: null, mo: null, moTimer: 0, onScroll: null, lost: false };
    overlay.onScroll = schedule;

    try { el.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' }); } catch (e) { /* ignore */ }
    position();
    try { window.addEventListener('scroll', overlay.onScroll, { capture: true, passive: true }); } catch (e) { /* ignore */ }
    try { window.addEventListener('resize', overlay.onScroll); } catch (e) { /* ignore */ }
    if (typeof ResizeObserver === 'function') { overlay.ro = new ResizeObserver(schedule); overlay.ro.observe(el); }
    if (typeof MutationObserver === 'function') {
      var o = overlay;
      o.mo = new MutationObserver(function () {
        clearTimeout(o.moTimer);
        o.moTimer = setTimeout(function () {
          if (overlay !== o || o.lost) return;
          if (!targetOk(o.el)) { o.lost = true; PS.emit('guideTargetLost', { elementId: o.id }); } else schedule();
        }, 400);
      });
      o.mo.observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'] });
    }
    return { found: true };
  });

  PS.register('guideClear', guideClear);
  PS.escapables.push({ active: function () { return !!overlay; }, clear: guideClear });
  PS.teardownFns.push(guideClear);
})();
