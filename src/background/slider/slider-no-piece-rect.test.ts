/**
 * 没有拼图块矩形时的两条硬规则。
 *
 * `slider-dom.ts` 允许 `pieceRect: undefined` —— 有些站点不给独立的碎片元素，
 * 碎片直接画在背景图上。这条路径是受支持的，但它让两个前提同时失效：
 *
 *  1. **`yHint` 变得无意义** —— 它退化成 0，那不是「缺口在顶部」而是
 *     「不知道在哪一行」。而 `edgeContourMatch` 与 `searchBand` 都把 y 钳在
 *     `yHint ± 容差` 的窄带里，于是只能在背景图最上面十几个像素里找。
 *     `backgroundDifferenceMatch` 早就有豁免，另两路原来没有。
 *
 *  2. **模板退化成纯白占位** —— `inferredTemplate` 造的是 `fill(255)` 的白矩形，
 *     不带任何形状或纹理。喂给 `nccTemplateMatch` 会落进 `templateStd < 1`
 *     分支，评分是「哪里最亮最平」（`1 - |mean-255|/255 - 0.3·std/255`），
 *     与缺口无关 —— 缺口通常反而是暗的。亮照片背景 mean≈210/std≈8 时它拿
 *     0.814，越过单方法门槛 0.68，且往往是唯一候选（rivalCount=0），
 *     于是高置信度拖到一个纯属虚构的位置。
 */

import { describe, expect, it } from 'vitest';
import { locateSliderGap, type PreparedSliderImages } from '@/background/slider/slider-image';
import type { SliderChallengeInfo } from '@/types/slider';

const BACKGROUND_WIDTH = 340;
const BACKGROUND_HEIGHT = 200;
const GAP_SIZE = 40;
/** 缺口刻意放在纵向中部：修复前的窄带（y≈0–10）完全看不到它。 */
const GAP_TOP = 90;

function makeImage(
  width: number,
  height: number,
  fill: (x: number, y: number) => [number, number, number, number],
) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = fill(x, y);
      const offset = (y * width + x) * 4;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = a;
    }
  }
  return { width, height, data };
}

/** 亮背景 + 可选的一个深色缺口。亮是刻意的：纯白模板正是在亮背景上得分最高。 */
function background(gapX: number | null) {
  return makeImage(BACKGROUND_WIDTH, BACKGROUND_HEIGHT, (x, y) => {
    if (gapX != null && x >= gapX && x < gapX + GAP_SIZE && y >= GAP_TOP && y < GAP_TOP + GAP_SIZE) {
      return [40, 40, 40, 255];
    }
    const noise = (x * 7 + y * 13) % 17;
    return [205 + noise, 210 + noise, 215 + noise, 255];
  });
}

function infoWithoutPieceRect(): SliderChallengeInfo {
  return {
    panelRect: { x: 0, y: 0, width: BACKGROUND_WIDTH, height: BACKGROUND_HEIGHT + 60 },
    backgroundRect: { x: 0, y: 0, width: BACKGROUND_WIDTH, height: BACKGROUND_HEIGHT },
    // 关键：站点没有暴露独立的碎片元素
    pieceRect: undefined,
    trackRect: { x: 0, y: BACKGROUND_HEIGHT + 20, width: BACKGROUND_WIDTH, height: 30 },
    handleRect: { x: 0, y: BACKGROUND_HEIGHT + 20, width: 40, height: 30 },
    viewportWidth: 1_280,
    viewportHeight: 720,
    devicePixelRatio: 1,
    challengeKey: 'no-piece-rect',
  };
}

describe('locateSliderGap · 没有 pieceRect 时的纵向搜索范围', () => {
  it('缺口在纵向中部也能找到（不再只搜背景图顶端窄带）', async () => {
    const gapX = 200;
    const images: PreparedSliderImages = {
      background: background(gapX),
      // 双图差分需要参考图；它是无 pieceRect 时唯一真正可用的方法
      referenceBackground: background(null),
      template: undefined,
      source: 'viewport-screenshot',
      imageScaleX: 1,
      imageScaleY: 1,
      cropOffsetX: 0,
      cropOffsetPieceX: 0,
    };

    const match = await locateSliderGap(infoWithoutPieceRect(), images);

    expect(match).not.toBeNull();
    // 修复前：yHint=0 把搜索钳在 y∈[0,10]，缺口（y=90）看不到 → null 或错位
    expect(Math.abs(match!.x - gapX)).toBeLessThanOrEqual(4);
    expect(Math.abs(match!.y - GAP_TOP)).toBeLessThanOrEqual(6);
  });
});

describe('locateSliderGap · 纯白占位模板不得凭亮度编造缺口', () => {
  /**
   * 没有参考图、也没有碎片图时，图上**没有**缺口 —— 正确答案是 null。
   *
   * 修复前：唯一的候选来自纯白模板走 NCC，它在亮背景上找「最亮最平」的窗口，
   * 拿到 0.8 以上的置信度、rivalCount=0，`buildSliderDragPlan` 的门槛全部放行。
   */
  it('无缺口的亮背景返回 null，不返回"最亮最平"的位置', async () => {
    const images: PreparedSliderImages = {
      background: background(null),
      referenceBackground: undefined,
      template: undefined,
      source: 'viewport-screenshot',
      imageScaleX: 1,
      imageScaleY: 1,
      cropOffsetX: 0,
      cropOffsetPieceX: 0,
    };

    const match = await locateSliderGap(infoWithoutPieceRect(), images);

    expect(match).toBeNull();
  });

  it('有缺口但没有参考图时也不靠亮度硬凑 —— 要么找到缺口，要么如实返回 null', async () => {
    const gapX = 200;
    const images: PreparedSliderImages = {
      background: background(gapX),
      referenceBackground: undefined,
      template: undefined,
      source: 'viewport-screenshot',
      imageScaleX: 1,
      imageScaleY: 1,
      cropOffsetX: 0,
      cropOffsetPieceX: 0,
    };

    const match = await locateSliderGap(infoWithoutPieceRect(), images);

    // 不可接受的是「命中一个与缺口无关的亮区域」。轮廓类方法可能找到缺口边缘，
    // 那是合理的；返回 null 也合理。但不能落在别处。
    if (match) {
      expect(Math.abs(match.x - gapX)).toBeLessThanOrEqual(GAP_SIZE / 2);
    } else {
      expect(match).toBeNull();
    }
  });
});
