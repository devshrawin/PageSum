// Guide mode core (spec section 9): what the model sees, how its plan is checked, and local safety warnings. Pure.
// The guide only ever points at elements. It never clicks, types or navigates, and it can only name elements
// that exist in the scan it was given.
import { sanitizeForBlock } from './chunks.js';

// Page-written text: one line, no quotes, defused like all page text.
function clean(s, max) {
  return sanitizeForBlock(String(s == null ? '' : s).replace(/\s+/g, ' ').trim()).replace(/"/g, "'").slice(0, max);
}

// Lines for the untrusted block, e.g.
//   [e1] button "Sign in" (region: Header)
//   [e2] link "Pricing" -> https://example.com/pricing
//   [e3] input type=email "Email address" required
// Links show their address as plain text. Typed values are never part of a scan, so none can appear here.
export function formatElementsForPrompt(elements) {
  return (elements || []).map((e) => {
    const label = clean(e.label, 80);
    let line = `[${e.id}] `;
    if (e.role === 'link') line += `link "${label}"${e.href ? ` -> ${clean(e.href, 80)}` : ''}`;
    else if (e.tag === 'input') line += `input type=${clean(e.type || 'text', 20)} "${label}"`;
    else line += `${clean(e.role || e.tag, 20)} "${label}"`;
    if (e.required) line += ' required';
    if (e.disabled) line += ' disabled';
    if (e.checked === true) line += ' checked';
    if (Array.isArray(e.options) && e.options.length) line += ` options: ${e.options.slice(0, 10).map((o) => clean(o, 40)).join(' | ')}`;
    if (e.region) line += ` (region: ${clean(e.region, 40)})`;
    return line;
  }).join('\n');
}

// Same idea for the form helper: fields with their format hints. Values are never included.
export function formatFieldsForPrompt(fields) {
  return (fields || []).map((f) => {
    const bits = [`type=${clean(f.type || f.tag, 20)}`];
    if (f.required) bits.push('required');
    if (f.sensitive) bits.push('sensitive');
    if (f.autocomplete) bits.push(`autocomplete=${clean(f.autocomplete, 30)}`);
    if (f.inputmode) bits.push(`inputmode=${clean(f.inputmode, 20)}`);
    if (f.pattern) bits.push(`pattern=${clean(f.pattern, 60)}`);
    if (Number.isFinite(f.maxLength) && f.maxLength > 0) bits.push(`maxlength=${f.maxLength}`);
    if (f.min != null && f.min !== '') bits.push(`min=${clean(f.min, 20)}`);
    if (f.max != null && f.max !== '') bits.push(`max=${clean(f.max, 20)}`);
    let line = `[${f.id}] ${bits.join(' ')} "${clean(f.label, 80)}"`;
    if (Array.isArray(f.options) && f.options.length) line += ` options: ${f.options.slice(0, 10).map((o) => clean(o, 40)).join(' | ')}`;
    if (f.region) line += ` (region: ${clean(f.region, 40)})`;
    return line;
  }).join('\n');
}

// Drops steps that name an element not in the scan, caps text, and marks an emptied plan infeasible.
// Returns { plan, dropped }.
export function validatePlan(plan, elementIds) {
  const ids = elementIds instanceof Set ? elementIds : new Set(elementIds || []);
  const steps = [];
  let dropped = 0;
  for (const s of Array.isArray(plan && plan.steps) ? plan.steps : []) {
    if (s.elementId != null && !ids.has(s.elementId)) { dropped++; continue; }
    steps.push({
      ...s,
      instruction: String(s.instruction == null ? '' : s.instruction).slice(0, 300),
      valueHint: s.valueHint == null ? null : String(s.valueHint).slice(0, 120),
    });
  }
  let feasible = !!(plan && plan.feasible);
  let summary = String((plan && plan.summary) || '');
  if (feasible && steps.length === 0) {
    feasible = false;
    summary = "PageSum couldn't map the steps to this page.";
  }
  return { plan: { feasible, summary, steps }, dropped };
}

const SEVERITY = ['external', 'personal_data', 'payment', 'destructive'];
const RE_DESTRUCTIVE = /\b(delete|remove|erase|destroy|cancel (my )?(subscription|account|order)|close account|deactivate|unsubscribe|reset|revoke)\b/i;
const RE_PAYMENT = /\b(pay|purchase|buy|checkout|place order|subscribe now|upgrade|transfer|send money|donate)\b/i;

function originOf(url) {
  try { return new URL(url).origin; } catch { return ''; }
}

// The warning computed here, from the step text and the real element. pageOrigin is the tab's origin.
export function detectCaution(step, element, pageOrigin) {
  const text = `${(step && step.instruction) || ''} ${(element && element.label) || ''}`;
  if (RE_DESTRUCTIVE.test(text)) return 'destructive';
  if (RE_PAYMENT.test(text)) return 'payment';
  if (element && (element.sensitive || ['password', 'email', 'tel'].includes(element.type))) return 'personal_data';
  if (element && element.role === 'link' && element.href && pageOrigin) {
    const o = originOf(element.href);
    if (o && o !== pageOrigin) return 'external';
  }
  return null;
}

// Local warnings can only add to the model's, never remove: the more severe of the two wins.
export function finalCaution(modelCaution, localCaution) {
  const rank = (c) => SEVERITY.indexOf(c);
  return rank(localCaution) > rank(modelCaution) ? localCaution : (modelCaution || null);
}

export function cautionFor(step, element, pageOrigin) {
  return finalCaution(step && step.caution, detectCaution(step, element, pageOrigin));
}

// Text of the badge. Hosts are plain text, never links.
export function cautionText(caution, host) {
  switch (caution) {
    case 'destructive': return "Can't be undone: check before you click";
    case 'payment': return 'Involves payment';
    case 'personal_data': return "You'll enter personal data";
    case 'external': return `Leaves this site (${host || 'another site'})`;
    default: return '';
  }
}

// After a re-scan the element ids change. Find the same element again: exact role + label first, then the same
// label with any role, then the same selector hint. Returns the new id or null.
export function resolveByFingerprint(fp, elements) {
  if (!fp) return null;
  const list = elements || [];
  if (fp.label) {
    const exact = list.find((e) => e.role === fp.role && e.label === fp.label);
    if (exact) return exact.id;
    const same = list.find((e) => e.label === fp.label);
    if (same) return same.id;
  }
  if (fp.selectorHint) {
    const hit = list.find((e) => e.selectorHint === fp.selectorHint);
    if (hit) return hit.id;
  }
  return null;
}
