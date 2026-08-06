// Generates placeholder toolbar icons (16/32/48/128px) as flat PNGs with no
// external dependency (no canvas/sharp) — just Node's built-in zlib deflate,
// which is all raw PNG encoding needs for a solid-color image.
//
// These are functional placeholders so the unpacked extension loads and has
// a visible toolbar icon; real branding is out of scope for this plan.
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'icons');

// TradePilot brand: deep indigo background, a light "up-candle" glyph.
const BG = [0x1a, 0x1d, 0x2e, 0xff]; // #1a1d2e
const FG = [0x4c, 0xaf, 0x7a, 0xff]; // #4caf7a (green candle)

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = makeTable());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    crc = (crc >>> 8) ^ table[c];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function candlePixel(x, y, size) {
  // A simple centered "candlestick" glyph: a vertical wick + a body rect.
  const cx = size / 2;
  const bodyW = Math.max(2, Math.round(size * 0.34));
  const bodyTop = Math.round(size * 0.28);
  const bodyBottom = Math.round(size * 0.62);
  const wickTop = Math.round(size * 0.12);
  const wickBottom = Math.round(size * 0.82);
  const inBody = Math.abs(x - cx) <= bodyW / 2 && y >= bodyTop && y <= bodyBottom;
  const inWick = Math.abs(x - cx) <= Math.max(1, size * 0.03) && y >= wickTop && y <= wickBottom;
  return inBody || inWick;
}

function makePng(size) {
  const width = size;
  const height = size;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0; // filter type: none
    for (let x = 0; x < width; x++) {
      const px = candlePixel(x, y, size) ? FG : BG;
      raw[offset++] = px[0];
      raw[offset++] = px[1];
      raw[offset++] = px[2];
      raw[offset++] = px[3];
    }
  }

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = deflateSync(raw);

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    const png = makePng(size);
    await writeFile(path.join(outDir, `${size}.png`), png);
  }
  console.log(`[icons] generated 16/32/48/128 -> ${path.relative(root, outDir)}/`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
