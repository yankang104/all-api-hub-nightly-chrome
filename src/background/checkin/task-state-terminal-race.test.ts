import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginTask, TaskStage } from '@/types';


/**
 * 终态竞态回归：`updateStage` 的「读 status → 写 running」与 `complete` 的
 * 「写 done」之间没有共享锁，交错时会把已落定的 done 覆盖回 running。
 *
 * 用户可见症状：签到成功（results 里有成功记录），但状态永远停在「签到中」，
 * 界面转圈；自动签到模式下表现为任务看起来卡住。
 *
 * 旧探针用 Promise.all 并发跑两个方法，被 task-state 的 writeLocked 顺序
 * 化后碰巧复现不出来。这里改成**受控交错**：把「把 running 写进存储」这个
 * await 点挂在闸门上，在闸门放开之前让 complete() 落定。修复前 complete()
 * 不在同一把锁里，会直接在闸门期间写下 done，随后被放行的 running 覆盖。
 */

const h = vi.hoisted(() => {
  const pad = (n: number) => String(n).padStart(2, '0');
  const todayKey = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  return {
    statusKey: (accountId: string) => `${accountId}:${todayKey()}`,
    sessionStore: new Map<string, unknown>(),
    statusStore: new Map<string, string>(),
    resultStore: new Map<string, unknown>(),
    gate: null as null | Promise<void>,
    statusWriteStarted: false,
    /** 闸门放行前，写入必须保持未落地 */
    async gated<T>(apply: () => T): Promise<T> {
      h.statusWriteStarted = true;
      if (h.gate) await h.gate;
      return apply();
    },
  };
});

vi.mock('@/lib/core/storage', () => ({
  session: {
    async get<T>(key: string, fallback: T): Promise<T> {
      return (h.sessionStore.has(key) ? h.sessionStore.get(key) : fallback) as T;
    },
    async set(key: string, value: unknown): Promise<void> {
      h.sessionStore.set(key, value);
    },
    async remove(key: string): Promise<void> {
      h.sessionStore.delete(key);
    },
  },
  local: {
    get: vi.fn(async () => ({})),
    set: vi.fn(async () => {}),
    setMany: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  },
  KEYS: { status: 'status', results: 'results' },
}));

vi.mock('@/data/app-repository', () => ({
  appRepository: {
    // 修复前的 updateStage 走这条：读完立刻写 running。
    setStatus: vi.fn(async (key: string, value: string) => {
      await h.gated(() => h.statusStore.set(key, value));
    }),
    // 修复后的 updateStage 走这条：判断与写入都在仓库的存储写锁里。
    setStatusUnlessTerminal: vi.fn(async (key: string, value: string) => h.gated(() => {
      const current = h.statusStore.get(key);
      if (current === 'done' || current === 'failed') return false;
      h.statusStore.set(key, value);
      return true;
    })),
    setStatusIfExpected: vi.fn(async (key: string, expected: string, value: string) => h.gated(() => {
      if (h.statusStore.get(key) !== expected) return false;
      h.statusStore.set(key, value);
      return true;
    })),
    getStatus: vi.fn(async (key: string) => h.statusStore.get(key)),
    setOutcome: vi.fn(async (result: { accountId: string; ok: boolean }) => {
      h.statusStore.set(h.statusKey(result.accountId), result.ok ? 'done' : 'failed');
      h.resultStore.set(result.accountId, result);
    }),
    setStatusAndResult: vi.fn(async (value: string, result: { accountId: string }) => {
      h.statusStore.set(h.statusKey(result.accountId), value);
      h.resultStore.set(result.accountId, result);
    }),
    clearInFlightStatus: vi.fn(async () => false),
  },
}));

import { taskState } from '@/background/checkin/task-state';

function makeTask(tabId: number, accountId: string): LoginTask {
  return {
    tabId,
    runId: `run-${accountId}`,
    accountId,
    siteId: `site-${accountId}`,
    username: 'user',
    password: 'secret',
    site: {
      id: `site-${accountId}`,
      name: `Site ${accountId}`,
      loginUrl: 'https://example.test/login',
      selectors: { username: '#username', password: '#password', submit: 'button[type="submit"]' },
      closeModalSelectors: [],
    },
    createdAt: Date.now(),
    stage: 'login' as TaskStage,
    steps: [],
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function flushTicks(times: number): Promise<void> {
  for (let i = 0; i < times; i += 1) await tick();
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await tick();
  }
  throw new Error('waitFor 超时：受控交错没有到达预期位置');
}

describe('taskState 终态竞态', () => {
  beforeEach(() => {
    h.sessionStore.clear();
    h.statusStore.clear();
    h.resultStore.clear();
    h.gate = null;
    h.statusWriteStarted = false;
  });

  it('complete 与 updateStage 的状态写必须互斥，done 不得被 running 覆盖', async () => {
    const task = makeTask(11, 'acc-race');
    await taskState.start(task.tabId, task);
    expect(h.statusStore.get(h.statusKey('acc-race'))).toBe('running');

    let release!: () => void;
    h.gate = new Promise<void>((resolve) => { release = resolve; });

    // updateStage 进入临界区，卡在「写 running」这一步。
    const stage = taskState.updateStage(task.tabId, task.runId, 'checkin', ['mid stage']);
    await waitFor(() => h.statusWriteStarted);

    // 恰好在这个窗口里，任务成功落定。
    let completeSettled = false;
    const completed = taskState
      .complete({ accountId: 'acc-race', ok: true, message: '签到成功', steps: ['ok'] })
      .then(() => { completeSettled = true; });

    await flushTicks(3);
    // 修复前 complete 不在任务锁里，这里已经落定，随后会被 running 覆盖。
    const completeWaitedForStage = !completeSettled;

    release();
    h.gate = null;
    await stage;
    await completed;

    expect(completeWaitedForStage, 'complete 必须等 updateStage 的状态写完成').toBe(true);
    expect(h.statusStore.get(h.statusKey('acc-race'))).toBe('done');
    expect(h.resultStore.get('acc-race')).toMatchObject({ ok: true });
  });

  it('complete 之后迟到的 updateStage 不得把 done 覆盖回 running', async () => {
    const task = makeTask(12, 'acc-late');
    await taskState.start(task.tabId, task);
    await taskState.complete({ accountId: 'acc-late', ok: true, message: 'ok', steps: [] });

    // 公告处理 / SPA 路由变化在成功之后仍会再上报一次 stage。
    await taskState.updateStage(task.tabId, task.runId, 'checkin', ['route change after success']);

    expect(h.statusStore.get(h.statusKey('acc-late'))).toBe('done');
  });

  it('resumeAttention 只能把 attention 恢复成 running，不得复活 done', async () => {
    const task = makeTask(13, 'acc-attention');
    await taskState.start(task.tabId, task);

    h.statusStore.set(h.statusKey('acc-attention'), 'attention');
    expect(await taskState.resumeAttention(task.tabId, task.runId)).toBe(true);
    expect(h.statusStore.get(h.statusKey('acc-attention'))).toBe('running');

    await taskState.complete({ accountId: 'acc-attention', ok: true, message: 'ok', steps: [] });
    expect(await taskState.resumeAttention(task.tabId, task.runId)).toBe(false);
    expect(h.statusStore.get(h.statusKey('acc-attention'))).toBe('done');
  });
});
