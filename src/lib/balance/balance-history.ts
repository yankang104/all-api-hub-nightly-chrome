import type {
  AccountBalance,
  BalancePoint,
  BalanceSnapshot,
  BalanceSource,
  DailyBalanceRecord,
  RewardSymbol,
} from '@/types';
import { todayKey } from '@/lib/core/date';

export const BALANCE_HISTORY_DAYS = 90;
/** 登录即签到的旧余额只在相邻两次日常执行之间可信。 */
export const LOGIN_CHECKIN_BASELINE_MAX_AGE_MS = 36 * 60 * 60_000;

type BalanceInput = Pick<AccountBalance, 'quota' | 'usedQuota' | 'symbol' | 'at' | 'source'>;

function pointOf(balance: BalanceInput): BalancePoint {
  return {
    quota: balance.quota,
    usedQuota: balance.usedQuota,
    ...(balance.symbol ? { symbol: balance.symbol } : {}),
    at: balance.at,
    source: balance.source ?? 'api',
  };
}

function dayOf(at: number): string {
  return todayKey(new Date(at));
}

/**
 * 从账号余额台账中取一份可用于“登录即签到”的历史基线。
 *
 * 刷新失败会保留旧 quota，却把顶层 at 改成失败时间，因此有 error 时只能
 * 信任 daily 里的成功采样。限制 36 小时可覆盖每日任务和跨午夜执行，同时
 * 避免把很久以前的充值或人工调额误算成本轮登录奖励。
 */
export function loginCheckinBalanceBaseline(
  balance: AccountBalance | undefined,
  taskCreatedAt: number,
  maxAgeMs = LOGIN_CHECKIN_BASELINE_MAX_AGE_MS,
): BalanceSnapshot | undefined {
  if (!balance || !Number.isFinite(taskCreatedAt) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    return undefined;
  }

  const candidates: BalancePoint[] = [];
  for (const record of Object.values(balance.daily ?? {})) {
    if (record.latest) candidates.push(record.latest);
  }
  if (!balance.error) candidates.push(pointOf(balance));

  let latest: BalancePoint | undefined;
  for (const point of candidates) {
    if (
      !Number.isFinite(point.quota)
      || !Number.isFinite(point.usedQuota)
      || !Number.isFinite(point.at)
      || point.at > taskCreatedAt
      || taskCreatedAt - point.at > maxAgeMs
    ) {
      continue;
    }
    if (
      !latest
      || point.at > latest.at
      || (point.at === latest.at && !latest.symbol && !!point.symbol)
    ) {
      latest = point;
    }
  }
  if (!latest) return undefined;

  const symbol = latest.symbol ?? balance.symbol;
  return {
    quota: latest.quota,
    usedQuota: latest.usedQuota,
    ...(symbol ? { symbol } : {}),
    at: latest.at,
    ...(latest.source === 'visible' ? { fromVisibleText: true } : {}),
  };
}

function trimDaily(
  daily: Record<string, DailyBalanceRecord>,
  limit = BALANCE_HISTORY_DAYS,
): Record<string, DailyBalanceRecord> {
  const kept = Object.keys(daily).sort().slice(-limit);
  return Object.fromEntries(kept.map((day) => [day, daily[day]!]));
}

/**
 * 把一次成功读取合并进每日台账。旧版只有顶层余额时，在首次新写入时懒迁移。
 * 带 error 的旧记录不迁移：其 at 是失败时间，而 quota 仍可能来自更早的一天。
 */
export function appendDailyBalance(
  previous: AccountBalance | undefined,
  balance: BalanceInput,
  limit = BALANCE_HISTORY_DAYS,
): Record<string, DailyBalanceRecord> {
  const daily: Record<string, DailyBalanceRecord> = { ...(previous?.daily ?? {}) };

  if (previous && !previous.error && !previous.daily && Number.isFinite(previous.at)) {
    const oldPoint = pointOf(previous);
    daily[dayOf(oldPoint.at)] = { first: oldPoint, latest: oldPoint };
  }

  const point = pointOf(balance);
  const day = dayOf(point.at);
  const existing = daily[day] ?? {};
  const first = !existing.first || point.at < existing.first.at ? point : existing.first;
  const latest = !existing.latest || point.at >= existing.latest.at ? point : existing.latest;
  daily[day] = { ...existing, first, latest };
  return trimDaily(daily, limit);
}

/** 把页面/接口明确给出的每日奖励写进同一天记录。 */
export function appendDailyReward(
  daily: Record<string, DailyBalanceRecord> | undefined,
  day: string,
  reward: number,
  at: number,
  limit = BALANCE_HISTORY_DAYS,
  symbol?: RewardSymbol,
): Record<string, DailyBalanceRecord> {
  const existing = daily?.[day];
  const effectiveSymbol = symbol
    ?? (existing?.checkinReward === reward ? existing.checkinRewardSymbol : undefined);
  const record: DailyBalanceRecord = {
    ...(existing ?? {}),
    checkinReward: reward,
    checkinRewardAt: at,
  };
  if (effectiveSymbol) record.checkinRewardSymbol = effectiveSymbol;
  else delete record.checkinRewardSymbol;
  return trimDaily({
    ...(daily ?? {}),
    [day]: record,
  }, limit);
}

export interface BalanceHistoryRow {
  day: string;
  first: BalancePoint;
  latest: BalancePoint;
  /** 当天首末两次采样之间，总额度的变化。 */
  withinDayDelta?: number;
  /** 与上一条有余额的日期相比，总额度的变化。 */
  previousDay?: string;
  previousDayDelta?: number;
  checkinReward?: number;
  checkinRewardSymbol?: RewardSymbol;
}

const total = (point: BalancePoint) => point.quota + point.usedQuota;

/** 最近日期在前；差额使用 quota + usedQuota，避免期间消耗掩盖签到奖励。 */
export function balanceHistoryRows(
  balance: AccountBalance | undefined,
  limit = 7,
): BalanceHistoryRow[] {
  if (!balance?.daily) return [];
  const chronological = Object.entries(balance.daily)
    .filter((entry): entry is [string, DailyBalanceRecord & { first: BalancePoint; latest: BalancePoint }] => (
      !!entry[1].first && !!entry[1].latest
    ))
    .sort(([left], [right]) => left.localeCompare(right));

  return chronological.map(([day, record], index) => {
    const previous = chronological[index - 1];
    const withinDayDelta = record.latest.at > record.first.at
      ? total(record.latest) - total(record.first)
      : undefined;
    return {
      day,
      first: record.first,
      latest: record.latest,
      ...(withinDayDelta != null ? { withinDayDelta } : {}),
      ...(previous
        ? {
            previousDay: previous[0],
            previousDayDelta: total(record.latest) - total(previous[1].latest),
          }
        : {}),
      ...(record.checkinReward != null ? {
        checkinReward: record.checkinReward,
        ...(record.checkinRewardSymbol ? { checkinRewardSymbol: record.checkinRewardSymbol } : {}),
      } : {}),
    };
  }).slice(-limit).reverse();
}

/** 便于调用方显式标记页面正文兜底，不让弱数据看起来像 API 快照。 */
export function balanceSource(fromVisibleText?: boolean): BalanceSource {
  return fromVisibleText ? 'visible' : 'api';
}
