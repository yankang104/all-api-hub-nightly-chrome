/**
 * 把代理池里的节点批量绑定到账号。
 *
 * 策略是**固定绑定**：一个账号长期走同一个出口。不用「每次随机取一个」，
 * 因为同一账号今天日本、明天香港，反而更像盗号，会踩站点的异地登录风控。
 *
 * 节点比账号少时循环复用 —— 3 个节点 5 个账号，至少把账号摊到 3 个出口上，
 * 比全部挤在一个出口好。节点多于账号时余下的节点不分配。
 */

import type { Account, AccountProxyMode } from '@/types';

export type AssignMode =
  /** 只分配还没绑定过的账号，不覆盖用户手配的（默认） */
  | 'unassigned'
  /** 全部重新分配，覆盖已有绑定 */
  | 'all';

export interface ProxyAssignment {
  accountId: string;
  proxyId: string;
  /** 用户在对照表里手动改的这一条，写入后不再被自动分配覆盖 */
  pinned?: boolean;
}

export interface AssignResult {
  assignments: ProxyAssignment[];
  /** 因为已有绑定而跳过的账号数（仅 unassigned 模式） */
  skipped: number;
  /** 账号不够，没被用上的节点数 */
  unusedProxies: number;
}

/**
 * 这个账号是不是用户「手动表过态」的。
 *
 * 手动过的一律不被自动分配覆盖：
 *  - 'custom' / 'none' 是用户在账号弹窗里明确选的（特意直连也算表态）；
 *  - 'pool' 只有带 proxyPinned 才算手动 —— 不带这个标记说明是上一轮自动填的，
 *    加了新节点后应该能被重新摊平，否则池子扩容后永远分不下去。
 */
function hasProxyIntent(account: Pick<Account, 'proxyMode' | 'proxyId' | 'proxyPinned'>): boolean {
  const mode: AccountProxyMode = account.proxyMode ?? 'inherit';
  if (mode === 'pool') return Boolean(account.proxyId) && account.proxyPinned === true;
  return mode === 'custom' || mode === 'none';
}

/**
 * 计算分配方案。纯函数，不碰存储。
 *
 * @param accounts 待分配的账号，按传入顺序轮转
 * @param proxyIds 可用节点（调用方应先剔除测活不通的）
 */
export function assignProxies(
  accounts: readonly Pick<Account, 'id' | 'proxyMode' | 'proxyId' | 'proxyPinned'>[],
  proxyIds: readonly string[],
  mode: AssignMode = 'unassigned',
): AssignResult {
  if (!proxyIds.length) {
    return { assignments: [], skipped: 0, unusedProxies: 0 };
  }

  const targets = mode === 'all' ? [...accounts] : accounts.filter((account) => !hasProxyIntent(account));
  const assignments = targets.map((account, index) => ({
    accountId: account.id,
    proxyId: proxyIds[index % proxyIds.length]!,
  }));

  return {
    assignments,
    skipped: accounts.length - targets.length,
    unusedProxies: Math.max(0, proxyIds.length - targets.length),
  };
}
