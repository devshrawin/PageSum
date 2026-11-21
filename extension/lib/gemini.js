// Gemini REST client (streaming). fetch is injectable for tests.
import { createSseParser } from './sse.js';
import { GeminiError, mapHttpError, mapFetchError, mapFinishReason, mapVideoError } from './errors.js';
import { filterModelList } from './models.js';
import { validate } from './jsonschema.js';

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// json: a response schema (structured output, phase 3) or undefined.
// jsonStyle 'responseFormat' (REST docs) or 'legacy' (responseMimeType + responseJsonSchema).
// cachedContent: 'cachedContents/{id}'. The system prompt then lives in the cache, so it is left out.
// No sampling fields (temperature, topP...) are ever sent: they are ignored on current models.
export function buildRequestBody({ system, contents, json, jsonStyle = 'responseFormat', cachedContent, webSearch }) {
  const body = {};
  if (cachedContent) body.cachedContent = cachedContent;
  else body.systemInstruction = { parts: [{ text: system }] };
  body.contents = contents;
  // Google Search grounding for current facts. Not combined with a cached context.
  if (webSearch && !cachedContent) body.tools = [{ google_search: {} }];
  if (json) {
    body.generationConfig = jsonStyle === 'legacy'
      ? { responseMimeType: 'application/json', responseJsonSchema: json }
      : { responseFormat: { text: { mimeType: 'APPLICATION_JSON', schema: json } } };
  }
  return body;
}

// Content part builders (text, inline file bytes, file URI such as a public YouTube URL).
export const parts = {
  text: (t) => ({ text: t }),
  inline: (mimeType, data, level) => ({ inlineData: { mimeType, data }, ...(level ? { mediaResolution: { level } } : {}) }),
  fileUri: (fileUri, level) => ({ fileData: { fileUri }, ...(level ? { mediaResolution: { level } } : {}) }),
};

export function extractChunk(json) {
  const cand = json && Array.isArray(json.candidates) ? json.candidates[0] : null;
  const parts = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts : [];
  let text = '';
  for (const p of parts) {
    if (p && p.thought === true) continue;
    if (p && typeof p.text === 'string') text += p.text;
  }
  // Search grounding sources: https only, short titles.
  const sources = [];
  const gm = cand && cand.groundingMetadata;
  for (const c of gm && Array.isArray(gm.groundingChunks) ? gm.groundingChunks : []) {
    const w = c && c.web;
    if (w && typeof w.uri === 'string' && /^https:\/\//i.test(w.uri)) {
      sources.push({ uri: w.uri, title: String(w.title || '').replace(/\s+/g, ' ').slice(0, 100) });
    }
  }
  return {
    text,
    sources,
    finishReason: (cand && cand.finishReason) ?? null,
    blockReason: (json && json.promptFeedback && json.promptFeedback.blockReason) ?? null,
    error: (json && json.error) ?? null,
  };
}

export function headers(apiKey) {
  return { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey };
}

export async function streamGenerate({
  apiKey, model, body, signal, onText,
  baseUrl = GEMINI_BASE, fetchImpl = fetch, idleMs = 60000,
}) {
  const url = `${baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const ctrl = new AbortController();
  let timedOut = false;
  let timer = null;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, idleMs);
  };
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let reader = null;
  try {
    arm();
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: headers(apiKey),
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      throw timedOut ? new GeminiError('timeout') : mapFetchError(err);
    }
    if (!res.ok) {
      let t = '';
      try { t = await res.text(); } catch { /* ignore */ }
      throw mapVideoError(mapHttpError(res.status, t), body);
    }

    let text = '';
    let finishReason = null;
    const sources = [];
    const parser = createSseParser((data) => {
      if (data.trim() === '[DONE]') return;
      let json;
      try { json = JSON.parse(data); } catch { return; }
      const c = extractChunk(json);
      if (c.error) throw mapHttpError(c.error.code || 500, JSON.stringify({ error: c.error }));
      if (c.blockReason) throw new GeminiError('blocked');
      if (c.finishReason) finishReason = c.finishReason;
      for (const s of c.sources) if (!sources.some((x) => x.uri === s.uri) && sources.length < 8) sources.push(s);
      if (c.text) {
        text += c.text;
        if (onText) onText(text);
      }
    });

    reader = res.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        arm();
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
      }
      parser.push(decoder.decode());
      parser.end();
    } catch (err) {
      if (err instanceof GeminiError) throw err;
      throw timedOut ? new GeminiError('timeout') : mapFetchError(err);
    }

    if (!text) {
      const e = mapFinishReason(finishReason);
      if (e) throw e;
      throw new GeminiError('empty');
    }
    return sources.length ? { text, finishReason, sources } : { text, finishReason };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    if (reader) { try { await reader.cancel(); } catch { /* ignore */ } }
  }
}

export async function listModels({ apiKey, baseUrl = GEMINI_BASE, fetchImpl = fetch }) {
  let res;
  try {
    res = await fetchImpl(`${baseUrl}/models?pageSize=1000`, { method: 'GET', headers: headers(apiKey) });
  } catch (err) {
    throw mapFetchError(err);
  }
  const t = await res.text();
  if (!res.ok) throw mapHttpError(res.status, t);
  let json = {};
  try { json = JSON.parse(t); } catch { /* ignore */ }
  return filterModelList(json.models);
}

/* ---------- structured output (spec B10) ---------- */

const jsonStyles = new Map();   // model -> 'responseFormat' | 'legacy', remembered for the session

export function resetJsonStyles() { jsonStyles.clear(); }

function stripFence(text) {
  const t = String(text).trim();
  const m = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(t);
  return m ? m[1].trim() : t;
}

// Streams a JSON answer, parses it, validates it locally (length limits are stripped server-side) and normalises it.
// Uses generationConfig.responseFormat; if the server rejects that field by name, retries once with the older
// responseMimeType + responseJsonSchema pair and remembers the choice for that model.
// A reply that does not parse or validate throws GeminiError('bad_json', { detail: first three problems }).
export async function generateJson({
  apiKey, model, system, contents, schema, normalize, signal, onProgress, baseUrl = GEMINI_BASE, fetchImpl = fetch, ignoreFormats = false,
}) {
  const run = (style) => streamGenerate({
    apiKey, model, signal, baseUrl, fetchImpl,
    body: buildRequestBody({ system, contents, json: schema, jsonStyle: style }),
    onText: onProgress ? (t) => onProgress(t.length) : undefined,
  });
  let style = jsonStyles.get(model) || 'responseFormat';
  let r;
  try {
    r = await run(style);
  } catch (err) {
    if (style === 'responseFormat' && err instanceof GeminiError && err.code === 'bad_request'
      && /responseFormat|response_format|Unknown name/i.test(String(err.message || ''))) {
      style = 'legacy';
      jsonStyles.set(model, style);
      r = await run(style);
    } else throw err;
  }
  let value;
  try {
    value = JSON.parse(stripFence(r.text));
  } catch {
    throw new GeminiError('bad_json', { detail: ['The reply was not valid JSON.'] });
  }
  const v = validate(schema, value, { formats: !ignoreFormats });
  if (!v.ok) throw new GeminiError('bad_json', { detail: v.errors.slice(0, 3) });
  return normalize ? normalize(value) : value;
}
