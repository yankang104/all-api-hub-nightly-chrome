import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginTask, TaskStage } from '@/types';

const { values } = vi.hoisted(() => ({ values: new Map<string, unknown>() }));
vi.mock('@/lib/core/storage', () => ({ session: {
  get: async (key: string, fallback: unknown) => values.has(key) ? values.get(key) : fallback,
  set: async (key: string, value: unknown) => { values.set(key, value); },
} }));
vi.mock('@/data/app-repository', () => ({ appRepository: { setStatusUnlessTerminal: vi.fn() } }));
import { taskState } from './task-state';

const task: LoginTask = {
  tabId: 1, runId: 'active', accountId: 'alice', siteId: 'runtime', username: 'alice', password: 'sentinel',
  identityConfirmed: true, githubCredentialsSubmitted: true, stage: 'checkin', createdAt: 1,
  site: { id: 'runtime', name: '会话重置', loginUrl: 'https://fixture.invalid/login',
    selectors: { username: '#u', password: '#p', submit: '#s' }, closeModalSelectors: [] },
};

beforeEach(() => { values.clear(); vi.clearAllMocks(); });
describe('重新认证时清除旧的身份确认', () => {
  it.each<TaskStage>(['login', 'github-logout', 'relogin'])('%s 阶段不沿用旧会话确认', async (stage) => {
    await taskState.put(1, task);
    const next = await taskState.updateStage(1, 'active', stage, ['恢复会话']);
    expect(next?.identityConfirmed).toBe(false);
    expect((await taskState.get(1))?.identityConfirmed).toBe(false);
    if (stage !== 'relogin') expect(next?.githubCredentialsSubmitted).toBe(false);
  });

  it('普通签到页导航保留本轮确认，过期任务不能修改它', async () => {
    await taskState.put(1, task);
    expect((await taskState.updateStage(1, 'active', 'checkin', ['导航']))?.identityConfirmed).toBe(true);
    expect(await taskState.updateStage(1, 'old-run', 'login', [])).toBeNull();
    expect((await taskState.get(1))?.identityConfirmed).toBe(true);
  });
});
