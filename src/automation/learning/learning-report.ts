/**
 * 结束学习时的**完整性自检**（纯函数）。
 *
 * 「保存逻辑」由 background 负责；这里只回答一个问题：**这一遍演示到底录全了没有**，
 * 以及没录全时缺的是什么。判定只读事件，缺什么就说什么 ——
 * 宁可提示「没录到签到成功证据」（当天已签到、或没点到真正的按钮），
 * 也不把「点到了」当成「签到了」。
 *
 * 报告文案全是固定字符串（例外只有命中的**固定词表**里的词，见 `safeWords`）：
 * 页面文字、输入值、选择器一律不进报告，管理页也就不会成为新的泄漏面。
 */
import type { LearningKind, SiteConfig, WorkflowLearningEvent } from '@/types';
import {
  analyzeLearningEvents,
  checkinEvidenceOf,
  isAuthLearningPath,
  isInteractiveCheckinLearningPath,
  isLogoutLearningEvent,
  learningPageSequence,
  type LearningAnalysis,
} from './learning-stage';
import {
  SUCCESS_WORDS as SHARED_SUCCESS_WORDS,
  ALREADY_WORDS as SHARED_ALREADY_WORDS,
  LOTTERY_SUCCESS_WORDS,
  LOTTERY_ALREADY_WORDS,
} from '@/automation/checkin/checkin-vocab';

/** 报告的三档结论：录全了 / 能用但缺证据 / 还不能用。 */
export type LearningReportVerdict = 'complete' | 'partial' | 'incomplete';
export type LearningReportLineStatus = 'ok' | 'warn' | 'missing';

export interface LearningReportLine {
  status: LearningReportLineStatus;
  text: string;
}

export interface LearningReport {
  verdict: LearningReportVerdict;
  lines: LearningReportLine[];
  /** 一行总结，给 toast 用 */
  summary: string;
  /**
   * 只含固定文案的提示，可直接放进 background 的 `learning.warnings` /
   * `learning.report`，由管理页原样呈现。
   */
  warnings: string[];
}

/**
 * 报告行的前缀标记（`warnings` 要脱掉它们，给别的界面复用）。
 *
 * `⚠` 与 `ℹ` 后面跟着变体选择符 `\uFE0F`（`⚠️` 实际是两个码位）：只把 `⚠` 写进
 * 字符类，会把变体选择符留在字符串开头，`warnings` 里就带上了一个看不见的怪字符。
 * 这里按完整序列匹配。
 */
const REPORT_PREFIX = /^(?:\u26A0\uFE0F|\u2139\uFE0F|\u274C|\u26A0|\u2139)\s*/u;

/** 只允许固定词表里的词进报告：事件可能来自旧版本或被伪造，不能让任意文本借报告进界面。 */
const SUCCESS_WORDS = [...SHARED_SUCCESS_WORDS, ...LOTTERY_SUCCESS_WORDS];
const ALREADY_WORDS = [...SHARED_ALREADY_WORDS, ...LOTTERY_ALREADY_WORDS];

function safeWords(words: readonly string[] | undefined, allowed: readonly string[]): string[] {
  if (!Array.isArray(words)) return [];
  return words.filter((word) => typeof word === 'string' && allowed.includes(word));
}

function evidenceWords(events: readonly WorkflowLearningEvent[], level: 'success' | 'already'): string[] {
  const allowed = level === 'success' ? SUCCESS_WORDS : ALREADY_WORDS;
  const words = new Set<string>();
  for (const event of events) {
    const evidence = event.type === 'click' ? event.evidence : undefined;
    if (evidence?.kind !== level) continue;
    for (const word of safeWords(evidence.words, allowed)) words.add(word);
  }
  return [...words];
}

/** 录到过页面上的签到结果提示吗（成功 / 今日已完成都算）？ */
export function hasCheckinResultEvidence(events: readonly WorkflowLearningEvent[]): boolean {
  return events.some((event) => {
    const level = checkinEvidenceOf(event);
    return level === 'confirmed' || level === 'already';
  });
}

/** 是否在认证页上留下过输入（签到学习里账密字段不带 fieldRole，只能按页面判定）。 */
function typedOnAuthPage(events: readonly WorkflowLearningEvent[]): boolean {
  return events.some((event) => {
    if (event.type !== 'fill' || !event.hasValue) return false;
    const path = (event as { path?: unknown }).path;
    return typeof path === 'string' && isAuthLearningPath(path);
  });
}

/** 登录学习：学到了哪几种字段（只看角色，绝不看输入值）。 */
function loginSelectorKinds(events: readonly WorkflowLearningEvent[]) {
  return {
    username: events.some((event) => event.type === 'fill' && event.fieldRole === 'username'),
    password: events.some((event) => event.type === 'fill' && event.fieldRole === 'password'),
  };
}

function logoutLine(): LearningReportLine {
  return {
    status: 'warn',
    text: '⚠️ 这次演示点了「退出登录」：会话已经断开，建议重新演示一遍',
  };
}

/** 登录学习（kind === 'login'）的报告行。 */
function loginKindLines(events: readonly WorkflowLearningEvent[]): LearningReportLine[] {
  const selectors = loginSelectorKinds(events);
  const oauth = events.some((event) => event.type === 'click' && event.loginAction === 'oauth');
  if (selectors.username && selectors.password) {
    return [{ status: 'ok', text: '✅ 登录配置已学会（表单：用户名/密码已识别）' }];
  }
  if (oauth) {
    return [{ status: 'ok', text: '✅ 登录配置已学会（第三方登录入口已识别）' }];
  }
  if (selectors.username || selectors.password) {
    return [{
      status: 'warn',
      text: '⚠️ 只录到其中一个字段：账号或密码字段没被识别，自动登录可能填不全',
    }];
  }
  return [{ status: 'missing', text: '⚠️ 没有录到登录动作（账号/密码字段或第三方登录入口）' }];
}

/**
 * 签到学习（kind === 'checkin'）的第一行：融合学习里的「登录部分」。
 *
 * 这里刻意不照抄登录学习的结论：签到学习里看不出字段角色，只能说
 * 「在登录页上录到了输入动作、并且进到了站内页面」。
 */
function fusedLoginLine(events: readonly WorkflowLearningEvent[], analysis: LearningAnalysis): LearningReportLine {
  if (analysis.credentials && analysis.signedIn) {
    return { status: 'ok', text: '✅ 登录配置已学会（表单：在登录页录到了账号/密码输入，并成功进入站内页面）' };
  }
  if (analysis.credentials) {
    return {
      status: 'warn',
      text: '⚠️ 登录部分可能学不全：只看到登录页上的输入，没看到登录成功（离开登录页）',
    };
  }
  return {
    status: 'ok',
    text: 'ℹ️ 本次没有录到登录步骤（开始学习时可能已经是登录状态），只更新签到流程',
  };
}

/** 签到结果那一行（成功 / 今日已完成 / 没证据）。 */
function checkinEvidenceLine(
  events: readonly WorkflowLearningEvent[],
  analysis: LearningAnalysis,
): LearningReportLine | null {
  if (analysis.checkin === 'none') return null;
  const success = evidenceWords(events, 'success');
  if (success.length > 0) {
    return { status: 'ok', text: `✅ 已录到「签到成功」证据（词：${success.join('、')}）` };
  }
  if (evidenceWords(events, 'already').length > 0 || analysis.checkin === 'already') {
    return { status: 'warn', text: '⚠️ 页面显示今天已经签到：这遍录到的流程按「已完成」处理' };
  }
  if (hasCheckinResultEvidence(events)) {
    return { status: 'ok', text: '✅ 已录到页面的签到结果提示' };
  }
  return {
    status: 'warn',
    text: '⚠️ 没有录到「签到成功」证据 —— 可能是当天已签到，或你没点到真正的签到按钮',
  };
}

export interface LearningReportOptions {
  /**
   * 这次学习**确实有产物试图落盘但失败**（写入异常 / 读回不一致 / 流程校验不通过）。
   *
   * 报告只读事件流时看到的是「演示录全了」，但用户实际拿到的站点配置可能缺了一半。
   * 传 true 时 finalize 会追加一条 missing 行，把结论钳到 incomplete —— 宁可说
   * 「还差内容」，也不因为事件流完整就报 complete。
   */
  saveFailed?: boolean;
  /**
   * 用户明确声明「本站是登录即签到」，并按它保存了签到那一半。
   *
   * 这不是自动推断：正常演示里「没点到签到按钮」与「站点没有签到按钮」在事件流里
   * 长得一样（见 learning-stage.ts 的 loginAsCheckinAvailable）。只有用户点了
   * 「登录即签到」按钮，后台才会带着这个选项生成报告。
   */
  loginAsCheckin?: boolean;
  /**
   * 站点上**已经**有一份可回放的登录配置（本次演示之前就存在，或已由这次学到的
   * 登录配置补上）。
   *
   * 「登录即签到」在运行时是「先登录、登录成功即算签到」：只要站点上有可用的
   * 登录配置，即使这次演示是「开始学习时已经登录」、没有录到任何登录动作，
   * 保存下来的流程依然完整可执行。判据见 `siteHasStoredLoginConfig`。
   */
  hasStoredLoginConfig?: boolean;
  /**
   * 站点**当前**配置的签到方式（`SiteConfig.checkin.method`）。
   *
   * 为什么报告必须知道它：站点本来就是「登录即签到」（`method === 'none'`，
   * 页面上根本没有签到按钮）时，演示里当然录不到签到动作 —— 那是站点的正常形态，
   * 不是「还差内容」。旧实现只看事件流，于是这类站点每次结束学习都被判
   * 「❌ 没有录到签到动作」，用户被要求去做一件页面上不存在的事。
   *
   * 只认显式的 `'none'`：其余取值（含 undefined）保持原有判据不变。
   */
  siteCheckinMethod?: string;
}

/** 「登录即签到」保存成功后的结论行（固定文案）。 */
const LOGIN_AS_CHECKIN_OK = '✅ 已按「登录即签到」学会：本站登录成功后即算签到，不需要点签到按钮';
const LOGIN_AS_CHECKIN_MISSING_CONFIG = '❌ 「登录即签到」未保存：没有录到登录配置';
const LOGIN_AS_CHECKIN_MISSING_SUCCESS = '⚠️ 「登录即签到」未保存：已录到登录配置，但没有确认成功进入站内页面';
/**
 * 本场没有录到**登录动作**（打开时已登录）时的结论。
 *
 * 保存照旧（站点上本来就有一份可用登录配置），但必须如实说明运行时的真实表现：
 * `none` 只有在**本轮确实完成登录**时才把「当前页没有签到控件」当作成功；浏览器
 * 打开时就是登录态的那条路径不会强制重登，会返回 `unverified` 并停下标「需处理」。
 * 想每轮都强制退出重登，只能把本站签到方式改成 `relogin`。
 *
 * 这句文案曾经承诺「自动签到时会先重新登录再确认」—— 运行时并不存在这个行为，
 * 用户照着它等一次永远不会发生的重登，保存提示就成了谎报。
 */
const LOGIN_AS_CHECKIN_NO_LOGIN_THIS_RUN = '⚠️ 已按「登录即签到」保存：本次没录到登录动作（可能打开时已登录）；运行时若已登录，无法证明本轮登录拿到奖励，会停在「需处理」而不记成功；要每轮强制退出重登，请把本站签到方式改成「退出再登录」';

/**
 * 站点上是否**已经**有一份可回放的登录配置。
 *
 * 判据与站点校验器的登录部分同一口径：oauth/github/passkey/token 不依赖账密
 * 表单；表单方式要求用户名/密码/登录按钮三个选择器齐全。它只回答「登录这一步
 * 跑不跑得起来」，不涉及签到配置。
 */
export function siteHasStoredLoginConfig(
  site: Pick<SiteConfig, 'loginMethod' | 'selectors'>,
  accountLoginMethod?: string,
): boolean {
  // 账号级登录方式与站点级同一优先级语义（账号覆盖优先于站点，见
  // resolveEffectiveMethods）：账号显式配了非表单方式时，登录不依赖账密表单。
  if (accountLoginMethod && accountLoginMethod !== 'form' && accountLoginMethod !== 'auto') return true;
  const method = site.loginMethod ?? 'form';
  if (method !== 'form') return true;
  return Boolean(
    site.selectors?.username?.trim()
    && site.selectors?.password?.trim()
    && site.selectors?.submit?.trim(),
  );
}

function loginAsCheckinLine(analysis: LearningAnalysis, hasStoredLoginConfig: boolean): LearningReportLine {
  // 显式选项不能替代登录能力：本场录到了登录动作，或站点上已经有一份可用登录
  // 配置（「开始学习时已经登录」的演示正是后者），二者居其一即可。之后还要看到
  // 离开认证页进入站内业务页面，才能把「登录即签到」保存成完整流程。
  if (!analysis.credentials && !analysis.login && !hasStoredLoginConfig) {
    return { status: 'missing', text: LOGIN_AS_CHECKIN_MISSING_CONFIG };
  }
  if (!analysis.signedIn) {
    return { status: 'warn', text: LOGIN_AS_CHECKIN_MISSING_SUCCESS };
  }
  /**
   * 「本场完全没有登录动作」时不能报「已录全」。
   *
   * 判据是「既没有登录动作（提交/OAuth），也没有在认证页录到过凭据输入」——
   * 只要用户填过账号密码并进到了站内页，就说明这次演示确实走过登录（凭据 +
   * 站内页已经是证据），那种情况仍按 ok 处理。
   *
   * 运行时的 `none` 只有在**本轮确实完成登录**（`loginHappenedThisRun`）时才把
   * 「当前页没有签到控件」当作成功；打开时已登录的那条路径会返回 `unverified`
   * 并转成「需要人工处理」。报告若在这里说「可以放心使用」，用户就会看到一个
   * 自相矛盾的结论：学习页说学会了，第二天自动签到却提示需要人工确认。
   *
   * 因此本场没录到登录动作时只给 warn（可用但需留意），并说清为什么。这**不**
   * 影响保存：产物照样落盘（登录配置可能站点上早就有了），只是结论更诚实。
   */
  if (!analysis.login && !analysis.credentials) {
    return { status: 'warn', text: LOGIN_AS_CHECKIN_NO_LOGIN_THIS_RUN };
  }
  return { status: 'ok', text: LOGIN_AS_CHECKIN_OK };
}

/**
 * 「没录到签到动作」时的替代出口提示。
 *
 * 只在这份演示**满足**登录即签到的保守判据（登录已生效、没点过退出登录、也没录到
 * 签到动作）时追加：给用户一条可执行的下一步，而不是一句干巴巴的「没有录到」。
 */
const LOGIN_AS_CHECKIN_SUGGESTION = 'ℹ️ 若本站是「登录即签到」（登录成功后自动完成、页面上没有签到按钮）：开始学习并完成登录后，在账号行点「登录即签到」即可保存完整流程';

/**
 * 站点已是「登录即签到」时的结论行。
 *
 * 与 `LOGIN_AS_CHECKIN_OK` 的区别：那条是**这次学习刚刚把它设成**登录即签到；
 * 这条是站点当前配置本来就是它，用户没有（也不需要）做任何额外操作。
 */
const LOGIN_AS_CHECKIN_ALREADY_CONFIGURED = '✅ 本站签到方式为「登录即签到」：登录成功即算完成，页面上没有签到按钮属于正常情况';

/**
 * 生成完整性报告。
 *
 * 三种结论：
 * - `complete`：登录配置与签到流程都学到，且录到了签到结果证据；
 * - `partial`：流程本身能学（有登录线索、有签到动作），但缺证据 ——
 *   典型是当天已签到，或点到的不是真正的签到按钮；
 * - `incomplete`：还没有可保存的内容（没有签到动作，或没有登录动作）。
 */
export function buildLearningReport(
  events: readonly WorkflowLearningEvent[],
  kind: LearningKind,
  options: LearningReportOptions = {},
): LearningReport {
  const analysis = analyzeLearningEvents(events, kind);
  const lines: LearningReportLine[] = [];
  const interactivePageSeen = events.some((event) => isInteractiveCheckinLearningPath(event.path));

  // 融合学习（'both'）与 'checkin' 一样，一次演示同时产出登录配置与签到流程。
  if (kind === 'login') {
    lines.push(...loginKindLines(events));
  } else {
    lines.push(fusedLoginLine(events, analysis));
    if (options.loginAsCheckin) {
      lines.push(loginAsCheckinLine(analysis, options.hasStoredLoginConfig === true));
    } else if (options.siteCheckinMethod === 'none' && analysis.checkin === 'none' && !interactivePageSeen) {
      /**
       * 站点本来就是「登录即签到」：演示里录不到签到动作是**符合预期**的，
       * 不能判成「❌ 没有录到签到动作」——那会让用户去找一个页面上
       * 根本不存在的按钮。这里给出明确的 ok 结论，说明这种形态是正常的。
       */
      lines.push({ status: 'ok', text: LOGIN_AS_CHECKIN_ALREADY_CONFIGURED });
    } else if (analysis.checkin === 'none') {
      lines.push({
        status: 'missing',
        text: interactivePageSeen
          ? '❌ 没有录到签到动作（抽奖站需要演示实际抽奖，只有进入页面不算学会）'
          : '❌ 没有录到签到动作（没有点到签到/领取按钮）',
      });
      if (analysis.loginAsCheckinAvailable) lines.push({ status: 'warn', text: LOGIN_AS_CHECKIN_SUGGESTION });
    } else {
      const pages = learningPageSequence(events).length;
      lines.push({ status: 'ok', text: `✅ 签到流程已学会（经过 ${pages} 个页面、${analysis.actions} 个动作）` });
      const evidenceLine = checkinEvidenceLine(events, analysis);
      if (evidenceLine) lines.push(evidenceLine);
    }
  }

  if (analysis.logout) lines.push(logoutLine());
  return finalize(lines, kind, options);
}

function verdictOf(lines: readonly LearningReportLine[]): LearningReportVerdict {
  if (lines.some((line) => line.status === 'missing')) return 'incomplete';
  if (lines.some((line) => line.status === 'warn')) return 'partial';
  return 'complete';
}

function finalize(lines: LearningReportLine[], kind: LearningKind, options: LearningReportOptions = {}): LearningReport {
  // 有产物试图落盘但失败：即使事件流看起来完整，也把结论钳到 incomplete。
  if (options.saveFailed === true) {
    lines.push({ status: 'missing', text: '❌ 有内容没能保存成功，本次结论按「还差内容」处理' });
  }
  const verdict = verdictOf(lines);
  const summary = verdict === 'complete'
    ? options.loginAsCheckin
      ? '已按「登录即签到」学会，可以放心使用'
      : (kind === 'login' ? '登录配置已学会，可以放心使用' : '登录配置与签到流程都已学会')
    : verdict === 'partial'
      ? '已学会的内容可用，但有需要留意的地方'
      : '这次演示还不够，先别指望它自动签到';
  const warnings = lines
    .filter((line) => line.status !== 'ok')
    .map((line) => line.text.replace(REPORT_PREFIX, ''));
  return { verdict, lines, summary, warnings };
}
