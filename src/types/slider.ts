export interface SliderRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SliderSolveResult {
  solved: boolean;
  method?: string;
  gapX?: number;
  distance?: number;
  error?: string;
  /** 仅用于 iframe 助手：窗口关闭只解除等待，登录/签到结果由业务流程确认。 */
  dismissed?: boolean;
}

export interface SliderImageSource {
  /** Absolute http(s) URL or a data URL captured from a canvas. */
  value: string;
  kind: 'url' | 'data-url';
}

/** DOM geometry collected in viewport CSS pixels. */
export interface SliderChallengeInfo {
  panelRect: SliderRect;
  backgroundRect: SliderRect;
  pieceRect?: SliderRect;
  trackRect: SliderRect;
  handleRect: SliderRect;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  backgroundSource?: SliderImageSource;
  /** Optional second background (for example, full image versus gapped image). */
  referenceBackgroundSource?: SliderImageSource;
  pieceSource?: SliderImageSource;
  /** Temporary DOM marker used to resample the handle immediately before press. */
  handleToken?: string;
  /** Changes when a refreshed challenge replaces either source image. */
  challengeKey: string;
}

export interface SliderCrackOptions {
  attempt: number;
  /** Small feedback-driven correction in handle CSS pixels. */
  correctionPx?: number;
  /**
   * 本轮已经拖过且被站点判失败的缺口位置。
   *
   * 单位是**背景图左边缘起算的 CSS 像素**，与 `SliderCrackResult.gapX` 同一坐标系 ——
   * 生产方就是把上一轮的 `result.gapX` 原样攒起来回传的。两条识别路径各自在自己的
   * 像素空间里比较，因此**消费端必须先按当前缩放比换算**，不能直接拿去比：
   * 静态路径要乘 `imageScaleX` 再加 `cropOffsetX`（背景图像素），
   * 边拖边测路径要乘 `pixelRatio` 再加裁剪偏移（截图裁剪像素）。
   *
   * 曾经这里写的是「背景图像素」，而生产方给的一直是 CSS 像素：`imageScaleX ≠ 1`
   * （HiDPI、Windows 125%/150% 缩放、站点按 2x 出图）时排除区落在完全错误的位置 ——
   * 既排不掉真正失败的那个缺口，又可能顺手排掉一个有效候选。
   *
   * 实测日志里第 1 次和第 5 次算出同一个「缺口=32.8px」，而第 1 次已经明确
   * 失败 —— 不排除的话 5 次机会里有 2 次是白费的。
   */
  excludedGapX?: number[];
}

export type SliderCrackErrorCode =
  | 'busy'
  | 'invalid-geometry'
  | 'image-unavailable'
  | 'match-not-found'
  | 'match-ambiguous'
  | 'distance-out-of-range'
  | 'drag-failed';

export interface SliderCrackDiagnostics {
  source: 'raw-image' | 'viewport-screenshot';
  imageScaleX: number;
  imageScaleY: number;
  imageDistance: number;
  handleRange: number;
  pieceRange: number;
  conversionRatio: number;
  correctionPx: number;
  candidateCount: number;
  confidenceMargin?: number;
  /** 位置明显不同、分数同样够高的其它候选个数；>0 说明图上有多个疑似缺口。 */
  rivalCount?: number;
  /** 截图裁剪的亚像素补偿量（背景图像素）；原图路径为 0。 */
  cropOffsetX?: number;
  /** 边拖边测：探测阶段移动了多远（CSS 像素）。 */
  probeDistance?: number;
  /**
   * 边拖边测：**实测**的碎片位移 ÷ 把手位移。
   *
   * 与 `conversionRatio` 的区别是它来自两张截图的差分，不是
   * `handleRange / pieceRange` 推算。两者不一致时说明几何推算不可信。
   */
  measuredRatio?: number;
}

export interface SliderCrackResult {
  /** The trusted drag was dispatched. DOM-side feedback still confirms acceptance. */
  solved: boolean;
  gapX?: number;
  distance?: number;
  method?: string;
  confidence?: number;
  diagnostics?: SliderCrackDiagnostics;
  errorCode?: SliderCrackErrorCode;
  error?: string;
}
