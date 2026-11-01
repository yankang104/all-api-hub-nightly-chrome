import { describe, expect, it } from 'vitest';
import { learningNoticeFromResponse, learningNoticeSummary, learningPartialSaveToast, learningSaveToast } from './learning-notice';

/**
 * 融合学习的「部分保存」文案：一次演示只完成一半时，用户必须能从 toast 上
 * 看清「存了什么、缺什么、下一步做什么」，绝不能被一句笼统的「已保存」蒙过去。
 */
describe('learningPartialSaveToast', () => {
  it('只保存了登录配置时：如实说只存了登录，并提示重新演示签到', () => {
    const text = learningPartialSaveToast(['login'], 12, [
      '没有录到登录之后的签到动作，这次只保存登录配置；请在按钮可点时重新演示一次签到',
    ]);

    expect(text).toContain('已保存本站登录配置');
    expect(text).toContain('录到 12 个事件');
    expect(text).toContain('没有录到登录之后的签到动作');
    expect(text).toContain('重新演示');
  });

  it('只保存了签到流程时：如实说只存了签到，并提示登录配置没录到', () => {
    const text = learningPartialSaveToast(['checkin'], 5, [
      '没有录到完整的登录动作（账号/密码字段或第三方登录入口），这次只保存签到流程',
    ]);

    expect(text).toContain('已保存本站签到流程');
    expect(text).toContain('没有录到完整的登录动作');
    expect(text).toContain('只保存签到流程');
  });

  it('两份都保存时不走部分保存文案（避免把完整流程说成残缺）', () => {
    const text = learningPartialSaveToast(['login', 'checkin'], 20, []);
    expect(text).toBe('已保存本站登录配置与签到流程（录到 20 个事件）');
  });

  it('什么都没保存时不谎报「已保存」', () => {
    const text = learningPartialSaveToast([], 3, ['这次演示没有录到可保存的内容']);
    expect(text).toContain('本次没有保存任何配置');
    expect(text).not.toContain('已保存本站任何配置');
  });

  it('缺一半时的提示按分号逐条列出，不吞掉第二条', () => {
    const text = learningPartialSaveToast(['login'], 9, ['缺签到', '另一半没有保存成功：校验失败']);
    expect(text).toContain('缺签到');
    expect(text).toContain('另一半没有保存成功：校验失败');
  });
});

describe('learningSaveToast', () => {
  it('融合学习（both）明确说明登录与签到都学会了', () => {
    const notice = learningNoticeFromResponse({ report: { verdict: 'complete', lines: [{ status: 'ok', text: '✅ 到位' }] } });
    const text = learningSaveToast('both', 30, notice);
    expect(text).toContain('已保存本站登录与签到流程');
    expect(text).toContain('录到 30 个事件');
  });

  it('旧取值 login / checkin 的文案保持一字不变（向后兼容）', () => {
    expect(learningSaveToast('login', 4, null)).toBe('已保存本站通用登录流程（录到 4 个事件）：以后自动按学习到的入口和字段登录');
    expect(learningSaveToast('checkin', 4, null)).toBe('已保存本站签到流程（录到 4 个事件）：以后先自动登录，核对当前账号后再回放签到步骤');
    expect(learningNoticeSummary(null)).toBeNull();
  });
});
