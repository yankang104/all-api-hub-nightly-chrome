import { session } from '@/lib/core/storage';

/**
 * 站点没跑完时「先留着」的任务页登记表。
 *
 * 为什么需要这层：同站还有账号排队/在跑时不能关当前任务页（用户要按站点
 * 看进度），但每个账号的任务页是各自新建的。如果只是「不关」，前面几个
 * 账号的页面就永远没人关 —— 站点真正跑完后会留下一串孤儿标签页。所以把
 * 留下的页按站点记下来，等本站最后一个账号收尾时一次性交出去关掉。
 *
 * 关页本身不在这里做：调用方逐个走 lib/core/tab-lifecycle 的 last-tab
 * 保护，绝不能关掉窗口的最后一个标签页（那等于关浏览器）。
 *
 * 存 storage.session：浏览器重启后任务页本来就没了，登记表跟着清空最干净。
 */

const keptKey = (siteId: string) => `keptSiteTabs:${siteId}`;

/*
 * 同站操作在队列里天然串行，但「记住上一页」和「站点收尾取走全部页」是
 * 两条各自带 1.2 秒定时器的异步路径；仍用一条 promise 链锁住读改写，
 * 避免极端时序下把刚登记的标签页丢掉。
 */
let lock: Promise<void> = Promise.resolve();

function locked<T>(work: () => Promise<T>): Promise<T> {
  const result = lock.then(work, work);
  lock = result.then(() => undefined, () => undefined);
  return result;
}

/** 记住一个「本站还没跑完、先留着」的任务页。同一页重复登记不会写两份。 */
export async function keepSiteTab(siteId: string, tabId: number): Promise<void> {
  if (!siteId || !Number.isFinite(tabId) || tabId <= 0) return;
  await locked(async () => {
    const tabs = await session.get<number[]>(keptKey(siteId), []);
    if (tabs.includes(tabId)) return;
    tabs.push(tabId);
    await session.set(keptKey(siteId), tabs);
  });
}

/** 取走并清空本站登记的任务页；调用方负责逐个安全关闭（last-tab 保护在调用方）。 */
export async function takeKeptSiteTabs(siteId: string): Promise<number[]> {
  return locked(async () => {
    const tabs = await session.get<number[]>(keptKey(siteId), []);
    if (tabs.length) await session.remove(keptKey(siteId));
    return tabs;
  });
}