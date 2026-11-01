import { describe, expect, it } from 'vitest';
import {
  HEADLESS_COOLDOWN_MS,
  HEADLESS_FAILURE_THRESHOLD,
  type HeadlessStats,
  describeHeadlessStat,
  pruneHeadlessStats,
  recordHeadlessOutcome,
  resetHeadlessStat,
  shouldTryHeadless,
} from '@/lib/checkin/headless-eligibility';

const T0 = 1_700_000_000_000;

/** 连续记 n 次 unsupported */
function failTimes(stats: HeadlessStats, siteId: string, n: number, now = T0): HeadlessStats {
  let current = stats;
  for (let i = 0; i < n; i += 1) {
    current = recordHeadlessOutcome(current, siteId, 'unsupported', now + i);
  }
  return current;
}

describe('shouldTryHeadless', () => {
  it('没有记录的站点默认尝试', () => {
    expect(shouldTryHeadless({}, 'site-a', T0)).toBe(true);
  });

  it('未达阈值时继续尝试', () => {
    const stats = failTimes({}, 'site-a', HEADLESS_FAILURE_THRESHOLD - 1);
    expect(shouldTryHeadless(stats, 'site-a', T0)).toBe(true);
  });

  it('达到阈值后熔断', () => {
    const stats = failTimes({}, 'site-a', HEADLESS_FAILURE_THRESHOLD);
    expect(shouldTryHeadless(stats, 'site-a', T0)).toBe(false);
  });

  it('冷却期过后重新给机会（站点可能升级后加了接口）', () => {
    const stats = failTimes({}, 'site-a', HEADLESS_FAILURE_THRESHOLD);
    // 基于实际写入的截止时间断言，而不是手算偏移：failTimes 每次推进 1ms，
    // 熔断起点是最后一次失败的时刻，不是 T0
    const until = stats['site-a']!.disabledUntil!;
    expect(shouldTryHeadless(stats, 'site-a', until - 1)).toBe(false);
    expect(shouldTryHeadless(stats, 'site-a', until)).toBe(true);
  });

  it('熔断只影响该站点，不影响其它站点', () => {
    const stats = failTimes({}, 'site-a', HEADLESS_FAILURE_THRESHOLD);
    expect(shouldTryHeadless(stats, 'site-b', T0)).toBe(true);
  });
});

describe('recordHeadlessOutcome 计数规则', () => {
  it('unsupported 累加计数', () => {
    const stats = failTimes({}, 'site-a', 2);
    expect(stats['site-a']!.consecutiveFailures).toBe(2);
    expect(stats['site-a']!.disabledUntil).toBeUndefined();
  });

  it('达到阈值时写入熔断截止时间', () => {
    const stats = failTimes({}, 'site-a', HEADLESS_FAILURE_THRESHOLD, T0);
    const until = stats['site-a']!.disabledUntil;
    expect(until).toBeDefined();
    expect(until).toBeGreaterThan(T0);
  });

  it('一次成功清零并解除熔断', () => {
    const failed = failTimes({}, 'site-a', HEADLESS_FAILURE_THRESHOLD);
    expect(shouldTryHeadless(failed, 'site-a', T0)).toBe(false);

    const recovered = recordHeadlessOutcome(failed, 'site-a', 'success', T0 + 1);
    expect(recovered['site-a']!.consecutiveFailures).toBe(0);
    expect(recovered['site-a']!.disabledUntil).toBeUndefined();
    expect(shouldTryHeadless(recovered, 'site-a', T0 + 1)).toBe(true);
  });

  it('网络 error 不计数 —— 断网不该被固化成站点不支持', () => {
    let stats = recordHeadlessOutcome({}, 'site-a', 'error', T0);
    stats = recordHeadlessOutcome(stats, 'site-a', 'error', T0 + 1);
    stats = recordHeadlessOutcome(stats, 'site-a', 'error', T0 + 2);
    stats = recordHeadlessOutcome(stats, 'site-a', 'error', T0 + 3);
    expect(stats['site-a']!.consecutiveFailures).toBe(0);
    expect(shouldTryHeadless(stats, 'site-a', T0 + 3)).toBe(true);
  });

  it('auth-expired 不计数 —— 浏览器登录后下次可能就好了', () => {
    let stats = {} as HeadlessStats;
    for (let i = 0; i < 5; i += 1) {
      stats = recordHeadlessOutcome(stats, 'site-a', 'auth-expired', T0 + i);
    }
    expect(stats['site-a']!.consecutiveFailures).toBe(0);
    expect(shouldTryHeadless(stats, 'site-a', T0)).toBe(true);
  });

  it('inconclusive 不计数但记下判定', () => {
    const stats = recordHeadlessOutcome({}, 'site-a', 'inconclusive', T0);
    expect(stats['site-a']!.consecutiveFailures).toBe(0);
    expect(stats['site-a']!.lastVerdict).toBe('inconclusive');
  });

  it('unsupported 之后来一次 error 不会清零也不会累加', () => {
    let stats = failTimes({}, 'site-a', 2);
    stats = recordHeadlessOutcome(stats, 'site-a', 'error', T0 + 10);
    expect(stats['site-a']!.consecutiveFailures).toBe(2);
  });

  it('不修改入参', () => {
    const original: HeadlessStats = { 'site-a': { consecutiveFailures: 1 } };
    const snapshot = JSON.stringify(original);
    recordHeadlessOutcome(original, 'site-a', 'unsupported', T0);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it('记下最近尝试时间与判定', () => {
    const stats = recordHeadlessOutcome({}, 'site-a', 'unsupported', T0);
    expect(stats['site-a']!.lastAttemptAt).toBe(T0);
    expect(stats['site-a']!.lastVerdict).toBe('unsupported');
  });
});

describe('resetHeadlessStat', () => {
  it('清掉记录让直连立即可用', () => {
    const stats = failTimes({}, 'site-a', HEADLESS_FAILURE_THRESHOLD);
    const reset = resetHeadlessStat(stats, 'site-a');
    expect(reset['site-a']).toBeUndefined();
    expect(shouldTryHeadless(reset, 'site-a', T0)).toBe(true);
  });

  it('没有记录时原样返回', () => {
    const stats: HeadlessStats = {};
    expect(resetHeadlessStat(stats, 'site-a')).toBe(stats);
  });
});

describe('describeHeadlessStat', () => {
  it('熔断中给出可读说明', () => {
    const stats = failTimes({}, 'site-a', HEADLESS_FAILURE_THRESHOLD, T0);
    const text = describeHeadlessStat(stats['site-a']!, T0);
    expect(text).toContain('不再尝试 API 直连');
    expect(text).toContain(String(HEADLESS_FAILURE_THRESHOLD));
  });

  it('未熔断时无需说明', () => {
    expect(describeHeadlessStat({ consecutiveFailures: 1 }, T0)).toBeNull();
    expect(describeHeadlessStat(undefined, T0)).toBeNull();
  });

  it('冷却期已过时不再提示', () => {
    const stats = failTimes({}, 'site-a', HEADLESS_FAILURE_THRESHOLD, T0);
    expect(describeHeadlessStat(stats['site-a']!, stats['site-a']!.disabledUntil!)).toBeNull();
  });
});

describe('pruneHeadlessStats 孤儿清理', () => {
  it('删掉已不存在站点的记录', () => {
    const stats = failTimes({ 'site-b': { consecutiveFailures: 1 } }, 'site-a', 1);
    const pruned = pruneHeadlessStats(stats, ['site-b']);
    expect(pruned['site-a']).toBeUndefined();
    expect(pruned['site-b']).toBeDefined();
  });

  it('无需清理时返回原对象（避免无意义的 storage 写）', () => {
    const stats: HeadlessStats = { 'site-a': { consecutiveFailures: 0 } };
    expect(pruneHeadlessStats(stats, ['site-a'])).toBe(stats);
  });
});
