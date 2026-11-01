import { describe, expect, it } from 'vitest';
import {
  ALREADY_WORDS,
  CHECKIN_ACTION,
  NON_ACTION_WORDS,
  controlDisabled,
  hit,
} from '@/automation/checkin/checkin-vocab';

/** controlDisabled 只用到这三样，用鸭子类型避免依赖真实 DOM */
const fakeControl = (className: string, attrs: Record<string, string> = {}, disabled?: boolean) => ({
  className,
  ...(disabled === undefined ? {} : { disabled }),
  getAttribute: (name: string) => attrs[name] ?? null,
});

describe('controlDisabled 禁用判定', () => {
  it('Tailwind 变体类名不算禁用 —— 这是弹窗里真按钮进不了候选的根因', () => {
    // `disabled:opacity-50` 只是声明「禁用时长什么样」，它出现在每个正常按钮上。
    // 旧实现用 className.includes('disabled') 会把这些全判成禁用。
    expect(controlDisabled(fakeControl('btn btn-primary disabled:opacity-50'))).toBe(false);
    expect(controlDisabled(fakeControl('disabled:cursor-not-allowed hover:bg-blue-600'))).toBe(false);
  });

  it('真正的禁用类名仍然识别', () => {
    expect(controlDisabled(fakeControl('disabled'))).toBe(true);
    expect(controlDisabled(fakeControl('btn btn-disabled'))).toBe(true);
    expect(controlDisabled(fakeControl('is-disabled'))).toBe(true);
    expect(controlDisabled(fakeControl('semi-button-disabled'))).toBe(true);
  });

  it('disabled 属性和 aria-disabled 仍然识别', () => {
    expect(controlDisabled(fakeControl('btn', {}, true))).toBe(true);
    expect(controlDisabled(fakeControl('btn', { 'aria-disabled': 'true' }))).toBe(true);
    expect(controlDisabled(fakeControl('btn', { 'aria-disabled': 'false' }))).toBe(false);
  });

  it('普通按钮不算禁用', () => {
    expect(controlDisabled(fakeControl('btn btn-primary'))).toBe(false);
    expect(controlDisabled(fakeControl(''))).toBe(false);
  });
});

describe('签到动作词表', () => {
  it('覆盖常见说法', () => {
    for (const text of ['签到', '立即签到', '每日打卡', '领取每日额度', 'Check in', 'Claim Daily Bonus']) {
      expect(CHECKIN_ACTION.test(text), text).toBe(true);
    }
  });

  it('排除点了没用的入口', () => {
    for (const text of ['签到记录', '签到日历', '签到规则', 'Check-in History']) {
      expect(NON_ACTION_WORDS.test(text), text).toBe(true);
    }
  });

  it('已签到文案能识别（正文兜底仍需要它）', () => {
    expect(hit('已签到 3 天，连续签到可得更多额度', ALREADY_WORDS)).toBe(true);
    expect(hit('今日已领取', ALREADY_WORDS)).toBe(true);
    expect(hit('立即签到', ALREADY_WORDS)).toBe(false);
  });
});

/**
 * 「页面上有没有签到入口」这一判据的语义红线（不是 checkinControls 本身，
 * 而是调用方如何使用它）。
 *
 * 现场背景：内容脚本用「可见且文案命中签到动作词」判断结束学习时页面上是否还摆着
 * 签到入口，作为「本站是不是登录即签到」的证据之一。这里刻意**不看禁用态**：
 * 当天已签到时按钮常被置灰成「已签到」，而它恰恰证明该站点本来就有签到入口 ——
 * 把它当成「没有控件」，会让用户在「今天已签」的那次学习里被误改成登录即签到，
 * 明天真正需要点击时反而不会点。
 */
describe('「有签到入口」的判据必须包含禁用态控件', () => {
  it('禁用态的「已签到」按钮仍然命中签到动作词，且不被排除词拦掉', () => {
    const disabledAlready = fakeControl('btn btn-disabled', { 'aria-disabled': 'true' }, true);

    // 它确实处于禁用态……
    expect(controlDisabled(disabledAlready)).toBe(true);
    // ……但文案是签到语义，调用方据此判定「站点的签到入口存在」。
    expect(CHECKIN_ACTION.test('已签到')).toBe(true);
    expect(NON_ACTION_WORDS.test('已签到')).toBe(false);
  });

  it('反向对照：「签到记录 / 规则 / 日历」是导航入口，不算签到动作', () => {
    for (const label of ['签到记录', '签到规则', '签到日历']) {
      expect(NON_ACTION_WORDS.test(label)).toBe(true);
    }
  });
});