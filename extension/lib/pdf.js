// PDF helpers (spec 8.5). Pure.

export const PDF_MAX_BYTES = 20 * 1024 * 1024;
const LOW_RES_BYTES = 5 * 1024 * 1024;
const LOW_RES_PAGES = 50;

export function isPdf(url, contentType) {
  if (String(contentType || '').toLowerCase().split(';')[0].trim() === 'application/pdf') return true;
  try { return /\.pdf$/i.test(new URL(url).pathname); } catch { return false; }
}

// Counts "/Type /Page" objects (not "/Type /Pages") in the file. Returns null when none are visible
// (page objects hidden inside compressed object streams), so callers treat the page count as unknown.
export function estimatePdfPages(u8) {
  const s = new TextDecoder('latin1').decode(u8);
  const m = s.match(/\/Type\s*\/Page(?![A-Za-z])/g);
  return m && m.length ? m.length : null;
}

// Big or long documents are read at LOW media resolution to save tokens; otherwise the model default (MEDIUM).
export function pdfResolution(bytes, pages) {
  if (bytes > LOW_RES_BYTES || (Number.isFinite(pages) && pages > LOW_RES_PAGES)) return 'MEDIA_RESOLUTION_LOW';
  return undefined;
}

export function bytesToBase64(u8) {
  let out = '';
  const STEP = 0x8000;
  for (let i = 0; i < u8.length; i += STEP) {
    out += String.fromCharCode.apply(null, u8.subarray(i, i + STEP));
  }
  return btoa(out);
}

export function formatMb(bytes) {
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

// Message for the too_large error card.
export function tooLargeDetail(bytes, max = PDF_MAX_BYTES) {
  return `This PDF is ${formatMb(bytes)}; the limit is ${formatMb(max)}.`;
}
