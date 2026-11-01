import type { Account, ProxyConfig } from '@/types';
import { isNameOnlyProxy } from '@/lib/proxy/proxy-config';
import { detectRegion } from '@/lib/proxy/proxy-region';
import type { ProxyAssignment } from '@/lib/proxy/proxy-assign';

/**
 * 「绑在没有出口的节点名上」的账号该怎么救。
 *
 * 订阅里的 vmess/vless/trojan/hysteria2 节点 Chrome 用不了，导入时只存下名字
 * （`nameOnly`）。账号一旦绑上这种条目就是死局：签到跑不起来，而 `refreshOneBalance`
 * 走同一条解析，站点卡片的余额也永远停在「未获取」。
 *
 * 替代出口**优先同地区**：账号原本绑的是「香港-优化2」，就换到池里真有出口的
 * 香港节点。出口国家不能悄悄变 —— 站点会按异地登录风控，这也正是原来宁可
 * 报错也不放行直连的理由。同地区一个出口都没有时才跨区，并且如实报出来。
 *
 * 注意「换到同地区的真实出口」和「悄悄改走直连」是两件事：前者保住了用户
 * 真正在意的东西（出口国家），后者把出口丢了。所以前者可以自动做，后者不行。
 */

export interface NameOnlyRepairPlan {
  /** 可以直接交给 applyAssignments 的换绑方案 */
  assignments: ProxyAssignment[];
  /** 同地区没有出口、只能跨区顶上的账号数，界面要如实说出来 */
  crossRegion: number;
  /** 池里连一个真实出口都找不到，救不了的账号 */
  unresolved: { accountId: string; proxyName: string }[];
}

interface Candidate {
  id: string;
  /** 已经有几个账号绑在这个出口上，用来把账号摊平而不是全挤一个 IP */
  used: number;
  /** 池内原始顺序，用于并列时的稳定排序 */
  order: number;
}

interface CandidatePool {
  byRegion: Map<string, Candidate[]>;
  all: Candidate[];
}

/**
 * 建出「真实出口」的候选表，按地区分桶。
 *
 * 起始占用数从**现有的健康绑定**算起。不这么算的话，换绑会把所有待救账号都
 * 堆到每个地区的第一个节点上，而那个节点可能已经有别的账号在用 —— 多个账号
 * 同一个出口 IP，「一账号一节点」的隔离就白做了。
 */
function buildCandidatePool(
  proxies: readonly ProxyConfig[],
  accounts: readonly Account[],
  skip: ReadonlySet<string>,
): CandidatePool {
  const usage = new Map<string, number>();
  for (const account of accounts) {
    if (skip.has(account.id)) continue;
    if ((account.proxyMode ?? 'inherit') !== 'pool' || !account.proxyId) continue;
    usage.set(account.proxyId, (usage.get(account.proxyId) ?? 0) + 1);
  }

  const byRegion = new Map<string, Candidate[]>();
  const all: Candidate[] = [];
  proxies.filter((proxy) => !isNameOnlyProxy(proxy)).forEach((proxy, order) => {
    const candidate: Candidate = { id: proxy.id, used: usage.get(proxy.id) ?? 0, order };
    all.push(candidate);
    const key = detectRegion(proxy.name).key;
    const bucket = byRegion.get(key);
    if (bucket) bucket.push(candidate);
    else byRegion.set(key, [candidate]);
  });

  return { byRegion, all };
}

/** 占用最少的优先，并列时按池内顺序 —— 结果稳定可复现 */
function takeLeastUsed(candidates: readonly Candidate[]): Candidate | undefined {
  return candidates.reduce<Candidate | undefined>(
    (best, item) => (
      !best || item.used < best.used || (item.used === best.used && item.order < best.order)
        ? item
        : best
    ),
    undefined,
  );
}

function pick(
  pool: CandidatePool,
  regionKey: string,
  allowCrossRegion: boolean,
): { candidate: Candidate; crossRegion: boolean } | undefined {
  const sameRegion = takeLeastUsed(pool.byRegion.get(regionKey) ?? []);
  if (sameRegion) return { candidate: sameRegion, crossRegion: false };
  if (!allowCrossRegion) return undefined;
  const anywhere = takeLeastUsed(pool.all);
  return anywhere ? { candidate: anywhere, crossRegion: true } : undefined;
}

/**
 * 绑在没有出口的节点名上的账号。
 *
 * 界面用它算「需要修几个」，换绑用它当输入 —— 两处必须是同一个判定，
 * 否则按钮上写着 3 个、点下去改了 5 个。
 */
export function nameOnlyBoundAccounts(
  accounts: readonly Account[],
  proxies: readonly ProxyConfig[],
): Account[] {
  const byId = new Map(proxies.map((proxy) => [proxy.id, proxy]));
  return accounts.filter((account) => {
    if ((account.proxyMode ?? 'inherit') !== 'pool' || !account.proxyId) return false;
    const proxy = byId.get(account.proxyId);
    return !!proxy && isNameOnlyProxy(proxy);
  });
}

/**
 * 算出换绑方案（把绑定本身改掉，持久生效）。纯函数，不碰存储。
 *
 * @param allowCrossRegion 同地区没有出口时是否允许跨区顶上。默认允许 ——
 *   用户点这个按钮的诉求是「让它先跑起来」，跨区数量会在结果里说明。
 */
export function planNameOnlyRepair(
  accounts: readonly Account[],
  proxies: readonly ProxyConfig[],
  allowCrossRegion = true,
): NameOnlyRepairPlan {
  const byId = new Map(proxies.map((proxy) => [proxy.id, proxy]));
  const stuck = nameOnlyBoundAccounts(accounts, proxies);
  if (!stuck.length) return { assignments: [], crossRegion: 0, unresolved: [] };

  const pool = buildCandidatePool(proxies, accounts, new Set(stuck.map((item) => item.id)));

  const assignments: ProxyAssignment[] = [];
  const unresolved: { accountId: string; proxyName: string }[] = [];
  let crossRegion = 0;

  for (const account of stuck) {
    const broken = byId.get(account.proxyId!)!;
    const chosen = pick(pool, detectRegion(broken.name).key, allowCrossRegion);
    if (!chosen) {
      unresolved.push({ accountId: account.id, proxyName: broken.name });
      continue;
    }

    if (chosen.crossRegion) crossRegion += 1;
    chosen.candidate.used += 1;
    // 不打 pinned：这是替代方案而非用户的选择，日后池子补进真正同名的
    // 出口时，还应该能被重新摊平（见 proxy-assign 的 hasProxyIntent）。
    assignments.push({ accountId: account.id, proxyId: chosen.candidate.id });
  }

  return { assignments, crossRegion, unresolved };
}
