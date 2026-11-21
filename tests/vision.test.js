import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldOfferVision, fitImage, MAX_IMAGE_EDGE } from '../extension/lib/vision.js';

const hints = (over = {}) => ({ textChars: 0, canvasArea: 0, imgArea: 0, viewportArea: 1000000, tinyTextRatio: 0, ...over });

test('shouldOfferVision: little text and a mostly-visual page', () => {
  assert.equal(shouldOfferVision(hints({ canvasArea: 400000 }), 399), true, 'exactly 40% of the viewport');
  assert.equal(shouldOfferVision(hints({ canvasArea: 399999 }), 399), false);
  assert.equal(shouldOfferVision(hints({ canvasArea: 200000, imgArea: 200000 }), 0), true, 'canvas and images add up');
  assert.equal(shouldOfferVision(hints({ canvasArea: 900000 }), 400), false, '400 chars of text is enough');
  assert.equal(shouldOfferVision(hints({ canvasArea: 900000 }), 5000), false);
});

test('shouldOfferVision: tiny text alone is enough', () => {
  assert.equal(shouldOfferVision(hints({ tinyTextRatio: 0.5 }), 5000), true);
  assert.equal(shouldOfferVision(hints({ tinyTextRatio: 0.49 }), 5000), false);
  assert.equal(shouldOfferVision(hints({ tinyTextRatio: 0.9 }), 0), true);
});

test('shouldOfferVision: missing or broken hints never offer', () => {
  assert.equal(shouldOfferVision(null, 0), false);
  assert.equal(shouldOfferVision(undefined, 0), false);
  assert.equal(shouldOfferVision(hints({ viewportArea: 0, canvasArea: 10 }), 0), false);
  assert.equal(shouldOfferVision({}, 0), false);
});

test('fitImage keeps the aspect ratio, caps the longest edge, never upscales', () => {
  assert.deepEqual(fitImage(3136, 1568), { width: 1568, height: 784 });
  assert.deepEqual(fitImage(1000, 4704), { width: 333, height: 1568 });
  assert.deepEqual(fitImage(800, 600), { width: 800, height: 600 });
  assert.deepEqual(fitImage(1568, 1568), { width: 1568, height: 1568 });
  assert.deepEqual(fitImage(3000, 3000, 1000), { width: 1000, height: 1000 });
  assert.equal(MAX_IMAGE_EDGE, 1568);
  const r = fitImage(0, 0);
  assert.ok(r.width >= 1 && r.height >= 1);
});
