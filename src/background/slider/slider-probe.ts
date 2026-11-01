/**
 * 拖拽中的差分测量。
 *
 * ## 为什么需要它
 *
 * 前两轮修复都在猜三件事，而三件都可能错：
 *
 *  1. **`pieceRect` 裁出来的是碎片吗** —— 多缺口图上 DOM 评分可能挑中某个缺口，
 *     两者都是同样大小的方块、都叠在背景图上；
 *  2. **推断出的 alpha 是碎片轮廓吗** —— 从不透明矩形反推形状，浅色碎片、
 *     半透明碎片、深色背景都会让它推歪；
 *  3. **行程比是 `handleRange / pieceRange` 吗** —— 站点可以任意映射，
 *     实测有 0.996 的，也可能有别的。
 *
 * 猜错的共同后果是「日志看着一切正常，位置就是不对」——最难排查的一类。
 *
 * ## 做法
 *
 * 按下把手**不松手**，先移动一小段，截图，与按下前的截图相减：
 *
 *  - 变化的像素分成两团：碎片**原来**的位置、碎片**现在**的位置
 *  - 右边那团的形状就是碎片的**真实轮廓**（不用推断）
 *  - 两团的水平间距 ÷ 把手位移 = **真实行程比**（不用假设）
 *  - 右边那团的 RGB 就是碎片的**真实内容**（可直接做模板匹配）
 *
 * 探测位移取「碎片宽度 + 余量」，保证两团不重叠 —— 重叠了就分不开。
 *
 * 全部是纯函数，输入是两张已解码的图，便于单测。
 */

import type { SimpleImageData } from '@/background/slider/slider-image';

export interface ProbeBlob {
  /** 包围盒（截图物理像素） */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 团内像素数 */
  area: number;
}

export interface ProbeMeasurement {
  /** 碎片探测后的位置（截图物理像素，包围盒左上角） */
  pieceX: number;
  pieceY: number;
  pieceWidth: number;
  pieceHeight: number;
  /** 碎片探测前的位置 */
  originX: number;
  originY: number;
  /**
   * 碎片实际水平位移 ÷ 把手水平位移。
   *
   * 站点可以任意映射这两者；测出来的值比任何公式推导都可靠。
   */
  measuredRatio: number;
  /** 碎片真实模板：alpha 来自差分掩码，RGB 来自探测后的截图 */
  template: SimpleImageData;
}

const MIN_BLOB_AREA = 60;
/** 差分阈值：低于此值算「没变」，滤掉压缩噪声和抗锯齿抖动 */
const DIFF_THRESHOLD = 26;

function createImage(width: number, height: number): SimpleImageData {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/** 两张同尺寸图的逐像素差分掩码 */
export function diffMask(before: SimpleImageData, after: SimpleImageData): Uint8Array | null {
  if (before.width !== after.width || before.height !== after.height) return null;
  const mask = new Uint8Array(before.width * before.height);
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    const offset = pixel * 4;
    const delta = (
      Math.abs(after.data[offset]! - before.data[offset]!)
      + Math.abs(after.data[offset + 1]! - before.data[offset + 1]!)
      + Math.abs(after.data[offset + 2]! - before.data[offset + 2]!)
    ) / 3;
    mask[pixel] = delta >= DIFF_THRESHOLD ? 1 : 0;
  }
  return mask;
}

/**
 * 连通域标记，返回按面积降序的团。
 *
 * 用显式栈的 4 邻域洪泛，不用递归 —— 一整块变化区域可能有上万像素，
 * 递归会爆栈。
 */
export function findBlobs(
  mask: Uint8Array,
  width: number,
  height: number,
  minArea = MIN_BLOB_AREA,
): ProbeBlob[] {
  const visited = new Uint8Array(mask.length);
  const blobs: ProbeBlob[] = [];
  const stack: number[] = [];

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    stack.length = 0;
    stack.push(start);
    visited[start] = 1;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let area = 0;

    while (stack.length > 0) {
      const index = stack.pop()!;
      const x = index % width;
      const y = (index - x) / width;
      area += 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;

      if (x > 0) {
        const left = index - 1;
        if (mask[left] && !visited[left]) { visited[left] = 1; stack.push(left); }
      }
      if (x + 1 < width) {
        const right = index + 1;
        if (mask[right] && !visited[right]) { visited[right] = 1; stack.push(right); }
      }
      if (y > 0) {
        const up = index - width;
        if (mask[up] && !visited[up]) { visited[up] = 1; stack.push(up); }
      }
      if (y + 1 < height) {
        const down = index + width;
        if (mask[down] && !visited[down]) { visited[down] = 1; stack.push(down); }
      }
    }

    if (area >= minArea) {
      blobs.push({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, area });
    }
  }

  return blobs.sort((left, right) => right.area - left.area);
}

export interface ProbeInput {
  /** 按下前的视口截图 */
  before: SimpleImageData;
  /** 探测移动后的视口截图（左键仍按住） */
  after: SimpleImageData;
  /** 把手实际水平位移（CSS 像素） */
  handleDeltaCss: number;
  /** 截图物理像素 / CSS 像素 */
  pixelRatio: number;
  /** 背景图区域（截图物理像素），用于把搜索限制在验证码图内 */
  backgroundRect: { x: number; y: number; width: number; height: number };
}

export type ProbeResult =
  | { ok: true; measurement: ProbeMeasurement }
  | { ok: false; reason: string };

/**
 * 从两张截图测出碎片的真实轮廓与真实行程比。
 *
 * 只接受「恰好两团、且水平分离」的结果。其它形态（一团、三团以上、
 * 垂直错位过大）说明这次差分不干净 —— 页面上还有别的东西在动（动画、倒计时、
 * 光标闪烁），此时任何结论都不可信，如实返回失败让调用方回退到几何推算。
 */
export function measurePieceFromProbe(input: ProbeInput): ProbeResult {
  const { before, after, handleDeltaCss, pixelRatio, backgroundRect } = input;
  if (!Number.isFinite(handleDeltaCss) || Math.abs(handleDeltaCss) < 4) {
    return { ok: false, reason: '探测位移过小，无法分离碎片' };
  }
  if (!Number.isFinite(pixelRatio) || pixelRatio <= 0) {
    return { ok: false, reason: '截图像素比无效' };
  }

  const mask = diffMask(before, after);
  if (!mask) return { ok: false, reason: '两张截图尺寸不一致' };

  // 只看背景图区域：页面别处的动画、光标、倒计时都与碎片无关。
  const left = Math.max(0, Math.floor(backgroundRect.x));
  const top = Math.max(0, Math.floor(backgroundRect.y));
  const right = Math.min(before.width, Math.ceil(backgroundRect.x + backgroundRect.width));
  const bottom = Math.min(before.height, Math.ceil(backgroundRect.y + backgroundRect.height));
  if (right - left < 20 || bottom - top < 20) {
    return { ok: false, reason: '背景图区域过小' };
  }
  for (let y = 0; y < before.height; y += 1) {
    const inRows = y >= top && y < bottom;
    for (let x = 0; x < before.width; x += 1) {
      if (!inRows || x < left || x >= right) mask[y * before.width + x] = 0;
    }
  }

  const blobs = findBlobs(mask, before.width, before.height);
  if (blobs.length === 0) {
    return { ok: false, reason: '探测移动后画面没有可识别的变化，碎片可能没有跟随把手' };
  }
  if (blobs.length === 1) {
    return {
      ok: false,
      reason: '只观察到一团变化，碎片的新旧位置可能重叠（探测位移不足）',
    };
  }

  // 取面积最大的两团：它们应该是碎片的旧位置和新位置。
  const [first, second] = blobs;
  const origin = first!.x <= second!.x ? first! : second!;
  const moved = first!.x <= second!.x ? second! : first!;

  const horizontalGap = moved.x - origin.x;
  if (horizontalGap <= 2) {
    return { ok: false, reason: '两团变化没有水平分离，无法判断移动方向' };
  }
  // 同一个碎片的两个位置，垂直方向应该基本对齐。
  if (Math.abs(moved.y - origin.y) > Math.max(6, origin.height * 0.35)) {
    return { ok: false, reason: '两团变化的垂直位置差异过大，可能不是同一个碎片' };
  }
  // 尺寸也应该接近。
  const widthRatio = moved.width / Math.max(1, origin.width);
  if (widthRatio < 0.6 || widthRatio > 1.7) {
    return { ok: false, reason: '两团变化的尺寸差异过大，可能不是同一个碎片' };
  }

  const handleDeltaPixels = handleDeltaCss * pixelRatio;

  /*
   * 位移不足一个碎片宽时，差分出来的是两条**细长条**，不是两个完整轮廓。
   *
   * 原因：掩码只标"变化的"像素，而新旧位置**重叠**的那部分没有变化。碎片宽
   * 46px、只移动 10px 时，掩码是两条 10px 宽的条带，中间 36px 因为始终被碎片
   * 覆盖而未被标记 —— 此时两团包围盒的间距量到的是**碎片宽度**，不是位移，
   * 行程比必然膨胀（实测算出 3.6，真值是 1.0）。
   *
   * 判据用**长宽比**而不是绝对宽度：两种情况下 `moved.width` 都可能小于位移量
   * （完整轮廓在大位移时也是如此），绝对值分不开它们。而拼图碎片接近方形，
   * 重叠残留的条带则明显细长 —— 这个区别是稳定的。
   *
   * 阈值取 0.45，只拦明显的条带：非方形碎片（长宽比 0.5–2）仍然放行。
   */
  const movedAspect = moved.width / Math.max(1, moved.height);
  if (movedAspect < 0.45) {
    return {
      ok: false,
      reason: '碎片的新旧位置部分重叠，差分只得到窄条（探测位移不足一个碎片宽）',
    };
  }
  const measuredRatio = horizontalGap / handleDeltaPixels;
  // 行程比落在这个范围外说明测量本身出了问题（站点极少做超过 2 倍的映射）。
  if (!Number.isFinite(measuredRatio) || measuredRatio < 0.25 || measuredRatio > 2.5) {
    return {
      ok: false,
      reason: `测得的行程比 ${measuredRatio.toFixed(3)} 超出合理范围`,
    };
  }

  /*
   * 碎片真实模板：alpha 来自差分掩码（哪些像素属于碎片），RGB 来自探测后的截图
   * （碎片当前呈现的内容）。这比从不透明矩形反推 alpha 可靠得多 ——
   * 掩码是"这些像素确实随把手一起动了"的直接证据。
   */
  const template = createImage(moved.width, moved.height);
  let opaque = 0;
  for (let y = 0; y < moved.height; y += 1) {
    for (let x = 0; x < moved.width; x += 1) {
      const sourceX = moved.x + x;
      const sourceY = moved.y + y;
      const to = (y * moved.width + x) * 4;
      if (sourceX < 0 || sourceY < 0 || sourceX >= after.width || sourceY >= after.height) continue;
      const from = (sourceY * after.width + sourceX) * 4;
      const inPiece = mask[sourceY * before.width + sourceX] === 1;
      template.data[to] = after.data[from]!;
      template.data[to + 1] = after.data[from + 1]!;
      template.data[to + 2] = after.data[from + 2]!;
      template.data[to + 3] = inPiece ? 255 : 0;
      if (inPiece) opaque += 1;
    }
  }
  const fillRatio = opaque / Math.max(1, moved.width * moved.height);
  if (fillRatio < 0.2) {
    return { ok: false, reason: '差分出的碎片形状过于稀疏，无法作为模板' };
  }

  return {
    ok: true,
    measurement: {
      pieceX: moved.x,
      pieceY: moved.y,
      pieceWidth: moved.width,
      pieceHeight: moved.height,
      originX: origin.x,
      originY: origin.y,
      measuredRatio,
      template,
    },
  };
}
