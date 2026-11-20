// Minimal, XSS-safe markdown: parse to a JSON AST, build DOM with createElement/textContent only.

const isAlnum = (c) => !!c && /[A-Za-z0-9]/.test(c);

function findSingle(src, ch, from) {
  // closing single marker that is not part of a doubled marker
  for (let k = from; k < src.length; k++) {
    if (src[k] === ch) {
      if (src[k + 1] === ch) { k++; continue; }
      return k;
    }
  }
  return -1;
}

function findClosingUnderscore(src, from) {
  for (let k = from; k < src.length; k++) {
    if (src[k] === '_' && !isAlnum(src[k + 1]) && src[k + 1] !== '_' && k > from) return k;
  }
  return -1;
}

function matchParen(src, open) {
  // src[open] === '('; returns index of the matching ')' or -1
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '(') depth++;
    else if (src[k] === ')') { depth--; if (depth === 0) return k; }
  }
  return -1;
}

function safeHref(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch { return null; }
}

export function parseInline(src) {
  const out = [];
  let buf = '';
  let i = 0;
  const flush = () => { if (buf) { out.push({ t: 'text', v: buf }); buf = ''; } };

  while (i < src.length) {
    const ch = src[i];

    if (ch === '`') {
      const j = src.indexOf('`', i + 1);
      if (j > i + 1) { flush(); out.push({ t: 'code', v: src.slice(i + 1, j) }); i = j + 1; continue; }
      buf += ch; i++; continue;
    }

    if (ch === '[') {
      const j = src.indexOf('](', i + 1);
      if (j > i) {
        const k = matchParen(src, j + 1);
        if (k > j) {
          const label = src.slice(i + 1, j);
          const href = safeHref(src.slice(j + 2, k).trim());
          if (href) { flush(); out.push({ t: 'link', href, c: parseInline(label) }); }
          else buf += label;
          i = k + 1;
          continue;
        }
      }
      buf += ch; i++; continue;
    }

    if ((src.startsWith('**', i)) || (src.startsWith('__', i) && !isAlnum(src[i - 1]))) {
      const mk = src.substr(i, 2);
      const j = src.indexOf(mk, i + 2);
      if (j > i + 2) { flush(); out.push({ t: 'strong', c: parseInline(src.slice(i + 2, j)) }); i = j + 2; continue; }
      buf += mk; i += 2; continue;
    }

    if (ch === '*' && src[i + 1] && !/\s/.test(src[i + 1])) {
      const j = findSingle(src, '*', i + 1);
      if (j > i + 1) { flush(); out.push({ t: 'em', c: parseInline(src.slice(i + 1, j)) }); i = j + 1; continue; }
    }

    if (ch === '_' && !isAlnum(src[i - 1]) && src[i + 1] && !/\s/.test(src[i + 1]) && src[i + 1] !== '_') {
      const j = findClosingUnderscore(src, i + 1);
      if (j > i + 1) { flush(); out.push({ t: 'em', c: parseInline(src.slice(i + 1, j)) }); i = j + 1; continue; }
    }

    buf += ch;
    i++;
  }
  flush();
  return out;
}

const RE_FENCE = /^\s*```/;
const RE_HEAD = /^(#{1,6})\s+(.*)$/;
const RE_UL = /^\s*[-*+]\s+(.*)$/;
const RE_OL = /^\s*\d+[.)]\s+(.*)$/;

export function parseMarkdown(src) {
  const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  let list = null;
  const flushPara = () => {
    if (para.length) { blocks.push({ t: 'p', c: parseInline(para.join(' ')) }); para = []; }
  };
  const flushList = () => { if (list) { blocks.push(list); list = null; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (RE_FENCE.test(line)) {
      flushPara(); flushList();
      const code = [];
      i++;
      while (i < lines.length && !RE_FENCE.test(lines[i])) { code.push(lines[i]); i++; }
      blocks.push({ t: 'pre', v: code.join('\n') });
      continue;
    }
    if (line.trim() === '') { flushPara(); flushList(); continue; }
    let m = RE_HEAD.exec(line);
    if (m) {
      flushPara(); flushList();
      blocks.push({ t: 'h', level: m[1].length <= 2 ? 3 : 4, c: parseInline(m[2].trim()) });
      continue;
    }
    m = RE_UL.exec(line);
    if (m) {
      flushPara();
      if (!list || list.t !== 'ul') { flushList(); list = { t: 'ul', items: [] }; }
      list.items.push(parseInline(m[1]));
      continue;
    }
    m = RE_OL.exec(line);
    if (m) {
      flushPara();
      if (!list || list.t !== 'ol') { flushList(); list = { t: 'ol', items: [] }; }
      list.items.push(parseInline(m[1]));
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushPara(); flushList();
  return blocks;
}

function appendInline(nodes, doc, parent) {
  for (const n of nodes) {
    if (n.t === 'text') parent.appendChild(doc.createTextNode(n.v));
    else if (n.t === 'code') {
      const c = doc.createElement('code');
      c.textContent = n.v;
      parent.appendChild(c);
    } else if (n.t === 'strong' || n.t === 'em') {
      const e = doc.createElement(n.t);
      appendInline(n.c, doc, e);
      parent.appendChild(e);
    } else if (n.t === 'link') {
      const a = doc.createElement('a');
      a.setAttribute('href', n.href);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      appendInline(n.c, doc, a);
      parent.appendChild(a);
    }
  }
}

export function renderMarkdown(src, doc) {
  const frag = doc.createDocumentFragment();
  for (const b of parseMarkdown(src)) {
    if (b.t === 'p') {
      const p = doc.createElement('p');
      appendInline(b.c, doc, p);
      frag.appendChild(p);
    } else if (b.t === 'h') {
      const h = doc.createElement(b.level === 3 ? 'h3' : 'h4');
      appendInline(b.c, doc, h);
      frag.appendChild(h);
    } else if (b.t === 'ul' || b.t === 'ol') {
      const l = doc.createElement(b.t);
      for (const item of b.items) {
        const li = doc.createElement('li');
        appendInline(item, doc, li);
        l.appendChild(li);
      }
      frag.appendChild(l);
    } else if (b.t === 'pre') {
      const pre = doc.createElement('pre');
      const code = doc.createElement('code');
      code.textContent = b.v;
      pre.appendChild(code);
      frag.appendChild(pre);
    }
  }
  return frag;
}
