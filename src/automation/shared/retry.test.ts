import { describe, expect, it } from 'vitest';
import { DIAGNOSIS, classifyFailure, planRetry } from '@/automation/shared/diagnostics';

describe('planRetry 差异化重试', () => {
  it('站点 5xx 值得重试，延迟递增退避', () => {
    const first = planRetry(DIAGNOSIS.SITE_UNAVAILABLE, 0);
    const second = planRetry(DIAGNOSIS.SITE_UNAVAILABLE, 1);

    expect(first.retry).toBe(true);
    expect(second.retry).toBe(true);
    // 退避：第二次要等更久，避免站点故障时被反复戳
    expect(second.delayMs).toBeGreaterThan(first.delayMs);
  });

  it('选择器对不上不重试 —— 配置问题重试一百次结果一样', () => {
    const decision = planRetry(DIAGNOSIS.SELECTOR_MISMATCH, 0);
    expect(decision.retry).toBe(false);
    expect(decision.reason).toContain('人工');
  });

  it('需要人工介入不重试', () => {
    expect(planRetry(DIAGNOSIS.MANUAL_REQUIRED, 0).retry).toBe(false);
  });

  it('没有签到入口不重试', () => {
    expect(planRetry(DIAGNOSIS.NO_CHECKIN_ENTRY, 0).retry).toBe(false);
  });

  it('达到上限后停止', () => {
    const plan = planRetry(DIAGNOSIS.NETWORK_FAILURE, 0);
    const exhausted = planRetry(DIAGNOSIS.NETWORK_FAILURE, plan.maxAttempts);

    expect(plan.retry).toBe(true);
    expect(exhausted.retry).toBe(false);
    expect(exhausted.reason).toContain('上限');
  });

  it('登录态失效只重试一次就够（扩展会自己重新登录）', () => {
    expect(planRetry(DIAGNOSIS.AUTH_EXPIRED, 0).retry).toBe(true);
    expect(planRetry(DIAGNOSIS.AUTH_EXPIRED, 1).retry).toBe(false);
  });

  it('未知失败不盲目重试', () => {
    expect(planRetry(DIAGNOSIS.UNKNOWN, 0).retry).toBe(false);
  });
});

describe('站点明确拒绝不重试', () => {
  it('「签到请求被拒绝」判为业务拒绝而非站点故障', () => {
    // 关键回归：这句话里的「拒绝」曾被网络类规则捞走，
    // 当成连接问题反复重试，任务卡在 running 直到超时
    const code = classifyFailure('签到请求被拒绝');
    expect(code).toBe(DIAGNOSIS.SITE_REJECTED);
    expect(planRetry(code, 0).retry).toBe(false);
  });

  it('业务规则类失败一律不重试', () => {
    for (const message of ['余额不足', '活动已结束', '账号已封禁', '显式失败优先']) {
      const code = classifyFailure(message);
      expect(planRetry(code, 0).retry, message).toBe(false);
    }
  });

  it('拒绝优先于站点不可用 —— 两者文案可能同时出现', () => {
    expect(classifyFailure('签到被拒绝，服务返回 503')).toBe(DIAGNOSIS.SITE_REJECTED);
  });
});

describe('classifyFailure 与重试策略配合', () => {
  it('网关错误归到站点不可用，进而触发重试', () => {
    const code = classifyFailure('签到接口返回 HTTP 502 Bad Gateway');
    expect(code).toBe(DIAGNOSIS.SITE_UNAVAILABLE);
    expect(planRetry(code, 0).retry).toBe(true);
  });

  it('找不到按钮归到选择器不匹配，不触发重试', () => {
    const code = classifyFailure('未找到签到按钮', ['当前页没有可点的签到元素']);
    expect(code).toBe(DIAGNOSIS.SELECTOR_MISMATCH);
    expect(planRetry(code, 0).retry).toBe(false);
  });

  it('遮挡告警归到选择器类，不会被误判成值得重试', () => {
    // 公告遮挡是配置/时序问题，重试同样会被挡住
    const code = classifyFailure('签到按钮被div.ant-modal-mask遮挡，可能有未关闭的公告弹窗');
    expect(planRetry(code, 0).retry).toBe(false);
  });

  it('人工验证优先级高于其他症状', () => {
    // 同时出现超时和验证码字样时，应判为需要人工而不是网络失败
    const code = classifyFailure('安全验证超时，请完成后重新签到');
    expect(code).toBe(DIAGNOSIS.MANUAL_REQUIRED);
    expect(planRetry(code, 0).retry).toBe(false);
  });
});
