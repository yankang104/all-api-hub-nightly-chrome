import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 冷启动恢复必须「没有租约就不动网络配置」。
 *
 * 背景（真机复现，非推测）：
 * `chrome.proxy.settings.clear/set` 是网络栈重配置，会中止正在进行的主框架
 * 导航。MV3 的 Worker 空闲即被回收，用户点「签到」唤醒 Worker 的同时，
 * `launchAccount` 刚 `tabs.update()` 出第一跳；此时 `proxyLease.recover()`
 * 若在**没有租约**的情况下照样 `clearProxy()`，首跳就被打断成
 * `net::ERR_ABORTED`，任务页停在 about:blank，任务永远停在 stage=login、
 * 队列一直 busy —— 用户看到的就是签到转圈卡死。
 *
 * 这个测试锁住不变量：holder 为 null 时 recover 不得触碰 chrome.proxy。
 */

const h = vi.hoisted(() => ({
  holder: null as number | null,
  cleared: 0,
  setCalls: 0,
  aliveTabs: new Set<number>(),
}));

vi.mock('@/lib/core/storage', () => ({
  session: {
    async get<T>(key: string, fallback: T): Promise<T> {
      if (key === 'proxyHolderTabId') return (h.holder ?? fallback) as T;
      return fallback;
    },
    async set(key: string, value: unknown): Promise<void> {
      if (key === 'proxyHolderTabId') h.holder = value as number;
    },
    async remove(key: string): Promise<void> {
      if (key === 'proxyHolderTabId') h.holder = null;
    },
  },
  KEYS: {},
}));

vi.mock('@/lib/proxy/proxy', () => ({
  applyProxy: vi.fn(async () => { h.setCalls += 1; }),
  clearProxy: vi.fn(async () => { h.cleared += 1; }),
}));

vi.stubGlobal('chrome', {
  tabs: {
    get: vi.fn(async (tabId: number) => {
      if (!h.aliveTabs.has(tabId)) throw new Error('No tab with id');
      return { id: tabId };
    }),
  },
});

import { proxyLease } from '@/background/proxy/proxy-lease';

describe('proxyLease.recover：无租约时不得重配置网络', () => {
  beforeEach(() => {
    h.holder = null;
    h.cleared = 0;
    h.setCalls = 0;
    h.aliveTabs = new Set();
  });

  it('holder 为 null 时一次 clearProxy 都不能发生（首跳导航会被打断）', async () => {
    await proxyLease.recover([]);
    expect(h.cleared).toBe(0);
  });

  it('与任务启动并发时同样不得 clear：这正是 ERR_ABORTED 的窗口', async () => {
    // 模拟冷启动：recover 与「刚建好标签页、还没有租约」的首跳并发
    h.aliveTabs = new Set([77]);
    await Promise.all([
      proxyLease.recover([77]),
      Promise.resolve(),
    ]);
    expect(h.cleared).toBe(0);
  });

  it('持有者已死时才清理租约（真实僵尸场景仍然要清）', async () => {
    h.holder = 42; // 已关闭的标签页
    await proxyLease.recover([99]);
    expect(h.cleared).toBe(1);
    expect(h.holder).toBeNull();
  });

  it('持有者仍活着且合法时必须原样保留', async () => {
    h.holder = 42;
    h.aliveTabs = new Set([42]);
    await proxyLease.recover([42]);
    expect(h.cleared).toBe(0);
    expect(h.holder).toBe(42);
  });
});
