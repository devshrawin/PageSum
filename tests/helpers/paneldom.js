// A small DOM for exercising the side panel UI modules in Node: elements are created for every id found in
// sidepanel.html (with their classes, attributes and nesting ignored), and createElement gives free-standing nodes.
// It implements only what the panel code uses.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension', 'sidepanel.html');

export class FakeEl {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.nodeType = 1;
    this.attrs = {};
    this.children = [];
    this.parentNode = null;
    this.listeners = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this._text = '';
    this.className = '';
    this.focused = false;
  }
  get classList() {
    const self = this;
    const list = () => String(self.className).split(/\s+/).filter(Boolean);
    return {
      add: (...c) => { self.className = [...new Set([...list(), ...c])].join(' '); },
      remove: (...c) => { self.className = list().filter((x) => !c.includes(x)).join(' '); },
      contains: (c) => list().includes(c),
    };
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k === 'class') this.className = String(v);
    if (k === 'hidden') this.hidden = true;
    if (k === 'value') this.value = String(v);
  }
  getAttribute(k) { return k === 'class' ? (this.className || null) : (k in this.attrs ? this.attrs[k] : null); }
  hasAttribute(k) { return k in this.attrs; }
  removeAttribute(k) { delete this.attrs[k]; }
  get tabIndex() { return Number(this.attrs.tabindex ?? 0); }
  set tabIndex(v) { this.attrs.tabindex = String(v); }
  get dataset() { return new Proxy({}, { get: (_, k) => this.attrs['data-' + String(k).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())] }); }
  get childElementCount() { return this.children.filter((c) => c.nodeType === 1).length; }
  get textContent() { return this._text + this.children.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join(''); }
  set textContent(v) { this.children = []; this._text = String(v == null ? '' : v); }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  append(...kids) { for (const k of kids) this.appendChild(typeof k === 'string' ? new FakeText(k) : k); }
  replaceChildren(...kids) { this.children.forEach((c) => { c.parentNode = null; }); this.children = []; this._text = ''; this.append(...kids); }
  insertBefore(n, ref) {
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(n); else this.children.splice(i, 0, n);
    return n;
  }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); }
  // Runs the listeners of this element, then bubbles up (stopPropagation honoured).
  fire(type, ev = {}) {
    const e = { type, target: ev.target || this, key: ev.key, preventDefault() {}, stopped: false, ...ev };
    e.stopPropagation = () => { e.stopped = true; };
    for (let n = this; n && !e.stopped; n = n.parentNode) {
      e.currentTarget = n;
      for (const fn of (n.listeners && n.listeners[type]) || []) fn(e);
    }
    return e;
  }
  click() { return this.fire('click'); }
  focus() { this.focused = true; }
  matches(sel) {
    return sel.split(',').some((part) => {
      const m = /^([a-zA-Z][\w-]*)?((?:\.[\w-]+|\[[^\]]+\]|#[\w-]+)*)$/.exec(part.trim());
      if (!m) return false;
      if (m[1] && this.tagName !== m[1].toUpperCase()) return false;
      for (const p of m[2].match(/\.[\w-]+|\[[^\]]+\]|#[\w-]+/g) || []) {
        if (p[0] === '.') { if (!this.classList.contains(p.slice(1))) return false; }
        else if (p[0] === '#') { if (this.attrs.id !== p.slice(1)) return false; }
        else {
          const a = /^\[([\w:-]+)(?:=(?:"([^"]*)"|([^\]]*)))?\]$/.exec(p);
          if (!(a[1] in this.attrs) && !(a[1] === 'hidden' && this.hidden)) return false;
          const v = a[2] ?? a[3];
          if (v !== undefined && this.attrs[a[1]] !== v) return false;
        }
      }
      return true;
    });
  }
  closest(sel) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (n.matches(sel)) return n; return null; }
  querySelectorAll(sel) {
    const out = [];
    (function w(n) { for (const c of n.children) { if (c.nodeType !== 1) continue; if (c.matches(sel)) out.push(c); w(c); } })(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 20 }; }
}

export class FakeText {
  constructor(d) { this.nodeType = 3; this.data = String(d); this.parentNode = null; }
  get textContent() { return this.data; }
}

// Installs globalThis.document, requestAnimationFrame, confirm, URL.createObjectURL tracking and navigator.clipboard.
export function installPanelDom() {
  const ids = new Map();
  const doc = {
    createElement: (t) => new FakeEl(t),
    createElementNS: (ns, t) => new FakeEl(t),
    createTextNode: (d) => new FakeText(d),
    createDocumentFragment: () => new FakeEl('#fragment'),
    getElementById: (id) => ids.get(id) || null,
    body: new FakeEl('body'),
    listeners: {},
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
  };
  const html = fs.readFileSync(HTML, 'utf8');
  for (const m of html.matchAll(/<(\w+)([^>]*?)>/g)) {
    const idm = / id="([^"]+)"/.exec(m[2]);
    if (!idm) continue;
    const e = new FakeEl(m[1]);
    e.attrs.id = idm[1];
    if (/\shidden(\s|$|=)/.test(m[2])) e.hidden = true;
    const role = /role="([^"]+)"/.exec(m[2]);
    if (role) e.attrs.role = role[1];
    const sel = /aria-selected="([^"]+)"/.exec(m[2]);
    if (sel) e.attrs['aria-selected'] = sel[1];
    const ti = /tabindex="([^"]+)"/.exec(m[2]);
    if (ti) e.attrs.tabindex = ti[1];
    const nm = /name="([^"]+)"/.exec(m[2]);
    if (nm) e.attrs.name = nm[1];
    const val = /\svalue="([^"]*)"/.exec(m[2]);
    if (val) e.value = val[1];
    ids.set(idm[1], e);
  }
  const clipboard = { text: null, async writeText(t) { clipboard.text = t; } };
  const saved = {};
  for (const [k, v] of Object.entries({ document: doc, requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: (n) => clearTimeout(n), confirm: () => true, getComputedStyle: () => ({ lineHeight: '20px' }) })) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  saved.navigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard }, configurable: true, writable: true });
  return {
    doc, ids, clipboard, $: (id) => ids.get(id),
    uninstall() {
      for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
    },
  };
}

// Finds nodes in a rendered subtree by class and/or text.
export function findAll(root, pred) {
  const out = [];
  (function w(n) { for (const c of n.children || []) { if (c.nodeType === 1 && pred(c)) out.push(c); if (c.nodeType === 1) w(c); } })(root);
  return out;
}
export const byClass = (root, cls) => findAll(root, (n) => n.classList.contains(cls));
export const byText = (root, re) => findAll(root, (n) => re.test(n.textContent));
