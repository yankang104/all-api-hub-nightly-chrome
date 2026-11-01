import { describe, expect, it } from 'vitest';
import type { AccountBalance } from '@/types';
import { LOGIN_CHECKIN_BASELINE_MAX_AGE_MS } from '@/lib/balance/balance-history';
import {
  LOGIN_CHECKIN_BASELINE_LOADED_NOTE,
  loginCheckinBaselineStepNote,
} from '@/lib/balance/login-checkin-baseline-note';

const at = (value: string) => new Date(value).getTime();

const taskCreatedAt = at('2026-10-16T17:34:00+08:00');

/** 只有顶层成功采样的账号（旧数据或首次写入前的样子）。 */
const balanceWith = (point: AccountBalance['at'], extra: Partial<AccountBalance> = {}): AccountBalance => ({
  quota: 100,
  usedQuota: 0,
  at: point,
  source: 'api',
  ...extra,
});

describe('登录即签到基线说明', () => {
  it('从未成功读过余额时点明原因，而不是笼统说没有基线', () => {
    const note = loginCheckinBaselineStepNote(undefined, taskCreatedAt);

    expect(note).toBe('该账号还没有成功读取过余额，本次只能刷新余额，无法计算登录带来的额度增加量');
    expect(note).toContain('只能刷新余额');
    expect(note).not.toContain('没有最近的账号余额基线');
  });

  it('从未成功读过余额时，失败记录不会被当成成功读数', () => {
    const failed: AccountBalance = {
      quota: 0,
      usedQuota: 0,
      at: taskCreatedAt - 60_000,
      error: 'HTTP 502',
    };

    const note = loginCheckinBaselineStepNote(failed, taskCreatedAt);

    expect(note).toBe('该账号还没有成功读取过余额，本次只能刷新余额，无法计算登录带来的额度增加量');
  });

  it('有成功读数但超过 36 小时时，给出读取时间和窗口，说明为什么没有采用', () => {
    const stale = balanceWith(
      at('2026-10-14T09:00:00+08:00'),
      { daily: { '2026-10-14': { latest: { quota: 100, usedQuota: 0, at: at('2026-10-14T09:00:00+08:00'), source: 'api' } } } },
    );

    const note = loginCheckinBaselineStepNote(stale, taskCreatedAt);

    expect(note).toContain('2026-10-14 09:00');
    expect(note).toContain('36 小时');
    expect(note).toContain('未用作登录前基线');
    expect(note).toContain('只能刷新余额');
  });

  it('刷新失败时用 daily 里的成功采样说明时间，不用失败时间冒充成功读数', () => {
    const errored: AccountBalance = {
      quota: 1373.79,
      usedQuota: 0,
      // 顶层 at 是这次**失败**的时间，不能当作「最近一次成功读取于…」
      at: at('2026-10-16T17:00:00+08:00'),
      error: '本次刷新失败',
      daily: {
        '2026-10-14': {
          latest: { quota: 1373.79, usedQuota: 0, at: at('2026-10-14T09:00:00+08:00'), source: 'api' },
        },
      },
    };

    const note = loginCheckinBaselineStepNote(errored, taskCreatedAt);

    expect(note).toContain('2026-10-14 09:00');
    expect(note).not.toContain('2026-10-16 17:00');
  });

  it('成功读数晚于任务开始时间时如实说明，不谎称超龄', () => {
    const future = balanceWith(taskCreatedAt + 60_000);

    const note = loginCheckinBaselineStepNote(future, taskCreatedAt);

    expect(note).toContain('晚于本次任务开始时间');
    expect(note).toContain('36 小时');
    expect(note).toContain('只能刷新余额');
  });

  it('窗口内的成功读数仍走原有正面文案，策略没有被改动', () => {
    const fresh = balanceWith(taskCreatedAt - LOGIN_CHECKIN_BASELINE_MAX_AGE_MS + 60_000);

    expect(loginCheckinBaselineStepNote(fresh, taskCreatedAt)).toBe(LOGIN_CHECKIN_BASELINE_LOADED_NOTE);
    expect(LOGIN_CHECKIN_BASELINE_LOADED_NOTE).toBe(
      '已载入该账号最近一次成功余额，登录后将按总额度差计算今日增加量',
    );
  });

  it('每天只留一个日期的真实场景：今天刷新过、前天是旧采样时用最近的成功样本', () => {
    const today = at('2026-10-16T08:00:00+08:00');
    const older = at('2026-10-14T09:00:00+08:00');
    const balance: AccountBalance = {
      quota: 1423.79,
      usedQuota: 1022.28,
      at: today,
      source: 'api',
      daily: {
        '2026-10-14': { latest: { quota: 1373.79, usedQuota: 0, at: older, source: 'api' } },
        '2026-10-16': { latest: { quota: 1423.79, usedQuota: 0, at: today, source: 'api' } },
      },
    };

    // 10-16 08:00 距 17:34 约 9.5 小时，仍在窗口内 → 用的是今天的采样
    expect(loginCheckinBaselineStepNote(balance, taskCreatedAt)).toBe(LOGIN_CHECKIN_BASELINE_LOADED_NOTE);
  });
});