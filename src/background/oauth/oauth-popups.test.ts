import { beforeEach, describe, expect, it, vi } from 'vitest';

const { store } = vi.hoisted(() => ({ store: new Map<string, unknown>() }));

vi.mock('@/lib/core/storage', () => ({
  session: {
    async get<T>(key: string, fallback: T): Promise<T> {
      return (store.has(key) ? store.get(key) : fallback) as T;
    },
    async set(key: string, value: unknown): Promise<void> {
      store.set(key, value);
    },
    async remove(key: string): Promise<void> {
      store.delete(key);
    },
  },
}));

import { oauthPopups } from '@/background/oauth/oauth-popups';

describe('oauth popup registry', () => {
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('chrome', {
      tabs: { get: vi.fn().mockResolvedValue({ id: 1 }) },
    });
  });

  it('survives a Service Worker restart by living in session storage', async () => {
    await oauthPopups.remember(22, 11);
    await oauthPopups.markProxyTransferred(22, 'google');

    // 模拟冷启动：模块内没有任何内存状态可依赖，只能从 session 读回来
    expect(await oauthPopups.transferredPopupsOf(11)).toEqual([22]);
    expect(await oauthPopups.get(22)).toMatchObject({
      openerTabId: 11,
      provider: 'google',
      proxyTransferred: true,
    });
  });

  it('only reports popups that actually hold the lease', async () => {
    await oauthPopups.remember(22, 11);
    await oauthPopups.remember(33, 11);
    await oauthPopups.markProxyTransferred(33, 'google');

    expect(await oauthPopups.transferredPopupsOf(11)).toEqual([33]);
  });

  it('supports a generic OAuth provider without a hard-coded domain', async () => {
    await oauthPopups.remember(44, 11);
    await oauthPopups.markProxyTransferred(44, 'generic');

    expect(await oauthPopups.get(44)).toMatchObject({
      openerTabId: 11,
      provider: 'generic',
      proxyTransferred: true,
    });
  });

  it('does not leak popups belonging to another task tab', async () => {
    await oauthPopups.remember(22, 11);
    await oauthPopups.markProxyTransferred(22, 'google');

    expect(await oauthPopups.transferredPopupsOf(99)).toEqual([]);
  });

  it('drops the lease mark without forgetting the popup', async () => {
    await oauthPopups.remember(22, 11);
    await oauthPopups.markProxyTransferred(22, 'google');
    await oauthPopups.clearProxyTransferred(22);

    expect(await oauthPopups.transferredPopupsOf(11)).toEqual([]);
    expect(await oauthPopups.get(22)).toMatchObject({ openerTabId: 11 });
  });

  it('retains a transferred lease after the opener task is gone', async () => {
    await oauthPopups.remember(22, 11);
    await oauthPopups.markProxyTransferred(22, 'generic');
    await oauthPopups.markProxyRetained(22);

    expect(await oauthPopups.entriesOf(11)).toEqual([
      [22, { openerTabId: 11, provider: 'generic', proxyTransferred: true, proxyRetained: true }],
    ]);
    // Retained popups must be included even when their opener is no longer
    // the active queue tab; recovery uses this list after a Worker restart.
    expect(await oauthPopups.transferredPopups()).toEqual([22]);
  });

  it('clearing a transfer also clears its retained marker', async () => {
    await oauthPopups.remember(22, 11);
    await oauthPopups.markProxyTransferred(22, 'generic');
    await oauthPopups.markProxyRetained(22);
    await oauthPopups.clearProxyTransferred(22);

    expect(await oauthPopups.get(22)).toMatchObject({
      proxyTransferred: false,
      proxyRetained: false,
    });
  });

  it('forgets a popup and clears the storage key when the table empties', async () => {
    await oauthPopups.remember(22, 11);
    await oauthPopups.forget(22);

    expect(await oauthPopups.get(22)).toBeUndefined();
    expect(store.has('oauthPopupOpeners')).toBe(false);
  });

  it('ignores marks for popups it never registered', async () => {
    await oauthPopups.markProxyTransferred(22, 'google');

    expect(await oauthPopups.get(22)).toBeUndefined();
  });

  it('prunes records whose tabs are already closed', async () => {
    await oauthPopups.remember(22, 11);
    await oauthPopups.remember(33, 11);
    await oauthPopups.markProxyTransferred(22, 'google');
    vi.mocked(chrome.tabs.get).mockImplementation(
      (tabId: number) => (tabId === 33 ? Promise.resolve({ id: 33 } as chrome.tabs.Tab) : Promise.reject(new Error('gone'))),
    );

    const removed = await oauthPopups.pruneDeadTabs();

    // 恢复逻辑要靠返回的完整状态把已关闭 popup 的租约交还 opener。
    expect(removed).toEqual([[
      22,
      { openerTabId: 11, provider: 'google', proxyTransferred: true },
    ]]);
    expect(await oauthPopups.get(22)).toBeUndefined();
    expect(await oauthPopups.get(33)).toMatchObject({ openerTabId: 11 });
  });

  /*
   * onUpdated 标记租约和 onRemoved 删除记录会同时发生。读改写不串行的话
   * 后写的会覆盖前一个，留下一条永远没人释放的租约，下一个账号就被挡住。
   */
  it('serializes concurrent writes instead of losing one', async () => {
    await oauthPopups.remember(22, 11);
    await oauthPopups.remember(33, 11);

    await Promise.all([
      oauthPopups.markProxyTransferred(22, 'google'),
      oauthPopups.markProxyTransferred(33, 'github'),
    ]);

    expect((await oauthPopups.transferredPopupsOf(11)).sort()).toEqual([22, 33]);
  });

  it('keeps a transfer mark when a duplicate registration arrives later', async () => {
    await oauthPopups.remember(22, 11);
    await oauthPopups.markProxyTransferred(22, 'google');
    await oauthPopups.remember(22, 11);

    expect(await oauthPopups.get(22)).toMatchObject({
      provider: 'google',
      proxyTransferred: true,
    });
  });
});
