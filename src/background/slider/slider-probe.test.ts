/**
 * 拖拽中差分测量。
 *
 * 这条路取代了三个靠推断的量：碎片是哪一块、碎片什么形状、行程比多少。
 * 前两轮修复失败的共同原因就是这三个推断里至少有一个错，而错了之后日志
 * 看着一切正常 —— 最难排查的一类。
 *
 * 用例分两组：
 *  1. **测得准** —— 构造「碎片移动了 N 像素」的两张图，断言测出的轮廓、
 *     位置和行程比都对
 *  2. **测不准时如实失败** —— 两团重叠、页面有别的动画、碎片没跟着动，
 *     这些情况必须返回失败让调用方回退，绝不能给一个错的测量结果
 */

import { describe, expect, it } from 'vitest';
import { diffMask, findBlobs, measurePieceFromProbe } from '@/background/slider/slider-probe';
import type { SimpleImageData } from '@/background/slider/slider-image';

const WIDTH = 400;
const HEIGHT = 260;
const PIECE_SIZE = 46;
const PIECE_TOP = 120;
/** 背景图在截图里的位置 */
const BACKGROUND = { x: 30, y: 60, width: 340, height: 180 };

function blank(): SimpleImageData {
  const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel += 1) {
    const x = pixel % WIDTH;
    const y = (pixel - x) / WIDTH;
    const offset = pixel * 4;
    // 有纹理的背景，避免纯色让差分退化
    const shade = 140 + Math.sin(x * 0.04) * 30 + Math.cos(y * 0.06) * 20 + ((x * 7 + y * 11) % 19);
    data[offset] = shade;
    data[offset + 1] = shade + 10;
    data[offset + 2] = shade - 6;
    data[offset + 3] = 255;
  }
  return { width: WIDTH, height: HEIGHT, data };
}

/** 拼图轮廓：方形主体 + 顶部半圆凸起 */
function inPieceShape(localX: number, localY: number): boolean {
  const inset = 5;
  const inBody = localX >= inset && localX < PIECE_SIZE - inset
    && localY >= inset && localY < PIECE_SIZE - inset;
  if (inBody) return true;
  return Math.hypot(localX - PIECE_SIZE / 2, localY - inset) <= 6;
}

/** 在图上把碎片画到指定 x（碎片内容是明显区别于背景的亮色） */
function paintPieceAt(image: SimpleImageData, pieceX: number): void {
  for (let localY = 0; localY < PIECE_SIZE; localY += 1) {
    for (let localX = 0; localX < PIECE_SIZE; localX += 1) {
      if (!inPieceShape(localX, localY)) continue;
      const x = pieceX + localX;
      const y = PIECE_TOP + localY;
      if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) continue;
      const offset = (y * WIDTH + x) * 4;
      image.data[offset] = 250;
      image.data[offset + 1] = 245;
      image.data[offset + 2] = 235;
    }
  }
}

/** 构造「按下前」和「探测移动后」两张图 */
function probeShots(originX: number, movedX: number) {
  const before = blank();
  paintPieceAt(before, originX);
  const after = blank();
  paintPieceAt(after, movedX);
  return { before, after };
}

describe('diffMask', () => {
  it('尺寸不一致时返回 null', () => {
    const before = blank();
    const after: SimpleImageData = { width: 10, height: 10, data: new Uint8ClampedArray(400) };
    expect(diffMask(before, after)).toBeNull();
  });

  it('完全相同的两张图差分掩码全 0', () => {
    const image = blank();
    const mask = diffMask(image, image)!;
    expect(mask.some((value) => value === 1)).toBe(false);
  });

  it('只标出真正变化的像素', () => {
    const { before, after } = probeShots(40, 140);
    const mask = diffMask(before, after)!;
    // 碎片原位置和新位置的中心都应被标记
    expect(mask[(PIECE_TOP + 20) * WIDTH + 40 + 20]).toBe(1);
    expect(mask[(PIECE_TOP + 20) * WIDTH + 140 + 20]).toBe(1);
    // 两者之间未被碎片覆盖过的区域不该被标记
    expect(mask[10 * WIDTH + 10]).toBe(0);
  });
});

describe('findBlobs', () => {
  it('两个分离的团被正确分开，按面积降序', () => {
    const mask = new Uint8Array(WIDTH * HEIGHT);
    // 大团 20×20
    for (let y = 10; y < 30; y += 1) for (let x = 10; x < 30; x += 1) mask[y * WIDTH + x] = 1;
    // 小团 12×12
    for (let y = 10; y < 22; y += 1) for (let x = 100; x < 112; x += 1) mask[y * WIDTH + x] = 1;

    const blobs = findBlobs(mask, WIDTH, HEIGHT, 20);

    expect(blobs.length).toBe(2);
    expect(blobs[0]!.area).toBe(400);
    expect(blobs[0]!.x).toBe(10);
    expect(blobs[1]!.area).toBe(144);
    expect(blobs[1]!.x).toBe(100);
  });

  it('小于最小面积的团被过滤（滤噪声）', () => {
    const mask = new Uint8Array(WIDTH * HEIGHT);
    for (let y = 10; y < 30; y += 1) for (let x = 10; x < 30; x += 1) mask[y * WIDTH + x] = 1;
    mask[200 * WIDTH + 200] = 1; // 单像素噪声

    const blobs = findBlobs(mask, WIDTH, HEIGHT, 20);

    expect(blobs.length).toBe(1);
  });

  it('L 形连通域不被拆开（4 邻域洪泛）', () => {
    const mask = new Uint8Array(WIDTH * HEIGHT);
    for (let y = 20; y < 60; y += 1) for (let x = 20; x < 32; x += 1) mask[y * WIDTH + x] = 1;
    for (let y = 48; y < 60; y += 1) for (let x = 32; x < 70; x += 1) mask[y * WIDTH + x] = 1;

    const blobs = findBlobs(mask, WIDTH, HEIGHT, 20);

    expect(blobs.length).toBe(1);
    expect(blobs[0]!.width).toBe(50);
  });
});

describe('measurePieceFromProbe · 测得准', () => {
  it('测出碎片新位置、旧位置与行程比', () => {
    const originX = 40;
    const movedX = 40 + 60;   // 碎片移动 60 物理像素
    const { before, after } = probeShots(originX, movedX);

    const result = measurePieceFromProbe({
      before,
      after,
      handleDeltaCss: 60,     // 把手也移动 60 CSS 像素
      pixelRatio: 1,          // 1:1，所以行程比应该是 1.0
      backgroundRect: BACKGROUND,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const m = result.measurement;
    /*
     * 包围盒对齐的是**轮廓最左侧像素**，不是绘制矩形的左边缘。
     * 测试用的形状主体有 5px inset，所以两个包围盒都比绘制位置右移 5px。
     *
     * 这不影响行程比 —— 两团同样偏移，相减时抵消。下游用的也正是这个
     * 包围盒坐标系（模板从同一个包围盒裁出），所以偏移是自洽的。
     */
    const silhouetteInset = 5;
    expect(Math.abs(m.pieceX - (movedX + silhouetteInset))).toBeLessThanOrEqual(2);
    expect(Math.abs(m.originX - (originX + silhouetteInset))).toBeLessThanOrEqual(2);
    // 真正要保证的是这个：位移比测得准
    expect(m.measuredRatio).toBeCloseTo(1, 1);
  });

  it('行程比不为 1 时也测得准（站点自定义映射）', () => {
    const originX = 40;
    // 把手移动 40，碎片移动 60 → 行程比 1.5
    const { before, after } = probeShots(originX, originX + 60);

    const result = measurePieceFromProbe({
      before,
      after,
      handleDeltaCss: 40,
      pixelRatio: 1,
      backgroundRect: BACKGROUND,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.measurement.measuredRatio).toBeCloseTo(1.5, 1);
  });

  it('devicePixelRatio ≠ 1 时正确换算', () => {
    const originX = 40;
    // 截图物理像素移动 75，把手 CSS 移动 60，DPR 1.25 → 行程比 1.0
    const { before, after } = probeShots(originX, originX + 75);

    const result = measurePieceFromProbe({
      before,
      after,
      handleDeltaCss: 60,
      pixelRatio: 1.25,
      backgroundRect: BACKGROUND,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.measurement.measuredRatio).toBeCloseTo(1, 1);
  });

  it('测出的模板 alpha 就是碎片真实轮廓', () => {
    const { before, after } = probeShots(40, 130);

    const result = measurePieceFromProbe({
      before,
      after,
      handleDeltaCss: 90,
      pixelRatio: 1,
      backgroundRect: BACKGROUND,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const template = result.measurement.template;
    const alphaAt = (x: number, y: number) => template.data[(y * template.width + x) * 4 + 3];

    // 主体中心不透明
    expect(alphaAt(PIECE_SIZE / 2 | 0, PIECE_SIZE / 2 | 0)).toBe(255);
    // 左上角在轮廓外（inset=5 的方形主体之外），应该透明
    expect(alphaAt(0, 0)).toBe(0);
    /*
     * 顶部凸起。
     *
     * 包围盒的 y=0 对应轮廓最顶端那一行，凸起是半径 6 的半圆、圆心在
     * localY=5，所以最顶端只有圆心正下方一两个像素属于轮廓。取包围盒
     * 顶部往下 3 行的中线 —— 那里必然在凸起内部。
     */
    expect(alphaAt(PIECE_SIZE / 2 | 0, 3)).toBe(255);
    // 凸起两侧同一行仍在轮廓外
    expect(alphaAt(2, 1)).toBe(0);
  });
});

describe('measurePieceFromProbe · 测不准时如实失败', () => {
  it('探测位移过小直接拒绝', () => {
    const { before, after } = probeShots(40, 42);

    const result = measurePieceFromProbe({
      before, after, handleDeltaCss: 2, pixelRatio: 1, backgroundRect: BACKGROUND,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('探测位移过小');
  });

  it('两团重叠（位移不足一个碎片宽）时拒绝', () => {
    // 只移动 10px，远小于碎片宽 46 → 新旧位置连成一团
    const { before, after } = probeShots(40, 50);

    const result = measurePieceFromProbe({
      before, after, handleDeltaCss: 10, pixelRatio: 1, backgroundRect: BACKGROUND,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('重叠');
  });

  it('碎片完全没动时拒绝（拖拽没被控件接受）', () => {
    const image = blank();
    paintPieceAt(image, 40);

    const result = measurePieceFromProbe({
      before: image,
      after: image,
      handleDeltaCss: 60,
      pixelRatio: 1,
      backgroundRect: BACKGROUND,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('没有可识别的变化');
  });

  it('两团垂直错位过大时拒绝（不是同一个碎片）', () => {
    const before = blank();
    paintPieceAt(before, 40);
    // 在完全不同的高度画一块，模拟页面上另有动画
    const after = blank();
    for (let localY = 0; localY < PIECE_SIZE; localY += 1) {
      for (let localX = 0; localX < PIECE_SIZE; localX += 1) {
        if (!inPieceShape(localX, localY)) continue;
        const x = 150 + localX;
        const y = 70 + localY;   // 比原位置高 50px
        const offset = (y * WIDTH + x) * 4;
        after.data[offset] = 250;
        after.data[offset + 1] = 245;
        after.data[offset + 2] = 235;
      }
    }

    const result = measurePieceFromProbe({
      before, after, handleDeltaCss: 110, pixelRatio: 1, backgroundRect: BACKGROUND,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('垂直位置');
  });

  it('测得的行程比超出合理范围时拒绝', () => {
    // 碎片移动 200，把手只移动 20 → 行程比 10，不可能
    const { before, after } = probeShots(40, 240);

    const result = measurePieceFromProbe({
      before, after, handleDeltaCss: 20, pixelRatio: 1, backgroundRect: BACKGROUND,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('行程比');
  });

  it('背景图区域外的变化被忽略（页面别处的动画）', () => {
    const { before, after } = probeShots(40, 130);
    // 在背景图区域**外**加一块变化（模拟倒计时数字刷新）
    for (let y = 5; y < 40; y += 1) {
      for (let x = 5; x < 25; x += 1) {
        const offset = (y * WIDTH + x) * 4;
        after.data[offset] = 0;
        after.data[offset + 1] = 0;
        after.data[offset + 2] = 0;
      }
    }

    const result = measurePieceFromProbe({
      before, after, handleDeltaCss: 90, pixelRatio: 1, backgroundRect: BACKGROUND,
    });

    // 区域外的干扰被裁掉，测量仍然成功
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.measurement.measuredRatio).toBeCloseTo(1, 1);
  });

  it('截图尺寸不一致时拒绝', () => {
    const before = blank();
    const after: SimpleImageData = { width: 10, height: 10, data: new Uint8ClampedArray(400) };

    const result = measurePieceFromProbe({
      before, after, handleDeltaCss: 60, pixelRatio: 1, backgroundRect: BACKGROUND,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('尺寸不一致');
  });
});
