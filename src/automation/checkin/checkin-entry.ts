import type { CheckinEntryConfig, CheckinEntryStep, SiteConfig } from '@/types';
import { isSameSiteUrl } from '@/lib/site/site-security';
import { clearClickBlocker } from '@/automation/shared/click-safety';
import { queryFirst, realClick, waitFor } from '@/automation/shared/dom-utils';
import type { StepLog } from '@/automation/shared/log';

export type CheckinEntryResult =
  | { status: 'ready' }
  | { status: 'navigate'; url: string }
  | { status: 'failed'; message: string; fallbackEligible?: boolean };

export interface CheckinEntryHooks {
  /** 每次入口点击前复用统一的人机验证检测。 */
  beforeAction?: () => Promise<boolean>;
}

const DEFAULT_STEP_TIMEOUT_MS = 10_000;
const DEFAULT_READY_TIMEOUT_MS = 12_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_ENTRY_STEPS = 8;

function timeout(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(MAX_TIMEOUT_MS, Math.max(0, Math.round(value!)));
}

function normalizedPath(pathname: string): string {
  return pathname.replace(/\/+$/, '') || '/';
}

function configuredTarget(site: SiteConfig): URL | null {
  const target = site.checkin?.url;
  if (!target || !isSameSiteUrl(site, target)) return null;
  try {
    return new URL(target, location.href);
  } catch {
    return null;
  }
}

function atTarget(target: URL | null): boolean {
  if (!target) return false;
  try {
    const current = new URL(location.href);
    return current.origin === target.origin
      && normalizedPath(current.pathname) === normalizedPath(target.pathname)
      && current.search === target.search
      && (!target.hash || current.hash === target.hash);
  } catch {
    return false;
  }
}

function fallback(
  site: SiteConfig,
  entry: CheckinEntryConfig,
  log: StepLog,
  reason: string,
): CheckinEntryResult {
  const target = configuredTarget(site);
  if (entry.fallbackToUrl !== false && target && !atTarget(target)) {
    log.push(`${reason}，回退到同源签到地址 ${target.pathname}${target.search}${target.hash}`);
    return { status: 'navigate', url: target.href };
  }
  return { status: 'failed', message: reason };
}

async function clickStep(
  site: SiteConfig,
  step: CheckinEntryStep,
  index: number,
  log: StepLog,
  hooks: CheckinEntryHooks,
): Promise<Extract<CheckinEntryResult, { status: 'failed' }> | null> {
  if (!step.selector?.trim()) {
    return { status: 'failed', message: `签到入口第 ${index + 1} 步缺少 selector` };
  }

  const stepTimeout = timeout(step.timeoutMs, DEFAULT_STEP_TIMEOUT_MS);
  // 页面重载/React 重绘后菜单可能已经展开；命中下一步等待条件时直接复用，
  // 避免再次点击头像把菜单关掉。
  if (step.waitFor?.trim() && queryFirst(step.waitFor)) return null;
  const initial = await waitFor<HTMLElement>(step.selector, stepTimeout);
  if (!initial) {
    return {
      status: 'failed',
      message: `签到入口第 ${index + 1} 步未找到控件: ${step.selector}`,
      // 只有第一步触发器根本不存在时才允许使用同源地址兜底。
      ...(index === 0 ? { fallbackEligible: true } : {}),
    };
  }

  if (hooks.beforeAction && !await hooks.beforeAction()) {
    return { status: 'failed', message: `签到入口第 ${index + 1} 步前的人机验证未完成` };
  }

  // 验证控件消失后 SPA 可能重绘页头，点击前必须按声明重新定位。
  const element = hooks.beforeAction
    ? await waitFor<HTMLElement>(step.selector, stepTimeout)
    : initial;
  if (!element) {
    return { status: 'failed', message: `完成人机验证后未找到签到入口控件: ${step.selector}` };
  }

  const blocker = await clearClickBlocker(element, site, log, '签到入口控件');
  if (blocker) {
    return { status: 'failed', message: `签到入口第 ${index + 1} 步仍被公告或遮罩挡住` };
  }

  try {
    await realClick(element, { mayNavigate: step.mayNavigate === true });
  } catch (error) {
    return {
      status: 'failed',
      message: `签到入口第 ${index + 1} 步点击失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  log.push(`已完成签到入口第 ${index + 1} 步`);

  if (step.waitFor?.trim() && !await waitFor(step.waitFor, stepTimeout)) {
    // 最后一步可能在 mouseReleased 时触发整页导航，旧页面来不及观察 readySelector。
    // 阶段已在点击前持久化，新文档会从 checkin 阶段重入并首先检查 readySelector。
    if (step.mayNavigate) {
      log.push(`签到入口第 ${index + 1} 步可能已触发整页导航，等待新页面继续`);
      // SPA 路由继续在当前文档等待；整页导航则由新 content script 从 checkin 阶段重入。
      return null;
    }
    return { status: 'failed', message: `签到入口第 ${index + 1} 步后未出现预期控件: ${step.waitFor}` };
  }
  return null;
}

/**
 * 通过声明式站内入口进入签到页，并等页面真实渲染完成。
 *
 * 调用方必须在执行前把任务阶段持久化为 checkin：最后一次点击可能触发整页
 * 导航，旧 content script 会被销毁，新页面需要从同一阶段继续。
 */
export async function prepareCheckinEntry(
  site: SiteConfig,
  log: StepLog,
  hooks: CheckinEntryHooks = {},
): Promise<CheckinEntryResult> {
  const entry = site.checkin?.entry;
  if (!entry) return { status: 'ready' };
  if (!entry.readySelector?.trim()) {
    return { status: 'failed', message: '签到入口缺少页面就绪选择器' };
  }
  if (!Array.isArray(entry.steps) || entry.steps.length === 0) {
    return { status: 'failed', message: '签到入口没有配置任何站内步骤' };
  }
  if (entry.steps.length > MAX_ENTRY_STEPS) {
    return { status: 'failed', message: `签到入口最多支持 ${MAX_ENTRY_STEPS} 个步骤` };
  }

  if (queryFirst(entry.readySelector)) return { status: 'ready' };

  const target = configuredTarget(site);
  if (atTarget(target)) {
    const ready = await waitFor(entry.readySelector, timeout(entry.readyTimeoutMs, DEFAULT_READY_TIMEOUT_MS));
    return ready
      ? { status: 'ready' }
      : { status: 'failed', message: `已进入签到页，但页面未完成渲染: ${entry.readySelector}` };
  }

  log.push('当前页需要通过站内用户菜单进入签到资料页');
  for (const [index, step] of entry.steps.entries()) {
    if (queryFirst(entry.readySelector)) return { status: 'ready' };
    const result = await clickStep(site, step, index, log, hooks);
    if (result) {
      return result.fallbackEligible
        ? fallback(site, entry, log, result.message)
        : result;
    }
  }

  const ready = await waitFor(entry.readySelector, timeout(entry.readyTimeoutMs, DEFAULT_READY_TIMEOUT_MS));
  if (ready) {
    log.push('签到资料页已就绪，开始核对账号');
    return { status: 'ready' };
  }
  // 入口步骤已经找到并执行过，不能再绕过站内导航直接请求受保护路由。
  return { status: 'failed', message: `站内入口已执行，但签到资料页未就绪: ${entry.readySelector}` };
}
