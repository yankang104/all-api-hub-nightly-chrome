/**
 * 找出「状态说在执行、实际没人在跑」的孤儿账号。
 *
 * 状态台账存在 storage.local（跨重启保留），队列和任务信箱存在
 * storage.session（浏览器重启即清空）。两边生命周期不同，必然会出现
 * 状态还是 running、但队列里没有它、也没有任何任务信箱的情况：
 *
 *   - Service Worker 被回收时正好在 launch 与落库之间；
 *   - 浏览器整体重启，session 清空而 local 保留；
 *   - 任务页被强杀（崩溃、任务管理器），onRemoved 没送到。
 *
 * 这种账号在界面上永远转圈：执行按钮不出现（只对 pending/failed 显示），
 * 队列里又查不到，watchdog 的超时逻辑只看队列 active 也管不到它 ——
 * 只能等跨天。所以要有人定期把它们捞回待签到。
 *
 * 判据刻意收得很紧：只有「队列不认它、且没有任务信箱」才算孤儿。
 * 正在跑的任务一定至少满足其中一条（队列先写 active，再由
 * taskState.start 同时写信箱和 running），不会被误杀。
 */

/** 台账里代表「还没落定」的两个状态 */
const IN_FLIGHT = new Set(['running', 'attention']);

export interface StuckScan {
  /** 状态台账原始快照，键是 `${accountId}:${day}` */
  statuses: Record<string, string>;
  /** 今天的日期键；只看今天，历史记录不该被改写 */
  day: string;
  /** 队列正在执行的账号 */
  activeAccountId?: string;
  /** 队列里排队等待的账号 */
  pendingAccountIds?: readonly string[];
  /** 仍有任务信箱的账号（真的有页面在跑） */
  liveAccountIds?: readonly string[];
}

export function orphanRunningAccounts(scan: StuckScan): string[] {
  const owned = new Set<string>(scan.pendingAccountIds ?? []);
  for (const accountId of scan.liveAccountIds ?? []) owned.add(accountId);
  if (scan.activeAccountId) owned.add(scan.activeAccountId);

  const suffix = `:${scan.day}`;
  const orphans: string[] = [];
  for (const [key, value] of Object.entries(scan.statuses)) {
    if (!key.endsWith(suffix) || !IN_FLIGHT.has(value)) continue;
    const accountId = key.slice(0, -suffix.length);
    if (!accountId || owned.has(accountId)) continue;
    orphans.push(accountId);
  }
  return orphans;
}
