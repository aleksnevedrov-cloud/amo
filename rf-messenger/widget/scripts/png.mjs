// Мини-генератор PNG-заглушек логотипов (без внешних зависимостей). Заменить на фирменные.
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

/** Прямоугольник с цветом фона и светлой «дверью» по центру. */
export function logoPng(width, height, bg = [0x2b, 0x4c, 0x7e], fg = [0xf2, 0xe6, 0xd0]) {
  const doorW = Math.max(4, Math.round(Math.min(width, height) * 0.35));
  const doorH = Math.round(Math.min(width, height) * 0.7);
  const x0 = Math.round((width - doorW) / 2);
  const y0 = Math.round((height - doorH) / 2);
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const inDoor = x >= x0 && x < x0 + doorW && y >= y0 && y < y0 + doorH;
      const [r, g, b] = inDoor ? fg : bg;
      raw.set([r, g, b, 255], row + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
