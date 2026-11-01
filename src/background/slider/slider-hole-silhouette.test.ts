/**
 * 形状吻合定位 —— 多缺口验证码的核心判据。
 *
 * 复现的是 hvoy.ai 的真实形态：同一张背景图上画三个拼图形状，左边一个是
 * **拼图块**（带真实图像内容），另外两个是**缺口**（纯色填充），而两个缺口的
 * 凸起方向不同 —— 只有一个能装进当前这块。
 *
 * 旧的 edgeContourMatch 只统计轮廓上的梯度能量，任何暗色块的边界都能拿高分，
 * 完全不检验形状是否吻合，于是三个形状全部命中、分数都在 0.65–0.75，
 * 连续 5 次落在不同形状上。
 *
 * 这里断言的是「凸起方向不同的那个缺口不能被选中」。
 */

import { describe, expect, it } from 'vitest';
import { locateSliderGap, pieceLooksTextured, type PreparedSliderImages } from '@/background/slider/slider-image';
import type { SliderChallengeInfo } from '@/types/slider';

const SIZE = 48;
const BACKGROUND_WIDTH = 330;
const BACKGROUND_HEIGHT = 190;
const SHAPE_TOP = 100;

type Knob = 'top' | 'left' | 'right';

/**
 * 拼图轮廓：一个方形主体 + 一个半圆凸起。
 * 凸起方向不同的两个形状，轮廓不可互换 —— 这正是验证码用来区分的特征。
 */
function inSilhouette(localX: number, localY: number, knob: Knob): boolean {
  const bodyInset = 6;
  const inBody = localX >= bodyInset && localX < SIZE - bodyInset
    && localY >= bodyInset && localY < SIZE - bodyInset;
  if (inBody) return true;

  const knobRadius = 7;
  const centre = SIZE / 2;
  if (knob === 'top') return Math.hypot(localX - centre, localY - bodyInset) <= knobRadius;
  if (knob === 'left') return Math.hypot(localX - bodyInset, localY - centre) <= knobRadius;
  return Math.hypot(localX - (SIZE - bodyInset), localY - centre) <= knobRadius;
}

/** 背景图像内容：有纹理，深浅变化，模拟真实照片 */
function sceneryAt(x: number, y: number): [number, number, number] {
  const band = Math.sin(x * 0.05) * 26 + Math.cos(y * 0.07) * 18;
  const grain = ((x * 13 + y * 29) % 23) * 3;
  const base = 150 + band + grain;
  return [base, base + 12, base - 8];
}

interface HoleSpec {
  x: number;
  knob: Knob;
}

/**
 * 构造背景图：真实纹理 + 若干个纯色填充的缺口。
 * 缺口用深灰实心（真实站点就是这么画的）。
 */
function backgroundWith(holes: HoleSpec[]) {
  const data = new Uint8ClampedArray(BACKGROUND_WIDTH * BACKGROUND_HEIGHT * 4);
  for (let y = 0; y < BACKGROUND_HEIGHT; y += 1) {
    for (let x = 0; x < BACKGROUND_WIDTH; x += 1) {
      const offset = (y * BACKGROUND_WIDTH + x) * 4;
      let filled = false;
      for (const hole of holes) {
        const localX = x - hole.x;
        const localY = y - SHAPE_TOP;
        if (localX >= 0 && localX < SIZE && localY >= 0 && localY < SIZE
          && inSilhouette(localX, localY, hole.knob)) {
          filled = true;
          break;
        }
      }
      if (filled) {
        // 纯色填充，几乎没有方差 —— 缺口的关键特征
        data[offset] = 58;
        data[offset + 1] = 58;
        data[offset + 2] = 62;
      } else {
        const [r, g, b] = sceneryAt(x, y);
        data[offset] = r;
        data[offset + 1] = g;
        data[offset + 2] = b;
      }
      data[offset + 3] = 255;
    }
  }
  return { width: BACKGROUND_WIDTH, height: BACKGROUND_HEIGHT, data };
}

/**
 * 拼图块模板：指定凸起方向的轮廓，形状内是从背景图某处裁下来的真实内容。
 * alpha 已经推断好（形状内 255，形状外 0）。
 */
function pieceTemplate(knob: Knob, sourceX: number) {
  const data = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const offset = (y * SIZE + x) * 4;
      if (inSilhouette(x, y, knob)) {
        const [r, g, b] = sceneryAt(sourceX + x, SHAPE_TOP + y);
        data[offset] = r;
        data[offset + 1] = g;
        data[offset + 2] = b;
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
    panelRect: { x: 0, y: 0, width: BACKGROUND_WIDTH, height: BACKGROUND_HEIGHT + 60 },
    backgroundRect: { x: 0, y: 0, width: BACKGROUND_WIDTH, height: BACKGROUND_HEIGHT },
    pieceRect: { x: pieceLeft, y: SHAPE_TOP, width: SIZE, height: SIZE },
    trackRect: { x: 0, y: BACKGROUND_HEIGHT + 20, width: BACKGROUND_WIDTH, height: 32 },
    handleRect: { x: 0, y: BACKGROUND_HEIGHT + 20, width: 46, height: 32 },
    viewportWidth: 1_280,
    viewportHeight: 720,
    devicePixelRatio: 1,
    challengeKey: 'silhouette-test',
  };
}

function imagesFor(
  background: ReturnType<typeof backgroundWith>,
  template: ReturnType<typeof pieceTemplate>,
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

describe('holeSilhouetteMatch · 多缺口图上选出形状吻合的那个', () => {
  it('两个缺口凸起方向不同时，选中与拼图块吻合的那个', async () => {
    const pieceLeft = 20;
    const matchingHoleX = 130;   // 凸起在上 —— 与拼图块相同
    const decoyHoleX = 240;      // 凸起在左 —— 装不进去
    const background = backgroundWith([
      { x: matchingHoleX, knob: 'top' },
      { x: decoyHoleX, knob: 'left' },
    ]);
    const images = imagesFor(background, pieceTemplate('top', pieceLeft));

    const match = await locateSliderGap(infoFor(pieceLeft), images);

    expect(match).not.toBeNull();
    // 必须落在吻合的那个缺口上，容差半个凸起半径
    expect(Math.abs(match!.x - matchingHoleX)).toBeLessThanOrEqual(4);
    // 而且明显不是干扰项
    expect(Math.abs(match!.x - decoyHoleX)).toBeGreaterThan(20);
  });

  it('干扰缺口在左、吻合缺口在右时同样正确', async () => {
    const pieceLeft = 20;
    const decoyHoleX = 120;
    const matchingHoleX = 250;
    const background = backgroundWith([
      { x: decoyHoleX, knob: 'right' },
      { x: matchingHoleX, knob: 'top' },
    ]);
    const images = imagesFor(background, pieceTemplate('top', pieceLeft));

    const match = await locateSliderGap(infoFor(pieceLeft), images);

    expect(match).not.toBeNull();
    expect(Math.abs(match!.x - matchingHoleX)).toBeLessThanOrEqual(4);
  });

  it('三形状（1 拼图块 + 2 缺口）—— 复现实测形态', async () => {
    const pieceLeft = 22;
    const matchingHoleX = 145;
    const decoyHoleX = 255;
    // 拼图块本身也画在背景上（截图路径就是这样），所以背景里有三个形状
    const background = backgroundWith([
      { x: matchingHoleX, knob: 'top' },
      { x: decoyHoleX, knob: 'left' },
    ]);
    const images = imagesFor(background, pieceTemplate('top', pieceLeft));

    const match = await locateSliderGap(infoFor(pieceLeft), images);

    expect(match).not.toBeNull();
    expect(match!.method).toContain('hole-silhouette');
    expect(Math.abs(match!.x - matchingHoleX)).toBeLessThanOrEqual(4);
    // 形状吻合达到高置信度时视为权威结论，不因其它方法各说各话而转人工
    expect(match!.rivalCount).toBe(0);
  });

  it('唯一缺口的常规图仍然正确', async () => {
    const pieceLeft = 20;
    const holeX = 200;
    const background = backgroundWith([{ x: holeX, knob: 'top' }]);
    const images = imagesFor(background, pieceTemplate('top', pieceLeft));

    const match = await locateSliderGap(infoFor(pieceLeft), images);

    expect(match).not.toBeNull();
    expect(Math.abs(match!.x - holeX)).toBeLessThanOrEqual(4);
  });

  it('图上没有任何缺口时返回 null，不在纹理里硬凑一个', async () => {
    const pieceLeft = 20;
    const background = backgroundWith([]);
    const images = imagesFor(background, pieceTemplate('top', pieceLeft));

    const match = await locateSliderGap(infoFor(pieceLeft), images);

    expect(match).toBeNull();
  });
});

describe('pieceLooksTextured · 认错拼图块的护栏', () => {
  it('带真实图像内容的拼图块判为有纹理', () => {
    expect(pieceLooksTextured(pieceTemplate('top', 20))).toBe(true);
  });

  it('纯色填充（其实是缺口）判为无纹理', () => {
    const flat = pieceTemplate('top', 20);
    // 把形状内全部涂成缺口的填充色
    for (let pixel = 0; pixel < SIZE * SIZE; pixel += 1) {
      const offset = pixel * 4;
      if (flat.image.data[offset + 3]! >= 200) {
        flat.image.data[offset] = 58;
        flat.image.data[offset + 1] = 58;
        flat.image.data[offset + 2] = 62;
      }
    }

    expect(pieceLooksTextured(flat)).toBe(false);
  });

  it('没有形状信息时不做这个判断（返回 true 放行）', () => {
    const rectangular = pieceTemplate('top', 20);
    rectangular.shapedAlpha = false;

    expect(pieceLooksTextured(rectangular)).toBe(true);
  });
});
