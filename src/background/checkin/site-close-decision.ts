/**
 * 「本站跑完了吗」的判据：一个账号成功收尾、准备关它的任务页之前，
 * 先看队列里还有没有**同一个站点**的其它账号。
 *
 * 为什么不能只看「站点下还有没有别的账号」：执行是用户勾选的，可能只跑
 * 一部分账号。没进队列的账号这一轮根本不会开跑，不该成为把页面无限期
 * 留在那里的理由。
 *
 * 为什么 active 和 pending 都要看：关页延迟到 1.2 秒后执行（先让 TASK_RESULT
 * 回执送达 content script），这个窗口里下一个同站账号完全可能已经从
 * pending 提升为 active、甚至已经开跑。漏看 active 就会在本站还没跑完时
 * 把页面关掉。
 */

export interface SiteCloseDecisionInput {
  /** 刚成功收尾、准备关页的账号所属站点 */
  siteId: string;
  /**
   * 刚成功收尾的账号。队列里如果还残留它自己（finish 重试全失败），
   * 不算「本站还有活」—— 否则这一页会因为自己而永远关不掉。
   */
  accountId: string;
  /** 账号台账：队列里的 accountId 靠它归属到站点 */
  accounts: ReadonlyArray<{ id: string; siteId: string }>;
  /** 关页那一刻的队列快照（active + pending 一次读出，避免两次读之间的竞态） */
  queue: {
    pendingAccountIds: readonly string[];
    activeAccountId?: string;
  };
}

/**
 * @returns true  = 本站没有下一棒了，可以关这一页
 *          false = 本站还有 active/pending 的账号，页面留着
 */
export function shouldCloseTaskTabAfter(input: SiteCloseDecisionInput): boolean {
  const siteByAccount = new Map(input.accounts.map((account) => [account.id, account.siteId]));
  const queued = [...input.queue.pendingAccountIds];
  if (input.queue.activeAccountId) queued.push(input.queue.activeAccountId);

  return !queued.some((accountId) => (
    accountId !== input.accountId && siteByAccount.get(accountId) === input.siteId
  ));
}