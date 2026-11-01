/**
 * 「这个站点还值得试 API 直连吗」的熔断判断。
 *
 * 为什么需要：直连是**默认对所有站点尝试**的，包括那些根本没有签到接口的。
 * 不记账的话，每个不支持的站点每天都要白发两三个请求 —— 慢一点还能忍，
 * 但对站点是无意义的流量，也是不必要的风控面。
 *
 * 熔断只针对 `unsupported`（站点确实没这个接口），**不针对网络错误** ——
 * 用户断网或代理抽风时把站点标记成不支持，等网络恢复后还得等 24 小时才
 * 重新尝试，那是把临时故障固化成长期降级。
 *
 * 纯函数 + 显式时间参数，不读 Date.now() 也不碰 storage，便于单测。
 * 持久化由调用方负责（`KEYS.headlessStats`）。
 */

/** 连续多少次 unsupported 之后熔断 */
export const HEADLESS_FAILURE_THRESHOLD = 3;
/** 熔断多久（毫秒）。24 小时：站点加上签到接口通常伴随版本更新，一天粒度够了 */
export const HEADLESS_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export interface HeadlessSiteStat {
  /** 连续 unsupported 次数，任何一次成功清零 */
  consecutiveFailures: number;
  /** 最近一次尝试的时间戳 */
  lastAttemptAt?: number;
  /** 熔断到什么时候，无值表示未熔断 */
  disabledUntil?: number;
  /** 最近一次判定，写进界面便于用户理解为什么这个站点还在开标签页 */
  lastVerdict?: string;
}

export type HeadlessStats = Record<string, HeadlessSiteStat>;

/** 影响熔断计数的结果类别，与 headless-checkin 的判定一一对应 */
export type EligibilitySignal =
  /** 直连成功（confirmed / already）—— 清零 */
  | 'success'
  /** 站点没有这个接口 —— 计数 */
  | 'unsupported'
  /** 登录态失效 —— 不计数，浏览器登录后下次可能就好了 */
  | 'auth-expired'
  /** 网络错误或超时 —— 不计数 */
  | 'error'
  /** 响应与余额差分对不上 —— 不计数，但也不算成功 */
  | 'inconclusive';

const empty = (): HeadlessSiteStat => ({ consecutiveFailures: 0 });

/**
 * 现在该不该为这个站点尝试直连。
 *
 * @param now 当前时间戳，由调用方传入以便测试
 */
export function shouldTryHeadless(
  stats: HeadlessStats,
  siteId: string,
  now: number,
): boolean {
  const stat = stats[siteId];
  if (!stat?.disabledUntil) return true;
  // 冷却期过了就重新给机会 —— 站点可能升级后加上了签到接口
  return now >= stat.disabledUntil;
}

/**
 * 记一次直连结果，返回新的统计（不改入参）。
 *
 * 返回新对象而不是原地改：调用方需要把它整体写回 storage，
 * 原地修改容易在并发写时丢失更新。
 */
export function recordHeadlessOutcome(
  stats: HeadlessStats,
  siteId: string,
  signal: EligibilitySignal,
  now: number,
): HeadlessStats {
  const previous = stats[siteId] ?? empty();
  const next: HeadlessSiteStat = {
    ...previous,
    lastAttemptAt: now,
    lastVerdict: signal,
  };

  if (signal === 'success') {
    next.consecutiveFailures = 0;
    delete next.disabledUntil;
    return { ...stats, [siteId]: next };
  }

  if (signal === 'unsupported') {
    next.consecutiveFailures = previous.consecutiveFailures + 1;
    if (next.consecutiveFailures >= HEADLESS_FAILURE_THRESHOLD) {
      next.disabledUntil = now + HEADLESS_COOLDOWN_MS;
    }
    return { ...stats, [siteId]: next };
  }

  // auth-expired / error / inconclusive：如实记录发生过，但不推进熔断。
  // 这三类都不是「站点没有接口」的证据。
  return { ...stats, [siteId]: next };
}

/** 用户手动重试或改了站点配置时，清掉熔断让直连立即重新可用 */
export function resetHeadlessStat(stats: HeadlessStats, siteId: string): HeadlessStats {
  if (!stats[siteId]) return stats;
  const next = { ...stats };
  delete next[siteId];
  return next;
}

/** 界面用：为什么这个站点没走直连 */
export function describeHeadlessStat(
  stat: HeadlessSiteStat | undefined,
  now: number,
): string | null {
  if (!stat?.disabledUntil || now >= stat.disabledUntil) return null;
  const hours = Math.max(1, Math.round((stat.disabledUntil - now) / 3_600_000));
  return `该站点连续 ${stat.consecutiveFailures} 次没有可用签到接口，${hours} 小时内不再尝试 API 直连`;
}

/**
 * 丢弃已删除站点的统计。
 *
 * 与 `app-repository` 里清理 results 的做法一致：storage 里按 id 存的
 * 附属数据必须随主体删除，否则会永久累积孤儿记录。
 */
export function pruneHeadlessStats(stats: HeadlessStats, liveSiteIds: Iterable<string>): HeadlessStats {
  const live = new Set(liveSiteIds);
  const entries = Object.entries(stats).filter(([siteId]) => live.has(siteId));
  return entries.length === Object.keys(stats).length ? stats : Object.fromEntries(entries);
}
