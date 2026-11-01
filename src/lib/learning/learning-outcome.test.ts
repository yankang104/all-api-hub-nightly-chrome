/**
 * 「这次学习算不算完整」的判定回归测试。
 *
 * 真实缺陷（2026-10-08 修）：判据曾是后台的兼容字段 kind，而它是按**实际存下了
 * 什么**反推的 —— 融合学习只存下登录时它也回 'login'，与「用户本来就只点学习登录」
 * 完全同形。界面据此把「学了一半」渲染成「登录与签到流程都已学会」，用户直到自动
 * 签到失败才发现签到流程根本不存在。
 *
 * 下面的用例把这条退化路径钉死：只要意图是 both 而只存了一份，就必须判「不完整」。
 */
import { describe, expect, it } from 'vitest';
import { learningOutcome, learningSavedToastText } from './learning-notice';

describe('learningOutcome', () => {
  it('融合学习只存下登录时判不完整（真实缺陷的回归点）', () => {
    const outcome = learningOutcome({ intent: 'both', kind: 'login', savedKinds: ['login'] });

    expect(outcome.intent).toBe('both');
    expect(outcome.savedLogin).toBe(true);
    expect(outcome.savedCheckin).toBe(false);
    expect(outcome.complete).toBe(false);
  });

  it('融合学习两份都存下才判完整', () => {
    expect(learningOutcome({ intent: 'both', kind: 'checkin', savedKinds: ['login', 'checkin'] }).complete).toBe(true);
  });

  it('只学登录的旧入口：只要有登录配置就算完整（不能误报残缺）', () => {
    expect(learningOutcome({ intent: 'login', kind: 'login', savedKinds: ['login'] }).complete).toBe(true);
  });

  it('旧后台没有 intent 时回落按 kind 推断意图', () => {
    // kind='login' 视为只学登录
    expect(learningOutcome({ kind: 'login', savedKinds: ['login'] }).intent).toBe('login');
    // kind='checkin' 视为融合学习，只存签到那份必须判不完整
    expect(learningOutcome({ kind: 'checkin', savedKinds: ['checkin'] }).complete).toBe(false);
  });

  it('什么都没存下时一律不完整', () => {
    expect(learningOutcome({ intent: 'both', savedKinds: [] }).complete).toBe(false);
    expect(learningOutcome({ intent: 'login', savedKinds: [] }).complete).toBe(false);
  });
});

describe('learningSavedToastText', () => {
  it('融合学习只存下登录时走「部分保存」文案，绝不谎报两份都学会', () => {
    const text = learningSavedToastText({
      intent: 'both',
      kind: 'login',
      savedKinds: ['login'],
      eventCount: 5,
      warnings: ['没有录到登录之后的签到动作，这次只保存登录配置；请在按钮可点时重新演示一次签到'],
    });

    expect(text).toContain('已保存本站登录配置');
    expect(text).toContain('没有录到登录之后的签到动作');
    expect(text).toContain('重新演示');
    expect(text).not.toContain('登录与签到流程');
  });

  it('融合学习两份都存下时说清楚两样都学会了', () => {
    const text = learningSavedToastText({
      intent: 'both',
      kind: 'checkin',
      savedKinds: ['login', 'checkin'],
      eventCount: 20,
      report: { verdict: 'complete', lines: [{ status: 'ok', text: '✅ 都学会了' }] },
    });

    expect(text).toContain('登录与签到流程');
    expect(text).toContain('20 个事件');
  });

  it('只学登录的旧入口保存成功时不说成融合学习', () => {
    const text = learningSavedToastText({
      intent: 'login',
      kind: 'login',
      savedKinds: ['login'],
      eventCount: 8,
    });

    expect(text).toContain('本站通用登录流程');
    expect(text).not.toContain('登录与签到流程');
  });
});
