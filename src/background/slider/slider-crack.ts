import type {
  SliderChallengeInfo,
  SliderCrackOptions,
  SliderCrackResult,
} from '@/types/slider';
import { openTrustedDragSession, trustedPointerDrag } from '@/background/slider/trusted-pointer';
import type { FramePointerTarget } from '@/background/slider/frame-target';
import {
  decodePngBase64,
  holeSilhouetteMatch,
  isDecisiveShape,
  locateSliderGap,
  nccTemplateMatch,
  outlineProfileMatch,
  pieceLooksTextured,
  prepareSliderImages,
  type SimpleImageData,
  type TemplateDescriptor,
} from '@/background/slider/slider-image';
import { buildSliderDragPlan, validateSliderGeometry } from '@/background/slider/slider-geometry';
import { measurePieceFromProbe } from '@/background/slider/slider-probe';
import {
  buildSliderDragPoints,
  buildSliderDragTrack,
  type TrackRandom,
} from '@/background/slider/slider-track';

export { nccTemplateMatch } from '@/background/slider/slider-image';
export { buildSliderDragTrack } from '@/background/slider/slider-track';
export type {
  SliderChallengeInfo,
  SliderCrackOptions,
  SliderCrackResult,
} from '@/types/slider';

interface ActiveCrack {
  challengeKey: string;
  promise: Promise<SliderCrackResult>;
}

const activeCracks = new Map<number, ActiveCrack>();

/** 探测阶段移动多远（CSS 像素）。取碎片宽度 + 余量，保证新旧位置不重叠。 */
function probeDistanceFor(info: SliderChallengeInfo): number {
  const pieceWidth = info.pieceRect?.width ?? Math.max(30, info.handleRect.width);
  const available = info.trackRect.x + info.trackRect.width
    - (info.handleRect.x + info.handleRect.width);
  // 至少要能分开两团，但不能把把手直接推到底 —— 那样就没有后续行程了。
  return Math.max(12, Math.min(pieceWidth + 8, available * 0.42));
}

/** 生成一段平缓的探测移动路径 */
function probePath(
  startX: number,
  startY: number,
  distance: number,
  random: TrackRandom,
): Array<{ x: number; y: number; delayMs: number }> {
  const steps = 7;
  const points: Array<{ x: number; y: number; delayMs: number }> = [];
  for (let index = 1; index <= steps; index += 1) {
    const progress = index / steps;
    const eased = 1 - (1 - progress) ** 2;
    points.push({
      x: startX + distance * eased,
      y: startY + (random() - 0.5) * 1.2,
      delayMs: 16 + Math.round(random() * 14),
    });
  }
  return points;
}

/**
 * 用测出来的碎片模板在背景图里找缺口。
 *
 * 与 `locateSliderGap` 的区别：模板是**差分测出来的**，不是从 `pieceRect` 裁+
 * 推断出来的。所以这里不需要再判断「这块是碎片还是缺口」，也不需要推断 alpha。
 *
 * 搜索范围排除碎片当前所在位置 —— 否则模板会匹配到自己身上。
 */
function locateGapWithMeasuredTemplate(
  background: SimpleImageData,
  beforeBackground: SimpleImageData,
  template: SimpleImageData,
  currentPieceX: number,
  originPieceX: number,
  pieceY: number,
  /** 已失败位置，**截图裁剪像素**（调用方负责从 CSS 换算过来）。 */
  excludedX: readonly number[],
): { x: number; confidence: number; method: string } | null {
  const descriptor: TemplateDescriptor = {
    image: template,
    originalWidth: template.width,
    originalHeight: template.height,
    bounds: { x: 0, y: 0, width: template.width, height: template.height },
    // alpha 来自差分掩码，是"这些像素确实随把手一起动了"的直接证据。
    shapedAlpha: true,
  };
  const acceptable = (x: number) => (
    // 命中碎片当前位置不算 —— 碎片就在那儿。
    Math.abs(x - currentPieceX) >= template.width * 0.5
    && !excludedX.some((excluded) => Math.abs(x - excluded) < template.width / 3)
  );

  /*
   * 形状吻合优先：它同时要求形状内是平坦的缺口填充、形状外是有纹理的图像内容。
   * 多缺口图上凸起方向不同的那些缺口，形状外会落到填充色上而被压下去 ——
   * 这是唯一真正检验「碎片能不能装进去」的判据。
   */
  const silhouette = holeSilhouetteMatch(background, descriptor, 0, pieceY);
  if (silhouette && isDecisiveShape(silhouette) && acceptable(silhouette.x)) {
    return { x: silhouette.x, confidence: silhouette.confidence, method: 'measured+silhouette' };
  }

  // 缺口内部带纹理时，区域灰度统计会失效；改用四条边的法线剖面，
  // 并把当前拼图位置和上一轮失败位置一起排除，避免把移动后的拼图再次命中。
  const outlineExcluded = [
    { x: currentPieceX, radius: Math.max(6, template.width * 0.5) },
    ...excludedX.map((x) => ({ x, radius: Math.max(6, template.width / 3) })),
  ];
  const outline = outlineProfileMatch(background, descriptor, 0, pieceY, false, outlineExcluded);
  if (outline && isDecisiveShape(outline) && acceptable(outline.x)) {
    return { x: outline.x, confidence: outline.confidence, method: 'measured+outline-profile' };
  }

  // 纹理型/半透明缺口用拖动前的背景匹配，避免命中同一张截图里的碎片自己。
  // 排除旧碎片所在区，并限定同一行；纯色缺口仍由上面的形状匹配负责。
  const left = Math.max(0, Math.ceil(originPieceX + template.width));
  const tolerance = Math.max(3, Math.round(template.height * 0.12));
  const top = Math.max(0, Math.floor(pieceY - tolerance));
  const bottom = Math.min(beforeBackground.height, Math.ceil(pieceY + template.height + tolerance));
  const width = beforeBackground.width - left;
  const height = bottom - top;
  if (width < template.width || height < template.height) return null;
  const operations = (width - template.width + 1)
    * (height - template.height + 1)
    * template.width * template.height;
  if (operations <= 0 || operations > 120_000_000) return null;

  if (!pieceLooksTextured(descriptor)) return null;
  const ncc = nccTemplateMatch(cropFrom(beforeBackground, left, top, width, height), template, 0.72);
  if (!ncc || ncc.confidenceMargin == null || ncc.confidenceMargin < 0.035) return null;
  const x = ncc.x + left;
  if (excludedX.some((excluded) => Math.abs(x - excluded) < template.width / 3)) return null;
  return { x, confidence: ncc.confidence, method: 'measured+ncc' };
}

/**
 * 边拖边测的求解路径。
 *
 * 一次手势内完成：按下 → 探测移动 → 截图差分测量 → 算剩余距离 → 继续拖到位 → 释放。
 *
 * 这条路取代了「先用 DOM 矩形推断一切、再一次性拖过去」的旧做法。旧做法有三个
 * 猜测点（碎片是哪块、碎片什么形状、行程比多少），每个都可能错，而错了之后
 * 日志看着一切正常。这里三个量全部实测。
 */
async function crackByMeasuredDrag(
  tabId: number,
  info: SliderChallengeInfo,
  options: SliderCrackOptions,
  random: TrackRandom,
  frameTarget?: FramePointerTarget,
): Promise<SliderCrackResult> {
  const startX = info.handleRect.x + info.handleRect.width / 2;
  const startY = info.handleRect.y + info.handleRect.height / 2;
  const probeDistance = probeDistanceFor(info);
  const availableTravel = info.trackRect.x + info.trackRect.width
    - (info.handleRect.x + info.handleRect.width);

  const session = await openTrustedDragSession(tabId, {
    startX,
    startY,
    viewportWidth: info.viewportWidth,
    viewportHeight: info.viewportHeight,
    targetToken: info.handleToken,
    frameTarget,
  }, random);

  try {
    const pressedAt = session.current;
    const beforeShot = await decodePngBase64(await session.screenshot());
    const pixelRatio = beforeShot.width / info.viewportWidth;
    const pixelRatioY = beforeShot.height / info.viewportHeight;
    if (![pixelRatio, pixelRatioY].every((ratio) => Number.isFinite(ratio) && ratio >= 0.25 && ratio <= 8)) {
      return { solved: false, errorCode: 'image-unavailable', error: '无法建立截图与页面坐标的比例' };
    }

    await session.moveBy(probePath(pressedAt.x, pressedAt.y, probeDistance, random));
    // 等待滑块动画和合成层追上指针；立即截图经常只得到半帧，差分会被切成
    // 多个小团，导致本来可测的探测被误判为失败。
    await new Promise<void>((resolve) => setTimeout(resolve, 110));
    const probedAt = session.current;
    const afterShot = await decodePngBase64(await session.screenshot());

    const probed = measurePieceFromProbe({
      before: beforeShot,
      after: afterShot,
      handleDeltaCss: probedAt.x - pressedAt.x,
      pixelRatio,
      backgroundRect: {
        x: info.backgroundRect.x * pixelRatio,
        y: info.backgroundRect.y * pixelRatioY,
        width: info.backgroundRect.width * pixelRatio,
        height: info.backgroundRect.height * pixelRatioY,
      },
    });
    if (!probed.ok) {
      return { solved: false, errorCode: 'match-not-found', error: `拖拽探测失败：${probed.reason}` };
    }

    const measurement = probed.measurement;
    // 背景图在截图里的裁剪区域，用于把缺口位置换算回 CSS。
    const backgroundLeft = info.backgroundRect.x * pixelRatio;
    const backgroundTop = info.backgroundRect.y * pixelRatioY;
    const cropOffsetX = backgroundLeft - Math.round(backgroundLeft);
    const backgroundCrop = cropFrom(
      afterShot,
      Math.round(backgroundLeft),
      Math.round(backgroundTop),
      Math.round(info.backgroundRect.width * pixelRatio),
      Math.round(info.backgroundRect.height * pixelRatioY),
    );

    const beforeBackground = cropFrom(
      beforeShot,
      Math.round(backgroundLeft),
      Math.round(backgroundTop),
      backgroundCrop.width,
      backgroundCrop.height,
    );

    // CSS 坐标换到裁剪像素时包含裁剪原点的小数偏移；回报时做严格逆变换。
    const excludedInCrop = (options.excludedGapX ?? [])
      .filter((x) => Number.isFinite(x))
      .map((cssX) => cssX * pixelRatio + cropOffsetX);

    const gap = locateGapWithMeasuredTemplate(
      backgroundCrop,
      beforeBackground,
      measurement.template,
      measurement.pieceX - Math.round(backgroundLeft),
      measurement.originX - Math.round(backgroundLeft),
      measurement.pieceY - Math.round(backgroundTop),
      excludedInCrop,
    );
    if (!gap) {
      return {
        solved: false,
        errorCode: 'match-not-found',
        error: '用实测碎片模板仍未在背景图中找到匹配的缺口',
      };
    }

    // 剩余碎片位移（截图像素）→ 剩余把手位移（CSS 像素）
    const pieceLeftInCrop = measurement.pieceX - Math.round(backgroundLeft);
    const remainingPiecePixels = gap.x - pieceLeftInCrop;
    const correction = Number.isFinite(options.correctionPx ?? 0) ? (options.correctionPx ?? 0) : 0;
    const remainingHandleCss = remainingPiecePixels / (measurement.measuredRatio * pixelRatio)
      + correction;
    const totalHandleCss = (probedAt.x - pressedAt.x) + remainingHandleCss;

    const diagnostics = {
      source: 'viewport-screenshot' as const,
      imageScaleX: Math.round(pixelRatio * 1_000) / 1_000,
      imageScaleY: Math.round(pixelRatioY * 1_000) / 1_000,
      imageDistance: Math.round(remainingPiecePixels / pixelRatio * 10) / 10,
      handleRange: Math.round((info.trackRect.width - info.handleRect.width) * 10) / 10,
      pieceRange: Math.round(info.backgroundRect.width * 10) / 10,
      conversionRatio: Math.round(measurement.measuredRatio * 1_000) / 1_000,
      correctionPx: correction,
      candidateCount: 1,
      probeDistance: Math.round(probeDistance * 10) / 10,
      measuredRatio: Math.round(measurement.measuredRatio * 1_000) / 1_000,
      cropOffsetX: Math.round(cropOffsetX * 100) / 100,
    };

    if (remainingHandleCss < -2 || totalHandleCss > availableTravel + 2) {
      return {
        solved: false,
        errorCode: 'distance-out-of-range',
        error: `实测剩余距离 ${remainingHandleCss.toFixed(1)}px 超出轨道可用行程`
          + `（已移动 ${(probedAt.x - pressedAt.x).toFixed(1)}/${availableTravel.toFixed(1)}px）`,
        method: gap.method,
        confidence: gap.confidence,
        diagnostics,
      };
    }

    // 继续拖完剩余距离：单调逼近，不冲过再退回。
    if (remainingHandleCss > 0.5) {
      const track = buildSliderDragTrack(remainingHandleCss, random, availableTravel - (probedAt.x - pressedAt.x));
      await session.moveBy(buildSliderDragPoints(
        probedAt.x,
        probedAt.y,
        track,
        info.viewportWidth,
        info.viewportHeight,
        random,
      ));
    }

    await session.release();
    return {
      solved: true,
      gapX: Math.round((gap.x - cropOffsetX) / pixelRatio * 10) / 10,
      distance: Math.round(totalHandleCss * 100) / 100,
      method: gap.method,
      confidence: gap.confidence,
      diagnostics,
    };
  } finally {
    // 无论如何都要松手：按住不放会让页面永久停在拖拽态。
    await session.release().catch(() => {});
  }
}

function cropFrom(
  source: SimpleImageData,
  x: number,
  y: number,
  width: number,
  height: number,
): SimpleImageData {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const result: SimpleImageData = {
    width: safeWidth,
    height: safeHeight,
    data: new Uint8ClampedArray(safeWidth * safeHeight * 4),
  };
  for (let row = 0; row < safeHeight; row += 1) {
    const fromY = y + row;
    if (fromY < 0 || fromY >= source.height) continue;
    for (let column = 0; column < safeWidth; column += 1) {
      const fromX = x + column;
      if (fromX < 0 || fromX >= source.width) continue;
      const from = (fromY * source.width + fromX) * 4;
      const to = (row * safeWidth + column) * 4;
      result.data[to] = source.data[from]!;
      result.data[to + 1] = source.data[from + 1]!;
      result.data[to + 2] = source.data[from + 2]!;
      result.data[to + 3] = source.data[from + 3]!;
    }
  }
  return result;
}

async function executeSliderCrack(
  tabId: number,
  info: SliderChallengeInfo,
  options: SliderCrackOptions,
  random: TrackRandom,
  frameTarget?: FramePointerTarget,
): Promise<SliderCrackResult> {
  const geometryError = validateSliderGeometry(info);
  if (geometryError) {
    return {
      solved: false,
      errorCode: 'invalid-geometry',
      error: geometryError,
    };
  }

  // 首轮有完整图片源时先静态识别，不为取模板额外消耗一次真实拖动。
  // 后续保留交替路径；一次请求仍最多拖一次，松手后必须重新采集挑战。
  const hasRawImages = info.backgroundSource != null
    && (info.pieceSource != null || info.referenceBackgroundSource != null);
  const useMeasuredDrag = hasRawImages ? options.attempt % 2 === 0 : options.attempt % 2 === 1;
  if (useMeasuredDrag) {
    return crackByMeasuredDrag(tabId, info, options, random, frameTarget)
      .catch((error): SliderCrackResult => ({
        solved: false,
        errorCode: 'drag-failed',
        error: error instanceof Error ? error.message : String(error),
      }));
  }

  let images;
  try {
    images = await prepareSliderImages(tabId, info);
  } catch (error) {
    return {
      solved: false,
      errorCode: 'image-unavailable',
      error: error instanceof Error ? error.message : String(error),
    };
  }

  // 已失败位置的排除半径取模板宽度的三分之一：足以覆盖同一个缺口的重复命中，
  // 又不会把相邻的另一个真实缺口一起排掉。
  /*
   * 先确认这块"拼图块"真的是拼图块。
   *
   * 多缺口图上 DOM 评分可能把某个**缺口**当成拼图块（都是同样大小的方块、
   * 都叠在背景图上）。认错之后起点就是错的，算出来的距离必然偏，而日志看着
   * 一切正常 —— 这是最难排查的一类失败。拼图块带真实图像内容（方差高），
   * 缺口是纯色填充（方差极低），据此判别。
   */
  if (images.source === 'viewport-screenshot'
    && images.template && !pieceLooksTextured(images.template)) {
    return {
      solved: false,
      errorCode: 'invalid-geometry',
      error: '页面上识别出的「拼图块」是纯色填充，更像缺口本身，无法确定拖动起点',
    };
  }

  /*
   * `excludedGapX` 是背景图左边缘起算的 **CSS 像素**（生产方攒的是上一轮的
   * `result.gapX`），而 `locateSliderGap` 的候选 `candidate.x` 是**背景图像素**。
   * 必须换算到同一坐标系再比 —— 直接比的话 `imageScaleX ≠ 1`（HiDPI、Windows
   * 125%/150% 缩放、站点按 2x 出图）时排除区整体错位：真正失败的缺口没被排掉，
   * 反倒可能排掉一个有效候选。换算规则与 `buildSliderDragPlan` 里
   * `gapLeftCss = (match.x - cropOffsetX) / imageScaleX` 严格互逆。
   */
  const excluded = (options.excludedGapX ?? [])
    .filter((x) => Number.isFinite(x))
    .map((cssX) => ({
      x: cssX * images.imageScaleX + images.cropOffsetX,
      radius: Math.max(6, (images.template?.image.width ?? 40) / 3),
    }));
  const match = await locateSliderGap(info, images, excluded);
  if (!match) {
    return {
      solved: false,
      errorCode: 'match-not-found',
      error: excluded.length
        ? `排除 ${excluded.length} 个已失败位置后，没有找到置信度足够且唯一的滑块缺口`
        : '没有找到置信度足够且唯一的滑块缺口',
    };
  }

  const planResult = buildSliderDragPlan(info, images, match, options.correctionPx);
  if (!planResult.ok) {
    return {
      solved: false,
      errorCode: planResult.errorCode,
      error: planResult.error,
      method: match.method,
      confidence: match.confidence,
    };
  }

  const { plan } = planResult;
  const remainingTrack = info.trackRect.x + info.trackRect.width
    - (info.handleRect.x + info.handleRect.width);
  const track = buildSliderDragTrack(plan.distance, random, Math.max(plan.distance, remainingTrack - 1));
  const startX = info.handleRect.x + info.handleRect.width / 2;
  const startY = info.handleRect.y + info.handleRect.height / 2;
  const points = buildSliderDragPoints(
    startX,
    startY,
    track,
    info.viewportWidth,
    info.viewportHeight,
    random,
  );

  try {
    await trustedPointerDrag(tabId, {
      startX,
      startY,
      points,
      viewportWidth: info.viewportWidth,
      viewportHeight: info.viewportHeight,
      targetToken: info.handleToken,
      frameTarget,
    }, random);
  } catch (error) {
    return {
      solved: false,
      errorCode: 'drag-failed',
      error: error instanceof Error ? error.message : String(error),
      gapX: plan.gapX,
      distance: plan.distance,
      method: match.method,
      confidence: match.confidence,
      diagnostics: plan.diagnostics,
    };
  }

  return {
    solved: true,
    gapX: plan.gapX,
    distance: plan.distance,
    method: `${images.source}:${match.method}`,
    confidence: match.confidence,
    diagnostics: plan.diagnostics,
  };
}

/**
 * Orchestrate one visual solve attempt. DOM-side feedback decides whether the
 * dispatched drag was accepted and whether a fresh challenge should retry.
 */
export function crackSliderChallenge(
  tabId: number,
  info: SliderChallengeInfo,
  optionsOrRandom: SliderCrackOptions | TrackRandom = { attempt: 1 },
  randomSource: TrackRandom = Math.random,
  frameTarget?: FramePointerTarget,
): Promise<SliderCrackResult> {
  const options = typeof optionsOrRandom === 'function'
    ? { attempt: 1 }
    : optionsOrRandom;
  const random = typeof optionsOrRandom === 'function' ? optionsOrRandom : randomSource;
  const active = activeCracks.get(tabId);
  if (active) {
    if (active.challengeKey === info.challengeKey) return active.promise;
    return Promise.resolve({
      solved: false,
      errorCode: 'busy',
      error: '当前标签页已有滑块识别任务在执行',
    });
  }

  const promise = executeSliderCrack(tabId, info, options, random, frameTarget)
    .finally(() => {
      const current = activeCracks.get(tabId);
      if (current?.promise === promise) activeCracks.delete(tabId);
    });
  activeCracks.set(tabId, { challengeKey: info.challengeKey, promise });
  return promise;
}
