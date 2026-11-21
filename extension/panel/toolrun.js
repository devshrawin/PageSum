// Quick actions and the form helper (spec section 10): what is sent and how the answer is cleaned.
// No DOM. Each run is a fresh first user turn (not the summary conversation). Page text stays inside the nonce
// block; the user's own inputs (notes, focus, question, info for drafts) sit outside it, labelled as trusted.
import { streamGenerate, generateJson, buildRequestBody, parts } from '../lib/gemini.js';
import { GeminiError } from '../lib/errors.js';
import {
  buildSystemPrompt, buildToolSystem, buildFirstTurn, buildQuickPrompt, buildChunkPageTurn, buildImageTurn, trustedLine,
  QUICK_PROMPTS, TRANSLATE_MAX_CHARS,
} from '../lib/prompts.js';
import {
  ACTION_ITEMS_SCHEMA, QUIZ_SCHEMA, TABLE_SCHEMA, FORM_SCHEMA,
  normalizeActionItems, normalizeQuiz, rectangularize, normalizeForm,
} from '../lib/schemas.js';
import { chunkResolver, pdfResolver, videoResolver } from '../lib/citations.js';
import { selectChunks, sanitizeForBlock } from '../lib/chunks.js';
import { formatFieldsForPrompt } from '../lib/guidecore.js';
import { callAgent, ensureAgent } from './agent.js';
import { prepareFirstTurn, switchToTranscript, captureScreenshot } from './media.js';
import { citeStyleFor } from './request.js';

// id, label, icon, hint shown under the title, whether the answer is JSON
export const TOOLS = [
  { id: 'explain', label: 'Explain simply', icon: 'sparkle', json: false, hint: 'A plain-language explanation for a curious 12-year-old.' },
  { id: 'translate', label: 'Translate', icon: 'globe', json: false, hint: 'Translates the page text. Long pages are cut at about 15,000 characters.' },
  { id: 'actionItems', label: 'Action items', icon: 'checklist', json: true, hint: 'Tasks and dates mentioned on the page, with their sources.' },
  { id: 'reply', label: 'Draft a reply', icon: 'mail', json: false, hint: 'A reply to the message or post on this page. Nothing is ever sent.' },
  { id: 'quiz', label: 'Quiz and flashcards', icon: 'cap', json: true, hint: 'Study material built from the page.' },
  { id: 'table', label: 'Extract table', icon: 'table', json: true, hint: 'Pulls repeated items into a table you can copy.' },
  { id: 'form', label: 'Form helper', icon: 'form', json: true, hint: 'Explains each field on the page. Nothing is ever written into the page.' },
  { id: 'vision', label: 'Ask about what is visible', icon: 'eye', json: false, hint: 'Sends a screenshot of the visible area with your question.' },
];

export const toolById = (id) => TOOLS.find((t) => t.id === id);

// Which citation ids are valid for a page (chunk ids, PDF pages, video times). null: nothing is citable.
export function sourceResolver(page) {
  if (!page) return null;
  if (page.kind === 'pdf') return pdfResolver(page.pdf && page.pdf.pages);
  if (page.kind === 'video') return videoResolver(page.video && page.video.duration);
  if (page.kind === 'image') return null;
  return chunkResolver(page.chunks || []);
}

async function scanFields(st) {
  await ensureAgent(st.tabId);
  const out = await callAgent(st.tabId, 'scanForm', { max: 80 }, { frameIds: [0] });
  const r = out[0];
  if (!r || !r.ok) throw new GeminiError('no_access');
  return r.data.fields;
}

const oneLine = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

// o: { action, settings, windowId, signal, onText, opts, baseUrl?, fetchImpl?, capture? }
// opts: { target, tone, notes, what, formContext, question }
// Returns { type: 'markdown', text, notice? } | { type: 'json', action, data, fields? } | { type: 'empty', message }.
export async function runTool(st, o) {
  const { action, settings } = o;
  const opts = o.opts || {};
  const tool = toolById(action);
  if (!tool) throw new Error('unknown tool');
  const page = st.page;
  const nonce = st.conv.nonce;
  const style = citeStyleFor(page);
  const cites = !!settings.citations && style !== 'none';
  const resolve = sourceResolver(page) || (() => null);
  let notice = null;
  let fields = null;
  let base;
  let instruction;
  let citeIds = true;

  if (action === 'vision') {
    const shot = await (o.capture || captureScreenshot)(o.windowId);
    base = { firstParts: [parts.inline('image/jpeg', shot.b64)], turn: buildImageTurn(page), ids: false };
    instruction = `${QUICK_PROMPTS.vision}\n${trustedLine('Question', opts.question || 'Describe what is visible.', 500)}`;
    citeIds = false;
  } else if (action === 'form') {
    fields = await scanFields(st);
    if (!fields.length) return { type: 'empty', message: 'No form fields found on this page.' };
    const title = sanitizeForBlock(oneLine(page.title, 300)) || '(untitled)';
    const turn = `Page title: ${title}\nPage URL: ${sanitizeForBlock(oneLine(page.url, 500))}\nContent: the form fields of this page (labels are written by the page)\n\n<untrusted_page_content id="${nonce}">\n# Form fields\n${formatFieldsForPrompt(fields)}\n</untrusted_page_content id="${nonce}">`;
    base = { firstParts: [], turn, ids: false };
    instruction = `${QUICK_PROMPTS.form}\n${opts.formContext ? trustedLine('Info to use for drafts', opts.formContext) : 'Info to use for drafts (trusted, from the user): none given'}`;
    citeIds = false;
  } else {
    base = await prepareFirstTurn(st, { settings, windowId: o.windowId, nonce });
    citeIds = base.ids && (tool.json || (action === 'explain' && cites));
    if (action === 'translate') {
      instruction = buildQuickPrompt('translate', { target: opts.target || settings.translateTarget });
      if (page.chunks && page.chunks.length && base.turn === undefined) {
        const sel = selectChunks(page.chunks, TRANSLATE_MAX_CHARS);
        const shown = sel.chunks.reduce((n, c) => n + c.text.length, 0);
        if (sel.truncated) notice = `Translated the first ${shown} characters.`;
        base = { ...base, turn: buildChunkPageTurn({ ...page, chunks: sel.chunks, truncated: sel.truncated, originalLength: sel.originalLength, meta: undefined, outline: undefined, links: undefined, forms: undefined }, nonce, { ids: false }) };
      }
    } else if (action === 'reply') {
      instruction = buildQuickPrompt('reply', { tone: opts.tone, language: settings.language });
      if (opts.notes) instruction += `\n${trustedLine("User's notes", opts.notes)}`;
    } else if (action === 'table') {
      instruction = buildQuickPrompt('table', { what: opts.what });
    } else {
      instruction = buildQuickPrompt(action, {});
    }
  }

  const system = tool.json
    ? buildToolSystem(settings.language)
    : buildSystemPrompt(settings.language, { citations: action === 'explain' && cites, citeStyle: action === 'explain' && cites ? style : 'none' });

  const jsonSpec = {
    actionItems: { schema: ACTION_ITEMS_SCHEMA, normalize: (v) => normalizeActionItems(v, resolve) },
    quiz: { schema: QUIZ_SCHEMA, normalize: (v) => normalizeQuiz(v, resolve) },
    table: { schema: TABLE_SCHEMA, normalize: (v) => rectangularize(v, resolve) },
    form: { schema: FORM_SCHEMA, normalize: (v) => normalizeForm(v, fields) },
  }[action];

  async function attempt(turn) {
    const contents = [buildFirstTurn({ page, nonce, firstParts: turn.firstParts, turn: turn.turn, citeIds: citeIds && turn.ids !== false ? true : false, instruction })];
    if (jsonSpec) {
      const data = await generateJson({
        apiKey: settings.apiKey, model: settings.model, system, contents, schema: jsonSpec.schema, normalize: jsonSpec.normalize, ignoreFormats: action === 'actionItems',
        signal: o.signal, baseUrl: o.baseUrl, fetchImpl: o.fetchImpl,
      });
      return { type: 'json', action, data, fields };
    }
    const r = await streamGenerate({
      apiKey: settings.apiKey, model: settings.model, body: buildRequestBody({ system, contents }),
      signal: o.signal, onText: o.onText, baseUrl: o.baseUrl, fetchImpl: o.fetchImpl,
    });
    return { type: 'markdown', text: r.text, notice };
  }

  try {
    return await attempt(base);
  } catch (err) {
    if (err instanceof GeminiError && err.code === 'video_unavailable' && page.kind === 'video' && !(st.media && st.media.transcript)) {
      const fb = await switchToTranscript(st, nonce);
      if (fb) return attempt(fb);
    }
    throw err;
  }
}

// Markdown for "Copy as Markdown" on action items: "- [ ] task (owner, due)".
export function actionItemsMarkdown(data) {
  const lines = data.items.map((it) => {
    const extra = [it.owner, it.due || it.dueText].filter(Boolean).join(', ');
    return `- [ ] ${it.task}${extra ? ` (${extra})` : ''}`;
  });
  const dates = data.dates.map((d) => `- ${d.date || d.text}: ${d.what}`);
  return [lines.length ? '## Tasks\n' + lines.join('\n') : '', dates.length ? '## Dates\n' + dates.join('\n') : ''].filter(Boolean).join('\n\n');
}
