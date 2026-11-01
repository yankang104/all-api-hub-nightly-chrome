/**
 * realDrag 的落点保真与通道契约。
 *
 * 现场（通用形态）：
 *  1. 生产回放走可信指针通道，但后台**没有 TRUSTED_POINTER_DRAG 路由**，
 *     消息落到 default 分支被静默丢弃（回执不是 ok），拖拽回放必然失败；
 *  2. DOM 模式下拖拽只按元素中心按下/释放，学习到的相对落点（用户点/拖在
 *     控件内的哪个位置）被丢掉 —— 滑块、排序把手这类控件对落点敏感。
 *
 * 本文件锁定：DOM 模式的指针序列带真实落点；可信通道把起终点标记与各自
 * 相对落点一并交给后台（由后台在按下前重采样）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/core/messaging', () => ({ sendMessage: vi.fn() }));

import { sendMessage } from '@/lib/core/messaging';
import { realDrag, setActiveClickRunId } from '@/automation/shared/dom-utils';

interface Rect { left: number; top: number; width: number; height: number }

function installElement(rect: Rect) {
  const events: Array<{ type: string; x: number; y: number }> = [];
  const attributes = new Map<string, string>();
  const element = {
    draggable: true,
    contains: (candidate: unknown) => candidate === element,
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => { attributes.set(name, value); },
    removeAttribute: (name: string) => { attributes.delete(name); },
    getBoundingClientRect: () => ({
      left: rect.left, top: rect.top, width: rect.width, height: rect.height,
      right: rect.left + rect.width, bottom: rect.top + rect.height,
      x: rect.left, y: rect.top, toJSON: () => ({}),
    } as DOMRect),
    scrollIntoView: vi.fn(),
    dispatchEvent: (event: { type: string; clientX?: number; clientY?: number }) => {
      events.push({ type: event.type, x: event.clientX ?? 0, y: event.clientY ?? 0 });
      return true;
    },
  };
  return { element: element as unknown as HTMLElement, events, attributes };
}

afterEach(() => {
  setActiveClickRunId(null);
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('realDrag 的落点保真', () => {
  it('DOM 模式按学习到的相对落点按下/释放，而不是元素中心', async () => {
    const from = installElement({ left: 100, top: 100, width: 200, height: 100 });
    const to = installElement({ left: 400, top: 300, width: 200, height: 100 });
    // 按坐标返回"该位置上的元素"：from 的矩形在上、to 的在下，互不重叠。
    const hitAt = (x: number, y: number) => (y < 250 ? from.element : to.element);
    vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 800, scrollBy: vi.fn() });
    vi.stubGlobal('document', { elementFromPoint: hitAt, querySelectorAll: () => [], querySelector: () => null });
    class FakePointerEvent {
      type: string;
      clientX: number;
      clientY: number;
      constructor(type: string, init: Record<string, unknown> = {}) {
        this.type = type;
        this.clientX = Number(init.clientX ?? 0);
        this.clientY = Number(init.clientY ?? 0);
      }
    }
    vi.stubGlobal('PointerEvent', FakePointerEvent);
    vi.stubGlobal('MouseEvent', FakePointerEvent);

    // 起点在控件右下角附近 (rx=0.9, ry=0.9)，终点在控件左上角 (rx=0.1, ry=0.1)
    await expect(realDrag(from.element, to.element, {
      fromAnchor: { rx: 0.9, ry: 0.9 },
      toAnchor: { rx: 0.1, ry: 0.1 },
      steps: 2,
    })).resolves.toBe('dom');

    const down = from.events.find((event) => event.type === 'pointerdown');
    expect(down).toBeDefined();
    // 100 + 200*0.9 = 280；100 + 100*0.9 = 190（而不是中心 200 / 150）
    expect(down!.x).toBe(280);
    expect(down!.y).toBe(190);
    const up = to.events.find((event) => event.type === 'pointerup');
    expect(up).toBeDefined();
    expect(up!.x).toBe(420);
    expect(up!.y).toBe(310);
  });

  it('可信通道把起终点标记与各自落点交给后台（后台按下前重采样）', async () => {
    const from = installElement({ left: 100, top: 100, width: 200, height: 100 });
    const to = installElement({ left: 400, top: 300, width: 200, height: 100 });
    const hitAt = (x: number, y: number) => (y < 250 ? from.element : to.element);
    vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 800 });
    vi.stubGlobal('document', { elementFromPoint: hitAt, querySelectorAll: () => [], querySelector: () => null });
    vi.stubGlobal('chrome', { runtime: { id: 'test-extension' } });
    vi.mocked(sendMessage).mockResolvedValue({
      ok: true,
      feature: { pointer: { mode: 'trusted', pathPoints: 0, clickObserved: null, drag: { points: 12, totalDistance: 320 } } },
    });
    setActiveClickRunId('run-drag');

    await expect(realDrag(from.element, to.element, {
      fromAnchor: { rx: 0.25, ry: 0.5 },
      toAnchor: { rx: 0.75, ry: 0.5 },
    })).resolves.toBe('trusted');

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'TRUSTED_POINTER_DRAG',
      runId: 'run-drag',
      fromAnchor: { kind: 'relative', rx: 0.25, ry: 0.5 },
      toAnchor: { kind: 'relative', rx: 0.75, ry: 0.5 },
      fromTargetToken: expect.stringMatching(/^p-[a-z0-9-]{8,80}$/i),
      toTargetToken: expect.stringMatching(/^p-[a-z0-9-]{8,80}$/i),
    }));
    // 位置只管到元素内相对比例：原始坐标绝不进消息契约的可选落点字段
    const call = vi.mocked(sendMessage).mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(JSON.stringify(call.fromAnchor)).not.toMatch(/clientX|clientY/);
  });

  it('可信通道缺少拖拽结果时明确报错，绝不当作成功', async () => {
    const from = installElement({ left: 100, top: 100, width: 200, height: 100 });
    const to = installElement({ left: 400, top: 300, width: 200, height: 100 });
    const hitAt = (x: number, y: number) => (y < 250 ? from.element : to.element);
    vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 800 });
    vi.stubGlobal('document', { elementFromPoint: hitAt, querySelectorAll: () => [], querySelector: () => null });
    vi.stubGlobal('chrome', { runtime: { id: 'test-extension' } });
    vi.mocked(sendMessage).mockResolvedValue({
      ok: true,
      feature: { pointer: { mode: 'trusted', pathPoints: 0, clickObserved: null } },
    });
    setActiveClickRunId('run-drag-missing');

    await expect(realDrag(from.element, to.element)).rejects.toThrow('未返回执行统计');
  });
});
