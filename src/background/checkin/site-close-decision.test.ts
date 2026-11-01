import { describe, expect, it } from 'vitest';

import { shouldCloseTaskTabAfter } from '@/background/checkin/site-close-decision';

const accounts = [
  { id: 's1-a1', siteId: 's1' },
  { id: 's1-a2', siteId: 's1' },
  { id: 's2-a1', siteId: 's2' },
];

const base = {
  siteId: 's1',
  accountId: 's1-a1',
  accounts,
};

describe('站点收尾关页判定', () => {
  it('同站还有 pending 的账号：不关，页面留给下一棒', () => {
    expect(shouldCloseTaskTabAfter({
      ...base,
      queue: { pendingAccountIds: ['s1-a2'] },
    })).toBe(false);
  });

  it('同站账号已经在 active（延迟窗口里已启动）：不关', () => {
    expect(shouldCloseTaskTabAfter({
      ...base,
      queue: { pendingAccountIds: [], activeAccountId: 's1-a2' },
    })).toBe(false);
  });

  it('本站没有剩余、别的站点还在跑：关掉这一页（不泄漏本站标签页）', () => {
    expect(shouldCloseTaskTabAfter({
      ...base,
      queue: { pendingAccountIds: ['s2-a1'], activeAccountId: 's2-a1' },
    })).toBe(true);
  });

  it('单账号站点跑完：关', () => {
    expect(shouldCloseTaskTabAfter({
      ...base,
      queue: { pendingAccountIds: [] },
    })).toBe(true);
  });

  it('空队列 + 空账号台账：不崩，按可关处理', () => {
    expect(shouldCloseTaskTabAfter({
      siteId: 's1',
      accountId: 'ghost',
      accounts: [],
      queue: { pendingAccountIds: [] },
    })).toBe(true);
  });

  it('队列里只剩刚跑完的账号自身（finish 重试失败的残留）：不算本站还有活', () => {
    expect(shouldCloseTaskTabAfter({
      ...base,
      queue: { pendingAccountIds: ['s1-a1'], activeAccountId: 's1-a1' },
    })).toBe(true);
  });

  it('队列里的账号已从台账删除、无法归属站点：不当成本站剩余', () => {
    expect(shouldCloseTaskTabAfter({
      ...base,
      queue: { pendingAccountIds: ['deleted-account'] },
    })).toBe(true);
  });
});