import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BalanceSnapshot, LoginTask } from '@/types';

const { sessionStore } = vi.hoisted(() => ({
  sessionStore: new Map<string, unknown>(),
}));

vi.mock('@/lib/core/storage', () => ({
  session: {
    async get<T>(key: string, fallback: T): Promise<T> {
      return (sessionStore.has(key) ? sessionStore.get(key) : fallback) as T;
    },
    async set(key: string, value: unknown): Promise<void> {
      sessionStore.set(key, value);
    },
    async remove(key: string): Promise<void> {
      sessionStore.delete(key);
    },
  },
}));

vi.mock('@/data/app-repository', () => ({
  appRepository: {
    setStatus: vi.fn(),
    getStatus: vi.fn(),
    setStatusAndResult: vi.fn(),
    clearInFlightStatus: vi.fn(),
    setOutcome: vi.fn(),
  },
}));

import { taskState } from '@/background/checkin/task-state';

const before: BalanceSnapshot = {
  quota: 1476,
  usedQuota: 0,
  symbol: '积分',
  at: 1,
  fromVisibleText: true,
};

function buttonTask(overrides: Partial<LoginTask> = {}): LoginTask {
  return {
    tabId: 23,
    runId: 'run-button-balance',
    accountId: 'account-linux-sb',
    siteId: 'site-linux-sb',
    username: '袁天罡',
    password: 'secret',
    effectiveLoginMethod: 'form',
    effectiveCheckinMethod: 'button',
    siteAccountCount: 2,
    identityConfirmed: true,
    site: {
      id: 'site-linux-sb',
      name: 'Linux.SB',
      loginUrl: 'https://linux.sb/login',
      loginMethod: 'form',
      selectors: { username: '#login', password: '#password', submit: 'button[type="submit"]' },
      closeModalSelectors: [],
      checkin: { method: 'button', url: '/daily_checkin', buttonSelector: 'button' },
    },
    createdAt: Date.now(),
    stage: 'checkin',
    context: { balanceAfter: { quota: 1400, usedQuota: 0, at: 0 } },
    ...overrides,
  };
}

describe('taskState button 点击余额基线', () => {
  beforeEach(() => {
    sessionStore.clear();
  });

  it('只在有效 button 签到阶段保存旧快照和点击用途标记', async () => {
    const task = buttonTask();
    await taskState.put(task.tabId, task);

    const updated = await taskState.saveButtonBalanceBefore(task.tabId, task.runId, before);

    expect(updated?.context).toEqual({
      balanceAfter: task.context?.balanceAfter,
      balanceBefore: before,
      buttonCheckinPending: true,
    });
  });

  it('stale run 不能覆盖当前任务已有的基线', async () => {
    const current = { ...before, quota: 1400, at: 0 };
    const task = buttonTask({
      context: { balanceBefore: current, buttonCheckinPending: true },
    });
    await taskState.put(task.tabId, task);

    const updated = await taskState.saveButtonBalanceBefore(task.tabId, 'stale-run', before);

    expect(updated).toBeNull();
    expect((await taskState.get(task.tabId))?.context?.balanceBefore).toEqual(current);
  });

  it.each([
    ['非 checkin 阶段', { stage: 'verify' as const }],
    ['非 button 方式', { effectiveCheckinMethod: 'api' as const }],
    ['多账号身份未确认', { identityConfirmed: false }],
  ])('%s 拒绝写入点击基线', async (_label, overrides) => {
    const task = buttonTask(overrides);
    await taskState.put(task.tabId, task);

    const updated = await taskState.saveButtonBalanceBefore(task.tabId, task.runId, before);

    expect(updated).toBeNull();
    expect((await taskState.get(task.tabId))?.context?.balanceBefore).toBeUndefined();
  });
});
