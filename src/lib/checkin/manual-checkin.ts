/**
 * 手动标记签到已完成。
 *
 * 存在的理由：有些站点扩展就是跑不过去 —— 指纹不干净拿不到 Turnstile 令牌、
 * 只能第三方登录、签到入口藏在活动页里。用户自己在浏览器里点完了，
 * 但扩展这边还停在「待签到 / 失败」，于是每天的「全部签到」都会再跑一遍，
 * 概览里的完成度也永远是错的。得给一个「这个我自己搞定了」的出口。
 */

import type { AccountBalance, BalancePoint, CheckinMetrics, TaskResult } from '@/types';
import { todayKey } from '@/lib/core/date';

/** 手动标记时写进列表的结果说明 */
export const MANUAL_DONE_MESSAGE = '手动标记为已签到';

const BALANCE_EPSILON = 1e-9;

export interface ManualBalanceDifference {
  metrics: CheckinMetrics;
  baselineDay: string;
  currentDay: string;
  basis: 'within-day' | 'previous-day';
}

function differenceBetween(before: BalancePoint, after: BalancePoint): CheckinMetrics {
  const reward = (after.quota + after.usedQuota) - (before.quota + before.usedQuota);
  const usageDelta = after.usedQuota - before.usedQuota;
  const balanceDelta = after.quota - before.quota;
  return {
    reward,
    usageDelta,
    balanceDelta,
    verdict: reward > BALANCE_EPSILON
      ? 'rewarded'
      : usageDelta > BALANCE_EPSILON ? 'already-used' : 'unchanged',
    source: 'balance-diff',
    quotaAfter: after.quota,
    ...(after.symbol ? { balanceSymbol: after.symbol } : {}),
  };
}

/**
 * 用余额历史给手动标记补一份可追溯的差值。
 *
 * 优先比较今天首末两次采样；若奖励在今天第一次刷新前已经到账，则退到最近
 * 一个历史日期。两种基线都存在时优先采用能解释正向入账的那一份。它仍只是
 * 手动标记期间的总额度差值，可能包含充值或其它入账，所以不会升级成自动验证。
 */
export function manualBalanceDifference(
  balance: AccountBalance | undefined,
  currentDay = todayKey(),
): ManualBalanceDifference | null {
  const daily = balance?.daily;
  if (!daily) return null;
  const current = daily[currentDay];
  if (!current?.latest) return null;

  const candidates: ManualBalanceDifference[] = [];
  if (current.first && current.latest.at > current.first.at) {
    candidates.push({
      metrics: differenceBetween(current.first, current.latest),
      baselineDay: currentDay,
      currentDay,
      basis: 'within-day',
    });
  }

  const previousDay = Object.keys(daily)
    .filter((day) => day < currentDay && !!daily[day]?.latest)
    .sort()
    .pop();
  const previous = previousDay ? daily[previousDay]?.latest : undefined;
  if (previousDay && previous) {
    candidates.push({
      metrics: differenceBetween(previous, current.latest),
      baselineDay: previousDay,
      currentDay,
      basis: 'previous-day',
    });
  }

  return candidates.find((candidate) => candidate.metrics.verdict === 'rewarded')
    ?? candidates[0]
    ?? null;
}

/**
 * 合成一条「手动标记」的执行结果。
 *
 * 为什么不能只把状态改成 done：列表行的时间戳、执行详情面板读的都是
 * `results[accountId]`。只改状态的话，上一次失败的结果还留在原地 ——
 * 界面上会出现绿色「已签到」徽标配一行红色失败原因，比没有信息更误导人。
 *
 * 所以状态和结果必须一起落地（`setStatusAndResult`），并且带上 manual 标记，
 * 让后面读数据的人知道这条成功没有证据支撑。
 */
export function manualDoneResult(
  accountId: string,
  balance?: AccountBalance,
  currentDay = todayKey(),
): TaskResult {
  const difference = manualBalanceDifference(balance, currentDay);
  const rewarded = difference?.metrics.verdict === 'rewarded';
  const basis = difference?.basis === 'within-day'
    ? '今天首次与最新余额快照'
    : difference
      ? `${difference.baselineDay} 与今天的余额快照`
      : null;

  return {
    accountId,
    ok: true,
    manual: true,
    message: rewarded
      ? `${MANUAL_DONE_MESSAGE}，已按余额差值计算增加量`
      : difference
        ? `${MANUAL_DONE_MESSAGE}，余额差值未增加`
        : MANUAL_DONE_MESSAGE,
    steps: [
      '用户在管理页手动标记本次签到已完成',
      ...(basis ? [`已按${basis}计算总额度差值`] : ['没有可用的历史余额基线，无法计算增加量']),
      ...(rewarded ? ['该增加量是余额期间差值，可能包含同期间充值或其它入账'] : []),
    ],
    ...(difference ? { metrics: difference.metrics } : {}),
  };
}
