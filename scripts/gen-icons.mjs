/**
 * 生成扩展图标（无第三方依赖，手写最小 PNG 编码器）。
 * 图案：品牌渐变圆角方块 + 白色对勾。
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icon');
mkdirSync(OUT, { recursive: true });

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 抗锯齿：对每像素做 3x3 超采样 */
function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const S = 3;
  const r = size * 0.22; // 圆角半径

  // 对勾折线的两段（归一化坐标）
  const segs = [
    [[0.28, 0.52], [0.44, 0.68]],
    [[0.44, 0.68], [0.74, 0.34]],
  ];
  const strokeW = size * 0.085;

  const distToSeg = (x, y, [[x1, y1], [x2, y2]]) => {
    const ax = x1 * size, ay = y1 * size, bx = x2 * size, by = y2 * size;
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
  };

  // 标准圆角矩形 SDF：把点相对中心的偏移收缩到「直边范围」外的部分，再判半径
  const half = size / 2;
  const insideRounded = (x, y) => {
    const qx = Math.max(Math.abs(x - half) - (half - r), 0);
    const qy = Math.max(Math.abs(y - half) - (half - r), 0);
    return Math.hypot(qx, qy) <= r;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgA = 0, tickA = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const fx = x + (sx + 0.5) / S;
          const fy = y + (sy + 0.5) / S;
          if (!insideRounded(fx, fy)) continue;
          bgA++;
          const d = Math.min(...segs.map((s) => distToSeg(fx, fy, s)));
          if (d <= strokeW / 2) tickA++;
        }
      }
      const n = S * S;
      const i = (y * size + x) * 4;
      if (bgA === 0) continue;

      // 竖向渐变 #7c9cff → #4361e8
      const t = y / size;
      const bg = [
        Math.round(0x7c + (0x43 - 0x7c) * t),
        Math.round(0x9c + (0x61 - 0x9c) * t),
        Math.round(0xff + (0xe8 - 0xff) * t),
      ];
      const tf = tickA / n;
      const bf = bgA / n;
      // 对勾（白）叠在渐变底上
      px[i] = Math.round(bg[0] * (1 - tf) + 255 * tf);
      px[i + 1] = Math.round(bg[1] * (1 - tf) + 255 * tf);
      px[i + 2] = Math.round(bg[2] * (1 - tf) + 255 * tf);
      px[i + 3] = Math.round(255 * bf);
    }
  }
  return px;
}

for (const size of [16, 32, 48, 96, 128]) {
  writeFileSync(join(OUT, `${size}.png`), png(size, render(size)));
  console.log(`icon/${size}.png`);
}
