// Generates extension/icons/icon{16,32,48,128}.png with node built-ins only.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function encodePng(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0; // filter 0
    rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Shapes on a 128 grid.
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x;
  const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}
function inSparkle(x, y, cx, cy, r) {
  const a = Math.abs(x - cx) / r, b = Math.abs(y - cy) / r;
  return Math.sqrt(a) + Math.sqrt(b) <= 1;
}

const BLUE = [0x4f, 0x46, 0xe5];
const WHITE = [255, 255, 255];

function sample(gx, gy, size) {
  if (!inRoundRect(gx, gy, 0, 0, 128, 128, 28)) return null;
  const bars = size === 16
    ? [[28, 100, 36], [28, 72, 80]]
    : [[28, 100, 36], [28, 100, 58], [28, 72, 80]];
  for (const [x0, x1, y0] of bars) if (inRoundRect(gx, gy, x0, y0, x1, y0 + 12, 6)) return WHITE;
  if (size !== 16 && inSparkle(gx, gy, 96, 88, 12)) return WHITE;
  return BLUE;
}

export function renderIcon(size) {
  const SS = 4;
  const buf = Buffer.alloc(size * size * 4);
  const scale = 128 / size;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, inside = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const gx = (px + (sx + 0.5) / SS) * scale;
          const gy = (py + (sy + 0.5) / SS) * scale;
          const c = sample(gx, gy, size);
          if (c) { r += c[0]; g += c[1]; b += c[2]; inside++; }
        }
      }
      const o = (py * size + px) * 4;
      if (inside) {
        buf[o] = Math.round(r / inside);
        buf[o + 1] = Math.round(g / inside);
        buf[o + 2] = Math.round(b / inside);
        buf[o + 3] = Math.round((inside / (SS * SS)) * 255);
      }
    }
  }
  return encodePng(size, size, buf);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(OUT, { recursive: true });
  for (const s of [16, 32, 48, 128]) {
    const file = join(OUT, `icon${s}.png`);
    writeFileSync(file, renderIcon(s));
    console.log('wrote', file);
  }
}
