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

function reloginTask(): LoginTask {
  return {
    tabId: 17,
    runId: 'run-relogin-balance',
    accountId: 'account-agentrouter',
    siteId: 'site-agentrouter',
    username: 'github_191247',
    password: '',
    effectiveLoginMethod: 'github',
    effectiveCheckinMethod: 'relogin',
    site: {
      id: 'site-agentrouter',
      name: 'Agent Router',
      loginUrl: 'https://agentrouter.org/login',
      loginMethod: 'github',
      selectors: { username: '#username', password: '#password', submit: 'button[type="submit"]' },
      closeModalSelectors: [],
      checkin: { method: 'relogin', logoutApiUrl: '/api/user/logout' },
    },
    createdAt: Date.now(),
    stage: 'checkin',
    context: {
      balanceAfter: { quota: 80, usedQuota: 20, at: 1 },
    },
  };
}

describe('taskState relogin balance baseline', () => {
  beforeEach(() => {
    sessionStore.clear();
  });

  it('stores the pre-logout snapshot in task context without dropping other context', async () => {
    const task = reloginTask();
    const before: BalanceSnapshot = { quota: 100, usedQuota: 50, at: 2 };
    await taskState.put(task.tabId, task);

    const updated = await taskState.saveReloginBalanceBefore(task.tabId, task.runId, before);

    expect(updated?.context).toEqual({
      balanceAfter: task.context?.balanceAfter,
      balanceBefore: before,
    });
    expect((await taskState.get(task.tabId))?.context?.balanceBefore).toEqual(before);
  });

  it('rejects a stale run without changing the active task baseline', async () => {
    const task = reloginTask();
    await taskState.put(task.tabId, task);

    const updated = await taskState.saveReloginBalanceBefore(
      task.tabId,
      'stale-run',
      { quota: 999, usedQuota: 0, at: 3 },
    );

    expect(updated).toBeNull();
    expect((await taskState.get(task.tabId))?.context?.balanceBefore).toBeUndefined();
  });
});
