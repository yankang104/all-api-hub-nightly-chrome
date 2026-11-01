import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SiteConfig, WorkflowLearningEvent } from '@/types';
import { buildLearnedWorkflow } from './learning';
import { runCheckinWorkflow } from './workflow';
import { realClick } from '@/automation/shared/dom-utils';

vi.mock('@/automation/shared/dom-utils', async (original) => {
  const actual = await original<typeof import('@/automation/shared/dom-utils')>();
  return { ...actual, realClick: vi.fn(async (element: HTMLElement) => { element.click(); return 'dom' as const; }) };
});
vi.mock('@/automation/shared/click-safety', () => ({ clearClickBlocker: vi.fn(async () => null) }));

const site: SiteConfig = {
  id: 'fixture', name: 'fixture', loginUrl: `${location.origin}/dashboard/overview`,
  selectors: { username: '', password: '', submit: '' }, closeModalSelectors: [],
};
const events: WorkflowLearningEvent[] = [
  { type: 'navigation', path: '/dashboard/overview', at: 1 },
  { type: 'click', selector: '#profile', label: '个人资料', path: '/dashboard/overview', at: 2 },
  { type: 'navigation', path: '/profile', at: 3 },
  { type: 'click', selector: '#entry', label: '进入签到', path: '/profile', at: 4 },
  { type: 'navigation', path: '/checkin', at: 5 },
  { type: 'click', selector: '#claim', label: '立即签到', path: '/checkin', at: 6 },
];
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 100, height: 30 } as DOMRect);
  document.body.innerHTML = '';
  vi.mocked(realClick).mockClear();
});
afterEach(() => vi.restoreAllMocks());

it('站点入口是业务页时不删除起点；先回放中间页动作，再交给引擎导航与身份核验', async () => {
  const workflow = buildLearnedWorkflow(site, events)!.workflow;
  expect(workflow.route).toEqual(['/dashboard/overview', '/profile', '/checkin']);
  expect(workflow.identityPath).toBe('/profile');
  history.replaceState({}, '', '/dashboard/overview');
  document.body.innerHTML = '<button id="profile">个人资料</button><button id="claim">立即签到</button>';
  const profile = document.querySelector<HTMLElement>('#profile')!;
  const order: string[] = [];
  profile.onclick = () => { order.push('click'); history.pushState({}, '', '/profile'); };
  const result = await runCheckinWorkflow(site, workflow, { push: vi.fn() }, {
    beforeNavigate: async () => { order.push('checkpoint'); },
  });
  expect(order).toEqual(['checkpoint', 'click']);
  expect(result).toEqual({ status: 'navigate', url: `${location.origin}/profile` });
  expect(realClick).toHaveBeenCalledTimes(1);
  expect(realClick).toHaveBeenCalledWith(profile, { mayNavigate: true });
});

it('落在路线外时先回起点，不能把等于 loginUrl 的业务页跳掉', async () => {
  history.replaceState({}, '', '/welcome');
  const workflow = buildLearnedWorkflow(site, events)!.workflow;
  const result = await runCheckinWorkflow(site, workflow, { push: vi.fn() });
  expect(result).toEqual({ status: 'navigate', url: `${location.origin}/dashboard/overview` });
  expect(realClick).not.toHaveBeenCalled();
});

it('中间页点击发生非预期导航时停止，不能在另一页继续签到', async () => {
  history.replaceState({}, '', '/dashboard/overview');
  document.body.innerHTML = '<button id="profile">个人资料</button>';
  document.querySelector<HTMLElement>('#profile')!.onclick = () => { history.pushState({}, '', '/unexpected'); };
  const result = await runCheckinWorkflow(site, buildLearnedWorkflow(site, events)!.workflow, { push: vi.fn() });
  expect(result.status).toBe('failed');
});

it('中间页的控件在别的账号页面上不存在（如印着演示账号名字的菜单）：按路线直接进下一页', async () => {
  history.replaceState({}, '', '/dashboard/overview');
  // 页面上没有 #profile：演示账号点的是自己的头像菜单，换个账号就没有这个控件。
  document.body.innerHTML = '<button id="claim">立即签到</button>';
  const log = { push: vi.fn() };
  const workflow = buildLearnedWorkflow(site, events)!.workflow;
  const step = workflow.steps.find((item) => item.type === 'if')!;
  if (step.type === 'if') {
    for (const nested of step.then) if (nested.type === 'click') nested.timeoutMs = 50;
  }

  const result = await runCheckinWorkflow(site, workflow, log);

  expect(result).toEqual({ status: 'navigate', url: `${location.origin}/profile` });
  expect(realClick).not.toHaveBeenCalled();
  expect(log.push).toHaveBeenCalledWith(expect.stringContaining('按学习路线直接进入下一页'));
});
