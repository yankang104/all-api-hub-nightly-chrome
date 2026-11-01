import { describe, expect, it } from 'vitest';
import type { AccountBalance } from '@/types';
import {
  appendDailyBalance,
  appendDailyReward,
  balanceHistoryRows,
  LOGIN_CHECKIN_BASELINE_MAX_AGE_MS,
  loginCheckinBalanceBaseline,
} from '@/lib/balance/balance-history';

const at = (value: string) => new Date(value).getTime();

describe('daily balance history', () => {
  it('keeps the first and latest sample of each local date', () => {
    const first = { quota: 100, usedQuota: 20, at: at('2026-08-21T08:00:00+08:00'), source: 'api' as const };
    const previous: AccountBalance = { ...first, daily: appendDailyBalance(undefined, first) };
    const latest = { quota: 150, usedQuota: 20, at: at('2026-08-21T09:00:00+08:00'), source: 'api' as const };
    const daily = appendDailyBalance(previous, latest);

    expect(daily['2026-08-21']).toMatchObject({ first, latest });
    expect(balanceHistoryRows({ ...latest, daily })[0]).toMatchObject({
      day: '2026-08-21',
      withinDayDelta: 50,
    });
  });

  it('computes adjacent-day change with quota plus cumulative usage', () => {
    const yesterday = { quota: 100, usedQuota: 40, at: at('2026-08-20T22:00:00+08:00'), source: 'api' as const };
    let balance: AccountBalance = { ...yesterday, daily: appendDailyBalance(undefined, yesterday) };
    const today = { quota: 120, usedQuota: 70, at: at('2026-08-21T09:00:00+08:00'), source: 'api' as const };
    balance = { ...today, daily: appendDailyBalance(balance, today) };

    expect(balanceHistoryRows(balance)[0]).toMatchObject({
      day: '2026-08-21',
      previousDay: '2026-08-20',
      previousDayDelta: 50,
    });
  });

  it('lazily migrates a successful legacy balance and skips an errored one', () => {
    const old: AccountBalance = { quota: 80, usedQuota: 10, at: at('2026-08-20T10:00:00+08:00') };
    const next = { quota: 90, usedQuota: 10, at: at('2026-08-21T10:00:00+08:00') };
    expect(appendDailyBalance(old, next)).toHaveProperty('2026-08-20');
    expect(appendDailyBalance({ ...old, error: 'timeout' }, next)).not.toHaveProperty('2026-08-20');
  });

  it('keeps the detected currency on current and migrated history points', () => {
    const old: AccountBalance = {
      quota: 319.63,
      usedQuota: 0,
      symbol: '¥',
      at: at('2026-08-20T10:00:00+08:00'),
      source: 'visible',
    };
    const next = {
      quota: 325.63,
      usedQuota: 0,
      symbol: '¥' as const,
      at: at('2026-08-21T10:00:00+08:00'),
      source: 'visible' as const,
    };

    const daily = appendDailyBalance(old, next);

    expect(daily['2026-08-20']?.latest?.symbol).toBe('¥');
    expect(daily['2026-08-21']?.latest?.symbol).toBe('¥');
  });

  it('retains only the newest configured number of dates and stores daily reward', () => {
    let balance: AccountBalance | undefined;
    for (let day = 1; day <= 5; day += 1) {
      const point = { quota: day, usedQuota: 0, at: at(`2026-08-0${day}T10:00:00+08:00`) };
      balance = { ...point, daily: appendDailyBalance(balance, point, 3) };
    }
    expect(Object.keys(balance!.daily!)).toEqual(['2026-08-03', '2026-08-04', '2026-08-05']);

    const daily = appendDailyReward(balance!.daily, '2026-08-05', 2.5, at('2026-08-05T11:00:00+08:00'), 3);
    expect(daily['2026-08-05']).toMatchObject({ checkinReward: 2.5 });
  });

  it('同日同金额的无符号刷新保留已经识别到的人民币符号', () => {
    const first = appendDailyReward(undefined, '2026-08-21', 10.31, at('2026-08-21T10:00:00+08:00'), 90, '¥');
    const refreshed = appendDailyReward(first, '2026-08-21', 10.31, at('2026-08-21T10:01:00+08:00'));

    expect(refreshed['2026-08-21']).toMatchObject({
      checkinReward: 10.31,
      checkinRewardSymbol: '¥',
    });
  });
});

describe('登录即签到历史余额基线', () => {
  const taskCreatedAt = at('2026-08-22T08:00:00+08:00');

  it('刷新失败时忽略伪装成新时间的顶层旧值，使用最近一次成功台账', () => {
    const successful = {
      quota: 590_000_000,
      usedQuota: 5_000_000,
      symbol: '$' as const,
      at: at('2026-08-21T08:05:00+08:00'),
      source: 'visible' as const,
    };
    const balance: AccountBalance = {
      quota: successful.quota,
      usedQuota: successful.usedQuota,
      symbol: successful.symbol,
      at: at('2026-08-22T07:59:00+08:00'),
      source: 'visible',
      error: '本次刷新失败',
      daily: {
        '2026-08-21': { first: successful, latest: successful },
      },
    };

    expect(loginCheckinBalanceBaseline(balance, taskCreatedAt)).toEqual({
      quota: successful.quota,
      usedQuota: successful.usedQuota,
      symbol: '$',
      at: successful.at,
      fromVisibleText: true,
    });
  });

  it('拒绝过旧或晚于任务创建时间的采样，不虚构今日增加量', () => {
    const stale: AccountBalance = {
      quota: 100,
      usedQuota: 20,
      at: taskCreatedAt - LOGIN_CHECKIN_BASELINE_MAX_AGE_MS - 1,
    };
    const future: AccountBalance = {
      quota: 100,
      usedQuota: 20,
      at: taskCreatedAt + 1,
    };

    expect(loginCheckinBalanceBaseline(stale, taskCreatedAt)).toBeUndefined();
    expect(loginCheckinBalanceBaseline(future, taskCreatedAt)).toBeUndefined();
  });
});
