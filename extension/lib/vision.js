// Screenshot / vision helpers (spec 8.8). Pure.

export const MAX_IMAGE_EDGE = 1568;
export const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;

// hints: { canvasArea, imgArea, viewportArea, tinyTextRatio } from the agent's visualHints.
// textChars: readable text found by extraction. True when the page is mostly a picture or canvas, or its text is tiny.
export function shouldOfferVision(hints, textChars) {
  if (!hints) return false;
  const viewport = Number(hints.viewportArea) || 0;
  const media = (Number(hints.canvasArea) || 0) + (Number(hints.imgArea) || 0);
  if (textChars < 400 && viewport > 0 && media >= 0.4 * viewport) return true;
  return (Number(hints.tinyTextRatio) || 0) >= 0.5;
}

// Longest edge at most max; never upscales; keeps the aspect ratio.
export function fitImage(w, h, max = MAX_IMAGE_EDGE) {
  const width = Math.max(1, Math.round(Number(w) || 0));
  const height = Math.max(1, Math.round(Number(h) || 0));
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
