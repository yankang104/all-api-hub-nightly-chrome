/**
 * 缺口定位的三条硬规则。
 *
 * 这些用例锁的是一次真实失败：hvoy.ai 的多缺口滑块连续 5 次全错，日志显示
 * 5 次算出 32.8 / 200.2 / 92.1 / 100.9 / 32.8 五个完全不同的位置，置信度
 * 却都在 0.652–0.748 —— 匹配器在多个形状之间随机选，而第 1 次已经明确失败的
 * 32.8 到第 5 次又被拖了一遍。
 *
 * 三条规则各自防一类：
 *  1. 缺口不能落在拼图块自己身上（自匹配）
 *  2. 多个位置分数都够高时不许赌（歧义）
 *  3. 已经判失败的位置不许再试（重复）
 */

import { describe, expect, it } from 'vitest';
import { locateSliderGap, type PreparedSliderImages } from '@/background/slider/slider-image';
import type { SliderChallengeInfo } from '@/types/slider';

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

/** 背景：浅色底 + 在指定 x 位置画若干个深色方块当"缺口" */
function backgroundWithGaps(width: number, height: number, gapXs: number[], gapSize: number) {
  return makeImage(width, height, (x, y) => {
    const inGap = gapXs.some((gapX) => (
      x >= gapX && x < gapX + gapSize && y >= 40 && y < 40 + gapSize
    ));
    if (inGap) return [40, 40, 40, 255];
    // 带一点纹理，避免纯色导致标准差为 0
    const noise = ((x * 7 + y * 13) % 17) * 3;
    return [180 + noise, 190 + noise, 200 + noise, 255];
  });
}

/** 拼图块：与缺口同样大小的深色方块，带一点内部纹理 */
function pieceTemplate(size: number) {
  return makeImage(size, size, (x, y) => {
    const noise = ((x * 5 + y * 11) % 13) * 4;
    return [40 + noise, 40 + noise, 40 + noise, 255];
  });
}

function infoFor(
  backgroundWidth: number,
  backgroundHeight: number,
  pieceLeft: number,
  pieceSize: number,
): SliderChallengeInfo {
  return {
    panelRect: { x: 0, y: 0, width: backgroundWidth, height: backgroundHeight + 60 },
    backgroundRect: { x: 0, y: 0, width: backgroundWidth, height: backgroundHeight },
    pieceRect: { x: pieceLeft, y: 40, width: pieceSize, height: pieceSize },
    trackRect: { x: 0, y: backgroundHeight + 20, width: backgroundWidth, height: 30 },
    handleRect: { x: 0, y: backgroundHeight + 20, width: 40, height: 30 },
    viewportWidth: 1_280,
    viewportHeight: 720,
    devicePixelRatio: 1,
    challengeKey: 'test-challenge',
  };
}

function imagesFor(
  background: ReturnType<typeof makeImage>,
  template: ReturnType<typeof makeImage>,
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
    source: 'raw-image',
    imageScaleX: 1,
    imageScaleY: 1,
    cropOffsetX: 0,
    cropOffsetPieceX: 0,
  };
}

describe('locateSliderGap 自匹配排除', () => {
  it('不把拼图块自己的位置当成缺口', async () => {
    const pieceSize = 40;
    const pieceLeft = 20;
    // 唯一的真实缺口在 x=220，远离拼图块
    const background = backgroundWithGaps(330, 190, [220], pieceSize);
    const info = infoFor(330, 190, pieceLeft, pieceSize);
    const images = imagesFor(background, pieceTemplate(pieceSize));

    const match = await locateSliderGap(info, images);

    expect(match).not.toBeNull();
    // 关键断言：命中位置必须在拼图块右侧足够远，不能落在拼图块自身范围内
    expect(match!.x).toBeGreaterThan(pieceLeft + pieceSize * 0.7);
  });

  it('拼图块已经贴在最右侧时返回 null，而不是在它自己身上找缺口', async () => {
    const pieceSize = 40;
    const background = backgroundWithGaps(330, 190, [220], pieceSize);
    // 拼图块左边缘距右边界不足一个模板宽
    const info = infoFor(330, 190, 300, pieceSize);
    const images = imagesFor(background, pieceTemplate(pieceSize));

    const match = await locateSliderGap(info, images);

    expect(match).toBeNull();
  });
});

describe('locateSliderGap 歧义报告', () => {
  it('单缺口图不报歧义', async () => {
    const pieceSize = 40;
    const background = backgroundWithGaps(330, 190, [220], pieceSize);
    const info = infoFor(330, 190, 20, pieceSize);
    const images = imagesFor(background, pieceTemplate(pieceSize));

    const match = await locateSliderGap(info, images);

    expect(match).not.toBeNull();
    expect(match!.rivalCount).toBe(0);
  });

  it('多缺口图返回 rivalCount 或直接拒绝，绝不静默选一个', async () => {
    const pieceSize = 40;
    // 三个一模一样的缺口 —— 正是 hvoy.ai 那张图的形态
    const background = backgroundWithGaps(330, 190, [120, 200, 275], pieceSize);
    const info = infoFor(330, 190, 20, pieceSize);
    const images = imagesFor(background, pieceTemplate(pieceSize));

    const match = await locateSliderGap(info, images);

    // 两种可接受的结局：拒绝（null），或命中但如实报出还有别的候选。
    // 不可接受的是"命中且 rivalCount=0" —— 那就是在赌。
    if (match) {
      expect(match.rivalCount).toBeGreaterThan(0);
    } else {
      expect(match).toBeNull();
    }
  });
});

describe('locateSliderGap 排除已失败位置', () => {
  it('排除区内的候选不再被选中', async () => {
    const pieceSize = 40;
    const background = backgroundWithGaps(330, 190, [120, 260], pieceSize);
    const info = infoFor(330, 190, 20, pieceSize);
    const images = imagesFor(background, pieceTemplate(pieceSize));

    const first = await locateSliderGap(info, images);
    expect(first).not.toBeNull();

    // 把第一次命中的位置标成已失败，再找一次
    const second = await locateSliderGap(info, images, [
      { x: first!.x, radius: pieceSize / 3 },
    ]);

    if (second) {
      expect(Math.abs(second.x - first!.x)).toBeGreaterThan(pieceSize / 3);
    } else {
      // 只有一个可用候选时全部排除后返回 null，也是正确行为
      expect(second).toBeNull();
    }
  });

  it('所有候选都被排除时返回 null，不退回已知失败的位置', async () => {
    const pieceSize = 40;
    const background = backgroundWithGaps(330, 190, [220], pieceSize);
    const info = infoFor(330, 190, 20, pieceSize);
    const images = imagesFor(background, pieceTemplate(pieceSize));

    const first = await locateSliderGap(info, images);
    expect(first).not.toBeNull();

    // 用一个覆盖整张图的排除半径
    const exhausted = await locateSliderGap(info, images, [
      { x: first!.x, radius: 400 },
    ]);

    expect(exhausted).toBeNull();
  });
});
