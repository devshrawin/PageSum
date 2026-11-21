// Compare tab (spec section 11). Optional permissions are requested at runtime, inside the click that needs them:
// "tabs" (to list tab titles) on Choose tabs, then the chosen sites on Compare. Always usable, even when the
// current tab can't be read.
import { $, el, announce, toast, buildErrorCard } from './dom.js';
import { app, shownState } from './tabs.js';
import { callAgent, ensureAgent } from './agent.js';
import { MAX_COMPARE_TABS, selectableTabs, originsFor, runCompare, compareTable, locateCite, hostOfTab } from './comparerun.js';
import { citeGroup, exportButtons } from './tools.js';
import { chunkResolver } from '../lib/citations.js';
import { GeminiError, redactKey } from '../lib/errors.js';

const S = { tabs: [], selected: new Set(), phase: 'idle', result: null, rows: [], message: '', error: null, ctrl: null };

const asError = (err) => {
  if (err instanceof GeminiError) return err;
  console.error(redactKey(String((err && err.message) || err)));
  return new GeminiError('network', { message: err && err.message });
};

function renderTabList() {
  const box = $('compareTabs');
  box.hidden = !S.tabs.length;
  box.replaceChildren();
  const full = S.selected.size >= MAX_COMPARE_TABS;
  for (const tab of S.tabs) {
    const input = el('input', { type: 'checkbox', 'data-tab-id': String(tab.id) });
    input.checked = S.selected.has(tab.id);
    input.disabled = full && !S.selected.has(tab.id);
    input.addEventListener('change', () => {
      if (input.checked) S.selected.add(tab.id); else S.selected.delete(tab.id);
      renderCompare();
    });
    box.appendChild(el('label', { class: 'compare-tab' }, input, el('span', { class: 'compare-tab-text' },
      el('span', { class: 'compare-tab-title', text: tab.title || tab.url }), el('span', { class: 'compare-tab-host', text: hostOfTab(tab) }))));
  }
}

function resultNode() {
  const r = S.result;
  const wrap = el('div', { class: 'tool-result' });
  const resolve = chunkResolver(r.tabs.flatMap((t) => t.chunks));
  const table = el('table', { class: 'data-table' });
  table.appendChild(el('thead', {}, el('tr', {},
    el('th', { scope: 'col', text: 'Criterion' }),
    ...r.tabs.map((t) => el('th', { scope: 'col' }, el('span', { text: t.title || t.key }), el('br'), el('span', { class: 'chip', text: t.host || '' }))))));
  const tbody = el('tbody');
  for (const c of r.criteria) {
    tbody.appendChild(el('tr', {}, el('th', { scope: 'row', text: c.name }),
      ...c.values.map((v) => el('td', {}, el('span', { text: v.value == null ? '-' : v.value }), ' ', citeGroup(v.sources, resolve)))));
  }
  table.appendChild(tbody);
  wrap.appendChild(el('div', { class: 'data-wrap' }, table));
  wrap.appendChild(el('p', { text: r.summary }));
  if (r.verdict) wrap.appendChild(el('p', {}, el('b', { text: 'Verdict: ' }), r.verdict));
  const t = compareTable(r);
  wrap.appendChild(exportButtons(t.columns, t.rows));
  return wrap;
}

export function renderCompare() {
  const have = S.tabs.length > 0;
  const running = S.phase === 'running';
  $('compareChoose').textContent = have ? 'Refresh tab list' : 'Choose tabs';
  $('compareChoose').disabled = running;
  renderTabList();
  $('compareFocusBox').hidden = !have;
  $('compareRun').hidden = !have || running;
  $('compareRun').disabled = S.selected.size < 2;
  $('compareStop').hidden = !running;

  const out = $('compareResult');
  out.replaceChildren();
  if (running) out.appendChild(el('div', { class: 'status' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), el('span', { text: 'Reading tabs and comparing...' })));
  if (S.message) out.appendChild(el('p', { class: 'hint', text: S.message }));
  for (const row of S.rows.filter((r) => !r.ok)) out.appendChild(el('p', { class: 'row-error' }, el('b', { text: (row.tab.title || row.tab.url) + ': ' }), row.error));
  if (S.error) out.appendChild(buildErrorCard(S.error, () => runNow(), { currentModel: app.settings && app.settings.model }));
  if (S.result && S.phase === 'done') out.appendChild(resultNode());
}

async function chooseTabs() {
  // chrome.permissions.request needs the click's user gesture, so it comes first.
  let granted = false;
  try { granted = await chrome.permissions.request({ permissions: ['tabs'] }); } catch { granted = false; }
  if (!granted) { S.message = 'PageSum needs permission to see the tab list to choose tabs.'; renderCompare(); return; }
  S.message = '';
  const all = await chrome.tabs.query({ windowId: app.windowId });
  S.tabs = selectableTabs(all);
  const current = shownState();
  S.selected = new Set(current && S.tabs.some((t) => t.id === current.tabId) ? [current.tabId] : []);
  renderCompare();
}

async function runNow() {
  const chosen = S.tabs.filter((t) => S.selected.has(t.id)).slice(0, MAX_COMPARE_TABS);
  if (chosen.length < 2) return;
  S.error = null;
  S.message = '';
  S.rows = [];
  // One prompt, in the gesture, for every site not granted yet.
  const missing = [];
  for (const o of originsFor(chosen)) {
    let has = false;
    try { has = await chrome.permissions.contains({ origins: [o] }); } catch { has = false; }
    if (!has) missing.push(o);
  }
  if (missing.length) {
    let ok = false;
    try { ok = await chrome.permissions.request({ origins: missing }); } catch { ok = false; }
    if (!ok) { S.message = 'PageSum needs access to those sites to compare them.'; renderCompare(); return; }
  }
  S.phase = 'running';
  S.result = null;
  S.ctrl = new AbortController();
  renderCompare();
  const ctrl = S.ctrl;
  try {
    const { rows, result, message } = await runCompare({ tabs: chosen, focus: $('compareFocus').value.trim(), settings: app.settings, signal: ctrl.signal });
    S.rows = rows;
    S.result = result;
    S.message = message || '';
    S.phase = 'done';
    if (result) announce('Comparison ready');
  } catch (err) {
    S.phase = 'done';
    if (!(err instanceof GeminiError && err.code === 'aborted')) S.error = asError(err);
  }
  S.ctrl = null;
  renderCompare();
}

// A citation like t2c5: bring that tab forward and highlight the passage there.
async function onCompareCite(id) {
  const hit = locateCite(S.result, id);
  if (!hit) { toast("That passage isn't available any more."); return; }
  try {
    await chrome.tabs.update(hit.tab.tabId, { active: true });
    await new Promise((r) => setTimeout(r, 300));
    const args = { localId: hit.chunk.localId, text: hit.chunk.text };
    let out = await callAgent(hit.tab.tabId, 'highlight', args, { frameIds: [hit.chunk.frameId] });
    if (out[0] && !out[0].ok && out[0].error && out[0].error.code === 'no_agent') {
      await ensureAgent(hit.tab.tabId);
      out = await callAgent(hit.tab.tabId, 'highlight', args, { frameIds: [hit.chunk.frameId] });
    }
    if (out[0] && out[0].ok && out[0].data.found === 'none') toast("That passage isn't on the page any more.");
  } catch { toast("Can't reach that tab. Allow its site or click the PageSum icon on it."); }
}

export function initCompare() {
  $('compareChoose').addEventListener('click', chooseTabs);
  $('compareRun').addEventListener('click', runNow);
  $('compareStop').addEventListener('click', () => { if (S.ctrl) S.ctrl.abort(); });
  // Handled here (and stopped) so the Page tab's click handler never sees compare citations.
  $('panel-compare').addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('button.cite') : null;
    if (!b) return;
    e.stopPropagation();
    onCompareCite(b.getAttribute('data-cite'));
  });
  renderCompare();
}

