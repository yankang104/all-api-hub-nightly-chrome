import type { SiteConfig } from '@/types';
import { dismissAnnouncements } from '@/automation/shared/announcements';
import {
  describeElement,
  elementBlocking,
  sleep,
} from '@/automation/shared/dom-utils';
import type { StepLog } from '@/automation/shared/log';

/**
 * 点击前清理迟到的公告遮罩，并在清理后重新确认目标没有被挡住。
 *
 * 这条路径同时服务于内置签到策略和声明式 workflow。两者都使用
 * `realClick`，而 `realClick` 本身不会替调用方关闭站点公告；如果不在
 * 这里统一处理，workflow 很容易出现“日志说已点击、站点实际没收到交互”。
 */
export async function clearClickBlocker(
  element: HTMLElement,
  site: SiteConfig,
  log: StepLog,
  label = '签到控件',
): Promise<HTMLElement | null> {
  let blocker = elementBlocking(element);
  if (!blocker) return null;

  log.push(`${label}被 ${describeElement(blocker)} 遮挡，尝试关闭遮挡的公告`);
  // 只在这次遮挡清理的两轮间记住无效按钮；下次新弹出的公告仍可正常关闭。
  const cleanupState = {
    failedButtons: new Set<HTMLElement>(),
    escapedOverlays: new Set<HTMLElement>(),
  };
  // 弹窗可能正由 React 在下一帧挂载，或刚完成关闭动画。只在首次确认
  // 有遮挡时做最多两轮短清理，避免把无弹窗的常规点击拖慢。
  for (let attempt = 0; attempt < 2 && blocker; attempt += 1) {
    await dismissAnnouncements(site, log, { waitForAppear: false, blockedElement: element, cleanupState });
    if (!element.isConnected) {
      log.push('公告处理期间页面已重绘，需要重新定位操作控件');
      return null;
    }
    element.scrollIntoView({ block: 'center' });
    await sleep(attempt === 0 ? 250 : 450);
    blocker = elementBlocking(element);
  }
  if (!blocker) log.push('遮挡已清除，继续点击');
  return blocker;
}
