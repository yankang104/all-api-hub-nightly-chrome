import React, { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, SiteConfig } from '@/types';
import { blankSite } from '@/sites';

vi.mock('motion/react', async () => {
  const ReactModule = await vi.importActual<typeof import('react')>('react');
  const element = (tag: string) => ({
    children,
    initial: _initial,
    animate: _animate,
    exit: _exit,
    transition: _transition,
    whileHover: _whileHover,
    whileTap: _whileTap,
    ...props
  }: Record<string, unknown>) => ReactModule.createElement(tag, props, children as ReactNode);

  return {
    AnimatePresence: ({ children }: { children?: ReactNode }) => ReactModule.createElement(ReactModule.Fragment, null, children),
    motion: {
      button: element('button'),
      div: element('div'),
    },
  };
});

import { AddAccountModal } from './AddAccountModal';
import { LoginMethodSection } from './site-form/LoginMethodSection';

const site: SiteConfig = {
  id: 'site-1',
  name: '测试站',
  loginUrl: 'https://example.com/login',
  loginMethod: 'form',
  selectors: { username: '#username', password: '#password', submit: 'button[type="submit"]' },
  closeModalSelectors: [],
  checkin: { method: 'auto' },
};

function withoutId(config: SiteConfig): Omit<SiteConfig, 'id'> {
  const { id: _id, ...form } = config;
  return form;
}

function findLoginMethodSelect(container: HTMLElement): HTMLSelectElement {
  const loginField = [...container.querySelectorAll<HTMLLabelElement>('label')]
    .find((label) => label.querySelector(':scope > span')?.textContent === '登录方式');
  const select = loginField?.querySelector<HTMLSelectElement>('select');
  if (!select) throw new Error('未找到登录方式下拉框');
  return select;
}

describe('登录方式可选项', () => {
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

  it('站点配置只显示站点密码和 GitHub 两种方式', async () => {
    await act(async () => root.render(createElement(LoginMethodSection, {
      form: withoutId(site),
      onChange: vi.fn(),
    })));

    const labels = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .map((button) => button.textContent?.replace(/\s+/g, ' ').trim());
    expect(labels).toEqual([
      '站点账号密码填站点用户名密码并提交，最常见',
      'GitHub 账号密码点站点 OAuth 按钮，跳到 GitHub 后自动填 GitHub 账密',
    ]);
  });

  it('账号配置只提供跟随站点及两种可选方式', async () => {
    await act(async () => root.render(createElement(AddAccountModal, {
      open: true,
      sites: [site],
      proxies: [],
      onClose: vi.fn(),
      onSubmit: vi.fn().mockResolvedValue(undefined),
    })));

    const options = [...findLoginMethodSelect(container).options]
      .map((option) => option.textContent?.replace(/\s+/g, ' ').trim());
    expect(options).toEqual([
      '跟随站点设置（当前：站点账号密码）',
      '站点账号密码',
      'GitHub 账号密码',
    ]);
  });

  it('历史站点方式只作为兼容状态显示，不重新变成可选项', async () => {
    await act(async () => root.render(createElement(LoginMethodSection, {
      form: withoutId({ ...site, loginMethod: 'auto' }),
      onChange: vi.fn(),
    })));

    expect(container.querySelectorAll('button')).toHaveLength(2);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('当前兼容配置：自动检测');
  });

  it('编辑历史 token 账号时保留原值，但只能主动选择两种新方式', async () => {
    const editing: Account = {
      id: 'account-1',
      siteId: site.id,
      username: 'legacy-user',
      password: '',
      loginMethod: 'token',
      apiToken: 'legacy-token',
    };

    await act(async () => root.render(createElement(AddAccountModal, {
      open: true,
      sites: [site],
      proxies: [],
      editing,
      onClose: vi.fn(),
      onSubmit: vi.fn().mockResolvedValue(undefined),
    })));

    const select = findLoginMethodSelect(container);
    expect(select.value).toBe('token');
    expect([...select.options].map((option) => ({
      value: option.value,
      text: option.textContent?.replace(/\s+/g, ' ').trim(),
      disabled: option.disabled,
    }))).toEqual([
      { value: '', text: '跟随站点设置（当前：站点账号密码）', disabled: false },
      { value: 'token', text: '当前兼容配置：API 通行令牌', disabled: true },
      { value: 'form', text: '站点账号密码', disabled: false },
      { value: 'github', text: 'GitHub 账号密码', disabled: false },
    ]);
    expect([...select.options]
      .filter((option) => option.value && !option.disabled)
      .map((option) => option.value)).toEqual(['form', 'github']);
  });

  it('未切换历史 auto 方式时可保存，并原样保留 GitHub 凭据', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const editing: Account = {
      id: 'account-auto',
      siteId: site.id,
      username: 'legacy-auto-user',
      password: '',
      loginMethod: 'auto',
      githubUsername: 'github-user',
      githubPassword: 'github-password',
      label: '旧账号',
    };

    await act(async () => root.render(createElement(AddAccountModal, {
      open: true,
      sites: [site],
      proxies: [],
      editing,
      onClose: vi.fn(),
      onSubmit,
    })));

    const saveButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '保存账号');
    expect(saveButton?.disabled).toBe(false);
    await act(async () => saveButton?.click());

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      loginMethod: 'auto',
      password: '',
      githubUsername: 'github-user',
      githubPassword: 'github-password',
    }));
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty('identity');
  });

  it('旧 auto 账号改为跟随同为 auto 的站点时仍保留凭据', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const legacySite = { ...site, loginMethod: 'auto' as const };
    const editing: Account = {
      id: 'account-follow-auto',
      siteId: site.id,
      username: 'follow-auto-user',
      password: '',
      loginMethod: 'auto',
      githubUsername: 'github-user',
      githubPassword: 'github-password',
      identity: { userId: '42', fetchedAt: 1 },
    };

    await act(async () => root.render(createElement(AddAccountModal, {
      open: true,
      sites: [legacySite],
      proxies: [],
      editing,
      onClose: vi.fn(),
      onSubmit,
    })));

    const select = findLoginMethodSelect(container);
    await act(async () => {
      select.value = '';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const saveButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '保存账号');
    expect(saveButton?.disabled).toBe(false);
    await act(async () => saveButton?.click());

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      loginMethod: '',
      password: '',
      githubUsername: 'github-user',
      githubPassword: 'github-password',
    }));
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty('identity');
  });

  it('从历史方式主动切换到 form 时清理旧凭据与身份', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const editing: Account = {
      id: 'account-token-to-form',
      siteId: site.id,
      username: 'switch-user',
      password: 'form-password',
      loginMethod: 'token',
      apiToken: 'legacy-token',
      githubUsername: 'legacy-github-user',
      githubPassword: 'legacy-github-password',
      passkey: true,
      identity: { userId: '42', fetchedAt: 1 },
    };

    await act(async () => root.render(createElement(AddAccountModal, {
      open: true,
      sites: [site],
      proxies: [],
      editing,
      onClose: vi.fn(),
      onSubmit,
    })));

    const select = findLoginMethodSelect(container);
    await act(async () => {
      select.value = 'form';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const saveButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '保存账号');
    expect(saveButton?.disabled).toBe(false);
    await act(async () => saveButton?.click());

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      loginMethod: 'form',
      password: 'form-password',
      apiToken: '',
      githubUsername: '',
      githubPassword: '',
      passkey: false,
      identity: {},
    }));
  });

  it('新建站点默认选中第一种可见方式', () => {
    expect(blankSite().loginMethod).toBe('form');
  });
});
