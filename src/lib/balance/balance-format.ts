/**
 * 余额的换算与求和。
 *
 * 抽成纯函数是因为**跨站点求和有一个必须踩对的坑**：站点原始 quota 的单位
 * 各家不同（new-api 是 500000/美元，Sub2API 的 balance 本身就是美元）。
 * 把原始 quota 直接加起来会得出一个毫无意义的数 —— 而它长得像个正常金额，
 * 错了看不出来。所以必须**先按各自系数换算成美元，再相加**。
 *
 * 三处显示（账号行、站点卡片合计、顶部总额）共用这里，避免各写一份。
 */

import type { AccountBalance, AdapterFamily, CheckinMetrics, RewardSymbol } from '@/types';

/**
 * new-api 家族的标准换算系数。
 *
 * 站点配置漏了 quotaPerUnit 时用它兜底 —— 与 balance.ts:216 和
 * AccountRow 原有的 formatQuota 保持同一个数，三处不能各写一个。
 */
const NEW_API_QUOTA_PER_UNIT = 500_000;

/** 一个站点的换算参数 */
export interface QuotaScale {
  quotaPerUnit?: number;
  family?: AdapterFamily;
}

/**
 * 求出实际要用的除数。
 *
 * 显式配置优先；没配时只有 new-api 家族按 500000 折算 ——
 * Sub2API 的 balance 已经是美元，套 new-api 的系数会把 $6.5 显示成 $0.00。
 */
export function quotaDivisor({ quotaPerUnit, family }: QuotaScale): number {
  if (quotaPerUnit && quotaPerUnit > 0) return quotaPerUnit;
  return family === 'new-api' ? NEW_API_QUOTA_PER_UNIT : 1;
}

/** 原始 quota → 美元数值 */
export function toDollars(raw: number, scale: QuotaScale): number {
  return raw / quotaDivisor(scale);
}

function formatPoints(value: number): string {
  return value.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

/**
 * 金额显示的小数位数。
 *
 * 两位小数会把小额奖励（如 $0.3449）四舍五入成 $0.34，用户看到的
 * 签到收益与实际到账对不上，差额证据也因此显得「没变化」。四位能覆盖这
 * 类站点的真实精度，又不会把 quota 换算后的浮点噪声一路显示出来。
 */
export const MONEY_DECIMALS = 4;

/** 原始 quota → 带页面显示单位的余额；默认仍按美元展示。 */
export function formatQuota(raw: number, scale: QuotaScale, symbol: RewardSymbol = '$'): string {
  if (symbol === '积分') return `积分 ${formatPoints(raw)}`;
  return `${symbol}${toDollars(raw, scale).toFixed(MONEY_DECIMALS)}`;
}

/** 原始 quota → 奖励/差值金额；积分是后置单位，币种仍保留原有前置符号。 */
export function formatQuotaChange(raw: number, scale: QuotaScale, symbol: RewardSymbol = '$'): string {
  if (symbol === '积分') return `${formatPoints(raw)} 积分`;
  return formatQuota(raw, scale, symbol);
}

/** 已经是美元的数值 → `$12.34` */
export function formatDollars(value: number): string {
  return `$${value.toFixed(MONEY_DECIMALS)}`;
}

/** 参与求和的一条：余额 + 它所属站点的换算参数 */
export interface BalanceEntry {
  balance: AccountBalance | undefined;
  scale: QuotaScale;
}

export interface BalanceTotal {
  /** 美元余额小计；保留该字段供旧调用方兼容，人民币不会混入。 */
  dollars: number;
  /** 有余额数据的账号数 */
  counted: number;
  /** 读不到余额的账号数（有 error，或压根没有记录） */
  missing: number;
  /** 按页面币种分别求和，禁止把美元与人民币静默相加。 */
  currencies: readonly BalanceCurrencyTotal[];
}

export interface BalanceCurrencyTotal {
  symbol: RewardSymbol;
  amount: number;
  counted: number;
}

/**
 * 先按各站的 quota 系数换成页面金额，再按币种分别求和。
 *
 * 每条各用自己站点的系数换算；美元和人民币进入不同分组，调用方展示时
 * 会分别列出，不能把两种币种静默相加成一个看似正常的数字。
 *
 * 带 error 的记录**不计入**：那个 quota 是上一次成功时的旧值，
 * 把它算进总额等于把过期数字当现值报给用户。它计入 missing，
 * 界面据此说明「N 个账号未获取」。
 */
export function sumBalances(entries: readonly BalanceEntry[]): BalanceTotal {
  let counted = 0;
  let missing = 0;
  const groups = new Map<'dollar' | 'yuan' | 'points', BalanceCurrencyTotal>();

  for (const { balance, scale } of entries) {
    if (!balance || balance.error) {
      missing += 1;
      continue;
    }
    const symbol = balance.symbol ?? '$';
    const key = symbol === '$' ? 'dollar' : symbol === '积分' ? 'points' : 'yuan';
    const current = groups.get(key);
    groups.set(key, {
      symbol: current?.symbol ?? symbol,
      amount: (current?.amount ?? 0) + (symbol === '积分' ? balance.quota : toDollars(balance.quota, scale)),
      counted: (current?.counted ?? 0) + 1,
    });
    counted += 1;
  }

  const unitOrder = (symbol: RewardSymbol): number => (
    symbol === '$' ? 0 : symbol === '积分' ? 2 : 1
  );
  const currencies = [...groups.values()].sort((left, right) => (
    unitOrder(left.symbol) - unitOrder(right.symbol)
  ));
  const dollars = groups.get('dollar')?.amount ?? 0;
  return { dollars, counted, missing, currencies };
}

/** 单币种直接显示；多币种逐项列出，绝不伪造一个合计币种。 */
export function formatBalanceTotal(total: BalanceTotal): string {
  if (total.counted === 0) return '未获取';
  return total.currencies
    .map(({ symbol, amount }) => formatQuota(amount, {}, symbol))
    .join(' + ');
}

/**
 * 界面展示用的余额：独立存储优先，缺失或带 error 时回落到本次签到的差分结果。
 *
 * 为什么必须共用这一个入口：账号行一直有这条回落，站点卡片和顶部合计却只认
 * 独立存储 —— 于是同一个账号，账号行写着「余额 $7.91」，站点标题同时写着
 * 「本站余额 未获取 · 4 个未获取」。两处读不同数据源，用户看到的是自相矛盾的
 * 界面，而且会以为刷新失败了。
 *
 * 什么情况下存储里会没有可用值：
 *  - 签到页只报出了「今天 +$X」而没有余额接口，写库的是 saveCheckinReward 的
 *    占位记录（quota=0 且带 error: '余额尚未读取'）；
 *  - 余额快照在写库前被身份闸门拒绝（多账号站点身份未确认），写入静默失败。
 * 这两种情况的共同点是：**本次签到的 metrics 里已经有一份读到的余额**，只是
 * 没进独立存储。展示层据此回落，不需要再猜一个数字。
 *
 * @returns balance 展示用记录；fromCheckinResult=true 表示这条是本次签到的
 *          结果而不是已落库的快照 —— 账号行据此不显示「几分钟前更新」（它的
 *          时刻不属于一次独立刷新）。
 */
export function displayBalanceOf(
  stored: AccountBalance | undefined,
  result: { metrics?: Pick<CheckinMetrics, 'quotaAfter' | 'balanceSymbol'> } | undefined,
  now = Date.now(),
): { balance?: AccountBalance; fromCheckinResult: boolean } {
  if (stored && !stored.error) return { balance: stored, fromCheckinResult: false };

  const quota = result?.metrics?.quotaAfter;
  if (quota == null) return { balance: stored, fromCheckinResult: false };

  const symbol = result?.metrics?.balanceSymbol ?? stored?.symbol;
  return {
    balance: {
      quota,
      usedQuota: stored?.usedQuota ?? 0,
      ...(symbol ? { symbol } : {}),
      at: now,
      source: 'api',
    },
    fromCheckinResult: true,
  };
}

/** 「3 分钟前」这类相对时间，余额旁边显示新鲜度 */
export function describeAge(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return '刚刚更新';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}
