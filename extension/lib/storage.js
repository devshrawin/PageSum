// Settings (storage.local) and summary cache (storage.session). Area is injectable.

export const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'gemini-3.5-flash-lite',
  defaultLength: 'medium',
  language: 'English',
  maxChars: 60000,
  autoSummarize: true,
};

const LENGTHS = ['short', 'medium', 'detailed'];

function sanitize(s) {
  const out = { ...DEFAULT_SETTINGS, ...(s || {}) };
  const n = Number(out.maxChars);
  out.maxChars = Math.min(400000, Math.max(5000, Number.isFinite(n) ? Math.round(n) : DEFAULT_SETTINGS.maxChars));
  if (!LENGTHS.includes(out.defaultLength)) out.defaultLength = DEFAULT_SETTINGS.defaultLength;
  if (typeof out.model !== 'string' || !out.model.trim()) out.model = DEFAULT_SETTINGS.model;
  out.apiKey = String(out.apiKey || '').trim();
  out.language = String(out.language == null ? '' : out.language);
  out.autoSummarize = !!out.autoSummarize;
  return out;
}

export async function getSettings(area = chrome.storage.local) {
  const res = await area.get('settings');
  return sanitize(res && res.settings);
}

export async function saveSettings(patch, area = chrome.storage.local) {
  const merged = sanitize({ ...(await getSettings(area)), ...patch });
  await area.set({ settings: merged });
  return merged;
}

export function pruneCache(cache, max = 30) {
  const entries = Object.entries((cache && cache.entries) || {});
  entries.sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  return { entries: Object.fromEntries(entries.slice(0, max)) };
}

async function readCache(area) {
  const res = await area.get('cache');
  return (res && res.cache && res.cache.entries) ? res.cache : { entries: {} };
}

export async function getCacheEntry(urlKey, area = chrome.storage.session) {
  const cache = await readCache(area);
  return cache.entries[urlKey] || null;
}

export async function putCacheEntry(urlKey, entry, area = chrome.storage.session) {
  const cache = await readCache(area);
  cache.entries[urlKey] = { ...entry, at: Date.now() };
  await area.set({ cache: pruneCache(cache) });
}

export async function deleteCacheEntry(urlKey, area = chrome.storage.session) {
  const cache = await readCache(area);
  delete cache.entries[urlKey];
  await area.set({ cache });
}

export async function clearCache(area = chrome.storage.session) {
  await area.remove('cache');
}
