/**
 * 从截图裁剪推断拼图块形状。
 *
 * 为什么需要：截图路径裁出来的拼图块是**不透明矩形**（拼图画在背景图上，
 * 裁下来四角都是背景色），alphaBounds 因此判 shapedAlpha=false，匹配退化成
 * 矩形边缘对比。实测在 hvoy.ai 的多缺口图上，矩形轮廓让 3 个形状全部命中、
 * 分数 0.652–0.748，等于随机选。
 *
 * 推断出形状后就能启用 alpha 感知的匹配路径。但推断错误比没有推断更糟 ——
 * 一个错的 mask 会污染所有后续匹配，所以只接受"像一个拼图块"的结果，
 * 不合理时如实返回 null。
 */

import { describe, expect, it } from 'vitest';
import { inferAlphaFromOpaqueCrop } from '@/background/slider/slider-image';

function makeImage(
  width: number,
  height: number,
  fill: (x: number, y: number) => [number, number, number],
) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = fill(x, y);
      const offset = (y * width + x) * 4;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
}

function opaqueRatio(image: { width: number; height: number; data: Uint8ClampedArray }): number {
  let opaque = 0;
  for (let pixel = 0; pixel < image.width * image.height; pixel += 1) {
    if (image.data[pixel * 4 + 3]! >= 32) opaque += 1;
  }
  return opaque / (image.width * image.height);
}

describe('inferAlphaFromOpaqueCrop', () => {
  it('深色拼图块画在浅色背景上时推断出形状', () => {
    // 40×40 裁剪：外圈浅色背景，中间 26×26 深色方块（约 42% 面积）
    const crop = makeImage(40, 40, (x, y) => {
      const inPiece = x >= 7 && x < 33 && y >= 7 && y < 33;
      return inPiece ? [45, 45, 50] : [195, 200, 205];
    });

    const inferred = inferAlphaFromOpaqueCrop(crop);

    expect(inferred).not.toBeNull();
    const ratio = opaqueRatio(inferred!);
    // 中间那块应该被标成不透明，外圈透明
    expect(ratio).toBeGreaterThan(0.3);
    expect(ratio).toBeLessThan(0.6);
    // 四角必须是透明的 —— 那是背景
    expect(inferred!.data[3]).toBe(0);
    const bottomRight = ((39 * 40) + 39) * 4 + 3;
    expect(inferred!.data[bottomRight]).toBe(0);
    // 中心必须是不透明的
    const center = ((20 * 40) + 20) * 4 + 3;
    expect(inferred!.data[center]).toBe(255);
  });

  it('带凸起的拼图形状也能推断（非矩形轮廓）', () => {
    const crop = makeImage(44, 44, (x, y) => {
      const inBody = x >= 8 && x < 36 && y >= 8 && y < 36;
      // 右侧中部一个圆形凸起
      const knobDistance = Math.hypot(x - 38, y - 22);
      const inKnob = knobDistance <= 6;
      return inBody || inKnob ? [50, 48, 52] : [200, 205, 210];
    });

    const inferred = inferAlphaFromOpaqueCrop(crop);

    expect(inferred).not.toBeNull();
    // 凸起位置应该被标成不透明
    const knobCentre = ((22 * 44) + 38) * 4 + 3;
    expect(inferred!.data[knobCentre]).toBe(255);
    // 凸起上方（背景）应该透明
    const aboveKnob = ((10 * 44) + 40) * 4 + 3;
    expect(inferred!.data[aboveKnob]).toBe(0);
  });

  it('整块与背景同色时返回 null，不产生噪点 mask', () => {
    // 全图同一个颜色 —— 无法区分前景背景
    const crop = makeImage(40, 40, () => [180, 185, 190]);

    expect(inferAlphaFromOpaqueCrop(crop)).toBeNull();
  });

  it('几乎整块都是前景时返回 null（等于没有形状信息）', () => {
    // 只有最外 1px 是背景色，其余全是深色 —— 不透明比例 > 0.9
    const crop = makeImage(40, 40, (x, y) => {
      const isBorder = x === 0 || y === 0 || x === 39 || y === 39;
      return isBorder ? [200, 200, 200] : [40, 40, 40];
    });

    expect(inferAlphaFromOpaqueCrop(crop)).toBeNull();
  });

  it('尺寸过小时返回 null', () => {
    const crop = makeImage(8, 8, (x) => (x < 4 ? [40, 40, 40] : [200, 200, 200]));

    expect(inferAlphaFromOpaqueCrop(crop)).toBeNull();
  });

  it('背景带纹理时阈值自适应，仍能分出前景', () => {
    const crop = makeImage(40, 40, (x, y) => {
      const inPiece = x >= 8 && x < 32 && y >= 8 && y < 32;
      if (inPiece) return [40, 42, 45];
      // 背景有 ±12 的纹理噪声
      const noise = ((x * 7 + y * 5) % 5) * 6;
      return [190 + noise, 195 + noise, 200 + noise];
    });

    const inferred = inferAlphaFromOpaqueCrop(crop);

    expect(inferred).not.toBeNull();
    const center = ((20 * 40) + 20) * 4 + 3;
    expect(inferred!.data[center]).toBe(255);
    // 纹理背景不该被误判成前景
    const corner = ((2 * 40) + 2) * 4 + 3;
    expect(inferred!.data[corner]).toBe(0);
  });

  it('保留原始 RGB，只改 alpha', () => {
    const crop = makeImage(40, 40, (x, y) => {
      const inPiece = x >= 10 && x < 30 && y >= 10 && y < 30;
      return inPiece ? [12, 34, 56] : [200, 205, 210];
    });

    const inferred = inferAlphaFromOpaqueCrop(crop);

    expect(inferred).not.toBeNull();
    const center = ((20 * 40) + 20) * 4;
    expect(inferred!.data[center]).toBe(12);
    expect(inferred!.data[center + 1]).toBe(34);
    expect(inferred!.data[center + 2]).toBe(56);
  });
});
