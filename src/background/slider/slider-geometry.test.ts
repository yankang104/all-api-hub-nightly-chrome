/**
 * 换算与歧义拦截。
 *
 * 两组用例：
 *  1. **DPR 一致性** —— 同一个逻辑缺口位置，在 100% / 125% / 150% / 200% 缩放下
 *     必须算出同一个拖动距离。截图路径按 devicePixelRatio 放大后裁剪会丢亚像素，
 *     不补偿的话偏差 1–2px，正好是校准序列 [0,-1,1,-2,2] 的量级 ——
 *     等于让重试去纠正一个本可算准的值。
 *  2. **歧义拦截** —— 图上有多个疑似缺口时不许出计划，交人工比赌一个位置好：
 *     每次失败都在累积站点的可疑计数。
 */

import { describe, expect, it } from 'vitest';
import { buildSliderDragPlan } from '@/background/slider/slider-geometry';
import type { PreparedSliderImages, SliderGapMatch } from '@/background/slider/slider-image';
import type { SliderChallengeInfo } from '@/types/slider';

const BACKGROUND_CSS_WIDTH = 330;
const BACKGROUND_CSS_HEIGHT = 190;
const PIECE_CSS_SIZE = 59;
const PIECE_CSS_LEFT = 25;
const HANDLE_CSS_WIDTH = 60;
/** 逻辑上的缺口左边缘（CSS 像素，相对背景图左边缘） */
const GAP_CSS_LEFT = 200;

function infoAt(dpr: number): SliderChallengeInfo {
  return {
    panelRect: { x: 20, y: 20, width: 380, height: 300 },
    // 故意用一个会产生小数物理坐标的 x：37 × 1.25 = 46.25
    backgroundRect: { x: 37, y: 60, width: BACKGROUND_CSS_WIDTH, height: BACKGROUND_CSS_HEIGHT },
    pieceRect: {
      x: 37 + PIECE_CSS_LEFT,
      y: 120,
      width: PIECE_CSS_SIZE,
      height: PIECE_CSS_SIZE,
    },
    trackRect: { x: 37, y: 300, width: BACKGROUND_CSS_WIDTH, height: 40 },
    handleRect: { x: 37, y: 300, width: HANDLE_CSS_WIDTH, height: 40 },
    viewportWidth: 1_280,
    viewportHeight: 800,
    devicePixelRatio: dpr,
    challengeKey: `dpr-${dpr}`,
  };
}

/**
 * 模拟 prepareSliderImages 的截图路径：按 dpr 放大 → Math.round 裁剪 →
 * 把丢掉的小数作为 cropOffset 带出来。
 */
function screenshotImages(dpr: number): PreparedSliderImages {
  const rawBackgroundX = 37 * dpr;
  const rawPieceX = (37 + PIECE_CSS_LEFT) * dpr;
  const backgroundPixelWidth = Math.max(1, Math.round(BACKGROUND_CSS_WIDTH * dpr));
  return {
    background: {
      width: backgroundPixelWidth,
      height: Math.max(1, Math.round(BACKGROUND_CSS_HEIGHT * dpr)),
      data: new Uint8ClampedArray(4),
    },
    template: {
      image: {
        width: Math.round(PIECE_CSS_SIZE * dpr),
        height: Math.round(PIECE_CSS_SIZE * dpr),
        data: new Uint8ClampedArray(4),
      },
      originalWidth: Math.round(PIECE_CSS_SIZE * dpr),
      originalHeight: Math.round(PIECE_CSS_SIZE * dpr),
      bounds: { x: 0, y: 0, width: Math.round(PIECE_CSS_SIZE * dpr), height: Math.round(PIECE_CSS_SIZE * dpr) },
      shapedAlpha: true,
    },
    source: 'viewport-screenshot',
    imageScaleX: backgroundPixelWidth / BACKGROUND_CSS_WIDTH,
    imageScaleY: Math.round(BACKGROUND_CSS_HEIGHT * dpr) / BACKGROUND_CSS_HEIGHT,
    cropOffsetX: rawBackgroundX - Math.round(rawBackgroundX),
    cropOffsetPieceX: rawPieceX - Math.round(rawPieceX),
  };
}

function matchAt(dpr: number, images: PreparedSliderImages, rivalCount = 0): SliderGapMatch {
  const templateWidth = images.template!.image.width;
  return {
    /*
     * 匹配器在背景图（= 裁剪图）像素坐标系里找到缺口。
     *
     * 裁剪原点是 `Math.round(rawBackgroundX)`，而缺口的物理绝对坐标是
     * `rawBackgroundX + GAP × scale`，所以裁剪图内坐标**含 cropOffsetX**：
     *   match.x = round(GAP × scale + cropOffsetX)
     * 漏掉这一项的话，`gapLeftCss` 的还原方向就无从检验 —— 加号和减号
     * 都只差一个 |cropOffsetX|/scale ≤ 0.4px，会被 0.5px 容差一起放过。
     */
    x: Math.round(GAP_CSS_LEFT * images.imageScaleX + images.cropOffsetX),
    y: 60,
    confidence: 0.8,
    confidenceMargin: 0.2,
    method: 'contour-alpha+ncc',
    candidateCount: 2,
    rivalCount,
    templateWidth,
    templateHeight: templateWidth,
    templateOffsetX: 0,
    templateOffsetY: 0,
    templateOriginalWidth: templateWidth,
    templateOriginalHeight: templateWidth,
  };
}

describe('buildSliderDragPlan · DPR 一致性', () => {
  const scales = [1, 1.25, 1.5, 2];

  it('同一个逻辑缺口在各缩放比下算出一致的拖动距离', () => {
    const distances = scales.map((dpr) => {
      const images = screenshotImages(dpr);
      const result = buildSliderDragPlan(infoAt(dpr), images, matchAt(dpr, images));
      expect(result.ok).toBe(true);
      return result.ok ? result.plan.distance : Number.NaN;
    });

    const reference = distances[0]!;
    for (const [index, distance] of distances.entries()) {
      // 亚像素补偿后，各缩放比之间的差应该在 0.5px 以内
      expect(Math.abs(distance - reference)).toBeLessThanOrEqual(0.5);
      expect(Number.isFinite(distance)).toBe(true);
      // 也要真的算对：逻辑距离 ≈ 200 - 25 = 175，行程比接近 1
      expect(distance).toBeGreaterThan(160);
      expect(distance).toBeLessThan(190);
      expect(index).toBeGreaterThanOrEqual(0);
    }
  });

  /**
   * 补偿的**方向**必须对。
   *
   * 上面那条只比各 DPR 之间的一致性，而符号写反时各 DPR 会**一致地**偏同一个
   * 方向，照样通过 —— 曾经 `gapLeftCss` 把 cropOffsetX 写成加号（应该减），
   * 把取整误差从「消除」变成「翻倍」，那条用例完全没有反应。
   *
   * 这里直接跟解析理想值比：`match.x` 已含 cropOffsetX（见 matchAt 的注释），
   * 还原时必须减掉才能回到 GAP_CSS_LEFT。容差 0.5px 是匹配器本身的量化下限
   * （match.x 取整），符号写反会产生约 1.2px 的偏差，落在容差之外。
   */
  it('亚像素补偿的方向正确 —— 与解析理想值的偏差不超过量化下限', () => {
    for (const dpr of scales) {
      const images = screenshotImages(dpr);
      const result = buildSliderDragPlan(infoAt(dpr), images, matchAt(dpr, images));

      expect(result.ok).toBe(true);
      if (!result.ok) continue;

      /*
       * 碎片模板从 round(rawPieceX) 裁起，所以起点的真实 CSS 位置也带着自己的
       * 取整偏移；理想图像距离 = (缺口 - 碎片左边缘) 的连续值。
       *
       * 再乘行程比：轨道行程(330-60) ÷ 碎片行程(330-59) ≈ 0.9963，不是 1 ——
       * 漏掉它会让"理想值"本身偏 0.65px，比要检验的符号误差还大。
       */
      const idealImageDistance = (GAP_CSS_LEFT - PIECE_CSS_LEFT)
        + images.cropOffsetPieceX / images.imageScaleX;
      const conversionRatio = (BACKGROUND_CSS_WIDTH - HANDLE_CSS_WIDTH)
        / (BACKGROUND_CSS_WIDTH - PIECE_CSS_SIZE);
      const idealDistance = idealImageDistance * conversionRatio;

      expect(Math.abs(result.plan.distance - idealDistance)).toBeLessThanOrEqual(0.5);
    }
  });

  it('诊断里带出亚像素补偿量，便于日志溯源', () => {
    const images = screenshotImages(1.25);
    const result = buildSliderDragPlan(infoAt(1.25), images, matchAt(1.25, images));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.diagnostics.source).toBe('viewport-screenshot');
      expect(result.plan.diagnostics.cropOffsetX).toBeDefined();
    }
  });

  it('原图路径没有裁剪偏移，补偿量为 0', () => {
    const images: PreparedSliderImages = {
      ...screenshotImages(1),
      source: 'raw-image',
      cropOffsetX: 0,
      cropOffsetPieceX: 0,
    };
    const result = buildSliderDragPlan(infoAt(1), images, matchAt(1, images));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.diagnostics.cropOffsetX).toBe(0);
  });
});

describe('buildSliderDragPlan · 歧义拦截', () => {
  it('存在其它疑似缺口且置信度不够高时拒绝出计划', () => {
    const images = screenshotImages(1);
    const match = { ...matchAt(1, images), confidence: 0.72, rivalCount: 2 };

    const result = buildSliderDragPlan(infoAt(1), images, match);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe('match-ambiguous');
      // 错误里要说清有几个候选，用户看日志时能明白为什么转人工
      expect(result.error).toContain('3');
    }
  });

  it('置信度足够高时即使有其它候选也放行', () => {
    const images = screenshotImages(1);
    const match = { ...matchAt(1, images), confidence: 0.93, rivalCount: 1 };

    const result = buildSliderDragPlan(infoAt(1), images, match);

    expect(result.ok).toBe(true);
  });

  it('没有其它候选时正常出计划', () => {
    const images = screenshotImages(1);
    const result = buildSliderDragPlan(infoAt(1), images, matchAt(1, images, 0));

    expect(result.ok).toBe(true);
  });
});
