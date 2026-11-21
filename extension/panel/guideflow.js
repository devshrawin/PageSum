// Guide mode flow (spec section 9.3): scan the page, ask for a plan, check it, and show one step at a time.
// No DOM here. The guide only points: every page-side call is scanInteractive, guideShow or guideClear, and the
// plan can only name element ids that exist in the scan it was made from.
import { generateJson } from '../lib/gemini.js';
import { GeminiError } from '../lib/errors.js';
import { GUIDE_SCHEMA, normalizeGuide } from '../lib/schemas.js';
import { buildGuideContents, buildGuideSystem, makeNonce } from '../lib/prompts.js';
import { formatElementsForPrompt, validatePlan, cautionFor, resolveByFingerprint } from '../lib/guidecore.js';
import { callAgent, ensureAgent } from './agent.js';

const originOf = (url) => { try { return new URL(url).origin; } catch { return ''; } };

async function scan(tabId) {
  await ensureAgent(tabId);
  const out = await callAgent(tabId, 'scanInteractive', { max: 250 }, { frameIds: [0] });
  const r = out[0];
  if (!r || !r.ok) throw new GeminiError('no_access');
  return r.data.elements;
}

const fingerprintOf = (e) => ({ role: e.role, label: e.label, region: e.region, selectorHint: e.selectorHint });
const infoOf = (e) => ({ role: e.role, label: e.label, type: e.type, href: e.href });

// Returns { plan: { feasible, summary, steps }, dropped }. Every step carries { info, fp } copied from the scan
// (the chip text, the warning, and the way to find the element again) and its final caution (model or local, never less).
export async function planGuide(st, { goal, doneSteps = [], settings, signal, baseUrl, fetchImpl }) {
  const elements = await scan(st.tabId);
  const byId = new Map(elements.map((e) => [e.id, e]));
  const page = st.page || { title: st.title, url: st.url };
  const raw = await generateJson({
    apiKey: settings.apiKey, model: settings.model, system: buildGuideSystem(settings.language),
    contents: buildGuideContents({ goal, elementsText: formatElementsForPrompt(elements), page, nonce: makeNonce(), doneSteps }),
    schema: GUIDE_SCHEMA, normalize: normalizeGuide, signal, baseUrl, fetchImpl,
  });
  const { plan, dropped } = validatePlan(raw, new Set(byId.keys()));
  const origin = originOf(page.url || st.url);
  const steps = plan.steps.map((s) => {
    const e = s.elementId ? byId.get(s.elementId) : null;
    return { ...s, caution: cautionFor(s, e, origin), info: e ? infoOf(e) : null, fp: e ? fingerprintOf(e) : null };
  });
  return { plan: { feasible: plan.feasible, summary: plan.summary, steps }, dropped };
}

async function guideShowCall(tabId, step, index, total) {
  const out = await callAgent(tabId, 'guideShow', {
    elementId: step.elementId, step: index + 1, total, text: step.instruction, caution: !!step.caution,
    expectRole: step.fp ? step.fp.role : undefined, expectLabel: step.fp ? step.fp.label : undefined,
  }, { frameIds: [0] });
  return !!(out[0] && out[0].ok && out[0].data && out[0].data.found);
}

export async function guideClear(tabId) {
  try { await callAgent(tabId, 'guideClear', {}, { frameIds: [0] }); } catch { /* tab gone or no access */ }
}

// After a re-scan all ids changed: re-find every step's element by its fingerprint.
function remap(plan, elements) {
  for (const s of plan.steps) {
    if (!s.fp) continue;
    const id = resolveByFingerprint(s.fp, elements);
    if (id) {
      const e = elements.find((x) => x.id === id);
      s.elementId = id;
      s.info = infoOf(e);
    }
  }
}

// Shows step `index` of g.plan on the page. Returns 'shown', 'text' (a step with no element: nothing is outlined)
// or 'lost' (not found even after a re-scan and a fingerprint match).
export async function showStep(st, g, index) {
  const step = g.plan.steps[index];
  const total = g.plan.steps.length;
  if (!step) return 'lost';
  if (!step.elementId) { await guideClear(st.tabId); return 'text'; }
  if (await guideShowCall(st.tabId, step, index, total)) return 'shown';
  let elements;
  try { elements = await scan(st.tabId); } catch { return 'lost'; }
  remap(g.plan, elements);
  if (await guideShowCall(st.tabId, step, index, total)) return 'shown';
  return 'lost';
}

// Re-plan from the current step: the steps before it stay (they are done), the rest is replaced.
// Returns { plan, dropped } for the full merged plan.
export async function replan(st, g, { settings, signal, baseUrl, fetchImpl }) {
  const keep = g.plan.steps.slice(0, g.index);
  const doneSteps = keep.map((s) => s.instruction);
  const res = await planGuide(st, { goal: g.goal, doneSteps, settings, signal, baseUrl, fetchImpl });
  return {
    plan: { feasible: res.plan.feasible, summary: res.plan.summary, steps: [...keep, ...res.plan.steps] },
    dropped: res.dropped,
  };
}

export function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}
