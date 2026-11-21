// One Gemini request for a tab (summary or chat answer): what is sent, citation style, the explicit context cache,
// and the YouTube transcript fallback. No DOM. fetch, base URL and the session storage area are injectable for tests.
import { buildSystemPrompt, buildContents, buildChatTail } from '../lib/prompts.js';
import { streamGenerate, buildRequestBody } from '../lib/gemini.js';
import { GeminiError } from '../lib/errors.js';
import {
  shouldUseExplicitCache, estimateTokens, createCache, deleteCache, unsupportedModels, markUnsupported, cacheIsFresh,
} from '../lib/cachectl.js';
import { prepareFirstTurn, switchToTranscript } from './media.js';

// How citations are written for this page: [c12] chunk ids, [p3] PDF pages, [t=12:34] video moments, none for screenshots.
export function citeStyleFor(page) {
  if (!page) return 'none';
  if (page.kind === 'pdf') return 'pdf';
  if (page.kind === 'video') return 'video';
  if (page.kind === 'image') return 'none';
  return 'chunk';
}

export function citationsOn(settings, page) {
  return !!settings.citations && citeStyleFor(page) !== 'none';
}

function estimateFor(st) {
  const page = st.page;
  const chars = (page.chunks || []).reduce((n, c) => n + c.text.length, 0);
  const m = st.media || {};
  const pdfPages = page.kind === 'pdf' ? (Number.isFinite(m.pages) && m.pages ? m.pages : Math.ceil((m.bytes || 0) / 50000)) : 0;
  return estimateTokens({
    chars, pdfPages, pdfLevel: m.level, videoSec: page.kind === 'video' && !(m.transcript) ? (page.video && page.video.duration) || 0 : 0,
  });
}

// Explicit cache (spec 8.7), only for follow-ups. Returns the cache name to use, or null to send everything.
// Any failure to create a cache marks the model unsupported for 24 h and carries on uncached, silently.
async function ensureCache(st, { settings, system, first, summary, baseUrl, fetchImpl, storage }) {
  if (!settings.explicitCache) return null;
  let map = {};
  try { map = ((await storage.get('cacheUnsupported')) || {}).cacheUnsupported || {}; } catch { map = {}; }
  const ok = shouldUseExplicitCache({
    enabled: settings.explicitCache, estTokens: estimateFor(st), model: settings.model, unsupported: unsupportedModels(map),
  });
  if (!ok) return null;
  const c = st.cache;
  // The system prompt is baked into a cache, so a changed rule (beyond-page toggle) needs a new one.
  if (c && c.model === settings.model && c.summary === summary && (c.system === undefined || c.system === system) && cacheIsFresh(c)) return c.name;
  if (c && c.name) await deleteCache({ apiKey: settings.apiKey, name: c.name, baseUrl, fetchImpl });
  st.cache = null;
  try {
    const made = await createCache({
      apiKey: settings.apiKey, model: settings.model, system,
      contents: [first, { role: 'model', parts: [{ text: summary }] }], baseUrl, fetchImpl,
    });
    st.cache = { name: made.name, expireAt: made.expireAt, model: settings.model, summary, system };
    return made.name;
  } catch {
    try { await storage.set({ cacheUnsupported: markUnsupported(map, settings.model) }); } catch { /* session storage unavailable */ }
    return null;
  }
}

// Search sources become a plain markdown list of https links under the answer.
function withSources(r) {
  if (!r || !r.sources || !r.sources.length) return r;
  const clean = (t) => String(t).replace(/[\[\]()\\]/g, '').trim();
  const lines = r.sources.map((s) => `- [${clean(s.title || new URL(s.uri).hostname) || 'source'}](${s.uri.replace(/[()\s]/g, encodeURIComponent)})`);
  return { ...r, text: `${r.text}\n\nSources:\n${lines.join('\n')}` };
}

// o: { settings, windowId, kind: 'summary' | 'answer', length, summary, messages, signal, onText, baseUrl?, fetchImpl?, storage? }
// Returns { text, finishReason }.
export async function runRequest(st, o) {
  const { settings } = o;
  const storage = o.storage || chrome.storage.session;
  const page = st.page;
  const nonce = st.conv.nonce;
  const cites = citationsOn(settings, page);
  const answer = o.kind === 'answer';
  // Beyond-the-page answers apply to follow-up questions only; summaries always stay on the page.
  const beyond = !answer ? undefined : settings.beyondPage === false ? 'off' : settings.webSearch ? 'web' : 'knowledge';
  const sysFor = (b) => buildSystemPrompt(settings.language, { citations: cites, citeStyle: cites ? citeStyleFor(page) : 'none', beyond: b });
  const system = sysFor(beyond);

  const send = (body) => streamGenerate({
    apiKey: settings.apiKey, model: settings.model, body, signal: o.signal, onText: o.onText, baseUrl: o.baseUrl, fetchImpl: o.fetchImpl,
  });
  const contentsFor = (turn) => buildContents({
    page, nonce, length: o.length, summary: answer ? o.summary : null, messages: answer ? o.messages : [],
    firstParts: turn.firstParts, turn: turn.turn, citeIds: cites && turn.ids,
  });

  async function attempt(turn) {
    const full = contentsFor(turn);
    if (beyond === 'web') {
      // Search grounding cannot ride on a cached context, so this sends everything. If the model or key
      // does not allow search, fall back to general knowledge without it.
      try {
        const r = await send(buildRequestBody({ system, contents: full, webSearch: true }));
        return withSources(r);
      } catch (err) {
        if (!(err instanceof GeminiError) || (err.code !== 'bad_request' && err.code !== 'forbidden')) throw err;
        return send(buildRequestBody({ system: sysFor('knowledge'), contents: full }));
      }
    }
    if (answer) {
      const cached = await ensureCache(st, { settings, system, first: full[0], summary: o.summary, baseUrl: o.baseUrl, fetchImpl: o.fetchImpl, storage });
      if (cached) {
        try {
          return await send(buildRequestBody({ system, contents: buildChatTail(o.messages), cachedContent: cached }));
        } catch (err) {
          // A cache the server no longer accepts (expired, evicted, wrong model): forget it and send everything.
          if (!(err instanceof GeminiError) || (err.code !== 'bad_request' && err.code !== 'model_not_found')) throw err;
          st.cache = null;
        }
      }
    }
    return send(buildRequestBody({ system, contents: full }));
  }

  const turn = await prepareFirstTurn(st, { settings, windowId: o.windowId, nonce });
  try {
    return await attempt(turn);
  } catch (err) {
    // A video Gemini can't watch: use the transcript panel if the user has it open, else show the error card.
    if (err instanceof GeminiError && err.code === 'video_unavailable' && page.kind === 'video' && !(st.media && st.media.transcript)) {
      const fb = await switchToTranscript(st, nonce);
      if (fb) return attempt(fb);
    }
    throw err;
  }
}
