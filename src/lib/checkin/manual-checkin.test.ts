import { describe, expect, it } from 'vitest';
import type { AccountBalance } from '@/types';
import { MANUAL_DONE_MESSAGE, manualBalanceDifference, manualDoneResult } from '@/lib/checkin/manual-checkin';

const balanceWithHistory = (): AccountBalance => ({
  quota: 1_069.8 * 500_000,
  usedQuota: 10 * 500_000,
  at: new Date('2026-08-21T10:20:00+08:00').getTime(),
  daily: {
    '2026-08-20': {
      first: { quota: 1_039.8 * 500_000, usedQuota: 10 * 500_000, at: 1, source: 'api' },
      latest: { quota: 1_039.8 * 500_000, usedQuota: 10 * 500_000, at: 2, source: 'api' },
    },
    '2026-08-21': {
      first: { quota: 1_069.8 * 500_000, usedQuota: 10 * 500_000, at: 3, source: 'api' },
      latest: { quota: 1_069.8 * 500_000, usedQuota: 10 * 500_000, at: 3, source: 'api' },
    },
  },
});

describe('manualDoneResult', () => {
  it('标成成功，并留下 manual 标记以区别于自动化验证过的成功', () => {
    const result = manualDoneResult('acc-1');

    expect(result.accountId).toBe('acc-1');
    expect(result.ok).toBe(true);
    expect(result.manual).toBe(true);
  });

  it('不带 metrics —— 手动标记没有额度差分证据，给了界面就会显示假收益', () => {
    expect(manualDoneResult('acc-1').metrics).toBeUndefined();
  });

  it('有历史余额时按总额度差值记录增加量，但仍保留 manual 标记', () => {
    const result = manualDoneResult('acc-1', balanceWithHistory(), '2026-08-21');

    expect(result.manual).toBe(true);
    expect(result.metrics).toMatchObject({
      verdict: 'rewarded',
      reward: 30 * 500_000,
      source: 'balance-diff',
    });
  });

  it('今天已有签到前后快照时优先使用当天差值', () => {
    const balance = balanceWithHistory();
    balance.daily!['2026-08-21'] = {
      first: { quota: 1_059.8 * 500_000, usedQuota: 10 * 500_000, at: 3, source: 'api' },
      latest: { quota: 1_069.8 * 500_000, usedQuota: 10 * 500_000, at: 4, source: 'api' },
    };

    expect(manualBalanceDifference(balance, '2026-08-21')).toMatchObject({
      basis: 'within-day',
      metrics: { verdict: 'rewarded', reward: 10 * 500_000 },
    });
  });

  it('带一条执行说明，保证详情面板打得开而不是空的', () => {
    const result = manualDoneResult('acc-1');

    expect(result.message).toBe(MANUAL_DONE_MESSAGE);
    expect(result.steps.length).toBeGreaterThan(0);
  });
});
