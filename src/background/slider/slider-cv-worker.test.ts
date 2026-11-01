/**
 * OpenCV worker 的两条生命周期规则。
 *
 * 这个模块是跨上下文的（Service Worker ↔ Web Worker），两个缺陷都不会报错，
 * 只表现为「白等 12 秒然后当作没有这一路候选」——而 `locateSliderGap` 是
 * `await` 它的，所以那 12 秒是实打实加在签到耗时上的，`SOLVE_DEADLINE_MS`
 * 只有 55 秒。
 *
 *  1. **回调不能互相覆盖** —— 原来每次调用都赋值 `worker.onmessage`。两次匹配
 *     并发时后一次顶掉前一次的监听器，而 worker 回的消息带着前一次的 id，
 *     后一次的监听器按 id 不匹配直接 return —— 前一次永远等不到回包。
 *
 *  2. **死掉的 worker 不能留在缓存里** —— `getCvWorker` 的缓存只看「有没有
 *     promise」。worker 崩溃被 terminate 之后，缓存里仍是那个死对象，此后每次
 *     调用都往死 worker post 消息（不抛错、也永不回消息），每轮白等 12 秒。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

interface FakeWorkerOptions {
  /** 收到匹配请求后多久回消息；null 表示永不回。 */
  replyDelayMs: number | null;
  /** 回消息前先抛一个 error 事件（模拟 worker 崩溃）。 */
  crashOnMessage?: boolean;
}

function installFakeWorker(options: FakeWorkerOptions) {
  const state = {
    created: 0,
    terminated: 0,
    posted: [] as string[],
    instances: [] as FakeWorker[],
  };

  class FakeWorker {
    listeners: Record<string, Array<(event: unknown) => void>> = {};
    dead = false;

    constructor() {
      state.created += 1;
      state.instances.push(this);
      // 握手：真 worker 加载完 opencv.js 后 postMessage('ready')
      setTimeout(() => this.emit('message', { data: 'ready' }), 1);
    }

    addEventListener(type: string, handler: (event: unknown) => void) {
      (this.listeners[type] ||= []).push(handler);
    }

    removeEventListener(type: string, handler: (event: unknown) => void) {
      this.listeners[type] = (this.listeners[type] ?? []).filter((item) => item !== handler);
    }

    emit(type: string, event: unknown) {
      for (const handler of [...(this.listeners[type] ?? [])]) handler(event);
    }

    postMessage(message: { id: string }) {
      state.posted.push(message.id);
      if (this.dead) return; // 死 worker：静默丢弃，永不回消息
      if (options.crashOnMessage) {
        setTimeout(() => this.emit('error', { message: 'wasm trap' }), 2);
        return;
      }
      if (options.replyDelayMs == null) return;
      setTimeout(
        () => this.emit('message', { data: { id: message.id, x: 100, y: 40, maxVal: 0.9 } }),
        options.replyDelayMs,
      );
    }

    terminate() {
      state.terminated += 1;
      this.dead = true;
    }

    // 生产代码不再用这两个赋值式接口；留着以防实现回退时静默失效。
    set onmessage(_handler: unknown) {
      throw new Error('不要用 onmessage 赋值 —— 会覆盖并发调用的监听器');
    }

    set onerror(_handler: unknown) {
      throw new Error('不要用 onerror 赋值 —— 会覆盖 getCvWorker 的崩溃处理');
    }
  }

  vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker);
  vi.stubGlobal('chrome', { runtime: { getURL: (path: string) => path } });
  vi.stubGlobal(
    'ImageData',
    class {
      data: unknown;
      width: number;
      height: number;
      constructor(data: unknown, width: number, height: number) {
        this.data = data;
        this.width = width;
        this.height = height;
      }
    } as unknown as typeof ImageData,
  );
  return state;
}

function shapedTemplate(size: number) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const inside = x > 4 && x < size - 4 && y > 4 && y < size - 4;
      if (!inside) continue;
      data[offset] = 60 + ((x * 3) % 40);
      data[offset + 1] = 60;
      data[offset + 2] = 60;
      data[offset + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

function texturedBackground(width: number, height: number) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const noise = (x * 5 + y * 7) % 23;
      data[offset] = 150 + noise;
      data[offset + 1] = 150 + noise;
      data[offset + 2] = 150 + noise;
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
}

async function loadLocate() {
  const module = await import('@/background/slider/slider-image');
  return module.locateSliderGap;
}

function fixture(module: typeof import('@/background/slider/slider-image')) {
  void module;
  const SIZE = 30;
  const WIDTH = 200;
  const HEIGHT = 120;
  return {
    images: {
      background: texturedBackground(WIDTH, HEIGHT),
      template: {
        image: shapedTemplate(SIZE),
        originalWidth: SIZE,
        originalHeight: SIZE,
        bounds: { x: 0, y: 0, width: SIZE, height: SIZE },
        shapedAlpha: true,
      },
      source: 'viewport-screenshot' as const,
      imageScaleX: 1,
      imageScaleY: 1,
      cropOffsetX: 0,
      cropOffsetPieceX: 0,
    },
    info: {
      panelRect: { x: 0, y: 0, width: WIDTH, height: HEIGHT + 50 },
      backgroundRect: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
      pieceRect: { x: 2, y: 40, width: SIZE, height: SIZE },
      trackRect: { x: 0, y: HEIGHT + 10, width: WIDTH, height: 28 },
      handleRect: { x: 0, y: HEIGHT + 10, width: 30, height: 28 },
      viewportWidth: 1_280,
      viewportHeight: 720,
      devicePixelRatio: 1,
      challengeKey: 'cv-worker',
    },
  };
}

describe('OpenCV worker · 并发调用', () => {
  it('两次并发匹配都拿到自己的结果，不会互相顶掉监听器', async () => {
    installFakeWorker({ replyDelayMs: 25 });
    const module = await import('@/background/slider/slider-image');
    const locateSliderGap = module.locateSliderGap;
    const { images, info } = fixture(module);

    const started = Date.now();
    const [first, second] = await Promise.all([
      locateSliderGap(info, images),
      locateSliderGap(info, images),
    ]);

    // 竞态存在时，先发起的那次要等满 12 秒超时才 resolve。
    expect(Date.now() - started).toBeLessThan(5_000);
    // 两次都应该拿到了 opencv 这一路候选（method 里带 opencv）。
    expect(first?.method ?? '').toContain('opencv');
    expect(second?.method ?? '').toContain('opencv');
  }, 30_000);
});

describe('OpenCV worker · 崩溃后不复用死 worker', () => {
  it('worker 崩溃后下一次调用重建，而不是打在已终止的 worker 上', async () => {
    const state = installFakeWorker({ replyDelayMs: 25, crashOnMessage: true });
    const module = await import('@/background/slider/slider-image');
    const locateSliderGap = module.locateSliderGap;
    const { images, info } = fixture(module);

    // 第一次：worker 在匹配途中崩溃 → 这一路没有候选，但不能卡住
    const started = Date.now();
    await locateSliderGap(info, images);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(state.terminated).toBeGreaterThanOrEqual(1);

    /*
     * 第二次：缓存必须已经失效。
     *
     * 修复前 `cvWorkerPromise` 仍指向那个已 terminate 的 worker，第二次调用
     * 往它 post 消息、永不回包、白等 12 秒。这里断言「没有再往同一个死 worker
     * 上投递」——要么重建了新 worker，要么直接判定不可用（都不会白等）。
     */
    const postedBefore = state.posted.length;
    const secondStarted = Date.now();
    await locateSliderGap(info, images);
    expect(Date.now() - secondStarted).toBeLessThan(5_000);

    const deadInstance = state.instances[0]!;
    const postedToDead = state.posted.length - postedBefore > 0 && state.instances.length === 1;
    // 不允许「只有那一个已死的 worker，却还在往它投递」
    expect(postedToDead && deadInstance.dead).toBe(false);
  }, 30_000);
});
