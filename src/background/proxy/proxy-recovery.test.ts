import { describe, expect, it } from 'vitest';
import { shouldReclaimProxyLease } from '@/background/proxy/proxy-recovery';

/**
 * 冷启动回收租约的判据必须覆盖「已 acquire、还没 bindTab」的窗口。
 *
 * 真机取证：任务启动链是 acquire(代理) → taskState.start → bindTab 回填 tabId
 * → tabs.update(导航)。中间这段队列里的 active.tabId 仍是 0，而租约持有者
 * 已经是刚建好的任务页。旧判据只有 launchInFlight()，它带 60 秒上限；慢启动
 * 一超限，recover 就拿 [0] 去比对持有者 → 判僵尸 → clearProxy()。
 * 而 clear/set 会中止进行中的主框架导航 —— 任务页停在空白页、队列卡 busy，
 * 用户看到「签到一直转圈」，日志却写着「已启用扩展代理」。
 */
describe('冷启动是否允许回收代理租约', () => {
  it('active 还没绑到标签页时绝不回收（哪怕启动窗口已超时）', () => {
    // 超过 LAUNCH_GRACE_MS 后 launchInFlight 会变 false，这里正是旧实现的漏洞
    expect(shouldReclaimProxyLease({ activeTabId: 0, launchInFlight: false })).toBe(false);
  });

  it('队列自报启动中时不回收（保留既有防线）', () => {
    expect(shouldReclaimProxyLease({ activeTabId: 0, launchInFlight: true })).toBe(false);
    expect(shouldReclaimProxyLease({ activeTabId: 77, launchInFlight: true })).toBe(false);
  });

  it('有真实任务页且不在启动窗口时照常回收（僵尸租约仍要被清掉）', () => {
    expect(shouldReclaimProxyLease({ activeTabId: 77, launchInFlight: false })).toBe(true);
  });

  it('没有任务时照常回收', () => {
    expect(shouldReclaimProxyLease({ activeTabId: null, launchInFlight: false })).toBe(true);
    expect(shouldReclaimProxyLease({ launchInFlight: false })).toBe(true);
  });
});
