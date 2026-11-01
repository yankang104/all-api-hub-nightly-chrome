import type { LaunchMode } from '@/types';

export const DEFAULT_LAUNCH_MODE: LaunchMode = 'sidepanel';

export type LaunchSurface = 'page' | 'sidepanel';

export interface LaunchSurfaceActivation {
  /** 是否打开了独立管理页。 */
  optionsOpened: boolean;
  /** 当前浏览器是否确认关闭了侧栏；旧版 Chrome 可能不支持该 API。 */
  sidePanelClosed: boolean;
}

/** Keep the toolbar action behavior in one place for UI and background callers. */
export async function applyLaunchMode(mode: LaunchMode): Promise<void> {
  if (!chrome.sidePanel?.setPanelBehavior) {
    throw new Error('当前 Chrome 版本不支持侧边栏启动模式，请升级浏览器');
  }

  const expected = mode === 'sidepanel';
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: expected });

  if (chrome.sidePanel.getPanelBehavior) {
    const actual = await chrome.sidePanel.getPanelBehavior();
    if (actual.openPanelOnActionClick !== expected) {
      throw new Error('Chrome 未应用启动模式，请重新加载扩展后重试');
    }
  }
}

/**
 * 将持久化的启动方式同步应用到当前界面。
 *
 * sidePanel.open() 必须由用户手势直接触发，所以调用方应在 click
 * handler 里立刻启动这个 Promise，不能先 await storage/background 写入。
 */
export async function activateLaunchMode(
  mode: LaunchMode,
  surface: LaunchSurface,
  windowId?: number,
): Promise<LaunchSurfaceActivation> {
  const targetWindowId = windowId ?? chrome.windows.WINDOW_ID_CURRENT;
  if (mode === 'sidepanel') {
    if (surface === 'sidepanel') {
      return { optionsOpened: false, sidePanelClosed: true };
    }

    if (typeof chrome.sidePanel?.open !== 'function') {
      throw new Error('当前 Chrome 不支持直接打开侧边栏，请点击扩展图标打开');
    }

    // 必须在首次 await 之前调用，Chrome 才会保留本次点击的用户手势。
    await chrome.sidePanel.open({ windowId: targetWindowId });
    return { optionsOpened: false, sidePanelClosed: true };
  }

  let optionsOpened = false;
  if (surface === 'sidepanel') {
    // 已有独立页时会直接聚焦，不会重复创建管理页。
    await chrome.runtime.openOptionsPage();
    optionsOpened = true;
  }

  // Chrome 141+ 才有 close()。旧版仍会保存模式，但当前侧栏需手动关闭一次。
  if (typeof chrome.sidePanel?.close !== 'function') {
    return { optionsOpened, sidePanelClosed: surface !== 'sidepanel' };
  }

  try {
    await chrome.sidePanel.close({ windowId: targetWindowId });
    return { optionsOpened, sidePanelClosed: true };
  } catch {
    // 部分 Chrome 在没有打开侧栏时会 reject；当前本来就在页面上，可视为已关闭。
    return { optionsOpened, sidePanelClosed: surface !== 'sidepanel' };
  }
}
