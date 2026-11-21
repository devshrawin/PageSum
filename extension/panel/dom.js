// Small DOM helpers shared by the panel modules. chrome.* only inside functions.
import { userMessage, GeminiError } from '../lib/errors.js';

export const $ = (id) => document.getElementById(id);

// el('div', { class: 'x', 'aria-label': 'y', text: 'hello' }, child, 'text child')
// Only attributes, textContent and createElement are used: never an HTML string.
export function el(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'text') node.textContent = String(v);
    else if (k === 'class') node.className = String(v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids) {
    if (kid == null || kid === false) continue;
    node.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  }
  return node;
}

let announceTimer = 0;
export function announce(text) {
  const s = $('status');
  if (!s) return;
  s.textContent = '';
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => { s.textContent = text; }, 30);
}

let toastTimer = 0;
export function toast(text) {
  const t = $('toast');
  if (!t) return;
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3000);
}

export async function copyText(text, labelEl, idleLabel) {
  try {
    await navigator.clipboard.writeText(text);
    labelEl.textContent = 'Copied';
  } catch {
    labelEl.textContent = 'Copy failed';
  }
  setTimeout(() => { labelEl.textContent = idleLabel; }, 1500);
}

// opts: { currentModel, onSwitchModel } (switch-to-default is performed by the caller)
export function buildErrorCard(err, onRetry, opts = {}) {
  const e = err instanceof GeminiError ? err : new GeminiError('network', { message: err && err.message });
  const info = userMessage(e, { currentModel: opts.currentModel });
  const card = el('div', { class: 'err-card' }, el('h3', { text: info.title }), el('p', { text: info.body }));
  const actions = el('div', { class: 'actions' });
  const add = (label, fn) => {
    const b = el('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: label });
    b.addEventListener('click', fn);
    actions.appendChild(b);
  };
  for (const a of info.actions) {
    if (a === 'retry' && onRetry) add('Retry', onRetry);
    else if (a === 'settings') add('Settings', () => chrome.runtime.openOptionsPage());
    else if (a === 'switchModel' && opts.onSwitchModel) add('Switch to default model', opts.onSwitchModel);
  }
  if (actions.childElementCount) card.appendChild(actions);
  announce(info.title);
  return card;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICON_PATHS = {
  close: 'M6 6l12 12M18 6L6 18',
  camera: 'M4 8a2 2 0 0 1 2-2h2l1.5-2h5L16 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM12 16a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  info: 'M12 8v.01M11 12h1v4h1M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
};

// Inline 1.5px-stroke SVG icon built with createElementNS (never an HTML string).
export function icon(name, cls = 'i') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', ICON_PATHS[name] || ICON_PATHS.info);
  svg.appendChild(p);
  return svg;
}
