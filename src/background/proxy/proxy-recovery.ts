/**
 * 冷启动恢复是否允许回收全局代理租约。
 *
 * 背景（真机取证）：任务启动链是 acquire(代理) → taskState.start → bindTab 回填
 * active.tabId → tabs.update(导航)。在「acquire 已成功、bindTab 还没回填」这段里，
 * 队列里的 active.tabId 仍是 0，而 proxyLease 的持有者已经是刚建好的任务页。
 *
 * 旧判据只有 launchInFlight()，而它带 60 秒上限（LAUNCH_GRACE_MS）。慢启动
 * （首次连代理、headless 探测、系统卡顿）一旦超过这个上限，判据就失效，
 * recover 会拿 [0] 去比对持有者 → 判成僵尸 → clearProxy()。Chrome 的
 * clear/set 是网络栈重配置，会中止正在进行的主框架导航：任务页停在空白页、
 * 状态卡 running、队列一直 busy —— 用户看到「签到一直转圈」，日志却写着
 * 「已启用扩展代理」。
 *
 * 因此真正的判据是「这一轮启动有没有绑定过标签页」，它是**状态**而不是时间窗：
 * active.tabId <= 0 就说明启动链还持有租约，此时无从比对持有者，一律不回收。
 * 真死掉的启动不需要这里代劳 —— checkinQueue.recover() 会先把 unbound active
 * 判失败并清掉，走到这里时 active 已经是 undefined，租约照旧被回收。
 */
export function shouldReclaimProxyLease(state: {
  /** 队列当前 active 的标签页；undefined 表示没有任务在跑。 */
  activeTabId?: number | null;
  /** 队列自报的「启动窗口内」。保留它是为了不弱化既有防线。 */
  launchInFlight: boolean;
}): boolean {
  if (state.activeTabId != null && state.activeTabId <= 0) return false;
  if (state.launchInFlight) return false;
  return true;
}
