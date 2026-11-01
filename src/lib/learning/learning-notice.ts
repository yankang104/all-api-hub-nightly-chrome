/**
 * 「结束学习」之后带给管理页的**完整性自检结论**。
 *
 * 判定逻辑在 `automation/learning/learning-report.ts`（纯函数）。这里只负责
 * 把后台的响应（`learning.report` 优先，缺省回落 `learning.warnings`）翻译成
 * 组件能直接渲染的一段文案 —— 保存逻辑仍由 background 拥有，本文件不做任何判定。
 *
 * 隐私：只搬运固定文案，页面内容、选择器、输入值都不会经过这里。
 */
import type { LearningReportLine, LearningReportLineStatus, LearningReportVerdict } from '@/automation/learning/learning-report';
import type { LearningKind } from '@/types';

export interface LearningNotice {
  verdict: LearningReportVerdict;
  lines: LearningReportLine[];
}

/** 后台「结束学习」响应里与本提示相关的两个可选字段。 */
export interface LearningNoticeResponse {
  warnings?: readonly string[];
  report?: {
    verdict?: LearningReportVerdict;
    lines?: readonly LearningReportLine[];
  };
}

const VERDICT_LABEL: Record<LearningReportVerdict, string> = {
  complete: '完整性自检：已录全',
  partial: '完整性自检：可用，但有需要注意的地方',
  incomplete: '完整性自检：还差内容',
};

/** 结论文案（供 AccountRow 的标题与 App 的 toast 共用）。 */
export function learningNoticeTitle(verdict: LearningReportVerdict): string {
  return VERDICT_LABEL[verdict] ?? VERDICT_LABEL.incomplete;
}

function isStatus(value: unknown): value is LearningReportLineStatus {
  return value === 'ok' || value === 'warn' || value === 'missing';
}

function isVerdict(value: unknown): value is LearningReportVerdict {
  return value === 'complete' || value === 'partial' || value === 'incomplete';
}

/**
 * 响应 → 可渲染的提示；两个字段都没有时返回 null（那就什么都不显示，
 * 不猜、不编一句「已保存成功」）。
 */
export function learningNoticeFromResponse(response: LearningNoticeResponse | undefined): LearningNotice | null {
  if (!response) return null;
  const lines = (response.report?.lines ?? [])
    .filter((line) => !!line && typeof line.text === 'string' && isStatus(line.status));
  if (isVerdict(response.report?.verdict) && lines.length > 0) {
    return { verdict: response.report.verdict, lines };
  }
  const warnings = (response.warnings ?? []).filter((text) => typeof text === 'string' && text.trim().length > 0);
  if (warnings.length === 0) return null;
  // 只有 warnings 时一律按「需要留意」呈现：这一侧拿不到判定依据，不替后台下结论。
  return { verdict: 'partial', lines: warnings.map((text) => ({ status: 'warn' as const, text })) };
}

/** 一行总结，给 toast 用。 */
export function learningNoticeSummary(notice: LearningNotice | null): string | null {
  if (!notice) return null;
  const first = notice.lines[0]?.text;
  return first ? `${learningNoticeTitle(notice.verdict)}：${first}` : learningNoticeTitle(notice.verdict);
}
/**
 * 「已保存」toast 文案。
 *
 * 与完整性自检分开写：前面那句说明保存了什么，后面那句是自检的最关键一条。
 * 没有自检结论时（后台这轮还没给出结论）就只说保存本身，不编结论。
 */
/**
 * 「部分学会」的 toast 文案：这一轮演示只够保存其中一半。
 *
 * 融合学习的演示经常只完成一半（先登录、还没来得及签到；或本来就在登录态、
 * 只有签到步骤值得更新）。这时**如实说明存了什么、缺什么、下一步该做什么**，
 * 既不谎报「已保存完整流程」，也不把已学到的另一半丢掉。
 */
export function learningPartialSaveToast(
  saved: ReadonlyArray<'login' | 'checkin'>,
  eventCount: number,
  notices: readonly string[],
): string {
  const what = saved.includes('login') && saved.includes('checkin')
    ? '登录配置与签到流程'
    : saved.includes('login')
      ? '登录配置'
      : saved.includes('checkin')
        ? '签到流程'
        : '任何配置';
  const head = saved.length > 0
    ? `已保存本站${what}（录到 ${eventCount} 个事件）`
    : `本次没有保存任何配置（录到 ${eventCount} 个事件）`;
  const tail = notices.map((line) => line.trim()).filter(Boolean).join('；');
  return tail ? `${head}，但这次演示没录全：${tail}` : head;
}

export function learningSaveToast(
  kind: LearningKind,
  eventCount: number,
  notice: LearningNotice | null,
): string {
  const summary = learningNoticeSummary(notice);
  const tail = summary ? `.${summary}` : '';
  // 融合学习（一次演示同时产出登录配置与签到流程）如实说明两边都保存了。
  if (kind === 'both') {
    return `已保存本站登录与签到流程（录到 ${eventCount} 个事件）：以后先自动登录，核对当前账号后再回放签到步骤${tail}`;
  }
  return kind === 'login'
    ? `已保存本站通用登录流程（录到 ${eventCount} 个事件）：以后自动按学习到的入口和字段登录${tail}`
    : `已保存本站签到流程（录到 ${eventCount} 个事件）：以后先自动登录，核对当前账号后再回放签到步骤${tail}`;
}

/**
 * 「这次学习到底算不算完整」的唯一判定入口。
 *
 * 为什么必须单独成函数：曾经的判据是后台的兼容字段 kind，而它是按
 * **实际存下了什么**反推的 —— 融合学习只存下登录时它也回 'login'，与
 * 「用户本来就只点学习登录」完全同形。界面据此会把「学了一半」渲染成
 * 「登录与签到流程都已学会」，用户直到自动签到失败才发现签到流程根本不存在。
 *
 * 现在按**意图**判定：意图是 'both' 就必须两份都真的落盘才算完整；
 * 缺哪份都由调用方走「部分保存」文案如实说明。旧后台没有 intent 时
 * 回落用 kind 推断意图（kind 为 'login' 视为只学登录），保持向后兼容。
 */
export function learningOutcome(response: {
  intent?: 'login' | 'both';
  kind?: LearningKind;
  savedKinds?: ReadonlyArray<'login' | 'checkin'>;
}): {
  intent: 'login' | 'both';
  saved: Array<'login' | 'checkin'>;
  savedLogin: boolean;
  savedCheckin: boolean;
  complete: boolean;
} {
  const saved = [...(response.savedKinds ?? [])];
  const intent = response.intent ?? (response.kind === 'login' ? 'login' : 'both');
  const savedLogin = saved.includes('login');
  const savedCheckin = saved.includes('checkin');
  return {
    intent,
    saved,
    savedLogin,
    savedCheckin,
    complete: intent === 'login' ? savedLogin : savedLogin && savedCheckin,
  };
}

/** 保存成功后的 toast 文案：按**实际**保存的产物说，不按意图说。 */
export function learningSavedToastText(response: {
  intent?: 'login' | 'both';
  kind?: LearningKind;
  savedKinds?: ReadonlyArray<'login' | 'checkin'>;
  /**
   * 签到那一半的落盘形态（见 lib/messages/learning.ts）。
   *
   * `login-as-checkin` 时说明这次学的是「登录成功即算签到」：以后不会再去页面上
   * 找签到按钮。缺省时按普通流程说明，绝不替后台猜它存的是哪种。
   */
  checkinSavedAs?: 'workflow' | 'login-as-checkin';
  eventCount: number;
  warnings?: readonly string[];
  report?: { verdict?: LearningReportVerdict; lines?: readonly LearningReportLine[] };
}): string {
  const outcome = learningOutcome(response);
  const report = learningNoticeFromResponse(response);
  /**
   * 报告与允许清单的区别必须说清楚：
   * - 有 `report.verdict` 时它才是唯一判据（账号行渲染的也是它）—— 同一份
   *   后台结论不能在这处被 `savedKinds` 覆盖，否则 toast 会说账号行相反的话；
   * - 没有 report 时才回落到 `savedKinds` —— 那是对旧后台的兼容，不是新判据。
   *
   * 「登录即签到」还要额外认 `checkinSavedAs`：报告 `complete` 只代表这次
   * 演示录全了，不代表保存形态；形态由后台落盘时写成 `login-as-checkin` 才确认。
   */
  const verdict: LearningReportVerdict = report?.verdict ?? (outcome.complete ? 'complete' : 'incomplete');
  /**
   * 「登录即签到」的成功文案优先认落盘形态（`checkinSavedAs`），而不是再拿
   * `savedKinds` 推一遍。只要后台读回确认写成了 `login-as-checkin`，这就已经是
   * 一张完整产物；报告给 warn 只意味着「本场没录到登录动作、运行时可能需人工
   * 确认」，不是「没录全」。但报告给 incomplete（例如另一半保存失败）时不能
   * 用成功句把缺失盖过去 —— 仍走下面按 verdict 分档的「没录全」。
   */
  if (verdict !== 'incomplete' && response.checkinSavedAs === 'login-as-checkin' && outcome.savedCheckin) {
    const tail = report ? learningNoticeSummary(report) : null;
    const suffix = tail ? `。${tail}` : '';
    return `已保存本站「登录即签到」流程（录到 ${response.eventCount} 个事件）：以后自动登录成功后即视为完成签到，不再寻找签到按钮${suffix}`;
  }
  if (verdict === 'complete') {
    const toastKind: LearningKind = outcome.savedLogin && outcome.savedCheckin
      ? 'both'
      : (outcome.savedCheckin ? 'checkin' : 'login');
    return learningSaveToast(toastKind, response.eventCount, report);
  }
  /**
   * `partial` 的语义是「已保存的内容可用，但有需要注意的地方」——它与账号行
   * 的 warn 行同调；`incomplete` 才是「没录全」。二者必须走不同文案，否则
   * 「有一半没录到」与「录到了但要留意」又会混成一句话。
   */
  if (verdict === 'partial') {
    const savedText = learningPartialSaveToast(outcome.saved, response.eventCount, response.warnings ?? []);
    return savedText.includes('没录全') ? savedText : `${savedText}，但这次演示有需要注意的地方：${report?.lines.map((line) => line.text).join('；') ?? ''}`;
  }
  return learningPartialSaveToast(outcome.saved, response.eventCount, response.warnings ?? []);
}
