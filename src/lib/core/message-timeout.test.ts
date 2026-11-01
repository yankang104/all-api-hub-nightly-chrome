/**
 * 消息往返必须有兜底超时。
 *
 * 修的是一次**静默挂死**（Orbelis 实测）：日志停在「已保存签到按钮点击前的
 * 余额基线」，下一行本该是「已点击签到按钮」，但一分半钟没有任何输出，
 * 界面上一直显示「正在签到 1 分 24 秒」。
 *
 * 原因：MV3 Service Worker 会被浏览器回收。若恰好在处理某条消息时被回收，
 * `chrome.runtime.sendMessage` 的回调**永远不会触发**，也不会设置 `lastError`
 * —— content script 就挂在那个 await 上。而 `mayNavigate` 的点击不受任何
 * 超时保护（它本来就允许"页面跳走、拿不到回包"），只能等 10 分钟看门狗。
 *
 * 报错比挂死好：用户看得见发生了什么，重试也有出口。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendMessage } from '@/lib/core/messaging';

interface FakeChrome {
  runtime: {
    id?: string;
    lastError?: { message?: string };
    sendMessage: (msg: unknown, cb: (resp: unknown) => void) => void;
  };
}

function installChrome(impl: FakeChrome['runtime']['sendMessage']): void {
  vi.stubGlobal('chrome', {
    runtime: { id: 'test-extension', sendMessage: impl },
  } satisfies FakeChrome);
}

describe('sendMessage 超时', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('后台永不回调时按超时失败，而不是永久挂起', async () => {
    // 复刻 Service Worker 被回收：回调从不触发，也不设 lastError
    installChrome(() => {});

    const pending = sendMessage({ type: 'GET_TASK' });
    await vi.advanceTimersByTimeAsync(45_000);
    const response = await pending;

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error).toContain('没有响应');
      expect(response.error).toContain('GET_TASK');
      // 要点名 Service Worker，否则用户无从判断该重试还是改配置
      expect(response.error).toContain('Service Worker');
    }
  });

  it('超时前正常回包不受影响', async () => {
    installChrome((_msg, cb) => {
      setTimeout(() => cb({ ok: true, task: null }), 1_000);
    });

    const pending = sendMessage({ type: 'GET_TASK' });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toEqual({ ok: true, task: null });
  });

  it('回包到达后不再被超时覆盖（只结算一次）', async () => {
    installChrome((_msg, cb) => {
      setTimeout(() => cb({ ok: true }), 500);
    });

    const pending = sendMessage({ type: 'GET_TASK' });
    await vi.advanceTimersByTimeAsync(60_000);

    // 即使推过了超时点，结果仍是先到的那个成功回包
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('lastError 立刻失败，不等满超时', async () => {
    installChrome((_msg, cb) => {
      (globalThis as unknown as { chrome: FakeChrome }).chrome.runtime.lastError = {
        message: 'Receiving end does not exist',
      };
      cb(undefined);
    });

    const response = await sendMessage({ type: 'GET_TASK' });

    expect(response).toEqual({ ok: false, error: 'Receiving end does not exist' });
  });

  it('扩展上下文失效（同步抛错）时返回失败而不是抛出', async () => {
    installChrome(() => {
      throw new Error('Extension context invalidated.');
    });

    const response = await sendMessage({ type: 'GET_TASK' });

    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error).toContain('Extension context invalidated');
  });

  it('回包为 undefined 时视为成功（后台的空响应约定）', async () => {
    installChrome((_msg, cb) => cb(undefined));

    await expect(sendMessage({ type: 'GET_TASK' })).resolves.toEqual({ ok: true });
  });
});

/**
 * 端口扫描的预算必须按端口数算。
 *
 * 修的是「代理功能不可用 —— 节点全部测不通/超时」：chrome.proxy 是浏览器
 * 全局设置，端口只能串行试，单个不通的端口要等 8 秒。默认范围 7901-7916
 * 共 16 个端口，全不通就是 128 秒，而固定的 45 秒预算在第 6 个端口就到点 ——
 * UI 把「后台还在扫」显示成「所有节点都测不通」。
 */
describe('sendMessage 按消息类型给预算', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('16 个端口的快速扫描撑过 128 秒串行耗时', async () => {
    installChrome((_msg, cb) => {
      // 后台串行试完 16 个不通的端口：16 × 8s
      setTimeout(() => cb({ ok: true, feature: { portScan: { entries: [], live: 0 } } }), 128_000);
    });

    const ports = Array.from({ length: 16 }, (_, index) => 7901 + index);
    const pending = sendMessage({ type: 'SCAN_LOCAL_PORTS', host: '127.0.0.1', ports, scheme: 'http' });
    await vi.advanceTimersByTimeAsync(128_000);

    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  it('勾选查出口后按更慢的单端口耗时放宽', async () => {
    installChrome((_msg, cb) => {
      // 每端口 12s 连通 + 两次 6s 地理接口
      setTimeout(() => cb({ ok: true, feature: { portScan: { entries: [], live: 0 } } }), 4 * 24_000);
    });

    const pending = sendMessage({
      type: 'SCAN_LOCAL_PORTS',
      host: '127.0.0.1',
      ports: [7901, 7902, 7903, 7904],
      scheme: 'http',
      withExit: true,
    });
    await vi.advanceTimersByTimeAsync(4 * 24_000);

    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  it('扫描仍有上限，后台真的丢了回包照样报错', async () => {
    installChrome(() => {});

    const pending = sendMessage({
      type: 'SCAN_LOCAL_PORTS', host: '127.0.0.1', ports: [7901, 7902], scheme: 'http',
    });
    // 2 × 8s + 10s 固定开销 = 26s，推过它就该报错
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(pending).resolves.toMatchObject({ ok: false });
  });

  it('签到路径上的消息仍是 45 秒，不被扫描的放宽拖长', async () => {
    installChrome(() => {});

    const pending = sendMessage({ type: 'GET_TASK' });
    await vi.advanceTimersByTimeAsync(45_000);
    const response = await pending;

    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error).toContain('45 秒');
  });

  it('单个节点点测试给到查出口那一档的预算', async () => {
    installChrome((_msg, cb) => {
      setTimeout(() => cb({ ok: true }), 24_000);
    });

    const pending = sendMessage({
      type: 'TEST_PROXY',
      proxy: { id: 'p1', name: 'n', scheme: 'http', host: '127.0.0.1', port: 11025 },
    });
    await vi.advanceTimersByTimeAsync(24_000);

    await expect(pending).resolves.toMatchObject({ ok: true });
  });
});
