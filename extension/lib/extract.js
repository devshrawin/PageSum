// Injected into the page via chrome.scripting.executeScript({ func }).
// MUST stay fully self-contained: no imports, no references to outer scope.

export function extractPage(opts) {
  const o = opts || {};
  const maxRaw = o.maxRawChars > 0 ? o.maxRawChars : 120000;

  const SKIP_TAGS = new Set('SCRIPT STYLE NOSCRIPT TEMPLATE SVG CANVAS IFRAME FRAME OBJECT EMBED VIDEO AUDIO PICTURE IMG BUTTON SELECT OPTION INPUT TEXTAREA DIALOG'.split(' '));
  const CHROME_TAGS = new Set(['NAV', 'FOOTER', 'ASIDE', 'HEADER', 'FORM']);
  const SKIP_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'complementary', 'search', 'menu', 'menubar', 'toolbar']);
  const BLOCK_TAGS = new Set('P DIV SECTION ARTICLE MAIN BLOCKQUOTE PRE UL OL TABLE FIGCAPTION DD DT HR'.split(' '));
  const NOISE = /\b(cookie|consent|gdpr|newsletter|subscribe|share|social|related|advert|ad-|promo|popup|modal|breadcrumb)\b/i;

  const textLen = (el) => (el.innerText || '').length;

  function isVisible(el) {
    if (el.checkVisibility) return el.checkVisibility({ checkVisibilityCSS: true });
    const cs = getComputedStyle(el);
    return !(cs.display === 'none' || cs.visibility === 'hidden');
  }

  function insideArticle(el) {
    return !!(el.closest && el.closest('article'));
  }

  function shouldSkip(el, root) {
    const tag = (el.tagName || '').toUpperCase();
    if (SKIP_TAGS.has(tag)) return true;
    if (el !== root && CHROME_TAGS.has(tag) && !insideArticle(el)) return true;
    if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true;
    const role = el.getAttribute('role');
    if (role && SKIP_ROLES.has(role.toLowerCase())) return true;
    if (!isVisible(el)) return true;
    const cls = (el.getAttribute('class') || '') + ' ' + (el.id || '');
    if (NOISE.test(cls) && (el.textContent || '').length < 2000) return true;
    return false;
  }

  function collect(root) {
    const parts = [];
    let len = 0;
    const emit = (s) => { parts.push(s); len += s.length; };

    function walk(node) {
      if (len > maxRaw) return;
      if (node.nodeType === 3) {
        emit((node.nodeValue || '').replace(/\s+/g, ' '));
        return;
      }
      if (node.nodeType !== 1) return;
      if (shouldSkip(node, root)) return;
      const tag = node.tagName.toUpperCase();

      if (tag === 'PRE') {
        emit('\n\n```\n' + (node.textContent || '') + '\n```\n\n');
        return;
      }
      if (/^H[1-3]$/.test(tag)) {
        emit('\n\n## ');
        walkChildren(node);
        emit('\n\n');
        return;
      }
      if (/^H[4-6]$/.test(tag)) {
        emit('\n\n### ');
        walkChildren(node);
        emit('\n\n');
        return;
      }
      if (tag === 'BR') { emit('\n'); return; }
      if (tag === 'LI') { emit('\n- '); walkChildren(node); return; }
      if (tag === 'TD' || tag === 'TH') { walkChildren(node); emit(' | '); return; }
      if (tag === 'TR') { walkChildren(node); emit('\n'); return; }
      if (BLOCK_TAGS.has(tag)) {
        emit('\n\n');
        walkChildren(node);
        emit('\n\n');
        return;
      }
      walkChildren(node);
    }
    function walkChildren(el) {
      const kids = el.childNodes;
      for (let i = 0; i < kids.length; i++) {
        if (len > maxRaw) return;
        walk(kids[i]);
      }
    }

    walk(root);
    return parts.join('');
  }

  const selection = String((window.getSelection && window.getSelection()) || '').trim();
  const base = {
    url: location.href,
    title: '',
    lang: document.documentElement.lang || '',
    contentType: document.contentType,
    selectionLength: selection.length,
  };
  let title = (document.title || '').trim();
  if (!title) {
    const h1 = document.querySelector('h1');
    title = h1 ? (h1.textContent || '').trim() : '';
  }
  base.title = title;

  if (!o.ignoreSelection && selection.length >= 40) {
    return { ...base, source: 'selection', text: selection };
  }

  let root = null;
  let source = 'body';

  const articles = Array.from(document.querySelectorAll('article'))
    .map((el) => ({ el, n: textLen(el) }))
    .filter((a) => a.n >= 500)
    .sort((a, b) => b.n - a.n);
  if (articles.length === 1 || (articles.length > 1 && articles[0].n >= 2 * articles[1].n)) {
    root = articles[0].el;
    source = 'article';
  }
  if (!root) {
    const m = document.querySelector('main');
    if (m && textLen(m) >= 500) { root = m; source = 'main'; }
    else {
      const rm = document.querySelector('[role="main"]');
      if (rm && textLen(rm) >= 500) { root = rm; source = 'main'; }
    }
  }
  if (!root) root = document.body;

  let text = collect(root);
  if (text.trim().length < 200 && root !== document.body) {
    root = document.body;
    source = 'body';
    text = collect(root);
  }

  return { ...base, source, text };
}
