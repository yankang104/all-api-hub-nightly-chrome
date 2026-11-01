import type {
  SliderChallengeInfo,
  SliderImageSource,
  SliderRect,
} from '@/types/slider';
import { TENCENT_SLIDER_SELECTORS } from '@/automation/slider/slider-frame-dom';

export const SLIDER_WIDGET_SELECTORS = [
  '.geetest_panel',
  '.geetest_holder',
  '.geetest_slider_button',
  '.gt_holder',
  '.gt_widget',
  '.gt_slider_knob',
  '.slide-verify',
  '.slider-captcha',
  '.captcha-slider',
  '.verify-slider',
  '.jigsaw-slider',
  '.drag-captcha',
  '.yidun_slider',
  '.yidun_panel',
  '.nc-container',
  '.nc_iconfont.btn_slide',
  '[class*="captcha" i][class*="slider" i]',
  '[id*="captcha" i][id*="slider" i]',
  '[class*="verify" i][class*="slider" i]',
  '[class*="slider" i][class*="verify" i]',
  '[class*="jigsaw" i][class*="slider" i]',
  '[class*="slide-verify" i]',
].join(', ');

export const SLIDER_SUCCESS_SELECTORS = [
  '.geetest_success',
  '.gt_info_success',
  '.gt_success',
  '.yidun_success',
  '[class*="captcha" i][data-state="verified" i]',
  '[class*="captcha" i][data-status="success" i]',
  '[class*="slider" i][data-state="verified" i]',
  '[class*="slider" i][data-status="success" i]',
  '[class*="verify" i][data-state="success" i]',
].join(', ');

const HANDLE_SELECTORS = [
  '[role="slider"]',
  '[draggable="true"]',
  '.geetest_slider_button',
  '.gt_slider_knob',
  '.nc_iconfont.btn_slide',
  '[class*="slider" i][class*="btn" i]',
  '[class*="slider" i][class*="button" i]',
  '[class*="slider" i][class*="handle" i]',
  '[class*="slider" i][class*="knob" i]',
  '[class*="slide" i][class*="btn" i]',
  '[class*="drag" i][class*="btn" i]',
  '[class*="drag" i][class*="button" i]',
  '[class*="move" i][class*="btn" i]',
].join(', ');

const MEDIA_SELECTORS = 'img, canvas, [class], [id]';
const CHALLENGE_WORDS = /captcha|challenge|verify|verification|puzzle|jigsaw|geetest|yidun|human|robot|验证码|验证|拼图|人机|安全校验/i;
const SLIDE_WORDS = /slider|slide|drag|swipe|move|track|rail|thumb|knob|handle|滑块|滑动|拖动|向右滑/i;
const HANDLE_WORDS = /(?:slider|slide|drag|move)[-_\s]*(?:btn|button|handle|knob|thumb)|(?:btn|button|handle|knob|thumb)[-_\s]*(?:slider|slide|drag|move)|滑块|拖动|滑动/i;
const NON_CHALLENGE_SLIDER_WORDS = /carousel|swiper|gallery|volume|seek|range|price|filter|toggle|switch|轮播|音量|价格|筛选/i;
const BACKGROUND_WORDS = /background|(?:^|[-_\s])bg(?:$|[-_\s])|canvas|content|image|(?:^|[-_\s])img(?:$|[-_\s])/i;
const PIECE_WORDS = /piece|slice|template|block|puzzle|jigsaw|move[-_\s]*img|slider[-_\s]*img|拼图|缺块/i;
const TRACK_WORDS = /track|rail|bar|slider[-_\s]*move|slide[-_\s]*track|drag[-_\s]*track|滑轨|拖动条/i;
const PROMPT_WORDS = /drag|slide|swipe|move|complete.{0,12}(?:puzzle|verification)|拖动|滑动|按住|完成拼图|向右滑/i;
const GEOMETRY_PANEL_SELECTORS = [
  SLIDER_WIDGET_SELECTORS,
  '[role="dialog"]',
  '[aria-modal="true"]',
  '[class*="captcha" i]',
  '[id*="captcha" i]',
  '[class*="verify" i]',
  '[id*="verify" i]',
  'img',
  'canvas',
  '[style*="background" i]',
].join(', ');
const NON_HANDLE_WORDS = /refresh|reload|close|cancel|reset|help|(?:^|[-_\s])info(?:$|[-_\s])|刷新|换一张|关闭|取消|帮助|说明/i;
const MAX_SCAN_ELEMENTS = 1_200;
const MAX_INLINE_IMAGE_LENGTH = 8 * 1024 * 1024;
const POINTER_MARKER = 'data-aah-pointer-target';

/** 腾讯控件定位可用于主页面；只有真实 iframe 才启用专用裁剪和取图策略。 */
export type SliderDomMode = 'page' | 'tencent-page' | 'tencent-frame';

/**
 * One DOM pass touches the same nodes from several scorers. Keep these values
 * only for the duration of that pass: a persistent cache would make a refreshed
 * challenge look stale, while no cache makes canvas.toDataURL run repeatedly.
 */
interface DomScanCache {
  mode: SliderDomMode;
  semantic: WeakMap<Element, string>;
  visibility: WeakMap<Element, boolean>;
  imageSource: WeakMap<Element, SliderImageSource | undefined>;
  geometryPanels?: Element[];
}

let activeDomScanCache: DomScanCache | undefined;

function createDomScanCache(mode: SliderDomMode): DomScanCache {
  return {
    mode,
    semantic: new WeakMap(),
    visibility: new WeakMap(),
    imageSource: new WeakMap(),
  };
}

function withDomScanCache<T>(callback: () => T, mode: SliderDomMode = 'page'): T {
  const previous = activeDomScanCache;
  if (!previous || previous.mode !== mode) activeDomScanCache = createDomScanCache(mode);
  try {
    return callback();
  } finally {
    activeDomScanCache = previous;
  }
}

function usesTencentSelectors(): boolean {
  return activeDomScanCache?.mode === 'tencent-page' || activeDomScanCache?.mode === 'tencent-frame';
}

function widgetSelectors(): string {
  return usesTencentSelectors() ? `${TENCENT_SLIDER_SELECTORS.widgets}, ${SLIDER_WIDGET_SELECTORS}` : SLIDER_WIDGET_SELECTORS;
}

function successSelectors(): string {
  return usesTencentSelectors() ? `${TENCENT_SLIDER_SELECTORS.success}, ${SLIDER_SUCCESS_SELECTORS}` : SLIDER_SUCCESS_SELECTORS;
}

function handleSelectors(): string {
  return usesTencentSelectors() ? `${TENCENT_SLIDER_SELECTORS.handle}, ${HANDLE_SELECTORS}` : HANDLE_SELECTORS;
}

function hasTrackWords(text: string): boolean {
  return TRACK_WORDS.test(text) || (usesTencentSelectors() && /groove/i.test(text));
}

export interface SliderDomMatch {
  panel: Element;
  background: Element;
  piece?: Element;
  track: Element;
  handle: HTMLElement;
  detectionMethod?: 'panel-geometry';
}

export interface CollectedSliderChallenge {
  info: SliderChallengeInfo;
  match: SliderDomMatch;
  releaseHandleMarker: () => void;
}

export interface SliderDomState {
  visible: boolean;
  success: boolean;
  /** 保留本轮面板，重绘移除把手后仍能读取同一面板的结果提示。 */
  panel?: Element;
  challengeKey?: string;
  handleX?: number;
  pieceX?: number;
  statusText: string;
  /**
   * 把手左边缘相对轨道左边缘的偏移（CSS px）。
   *
   * 仅作等待结束后的辅助判据；成功收尾时也可能复位，不能立即判为失败。
   */
  handleOffsetX?: number;
  /** 轨道可用行程；判断回弹时需要它作为比例基准。 */
  handleRange?: number;
}

function queryAll(selectors: string, root: ParentNode = document): Element[] {
  try {
    return [...root.querySelectorAll(selectors)];
  } catch {
    return [];
  }
}

export function isVisibleSliderElement(element: Element): boolean {
  const cache = activeDomScanCache;
  if (cache?.visibility.has(element)) return cache.visibility.get(element)!;

  let visible = false;
  if (!element.isConnected || element.getClientRects().length === 0) return false;
  let current: Element | null = element;
  while (current) {
    const style = window.getComputedStyle(current);
    if (
      style.display === 'none'
      || style.visibility === 'hidden'
      || style.visibility === 'collapse'
      || Number.parseFloat(style.opacity || '1') <= 0.02
      || (current instanceof HTMLElement && current.hidden)
    ) {
      if (cache) cache.visibility.set(element, false);
      return false;
    }
    current = current.parentElement;
  }
  const rect = element.getBoundingClientRect();
  visible = rect.width >= 2 && rect.height >= 2;
  if (cache) cache.visibility.set(element, visible);
  return visible;
}

function rectOf(element: Element): DOMRect {
  return element.getBoundingClientRect();
}

function toRect(rect: DOMRect | SliderRect): SliderRect {
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    x: round(rect.x),
    y: round(rect.y),
    width: round(rect.width),
    height: round(rect.height),
  };
}

function semanticText(element: Element): string {
  const cache = activeDomScanCache;
  if (cache?.semantic.has(element)) return cache.semantic.get(element)!;
  const attributes = [
    element.id,
    element.className,
    element.getAttribute('role'),
    element.getAttribute('aria-label'),
    element.getAttribute('title'),
    element.getAttribute('name'),
    element.getAttribute('data-type'),
    element.getAttribute('data-captcha-type'),
    element.getAttribute('data-state'),
    element.getAttribute('data-status'),
  ];
  const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 180);
  const result = `${attributes.filter(Boolean).join(' ')} ${text}`.toLowerCase();
  cache?.semantic.set(element, result);
  return result;
}

function ancestorText(element: Element, levels = 5): string {
  const parts: string[] = [];
  let current: Element | null = element;
  for (let level = 0; current && level < levels; level += 1) {
    parts.push(semanticText(current));
    current = current.parentElement;
  }
  return parts.join(' ');
}

function hasChallengeContext(element: Element): boolean {
  const context = ancestorText(element, 7);
  return CHALLENGE_WORDS.test(context) && (SLIDE_WORDS.test(context) || PROMPT_WORDS.test(context));
}

function scoredElements<T extends Element>(
  elements: Iterable<T>,
  scorer: (element: T) => number,
): Array<{ element: T; score: number }> {
  return [...elements]
    .map((element) => ({ element, score: scorer(element) }))
    .filter((item) => Number.isFinite(item.score))
    .sort((left, right) => right.score - left.score);
}

function scoreHandle(element: Element): number {
  if (!(element instanceof HTMLElement) || !isVisibleSliderElement(element)) return -Infinity;
  const rect = rectOf(element);
  if (rect.width < 12 || rect.height < 12 || rect.width > 180 || rect.height > 110) return -Infinity;
  if (usesTencentSelectors()) {
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    if (cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight) {
      const hit = document.elementFromPoint(cx, cy);
      if (!hit || !(hit === element || element.contains(hit))) return -Infinity;
    }
  }

  const own = semanticText(element);
  const context = ancestorText(element, 7);
  let score = 0;
  if (usesTencentSelectors() && element.matches(TENCENT_SLIDER_SELECTORS.handle)) score += 12;
  if (element.getAttribute('role')?.toLowerCase() === 'slider') score += 8;
  if (HANDLE_WORDS.test(own)) score += 9;
  else if (SLIDE_WORDS.test(own)) score += 4;
  if (CHALLENGE_WORDS.test(context)) score += 7;
  if (PROMPT_WORDS.test(context)) score += 4;
  if (SLIDE_WORDS.test(context)) score += 2;
  if (NON_CHALLENGE_SLIDER_WORDS.test(context) && !CHALLENGE_WORDS.test(context)) score -= 14;
  if (element instanceof HTMLInputElement && element.type === 'range' && !CHALLENGE_WORDS.test(context)) score -= 12;
  if (rect.width <= 100 && rect.height <= 80) score += 2;
  const cursor = window.getComputedStyle(element).cursor;
  if (cursor === 'grab' || cursor === 'grabbing' || cursor === 'pointer' || cursor === 'move') score += 2;
  return score;
}

function collectHandleCandidates(): HTMLElement[] {
  const direct = queryAll(handleSelectors());
  const semantic = queryAll('button, [role], [draggable], [class], [id]')
    .slice(0, MAX_SCAN_ELEMENTS)
    .filter((element) => HANDLE_WORDS.test(semanticText(element)));
  return [...new Set([...direct, ...semantic])]
    .filter((element): element is HTMLElement => element instanceof HTMLElement)
    .map((element) => ({ element, score: scoreHandle(element) }))
    .filter((item) => Number.isFinite(item.score))
    .sort((left, right) => right.score - left.score)
    .map((item) => item.element);
}

function scorePanel(element: Element, handle: Element): number {
  if (!isVisibleSliderElement(element) || !element.contains(handle)) return -Infinity;
  const rect = rectOf(element);
  const handleRect = rectOf(handle);
  if (rect.width < handleRect.width * 2 || rect.height < handleRect.height * 1.6) return -Infinity;

  const own = semanticText(element);
  let score = 0;
  if (CHALLENGE_WORDS.test(own)) score += 8;
  if (SLIDE_WORDS.test(own)) score += 5;
  if (PROMPT_WORDS.test(own)) score += 4;
  if (queryAll('img, canvas', element).some(isVisibleSliderElement)) score += 5;
  if (rect.width >= 160 && rect.width <= 720) score += 3;
  if (rect.height >= 110 && rect.height <= 720) score += 3;
  if (rect.width >= window.innerWidth * 0.96 && rect.height >= window.innerHeight * 0.9) score -= 3;
  score -= Math.log10(Math.max(10, rect.width * rect.height));
  return score;
}

function findPanel(handle: HTMLElement): Element | null {
  const candidates: Element[] = [];
  let current = handle.parentElement;
  for (let level = 0; current && current !== document.body && level < 12; level += 1) {
    candidates.push(current);
    current = current.parentElement;
  }
  const best = scoredElements(candidates, (element) => scorePanel(element, handle))[0];
  return best && best.score >= 3 ? best.element : null;
}

function verticalOverlap(left: DOMRect, right: DOMRect): number {
  return Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
}

function scoreTrack(element: Element, panel: Element, handle: HTMLElement): number {
  if (!isVisibleSliderElement(element) || !panel.contains(element)) return -Infinity;
  const rect = rectOf(element);
  const handleRect = rectOf(handle);
  if (rect.width < handleRect.width * 1.8 || rect.height > Math.max(100, handleRect.height * 3)) return -Infinity;
  if (verticalOverlap(rect, handleRect) < Math.min(handleRect.height, rect.height) * 0.25) return -Infinity;

  const own = semanticText(element);
  let score = 0;
  if (hasTrackWords(own)) score += 9;
  else if (SLIDE_WORDS.test(own)) score += 4;
  if (element.contains(handle)) score += 5;
  if (rect.width >= handleRect.width * 3) score += 3;
  if (rect.height <= handleRect.height * 1.5) score += 3;
  score += Math.min(4, rect.width / Math.max(1, handleRect.width * 3));
  return score;
}

function findTrack(panel: Element, handle: HTMLElement): Element | null {
  const descendants = queryAll('[role="slider"], input[type="range"], [class], [id]', panel)
    .slice(0, MAX_SCAN_ELEMENTS);
  const ancestors: Element[] = [];
  let current = handle.parentElement;
  while (current && current !== panel.parentElement) {
    ancestors.push(current);
    if (current === panel) break;
    current = current.parentElement;
  }
  const best = scoredElements(
    new Set([...descendants, ...ancestors]),
    (element) => scoreTrack(element, panel, handle),
  )[0];
  return best && best.score >= 4 ? best.element : null;
}

function cssImageUrl(element: Element): string | null {
  const value = window.getComputedStyle(element).backgroundImage;
  if (!value || value === 'none') return null;
  const match = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/i.exec(value);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim() || null;
}

function normalizeImageUrl(value: string): SliderImageSource | undefined {
  if (value.startsWith('data:image/')) {
    if (value.length > MAX_INLINE_IMAGE_LENGTH) return undefined;
    return { value, kind: 'data-url' };
  }
  try {
    const url = new URL(value, document.baseURI);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return { value: url.href, kind: 'url' };
  } catch {
    return undefined;
  }
}

export function imageSourceOf(element: Element): SliderImageSource | undefined {
  const cache = activeDomScanCache;
  if (cache?.imageSource.has(element)) return cache.imageSource.get(element);

  let result: SliderImageSource | undefined;
  if (element instanceof HTMLCanvasElement) {
    if (element.width >= 2 && element.height >= 2) {
      try {
        result = normalizeImageUrl(element.toDataURL('image/png'));
      } catch {
        result = undefined;
      }
    }
  } else if (element instanceof HTMLImageElement) {
    const source = element.currentSrc || element.src;
    if (source) result = normalizeImageUrl(source);
  } else {
    const background = cssImageUrl(element);
    if (background) result = normalizeImageUrl(background);
  }
  cache?.imageSource.set(element, result);
  return result;
}

function scoreBackground(element: Element, panel: Element, track: Element, handle: HTMLElement): number {
  if (!isVisibleSliderElement(element) || !panel.contains(element) || element === handle) return -Infinity;
  const rect = rectOf(element);
  const trackRect = rectOf(track);
  if (rect.width < Math.max(110, rectOf(handle).width * 1.8) || rect.height < 45) return -Infinity;
  if (rect.width / Math.max(1, rect.height) < 1.1) return -Infinity;
  if (rect.top > trackRect.bottom + 20) return -Infinity;

  const own = semanticText(element);
  let score = 0;
  // 裁剪素材的特殊评分仅在腾讯 iframe 内启用。
  if (activeDomScanCache?.mode === 'tencent-frame') {
    if (element.matches(TENCENT_SLIDER_SELECTORS.background)) score += 12;
    else if (element.matches(TENCENT_SLIDER_SELECTORS.backgroundImage)) score += 9;
  }
  if (element instanceof HTMLImageElement || element instanceof HTMLCanvasElement) score += 5;
  if (imageSourceOf(element)) score += 5;
  if (BACKGROUND_WORDS.test(own)) score += 5;
  if (PIECE_WORDS.test(own)) score -= 8;
  if (/logo|icon|avatar|btn|button|thumb/i.test(own)) score -= 9;
  if (rect.bottom <= trackRect.top + 25) score += 4;
  score += Math.min(5, (rect.width * rect.height) / 20_000);
  return score;
}

function findBackground(panel: Element, track: Element, handle: HTMLElement): Element | null {
  const best = scoredElements(
    queryAll(MEDIA_SELECTORS, panel).slice(0, MAX_SCAN_ELEMENTS),
    (element) => scoreBackground(element, panel, track, handle),
  )[0];
  return best && best.score >= 6 ? best.element : null;
}

function findReferenceBackground(panel: Element, background: Element): Element | undefined {
  const primarySource = imageSourceOf(background)?.value;
  const primaryRect = rectOf(background);
  const candidates = queryAll('img, canvas, [class], [id]', panel)
    .slice(0, MAX_SCAN_ELEMENTS)
    .filter((element) => element !== background)
    .map((element) => {
      const source = imageSourceOf(element);
      if (!source || source.value === primarySource) return null;
      const own = semanticText(element);
      if (!BACKGROUND_WORDS.test(own) || PIECE_WORDS.test(own) || /logo|icon|btn|button/i.test(own)) return null;
      const rect = rectOf(element);
      const width = rect.width || (element instanceof HTMLCanvasElement ? element.width : 0)
        || (element instanceof HTMLImageElement ? element.naturalWidth : 0);
      const height = rect.height || (element instanceof HTMLCanvasElement ? element.height : 0)
        || (element instanceof HTMLImageElement ? element.naturalHeight : 0);
      if (width < 80 || height < 40) return null;
      const aspect = width / height;
      const primaryAspect = primaryRect.width / Math.max(1, primaryRect.height);
      const aspectError = Math.abs(Math.log(aspect / primaryAspect));
      if (aspectError > 0.1) return null;
      let score = 8 - aspectError * 20;
      if (element instanceof HTMLCanvasElement || element instanceof HTMLImageElement) score += 3;
      if (/full|original|complete|完整|原图/i.test(own)) score += 2;
      return { element, score };
    })
    .filter((item): item is { element: Element; score: number } => item != null)
    .sort((left, right) => right.score - left.score);
  return candidates[0]?.element;
}

function overlaps(left: DOMRect, right: DOMRect): boolean {
  return left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
}

function scorePiece(element: Element, panel: Element, background: Element, handle: HTMLElement): number {
  if (!isVisibleSliderElement(element) || !panel.contains(element) || element === background || element === handle) return -Infinity;
  const rect = rectOf(element);
  const backgroundRect = rectOf(background);
  if (!overlaps(rect, backgroundRect)) return -Infinity;
  if (rect.width < 8 || rect.height < 8 || rect.width > backgroundRect.width * 1.08 || rect.height > backgroundRect.height * 1.15) {
    return -Infinity;
  }

  // A real puzzle piece can be rectangular, but an extreme strip is usually
  // a decorative/status element that happens to overlap the image. Keep the
  // bound intentionally broad so non-square pieces remain valid candidates.
  const pieceAspect = rect.width / Math.max(1, rect.height);
  if (pieceAspect > 2.5 || pieceAspect < 0.4) return -Infinity;

  // Reject a candidate that is both much thinner than the drag handle and
  // longer than it. This catches transient banner-like elements without
  // requiring puzzle pieces to match the handle or to be square.
  const handleRect = rectOf(handle);
  const pieceShortSide = Math.min(rect.width, rect.height);
  const pieceLongSide = Math.max(rect.width, rect.height);
  const handleShortSide = Math.min(handleRect.width, handleRect.height);
  if (
    handleShortSide >= 8
    && pieceShortSide < handleShortSide * 0.55
    && pieceLongSide > handleShortSide * 1.25
  ) {
    return -Infinity;
  }

  const own = semanticText(element);
  let score = 0;
  if (PIECE_WORDS.test(own)) score += 11;
  if (imageSourceOf(element)) score += 5;
  if (element instanceof HTMLImageElement || element instanceof HTMLCanvasElement) score += 2;
  if (BACKGROUND_WORDS.test(own) && !PIECE_WORDS.test(own)) score -= 6;
  if (/logo|icon|avatar|btn|button|track|rail/i.test(own)) score -= 10;
  const widthRatio = rect.width / Math.max(1, backgroundRect.width);
  if (widthRatio >= 0.08 && widthRatio <= 0.55) score += 5;
  else if (widthRatio > 0.9) score -= 3;
  return score;
}

function findPiece(panel: Element, background: Element, handle: HTMLElement): Element | undefined {
  if (usesTencentSelectors() && handle.matches(TENCENT_SLIDER_SELECTORS.handle)) {
    const foregrounds = queryAll(TENCENT_SLIDER_SELECTORS.piece, panel).filter(isVisibleSliderElement);
    // fg-item 也用于多物体挑战，不能任取一块当拼图；不唯一时交给截图差分。
    return foregrounds.length === 1 && scorePiece(foregrounds[0]!, panel, background, handle) >= 5
      ? foregrounds[0] : undefined;
  }
  const first = scoredElements(
    queryAll(MEDIA_SELECTORS, panel).slice(0, MAX_SCAN_ELEMENTS),
    (element) => scorePiece(element, panel, background, handle),
  )[0];
  return first && first.score >= 5 ? first.element : undefined;
}

/**
 * 签到可能新建一套没有标准滑块类名的组件。只在尺寸受限、带可见拼图/验证
 * 拖动提示的局部面板里兜底，不能借用整页文字把普通横条当成验证码。
 * 缓存只活在一次同步扫描里；登录、签到、换题之间必须重新找当前面板。
 */
function findGeometrySliderPanels(): Element[] {
  if (activeDomScanCache?.geometryPanels) return activeDomScanCache.geometryPanels;
  const panels = new Set<Element>();
  const visited = new Set<Element>();
  const seeds = queryAll(usesTencentSelectors()
    ? `${TENCENT_SLIDER_SELECTORS.widgets}, ${GEOMETRY_PANEL_SELECTORS}` : GEOMETRY_PANEL_SELECTORS)
    .filter(isVisibleSliderElement)
    .slice(0, MAX_SCAN_ELEMENTS);

  for (const seed of seeds) {
    let panel: Element | null = seed;
    for (let level = 0; panel && level < 8; level += 1, panel = panel.parentElement) {
      if (panel === document.body || panel === document.documentElement) break;
      if (visited.has(panel)) continue;
      visited.add(panel);
      const rect = rectOf(panel);
      if (rect.width < 160 || rect.width > 760 || rect.height < 110 || rect.height > 720) continue;
      if (!isVisibleSliderElement(panel) || panel.closest('pre, code, textarea, [contenteditable="true"]')) continue;
      const text = visibleSliderStatusText(panel);
      if (!CHALLENGE_WORDS.test(text) || !PROMPT_WORDS.test(text)) continue;
      panels.add(panel);
    }
  }

  const result = [...panels]
    .sort((left, right) => {
      const a = rectOf(left);
      const b = rectOf(right);
      return a.width * a.height - b.width * b.height;
    })
    .slice(0, 12);
  if (activeDomScanCache) activeDomScanCache.geometryPanels = result;
  return result;
}

function rectContains(outer: DOMRect, inner: DOMRect, tolerance = 3): boolean {
  return inner.left >= outer.left - tolerance && inner.right <= outer.right + tolerance
    && inner.top >= outer.top - tolerance && inner.bottom <= outer.bottom + tolerance;
}

function rectInViewport(rect: DOMRect, minimumRatio: number): boolean {
  const width = Math.max(0, Math.min(window.innerWidth, rect.right) - Math.max(0, rect.left));
  const height = Math.max(0, Math.min(window.innerHeight, rect.bottom) - Math.max(0, rect.top));
  return width * height >= rect.width * rect.height * minimumRatio;
}

function scoreGeometryBackground(element: Element, panel: Element): number {
  if (!isVisibleSliderElement(element)) return -Infinity;
  const rect = rectOf(element);
  if (rect.width < 110 || rect.height < 50 || rect.width / rect.height < 1.1
    || rect.width / rect.height > 4.5 || !rectContains(rectOf(panel), rect)
    || !rectInViewport(rect, 0.96)) return -Infinity;
  // 必须是真实图片区域；纯色占位框、文字容器不能充当截图背景。
  if (!(element instanceof HTMLImageElement) && !(element instanceof HTMLCanvasElement)
    && !cssImageUrl(element)) return -Infinity;
  return 8 + Math.min(5, rect.width * rect.height / 20_000)
    + (BACKGROUND_WORDS.test(semanticText(element)) ? 3 : 0);
}

function scoreGeometryTrack(element: Element, background: Element, panel: Element): number {
  if (!(element instanceof HTMLElement) || element === background || element.contains(background)
    || background.contains(element) || !isVisibleSliderElement(element)) return -Infinity;
  const rect = rectOf(element);
  const image = rectOf(background);
  const gap = rect.top - image.bottom;
  if (rect.height < 12 || rect.height > 90 || rect.width < rect.height * 3
    || rect.width < image.width * 0.75 || rect.width > image.width * 1.25
    || gap < -4 || gap > Math.max(64, image.height * 0.35)
    || Math.abs(rect.left - image.left) > Math.max(24, image.width * 0.12)
    || !rectContains(rectOf(panel), rect) || !rectInViewport(rect, 0.98)) return -Infinity;
  return 8 + (hasTrackWords(semanticText(element)) ? 3 : 0)
    + 4 * (1 - Math.min(1, Math.abs(rect.width - image.width) / image.width));
}

function scoreGeometryHandle(element: Element, track: Element): number {
  if (!(element instanceof HTMLElement) || element === track || !track.contains(element)
    || !isVisibleSliderElement(element) || element.matches('input, select, textarea, :disabled')
    || element.closest('[inert], [aria-disabled="true"], [aria-hidden="true"], [disabled]')) return -Infinity;
  const rect = rectOf(element);
  const rail = rectOf(track);
  if (rect.width < 20 || rect.width > 110 || rect.height < 18 || rect.height > 96
    || rect.width / rect.height < 0.45 || rect.width / rect.height > 2.6
    || rail.width < rect.width * 2.7 || rect.height < rail.height * 0.55
    || rect.height > rail.height * 1.5 || rect.left < rail.left - 3 || rect.right > rail.right + 3
    || verticalOverlap(rect, rail) < Math.min(rect.height, rail.height) * 0.65
    || !rectInViewport(rect, 0.98)) return -Infinity;
  const own = semanticText(element);
  if (NON_HANDLE_WORDS.test(own)) return -Infinity;
  const style = window.getComputedStyle(element);
  if (style.pointerEvents === 'none') return -Infinity;
  const dragHint = element.matches(handleSelectors()) || HANDLE_WORDS.test(own)
    || element.matches('button, [role="button"]') || /^(?:grab|grabbing|pointer|move|ew-resize)$/.test(style.cursor);
  const hasSurface = (style.boxShadow !== 'none' && style.boxShadow !== '')
    || Number.parseFloat(style.borderLeftWidth) > 0
    || (!!style.backgroundColor && !/^(?:transparent|rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\))$/.test(style.backgroundColor));
  if (!dragHint && !hasSurface) return -Infinity;
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  // 只能标记真正接收按压的把手，不能拿被公告盖住的旧登录控件兜底。
  if (!hit || !(hit === element || element.contains(hit))) return -Infinity;
  return 8 + (dragHint ? 6 : 0)
    + 4 * (1 - Math.min(1, Math.abs(rect.height - rail.height) / rail.height))
    + (rect.left - rail.left < rail.width * 0.35 ? 1 : 0);
}

function findGeometrySliderDomMatch(): SliderDomMatch | null {
  for (const panel of findGeometrySliderPanels()) {
    const elements = queryAll('*', panel).slice(0, MAX_SCAN_ELEMENTS);
    const backgrounds = scoredElements(elements, (element) => scoreGeometryBackground(element, panel)).slice(0, 4);
    let best: { match: SliderDomMatch; score: number } | undefined;
    for (const { element: background, score: backgroundScore } of backgrounds) {
      const tracks = scoredElements(elements, (element) => scoreGeometryTrack(element, background, panel)).slice(0, 6);
      for (const { element: track, score: trackScore } of tracks) {
        const candidate = scoredElements(elements, (element) => scoreGeometryHandle(element, track))[0];
        if (!candidate || !(candidate.element instanceof HTMLElement)) continue;
        const score = backgroundScore + trackScore + candidate.score;
        if (!best || score > best.score) {
          best = {
            score,
            // 匿名节点里的暗色缺口不能猜成拼图块；后台已有无 pieceRect 的
            // 截图差分路径，会在同一次可信拖动中测量真正随把手移动的图像。
            match: { panel, background, track, handle: candidate.element, detectionMethod: 'panel-geometry' },
          };
        }
      }
    }
    if (best) return best.match;
  }
  return null;
}

function findSliderDomMatchInternal(): SliderDomMatch | null {
  for (const handle of collectHandleCandidates()) {
    const handleScore = scoreHandle(handle);
    if (handleScore < 9 || (!hasChallengeContext(handle) && handleScore < 14)) continue;
    const panel = findPanel(handle);
    if (!panel) continue;
    const track = findTrack(panel, handle);
    if (!track) continue;
    const background = findBackground(panel, track, handle);
    if (!background) continue;
    const piece = findPiece(panel, background, handle);
    return { panel, background, piece, track, handle };
  }
  return findGeometrySliderDomMatch();
}

export function findSliderDomMatch(mode: SliderDomMode = 'page'): SliderDomMatch | null {
  return withDomScanCache(findSliderDomMatchInternal, mode);
}

export function hasVisibleSliderWidget(): boolean {
  return withDomScanCache(() => {
    if (queryAll(SLIDER_WIDGET_SELECTORS).some(isVisibleSliderElement)) return true;
    return findSliderDomMatchInternal() != null || findGeometrySliderPanels().length > 0;
  });
}

export function hasExplicitSliderSuccess(panel?: Element): boolean {
  const root: ParentNode = panel ?? document;
  const selectors = successSelectors();
  if (panel?.matches(selectors) && isVisibleSliderElement(panel)) return true;
  if (queryAll(selectors, root).some(isVisibleSliderElement)) return true;
  if (!panel || !isVisibleSliderElement(panel)) return false;
  return ['data-state', 'data-status', 'aria-checked'].some((attribute) => (
    /^(?:verified|success|passed|complete|completed|true)$/i.test(panel.getAttribute(attribute)?.trim() ?? '')
  ));
}

function sampledHash(value: string): string {
  let hash = 0x811c9dc5;
  const step = Math.max(1, Math.floor(value.length / 256));
  for (let index = 0; index < value.length; index += step) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= value.length;
  return (hash >>> 0).toString(36);
}

/**
 * 取几个「换图时会变、但不需要读像素」的辅助信号。
 *
 * 图片源拿不到时（canvas 被跨域污染 → `toDataURL` 抛 SecurityError，或图只挂在
 * CSS `background-image` 上而 URL 取不到）`challengeKey` 会退化成
 * 「semanticText + 矩形尺寸」，这两项在刷新前后一模一样 —— 新旧挑战算出同一个
 * key，`slider-solve` 就看不出图已经换了。
 *
 * 这些属性不是万灵药（真的什么都不变时仍会碰撞），但覆盖了常见的几种：验证码
 * 库往往把版本号/随机串写进 `background-position`、`data-*` 或内联 style，
 * canvas 换图时尺寸属性也常跟着变。
 */
function volatileHints(element: Element | undefined): string {
  if (!element) return '';
  const parts = [
    element.getAttribute('style') ?? '',
    element.getAttribute('data-id') ?? '',
    element.getAttribute('data-key') ?? '',
    element.getAttribute('data-index') ?? '',
    element.getAttribute('srcset') ?? '',
  ];
  if (element instanceof HTMLCanvasElement) parts.push(`${element.width}x${element.height}`);
  if (element instanceof HTMLImageElement) parts.push(`${element.naturalWidth}x${element.naturalHeight}`);
  try {
    // background-position / background-size 常被用来在同一张雪碧图上换图。
    const style = window.getComputedStyle(element);
    parts.push(style.backgroundPosition, style.backgroundSize);
  } catch {
    // 元素已脱离文档时取不到计算样式，忽略。
  }
  return parts.filter(Boolean).join('~');
}

function challengeKey(
  match: SliderDomMatch,
  backgroundSource?: SliderImageSource,
  pieceSource?: SliderImageSource,
  referenceBackgroundSource?: SliderImageSource,
): string {
  const backgroundRect = rectOf(match.background);
  const pieceRect = match.piece ? rectOf(match.piece) : undefined;
  const material = [
    backgroundSource?.value ?? semanticText(match.background),
    referenceBackgroundSource?.value ?? '',
    pieceSource?.value ?? (match.piece ? semanticText(match.piece) : ''),
    `${backgroundRect.width.toFixed(1)}x${backgroundRect.height.toFixed(1)}`,
    pieceRect ? `${pieceRect.width.toFixed(1)}x${pieceRect.height.toFixed(1)}` : 'no-piece',
    // 只在图片源缺失时才纳入：源存在时它本身已经足够区分，多带这些反而会让
    // 同一张图因为一次无关的重绘（内联 style 微调）被误判成"换了新图"。
    backgroundSource ? '' : volatileHints(match.background),
    pieceSource ? '' : volatileHints(match.piece),
  ].join('|');
  return sampledHash(material);
}

function panelNeedsCentering(panel: Element): boolean {
  const rect = rectOf(panel);
  const margin = 4;
  return rect.left < margin || rect.top < margin || rect.right > window.innerWidth - margin || rect.bottom > window.innerHeight - margin;
}

const nextPaint = (mode: SliderDomMode) => new Promise<void>((resolve) => {
  // 只给可能被销毁的 iframe 增加定时退出；主页面仍等待原有的两帧渲染。
  const timer = mode === 'tencent-frame' ? setTimeout(resolve, 250) : undefined;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (timer !== undefined) clearTimeout(timer);
    resolve();
  }));
});

/**
 * 本地定义而不从 `dom-utils` 导入：那个模块会连带引入 `lib/messaging`，
 * 而本文件目前只依赖 DOM，保持这条边界干净。
 */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 把一次匹配的全部矩形读成一串数字。
 *
 * 必须在**采样那一刻**取值存下来。原来的写法是 `geometryIsStable(before, after)`
 * 内部对两个参数各调一次这个函数 —— 而 `before` 和 `after` 指向的是同一批 DOM
 * 节点，同一瞬间读两次必然相等，稳定判定恒为 true，从来没拦住过任何东西。
 *
 * 真正的危害不是「慢动画被拒」，而是反过来：动画中途的坐标被当成稳定值发给后台，
 * 拖动按它算，而下一帧它就作废了 —— 日志里一切正常，站点判失败。
 */
function geometrySnapshot(match: SliderDomMatch): number[] {
  return [match.panel, match.background, match.piece, match.track, match.handle]
    .filter((element): element is Element => element != null)
    .flatMap((element) => {
      const rect = rectOf(element);
      return [rect.x, rect.y, rect.width, rect.height];
    });
}

function geometryIsStable(
  before: readonly number[],
  after: readonly number[],
  tolerance = 1.5,
): boolean {
  return before.length === after.length
    && before.every((value, index) => Math.abs(value - after[index]!) <= tolerance);
}

function sliderMediaReady(match: SliderDomMatch): boolean {
  return [match.background, match.piece].every((element) => {
    if (element instanceof HTMLImageElement) {
      return element.complete && element.naturalWidth > 0 && element.naturalHeight > 0;
    }
    if (element instanceof HTMLCanvasElement) return element.width > 0 && element.height > 0;
    return true;
  });
}

async function waitForSliderDomMatch(
  timeoutMs = 1_500,
  isActive = () => true,
  mode: SliderDomMode = 'page',
): Promise<SliderDomMatch | null> {
  const deadline = Date.now() + timeoutMs;
  if (!isActive()) return null;
  let match = findSliderDomMatch(mode);
  // 刷新时旧面板与新把手并非同时替换；给组件挂载一个有界的等待窗口。
  while (!match && Date.now() < deadline && isActive()) {
    await sleep(Math.min(120, Math.max(0, deadline - Date.now())));
    match = findSliderDomMatch(mode);
  }
  return isActive() ? match : null;
}

let sliderCollectionFailure: string | undefined;

export function getSliderCollectionFailure(): string | undefined {
  return sliderCollectionFailure;
}

function missingSliderPart(mode: SliderDomMode): string {
  return withDomScanCache(() => {
    const handles = collectHandleCandidates().filter((handle) => scoreHandle(handle) >= 9 && hasChallengeContext(handle));
    if (!handles.length) return '当前验证码文档未找到可接收拖动的滑块把手（可能仍在加载或被遮挡）';
    const panels = handles.map((handle) => ({ handle, panel: findPanel(handle) })).filter((item) => item.panel != null);
    if (!panels.length) return '已找到滑块把手，但尚未找到它所属的验证码面板';
    const tracks = panels.map(({ handle, panel }) => ({ handle, panel: panel!, track: findTrack(panel!, handle) }))
      .filter((item) => item.track != null);
    if (!tracks.length) return '已找到验证码面板和把手，但没有匹配的滑动轨道';
    if (!tracks.some(({ handle, panel, track }) => findBackground(panel, track!, handle))) {
      return '已找到滑块把手和轨道，但验证码背景图片尚未就绪';
    }
    return '验证码组件仍在重绘，尚未取得同一挑战的完整滑块控件';
  }, mode);
}

export async function collectSliderChallenge(options: {
  mode?: SliderDomMode;
  mountTimeoutMs?: number;
  deadline?: number;
  isActive?: () => boolean;
} = {}): Promise<CollectedSliderChallenge | null> {
  sliderCollectionFailure = undefined;
  const mode = options.mode ?? 'page';
  const isActive = () => options.isActive?.() !== false && Date.now() < (options.deadline ?? Infinity);
  const mountTimeout = () => Math.max(0, Math.min(options.mountTimeoutMs ?? 1_500, (options.deadline ?? Infinity) - Date.now()));
  let match = await waitForSliderDomMatch(mountTimeout(), isActive, mode);
  if (!match) {
    sliderCollectionFailure = isActive() ? missingSliderPart(mode) : '本轮滑块任务已停止或超过时限';
    return null;
  }

  if (panelNeedsCentering(match.panel)) {
    match.panel.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
    await nextPaint(mode);
    match = await waitForSliderDomMatch(mountTimeout(), isActive, mode);
    if (!match) {
      sliderCollectionFailure = isActive() ? missingSliderPart(mode) : '本轮滑块任务已停止或超过时限';
      return null;
    }
  }

  /*
   * 等几何稳定下来，但要给足入场动画的时间。
   *
   * 原来是固定的「最多 3 帧」（60fps 下约 50ms）：面板带 300–400ms 滑入动画时
   * 每一帧几何都在变，于是直接 return null —— 滑块明明能识别，却因为还在动而
   * 被丢掉，上层报「没有找到同时满足把手、轨道和背景几何关系的滑块控件」。
   *
   * 改成有界轮询，与 `dom-utils.ts` 的 `stableRect` 同一个形状：连续两次采样
   * 几何不变且图片就绪才算稳定，最多等 2.5 秒。上限是必需的 —— 有些站点的验证码带持续
   * 的呼吸/闪烁动画，永远等不到"完全不动"。
   */
  const STABLE_TIMEOUT_MS = 2_500;
  /**
   * 相邻两次采样的间隔。
   *
   * 必须**每次**都等这么久，不能只在「上次判定为动」时等：动画不一定每帧都改
   * 几何（CSS 过渡在低帧率下、或 JS 每 2–3 帧才更新一次位置），相邻两次
   * requestAnimationFrame（约 16ms）很可能读到同一个值，于是动画中途就被判成
   * 稳定，采到一个下一帧就作废的坐标。间隔要明显大于一帧。
   *
   * 局限：更新间隔超过 100ms 的动画（低于 10fps）仍可能被两次采样都读到同一
   * 位置而误判为稳定。真实验证码不会这么慢，而后台在按下前还会用
   * `liveTargetPoint` 重新采样把手，是第二道防线。要更严就得把间隔调大，
   * 代价是每次采集都多等 —— 当前取值是这两者的折中。
   */
  const STABLE_INTERVAL_MS = 50;
  const deadline = Math.min(options.deadline ?? Infinity,
    Date.now() + Math.max(STABLE_TIMEOUT_MS, Math.min(options.mountTimeoutMs ?? 0, 6_000)));
  // 存快照，不是存 match：match 里是 DOM 节点引用，晚一刻再读就是新值了。
  let previousGeometry = geometrySnapshot(match);
  let stableSamples = 0;
  while (Date.now() < deadline && isActive()) {
    await sleep(STABLE_INTERVAL_MS);
    const current = findSliderDomMatch(mode);
    if (!current) {
      stableSamples = 0;
      continue;
    }
    const currentGeometry = geometrySnapshot(current);
    if (sliderMediaReady(current) && geometryIsStable(previousGeometry, currentGeometry)) stableSamples += 1;
    else stableSamples = 0;
    previousGeometry = currentGeometry;
    match = current;
    if (stableSamples >= 2) break;
  }
  if (stableSamples < 2 || !isActive()) {
    sliderCollectionFailure = !isActive() ? '本轮滑块任务已停止或超过时限'
      : !sliderMediaReady(match) ? '验证码图片还没有加载完成，未执行拖动'
      : '验证码布局在等待时间内没有稳定，未使用动画中的坐标拖动';
    return null;
  }

  const backgroundSource = imageSourceOf(match.background);
  const referenceBackground = match.detectionMethod === 'panel-geometry'
    ? undefined : findReferenceBackground(match.panel, match.background);
  const referenceBackgroundSource = referenceBackground ? imageSourceOf(referenceBackground) : undefined;
  const pieceSource = match.piece ? imageSourceOf(match.piece) : undefined;
  // 主页面保留原图输入；共用裁剪素材的截图策略只属于腾讯 iframe 助手。
  const renderedOnly = mode === 'tencent-frame' && match.handle.matches(TENCENT_SLIDER_SELECTORS.handle);
  const previousMarker = match.handle.getAttribute(POINTER_MARKER);
  const handleToken = `p-slider-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  match.handle.setAttribute(POINTER_MARKER, handleToken);

  let released = false;
  const releaseHandleMarker = () => {
    if (released) return;
    released = true;
    if (match!.handle.getAttribute(POINTER_MARKER) !== handleToken) return;
    if (previousMarker == null) match!.handle.removeAttribute(POINTER_MARKER);
    else match!.handle.setAttribute(POINTER_MARKER, previousMarker);
  };

  const info: SliderChallengeInfo = {
    panelRect: toRect(rectOf(match.panel)),
    backgroundRect: toRect(rectOf(match.background)),
    pieceRect: match.piece ? toRect(rectOf(match.piece)) : undefined,
    trackRect: toRect(rectOf(match.track)),
    handleRect: toRect(rectOf(match.handle)),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio || 1,
    backgroundSource: renderedOnly ? undefined : backgroundSource,
    referenceBackgroundSource: renderedOnly ? undefined : referenceBackgroundSource,
    pieceSource: renderedOnly ? undefined : pieceSource,
    handleToken,
    challengeKey: challengeKey(match, backgroundSource, pieceSource, referenceBackgroundSource),
  };

  return { info, match, releaseHandleMarker };
}

export function visibleSliderStatusText(panel?: Element): string {
  const candidates = panel ? [panel] : queryAll(widgetSelectors());
  const visibleRoots = candidates.filter(isVisibleSliderElement);
  const roots = visibleRoots.filter((root) => !visibleRoots.some((other) => other !== root && other.contains(root)));
  const parts: string[] = [];
  let length = 0;
  let scanned = 0;

  // textContent 包含隐藏的上轮失败文案；也不能在面板重绘时退回读取整页文本。
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode()) && scanned < MAX_SCAN_ELEMENTS && length < 1_500) {
      scanned += 1;
      const text = node.textContent ?? '';
      if (!text.trim() || !node.parentElement || !isVisibleSliderElement(node.parentElement)) continue;
      parts.push(text);
      length += text.length;
    }
    if (scanned >= MAX_SCAN_ELEMENTS || length >= 1_500) break;
  }

  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 1_500);
}

export function readSliderDomState(previousPanel?: Element, mode: SliderDomMode = 'page'): SliderDomState {
  return withDomScanCache(() => {
    const match = findSliderDomMatchInternal();
    if (!match) {
      // `findSliderDomMatchInternal` already scanned the document. Calling the
      // public helper here would repeat that full scan on every polling tick.
      const visibleWidgets = [
        ...queryAll(widgetSelectors()).filter(isVisibleSliderElement),
        ...findGeometrySliderPanels(),
      ];
      const previous = previousPanel && isVisibleSliderElement(previousPanel) ? previousPanel : undefined;
      if (mode === 'page') {
        // 主页面沿用原有整页成功标记兜底，不套用 iframe 的面板隔离规则。
        const panel = previous ?? visibleWidgets[0];
        return {
          visible: visibleWidgets.length > 0,
          success: hasExplicitSliderSuccess(panel) || hasExplicitSliderSuccess(),
          panel,
          statusText: visibleSliderStatusText(panel),
        };
      }
      const roots = [...new Set(visibleWidgets)].filter((root) => (
        !visibleWidgets.some((other) => other !== root && other.contains(root))
      ));
      // 同一面板的图片区和成功提示可能是兄弟节点；先读本轮整体面板。
      // 只有另一个独立、未通过的面板出现时才切换，不能沿用旧登录 success。
      const pendingElsewhere = roots.find((root) => !hasExplicitSliderSuccess(root)
        && (!previous || (!previous.contains(root) && !root.contains(previous))));
      const panel = pendingElsewhere ?? previous ?? roots[0];
      return {
        visible: visibleWidgets.length > 0 || panel != null,
        success: panel != null && hasExplicitSliderSuccess(panel),
        panel,
        statusText: visibleSliderStatusText(panel),
      };
    }

    const backgroundSource = imageSourceOf(match.background);
    const referenceBackground = match.detectionMethod === 'panel-geometry'
      ? undefined : findReferenceBackground(match.panel, match.background);
    const referenceBackgroundSource = referenceBackground ? imageSourceOf(referenceBackground) : undefined;
    const pieceSource = match.piece ? imageSourceOf(match.piece) : undefined;
    const handleRect = rectOf(match.handle);
    const trackRect = rectOf(match.track);
    return {
      visible: true,
      success: hasExplicitSliderSuccess(match.panel) || (mode === 'page' && hasExplicitSliderSuccess()),
      panel: match.panel,
      challengeKey: challengeKey(match, backgroundSource, pieceSource, referenceBackgroundSource),
      handleX: handleRect.x,
      pieceX: match.piece ? rectOf(match.piece).x : undefined,
      handleOffsetX: handleRect.x - trackRect.x,
      handleRange: trackRect.width - handleRect.width,
      statusText: visibleSliderStatusText(match.panel),
    };
  }, mode);
}
