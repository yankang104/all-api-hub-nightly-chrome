import { describe, expect, it } from 'vitest';
import type { SliderChallengeInfo } from '@/types/slider';
import { buildSliderDragPlan } from '@/background/slider/slider-geometry';
import type { PreparedSliderImages, SliderGapMatch } from '@/background/slider/slider-image';

const BACKGROUND_WIDTH = 330;
const PIECE_WIDTH = 59;
const HANDLE_WIDTH = 60;
const PIECE_LEFT = 25;
const GAP_LEFT = 200;
const RANGE_RATIO = (BACKGROUND_WIDTH - HANDLE_WIDTH) / (BACKGROUND_WIDTH - PIECE_WIDTH);
const EXPECTED_DISTANCE = (GAP_LEFT - PIECE_LEFT) * RANGE_RATIO;

/** 同一页面几何与目标，只改变模板透明边距和截图/原图的像素比例。 */
function fixture(
  source: PreparedSliderImages['source'],
  scale = 1,
  trimLeft = 0,
  trimRight = trimLeft,
): { info: SliderChallengeInfo; images: PreparedSliderImages; match: SliderGapMatch } {
  const backgroundX = 37;
  const info: SliderChallengeInfo = {
    panelRect: { x: 20, y: 20, width: 380, height: 340 },
    backgroundRect: { x: backgroundX, y: 60, width: BACKGROUND_WIDTH, height: 190 },
    pieceRect: { x: backgroundX + PIECE_LEFT, y: 120, width: PIECE_WIDTH, height: PIECE_WIDTH },
    trackRect: { x: backgroundX, y: 300, width: BACKGROUND_WIDTH, height: 40 },
    handleRect: { x: backgroundX, y: 300, width: HANDLE_WIDTH, height: 40 },
    viewportWidth: 1_280,
    viewportHeight: 800,
    devicePixelRatio: scale,
    challengeKey: 'same-layout',
  };
  const originalWidth = Math.round(PIECE_WIDTH * scale);
  const templateWidth = originalWidth - trimLeft - trimRight;
  const rawBackgroundX = backgroundX * scale;
  const rawPieceX = (backgroundX + PIECE_LEFT) * scale;
  const cropOffsetX = source === 'viewport-screenshot'
    ? rawBackgroundX - Math.round(rawBackgroundX) : 0;
  const cropOffsetPieceX = source === 'viewport-screenshot'
    ? rawPieceX - Math.round(rawPieceX) : 0;
  const images: PreparedSliderImages = {
    background: {
      width: Math.round(BACKGROUND_WIDTH * scale),
      height: Math.round(190 * scale),
      data: new Uint8ClampedArray(4),
    },
    source,
    // 与生产截图一致：裁剪只取整边界，不会重新缩放图片。
    imageScaleX: scale,
    imageScaleY: scale,
    cropOffsetX,
    cropOffsetPieceX,
  };
  // 匹配结果指向裁后模板的原点，不是透明边距之外的 DOM 左边缘。
  const templateOffsetCss = source === 'raw-image'
    ? trimLeft / originalWidth * PIECE_WIDTH
    : (trimLeft - cropOffsetPieceX) / scale;
  const match: SliderGapMatch = {
    x: Math.round((GAP_LEFT + templateOffsetCss) * scale + cropOffsetX),
    y: 60,
    confidence: 0.9,
    confidenceMargin: 0.2,
    method: 'hole-silhouette',
    candidateCount: 1,
    rivalCount: 0,
    templateWidth,
    templateHeight: originalWidth,
    templateOffsetX: trimLeft,
    templateOffsetY: 0,
    templateOriginalWidth: originalWidth,
    templateOriginalHeight: originalWidth,
  };
  return { info, images, match };
}

describe.each(['raw-image', 'viewport-screenshot'] as const)('buildSliderDragPlan · %s 行程稳定', (source) => {
  it.each([0, 2, 4, 6])('裁剪掉左右各 %i 像素透明边距不改变拖动距离', (trim) => {
    const { info, images, match } = fixture(source, 1, trim);
    const result = buildSliderDragPlan(info, images, match);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.diagnostics.imageDistance).toBe(GAP_LEFT - PIECE_LEFT);
    expect(result.plan.diagnostics.pieceRange).toBe(BACKGROUND_WIDTH - PIECE_WIDTH);
    expect(result.plan.distance).toBeCloseTo(EXPECTED_DISTANCE, 2);
  });

  it('左右不对称的透明边距也不改变拖动距离', () => {
    const { info, images, match } = fixture(source, 1, 3, 9);
    const result = buildSliderDragPlan(info, images, match);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.distance).toBeCloseTo(EXPECTED_DISTANCE, 2);
  });

  it.each([1.25, 1.5, 2])('像素比例 %f 时，裁剪与宽度取整不能改变页面行程', (scale) => {
    const { info, images, match } = fixture(source, scale, Math.round(4 * scale), Math.round(6 * scale));
    const result = buildSliderDragPlan(info, images, match);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.diagnostics.pieceRange).toBe(BACKGROUND_WIDTH - PIECE_WIDTH);
    // 只允许匹配坐标半个图像像素，以及最终距离保留两位小数的取整误差。
    const quantizationBound = 0.5 / scale * RANGE_RATIO + 0.005;
    expect(Math.abs(result.plan.distance - EXPECTED_DISTANCE)).toBeLessThanOrEqual(quantizationBound);
  });
});

describe('buildSliderDragPlan · 控件尺寸与兼容保护', () => {
  it('保留页面上 58.9px 这样的非整数控件宽度', () => {
    const { info, images, match } = fixture('viewport-screenshot', 1, 4);
    info.pieceRect!.width = 58.9;
    const result = buildSliderDragPlan(info, images, match);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.diagnostics.pieceRange).toBe(271.1);
    expect(result.plan.distance).toBeCloseTo(175 * 270 / 271.1, 2);
  });

  it('没有拼图 DOM 矩形时仍保留原来的模板宽度回退', () => {
    const { info, images, match } = fixture('viewport-screenshot', 1, 6);
    info.pieceRect = undefined;
    const result = buildSliderDragPlan(info, images, match);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const fallbackRange = BACKGROUND_WIDTH - match.templateWidth;
    expect(result.plan.diagnostics.pieceRange).toBe(fallbackRange);
    expect(result.plan.distance).toBeCloseTo(match.x * 270 / fallbackRange, 2);
  });

  it('模板裁剪不能掩盖实际控件没有足够行程', () => {
    const { info, images, match } = fixture('viewport-screenshot', 1, 6);
    info.pieceRect!.width = BACKGROUND_WIDTH - 10;
    const result = buildSliderDragPlan(info, images, match);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('invalid-geometry');
  });

  it('已有反馈修正仍按把手 CSS 像素叠加', () => {
    const { info, images, match } = fixture('viewport-screenshot', 1, 6);
    const result = buildSliderDragPlan(info, images, match, 2);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.diagnostics.correctionPx).toBe(2);
    expect(result.plan.distance).toBeCloseTo(EXPECTED_DISTANCE + 2, 2);
  });
});
