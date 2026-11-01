import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildHumanPointerPath,
  openTrustedDragSession,
  trustedPointerClick,
  trustedPointerDrag,
} from '@/background/slider/trusted-pointer';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('buildHumanPointerPath', () => {
  it('始终准确落到目标中心并包含足够多的移动点', () => {
    const path = buildHumanPointerPath({ x: 10, y: 20 }, { x: 410, y: 260 }, () => 0.4);
    expect(path.length).toBeGreaterThanOrEqual(12);
    expect(path.at(-1)).toEqual({ x: 410, y: 260 });
  });

  it('短距离也不会退化成瞬移', () => {
    const path = buildHumanPointerPath({ x: 100, y: 100 }, { x: 104, y: 102 }, () => 0.5);
    expect(path).toHaveLength(12);
    expect(path[0]).not.toEqual(path.at(-1));
  });
});

describe('可信拖拽参数校验', () => {
  it('普通拖拽在接触 debugger 前拒绝非法延时', async () => {
    await expect(trustedPointerDrag(1, {
      startX: 20,
      startY: 20,
      viewportWidth: 100,
      viewportHeight: 100,
      points: [
        { x: 30, y: 20, delayMs: 10 },
        { x: 40, y: 20, delayMs: Number.NaN },
      ],
    })).rejects.toThrow('拖拽路径点坐标或延时不是有效数字');
  });

  it('动态拖拽会话在接触 debugger 前拒绝视口外起点', async () => {
    await expect(openTrustedDragSession(1, {
      startX: -1,
      startY: 20,
      viewportWidth: 100,
      viewportHeight: 100,
    })).rejects.toThrow('拖拽起点不在当前视口内');
  });
});

describe('trustedPointerClick 生命周期', () => {
  /**
   * 按下之后中断，必须补发 mouseReleased。
   *
   * mousePressed 与 mouseReleased 之间还有 `pauseBeforeDeadline`（剩余时间不足
   * 直接抛）和 mouseReleased 自己的有界包装（`remaining <= 0` 直接 reject），
   * 两处都能在**已经按下**之后中断。不补发的话页面只收到 mousedown、永远收不到
   * mouseup/click：控件停在 :active，站点侧看到「按住不放」本轮必然判失败，
   * 而下一次点击会在浏览器仍认为左键按下的状态下再按一次，事件序列直接错乱。
   */
  it('按下后释放失败时在收尾里补发 mouseReleased，不把左键留在按下态', async () => {
    const dispatched: string[] = [];
    const detach = vi.fn().mockResolvedValue(undefined);
    let releaseAttempts = 0;
    const sendCommand = vi.fn((_target: unknown, method: string, params?: Record<string, unknown>) => {
      if (method === 'Input.dispatchMouseEvent') {
        const type = String(params?.type);
        dispatched.push(type);
        if (type === 'mouseReleased') {
          releaseAttempts += 1;
          // 第一次释放失败（页面导航/CDP 抖动），模拟"按下了但没松手"的中断。
          if (releaseAttempts === 1) return Promise.reject(new Error('CDP 通道中断'));
        }
        return Promise.resolve({});
      }
      if (method === 'Runtime.evaluate') {
        const expression = String((params as { expression?: string } | undefined)?.expression ?? '');
        // installClickProbe / liveTargetPoint / finishClickProbe 共用 Runtime.evaluate，
        // 按表达式特征分辨：落点查询要返回命中的几何，其余返回 true 即可。
        if (expression.includes('getBoundingClientRect')) {
          return Promise.resolve({
            result: {
              value: {
                x: 120, y: 80, hit: true, withinHost: true,
                tag: 'button', id: '', cls: '', width: 40, height: 20,
              },
            },
          });
        }
        return Promise.resolve({ result: { value: true } });
      }
      return Promise.resolve({});
    });
    vi.stubGlobal('chrome', {
      debugger: { attach: vi.fn().mockResolvedValue(undefined), sendCommand, detach },
    });

    await expect(trustedPointerClick(902, {
      x: 120,
      y: 80,
      viewportWidth: 800,
      viewportHeight: 600,
      targetToken: 'p-release5678',
    }, () => 0.5)).rejects.toThrow('CDP 通道中断');

    // 前提：确实走到了按下（否则下面的断言毫无意义）
    expect(dispatched).toContain('mousePressed');
    // 关键断言：第一次释放失败后，收尾必须再补发一次
    expect(releaseAttempts).toBeGreaterThanOrEqual(2);
    expect(detach).toHaveBeenCalled();
  });

  /**
   * attach 包装超时、底层却成功时，仍然必须 detach。
   *
   * `boundedOperation` 只是放弃等待，不取消底层 Promise —— reject 之后
   * `chrome.debugger.attach` 仍可能真的挂上调试器。按「attach 成功才 detach」
   * 写的话调试会话永久泄漏，而本仓库没有 `chrome.debugger.onDetach`、
   * 也没有按 tabId 的兜底清理：此后该标签页所有 attach 都被 Chrome 以
   * 「Another debugger is already attached」拒绝，可信点击/滚动/拖拽/截图
   * 全线失效，页面顶上还一直挂着调试提示栏。
   */
  it('attach 包装超时但底层随后成功时，收尾仍然 detach（不泄漏调试会话）', async () => {
    vi.useFakeTimers();
    const detach = vi.fn().mockResolvedValue(undefined);
    // attach 比包装的 4 秒预算慢，但最终会成功
    const attach = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 6_000)));
    vi.stubGlobal('chrome', {
      debugger: {
        attach,
        sendCommand: vi.fn().mockResolvedValue({}),
        detach,
      },
    });

    const pending = trustedPointerClick(905, {
      x: 120,
      y: 80,
      viewportWidth: 800,
      viewportHeight: 600,
      targetToken: 'p-attachslow99',
    }, () => 0.5);

    const result = expect(pending).rejects.toThrow('debugger.attach');
    await vi.advanceTimersByTimeAsync(4_100);
    await result;

    // 关键断言：即便包装层认为 attach 失败了，也必须尝试 detach。
    expect(attach).toHaveBeenCalled();
    expect(detach).toHaveBeenCalled();
  });

  it('CDP 回调永不返回时，在单步超时后释放调试器并结束 Promise（点击路径）', async () => {
    vi.useFakeTimers();
    const detach = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('chrome', {
      debugger: {
        attach: vi.fn().mockResolvedValue(undefined),
        sendCommand: vi.fn().mockReturnValue(new Promise(() => {})),
        detach,
      },
    });

    const pending = trustedPointerClick(901, {
      x: 120,
      y: 80,
      viewportWidth: 800,
      viewportHeight: 600,
      targetToken: 'p-timeout1234',
    }, () => 0.5);

    const result = expect(pending).rejects.toThrow('点击结果可能未知');
    await vi.advanceTimersByTimeAsync(4_100);
    await result;
    expect(detach).toHaveBeenCalledOnce();
  });

  /**
   * 拖拽路径同样必须有界。
   *
   * 曾经只有点击路径包了 boundedOperation，拖拽与滚动全是裸 sendCommand。
   * 代价比点击更重：拖拽挂住时左键**正按着**，页面停在拖拽态，调试器挂着，
   * 而 slider-crack.ts 的 activeCracks 条目也永久驻留（`.finally()` 永不执行），
   * 该标签页之后每次 SLIDER_CRACK 只能拿到 busy —— 滑块子系统对这个 tab 报废。
   */
  it('一次性拖拽的 CDP 调用永不返回时，超时结束并释放调试器', async () => {
    vi.useFakeTimers();
    const detach = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('chrome', {
      debugger: {
        attach: vi.fn().mockResolvedValue(undefined),
        sendCommand: vi.fn().mockReturnValue(new Promise(() => {})),
        detach,
      },
    });

    const pending = trustedPointerDrag(903, {
      startX: 40,
      startY: 300,
      viewportWidth: 800,
      viewportHeight: 600,
      points: [
        { x: 90, y: 300, delayMs: 12 },
        { x: 150, y: 300, delayMs: 12 },
      ],
    }, () => 0.5);

    const result = expect(pending).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(4_100);
    await result;
    expect(detach).toHaveBeenCalled();
  });

  it('拖拽会话中途截图永不返回时，超时结束而不是永久按住左键', async () => {
    vi.useFakeTimers();
    const detach = vi.fn().mockResolvedValue(undefined);
    const dispatched: string[] = [];
    const sendCommand = vi.fn((_target: unknown, method: string, params?: Record<string, unknown>) => {
      // 截图永不 settle —— 这正是 crackByMeasuredDrag 按下之后要做两次的调用。
      if (method === 'Page.captureScreenshot') return new Promise(() => {});
      if (method === 'Input.dispatchMouseEvent') {
        dispatched.push(String(params?.type));
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });
    vi.stubGlobal('chrome', {
      debugger: { attach: vi.fn().mockResolvedValue(undefined), sendCommand, detach },
    });

    // 会话建立阶段有真实的 pause()（接近轨迹 + 按下前后的停顿），
    // 假定时器下必须手动推进时钟，否则这个 await 永远不会 resolve。
    const opening = openTrustedDragSession(904, {
      startX: 40,
      startY: 300,
      viewportWidth: 800,
      viewportHeight: 600,
    }, () => 0.5);
    await vi.advanceTimersByTimeAsync(2_000);
    const session = await opening;

    expect(dispatched).toContain('mousePressed');

    const shot = expect(session.screenshot()).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(8_100);
    await shot;

    // 截图超时后仍然能松手并释放调试器，不把左键留在按下态。
    const releasing = session.release();
    await vi.advanceTimersByTimeAsync(1_000);
    await releasing;
    expect(dispatched).toContain('mouseReleased');
    expect(detach).toHaveBeenCalled();
  });
});
