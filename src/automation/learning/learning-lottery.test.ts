import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SiteConfig, WorkflowLearningEvent } from '@/types';
import { realClick } from '@/automation/shared/dom-utils';
import { buildLearnedArtifacts, buildLearnedWorkflow, evidenceFromText, LearningCapture, shouldAutoSaveLoginAsCheckin } from './learning';
import { analyzeLearningEvents, checkinEvidenceOf } from './learning-stage';
import { buildLearningReport } from './learning-report';
import { runCheckinWorkflow } from './workflow';
import { validateCheckinWorkflow } from '@/lib/workflow/workflow-validation';

vi.mock('@/automation/shared/dom-utils', async (original) => {
  const actual = await original<typeof import('@/automation/shared/dom-utils')>();
  return { ...actual, realClick: vi.fn(async (element: HTMLElement) => { element.click(); return 'dom' as const; }) };
});
vi.mock('@/automation/shared/click-safety', () => ({ clearClickBlocker: vi.fn(async () => null) }));

const site: SiteConfig = {
  id: 'lottery', name: '抽奖测试站', loginUrl: location.origin + '/sign-in',
  selectors: { username: '#username', password: '#password', submit: '#login' },
  closeModalSelectors: [],
};
const nav = (path: string): WorkflowLearningEvent => ({ type: 'navigation', path, at: 1 });
function draw(label = '开始抽奖'): WorkflowLearningEvent {
  return { type: 'click', selector: '#draw', label, path: '/lottery', at: 2 };
}

beforeEach(() => {
  history.replaceState({}, '', '/lottery');
  document.body.innerHTML = '';
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 100, height: 30 } as DOMRect);
  vi.mocked(realClick).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  history.replaceState({}, '', '/');
});

describe('抽奖学习必须保留真实业务动作', () => {
  it.each(['/lottery', '/draw', '/prize', '/#/lottery', '/#/draw?tab=daily'])('只有进入 %s 不能自动推断登录即签到', (path) => {
    const events = [nav(path)];
    expect(shouldAutoSaveLoginAsCheckin(events, 'both', false)).toBe(false);
    expect(analyzeLearningEvents(events, 'both').loginAsCheckinAvailable).toBe(false);
    expect(buildLearnedArtifacts(site, events, 'both').checkin).toBeNull();
    expect(buildLearningReport(events, 'both', { siteCheckinMethod: 'none' }).verdict).toBe('incomplete');
  });

  it('看过抽奖页再返回个人页仍不能被推断成登录即签到', () => {
    expect(shouldAutoSaveLoginAsCheckin([nav('/lottery'), nav('/profile')], 'both', false)).toBe(false);
    expect(shouldAutoSaveLoginAsCheckin([nav('/profile')], 'both', false)).toBe(true);
  });

  it.each(['开始抽奖', '浮梦抽签', 'Start draw'])('%s 被算作业务动作并编译为实际点击', (label) => {
    const events = [nav('/lottery'), draw(label)];
    expect(checkinEvidenceOf(draw(label))).toBe('action');
    const learned = buildLearnedArtifacts(site, events, 'both').checkin;
    expect(learned?.kind).toBe('workflow');
    if (learned?.kind !== 'workflow') throw new Error('没有编译抽奖流程');
    expect(learned.workflow.steps).toContainEqual(expect.objectContaining({ type: 'click', selector: '#draw' }));
    expect(learned.workflow.identityPath).toBe('/lottery');
    expect(buildLearningReport(events, 'both').verdict).toBe('partial');
  });

  it('业务表单的抽奖 submit 不是登录动作', () => {
    expect(checkinEvidenceOf({ ...draw(), loginAction: 'submit' } as WorkflowLearningEvent)).toBe('action');
  });

  it('加载占位和他人中奖不作为抽奖成功证据', () => {
    expect(evidenceFromText('今日已抽 0 次 Draw completed 用户甲中了 $5', true)).toBeUndefined();
    expect(evidenceFromText('This draw is complete. Come back tomorrow for another.', true))
      .toEqual({ kind: 'already', words: ['This draw is complete'] });
  });

  it('晚到的抽奖结果补报回同一个动作，结束学习刷新时不丢', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button id="draw">开始抽奖</button><p id="result"></p>';
    const events: WorkflowLearningEvent[] = [];
    const capture = new LearningCapture({ kind: 'both', settleMs: 50, onEvent: (event) => events.push(event) });
    capture.attach();
    document.querySelector<HTMLElement>('#draw')!.click();
    await vi.advanceTimersByTimeAsync(100);
    document.querySelector('#result')!.textContent = '抽奖成功';
    await vi.advanceTimersByTimeAsync(2500);
    capture.flushPending();
    capture.detach();
    const clicks = events.filter((event) => event.type === 'click');
    expect(new Set(clicks.map((event) => event.at)).size).toBe(1);
    expect(clicks).toContainEqual(expect.objectContaining({ evidence: { kind: 'success', words: ['抽奖成功'] } }));
    expect(buildLearningReport(events, 'both').verdict).toBe('complete');
  });

  it('回放只点一次并等待异步开奖，加载占位不能提前终止', async () => {
    document.body.innerHTML = '<button id="draw">开始抽奖</button><p id="result">今日已抽 0 次 Draw completed</p>';
    document.querySelector<HTMLElement>('#draw')!.onclick = () => {
      setTimeout(() => { document.querySelector('#result')!.textContent = '抽奖成功'; }, 1000);
    };
    const workflow = buildLearnedWorkflow(site, [nav('/lottery'), draw()])!.workflow;
    const result = await runCheckinWorkflow(site, workflow, { push: vi.fn() });
    expect(result.status).toBe('success');
    expect(realClick).toHaveBeenCalledTimes(1);
  });

  it('加载占位指纹短暂失配时等待真正的抽奖按钮，不空转耗尽重试次数', async () => {
    document.body.innerHTML = '<button id="draw" disabled>今日已抽</button><p id="result"></p>';
    setTimeout(() => {
      const button = document.querySelector<HTMLButtonElement>('#draw')!;
      button.disabled = false;
      button.textContent = '开始抽奖';
      button.onclick = () => { document.querySelector('#result')!.textContent = '今日梦火抽签次数已耗尽'; };
    }, 1200);
    const action = { ...draw(), fingerprint: { tag: 'button', text: '开始抽奖' } } as WorkflowLearningEvent;
    const workflow = buildLearnedWorkflow(site, [nav('/lottery'), action])!.workflow;
    const result = await runCheckinWorkflow(site, workflow, { push: vi.fn() });
    expect(result.status).toBe('success');
    expect(realClick).toHaveBeenCalledTimes(1);
  });

  it('加载一直未完成时不能用附近的今日已抽占位掩盖失败', async () => {
    document.body.innerHTML = '<section><button id="draw" disabled>今日已抽</button><p>Draw completed 0 次</p></section>';
    const workflow = buildLearnedWorkflow(site, [nav('/lottery'), {
      ...draw(), fingerprint: { tag: 'button', text: '开始抽奖' },
    } as WorkflowLearningEvent])!.workflow;
    const click = workflow.steps.find((step) => step.type === 'click');
    if (click?.type !== 'click') throw new Error('没有抽奖步骤');
    click.timeoutMs = 50;
    const result = await runCheckinWorkflow(site, workflow, { push: vi.fn() });
    expect(result.status).toBe('failed');
    expect(realClick).not.toHaveBeenCalled();
  });

  it('可靠的今日抽奖结束证据直接完成，不再寻找已禁用的抽奖按钮', async () => {
    document.body.innerHTML = '<button id="draw" disabled>今日已抽</button><p>This draw is complete</p>';
    const workflow = buildLearnedWorkflow(site, [nav('/lottery'), draw('Start draw')])!.workflow;
    expect((await runCheckinWorkflow(site, workflow, { push: vi.fn() })).status).toBe('already');
    expect(realClick).not.toHaveBeenCalled();
  });

  it('多动作抽奖流程为异步结果和前置守卫预留步数，不超校验上限', () => {
    const events: WorkflowLearningEvent[] = [nav('/lottery')];
    for (let index = 0; index < 35; index += 1) {
      events.push({ type: 'click', path: '/lottery', selector: '#step-' + index, label: '打开选项', at: 1000 * index });
    }
    events.push({ ...draw(), at: 40_000 });
    const workflow = buildLearnedWorkflow(site, events)!.workflow;
    expect(validateCheckinWorkflow(site, workflow)).toEqual([]);
    expect(workflow.steps).toContainEqual(expect.objectContaining({ type: 'click', selector: '#draw' }));
  });
});
