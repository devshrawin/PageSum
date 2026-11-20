// A tiny fake DOM plus a vm sandbox for running the classic content scripts (extension/content/*.js).
// Scripts run in a fresh vm context with no module scope, which also proves they are self-contained.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTENT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension', 'content');

// Results come from another realm: round-trip through JSON so deepEqual works.
export const plain = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

export function t(v) {
  const n = {
    nodeType: 3,
    nodeValue: v,
    parentNode: null,
    get parentElement() { return this.parentNode; },
    get isConnected() { return isConnected(this); },
  };
  return n;
}

function isConnected(node) {
  for (let n = node; n; n = n.parentNode) if (n._isRoot) return true;
  return false;
}

export function el(tag, attrs = {}, ...kids) {
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    attrs,
    id: attrs.id || '',
    parentNode: null,
    style: {},
    scrolled: [],
    childNodes: [],
    get parentElement() { return this.parentNode; },
    get isConnected() { return isConnected(this); },
    getAttribute(n) { return n in attrs ? String(attrs[n]) : null; },
    hasAttribute(n) { return n in attrs; },
    get textContent() { return this.childNodes.map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join(''); },
    get innerText() { return this.textContent; },
    closest(sel) {
      for (let n = this; n; n = n.parentNode) if (n.nodeType === 1 && n.tagName === sel.toUpperCase()) return n;
      return null;
    },
    checkVisibility() { return !attrs.__invisible; },
    getBoundingClientRect() { return attrs.__rect || { left: 0, top: 0, width: 100, height: 20 }; },
    scrollIntoView(o) { this.scrolled.push(o); },
    appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c; },
    remove() {
      if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter((c) => c !== this);
      this.parentNode = null;
    },
  };
  for (const k of kids) node.appendChild(typeof k === 'string' ? t(k) : k);
  return node;
}

export function descendants(root, tag) {
  const out = [];
  (function w(n) {
    if (n.nodeType !== 1) return;
    if (n.tagName === tag.toUpperCase()) out.push(n);
    n.childNodes.forEach(w);
  })(root);
  return out;
}

function textNodesIn(root) {
  const out = [];
  (function w(n) {
    if (n.nodeType === 3) out.push(n);
    else (n.childNodes || []).forEach(w);
  })(root);
  return out;
}

function containsText(node, set) {
  if (node.nodeType === 3) return set.has(node);
  return (node.childNodes || []).some((c) => containsText(c, set));
}

// selection: { startNode, startOffset, endNode, endOffset } (both nodes are text nodes), text: its string form.
export function makeEnv({
  body, title = 'Doc title', selection = null, href = 'https://example.com/a', reduced = true,
  highlightApi = true, runtimeId = 'ext-id', hasNavigation = false,
} = {}) {
  const html = el('html', { lang: 'en' });
  html._isRoot = true;
  html.lang = 'en';
  html.appendChild(body);
  const sent = [];
  const listeners = {};
  const highlights = new Map();
  const ranges = [];

  const document = {
    title,
    contentType: 'text/html',
    documentElement: html,
    body,
    querySelectorAll(sel) { return sel === 'article' ? descendants(body, 'article') : []; },
    querySelector(sel) {
      if (sel === 'main') return descendants(body, 'main')[0] || null;
      if (sel === 'h1') return descendants(body, 'h1')[0] || null;
      if (sel === 'input[type="password"]') return descendants(body, 'input').find((i) => i.attrs.type === 'password') || null;
      return null;
    },
    createElement(tag) { return el(tag); },
    createRange() {
      const r = {
        startContainer: null, startOffset: 0, endContainer: null, endOffset: 0,
        setStart(n, o) { this.startContainer = n; this.startOffset = o; },
        setEnd(n, o) { this.endContainer = n; this.endOffset = o; },
        getBoundingClientRect() { return r.rect || { left: 10, top: 20, width: 120, height: 18 }; },
      };
      ranges.push(r);
      return r;
    },
  };

  let selObj = { toString: () => '', rangeCount: 0, getRangeAt() { return null; } };
  if (selection) {
    const all = textNodesIn(body);
    const a = all.indexOf(selection.startNode);
    const b = all.indexOf(selection.endNode);
    const inSel = new Set(all.slice(a, b + 1));
    let common = selection.startNode;
    if (selection.startNode !== selection.endNode) {
      const anc = new Set();
      for (let n = selection.startNode; n; n = n.parentNode) anc.add(n);
      for (let n = selection.endNode; n; n = n.parentNode) if (anc.has(n)) { common = n; break; }
    }
    const range = {
      startContainer: selection.startNode, startOffset: selection.startOffset,
      endContainer: selection.endNode, endOffset: selection.endOffset,
      commonAncestorContainer: common,
      intersectsNode(n) { return containsText(n, inSel); },
    };
    selObj = { toString: () => selection.text, rangeCount: 1, getRangeAt: () => range };
  }

  class Highlight { constructor(...r) { this.ranges = r; } }

  const sandbox = {
    document,
    location: { href },
    chrome: { runtime: { id: runtimeId, sendMessage(m) { sent.push(m); return Promise.resolve(); } } },
    CSS: highlightApi ? { highlights } : {},
    matchMedia: () => ({ matches: reduced }),
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    setTimeout, clearTimeout,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
    getSelection: () => selObj,
  };
  if (highlightApi) sandbox.Highlight = Highlight;
  if (hasNavigation) {
    sandbox.navigation = {
      addEventListener(type, fn) { (listeners['nav:' + type] = listeners['nav:' + type] || []).push(fn); },
      removeEventListener(type, fn) { listeners['nav:' + type] = (listeners['nav:' + type] || []).filter((f) => f !== fn); },
    };
  }
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);

  const env = {
    ctx, sandbox, document, sent, listeners, highlights, ranges, html, body,
    load(files = ['core.js', 'extract.js', 'highlight.js']) {
      for (const f of files) vm.runInContext(fs.readFileSync(path.join(CONTENT_DIR, f), 'utf8'), ctx, { filename: f });
      return env;
    },
    call(name, args) { return plain(ctx.__PageSum.call(name, args)); },
    get PS() { return ctx.__PageSum; },
    fire(type, ev) { for (const fn of (listeners[type] || []).slice()) fn(ev); },
  };
  return env;
}

export function fnSource(code, name) {
  // Returns the full text of `function name(...) { ... }` by brace matching (strings and regexes here contain no unbalanced braces).
  const start = code.indexOf(`function ${name}(`);
  if (start < 0) return null;
  const open = code.indexOf('{', code.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') { depth--; if (depth === 0) return code.slice(start, i + 1); }
  }
  return null;
}
