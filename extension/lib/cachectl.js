// Explicit context cache (spec 8.7). Opt-in (settings.explicitCache), off by default, "paid tier only".
// Implicit caching needs no code: the system prompt and the first user turn stay byte-identical across follow-ups.
// fetch is injectable for tests. The key only ever travels in the x-goog-api-key header.
import { GEMINI_BASE, headers } from './gemini.js';
import { GeminiError, mapHttpError, mapFetchError } from './errors.js';

export const CACHE_MIN_TOKENS = 32768;          // below this the cache would cost more than it saves (minimum is "varies by model")
export const UNSUPPORTED_MS = 24 * 60 * 60 * 1000;
const NAME_RE = /^cachedContents\/[A-Za-z0-9_-]+$/;

export function shouldUseExplicitCache({ enabled, estTokens, model, unsupported }) {
  return !!enabled && Number(estTokens) >= CACHE_MIN_TOKENS && !(unsupported && unsupported.has(model));
}

export function estimateTokens({ chars = 0, pdfPages = 0, pdfLevel, videoSec = 0 } = {}) {
  const perPage = pdfLevel === 'MEDIA_RESOLUTION_LOW' ? 280 : 560;
  return Math.ceil(chars / 4) + pdfPages * perPage + Math.ceil(videoSec * 100);
}

// session storage key cacheUnsupported: { [model]: untilMs }
export function unsupportedModels(map, now = Date.now()) {
  const out = new Set();
  for (const [model, until] of Object.entries(map || {})) if (Number(until) > now) out.add(model);
  return out;
}
export function markUnsupported(map, model, now = Date.now()) {
  const next = {};
  for (const [m, until] of Object.entries(map || {})) if (Number(until) > now) next[m] = until;
  next[model] = now + UNSUPPORTED_MS;
  return next;
}

// A cache is reusable until 30 s before it expires.
export function cacheIsFresh(cache, now = Date.now()) {
  return !!cache && !!cache.name && now <= cache.expireAt - 30000;
}

// contents: [first user turn, model summary turn]. Returns { name, expireAt }.
export async function createCache({ apiKey, model, system, contents, ttlSec = 900, baseUrl = GEMINI_BASE, fetchImpl = fetch }) {
  let res;
  try {
    res = await fetchImpl(`${baseUrl}/cachedContents`, {
      method: 'POST',
      headers: headers(apiKey),
      body: JSON.stringify({
        model: `models/${model}`,
        systemInstruction: { parts: [{ text: system }] },
        contents,
        ttl: `${ttlSec}s`,
      }),
    });
  } catch (err) {
    throw mapFetchError(err);
  }
  const text = await res.text();
  if (!res.ok) throw mapHttpError(res.status, text);
  let json = {};
  try { json = JSON.parse(text); } catch { json = {}; }
  if (typeof json.name !== 'string' || !NAME_RE.test(json.name)) throw new GeminiError('bad_request', { message: 'Unexpected cache response' });
  const t = Date.parse(json.expireTime);
  return { name: json.name, expireAt: Number.isFinite(t) ? t : Date.now() + ttlSec * 1000 };
}

// Best effort: errors are swallowed.
export async function deleteCache({ apiKey, name, baseUrl = GEMINI_BASE, fetchImpl = fetch }) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) return;
  try {
    await fetchImpl(`${baseUrl}/${name}`, { method: 'DELETE', headers: headers(apiKey) });
  } catch { /* ignore */ }
}
