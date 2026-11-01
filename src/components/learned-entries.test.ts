import React, { act, createElement, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, CheckinMethod, DailyStatus, LearningKind, SiteConfig } from '@/types';

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
 * 学习入口的端到端渲染测试（真实 SiteCard + 真实 AccountRow）。
 *
 * 与 account-row-collapse.test.ts 只渲染 AccountRow 不同，这里整体渲染站点卡片，
 * 证明统一后的入口确实长在每一行账号上（而不是只在某个单行组件里成立）：
 *  - 每一行只有一个「学习本站流程」融合入口（kind='both'，一次演示同时学会登录与签到）；
 *  - 旧的「学习登录」「学习签到」两个入口已从界面移除，只保留后台兼容；
 *  - 录制中同一按钮变成「结束学习」，另一账号的入口不受影响。
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
  { id: 'account-2', siteId: site.id, username: 'second@example.com', password: 'secret' },
];

const noop = vi.fn();

function props(
  statuses: Readonly<Record<string, DailyStatus>>,
  options: {
    checkinMethod?: CheckinMethod;
    learningAccounts?: ReadonlyMap<string, { eventCount: number; kind?: LearningKind }>;
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

describe('学习入口与引导', () => {
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

  function learnButtons() {
    return [...container.querySelectorAll<HTMLButtonElement>('button')]
      .filter((button) => ['学习本站流程', '结束学习', '学习登录', '学习签到'].includes(button.textContent?.trim() ?? ''));
  }

  async function expandAccounts(): Promise<void> {
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-expanded]');
    if (!toggle) throw new Error('找不到账号展开开关');
    await act(async () => toggle.click());
  }

  it.each<CheckinMethod>(['auto', 'button', 'api', 'claim', 'none', 'relogin'])(
    '每个账号行只有一个「学习本站流程」入口，旧的两个入口不再出现（%s 签到方式同样如此）',
    async (method) => {
      await render(props({ 'account-1': 'pending', 'account-2': 'failed' }, { checkinMethod: method }));
      await expandAccounts();

      const buttons = learnButtons();
      expect(buttons.filter((button) => button.textContent === '学习本站流程')).toHaveLength(2);
      expect(buttons.filter((button) => button.textContent === '学习登录')).toHaveLength(0);
      expect(buttons.filter((button) => button.textContent === '学习签到')).toHaveLength(0);
    },
  );

  it('点击各行的学习入口会带上账号 ID，并以 both 开始融合学习', async () => {
    const onLearnAccount = vi.fn();
    await render({ ...props({ 'account-1': 'pending', 'account-2': 'pending' }), onLearnAccount });
    await expandAccounts();

    const row1 = container.querySelector<HTMLElement>('[data-account-id="account-1"]');
    const row2 = container.querySelector<HTMLElement>('[data-account-id="account-2"]');
    expect(row1).not.toBeNull();
    expect(row2).not.toBeNull();

    const row1Start = [...row1!.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '学习本站流程');
    const row2Start = [...row2!.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '学习本站流程');

    await act(async () => row1Start!.click());
    expect(onLearnAccount).toHaveBeenLastCalledWith('account-1', 'both');
    await act(async () => row2Start!.click());
    expect(onLearnAccount).toHaveBeenLastCalledWith('account-2', 'both');
  });

  it('一个账号在录学习时只显示结束/放弃，另一个账号仍有唯一入口', async () => {
    await render(props(
      { 'account-1': 'pending', 'account-2': 'pending' },
      { learningAccounts: new Map([['account-1', { eventCount: 3, kind: 'both' }]]) },
    ));
    await expandAccounts();

    const row1 = container.querySelector<HTMLElement>('[data-account-id="account-1"]');
    const row2 = container.querySelector<HTMLElement>('[data-account-id="account-2"]');
    expect([...row1!.querySelectorAll<HTMLButtonElement>('button')].some((button) => button.textContent === '学习本站流程')).toBe(false);
    expect([...row1!.querySelectorAll<HTMLButtonElement>('button')].some((button) => button.textContent === '结束学习')).toBe(true);
    expect([...row1!.querySelectorAll<HTMLButtonElement>('button')].some((button) => button.title === '放弃本次学习，不保存流程')).toBe(true);
    expect([...row2!.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent === '学习本站流程')).toHaveLength(1);
    expect([...row2!.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent === '学习登录')).toHaveLength(0);
    expect([...row2!.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent === '学习签到')).toHaveLength(0);
  });

  it('融合学习的引导覆盖两段：先手动登录，再在签到页签到，最后结束学习', async () => {
    await render(props(
      { 'account-1': 'pending', 'account-2': 'pending' },
      { learningAccounts: new Map([['account-1', { eventCount: 2, kind: 'both' }]]) },
    ));
    await expandAccounts();

    const text = container.textContent ?? '';
    expect(text).toContain('正在学习登录与签到');
    expect(text).toContain('先手动登录');
    expect(text).toContain('签到按钮就在个人资料页上时，直接在该页签到');
    expect(text).toContain('先经过资料页核验身份');
    expect(text).toContain('再进入签到页签到');
    expect(text.indexOf('先经过资料页核验身份')).toBeLessThan(text.indexOf('再进入签到页签到'));
    expect(text).toContain('不保存账号或密码内容');
  });

  it('已保存流程的站点卡片说明先核验账号再执行签到', async () => {
    await render({
      ...props({ 'account-1': 'pending' }),
      site: { ...site, checkin: { method: 'workflow', workflow: { steps: [], route: ['/profile', '/checkin'] } } },
    });

    const text = container.textContent ?? '';
    expect(text).toContain('核对当前账号');
    expect(text).toContain('执行已保存签到流程');
    expect(text.indexOf('核对当前账号')).toBeLessThan(text.indexOf('执行已保存签到流程'));
  });
});
