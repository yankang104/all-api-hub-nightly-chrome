/**
 * 学习与校验的接缝测试。
 *
 * `buildLearnedWorkflow`（learning.ts）产出 route，`validateCheckinWorkflow`
 * （workflow-validation.ts）在保存前校验 route。两者各自有单测，但**互不引用**：
 * 一旦两边对「同源」「空项」「长度」的理解不一致，学出来的流程会在保存那一步
 * 被自己的校验器拒掉 —— 各自的单测都绿，功能却端到端不可用。这里专门盯这条缝。
 */
import { describe, expect, it } from 'vitest';
import type { SiteConfig, WorkflowLearningEvent } from '@/types';
import { buildLearnedWorkflow } from '@/automation/learning/learning';
import { validateCheckinWorkflow } from '@/lib/workflow/workflow-validation';

const site: SiteConfig = {
  id: 'site-1',
  name: '测试站',
  loginUrl: 'https://example.com/login',
  selectors: { username: '#user', password: '#pass', submit: '#submit' },
  closeModalSelectors: [],
};

/** 学出来的流程必须总是能通过保存前校验，否则用户根本存不下。 */
function expectLearnable(events: WorkflowLearningEvent[]): void {
  const learned = buildLearnedWorkflow(site, events);
  expect(learned).not.toBeNull();
  expect(validateCheckinWorkflow(site, learned!.workflow)).toEqual([]);
}

describe('学习产出的流程必须能通过保存前校验', () => {
  it('普通路径路线', () => {
    expectLearnable([
      { type: 'navigation', path: '/dashboard', at: 1 },
      { type: 'navigation', path: '/daily-reward', at: 2 },
      { type: 'click', selector: 'button.claim', label: '领取', path: '/daily-reward', at: 3 },
    ]);
  });

  it('哈希路由路线', () => {
    expectLearnable([
      { type: 'navigation', path: '/#/home', at: 1 },
      { type: 'navigation', path: '/#/checkin', at: 2 },
      { type: 'click', selector: '#claim-btn', label: '签到', path: '/#/checkin', at: 3 },
    ]);
  });

  it('带成功证据的流程', () => {
    expectLearnable([
      { type: 'navigation', path: '/check-in', at: 1 },
      {
        type: 'click',
        selector: 'button.checkin',
        label: '签到',
        path: '/check-in',
        evidence: { kind: 'success', words: ['签到成功'] },
        at: 2,
      },
    ]);
  });

  it('外域导航被丢弃后仍能通过校验，且路线里不含外域', () => {
    const learned = buildLearnedWorkflow(site, [
      { type: 'navigation', path: 'https://evil.example/steal', at: 1 },
      { type: 'navigation', path: '/check-in', at: 2 },
      { type: 'click', selector: 'button.checkin', label: '立即签到', path: '/check-in', at: 3 },
    ]);

    expect(learned).not.toBeNull();
    expect(validateCheckinWorkflow(site, learned!.workflow)).toEqual([]);
    expect(JSON.stringify(learned!.workflow)).not.toContain('evil.example');
  });

  it('单页路线（只有签到页）也能通过校验', () => {
    expectLearnable([
      { type: 'click', selector: 'button.checkin', label: '立即签到', path: '/check-in', at: 1 },
    ]);
  });

  it('途经页面很多时也不会生成超长路线（否则保存必被拒）', () => {
    // 用户学习时可能点开十多个页面才到签到页。route 无上限而校验器限 12 项，
    // 学出来的流程就会在保存那一步被自己的校验器拒掉 —— 用户白学一遍。
    const events: WorkflowLearningEvent[] = [];
    for (let index = 1; index <= 20; index += 1) {
      events.push({ type: 'navigation', path: `/step-${index}`, at: index });
    }
    events.push({ type: 'click', selector: 'button.checkin', label: '立即签到', path: '/step-20', at: 21 });

    const learned = buildLearnedWorkflow(site, events);
    expect(learned).not.toBeNull();
    expect(validateCheckinWorkflow(site, learned!.workflow)).toEqual([]);
    // 截断必须保住终点页，否则自动签到会停在半路
    expect(learned!.workflow.route?.at(-1)).toBe('/step-20');
  });
});

/**
 * 学习路线 × 回放推进 的接缝（本次「流程重复 / 什么也没学习到」的直接回归点）。
 *
 * `resolveRoute`（automation/workflow.ts）的推进规则是：当前页在路线里 → 走下一页；
 * **当前页不在路线里 → 从 route[0] 开始**。用户真实场景中，登录后站点会重定向到
 * `/dashboard/overview`，而学习时录下来的 route[0] 是登录页 → 每次推进都跳回登录页
 * → 站点又重定向回来，日志三行完全一样地重复。
 *
 * 这里不修改 `resolveRoute`，而是在**生成侧**把这条陷阱锁死：学出来的 route
 * 无论从哪个位置推进，都不可能把登录页当成落点。用 route 自身的推进规则逐步模拟。
 */
describe('学出的路线拿去推进时不会指向登录页', () => {
  /** 复刻真实故障站点：loginUrl 的 pathname 就是 `/sign-in`。 */
  const authSite: SiteConfig = { ...site, loginUrl: 'https://example.com/sign-in' };
  /** 登录语义路径：与 `site.loginUrl` 同名，或本身就是认证页。 */
  const AUTH_PATH = /(?:^|\/)(?:sign-?in|sign-?up|log-?in|log-?out|logout|register|auth|oauth|authorize|password|reset|forgot)(?:\/|$)/i;

  /** `resolveRoute` 的推进规则（只看 pathname+hash，查询串无关）：返回它将要跳的那一页。 */
  function nextTarget(route: string[], currentPage: string): string | undefined {
    const index = route.indexOf(currentPage);
    const targetIndex = index >= 0 ? index + 1 : 0;
    return targetIndex >= route.length ? undefined : route[targetIndex];
  }

  it('真实故障场景：登录页被重定向到 /dashboard/overview 后签到，路线不含登录页', () => {
    const learned = buildLearnedWorkflow(authSite, [
      // 学习就是用 site.loginUrl 开页的，采集器首次加载即上报这一条
      { type: 'navigation', path: '/sign-in', at: 1 },
      // 站点把 /sign-in 重定向到真实落地页（用户真正开始的地方）
      { type: 'navigation', path: '/dashboard/overview', at: 2 },
      { type: 'click', selector: '#checkin-entry', label: '每日签到', path: '/dashboard/overview', at: 3 },
      { type: 'navigation', path: '/profile', at: 4 },
      {
        type: 'click',
        selector: '#claim',
        label: '签到',
        path: '/profile',
        evidence: { kind: 'success', words: ['签到成功'] },
        at: 5,
      },
    ]);

    const route = learned!.workflow.route!;
    expect(route).toEqual(['/dashboard/overview', '/profile']);
    expect(validateCheckinWorkflow(authSite, learned!.workflow)).toEqual([]);

    // 接缝一：路线首项不是登录页（currentIndex === -1 时的落点）
    expect(route[0]).toBe('/dashboard/overview');
    // 接缝二：从任何一个真实落点推进，都到不了登录页
    for (const landing of ['/dashboard/overview', '/profile', '/unknown-page-after-login']) {
      const target = nextTarget(route, landing);
      expect(target === undefined || !AUTH_PATH.test(target)).toBe(true);
    }
    // 接缝三：签到页是终点，推进到它之后就执行 steps（不再乱跳）
    expect(nextTarget(route, '/profile')).toBeUndefined();
  });

  it('用户真实经过的页面逐页对应：顺序与录制一致，中间页一页都不丢', () => {
    const learned = buildLearnedWorkflow(authSite, [
      { type: 'navigation', path: '/sign-in', at: 1 },
      { type: 'navigation', path: '/dashboard/overview', at: 2 },
      { type: 'click', selector: '#to-console', label: '控制台', path: '/dashboard/overview', at: 3 },
      { type: 'navigation', path: '/console/checkin', at: 4 },
      { type: 'fill', selector: '#reason', label: '领取理由', path: '/console/checkin', hasValue: true, at: 5 },
      {
        type: 'click',
        selector: '#submit',
        label: '提交',
        path: '/console/checkin',
        evidence: { kind: 'success', words: ['领取成功'] },
        at: 6,
      },
    ]);

    const route = learned!.workflow.route!;
    expect(route).toEqual(['/dashboard/overview', '/console/checkin']);
    // 每一页都能按顺序推进过去（不跳页、不回退）
    expect(nextTarget(route, '/dashboard/overview')).toBe('/console/checkin');
    expect(nextTarget(route, '/console/checkin')).toBeUndefined();
    expect(validateCheckinWorkflow(authSite, learned!.workflow)).toEqual([]);
  });

  it('整遍只录到登录页时不保存，登录步骤不会交给签到回放器', () => {
    const learned = buildLearnedWorkflow(authSite, [
      { type: 'navigation', path: '/sign-in', at: 1 },
      { type: 'click', selector: '#claim', label: '签到', path: '/sign-in', at: 2 },
    ]);

    expect(learned).toBeNull();
  });
});
