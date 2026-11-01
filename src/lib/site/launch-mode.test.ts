import { afterEach, describe, expect, it, vi } from 'vitest';
import { activateLaunchMode } from '@/lib/site/launch-mode';

function installChrome(overrides: {
  open?: ReturnType<typeof vi.fn>;
  close?: ReturnType<typeof vi.fn>;
} = {}) {
  const open = overrides.open ?? vi.fn().mockResolvedValue(undefined);
  const close = overrides.close ?? vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('chrome', {
    windows: { WINDOW_ID_CURRENT: -2 },
    runtime: { openOptionsPage: vi.fn().mockResolvedValue(undefined) },
    sidePanel: { open, close },
  });
  return { open, close, runtime: chrome.runtime };
}

afterEach(() => vi.unstubAllGlobals());

describe('activateLaunchMode', () => {
  it('从独立页切到侧边栏时直接打开当前窗口', async () => {
    const { open, runtime } = installChrome();

    const result = await activateLaunchMode('sidepanel', 'page', 17);

    expect(open).toHaveBeenCalledWith({ windowId: 17 });
    expect(runtime.openOptionsPage).not.toHaveBeenCalled();
    expect(result).toEqual({ optionsOpened: false, sidePanelClosed: true });
  });

  it('从侧边栏切到独立页时打开管理页并关闭侧栏', async () => {
    const { close, runtime } = installChrome();

    const result = await activateLaunchMode('tab', 'sidepanel', 23);

    expect(runtime.openOptionsPage).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith({ windowId: 23 });
    expect(result).toEqual({ optionsOpened: true, sidePanelClosed: true });
  });

  it('旧版 Chrome 没有 close API 时保留模式并报告需要手动关闭', async () => {
    const runtime = { openOptionsPage: vi.fn().mockResolvedValue(undefined) };
    vi.stubGlobal('chrome', {
      windows: { WINDOW_ID_CURRENT: -2 },
      runtime,
      sidePanel: {},
    });

    const result = await activateLaunchMode('tab', 'sidepanel');

    expect(runtime.openOptionsPage).toHaveBeenCalledOnce();
    expect(result).toEqual({ optionsOpened: true, sidePanelClosed: false });
  });

  it('已经在目标界面时不重复打开', async () => {
    const { open, runtime, close } = installChrome();

    const result = await activateLaunchMode('sidepanel', 'sidepanel');

    expect(open).not.toHaveBeenCalled();
    expect(runtime.openOptionsPage).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(result).toEqual({ optionsOpened: false, sidePanelClosed: true });
  });
});
