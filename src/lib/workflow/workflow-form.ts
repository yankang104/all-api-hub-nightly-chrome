import type { CheckinWorkflowConfig, CheckinWorkflowStep } from '@/types';

/**
 * 只替换工作流步骤，保留其它字段（尤其是学习到的 route）。
 *
 * 站点表单的步骤编辑路径原本直接构造 `{ steps }` 整体覆盖 workflow，
 * 于是 `route` 被静默抹掉：用户手动签到学到的页面路线，一进编辑界面改个步骤
 * 就没了，自动签到只剩 steps，再也找不到签到页。这类「看起来正常、实际丢数据」
 * 的 bug 很难从界面察觉，所以把合并逻辑抽成可测的纯函数。
 */
export function withWorkflowSteps(
  current: CheckinWorkflowConfig | undefined,
  steps: CheckinWorkflowStep[],
): CheckinWorkflowConfig {
  return { ...current, steps };
}

/**
 * 只替换学习路线，保留步骤。
 *
 * 与 `withWorkflowSteps` 对称：界面改路线时不能把用户辛苦配好的步骤冲掉。
 * 路线交给运行时逐页推进，因此任何一步的修改都必须原样落盘。
 */
export function withWorkflowRoute(
  current: CheckinWorkflowConfig | undefined,
  route: string[] | undefined,
): CheckinWorkflowConfig {
  const next: CheckinWorkflowConfig = { steps: current?.steps ?? [] };
  if (route && route.length > 0) next.route = route;
  return next;
}

/**
 * 从学习路线里删掉一页。
 *
 * 学习可能录进不该走的一页（典型是被重定向的登录页）。删掉后若路线为空，
 * 该字段整个消失 —— 运行时据此退回「只执行 steps」的老行为，而不是留一个
 * 空数组让校验器判失败。
 */
export function removeRoutePage(route: readonly string[], index: number): string[] {
  return route.filter((_, current) => current !== index);
}

/**
 * 把步骤描述成人话。
 *
 * 界面原本只显示裸选择器（`text=个人资料`、`button.checkin`），用户看完学到的流程
 * 也判断不出「扩展到底学会了什么」，只能感到「学得很垃圾」却不知道差在哪。
 * 描述只做展示，不参与执行，因此这里可以放心回落到选择器原文。
 */
export function describeWorkflowStep(step: CheckinWorkflowStep): string {
  switch (step.type) {
    case 'click': {
      const what = `「${selectorLabel(step.selector)}」`;
      // 手势与落点必须显示出来：用户排查「为什么它点的地方和我点的不一样」时，
      // 界面是唯一线索。缺省（普通单击、中心点）保持原有文案不变。
      const how = step.gesture === 'double'
        ? '双击'
        : step.gesture === 'right'
          ? '右键'
          : step.gesture === 'long-press'
            ? '长按'
            : step.key
              ? `按 ${step.key} 键触发`
              : '点击';
      const where = step.anchor
        ? `（落点 ${Math.round(step.anchor.rx * 100)}%, ${Math.round(step.anchor.ry * 100)}%）`
        : '';
      return `${how}${what}${where}`;
    }
    case 'fill': {
      // 下拉/勾选不是「填写内容」——如实说明，否则用户会以为扩展又填错了东西。
      if (step.control === 'select') return `在「${selectorLabel(step.selector)}」选择第 ${(step.choice ?? 0) + 1} 项`;
      if (step.control === 'checkbox' || step.control === 'radio') {
        return `${step.checked ? '勾选' : '取消勾选'}「${selectorLabel(step.selector)}」`;
      }
      return `在「${selectorLabel(step.selector)}」填写内容`;
    }
    case 'scroll': {
      const pct = Math.round(step.ratio * 100);
      const where = step.container ? `「${selectorLabel(step.container)}」滚动到 ${pct}%` : `页面滚动到 ${pct}%`;
      return where;
    }
    case 'drag':
      return `把「${selectorLabel(step.selector)}」拖到「${selectorLabel(step.toSelector)}」`;
    case 'navigate':
      return `进入页面 ${step.url}`;
    case 'wait':
      return step.selector ? `等待「${selectorLabel(step.selector)}」出现` : `等待 ${step.ms ?? 500} 毫秒`;
    case 'assert': {
      const what = step.selector ? `「${selectorLabel(step.selector)}」` : `文字 ${(step.text ?? []).join(' / ')}`;
      if (step.result === 'success') return `确认签到成功：${what}`;
      if (step.result === 'already') return `确认今日已完成：${what}`;
      return `检查 ${what}`;
    }
    case 'if': {
      const condition = step.condition.type === 'text'
        ? `页面出现 ${step.condition.words.join(' / ')}`
        : step.condition.type === 'selector'
          ? `存在「${selectorLabel(step.condition.selector)}」`
          : `路径匹配 ${step.condition.pattern}`;
      return `如果 ${condition}`;
    }
    case 'leilei-daily':
      return '执行一梦五千年的每日签到与抽奖';
    default:
      return '未知步骤';
  }
}

/** 学习模式主要产出 `text=可见文字` 形式的选择器，展示时剥掉语法。 */
function selectorLabel(selector: string): string {
  const trimmed = selector.trim();
  if (trimmed.startsWith('text=')) return trimmed.slice('text='.length).trim();
  return trimmed;
}
