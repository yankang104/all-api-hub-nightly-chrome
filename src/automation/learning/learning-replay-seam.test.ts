/**
 * 学习 → 执行的接缝测试。
 *
 * 学习模式产出的选择器最终要交给 `automation/workflow.ts` 的 click 步骤执行。
 * 两边各自有测试，但没人验证「学出来的选择器执行器真的找得到控件」。
 * 这条缝断掉时表现最迷惑：流程能保存、能跑完，但**什么都没点到**。
 *
 * jsdom 没有布局引擎，`getBoundingClientRect()` 恒为 0，会让真实 `isVisible`
 * 把所有元素判成不可见。这里给原型补一个非零矩形，让可见性判定按真实逻辑走，
 * 而不是把可见性整个 mock 掉 —— 本文件要验证的正是「选择器能否真正解析到控件」。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/automation/shared/dom-utils', async () => {
  const actual = await vi.importActual<typeof import('@/automation/shared/dom-utils')>('@/automation/shared/dom-utils');
  return {
    ...actual,
    realClick: vi.fn().mockResolvedValue('dom'),
    sleep: vi.fn().mockResolvedValue(undefined),
    // 立即判定一次（真实 queryFirst），不空等元素超时。
    waitFor: vi.fn(async (selector: string) => actual.queryFirst(selector)),
  };
});

vi.mock('@/automation/shared/click-safety', () => ({
  clearClickBlocker: vi.fn().mockResolvedValue(null),
}));

import { queryFirst } from '@/automation/shared/dom-utils';
import { runCheckinWorkflow } from '@/automation/learning/workflow';
import type { CheckinWorkflowStep, SiteConfig } from '@/types';

const site: SiteConfig = {
  id: 'site-1',
  name: '测试站',
  loginUrl: `${window.location.origin}/login`,
  selectors: { username: '#user', password: '#pass', submit: '#submit' },
  closeModalSelectors: [],
};

const log = { push: vi.fn() };

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function rect() {
    return { x: 0, y: 0, width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 } as DOMRect;
  };
  // jsdom 不实现 innerText（恒为 undefined），而 queryByText 正是按 innerText 匹配文字。
  // 这是环境限制：不给它兜底，text= 路径在单测里永远找不到元素，也就无法验证
  // 「学到的文字选择器回放时到底能不能命中」。
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true,
    get(this: HTMLElement) { return this.textContent ?? ''; },
  });
});

beforeEach(() => {
  window.history.replaceState({}, '', '/check-in');
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

/** 学习模式产出的选择器形态：属性优先，其次 text=可见文字。 */
describe('学习产出的选择器必须能被执行器解析到', () => {
  it('text= 选择器能在回放时定位到同一个控件', async () => {
    document.body.innerHTML = '<button>立即签到</button>';

    const steps: CheckinWorkflowStep[] = [{ type: 'click', selector: 'text=立即签到' }];
    expect(queryFirst('text=立即签到')).not.toBeNull();

    /*
     * 本测试只关心「选择器能不能被解析到真正的控件」—— 找不到就该报失败。
     * 页面证据为空时结果是 `unknown`（步骤跑完但读不到签到证据，不假装成功），
     * 所以这里断言「不是 failed」而不是断言 success：把「点到了」和「签到了」
     * 分开正是这一步要守住的语义。
     */
    const result = await runCheckinWorkflow(site, { steps }, log);
    expect(result.status).not.toBe('failed');
  });

  it('属性型选择器不受文字变化影响', async () => {
    // 学习时文字是「立即签到」，回放时站点已改成「去签到」—— 属性选择器仍应命中。
    document.body.innerHTML = '<button data-testid="checkin">去签到</button>';

    const steps: CheckinWorkflowStep[] = [{ type: 'click', selector: '[data-testid="checkin"]' }];
    const result = await runCheckinWorkflow(site, { steps }, log);

    // 同上：本测试验证的是「属性选择器仍能命中」，不是签到结论。
    expect(result.status).not.toBe('failed');
  });

  it('控件找不到时明确失败，而不是静默跳过', async () => {
    // 「什么都没点到却报成功」是最误导的结果；必须报失败让用户改配置。
    document.body.innerHTML = '<button>别的按钮</button>';

    const steps: CheckinWorkflowStep[] = [{ type: 'click', selector: 'text=立即签到' }];
    const result = await runCheckinWorkflow(site, { steps }, log);

    // 断言收窄到 failed 分支后再读 message：WorkflowRunResult 是联合类型，
    // navigate 分支没有 message 字段。
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error(`期望 failed，实际 ${result.status}`);
    expect(result.message).toContain('text=立即签到');
  });
});
