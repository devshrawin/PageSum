// PDF bytes, YouTube video info / transcript, and screenshots (spec 8.5, 8.6, 8.8), plus the first-turn
// builder that decides what Gemini receives for a tab. No DOM. chrome.* only inside functions.
import { callAgent, ensureAgent } from './agent.js';
import {
  PDF_MAX_BYTES, estimatePdfPages, pdfResolution, bytesToBase64, tooLargeDetail,
} from '../lib/pdf.js';
import { GeminiError } from '../lib/errors.js';
import { fitImage, MAX_IMAGE_BYTES } from '../lib/vision.js';
import { canonicalVideoUrl, transcriptToText } from '../lib/youtube.js';
import { parts } from '../lib/gemini.js';
import { buildPdfTurn, buildImageTurn, buildChunkPageTurn } from '../lib/prompts.js';

/* ---------- PDF ---------- */

// Thrown when the PDF can't be fetched for lack of access. kind: 'file' (file URLs need "Allow access to file
// URLs" in chrome://extensions) or 'need' (needs a host grant or the icon click).
export class PdfAccessError extends Error {
  constructor(kind) { super('pdf_access_' + kind); this.kind = kind; }
}

function tooLarge(bytes) {
  return new GeminiError('too_large', { message: tooLargeDetail(bytes, PDF_MAX_BYTES) });
}

async function fetchInPanel(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error('http ' + res.status);
  const len = Number(res.headers.get('content-length'));
  if (len > PDF_MAX_BYTES) throw tooLarge(len);       // refuse before downloading
  const buf = await res.arrayBuffer();
  if (buf.byteLength > PDF_MAX_BYTES) throw tooLarge(buf.byteLength);
  return new Uint8Array(buf);
}

// fetch() rejects file: URLs, so local PDFs go through XMLHttpRequest (needs "Allow access to file URLs").
function fetchFile(url) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('GET', url);
    x.responseType = 'arraybuffer';
    x.onload = () => {
      const buf = x.response;
      if (!buf || !buf.byteLength) reject(new Error('empty'));
      else if (buf.byteLength > PDF_MAX_BYTES) reject(tooLarge(buf.byteLength));
      else resolve(new Uint8Array(buf));
    };
    x.onerror = () => reject(new Error('xhr'));
    x.send();
  });
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

// Strategy (spec 8.5): (1) the panel fetches the URL; (2) failing that, the page agent fetches its own URL;
// (3) file: URLs use XHR. Returns { b64, bytes, pages, level }. Throws GeminiError('too_large') or PdfAccessError.
export async function loadPdf(tabId, url) {
  const isFile = /^file:/i.test(url);
  let u8 = null;
  try {
    u8 = isFile ? await fetchFile(url) : await fetchInPanel(url);
  } catch (err) {
    if (err instanceof GeminiError) throw err;
    if (isFile) throw new PdfAccessError('file');
    try {
      await ensureAgent(tabId);
      const out = await callAgent(tabId, 'fetchSelfPdf', { maxBytes: PDF_MAX_BYTES }, { frameIds: [0] });
      const r = out[0];
      if (!r || !r.ok) throw new Error('agent');
      if (r.data.tooLarge) throw tooLarge(r.data.bytes);
      u8 = base64ToBytes(r.data.base64);
    } catch (err2) {
      if (err2 instanceof GeminiError) throw err2;
      throw new PdfAccessError('need');
    }
  }
  const pages = estimatePdfPages(u8);
  return { b64: bytesToBase64(u8), bytes: u8.length, pages, level: pdfResolution(u8.length, pages) };
}

/* ---------- YouTube ---------- */

export async function readVideoInfo(tabId) {
  try {
    const out = await callAgent(tabId, 'videoInfo', {}, { frameIds: [0] });
    return out[0] && out[0].ok ? out[0].data : null;
  } catch { return null; }
}

// Lines "[t=m:ss] text" from the open transcript panel, or '' when it isn't open.
export async function readTranscript(tabId) {
  try {
    await ensureAgent(tabId);
    const out = await callAgent(tabId, 'readTranscriptPanel', {}, { frameIds: [0] });
    const r = out[0];
    return r && r.ok ? transcriptToText(r.data.segments) : '';
  } catch { return ''; }
}

/* ---------- screenshot ---------- */

export async function readVisualHints(tabId) {
  try {
    const out = await callAgent(tabId, 'visualHints', {}, { frameIds: [0] });
    return out[0] && out[0].ok ? out[0].data : null;
  } catch { return null; }
}

// JPEG of the visible area, downscaled to at most 1568 px and re-encoded at 0.7. Needs activeTab on that tab or
// the all-sites grant (a per-site grant is not enough). Any failure to capture is capture_denied.
export async function captureScreenshot(windowId) {
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 70 });
  } catch {
    throw new GeminiError('capture_denied');
  }
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const { width, height } = fitImage(bmp.width, bmp.height);
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d').drawImage(bmp, 0, 0, width, height);
  if (bmp.close) bmp.close();
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
  if (out.size > MAX_IMAGE_BYTES) throw new GeminiError('too_large', { message: 'The screenshot is too large to send.' });
  return { b64: bytesToBase64(new Uint8Array(await out.arrayBuffer())), bytes: out.size, width, height };
}

/* ---------- what Gemini receives ---------- */

// Returns the first user turn's ingredients for a tab: { firstParts, turn, ids }.
//   html:  turn undefined (buildContents makes the chunk turn), ids = citations on
//   pdf:   inline PDF part + PDF turn
//   video: YouTube fileData part (or the transcript text) + chunk turn of the page text
//   image: inline screenshot part
// st.media holds the bytes/transcript so follow-ups reuse them.
export async function prepareFirstTurn(st, { settings, windowId, nonce }) {
  const page = st.page;
  if (page.kind === 'pdf') {
    if (!st.media || st.media.kind !== 'pdf') {
      st.media = { kind: 'pdf', ...(await loadPdf(st.tabId, st.url)) };   // restored from the cache: bytes are fetched again
    }
    return { firstParts: [parts.inline('application/pdf', st.media.b64, st.media.level)], turn: buildPdfTurn(page), ids: false };
  }
  if (page.kind === 'image') {
    if (!st.media || st.media.kind !== 'image') st.media = { kind: 'image', ...(await captureScreenshot(windowId)) };
    return { firstParts: [parts.inline('image/jpeg', st.media.b64)], turn: buildImageTurn(page), ids: false };
  }
  if (page.kind === 'video') {
    const useTranscript = settings.youtubeMode === 'transcript' || (st.media && st.media.transcript);
    if (useTranscript) {
      const transcript = (st.media && st.media.transcript) || await readTranscript(st.tabId);
      if (!transcript) throw new GeminiError('video_unavailable');
      st.media = { kind: 'video', transcript };
      return { firstParts: [], turn: videoTurn(page, nonce, transcript), ids: false };
    }
    return { firstParts: [parts.fileUri(canonicalVideoUrl(page.video.id))], turn: videoTurn(page, nonce, ''), ids: false };
  }
  return { firstParts: [], turn: undefined, ids: true };
}

// Used after a video_unavailable error: switch this tab to the transcript for good (until it is reset).
export async function switchToTranscript(st, nonce) {
  const transcript = await readTranscript(st.tabId);
  if (!transcript) return null;
  st.media = { kind: 'video', transcript };
  return { firstParts: [], turn: videoTurn(st.page, nonce, transcript), ids: false };
}

function videoTurn(page, nonce, transcript) {
  const label = transcript
    ? 'the transcript of a YouTube video (cite moments by their [t=m:ss] time) and the video page text'
    : 'the attached public YouTube video (cite moments by time) and the video page text below';
  return buildChunkPageTurn({ ...page, transcript: transcript || undefined, meta: undefined }, nonce, { ids: false, label });
}
