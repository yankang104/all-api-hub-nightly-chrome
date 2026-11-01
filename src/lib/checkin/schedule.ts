import type { CheckinSchedule } from '@/types';

export const DEFAULT_CHECKIN_SCHEDULE: CheckinSchedule = {
  enabled: false,
  time: '09:00',
  weekdays: [1, 2, 3, 4, 5],
};

export const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'] as const;

const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function isValidSchedule(value: unknown): value is CheckinSchedule {
  if (!value || typeof value !== 'object') return false;
  const schedule = value as Partial<CheckinSchedule>;
  return typeof schedule.enabled === 'boolean'
    && typeof schedule.time === 'string'
    && TIME_RE.test(schedule.time)
    && Array.isArray(schedule.weekdays)
    && schedule.weekdays.length > 0
    && schedule.weekdays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    && new Set(schedule.weekdays).size === schedule.weekdays.length
    && (schedule.accountIds === undefined
      || (Array.isArray(schedule.accountIds)
        && schedule.accountIds.every((accountId) => typeof accountId === 'string' && accountId.length > 0)
        && new Set(schedule.accountIds).size === schedule.accountIds.length));
}

/** 读取旧版本/手工导入的值时，始终得到可安全使用的配置。 */
export function normalizeSchedule(value: unknown): CheckinSchedule {
  if (!value || typeof value !== 'object') return { ...DEFAULT_CHECKIN_SCHEDULE };
  const input = value as Partial<CheckinSchedule>;
  const suppliedTime = input.time !== undefined;
  const validTime = typeof input.time === 'string' && TIME_RE.test(input.time);
  const suppliedWeekdays = input.weekdays !== undefined;
  const suppliedAccountIds = input.accountIds !== undefined;
  const validAccountIds = Array.isArray(input.accountIds)
    && input.accountIds.every((accountId) => typeof accountId === 'string' && accountId.length > 0);
  const weekdays = Array.isArray(input.weekdays)
    ? [...new Set(input.weekdays.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6))].sort((a, b) => a - b)
    : [];
  const accountIds = Array.isArray(input.accountIds)
    ? [...new Set(input.accountIds.filter((accountId): accountId is string => typeof accountId === 'string' && accountId.length > 0))].sort()
    : [];
  const missingEnabledField = input.enabled === true && (!suppliedTime || !suppliedWeekdays);
  const malformed = missingEnabledField
    || (suppliedTime && !validTime)
    || (suppliedWeekdays && weekdays.length === 0)
    || (suppliedAccountIds && !validAccountIds);
  const normalized: CheckinSchedule = {
    enabled: input.enabled === true && !malformed,
    time: validTime ? input.time! : DEFAULT_CHECKIN_SCHEDULE.time,
    weekdays: weekdays.length ? weekdays : [...DEFAULT_CHECKIN_SCHEDULE.weekdays],
  };
  // Keep the field absent for legacy values so they continue to mean "all".
  if (suppliedAccountIds) normalized.accountIds = accountIds;
  return normalized;
}

/** 删除账号/站点后清理计划中的悬空账号 ID；旧的全选语义保持为 undefined。 */
export function pruneScheduleAccountIds(
  schedule: CheckinSchedule,
  validAccountIds: Iterable<string>,
): CheckinSchedule {
  const normalized = normalizeSchedule(schedule);
  if (normalized.accountIds === undefined) return normalized;
  const valid = new Set(validAccountIds);
  return {
    ...normalized,
    accountIds: normalized.accountIds.filter((accountId) => valid.has(accountId)),
  };
}

/** 返回本轮计划实际覆盖的账号，调用方再叠加每日状态过滤。 */
export function scheduledAccountIds(
  schedule: CheckinSchedule,
  allAccountIds: Iterable<string>,
): string[] {
  const all = [...new Set(allAccountIds)];
  const normalized = normalizeSchedule(schedule);
  if (normalized.accountIds === undefined) return all;
  const selected = new Set(normalized.accountIds);
  return all.filter((accountId) => selected.has(accountId));
}

/** 用于防重复执行的稳定签名，包含账号筛选条件。 */
export function scheduleSignature(schedule: CheckinSchedule): string {
  const normalized = normalizeSchedule(schedule);
  return `${normalized.time}|${normalized.weekdays.join(',')}|${normalized.accountIds === undefined ? '*' : normalized.accountIds.join(',')}`;
}

/**
 * 计算严格晚于 from 的下一次执行时间。
 * 使用本地 Date 的 setter，闹钟最终保存的是绝对时间戳，但周几/时间始终按本地时区解释。
 */
export function nextScheduledAt(schedule: CheckinSchedule, from: Date = new Date()): Date | null {
  const normalized = normalizeSchedule(schedule);
  if (!normalized.enabled || normalized.weekdays.length === 0) return null;
  const [hours = 0, minutes = 0] = normalized.time.split(':').map(Number);
  const weekdays = new Set(normalized.weekdays);

  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(from);
    candidate.setDate(from.getDate() + offset);
    candidate.setHours(hours, minutes, 0, 0);
    if (weekdays.has(candidate.getDay()) && candidate.getTime() > from.getTime()) return candidate;
  }
  return null;
}

/**
 * Chrome may deliver a missed alarm after the computer wakes. Only accept the
 * alarm on its configured local calendar day, while still allowing delays
 * within that day.
 */
export function shouldRunScheduledAlarm(
  schedule: CheckinSchedule,
  scheduledTime: number,
  now: Date = new Date(),
): boolean {
  const normalized = normalizeSchedule(schedule);
  if (!normalized.enabled || !Number.isFinite(scheduledTime)) return false;

  const scheduled = new Date(scheduledTime);
  if (Number.isNaN(scheduled.getTime())) return false;
  const [hours = 0, minutes = 0] = normalized.time.split(':').map(Number);

  return scheduled.getFullYear() === now.getFullYear()
    && scheduled.getMonth() === now.getMonth()
    && scheduled.getDate() === now.getDate()
    && scheduled.getHours() === hours
    && scheduled.getMinutes() === minutes
    && normalized.weekdays.includes(scheduled.getDay());
}

export function scheduleRunKey(date: Date, time: string): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}@${time}`;
}

/**
 * 今天应当执行、且此刻已经到点的计划时刻；没有就返回 null。
 *
 * 用途是**补跑当天错过的计划**：Chrome 只在浏览器运行时投递闹钟，机器在计划
 * 时刻关机、或整个白天没开浏览器，当天这一轮就永远不会发生，用户只能手动点
 * 一次批量签到。冷启动时用这个函数算出「今天那次」是否已过点，再由调用方用
 * runKey 去重，跑过的不重复跑。
 *
 * 只回看当天、不跨天补：第二天开机时把昨天的任务再跑一遍，既不是用户设定的
 * 时间，也可能落在站点侧的另一天，宁可不跑。
 */
export function latestDueScheduleSlot(schedule: CheckinSchedule, now: Date = new Date()): Date | null {
  const normalized = normalizeSchedule(schedule);
  if (!normalized.enabled || normalized.weekdays.length === 0) return null;
  if (!normalized.weekdays.includes(now.getDay())) return null;

  const [hours = 0, minutes = 0] = normalized.time.split(':').map(Number);
  const slot = new Date(now);
  slot.setHours(hours, minutes, 0, 0);
  return slot.getTime() <= now.getTime() ? slot : null;
}
