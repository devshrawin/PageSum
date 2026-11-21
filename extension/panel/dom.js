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
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
  checklist: 'M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2',
  mail: 'M4 6h16v12H4zM4 7l8 6 8-6',
  cap: 'M3 9l9-4 9 4-9 4zM7 11v5c0 1 2.2 2.5 5 2.5s5-1.5 5-2.5v-5',
  table: 'M4 5h16v14H4zM4 10h16M10 5v14',
  form: 'M6 4h12v16H6zM9 9h6M9 13h6M9 17h3',
  eye: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  compass: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM15.5 8.5l-2 5-5 2 2-5z',
  columns: 'M4 5h7v14H4zM13 5h7v14h-7z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10 11v6M14 11v6',
  download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
  back: 'M15 6l-6 6 6 6',
  next: 'M9 6l6 6-6 6',
  check: 'M5 12l5 5 9-10',
  copy: 'M9 9h11v11H9zM5 15V5a1 1 0 0 1 1-1h10',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 12h.01',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
  file: 'M7 3h7l5 5v13H7zM14 3v5h5',
  save: 'M5 4h12l2 2v14H5zM8 4v5h7V4M8 20v-6h8v6',
  play: 'M8 5l11 7-11 7z',
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
