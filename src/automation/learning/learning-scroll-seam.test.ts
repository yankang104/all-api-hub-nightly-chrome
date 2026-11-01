/**
 * 「学习到的滚动」→「回放的滚动」接缝。
 *
 * 用户的原话：「你难道不需要学习滑动页面的动作吗」。
 * 采集侧确实记下了滚动位置（`scrollBeforeY`），编译侧把它变成步骤上的
 * `scrollIntoView`，执行侧在点击/填写前真的滚一次 —— 三段分属三个文件，
 * 中途任何一段丢掉字段，功能都会**静默失效**：不报错，只是长页面上的按钮点不到。
 *
 * jsdom 没有布局引擎也没有 `scrollIntoView`，所以这里只断言「有没有按契约调用」，
 * 不假装验证真实滚动效果（那属于真实浏览器 e2e 的范围）。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/automation/shared/dom-utils', async () => {
  const actual = await vi.importActual<typeof import('@/automation/shared/dom-utils')>('@/automation/shared/dom-utils');
  return {
    ...actual,
    // 真实 realClick 在 jsdom 里会因为「位置不稳定 / 视口之外」一直重试到超时，
    // 本文件验证的是「点击之前有没有先滚」，所以把它换成可控替身。
    realClick: vi.fn().mockResolvedValue('dom'),
    sleep: vi.fn().mockResolvedValue(undefined),
    waitFor: vi.fn(async (selector: string) => actual.queryFirst(selector)),
  };
});

vi.mock('@/automation/shared/click-safety', () => ({
  clearClickBlocker: vi.fn().mockResolvedValue(null),
}));

import { buildLearnedWorkflow } from '@/automation/learning/learning';
import { runCheckinWorkflow } from '@/automation/learning/workflow';
import { validateCheckinWorkflow } from '@/lib/workflow/workflow-validation';
import type { CheckinWorkflowStep, SiteConfig, WorkflowLearningEvent } from '@/types';

const site: SiteConfig = {
  id: 'st-seam',
  name: '接缝站',
  loginUrl: `${window.location.origin}/login`,
  selectors: { username: '#user', password: '#pass', submit: '#submit' },
  closeModalSelectors: [],
};

/** 页面很长：签到按钮在文档下方，用户必须先滚动才够得着。 */
const LONG_PAGE_EVENTS: WorkflowLearningEvent[] = [
  { type: 'navigation', path: '/dashboard', at: 1 },
  { type: 'click', selector: 'text=个人资料', label: '个人资料', path: '/profile', at: 2 },
  // 用户滚下去，再点签到
  { type: 'click', selector: 'text=立即签到', label: '立即签到', path: '/profile', at: 3, scrollBeforeY: 2_400, afterText: ['已签到'] },
];

describe('学习到的滚动动作能在回放时重现', () => {
  beforeAll(() => {
    /*
     * jsdom 没有布局引擎：`getBoundingClientRect()` 恒为 0，真实的 `waitFor` 会把
     * 所有元素判成不可见（`isVisible` 要求宽高非零），点击步骤直接报「找不到可点击元素」。
     * 这是环境限制而非产品缺陷，所以给原型补一个非零矩形，让可见性判定按真实逻辑走。
     */
    Element.prototype.getBoundingClientRect = function rect() {
      return { x: 0, y: 0, width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 } as DOMRect;
    };
  });

  beforeEach(() => {
    window.history.replaceState({}, '', `${window.location.origin}/check-in`);
    document.body.innerHTML = '';
  });

  it('采集到的滚动位置会被编译成步骤上的 scrollIntoView', () => {
    const learned = buildLearnedWorkflow(site, LONG_PAGE_EVENTS);
    expect(learned).not.toBeNull();

    // 找不到「先滚动才够得着」的那个签到步骤，说明采集/编译这一段断了。
    const checkinSteps = learned!.workflow.steps.filter(
      (step): step is Extract<CheckinWorkflowStep, { type: 'click' }> =>
        step.type === 'click' && step.selector.includes('立即签到'),
    );
    expect(checkinSteps).toHaveLength(1);
    expect(checkinSteps[0]?.scrollIntoView).toBe(true);
  });

  it('带 scrollIntoView 的步骤能通过校验器（否则用户根本存不下学到的流程）', () => {
    const learned = buildLearnedWorkflow(site, LONG_PAGE_EVENTS)!;

    expect(validateCheckinWorkflow(site, learned.workflow)).toEqual([]);
  });

  it('回放时真的先滚动再点，不是把字段丢掉', async () => {
    const steps: CheckinWorkflowStep[] = [{ type: 'click', selector: '#checkin', scrollIntoView: true }];
    document.body.innerHTML = '<button id="checkin">立即签到</button>';
    const button = document.getElementById('checkin')!;
    const scrollIntoView = vi.fn();
    (button as unknown as { scrollIntoView: () => void }).scrollIntoView = scrollIntoView;

    await runCheckinWorkflow(site, { steps }, []);

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    // 只滚相对位置，绝不回放录制时的绝对像素（2_400 是那一刻页面高度决定的）。
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', inline: 'center' });
  });

  it('没学到滚动的步骤不会平白多滚一次', async () => {
    const steps: CheckinWorkflowStep[] = [{ type: 'click', selector: '#plain' }];
    document.body.innerHTML = '<button id="plain">立即签到</button>';
    const scrollIntoView = vi.fn();
    (document.getElementById('plain') as unknown as { scrollIntoView: () => void }).scrollIntoView = scrollIntoView;

    await runCheckinWorkflow(site, { steps }, []);

    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
