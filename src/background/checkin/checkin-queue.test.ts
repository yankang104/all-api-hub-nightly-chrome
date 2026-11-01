import { beforeEach, describe, expect, it, vi } from 'vitest';

const { store } = vi.hoisted(() => ({ store: new Map<string, unknown>() }));

vi.mock('@/lib/core/storage', () => ({
  session: {
    async get<T>(key: string, fallback: T): Promise<T> {
      const value = store.has(key) ? store.get(key) : fallback;
      return structuredClone(value) as T;
    },
    async set(key: string, value: unknown): Promise<void> {
      store.set(key, structuredClone(value));
    },
  },
}));

import { createCheckinQueue, QUEUE_KEY, type CheckinQueue, type QueueLaunchResult } from '@/background/checkin/checkin-queue';

describe('check-in queue OAuth recovery', () => {
  beforeEach(() => {
    store.clear();
  });

  it('keeps a task that abandon recovered by rebinding to a live OAuth popup', async () => {
    store.set(QUEUE_KEY, {
      pendingAccountIds: ['next-account'],
      active: { accountId: 'oauth-account', tabId: 11, startedAt: 100 },
    });

    const fail = vi.fn();
    const launch = vi.fn();
    let queue!: CheckinQueue;
    queue = createCheckinQueue({
      launch,
      fail,
      isAlive: vi.fn().mockResolvedValue(false),
      async abandon(active) {
        await queue.rebindActiveTab(active.tabId, 22);
      },
      changed: vi.fn(),
    });

    await queue.recover();

    expect(await queue.active()).toMatchObject({ accountId: 'oauth-account', tabId: 22 });
    expect(fail).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });
});

describe('check-in queue launch window', () => {
  beforeEach(() => {
    store.clear();
  });

  it('启动窗口内不把 tabId=0 的任务判死（否则会被当成后台重启并清掉代理）', async () => {
    store.set(QUEUE_KEY, {
      pendingAccountIds: [],
      active: { accountId: 'launching', tabId: 0, startedAt: Date.now(), launching: true },
    });

    const fail = vi.fn();
    const queue = createCheckinQueue({
      launch: vi.fn(),
      fail,
      isAlive: vi.fn().mockResolvedValue(false),
      abandon: vi.fn(),
      changed: vi.fn(),
    });

    await queue.recover();

    expect(await queue.launchInFlight()).toBe(true);
    expect(fail).not.toHaveBeenCalled();
    expect(await queue.active()).toMatchObject({ accountId: 'launching', tabId: 0 });
  });

  it('启动窗口卡死超时后仍按死任务处理，队列不会被永久堵住', async () => {
    store.set(QUEUE_KEY, {
      pendingAccountIds: [],
      active: { accountId: 'stuck', tabId: 0, startedAt: Date.now() - 120_000, launching: true },
    });

    const fail = vi.fn().mockResolvedValue(undefined);
    const launch = vi.fn();
    const queue = createCheckinQueue({
      launch,
      fail,
      isAlive: vi.fn().mockResolvedValue(false),
      abandon: vi.fn().mockResolvedValue(undefined),
      changed: vi.fn(),
    });

    await queue.recover();

    expect(await queue.launchInFlight()).toBe(false);
    expect(fail).toHaveBeenCalledWith('stuck', expect.stringContaining('浏览器后台重启'));
    expect(await queue.active()).toBeUndefined();
    expect(launch).not.toHaveBeenCalled();
  });
});

describe('check-in queue headless completion storage failure', () => {
  beforeEach(() => {
    store.clear();
  });

  it('fails the account and advances to the next instead of stalling when complete() rejects', async () => {
    // 两个 pending、无 active：模拟 headless 直连批处理正要开跑。
    store.set(QUEUE_KEY, { pendingAccountIds: ['acct-1', 'acct-2'] });

    // acct-1 走 headless 直连完成（不占 tab），acct-2 正常开授权标签页。
    const launch = vi.fn(async (accountId: string): Promise<QueueLaunchResult> => {
      if (accountId === 'acct-1') {
        return {
          ok: true,
          completedResult: {
            accountId: 'acct-1',
            ok: true,
            message: 'headless 直连签到成功',
            steps: [],
            via: 'headless',
          },
        };
      }
      return { ok: true, tabId: 42 };
    });
    // 首个账号落库时抛错（storage.session 写失败），后续调用正常。
    const complete = vi.fn().mockRejectedValueOnce(new Error('session 写入失败'));
    const fail = vi.fn().mockResolvedValue(undefined);

    const queue = createCheckinQueue({
      launch,
      complete,
      fail,
      isAlive: vi.fn().mockResolvedValue(false),
      abandon: vi.fn().mockResolvedValue(undefined),
      changed: vi.fn(),
    });

    // recover 会 await 整轮 drain：落库失败不再把异常抛穿队列。
    await queue.recover();

    // 队列没卡死：acct-1 落库失败被判负后，drain 立即推进到 acct-2 开标签页。
    expect(launch).toHaveBeenCalledTimes(2);
    expect(launch.mock.calls.map((call) => call[0])).toEqual(['acct-1', 'acct-2']);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(fail).toHaveBeenCalledWith('acct-1', expect.stringContaining('落库失败'));

    // 单一 active 不变式：此刻只剩 acct-2 占用（tabId 42），没有并存两个 active，
    // pending 也已排空——不必再等 10 分钟超时看门狗兜底。
    expect(await queue.active()).toMatchObject({ accountId: 'acct-2', tabId: 42 });
    const state = store.get(QUEUE_KEY) as { pendingAccountIds: string[] };
    expect(state.pendingAccountIds).toEqual([]);
  });
});

describe('check-in queue snapshot', () => {
  beforeEach(() => {
    store.clear();
  });

  it('一次读回 active 与 pending，供站点收页判定使用', async () => {
    store.set(QUEUE_KEY, {
      pendingAccountIds: ['next-a', 'next-b'],
      active: { accountId: 'running', tabId: 42, startedAt: 100 },
    });

    const queue = createCheckinQueue({
      launch: vi.fn(),
      fail: vi.fn(),
      isAlive: vi.fn(),
      abandon: vi.fn(),
      changed: vi.fn(),
    });

    const snapshot = await queue.snapshot();
    expect(snapshot.pendingAccountIds).toEqual(['next-a', 'next-b']);
    expect(snapshot.active).toMatchObject({ accountId: 'running', tabId: 42 });
  });

  it('空队列快照不崩：pending 为空、没有 active', async () => {
    const queue = createCheckinQueue({
      launch: vi.fn(),
      fail: vi.fn(),
      isAlive: vi.fn(),
      abandon: vi.fn(),
      changed: vi.fn(),
    });

    expect(await queue.snapshot()).toEqual({ pendingAccountIds: [] });
  });
});