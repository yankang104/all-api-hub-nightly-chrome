import type { SiteConfig } from '@/types';

/**
 * 只有明确选择 workflow 才执行保存的流程。
 * auto 始终使用本站适配/页面自动识别，残留的旧 workflow（即使损坏）不改变执行方式。
 * 显式 workflow 的错误仍由校验器/回放器报告，不在已经开始点击后偷偷换策略。
 */
export function usesCheckinWorkflow(site: Pick<SiteConfig, 'checkin'>): boolean {
  return site.checkin?.method === 'workflow';
}

/**
 * 学习演示保存下来的「登录即签到」。
 *
 * 标记只在 method 仍为 none 时生效：用户之后在站点设置里改成别的方式，
 * 残留标记不再代表当前的签到策略。
 */
export function isLearnedLoginAsCheckin(site: Pick<SiteConfig, 'checkin'>): boolean {
  return site.checkin?.method === 'none' && site.checkin.learnedLoginAsCheckin === true;
}

/**
 * 签到由用户学到的流程拥有（回放步骤，或学到的登录即签到）。
 *
 * 这两类都不能被 API 直连签到或旧模板迁移替代：前者要执行浏览器 DOM 动作，
 * 后者的奖励由登录动作本身触发，直连签到接口会绕开它。
 */
export function usesLearnedCheckin(site: Pick<SiteConfig, 'checkin'>): boolean {
  return usesCheckinWorkflow(site) || isLearnedLoginAsCheckin(site);
}

/** 只有站点专用执行器才能完成的复合签到步骤（答题翻牌、抽奖等）。 */
const SITE_SPECIFIC_STEP_TYPES = new Set(['leilei-daily']);

/**
 * 本站签到是否由**专用复合流程**承担（模板写死的 leilei-daily 等）。
 *
 * 这类流程不是「点一下签到按钮」：VSLLM 要展开面板、答题、循环翻牌，一梦五千年
 * 要进抽奖页完成浮梦引光。只录到菜单/导航不能替换它；明确录到业务动作后，
 * 用户这次学到的流程才接管回放，不能被模板静默覆盖。
 */
export function usesSiteSpecificCheckin(site: Pick<SiteConfig, 'checkin'>): boolean {
  const steps = site.checkin?.workflow?.steps;
  if (!usesCheckinWorkflow(site) || !Array.isArray(steps)) return false;
  const containsSpecific = (list: readonly unknown[]): boolean => list.some((step) => {
    if (!step || typeof step !== 'object') return false;
    const record = step as { type?: unknown; then?: unknown; else?: unknown };
    if (typeof record.type === 'string' && SITE_SPECIFIC_STEP_TYPES.has(record.type)) return true;
    return (Array.isArray(record.then) && containsSpecific(record.then))
      || (Array.isArray(record.else) && containsSpecific(record.else));
  });
  return containsSpecific(steps);
}
