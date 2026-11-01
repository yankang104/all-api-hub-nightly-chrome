import type { ProxyConfig } from '@/types';
import { applyProxy, clearProxy } from '@/lib/proxy/proxy';
import { session } from '@/lib/core/storage';

const PROXY_HOLDER = 'proxyHolderTabId';
let operationQueue: Promise<void> = Promise.resolve();

function locked<T>(work: () => Promise<T>): Promise<T> {
  const result = operationQueue.then(work, work);
  operationQueue = result.then(() => undefined, () => undefined);
  return result;
}

export const proxyLease = {
  /** 当前全局代理租约持有者，供 OAuth 生命周期处理竞态。 */
  holder(): Promise<number | null> {
    return locked(() => session.get<number | null>(PROXY_HOLDER, null));
  },

  acquire(tabId: number, proxy: ProxyConfig): Promise<boolean> {
    return locked(async () => {
      const holder = await session.get<number | null>(PROXY_HOLDER, null);
      if (holder != null && holder !== tabId) {
        const alive = await chrome.tabs.get(holder).then(() => true).catch(() => false);
        if (alive) return false;
        await clearProxy();
        await session.remove(PROXY_HOLDER);
      }

      await session.set(PROXY_HOLDER, tabId);
      try {
        await applyProxy(proxy);
        return true;
      } catch (error) {
        await clearProxy().catch(() => {});
        if (await session.get<number | null>(PROXY_HOLDER, null) === tabId) {
          await session.remove(PROXY_HOLDER);
        }
        throw error;
      }
    });
  },

  /**
   * 把全局代理租约从一个任务标签页移交给它新开的 OAuth 标签页。
   *
   * `chrome.proxy` 本身是浏览器级设置，移交时绝不能调用 `clearProxy()`：
   * 那会让刚打开的授权页立刻改走直连。这里只更新 session 里的持有者，
   * 代理设置和内存中的认证凭据保持原样，等新标签页结束任务后再 release。
   */
  transfer(fromTabId: number, toTabId: number): Promise<boolean> {
    return locked(async () => {
      if (fromTabId === toTabId) return true;

      const holder = await session.get<number | null>(PROXY_HOLDER, null);
      // onUpdated/onRemoved 可能重复到达；把已经转到目标页的操作视为幂等，
      // 这样接管逻辑不会把一个正确的 popup 租约误判成失败。
      if (holder === toTabId) {
        return chrome.tabs.get(toTabId).then(() => true).catch(() => false);
      }
      if (holder !== fromTabId) return false;

      const destinationAlive = await chrome.tabs.get(toTabId).then(() => true).catch(() => false);
      if (!destinationAlive) return false;

      await session.set(PROXY_HOLDER, toTabId);
      return true;
    });
  },

  release(tabId: number): Promise<void> {
    return locked(async () => {
      const holder = await session.get<number | null>(PROXY_HOLDER, null);
      if (holder !== tabId) {
        // OAuth 弹窗可能在后台没收到 onRemoved 的情况下关闭。任务页收尾时
        // 虽然传入的是 openerTabId，session 里仍记着那个已经消失的弹窗；
        // 确认持有者已死后安全清理，避免旧代理残留到没有下一个任务的场景。
        if (holder == null) return;
        const alive = await chrome.tabs.get(holder).then(() => true).catch(() => false);
        if (alive) return;
        await clearProxy();
        await session.remove(PROXY_HOLDER);
        return;
      }
      await clearProxy();
      await session.remove(PROXY_HOLDER);
    });
  },

  /**
   * Service Worker 冷启动后核对租约，僵尸租约一律清掉。
   *
   * @param validTabIds 现在**还有权**持有租约的标签页。必须包含正在跑的任务页
   *   **以及它名下的 OAuth 授权弹窗** —— Google 那类流程只把租约转给弹窗、
   *   任务信箱留在发起页（见 background 的 handoffOAuthPopup），此时持有者是
   *   弹窗而队列里的 active.tabId 是发起页。只拿 active.tabId 来比对，等于在
   *   用户手输 Google 密码的当口把全局代理撤掉：授权页当场改走直连，页面直接
   *   打不开，而任务日志里还写着「已启用扩展代理」。
   *   MV3 的 Worker 空闲几十秒就回收、看门狗每分钟又唤醒它，这一撤几乎必然发生。
   */
  recover(validTabIds: readonly number[] = []): Promise<void> {
    return locked(async () => {
      const holder = await session.get<number | null>(PROXY_HOLDER, null);
      if (holder != null && validTabIds.includes(holder)) {
        const alive = await chrome.tabs.get(holder).then(() => true).catch(() => false);
        if (alive) return;
      }
      /*
       * 关键：没有租约时**绝不能**调用 clearProxy()。
       *
       * chrome.proxy.settings.clear / set 属于网络栈重配置：Chrome 会短暂
       * 进入「网络变更」状态，此时正在进行中的主框架导航会被中止
       * （webNavigation 报 net::ERR_ABORTED，标签页停在 about:blank）。
       *
       * MV3 的 Worker 空闲几十秒就被回收，而每次冷启动都会跑本函数：
       * 用户点「签到」时放行的 START_LOGIN 消息本身就会唤醒 Worker，
       * recover 与 launchAccount 的 tabs.update 几乎同时发生 —— 一次多余
       * 的 clear 正好落在首个导航的窗口里，任务页永远停在空白页，
       * 状态卡在 running、队列一直 busy。这正是签到偶发「转圈卡死」的根因。
       *
       * 没有租约就意味着当前没有任何生效的扩展代理，无需清理网络配置。
       */
      if (holder == null) return;
      await clearProxy();
      await session.remove(PROXY_HOLDER);
    });
  },
};
