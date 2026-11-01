/**
 * 跨页面的正文余额不能相减。
 *
 * 这是一次**谎报事故**的回归防线。海獭 AI 实测：候选路由降级让流程在
 * `/dashboard/overview` 与 `/profile` 之间来回跳，两页正文印的数字不是同一个
 * 口径（一个 $3.00、一个 $52.58）。基线取自前者、终值取自后者，守恒差分
 * 算出「签到获得 $49.58」并写进了记录 —— 而站点实际只发了 $3.06。
 *
 * 为什么这比签到失败严重：
 *  - 签到失败用户看得见，会来问；
 *  - 错的收益数字与对的**看起来完全一样**，还会进日台账、进跨天对比，
 *    用户没有任何线索能发现它是假的。
 *
 * 判 unknown 是诚实的：我们确实没有可比的基线。
 */

import { describe, expect, it } from 'vitest';
import type { BalanceSnapshot } from '@/types';
import { diffBalance } from '@/automation/balance/balance';

function visibleAt(path: string, quota: number, usedQuota = 0): BalanceSnapshot {
  return { quota, usedQuota, at: Date.now(), fromVisibleText: true, visiblePath: path };
}

function fromApi(quota: number, usedQuota = 0): BalanceSnapshot {
  return { quota, usedQuota, at: Date.now() };
}

describe('diffBalance · 跨页面正文快照', () => {
  it('两个正文快照来自不同页面时判 unknown，绝不相减', () => {
    // 复刻实测事故的两个数字
    const before = visibleAt('/dashboard/overview', 3);
    const after = visibleAt('/profile', 52.58);

    const metrics = diffBalance(before, after);

    expect(metrics.verdict).toBe('unknown');
    // 关键：绝不能出现 49.58 这个凭空造出来的奖励
    expect(metrics.reward).toBeUndefined();
  });

  it('同一页面的两次正文采样正常相减', () => {
    const before = visibleAt('/profile', 49.52);
    const after = visibleAt('/profile', 52.58);

    const metrics = diffBalance(before, after);

    expect(metrics.verdict).toBe('rewarded');
    expect(metrics.reward).toBeCloseTo(3.06, 2);
  });

  it('同一页面但余额没变时判 unchanged', () => {
    const before = visibleAt('/profile', 52.58);
    const after = visibleAt('/profile', 52.58);

    expect(diffBalance(before, after).verdict).toBe('unchanged');
  });

  it('接口读数不受页面约束 —— 它是账号级的，与在哪一页请求无关', () => {
    const before = fromApi(1_000_000, 500_000);
    const after = fromApi(1_500_000, 500_000);

    const metrics = diffBalance(before, after);

    expect(metrics.verdict).toBe('rewarded');
    expect(metrics.reward).toBe(500_000);
  });

  it('一个来自接口、一个来自正文时仍然相减（不是跨页正文的情形）', () => {
    const before = fromApi(100, 10);
    const after = visibleAt('/profile', 105, 10);

    const metrics = diffBalance(before, after);

    expect(metrics.verdict).toBe('rewarded');
    expect(metrics.reward).toBeCloseTo(5, 6);
  });

  it('旧快照没有 visiblePath 时保持原有行为（兼容升级前的任务）', () => {
    const before: BalanceSnapshot = { quota: 100, usedQuota: 0, at: Date.now(), fromVisibleText: true };
    const after: BalanceSnapshot = { quota: 103, usedQuota: 0, at: Date.now(), fromVisibleText: true };

    const metrics = diffBalance(before, after);

    expect(metrics.verdict).toBe('rewarded');
    expect(metrics.reward).toBeCloseTo(3, 6);
  });

  it('缺少任一快照时判 unknown', () => {
    expect(diffBalance(undefined, visibleAt('/profile', 10)).verdict).toBe('unknown');
    expect(diffBalance(visibleAt('/profile', 10), undefined).verdict).toBe('unknown');
  });

  it('跨页判 unknown 时不带 quotaAfter —— 那个数也来自不可比的页面', () => {
    const metrics = diffBalance(
      visibleAt('/dashboard/overview', 3),
      visibleAt('/profile', 52.58),
    );

    expect(metrics.quotaAfter).toBeUndefined();
  });
});
