/**
 * Generates `assets/icon.png` — the master 1024x1024 source image that
 * `tauri icon` expands into every platform icon format.
 *
 * The mark is drawn procedurally (a barred spiral seen face-on) so the repo
 * carries no binary blobs and the icon can be regenerated on any machine with
 * nothing but Node. Run via `npm run icons`.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 1024;
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'icon.png');

/* ---------------------------------------------------------------- painting */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Deterministic value noise so successive runs produce a byte-identical file. */
function hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

const pixels = Buffer.alloc(SIZE * SIZE * 4);

const cx = SIZE / 2;
const cy = SIZE / 2;
const R = SIZE * 0.46;

// Two logarithmic arms, matching the layout the galaxy renderer actually uses.
const ARMS = 2;
const TWIST = 2.6;

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const dx = (x + 0.5 - cx) / R;
    const dy = (y + 0.5 - cy) / R;
    const r = Math.hypot(dx, dy);
    const theta = Math.atan2(dy, dx);

    // Rounded-square disc mask (macOS/Windows both crop differently; a disc
    // with a soft edge survives every mask).
    const disc = 1 - smoothstep(0.92, 1.0, r);
    if (disc <= 0) {
      const i = (y * SIZE + x) * 4;
      pixels[i + 3] = 0;
      continue;
    }

    // Spiral arm intensity: how close is this angle to an arm at this radius?
    const armPhase = theta - Math.log(Math.max(r, 0.04)) * TWIST;
    const armWave = Math.cos(armPhase * ARMS);
    const arm = Math.pow(clamp01(armWave * 0.5 + 0.5), 3.2);

    // Core bulge falls off exponentially; arms live in the mid annulus.
    const bulge = Math.exp(-Math.pow(r / 0.14, 2));
    const annulus = smoothstep(0.06, 0.3, r) * (1 - smoothstep(0.55, 0.95, r));

    const grain = 0.82 + 0.36 * hash2(x * 0.37, y * 0.37);
    const density = clamp01(bulge * 1.25 + arm * annulus * 1.15 * grain);

    // Physically-ish palette: hot white core -> cyan mid -> deep indigo rim.
    const rr = clamp01(0.30 * density + 0.95 * bulge);
    const gg = clamp01(0.62 * density + 0.90 * bulge);
    const bb = clamp01(0.95 * density + 0.88 * bulge);

    // Background of the disc: near-black space with a faint blue haze.
    const haze = 0.06 * (1 - smoothstep(0.0, 1.0, r));
    const bg = [0.012 + haze * 0.4, 0.016 + haze * 0.7, 0.035 + haze];

    const a = clamp01(density * 1.15);
    const out = [
      clamp01(bg[0] + rr * a),
      clamp01(bg[1] + gg * a),
      clamp01(bg[2] + bb * a),
    ];

    const i = (y * SIZE + x) * 4;
    pixels[i] = Math.round(Math.pow(out[0], 1 / 1.05) * 255);
    pixels[i + 1] = Math.round(Math.pow(out[1], 1 / 1.05) * 255);
    pixels[i + 2] = Math.round(Math.pow(out[2], 1 / 1.05) * 255);
    pixels[i + 3] = Math.round(disc * 255);
  }
}

/* ----------------------------------------------------------- PNG container */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
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
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
ihdr[10] = 0; // deflate
ihdr[11] = 0; // adaptive filtering
ihdr[12] = 0; // no interlace

// Prefix every scanline with filter byte 0 (None).
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, png);
console.log(`wrote ${OUT} (${SIZE}x${SIZE}, ${(png.length / 1024).toFixed(1)} KiB)`);
console.log('next: npx tauri icon assets/icon.png');
