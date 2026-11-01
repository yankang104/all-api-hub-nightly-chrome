import { describe, expect, it } from 'vitest';
import { orphanRunningAccounts } from '@/background/checkin/stuck-tasks';

const DAY = '2026-08-19';

describe('orphanRunningAccounts 捞回卡在「执行中」的账号', () => {
  it('队列不认、也没有任务信箱的 running 是孤儿', () => {
    expect(orphanRunningAccounts({
      statuses: { [`a:${DAY}`]: 'running' },
      day: DAY,
    })).toEqual(['a']);
  });

  it('正在执行的账号不能被当成孤儿', () => {
    expect(orphanRunningAccounts({
      statuses: { [`a:${DAY}`]: 'running' },
      day: DAY,
      activeAccountId: 'a',
    })).toEqual([]);
  });

  it('排队中的账号不算孤儿', () => {
    expect(orphanRunningAccounts({
      statuses: { [`a:${DAY}`]: 'running' },
      day: DAY,
      pendingAccountIds: ['a'],
    })).toEqual([]);
  });

  it('还有任务信箱说明页面真在跑（headless 之外的活口）', () => {
    expect(orphanRunningAccounts({
      statuses: { [`a:${DAY}`]: 'running' },
      day: DAY,
      liveAccountIds: ['a'],
    })).toEqual([]);
  });

  it('等人工处理的任务丢了信箱也要捞回来 —— 否则没人能再推进它', () => {
    expect(orphanRunningAccounts({
      statuses: { [`a:${DAY}`]: 'attention' },
      day: DAY,
    })).toEqual(['a']);
  });

  it('终态不动：done / failed 是结论，不是卡住', () => {
    expect(orphanRunningAccounts({
      statuses: { [`a:${DAY}`]: 'done', [`b:${DAY}`]: 'failed' },
      day: DAY,
    })).toEqual([]);
  });

  it('只看今天，历史台账不许改写', () => {
    expect(orphanRunningAccounts({
      statuses: { [`a:2026-08-18`]: 'running', [`b:${DAY}`]: 'running' },
      day: DAY,
    })).toEqual(['b']);
  });

  it('账号 id 里含冒号也能正确切出来', () => {
    expect(orphanRunningAccounts({
      statuses: { [`acc:1:${DAY}`]: 'running' },
      day: DAY,
    })).toEqual(['acc:1']);
  });
});
