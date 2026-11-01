import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, ProxyConfig } from '@/types';
import { AccountBindingPicker } from './AccountBindingPicker';

const proxies: ProxyConfig[] = [
  { id: 'p1', name: 'Japan', scheme: 'http', host: '127.0.0.1', port: 7891 },
  { id: 'p2', name: 'US', scheme: 'socks5', host: '127.0.0.1', port: 7892 },
];

const accounts: Account[] = [
  { id: 'a1', siteId: 's1', username: 'one@example.com', password: 'x', proxyMode: 'pool', proxyId: 'p1' },
  { id: 'a2', siteId: 's1', username: 'two@example.com', password: 'x', proxyMode: 'pool', proxyId: 'p2' },
];

describe('AccountBindingPicker', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('saves the checked account to the selected proxy', async () => {
    const onAssign = vi.fn(async () => 1);
    await act(async () => root.render(createElement(AccountBindingPicker, {
      open: true,
      initialProxyId: 'p1',
      proxies,
      accounts,
      sites: [],
      onAssign,
      onSetAccountProxy: vi.fn(async () => {}),
      onShowImport: vi.fn(),
    })));

    const checkbox = container.querySelector<HTMLInputElement>('input[aria-label="选择 two@example.com"]');
    expect(checkbox?.disabled).toBe(false);
    await act(async () => checkbox?.click());
    expect(container.querySelector<HTMLInputElement>('input[aria-label="选择 one@example.com"]')?.checked).toBe(false);
    const save = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('保存绑定'));
    await act(async () => save?.click());

    expect(onAssign).toHaveBeenCalledWith([{ accountId: 'a2', proxyId: 'p1', pinned: true }]);
    expect(container.textContent).toContain('已为 1 个账号绑定到“Japan”。');
  });

  it('clears a binding back to the site setting from the same account list', async () => {
    const onSetAccountProxy = vi.fn(async () => {});
    await act(async () => root.render(createElement(AccountBindingPicker, {
      open: true,
      initialProxyId: 'p1',
      proxies,
      accounts,
      sites: [],
      onAssign: vi.fn(async () => 0),
      onSetAccountProxy,
      onShowImport: vi.fn(),
    })));

    const unbind = container.querySelector<HTMLButtonElement>('button[aria-label="取消 one@example.com 的绑定"]');
    expect(unbind).not.toBeNull();
    await act(async () => unbind?.click());

    expect(onSetAccountProxy).toHaveBeenCalledWith('a1', { proxyMode: 'inherit' });
    expect(container.textContent).toContain('已取消绑定，将跟随站点设置。');
  });
});
