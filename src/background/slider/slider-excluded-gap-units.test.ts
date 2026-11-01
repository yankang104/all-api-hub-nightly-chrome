/**
 * `excludedGapX` 的单位一致性。
 *
 * 这个字段是唯一跨上下文往回传的坐标：content script 把上一轮失败的
 * `result.gapX`（**背景图左边缘起算的 CSS 像素**）攒起来回传，后台两条识别路径
 * 各自在自己的像素空间里比较 —— 静态路径是背景图像素、边拖边测是截图裁剪像素。
 *
 * 曾经类型注释写的是「背景图像素」而生产方一直给 CSS 像素，两边都直接拿去比：
 * `imageScaleX = 1` 时恰好等价，于是全部既有用例（都用 scale=1）都看不出问题；
 * 而 HiDPI / Windows 125%–150% 缩放 / 站点按 2x 出图时排除区整体错位 ——
 * 真正失败的缺口没被排掉（5 次机会继续白费），反倒可能排掉一个有效候选。
 *
 * 所以这里的用例**必须**用 scale ≠ 1，这是它存在的全部意义。
 */

import { describe, expect, it } from 'vitest';
import { locateSliderGap, type PreparedSliderImages } from '@/background/slider/slider-image';
import type { SliderChallengeInfo } from '@/types/slider';

const BACKGROUND_CSS_WIDTH = 330;
const BACKGROUND_CSS_HEIGHT = 190;
const PIECE_CSS_SIZE = 40;
const PIECE_CSS_LEFT = 20;
const GAP_ROW_CSS_TOP = 40;

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

/** 背景按 scale 放大：缺口位置用 CSS 坐标给，内部换算到图像素。 */
function backgroundWithGapsCss(gapCssXs: number[], scale: number) {
  const width = Math.round(BACKGROUND_CSS_WIDTH * scale);
  const height = Math.round(BACKGROUND_CSS_HEIGHT * scale);
  const gapSize = Math.round(PIECE_CSS_SIZE * scale);
  const gapTop = Math.round(GAP_ROW_CSS_TOP * scale);
  const gapPixelXs = gapCssXs.map((cssX) => Math.round(cssX * scale));
  return makeImage(width, height, (x, y) => {
    const inGap = gapPixelXs.some((gapX) => (
      x >= gapX && x < gapX + gapSize && y >= gapTop && y < gapTop + gapSize
    ));
    if (inGap) return [40, 40, 40, 255];
    const noise = ((x * 7 + y * 13) % 17) * 3;
    return [180 + noise, 190 + noise, 200 + noise, 255];
  });
}

function pieceTemplateScaled(scale: number) {
  const size = Math.round(PIECE_CSS_SIZE * scale);
  return makeImage(size, size, (x, y) => {
    const noise = ((x * 5 + y * 11) % 13) * 4;
    return [40 + noise, 40 + noise, 40 + noise, 255];
  });
}

function infoFor(): SliderChallengeInfo {
  return {
    panelRect: { x: 0, y: 0, width: BACKGROUND_CSS_WIDTH, height: BACKGROUND_CSS_HEIGHT + 60 },
    backgroundRect: { x: 0, y: 0, width: BACKGROUND_CSS_WIDTH, height: BACKGROUND_CSS_HEIGHT },
    pieceRect: { x: PIECE_CSS_LEFT, y: GAP_ROW_CSS_TOP, width: PIECE_CSS_SIZE, height: PIECE_CSS_SIZE },
    trackRect: { x: 0, y: BACKGROUND_CSS_HEIGHT + 20, width: BACKGROUND_CSS_WIDTH, height: 30 },
    handleRect: { x: 0, y: BACKGROUND_CSS_HEIGHT + 20, width: 40, height: 30 },
    viewportWidth: 1_280,
    viewportHeight: 720,
    devicePixelRatio: 1,
    challengeKey: 'excluded-units',
  };
}

function imagesFor(
  background: ReturnType<typeof makeImage>,
  template: ReturnType<typeof makeImage>,
  scale: number,
): PreparedSliderImages {
  return {
    background,
    template: {
      image: template,
      originalWidth: template.width,
      originalHeight: template.height,
      bounds: { x: 0, y: 0, width: template.width, height: template.height },
      shapedAlpha: false,
    },
    source: 'viewport-screenshot',
    imageScaleX: background.width / BACKGROUND_CSS_WIDTH,
    imageScaleY: Math.round(BACKGROUND_CSS_HEIGHT * scale) / BACKGROUND_CSS_HEIGHT,
    cropOffsetX: 0,
    cropOffsetPieceX: 0,
  };
}

/**
 * 复刻 slider-crack.ts 里的换算：CSS → 背景图像素。
 *
 * 这里刻意重写一遍而不是导出生产函数：用例要验的是"两侧单位约定一致"，
 * 直接复用同一个函数的话，约定一起错了也照样通过。
 */
function toBackgroundPixels(
  cssXs: readonly number[],
  images: PreparedSliderImages,
): Array<{ x: number; radius: number }> {
  return cssXs.map((cssX) => ({
    x: cssX * images.imageScaleX + images.cropOffsetX,
    radius: Math.max(6, (images.template?.image.width ?? 40) / 3),
  }));
}

describe('excludedGapX 的单位换算', () => {
  // 1.25 / 1.5 是 Windows 最常见的两档缩放；2 是站点按 2x 出图。
  for (const scale of [1.25, 1.5, 2]) {
    it(`scale=${scale} 时按 CSS 像素给出的已失败位置能真正排掉对应候选`, async () => {
      const failedGapCss = 120;
      const otherGapCss = 250;
      const background = backgroundWithGapsCss([failedGapCss, otherGapCss], scale);
      const images = imagesFor(background, pieceTemplateScaled(scale), scale);
      const info = infoFor();

      const excluded = toBackgroundPixels([failedGapCss], images);
      const match = await locateSliderGap(info, images, excluded);

      // 排掉之后要么落在另一个缺口上，要么如实返回 null —— 但绝不能又回到
      // 那个已经被站点判失败的位置。
      if (match) {
        const matchCssX = (match.x - images.cropOffsetX) / images.imageScaleX;
        expect(Math.abs(matchCssX - failedGapCss)).toBeGreaterThan(PIECE_CSS_SIZE / 3);
      } else {
        expect(match).toBeNull();
      }
    });
  }

  /**
   * 反向守卫：不换算会怎样。
   *
   * 直接把 CSS 值当图像素用（即修复前的行为），排除区会落在
   * `failedGapCss` 而不是 `failedGapCss × scale` 上。scale=2、失败位置
   * CSS=120 时，排除区盖住图像素 120（CSS 60）附近，而真正要排的图像素 240
   * 完全没被碰到 —— 这条用例证明「不换算」确实排不掉，从而说明换算是必需的，
   * 而不是可有可无的形式转换。
   */
  it('不做换算时排除区落在错误位置（说明换算是必需的）', async () => {
    const scale = 2;
    const failedGapCss = 120;
    const background = backgroundWithGapsCss([failedGapCss], scale);
    const images = imagesFor(background, pieceTemplateScaled(scale), scale);
    const info = infoFor();

    const radius = Math.max(6, images.template!.image.width / 3);
    const correct = toBackgroundPixels([failedGapCss], images)[0]!;
    const naive = { x: failedGapCss, radius };

    // 正确换算后的排除中心确实覆盖真实缺口的图像素位置
    expect(Math.abs(correct.x - failedGapCss * scale)).toBeLessThanOrEqual(1);
    // 而不换算的中心离它有整整一个 (scale-1) 倍，远超排除半径
    expect(Math.abs(naive.x - failedGapCss * scale)).toBeGreaterThan(radius);

    // 端到端：只用未换算的排除区，那个失败位置仍然会被选出来
    const match = await locateSliderGap(info, images, [naive]);
    if (match) {
      const matchCssX = match.x / images.imageScaleX;
      expect(Math.abs(matchCssX - failedGapCss)).toBeLessThanOrEqual(PIECE_CSS_SIZE / 2);
    }
  });
});
