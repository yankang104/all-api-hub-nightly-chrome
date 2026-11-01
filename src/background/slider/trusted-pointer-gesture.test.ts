/**
 * 可信指针通道的手势保真：双击 / 右键 / 长按必须真的按语义派发。
 *
 * 现场：学习侧会记录手势，默认回放路径却是可信指针通道，而那条通道过去
 * 只派发一次普通左键单击 —— 用户学到「双击展开」「右键菜单」「长按确认」，
 * 回放只点一下：页面毫无反应，日志却写「已点击」。这是最难查的假成功。
 *
 * 本文件按 CDP 实际收到的参数锁定语义：
 *  - 双击 → 两次 (mousePressed, mouseReleased)，clickCount=2；
 *  - 右键 → button='right'、buttons=2；
 *  - 长按 → 按下与释放之间的等待 ≥ holdMs；
 *  - 未知手势 → 在接触 debugger 之前明确拒绝，不静默降级。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trustedPointerClick } from '@/background/slider/trusted-pointer';

interface Dispatched {
  type: string;
  button?: string;
  buttons?: number;
  clickCount?: number;
}

function stubChrome(dispatched: Dispatched[]): { detach: ReturnType<typeof vi.fn> } {
  const detach = vi.fn().mockResolvedValue(undefined);
  const sendCommand = vi.fn((_target: unknown, method: string, params?: Record<string, unknown>) => {
    if (method === 'Input.dispatchMouseEvent') {
      dispatched.push({
        type: String(params?.type),
        button: typeof params?.button === 'string' ? params.button : undefined,
        buttons: typeof params?.buttons === 'number' ? params.buttons : undefined,
        clickCount: typeof params?.clickCount === 'number' ? params.clickCount : undefined,
      });
      return Promise.resolve({});
    }
    if (method === 'Runtime.evaluate') {
      const expression = String((params as { expression?: string } | undefined)?.expression ?? '');
      if (expression.includes('getBoundingClientRect')) {
        return Promise.resolve({
          result: {
            value: { x: 120, y: 80, hit: true, withinHost: true, tag: 'button', id: '', cls: '', width: 40, height: 20 },
          },
        });
      }
      return Promise.resolve({ result: { value: true } });
    }
    return Promise.resolve({});
  });
  vi.stubGlobal('chrome', { debugger: { attach: vi.fn().mockResolvedValue(undefined), sendCommand, detach } });
  return { detach };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('可信指针手势', () => {
  it('双击派发两次按下/释放，clickCount=2', async () => {
    const dispatched: Dispatched[] = [];
    stubChrome(dispatched);
    await trustedPointerClick(911, {
      x: 120,
      y: 80,
      viewportWidth: 800,
      viewportHeight: 600,
      targetToken: 'p-double1234',
      gesture: 'double',
    }, () => 0.5);

    const presses = dispatched.filter((event) => event.type === 'mousePressed');
    const releases = dispatched.filter((event) => event.type === 'mouseReleased');
    expect(presses.length).toBe(2);
    expect(releases.length).toBe(2);
    // 第一次与第二次都必须带 clickCount=2，否则浏览器不会合成 dblclick
    expect(presses.every((event) => event.clickCount === 2)).toBe(true);
    expect(presses.every((event) => event.button === 'left')).toBe(true);
  });

  it('右键用 button=right + buttons=2，绝不退化成左键', async () => {
    const dispatched: Dispatched[] = [];
    stubChrome(dispatched);
    await trustedPointerClick(912, {
      x: 120,
      y: 80,
      viewportWidth: 800,
      viewportHeight: 600,
      targetToken: 'p-right12345',
      gesture: 'right',
    }, () => 0.5);

    const press = dispatched.find((event) => event.type === 'mousePressed');
    const release = dispatched.find((event) => event.type === 'mouseReleased');
    expect(press?.button).toBe('right');
    expect(press?.buttons).toBe(2);
    expect(release?.button).toBe('right');
    expect(release?.buttons).toBe(0);
  });

  it('长按的按下→释放间隔不短于学习到的 holdMs', async () => {
    vi.useFakeTimers();
    const dispatched: Array<Dispatched & { at: number }> = [];
    const detach = vi.fn().mockResolvedValue(undefined);
    const sendCommand = vi.fn((_target: unknown, method: string, params?: Record<string, unknown>) => {
      if (method === 'Input.dispatchMouseEvent') {
        dispatched.push({
          type: String(params?.type),
          button: typeof params?.button === 'string' ? params.button : undefined,
          buttons: typeof params?.buttons === 'number' ? params.buttons : undefined,
          clickCount: typeof params?.clickCount === 'number' ? params.clickCount : undefined,
          at: Date.now(),
        });
        return Promise.resolve({});
      }
      if (method === 'Runtime.evaluate') {
        const expression = String((params as { expression?: string } | undefined)?.expression ?? '');
        if (expression.includes('getBoundingClientRect')) {
          return Promise.resolve({
            result: {
              value: { x: 120, y: 80, hit: true, withinHost: true, tag: 'button', id: '', cls: '', width: 40, height: 20 },
            },
          });
        }
        return Promise.resolve({ result: { value: true } });
      }
      return Promise.resolve({});
    });
    vi.stubGlobal('chrome', { debugger: { attach: vi.fn().mockResolvedValue(undefined), sendCommand, detach } });

    const pending = trustedPointerClick(913, {
      x: 120,
      y: 80,
      viewportWidth: 800,
      viewportHeight: 600,
      targetToken: 'p-longpress1',
      gesture: 'long-press',
      holdMs: 900,
    }, () => 0.5);
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;

    const press = dispatched.find((event) => event.type === 'mousePressed');
    const release = dispatched.find((event) => event.type === 'mouseReleased');
    expect(press).toBeDefined();
    expect(release).toBeDefined();
    expect(release!.at - press!.at).toBeGreaterThanOrEqual(900);
  });

  it('右键用 contextmenu 判定到位（浏览器对右键不发 click，不能因此误判"事件未到达"）', async () => {
    const dispatched: Dispatched[] = [];
    const detach = vi.fn().mockResolvedValue(undefined);
    const sendCommand = vi.fn((_target: unknown, method: string, params?: Record<string, unknown>) => {
      if (method === 'Input.dispatchMouseEvent') {
        dispatched.push({ type: String(params?.type) });
        return Promise.resolve({});
      }
      if (method === 'Runtime.evaluate') {
        const expression = String((params as { expression?: string } | undefined)?.expression ?? '');
        // 落点查询返回命中几何。
        if (expression.includes('getBoundingClientRect')) {
          return Promise.resolve({
            result: {
              value: { x: 120, y: 80, hit: true, withinHost: true, tag: 'button', id: '', cls: '', width: 40, height: 20 },
            },
          });
        }
        // 探针结算：模拟"右键只到 contextmenu、没有 click"。
        if (expression.includes('contextmenuObserved')) {
          return Promise.resolve({
            result: { value: { clickObserved: false, contextmenuObserved: true } },
          });
        }
        return Promise.resolve({ result: { value: true } });
      }
      return Promise.resolve({});
    });
    vi.stubGlobal('chrome', { debugger: { attach: vi.fn().mockResolvedValue(undefined), sendCommand, detach } });

    const result = await trustedPointerClick(915, {
      x: 120,
      y: 80,
      viewportWidth: 800,
      viewportHeight: 600,
      targetToken: 'p-rightctx123',
      gesture: 'right',
    }, () => 0.5);

    // 关键：右键的到位证据来自 contextmenu，而不是 click。
    expect(result.clickObserved).toBe(true);
  });

  it('未知手势在接触 debugger 之前明确拒绝，不静默降级', async () => {
    const dispatched: Dispatched[] = [];
    const attach = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('chrome', { debugger: { attach, sendCommand: vi.fn().mockResolvedValue({}), detach: vi.fn() } });

    await expect(trustedPointerClick(914, {
      x: 120,
      y: 80,
      viewportWidth: 800,
      viewportHeight: 600,
      targetToken: 'p-unknown123',
      // 故意传入非法手势（例如旧版本或伪造事件）
      gesture: 'triple' as never,
    }, () => 0.5)).rejects.toThrow('未知手势');

    expect(attach).not.toHaveBeenCalled();
    expect(dispatched).toHaveLength(0);
  });
});
