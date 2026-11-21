// Guide tab (spec 9.3): a goal, a step-by-step plan, and "show on page". PageSum never clicks or types for the
// user: the only things that happen on the page are an outline and a tooltip, drawn by content/guide.js.
import { $, el, icon, announce, toast, copyText, buildErrorCard } from './dom.js';
import { app, shownState, isShown } from './tabs.js';
import { blockedReason } from './nav.js';
import { planGuide, showStep, replan, guideClear, hostOf } from './guideflow.js';
import { cautionText } from '../lib/guidecore.js';
import { GeminiError, redactKey } from '../lib/errors.js';
import { DEFAULT_MODEL } from '../lib/models.js';
import { saveSettings } from '../lib/storage.js';

const asError = (err) => {
  if (err instanceof GeminiError) return err;
  console.error(redactKey(String((err && err.message) || err)));
  return new GeminiError('network', { message: err && err.message });
};

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');

function stepNode(step, i, g) {
  const current = i === g.index;
  const body = el('div', { class: 'step-body' }, el('span', { class: 'step-text', text: step.instruction }));
  if (step.info) body.appendChild(el('span', { class: 'chip', text: `${cap(step.info.role)}: ${step.info.label || '(no label)'}` }));
  if (step.valueHint) {
    const label = el('span', { text: 'Copy' });
    const copy = el('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, icon('copy'), label);
    copy.addEventListener('click', () => copyText(step.valueHint, label, 'Copy'));
    body.appendChild(el('div', { class: 'draft' }, el('span', { class: 'hint', text: 'Suggested:' }), el('code', { text: step.valueHint }), copy));
  }
  if (step.caution) {
    // The host is plain text, never a link.
    body.appendChild(el('span', { class: 'badge badge-warn', text: cautionText(step.caution, step.info && step.info.href ? hostOf(step.info.href) : '') }));
  }
  const li = el('li', { class: i < g.index ? 'is-done' : '' }, el('span', { class: 'step-n', text: String(i + 1) }), body);
  if (current) li.setAttribute('aria-current', 'step');
  return li;
}

export function renderGuide(st) {
  const reason = blockedReason(st);
  $('guideBlocked').hidden = !reason;
  $('guideMain').hidden = !!reason;
  if (reason) { $('guideBlockedText').textContent = reason; return; }
  const g = st.guide;
  const planning = !!g && (g.status === 'planning' || g.status === 'replanning');
  const hasPlan = !!g && !!g.plan;

  $('guideStartBox').hidden = hasPlan;
  if (!hasPlan) {
    if (g && g.goal && !$('guideGoal').value) $('guideGoal').value = g.goal;
    $('guideStart').disabled = planning;
    $('guideStart').textContent = planning ? 'Working out the steps...' : 'Show me how';
  }
  const errBox = $('guideError');
  if (g && g.error) {
    errBox.replaceChildren(buildErrorCard(g.error, () => (hasPlan ? replanNow(st) : start()), {
      currentModel: app.settings && app.settings.model,
      onSwitchModel: async () => { app.settings = await saveSettings({ model: DEFAULT_MODEL }); if (hasPlan) replanNow(st); else start(); },
    }));
    errBox.hidden = false;
  } else {
    errBox.hidden = true;
    errBox.replaceChildren();
  }

  $('guidePlan').hidden = !hasPlan;
  if (!hasPlan) return;
  const plan = g.plan;
  $('guideSummary').textContent = plan.summary;
  const dropped = $('guideDropped');
  dropped.hidden = !g.dropped;
  dropped.textContent = g.dropped ? `${g.dropped} suggested ${g.dropped === 1 ? 'step referred' : 'steps referred'} to elements not on the page and ${g.dropped === 1 ? 'was' : 'were'} removed.` : '';
  const list = $('guideSteps');
  list.replaceChildren(...(plan.feasible ? plan.steps.map((s, i) => stepNode(s, i, g)) : []));
  $('guideLost').hidden = !(plan.feasible && g.lost);
  const live = plan.feasible && plan.steps.length > 0;
  const last = g.index >= plan.steps.length - 1;
  $('guideBack').hidden = !live;
  $('guideNext').hidden = !live;
  $('guideShowBtn').hidden = !live;
  $('guideReplan').hidden = !live;
  $('guideBack').disabled = planning || g.index <= 0;
  $('guideNext').disabled = planning || last;
  $('guideShowBtn').disabled = planning;
  $('guideReplan').disabled = planning;
  $('guideNext').textContent = g.lost ? 'Skip' : 'Next';
}

async function showCurrent(st) {
  const g = st.guide;
  if (!g || !g.plan) return;
  try {
    const r = await showStep(st, g, g.index);
    g.lost = r === 'lost';
  } catch (err) {
    g.lost = true;
    console.error(redactKey(String((err && err.message) || err)));
  }
  if (isShown(st)) renderGuide(st);
}

async function start() {
  const st = shownState();
  if (!st) return;
  const goal = $('guideGoal').value.trim();
  if (!goal) { toast('Type what you want to do first.'); return; }
  const g = { goal, plan: null, index: 0, doneSteps: [], status: 'planning', error: null, lost: false, dropped: 0 };
  st.guide = g;
  renderGuide(st);
  try {
    const res = await planGuide(st, { goal, settings: app.settings });
    if (st.guide !== g) return;
    g.plan = res.plan;
    g.dropped = res.dropped;
    g.status = 'ready';
    if (res.plan.feasible && res.plan.steps.length) {
      announce('Plan ready');
      await showCurrent(st);
    }
  } catch (err) {
    if (st.guide !== g) return;
    g.status = 'ready';
    g.error = asError(err);
  }
  if (isShown(st)) renderGuide(st);
}

// Re-plan from the current step: earlier steps stay, the rest is replaced using a fresh scan.
async function replanNow(st) {
  const g = st.guide;
  if (!g || !g.plan) return;
  g.status = 'replanning';
  g.error = null;
  if (isShown(st)) renderGuide(st);
  try {
    const res = await replan(st, g, { settings: app.settings });
    if (st.guide !== g) return;
    g.plan = res.plan;
    g.dropped = res.dropped;
    g.lost = false;
    g.status = 'ready';
    if (g.index >= g.plan.steps.length) g.index = Math.max(0, g.plan.steps.length - 1);
    announce('Plan ready');
    await showCurrent(st);
  } catch (err) {
    if (st.guide !== g) return;
    g.status = 'ready';
    g.error = asError(err);
  }
  if (isShown(st)) renderGuide(st);
}

async function goTo(st, index) {
  const g = st.guide;
  if (!g || !g.plan) return;
  g.index = Math.min(Math.max(0, index), g.plan.steps.length - 1);
  g.lost = false;
  g.error = null;
  renderGuide(st);
  await showCurrent(st);
}

async function done(st) {
  st.guide = null;
  await guideClear(st.tabId);
  $('guideGoal').value = '';
  if (isShown(st)) renderGuide(st);
}

// Hooks called by tabs.js.
export function onGuideTargetLost(st, elementId) {
  const g = st.guide;
  const step = g && g.plan && g.plan.steps[g.index];
  if (!step || step.elementId !== elementId) return;
  g.lost = true;
  if (isShown(st)) renderGuide(st);
}

export function onGuideContinue(st) {
  if (st.guide && st.guide.plan) replanNow(st);
}

export function initGuide() {
  $('guideStart').addEventListener('click', start);
  $('guideGoal').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); start(); }
  });
  $('guideNext').addEventListener('click', () => { const st = shownState(); if (st && st.guide) goTo(st, st.guide.index + 1); });
  $('guideBack').addEventListener('click', () => { const st = shownState(); if (st && st.guide) goTo(st, st.guide.index - 1); });
  $('guideShowBtn').addEventListener('click', () => { const st = shownState(); if (st && st.guide) { st.guide.lost = false; showCurrent(st); } });
  $('guideReplan').addEventListener('click', () => { const st = shownState(); if (st) replanNow(st); });
  $('guideDone').addEventListener('click', () => { const st = shownState(); if (st) done(st); });
}
