import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHECKIN_SCHEDULE,
  isValidSchedule,
  latestDueScheduleSlot,
  nextScheduledAt,
  normalizeSchedule,
  pruneScheduleAccountIds,
  scheduledAccountIds,
  scheduleRunKey,
  scheduleSignature,
  shouldRunScheduledAlarm,
} from '@/lib/checkin/schedule';

function localDate(day: number, hour: number, minute = 0): Date {
  return new Date(2026, 7, day, hour, minute, 0, 0);
}

describe('checkin schedule', () => {
  it('uses the next selected weekday and keeps local time', () => {
    // 2026-08-17 is Monday; after Monday 10:00, Tuesday 09:30 is next.
    const result = nextScheduledAt(
      { enabled: true, time: '09:30', weekdays: [1, 2] },
      localDate(17, 10),
    );
    expect(result?.getDate()).toBe(18);
    expect(result?.getHours()).toBe(9);
    expect(result?.getMinutes()).toBe(30);
  });

  it('can schedule later today and rolls over after the final selected day', () => {
    const today = nextScheduledAt(
      { enabled: true, time: '18:00', weekdays: [1] },
      localDate(17, 10),
    );
    expect(today?.getDate()).toBe(17);

    const nextWeek = nextScheduledAt(
      { enabled: true, time: '09:00', weekdays: [1] },
      localDate(17, 10),
    );
    expect(nextWeek?.getDate()).toBe(24);
  });

  it('normalizes malformed stored values without enabling them', () => {
    expect(normalizeSchedule({ enabled: true, time: 'bad', weekdays: [9] })).toEqual({
      ...DEFAULT_CHECKIN_SCHEDULE,
    });
    expect(isValidSchedule(DEFAULT_CHECKIN_SCHEDULE)).toBe(true);
    expect(isValidSchedule({ enabled: true, time: '09:00', weekdays: [1, 1] })).toBe(false);
  });

  it('keeps legacy schedules targeted at all accounts', () => {
    expect(normalizeSchedule({ enabled: true, time: '09:00', weekdays: [1] })).not.toHaveProperty('accountIds');
    expect(normalizeSchedule({ enabled: true, time: '09:00', weekdays: [1], accountIds: [] })).toEqual({
      enabled: true,
      time: '09:00',
      weekdays: [1],
      accountIds: [],
    });
  });

  it('prunes deleted accounts without changing the legacy all-accounts mode', () => {
    const selected = pruneScheduleAccountIds(
      { enabled: true, time: '09:00', weekdays: [1], accountIds: ['a2', 'gone', 'a2'] },
      ['a1', 'a2'],
    );
    expect(selected.accountIds).toEqual(['a2']);
    expect(pruneScheduleAccountIds(DEFAULT_CHECKIN_SCHEDULE, ['a1'])).not.toHaveProperty('accountIds');
  });

  it('includes the selected account set in the duplicate-run signature', () => {
    expect(scheduleSignature({ enabled: true, time: '09:00', weekdays: [1], accountIds: ['a2', 'a1'] }))
      .toBe('09:00|1|a1,a2');
    expect(scheduleSignature(DEFAULT_CHECKIN_SCHEDULE)).toBe('09:00|1,2,3,4,5|*');
  });

  it('returns only the selected accounts while keeping legacy schedules global', () => {
    expect(scheduledAccountIds(
      { enabled: true, time: '09:00', weekdays: [1], accountIds: ['a3', 'missing'] },
      ['a1', 'a2', 'a3'],
    )).toEqual(['a3']);
    expect(scheduledAccountIds(DEFAULT_CHECKIN_SCHEDULE, ['a1', 'a2'])).toEqual(['a1', 'a2']);
  });

  it('keeps incomplete enabled schedules disabled and restores valid defaults', () => {
    expect(normalizeSchedule({ enabled: true, weekdays: [2] })).toEqual({
      enabled: false,
      time: DEFAULT_CHECKIN_SCHEDULE.time,
      weekdays: [2],
    });
    expect(normalizeSchedule({ enabled: true, time: '08:30' })).toEqual({
      enabled: false,
      time: '08:30',
      weekdays: DEFAULT_CHECKIN_SCHEDULE.weekdays,
    });
    expect(normalizeSchedule({ enabled: true })).toEqual(DEFAULT_CHECKIN_SCHEDULE);
  });

  it('creates a stable local run key', () => {
    expect(scheduleRunKey(localDate(3, 8), '08:00')).toBe('2026-08-03@08:00');
  });

  it('accepts a delayed alarm only on its configured local day', () => {
    const schedule = { enabled: true, time: '09:00', weekdays: [1] };
    const mondayAlarm = localDate(17, 9).getTime();

    expect(shouldRunScheduledAlarm(schedule, mondayAlarm, localDate(17, 15))).toBe(true);
    expect(shouldRunScheduledAlarm(schedule, mondayAlarm, localDate(18, 8))).toBe(false);
  });

  it('rejects stale alarms after the configured time or weekdays change', () => {
    const mondayAlarm = localDate(17, 9).getTime();

    expect(shouldRunScheduledAlarm(
      { enabled: true, time: '10:00', weekdays: [1] },
      mondayAlarm,
      localDate(17, 9, 5),
    )).toBe(false);
    expect(shouldRunScheduledAlarm(
      { enabled: true, time: '09:00', weekdays: [2] },
      mondayAlarm,
      localDate(17, 9, 5),
    )).toBe(false);
  });

  it('补跑：当天已过点且今天是指定星期时给出那一次的计划时刻', () => {
    // 2026-08-17 是周一。09:00 的计划，15:00 才开机 —— 应当补跑当天 09:00 那次。
    const slot = latestDueScheduleSlot({ enabled: true, time: '09:00', weekdays: [1] }, localDate(17, 15));
    expect(slot?.getFullYear()).toBe(2026);
    expect(slot?.getMonth()).toBe(7);
    expect(slot?.getDate()).toBe(17);
    expect(slot?.getHours()).toBe(9);
    expect(slot?.getMinutes()).toBe(0);
  });

  it('补跑：还没到点、不是指定星期、或没启用时都不补', () => {
    const schedule = { enabled: true, time: '09:00', weekdays: [1] };

    expect(latestDueScheduleSlot(schedule, localDate(17, 8, 59))).toBeNull();
    // 周二不是指定星期，即使已经过了 09:00 也不补
    expect(latestDueScheduleSlot(schedule, localDate(18, 15))).toBeNull();
    expect(latestDueScheduleSlot({ ...schedule, enabled: false }, localDate(17, 15))).toBeNull();
  });

  it('补跑：跨天不补昨天的计划', () => {
    // 周一 09:00 的计划，周二 08:00 开机：不把昨天的任务再跑一遍。
    expect(latestDueScheduleSlot({ enabled: true, time: '09:00', weekdays: [1, 2] }, localDate(18, 8))).toBeNull();
  });
});
