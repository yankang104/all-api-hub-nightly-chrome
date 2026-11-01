/**
 * 状态文案必须跟着站点动作走。
 *
 * 这些断言存在的原因：SharedChat 做的是「领取权益」，全站统一显示
 * 「正在签到 / 已签到」会让用户以为扩展跑错了流程；Agent Router 的
 * 「退出重登领奖」同理。
 */
import { describe, expect, it } from 'vitest';
import { actionWords, stageLabelFor, statusLabelFor } from '@/lib/checkin/action-label';

describe('actionWords', () => {
  it('默认按签到措辞', () => {
    const words = actionWords(undefined);
    expect(words.noun).toBe('签到');
    expect(words.done).toBe('已签到');
    expect(words.pending).toBe('待签到');
  });

  it('claim 站点说领取，不说签到', () => {
    const words = actionWords('claim');
    expect(words.noun).toBe('领取权益');
    expect(words.done).toBe('已领取');
    expect(words.running).toBe('领取中');
    expect(words.failed).toBe('领取失败');
    expect(words.acting).not.toContain('签到');
  });

  it('relogin 站点讲清是登录奖励', () => {
    const words = actionWords('relogin');
    expect(words.noun).toBe('登录奖励');
    expect(words.acting).toContain('重登');
  });

  it('button / api / auto 仍按签到措辞', () => {
    for (const method of ['button', 'api', 'auto', 'none'] as const) {
      expect(actionWords(method).done).toBe('已签到');
    }
  });
});

describe('stageLabelFor', () => {
  it('执行动作那一阶段按方式区分', () => {
    expect(stageLabelFor('checkin', 'claim')).toBe('正在领取权益');
    expect(stageLabelFor('checkin', 'button')).toBe('正在签到');
    expect(stageLabelFor('checkin', undefined)).toBe('正在签到');
  });

  it('登录相关阶段所有站点一致，不因方式变啰嗦', () => {
    for (const method of [undefined, 'claim', 'relogin'] as const) {
      expect(stageLabelFor('login', method)).toBe('正在登录');
      expect(stageLabelFor('verify', method)).toBe('登录校验');
      expect(stageLabelFor('verify-oauth', method)).toBe('等待授权');
      expect(stageLabelFor('github-logout', method)).toBe('正在切换 GitHub 账号');
    }
  });

  it('未知阶段有兜底文案', () => {
    expect(stageLabelFor('nope' as never, 'claim')).toBe('处理中');
  });
});

describe('statusLabelFor', () => {
  it('claim 站点的四个状态都不含「签到」', () => {
    for (const status of ['pending', 'running', 'done', 'failed'] as const) {
      expect(statusLabelFor(status, 'claim')).not.toContain('签到');
    }
  });

  it('attention 与动作无关，统一提示需要人工', () => {
    expect(statusLabelFor('attention', 'claim')).toBe('需要人工处理');
    expect(statusLabelFor('attention', undefined)).toBe('需要人工处理');
  });

  it('签到站点保持原文案，避免无谓改动', () => {
    expect(statusLabelFor('done', 'button')).toBe('已签到');
    expect(statusLabelFor('pending', undefined)).toBe('待签到');
  });
});
