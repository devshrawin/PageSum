import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
const files = walk(EXT);
const textFiles = files.filter((f) => /\.(js|html|css|json)$/.test(f));
const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/');
const read = (f) => fs.readFileSync(f, 'utf8');

test('manifest parses and every referenced file exists', () => {
  const m = JSON.parse(read(path.join(EXT, 'manifest.json')));
  assert.equal(m.manifest_version, 3);
  assert.deepEqual(m.permissions, ['activeTab', 'scripting', 'storage']);
  assert.deepEqual(m.host_permissions, ['https://generativelanguage.googleapis.com/*']);
  assert.equal(m.background, undefined);
  assert.equal(m.content_scripts, undefined);
  const refs = new Set([m.action.default_popup, m.options_ui.page, ...Object.values(m.icons), ...Object.values(m.action.default_icon)]);
  for (const r of refs) assert.ok(fs.existsSync(path.join(EXT, r)), `missing ${r}`);
});

test('html files reference existing scripts/styles; no inline scripts or on* handlers', () => {
  for (const f of files.filter((x) => x.endsWith('.html'))) {
    const h = read(f);
    for (const m of h.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const src = /\bsrc="([^"]+)"/.exec(m[1]);
      assert.ok(src, `inline <script> in ${rel(f)}`);
      assert.equal(m[2].trim(), '', `script with body in ${rel(f)}`);
      assert.ok(fs.existsSync(path.join(path.dirname(f), src[1])), `missing ${src[1]}`);
    }
    for (const m of h.matchAll(/<link\b[^>]*\bhref="([^"]+)"/gi)) {
      assert.ok(fs.existsSync(path.join(path.dirname(f), m[1])), `missing ${m[1]}`);
    }
    assert.ok(!/\son[a-z]+\s*=/i.test(h), `on* attribute in ${rel(f)}`);
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>\s*\S/i.test(h), `inline script body in ${rel(f)}`);
  }
});

test('banned APIs do not appear anywhere in extension/', () => {
  const banned = [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\(/, /new Function/];
  for (const f of textFiles) {
    const s = read(f);
    for (const re of banned) assert.ok(!re.test(s), `${re} found in ${rel(f)}`);
  }
});

test('no console call mentions the key or the settings object', () => {
  for (const f of textFiles.filter((x) => x.endsWith('.js'))) {
    const s = read(f);
    for (const m of s.matchAll(/console\.\w+\(([^;]*)\)/g)) {
      assert.ok(!/\b(apiKey|settings|headers)\b/.test(m[1]), `${rel(f)}: ${m[0]}`);
    }
  }
});

test('the key never goes in a URL', () => {
  const g = read(path.join(EXT, 'lib', 'gemini.js'));
  assert.ok(!g.includes('?key='));
  assert.ok(!/[?&]key=/.test(g));
  assert.ok(g.includes("'x-goog-api-key'"));
});

test('lib modules do not touch chrome.* at import time', async () => {
  const saved = globalThis.chrome;
  delete globalThis.chrome;
  try {
    for (const f of fs.readdirSync(path.join(EXT, 'lib'))) {
      await import(path.join(EXT, 'lib', f).replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
    }
  } finally { if (saved) globalThis.chrome = saved; }
});

test('extension code has no external script/CDN references', () => {
  for (const f of textFiles) {
    const s = read(f);
    assert.ok(!/<script[^>]+src="https?:/i.test(s), rel(f));
  }
});

test('icons are valid PNGs of the right size', () => {
  for (const size of [16, 32, 48, 128]) {
    const buf = fs.readFileSync(path.join(EXT, 'icons', `icon${size}.png`));
    assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(buf.readUInt32BE(16), size);
    assert.equal(buf.readUInt32BE(20), size);
    assert.equal(buf[24], 8);
    assert.equal(buf[25], 6);
    // gather IDAT, inflate, check length
    let off = 8; const idat = [];
    while (off < buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString('ascii', off + 4, off + 8);
      if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
      off += 12 + len;
    }
    assert.equal(zlib.inflateSync(Buffer.concat(idat)).length, size * (1 + size * 4));
  }
});
