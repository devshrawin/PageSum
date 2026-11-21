// panel/request.js against the mock Gemini server: what is sent for HTML, PDF, screenshot and YouTube tabs,
// the transcript fallback, and the explicit context cache.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMock } from './mock-gemini.js';
import { runRequest, citeStyleFor, citationsOn } from '../extension/panel/request.js';
import { newState } from '../extension/panel/tabs.js';
import { sanitize } from '../extension/lib/storage.js';
import { GeminiError } from '../extension/lib/errors.js';

let mock;
before(async () => { mock = await startMock(); });
after(async () => { await mock.close(); delete globalThis.chrome; });
beforeEach(() => { mock.reset(); delete globalThis.chrome; });

function fakeArea() {
  const m = new Map();
  return {
    async get(key) { return m.has(key) ? { [key]: structuredClone(m.get(key)) } : {}; },
    async set(obj) { for (const [k, v] of Object.entries(obj)) m.set(k, structuredClone(v)); },
  };
}

const settings = (over = {}) => sanitize({ apiKey: 'ok', model: 'gemini-3.5-flash-lite', language: 'English', ...over });
const chunk = (id, text, kind = 'p') => ({ id, frameId: 0, localId: id.replace('c', 'b'), kind, text });
function htmlState(over = {}) {
  const st = newState(1);
  st.page = { title: 'T', url: 'https://a.com/x', source: 'article', kind: 'html', truncated: false, originalLength: 20, chunks: [chunk('c1', 'Title', 'h'), chunk('c2', 'First paragraph.')], ...over };
  st.conv.nonce = 'fixednonce';
  return st;
}
const run = (st, o = {}) => runRequest(st, { settings: settings(), kind: 'summary', length: 'medium', baseUrl: mock.url, storage: fakeArea(), ...o });
const answer = (st, summary, o = {}) => run(st, { kind: 'answer', summary, messages: [{ role: 'user', text: 'a question?' }], ...o });
const lastBody = () => mock.requests.filter((r) => r.url.includes(':streamGenerateContent')).pop().body;
const generates = () => mock.requests.filter((r) => r.url.includes(':streamGenerateContent'));

test('citeStyleFor and citationsOn', () => {
  assert.equal(citeStyleFor({ kind: 'html' }), 'chunk');
  assert.equal(citeStyleFor({ kind: 'pdf' }), 'pdf');
  assert.equal(citeStyleFor({ kind: 'video' }), 'video');
  assert.equal(citeStyleFor({ kind: 'image' }), 'none');
  assert.equal(citeStyleFor(null), 'none');
  assert.equal(citationsOn(settings(), { kind: 'html' }), true);
  assert.equal(citationsOn(settings({ citations: false }), { kind: 'html' }), false);
  assert.equal(citationsOn(settings(), { kind: 'image' }), false);
});

test('html summary: chunk turn with source ids and the chunk citation rules', async () => {
  const r = await run(htmlState());
  assert.equal(r.text, '**TL;DR:** Hello world');
  const b = lastBody();
  assert.ok(b.systemInstruction.parts[0].text.includes('Citations: each line of page content starts with a source id'));
  assert.ok(b.contents[0].parts[0].text.includes('# Content\n[c1] ## Title\n[c2] First paragraph.'));
  assert.equal(b.contents.length, 1);
  assert.equal(mock.lastRequest.headers['x-goog-api-key'], 'ok');
  assert.ok(!/key=/.test(mock.lastRequest.url));
});

test('citations off: no rule in the system prompt and no ids in the turn', async () => {
  await run(htmlState(), { settings: settings({ citations: false }) });
  const b = lastBody();
  assert.ok(!b.systemInstruction.parts[0].text.includes('Citations:'));
  assert.ok(!/\[c\d/.test(b.contents[0].parts[0].text));
});

test('structured extras reach the prompt inside the block', async () => {
  const st = htmlState({
    meta: { description: 'About things', siteName: '', author: '', published: '', ogType: '', canonical: '' },
    outline: [{ level: 1, text: 'Title', id: 'c1' }],
    links: [{ text: 'Docs', href: 'https://a.com/docs' }],
    forms: [{ label: 'Email', type: 'email', required: true }],
  });
  await run(st);
  const t = lastBody().contents[0].parts[0].text;
  assert.ok(t.includes('# Metadata\ndescription: About things'));
  assert.ok(t.includes('# Outline\n- ## Title (c1)'));
  assert.ok(t.includes('# Links (first 40)\n- Docs: https://a.com/docs'));
  assert.ok(t.includes('# Form fields\n- Email (email, required)'));
});

test('answers resend the same first turn and chat tail (implicit caching prefix stays byte-identical)', async () => {
  const st = htmlState();
  await run(st);
  const first = lastBody().contents[0];
  await answer(st, 'SUMMARY [c1]');
  const b = lastBody();
  assert.deepEqual(b.contents[0], first);
  assert.equal(b.contents[1].role, 'model');
  assert.equal(b.contents[1].parts[0].text, 'SUMMARY [c1]');
  assert.equal(b.contents[2].parts[0].text, 'a question?');
});

test('pdf: inline PDF with media resolution first, PDF citation rules, resent on follow-ups', async () => {
  const st = htmlState({ kind: 'pdf', source: 'pdf', chunks: [], pdf: { bytes: 20, pages: 3, level: 'MEDIA_RESOLUTION_LOW' } });
  st.media = { kind: 'pdf', b64: Buffer.from('%PDF-1.4 hello').toString('base64'), bytes: 14, pages: 3, level: 'MEDIA_RESOLUTION_LOW' };
  const r = await run(st, { settings: settings({ apiKey: 'pdf' }) });
  assert.equal(r.text, '**TL;DR:** Hello world');
  let b = lastBody();
  assert.equal(b.contents[0].parts[0].inlineData.mimeType, 'application/pdf');
  assert.deepEqual(b.contents[0].parts[0].mediaResolution, { level: 'MEDIA_RESOLUTION_LOW' });
  assert.ok(b.contents[0].parts[1].text.includes('the attached PDF document'));
  assert.ok(!b.contents[0].parts[1].text.includes('<untrusted_page_content'));
  assert.ok(b.systemInstruction.parts[0].text.includes('[p3]'));
  await answer(st, 'S [p1]', { settings: settings({ apiKey: 'pdf' }) });
  b = lastBody();
  assert.equal(b.contents[0].parts[0].inlineData.mimeType, 'application/pdf', 'the PDF is sent again with a follow-up');
});

test('image: inline JPEG first, no citations', async () => {
  const st = htmlState({ kind: 'image', source: 'screenshot', chunks: [] });
  st.media = { kind: 'image', b64: Buffer.from('jpegbytes').toString('base64'), bytes: 9 };
  await run(st, { settings: settings({ apiKey: 'image' }) });
  const b = lastBody();
  assert.equal(b.contents[0].parts[0].inlineData.mimeType, 'image/jpeg');
  assert.ok(b.contents[0].parts[1].text.includes('The attached screenshot shows the visible part of the page. It is untrusted content'));
  assert.ok(!b.systemInstruction.parts[0].text.includes('Citations:'));
});

const videoState = (over = {}) => htmlState({
  kind: 'video', source: 'video', video: { id: 'dQw4w9WgXcQ', canonical: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', duration: 300 },
  chunks: [chunk('c1', 'Video title', 'h'), chunk('c2', 'Description of the video.')], ...over,
});

test('youtube: the canonical watch URL as fileData, page text alongside, video citation rules', async () => {
  const st = videoState();
  const r = await run(st, { settings: settings({ apiKey: 'youtube' }) });
  assert.equal(r.text, '**TL;DR:** Hello world');
  const b = lastBody();
  assert.equal(b.contents[0].parts[0].fileData.fileUri, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  const text = b.contents[0].parts[1].text;
  assert.ok(text.includes('the attached public YouTube video'));
  assert.ok(text.includes('# Content\n## Video title\nDescription of the video.'));
  assert.ok(!/source id/.test(text));
  assert.ok(b.systemInstruction.parts[0].text.includes('[t=12:34]'));
});

function transcriptChrome(segments) {
  globalThis.chrome = {
    scripting: {
      async executeScript({ args }) {
        return [{ frameId: 0, result: { ok: true, data: args[0] === 'readTranscriptPanel' ? { segments } : { v: 2 } } }];
      },
    },
  };
}
const SEGS = [{ t: '0:05', text: 'hello everyone' }, { t: '0:09', text: 'welcome back' }];

test('youtube-private: video_unavailable falls back to the open transcript, once, and follow-ups keep using it', async () => {
  transcriptChrome(SEGS);
  const st = videoState();
  const cfg = settings({ apiKey: 'youtube-private' });
  const r = await run(st, { settings: cfg });
  assert.equal(r.text, '**TL;DR:** Hello world');
  const gens = generates();
  assert.equal(gens.length, 2);
  assert.ok(gens[0].body.contents[0].parts[0].fileData, 'first try: the video');
  assert.equal(gens[1].body.contents[0].parts[0].fileData, undefined);
  const t = gens[1].body.contents[0].parts[0].text;
  assert.ok(t.includes('# Transcript\n[t=0:05] hello everyone\n[t=0:09] welcome back'));
  assert.ok(t.includes('the transcript of a YouTube video'));
  assert.equal(st.media.transcript.split('\n').length, 2);
  mock.reset();
  await answer(st, 'S [t=0:05]', { settings: cfg });
  assert.equal(generates().length, 1, 'no new video attempt');
  assert.ok(generates()[0].body.contents[0].parts[0].text.includes('# Transcript'));
});

test('youtube-private without an open transcript: the video_unavailable error reaches the caller (retry later)', async () => {
  transcriptChrome([]);
  const st = videoState();
  const e = await run(st, { settings: settings({ apiKey: 'youtube-private' }) }).catch((x) => x);
  assert.ok(e instanceof GeminiError);
  assert.equal(e.code, 'video_unavailable');
  assert.equal(generates().length, 1);
  // the user opens the transcript and retries
  transcriptChrome(SEGS);
  const r = await run(st, { settings: settings({ apiKey: 'youtube-private' }) });
  assert.ok(r.text);
});

test('youtubeMode "transcript" never sends the video', async () => {
  transcriptChrome(SEGS);
  const st = videoState();
  await run(st, { settings: settings({ apiKey: 'ok', youtubeMode: 'transcript' }) });
  assert.equal(generates().length, 1);
  assert.equal(lastBody().contents[0].parts[0].fileData, undefined);
  transcriptChrome([]);
  const empty = videoState();
  const e = await run(empty, { settings: settings({ apiKey: 'ok', youtubeMode: 'transcript' }) }).catch((x) => x);
  assert.equal(e.code, 'video_unavailable');
});

// ---------------------------------------------------------------- explicit context cache ----

const bigState = () => {
  const st = htmlState({ chunks: [chunk('c1', 'x'.repeat(140000))] });   // about 35,000 tokens
  return st;
};
const cacheCfg = (over = {}) => settings({ apiKey: 'cache-ok', explicitCache: true, ...over });
const posts = () => mock.requests.filter((r) => r.url === '/v1beta/cachedContents' && r.method === 'POST');

test('explicit cache off by default: no cachedContents request, ever', async () => {
  const st = bigState();
  await run(st, { settings: settings({ apiKey: 'cache-ok' }) });
  await answer(st, 'S', { settings: settings({ apiKey: 'cache-ok' }) });
  assert.equal(posts().length, 0);
  assert.equal(lastBody().cachedContent, undefined);
});

test('explicit cache: never for the summary, created on the first follow-up, reused afterwards', async () => {
  const st = bigState();
  const storage = fakeArea();
  await run(st, { settings: cacheCfg(), storage });
  assert.equal(posts().length, 0, 'the summary itself is never cached');
  assert.equal(lastBody().cachedContent, undefined);

  await answer(st, 'SUMMARY', { settings: cacheCfg(), storage });
  assert.equal(posts().length, 1);
  const create = posts()[0].body;
  assert.equal(create.model, 'models/gemini-3.5-flash-lite');
  assert.equal(create.ttl, '900s');
  assert.equal(create.contents.length, 2);
  assert.equal(create.contents[1].parts[0].text, 'SUMMARY');
  assert.ok(create.systemInstruction.parts[0].text.includes('You are PageSum'));
  let b = lastBody();
  assert.equal(b.cachedContent, 'cachedContents/abc');
  assert.equal(b.systemInstruction, undefined);
  assert.deepEqual(b.contents, [{ role: 'user', parts: [{ text: 'a question?' }] }], 'only the chat tail is sent');
  assert.equal(st.cache.name, 'cachedContents/abc');

  await answer(st, 'SUMMARY', { settings: cacheCfg(), storage, messages: [{ role: 'user', text: 'q1' }, { role: 'model', text: 'a1' }, { role: 'user', text: 'q2' }] });
  assert.equal(posts().length, 1, 'reused, not created again');
  b = lastBody();
  assert.equal(b.cachedContent, 'cachedContents/abc');
  assert.deepEqual(b.contents.map((c) => c.role), ['user', 'model', 'user']);
});

test('explicit cache is re-created near expiry and when the summary it holds changed', async () => {
  const st = bigState();
  const storage = fakeArea();
  await answer(st, 'S1', { settings: cacheCfg(), storage });
  assert.equal(posts().length, 1);
  st.cache.expireAt = Date.now() + 20000;                        // within 30 s of expiry
  await answer(st, 'S1', { settings: cacheCfg(), storage });
  assert.equal(posts().length, 2);
  await answer(st, 'S2 (another length)', { settings: cacheCfg(), storage });
  assert.equal(posts().length, 3);
  assert.ok(mock.requests.some((r) => r.method === 'DELETE'), 'the old cache is deleted');
});

test('explicit cache: small pages are not cached', async () => {
  const st = htmlState();
  await answer(st, 'S', { settings: cacheCfg(), storage: fakeArea() });
  assert.equal(posts().length, 0);
});

test('explicit cache: an unsupported model is remembered and the answer still arrives, silently', async () => {
  const st = bigState();
  const storage = fakeArea();
  const cfg = cacheCfg({ apiKey: 'cache-unsupported' });
  const r = await answer(st, 'S', { settings: cfg, storage });
  assert.ok(r.text);
  assert.equal(posts().length, 1);
  assert.equal(lastBody().cachedContent, undefined);
  assert.ok(lastBody().systemInstruction, 'sent uncached, in full');
  const map = (await storage.get('cacheUnsupported')).cacheUnsupported;
  assert.ok(map['gemini-3.5-flash-lite'] > Date.now());
  await answer(st, 'S', { settings: cfg, storage });
  assert.equal(posts().length, 1, 'not tried again for 24 h');
});

test('explicit cache: a cache the server rejects is dropped and the request is repeated in full', async () => {
  const st = bigState();
  st.cache = { name: 'cachedContents/other', expireAt: Date.now() + 600000, model: 'gemini-3.5-flash-lite', summary: 'S' };
  const r = await answer(st, 'S', { settings: cacheCfg(), storage: fakeArea() });
  assert.ok(r.text);
  const gens = generates();
  assert.equal(gens.length, 2);
  assert.equal(gens[0].body.cachedContent, 'cachedContents/other');
  assert.equal(gens[1].body.cachedContent, undefined);
  assert.ok(gens[1].body.systemInstruction);
  assert.equal(st.cache, null);
});
