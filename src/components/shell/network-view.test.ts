import { act, createElement, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, ProxyConfig, SiteConfig } from '@/types';
import { sendMessage } from '@/lib/core/messaging';
import { NetworkView } from './views';

vi.mock('@/lib/core/messaging', () => ({ sendMessage: vi.fn() }));
vi.mock('motion/react', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  const element = (tag: string) => ({ children, layout: _layout, initial: _initial, animate: _animate, exit: _exit, whileTap: _tap, ...props }: Record<string, unknown>) => React.createElement(tag, props, children as ReactNode);
  return {
    AnimatePresence: ({ children }: { children?: ReactNode }) => children,
    motion: { article: element('article'), button: element('button'), div: element('div'), span: element('span') },
  };
});

const proxies: ProxyConfig[] = [
  { id: 'p1', name: 'Japan', scheme: 'http', host: '127.0.0.1', port: 11001 },
  { id: 'p2', name: 'US', scheme: 'socks5', host: '127.0.0.1', port: 11002 },
  { id: 'names', name: 'Name only', scheme: 'http', host: '-', port: 0, nameOnly: true },
];
const accounts: Account[] = [
  { id: 'a1', siteId: 's1', username: 'one', password: 'x' },
  { id: 'a2', siteId: 's1', username: 'two', password: 'x', proxyMode: 'pool', proxyId: 'p2', proxyPinned: true },
];
const sites = [{ id: 's1', name: 'Test site', proxyId: 'p1' }] as SiteConfig[];
const success = { ok: true as const, test: { ok: true, ms: 15, message: '可用 15ms' } };
const failure = { ok: true as const, test: { ok: false, ms: 0, message: '端口未监听', listenerProbe: 'closed' as const } };

describe('代理单页操作', () => {
  let container: HTMLDivElement;
  let root: Root;
  let dialogMethods: PropertyDescriptorMap;

  beforeEach(() => {
    dialogMethods = Object.getOwnPropertyDescriptors(HTMLDialogElement.prototype);
    Object.defineProperties(HTMLDialogElement.prototype, {
      showModal: { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } },
      close: { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } },
    });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('chrome', { storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } } });
    vi.mocked(sendMessage).mockReset().mockResolvedValue(success);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    for (const method of ['showModal', 'close']) {
      if (dialogMethods[method]) Object.defineProperty(HTMLDialogElement.prototype, method, dialogMethods[method]!);
      else Reflect.deleteProperty(HTMLDialogElement.prototype, method);
    }
  });

  async function render(overrides: Partial<ComponentProps<typeof NetworkView>> = {}) {
    const props = {
      proxies, accounts, sites,
      onAddMany: vi.fn(async () => ({ added: 1, skipped: 0, upgraded: 0 })),
      onSyncClash: vi.fn(async () => ({ added: 1, skipped: 0, upgraded: 0, removed: 0, keptInUse: 0 })),
      onRemove: vi.fn(async () => {}),
      onAssign: vi.fn(async () => 1),
      onSetAccountProxy: vi.fn(async () => {}),
      ...overrides,
    };
    await act(async () => root.render(createElement(NetworkView, props)));
    return props;
  }

  function button(text: string) {
    const found = [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === text);
    expect(found, `button: ${text}`).toBeDefined();
    return found!;
  }

  function namedButton(name: string) {
    const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
    expect(found, name).not.toBeNull();
    return found!;
  }

  async function selectProxy(id: string) {
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="选择绑定代理"]')!;
    await act(async () => {
      select.value = id;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    return select;
  }

  it('同时提供分配方式、测活和手动绑定，点击代理不会丢失勾选', async () => {
    const props = await render();
    expect(container.querySelector('dialog[open]')).toBeNull();
    expect(button('测活并分配').disabled).toBe(false);
    expect(container.querySelector<HTMLInputElement>('input[aria-label="保留手动绑定"]')?.checked).toBe(true);
    expect(container.querySelector('article[aria-label="代理 Japan"]')?.textContent).toContain('1 个账号');
    await act(async () => container.querySelector<HTMLInputElement>('input[aria-label="选择 one"]')!.click());
    await act(async () => namedButton('绑定账号到 Japan').click());
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="选择绑定代理"]')!;
    expect(select.value).toBe('p1');
    expect([...select.options].map((option) => option.value)).toEqual(['', 'p1', 'p2']);
    await selectProxy('p2');
    await act(async () => namedButton('绑定账号到 Japan').click());
    expect(container.querySelector<HTMLInputElement>('input[aria-label="选择 one"]')?.checked).toBe(true);
    await act(async () => button('保存绑定').click());
    expect(props.onAssign).toHaveBeenCalledWith([{ accountId: 'a1', proxyId: 'p1', pinned: true }]);
    expect(container.textContent).toContain('已为 1 个账号绑定到“Japan”。');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('单个测活期间阻止其他测活、分配和删除，异常后可以重试', async () => {
    let reject!: (error: Error) => void;
    vi.mocked(sendMessage).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    await render();
    await act(async () => namedButton('测试 Japan').click());
    expect(namedButton('测试 US').disabled).toBe(true);
    expect(button('全部测活').disabled).toBe(true);
    expect(button('测活并分配').disabled).toBe(true);
    expect(button('保存绑定').disabled).toBe(true);
    expect(namedButton('删除 Japan').disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[aria-label="代理订阅地址"]')!.matches(':disabled')).toBe(true);
    await act(async () => reject(new Error('连接中断')));
    expect(container.querySelector('article[aria-label="代理 Japan"]')?.textContent).toContain('连接中断');
    expect(button('全部测活').disabled).toBe(false);
    await act(async () => namedButton('测试 Japan').click());
    expect(container.querySelector('article[aria-label="代理 Japan"]')?.textContent).toContain('可用 15ms');
  });

  it('全部测活逐个执行，跳过名称条目，失败后继续检测剩余节点', async () => {
    let resolve!: (result: typeof success) => void;
    vi.mocked(sendMessage).mockImplementationOnce(() => new Promise((done) => { resolve = done; })).mockRejectedValueOnce(new Error('连接失败'));
    const props = await render();
    await act(async () => button('全部测活').click());
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(button('保存绑定').disabled).toBe(true);
    await act(async () => resolve(success));
    expect(vi.mocked(sendMessage).mock.calls.map(([message]) => message.type === 'TEST_PROXY' && message.proxy.id)).toEqual(['p1', 'p2']);
    expect(container.textContent).toContain('测试完成，1/2 个连接正常。');
    expect(container.querySelector('article[aria-label="代理 US"]')?.textContent).toContain('连接失败');
    expect(props.onAssign).not.toHaveBeenCalled();
    expect(button('全部测活').disabled).toBe(false);
  });

  it('保存失败保留勾选以便重试，保存期间阻止重复操作', async () => {
    let reject!: (error: Error) => void;
    const onAssign = vi.fn<() => Promise<number>>().mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; })).mockResolvedValueOnce(1);
    await render({ onAssign });
    await selectProxy('p1');
    const checkbox = container.querySelector<HTMLInputElement>('input[aria-label="选择 one"]')!;
    await act(async () => checkbox.click());
    await act(async () => button('保存绑定').click());
    expect(button('保存中…').disabled).toBe(true);
    expect(button('全部测活').disabled).toBe(true);
    expect(button('测活并分配').disabled).toBe(true);
    expect(namedButton('删除 Japan').disabled).toBe(true);
    await act(async () => reject(new Error('保存失败')));
    expect(container.textContent).toContain('保存失败');
    expect(checkbox.checked).toBe(true);
    expect(button('保存绑定').disabled).toBe(false);
    await act(async () => button('保存绑定').click());
    expect(onAssign).toHaveBeenNthCalledWith(2, [{ accountId: 'a1', proxyId: 'p1', pinned: true }]);
    expect(container.textContent).toContain('已为 1 个账号绑定到“Japan”。');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('默认账号列表就能解绑，解绑期间阻止连接测试', async () => {
    let resolve!: () => void;
    const onSetAccountProxy = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    await render({ onSetAccountProxy });
    await act(async () => namedButton('取消 two 的绑定').click());
    expect(button('全部测活').disabled).toBe(true);
    expect(button('测活并分配').disabled).toBe(true);
    expect(onSetAccountProxy).toHaveBeenCalledWith('a2', { proxyMode: 'inherit' });
    await act(async () => resolve());
    expect(container.textContent).toContain('已取消绑定，将跟随站点设置。');
    expect(button('全部测活').disabled).toBe(false);
  });

  it('没有真实代理时通过添加入口展开导入，分配按钮说明不可用原因', async () => {
    await render({ proxies: [proxies[2]!] });
    expect(button('保存绑定').disabled).toBe(true);
    expect(button('测活并分配').disabled).toBe(true);
    await act(async () => button('去添加代理').click());
    expect(container.querySelector<HTMLDialogElement>('#proxy-import')?.open).toBe(true);
    await act(async () => namedButton('关闭添加代理').click());
    expect(container.querySelector<HTMLDialogElement>('#proxy-import')?.open).toBe(false);
  });

  it('测活并分配只使用通过的代理，默认保留手动绑定并更新代理列表状态', async () => {
    vi.mocked(sendMessage).mockResolvedValueOnce(success).mockResolvedValueOnce(failure);
    const props = await render();
    await act(async () => button('测活并分配').click());
    expect(vi.mocked(sendMessage).mock.calls.map(([message]) => message.type === 'TEST_PROXY' && message.proxy.id)).toEqual(['p1', 'p2']);
    expect(props.onAssign).toHaveBeenCalledWith([{ accountId: 'a1', proxyId: 'p1' }]);
    expect(container.querySelector('article[aria-label="代理 Japan"]')?.textContent).toContain('可用 15ms');
    expect(container.querySelector('article[aria-label="代理 US"]')?.textContent).toContain('端口未监听');
    expect(container.textContent).toContain('保留手动设置 1 个');
  });

  it('全部重新分配能覆盖手动和直连账号，出口不足时循环分配', async () => {
    const props = await render({ accounts: [...accounts, { id: 'a3', siteId: 's1', username: 'three', password: 'x', proxyMode: 'none' }] });
    await act(async () => container.querySelector<HTMLInputElement>('input[aria-label="全部重新分配"]')!.click());
    await act(async () => button('测活并分配').click());
    expect(props.onAssign).toHaveBeenCalledWith([
      { accountId: 'a1', proxyId: 'p1' },
      { accountId: 'a2', proxyId: 'p2' },
      { accountId: 'a3', proxyId: 'p1' },
    ]);
  });

  it('全部测活失败时不修改绑定，保存失败时恢复按钮供重试', async () => {
    vi.mocked(sendMessage).mockResolvedValue(failure);
    const onAssign = vi.fn(async () => { throw new Error('存储失败'); });
    await render({ onAssign });
    await act(async () => button('测活并分配').click());
    expect(onAssign).not.toHaveBeenCalled();
    expect(container.textContent).toContain('没有写入任何绑定');
    vi.mocked(sendMessage).mockResolvedValue(success);
    await act(async () => button('测活并分配').click());
    expect(container.textContent).toContain('存储失败');
    expect(button('测活并分配').disabled).toBe(false);
    expect(button('全部测活').disabled).toBe(false);
  });
});
