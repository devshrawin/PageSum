// content/guide.js against the fake DOM: scanning, labels, forms, the overlay, target-lost events and teardown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { el, t, makeEnv } from './helpers/fakedom.js';

const FILES = ['core.js', 'extract.js', 'guide.js'];
const mk = (body, over = {}) => makeEnv({ body, ...over }).load(FILES);
const scan = (env, args = {}) => env.call('scanInteractive', args);
const rect = (left, top, width, height) => ({ __rect: { left, top, width, height } });
const byLabel = (r, label) => r.data.elements.find((e) => e.label === label);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const overlayNodes = (env) => env.html.childNodes.filter((n) => /pagesum-ov-/.test(n.className || ''));

test('scanInteractive: collects the interactive elements with ids, roles, labels and flags', () => {
  const body = el('body', {},
    el('a', { href: 'https://example.com/pricing?plan=pro#x' }, 'Pricing'),
    el('button', {}, 'Save'),
    el('button', { disabled: '' }, 'Disabled one'),
    el('input', { type: 'email', 'aria-label': 'Email address', required: '' }),
    el('input', { type: 'checkbox', 'aria-label': 'Agree', __props: { checked: true } }),
    el('div', { role: 'tab' }, 'Tab one'),
    el('span', { tabindex: '0' }, 'Focusable span'),
    el('span', { tabindex: '-1' }, 'Not in tab order'),
    el('a', {}, 'Anchor without href'),
    el('input', { type: 'hidden' }),
    el('p', {}, 'Just text'));
  const r = scan(mk(body));
  assert.equal(r.ok, true);
  assert.equal(r.data.scanId, 1);
  const labels = r.data.elements.map((e) => e.label);
  assert.deepEqual(labels, ['Pricing', 'Save', 'Disabled one', 'Email address', 'Agree', 'Tab one', 'Focusable span']);
  assert.deepEqual(r.data.elements.map((e) => e.id), ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7']);
  const link = byLabel(r, 'Pricing');
  assert.deepEqual([link.role, link.tag, link.href], ['link', 'a', 'https://example.com/pricing'], 'origin + pathname only, no query or hash');
  assert.equal(byLabel(r, 'Disabled one').disabled, true);
  assert.equal(byLabel(r, 'Save').disabled, false);
  const email = byLabel(r, 'Email address');
  assert.deepEqual([email.role, email.type, email.required], ['textbox', 'email', true]);
  const agree = byLabel(r, 'Agree');
  assert.deepEqual([agree.role, agree.checked], ['checkbox', true]);
  assert.equal(byLabel(r, 'Tab one').role, 'tab', 'explicit role wins');
});

test('scanInteractive: label precedence', () => {
  const body = el('body', {},
    el('input', { id: 'a', type: 'text', 'aria-label': 'ARIA', placeholder: 'ph', title: 'ti' }),
    el('span', { id: 'lbl' }, 'Labelled by text'), el('input', { type: 'text', 'aria-labelledby': 'lbl', placeholder: 'ph2' }),
    el('label', { for: 'c' }, 'For label'), el('input', { id: 'c', type: 'text', placeholder: 'ph3' }),
    el('label', {}, 'Wrapping label ', el('input', { type: 'text', placeholder: 'ph4' })),
    el('input', { type: 'text', placeholder: 'Placeholder text', title: 'Title text' }),
    el('input', { type: 'text', title: 'Title only' }),
    el('button', {}, el('img', { alt: 'Alt text' })),
    el('button', {}, '  Plain   text  '));
  const labels = scan(mk(body)).data.elements.map((e) => e.label);
  assert.deepEqual(labels, ['ARIA', 'Labelled by text', 'For label', 'Wrapping label', 'Placeholder text', 'Title only', 'Alt text', 'Plain text']);
});

test('scanInteractive: hidden and zero-size elements are skipped, nested matches keep the outermost', () => {
  const body = el('body', {},
    el('button', { __invisible: true }, 'Invisible'),
    el('button', { hidden: '' }, 'Hidden attr'),
    el('button', rect(0, 0, 0, 0), 'Zero size'),
    el('div', { __invisible: true }, el('button', {}, 'In hidden parent')),
    el('a', { href: '/outer' }, 'Outer link ', el('button', {}, 'Inner button')),
    el('button', {}, 'Visible'));
  const labels = scan(mk(body)).data.elements.map((e) => e.label);
  assert.deepEqual(labels, ['Outer link Inner button', 'Visible']);
});

test('scanInteractive: elements in the viewport come first, then the rest in document order; the cap is respected', () => {
  const body = el('body', {},
    el('button', rect(0, 5000, 100, 20), 'Far below'),
    el('button', rect(0, 10, 100, 20), 'On screen A'),
    el('button', rect(0, 8000, 100, 20), 'Further below'),
    el('button', rect(0, 40, 100, 20), 'On screen B'));
  const r = scan(mk(body));
  assert.deepEqual(r.data.elements.map((e) => e.label), ['On screen A', 'On screen B', 'Far below', 'Further below']);
  assert.deepEqual(r.data.elements.map((e) => e.inViewport), [true, true, false, false]);
  const many = el('body', {}, ...Array.from({ length: 300 }, (_, i) => el('button', {}, 'B' + i)));
  assert.equal(scan(mk(many)).data.elements.length, 250);
  assert.equal(scan(mk(many), { max: 10 }).data.elements.length, 10);
  assert.equal(scan(mk(many), { max: 9999 }).data.elements.length, 250);
});

test('scanInteractive never reads a value, selected option or textarea text', () => {
  const secret = el('input', { type: 'text', 'aria-label': 'Secret' });
  for (const prop of ['value', 'selectedIndex', 'innerText']) Object.defineProperty(secret, prop, { get() { throw new Error('read ' + prop); } });
  const area = el('textarea', {}, 'TYPED PRIVATE NOTES');
  const pw = el('input', { type: 'password' }, 'ignored');
  const sel = el('select', { 'aria-label': 'Country' }, ...Array.from({ length: 14 }, (_, i) => el('option', {}, i === 0 ? 'x'.repeat(80) : 'Opt' + i)));
  Object.defineProperty(sel, 'value', { get() { throw new Error('read select value'); } });
  Object.defineProperty(sel, 'selectedIndex', { get() { throw new Error('read selectedIndex'); } });
  const r = scan(mk(el('body', {}, secret, area, pw, sel)));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(byLabel(r, 'Secret').role, 'textbox');
  const ta = r.data.elements.find((e) => e.tag === 'textarea');
  assert.equal(ta.label, '', 'textarea text is never used as a label');
  assert.equal(r.data.elements.find((e) => e.type === 'password').label, '');
  assert.equal(JSON.stringify(r).includes('TYPED PRIVATE NOTES'), false);
  const country = byLabel(r, 'Country');
  assert.equal(country.options.length, 10, 'first 10 options');
  assert.equal(country.options[0].length, 40, 'each capped at 40 chars');
  assert.equal(country.role, 'combobox');
});

test('scanInteractive: region from the nearest landmark or heading, selector hints stay out of the label', () => {
  const body = el('body', {},
    el('header', {}, el('a', { href: '/home' }, 'Home')),
    el('nav', { 'aria-label': 'Main menu' }, el('a', { href: '/x' }, 'Docs')),
    el('div', {}, el('h2', {}, 'Billing'), el('div', {}, el('button', { id: 'pay-now' }, 'Pay'))),
    el('div', { id: 'order12345' }, el('button', { 'data-testid': 'checkout-btn' }, 'Checkout')),
    el('div', {}, el('span', {}, el('button', {}, 'Deep'))));
  const r = scan(mk(body));
  assert.equal(byLabel(r, 'Home').region, 'Header');
  assert.equal(byLabel(r, 'Docs').region, 'Main menu');
  assert.equal(byLabel(r, 'Pay').region, 'Billing');
  assert.equal(byLabel(r, 'Pay').selectorHint, '#pay-now');
  assert.equal(byLabel(r, 'Checkout').selectorHint, '[data-testid="checkout-btn"]');
  assert.match(byLabel(r, 'Deep').selectorHint, /^div:nth-of-type\(\d+\)>span:nth-of-type\(1\)>button:nth-of-type\(1\)$/);
});

test('scanForm: sensitive detection, format hints, only fields in a form or with a label', () => {
  const body = el('body', {},
    el('form', {},
      el('input', { type: 'text', 'aria-label': 'Full name', autocomplete: 'name', required: '' }),
      el('input', { type: 'password', 'aria-label': 'Password' }),
      el('input', { type: 'text', 'aria-label': 'Card', autocomplete: 'cc-number' }),
      el('input', { type: 'text', name: 'ssn', 'aria-label': 'Tax id' }),
      el('input', { type: 'text', 'aria-label': 'Passport number' }),
      el('input', { type: 'tel', 'aria-label': 'Phone', inputmode: 'numeric', pattern: '[0-9]{10}', maxlength: '10' }),
      el('input', { type: 'number', 'aria-label': 'Age', min: '1', max: '120' }),
      el('input', { type: 'hidden', name: 'csrf' }), el('input', { type: 'submit' }),
      el('select', { 'aria-label': 'Country' }, el('option', {}, 'India'), el('option', {}, 'France'))),
    el('input', { type: 'text' }),                                  // no form, no label: ignored
    el('label', {}, 'Loose labelled ', el('input', { type: 'text' })));
  const r = mk(body).call('scanForm', {});
  assert.equal(r.ok, true);
  const f = (label) => r.data.fields.find((x) => x.label === label);
  assert.deepEqual(r.data.fields.map((x) => x.label), ['Full name', 'Password', 'Card', 'Tax id', 'Passport number', 'Phone', 'Age', 'Country', 'Loose labelled']);
  assert.equal(f('Full name').sensitive, false);
  assert.equal(f('Full name').required, true);
  assert.equal(f('Full name').autocomplete, 'name');
  assert.equal(f('Password').sensitive, true);
  assert.equal(f('Card').sensitive, true, 'cc- autocomplete');
  assert.equal(f('Tax id').sensitive, true, 'ssn in the name');
  assert.equal(f('Passport number').sensitive, true, 'sensitive words in the label');
  assert.deepEqual([f('Phone').inputmode, f('Phone').pattern, f('Phone').maxLength, f('Phone').type], ['numeric', '[0-9]{10}', 10, 'tel']);
  assert.deepEqual([f('Age').min, f('Age').max], ['1', '120']);
  assert.deepEqual(f('Country').options, ['India', 'France']);
  assert.equal(f('Country').type, 'select');
});

test('scanForm reads no values either', () => {
  const secret = el('input', { type: 'text', 'aria-label': 'Secret' });
  Object.defineProperty(secret, 'value', { get() { throw new Error('read value'); } });
  const r = mk(el('body', {}, el('form', {}, secret))).call('scanForm', {});
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.data.fields[0].label, 'Secret');
});

function setup(extra = []) {
  const target = el('button', { id: 'go', ...rect(100, 200, 120, 30) }, 'Go ahead');
  const env = mk(el('body', {}, target, ...extra));
  const r = scan(env);
  return { env, target, id: byLabel(r, 'Go ahead').id };
}

test('guideShow outlines the element and shows a tooltip made with textContent; it never touches the element', () => {
  const { env, target, id } = setup();
  const r = env.call('guideShow', { elementId: id, step: 2, total: 5, text: 'Press <b>Go</b> now', caution: null });
  assert.deepEqual(r, { ok: true, data: { found: true } });
  const nodes = overlayNodes(env);
  assert.equal(nodes.length, 2);
  const [box, tip] = nodes;
  assert.equal(box.className, 'pagesum-ov-target');
  assert.equal(tip.className, 'pagesum-ov-tip');
  assert.equal(tip.textContent, 'Step 2/5: Press <b>Go</b> now', 'markup in the text stays text');
  assert.equal(tip.childNodes.length, 1);
  assert.equal(tip.childNodes[0].nodeType, 3);
  assert.deepEqual([box.style.left, box.style.top, box.style.width, box.style.height], ['97px', '197px', '126px', '36px']);
  assert.deepEqual(JSON.parse(JSON.stringify(target.scrolled)), [{ block: 'center', behavior: 'auto' }]);
  assert.equal(target.childNodes.length, 1, 'the page element is untouched');
});

test('guideShow with a caution adds the warning class and prefix; a second show replaces the first overlay', () => {
  const { env, id } = setup();
  env.call('guideShow', { elementId: id, step: 1, total: 1, text: 'Delete it', caution: 'destructive' });
  let [box, tip] = overlayNodes(env);
  assert.match(box.className, /pagesum-ov-warn/);
  assert.match(tip.className, /pagesum-ov-warn/);
  assert.equal(tip.textContent, 'Careful. Step 1/1: Delete it');
  env.call('guideShow', { elementId: id, step: 2, total: 3, text: 'Next', caution: null });
  assert.equal(overlayNodes(env).length, 2, 'only one overlay at a time');
  [box, tip] = overlayNodes(env);
  assert.equal(tip.textContent, 'Step 2/3: Next');
  assert.ok(!/warn/.test(box.className));
});

test('guideShow: unknown id, stale scan, hidden or changed element all give found:false', () => {
  const { env, target, id } = setup();
  assert.deepEqual(env.call('guideShow', { elementId: 'e99', step: 1, total: 1, text: 'x' }).data, { found: false });
  assert.deepEqual(env.call('guideShow', { elementId: '', step: 1, total: 1, text: 'x' }).data, { found: false });
  assert.equal(overlayNodes(env).length, 0);
  // the element changes what it is after the scan (a hostile page swapping it): refused
  target.childNodes[0].nodeValue = 'Delete my account';
  assert.deepEqual(env.call('guideShow', { elementId: id, step: 1, total: 1, text: 'x' }).data, { found: false });
  target.childNodes[0].nodeValue = 'Go ahead';
  assert.equal(env.call('guideShow', { elementId: id, step: 1, total: 1, text: 'x' }).data.found, true);
  target.attrs.__invisible = true;
  assert.equal(env.call('guideShow', { elementId: id, step: 1, total: 1, text: 'x' }).data.found, false);
  assert.equal(overlayNodes(env).length, 0, 'a failed show leaves nothing behind');
  // a new scan replaces the registry: ids from the old one are gone
  target.attrs.__invisible = false;
  env.call('scanInteractive', {});
  env.call('scanForm', {});
  assert.equal(env.call('guideShow', { elementId: id, step: 1, total: 1, text: 'x' }).data.found, false, 'scanForm found no fields, so the registry is empty');
});

test('guideShow refuses when the panel expects a different role or label than the scan recorded', () => {
  const { env, id } = setup();
  const show = (extra) => env.call('guideShow', { elementId: id, step: 1, total: 1, text: 'x', ...extra }).data.found;
  assert.equal(show({ expectRole: 'button', expectLabel: 'Go ahead' }), true);
  assert.equal(show({ expectRole: 'link', expectLabel: 'Go ahead' }), false);
  assert.equal(show({ expectRole: 'button', expectLabel: 'Something else' }), false);
  assert.equal(overlayNodes(env).length, 0);
  assert.equal(show({}), true, 'no expectation given: only the registry is checked');
});

test('text and numbers given to guideShow are capped and clamped', () => {
  const { env, id } = setup();
  env.call('guideShow', { elementId: id, step: -5, total: 'abc', text: 'y'.repeat(900) });
  const tip = overlayNodes(env)[1];
  assert.ok(tip.textContent.startsWith('Step 1/1: '));
  assert.equal(tip.textContent.length, 'Step 1/1: '.length + 300);
});

test('a mutation that removes the target emits guideTargetLost once; a harmless mutation does not', async () => {
  const { env, target, id } = setup();
  env.call('guideShow', { elementId: id, step: 1, total: 1, text: 'x' });
  const mo = env.observers.mo[0];
  assert.deepEqual(JSON.parse(JSON.stringify(mo.opts)), { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'] });
  mo.cb([]);
  await sleep(450);
  assert.equal(env.sent.length, 0, 'target still fine');
  target.remove();
  mo.cb([]); mo.cb([]);
  await sleep(450);
  assert.equal(env.sent.length, 1, 'debounced and sent once');
  assert.deepEqual(JSON.parse(JSON.stringify(env.sent[0])), { v: 2, src: 'pagesum-agent', type: 'agent/event', event: 'guideTargetLost', data: { elementId: id } });
  mo.cb([]);
  await sleep(450);
  assert.equal(env.sent.length, 1, 'only once per target');
});

test('a target that becomes hidden is also lost', async () => {
  const { env, target, id } = setup();
  env.call('guideShow', { elementId: id, step: 1, total: 1, text: 'x' });
  target.attrs.__invisible = true;
  env.observers.mo[0].cb([]);
  await sleep(450);
  assert.equal(env.sent[0].event, 'guideTargetLost');
});

test('guideClear removes the overlay, disconnects the observers and stops listening', () => {
  const { env, id } = setup();
  env.call('guideShow', { elementId: id, step: 1, total: 1, text: 'x' });
  assert.equal(overlayNodes(env).length, 2);
  assert.ok((env.listeners.scroll || []).length >= 1 && (env.listeners.resize || []).length >= 1);
  assert.deepEqual(env.call('guideClear', {}), { ok: true, data: {} });
  assert.equal(overlayNodes(env).length, 0);
  assert.equal(env.observers.mo[0].disconnected, true);
  assert.equal(env.observers.ro[0].disconnected, true);
  assert.equal((env.listeners.scroll || []).length, 0);
  assert.equal((env.listeners.resize || []).length, 0);
  assert.deepEqual(env.call('guideClear', {}), { ok: true, data: {} }, 'clearing twice is fine');
});

test('scrolling repositions the outline (rAF throttled)', async () => {
  const { env, target, id } = setup();
  env.call('guideShow', { elementId: id, step: 1, total: 1, text: 'x' });
  const box = overlayNodes(env)[0];
  target.attrs.__rect = { left: 100, top: 50, width: 120, height: 30 };
  env.fire('scroll', {});
  env.fire('scroll', {});
  await sleep(30);
  assert.equal(box.style.top, '47px');
});

test('Esc on the page clears the guide and tells the panel; reloading the extension tears it down', () => {
  const { env, id } = setup();
  env.call('guideShow', { elementId: id, step: 1, total: 1, text: 'x' });
  env.fire('keydown', { key: 'Escape' });
  assert.equal(overlayNodes(env).length, 0);
  assert.equal(env.sent.length, 1);
  assert.equal(env.sent[0].event, 'escape');
  env.call('guideShow', { elementId: id, step: 1, total: 1, text: 'x' });
  env.sandbox.chrome.runtime.id = undefined;
  assert.equal(env.PS.emit('escape', {}), false);
  assert.equal(overlayNodes(env).length, 0, 'teardown removed the overlay');
});

test('guide.js registers exactly its four commands, once', () => {
  const env = mk(el('body', {}));
  const keys = Object.keys(env.PS.handlers).sort();
  assert.deepEqual(keys, ['extract', 'guideClear', 'guideShow', 'ping', 'scanForm', 'scanInteractive']);
  env.load(FILES);
  assert.deepEqual(Object.keys(env.PS.handlers).sort(), keys);
});

void t;
