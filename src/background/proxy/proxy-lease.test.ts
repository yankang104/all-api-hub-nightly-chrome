import { beforeEach, describe, expect, it, vi } from 'vitest';

const { session, applyProxy, clearProxy } = vi.hoisted(() => ({
  session: {
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
  },
  applyProxy: vi.fn(),
  clearProxy: vi.fn(),
}));

vi.mock('@/lib/core/storage', () => ({ session }));
vi.mock('@/lib/proxy/proxy', () => ({ applyProxy, clearProxy }));

import { proxyLease } from '@/background/proxy/proxy-lease';

describe('proxy lease transfer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    session.get.mockResolvedValue(11);
    session.set.mockResolvedValue(undefined);
    session.remove.mockResolvedValue(undefined);
    applyProxy.mockResolvedValue(undefined);
    clearProxy.mockResolvedValue(undefined);
    vi.stubGlobal('chrome', {
      tabs: {
        get: vi.fn().mockResolvedValue({ id: 22 }),
      },
    });
  });

  it('changes only the lease holder and keeps the active proxy untouched', async () => {
    await expect(proxyLease.transfer(11, 22)).resolves.toBe(true);

    expect(session.set).toHaveBeenCalledWith('proxyHolderTabId', 22);
    expect(clearProxy).not.toHaveBeenCalled();
    expect(applyProxy).not.toHaveBeenCalled();
  });

  it('treats a repeated transfer to the current holder as idempotent', async () => {
    session.get.mockResolvedValue(22);

    await expect(proxyLease.transfer(11, 22)).resolves.toBe(true);

    expect(session.set).not.toHaveBeenCalled();
    expect(clearProxy).not.toHaveBeenCalled();
  });

  it('reports the holder for popup lifecycle race checks', async () => {
    session.get.mockResolvedValue(22);

    await expect(proxyLease.holder()).resolves.toBe(22);
    expect(session.get).toHaveBeenCalledWith('proxyHolderTabId', null);
  });

  it('rejects a transfer from a tab that no longer owns the lease', async () => {
    session.get.mockResolvedValue(99);

    await expect(proxyLease.transfer(11, 22)).resolves.toBe(false);

    expect(session.set).not.toHaveBeenCalled();
    expect(chrome.tabs.get).not.toHaveBeenCalled();
  });

  it('does not hand a lease to a closed destination tab', async () => {
    vi.mocked(chrome.tabs.get).mockRejectedValue(new Error('tab closed'));

    await expect(proxyLease.transfer(11, 22)).resolves.toBe(false);

    expect(session.set).not.toHaveBeenCalled();
  });
});

describe('proxy lease recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    session.set.mockResolvedValue(undefined);
    session.remove.mockResolvedValue(undefined);
    applyProxy.mockResolvedValue(undefined);
    clearProxy.mockResolvedValue(undefined);
    vi.stubGlobal('chrome', {
      tabs: { get: vi.fn().mockResolvedValue({ id: 22 }) },
    });
  });

  /*
   * 这条是真实故障的回归：Google 授权弹窗持有租约、任务信箱仍在发起页时，
   * Worker 每分钟被看门狗唤醒一次，冷启动的 recover 只认 active.tabId，
   * 就会在用户输密码的当口 clearProxy —— 授权页当场改走直连打不开。
   */
  it('keeps a lease held by the active task OAuth popup', async () => {
    session.get.mockResolvedValue(22);

    await proxyLease.recover([11, 22]);

    expect(clearProxy).not.toHaveBeenCalled();
    expect(session.remove).not.toHaveBeenCalled();
  });

  it('keeps a lease held by the task tab itself', async () => {
    session.get.mockResolvedValue(11);

    await proxyLease.recover([11]);

    expect(clearProxy).not.toHaveBeenCalled();
  });

  it('clears a lease held by a tab nobody claims', async () => {
    session.get.mockResolvedValue(99);

    await proxyLease.recover([11, 22]);

    expect(clearProxy).toHaveBeenCalledOnce();
    expect(session.remove).toHaveBeenCalledWith('proxyHolderTabId');
  });

  it('clears a lease whose holder tab is already gone', async () => {
    session.get.mockResolvedValue(22);
    vi.mocked(chrome.tabs.get).mockRejectedValue(new Error('tab closed'));

    await proxyLease.recover([11, 22]);

    expect(clearProxy).toHaveBeenCalledOnce();
  });

  it('clears a dead popup holder when the task tab releases', async () => {
    session.get.mockResolvedValue(22);
    vi.mocked(chrome.tabs.get).mockRejectedValue(new Error('tab closed'));

    await proxyLease.release(11);

    expect(clearProxy).toHaveBeenCalledOnce();
    expect(session.remove).toHaveBeenCalledWith('proxyHolderTabId');
  });

  it('does not clear a live popup holder when the opener task releases', async () => {
    session.get.mockResolvedValue(22);
    // `chrome` is stubbed locally rather than through the full Chrome API type;
    // Vitest consequently infers this mock's resolved value as `void`.
    vi.mocked(chrome.tabs.get).mockResolvedValue({ id: 22 } as never);

    await proxyLease.release(11);

    expect(clearProxy).not.toHaveBeenCalled();
    expect(session.remove).not.toHaveBeenCalled();
  });

  it('clears the proxy when no task is running', async () => {
    session.get.mockResolvedValue(11);

    await proxyLease.recover();

    expect(clearProxy).toHaveBeenCalledOnce();
  });
});
