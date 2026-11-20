// Settings (storage.local) and summary cache (storage.session). Area is injectable.
import { normalizeHostEntry } from './sensitive.js';

export const DEFAULT_SETTINGS = {
  schemaVersion: 2,
  apiKey: '',
  model: 'gemini-3.5-flash-lite',
  defaultLength: 'medium',
  language: 'English',
  maxChars: 60000,
  autoSummarize: true,
  // v2
  citations: true,
  structuredExtraction: true,
  readFrames: true,
  vision: 'ask',               // 'ask' | 'auto' | 'off'
  youtubeMode: 'video',        // 'video' | 'transcript'
  explicitCache: false,
  translateTarget: 'English',
  historyEnabled: true,
  historySaveChat: false,
  sensitiveGuard: true,
  siteBlocklist: [],
};

const LENGTHS = ['short', 'medium', 'detailed'];
const VISION = ['ask', 'auto', 'off'];
const YT_MODES = ['video', 'transcript'];
const CACHE_KEY = 'cache2';
const OLD_CACHE_KEY = 'cache';
export const MAX_CACHE_ENTRIES = 20;

export function sanitize(s) {
  const out = { ...DEFAULT_SETTINGS, ...(s || {}) };
  const n = Number(out.maxChars);
  out.maxChars = Math.min(400000, Math.max(5000, Number.isFinite(n) ? Math.round(n) : DEFAULT_SETTINGS.maxChars));
  if (!LENGTHS.includes(out.defaultLength)) out.defaultLength = DEFAULT_SETTINGS.defaultLength;
  if (typeof out.model !== 'string' || !out.model.trim()) out.model = DEFAULT_SETTINGS.model;
  out.apiKey = String(out.apiKey || '').trim();
  out.language = String(out.language == null ? '' : out.language);
  out.autoSummarize = !!out.autoSummarize;
  out.citations = !!out.citations;
  out.structuredExtraction = !!out.structuredExtraction;
  out.readFrames = !!out.readFrames;
  out.explicitCache = !!out.explicitCache;
  out.historyEnabled = !!out.historyEnabled;
  out.historySaveChat = !!out.historySaveChat;
  out.sensitiveGuard = !!out.sensitiveGuard;
  if (!VISION.includes(out.vision)) out.vision = DEFAULT_SETTINGS.vision;
  if (!YT_MODES.includes(out.youtubeMode)) out.youtubeMode = DEFAULT_SETTINGS.youtubeMode;
  out.translateTarget = String(out.translateTarget == null ? '' : out.translateTarget).trim().slice(0, 60) || DEFAULT_SETTINGS.translateTarget;
  const seen = new Set();
  const list = [];
  for (const e of Array.isArray(out.siteBlocklist) ? out.siteBlocklist : []) {
    const h = normalizeHostEntry(e);
    if (h && !seen.has(h)) { seen.add(h); list.push(h); }
    if (list.length >= 200) break;
  }
  out.siteBlocklist = list;
  out.schemaVersion = 2;
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

// v1 -> v2: rewrite settings through sanitize() (v1 fields are kept) and drop the v1 session cache.
// Idempotent. Both areas are injectable for tests.
export async function migrateStorage(local = chrome.storage.local, session = chrome.storage.session) {
  const res = await local.get('settings');
  if (res && res.settings && typeof res.settings === 'object') {
    await local.set({ settings: sanitize(res.settings) });
  }
  try { await session.remove(OLD_CACHE_KEY); } catch { /* session area unavailable */ }
}

export function pruneCache(cache, max = MAX_CACHE_ENTRIES) {
  const entries = Object.entries((cache && cache.entries) || {});
  entries.sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  return { entries: Object.fromEntries(entries.slice(0, max)) };
}

async function readCache(area) {
  const res = await area.get(CACHE_KEY);
  return (res && res[CACHE_KEY] && res[CACHE_KEY].entries) ? res[CACHE_KEY] : { entries: {} };
}

export async function getCacheEntry(urlKey, area = chrome.storage.session) {
  const cache = await readCache(area);
  return cache.entries[urlKey] || null;
}

export async function putCacheEntry(urlKey, entry, area = chrome.storage.session) {
  const cache = await readCache(area);
  cache.entries[urlKey] = { ...entry, v: 2, at: Date.now() };
  await area.set({ [CACHE_KEY]: pruneCache(cache) });
}

export async function deleteCacheEntry(urlKey, area = chrome.storage.session) {
  const cache = await readCache(area);
  delete cache.entries[urlKey];
  await area.set({ [CACHE_KEY]: cache });
}

export async function clearCache(area = chrome.storage.session) {
  await area.remove([CACHE_KEY, OLD_CACHE_KEY]);
}
