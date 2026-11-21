// Tools tab (spec section 10): quick actions and the form helper. Results are kept per tab in TabState.tool.
// Everything is built with createElement/textContent. Nothing here ever writes into the page.
import { $, el, icon, announce, toast, copyText, buildErrorCard } from './dom.js';
import { app, shownState, isShown, callAgent } from './tabs.js';
import { blockedReason } from './nav.js';
import { TOOLS, toolById, runTool, sourceResolver, actionItemsMarkdown } from './toolrun.js';
import { toCsv, toMarkdownTable, toJsonRecords } from '../lib/exporters.js';
import { renderMarkdown } from '../lib/markdown.js';
import { stripCitations, stripPartialCite } from '../lib/citations.js';
import { GeminiError, redactKey } from '../lib/errors.js';
import { DEFAULT_MODEL } from '../lib/models.js';
import { saveSettings } from '../lib/storage.js';
import { recordHistory } from './history.js';

/* ---------- small builders ---------- */

// <sup class="cites"><button class="cite" data-cite="c3">1</button>...</sup>. The Page tab's delegated handler
// on #content turns a click into a highlight (or a PDF page / video time).
export function citeGroup(ids, resolve) {
  const valid = (ids || []).filter((id) => resolve && resolve(id));
  if (!valid.length) return null;
  const sup = el('sup', { class: 'cites' });
  valid.forEach((id, i) => {
    const passage = String((resolve(id) || {}).text || '').replace(/\s+/g, ' ').trim();
    sup.appendChild(el('button', {
      type: 'button', class: 'cite', 'data-cite': id, 'aria-label': `Source ${i + 1}: ${passage.slice(0, 60)}`, title: passage.slice(0, 160), text: String(i + 1),
    }));
  });
  return sup;
}

function copyButton(label, getText) {
  const span = el('span', { text: label });
  const b = el('button', { type: 'button', class: 'btn btn-secondary btn-sm' }, icon('copy'), span);
  b.addEventListener('click', () => copyText(getText(), span, label));
  return b;
}

function saveButton(st, label, getMarkdown) {
  const span = el('span', { text: 'Save to history' });
  const b = el('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, icon('save'), span);
  b.addEventListener('click', async () => {
    const r = await recordHistory(st, { kind: 'tool', label, markdown: getMarkdown() });
    span.textContent = r.saved ? 'Saved' : 'Not saved';
    if (r.skipped) toast(r.skipped);
    else if (!r.saved) toast('History is turned off in Settings.');
  });
  return b;
}

const asError = (err) => {
  if (err instanceof GeminiError) return err;
  console.error(redactKey(String((err && err.message) || err)));
  return new GeminiError('network', { message: err && err.message });
};

/* ---------- result views ---------- */

function markdownView(st, res, tool) {
  const resolve = tool.id === 'explain' && app.settings.citations ? sourceResolver(st.page) : undefined;
  const box = el('div', { class: 'card' });
  const body = el('div', { class: 'md' });
  body.appendChild(renderMarkdown(res.text, document, { resolveCite: resolve || undefined }));
  box.appendChild(body);
  if (res.notice) box.appendChild(el('p', { class: 'hint', text: res.notice }));
  box.appendChild(el('div', { class: 'res-actions' }, copyButton('Copy', () => stripCitations(res.text)), saveButton(st, tool.label, () => res.text)));
  return box;
}

function itemList(rows) {
  if (!rows.length) return el('p', { class: 'hint', text: 'None found.' });
  const ul = el('ul', { class: 'list' });
  for (const r of rows) ul.appendChild(el('li', {}, ...r));
  return ul;
}

function actionItemsView(st, res) {
  const resolve = sourceResolver(st.page);
  const d = res.data;
  const items = d.items.map((it) => {
    const meta = [it.owner, it.due || it.dueText].filter(Boolean).join(', ');
    return [el('span', { text: it.task }), meta ? el('span', { class: 'chip', text: meta }) : null, citeGroup(it.sources, resolve)].filter(Boolean).flatMap((n, i) => (i ? [' ', n] : [n]));
  });
  const dates = d.dates.map((x) => [el('b', { text: x.date || x.text }), ' ', el('span', { text: x.what }), x.date && x.text !== x.date ? el('span', { class: 'chip', text: x.text }) : null, citeGroup(x.sources, resolve)].filter(Boolean));
  const md = actionItemsMarkdown(d);
  const box = el('div', { class: 'tool-result' });
  box.append(
    el('h3', { class: 'res-title', text: 'Tasks' }), itemList(items),
    el('h3', { class: 'res-title', text: 'Dates and deadlines' }), itemList(dates),
    el('div', { class: 'res-actions' }, copyButton('Copy as Markdown', () => md), saveButton(st, 'Action items', () => md)),
  );
  return box;
}

function quizMarkdown(d) {
  const cards = d.cards.map((c) => `**Q:** ${c.q}\n**A:** ${c.a}`).join('\n\n');
  const quiz = d.quiz.map((q, i) => `${i + 1}. ${q.q}\n${q.choices.map((c, k) => `   - ${String.fromCharCode(97 + k)}) ${c}${k === q.answer ? ' (correct)' : ''}`).join('\n')}\n   ${q.why}`).join('\n\n');
  return [cards ? '## Flashcards\n\n' + cards : '', quiz ? '## Quiz\n\n' + quiz : ''].filter(Boolean).join('\n\n');
}

function quizView(st, res) {
  const resolve = sourceResolver(st.page);
  const d = res.data;
  const box = el('div', { class: 'tool-result' });
  if (d.cards.length) {
    box.appendChild(el('h3', { class: 'res-title', text: 'Flashcards' }));
    for (const c of d.cards) {
      const a = el('span', { class: 'flash-a', text: c.a, hidden: true });
      const b = el('button', { type: 'button', class: 'flash', 'aria-pressed': 'false' }, el('span', { class: 'flash-q', text: c.q }), a);
      b.addEventListener('click', () => {
        const on = b.getAttribute('aria-pressed') !== 'true';
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        a.hidden = !on;
      });
      box.appendChild(el('div', {}, b, citeGroup(c.sources, resolve)));
    }
  }
  if (d.quiz.length) {
    box.appendChild(el('h3', { class: 'res-title', text: 'Quiz' }));
    const groups = [];
    d.quiz.forEach((q, qi) => {
      const fs = el('fieldset', { class: 'card field' }, el('legend', { class: 'quiz-q', text: `${qi + 1}. ${q.q}` }));
      const labels = q.choices.map((ch, k) => {
        const input = el('input', { type: 'radio', name: `quiz-${qi}`, value: String(k) });
        const lab = el('label', { class: 'quiz-choice' }, input, el('span', { text: ch }));
        fs.appendChild(lab);
        return { input, lab };
      });
      const why = el('p', { class: 'quiz-why', text: q.why, hidden: true });
      fs.append(why, el('div', {}, citeGroup(q.sources, resolve)));
      groups.push({ q, labels, why });
      box.appendChild(fs);
    });
    const score = el('p', { class: 'hint', role: 'status' });
    const check = el('button', { type: 'button', class: 'btn btn-primary primary btn-sm' }, icon('check'), el('span', { text: 'Check answers' }));
    check.addEventListener('click', () => {
      let right = 0;
      for (const g of groups) {
        g.labels.forEach((l, k) => {
          l.lab.classList.remove('is-right', 'is-wrong');
          if (k === g.q.answer) l.lab.classList.add('is-right');
          else if (l.input.checked) l.lab.classList.add('is-wrong');
          if (k === g.q.answer && l.input.checked) right++;
        });
        g.why.hidden = false;
      }
      score.textContent = `${right} of ${groups.length} correct.`;
      announce(score.textContent);
    });
    box.append(el('div', { class: 'res-actions' }, check), score);
  }
  const md = quizMarkdown(d);
  box.appendChild(el('div', { class: 'res-actions' }, copyButton('Copy as Markdown', () => md), saveButton(st, 'Quiz', () => md)));
  return box;
}

// The table is built with createElement (the markdown renderer has no tables).
export function tableNode(columns, rows, resolve, withSources) {
  const table = el('table', { class: 'data-table' });
  const head = el('tr', {}, ...columns.map((c) => el('th', { scope: 'col', text: c })), withSources ? el('th', { scope: 'col', text: 'Source' }) : null);
  table.appendChild(el('thead', {}, head));
  const tbody = el('tbody');
  for (const r of rows) {
    tbody.appendChild(el('tr', {}, ...r.cells.map((c) => el('td', { text: c == null ? '' : c })), withSources ? el('td', {}, citeGroup(r.sources, resolve)) : null));
  }
  table.appendChild(tbody);
  return el('div', { class: 'data-wrap' }, table);
}

export function exportButtons(columns, rows2d) {
  return el('div', { class: 'res-actions' },
    copyButton('Copy CSV', () => toCsv(columns, rows2d)),
    copyButton('Copy Markdown', () => toMarkdownTable(columns, rows2d)),
    copyButton('Copy JSON', () => toJsonRecords(columns, rows2d)));
}

function tableView(st, res) {
  const d = res.data;
  const rows2d = d.rows.map((r) => r.cells);
  const box = el('div', { class: 'tool-result' });
  if (!d.rows.length) {
    box.appendChild(el('p', { class: 'hint', text: 'No rows found.' }));
  } else {
    box.append(tableNode(d.columns, d.rows, sourceResolver(st.page), true), exportButtons(d.columns, rows2d));
    box.appendChild(el('div', { class: 'res-actions' }, saveButton(st, 'Extracted table', () => toMarkdownTable(d.columns, rows2d))));
  }
  if (d.notes) box.appendChild(el('p', { class: 'hint', text: d.notes }));
  return box;
}

async function showFieldOnPage(st, field, scanField) {
  try {
    const out = await callAgent(st.tabId, 'guideShow', {
      elementId: field.elementId, step: 1, total: 1, text: field.explanation.slice(0, 200), caution: !!(scanField && scanField.sensitive),
      expectRole: scanField ? scanField.role : undefined, expectLabel: scanField ? scanField.label : undefined,
    }, { frameIds: [0] });
    if (!out[0] || !out[0].ok || !out[0].data.found) toast("Can't find that field on the page now. Run the form helper again.");
  } catch { toast("Can't reach the page. Click the PageSum icon while on this tab."); }
}

function formView(st, res) {
  const byId = new Map((res.fields || []).map((f) => [f.id, f]));
  const box = el('div', { class: 'tool-result' });
  if (!res.data.fields.length) box.appendChild(el('p', { class: 'hint', text: 'Nothing to explain.' }));
  for (const f of res.data.fields) {
    const scan = byId.get(f.elementId);
    const card = el('div', { class: 'card field-card' },
      el('div', {}, el('span', { class: 'field-label', text: (scan && scan.label) || f.elementId }), ' ', scan ? el('span', { class: 'chip', text: scan.type + (scan.required ? ', required' : '') }) : null),
      el('p', { class: 'step-text', text: f.explanation }));
    if (f.format) card.appendChild(el('p', { class: 'hint', text: `Format: ${f.format}` }));
    if (scan && scan.sensitive) card.appendChild(el('p', { class: 'hint', text: 'Enter this yourself.' }));
    else if (f.draft) card.appendChild(el('div', { class: 'draft' }, el('span', { class: 'hint', text: 'Suggested:' }), el('code', { text: f.draft }), copyButton('Copy', () => f.draft)));
    const show = el('button', { type: 'button', class: 'btn btn-secondary btn-sm' }, icon('target'), el('span', { text: 'Show on page' }));
    show.addEventListener('click', () => showFieldOnPage(st, f, scan));
    card.appendChild(el('div', { class: 'res-actions' }, show));
    box.appendChild(card);
  }
  box.appendChild(el('p', { class: 'hint', text: 'PageSum only suggests. It never types into the page.' }));
  return box;
}

/* ---------- panel ---------- */

function renderResult(st) {
  const t = st.tool;
  const box = $('toolResult');
  box.replaceChildren();
  if (!t || t.status === 'idle') return;
  const tool = toolById(t.action);
  if (t.status === 'running') {
    box.appendChild(el('div', { class: 'status' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), el('span', { text: 'Working...' })));
    if (t.raw && !tool.json) {
      const md = el('div', { class: 'md card' });
      md.appendChild(renderMarkdown(stripPartialCite(t.raw), document));
      box.appendChild(md);
    }
    return;
  }
  if (t.status === 'error') {
    box.appendChild(buildErrorCard(t.error, () => run(), {
      currentModel: app.settings && app.settings.model,
      onSwitchModel: async () => { app.settings = await saveSettings({ model: DEFAULT_MODEL }); run(); },
    }));
    return;
  }
  const res = t.result;
  if (!res) return;
  if (res.type === 'empty') box.appendChild(el('p', { class: 'hint', text: res.message }));
  else if (res.type === 'markdown') box.appendChild(markdownView(st, res, tool));
  else if (res.action === 'actionItems') box.appendChild(actionItemsView(st, res));
  else if (res.action === 'quiz') box.appendChild(quizView(st, res));
  else if (res.action === 'table') box.appendChild(tableView(st, res));
  else if (res.action === 'form') box.appendChild(formView(st, res));
}

function buildGrid() {
  const grid = $('toolGrid');
  if (grid.children.length) return;
  for (const tool of TOOLS) {
    const b = el('button', { type: 'button', class: 'tool-btn', 'data-tool': tool.id, 'aria-pressed': 'false' }, icon(tool.icon, 'i i-18'), el('span', { text: tool.label }));
    b.addEventListener('click', () => {
      const st = shownState();
      if (!st || (st.tool && st.tool.status === 'running')) return;
      st.tool = { ...(st.tool || {}), action: tool.id, status: (st.tool && st.tool.status) || 'idle' };
      renderTools(st);
    });
    grid.appendChild(b);
  }
}

export function renderTools(st) {
  buildGrid();
  const reason = blockedReason(st);
  $('toolsBlocked').hidden = !reason;
  $('toolsMain').hidden = !!reason;
  if (reason) { $('toolsBlockedText').textContent = reason; return; }
  const t = st.tool || {};
  const running = t.status === 'running';
  for (const b of $('toolGrid').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', b.getAttribute('data-tool') === t.action ? 'true' : 'false');
    b.disabled = running;
  }
  const options = $('toolOptions');
  options.hidden = !t.action;
  if (t.action) {
    const tool = toolById(t.action);
    $('toolTitle').textContent = tool.label;
    $('toolHint').textContent = tool.hint;
    for (const o of options.querySelectorAll('.tool-opt')) o.hidden = o.getAttribute('data-for') !== t.action;
    const target = $('translateTarget');
    if (!target.value) target.value = app.settings.translateTarget;
    $('toolRun').hidden = running;
    $('toolStop').hidden = !running;
  }
  renderResult(st);
}

let draw = 0;
function scheduleDraw(st) {
  if (draw) return;
  draw = requestAnimationFrame(() => { draw = 0; if (isShown(st)) renderResult(st); });
}

async function run() {
  const st = shownState();
  if (!st || !st.tool || !st.tool.action || st.tool.status === 'running') return;
  const action = st.tool.action;
  const ctrl = new AbortController();
  const opts = {
    target: $('translateTarget').value.trim(), tone: $('replyTone').value, notes: $('replyNotes').value.trim(),
    what: $('tableWhat').value.trim(), formContext: $('formContext').value.trim(), question: $('visionQ').value.trim(),
  };
  if (action === 'vision' && !opts.question) { toast('Type a question about what is visible first.'); return; }
  const tool = { action, status: 'running', ctrl, raw: '', result: null, error: null };
  st.tool = tool;
  renderTools(st);
  try {
    const result = await runTool(st, {
      action, settings: app.settings, windowId: app.windowId, signal: ctrl.signal, opts,
      onText: (text) => { if (st.tool !== tool) return; tool.raw = text; if (isShown(st)) scheduleDraw(st); },
    });
    if (st.tool !== tool) return;
    tool.status = 'done';
    tool.result = result;
    if (isShown(st)) announce(`${toolById(action).label} ready`);
  } catch (err) {
    if (st.tool !== tool) return;
    if (err instanceof GeminiError && err.code === 'aborted') tool.status = 'idle';
    else { tool.status = 'error'; tool.error = asError(err); }
  }
  tool.ctrl = null;
  if (isShown(st)) renderTools(st);
}

export function initTools() {
  buildGrid();
  $('toolRun').addEventListener('click', run);
  $('toolStop').addEventListener('click', () => {
    const st = shownState();
    if (st && st.tool && st.tool.ctrl) st.tool.ctrl.abort();
  });
}

// A navigation or a re-summarise makes a stored tool result stale.
export function clearTool(st) {
  if (st.tool && st.tool.ctrl) st.tool.ctrl.abort();
  st.tool = null;
}
