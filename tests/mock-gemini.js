// Mock Gemini server for e2e tests. Behaviour is chosen by the x-goog-api-key value.
import http from 'node:http';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const textEvent = (text, extra = {}) => ({ candidates: [{ content: { role: 'model', parts: [{ text }] }, ...extra }] });

const errBody = (code, message, details = []) => JSON.stringify({ error: { code, message, status: 'X', details } });

export const MODELS_FIXTURE = {
  models: [
    { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent', 'countTokens'] },
    { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.8-pro', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.8-flash-image', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3-flash-tts', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
  ],
};

export function startMock() {
  let last = null;
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    const key = req.headers['x-goog-api-key'];
    last = { method: req.method, url: req.url, headers: req.headers, body };
    requests.push(last);

    const json = (status, text) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(text);
    };

    // Explicit context cache (spec 8.7). Key 'cache-unsupported' refuses; any other key creates cachedContents/abc.
    if (req.url === '/v1beta/cachedContents' && req.method === 'POST') {
      if (key === 'cache-unsupported') return json(400, errBody(400, 'Cached content is too small. total_token_count=100, min_total_token_count=32768'));
      const expireTime = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      return json(200, JSON.stringify({ name: 'cachedContents/abc', model: body && body.model, expireTime }));
    }
    if (req.url.startsWith('/v1beta/cachedContents/') && req.method === 'DELETE') return json(200, '{}');

    if (req.method === 'GET' && req.url.startsWith('/v1beta/models')) {
      if (key === 'badkey') return json(400, BAD_KEY);
      return json(200, JSON.stringify(MODELS_FIXTURE));
    }

    if (req.method === 'POST' && req.url.includes(':streamGenerateContent')) {
      switch (key) {
        case 'badkey': return json(400, BAD_KEY);
        case 'quota-day':
          return json(429, errBody(429, 'Quota exceeded', [
            { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] },
          ]));
        case 'quota-min':
          return json(429, errBody(429, 'Quota exceeded', [
            { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] },
            { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' },
          ]));
        case 'notfound': return json(404, errBody(404, 'models/x is not found'));
        case 'busy': return json(503, errBody(503, 'The model is overloaded.'));
        case 'pdf': {
          const p = body && body.contents && body.contents[0] && body.contents[0].parts && body.contents[0].parts[0];
          const ok = p && p.inlineData && p.inlineData.mimeType === 'application/pdf' && /^[A-Za-z0-9+/]+={0,2}$/.test(p.inlineData.data || '');
          if (!ok) return json(400, errBody(400, 'ASSERT: first part must be inlineData application/pdf with base64 data'));
          break;
        }
        case 'image': {
          const p = body && body.contents && body.contents[0] && body.contents[0].parts && body.contents[0].parts[0];
          const ok = p && p.inlineData && p.inlineData.mimeType === 'image/jpeg' && /^[A-Za-z0-9+/]+={0,2}$/.test(p.inlineData.data || '');
          if (!ok) return json(400, errBody(400, 'ASSERT: first part must be inlineData image/jpeg with base64 data'));
          break;
        }
        case 'youtube': {
          const p = body && body.contents && body.contents[0] && body.contents[0].parts && body.contents[0].parts[0];
          const ok = p && p.fileData && /^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}$/.test(p.fileData.fileUri || '');
          if (!ok) return json(400, errBody(400, 'ASSERT: first part must be fileData with the canonical watch address'));
          break;
        }
        case 'youtube-private': {
          // Only a request that carries the video as fileData is refused (a private video). Text-only requests work.
          const hasVideo = body && body.contents && body.contents.some((c) => c.parts && c.parts.some((p) => p.fileData));
          if (hasVideo) return json(400, errBody(400, 'File URI not accessible'));
          break;
        }
        case 'cache-ok': {
          if (body && body.cachedContent) {
            if (body.cachedContent !== 'cachedContents/abc' || body.systemInstruction) {
              return json(400, errBody(400, 'ASSERT: cachedContent must be cachedContents/abc and systemInstruction must be omitted'));
            }
          }
          break;
        }
        default: break;
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.flushHeaders();
      const gap = () => sleep(20);
      const closed = () => res.destroyed || res.writableEnded;
      if (key === 'stall') {
        req.on('close', () => { try { res.end(); } catch { /* ignore */ } });
        return; // headers sent, then nothing
      }
      if (key === 'blocked') {
        res.write(sse({ promptFeedback: { blockReason: 'SAFETY' } }));
        return res.end();
      }
      if (key === 'empty') {
        res.write(sse({ candidates: [{ finishReason: 'OTHER' }] }));
        return res.end();
      }
      if (key === 'midstream-error') {
        res.write(sse(textEvent('partial ')));
        await gap();
        res.write(sse({ error: { code: 500, message: 'Internal error', status: 'INTERNAL' } }));
        return res.end();
      }
      if (key === 'thought') {
        res.write(sse({ candidates: [{ content: { role: 'model', parts: [{ text: 'SECRET THINKING', thought: true }, { text: 'Visible' }] } }] }));
        await gap();
        res.write(sse(textEvent(' answer', { finishReason: 'STOP' })));
        return res.end();
      }
      if (key === 'maxtokens') {
        res.write(sse(textEvent('cut', { finishReason: 'MAX_TOKENS' })));
        return res.end();
      }
      // 'ok' (and anything else)
      res.write(sse(textEvent('**TL;DR:** Hello')));
      await gap();
      if (closed()) return;
      res.write(sse(textEvent(' world')));
      await gap();
      if (closed()) return;
      res.write(sse({
        candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 },
      }));
      return res.end();
    }
    json(404, errBody(404, 'no route'));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const handle = {
        url: `http://127.0.0.1:${port}/v1beta`,
        close: () => new Promise((r) => {
          server.close(() => r());
          if (server.closeAllConnections) server.closeAllConnections();
        }),
      };
      Object.defineProperty(handle, 'lastRequest', { get: () => last });
      Object.defineProperty(handle, 'requests', { get: () => requests });
      handle.reset = () => { requests.length = 0; last = null; };
      resolve(handle);
    });
  });
}

const BAD_KEY = errBody(400, 'API key not valid. Please pass a valid API key.', [
  { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' },
]);
