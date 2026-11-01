import React, { act, createElement, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, AccountBalance, BalancePoint, DailyStatus, LastResult } from '@/types';
import type { LiveTask } from '@/lib/messages/live';

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
      span: element('span'),
    },
  };
});

import { AccountRow } from './AccountRow';

const account: Account = {
  id: 'account-1',
  siteId: 'site-1',
  username: 'user@example.com',
  password: 'secret',
};

const liveTask: LiveTask = {
  accountId: account.id,
  siteId: account.siteId,
  tabId: 17,
  runId: 'run-1',
  stage: 'checkin',
  method: 'button',
  steps: ['正在执行的时间线步骤'],
  startedAt: Date.now(),
};

const noop = vi.fn();
/** 新增可视化用例用的学习回调桩（各用例只关心渲染结果，不关心回调参数）。 */
const onLearn = vi.fn();

function props(
  status: DailyStatus,
  options: { liveTask?: LiveTask; result?: LastResult; balance?: AccountBalance } = {},
): ComponentProps<typeof AccountRow> {
  return {
    account,
    status,
    siteCheckinMethod: 'button',
    liveTask: options.liveTask,
    result: options.result,
    balance: options.balance,
    quotaPerUnit: 1,
    onRun: noop,
    onRemove: noop,
  };
}

function result(ok: boolean, message: string, steps: string[]): LastResult {
  return { accountId: account.id, ok, message, steps, at: Date.now() };
}

function point(day: number, hour: number, quota: number, source: BalancePoint['source']): BalancePoint {
  return { quota, usedQuota: 0, at: new Date(2026, 7, day, hour).getTime(), source };
}

function balanceWithHistory(): AccountBalance {
  const previousYear = { quota: 60, usedQuota: 0, at: new Date(2025, 11, 31, 18).getTime(), source: 'api' as const };
  const earlier = point(18, 18, 70, 'api');
  const beforeYesterday = point(19, 18, 80, 'api');
  const yesterday = point(20, 18, 90, 'visible');
  const todayFirst = point(21, 8, 100, 'api');
  const todayLatest = point(21, 9, 125, 'api');
  return {
    ...todayLatest,
    daily: {
      '2025-12-31': { first: previousYear, latest: previousYear },
      '2026-08-18': { first: earlier, latest: earlier },
      '2026-08-19': { first: beforeYesterday, latest: beforeYesterday },
      '2026-08-20': { first: yesterday, latest: yesterday },
      '2026-08-21': { first: todayFirst, latest: todayLatest, checkinReward: 20 },
    },
  };
}

describe('AccountRow 执行时间线自动收起', () => {
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
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  async function render(next: ComponentProps<typeof AccountRow>): Promise<void> {
    await act(async () => root.render(createElement(AccountRow, next)));
  }

  function learningButtons(): HTMLButtonElement[] {
    return [...container.querySelectorAll<HTMLButtonElement>('[data-account-actions] button')]
      .filter((button) => ['学习本站流程', '结束学习', '学习登录', '学习签到'].includes(button.textContent?.trim() ?? ''));
  }

  it('批量删除选择使用删除文案并回调账号 ID', async () => {
    const onToggleSelect = vi.fn();
    await render({
      ...props('pending'),
      selectionMode: true,
      onToggleSelect,
    });

    const toggle = container.querySelector<HTMLButtonElement>('button[title="选择账号"]');
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute('aria-label')).toContain('选择账号');
    expect(toggle?.getAttribute('aria-pressed')).toBe('false');

    await act(async () => toggle?.click());
    expect(onToggleSelect).toHaveBeenCalledWith(account.id);
  });

  it('批量删除选择会禁用不可选账号并展示原因', async () => {
    await render({
      ...props('done'),
      selectionMode: true,
      selectionDisabled: true,
      selectionDisabledReason: '删除站点后，该账号会保留到待恢复账号',
    });

    const toggle = container.querySelector<HTMLButtonElement>('button[title="删除站点后，该账号会保留到待恢复账号"]');
    expect(toggle?.disabled).toBe(true);
    expect(toggle?.getAttribute('aria-label')).toContain('删除站点后，该账号会保留到待恢复账号');
  });

  it('空闲时只显示一个「学习本站流程」主按钮，并以 both 开始学习', async () => {
    const onLearn = vi.fn();
    await render({ ...props('pending'), onLearn });

    const [start] = learningButtons();
    expect(learningButtons()).toHaveLength(1);
    expect(start?.textContent).toBe('学习本站流程');
    expect(start?.title).toContain('先手动登录');
    expect(start?.title).toContain('完成一次签到');
    expect(start?.title).toContain('不保存账号或密码内容');
    expect(start?.getAttribute('aria-label')).toBe(start?.title);
    const labels = learningButtons().map((button) => button.textContent?.trim());
    expect(labels).not.toContain('学习登录');
    expect(labels).not.toContain('学习签到');

    await act(async () => start?.click());
    expect(onLearn).toHaveBeenCalledWith(account.id, 'both');
  });

  it.each([
    { sessionKind: undefined, endKind: 'both' as const, savedLabel: '登录与签到' },
    { sessionKind: 'both' as const, endKind: 'both' as const, savedLabel: '登录与签到' },
    { sessionKind: 'login' as const, endKind: 'login' as const, savedLabel: '登录' },
    { sessionKind: 'checkin' as const, endKind: 'checkin' as const, savedLabel: '签到' },
  ])('学习中复用同一主按钮结束，结束时传当前会话 kind（kind=$sessionKind）', async ({ sessionKind, endKind, savedLabel }) => {
    const onLearn = vi.fn();
    await render({ ...props('pending'), onLearn, learning: { eventCount: 4, kind: sessionKind } });

    const [finish] = learningButtons();
    expect(learningButtons()).toHaveLength(1);
    expect(finish?.textContent).toBe('结束学习');
    expect(finish?.title).toBe(`结束学习并保存${savedLabel}流程`);
    const labels = learningButtons().map((button) => button.textContent?.trim());
    expect(labels).not.toContain('学习登录');
    expect(labels).not.toContain('学习签到');
    expect(container.textContent).toContain(`正在学习${savedLabel}`);
    expect(container.textContent).toContain('已记录 4 个动作');
    if (savedLabel === '登录') {
      // 旧 login 会话（升级前开始）只学登录，引导不包含签到两段。
      expect(container.textContent).toContain('本次请手动完成登录');
    } else {
      expect(container.textContent).toContain('先手动登录');
      expect(container.textContent).toContain('再进入签到页签到');
    }

    await act(async () => finish?.click());
    expect(onLearn).toHaveBeenCalledWith(account.id, endKind);
  });

  it('放弃学习仍是独立操作，不触发结束学习回调', async () => {
    const onLearn = vi.fn();
    const onCancelLearn = vi.fn();
    await render({ ...props('pending'), onLearn, onCancelLearn, learning: { eventCount: 1, kind: 'both' } });
    const [finish] = learningButtons();
    const cancel = container.querySelector<HTMLButtonElement>('button[title="放弃本次学习，不保存流程"]');

    expect(learningButtons()).toHaveLength(1);
    expect(finish?.textContent).toBe('结束学习');
    expect(cancel).not.toBeNull();
    await act(async () => cancel?.click());
    expect(onCancelLearn).toHaveBeenCalledWith(account.id);
    expect(onLearn).not.toHaveBeenCalled();
  });

  it('执行中的账号不显示「开始学习」入口', async () => {
    const onLearn = vi.fn();
    await render({ ...props('running', { liveTask }), onLearn });
    expect(learningButtons()).toHaveLength(0);
  });

  it('已完成的账号仍可从行内开始学习（流程变了可重学）', async () => {
    const onLearn = vi.fn();
    await render({ ...props('done', { result: result(true, '签到成功', []) }), onLearn });
    expect(learningButtons()).toHaveLength(1);
    expect(learningButtons()[0]?.textContent).toBe('学习本站流程');
  });

  it('批量删除选择使用删除选中态并暴露 aria-pressed', async () => {
    await render({
      ...props('pending'),
      selectionMode: true,
      selected: true,
    });

    const row = container.querySelector<HTMLElement>('[data-account-id="account-1"]');
    const toggle = container.querySelector<HTMLButtonElement>('button[title="取消选择账号"]');
    expect(row?.className).toContain('bg-rose-50');
    expect(toggle?.getAttribute('aria-pressed')).toBe('true');
  });

  it('任务成功后自动收起已经展开的时间线', async () => {
    await render(props('running', { liveTask }));
    expect(container.querySelector('ol')?.textContent).toContain('正在执行的时间线步骤');

    await render(props('done', { result: result(true, '签到成功', ['成功终态步骤']) }));

    expect(container.querySelector('ol')).toBeNull();
  });

  it('统一学习引导先资料页核验再签到页，产物说明本站共用且只录选择器', async () => {
    const onLearn = vi.fn();
    await render({ ...props('pending'), onLearn });
    const [start] = learningButtons();
    expect(start).toBeDefined();
    expect(start?.title).toContain('先手动登录');
    expect(start?.title).toContain('完成一次签到');
    await act(async () => start!.click());
    expect(onLearn).toHaveBeenCalledWith(account.id, 'both');

    await render({ ...props('pending'), onLearn, learning: { eventCount: 3, kind: 'both' } });
    const [finish] = learningButtons();
    expect(finish).toBeDefined();
    expect(learningButtons()).toHaveLength(1);
    expect(container.textContent).toContain('先经过资料页核验身份');
    expect(container.textContent).toContain('只保存可安全回放的选择器（本站账号共用）');
    expect(container.textContent).toContain('已记录 3 个动作');
    const guide = container.textContent ?? '';
    expect(guide.indexOf('先经过资料页核验身份')).toBeGreaterThan(-1);
    expect(guide.indexOf('先经过资料页核验身份')).toBeLessThan(guide.indexOf('再进入签到页签到'));
    await act(async () => finish!.click());
    expect(onLearn).toHaveBeenCalledTimes(2);

  });

  it('录制中把已录到的动作逐条显示（能看见滚到哪、点了哪）', async () => {
    await render({
      ...props('pending'),
      onLearn,
      learning: {
        eventCount: 3,
        kind: 'both',
        preview: [
          { kind: 'navigation', text: '进入页面 /console', path: '/console', at: 1 },
          { kind: 'scroll', text: '滚动页面到 60%', path: '/checkin', at: 2 },
          { kind: 'click', text: '点击「立即签到」（落点 90%, 50%）', path: '/checkin', at: 3 },
        ],
      },
    });

    const live = container.querySelector('[data-learning-steps="learning-live-steps"]');
    expect(live).not.toBeNull();
    expect(live?.textContent).toContain('正在记录的动作');
    expect(live?.textContent).toContain('进入页面 /console');
    expect(live?.textContent).toContain('滚动页面到 60%');
    expect(live?.textContent).toContain('点击「立即签到」');
  });

  it('没有预览时安静降级：不出现空的「已学会的动作」区块', async () => {
    await render({ ...props('pending'), onLearn, learning: { eventCount: 0, kind: 'both' } });

    expect(container.querySelector('[data-learning-steps]')).toBeNull();
    expect(container.textContent).not.toContain('正在记录的动作');
  });

  it('超长流程只显示最近几条，并如实提示「还有 M 个动作」', async () => {
    const preview = Array.from({ length: 12 }, (_, index) => ({
      kind: 'click' as const,
      text: `动作 ${index + 1}`,
      path: '/checkin',
      at: index,
    }));
    await render({ ...props('pending'), onLearn, learning: { eventCount: 12, kind: 'both', preview } });

    const live = container.querySelector('[data-learning-steps="learning-live-steps"]');
    expect(live?.querySelectorAll('li')).toHaveLength(6); // 5 条 + 1 行「还有」
    expect(live?.textContent).toContain('动作 12');
    expect(live?.textContent).not.toContain('动作 7');
    expect(live?.textContent).toContain('还有 7 个动作');
  });

  it('学习结束后仍能看到这次学到了哪些动作（会话已清空）', async () => {
    await render({
      ...props('done'),
      onLearn,
      learnedSteps: [
        { kind: 'scroll', text: '滚动页面到 100%', path: '/checkin', at: 1 },
        { kind: 'click', text: '点击「签到卡片」里的按钮', path: '/checkin', at: 2 },
      ],
    });

    const last = container.querySelector('[data-learning-steps="learning-last-steps"]');
    expect(last).not.toBeNull();
    expect(last?.textContent).toContain('这次学到的动作');
    expect(last?.textContent).toContain('滚动页面到 100%');
    expect(last?.textContent).toContain('点击「签到卡片」里的按钮');
    // 会话清空后不应再出现「正在记录的动作」
    expect(container.querySelector('[data-learning-steps="learning-live-steps"]')).toBeNull();
  });

  it('结束后回看与完整性自检同时显示（学到什么 + 缺什么）', async () => {
    await render({
      ...props('done'),
      learnedSteps: [{ kind: 'click', text: '点击「立即签到」', path: '/checkin', at: 1 }],
      learningNotice: { verdict: 'partial', lines: [{ status: 'warn', text: '没有录到登录之后的签到动作' }] },
    });

    expect(container.querySelector('[data-learning-steps="learning-last-steps"]')?.textContent).toContain('点击「立即签到」');
    expect(container.querySelector('[data-learning-notice="partial"]')?.textContent).toContain('没有录到登录之后的签到动作');
  });

  it('隐私红线：渲染出的 DOM 里没有输入值、原始坐标与选择器原文', async () => {
    const preview = [
      { kind: 'fill' as const, text: '在「账号」填写内容', path: '/login', at: 1 },
      { kind: 'click' as const, text: '点击「登录」', path: '/login', at: 2 },
    ];
    await render({ ...props('pending'), onLearn, learning: { eventCount: 2, kind: 'login', preview } });
    const live = container.querySelector('[data-learning-steps="learning-live-steps"]')?.outerHTML ?? '';
    expect(live).toContain('在「账号」填写内容');
    expect(live).not.toContain('/login');

    // 即使调用方把敏感字段硬塞进 preview 条目，账号行也只渲染 text。
    const polluted = [{
      kind: 'fill' as const,
      text: '在「账号」填写内容',
      path: '/login',
      at: 3,
      password: 'sentinel-secret-value',
      value: 'sentinel-secret-value',
      selector: '#private-selector',
      clientX: 321,
      clientY: 654,
    }];
    await render({ ...props('pending'), onLearn, learning: { eventCount: 1, kind: 'login', preview: polluted } });
    const html = container.innerHTML;
    expect(html).not.toContain('sentinel-secret-value');
    expect(html).not.toContain('#private-selector');
    expect(html).not.toContain('clientX');
    expect(html).not.toContain('clientY');
    expect(html).not.toContain('321');
    expect(html).not.toContain('654');

    await render({ ...props('done'), learnedSteps: polluted });
    const lastHtml = container.querySelector('[data-learning-steps="learning-last-steps"]')?.outerHTML ?? '';
    expect(lastHtml).toContain('在「账号」填写内容');
    expect(lastHtml).not.toContain('sentinel-secret-value');
    expect(lastHtml).not.toContain('#private-selector');
    expect(lastHtml).not.toContain('clientX');
    expect(lastHtml).not.toContain('clientY');
  });

  it('新增的图标不参与可访问名称（既有 aria 断言不受影响）', async () => {
    await render({
      ...props('pending'),
      onLearn,
      learning: {
        eventCount: 2,
        kind: 'both',
        preview: [
          { kind: 'scroll', text: '滚动页面到 60%', path: '/checkin', at: 1 },
          { kind: 'click', text: '点击「立即签到」', path: '/checkin', at: 2 },
        ],
      },
    });

    const live = container.querySelector('[data-learning-steps="learning-live-steps"]');
    // 图标全部 aria-hidden，行内文本仍是纯 text，不掺「滚动」「点击」之外的名称噪音
    expect(live?.querySelectorAll('svg[aria-hidden="true"]').length).toBe(2);
    const actionNames = [...container.querySelectorAll<HTMLButtonElement>('button[aria-label]')].map((b) => b.getAttribute('aria-label'));
    expect(actionNames).toContain('结束学习并保存登录与签到流程');
  });

  it('任务失败后保留已经展开的诊断时间线', async () => {
    await render(props('running', { liveTask }));

    await render(props('failed', { result: result(false, '签到失败', ['失败诊断步骤']) }));

    expect(container.querySelector('ol')?.textContent).toContain('失败诊断步骤');
  });

  it('失败时显示结构化诊断：结论标题 + 下一步（不是一句笼统的失败）', async () => {
    // 诊断长在展开的详情区里；先跑一次让详情自动展开（与真实使用一致：
    // 运行时展开，失败后被保留下来），再落失败结果。
    await render(props('running', { liveTask }));
    await render(props('failed', {
      result: result(false, '本机 127.0.0.1:7897 上没有程序在监听 —— 内核（Clash Verge / mihomo 等）没启动', []),
    }));

    const hint = container.querySelector('[data-diagnosis-code]');
    expect(hint?.getAttribute('data-diagnosis-code')).toBe('proxy-unreachable');
    expect(container.querySelector('[data-diagnosis-title]')?.textContent)
      .toBe('本机代理端口没有程序在监听');

    const actions = container.querySelector('[data-diagnosis-actions]')?.textContent ?? '';
    expect(actions).toContain('Clash Verge');
    expect(actions).toContain('端口');
  });

  it('原始失败说明与诊断标题同时存在（诊断不吞掉站点原话）', async () => {
    const message = '工作流点击选择器命中了错误的元素: #claim（text 期望 "立即签到" 实际 "签到记录"）';
    await render(props('running', { liveTask }));
    await render(props('failed', { result: result(false, message, []) }));

    expect(container.textContent).toContain(message);
    expect(container.querySelector('[data-diagnosis-code]')?.getAttribute('data-diagnosis-code'))
      .toBe('element-mismatch');
    expect(container.textContent).toContain('命中了错误的元素');
  });

  it('需要人工处理时继续展开当前任务时间线', async () => {
    await render(props('running', { liveTask }));

    await render(props('attention', {
      liveTask: { ...liveTask, steps: ['等待人工完成验证'] },
    }));

    expect(container.querySelector('ol')?.textContent).toContain('等待人工完成验证');
  });

  it('没有执行结果时仍可展开余额历史', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 21, 12));
    await render(props('pending', { balance: balanceWithHistory() }));

    expect(container.querySelector('[aria-label="余额历史"]')).toBeNull();
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="查看账号详情"]');
    expect(toggle).not.toBeNull();
    await act(async () => toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(container.querySelector('[aria-label="余额历史"]')).not.toBeNull();
  });

  it('账号余额、历史和结果回退都保留人民币符号', async () => {
    const yuanBalance = balanceWithHistory();
    yuanBalance.symbol = '¥';
    if (yuanBalance.daily?.['2026-08-21']?.latest) {
      yuanBalance.daily['2026-08-21'].latest.symbol = '¥';
    }
    await render(props('done', { balance: yuanBalance }));
    expect(container.textContent).toContain('余额 ¥125.00');

    await render(props('done', {
      result: {
        ...result(true, '签到成功', []),
        metrics: { verdict: 'rewarded', reward: 10.31, quotaAfter: 319.63, balanceSymbol: '¥' },
      },
    }));
    expect(container.textContent).toContain('余额 ¥319.63');
    expect(container.textContent).toContain('+¥10.31');
  });

  it('积分余额与签到差值不显示成美元', async () => {
    await render(props('done', {
      balance: { quota: 1_476, usedQuota: 0, at: Date.now(), symbol: '积分', source: 'visible' },
      result: {
        ...result(true, '签到成功', []),
        metrics: { verdict: 'rewarded', reward: 42, quotaAfter: 1_476, balanceSymbol: '积分' },
      },
    }));

    expect(container.textContent).toContain('余额 积分 1476');
    expect(container.textContent).toContain('+42 积分');
    expect(container.textContent).not.toContain('$1476');
  });

  it('余额历史显示相对日期、来源、差额和明确奖励', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 21, 12));
    await render(props('pending', { balance: balanceWithHistory() }));
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="查看账号详情"]');
    await act(async () => toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    const today = container.querySelector<HTMLElement>('[data-balance-day="2026-08-21"]');
    const yesterday = container.querySelector<HTMLElement>('[data-balance-day="2026-08-20"]');
    const beforeYesterday = container.querySelector<HTMLElement>('[data-balance-day="2026-08-19"]');
    const earlier = container.querySelector<HTMLElement>('[data-balance-day="2026-08-18"]');
    const previousYear = container.querySelector<HTMLElement>('[data-balance-day="2025-12-31"]');
    expect(today?.textContent).toContain('今天');
    expect(today?.textContent).toContain('8月21日');
    expect(today?.textContent).toContain('$125.00');
    expect(today?.textContent).toContain('API');
    expect(today?.textContent).toContain('当天 +$25.00');
    expect(today?.textContent).toContain('奖励 +$20.00');
    expect(yesterday?.textContent).toContain('昨天');
    expect(yesterday?.textContent).toContain('页面');
    expect(yesterday?.textContent).toContain('较前天 +$10.00');
    expect(beforeYesterday?.textContent).toContain('前天');
    expect(earlier?.textContent).toContain('8月18日');
    expect(previousYear?.textContent).toContain('2025年12月31日');
  });
});


