/** 校验生成的图标：角应透明、中心应不透明、应含白色对勾像素 */
import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icon');

function decode(file) {
  const buf = readFileSync(file);
  let off = 8, width = 0, height = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); }
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(width * height * 4);
  const stride = width * 4;
  for (let y = 0; y < height; y++) {
    raw.copy(px, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
  }
  return { width, height, px };
}

let allOk = true;
for (const size of [16, 48, 128]) {
  const { width, px } = decode(join(dir, `${size}.png`));
  const at = (x, y) => {
    const i = (y * width + x) * 4;
    return [px[i], px[i + 1], px[i + 2], px[i + 3]];
  };

  const corner = at(0, 0);
  const center = at(width >> 1, width >> 1);
  // 找纯白附近的像素（对勾）
  let whiteish = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] > 200 && px[i] > 235 && px[i + 1] > 235 && px[i + 2] > 235) whiteish++;
  }

  const cornerOk = corner[3] === 0;
  const centerOk = center[3] > 250;
  const tickOk = whiteish > (size * size) * 0.02;
  const ok = cornerOk && centerOk && tickOk;
  if (!ok) allOk = false;

  console.log(
    `${size}px  角透明=${cornerOk}(a=${corner[3]})  中心实心=${centerOk}(a=${center[3]})  对勾像素=${whiteish}(${tickOk})  => ${ok ? 'OK' : 'FAIL'}`,
  );
}
console.log(allOk ? '\n全部图标校验通过' : '\n存在异常图标');
process.exit(allOk ? 0 : 1);
