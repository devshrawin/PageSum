// Error types, mapping and user messages. Pure.
import { DEFAULT_MODEL } from './models.js';

export class GeminiError extends Error {
  constructor(code, { status, message, retryAfterSec, detail } = {}) {
    super(message || code);
    this.name = 'GeminiError';
    this.code = code;
    this.status = status;
    this.retryAfterSec = retryAfterSec;
    this.detail = detail;
  }
}

export function redactKey(str) {
  return String(str == null ? '' : str).replace(/AIza[0-9A-Za-z_\-]{30,}/g, 'AIza…[redacted]');
}

function parseBody(bodyText) {
  let json = {};
  try { json = JSON.parse(bodyText); } catch { json = {}; }
  if (Array.isArray(json)) json = json[0];
  return json && typeof json === 'object' ? json : {};
}

export function mapHttpError(status, bodyText) {
  const json = parseBody(bodyText);
  const e = json.error && typeof json.error === 'object' ? json.error : {};
  const details = Array.isArray(e.details) ? e.details : [];
  const reason = (details.find((d) => d && d.reason) || {}).reason;
  const message = redactKey(typeof e.message === 'string' ? e.message : '');

  let retryAfterSec;
  const ri = details.find((d) => d && d.retryDelay);
  if (ri) {
    const n = parseFloat(String(ri.retryDelay));
    if (Number.isFinite(n)) retryAfterSec = Math.ceil(n);
  }
  const daily = details.some((d) => d && Array.isArray(d.violations) &&
    d.violations.some((v) => v && typeof v.quotaId === 'string' && v.quotaId.includes('PerDay')));

  const opts = { status, message, retryAfterSec, detail: { reason, daily } };

  if (reason === 'API_KEY_INVALID' || (status === 400 && /api key not valid/i.test(message))) return new GeminiError('bad_key', opts);
  if (status === 400 && /location is not supported/i.test(message)) return new GeminiError('region', opts);
  if (status === 400) return new GeminiError('bad_request', opts);
  if (status === 401 || status === 403) return new GeminiError('forbidden', opts);
  if (status === 404) return new GeminiError('model_not_found', opts);
  if (status === 429) return new GeminiError('quota', opts);
  if ([500, 502, 503, 504].includes(status)) return new GeminiError('server', opts);
  return new GeminiError('http', opts);
}

export function mapFetchError(err) {
  if (err && err.name === 'AbortError') return new GeminiError('aborted');
  return new GeminiError('network', { message: redactKey(err && err.message) });
}

const BLOCKED = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY']);

export function mapFinishReason(reason) {
  if (!reason) return null;
  if (BLOCKED.has(reason)) return new GeminiError('blocked');
  if (reason === 'RECITATION') return new GeminiError('recitation');
  if (reason === 'OTHER' || reason === 'MALFORMED_FUNCTION_CALL') return new GeminiError('empty');
  return null;
}

export function userMessage(err, { currentModel } = {}) {
  const code = err && err.code;
  const model = currentModel || '';
  let r;
  switch (code) {
    case 'bad_key':
      r = { title: 'Invalid API key', body: 'Gemini rejected this key. Check it in Settings or create a new one at aistudio.google.com/apikey.', actions: ['settings'] }; break;
    case 'region':
      r = { title: 'Not available in your region', body: "Google doesn't offer the Gemini API in your location.", actions: [] }; break;
    case 'bad_request':
      r = { title: 'Request rejected', body: redactKey(err.message || '').slice(0, 200), actions: ['retry'] }; break;
    case 'forbidden':
      r = { title: 'Key not allowed', body: "This key can't call the Gemini API. Check its API restrictions in Google Cloud, or create a new key in AI Studio.", actions: ['settings'] }; break;
    case 'model_not_found':
      r = { title: 'Model not available', body: `${model} isn't available for this key. Pick another model in Settings.`, actions: ['switchModel', 'settings'] }; break;
    case 'quota': {
      const daily = err.detail && err.detail.daily;
      r = {
        title: 'Rate limit reached',
        body: daily
          ? `Daily free quota for ${model} is used up. Try a different model or come back tomorrow.`
          : `Too many requests. Try again in ${err.retryAfterSec ?? 60}s.`,
        actions: ['retry', 'switchModel'],
      };
      break;
    }
    case 'server':
      r = { title: 'Gemini is busy', body: "Google's servers are overloaded. Try again in a moment.", actions: ['retry'] }; break;
    case 'http':
      r = { title: `Unexpected error (${err.status})`, body: redactKey(err.message || '').slice(0, 200), actions: ['retry'] }; break;
    case 'network':
      r = { title: "Can't reach Gemini", body: 'Check your internet connection.', actions: ['retry'] }; break;
    case 'timeout':
      r = { title: 'Gemini stopped responding', body: 'No data for 60 seconds.', actions: ['retry'] }; break;
    case 'blocked':
      r = { title: 'Response blocked', body: "Gemini's safety filters blocked this request for this page.", actions: [] }; break;
    case 'recitation':
      r = { title: 'Response withheld', body: 'Gemini declined because the answer would copy the source too closely. Try a shorter length or ask a narrower question.', actions: ['retry'] }; break;
    case 'empty':
      r = { title: 'Empty response', body: 'Gemini returned no text. Try again.', actions: ['retry'] }; break;
    case 'aborted':
      r = { title: '', body: '', actions: [] }; break;
    default:
      r = { title: 'Something went wrong', body: redactKey((err && err.message) || 'Unknown error').slice(0, 200), actions: ['retry'] };
  }
  if (currentModel === DEFAULT_MODEL) r.actions = r.actions.filter((a) => a !== 'switchModel');
  return r;
}
