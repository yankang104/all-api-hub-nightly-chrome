/**
 * 关闭「扩展自己开的标签页」时的安全闸门。
 *
 * 为什么必须有这层：`chrome.tabs.remove` 关掉一个窗口的**最后一个标签页**时，
 * Chrome 会连窗口一起关闭；若那是唯一的窗口，浏览器直接退出。用户报的真实故障
 * 就是这条 —— 签到完成后浏览器「自己退了」，而他还要继续下一个站点。
 *
 * 扩展的任务页是 `chrome.tabs.create({ active: true })` 开在用户当前窗口里的
 * 普通标签页，没有任何独立窗口兜底。用侧边栏操作时侧栏不算标签页，任务页
 * 往往就是那个窗口里唯一的标签，于是每一次「跑完关页」都可能掀掉整个浏览器。
 *
 * 所以关闭前必须先问一句：这个窗口还有别的标签页吗？没有就不关，把标签页
 * 留在原地（用户自己关，或下一个任务复用），绝不拿用户的浏览器当代价。
 */

/** 只依赖 tabs API，便于单测注入。 */
export interface TabRemovalDeps {
  get(tabId: number): Promise<{ windowId?: number } | undefined>;
  queryWindow(windowId: number): Promise<readonly { id?: number }[]>;
  remove(tabId: number): Promise<void>;
}

/** 浏览器标签页 API 的默认实现。 */
export const chromeTabRemovalDeps: TabRemovalDeps = {
  get: (tabId) => chrome.tabs.get(tabId).catch(() => undefined),
  queryWindow: (windowId) => chrome.tabs.query({ windowId }).catch(() => []),
  remove: (tabId) => chrome.tabs.remove(tabId),
};

/**
 * 关闭标签页；若是所在窗口的最后一个标签页则**跳过**。
 *
 * @returns 'removed'  已关闭
 *          'kept'     它是最后一个标签页，为保住窗口/浏览器没有关它
 *          'gone'     标签页本来就不在了
 */
export async function removeTabUnlessLast(
  tabId: number,
  deps: TabRemovalDeps = chromeTabRemovalDeps,
): Promise<'removed' | 'kept' | 'gone'> {
  if (!Number.isFinite(tabId) || tabId <= 0) return 'gone';

  const tab = await deps.get(tabId);
  if (!tab) return 'gone';

  // 拿不到 windowId 时按「保守不关」处理：宁可留一个多余标签页，
  // 也不能因为读不到窗口信息就赌上用户的整个浏览器。
  if (tab.windowId == null) return 'kept';

  const siblings = await deps.queryWindow(tab.windowId);
  const otherTabs = siblings.filter((item) => item.id !== tabId);
  if (otherTabs.length === 0) return 'kept';

  await deps.remove(tabId);
  return 'removed';
}
