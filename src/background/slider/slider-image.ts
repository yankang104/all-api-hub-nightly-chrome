import type {
  SliderChallengeInfo,
  SliderImageSource,
  SliderRect,
} from '@/types/slider';

export interface SimpleImageData {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface TemplateDescriptor {
  image: SimpleImageData;
  originalWidth: number;
  originalHeight: number;
  bounds: { x: number; y: number; width: number; height: number };
  shapedAlpha: boolean;
}

export interface PreparedSliderImages {
  background: SimpleImageData;
  referenceBackground?: SimpleImageData;
  template?: TemplateDescriptor;
  source: 'raw-image' | 'viewport-screenshot';
  imageScaleX: number;
  imageScaleY: number;
  /**
   * 裁剪背景图时因取整丢失的左边缘偏移，单位为背景图像素。
   *
   * 截图路径先按 devicePixelRatio 放大再 `Math.round` 裁剪，125% 缩放下会丢
   * 半个物理像素。经 `imageDistance × conversionRatio` 放大后，最终拖动距离
   * 系统性偏 1–2px —— 正好是校准序列 `[0,-1,1,-2,2]` 的量级，也就是说
   * 原来靠重试碰对，而不是一次算准。把偏移带出来在换算时减掉。
   */
  cropOffsetX: number;
  /** 拼图块裁剪的同类偏移；没有拼图块矩形时为 0。 */
  cropOffsetPieceX: number;
}

export interface SliderGapMatch {
  x: number;
  y: number;
  confidence: number;
  confidenceMargin?: number;
  method: string;
  candidateCount: number;
  templateWidth: number;
  templateHeight: number;
  templateOffsetX: number;
  templateOffsetY: number;
  templateOriginalWidth: number;
  templateOriginalHeight: number;
  /**
   * 图上还有几个分数接近的候选缺口。
   *
   * 多缺口验证码（同一张背景图上画 2–3 个拼图形状）会让每种匹配方法各自锁定
   * 不同的形状，分数都在 0.65–0.75 之间。此时选中的那个只是"分数最高"，
   * 不是"正确"—— 必须如实报出来，让调用方尽早转人工而不是把 5 次机会用完。
   */
  rivalCount: number;
}

/** 已经拖过且被站点判失败的缺口位置，单位为背景图像素。 */
export interface ExcludedGap {
  x: number;
  /** 排除半径；落在 ±radius 内的候选一律不再采信。 */
  radius: number;
}

interface NCCResult {
  x: number;
  y: number;
  confidence: number;
  confidenceMargin?: number;
  candidateCount?: number;
}

interface MatchCandidate extends NCCResult {
  method: string;
}

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
/**
 * 解码后单张图像的像素总数上限，与 validBackgroundImage 的背景图上限同源。
 *
 * MAX_IMAGE_BYTES 只约束**压缩后**的字节数，挡不住解压炸弹：一张 ~200KB 的
 * PNG 可以合法解码成 15000×15000，按 width×height×4 分配就是 >900MB。这个上限
 * 用在 decodeBlob 里，在建 canvas / getImageData **之前**按解码尺寸拦一道。
 * background 本身允许到 16M 像素（validBackgroundImage），拼图块更小；decodeBlob
 * 两种图都解，因此取较大的背景图上限，绝不能用更严的模板上限误杀合法背景。
 */
const MAX_IMAGE_PIXELS = 16_000_000;
const IMAGE_LOAD_TIMEOUT_MS = 8_000;

function createImageData(width: number, height: number): SimpleImageData {
  return {
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
  };
}

function cropRegion(source: SimpleImageData, rect: SliderRect): SimpleImageData {
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const result = createImageData(width, height);
  const sourceX = Math.round(rect.x);
  const sourceY = Math.round(rect.y);

  for (let y = 0; y < height; y += 1) {
    const fromY = sourceY + y;
    if (fromY < 0 || fromY >= source.height) continue;
    for (let x = 0; x < width; x += 1) {
      const fromX = sourceX + x;
      if (fromX < 0 || fromX >= source.width) continue;
      const from = (fromY * source.width + fromX) * 4;
      const to = (y * width + x) * 4;
      result.data[to] = source.data[from]!;
      result.data[to + 1] = source.data[from + 1]!;
      result.data[to + 2] = source.data[from + 2]!;
      result.data[to + 3] = source.data[from + 3]!;
    }
  }
  return result;
}

function grayAt(data: Uint8ClampedArray, pixel: number): number {
  const offset = pixel * 4;
  return 0.299 * data[offset]! + 0.587 * data[offset + 1]! + 0.114 * data[offset + 2]!;
}

function buildGray(image: SimpleImageData): Float32Array {
  const result = new Float32Array(image.width * image.height);
  for (let pixel = 0; pixel < result.length; pixel += 1) result[pixel] = grayAt(image.data, pixel);
  return result;
}

function runnerUpMargin(
  scores: Float32Array,
  columns: number,
  bestIndex: number,
  exclusionX: number,
  exclusionY: number,
): { margin?: number; candidateCount: number } {
  const best = scores[bestIndex]!;
  const bestX = bestIndex % columns;
  const bestY = Math.floor(bestIndex / columns);
  let second = -Infinity;
  let candidateCount = 0;
  for (let index = 0; index < scores.length; index += 1) {
    const score = scores[index]!;
    if (!Number.isFinite(score)) continue;
    candidateCount += 1;
    const x = index % columns;
    const y = Math.floor(index / columns);
    if (Math.abs(x - bestX) <= exclusionX && Math.abs(y - bestY) <= exclusionY) continue;
    if (score > second) second = score;
  }
  if (!Number.isFinite(second)) return { candidateCount };
  return {
    margin: Math.max(0, best - second),
    candidateCount,
  };
}

/** Alpha-aware normalized cross-correlation used when OpenCV is unavailable. */
export function nccTemplateMatch(
  search: SimpleImageData,
  template: SimpleImageData,
  minConfidence = 0.4,
): NCCResult | null {
  const sw = search.width;
  const sh = search.height;
  const tw = template.width;
  const th = template.height;
  if (tw > sw || th > sh || tw < 1 || th < 1) return null;

  const templateLength = tw * th;
  const templatePixels: Array<{ x: number; y: number; value: number; centered: number }> = [];
  let templateSum = 0;
  for (let pixel = 0; pixel < templateLength; pixel += 1) {
    if (template.data[pixel * 4 + 3]! < 32) continue;
    const value = grayAt(template.data, pixel);
    templatePixels.push({
      x: pixel % tw,
      y: Math.floor(pixel / tw),
      value,
      centered: 0,
    });
    templateSum += value;
  }
  const validCount = templatePixels.length;
  if (validCount === 0) return null;
  const templateMean = templateSum / validCount;

  let templateVariance = 0;
  for (const pixel of templatePixels) {
    pixel.centered = pixel.value - templateMean;
    templateVariance += pixel.centered ** 2;
  }
  const templateStd = Math.sqrt(templateVariance / validCount);
  const searchGray = buildGray(search);
  const maxX = sw - tw;
  const maxY = sh - th;
  const columns = maxX + 1;
  const scores = new Float32Array(columns * (maxY + 1));
  scores.fill(Number.NEGATIVE_INFINITY);
  let bestIndex = -1;
  let bestScore = -Infinity;

  // An opaque template always samples the complete rectangle. Integral sums
  // make the candidate window mean and variance O(1), leaving only the actual
  // correlation pass in the hot loop. Masked templates keep the exact previous
  // path because their sample set is intentionally non-rectangular.
  const opaqueTemplate = validCount === templateLength;
  let integralSum: Float64Array | undefined;
  let integralSquareSum: Float64Array | undefined;
  const integralWidth = sw + 1;
  if (opaqueTemplate) {
    integralSum = new Float64Array(integralWidth * (sh + 1));
    integralSquareSum = new Float64Array(integralWidth * (sh + 1));
    for (let y = 0; y < sh; y += 1) {
      let rowSum = 0;
      let rowSquareSum = 0;
      for (let x = 0; x < sw; x += 1) {
        const value = searchGray[y * sw + x]!;
        rowSum += value;
        rowSquareSum += value * value;
        const index = (y + 1) * integralWidth + x + 1;
        integralSum[index] = integralSum[y * integralWidth + x + 1]! + rowSum;
        integralSquareSum[index] = integralSquareSum[y * integralWidth + x + 1]! + rowSquareSum;
      }
    }
  }

  const rectangleStats = (x: number, y: number) => {
    const right = x + tw;
    const bottom = y + th;
    const sum = integralSum![bottom * integralWidth + right]!
      - integralSum![y * integralWidth + right]!
      - integralSum![bottom * integralWidth + x]!
      + integralSum![y * integralWidth + x]!;
    const squareSum = integralSquareSum![bottom * integralWidth + right]!
      - integralSquareSum![y * integralWidth + right]!
      - integralSquareSum![bottom * integralWidth + x]!
      + integralSquareSum![y * integralWidth + x]!;
    const mean = sum / validCount;
    return { mean, variance: Math.max(0, squareSum / validCount - mean * mean) };
  };

  const scoreAt = (x: number, y: number): number | null => {
    if (opaqueTemplate) {
      const stats = rectangleStats(x, y);
      if (templateStd < 1) {
        const colorDifference = Math.abs(stats.mean - templateMean) / 255;
        return 1 - colorDifference - 0.3 * Math.sqrt(stats.variance) / 255;
      }
      const searchStd = Math.sqrt(stats.variance);
      if (searchStd < 1) return null;
      let cross = 0;
      for (const pixel of templatePixels) {
        const searchValue = searchGray[(y + pixel.y) * sw + x + pixel.x]!;
        cross += pixel.centered * (searchValue - stats.mean);
      }
      return cross / (validCount * templateStd * searchStd);
    }

    // A shaped template has a non-rectangular alpha mask, so its window
    // statistics still need the sampled pixels. Keep the sum and correlation
    // passes together with the old arithmetic, but avoid re-reading template
    // alpha and grayscale data for every candidate.
    let sum = 0;
    for (const pixel of templatePixels) {
      sum += searchGray[(y + pixel.y) * sw + x + pixel.x]!;
    }
    const mean = sum / validCount;
    if (templateStd < 1) {
      let squareSum = 0;
      for (const pixel of templatePixels) {
        const value = searchGray[(y + pixel.y) * sw + x + pixel.x]!;
        squareSum += value * value;
      }
      const variance = Math.max(0, squareSum / validCount - mean * mean);
      const colorDifference = Math.abs(mean - templateMean) / 255;
      return 1 - colorDifference - 0.3 * Math.sqrt(variance) / 255;
    }
    let variance = 0;
    let cross = 0;
    for (const pixel of templatePixels) {
      const searchValue = searchGray[(y + pixel.y) * sw + x + pixel.x]!;
      cross += pixel.centered * (searchValue - mean);
      variance += (searchValue - mean) ** 2;
    }
    const searchStd = Math.sqrt(variance / validCount);
    if (searchStd < 1) return null;
    return cross / (validCount * templateStd * searchStd);
  };

  if (templateStd < 1) {
    let searchSum = 0;
    let searchSquareSum = 0;
    for (const value of searchGray) {
      searchSum += value;
      searchSquareSum += value * value;
    }
    const searchMean = searchSum / searchGray.length;
    const searchVariance = Math.max(0, searchSquareSum / searchGray.length - searchMean * searchMean);
    if (Math.sqrt(searchVariance) < 1 && Math.abs(searchMean - templateMean) < 1) return null;

    for (let y = 0; y <= maxY; y += 1) {
      for (let x = 0; x <= maxX; x += 1) {
        const score = scoreAt(x, y);
        if (score == null) continue;
        const index = y * columns + x;
        scores[index] = score;
        if (score > bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      }
    }
  } else {
    for (let y = 0; y <= maxY; y += 1) {
      for (let x = 0; x <= maxX; x += 1) {
        const score = scoreAt(x, y);
        if (score == null) continue;
        const index = y * columns + x;
        scores[index] = score;
        if (score > bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      }
    }
  }

  if (bestIndex < 0 || bestScore < minConfidence) return null;
  const runnerUp = runnerUpMargin(
    scores,
    columns,
    bestIndex,
    Math.max(2, Math.round(tw * 0.25)),
    Math.max(2, Math.round(th * 0.25)),
  );
  return {
    x: bestIndex % columns,
    y: Math.floor(bestIndex / columns),
    confidence: bestScore,
    confidenceMargin: runnerUp.margin,
    candidateCount: runnerUp.candidateCount,
  };
}

function alphaBounds(image: SimpleImageData): TemplateDescriptor {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  let transparent = 0;
  let opaque = 0;

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const alpha = image.data[(y * image.width + x) * 4 + 3]!;
      if (alpha < 24) {
        transparent += 1;
        continue;
      }
      opaque += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  const total = image.width * image.height;
  const shapedAlpha = transparent / Math.max(1, total) >= 0.08 && opaque / Math.max(1, total) >= 0.015;
  if (!shapedAlpha || maxX < minX || maxY < minY) {
    return {
      image,
      originalWidth: image.width,
      originalHeight: image.height,
      bounds: { x: 0, y: 0, width: image.width, height: image.height },
      shapedAlpha: false,
    };
  }

  /*
   * 包围盒往外扩 1px 留边，但左/上贴边时扩不出去 —— 宽高要按**实际**扩出的
   * 量算，不能一律加 padding * 2。原来在 minX = 0 时算出 maxX + 3，比真实形状
   * 宽 1px（右边多带一列背景像素），模板与缺口的形状就对不齐了。
   */
  const padding = 1;
  const left = Math.max(0, minX - padding);
  const top = Math.max(0, minY - padding);
  const right = Math.min(image.width - 1, maxX + padding);
  const bottom = Math.min(image.height - 1, maxY + padding);
  const bounds = {
    x: left,
    y: top,
    width: right - left + 1,
    height: bottom - top + 1,
  };
  return {
    image: cropRegion(image, bounds),
    originalWidth: image.width,
    originalHeight: image.height,
    bounds,
    shapedAlpha: true,
  };
}

/** 只填补封闭在轮廓内部的透明孔洞，保留与外部相通的凹口。 */
export function fillTemplateAlphaHoles(image: SimpleImageData): SimpleImageData {
  const { width, height } = image;
  const exterior = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  const enqueue = (index: number) => {
    if (exterior[index] || image.data[index * 4 + 3]! >= 32) return;
    exterior[index] = 1;
    queue[tail++] = index;
  };
  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }
  while (head < tail) {
    const index = queue[head++]!;
    const x = index % width;
    if (x > 0) enqueue(index - 1);
    if (x + 1 < width) enqueue(index + 1);
    if (index >= width) enqueue(index - width);
    if (index + width < exterior.length) enqueue(index + width);
  }
  const data = new Uint8ClampedArray(image.data);
  for (let index = 0; index < exterior.length; index += 1) {
    if (!exterior[index] && data[index * 4 + 3]! < 32) data[index * 4 + 3] = 255;
  }
  return { width, height, data };
}

/**
 * 从截图裁剪出的拼图块推断它的实际形状。
 *
 * 截图路径拿到的是**不透明矩形**：拼图块画在背景图上，裁下来四角都是背景色，
 * `alphaBounds` 因此判定 `shapedAlpha: false`，匹配退化成矩形边缘对比
 * （`contour-edge`）。矩形轮廓在多缺口图上区分力极弱 —— 实测同一张图上
 * 3 个拼图形状全都命中，分数 0.652–0.748，等于在候选间随机选。
 *
 * 拼图块与周围背景之间几乎总有可分的边界（描边、投影、明暗差）。取矩形外圈
 * 2px 的中位色当背景参考，与之差异显著的像素标为不透明，就能还原出凸起形状，
 * 从而启用 alpha 感知的 `contour-alpha` 与带 mask 的 NCC。
 *
 * 推断不出合理形状（不透明比例失衡）时如实返回 null，保持原有行为。
 */
export function inferAlphaFromOpaqueCrop(image: SimpleImageData): SimpleImageData | null {
  const { width, height } = image;
  if (width < 12 || height < 12) return null;

  const ring = 2;
  const samples: number[][] = [[], [], []];
  const pushSample = (x: number, y: number) => {
    const offset = (y * width + x) * 4;
    samples[0]!.push(image.data[offset]!);
    samples[1]!.push(image.data[offset + 1]!);
    samples[2]!.push(image.data[offset + 2]!);
  };
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < ring; y += 1) {
      pushSample(x, y);
      pushSample(x, height - 1 - y);
    }
  }
  for (let y = ring; y < height - ring; y += 1) {
    for (let x = 0; x < ring; x += 1) {
      pushSample(x, y);
      pushSample(width - 1 - x, y);
    }
  }
  if (samples[0]!.length < 24) return null;

  const median = (values: number[]): number => {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)]!;
  };
  const backgroundRgb = [median(samples[0]!), median(samples[1]!), median(samples[2]!)] as const;

  // 外圈自身的离散程度决定阈值：背景本身有纹理时要求更大的差异才算前景。
  const ringSpread = median(samples[0]!.map((value) => Math.abs(value - backgroundRgb[0])));
  const threshold = Math.max(26, Math.min(80, ringSpread * 2.6 + 22));

  const result = createImageData(width, height);
  let opaque = 0;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const offset = pixel * 4;
    const distance = (
      Math.abs(image.data[offset]! - backgroundRgb[0])
      + Math.abs(image.data[offset + 1]! - backgroundRgb[1])
      + Math.abs(image.data[offset + 2]! - backgroundRgb[2])
    ) / 3;
    const isForeground = distance >= threshold;
    result.data[offset] = image.data[offset]!;
    result.data[offset + 1] = image.data[offset + 1]!;
    result.data[offset + 2] = image.data[offset + 2]!;
    result.data[offset + 3] = isForeground ? 255 : 0;
    if (isForeground) opaque += 1;
  }

  /**
   * 只接受"像一个拼图块"的结果。
   *
   * 比例过低说明拼图块与背景色太接近，推断出的是噪点；过高说明整块都被判成
   * 前景，等于没有形状信息。两种情况都退回矩形路径，不能拿一个错误的 mask
   * 去污染后续匹配 —— 那比没有 mask 更糟。
   */
  const ratio = opaque / (width * height);
  if (ratio < 0.18 || ratio > 0.9) return null;
  return fillTemplateAlphaHoles(result);
}

function base64ToBytes(base64: string): Uint8Array {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lookup = new Uint8Array(256);
  for (let index = 0; index < chars.length; index += 1) lookup[chars.charCodeAt(index)] = index;
  let validLength = base64.length;
  while (validLength > 0 && base64[validLength - 1] === '=') validLength -= 1;
  const outputLength = Math.floor(validLength * 3 / 4);
  const bytes = new Uint8Array(outputLength);
  let position = 0;
  for (let index = 0; index < validLength; index += 4) {
    const a = lookup[base64.charCodeAt(index)]!;
    const b = lookup[base64.charCodeAt(index + 1)]!;
    const c = lookup[base64.charCodeAt(index + 2)]!;
    const d = lookup[base64.charCodeAt(index + 3)]!;
    bytes[position++] = (a << 2) | (b >> 4);
    if (position < outputLength) bytes[position++] = ((b & 0x0f) << 4) | (c >> 2);
    if (position < outputLength) bytes[position++] = ((c & 0x03) << 6) | d;
  }
  return bytes;
}

async function decodeBlob(blob: Blob): Promise<SimpleImageData> {
  if (blob.size > MAX_IMAGE_BYTES) throw new Error('滑块图片超过允许大小');
  const bitmap = await createImageBitmap(blob);
  try {
    /*
     * 解码尺寸校验必须在这里、在建 canvas 之前做。
     *
     * blob.size 挡住的是压缩后的字节，解压炸弹（~200KB 解成 15000×15000）能一路
     * 过关；而下面的 OffscreenCanvas + getImageData 会按解码后的 width×height×4
     * 实打实分配（15000² 就是 >900MB），直接 OOM 掉 MV3 service worker，连带打断
     * 所有在跑的签到。prepareSliderImages 里的 validBackgroundImage 等解码尺寸校验
     * 要到更后面才跑 —— 那时内存早已分配，太晚了。这里用同一套像素上限
     * （MAX_IMAGE_PIXELS）先按解码尺寸拦下：抛出的错误落进 loadImageSource /
     * captureViewport 既有的 decode 失败路径，被当成普通「无法解码」处理，
     * 而 bitmap 由下面的 finally 关闭，不泄漏。
     */
    if (!Number.isFinite(bitmap.width) || !Number.isFinite(bitmap.height)
      || bitmap.width < 1 || bitmap.height < 1
      || bitmap.width * bitmap.height > MAX_IMAGE_PIXELS) {
      throw new Error('滑块图片解码尺寸无效或超过允许大小');
    }
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建滑块图像上下文');
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: image.width, height: image.height, data: image.data };
  } finally {
    bitmap.close();
  }
}

export async function decodePngBase64(base64: string): Promise<SimpleImageData> {
  const bytes = base64ToBytes(base64);
  return decodeBlob(new Blob([bytes.buffer as ArrayBuffer], { type: 'image/png' }));
}

async function loadImageSource(source: SliderImageSource): Promise<SimpleImageData> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_LOAD_TIMEOUT_MS);
  try {
    const response = await fetch(source.value, {
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`滑块图片读取失败（HTTP ${response.status}）`);
    return await decodeBlob(await response.blob());
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * CDP 截图的单步超时。
 *
 * 与 `trusted-pointer.ts` 同一条规则：debugger 的 Promise 在页面导航或
 * Service Worker 回收的边界上偶尔不会 settle，而 `fromSurface: true` 要等一帧
 * 真正合成出来，窗口被遮挡或最小化时本来就慢。不设上限的话一次不 settle
 * 就把整条签到队列占住，还留着一个挂着的调试会话。
 */
const CDP_STEP_TIMEOUT_MS = 8_000;

function withCdpTimeout<T>(operation: () => Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} 超时`));
    }, CDP_STEP_TIMEOUT_MS);
    operation().then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function captureViewport(tabId: number): Promise<SimpleImageData> {
  const target: chrome.debugger.Debuggee = { tabId };
  /*
   * 只要**发起过** attach 就要 detach：`withCdpTimeout` 只放弃等待，不取消底层
   * Promise，超时之后 `chrome.debugger.attach` 仍可能真的挂上。按「成功才 detach」
   * 写的话会话永久泄漏，而本仓库没有 onDetach 兜底 —— 此后该标签页所有 attach
   * 都被「Another debugger is already attached」拒绝。detach 未挂上的 target
   * 只会 reject，被吞掉，无害且幂等。
   */
  let attachRequested = false;
  try {
    attachRequested = true;
    await withCdpTimeout(() => chrome.debugger.attach(target, '1.3'), 'CDP debugger.attach');
    await withCdpTimeout(
      () => chrome.debugger.sendCommand(target, 'Page.bringToFront'),
      'CDP Page.bringToFront',
    );
    const result = await withCdpTimeout(
      () => chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false,
      }) as Promise<{ data?: string }>,
      'CDP Page.captureScreenshot',
    );
    if (!result.data) throw new Error('CDP 截图返回空数据');
    return await decodePngBase64(result.data);
  } finally {
    if (attachRequested) {
      await withCdpTimeout(
        () => chrome.debugger.detach(target),
        'CDP debugger.detach',
      ).catch(() => {});
    }
  }
}

function validBackgroundImage(image: SimpleImageData): boolean {
  return image.width >= 80
    && image.height >= 40
    && image.width * image.height <= MAX_IMAGE_PIXELS;
}

function validTemplateImage(image: SimpleImageData): boolean {
  return image.width >= 6
    && image.height >= 6
    && image.width * image.height <= 4_000_000;
}

function aspectRatioMatches(image: SimpleImageData, rect: SliderRect): boolean {
  const imageRatio = image.width / Math.max(1, image.height);
  const renderedRatio = rect.width / Math.max(1, rect.height);
  return Math.abs(Math.log(imageRatio / renderedRatio)) <= 0.09;
}

/** 先统一原图像素密度，再裁 alpha 包围盒，避免把 1x 碎片拿去匹配 2x 背景。 */
function resizeImage(image: SimpleImageData, width: number, height: number): SimpleImageData {
  width = Math.round(width);
  height = Math.round(height);
  if (!Number.isFinite(width) || !Number.isFinite(height)
    || width < 1 || height < 1 || width * height > MAX_IMAGE_PIXELS) {
    throw new Error('滑块图片缩放尺寸无效');
  }
  if (image.width === width && image.height === height) return image;

  const source = new OffscreenCanvas(image.width, image.height);
  const target = new OffscreenCanvas(width, height);
  const sourceContext = source.getContext('2d');
  const targetContext = target.getContext('2d');
  if (!sourceContext || !targetContext) throw new Error('无法缩放滑块图片');
  sourceContext.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
  targetContext.imageSmoothingEnabled = true;
  targetContext.imageSmoothingQuality = 'high';
  targetContext.drawImage(source, 0, 0, width, height);
  const resized = targetContext.getImageData(0, 0, width, height);
  return { width, height, data: resized.data };
}

export async function prepareSliderImages(
  tabId: number,
  info: SliderChallengeInfo,
): Promise<PreparedSliderImages> {
  if (info.backgroundSource && (info.pieceSource || info.referenceBackgroundSource)) {
    try {
      const background = await loadImageSource(info.backgroundSource);
      const [piece, referenceBackground] = await Promise.all([
        info.pieceSource ? loadImageSource(info.pieceSource).catch(() => undefined) : undefined,
        info.referenceBackgroundSource
          ? loadImageSource(info.referenceBackgroundSource).catch(() => undefined)
          : undefined,
      ]);
      if (
        validBackgroundImage(background)
        && aspectRatioMatches(background, info.backgroundRect)
        && (!piece || (validTemplateImage(piece) && (!info.pieceRect || aspectRatioMatches(piece, info.pieceRect))))
        && (!referenceBackground || (
          validBackgroundImage(referenceBackground)
          && aspectRatioMatches(referenceBackground, info.backgroundRect)
        ))
        && (piece || referenceBackground)
      ) {
        const scaleX = background.width / info.backgroundRect.width;
        const scaleY = background.height / info.backgroundRect.height;
        const normalizedPiece = piece && info.pieceRect
          ? resizeImage(piece, info.pieceRect.width * scaleX, info.pieceRect.height * scaleY)
          : piece;
        return {
          background,
          referenceBackground: referenceBackground
            ? resizeImage(referenceBackground, background.width, background.height)
            : undefined,
          template: normalizedPiece ? alphaBounds(normalizedPiece) : undefined,
          source: 'raw-image',
          imageScaleX: scaleX,
          imageScaleY: scaleY,
          // 原图不经裁剪，没有取整损失。
          cropOffsetX: 0,
          cropOffsetPieceX: 0,
        };
      }
    } catch {
      // The source may be protected or become stale during a challenge refresh.
    }
  }

  const screenshot = await captureViewport(tabId);
  const scaleX = screenshot.width / info.viewportWidth;
  const scaleY = screenshot.height / info.viewportHeight;
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX < 0.25 || scaleY < 0.25 || scaleX > 8 || scaleY > 8) {
    throw new Error('无法建立截图像素与页面坐标的比例');
  }

  const rawBackgroundX = info.backgroundRect.x * scaleX;
  const backgroundRect = {
    x: rawBackgroundX,
    y: info.backgroundRect.y * scaleY,
    width: info.backgroundRect.width * scaleX,
    height: info.backgroundRect.height * scaleY,
  };
  const background = cropRegion(screenshot, backgroundRect);
  // cropRegion 内部对 x 取整；把丢掉的小数带出去，换算时减掉。
  const cropOffsetX = rawBackgroundX - Math.round(rawBackgroundX);

  let template: TemplateDescriptor | undefined;
  let cropOffsetPieceX = 0;
  if (info.pieceRect) {
    const rawPieceX = info.pieceRect.x * scaleX;
    const piece = cropRegion(screenshot, {
      x: rawPieceX,
      y: info.pieceRect.y * scaleY,
      width: info.pieceRect.width * scaleX,
      height: info.pieceRect.height * scaleY,
    });
    cropOffsetPieceX = rawPieceX - Math.round(rawPieceX);
    /**
     * 截图裁出来的拼图块是不透明矩形，先尝试推断真实形状。
     *
     * 不做这一步时匹配退化成矩形边缘对比，在多缺口图上几乎等于随机选 ——
     * 见 inferAlphaFromOpaqueCrop 的注释。
     */
    const shaped = inferAlphaFromOpaqueCrop(piece);
    template = alphaBounds(shaped ?? piece);
  }

  return {
    background,
    template,
    source: 'viewport-screenshot',
    // 裁剪只取整边界，不会缩放像素；不能用裁后整数宽高重新推算比例。
    imageScaleX: scaleX,
    imageScaleY: scaleY,
    cropOffsetX,
    cropOffsetPieceX,
  };
}

let cvWorkerPromise: Promise<Worker | null> | null = null;
/** 已经 terminate 掉的 worker：缓存必须连带失效，否则后续调用全打在死 worker 上。 */
let cvWorkerDead = false;

/**
 * 丢弃当前 worker 缓存。
 *
 * 缺了这一步的后果是**永久性**的：`getCvWorker` 的缓存只按「有没有 promise」判断，
 * 一旦 worker 崩溃被 terminate，缓存里留下的仍是那个死 worker 对象。此后每次
 * `matchTemplateWithOpenCV` 都往死 worker post 消息 —— 不抛错、也永不回消息 ——
 * 直到 12 秒超时返回 null。`locateSliderGap` 是 `await` 它的，于是每一轮静态路径
 * 都白等 12 秒，5 次尝试里两轮就吃掉 24 秒，而 `SOLVE_DEADLINE_MS` 只有 55 秒。
 */
function discardCvWorker(worker: Worker): void {
  cvWorkerDead = true;
  cvWorkerPromise = null;
  try {
    worker.terminate();
  } catch {
    // 已经终止或上下文已销毁，无需处理。
  }
}

function getCvWorker(): Promise<Worker | null> {
  // 加载/初始化失败过就不再重试：worker.js 缺失或 opencv.js 加载不了是确定性的，
  // 每次签到都重新 new Worker 只是白等 8 秒。而崩溃（onerror）会清掉 promise，
  // 走的是下面 cvWorkerDead 的分支。
  if (cvWorkerPromise) return cvWorkerPromise;
  if (cvWorkerDead) return Promise.resolve(null);
  cvWorkerPromise = new Promise((resolve) => {
    try {
      const worker = new Worker(chrome.runtime.getURL('opencv/worker.js'));
      const timeout = setTimeout(() => {
        discardCvWorker(worker);
        resolve(null);
      }, 8_000);
      const onReady = (event: MessageEvent) => {
        // 只处理握手消息；匹配结果由 matchTemplateWithOpenCV 自己的监听器接。
        if (event.data !== 'ready' && event.data !== 'error') return;
        clearTimeout(timeout);
        worker.removeEventListener('message', onReady);
        if (event.data === 'ready') resolve(worker);
        else {
          discardCvWorker(worker);
          resolve(null);
        }
      };
      worker.addEventListener('message', onReady);
      // onerror 长期挂着：worker 在**任何时候**崩溃都要让缓存失效，
      // 而不只是在握手阶段。
      worker.addEventListener('error', () => {
        clearTimeout(timeout);
        discardCvWorker(worker);
        resolve(null);
      });
    } catch {
      cvWorkerDead = true;
      cvWorkerPromise = null;
      resolve(null);
    }
  });
  return cvWorkerPromise;
}

async function matchTemplateWithOpenCV(
  search: SimpleImageData,
  template: SimpleImageData,
  useMask = false,
): Promise<NCCResult | null> {
  const worker = await getCvWorker();
  if (!worker) return null;
  const id = `slider-match-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    /*
     * 用 addEventListener + 自己摘掉，而不是赋值 `worker.onmessage`。
     *
     * 赋值会**覆盖**上一次调用的监听器：两次匹配并发时，先发起的那次回调被后一次
     * 顶掉，而 worker 回的消息带着前一次的 id，后一次的监听器按 id 不匹配直接
     * `return` —— 前一次于是永远等不到回包，白等 12 秒超时。这里每次调用挂自己的
     * 监听器、拿到自己的 id 就摘掉，互不干扰。
     */
    const settle = (result: NCCResult | null) => {
      clearTimeout(timeout);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      resolve(result);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.data?.id !== id) return;
      // maskUnsupported：本 OpenCV 构建不接受 masked TM_CCOEFF_NORMED。
      // 形状模板此时必须放弃这一路 —— 无 mask 结果会把透明区当黑色实心，
      // 给出一个看似正常实则错位的候选。JS 的 alpha 感知 NCC 会接手。
      if (event.data.error || event.data.uniform || event.data.maskUnsupported) settle(null);
      else settle({ x: event.data.x, y: event.data.y, confidence: event.data.maxVal });
    };
    // worker 在匹配途中崩溃：立刻结束本次等待，并让缓存失效，
    // 否则下一次调用还会打在这个已死的 worker 上。
    const onError = () => {
      discardCvWorker(worker);
      settle(null);
    };
    const timeout = setTimeout(() => {
      /*
       * 超时说明这个 worker 已经不响应了（OpenCV 在大图上跑飞、或 wasm 卡死）。
       * 留着它下一轮还会再等 12 秒，所以连带丢弃缓存。
       */
      discardCvWorker(worker);
      settle(null);
    }, 12_000);
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    const searchData = new ImageData(new Uint8ClampedArray(search.data), search.width, search.height);
    const templateData = new ImageData(new Uint8ClampedArray(template.data), template.width, template.height);
    try {
      worker.postMessage(
        // useMask 让 worker 用模板 alpha 通道做 mask 匹配；不支持该重载的
        // OpenCV 构建会自行回退到无 mask 调用。
        { id, search: searchData, template: templateData, useMask },
        [searchData.data.buffer, templateData.data.buffer],
      );
    } catch {
      // worker 已被终止，或 buffer 已被 transfer 掉。
      discardCvWorker(worker);
      settle(null);
    }
  });
}

function sobelMagnitude(image: SimpleImageData): Float32Array {
  const gray = buildGray(image);
  const result = new Float32Array(image.width * image.height);
  for (let y = 1; y < image.height - 1; y += 1) {
    for (let x = 1; x < image.width - 1; x += 1) {
      const topLeft = gray[(y - 1) * image.width + x - 1]!;
      const top = gray[(y - 1) * image.width + x]!;
      const topRight = gray[(y - 1) * image.width + x + 1]!;
      const left = gray[y * image.width + x - 1]!;
      const right = gray[y * image.width + x + 1]!;
      const bottomLeft = gray[(y + 1) * image.width + x - 1]!;
      const bottom = gray[(y + 1) * image.width + x]!;
      const bottomRight = gray[(y + 1) * image.width + x + 1]!;
      const gx = -topLeft + topRight - 2 * left + 2 * right - bottomLeft + bottomRight;
      const gy = -topLeft - 2 * top - topRight + bottomLeft + 2 * bottom + bottomRight;
      result[y * image.width + x] = Math.hypot(gx, gy);
    }
  }
  return result;
}

function contourPoints(template: TemplateDescriptor): Array<{ x: number; y: number }> {
  const { image } = template;
  const points: Array<{ x: number; y: number }> = [];
  if (!template.shapedAlpha) {
    for (let x = 1; x < image.width - 1; x += 2) {
      points.push({ x, y: 1 }, { x, y: image.height - 2 });
    }
    for (let y = 2; y < image.height - 2; y += 2) {
      points.push({ x: 1, y }, { x: image.width - 2, y });
    }
    return points;
  }

  const opaqueAt = (x: number, y: number) => (
    x >= 0
    && y >= 0
    && x < image.width
    && y < image.height
    && image.data[(y * image.width + x) * 4 + 3]! >= 24
  );
  for (let y = 1; y < image.height - 1; y += 1) {
    for (let x = 1; x < image.width - 1; x += 1) {
      if (!opaqueAt(x, y)) continue;
      if (!opaqueAt(x - 1, y) || !opaqueAt(x + 1, y) || !opaqueAt(x, y - 1) || !opaqueAt(x, y + 1)) {
        points.push({ x, y });
      }
    }
  }
  return points;
}

function edgeContourMatch(
  search: SimpleImageData,
  template: TemplateDescriptor,
  minimumGapX: number,
  yHint: number,
  /** `yHint` 不可信时搜全部行，见 locateSliderGap 里的 yHintKnown。 */
  searchAllRows = false,
): MatchCandidate | null {
  const points = contourPoints(template);
  const tw = template.image.width;
  const th = template.image.height;
  if (points.length < 18 || tw >= search.width || th >= search.height) return null;
  const gradient = sobelMagnitude(search);
  const minX = Math.max(0, Math.round(minimumGapX));
  const maxX = search.width - tw;
  const yTolerance = Math.max(4, Math.round(th * 0.22));
  const minY = searchAllRows ? 0 : Math.max(0, Math.round(yHint - yTolerance));
  const maxY = searchAllRows
    ? search.height - th
    : Math.min(search.height - th, Math.round(yHint + yTolerance));
  if (minX > maxX || minY > maxY) return null;

  const columns = maxX - minX + 1;
  const rows = maxY - minY + 1;
  /*
   * 操作数上限：与 outlineProfileMatch 同一套 ~90M 预算。
   *
   * 下面的双层扫描每个候选位都要遍历一遍 points（轮廓采样点），没有上限时
   * 一张 4000×4000、又拿不到 pieceRect（yHint 不可信 → 搜全部行）的背景会驱动
   * columns×rows×points 量级的同步运算 —— 数十亿次，把 service worker 冻住几十
   * 秒，连带打断整条签到队列。超预算直接放弃这一路（返回 null），交给其它匹配器。
   */
  if (columns * rows * points.length > 90_000_000) return null;
  const scores = new Float32Array(columns * rows);
  let bestIndex = -1;
  let bestScore = -Infinity;
  let sum = 0;
  let squareSum = 0;

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      let edgeSum = 0;
      let covered = 0;
      for (const point of points) {
        const magnitude = gradient[(y + point.y) * search.width + x + point.x]!;
        edgeSum += Math.min(1020, magnitude);
        if (magnitude >= 90) covered += 1;
      }
      const mean = edgeSum / points.length / 1020;
      const coverage = covered / points.length;
      const score = mean * 0.72 + coverage * 0.28;
      const index = (y - minY) * columns + x - minX;
      scores[index] = score;
      sum += score;
      squareSum += score * score;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
  }

  if (bestIndex < 0) return null;
  const count = scores.length;
  const mean = sum / count;
  const standardDeviation = Math.sqrt(Math.max(0, squareSum / count - mean * mean));
  const zScore = standardDeviation > 0 ? (bestScore - mean) / standardDeviation : 0;
  const runnerUp = runnerUpMargin(
    scores,
    columns,
    bestIndex,
    Math.max(3, Math.round(tw * 0.3)),
    Math.max(2, Math.round(th * 0.25)),
  );
  const rawMargin = runnerUp.margin ?? 0;
  const relativeMargin = rawMargin / Math.max(0.01, Math.abs(bestScore));
  const confidence = Math.max(0, Math.min(0.99, 0.32 + zScore * 0.065 + relativeMargin * 1.8));
  if (zScore < 1.25 || confidence < 0.46) return null;

  return {
    x: minX + bestIndex % columns,
    y: minY + Math.floor(bestIndex / columns),
    confidence,
    confidenceMargin: relativeMargin,
    candidateCount: runnerUp.candidateCount,
    method: template.shapedAlpha ? 'contour-alpha' : 'contour-edge',
  };
}

function backgroundDifferenceMatch(
  background: SimpleImageData,
  reference: SimpleImageData,
  template: TemplateDescriptor,
  minimumGapX: number,
  yHint: number,
  searchAllRows: boolean,
): MatchCandidate | null {
  if (background.width !== reference.width || background.height !== reference.height) return null;
  const tw = template.image.width;
  const th = template.image.height;
  if (tw >= background.width || th >= background.height) return null;

  const difference = new Float32Array(background.width * background.height);
  const integralWidth = background.width + 1;
  const integral = new Float64Array((background.width + 1) * (background.height + 1));
  let significantPixels = 0;
  for (let y = 0; y < background.height; y += 1) {
    let rowSum = 0;
    for (let x = 0; x < background.width; x += 1) {
      const pixel = y * background.width + x;
      const offset = pixel * 4;
      const value = (
        Math.abs(background.data[offset]! - reference.data[offset]!)
        + Math.abs(background.data[offset + 1]! - reference.data[offset + 1]!)
        + Math.abs(background.data[offset + 2]! - reference.data[offset + 2]!)
      ) / 3;
      difference[pixel] = value;
      if (value >= 20) significantPixels += 1;
      rowSum += value;
      integral[(y + 1) * integralWidth + x + 1] = integral[y * integralWidth + x + 1]! + rowSum;
    }
  }
  const significantRatio = significantPixels / difference.length;
  if (significantRatio < 0.002 || significantRatio > 0.35) return null;

  const maskPoints: Array<{ x: number; y: number }> = [];
  if (template.shapedAlpha) {
    for (let y = 0; y < th; y += 2) {
      for (let x = 0; x < tw; x += 2) {
        if (template.image.data[(y * tw + x) * 4 + 3]! >= 24) maskPoints.push({ x, y });
      }
    }
  }
  const windowSum = (x: number, y: number) => {
    if (maskPoints.length > 0) {
      let sum = 0;
      for (const point of maskPoints) sum += difference[(y + point.y) * background.width + x + point.x]!;
      return sum / maskPoints.length;
    }
    const right = x + tw;
    const bottom = y + th;
    const sum = integral[bottom * integralWidth + right]!
      - integral[y * integralWidth + right]!
      - integral[bottom * integralWidth + x]!
      + integral[y * integralWidth + x]!;
    return sum / (tw * th);
  };

  const minX = Math.max(0, Math.round(minimumGapX));
  const maxX = background.width - tw;
  const tolerance = Math.max(5, Math.round(th * 0.3));
  const minY = searchAllRows ? 0 : Math.max(0, Math.round(yHint - tolerance));
  const maxY = searchAllRows
    ? background.height - th
    : Math.min(background.height - th, Math.round(yHint + tolerance));
  if (minX > maxX || minY > maxY) return null;

  const columns = maxX - minX + 1;
  const rows = maxY - minY + 1;
  /*
   * 操作数上限：与 outlineProfileMatch 同一套 ~90M 预算。
   *
   * 带 mask 的分支里 windowSum 每个候选位要遍历一遍 maskPoints，没有上限时大图
   * （如 4000×4000、yHint 不可信搜全部行）会驱动 columns×rows×maskPoints 量级的
   * 同步运算 —— 数十亿次，冻住 service worker。无 mask 分支靠积分图是 O(1)，
   * 用 max(1, …) 兜底即可。超预算放弃这一路，返回 null。
   */
  if (columns * rows * Math.max(1, maskPoints.length) > 90_000_000) return null;
  const scores = new Float32Array(columns * rows);
  let bestIndex = -1;
  let bestScore = -Infinity;
  let sum = 0;
  let squareSum = 0;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const score = windowSum(x, y);
      const index = (y - minY) * columns + x - minX;
      scores[index] = score;
      sum += score;
      squareSum += score * score;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
  }
  if (bestIndex < 0 || bestScore < 6) return null;

  const mean = sum / scores.length;
  const standardDeviation = Math.sqrt(Math.max(0, squareSum / scores.length - mean * mean));
  const zScore = standardDeviation > 0 ? (bestScore - mean) / standardDeviation : 0;
  const runnerUp = runnerUpMargin(
    scores,
    columns,
    bestIndex,
    Math.max(3, Math.round(tw * 0.35)),
    Math.max(3, Math.round(th * 0.35)),
  );
  const relativeMargin = (runnerUp.margin ?? 0) / Math.max(1, bestScore);
  const confidence = Math.max(0, Math.min(
    0.995,
    0.48 + Math.min(0.24, zScore * 0.045) + Math.min(0.2, relativeMargin * 1.8) + Math.min(0.06, bestScore / 500),
  ));
  if (zScore < 1.4 || confidence < 0.55) return null;

  return {
    x: minX + bestIndex % columns,
    y: minY + Math.floor(bestIndex / columns),
    confidence,
    confidenceMargin: relativeMargin,
    candidateCount: runnerUp.candidateCount,
    method: 'background-delta',
  };
}

interface SilhouetteSamples {
  /** 轮廓**内部**的采样点（四邻也在内，避开抗锯齿边） */
  inside: Array<{ x: number; y: number }>;
  /** 包围盒内、轮廓**外部**的采样点（拼图块的四角空白） */
  outside: Array<{ x: number; y: number }>;
  /**
   * 沿轮廓边界的**成对**采样点：每对一个刚好在里、一个刚好在外。
   *
   * 这是区分「哪个缺口装得进这块碎片」的唯一判据。多缺口图上每个缺口的
   * 凸起方向都不同（用户截图：左凸右、中凸上、右凸左上），而「形状内平坦
   * ＋形状外有纹理」两个缺口**都满足** —— 所以那两项分不出对错。
   *
   * 位置正确时，每一对的内外灰度差都很大且方向一致（内是填充色、外是图像）；
   * 位置错了则有相当比例的对落在「内外都是填充」或「内外都是图像」上，
   * 一致性立刻掉下来。检验的是轮廓**形状**，不再是区域统计。
   */
  boundary: Array<{ inX: number; inY: number; outX: number; outY: number }>;
}

/**
 * 按拼图块的 alpha 轮廓分出「形状内」和「形状外」两组采样点。
 *
 * 两组都要：只看形状内不足以区分「真缺口」和「随便一块暗色区域」，
 * 必须同时确认形状**外**是正常图像内容 —— 那正是凸起与凹槽位置对不对的判据。
 */
function silhouetteSamples(template: TemplateDescriptor, step = 2): SilhouetteSamples {
  const { image } = template;
  const inside: Array<{ x: number; y: number }> = [];
  const outside: Array<{ x: number; y: number }> = [];
  const boundary: SilhouetteSamples['boundary'] = [];
  const alphaAt = (x: number, y: number): number => (
    x >= 0 && y >= 0 && x < image.width && y < image.height
      ? image.data[(y * image.width + x) * 4 + 3]!
      : 0
  );
  const solidCore = (x: number, y: number) => alphaAt(x - 1, y) >= 200
    && alphaAt(x + 1, y) >= 200 && alphaAt(x, y - 1) >= 200 && alphaAt(x, y + 1) >= 200;
  const emptyCore = (x: number, y: number) => alphaAt(x - 1, y) <= 12
    && alphaAt(x + 1, y) <= 12 && alphaAt(x, y - 1) <= 12 && alphaAt(x, y + 1) <= 12;

  for (let y = 0; y < image.height; y += step) {
    for (let x = 0; x < image.width; x += step) {
      const alpha = alphaAt(x, y);
      if (alpha >= 200 && solidCore(x, y)) inside.push({ x, y });
      else if (alpha <= 12 && emptyCore(x, y)) outside.push({ x, y });
    }
  }

  /*
   * 沿轮廓取成对采样点：不透明像素，且四邻里至少有一个是透明的（即边界上），
   * 就沿那个方向往外 2px 取配对点，往内 2px 取内侧点。
   *
   * 间隔比区域采样密一些（step 的一半）：轮廓上的点本来就少，而它承载的是
   * 最关键的判据。
   */
  const boundaryStep = Math.max(1, Math.round(step / 2));
  const offsets = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;
  for (let y = 1; y < image.height - 1; y += boundaryStep) {
    for (let x = 1; x < image.width - 1; x += boundaryStep) {
      if (alphaAt(x, y) < 200) continue;
      for (const [dx, dy] of offsets) {
        if (alphaAt(x + dx, y + dy) > 12) continue;
        // 沿法线往外 2px、往内 2px，跨过抗锯齿带
        const outX = x + dx * 2;
        const outY = y + dy * 2;
        const inX = x - dx * 2;
        const inY = y - dy * 2;
        // 两侧都要落在模板内，且内侧确实还在轮廓里
        if (outX < 0 || outY < 0 || outX >= image.width || outY >= image.height) continue;
        if (inX < 0 || inY < 0 || inX >= image.width || inY >= image.height) continue;
        if (alphaAt(inX, inY) < 200) continue;
        boundary.push({ inX, inY, outX, outY });
        break;
      }
    }
  }

  return { inside, outside, boundary };
}

/** 一个区域的灰度均值与标准差（供形状吻合匹配用） */
function grayStats(
  gray: Float32Array,
  width: number,
  originX: number,
  originY: number,
  points: ReadonlyArray<{ x: number; y: number }>,
): { mean: number; std: number } {
  let sum = 0;
  let squareSum = 0;
  for (const point of points) {
    const value = gray[(originY + point.y) * width + originX + point.x]!;
    sum += value;
    squareSum += value * value;
  }
  const mean = sum / points.length;
  return { mean, std: Math.sqrt(Math.max(0, squareSum / points.length - mean * mean)) };
}

/**
 * 按拼图块轮廓找「形状真正吻合的缺口」。
 *
 * 这是为多缺口验证码写的：同一张背景图上画 2–3 个拼图形状，只有一个能装进
 * 当前这块。`edgeContourMatch` 只统计轮廓上的梯度强度 —— 任何暗色块的**边界**
 * 都能拿高分，不检验形状本身，于是三个形状全部命中、分数都在 0.65–0.75，
 * 等于随机选（实测 hvoy.ai 连续 5 次全错，每次落在不同形状上）。
 *
 * 这里同时检验三件事，只有形状真正吻合时才会同时成立：
 *  1. **形状内是缺口填充** —— 暗、且平（缺口是纯色块，方差很小）
 *  2. **形状外是图像内容** —— 亮、有纹理（凸起/凹槽错位时这里会落到填充色上）
 *  3. **内外反差足够大** —— 单看任一侧都可能被暗色的图像内容骗过去
 *
 * 缺口比周围亮的站点同样支持（取反差绝对值），但深色是主流。
 */
export function holeSilhouetteMatch(
  background: SimpleImageData,
  template: TemplateDescriptor,
  minimumGapX: number,
  yHint: number,
  searchAllRows = false,
): MatchCandidate | null {
  if (!template.shapedAlpha) return null;
  const tw = template.image.width;
  const th = template.image.height;
  if (tw >= background.width || th >= background.height) return null;

  const samples = silhouetteSamples(template);
  // 采样点太少说明轮廓提取本身不可靠，不要拿它下结论。
  if (samples.inside.length < 24 || samples.outside.length < 12) return null;
  // 边界对是分辨「哪个缺口装得进」的唯一判据，太少就不要假装能分辨。
  if (samples.boundary.length < 20) return null;

  const gray = buildGray(background);
  const minX = Math.max(0, Math.round(minimumGapX));
  const maxX = background.width - tw;
  const tolerance = Math.max(4, Math.round(th * 0.25));
  const minY = searchAllRows ? 0 : Math.max(0, Math.round(yHint - tolerance));
  const maxY = searchAllRows
    ? background.height - th
    : Math.min(background.height - th, Math.round(yHint + tolerance));
  if (minX > maxX || minY > maxY) return null;

  const columns = maxX - minX + 1;
  const rows = maxY - minY + 1;
  /*
   * 操作数上限：与 outlineProfileMatch 同一套 ~90M 预算。
   *
   * 下面的双层扫描每个候选位都要跑两次 grayStats（inside/outside），再遍历一遍
   * boundary 对，没有上限时大图（如 4000×4000、yHint 不可信搜全部行）会驱动
   * columns×rows×(inside+outside+boundary) 量级的同步运算 —— 数十亿次，冻住
   * service worker，连带打断整条签到队列。超预算直接放弃形状吻合这一路
   * （返回 null），退回更弱但有界的匹配器。
   */
  const sampleCost = samples.inside.length + samples.outside.length + samples.boundary.length;
  if (columns * rows * sampleCost > 90_000_000) return null;
  const scores = new Float32Array(columns * rows);
  scores.fill(Number.NEGATIVE_INFINITY);
  let bestIndex = -1;
  let bestScore = -Infinity;
  let scored = 0;
  let scoreSum = 0;
  let scoreSquareSum = 0;
  /** 最佳位置的边界吻合度：它必须能压住置信度，否则 z 分数会把它掩盖掉。 */
  let bestBoundaryFit = 0;

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const insideStats = grayStats(gray, background.width, x, y, samples.inside);
      const outsideStats = grayStats(gray, background.width, x, y, samples.outside);

      const contrast = Math.abs(outsideStats.mean - insideStats.mean) / 255;
      // 缺口是纯色填充：形状内越平越像缺口。40 灰阶以内算平。
      const flatness = 1 - Math.min(1, insideStats.std / 40);
      // 形状外应该是正常图像内容，有纹理。完全平坦说明这里也是填充色 ——
      // 那意味着形状选大了或位置偏了。
      const exteriorTexture = Math.min(1, outsideStats.std / 18);

      if (contrast < 0.08 || insideStats.std > 46) continue;

      /*
       * 边界吻合度：沿轮廓每一对采样点的内外灰度差是否**同向且一致**。
       *
       * 这是分辨多缺口的关键。上面三项（内外反差、内部平坦、外部纹理）用的
       * 是**区域统计**，而同一张图上凸起方向不同的两个缺口在这三项上几乎
       * 一样 —— 都是「暗色平坦块嵌在有纹理的图里」。实测 hvoy 因此在两个
       * 缺口之间随机选，拖过去被判「验证错误，请重试」。
       *
       * 位置正确时，轮廓上**每一点**都恰好跨在填充与图像的分界上，
       * 于是每对的差值同号、比例接近 1。位置错了（凸起压在图像上、
       * 凹槽露出填充色）就会有相当比例的对反号或差值极小。
       *
       * 用符号一致率而不是平均差值：平均值会被少数强边缘拉高，掩盖掉
       * 「大部分点都不对」这个事实。
       */
      const expectedSign = Math.sign(outsideStats.mean - insideStats.mean);
      /*
       * 按空间分格统计，取**最差那一格**，而不是全局比例。
       *
       * 实测量过：凸起方向不同的两个拼图形状，轮廓上仍有 **82%** 的点互相
       * 吻合 —— 因为它们共用同一个方形主体，只有凸起那一小段（约 18%）不同。
       * 全局比例把这 18% 稀释掉了，0.82 和 1.0 在加权评分里只差 8 分，
       * 其它三项轻易就能盖过去。
       *
       * 而凸起的不吻合是**空间聚集**的：错位时那一格里的点几乎全错。
       * 把模板切成 3×3，取样本足够的格子里的最小吻合率 —— 凸起占 1–2 格，
       * 它一差，最小值立刻掉下来，与全局比例无关。
       */
      const BINS = 3;
      const binAgree = new Int32Array(BINS * BINS);
      const binTotal = new Int32Array(BINS * BINS);
      for (const pair of samples.boundary) {
        const inValue = gray[(y + pair.inY) * background.width + x + pair.inX]!;
        const outValue = gray[(y + pair.outY) * background.width + x + pair.outX]!;
        const delta = outValue - inValue;
        const bin = Math.min(BINS - 1, Math.floor(pair.inX / tw * BINS))
          + Math.min(BINS - 1, Math.floor(pair.inY / th * BINS)) * BINS;
        binTotal[bin]! += 1;
        // 差值太小算不上边界；同号且够大才算这一点吻合
        if (Math.abs(delta) >= 12 && Math.sign(delta) === expectedSign) binAgree[bin]! += 1;
      }
      let worstBin = 1;
      let usableBins = 0;
      for (let bin = 0; bin < binTotal.length; bin += 1) {
        // 样本太少的格子（轮廓没经过）不参与，否则会被 0/0 或个别点主导
        if (binTotal[bin]! < 5) continue;
        usableBins += 1;
        worstBin = Math.min(worstBin, binAgree[bin]! / binTotal[bin]!);
      }
      // 可用格子太少说明轮廓集中在一小片，分格失去意义 —— 不下结论
      if (usableBins < 4) continue;
      const boundaryFit = worstBin;
      // 任何一格里过半的点都对不上，说明形状没套准（凸起压在图像上、
      // 或凹槽露出填充色）—— 直接排除，不让它靠区域统计的高分混进候选。
      if (boundaryFit < 0.55) continue;

      const score = boundaryFit * 0.45
        + contrast * 0.25
        + flatness * 0.18
        + exteriorTexture * 0.12;
      const index = (y - minY) * columns + x - minX;
      scores[index] = score;
      scored += 1;
      scoreSum += score;
      scoreSquareSum += score * score;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
        bestBoundaryFit = boundaryFit;
      }
    }
  }

  if (bestIndex < 0) return null;
  const mean = scoreSum / scored;
  const standardDeviation = Math.sqrt(Math.max(0, scoreSquareSum / scored - mean * mean));
  const zScore = standardDeviation > 0 ? (bestScore - mean) / standardDeviation : 0;
  const runnerUp = runnerUpMargin(
    scores,
    columns,
    bestIndex,
    Math.max(3, Math.round(tw * 0.4)),
    Math.max(3, Math.round(th * 0.3)),
  );
  const relativeMargin = runnerUp.margin == null
    ? undefined
    : runnerUp.margin / Math.max(0.01, bestScore);
  /*
   * 置信度以「内外反差 + 形状平坦度」为主体，再用 z 分数和次优差距加成。
   * 基线取 0.42：形状吻合本身就是比边缘能量强得多的证据，但仍要求它
   * 明显优于同一张图上的其它位置才给高分。
   */
  const rawConfidence = Math.max(0, Math.min(
    0.99,
    0.42 + bestScore * 0.38 + Math.min(0.18, zScore * 0.05) + Math.min(0.16, (relativeMargin ?? 0) * 1.6),
  ));
  /**
   * 边界吻合度**封顶**置信度，不只是加权项。
   *
   * 上一版把它当成评分里的一项，然后靠 z 分数和次优差距加成 —— 而全图只有
   * 一个候选时 z 分数自动很高（没有别的位置可比），于是一个「轮廓只对上一半」
   * 的位置照样拿到 0.995。测试直接抓到了这个：碎片凸起在上、图上唯一的缺口
   * 凸起在左，装不进去，却被判成高置信度命中 —— 拖过去必然被站点判
   * 「验证错误，请重试」（用户截图）。
   *
   * 现在让吻合度直接决定上限：轮廓全对才允许接近 1，对上七成封在 0.72
   * （低于 `locateSliderGap` 里 0.66 的权威门槛之上一点，仍需其它方法印证），
   * 只对上一半封在 0.5（低于最低门槛，等于拒绝）。
   */
  const confidence = Math.min(rawConfidence, 0.28 + bestBoundaryFit * 0.71);
  /**
   * 边界吻合度高到接近满分时，不再要求 z 分数。
   *
   * z 分数衡量的是「最佳位置比同图其它位置好多少」。加了分格边界检验之后，
   * 对不上的位置在评分阶段就被 `continue` 掉了 —— 实测只剩 9 个存活位置
   * （全是正确缺口周围 ±几像素的抖动），它们分数几乎相同，标准差极小，
   * z 分数自然上不去。于是**正确答案也被 z 分数门槛挡掉**，
   * `holeSilhouetteMatch` 返回 null，流程退回更弱的 `contour-alpha`。
   *
   * 这是引入新判据后必须调整的连带项：筛得越准，存活样本越少也越同质，
   * 「显著优于其它位置」这个统计判据就越不适用。轮廓每一格都对上本身
   * 就是强于 z 分数的证据。
   */
  const boundaryDecisive = bestBoundaryFit >= 0.92;
  if (!boundaryDecisive && zScore < 1.1) return null;
  if (confidence < 0.5) return null;

  return {
    x: minX + bestIndex % columns,
    y: minY + Math.floor(bestIndex / columns),
    confidence,
    confidenceMargin: relativeMargin,
    candidateCount: runnerUp.candidateCount,
    method: 'hole-silhouette',
  };
}

interface OutlineProfilePoint {
  x: number;
  y: number;
  /** 边界法线是否沿 X 轴；水平边的法线沿 Y 轴。 */
  normalX: boolean;
  /** 从外侧朝拼图内部的方向。 */
  normalSign: 1 | -1;
  bin: number;
}

/** 四条边各分三段，凸起/凹口所在段单独计分，不被其它直边稀释。 */
function outlineProfilePoints(template: TemplateDescriptor): OutlineProfilePoint[] {
  const { width, height, data } = template.image;
  const points: OutlineProfilePoint[] = [];
  const solid = (x: number, y: number) => data[(y * width + x) * 4 + 3]! >= 128;
  for (let side = 0; side < 4; side += 1) {
    const horizontalSide = side < 2;
    const alongLength = horizontalSide ? width : height;
    const depthLength = horizontalSide ? height : width;
    const sampleCount = Math.min(36, Math.max(9, alongLength - 2));
    const normalX = !horizontalSide;
    const normalSign: 1 | -1 = side === 0 || side === 2 ? 1 : -1;
    for (let sample = 0; sample < sampleCount; sample += 1) {
      const along = Math.min(
        alongLength - 2,
        Math.max(1, 1 + Math.round((sample + 0.5) * (alongLength - 2) / sampleCount)),
      );
      for (let depth = 0; depth < depthLength; depth += 1) {
        const across = normalSign > 0 ? depth : depthLength - 1 - depth;
        const x = horizontalSide ? along : across;
        const y = horizontalSide ? across : along;
        if (!solid(x, y)) continue;
        points.push({
          x,
          y,
          normalX,
          normalSign,
          bin: side * 3 + Math.min(2, Math.floor(sample / sampleCount * 3)),
        });
        break;
      }
    }
  }
  // 不透明矩形即使有透明留边，也不提供区分不同拼图形状的证据。
  const shaped = [0, 1, 2, 3].some((side) => {
    const depths = points.filter((point) => Math.floor(point.bin / 3) === side)
      .map((point) => point.normalX ? point.x : point.y);
    return depths.length >= 4
      && Math.max(...depths) - Math.min(...depths) >= Math.max(3, Math.min(width, height) * 0.07);
  });
  return shaped ? points : [];
}

/** 按完整外轮廓匹配带描边、半透明的缺口，不要求缺口内部是纯色。 */
export function outlineProfileMatch(
  background: SimpleImageData,
  template: TemplateDescriptor,
  minimumGapX: number,
  yHint: number,
  searchAllRows = false,
  excluded: readonly ExcludedGap[] = [],
): MatchCandidate | null {
  if (!template.shapedAlpha) return null;
  const { width: tw, height: th } = template.image;
  if (tw >= background.width || th >= background.height) return null;
  const points = outlineProfilePoints(template);
  const totals = new Uint16Array(12);
  for (const point of points) totals[point.bin]! += 1;
  // 小尺寸模板在每个三等分区可能只有两个稳定采样点；要求三个会让真实
  // 的浅凸起/浅凹口直接退化为矩形边缘匹配。深凹口还可能让某个分区完全
  // 没有从外侧看到实体，因此只要求每条边仍有足够的有效分区。
  const activeBins = Array.from(totals, (total, bin) => ({ total, bin }))
    .filter(({ total }) => total >= 2)
    .map(({ bin }) => bin);
  const sideCounts = [0, 1, 2, 3].map((side) => activeBins.filter((bin) => Math.floor(bin / 3) === side).length);
  if (points.length < 24 || activeBins.length < 8 || sideCounts.some((count) => count < 2)) return null;

  const radius = Math.max(1, Math.min(3, Math.round(Math.min(tw, th) / 48)));
  const minX = Math.max(0, Math.ceil(minimumGapX));
  const maxX = background.width - tw;
  const tolerance = Math.max(3, Math.round(th * 0.18));
  const minY = Math.max(0, searchAllRows ? 0 : Math.floor(yHint - tolerance));
  const maxY = Math.min(background.height - th,
    searchAllRows ? background.height - th : Math.ceil(yHint + tolerance));
  if (minX > maxX || minY > maxY) return null;
  const columns = maxX - minX + 1;
  const rows = maxY - minY + 1;
  if (columns * rows * points.length * (radius * 2 + 1) > 90_000_000) return null;

  const gray = buildGray(background);
  // gx 是垂直边的法线响应，gy 是水平边的法线响应。
  const xNormalEdges = new Float32Array(gray.length);
  const yNormalEdges = new Float32Array(gray.length);
  const width = background.width;
  for (let y = 1; y < background.height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const gx = Math.abs(gray[i - width + 1]! + 2 * gray[i + 1]! + gray[i + width + 1]!
        - gray[i - width - 1]! - 2 * gray[i - 1]! - gray[i + width - 1]!);
      const gy = Math.abs(gray[i + width - 1]! + 2 * gray[i + width]! + gray[i + width + 1]!
        - gray[i - width - 1]! - 2 * gray[i - width]! - gray[i - width + 1]!);
      xNormalEdges[i] = Math.max(0, gx - gy * 0.3);
      yNormalEdges[i] = Math.max(0, gy - gx * 0.3);
    }
  }

  const scores = new Float32Array(columns * rows);
  scores.fill(Number.NEGATIVE_INFINITY);
  const agreements = new Uint16Array(12);
  const edgeValue = (
    edges: Float32Array,
    baseX: number,
    baseY: number,
    offset: number,
    normalX: boolean,
  ): number => {
    const sampleX = normalX ? baseX + offset : baseX;
    const sampleY = normalX ? baseY : baseY + offset;
    if (sampleX < 0 || sampleY < 0 || sampleX >= width || sampleY >= background.height) return 0;
    return edges[sampleY * width + sampleX]!;
  };
  let bestIndex = -1;
  let bestScore = -Infinity;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (excluded.some((zone) => Math.abs(x - zone.x) <= zone.radius)) continue;
      agreements.fill(0);
      let strength = 0;
      let matched = 0;
      for (const point of points) {
        const edges = point.normalX ? xNormalEdges : yNormalEdges;
        const baseX = x + point.x;
        const baseY = y + point.y;
        let peak = 0;
        for (let offset = -radius; offset <= radius; offset += 1) {
          peak = Math.max(peak, edgeValue(edges, baseX, baseY, offset, point.normalX));
        }
        const normalOffset = (radius + 2) * point.normalSign;
        const outside = edgeValue(edges, baseX, baseY, -normalOffset, point.normalX);
        const inside = edgeValue(edges, baseX, baseY, normalOffset, point.normalX);
        const nearby = Math.max(outside, inside);
        if (peak >= 56 && peak >= nearby * 0.75) {
          agreements[point.bin]! += 1;
          matched += 1;
        }
        strength += peak / (peak + 64);
      }
      const coverage = matched / points.length;
      let worst = 1;
      for (let bin = 0; bin < totals.length; bin += 1) {
        if (totals[bin]! < 2) continue;
        worst = Math.min(worst, agreements[bin]! / totals[bin]!);
      }
      const score = worst * 0.6 + coverage * 0.3 + strength / points.length * 0.1;
      const index = (y - minY) * columns + x - minX;
      scores[index] = score;
      if (worst >= 0.6 && coverage >= 0.8 && score > bestScore) {
        bestIndex = index;
        bestScore = score;
      }
    }
  }
  if (bestIndex < 0 || bestScore < 0.7) return null;
  const runnerUp = runnerUpMargin(scores, columns, bestIndex,
    Math.max(radius * 2 + 1, Math.round(tw * 0.35)),
    Math.max(radius * 2 + 1, Math.round(th * 0.25)));
  const margin = runnerUp.margin == null ? undefined : runnerUp.margin / bestScore;
  if (margin != null && margin < 0.035) return null;
  return {
    x: minX + bestIndex % columns,
    y: minY + Math.floor(bestIndex / columns),
    confidence: Math.min(0.98, bestScore),
    confidenceMargin: margin,
    candidateCount: runnerUp.candidateCount,
    method: 'outline-profile',
  };
}

export function isDecisiveShape(candidate: MatchCandidate): boolean {
  const shapeMethod = candidate.method.split('+').some((method) => (
    method === 'hole-silhouette' || method === 'outline-profile'
  ));
  return shapeMethod
    && candidate.confidence >= 0.66
    && (candidate.confidenceMargin == null || candidate.confidenceMargin >= 0.015);
}

/**
 * 这块"拼图块"是真的拼图块，还是扩展把缺口认成了拼图块？
 *
 * 判据是**纹理**：拼图块带着从背景图上裁下来的真实内容，方差高；缺口是纯色
 * 填充，方差极低。认错的后果不是找不到缺口，而是从一个错误的起点算距离 ——
 * 拖出来的位置必然是错的，而日志看起来一切正常。
 */
export function pieceLooksTextured(template: TemplateDescriptor): boolean {
  if (!template.shapedAlpha) return true; // 无形状信息时不做这个判断
  const samples = silhouetteSamples(template);
  if (samples.inside.length < 24) return true;
  const gray = buildGray(template.image);
  const stats = grayStats(gray, template.image.width, 0, 0, samples.inside);
  return stats.std >= 10;
}

function searchBand(
  background: SimpleImageData,
  template: TemplateDescriptor,
  yHint: number,
  /** `yHint` 不可信时不裁纵向，见 locateSliderGap 里的 yHintKnown。 */
  searchAllRows = false,
): { image: SimpleImageData; offsetY: number } {
  if (searchAllRows) return { image: background, offsetY: 0 };
  const tolerance = Math.max(5, Math.round(template.image.height * 0.28));
  const offsetY = Math.max(0, Math.round(yHint - tolerance));
  const bottom = Math.min(background.height, Math.round(yHint + template.image.height + tolerance));
  return {
    image: cropRegion(background, { x: 0, y: offsetY, width: background.width, height: bottom - offsetY }),
    offsetY,
  };
}

interface ChosenCandidate {
  candidate: MatchCandidate;
  /** 与选中位置明显不同、但分数同样够高的其它候选个数。 */
  rivalCount: number;
}

/**
 * 多方法结果的融合。
 *
 * 两条互补的判断：
 *  - **一致** —— 多个方法落在同一位置（±16% 模板宽），加权平均并给置信度加成。
 *    单一方法在纯色背景或强纹理上都会失手，互相印证是最强的信号。
 *  - **分歧** —— 多个方法各自锁定**不同**位置且分数都够高。这不是"取最高分"
 *    能解决的：多缺口验证码（同一张背景图画 2–3 个拼图形状）恰恰会产生这种
 *    局面，选中的那个只是分数最高，不是正确。必须把分歧数报出来。
 */
function chooseCandidate(candidates: MatchCandidate[], templateWidth: number): ChosenCandidate | null {
  if (candidates.length === 0) return null;
  const tolerance = Math.max(4, templateWidth * 0.16);
  const sorted = [...candidates].sort((left, right) => right.confidence - left.confidence);
  // 轮廓已经吻合且有候选差距时保留其坐标，不能再被弱边缘分数压过或平均偏移。
  const decisiveShapes = sorted.filter(isDecisiveShape);
  if (decisiveShapes.length > 0) {
    const shape = decisiveShapes[0]!;
    const shapeRivals = decisiveShapes.filter((candidate) => (
      Math.abs(candidate.x - shape.x) > tolerance
      && candidate.confidence >= shape.confidence * 0.88
    ));
    return { candidate: shape, rivalCount: shapeRivals.length };
  }
  const best = sorted[0]!;
  const agreeing = sorted.filter((candidate) => Math.abs(candidate.x - best.x) <= tolerance);
  /**
   * 分歧候选：位置明显不同，且分数在最佳的 88% 以上。
   *
   * 门槛不能太严：多缺口图上各方法的分数本来就接近（实测 0.652–0.748），
   * 要求"几乎相等"会漏判。也不能太松：真实单缺口图上的次优候选通常在
   * 最佳的一半以下，88% 不会把它们误算成分歧。
   */
  const rivals = sorted.filter((candidate) => (
    Math.abs(candidate.x - best.x) > tolerance
    && candidate.confidence >= best.confidence * 0.88
  ));

  if (agreeing.length >= 2) {
    const totalWeight = agreeing.reduce((sum, candidate) => sum + Math.max(0.01, candidate.confidence), 0);
    return {
      candidate: {
        ...best,
        x: agreeing.reduce((sum, candidate) => sum + candidate.x * candidate.confidence, 0) / totalWeight,
        y: agreeing.reduce((sum, candidate) => sum + candidate.y * candidate.confidence, 0) / totalWeight,
        confidence: Math.min(0.995, best.confidence + 0.08),
        method: agreeing.map((candidate) => candidate.method).join('+'),
        candidateCount: agreeing.reduce((sum, candidate) => sum + (candidate.candidateCount ?? 0), 0),
      },
      rivalCount: rivals.length,
    };
  }
  return { candidate: best, rivalCount: rivals.length };
}

/**
 * 没有拼图块图像时的纯白占位模板。
 *
 * 它**不携带任何形状或纹理信息** —— 只是一个尺寸大致正确的白色矩形，用来给
 * 双图差分（`backgroundDifferenceMatch`）提供一个窗口大小。灰度相关类的方法
 * 绝不能用它：`nccTemplateMatch` 在 `templateStd < 1` 分支的评分是
 * `1 - |mean-255|/255 - 0.3·std/255`，也就是「哪里最亮最平」，与缺口毫无关系
 * （缺口通常反而是暗的）。亮照片背景 mean≈210/std≈8 时它能拿 0.814，
 * 直接越过单方法门槛 0.68，于是高置信度拖到一个纯属虚构的位置。
 */
function inferredTemplate(info: SliderChallengeInfo, images: PreparedSliderImages): TemplateDescriptor {
  const cssWidth = info.pieceRect?.width ?? Math.max(28, Math.min(64, info.handleRect.width));
  const cssHeight = info.pieceRect?.height ?? cssWidth;
  const width = Math.max(8, Math.min(images.background.width - 1, Math.round(cssWidth * images.imageScaleX)));
  const height = Math.max(8, Math.min(images.background.height - 1, Math.round(cssHeight * images.imageScaleY)));
  const image = createImageData(width, height);
  image.data.fill(255);
  return {
    image,
    originalWidth: width,
    originalHeight: height,
    bounds: { x: 0, y: 0, width, height },
    shapedAlpha: false,
  };
}

/**
 * 缺口不可能与拼图块的起始位置重叠 —— 重叠的话拼图块本来就在缺口里了。
 *
 * 原来的自排除只有 `模板宽 × 0.08`（实测约 4.7px），而拼图块宽约 59px，
 * 于是匹配器能锁定**拼图块自己的边缘**当成缺口：实测日志里出现过
 * 「缺口=32.8px，拖动=8.21px」，而拼图块左边缘就在 24.6px —— 找到的
 * "缺口"落在拼图块内部，拖 8px 当然过不了。
 *
 * 用拼图块宽度的 0.75 倍：留一点余量给描边和投影造成的视觉宽度差，
 * 但足以把自身排除掉。
 */
const SELF_MATCH_EXCLUSION_RATIO = 0.75;

export async function locateSliderGap(
  info: SliderChallengeInfo,
  images: PreparedSliderImages,
  excluded: readonly ExcludedGap[] = [],
): Promise<SliderGapMatch | null> {
  const template = images.template ?? inferredTemplate(info, images);
  if (template.image.width >= images.background.width || template.image.height >= images.background.height) return null;

  const pieceLeftCss = info.pieceRect?.x ?? info.backgroundRect.x;
  const initialX = Math.max(0, (pieceLeftCss - info.backgroundRect.x) * images.imageScaleX
    + template.bounds.x * (info.pieceRect && images.source === 'raw-image'
      ? info.pieceRect.width / Math.max(1, template.originalWidth) * images.imageScaleX
      : 1));
  const pieceTopCss = info.pieceRect?.y ?? info.backgroundRect.y;
  const yHint = Math.max(0, (pieceTopCss - info.backgroundRect.y) * images.imageScaleY
    + template.bounds.y * (info.pieceRect && images.source === 'raw-image'
      ? info.pieceRect.height / Math.max(1, template.originalHeight) * images.imageScaleY
      : 1));
  /**
   * `yHint` 只有在拼图块矩形真实存在时才有意义。
   *
   * 没有 `pieceRect` 时上面那个表达式退化成 0 —— 不是「缺口在顶部」，而是
   * 「不知道缺口在哪一行」。而三路匹配器都把 y 钳在 `yHint ± 容差` 的窄带里：
   * `edgeContourMatch` 只搜 y∈[0, th×0.22]，`searchBand` 只裁到
   * y≈th+容差。背景 340×200、缺口在 y≈90 时，它们全都看不到真正的缺口，
   * 只能在最顶上十几个像素里挑一个最像的交出去。
   *
   * `backgroundDifferenceMatch` 早就有这个豁免（原来写作
   * `!info.pieceRect && !images.template`），但另两路没有 —— 这里统一。
   */
  const yHintKnown = info.pieceRect != null;
  /**
   * 模板是纯白占位（没有任何拼图块图像）。
   *
   * 这种模板只能用于双图差分提供窗口尺寸；灰度相关类方法在它上面找的是
   * 「最亮最平的地方」，与缺口无关。见 `inferredTemplate` 的说明。
   */
  const syntheticTemplate = images.template == null;

  const candidates: MatchCandidate[] = [];
  const minimumGapX = initialX + Math.max(3, template.image.width * SELF_MATCH_EXCLUSION_RATIO);
  if (minimumGapX > images.background.width - template.image.width) {
    // 拼图块已经贴在右侧，没有可用的搜索区间。
    return null;
  }
  if (images.referenceBackground) {
    const difference = backgroundDifferenceMatch(
      images.background,
      images.referenceBackground,
      template,
      minimumGapX,
      yHint,
      !yHintKnown,
    );
    if (difference) candidates.push(difference);
  }
  /*
   * 形状吻合优先。
   *
   * 这是唯一真正检验「碎片能不能装进去」的方法：同时要求形状内是平坦的缺口
   * 填充、形状外是有纹理的图像内容。多缺口图上另外那些形状的凸起/凹槽位置
   * 不同，形状外必然落到填充色上，因此会被 exteriorTexture 压下去。
   */
  const silhouette = holeSilhouetteMatch(images.background, template, minimumGapX, yHint, !yHintKnown);
  if (silhouette) candidates.push(silhouette);
  const usableShape = (candidate: MatchCandidate | null): candidate is MatchCandidate => (
    candidate != null
    && isDecisiveShape(candidate)
    && !excluded.some((zone) => Math.abs(candidate.x - zone.x) <= zone.radius)
  );
  const outline = !usableShape(silhouette)
    ? outlineProfileMatch(images.background, template, minimumGapX, yHint, !yHintKnown, excluded)
    : null;
  if (outline) candidates.push(outline);
  /**
   * 形状吻合明确否决时，**压低其它方法的置信度**。
   *
   * 这条是必需的，不是保险。带 alpha 的模板走到形状吻合而它返回 null，
   * 意味着「图上每一个位置的轮廓都对不上这块碎片」—— 最典型的情形就是
   * 缺口的凸起方向与碎片不符（用户截图：碎片凸起在上，缺口凸起在左）。
   *
   * 而 `contour-alpha` / `ncc` / `opencv` 只看边缘能量或灰度相关，
   * 照样会在那个装不进去的缺口上给出 0.99。拖过去必然被站点判
   * 「验证错误，请重试」—— 那正是用户看到的结果。
   *
   * 不直接丢弃候选：几何/双图差分路径仍可能是对的，而形状推断本身也可能
   * 有误（截图裁剪推 alpha 不是万无一失）。压到权威门槛（0.66）以下，
   * 让它走「多个疑似缺口 → 转人工」，而不是高置信度拖一个错位置。
   */
  // 纯色缺口的形状判据不适用于保留纹理的半透明缺口；后续只允许强原图证据豁免。
  const shapeMissing = template.shapedAlpha && ![silhouette, outline].some(usableShape);

  const shapeDecisive = [silhouette, outline].some(usableShape);
  const contour = shapeDecisive ? null
    : edgeContourMatch(images.background, template, minimumGapX, yHint, !yHintKnown);
  if (contour) candidates.push(contour);

  const band = searchBand(images.background, template, yHint, !yHintKnown);
  /*
   * 带 alpha 的模板现在也走 OpenCV：worker 支持 mask 时精度明显更高，
   * 不支持时它自己回退到无 mask 调用，不会比原来差。
   *
   * `x > minimumGapX` 是**事后**否决而不是缩小搜索范围，这是有意的：截图路径的
   * 背景图里合成着拼图块本身，模板与背景是同一张截图的两块、逐字节相等，自匹配处
   * 相关系数恰为 1.0 必为全局最优。而缺口是纯色平坦填充、跟碎片纹理毫不相似 ——
   * 灰度相关在这条路径上除了碎片自己以外没有可说的。"全局最优只有自己"正确地
   * 表达了"我没有结论"；改成在自匹配区右侧强行取最优，只会返回纹理噪声，
   * 把没有缺口的图判成有缺口（slider-hole-silhouette.test.ts 直接断言了这点）。
   */
  const openCv = syntheticTemplate || shapeDecisive ? null
    : await matchTemplateWithOpenCV(band.image, template.image, template.shapedAlpha);
  if (openCv && openCv.confidence >= 0.42 && openCv.x >= minimumGapX) {
    candidates.push({ ...openCv, y: openCv.y + band.offsetY, method: 'opencv', candidateCount: 1 });
  }

  const operationEstimate = (band.image.width - template.image.width + 1)
    * (band.image.height - template.image.height + 1)
    * template.image.width
    * template.image.height;
  /*
   * 纯白占位模板不走 NCC。
   *
   * 它没有任何形状或纹理信息，而 `templateStd < 1` 分支的评分是「哪里最亮最平」
   * （`1 - |mean-255|/255 - 0.3·std/255`），与缺口无关 —— 缺口通常反而是暗的。
   * 亮照片背景 mean≈210/std≈8 时它拿 0.814，越过单方法门槛 0.68，且它往往是
   * 唯一候选（rivalCount=0），于是 buildSliderDragPlan 全部门槛放行，
   * 高置信度拖到一个纯属虚构的位置。OpenCV 那一路 worker 自己用
   * `uniform: true` 挡住了，JS 这一路必须在这里挡。
   */
  if (!syntheticTemplate && !shapeDecisive && operationEstimate > 0 && operationEstimate <= 90_000_000) {
    const ncc = nccTemplateMatch(band.image, template.image, template.shapedAlpha ? 0.28 : 0.36);
    if (ncc && ncc.x >= minimumGapX) {
      candidates.push({ ...ncc, y: ncc.y + band.offsetY, method: 'ncc' });
    }
  }

  /**
   * 剔除已经拖过且被站点判失败的位置。
   *
   * 实测日志里第 1 次和第 5 次都算出「缺口=32.8px」—— 第 1 次已经明确
   * 「页面反馈验证失败」，第 5 次没有任何理由再试同一个位置。不排除的话
   * 5 次机会里有 2 次是白费的。
   */
  const usable = excluded.length
    ? candidates.filter((candidate) => !excluded.some(
        (zone) => Math.abs(candidate.x - zone.x) <= zone.radius,
      ))
    : candidates;
  if (usable.length === 0) return null;

  const chosen = chooseCandidate(usable, template.image.width);
  if (!chosen) return null;
  const { candidate: selected, rivalCount } = chosen;

  const directImageEvidence = images.source === 'raw-image' && usable.some((candidate) => (
    (candidate.method === 'ncc' || candidate.method === 'background-delta')
    && candidate.confidence >= 0.86
    && candidate.confidenceMargin != null && candidate.confidenceMargin >= 0.05
    && Math.abs(candidate.x - selected.x) <= Math.max(2, template.image.width * 0.06)
    && Math.abs(candidate.y - selected.y) <= Math.max(2, template.image.height * 0.06)
  ));
  const shapeVetoed = shapeMissing && !directImageEvidence;

  /*
   * 形状吻合达到高置信度时，它自己就是结论。
   *
   * 其它方法在多缺口图上必然给出分歧位置（各自锁定不同形状），若让 rivalCount
   * 一律拦下，这类验证码就永远只能转人工 —— 而形状吻合恰恰能答对。它检验的是
   * 「凸起和凹槽都对得上」，与「这里边缘能量高」不是同一个量级的证据。
   */
  const shapeAuthoritative = isDecisiveShape(selected);

  const minimumConfidence = candidates.length >= 2 && selected.method.includes('+')
    ? 0.48
    // 单方法没有任何印证：多缺口图上任意一个形状都能拿到 0.65–0.75 的边缘分数，
    // 所以矩形轮廓要 0.68。形状吻合自带更强语义，0.58 即可。
    : shapeAuthoritative
      ? 0.58
      : (template.shapedAlpha ? 0.62 : 0.68);
  if (selected.confidence < minimumConfidence) return null;

  /*
   * 形状吻合否决过，就不让别的方法冒充权威结论。
   *
   * 压到 0.6：既低于 `buildSliderDragPlan` 里 0.86 的歧义放行门槛（于是会
   * 走「多个疑似缺口 → 转人工」），又高于 0.45 的最低可用线（仍允许在
   * 用户没有别的选择时尝试一次），并强制 rivalCount ≥ 1 让歧义判定生效。
   */
  const vetoedConfidence = shapeVetoed && !shapeAuthoritative
    ? Math.min(selected.confidence, 0.6)
    : selected.confidence;

  return {
    x: selected.x,
    y: selected.y,
    confidence: vetoedConfidence,
    confidenceMargin: selected.confidenceMargin,
    method: selected.method,
    candidateCount: selected.candidateCount ?? candidates.length,
    // 形状吻合已经确认了唯一目标，不必再因为别的方法各说各话而转人工。
    // 反之它明确否决时，必须留下歧义标记，让上层走转人工而不是硬拖。
    rivalCount: shapeAuthoritative
      ? rivalCount
      : shapeVetoed
        ? Math.max(1, rivalCount)
        : rivalCount,
    templateWidth: template.image.width,
    templateHeight: template.image.height,
    templateOffsetX: template.bounds.x,
    templateOffsetY: template.bounds.y,
    templateOriginalWidth: template.originalWidth,
    templateOriginalHeight: template.originalHeight,
  };
}
