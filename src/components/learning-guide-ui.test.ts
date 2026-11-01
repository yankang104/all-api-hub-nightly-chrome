import React, { act, createElement, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, CheckinMethod, DailyStatus, LearningKind, SiteConfig } from '@/types';
import type { WorkflowLearningEvent } from '@/types';
import { buildLearningReport } from '@/automation/learning/learning-report';
import { analyzeLearningEvents, guideViewOf } from '@/automation/learning/learning-stage';
import { learningNoticeFromResponse, learningNoticeSummary, learningSavedToastText } from '@/lib/learning/learning-notice';

vi.mock('motion/react', async () => {
  const ReactModule = await vi.importActual<typeof import('react')>('react');
  const element = (tag: string) => ({
    children,
    layout: _layout,
    initial: _initial,
    animate: _animate,
    exit: _exit,
    transition: _transition,
    whileTap: _whileTap,
    ...props
  }: Record<string, unknown>) => ReactModule.createElement(tag, props, children as ReactNode);

  return {
    AnimatePresence: ({ children }: { children?: ReactNode }) => ReactModule.createElement(ReactModule.Fragment, null, children),
    motion: {
      button: element('button'),
      div: element('div'),
      section: element('section'),
      span: element('span'),
    },
  };
});

import { SiteCard } from './SiteCard';

/**
 * 学习引导的界面呈现（真实 SiteCard + 真实 AccountRow）：
 * 1) 「开始学习」旁边的一句话说明：讲清要演示哪三步、不能做什么；
 * 2) 「结束学习」之后的完整性自检：逐行留在账号行上，句式和纯函数产出一致。
 *
 * 这里渲染的是真实组件树 + 真实报告函数，取出的文本就是用户会看到的文本。
 */

const site: SiteConfig = {
  id: 'site-1',
  name: '学习验收站',
  loginUrl: 'https://example.com/login',
  loginMethod: 'form',
  selectors: { username: '#username', password: '#password', submit: 'button[type="submit"]' },
  closeModalSelectors: [],
  checkin: { method: 'auto' },
};

const accounts: Account[] = [
  { id: 'account-1', siteId: site.id, username: 'first@example.com', password: 'secret' },
];

const profileEvents = [
  { type: 'navigation', path: '/login', at: 1 },
  { type: 'navigation', path: '/console', at: 2 },
  { type: 'fill', selector: '#username', label: '用户名', path: '/login', hasValue: true, at: 3 },
  { type: 'click', selector: 'button[type="submit"]', label: '登录', path: '/login', loginAction: 'submit', at: 4 },
] satisfies WorkflowLearningEvent[];
const profileAnalysis = analyzeLearningEvents(profileEvents, 'both');
const guide = guideViewOf(profileAnalysis);
const loginGuide = guideViewOf(analyzeLearningEvents([{ type: 'navigation', path: '/login', at: 1 }], 'both'));
const LOGIN_AS_CHECKIN_HINT = '若本站是「登录即签到」（登录成功后自动完成、页面上没有签到按钮），回扩展里点「登录即签到」即可保存完整流程';

const noop = vi.fn();

function props(
  statuses: Readonly<Record<string, DailyStatus>>,
  options: {
    checkinMethod?: CheckinMethod;
    learningAccounts?: ComponentProps<typeof SiteCard>['learningAccounts'];
    learningNotices?: ComponentProps<typeof SiteCard>['learningNotices'];
  } = {},
): ComponentProps<typeof SiteCard> {
  return {
    site: { ...site, ...(options.checkinMethod ? { checkin: { method: options.checkinMethod } } : {}) },
    accounts,
    proxies: [],
    proxyUsage: new Map(),
    statusOf: (accountId) => statuses[accountId] ?? 'pending',
    resultOf: () => undefined,
    liveOf: () => undefined,
    balanceOf: () => undefined,
    isQueued: () => false,
    onRun: noop,
    onRunAll: noop,
    onStopAll: noop,
    onResetAccount: noop,
    onStopAccount: noop,
    onRetryAccount: noop,
    onMarkAccountDone: noop,
    onCaptureSession: noop,
    onLearnAccount: noop,
    learningAccounts: options.learningAccounts,
    learningNotices: options.learningNotices,
    onCancelLearnAccount: noop,
    onEditAccount: noop,
    onSetAccountProxy: vi.fn().mockResolvedValue(undefined),
    onRemoveAccount: noop,
    onAddAccount: noop,
    onEditSite: noop,
    onRemoveSite: noop,
    selectionMode: false,
    siteSelected: false,
    selectedAccountIds: new Set(),
    onToggleSite: noop,
    onToggleAccount: noop,
  };
}

describe('学习引导的界面呈现', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render(next: ComponentProps<typeof SiteCard>): Promise<void> {
    await act(async () => root.render(createElement(SiteCard, next)));
  }

  async function expandAccounts(): Promise<void> {
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-expanded]');
    if (!toggle) throw new Error('找不到账号展开开关');
    await act(async () => toggle.click());
  }

  it('未开始学习时，账号行上有一句话说明（先手动登录 → 完成一次签到 → 点结束，不要点退出登录）', async () => {
    await render(props({ 'account-1': 'pending' }));
    await expandAccounts();

    const text = container.textContent ?? '';
    expect(text).toContain('先手动登录，再完成一次签到，最后点「结束学习」；若本站登录成功后即算签到、没有签到按钮，登录后改点「登录即签到」。全程不要点「退出登录」。');
  });

  it('正在学习时不重复显示一句话说明（由详细引导接管）', async () => {
    await render(props(
      { 'account-1': 'pending' },
      { learningAccounts: new Map([['account-1', { eventCount: 2, kind: 'checkin' }]]) },
    ));
    await expandAccounts();

    const text = container.textContent ?? '';
    expect(text).toContain('正在学习签到，已记录 2 个动作');
    expect(text).not.toContain('全程不要点「退出登录」');
  });

  it('渲染后台引导步骤条的完成、当前、待做状态和固定提示文案', async () => {
    await render(props(
      { 'account-1': 'pending' },
      { learningAccounts: new Map([['account-1', { eventCount: 4, kind: 'both', guide }]]) },
    ));
    await expandAccounts();

    expect(guide.steps.map((step) => step.state)).toEqual(['done', 'current', 'todo', 'todo']);
    expect(guide.hint).toBe(`先经过能显示当前账号的页面（如「个人资料 / 我的账户」），再进签到页；${LOGIN_AS_CHECKIN_HINT}`);

    const panel = container.querySelector<HTMLElement>('[data-learning-panel]');
    const stepsBar = panel?.querySelector<HTMLElement>('[data-learning-steps-bar]');
    expect(stepsBar?.getAttribute('data-learning-steps-bar')).toBe(String(guide.step));

    const steps = [...(stepsBar?.querySelectorAll<HTMLElement>('[data-learning-step]') ?? [])];
    expect(steps.map((step) => step.getAttribute('data-learning-step'))).toEqual(['done', 'current', 'todo', 'todo']);
    expect(steps.map((step) => (step.textContent ?? '').replace(/^\d+/, '').trim())).toEqual(['登录', '账号页', '签到', '结束']);

    const renderedHint = [...(panel?.querySelectorAll('p') ?? [])]
      .find((paragraph) => paragraph.textContent === guide.hint);
    expect(renderedHint?.textContent).toBe(guide.hint);
  });

  it('后台判定可用时显示登录即签到入口，提示追加固定文案，点击带显式选项结束学习', async () => {
    expect(profileAnalysis.loginAsCheckinAvailable).toBe(true);
    const onLearnAccount = vi.fn();
    await render({
      ...props({ 'account-1': 'pending' }, {
        learningAccounts: new Map([['account-1', {
          eventCount: 4,
          kind: 'both',
          guide,
          loginAsCheckinAvailable: true,
        }]]),
      }),
      onLearnAccount,
    });
    await expandAccounts();

    const panel = container.querySelector<HTMLElement>('[data-learning-panel]');
    expect(panel?.textContent ?? '').toContain(LOGIN_AS_CHECKIN_HINT);
    expect(guide.hint.endsWith(LOGIN_AS_CHECKIN_HINT)).toBe(true);

    const button = container.querySelector<HTMLButtonElement>('[data-learning-login-as-checkin]');
    expect(button?.textContent?.trim()).toBe('登录即签到（没有签到按钮）');
    await act(async () => button?.click());

    expect(onLearnAccount).toHaveBeenCalledOnce();
    expect(onLearnAccount).toHaveBeenCalledWith('account-1', 'both', { loginAsCheckin: true });
  });

  it.each([false, undefined])('后台没有判定登录即签到出口可用（%s）时不显示入口', async (available) => {
    await render(props({ 'account-1': 'pending' }, {
      learningAccounts: new Map([['account-1', {
        eventCount: 1,
        kind: 'both',
        guide: loginGuide,
        loginAsCheckinAvailable: available,
      }]]),
    }));
    await expandAccounts();

    expect(loginGuide.steps.map((step) => step.state)).toEqual(['current', 'todo', 'todo', 'todo']);
    expect(loginGuide.hint).not.toContain(LOGIN_AS_CHECKIN_HINT);

    const row = container.querySelector<HTMLElement>('[data-account-id="account-1"]');
    const loginAsCheckinButtons = [...(row?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
      .filter((button) => button.hasAttribute('data-learning-login-as-checkin')
        || (button.getAttribute('aria-label') ?? '').includes('登录即签到'));
    expect(loginAsCheckinButtons).toHaveLength(0);
  });

  it('结束学习后：账号行渲染完整性自检（渲染后的真实文本）', async () => {
    const events = [
      { type: 'navigation', path: '/login', at: 1 },
      { type: 'fill', selector: '#username', label: '用户名', path: '/login', hasValue: true, at: 2 },
      { type: 'navigation', path: '/console', at: 3 },
      { type: 'navigation', path: '/profile', at: 4 },
      { type: 'navigation', path: '/checkin', at: 5 },
      { type: 'click', selector: 'text=签到', label: '签到', path: '/checkin', at: 6, evidence: { kind: 'success', words: ['签到成功'] } },
    ] satisfies WorkflowLearningEvent[];
    const report = buildLearningReport(events, 'checkin');
    const notice = learningNoticeFromResponse({ report: { verdict: report.verdict, lines: report.lines } });
    expect(notice).not.toBeNull();

    await render(props({ 'account-1': 'pending' }, { learningNotices: new Map([['account-1', notice!]]) }));
    await expandAccounts();

    const rendered = container.querySelector('[data-learning-notice]');
    expect(rendered?.getAttribute('data-learning-notice')).toBe('complete');
    const renderedText = (rendered?.textContent ?? '').replace(/\s+/g, ' ').trim();
    // 逐行拼出来的真实文本（组件测试取出的证据）
    expect(renderedText).toContain('完整性自检：已录全');
    expect(renderedText).toContain('✅ 登录配置已学会（表单：在登录页录到了账号/密码输入，并成功进入站内页面）');
    expect(renderedText).toContain('✅ 签到流程已学会（经过 4 个页面、');
    expect(renderedText).toContain('✅ 已录到「签到成功」证据（词：签到成功）');
    expect(learningNoticeSummary(notice)).toBe('完整性自检：已录全：✅ 登录配置已学会（表单：在登录页录到了账号/密码输入，并成功进入站内页面）');
  });

  it('缺签到成功证据时，行上如实提示「可能是当天已签到，或没点到真正的按钮」', async () => {
    const report = buildLearningReport([
      { type: 'navigation', path: '/login', at: 1 },
      { type: 'navigation', path: '/console', at: 2 },
      { type: 'navigation', path: '/profile', at: 3 },
      { type: 'navigation', path: '/checkin', at: 4 },
      { type: 'click', selector: 'text=签到', label: '签到', path: '/checkin', at: 5 },
    ], 'checkin');
    expect(report.verdict).toBe('partial');

    await render(props({ 'account-1': 'pending' }, {
      learningNotices: new Map([['account-1', { verdict: 'partial', lines: report.lines }]]),
    }));
    await expandAccounts();

    const rendered = container.querySelector('[data-learning-notice]');
    expect(rendered?.getAttribute('data-learning-notice')).toBe('partial');
    expect(rendered?.textContent ?? '').toContain('⚠️ 没有录到「签到成功」证据 —— 可能是当天已签到，或你没点到真正的签到按钮');
  });

  it('后台只回了 warnings（还没有 report）时，也照原样呈现在账号行上', async () => {
    const notice = learningNoticeFromResponse({ warnings: ['学习过程中出现了验证码/二次验证（OTP）字段，回放时需要你人工完成'] });
    await render(props({ 'account-1': 'pending' }, { learningNotices: new Map([['account-1', notice!]]) }));
    await expandAccounts();

    const rendered = container.querySelector('[data-learning-notice]');
    expect(rendered?.getAttribute('data-learning-notice')).toBe('partial');
    expect(rendered?.textContent ?? '').toContain('完整性自检：可用，但有需要注意的地方');
    expect(rendered?.textContent ?? '').toContain('学习过程中出现了验证码/二次验证（OTP）字段，回放时需要你人工完成');
  });

  it('"登录即签到"保存成功时：report.verdict=complete 与账号行同结论，toast 不说「没录全」', () => {
    const report = {
      verdict: 'complete' as const,
      lines: [{ status: 'ok' as const, text: '✅ 已按「登录即签到」学会：本站登录成功后即算签到，不需要点签到按钮' }],
    };
    const notice = learningNoticeFromResponse({
      report: { verdict: report.verdict, lines: report.lines },
    });
    expect(notice?.verdict).toBe('complete');
    expect(notice?.lines[0]?.text).toBe('✅ 已按「登录即签到」学会：本站登录成功后即算签到，不需要点签到按钮');

    const toast = learningSavedToastText({
      intent: 'both',
      kind: 'checkin',
      savedKinds: ['checkin'],
      checkinSavedAs: 'login-as-checkin',
      eventCount: 6,
      report,
    });
    expect(toast).toContain('已保存本站「登录即签到」流程');
    expect(toast).not.toContain('没录全');
  });

  it('report.verdict=incomplete 时：toast 必须说没录全，不得因 savedKinds 非空而谎报成功', () => {
    const report = {
      verdict: 'incomplete' as const,
      lines: [{ status: 'missing' as const, text: '❌ 没有录到签到动作（没有点到签到/领取按钮）' }],
    };
    const notice = learningNoticeFromResponse({
      report: { verdict: report.verdict, lines: report.lines },
    });
    expect(notice?.verdict).toBe('incomplete');

    const toast = learningSavedToastText({
      intent: 'both',
      kind: 'login',
      savedKinds: ['login'],
      eventCount: 4,
      warnings: ['没有录到登录之后的签到动作，这次只保存登录配置；请在按钮可点时重新演示一次签到'],
      report,
    });
    expect(toast).toContain('没录全');
    expect(toast).not.toContain('已保存本站登录与签到流程');
  });

  it('既没有 report 也没有 warnings 时不编造结论', () => {
    expect(learningNoticeFromResponse(undefined)).toBeNull();
    expect(learningNoticeFromResponse({})).toBeNull();
    expect(learningNoticeFromResponse({ warnings: [] })).toBeNull();
    expect(learningNoticeSummary(null)).toBeNull();
  });
});
