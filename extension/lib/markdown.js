// Minimal, XSS-safe markdown: parse to a JSON AST, build DOM with createElement/textContent only.
import { parseCiteToken, numberCitations } from './citations.js';

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

export function parseInline(src, opts) {
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

    if (ch === '[' && opts && opts.cite) {
      const tok = parseCiteToken(src, i);
      if (tok) { flush(); out.push({ t: 'cite', ids: tok.ids }); i = tok.end; continue; }
    }

    if (ch === '[') {
      const j = src.indexOf('](', i + 1);
      if (j > i) {
        const k = matchParen(src, j + 1);
        if (k > j) {
          const label = src.slice(i + 1, j);
          const href = safeHref(src.slice(j + 2, k).trim());
          if (href) { flush(); out.push({ t: 'link', href, c: parseInline(label, opts) }); }
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
      if (j > i + 2) { flush(); out.push({ t: 'strong', c: parseInline(src.slice(i + 2, j), opts) }); i = j + 2; continue; }
      buf += mk; i += 2; continue;
    }

    if (ch === '*' && src[i + 1] && !/\s/.test(src[i + 1])) {
      const j = findSingle(src, '*', i + 1);
      if (j > i + 1) { flush(); out.push({ t: 'em', c: parseInline(src.slice(i + 1, j), opts) }); i = j + 1; continue; }
    }

    if (ch === '_' && !isAlnum(src[i - 1]) && src[i + 1] && !/\s/.test(src[i + 1]) && src[i + 1] !== '_') {
      const j = findClosingUnderscore(src, i + 1);
      if (j > i + 1) { flush(); out.push({ t: 'em', c: parseInline(src.slice(i + 1, j), opts) }); i = j + 1; continue; }
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

export function parseMarkdown(src, opts) {
  const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  let list = null;
  const flushPara = () => {
    if (para.length) { blocks.push({ t: 'p', c: parseInline(para.join(' '), opts) }); para = []; }
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
      blocks.push({ t: 'h', level: m[1].length <= 2 ? 3 : 4, c: parseInline(m[2].trim(), opts) });
      continue;
    }
    m = RE_UL.exec(line);
    if (m) {
      flushPara();
      if (!list || list.t !== 'ul') { flushList(); list = { t: 'ul', items: [] }; }
      list.items.push(parseInline(m[1], opts));
      continue;
    }
    m = RE_OL.exec(line);
    if (m) {
      flushPara();
      if (!list || list.t !== 'ol') { flushList(); list = { t: 'ol', items: [] }; }
      list.items.push(parseInline(m[1], opts));
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushPara(); flushList();
  return blocks;
}

// Collects, in render order, the kept ids of every cite node. resolve(id) -> { text } | falsy.
function collectCites(nodes, resolve, out) {
  for (const n of nodes) {
    if (n.t === 'cite') {
      n.kept = n.ids.filter((id) => resolve(id));
      if (n.kept.length) out.push(n.kept);
    } else if (n.c) collectCites(n.c, resolve, out);
  }
}

function walkBlocks(blocks, resolve) {
  const lists = [];
  for (const b of blocks) {
    if (b.c) collectCites(b.c, resolve, lists);
    if (b.items) for (const it of b.items) collectCites(it, resolve, lists);
  }
  return lists;
}

function appendInline(nodes, doc, parent, ctx) {
  for (const n of nodes) {
    if (n.t === 'text') parent.appendChild(doc.createTextNode(n.v));
    else if (n.t === 'code') {
      const c = doc.createElement('code');
      c.textContent = n.v;
      parent.appendChild(c);
    } else if (n.t === 'strong' || n.t === 'em') {
      const e = doc.createElement(n.t);
      appendInline(n.c, doc, e, ctx);
      parent.appendChild(e);
    } else if (n.t === 'link') {
      const a = doc.createElement('a');
      a.setAttribute('href', n.href);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      appendInline(n.c, doc, a, ctx);
      parent.appendChild(a);
    } else if (n.t === 'cite' && ctx) {
      // Unknown ids were dropped in the pre-pass; a node with none left renders nothing.
      if (!n.kept || !n.kept.length) continue;
      const sup = doc.createElement('sup');
      sup.setAttribute('class', 'cites');
      for (const id of n.kept) {
        const info = ctx.resolve(id) || {};
        const passage = String(info.text || '').replace(/\s+/g, ' ').trim();
        const num = ctx.numbers.get(id);
        const b = doc.createElement('button');
        b.setAttribute('type', 'button');
        b.setAttribute('class', 'cite');
        b.setAttribute('data-cite', id);
        b.setAttribute('aria-label', `Source ${num}: ${passage.slice(0, 60)}`);
        b.setAttribute('title', passage.slice(0, 160));
        b.textContent = String(num);
        sup.appendChild(b);
      }
      parent.appendChild(sup);
    }
  }
}

// opts.resolveCite (id -> { text } | falsy) turns citation parsing on. Without it, "[c1]" stays plain text.
export function renderMarkdown(src, doc, opts) {
  const resolve = opts && typeof opts.resolveCite === 'function' ? opts.resolveCite : null;
  const blocks = parseMarkdown(src, resolve ? { cite: true } : undefined);
  const ctx = resolve ? { resolve, numbers: numberCitations(walkBlocks(blocks, resolve)) } : null;
  const frag = doc.createDocumentFragment();
  for (const b of blocks) {
    if (b.t === 'p') {
      const p = doc.createElement('p');
      appendInline(b.c, doc, p, ctx);
      frag.appendChild(p);
    } else if (b.t === 'h') {
      const h = doc.createElement(b.level === 3 ? 'h3' : 'h4');
      appendInline(b.c, doc, h, ctx);
      frag.appendChild(h);
    } else if (b.t === 'ul' || b.t === 'ol') {
      const l = doc.createElement(b.t);
      for (const item of b.items) {
        const li = doc.createElement('li');
        appendInline(item, doc, li, ctx);
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
