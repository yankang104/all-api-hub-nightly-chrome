import { session } from '@/lib/core/storage';

/**
 * OAuth 授权弹窗的登记表。
 *
 * 为什么必须落在 `storage.session` 而不是内存 Map：
 *
 * 许多 OAuth 实现都是「弹窗授权 → postMessage/回调到 opener → 自动关闭」；
 * 任务信箱通常留在发起页，只有**代理租约**临时转给弹窗（见 background 的
 * handoffOAuthPopup）。于是 `PROXY_HOLDER` 是弹窗，而队列里的 `active.tabId`
 * 还是发起页。
 *
 * MV3 的 Service Worker 空闲几十秒就被回收，看门狗 alarm 每分钟又把它唤醒。
 * 冷启动会跑 `proxyLease.recover(合法持有者)`，而恢复逻辑只有知道「这个弹窗
 * 属于那个仍在跑的任务」才不会把租约当僵尸清掉 —— 内存 Map 恰好在重启时丢了
 * 这个事实，结果用户正在手输 Google 密码时全局代理被撤，授权页当场改走直连。
 *
 * 所以这张表要和租约本身（同为 session 存储）同生共死。
 */

const KEY = 'oauthPopupOpeners';

/**
 * 认证提供商。`generic` 表示站点自定义的 OAuth/SSO 提供商。
 *
 * 代理租约不应该依赖提供商白名单：Chrome 的代理是浏览器全局设置，
 * 只要是任务页打开的认证弹窗，就必须纳入同一条生命周期。provider 只
 * 用于日志与排查，不参与凭据派发判定。
 */
export type OAuthProvider = 'google' | 'github' | 'generic';

export interface OAuthPopupState {
  openerTabId: number;
  /** Google 这类 OAuth 通常通过 postMessage 回到 opener，任务仍留在 opener。 */
  provider?: OAuthProvider;
  /** 代理租约是否已经临时转到弹窗，关闭时要转回或释放。 */
  proxyTransferred?: boolean;
  /**
   * 发起页已经关闭/任务已经结束，但弹窗仍活着时保留代理。
   *
   * 这个标记不能靠内存状态：MV3 Service Worker 可能在用户输入 OAuth
   * 密码期间重启，恢复逻辑需要知道该弹窗仍是合法的全局代理持有者。
   */
  proxyRetained?: boolean;
}

type PopupTable = Record<string, OAuthPopupState>;

/**
 * 读改写串行化。
 *
 * 表里每条记录都会被多个事件并发改写（onCreated 写入、onUpdated 标记租约、
 * onRemoved 删除）。不串行的话「标记 proxyTransferred」和「删除」会互相覆盖，
 * 留下一条永远没人释放的租约，下一个账号就被一扇看不见的门挡住。
 */
let queue: Promise<void> = Promise.resolve();

function locked<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work, work);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

const read = (): Promise<PopupTable> => session.get<PopupTable>(KEY, {});

async function write(table: PopupTable): Promise<void> {
  if (Object.keys(table).length) await session.set(KEY, table);
  else await session.remove(KEY);
}

async function update(mutate: (table: PopupTable) => void): Promise<void> {
  const table = await read();
  mutate(table);
  await write(table);
}

const tabAlive = (tabId: number): Promise<boolean> =>
  chrome.tabs.get(tabId).then(() => true).catch(() => false);

export const oauthPopups = {
  /** 登记一个由任务标签页开出来的窗口。调用方负责确认 opener 上真有任务。 */
  remember(popupTabId: number, openerTabId: number): Promise<void> {
    return locked(() => update((table) => {
      const existing = table[String(popupTabId)];
      // onCreated 与首个 onUpdated 可能同时补登记；不要让后到的普通登记
      // 把已经写入的 provider/proxyTransferred 标记覆盖掉。
      table[String(popupTabId)] = { ...existing, openerTabId };
    }));
  },

  get(popupTabId: number): Promise<OAuthPopupState | undefined> {
    return locked(async () => (await read())[String(popupTabId)]);
  },

  entries(): Promise<[number, OAuthPopupState][]> {
    return locked(async () => Object.entries(await read())
      .map(([tabId, state]) => [Number(tabId), state] as [number, OAuthPopupState]));
  },

  /** 某个任务发起页名下的全部弹窗（包括尚未转移租约的记录）。 */
  entriesOf(openerTabId: number): Promise<[number, OAuthPopupState][]> {
    return locked(async () => Object.entries(await read())
      .filter(([, state]) => state.openerTabId === openerTabId)
      .map(([tabId, state]) => [Number(tabId), state] as [number, OAuthPopupState]));
  },

  /** 记下租约已经转给这个弹窗，`releaseTaskProxy` / `recover` 靠它认人。 */
  markProxyTransferred(popupTabId: number, provider: OAuthProvider): Promise<void> {
    return locked(() => update((table) => {
      const key = String(popupTabId);
      const state = table[key];
      if (state) table[key] = { ...state, provider, proxyTransferred: true };
    }));
  },

  clearProxyTransferred(popupTabId: number): Promise<void> {
    return locked(() => update((table) => {
      const key = String(popupTabId);
      const state = table[key];
      if (state) table[key] = { ...state, proxyTransferred: false, proxyRetained: false };
    }));
  },

  /** 标记弹窗在任务收尾后仍需继续持有全局代理，直到它自己关闭。 */
  markProxyRetained(popupTabId: number, retained = true): Promise<void> {
    return locked(() => update((table) => {
      const key = String(popupTabId);
      const state = table[key];
      if (state) table[key] = { ...state, proxyRetained: retained };
    }));
  },

  forget(popupTabId: number): Promise<void> {
    return locked(() => update((table) => {
      delete table[String(popupTabId)];
    }));
  },

  /** 某个任务标签页名下、已经拿到租约的弹窗。 */
  transferredPopupsOf(openerTabId: number): Promise<number[]> {
    return locked(async () => Object.entries(await read())
      .filter(([, state]) => state.openerTabId === openerTabId && state.proxyTransferred)
      .map(([tabId]) => Number(tabId)));
  },

  /** 当前仍标记为代理持有者的全部弹窗，供冷启动恢复校验。 */
  transferredPopups(): Promise<number[]> {
    return locked(async () => Object.entries(await read())
      .filter(([, state]) => state.proxyTransferred)
      .map(([tabId]) => Number(tabId)));
  },

  /**
   * 丢掉标签页已经不存在的记录。
   *
   * 浏览器重启后 session 存储会清空，所以这里只处理「本次会话里弹窗已关、
   * 但 onRemoved 没跑到」的漏网记录（Worker 恰好在那一刻被回收就会发生）。
   */
  pruneDeadTabs(): Promise<[number, OAuthPopupState][]> {
    return locked(async () => {
      const table = await read();
      const ids = Object.keys(table);
      if (!ids.length) return [];

      const alive = await Promise.all(ids.map((id) => tabAlive(Number(id))));
      const kept: PopupTable = {};
      const removed: [number, OAuthPopupState][] = [];
      ids.forEach((id, index) => {
        if (alive[index]) kept[id] = table[id]!;
        else removed.push([Number(id), table[id]!]);
      });
      if (Object.keys(kept).length !== ids.length) await write(kept);
      return removed;
    });
  },
};
