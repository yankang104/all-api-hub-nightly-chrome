import React, { act, createElement, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, DailyStatus, SiteConfig } from '@/types';

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
      div: element('div'),
      section: element('section'),
      span: element('span'),
    },
  };
});

vi.mock('./AccountRow', async () => {
  const ReactModule = await vi.importActual<typeof import('react')>('react');
  return {
    AccountRow: ({ account, selectionMode, selectionDisabled, selectionDisabledReason }: { account: Account; selectionMode?: boolean; selectionDisabled?: boolean; selectionDisabledReason?: string }) => ReactModule.createElement(
      'div',
      {
        'data-account-id': account.id,
        'data-selection-mode': selectionMode ? 'true' : 'false',
        'data-selection-disabled': selectionDisabled ? 'true' : 'false',
        'data-selection-disabled-reason': selectionDisabledReason,
      },
      account.username,
    ),
  };
});

import { SiteCard } from './SiteCard';

const site: SiteConfig = {
  id: 'site-1',
  name: '测试站',
  loginUrl: 'https://example.com/login',
  loginMethod: 'form',
  selectors: { username: '#username', password: '#password', submit: 'button[type="submit"]' },
  closeModalSelectors: [],
  checkin: { method: 'button', url: '/profile', buttonSelector: 'button >> text=立即签到' },
};

const accounts: Account[] = [
  { id: 'account-1', siteId: site.id, username: 'first@example.com', password: 'secret' },
  { id: 'account-2', siteId: site.id, username: 'second@example.com', password: 'secret' },
];

const noop = vi.fn();

function props(
  statuses: Readonly<Record<string, DailyStatus>>,
  options: { queuedIds?: ReadonlySet<string>; learningIds?: ReadonlySet<string> } = {},
): ComponentProps<typeof SiteCard> {
  return {
    site,
    accounts,
    proxies: [],
    proxyUsage: new Map(),
    statusOf: (accountId) => statuses[accountId] ?? 'pending',
    resultOf: () => undefined,
    liveOf: () => undefined,
    balanceOf: () => undefined,
    isQueued: (accountId) => options.queuedIds?.has(accountId) ?? false,
    onRun: noop,
    onRunAll: noop,
    onStopAll: noop,
    onResetAccount: noop,
    onStopAccount: noop,
    onRetryAccount: noop,
    onMarkAccountDone: noop,
    onCaptureSession: noop,
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
    learningAccounts: options.learningIds ? new Map([...options.learningIds].map((id) => [id, 1])) : undefined,
  };
}

describe('SiteCard 账号列表自动收起', () => {
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

  async function render(statuses: Readonly<Record<string, DailyStatus>>): Promise<void> {
    await act(async () => root.render(createElement(SiteCard, props(statuses))));
  }

  it('站点卡片收起时显示失败诊断的标题与第一步（不用展开账号就能看到怎么做）', async () => {
    await act(async () => root.render(createElement(SiteCard, {
      ...props({ 'account-1': 'failed' }),
      resultOf: (accountId) => (accountId === 'account-1'
        ? {
            accountId,
            ok: false,
            message: '本机 127.0.0.1:7897 上没有程序在监听 —— 内核（Clash Verge / mihomo 等）没启动',
            steps: [],
            at: Date.now(),
          }
        : undefined),
    })));

    const hint = container.querySelector('[data-site-diagnosis]');
    expect(hint?.getAttribute('data-site-diagnosis')).toBe('proxy-unreachable');
    expect(hint?.textContent).toContain('本机代理端口没有程序在监听');
    // 光给标题还不够：卡片上必须能看到「第一步做什么」。
    expect(hint?.textContent).toContain('下一步');
    expect(hint?.textContent).toContain('Clash Verge');
  });

  function accountToggle(): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>('button[aria-expanded]');
    if (!button) throw new Error('找不到账号展开开关');
    return button;
  }

  async function expandAccounts(): Promise<void> {
    await act(async () => accountToggle().click());
    expect(accountToggle().getAttribute('aria-expanded')).toBe('true');
  }

  it('批量删除选择模式会强制展开账号列表', async () => {
    await act(async () => root.render(createElement(SiteCard, {
      ...props({ 'account-1': 'pending', 'account-2': 'done' }),
      selectionMode: true,
    })));

    expect(container.querySelector('[data-account-id="account-1"]')).not.toBeNull();
    expect(container.querySelector('button[aria-expanded]')).toBeNull();
  });

  it('明确显示学习流程回放，自动识别中的旧记录不接管', async () => {
    await act(async () => root.render(createElement(SiteCard, {
      ...props({}),
      site: { ...site, checkin: { method: 'workflow', workflow: { steps: [] } } },
    })));

    expect(container.textContent).toContain('学习流程回放');
    expect(container.textContent).toContain('核对当前账号 → 执行已保存签到流程');
    expect(container.textContent).toContain('本站账号共用');
    expect(container.textContent).not.toContain('自定义流程');
  });

  it('登录即签到的站点在卡片上明确显示实际执行方式', async () => {
    await act(async () => root.render(createElement(SiteCard, {
      ...props({}),
      site: { ...site, checkin: { method: 'none' } },
    })));

    expect(container.textContent).toContain('登录即签到');
    expect(container.textContent).toContain('登录成功即完成签到');
    expect(container.textContent).not.toContain('本站适配');
  });

  it('部分完成、失败或需人工处理时保持展开，只有全部成功才收起', async () => {
    await render({ 'account-1': 'pending', 'account-2': 'pending' });
    await expandAccounts();

    await render({ 'account-1': 'done', 'account-2': 'failed' });
    expect(accountToggle().getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-account-id="account-2"]')).not.toBeNull();

    await render({ 'account-1': 'done', 'account-2': 'attention' });
    expect(accountToggle().getAttribute('aria-expanded')).toBe('true');

    await render({ 'account-1': 'done', 'account-2': 'done' });
    expect(accountToggle().getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-account-id="account-1"]')).toBeNull();
  });
});

