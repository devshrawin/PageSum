import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { fnSource } from './helpers/fakedom.js';

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
const manifest = () => JSON.parse(read(path.join(EXT, 'manifest.json')));
const contentFiles = files.filter((f) => rel(f).startsWith('extension/content/') && f.endsWith('.js'));

// ---------- manifest ----------

test('manifest equals the spec: permissions, side panel, service worker, no popup / content_scripts', () => {
  const m = manifest();
  assert.equal(m.manifest_version, 3);
  assert.equal(m.name, 'PageSum');
  assert.equal(m.minimum_chrome_version, '116');
  assert.deepEqual(m.permissions, ['activeTab', 'scripting', 'storage', 'sidePanel']);
  assert.deepEqual(m.optional_permissions, ['tabs']);
  assert.deepEqual(m.host_permissions, ['https://generativelanguage.googleapis.com/*']);
  assert.deepEqual(m.optional_host_permissions, ['<all_urls>']);
  assert.deepEqual(m.background, { service_worker: 'sw.js', type: 'module' });
  assert.deepEqual(m.side_panel, { default_path: 'sidepanel.html' });
  assert.deepEqual(m.options_ui, { page: 'options.html', open_in_tab: true });
  assert.equal(m.action.default_title, 'Open PageSum');
  assert.equal(m.action.default_popup, undefined, 'no popup: the icon click must reach action.onClicked');
  assert.equal(m.content_scripts, undefined);
  assert.equal(m.web_accessible_resources, undefined);
  assert.deepEqual(m.commands, { _execute_action: { suggested_key: { default: 'Alt+Shift+S' }, description: 'Open PageSum' } });
  assert.ok(!m.permissions.includes('<all_urls>') && !m.permissions.includes('tabs') && !m.permissions.includes('webRequest'));
});

test('manifest and package.json versions agree (1.1.x until a major bump is approved)', () => {
  const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));
  assert.equal(manifest().version, pkg.version);
  assert.match(pkg.version, /^1\.1\.\d+$/);
});

test('every file the manifest references exists, and so does every injected content file', () => {
  const m = manifest();
  const refs = new Set([
    m.background.service_worker, m.side_panel.default_path, m.options_ui.page,
    ...Object.values(m.icons), ...Object.values(m.action.default_icon),
  ]);
  for (const r of refs) assert.ok(fs.existsSync(path.join(EXT, r)), `missing ${r}`);

  const tabs = read(path.join(EXT, 'panel', 'agent.js'));
  const cf = /CONTENT_FILES\s*=\s*\[([^\]]*)\]/.exec(tabs);
  assert.ok(cf, 'CONTENT_FILES not found in panel/agent.js');
  const list = [...cf[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.ok(list.length >= 4);
  assert.ok(list.includes('content/media.js'));
  assert.equal(list[0], 'content/core.js', 'core.js must be injected first');
  for (const f of list) assert.ok(fs.existsSync(path.join(EXT, f)), `missing ${f}`);
  const css = /CSS_FILES\s*=\s*\[([^\]]*)\]/.exec(tabs);
  for (const f of [...css[1].matchAll(/'([^']+)'/g)].map((x) => x[1])) assert.ok(fs.existsSync(path.join(EXT, f)), `missing ${f}`);
  // every content script on disk is actually injected
  for (const f of contentFiles.filter((x) => x.endsWith('.js'))) assert.ok(list.includes('content/' + path.basename(f)), `${rel(f)} is never injected`);
});

test('the popup is gone', () => {
  for (const n of ['popup.html', 'popup.css', 'popup.js']) assert.ok(!fs.existsSync(path.join(EXT, n)), n);
  assert.ok(!fs.existsSync(path.join(EXT, 'lib', 'extract.js')), 'lib/extract.js moved to content/extract.js');
});

// ---------- html ----------

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

test('the side panel keeps the v1 element ids', () => {
  const h = read(path.join(EXT, 'sidepanel.html'));
  const ids = 'pageTitle notices content view-init view-needKey view-restricted view-needAccess view-empty view-idle view-summary lengthGroup regenBtn copyBtn copyLabel stopBtn summaryBody summaryError chat footer question sendBtn modelLabel newChatBtn settingsBtn status keyInput keyShow keySave moreSettings keyMsg restrictedText tryAnyway summariseBtn toast'.split(' ');
  for (const id of ids) assert.ok(new RegExp(`\\bid="${id}"`).test(h), `missing #${id}`);
});

test('every element id the panel code looks up exists in sidepanel.html', () => {
  const html = read(path.join(EXT, 'sidepanel.html'));
  const have = new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
  const srcs = [path.join(EXT, 'sidepanel.js'), ...files.filter((f) => rel(f).startsWith('extension/panel/'))];
  let n = 0;
  for (const f of srcs) {
    for (const m of read(f).matchAll(/\$\('([A-Za-z][\w-]*)'\)/g)) {
      n++;
      assert.ok(have.has(m[1]), `#${m[1]} used in ${rel(f)} but missing from sidepanel.html`);
    }
  }
  assert.ok(n > 30);
});

test('panel modules link: every import resolves to a real export', async () => {
  for (const name of ['dom.js', 'agent.js', 'media.js', 'request.js', 'tabs.js', 'page.js']) {
    const url = 'file:///' + path.join(EXT, 'panel', name).replace(/\\/g, '/');
    const mod = await import(url);
    assert.ok(Object.keys(mod).length > 0, name);
  }
});

// ---------- v1 bans, kept for all of extension/ ----------

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
  for (const name of ['gemini.js', 'cachectl.js']) {
    const p = path.join(EXT, 'lib', name);
    if (!fs.existsSync(p)) continue;
    const g = read(p);
    assert.ok(!g.includes('?key='), name);
    assert.ok(!/[?&]key=/.test(g), name);
  }
  assert.ok(read(path.join(EXT, 'lib', 'gemini.js')).includes("'x-goog-api-key'"));
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

// ---------- content/ never acts on the page (spec B11, B5) ----------

test('content/ files are classic scripts (no import/export)', () => {
  assert.ok(contentFiles.length >= 3);
  for (const f of contentFiles) assert.ok(!/^\s*(import|export)\s/m.test(read(f)), rel(f));
});

test('content/ never acts on the page: no click, dispatch, submit, focus, writes to values, no navigation', () => {
  const banned = [
    /\.click\(/, /dispatchEvent\(/, /\.submit\(/, /requestSubmit/, /\.focus\(/, /execCommand/, /setRangeText/,
    /\.value\s*=[^=]/, /\.checked\s*=[^=]/, /\.selected\s*=[^=]/, /selectedIndex\s*=[^=]/,
    /location\.href\s*=[^=]/, /location\.assign/, /location\.replace/, /window\.open/, /\.href\s*=[^=]/,
  ];
  for (const f of contentFiles) {
    const s = read(f);
    for (const re of banned) assert.ok(!re.test(s), `${re} found in ${rel(f)}`);
    if (path.basename(f) !== 'media.js') assert.ok(!/currentTime\s*=[^=]/.test(s), `currentTime write outside media.js: ${rel(f)}`);
  }
});

test('content/ has no inbound message channel, no storage, and no network', () => {
  for (const f of contentFiles) {
    const s = read(f);
    assert.ok(!/addEventListener\(\s*['"]message['"]/.test(s), `message listener in ${rel(f)}`);
    assert.ok(!/onmessage/i.test(s), `onmessage in ${rel(f)}`);
    assert.ok(!/onMessage/.test(s), `chrome.runtime.onMessage in ${rel(f)}`);
    assert.ok(!/chrome\.storage/.test(s), `chrome.storage in ${rel(f)}`);
    for (const m of s.matchAll(/\bfetch\(/g)) {
      assert.equal(path.basename(f), 'media.js', `fetch( in ${rel(f)}`);
      assert.ok(s.slice(m.index).startsWith('fetch(location.href'), `only fetch(location.href is allowed: ${rel(f)}`);
    }
    assert.ok(!/XMLHttpRequest|WebSocket|sendBeacon/.test(s), `network API in ${rel(f)}`);
  }
});

test('overlay and highlight text only ever goes through textContent / attributes', () => {
  for (const f of contentFiles) {
    const s = read(f);
    assert.ok(!/\.innerText\s*=/.test(s) && !/\.textContent\s*=\s*[^'"\s]*(?:<|html)/i.test(s), rel(f));
  }
});

// ---------- service worker ----------

test('sw.js is tiny: no fetch, no onMessage, no setPanelBehavior; sidePanel.open runs before any await', () => {
  const s = read(path.join(EXT, 'sw.js'));
  assert.ok(s.split('\n').length < 40);
  assert.ok(!/\bfetch\(/.test(s));
  assert.ok(!/onMessage/.test(s));
  assert.ok(!/setPanelBehavior/.test(s));
  assert.ok(!/setTimeout|setInterval|chrome\.alarms/.test(s));
  const l = s.indexOf('chrome.action.onClicked.addListener');
  assert.ok(l >= 0, 'onClicked listener');
  const open = s.indexOf('sidePanel.open', l);
  assert.ok(open > l, 'sidePanel.open in the onClicked listener');
  const aw = s.indexOf('await', l);
  assert.ok(aw < 0 || open < aw, 'sidePanel.open must come before any await (user gesture)');
  assert.ok(/chrome\.storage\.session\.set\(\{\s*activeTabGrant/.test(s));
});

test('panel/tabs.js validates agent events and never reads a tab id from the payload', () => {
  const s = read(path.join(EXT, 'panel', 'tabs.js'));
  assert.ok(s.includes('isTrustedAgentSender') && s.includes('validateAgentEvent'));
  assert.ok(!/v\.data\.tabId|msg\.tabId|msg\.data\.tabId/.test(s));
});

// ---------- phase 2: PDF, YouTube, screenshots, cache ----------

test('only the rebuilt canonical YouTube URL is ever sent; no YouTube internal or caption APIs', () => {
  const media = read(path.join(EXT, 'panel', 'media.js'));
  const calls = [...media.matchAll(/parts\.fileUri\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(calls.length >= 1);
  for (const c of calls) assert.ok(/^canonicalVideoUrl\(/.test(c.trim()), `fileUri argument: ${c}`);
  for (const f of textFiles.filter((x) => x.endsWith('.js'))) {
    assert.ok(!/timedtext|youtubei|get_video_info|ytInitialPlayerResponse/i.test(read(f)), `${rel(f)} touches a YouTube internal API`);
  }
});

test('screenshots: captureVisibleTab is called in one place, as JPEG, and its error becomes capture_denied', () => {
  const hits = textFiles.filter((f) => /captureVisibleTab/.test(read(f))).map(rel);
  assert.deepEqual(hits, ['extension/panel/media.js']);
  const m = read(path.join(EXT, 'panel', 'media.js'));
  assert.ok(/captureVisibleTab\(windowId, \{ format: 'jpeg', quality: 70 \}\)/.test(m));
  assert.ok(/capture_denied/.test(m));
});

test('the explicit cache module sends the key only in a header and never as a URL parameter', () => {
  const c = read(path.join(EXT, 'lib', 'cachectl.js'));
  assert.ok(c.includes('headers(apiKey)'));
  assert.ok(!/[?&]key=/.test(c) && !c.includes('?key='));
  const r = read(path.join(EXT, 'panel', 'request.js'));
  assert.ok(!/[?&]key=/.test(r));
});

test('no unicode glyph icons in the panel UI code (icons are inline SVG)', () => {
  for (const f of [path.join(EXT, 'sidepanel.html'), ...files.filter((x) => rel(x).startsWith('extension/panel/') && x.endsWith('.js'))]) {
    const s = read(f);
    const bad = s.match(/[←-⇿☀-➿⬀-⯿\uD83C-\uD83E][\uDC00-\uDFFF]?/);
    assert.ok(!bad, `${rel(f)} contains a glyph icon: ${bad && bad[0]}`);
  }
});

// ---------- the two findPassage copies stay identical ----------

test('findPassage and mapCollapsedOffset in content/core.js equal the copies in lib/fuzzy.js', () => {
  const core = read(path.join(EXT, 'content', 'core.js'));
  const lib = read(path.join(EXT, 'lib', 'fuzzy.js'));
  const norm = (x) => x.replace(/\s+/g, ' ').trim();
  for (const name of ['findPassage', 'mapCollapsedOffset']) {
    const a = fnSource(core, name);
    const b = fnSource(lib, name);
    assert.ok(a && b, `${name} found in both`);
    assert.equal(norm(a), norm(b), `${name} copies differ`);
  }
});

// ---------- icons ----------

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
