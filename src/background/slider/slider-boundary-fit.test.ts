/**
 * 边界吻合度 —— 分辨「哪个缺口装得进这块碎片」。
 *
 * 复刻用户截图（hvoy）：同一张背景图上三个拼图形状，**凸起方向各不相同**
 * （左边浅色的凸起在右、中间的凸起在上、右边的凸起在左上）。上一次拖动
 * 被站点判「验证错误，请重试」。
 *
 * 为什么之前分不出来：`holeSilhouetteMatch` 原本只看三项**区域统计** ——
 * 内外反差、形状内平坦度、形状外纹理。而凸起方向不同的两个缺口在这三项上
 * 几乎一模一样（都是「暗色平坦块嵌在有纹理的图里」），于是在两者间随机选。
 *
 * 边界吻合度检验的是轮廓**形状**：沿轮廓每一对采样点（一内一外）的灰度差
 * 是否同向。位置正确时每一点都恰好跨在填充与图像的分界上；位置错了就会有
 * 相当比例的点落在「内外都是填充」或「内外都是图像」上。
 */

import { describe, expect, it } from 'vitest';
import { locateSliderGap, type PreparedSliderImages } from '@/background/slider/slider-image';
import type { SliderChallengeInfo } from '@/types/slider';

const SIZE = 46;
const BG_WIDTH = 340;
const BG_HEIGHT = 200;
const SHAPE_TOP = 90;
/** 缺口填充色（截图里是深灰） */
const FILL = 58;

type Knob = 'top' | 'right' | 'left';

/**
 * 拼图轮廓：方形主体 + 一个半圆凸起。
 * 凸起方向不同的两个形状轮廓不可互换 —— 这正是验证码用来区分的特征。
 */
function inSilhouette(x: number, y: number, knob: Knob): boolean {
  const inset = 6;
  if (x >= inset && x < SIZE - inset && y >= inset && y < SIZE - inset) return true;
  const mid = SIZE / 2;
  const r = 7;
  if (knob === 'top') return Math.hypot(x - mid, y - inset) <= r;
  if (knob === 'right') return Math.hypot(x - (SIZE - inset), y - mid) <= r;
  return Math.hypot(x - inset, y - mid) <= r;
}

/** 有纹理的背景（模拟截图里的叶脉/山谷照片） */
function scenery(x: number, y: number): number {
  return 150 + Math.sin(x * 0.06) * 30 + Math.cos(y * 0.08) * 22 + ((x * 13 + y * 29) % 27);
}

function backgroundWith(holes: Array<{ x: number; knob: Knob }>) {
  const data = new Uint8ClampedArray(BG_WIDTH * BG_HEIGHT * 4);
  for (let y = 0; y < BG_HEIGHT; y += 1) {
    for (let x = 0; x < BG_WIDTH; x += 1) {
      const offset = (y * BG_WIDTH + x) * 4;
      const filled = holes.some((hole) => {
        const lx = x - hole.x;
        const ly = y - SHAPE_TOP;
        return lx >= 0 && lx < SIZE && ly >= 0 && ly < SIZE && inSilhouette(lx, ly, hole.knob);
      });
      const value = filled ? FILL : scenery(x, y);
      data[offset] = value;
      data[offset + 1] = value + (filled ? 0 : 8);
      data[offset + 2] = value - (filled ? 0 : 5);
      data[offset + 3] = 255;
    }
  }
  return { width: BG_WIDTH, height: BG_HEIGHT, data };
}

/** 碎片模板：指定凸起方向，形状内是真实图像内容，alpha 已推断好 */
function piece(knob: Knob, sourceX: number) {
  const data = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const offset = (y * SIZE + x) * 4;
      if (inSilhouette(x, y, knob)) {
        const value = scenery(sourceX + x, SHAPE_TOP + y);
        data[offset] = value;
        data[offset + 1] = value + 8;
        data[offset + 2] = value - 5;
        data[offset + 3] = 255;
      } else {
        data[offset + 3] = 0;
      }
    }
  }
  return {
    image: { width: SIZE, height: SIZE, data },
    originalWidth: SIZE,
    originalHeight: SIZE,
    bounds: { x: 0, y: 0, width: SIZE, height: SIZE },
    shapedAlpha: true,
  };
}

function infoFor(pieceLeft: number): SliderChallengeInfo {
  return {
    panelRect: { x: 0, y: 0, width: BG_WIDTH, height: BG_HEIGHT + 60 },
    backgroundRect: { x: 0, y: 0, width: BG_WIDTH, height: BG_HEIGHT },
    pieceRect: { x: pieceLeft, y: SHAPE_TOP, width: SIZE, height: SIZE },
    trackRect: { x: 0, y: BG_HEIGHT + 20, width: BG_WIDTH, height: 32 },
    handleRect: { x: 0, y: BG_HEIGHT + 20, width: 46, height: 32 },
    viewportWidth: 1_280,
    viewportHeight: 720,
    devicePixelRatio: 1,
    challengeKey: 'boundary-fit',
  };
}

function imagesFor(
  background: ReturnType<typeof backgroundWith>,
  template: ReturnType<typeof piece>,
): PreparedSliderImages {
  return {
    background,
    template,
    source: 'viewport-screenshot',
    imageScaleX: 1,
    imageScaleY: 1,
    cropOffsetX: 0,
    cropOffsetPieceX: 0,
  };
}

describe('边界吻合度 · 凸起方向不同的两个缺口', () => {
  it('选中凸起方向相同的那个，不是位置更近的那个', async () => {
    const pieceLeft = 20;
    // 干扰缺口在**更近**的位置，吻合缺口在更远处 ——
    // 只看区域统计会倾向近的（评分里有距离惩罚），必须靠轮廓形状纠正
    const decoyX = 120;
    const matchX = 250;
    const background = backgroundWith([
      { x: decoyX, knob: 'left' },
      { x: matchX, knob: 'top' },
    ]);
    const images = imagesFor(background, piece('top', pieceLeft));

    const match = await locateSliderGap(infoFor(pieceLeft), images);

    expect(match).not.toBeNull();
    expect(Math.abs(match!.x - matchX)).toBeLessThanOrEqual(4);
    expect(Math.abs(match!.x - decoyX)).toBeGreaterThan(20);
  });

  it('反过来（吻合的在近处）同样正确', async () => {
    const pieceLeft = 20;
    const matchX = 130;
    const decoyX = 255;
    const background = backgroundWith([
      { x: matchX, knob: 'right' },
      { x: decoyX, knob: 'top' },
    ]);
    const images = imagesFor(background, piece('right', pieceLeft));

    const match = await locateSliderGap(infoFor(pieceLeft), images);

    expect(match).not.toBeNull();
    expect(Math.abs(match!.x - matchX)).toBeLessThanOrEqual(4);
  });

  it('三个形状（1 碎片 + 2 缺口）—— 复刻截图形态', async () => {
    const pieceLeft = 22;
    const matchX = 140;
    const decoyX = 250;
    const background = backgroundWith([
      { x: matchX, knob: 'top' },
      { x: decoyX, knob: 'left' },
    ]);
    const images = imagesFor(background, piece('top', pieceLeft));

    const match = await locateSliderGap(infoFor(pieceLeft), images);

    expect(match).not.toBeNull();
    expect(match!.method).toContain('hole-silhouette');
    expect(Math.abs(match!.x - matchX)).toBeLessThanOrEqual(4);
  });

  it('图上只有方向不符的缺口时拒绝，不硬拖一个错位置', async () => {
    const pieceLeft = 20;
    // 唯一的缺口凸起在左，而碎片凸起在上 —— 装不进去
    const background = backgroundWith([{ x: 200, knob: 'left' }]);
    const images = imagesFor(background, piece('top', pieceLeft));

    const match = await locateSliderGap(infoFor(pieceLeft), images);

    /*
     * 可接受两种结局：拒绝（null），或命中但如实报出还有别的候选。
     * 不可接受的是「高置信度命中一个方向不符的缺口」—— 那正是被站点
     * 判「验证错误」的来源。
     */
    if (match) {
      expect(match.confidence).toBeLessThan(0.66);
    } else {
      expect(match).toBeNull();
    }
  });

  it('唯一且方向吻合的缺口正常命中（不因新判据变严而漏）', async () => {
    const pieceLeft = 20;
    const holeX = 210;
    const background = backgroundWith([{ x: holeX, knob: 'top' }]);
    const images = imagesFor(background, piece('top', pieceLeft));

    const match = await locateSliderGap(infoFor(pieceLeft), images);

    expect(match).not.toBeNull();
    expect(Math.abs(match!.x - holeX)).toBeLessThanOrEqual(4);
  });

  it('图上没有任何缺口时返回 null', async () => {
    const pieceLeft = 20;
    const images = imagesFor(backgroundWith([]), piece('top', pieceLeft));

    expect(await locateSliderGap(infoFor(pieceLeft), images)).toBeNull();
  });
});
