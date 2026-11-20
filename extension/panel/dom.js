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
    const b = el('button', { type: 'button', class: 'btn', text: label });
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
