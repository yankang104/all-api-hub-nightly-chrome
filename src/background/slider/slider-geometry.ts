import type {
  SliderChallengeInfo,
  SliderCrackDiagnostics,
  SliderCrackErrorCode,
  SliderRect,
} from '@/types/slider';
import type { PreparedSliderImages, SliderGapMatch } from '@/background/slider/slider-image';

export interface SliderDragPlan {
  gapX: number;
  distance: number;
  diagnostics: SliderCrackDiagnostics;
}

export type SliderDragPlanResult =
  | { ok: true; plan: SliderDragPlan }
  | { ok: false; errorCode: SliderCrackErrorCode; error: string };

function finiteRect(rect: SliderRect | undefined): rect is SliderRect {
  return !!rect
    && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    && rect.width > 0
    && rect.height > 0;
}

function visibleRatio(rect: SliderRect, viewportWidth: number, viewportHeight: number): number {
  const left = Math.max(0, rect.x);
  const top = Math.max(0, rect.y);
  const right = Math.min(viewportWidth, rect.x + rect.width);
  const bottom = Math.min(viewportHeight, rect.y + rect.height);
  const visibleArea = Math.max(0, right - left) * Math.max(0, bottom - top);
  return visibleArea / Math.max(1, rect.width * rect.height);
}

export function validateSliderGeometry(info: SliderChallengeInfo): string | null {
  if (!Number.isFinite(info.viewportWidth) || !Number.isFinite(info.viewportHeight)
    || info.viewportWidth < 100 || info.viewportHeight < 100) {
    return '页面视口尺寸无效';
  }
  if (!finiteRect(info.panelRect) || !finiteRect(info.backgroundRect)
    || !finiteRect(info.trackRect) || !finiteRect(info.handleRect)) {
    return '滑块控件包含无效几何信息';
  }
  if (info.pieceRect && !finiteRect(info.pieceRect)) return '拼图块几何信息无效';
  if (info.backgroundRect.width < 80 || info.backgroundRect.height < 40) return '滑块背景图尺寸过小';
  if (info.trackRect.width - info.handleRect.width < 20) return '滑块轨道没有足够的可拖动行程';
  if (visibleRatio(info.backgroundRect, info.viewportWidth, info.viewportHeight) < 0.96) {
    return '滑块背景图没有完整显示在当前视口';
  }
  if (visibleRatio(info.handleRect, info.viewportWidth, info.viewportHeight) < 0.98) {
    return '滑块把手没有完整显示在当前视口';
  }
  const handleCenterY = info.handleRect.y + info.handleRect.height / 2;
  if (handleCenterY < info.trackRect.y - info.handleRect.height
    || handleCenterY > info.trackRect.y + info.trackRect.height + info.handleRect.height) {
    return '滑块把手与轨道位置不一致';
  }
  return null;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function buildSliderDragPlan(
  info: SliderChallengeInfo,
  images: PreparedSliderImages,
  match: SliderGapMatch,
  correctionPx = 0,
): SliderDragPlanResult {
  const geometryError = validateSliderGeometry(info);
  if (geometryError) return { ok: false, errorCode: 'invalid-geometry', error: geometryError };
  if (!Number.isFinite(images.imageScaleX) || !Number.isFinite(images.imageScaleY)
    || images.imageScaleX <= 0 || images.imageScaleY <= 0) {
    return { ok: false, errorCode: 'invalid-geometry', error: '图片像素比例无效' };
  }
  if (!Number.isFinite(match.confidence) || match.confidence < 0.45) {
    return { ok: false, errorCode: 'match-not-found', error: '缺口匹配置信度不足' };
  }
  if (match.confidenceMargin != null && match.confidenceMargin < 0.006 && match.confidence < 0.72) {
    return { ok: false, errorCode: 'match-ambiguous', error: '缺口存在多个相近候选位置' };
  }
  /**
   * 多个方法各自锁定不同位置且分数都够高 —— 这是多缺口验证码的特征。
   *
   * 拖一个"分数最高但可能是错的"位置，代价不只是这一次失败：站点会把连续
   * 失败当作可疑行为，而 5 次机会用完之后用户才被叫来处理。如实报出歧义，
   * 让调用方立刻转人工。
   */
  if (match.rivalCount > 0 && match.confidence < 0.86) {
    return {
      ok: false,
      errorCode: 'match-ambiguous',
      error: `图上有 ${match.rivalCount + 1} 个分数接近的候选缺口，无法确定唯一目标`,
    };
  }

  /*
   * 裁剪取整丢掉的亚像素在这里补回来：截图路径 DPR≠1 时它是 1–2px 系统偏差
   * 的来源，而那正好是校准序列的量级，等于让重试去纠正一个本可算准的值。
   *
   * 方向必须是**减**：裁剪原点取的是 `Math.round(rawBackgroundX)`，而
   * `cropOffsetX = rawBackgroundX - Math.round(rawBackgroundX)`，所以裁剪图内的
   * 坐标满足 `match.x = cropOffsetX + gapCss × scaleX`。写成加号会把取整误差
   * 从「消除」变成「翻倍」，且方向恒定 —— 每次 DPR≠1 的截图路径都偏，
   * 而 `nextSliderCorrection` 对一般失败返回 0，不会再去纠这个偏。
   */
  const gapLeftCss = (match.x - images.cropOffsetX) / images.imageScaleX;
  const pieceRect = info.pieceRect;
  const templateOffsetCss = pieceRect && images.source === 'raw-image'
    ? match.templateOffsetX / Math.max(1, match.templateOriginalWidth) * pieceRect.width
    : match.templateOffsetX / images.imageScaleX;
  const initialPieceLeftCss = pieceRect
    ? pieceRect.x - info.backgroundRect.x + templateOffsetCss
      - images.cropOffsetPieceX / images.imageScaleX
    : 0;
  const pieceWidthCss = pieceRect && images.source === 'raw-image'
    ? match.templateWidth / Math.max(1, match.templateOriginalWidth) * pieceRect.width
    : match.templateWidth / images.imageScaleX;

  const imageDistance = gapLeftCss - initialPieceLeftCss;
  // 行程取页面拼图控件的完整宽度；裁剪透明边距只影响匹配原点，不能改变行程。
  // 用裁后模板宽度会虚增行程、缩短拖动距离，截图尺寸取整还会带入缩放偏差。
  // 未取得拼图 DOM 矩形时保留原有模板尺寸回退。
  const pieceRange = info.backgroundRect.width - (pieceRect?.width ?? pieceWidthCss);
  const handleRange = info.trackRect.width - info.handleRect.width;
  const availableHandleTravel = info.trackRect.x + info.trackRect.width
    - (info.handleRect.x + info.handleRect.width);

  if (pieceRange < 20 || handleRange < 20 || availableHandleTravel < 2) {
    return { ok: false, errorCode: 'invalid-geometry', error: '滑块或拼图块没有有效行程' };
  }
  if (imageDistance <= 1 || imageDistance > pieceRange + Math.max(3, pieceWidthCss * 0.15)) {
    return {
      ok: false,
      errorCode: 'distance-out-of-range',
      error: `识别出的拼图距离超出范围（${imageDistance.toFixed(1)}px）`,
    };
  }

  const rawRatio = handleRange / pieceRange;
  const conversionRatio = rawRatio >= 0.45 && rawRatio <= 1.8 ? rawRatio : 1;
  const safeCorrection = clamp(Number.isFinite(correctionPx) ? correctionPx : 0, -10, 10);
  const distance = imageDistance * conversionRatio + safeCorrection;
  if (distance < 2 || distance > availableHandleTravel) {
    return {
      ok: false,
      errorCode: 'distance-out-of-range',
      error: `换算后的把手距离超出轨道（${distance.toFixed(1)}/${availableHandleTravel.toFixed(1)}px）`,
    };
  }

  return {
    ok: true,
    plan: {
      gapX: Math.round(gapLeftCss * 10) / 10,
      // Preserve sub-pixel conversion accuracy through the final CDP release.
      // Intermediate track points may be integral, but rounding the plan here
      // reintroduced the same +/-0.5px alignment error at the destination.
      distance: Math.round(distance * 100) / 100,
      diagnostics: {
        source: images.source,
        imageScaleX: Math.round(images.imageScaleX * 1_000) / 1_000,
        imageScaleY: Math.round(images.imageScaleY * 1_000) / 1_000,
        imageDistance: Math.round(imageDistance * 10) / 10,
        handleRange: Math.round(handleRange * 10) / 10,
        pieceRange: Math.round(pieceRange * 10) / 10,
        conversionRatio: Math.round(conversionRatio * 1_000) / 1_000,
        correctionPx: safeCorrection,
        candidateCount: match.candidateCount,
        confidenceMargin: match.confidenceMargin,
        rivalCount: match.rivalCount,
        cropOffsetX: Math.round(images.cropOffsetX * 100) / 100,
      },
    },
  };
}
