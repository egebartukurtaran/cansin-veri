// Generates public/icon-192.png and icon-512.png (blue tile, white report sheet with lines).
import fs from 'node:fs';
import zlib from 'node:zlib';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (const b of buf) {
    c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x / size, y / size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
const BLUE = [31, 95, 191, 255], WHITE = [255, 255, 255, 255], LINE = [150, 178, 225, 255], GREEN = [46, 160, 90, 255];
const pixel = (u, v) => {
  const inSheet = u > 0.28 && u < 0.72 && v > 0.2 && v < 0.8;
  if (!inSheet) return BLUE;
  for (const [ly, w] of [[0.33, 0.62], [0.43, 0.56], [0.53, 0.62], [0.63, 0.5]]) {
    if (v > ly && v < ly + 0.035 && u > 0.35 && u < w) return LINE;
  }
  if ((u - 0.6) ** 2 + (v - 0.66) ** 2 < 0.004) return GREEN;
  return WHITE;
};
for (const s of [192, 512]) fs.writeFileSync(`public/icon-${s}.png`, png(s, pixel));
