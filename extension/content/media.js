// PageSum page agent: media helpers (phase 2). CLASSIC script, runs after core.js.
// Reads video info and the visible transcript panel, seeks the player, fetches the page's own PDF, and measures
// how visual a page is. Two writes are allowed here and nowhere else in content/: the video's currentTime (seek),
// and the single fetch(location.href) for a same-origin PDF.
(function () {
  'use strict';
  var PS = globalThis.__PageSum;
  if (!PS || PS.v !== 2 || PS.mediaLoaded) return;
  PS.mediaLoaded = true;
  var U = PS.util;

  function findVideo() {
    var v = document.querySelector('video');
    return v || null;
  }

  function finiteDuration(v) {
    var d = Number(v.duration);
    return isFinite(d) && d > 0 ? d : 0;       // NaN before metadata loads, Infinity for live streams
  }

  PS.register('videoInfo', function () {
    var v = findVideo();
    if (!v) return null;
    return { duration: finiteDuration(v), currentTime: Number(v.currentTime) || 0, title: U.str(document.title, 200) };
  });

  PS.register('seek', function (a) {
    var v = findVideo();
    if (!v) return {};
    var sec = U.num(a.seconds, 0, 86400, 0);
    var d = finiteDuration(v);
    if (d > 0) sec = Math.min(sec, d);
    v.currentTime = sec;
    return {};
  });

  // Visible rows of YouTube's transcript panel: [{ t: '1:23', text }]. The panel must be open (the user does that).
  PS.register('readTranscriptPanel', function () {
    var rows = document.querySelectorAll('ytd-transcript-segment-renderer');
    var segments = [];
    for (var i = 0; i < rows.length && segments.length < 4000; i++) {
      var ts = rows[i].querySelector('.segment-timestamp');
      var tx = rows[i].querySelector('.segment-text');
      var t = ts ? U.collapse(ts.textContent || '').trim() : '';
      var text = tx ? U.collapse(tx.textContent || '').trim() : '';
      if (t && text) segments.push({ t: t.slice(0, 12), text: text.slice(0, 400) });
    }
    return { segments: segments };
  });

  function toBase64(u8) {
    var out = '';
    var STEP = 0x8000;
    for (var i = 0; i < u8.length; i += STEP) out += String.fromCharCode.apply(null, u8.subarray(i, i + STEP));
    return btoa(out);
  }

  // Same-origin fetch of the document the tab is showing (used when the panel cannot fetch the PDF itself).
  PS.register('fetchSelfPdf', function (a) {
    var max = U.num(a.maxBytes, 1, 100 * 1024 * 1024, 20 * 1024 * 1024);
    return fetch(location.href, { credentials: 'same-origin' }).then(function (res) {
      if (!res.ok) throw new Error('http ' + res.status);
      var len = Number(res.headers && res.headers.get ? res.headers.get('content-length') : 0);
      if (len > max) return { tooLarge: true, bytes: len };
      return res.arrayBuffer().then(function (buf) {
        if (buf.byteLength > max) return { tooLarge: true, bytes: buf.byteLength };
        return { base64: toBase64(new Uint8Array(buf)), bytes: buf.byteLength };
      });
    });
  });

  function visibleArea(el, vw, vh) {
    var r = el.getBoundingClientRect();
    var x0 = Math.max(0, r.left);
    var y0 = Math.max(0, r.top);
    var x1 = Math.min(vw, r.left + r.width);
    var y1 = Math.min(vh, r.top + r.height);
    return x1 > x0 && y1 > y0 ? (x1 - x0) * (y1 - y0) : 0;
  }

  function areaOf(selector, vw, vh) {
    var list = document.querySelectorAll(selector);
    var sum = 0;
    for (var i = 0; i < list.length && i < 200; i++) {
      var el = list[i];
      if (el.checkVisibility && !el.checkVisibility()) continue;
      sum += visibleArea(el, vw, vh);
    }
    return Math.round(sum);
  }

  // How visual is this page? Used to offer a screenshot when there is little readable text (spec 8.8).
  PS.register('visualHints', function () {
    var vw = Number(window.innerWidth) || 0;
    var vh = Number(window.innerHeight) || 0;
    var textChars = document.body ? U.collapse(document.body.innerText || '').trim().length : 0;
    // share of the first 300 text nodes whose computed font size is under 9px
    var seen = 0;
    var tiny = 0;
    (function w(n) {
      if (seen >= 300) return;
      if (n.nodeType === 3) {
        if (!/\S/.test(n.nodeValue || '')) return;
        seen++;
        var p = n.parentElement || n.parentNode;
        var size = NaN;
        try { size = parseFloat(getComputedStyle(p).fontSize); } catch (e) { size = NaN; }
        if (isFinite(size) && size < 9) tiny++;
        return;
      }
      if (n.nodeType !== 1) return;
      var tag = n.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return;
      if (n.checkVisibility && !n.checkVisibility()) return;
      for (var i = 0; i < n.childNodes.length; i++) w(n.childNodes[i]);
    })(document.body || document.documentElement);
    return {
      textChars: textChars,
      canvasArea: areaOf('canvas', vw, vh),
      imgArea: areaOf('img, video, svg', vw, vh),
      viewportArea: vw * vh,
      tinyTextRatio: seen ? tiny / seen : 0,
    };
  });
})();
