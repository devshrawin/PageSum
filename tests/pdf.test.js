import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  PDF_MAX_BYTES, isPdf, estimatePdfPages, pdfResolution, bytesToBase64, formatMb, tooLargeDetail,
} from '../extension/lib/pdf.js';

const latin1 = (s) => new Uint8Array(Buffer.from(s, 'latin1'));

test('isPdf: by content type or by .pdf path', () => {
  assert.equal(isPdf('https://a.com/x.pdf'), true);
  assert.equal(isPdf('https://a.com/X.PDF?download=1'), true);
  assert.equal(isPdf('https://a.com/download?id=3', 'application/pdf'), true);
  assert.equal(isPdf('https://a.com/download?id=3', 'application/pdf; charset=binary'), true);
  assert.equal(isPdf('https://a.com/x.pdf.html', 'text/html'), false);
  assert.equal(isPdf('not a url'), false);
  assert.equal(isPdf('https://a.com/', undefined), false);
});

test('estimatePdfPages counts /Type /Page objects but not /Type /Pages', () => {
  const pdf = latin1([
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R >> endobj',
    '4 0 obj << /Type/Page /Parent 2 0 R >> endobj',
    '5 0 obj << /Parent 2 0 R /Type  /Page >> endobj',
    '%%EOF',
  ].join('\n'));
  assert.equal(estimatePdfPages(pdf), 3);
});

test('estimatePdfPages returns null when no page object is visible (object streams) or for junk', () => {
  assert.equal(estimatePdfPages(latin1('%PDF-1.5\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n%%EOF')), null);
  assert.equal(estimatePdfPages(new Uint8Array(0)), null);
  assert.equal(estimatePdfPages(latin1('/Type /PageLabels')), null);
});

test('pdfResolution: LOW above 5 MB or 50 pages, otherwise the model default', () => {
  const MB = 1024 * 1024;
  assert.equal(pdfResolution(5 * MB, 50), undefined, 'boundaries are not low');
  assert.equal(pdfResolution(5 * MB + 1, 10), 'MEDIA_RESOLUTION_LOW');
  assert.equal(pdfResolution(MB, 51), 'MEDIA_RESOLUTION_LOW');
  assert.equal(pdfResolution(MB, null), undefined, 'unknown page count: bytes decide');
  assert.equal(pdfResolution(6 * MB, null), 'MEDIA_RESOLUTION_LOW');
});

test('bytesToBase64 equals Buffer base64 for 0, 1, 2, 3 and 100 KB', () => {
  for (const n of [0, 1, 2, 3, 100 * 1024, 100 * 1024 + 1, 0x8000 * 2 + 5]) {
    const u8 = new Uint8Array(crypto.randomBytes(n));
    assert.equal(bytesToBase64(u8), Buffer.from(u8).toString('base64'), `n=${n}`);
  }
});

test('size cap and messages', () => {
  assert.equal(PDF_MAX_BYTES, 20 * 1024 * 1024);
  assert.equal(formatMb(34 * 1024 * 1024), '34 MB');
  assert.equal(formatMb(10), '1 MB');
  assert.equal(tooLargeDetail(34 * 1024 * 1024), 'This PDF is 34 MB; the limit is 20 MB.');
});
