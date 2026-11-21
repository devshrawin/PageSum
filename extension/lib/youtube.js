// YouTube helpers (spec 8.6). Pure.
import { sanitizeForBlock } from './chunks.js';

const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set(['www.youtube.com', 'm.youtube.com', 'youtube.com']);

// watch?v={id} or /shorts/{id}. Anything else (channel pages, bad ids, other hosts) gives null.
export function videoIdFromUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!HOSTS.has(u.hostname)) return null;
  let id = null;
  if (u.pathname === '/watch') id = u.searchParams.get('v');
  else {
    const m = /^\/shorts\/([^/?#]+)\/?$/.exec(u.pathname);
    if (m) id = m[1];
  }
  return id && ID_RE.test(id) ? id : null;
}

// Only this rebuilt URL is ever sent to Gemini, never the raw tab URL.
export function canonicalVideoUrl(id) {
  return `https://www.youtube.com/watch?v=${id}`;
}

// "1:02" -> 62, "1:02:03" -> 3723. Invalid -> null.
export function parseTimecode(s) {
  const m = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(String(s == null ? '' : s).trim());
  if (!m) return null;
  const mins = Number(m[2]);
  const secs = Number(m[3]);
  if (secs > 59 || (m[1] !== undefined && mins > 59)) return null;
  return (m[1] ? Number(m[1]) * 3600 : 0) + mins * 60 + secs;
}

export function formatTimecode(sec) {
  const t = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// About 100 tokens per second of video at the default resolution.
export function estimateVideoTokens(sec) {
  return Math.ceil(Math.max(0, Number(sec) || 0) * 100);
}

export const LONG_VIDEO_SECONDS = 1200;

// segments: [{ t: '1:23', text }] read from the visible transcript panel. Lines are "[t=1:23] text".
// The text of each line comes from the page, so it is defused like all page text.
export function transcriptToText(segments) {
  const lines = [];
  for (const seg of Array.isArray(segments) ? segments : []) {
    const sec = parseTimecode(seg && seg.t);
    const text = sanitizeForBlock(String((seg && seg.text) || '').replace(/\s+/g, ' ').trim());
    if (sec == null || !text) continue;
    lines.push(`[t=${formatTimecode(sec)}] ${text}`);
  }
  return lines.join('\n');
}
