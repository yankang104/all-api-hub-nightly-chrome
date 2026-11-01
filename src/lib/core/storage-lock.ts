/**
 * 跨上下文的存储写锁。
 *
 * 为什么需要：扩展有三个 JS 上下文会写同一份数据 —— side panel、
 * options 页、background。它们各自跑在独立的 JS 环境里，模块级的
 * Promise 队列只能串行化本上下文内的写入，管不到另外两个。
 *
 * 典型事故：options 页正在读改写账号列表，side panel 同时也读改写，
 * 两边都基于同一份旧数据，后写的那个把先写的改动整段覆盖掉，
 * 没有报错、没有日志，用户只看到「刚才改的东西没了」。
 *
 * Web Locks API 是浏览器提供的跨上下文互斥量，正好解决这个问题。
 * 但它在某些环境（部分测试宿主、老版本 Service Worker）里不存在，
 * 所以保留一条内存 FIFO 队列作为兜底 —— 至少保证单上下文内有序。
 */

const inMemoryQueues = new Map<string, Promise<void>>();

/** 锁名：相关联、必须一起更新的存储键共用一把锁 */
export const STORAGE_LOCKS = {
  /** 站点、账号、状态、结果 —— 删除站点会级联删账号，必须同锁 */
  APP_DATA: 'checkin:app-data',
  /** 余额与历史快照 */
  BALANCE: 'checkin:balance',
} as const;

function runQueued<T>(lockName: string, work: () => Promise<T>): Promise<T> {
  const previous = inMemoryQueues.get(lockName) ?? Promise.resolve();
  const run = previous.then(work, work);
  inMemoryQueues.set(lockName, run.then(() => undefined, () => undefined));
  return run;
}

function webLocks(): LockManager | undefined {
  const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
  return typeof locks?.request === 'function' ? locks : undefined;
}

/**
 * 在排他锁内执行一段读改写。
 *
 * 内存队列包在最外层：即使 Web Locks 可用，也先让本上下文内的
 * 调用排好队，避免同一上下文里几十个并发请求同时去抢浏览器锁。
 */
export function withStorageWriteLock<T>(lockName: string, work: () => Promise<T>): Promise<T> {
  const locks = webLocks();
  if (!locks) return runQueued(lockName, work);

  // await 一层：Web Locks 的类型把回调返回值原样包进 Promise，
  // 回调本身返回 Promise<T>，直接返回会变成 Promise<Promise<T>>。
  return runQueued(lockName, async (): Promise<T> =>
    await locks.request(lockName, { mode: 'exclusive' }, () => work()),
  );
}
