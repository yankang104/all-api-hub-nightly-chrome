/**
 * 「签到请求被站点明确拒绝」时的可重试性。
 *
 * 用户实测诉求（本轮原话其一）：**接口偶发失败一次后能不能重试成功**。
 *
 * 站点把「服务暂不可用」渲染成页面文案（`签到失败：服务暂不可用`）时，
 * 扩展只看成功词表，读不到成功就报「点击自动识别的签到按钮后缺少明确结果」——
 * 那句话既没有把站点真正说的原因带给用户，也让 diagnostics 归类不到
 * `SITE_UNAVAILABLE`，于是**一次偶发 5xx 就永久失败，完全不重试**。
 *
 * 这条测试锁住两件事：
 *   1. 站点明确拒绝时的原因必须一路带到 message/steps（否则重试分类不可能对）；
 *   2. 分类结果必须是「可重试」的那一类 —— 同时**不能**把「响应未知」也
 *      归进来（那会让一次可能已经落库的签到被重复提交）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/automation/shared/dom-utils', async () => {
  const actual = await vi.importActual<typeof import('@/automation/shared/dom-utils')>('@/automation/shared/dom-utils');
  return {
    ...actual,
    sleep: vi.fn().mockResolvedValue(undefined),
    waitFor: vi.fn(async (selector: string) => actual.queryFirst(selector)),
    realClick: vi.fn(async (element: HTMLElement) => { element.click(); return 'dom'; }),
  };
});

vi.mock('@/automation/balance/balance', async () => {
  const actual = await vi.importActual<typeof import('@/automation/balance/balance')>('@/automation/balance/balance');
  return { ...actual, captureBalance: vi.fn().mockResolvedValue(null) };
});

vi.mock('@/automation/shared/click-safety', () => ({
  clearClickBlocker: vi.fn().mockResolvedValue(null),
}));

import { performCheckin, type CheckinOutcome } from '@/automation/checkin/checkin';
import { classifyFailure, planRetry, DIAGNOSIS } from '@/automation/shared/diagnostics';
import type { SiteConfig } from '@/types';

const log = { push: vi.fn() };

/**
 * 把 outcome 收敛成带 message 的终态。
 *
 * 直接读 `outcome.message` 通不过类型检查（联合类型里 navigate/relogin 没有
 * message 字段）。用例真正关心的是「结论里有没有站点说出的原因」，所以这里
 * 显式断言它不是中间态 —— 顺带把「签到不该以导航收尾」也锁住。
 */
function terminalMessage(outcome: CheckinOutcome): string {
  if (outcome.status === 'navigate' || outcome.status === 'relogin') {
    throw new Error(`签到以中间态收尾: ${outcome.status}`);
  }
  return outcome.message;
}
const site: SiteConfig = {
  id: 'flaky', name: '偶发故障站', loginUrl: `${location.origin}/login`,
  selectors: { username: '#u', password: '#p', submit: '#s' },
  closeModalSelectors: [],
  checkin: { method: 'auto' },
};

beforeEach(() => {
  vi.clearAllMocks();
  history.replaceState({}, '', '/check-in');
  // 等待循环以 Date.now() 为界。让时钟**单调前进**而不是冻结：冻结会让
  // 「等结果」的轮询永不结束（用例挂死），前进才能在秒级内走到同一结论。
  // sleep 已被 mock 成立即返回，因此这里推进的是逻辑时间而非真实等待。
  let logicalNow = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => { logicalNow += 500; return logicalNow; });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 100, height: 30, top: 0, left: 0, right: 100, bottom: 30,
  } as DOMRect);
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true,
    get(this: HTMLElement) { return this.textContent ?? ''; },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  history.replaceState({}, '', '/');
});

describe('站点明确拒绝签到时的可重试性', () => {
  it('把站点说的原因带进步骤日志（否则无法归类、无法重试）', async () => {
    document.body.innerHTML = '<h1>每日签到</h1><button id="claim">立即签到</button><p id="result"></p>';
    document.querySelector<HTMLElement>('#claim')!.addEventListener('click', () => {
      document.querySelector('#result')!.textContent = '签到失败：服务暂不可用（HTTP 503）';
    });

    const outcome = await performCheckin(site, log);

    expect(outcome.status).toBe('failed');
    const steps = log.push.mock.calls.map(([step]) => String(step)).join('\n');
    expect(`${terminalMessage(outcome)}\n${steps}`).toContain('服务暂不可用');
  });

  it('明确的 5xx 被归到「值得重试」，且重试次数有上限', async () => {
    document.body.innerHTML = '<h1>每日签到</h1><button id="claim">立即签到</button><p id="result"></p>';
    document.querySelector<HTMLElement>('#claim')!.addEventListener('click', () => {
      document.querySelector('#result')!.textContent = '签到失败：服务暂不可用（HTTP 503）';
    });

    const outcome = await performCheckin(site, log);
    const steps = log.push.mock.calls.map(([step]) => String(step));

    const message = terminalMessage(outcome);
    const code = classifyFailure(message, steps.concat(message));
    expect(code).toBe(DIAGNOSIS.SITE_UNAVAILABLE);
    const first = planRetry(code, 0);
    expect(first.retry).toBe(true);
    expect(first.maxAttempts).toBeGreaterThan(0);
    // 上限必须是有限的：无限重试会把站点故障放大成持续打点。
    expect(planRetry(code, first.maxAttempts).retry).toBe(false);
  });

  it('响应未知（点击后页面什么都没说）绝不进入可重试分类', async () => {
    // 这一条与上面成对：站点没有明确拒绝时，写请求可能已经落库，
    // 任何「重试」都等于重复提交。
    document.body.innerHTML = '<h1>每日签到</h1><button id="claim">立即签到</button><p id="result"></p>';
    document.querySelector<HTMLElement>('#claim')!.addEventListener('click', () => { /* 静默 */ });

    const outcome = await performCheckin(site, log);
    const steps = log.push.mock.calls.map(([step]) => String(step));

    expect(outcome.status).toBe('failed');
    const message = terminalMessage(outcome);
    const code = classifyFailure(message, steps.concat(message));
    expect(code).not.toBe(DIAGNOSIS.SITE_UNAVAILABLE);
    expect(planRetry(code, 0).retry).toBe(false);
  });
});


