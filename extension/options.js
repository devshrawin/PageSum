import { getSettings, saveSettings, clearCache } from './lib/storage.js';
import { clearHistory } from './lib/history.js';
import { MODEL_PRESETS } from './lib/models.js';
import { listModels } from './lib/gemini.js';
import { userMessage, redactKey, GeminiError } from './lib/errors.js';

const $ = (id) => document.getElementById(id);
const CUSTOM = '__custom__';
let settings = null;
let modelList = [];
let toastTimer = 0;

function toast() {
  const t = $('toast');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 1500);
}

function say(id, text, kind) {
  const el = $(id);
  el.textContent = text;
  el.className = 'msg' + (kind ? ' ' + kind : '');
}

async function save(patch) {
  settings = await saveSettings(patch);
  toast();
}

function errText(err) {
  const m = userMessage(err instanceof GeminiError ? err : new GeminiError('network', { message: err && err.message }), { currentModel: settings && settings.model });
  return `${m.title}: ${m.body}`;
}

function buildModelSelect() {
  const sel = $('model');
  sel.replaceChildren();
  const seen = new Set();
  const add = (value, label) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    sel.appendChild(o);
  };
  for (const p of MODEL_PRESETS) { add(p.id, p.label); seen.add(p.id); }
  for (const id of modelList) if (!seen.has(id)) { add(id, id); seen.add(id); }
  add(CUSTOM, 'Custom…');
  if (seen.has(settings.model)) {
    sel.value = settings.model;
    $('customRow').hidden = true;
  } else {
    sel.value = CUSTOM;
    $('customRow').hidden = false;
    $('customModel').value = settings.model;
  }
}

async function loadModelList() {
  try {
    const r = await chrome.storage.local.get('modelList');
    modelList = Array.isArray(r.modelList) ? r.modelList.filter((x) => typeof x === 'string') : [];
  } catch { modelList = []; }
}

function fillForm() {
  $('apiKey').value = settings.apiKey;
  for (const r of document.querySelectorAll('input[name="length"]')) r.checked = r.value === settings.defaultLength;
  $('language').value = settings.language;
  $('maxChars').value = String(settings.maxChars);
  $('autoSummarize').checked = settings.autoSummarize;
  buildModelSelect();
}


/* ---------- v2 settings: features, privacy, site access ---------- */

const SWITCHES = ['citations', 'structuredExtraction', 'readFrames', 'beyondPage', 'webSearch', 'explicitCache', 'sensitiveGuard', 'historyEnabled', 'historySaveChat'];

function fillV2() {
  for (const id of SWITCHES) $(id).checked = !!settings[id];
  for (const r of document.querySelectorAll('input[name="vision"]')) r.checked = r.value === settings.vision;
  for (const r of document.querySelectorAll('input[name="ytmode"]')) r.checked = r.value === settings.youtubeMode;
  $('translateTarget').value = settings.translateTarget;
  $('siteBlocklist').value = settings.siteBlocklist.join('\n');
}

// Origins the user granted: everything optional, so not the Gemini host the manifest asks for at install.
async function grantedOrigins() {
  const all = await chrome.permissions.getAll();
  const required = new Set((chrome.runtime.getManifest().host_permissions) || []);
  return (all.origins || []).filter((o) => !required.has(o));
}

async function renderSites() {
  const list = $('siteList');
  list.replaceChildren();
  let origins = [];
  try { origins = await grantedOrigins(); } catch { origins = []; }
  $('siteEmpty').hidden = origins.length > 0;
  $('revokeAll').disabled = origins.length === 0;
  for (const o of origins) {
    const li = document.createElement('li');
    li.className = 'site-row';
    const name = document.createElement('span');
    name.className = 'site-name';
    name.textContent = o === '<all_urls>' || o === '*://*/*' ? 'All sites' : o.replace(/\/\*$/, '');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-secondary btn-sm';
    b.textContent = 'Revoke';
    b.setAttribute('aria-label', `Revoke access to ${name.textContent}`);
    b.addEventListener('click', async () => {
      try { await chrome.permissions.remove({ origins: [o] }); say('siteMsg', 'Revoked', 'ok'); } catch { say('siteMsg', 'Could not revoke that site.', 'err'); }
      renderSites();
    });
    li.append(name, b);
    list.appendChild(li);
  }
}

function initV2() {
  fillV2();
  for (const id of SWITCHES) $(id).addEventListener('change', () => save({ [id]: $(id).checked }));
  for (const r of document.querySelectorAll('input[name="vision"]')) r.addEventListener('change', () => { if (r.checked) save({ vision: r.value }); });
  for (const r of document.querySelectorAll('input[name="ytmode"]')) r.addEventListener('change', () => { if (r.checked) save({ youtubeMode: r.value }); });
  $('translateTarget').addEventListener('change', () => save({ translateTarget: $('translateTarget').value.trim() }));
  $('siteBlocklist').addEventListener('change', async () => {
    const lines = $('siteBlocklist').value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    await save({ siteBlocklist: lines });
    const kept = settings.siteBlocklist.length;
    $('siteBlocklist').value = settings.siteBlocklist.join('\n');
    say('blocklistMsg', kept === lines.length ? '' : `${lines.length - kept} entries were not valid hosts and were removed.`, kept === lines.length ? '' : 'warn');
  });
  $('revokeAll').addEventListener('click', async () => {
    try {
      const origins = await grantedOrigins();
      if (origins.length) await chrome.permissions.remove({ origins });
      say('siteMsg', 'Revoked', 'ok');
    } catch { say('siteMsg', 'Could not revoke all sites.', 'err'); }
    renderSites();
  });
  $('clearHistory').addEventListener('click', async () => {
    try { await clearHistory(); say('dataMsg', 'History cleared', 'ok'); } catch { say('dataMsg', 'Could not clear history.', 'err'); }
  });
  renderSites();
  // Grants can also change from the panel while this page is open.
  if (chrome.permissions.onAdded) chrome.permissions.onAdded.addListener(renderSites);
  if (chrome.permissions.onRemoved) chrome.permissions.onRemoved.addListener(renderSites);
}

function currentKey() { return $('apiKey').value.trim(); }

async function init() {
  settings = await getSettings();
  await loadModelList();
  fillForm();

  $('keyShow').addEventListener('click', () => {
    const inp = $('apiKey');
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    $('keyShow').textContent = show ? 'Hide' : 'Show';
  });

  $('keySave').addEventListener('click', async () => {
    const k = currentKey();
    await save({ apiKey: k });
    if (k && !k.startsWith('AIza')) say('keyMsg', "Saved, but this doesn't look like a Google API key (they usually start with AIza).", 'warn');
    else say('keyMsg', k ? 'Key saved.' : 'Key cleared.', 'ok');
  });

  $('keyRemove').addEventListener('click', async () => {
    $('apiKey').value = '';
    await save({ apiKey: '' });
    say('keyMsg', 'Key removed.', 'ok');
  });

  $('keyTest').addEventListener('click', async () => {
    const k = currentKey() || settings.apiKey;
    if (!k) { say('keyMsg', 'Enter a key first.', 'err'); return; }
    say('keyMsg', 'Testing…');
    try {
      const ids = await listModels({ apiKey: k });
      say('keyMsg', `Key works: ${ids.length} models available`, 'ok');
    } catch (err) {
      say('keyMsg', redactKey(errText(err)), 'err');
    }
  });

  $('model').addEventListener('change', async () => {
    const v = $('model').value;
    if (v === CUSTOM) {
      $('customRow').hidden = false;
      $('customModel').focus();
      return;
    }
    $('customRow').hidden = true;
    await save({ model: v });
  });
  $('customModel').addEventListener('change', async () => {
    const v = $('customModel').value.trim();
    if (v) await save({ model: v });
  });

  $('modelRefresh').addEventListener('click', async () => {
    const k = currentKey() || settings.apiKey;
    if (!k) { say('modelMsg', 'Enter and save a key first.', 'err'); return; }
    say('modelMsg', 'Refreshing…');
    try {
      modelList = await listModels({ apiKey: k });
      await chrome.storage.local.set({ modelList });
      buildModelSelect();
      say('modelMsg', `${modelList.length} models found.`, 'ok');
    } catch (err) {
      say('modelMsg', redactKey(errText(err)), 'err');
    }
  });

  for (const r of document.querySelectorAll('input[name="length"]')) {
    r.addEventListener('change', () => { if (r.checked) save({ defaultLength: r.value }); });
  }
  $('language').addEventListener('change', () => save({ language: $('language').value.trim() }));
  $('maxChars').addEventListener('change', async () => {
    await save({ maxChars: Number($('maxChars').value) });
    $('maxChars').value = String(settings.maxChars);
  });
  $('autoSummarize').addEventListener('change', () => save({ autoSummarize: $('autoSummarize').checked }));

  initV2();

  $('clearCache').addEventListener('click', async () => {
    try { await clearCache(); say('dataMsg', 'Cleared', 'ok'); } catch { say('dataMsg', 'Could not clear cache.', 'err'); }
  });
}

init().catch((err) => { console.error(redactKey(String(err && err.message))); });
