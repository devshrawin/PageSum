// Multi-tab compare (spec section 11): read up to four tabs, ask Gemini for a criteria table, clean it.
// No DOM. Permissions are requested by the UI (compare.js) inside the click that needs them.
import { generateJson } from '../lib/gemini.js';
import { isRestrictedUrl } from '../lib/text.js';
import { renumberFrames, selectChunks } from '../lib/chunks.js';
import { chunkResolver } from '../lib/citations.js';
import { COMPARE_SCHEMA, normalizeCompare } from '../lib/schemas.js';
import { buildCompareContents, buildToolSystem, makeNonce } from '../lib/prompts.js';
import { callAgent, ensureAgent } from './agent.js';

export const MAX_COMPARE_TABS = 4;
export const MIN_TAB_CHARS = 10000;

export const ASLEEP = 'This tab is asleep. Open it once, then try again.';
export const NO_ACCESS = "PageSum can't read this tab. Allow its site, or open the tab and click the PageSum icon.";

// Tabs the user may pick: ones Chrome lets an extension read (needs the optional "tabs" permission to see urls).
export function selectableTabs(tabs) {
  return (tabs || []).filter((t) => t && t.url && isRestrictedUrl(t.url, { title: t.title }).ok);
}

export function hostOfTab(tab) {
  try { return new URL(tab.url).hostname; } catch { return ''; }
}

// One match pattern per distinct http(s) site among the chosen tabs (hostname, so every port of that host).
export function originsFor(tabs) {
  const set = new Set();
  for (const t of tabs) {
    try {
      const u = new URL(t.url);
      if (u.protocol === 'http:' || u.protocol === 'https:') set.add(`${u.protocol}//${u.hostname}/*`);
    } catch { /* skip */ }
  }
  return [...set];
}

async function readTab(tab, perTabChars) {
  let live;
  try { live = await chrome.tabs.get(tab.id); } catch { return { ok: false, error: 'This tab was closed.' }; }
  if (live.discarded) return { ok: false, error: ASLEEP };
  if (live.url && !isRestrictedUrl(live.url, { title: live.title }).ok) return { ok: false, error: "Chrome doesn't let extensions read this page." };
  try {
    await ensureAgent(tab.id);
    const out = await callAgent(tab.id, 'extract', { ignoreSelection: true, maxRawChars: perTabChars * 2, maxChunkChars: 600, structured: false }, { frameIds: [0] });
    const r = out[0];
    if (!r || !r.ok) return { ok: false, error: NO_ACCESS };
    const { chunks } = renumberFrames([{ frameId: 0, result: r.data }]);
    const sel = selectChunks(chunks, perTabChars);
    if (!sel.chunks.length) return { ok: false, error: 'There is no readable text on this tab.' };
    return { ok: true, title: r.data.title || live.title || '', url: r.data.url || live.url || tab.url, chunks: sel.chunks };
  } catch {
    return { ok: false, error: NO_ACCESS };
  }
}

// tabs: [{ id, title, url }] in selection order (at most 4). Returns { rows, result } where rows say, per chosen
// tab, whether it was read, and result is null unless at least two tabs could be read.
export async function runCompare({ tabs, focus, settings, signal, baseUrl, fetchImpl }) {
  const chosen = tabs.slice(0, MAX_COMPARE_TABS);
  const perTab = Math.max(MIN_TAB_CHARS, Math.floor(settings.maxChars / chosen.length));
  const rows = [];
  for (const tab of chosen) {
    const read = await readTab(tab, perTab);
    rows.push({ tab, ...read });
  }
  const good = rows.filter((r) => r.ok);
  if (good.length < 2) return { rows, result: null, message: 'PageSum needs at least two readable tabs to compare.' };

  // Chunk ids are namespaced per tab: t1c1, t1c2, ..., t2c1 ... (k follows the order of the tabs that were read).
  const compared = good.map((r, i) => {
    const key = `t${i + 1}`;
    return {
      key, tabId: r.tab.id, title: r.title, url: r.url, host: hostOfTab({ url: r.url }),
      chunks: r.chunks.map((c) => ({ ...c, id: key + c.id })),
    };
  });
  const keys = compared.map((c) => c.key);
  const resolve = chunkResolver(compared.flatMap((c) => c.chunks));
  const data = await generateJson({
    apiKey: settings.apiKey, model: settings.model, system: buildToolSystem(settings.language),
    contents: buildCompareContents(compared, makeNonce(), focus), schema: COMPARE_SCHEMA,
    normalize: (v) => normalizeCompare(v, keys, resolve), signal, baseUrl, fetchImpl,
  });
  return { rows, result: { ...data, tabs: compared } };
}

// Columns and rows for Copy CSV / Markdown / JSON: Criterion, then one column per tab (its title).
export function compareTable(result) {
  const columns = ['Criterion', ...result.tabs.map((t) => t.title || t.host || t.key)];
  const rows = result.criteria.map((c) => [c.name, ...c.values.map((v) => v.value)]);
  return { columns, rows };
}

// Where a namespaced citation points: { tab, chunk } or null.
export function locateCite(result, id) {
  const m = /^(t\d+)c\d+$/.exec(id);
  if (!m || !result) return null;
  const tab = result.tabs.find((t) => t.key === m[1]);
  const chunk = tab && tab.chunks.find((c) => c.id === id);
  return chunk ? { tab, chunk } : null;
}
