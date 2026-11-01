/**
 * 「登录即签到」启动步骤的说明文案。
 *
 * 用户看到的必须是**原因**，不是一个笼统的「没有基线」：从来没成功读过余额，
 * 和读过但已经过期，下一步该做的事完全不同（前者要等这次刷新，后者要缩短
 * 两次执行的间隔）。判定仍然只归 loginCheckinBalanceBaseline，这里只把它
 * 的结果翻译成如实的中文说明，不改 36 小时策略，也不引用任何页面内容。
 */
import type { AccountBalance, BalancePoint } from '@/types';
import {
  LOGIN_CHECKIN_BASELINE_MAX_AGE_MS,
  loginCheckinBalanceBaseline,
} from '@/lib/balance/balance-history';

/** 基线可用时的既有文案，一个字都不改。 */
export const LOGIN_CHECKIN_BASELINE_LOADED_NOTE =
  '已载入该账号最近一次成功余额，登录后将按总额度差计算今日增加量';

const BASELINE_MAX_AGE_HOURS = Math.round(LOGIN_CHECKIN_BASELINE_MAX_AGE_MS / 3_600_000);

const NO_SUCCESSFUL_SAMPLE_NOTE =
  '该账号还没有成功读取过余额，本次只能刷新余额，无法计算登录带来的额度增加量';

function withNoBaselineSuffix(reason: string): string {
  return `${reason}，未用作登录前基线；本次只能刷新余额，无法计算登录带来的额度增加量`;
}

/** 本地时区的 `YYYY-MM-DD HH:mm`，只用于说明采样时刻。 */
function formatSampleTime(at: number): string {
  const d = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 与 loginCheckinBalanceBaseline 同一套候选集：daily 里的成功采样，
 * 以及顶层值（仅当这次刷新没有失败 —— 有 error 时顶层 at 是**失败时间**，
 * 不能拿来冒充成功读数）。
 */
function successfulCandidates(balance: AccountBalance | undefined): BalancePoint[] {
  if (!balance) return [];
  const points: BalancePoint[] = [];
  for (const record of Object.values(balance.daily ?? {})) {
    if (record.latest) points.push(record.latest);
  }
  if (!balance.error) {
    points.push({
      quota: balance.quota,
      usedQuota: balance.usedQuota,
      ...(balance.symbol ? { symbol: balance.symbol } : {}),
      at: balance.at,
      source: balance.source ?? 'api',
    });
  }
  return points;
}

function latestByAt(points: BalancePoint[]): BalancePoint | undefined {
  let latest: BalancePoint | undefined;
  for (const point of points) {
    if (!Number.isFinite(point.at)) continue;
    if (!latest || point.at > latest.at) latest = point;
  }
  return latest;
}

/**
 * 启动步骤里这一条日志的固定文案（单行，不含页面内容）。
 *
 * 基线取得到就是原有的「已载入…」；取不到时点名真实原因：从未成功读过余额 /
 * 超过 36 小时归因窗口 / 晚于任务开始时间 / 记录本身不完整。
 */
export function loginCheckinBaselineStepNote(
  balance: AccountBalance | undefined,
  taskCreatedAt: number,
): string {
  if (loginCheckinBalanceBaseline(balance, taskCreatedAt)) {
    return LOGIN_CHECKIN_BASELINE_LOADED_NOTE;
  }
  if (!Number.isFinite(taskCreatedAt)) return NO_SUCCESSFUL_SAMPLE_NOTE;

  const latest = latestByAt(successfulCandidates(balance));
  if (!latest) return NO_SUCCESSFUL_SAMPLE_NOTE;

  const when = formatSampleTime(latest.at);
  if (latest.at > taskCreatedAt) {
    return withNoBaselineSuffix(
      `最近一次成功余额读取于 ${when}，晚于本次任务开始时间，不在 ${BASELINE_MAX_AGE_HOURS} 小时归因窗口的可用范围内`,
    );
  }
  if (taskCreatedAt - latest.at > LOGIN_CHECKIN_BASELINE_MAX_AGE_MS) {
    return withNoBaselineSuffix(
      `最近一次成功余额读取于 ${when}，已超过 ${BASELINE_MAX_AGE_HOURS} 小时归因窗口`,
    );
  }
  // 时间在窗口内却仍被拒绝，只剩「这条记录本身不可用」这一种可能，不编原因。
  return withNoBaselineSuffix(
    `最近一次成功余额读取于 ${when}，但该记录的额度数据不完整`,
  );
}