import { describe, expect, it } from 'vitest';
import { collectLiveTasks } from '@/background/checkin/live-progress';

const baseTask = {
  tabId: 7,
  runId: 'run-1',
  accountId: 'acc-1',
  siteId: 'site-1',
  username: 'demo_user',
  password: 'super-secret',
  apiToken: 'token-abc',
  session: { accessToken: 'at', refreshToken: 'rt' },
  site: { id: 'site-1' },
  createdAt: 1_000,
  stage: 'checkin',
  steps: ['已填写用户名', '已点击登录按钮'],
};

describe('collectLiveTasks', () => {
  it('只投影任务信箱键，忽略其他 session 条目', () => {
    const live = collectLiveTasks({
      'task:7': baseTask,
      checkinQueue: { pendingAccountIds: ['acc-2'] },
      other: 'noise',
    });
    expect(live).toHaveLength(1);
    expect(live[0]!.accountId).toBe('acc-1');
  });

  it('丢弃没有 runId / accountId 的残破条目', () => {
    const live = collectLiveTasks({
      'task:1': { ...baseTask, runId: undefined },
      'task:2': { ...baseTask, accountId: undefined },
      'task:3': baseTask,
    });
    expect(live).toHaveLength(1);
  });

  it('绝不投影敏感字段（密码 / token / 会话）', () => {
    const [projected] = collectLiveTasks({ 'task:7': baseTask });
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('token-abc');
    expect(serialized).not.toContain('accessToken');
    expect(projected).not.toHaveProperty('password');
    expect(projected).not.toHaveProperty('apiToken');
    expect(projected).not.toHaveProperty('session');
    expect(projected).not.toHaveProperty('site');
  });

  it('按创建时间升序排列', () => {
    const live = collectLiveTasks({
      'task:3': { ...baseTask, runId: 'run-3', accountId: 'acc-3', createdAt: 3_000 },
      'task:1': { ...baseTask, runId: 'run-1', accountId: 'acc-1', createdAt: 1_000 },
      'task:2': { ...baseTask, runId: 'run-2', accountId: 'acc-2', createdAt: 2_000 },
    });
    expect(live.map((t) => t.accountId)).toEqual(['acc-1', 'acc-2', 'acc-3']);
  });

  it('steps 缺失时回落空数组，createdAt 缺失时用当前时间兜底', () => {
    const now = Date.now();
    const [projected] = collectLiveTasks({
      'task:9': { ...baseTask, runId: 'run-9', steps: undefined, createdAt: undefined },
    });
    expect(projected!.steps).toEqual([]);
    expect(projected!.startedAt).toBeGreaterThanOrEqual(now);
  });
});