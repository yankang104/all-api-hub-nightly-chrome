import type { PointerAnchor, PointerTargetDiagnostics } from '@/lib/messages/pointer';
import type { SliderRect } from '@/types/slider';

/** 只由后台已授权的验证码会话创建，不能直接信任 content 消息中的 frameId。 */
export interface FramePointerTarget {
  frameId: number;
  documentId?: string;
  frameToken: string;
  frameUrl: string;
}

export interface FrameEmbedding {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  pointHits: boolean[];
}

async function boundedFrameRead<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('验证码内嵌页面读取超时')), 4_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 内容框（不含边框）的屏幕位置；归一化落点也必须命中这一具体 iframe。 */
export async function readFrameEmbedding(
  tabId: number,
  target: Pick<FramePointerTarget, 'frameToken' | 'frameUrl'>,
  points: Array<{ x: number; y: number }> = [],
): Promise<FrameEmbedding> {
  const results = await boundedFrameRead(chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func: (token: string, expectedUrl: string, probes: Array<{ x: number; y: number }>) => {
      const element = document.querySelector(`[data-aah-pointer-target="${token}"]`);
      if (!(element instanceof HTMLIFrameElement) || !element.isConnected || element.src !== expectedUrl) return null;
      let ancestor: Element | null = element;
      while (ancestor) {
        const style = getComputedStyle(ancestor);
        if (style.display === 'none' || style.visibility !== 'visible'
          || Number.parseFloat(style.opacity || '1') <= 0.02) return null;
        // 包含缩放的弹窗可换算；旋转/透视不能用轴对齐矩形近似后盲拖。
        if (style.transform !== 'none') {
          const matrix = new DOMMatrixReadOnly(style.transform);
          if (!matrix.is2D || Math.abs(matrix.b) > 0.001 || Math.abs(matrix.c) > 0.001
            || matrix.a <= 0 || matrix.d <= 0) return null;
        }
        ancestor = ancestor.parentElement;
      }
      const rect = element.getBoundingClientRect();
      if (rect.width < 100 || rect.height < 70 || !element.offsetWidth || !element.offsetHeight) return null;
      const sx = rect.width / element.offsetWidth;
      const sy = rect.height / element.offsetHeight;
      const x = rect.left + element.clientLeft * sx;
      const y = rect.top + element.clientTop * sy;
      const width = element.clientWidth * sx;
      const height = element.clientHeight * sy;
      const pointHits = probes.map((point) => {
        if (![point.x, point.y].every(Number.isFinite)
          || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return false;
        const px = x + point.x * width;
        const py = y + point.y * height;
        return px >= 1 && py >= 1 && px < innerWidth - 1 && py < innerHeight - 1
          && document.elementFromPoint(px, py) === element;
      });
      return { x, y, width, height, viewportWidth: innerWidth, viewportHeight: innerHeight,
        devicePixelRatio: devicePixelRatio || 1, pointHits };
    },
    args: [target.frameToken, target.frameUrl, points],
  }));
  const embedding = results[0]?.result;
  if (!embedding) throw new Error('验证码 iframe 已隐藏、重建或发生无法换算的变形');
  if (embedding.pointHits.some((hit) => !hit)) throw new Error('验证码 iframe 的图片或把手被外层弹窗遮挡');
  return embedding;
}

export function frameScale(embedding: FrameEmbedding, width: number, height: number) {
  const x = embedding.width / width;
  const y = embedding.height / height;
  if (![x, y].every((scale) => Number.isFinite(scale) && scale >= 0.2 && scale <= 5)) {
    throw new Error('验证码 iframe 的视口缩放比例无效');
  }
  return { x, y };
}

export function mapFrameRect(rect: SliderRect, embedding: FrameEmbedding, scale: { x: number; y: number }): SliderRect {
  return { x: embedding.x + rect.x * scale.x, y: embedding.y + rect.y * scale.y,
    width: rect.width * scale.x, height: rect.height * scale.y };
}

/** 按下前同时检查内层真实控件和外层 iframe，绝不跳过跨域 hit-test。 */
export async function readFramePointerTarget(
  tabId: number,
  target: FramePointerTarget,
  token: string,
  anchor: PointerAnchor,
): Promise<PointerTargetDiagnostics | null> {
  const results = await boundedFrameRead(chrome.scripting.executeScript({
    target: target.documentId
      ? { tabId, documentIds: [target.documentId] }
      : { tabId, frameIds: [target.frameId] },
    func: (marker: string, position: PointerAnchor, expectedUrl: string) => {
      if (location.href !== expectedUrl) return null;
      const element = document.querySelector(`[data-aah-pointer-target="${marker}"]`);
      if (!element?.isConnected) return null;
      const rect = element.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return null;
      const x = rect.left + (position.kind === 'inset-left' ? Math.min(position.px, rect.width / 2) : rect.width / 2);
      const y = rect.top + rect.height / 2;
      if (x < 1 || y < 1 || x >= innerWidth - 1 || y >= innerHeight - 1) return null;
      const hit = document.elementFromPoint(x, y);
      if (!hit || !(hit === element || element.contains(hit))) return null;
      return { x, y, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        viewportWidth: innerWidth, viewportHeight: innerHeight };
    },
    args: [token, anchor, target.frameUrl],
  }));
  const point = results[0]?.result;
  if (!point) return null;
  const embedding = await readFrameEmbedding(tabId, target, [{
    x: point.x / point.viewportWidth, y: point.y / point.viewportHeight,
  }]);
  const scale = frameScale(embedding, point.viewportWidth, point.viewportHeight);
  const rect = mapFrameRect(point.rect, embedding, scale);
  return { x: embedding.x + point.x * scale.x, y: embedding.y + point.y * scale.y,
    rect: { left: rect.x, top: rect.y, width: rect.width, height: rect.height }, hit: true, withinHost: true };
}
