import React, { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, ProxyConfig } from '@/types';

/**
 * `motion/react` 在 jsdom 里没有布局引擎，直接渲染成普通标签即可；
 * 这里只关心「按钮在不在、点了发什么」，不关心动画。
 */
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
    motion: { button: element('button'), div: element('div'), span: element('span') },
  };
});

import { BulkAssign } from './BulkAssign';
import type { ProxyAssignment } from '@/lib/proxy/proxy-assign';

/**
 * 显式标注签名：assignSpy(0) 会把参数推断成空元组，
 * 读 mock.calls[0]![0] 就成越界访问。这里按真实回调签名声明。
 */
const assignSpy = (result = 0) => vi.fn(async (_assignments: ProxyAssignment[]) => result);

const nameOnly = (id: string, name: string): ProxyConfig => ({
  id, name, scheme: 'http', host: '0.0.0.0', port: 0, nameOnly: true,
});
const real = (id: string, name: string, port: number): ProxyConfig => ({
  id, name, scheme: 'http', host: '127.0.0.1', port,
});
const account = (id: string, proxyId?: string): Account => ({
  id,
  siteId: 'site',
  username: `${id}@example.com`,
  password: 'x',
  ...(proxyId ? { proxyMode: 'pool' as const, proxyId } : {}),
} as Account);

describe('批量分配面板的「节点名死局」修复入口', () => {
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

  it('没有死局账号时不显示换绑入口', async () => {
    const proxies = [real('r-hk', '香港-优化1', 11001)];
    const accounts = [account('a', 'r-hk')];
    await act(async () => root.render(createElement(BulkAssign, {
      proxies, accounts, onAssign: assignSpy(0),
    })));

    expect(container.textContent).not.toContain('缺少代理地址');
    expect(container.textContent).not.toContain('换到同地区的真实出口');
  });

  it('有账号绑在节点名上时给出换绑入口与数量', async () => {
    const proxies = [nameOnly('n-hk', '香港-优化2'), real('r-hk', '香港WAP-优化2-Gemini', 11018)];
    const accounts = [account('a', 'n-hk'), account('b', 'n-hk'), account('c', 'r-hk')];
    await act(async () => root.render(createElement(BulkAssign, {
      proxies, accounts, onAssign: assignSpy(0),
    })));

    expect(container.textContent).toContain('2 个账号绑定的节点缺少代理地址');
    expect(container.textContent).toContain('换到同地区的真实出口（2 个）');
  });

  it('点换绑只写同地区真实出口，并把数量与跨区如实报出来', async () => {
    const proxies = [nameOnly('n-hk', '香港-优化2'), real('r-hk', '香港WAP-优化2-Gemini', 11018)];
    const accounts = [account('a', 'n-hk'), account('b', 'n-hk')];
    const onAssign = assignSpy(2);
    await act(async () => root.render(createElement(BulkAssign, { proxies, accounts, onAssign })));

    const button = [...container.querySelectorAll('button')]
      .find((item) => item.textContent?.includes('换到同地区的真实出口'));
    expect(button).toBeTruthy();
    await act(async () => (button as HTMLButtonElement).click());

    // 关键契约：换的是**真实出口**，绝不改成直连（proxyMode 必须仍是 pool）
    expect(onAssign).toHaveBeenCalledTimes(1);
    expect(onAssign.mock.calls[0]![0]).toEqual([
      { accountId: 'a', proxyId: 'r-hk' },
      { accountId: 'b', proxyId: 'r-hk' },
    ]);
    expect(container.textContent).toContain('已把 2 个账号换到真实出口');
  });

  /*
   * 真实调用方（ProxyModal）传给批量分配的是**已剔除节点名**的可用出口列表：
   * 测活与分配都不该见到无出口条目。修复入口却必须看得到它们，否则在真实
   * 界面里永远认不出「谁绑死在节点名上」—— 这条就是那个集成契约。
   */
  it('只收到可用出口时仍靠完整池认出死局账号（ProxyModal 的形状）', async () => {
    const pool = [nameOnly('n-hk', '香港-优化2'), real('r-hk', '香港WAP-优化2-Gemini', 11018)];
    const usable = pool.filter((proxy) => !proxy.nameOnly);
    const accounts = [account('a', 'n-hk')];
    const onAssign = assignSpy(1);
    await act(async () => root.render(createElement(BulkAssign, {
      proxies: usable, pool, accounts, onAssign,
    })));

    expect(container.textContent).toContain('1 个账号绑定的节点缺少代理地址');
    const button = [...container.querySelectorAll('button')]
      .find((item) => item.textContent?.includes('换到同地区的真实出口'));
    expect(button).toBeTruthy();
    await act(async () => (button as HTMLButtonElement).click());
    expect(onAssign.mock.calls[0]![0]).toEqual([{ accountId: 'a', proxyId: 'r-hk' }]);
  });

  /*
   * 换绑成功后死局账号变成 0 个，提示块会整块消失。结果文案必须留在面板外面，
   * 否则用户点完按钮看不到任何确认（跨区提示更是不能丢）。
   */
  it('换绑成功后仍能看到结果确认', async () => {
    const proxies = [nameOnly('n-hk', '香港-优化2'), real('r-hk', '香港WAP-优化2-Gemini', 11018)];
    const accounts = [account('a', 'n-hk'), account('b', 'n-hk')];
    const onAssign = assignSpy(2);
    await act(async () => root.render(createElement(BulkAssign, { proxies, accounts, onAssign })));

    const button = [...container.querySelectorAll('button')]
      .find((item) => item.textContent?.includes('换到同地区的真实出口'));
    await act(async () => (button as HTMLButtonElement).click());

    expect(container.textContent).toContain('已把 2 个账号换到真实出口');
  });

  it('池里没有真实出口时如实说明救不了，不写任何绑定', async () => {
    const proxies = [nameOnly('n-hk', '香港-优化2')];
    const accounts = [account('a', 'n-hk')];
    const onAssign = assignSpy(0);
    await act(async () => root.render(createElement(BulkAssign, { proxies, accounts, onAssign })));

    const button = [...container.querySelectorAll('button')]
      .find((item) => item.textContent?.includes('换到同地区的真实出口'));
    await act(async () => (button as HTMLButtonElement).click());

    expect(onAssign).not.toHaveBeenCalled();
    expect(container.textContent).toContain('没有可匹配的代理，1 个账号尚未换绑。请先添加代理。');
  });
});
