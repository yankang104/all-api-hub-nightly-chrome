import type {
  CheckinWorkflowCondition,
  CheckinWorkflowConfig,
  CheckinWorkflowStep,
  SiteConfig,
} from '@/types';
import { isSameSiteUrl } from '@/lib/site/site-security';
import { clearClickBlocker } from '@/automation/shared/click-safety';
import { dismissAnnouncements } from '@/automation/shared/announcements';
import {
  isVisible,
  queryAll,
  queryFirst,
  realClick,
  fillEditable,
  isFillable,
  selectorVisibleText,
  sleep,
  waitFor,
} from '@/automation/shared/dom-utils';
import * as domUtils from '@/automation/shared/dom-utils';
import type {
  WorkflowElementFingerprint,
  WorkflowGesture,
  WorkflowKey,
  WorkflowPointerAnchor,
} from '@/types/workflow';
import type { StepLog } from '@/automation/shared/log';
import { runLeileiDaily } from '@/automation/sites/leilei-daily';
import { hasObjectiveChallengeEvidence } from '@/automation/challenge/challenge';
import { readWorkflowOutcomeEvidence, readWorkflowOutcomeEvidenceIn, settleWorkflowOutcome } from '@/automation/learning/workflow-outcome';
import {
  ALREADY_WORDS,
  LOTTERY_ALREADY_WORDS,
  LEARNING_LOTTERY_ACTION,
  CHECKIN_ACTION,
  NON_ACTION_WORDS,
  checkinControls,
  controlDisabled,
  controlText,
} from '@/automation/checkin/checkin-vocab';
import { isKnownBusinessLearningPath } from './learning-paths';
import { usesCheckinWorkflow } from '@/lib/checkin/learned-checkin';

/** 当前 DOM 中的签到控件快照；布局可见不要求已处于视口内。 */
export type CheckinSnapshotVerdict =
  | { kind: 'action'; element: HTMLElement; label: string }
  | { kind: 'already'; words: string[] }
  | { kind: 'ambiguous'; count: number }
  | { kind: 'none' };

function isCheckinCommand(element: HTMLElement): boolean {
  const text = controlText(element);
  if (!CHECKIN_ACTION.test(text) || NON_ACTION_WORDS.test(text)
    || /帮助|教程|演示|示例|预览|前往|进入|查看|去签到|help|tutorial|demo|preview/i.test(text)) return false;
  if (element.closest('nav, [role="navigation"], [role="menu"], [role="menubar"], [role="tablist"]')
    || element.matches('[role="menuitem"], [role="tab"], [role="link"], [aria-expanded]')
    || (element.hasAttribute('aria-haspopup') && element.getAttribute('aria-haspopup') !== 'false')) return false;
  if (element.closest('form')?.querySelector('input[type="password"]')) return false;
  // 快照替代的是动作按钮，不能把同名导航链接或外层按钮包装容器当成签到动作。
  if (element.matches('a[href]')) {
    try {
      const target = new URL(element.getAttribute('href')!, location.href);
      if (target.origin !== location.origin || target.pathname !== location.pathname
        || target.search !== location.search || (target.hash && target.hash !== location.hash)) return false;
    } catch { return false; }
  }
  const commandScope = 'button, a[href], input[type="button"], input[type="submit"], [role="button"], [onclick]';
  if (element.closest(commandScope) && element.closest(commandScope) !== element) return false;
  if (element.querySelector(commandScope)) return false;
  return element.matches(commandScope) || getComputedStyle(element).cursor === 'pointer';
}

export function snapshotCheckinControls(
  root: ParentNode = document,
  fingerprint?: WorkflowElementFingerprint,
): CheckinSnapshotVerdict {
  const controls = checkinControls(root).filter((element) => isCheckinCommand(element)
    // 文案可变，其余已记录字段不能因为语义回退而被忽略。
    && (!fingerprint || fingerprintMismatch({ ...fingerprint, text: undefined }, element) === null));
  const completedWords = (element: HTMLElement): string[] => {
    const text = controlText(element).toLowerCase();
    return ALREADY_WORDS.filter((word) => text.includes(word.toLowerCase()));
  };
  const actions = controls.filter((element) => !controlDisabled(element)
    && completedWords(element).length === 0 && element.getAttribute('aria-busy') !== 'true'
    && !/签到中|打卡中|领取中|checking|claiming|processing/i.test(controlText(element)));
  if (actions.length === 1) {
    const element = actions[0]!;
    return { kind: 'action', element, label: controlText(element).slice(0, 60) };
  }
  if (actions.length > 1) return { kind: 'ambiguous', count: actions.length };
  // 禁用只表明不能点击；必须同时有明确完成文案，不能把「签到中」误报为已签到。
  const completed = controls.filter((element) => controlDisabled(element) && completedWords(element).length > 0);
  if (completed.length === 1) return { kind: 'already', words: completedWords(completed[0]!) };
  if (completed.length > 1) return { kind: 'ambiguous', count: completed.length };
  return { kind: 'none' };
}

/**
 * 这一步是不是「签到动作本身」？
 *
 * 只看步骤录到的文案（label 优先，缺省退回到选择器里的 `text=` 部分）：站点改写
 * 过文案时 `label` 仍是学习那一刻的可见文字，比结构路径更接近语义。判据与
 * `checkin-vocab` 的 `CHECKIN_ACTION` / `NON_ACTION_WORDS` 同一口径，避免这里
 * 再写一份「什么算签到」。
 *
 * 为什么必须判定：页面控件快照是「用页面现状替代失效选择器」的兜底，只能用在
 * 签到动作上。中间页的 `text=Y`、`text=个人资料` 被它劫持，就会变成「本该点菜单，
 * 结果点了签到按钮」，比原来的「找不到」更糟。
 */
function isCheckinActionStep(step: Extract<CheckinWorkflowStep, { type: 'click' }>): boolean {
  if ((step.gesture && step.gesture !== 'click') || (step.key && !['Enter', 'Space'].includes(step.key))) return false;
  /**
   * 文案来源按可靠度排列：`text=` 选择器里的文字 → 指纹里的可见文字。
   *
   * 结构路径（`#root > div:nth-of-type(2) > …`）读不出语义，指纹里的 text 是学习
   * 那一刻真实录到的可见文案，回退顺序与学习侧 `learningLabel` 同一思路。
   */
  const fromSelector = /text=(.+)$/i.exec(step.selector.trim())?.[1]?.trim();
  const text = fromSelector || step.fingerprint?.text?.trim() || '';
  if (!text) return false;
  if (!CHECKIN_ACTION.test(text)) return false;
  return !NON_ACTION_WORDS.test(text);
}

export type WorkflowRunResult =
  | { status: 'success'; message: string }
  | { status: 'already'; message: string }
  /**
   * 步骤都执行完了，但读不到签到结果证据。
   *
   * 不能当作成功：工作流只负责「按学到的步骤操作」，它证明不了签到生效。
   * 交给上层按余额等其它证据继续判定。
   */
  | { status: 'unknown'; message: string }
  | { status: 'failed'; message: string }
  /** 运行环境中断不结算奖励；无法自动恢复时由引擎结束本轮。 */
  | { status: 'interrupted'; message: string; terminal?: true }
  | { status: 'navigate'; url: string };

export interface WorkflowCheckpoint {
  phase: 'before' | 'waiting' | 'action' | 'after' | 'result';
  step?: CheckinWorkflowStep;
}

export interface WorkflowRunHooks {
  /** 每个步骤及结果确认时核对运行环境；中断不能回退成导航或成功。 */
  checkpoint?: (context: WorkflowCheckpoint) => Promise<Extract<WorkflowRunResult, { status: 'interrupted' | 'failed' }> | null>;
  /** 每个工作流步骤/点击前处理可能动态出现的人机验证；返回 false 时停止。 */
  beforeAction?: () => Promise<boolean>;
  /** 专用复合流程的真实点击后处理下一帧才挂载的人机验证。 */
  afterAction?: () => Promise<boolean>;
  /** 中间页点击可能卸载文档；点击前持久化 checkin 阶段。 */
  beforeNavigate?: () => Promise<void>;
  /**
   * 签到结果等待期间接管「点击后才挂载」的人机验证。
   *
   * 点击前的验证由 beforeAction 负责，但 Turnstile / 验证码常在一次点击之后
   * 才挂载；只靠读结果证据会把「只差一次验证」误报成「未读到签到结果」。
   * 返回 resolved=false 时立即停止等待并如实失败。
   */
  whileWaitingForResult?: () => Promise<{ detected: boolean; resolved: boolean }>;
}

const DEFAULT_ELEMENT_TIMEOUT_MS = 10_000;
const DEFAULT_ASSERT_TIMEOUT_MS = 3_000;
const MAX_WAIT_MS = 30_000;
const MAX_WORKFLOW_STEPS = 30;
const MAX_CONDITION_DEPTH = 4;
/** 步骤跑完后等待结果证据的最长时间（ms）。 */
const OUTCOME_EVIDENCE_WAIT_MS = 6_000;
/** 结果证据的重读间隔（ms）。 */
const OUTCOME_EVIDENCE_POLL_MS = 400;
/** 长等待按短窗口检查公告、验证和会话，不重新执行已提交的业务动作。 */
const WORKFLOW_ENVIRONMENT_POLL_MS = 500;
/** 结果证据最多重读几次（对应 6 秒 / 400ms）。 */
const OUTCOME_EVIDENCE_MAX_READS = 16;

/**
 * 「先滚再点」在懒渲染页面上的定位参数。
 *
 * 带 `scrollIntoView` 的步骤，首屏没找到控件时不能直接判失败：签到控件常常是
 * 虚拟列表/滚动加载，滚到那儿之前根本不在 DOM 里。这几个常量控制「渐进扫掠
 * （先向下、再向上）+ 重试定位」的边界，全部是**相对量**（滚一屏、探一小段），
 * 不依赖录制时的绝对像素。
 */
/** 每次向下滚动后，等待懒渲染把控件挂进 DOM 的时间。 */
const SCROLL_RENDER_SETTLE_MS = 150;
/** 单次定位探测的最长等待：短，好让「滚→探→再滚」循环快速推进；控件已在 DOM 时会立即命中。 */
const SCROLL_PROBE_TIMEOUT_MS = 400;
/** 滚动重试的次数上限（有界循环的硬顶，配合 timeoutMs 一起兜底）。 */
const MAX_SCROLL_ATTEMPTS = 24;
/**
 * 没带 `scrollIntoView` 标记的步骤，首屏按完整超时等一次仍落空后，额外下滚兜底的时间预算。
 *
 * 单独给一段预算（不与首屏超时叠满）：这样正常步骤（控件在首屏就命中）零影响，只有
 * 「本来就要报找不到」的失败路径才多花这几秒下滚找懒渲染在视口下方的控件 —— 学习没
 * 记到滚动、或回放时页面比学习时更长，都能靠这层恢复够着签到栏。
 */
const SCROLL_RECOVERY_BUDGET_MS = 6_000;

type FingerprintTextMatch = 'exact' | 'tolerant' | 'checkin';
/** 动作前仍重新核验全部字段，沿用本次定位实际采用的文案口径。 */
const rescueVerifiedElements = new WeakMap<Element, {
  fingerprint: WorkflowElementFingerprint;
  textMatch: FingerprintTextMatch;
}>();

type TargetRecovery<T extends Element> = { locate: () => T | null; stop: () => boolean };

/** 页面自身（`html`/`body`/window）当前的纵向滚动位置：判断「还能不能再往下滚」。 */
function pageScrollY(): number {
  return Math.max(
    Math.round(window.scrollY || 0),
    Math.round(document.documentElement?.scrollTop || 0),
    Math.round(document.body?.scrollTop || 0),
  );
}

/** 向下滚约一屏（相对量，不依赖录制像素）；jsdom/无 scrollBy 时退回 scrollingElement。 */
function scrollPageDown(): void {
  const amount = Math.max(1, Math.round((window.innerHeight || 800) * 0.9));
  if (typeof window.scrollBy === 'function') {
    window.scrollBy(0, amount);
    return;
  }
  const scroller = document.scrollingElement ?? document.documentElement;
  if (scroller) scroller.scrollTop += amount;
}

/**
 * 向上滚约一屏（相对量，不依赖录制像素）；jsdom/无 scrollBy 时退回 scrollingElement。
 *
 * 与 scrollPageDown 对称：回放打开页面时浏览器可能把滚动位置恢复到页面下半部，
 * 而签到控件懒渲染在当前位置**上方**——只向下滚只会越滚越远，永远够不着。
 */
function scrollPageUp(): void {
  const amount = Math.max(1, Math.round((window.innerHeight || 800) * 0.9));
  if (typeof window.scrollBy === 'function') {
    window.scrollBy(0, -amount);
    return;
  }
  const scroller = document.scrollingElement ?? document.documentElement;
  if (scroller) scroller.scrollTop -= amount;
}

/**
 * 定位工作流控件；首屏找不到时会**渐进扫掠并重试**（先向下、再向上），把懒渲染/
 * 首屏下方或上方的控件找回来。
 *
 * 用户症状（Motomoto /profile 实测）：签到控件在首屏下方，学习时先滑动页面才够得着它。
 * 这类控件在真实站点常是懒渲染（虚拟列表/滚动加载）—— 页面停在顶部时它压根不在 DOM，
 * 回放只在首屏 `waitFor` 一次就会超时报「找不到可点击元素」，而 `element.scrollIntoView()`
 * 需要先拿到 element，此刻却拿不到。另一类症状：浏览器把滚动位置恢复到页面下半部，
 * 控件懒渲染在当前位置**上方**，只向下滚永远够不着（向上扫掠见 `scrollToLocate`）。
 *
 * 两条路，成功路径零影响、只在失败路径多花时间：
 *  - 步骤带 `scrollIntoView`（学到「先滚再点」）：首屏短探未命中就把整个 `timeout` 预算
 *    投入「滚动 + 重试」，尽快扫到控件；
 *  - 步骤**没带**该标记（老配置的学习产物没记到滚动、或回放时页面比学习时更长）：先按原有
 *    语义把 `timeout` 等满，仍落空才用一小段独立预算扫掠兜底一次。正常步骤（控件在首屏就命中）
 *    第一次 `waitFor` 立刻返回，走不到滚动，行为与从前完全一致。
 *
 * 全部是**相对量**（滚一屏、探一小段），不依赖录制时的绝对像素。
 */
type WorkflowWaitGuard = () => Promise<void>;
type WorkflowInterruption = Extract<WorkflowRunResult, { status: 'interrupted' | 'failed' }>;

/** 只在本执行器内传播；上层仍接收既有的中断结果，不把它误当定位失败。 */
class WorkflowWaitInterrupted extends Error {
  constructor(readonly result: WorkflowInterruption) {
    super(result.message);
  }
}

async function waitWithEnvironment<T>(
  read: (timeoutMs: number) => Promise<T | null>,
  timeoutMs: number,
  guard?: WorkflowWaitGuard,
): Promise<T | null> {
  if (!guard) return read(timeoutMs);
  let deadline = Date.now() + timeoutMs;
  const attempts = Math.max(1, Math.ceil(timeoutMs / WORKFLOW_ENVIRONMENT_POLL_MS) + 1);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const pausedAt = Date.now();
    await guard();
    // 等验证/关公告是环境恢复，不能消耗业务元素的挂载预算。
    deadline += Math.max(0, Date.now() - pausedAt);
    const remaining = Math.max(0, deadline - Date.now());
    const value = await read(Math.min(remaining, WORKFLOW_ENVIRONMENT_POLL_MS));
    if (value !== null) return value;
    if (remaining === 0 || Date.now() >= deadline) return null;
  }
  return null;
}

async function locateStepTarget<T extends Element = HTMLElement>(
  selector: string,
  timeout: number,
  scrollIntoView: boolean | undefined,
  scrollContainer?: string,
  log?: StepLog,
  fingerprint?: WorkflowElementFingerprint,
  recovery?: TargetRecovery<T>,
  waitGuard?: WorkflowWaitGuard,
): Promise<T | null> {
  // 内层探测和外层指纹/滚动重试使用同一业务时钟，环境恢复不消耗任何一层预算。
  let environmentWaitMs = 0;
  const now = () => Date.now() - environmentWaitMs;
  const guard = waitGuard ? async () => {
    const startedAt = Date.now();
    try {
      await waitGuard();
    } finally {
      environmentWaitMs += Math.max(0, Date.now() - startedAt);
    }
  } : undefined;
  // 无指纹时维持原命中语义（queryFirst 取第一个可见命中）；有指纹时改为
  // 「全部可见命中里找指纹匹配的那个」——选择器可能命中多个元素（同文案按钮）。
  const probe = async (probeTimeout: number): Promise<T | null> => {
    if (!fingerprint) return waitWithEnvironment((windowMs) => waitFor<T>(selector, windowMs), probeTimeout, guard);
    if (probeTimeout <= 0) await guard?.();
    const first = probeTimeout > 0
      ? await waitWithEnvironment((windowMs) => waitFor<T>(selector, windowMs), probeTimeout, guard)
      : queryFirst<T>(selector);
    if (!first) return null;
    return findByFingerprint<T>(selector, fingerprint, log);
  };

  const recover = (reportFailure = false): T | null => {
    if (fingerprint) {
      const rescued = rescueByFingerprint<T>(selector, fingerprint, log, reportFailure);
      if (rescued) {
        rescueVerifiedElements.set(rescued, {
          fingerprint,
          textMatch: rescueAnchorFields(fingerprint).strong.length ? 'tolerant' : 'exact',
        });
        return rescued;
      }
    }
    return recovery?.locate() ?? null;
  };
  // 已挂载的控件能直接给出滚动方向，不先扫描录制时的比例/面板。
  const immediateRecovery = !!fingerprint || !!recovery;
  const initial = await probe(immediateRecovery ? 0 : scrollIntoView ? Math.min(timeout, SCROLL_PROBE_TIMEOUT_MS) : timeout);
  if (initial) return initial;
  const recovered = recover();
  if (recovered || recovery?.stop()) return recovered;

  if (!scrollIntoView && immediateRecovery && timeout > 0) {
    const deadline = now() + timeout;
    // 等异步挂载时也重读快照；不能只等待已经失效的旧选择器。
    const probes = Math.ceil(timeout / SCROLL_PROBE_TIMEOUT_MS);
    for (let attempt = 0; attempt < probes && now() < deadline; attempt += 1) {
      const found = await probe(Math.min(SCROLL_PROBE_TIMEOUT_MS, Math.max(0, deadline - now())));
      if (found) return found;
      const retry = recover();
      if (retry || recovery?.stop()) return retry;
      // 选择器已命中但指纹仍是加载占位时，probe 会立刻返回，不能空转耗光重试次数。
      // 给页面真实渲染时间；睡眠仍受同一个业务截止时间约束，环境恢复另计。
      await sleep(Math.min(SCROLL_PROBE_TIMEOUT_MS, Math.max(0, deadline - now())));
    }
  }

  const scrolled = await scrollToLocate<T>(
    selector,
    now() + (scrollIntoView ? timeout : SCROLL_RECOVERY_BUDGET_MS),
    scrollContainer,
    log,
    immediateRecovery ? async (probeTimeout) => {
      const hit = await probe(0);
      if (hit) return hit;
      const current = recover();
      if (current || recovery?.stop()) return current;
      const waited = await probe(probeTimeout);
      return waited ?? recover();
    } : probe,
    recovery?.stop,
    now,
  );
  return scrolled ?? (recovery?.stop() ? null : recover(true));
}

function isScrollContainer(element: HTMLElement): boolean {
  return element !== document.body && element !== document.documentElement
    && element.scrollHeight > element.clientHeight + 1
    && /(auto|scroll|overlay)/.test(getComputedStyle(element).overflowY)
    && isVisible(element);
}

function currentScrollContainers(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('*')].filter(isScrollContainer)
    .sort((a, b) => b.clientHeight * b.clientWidth - a.clientHeight * a.clientWidth).slice(0, 4);
}

/** 仅在目标尚未挂载时扫描当前可滚动表面；每一段都重新读取目标/控件快照。 */
async function scrollToLocate<T extends Element = HTMLElement>(
  selector: string,
  deadline: number,
  containerSelector?: string,
  log?: StepLog,
  probe: (timeout: number) => Promise<T | null> = (timeout) => waitFor<T>(selector, timeout),
  stopped?: () => boolean,
  now: () => number = Date.now,
): Promise<T | null> {
  type Surface = { y: () => number; scroll: (down: boolean) => void; label: string };
  const containerSurface = (element: HTMLElement): Surface => ({
    y: () => element.scrollTop,
    scroll: (down) => {
      const amount = Math.max(1, Math.round((element.clientHeight || element.getBoundingClientRect().height) * 0.9));
      element.scrollTop += down ? amount : -amount;
    },
    label: element === learnedContainer ? `学习面板 ${containerSelector}` : '页面内滚动面板',
  });
  const makePageSurface = (): Surface => ({
    y: pageScrollY,
    scroll: (down) => down ? scrollPageDown() : scrollPageUp(),
    label: '页面',
  });
  const surfaces: Surface[] = [];
  let learnedContainer: HTMLElement | null = null;
  if (containerSelector) {
    const container = queryFirst<HTMLElement>(containerSelector);
    if (container && isScrollContainer(container)) {
      learnedContainer = container;
      // 先把整个面板带进视口，触发依赖 IntersectionObserver 的懒挂载。
      container.scrollIntoView?.({ block: 'center', inline: 'center' });
      await sleep(SCROLL_RENDER_SETTLE_MS);
      const revealed = await probe(0);
      if (revealed || stopped?.()) return revealed;
      surfaces.push(containerSurface(container));
    } else {
      log?.push(`工作流${container ? '学习时的滚动面板已不可滚动' : '未找到学习时的滚动面板'}: ${containerSelector}，退回到页面通用滚动查找`);
    }
  }
  // 即使旧选择器命中了可滚动的错误面板，也必须给当前其他面板分配查找机会。
  surfaces.push(...currentScrollContainers().filter((element) => element !== learnedContainer).map(containerSurface));
  surfaces.push(makePageSurface());

  let attempts = 0;
  // 容器与窗口共享同一份 MAX_SCROLL_ATTEMPTS 预算与 deadline；每个「面板 × 方向」只记一次日志。
  const loggedSurfaceDirections = new Set<string>();
  const scrollOnce = async (surface: Surface, down: boolean): Promise<T | null> => {
    if (attempts >= MAX_SCROLL_ATTEMPTS || now() >= deadline) return null;
    attempts += 1;
    const previous = surface.y();
    surface.scroll(down);
    await sleep(SCROLL_RENDER_SETTLE_MS);
    const remaining = deadline - now();
    if (remaining <= 0) return null;
    const y = surface.y();
    const key = `${surface.label}|${down ? 'down' : 'up'}`;
    if (y !== previous && !loggedSurfaceDirections.has(key)) {
      loggedSurfaceDirections.add(key);
      log?.push(`工作流滚动${surface.label}${down ? '向下' : '向上'}查找 ${selector}`);
    }
    return probe(Math.min(remaining, SCROLL_PROBE_TIMEOUT_MS));
  };

  for (const down of [true, false]) {
    const pending = new Set(surfaces.filter((surface) => down || surface.y() > 0));
    while (pending.size && attempts < MAX_SCROLL_ATTEMPTS && now() < deadline) {
      for (const surface of pending) {
        if (attempts >= MAX_SCROLL_ATTEMPTS || now() >= deadline || stopped?.()) return null;
        const previous = surface.y();
        const hit = await scrollOnce(surface, down);
        if (hit || stopped?.()) return hit;
        const y = surface.y();
        if (down ? y <= previous : y >= previous) pending.delete(surface);
      }
    }
  }
  return null;
}

type WorkflowExecutionBudget = {
  steps: number;
  routeNext?: string;
  sourcePath?: string;
  pendingScroll?: { container?: string };
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isWorkflowStep(value: unknown): value is CheckinWorkflowStep {
  const record = asRecord(value);
  return !!record && typeof record.type === 'string';
}

function interpolate(value: string, site: SiteConfig): string {
  return value.replace(/\{\{\s*claimText\s*\}\}/gi, site.checkin?.claimText ?? '');
}

function pageText(): string {
  return document.body?.innerText ?? document.body?.textContent ?? '';
}

function textMatches(words?: string[], match: 'any' | 'all' = 'any'): boolean {
  if (!words?.length) return false;
  const text = pageText().toLocaleLowerCase();
  const hits = words
    .filter((word) => word.trim())
    .map((word) => text.includes(word.trim().toLocaleLowerCase()));
  return match === 'all' ? hits.length > 0 && hits.every(Boolean) : hits.some(Boolean);
}

function conditionMatches(condition: CheckinWorkflowCondition): boolean {
  switch (condition.type) {
    case 'text':
      return textMatches(condition.words, condition.match ?? 'any');
    case 'selector':
      return !!queryFirst(condition.selector);
    case 'path': {
      const pattern = condition.pattern.trim();
      // 学习出来的 hash router 路线使用 `/#/页面`。只比较 pathname 会把所有
      // 页面都看成 `/`，导致中间页的动作守卫永远不命中；普通站点没有 hash，
      // 仍然得到原来的 pathname 比较语义。查询串继续忽略，和 route 一致。
      const currentPath = `${location.pathname}${location.hash}`;
      return pattern.endsWith('*')
        ? currentPath.startsWith(pattern.slice(0, -1))
        : currentPath === pattern;
    }
  }
}

function clampTimeout(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(MAX_WAIT_MS, Math.max(0, Math.round(value!)));
}

/* ---------------------------------------------------------------------------
 * 元素身份指纹核验 —— 「选择器命中的是不是当初那个元素」。
 *
 * 站点改版后选择器常常命中**另一个**元素（class 重排、同文案按钮变多）。只按选择器
 * 命中就把错误元素当成目标点了，用户看到的是「点了一下但什么都没发生」，极难排查。
 * 指纹把「当初那个元素长什么样」存成一组稳定的可见/语义特征，回放时逐条比对：
 * 任何一条对不上即失配。没写指纹的老步骤维持原行为（只按选择器命中，不核验）。
 * ------------------------------------------------------------------------- */

/** 读元素的实际指纹；与 `WorkflowElementFingerprint` 同构，缺省字段不落。 */
function readFingerprint(element: Element): WorkflowElementFingerprint {
  const fp: WorkflowElementFingerprint = { tag: element.tagName.toLowerCase() };
  const aria = element.getAttribute('aria-label');
  if (aria) fp.aria = aria;
  const name = element.getAttribute('name');
  if (name) fp.name = name;
  const testId = element.getAttribute('data-testid');
  if (testId) fp.testId = testId;
  /**
   * `inputType` 必须与采集侧 `learningFingerprint` 逐字对齐：
   * 那边对 `<input>` 写 `element.type`、对 `<textarea>` 写字面量 `'textarea'`。
   * 旧实现只给 `HTMLInputElement` 写这一项，textarea 永远拿不到 → 采集侧写下的
   * `inputType: 'textarea'` 在回放侧必然对不上，**每个富文本框的指纹核验都失配**，
   * 表现为「学到了却回放失败：命中了错误的元素」。
   */
  if (element instanceof HTMLInputElement) fp.inputType = element.type;
  else if (element instanceof HTMLTextAreaElement) fp.inputType = 'textarea';
  const role = element.getAttribute('role');
  if (role) fp.role = role;
  const text = selectorVisibleText(element);
  if (text) fp.text = text;
  return fp;
}

/** 指纹的人类可读摘要，用于失败日志（只列实际比对过的字段）。 */
function describeFingerprint(fp: WorkflowElementFingerprint): string {
  const parts: string[] = [];
  if (fp.tag) parts.push(`tag=${fp.tag}`);
  if (fp.aria) parts.push(`aria="${fp.aria}"`);
  if (fp.name) parts.push(`name="${fp.name}"`);
  if (fp.testId) parts.push(`testId="${fp.testId}"`);
  if (fp.inputType) parts.push(`type=${fp.inputType}`);
  if (fp.role) parts.push(`role=${fp.role}`);
  if (fp.text) parts.push(`text="${fp.text.length > 24 ? `${fp.text.slice(0, 24)}…` : fp.text}"`);
  return parts.length ? parts.join(' ') : '(空指纹)';
}

/**
 * 期望指纹是否命中元素。
 *
 * 只比对期望里**写了的**字段；`tag` 缺省也能比（实际总能读到标签）。
 * 返回第一个失配字段的说明，全部通过返回 null。
 */
function fingerprintMismatch(
  expected: WorkflowElementFingerprint,
  element: Element,
  textMatch: FingerprintTextMatch = 'exact',
): string | null {
  const actual = readFingerprint(element);
  if (expected.tag && actual.tag !== expected.tag.toLowerCase()) {
    return `tag 期望 ${expected.tag} 实际 ${actual.tag}`;
  }
  if (expected.aria !== undefined && actual.aria !== expected.aria) {
    return `aria 期望 "${expected.aria}" 实际 "${actual.aria ?? ''}"`;
  }
  if (expected.name !== undefined && actual.name !== expected.name) {
    return `name 期望 "${expected.name}" 实际 "${actual.name ?? ''}"`;
  }
  if (expected.testId !== undefined && actual.testId !== expected.testId) {
    return `testId 期望 "${expected.testId}" 实际 "${actual.testId ?? ''}"`;
  }
  if (expected.inputType !== undefined && actual.inputType !== expected.inputType) {
    return `type 期望 ${expected.inputType} 实际 ${actual.inputType ?? ''}`;
  }
  if (expected.role !== undefined && actual.role !== expected.role) {
    return `role 期望 ${expected.role} 实际 ${actual.role ?? ''}`;
  }
  if (expected.text !== undefined) {
    const expectedText = expected.text.replace(/\s+/g, ' ').trim();
    const actualText = (actual.text ?? '').replace(/\s+/g, ' ').trim();
    // 严格核验（选择器命中路径）保持全等；回退路径才放宽文案，见 textMatchesLoosely。
    const matched = textMatch === 'checkin'
      ? isCheckinCommand(element as HTMLElement)
      : textMatch === 'tolerant'
        ? textMatchesLoosely(actualText, expectedText)
        : actualText === expectedText;
    if (!matched) return `text 期望 "${expectedText}" 实际 "${actualText}"`;
  }
  return null;
}

/**
 * 容忍动态文案 / 80 字符截断的文本比较：两侧规范化后互为包含即算命中。
 *
 * 只在跨选择器回退路径使用（`fingerprintMismatch(..., 'tolerant')`）。文案可以随
 * 日期、倒计时或尾部说明变化，且采集侧把 text 截到 80 字符——严格全等会让这些
 * 步骤误失配。只有强字段回退允许这种包含比较；只有文案的回退仍要求完全匹配。
 */
function textMatchesLoosely(actualText: string, expectedText: string): boolean {
  if (!actualText || !expectedText) return actualText === expectedText;
  return actualText.includes(expectedText) || expectedText.includes(actualText);
}

/**
 * 步骤带指纹时核验候选元素；返回命中元素或 null。
 *
 * 失配时写一行带「期望指纹 / 实际指纹」的日志——这是用户排查选择器失配的唯一线索。
 */
function verifyFingerprint(
  element: Element,
  fingerprint: WorkflowElementFingerprint | undefined,
  selector: string,
  log: StepLog | undefined,
  /**
   * 文案比较宽容度。选择器命中路径用严格全等（默认）；跨选择器回退路径才放宽为
   * 包含/前缀，容忍动态文案与 80 字符截断。身份字段的比对强度两条路径完全相同。
   */
  textMatch: FingerprintTextMatch = 'exact',
): Element | null {
  if (!fingerprint) return element;
  const mismatch = fingerprintMismatch(fingerprint, element, textMatch);
  if (!mismatch) return element;
  log?.push(
    `工作流指纹失配: ${selector} 命中的元素不符（${mismatch}）；`
    + `期望 ${describeFingerprint(fingerprint)}，实际 ${describeFingerprint(readFingerprint(element))}`,
  );
  return null;
}

function verifyStepFingerprint(
  element: Element,
  fingerprint: WorkflowElementFingerprint | undefined,
  selector: string,
  log: StepLog,
): Element | null {
  const rescued = rescueVerifiedElements.get(element);
  return verifyFingerprint(element, fingerprint, selector, log,
    rescued && rescued.fingerprint === fingerprint ? rescued.textMatch : 'exact');
}

/**
 * 在「选择器全部可见命中」里找指纹匹配的元素。
 *
 * `waitFor`/`queryFirst` 只返回第一个可见命中；指纹失配时不能就此放弃——同选择器
 * 可能还命中别的元素（同文案按钮）。枚举全部可见命中，返回第一个指纹匹配的。
 */
function findByFingerprint<T extends Element = HTMLElement>(
  selector: string,
  fingerprint: WorkflowElementFingerprint | undefined,
  log?: StepLog,
): T | null {
  if (!fingerprint) return queryFirst<T>(selector);
  const candidates = queryAll<T>(selector);
  for (const candidate of candidates) {
    if (verifyFingerprint(candidate, fingerprint, selector, log)) return candidate;
  }
  return null;
}

/**
 * 定位落空后的指纹失配诊断。
 *
 * 「找不到元素」有两种真相：选择器真的没命中（懒渲染未挂载 / 选择器失效），或选择器
 * 命中了、但命中的元素指纹对不上（站点改版后同选择器指向了别的元素）。后者报
 * 「命中了错误的元素」比「找不到」好排查一万倍——选择器还在，只是它指的不再是当初
 * 那个控件。只在「确实存在候选、且候选全部失配」时返回该诊断，否则返回 null。
 */
function fingerprintFailureMessage(
  selector: string,
  fingerprint: WorkflowElementFingerprint | undefined,
  action: string,
): string | null {
  if (!fingerprint) return null;
  const candidates = queryAll(selector);
  if (candidates.length === 0) return null;
  const first = candidates[0]!;
  const mismatch = fingerprintMismatch(fingerprint, first);
  if (!mismatch) return null; // 有候选其实匹配——那是竞态，按原「找不到」处理
  return `工作流${action}选择器命中了错误的元素: ${selector}`
    + `（${mismatch}；期望 ${describeFingerprint(fingerprint)}，实际 ${describeFingerprint(readFingerprint(first))}）`;
}

/* ---------------------------------------------------------------------------
 * 跨选择器回退 —— 选择器已经指不到任何东西时的最后一次自救。
 *
 * 现状的缺口：`findByFingerprint` 只在**同一个选择器**的可见命中里挑指纹匹配项。
 * 站点改版把选择器整个打废时（class 哈希变了、id 重命名、`:nth-of-type` 因列表
 * 增删而错位），一个候选都枚举不到，回放直接报「找不到可点击元素」——检测到了
 * 失配，却没有自救。
 *
 * 这一层用**录制时留下的指纹**（`testId`/`name`/`aria` 这类身份字段，`text` = 当初的
 * 可见文字）在页面里做**受限**候选搜索：只在「本来就能交互」的元素里找，且要求指纹里
 * **写了的字段全部匹配**，还必须**唯一命中**。
 *
 * - 强身份字段存在时全部核验；只有文案时要求完全匹配且控件可交互；
 * - 多个候选同时满分匹配时**拒绝**（绝不按文档顺序猜）；
 * - 候选范围只用可交互元素白名单，不用 `*`：`text=` 这类锚点可能命中包着控件的
 *   容器或纯文字节点，把「一段文字」当按钮点比报找不到危险得多；
 * - 命中后仍走原有的遮挡检查 / 同源校验 / 指纹复核，一步不少。
 * ------------------------------------------------------------------------- */

/**
 * 回退搜索的基础候选范围 —— 只扫「本来就被设计成能交互」的元素。
 *
 * 刻意不用 `*`：整页扫描会把容器、标题、纯文本节点一起纳入，一个弱锚点就可能对上
 * 一个不该点的东西。漏掉个别自绘控件是可接受的代价（如实报找不到），点错元素不是。
 */
const RESCUE_CANDIDATE_SCOPE = [
  'button',
  'a',
  'input',
  'textarea',
  'select',
  'summary',
  '[role]',
  '[tabindex]',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[data-testid]',
  '[aria-label]',
  '[name]',
].join(', ');

/** 强字段支持容忍动态文案；只有种类而没有文案/强字段时不能回退。 */
const RESCUE_STRONG_FIELDS = ['testId', 'name', 'aria'] as const;
/** 文案可用于完全匹配的唯一交互控件回退。 */
const RESCUE_WEAK_FIELDS = ['text'] as const;

/** 某字段在指纹里写了有效值。 */
function hasFingerprintField(
  fingerprint: WorkflowElementFingerprint,
  field: keyof WorkflowElementFingerprint,
): boolean {
  const value = fingerprint[field];
  return typeof value === 'string' && value.trim().length > 0;
}

/** 回退锚点分类，供候选搜索与动作前复核共用。 */
function rescueAnchorFields(fingerprint: WorkflowElementFingerprint): {
  strong: string[];
  weak: string[];
} {
  return {
    strong: RESCUE_STRONG_FIELDS.filter((field) => hasFingerprintField(fingerprint, field)),
    weak: RESCUE_WEAK_FIELDS.filter((field) => hasFingerprintField(fingerprint, field)),
  };
}

/**
 * 回退候选范围：基础白名单 **加上指纹自己的标签**。
 *
 * 自绘控件常是 `<div role="button">`（已被 `[role]` 覆盖）或干脆裸 `<div onclick>`。
 * 后者只在**指纹的 tag 就是 `div`** 时才会被纳入 —— 那是「当初录到的就是 div」，
 * 不是临时拓宽范围；匹配条件（全字段 + 唯一）一条没松。
 */
function rescueCandidateScope(fingerprint: WorkflowElementFingerprint): string {
  const scope = new Set(RESCUE_CANDIDATE_SCOPE.split(', '));
  const tag = fingerprint.tag?.trim().toLowerCase();
  if (tag && /^[a-z][a-z0-9-]*$/.test(tag)) scope.add(tag);
  return [...scope].join(', ');
}

/**
 * 在受限范围里找出「指纹写了的字段全部匹配」的可见元素。
 *
 * 强字段存在时容忍文案包含；只有文案时要求可交互元素、全部字段严格匹配。
 *
 * 这里不逐条写失配日志——扫描是全页量级，每个候选都记一行会把回放日志冲垮；
 * 失配原因仍由 `verifyFingerprint` 在真正决策处记。
 */
function rescueMatches(fingerprint: WorkflowElementFingerprint): Element[] {
  const anchors = rescueAnchorFields(fingerprint);
  if (anchors.strong.length === 0 && anchors.weak.length === 0) return [];
  let candidates: Element[];
  try {
    candidates = [...document.querySelectorAll(rescueCandidateScope(fingerprint))];
  } catch {
    return [];
  }
  return candidates.filter((element) => isVisible(element)
    && (anchors.strong.length > 0 || isReplayInteractive(element))
    && fingerprintMismatch(fingerprint, element, anchors.strong.length > 0 ? 'tolerant' : 'exact') === null);
}

function isReplayInteractive(element: Element): boolean {
  if (controlDisabled(element as HTMLElement)) return false;
  return element.matches('button, a[href], input:not([type="hidden"]), textarea, select, summary, '
    + '[role="button"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="radio"], '
    + '[contenteditable=""], [contenteditable="true"], [onclick], [tabindex]:not([tabindex="-1"])')
    || getComputedStyle(element).cursor === 'pointer';
}

/**
 * 回退命中的元素怎么在日志里称呼它。
 *
 * 局部实现，不 import dom-utils 的新导出：全部回放用例都用 `vi.mock` 工厂整体替换
 * 该模块，新增导出在那些 mock 里是 undefined，一调用就崩。
 */
function describeRescueTarget(element: Element): string {
  const parts = [element.tagName.toLowerCase()];
  const id = element.getAttribute('id');
  if (id) parts.push(`#${id}`);
  const testId = element.getAttribute('data-testid');
  if (testId) parts.push(`[data-testid="${testId}"]`);
  return parts.join('');
}

/** 单次 DOM 指纹恢复；等待与滚动共用定位器的预算，不再额外叠加一轮固定重试。 */
function rescueByFingerprint<T extends Element = HTMLElement>(
  selector: string,
  fingerprint: WorkflowElementFingerprint,
  log?: StepLog,
  reportFailure = true,
): T | null {
  const anchors = rescueAnchorFields(fingerprint);
  if (anchors.strong.length === 0 && anchors.weak.length === 0) {
    if (reportFailure) log?.push(
      `工作流原选择器失效（${selector}），指纹只有${anchors.weak.length > 0 ? '文案' : '控件种类'}`
      + `（${describeFingerprint(fingerprint)}），无法确认是同一个控件，不做跨选择器回退`,
    );
    return null;
  }

  const matches = rescueMatches(fingerprint);
  if (matches.length === 1) {
    const element = matches[0] as T;
    log?.push(
      `原选择器失效，已按指纹回退到 ${describeRescueTarget(element)}：${selector}`
      + `（${describeFingerprint(fingerprint)}）`,
    );
    return element;
  }

  if (reportFailure) log?.push(matches.length > 1
    ? `工作流原选择器失效（${selector}），按指纹回退搜索命中 ${matches.length} 个候选、无法确定唯一目标，已放弃`
    : `工作流原选择器失效（${selector}），按指纹回退搜索没有找到匹配元素`);
  return null;
}

async function waitForAssertion(
  step: Extract<CheckinWorkflowStep, { type: 'assert' }>,
  guard?: WorkflowWaitGuard,
): Promise<boolean> {
  const timeout = clampTimeout(step.timeoutMs, DEFAULT_ASSERT_TIMEOUT_MS);
  let deadline = Date.now() + timeout;
  const hasSelector = typeof step.selector === 'string' && step.selector.trim().length > 0;
  const hasText = Array.isArray(step.text) && step.text.some((word) => typeof word === 'string' && word.trim());

  const maxReads = Math.ceil(timeout / 150) + 1;
  for (let attempt = 0; attempt < maxReads && Date.now() <= deadline; attempt += 1) {
    const pausedAt = Date.now();
    await guard?.();
    deadline += Math.max(0, Date.now() - pausedAt);
    const selectorHit = hasSelector && !!queryFirst(step.selector!);
    const textHit = hasText && textMatches(step.text);
    if (selectorHit || textHit) return true;
    await sleep(150);
  }
  return false;
}

function sameLocation(target: URL): boolean {
  try {
    const current = new URL(location.href);
    return current.origin === target.origin
      && current.pathname === target.pathname
      && current.search === target.search
      && current.hash === target.hash;
  } catch {
    return false;
  }
}

/**
 * 学习路线（`workflow.route`）的运行时入口。
 *
 * 路线是「学会网址」的载体：用户手动签到一次后，扩展记住经过的同源页面，
 * 最后一项就是执行签到动作的目标页。这里只负责**对齐当前页**：
 *
 * - 已经在目标页 → 返回 null，继续执行 steps；
 * - 不在目标页 → 返回 `navigate` 中间态，由引擎负责真正跳转（本文件不碰
 *   `chrome.tabs` / `location.assign`，content script 只报告意图）；
 * - 目标页与 `site.loginUrl` 不同源 → 直接失败，绝不产生外域跳转。
 *
 * 路线只记录 `pathname + hash`（见 `automation/learning.ts`），因此比较时
 * 忽略查询串：`/check-in?tab=1` 与路线里的 `/check-in` 视为同一页。
 * 路线缺失、为空或格式不可用时退回「只执行 steps」的老行为。
 */

/**
 * 「落点不在学习路线上」的日志前缀。
 *
 * `resolveRoute` 在当前页不在 route 里时只能凭猜：它写下这行说明为什么没有从
 * 路线首项继续。这行同时是引擎跨页面给这条路径单独计数的依据（与
 * `CHECKIN_NAV_MARKER` / `PAGE_RETRY_MARKER` 同一套「标记写进步骤日志」的办法）——
 * 整页跳转会销毁 content script，内存变量存不住。
 */
export const ROUTE_OFF_PAGE_PREFIX = '学习路线未命中: ';

/**
 * 已登录后的业务落点接入学习路线时使用的日志前缀。
 *
 * OAuth 返回 `/dashboard/*` 后，旧学习产物可能只保存了真正发生操作的 `/profile`。
 * 这不是路线命中失败，而是从一个合法业务页进入已保存路线。该跳转仍需由引擎计入
 * 同一份有界预算，避免目标页被站点重定向回来后反复接入。
 */
export const ROUTE_ENTRY_PREFIX = '工作流接入学习路线: ';

/**
 * 落点不在学习路线上时的说明日志。
 *
 * 结尾固定是本次要去的地址，引擎据此把这次跳转和它的原因配成一对。
 * 地址用 `pathname + hash` —— 与 route 的存储格式（`learning.ts` 的
 * `sameOriginPath`）一致，别写成 `pathname + search`：同一次跳转打印出两种
 * 写法，排障时会看起来像两个不同的目标。
 */
export function routeOffPageLog(currentPath: string, target: string): string {
  return `${ROUTE_OFF_PAGE_PREFIX}当前页 ${currentPath} 不在学习路线上，尝试进入 ${target}`;
}

export function routeEntryLog(currentPath: string, target: string): string {
  return `${ROUTE_ENTRY_PREFIX}从当前业务页 ${currentPath} 进入 ${target}`;
}

/** 路线项解析成同源绝对地址；跨站或非法地址返回 undefined。 */
function routeUrl(site: SiteConfig, page: string): URL | undefined {
  if (!isSameSiteUrl(site, page)) return undefined;
  try {
    // 用站点地址做基准解析，相对路线不依赖当前页，结果稳定且必然同源。
    return new URL(page, site.loginUrl);
  } catch {
    return undefined;
  }
}

/**
 * 站点登录页的 pathname + hash。
 *
 * 登录页是**具体路径**（`/sign-in`、`/login`、`/#/login`）时才有意义：站点会把
 * 已登录用户从那里赶走，所以它是「跳过去必然被弹回来」的那一类地址。
 * 登录地址是站点根 `/` 时返回 null（不过滤）—— 根路径是歧义的：它既可能是
 * 登录表单，也可能是同一路径下的控制台，跳过它会把路线上真实存在的业务页
 * 一起跳过。歧义时不做猜测，交给引擎的跳转预算兜底。
 */
function loginPageKey(site: SiteConfig): string | null {
  if (isKnownBusinessLearningPath(site.loginUrl)) return null;
  try {
    const login = new URL(site.loginUrl);
    if (login.pathname === '/' && !login.hash) return null;
    return `${login.pathname}${login.hash}`;
  } catch {
    return null;
  }
}

/**
 * 学习路线解析成同源绝对地址序列；不是「带有效路线的工作流站点」时返回 null。
 *
 * 引擎用它把「已登录 → 去个人资料页核对账号」这段内含逻辑接到学习出来的站点上：
 * 这类站点没有 `checkin.entry`（那是给预设站手写的站内入口），显示账号的资料页
 * 藏在 `route` 末项里。判据与 `resolveRoute` 完全一致，避免两处对「终点在哪」产生
 * 分歧：必须启用 workflow 或登录即签到的身份路线、route 为非空字符串数组、每项与站点同源
 * （任一跨站即整体作废，回退成「无学习路线」，绝不据此产生外域跳转）。
 */
function learnedRoutePages(site: SiteConfig): URL[] | null {
  // 登录即签到也会保存仅用于核对身份的路线；不回放动作不代表忽略已学的身份页。
  const identityOnly = site.checkin?.method === 'none'
    && Array.isArray(site.checkin.workflow?.steps)
    && site.checkin.workflow.steps.length === 0
    && !!site.checkin.workflow.identityPath;
  if (!usesCheckinWorkflow(site) && !identityOnly) return null;
  const route = site.checkin?.workflow?.route;
  if (!Array.isArray(route) || route.length === 0) return null;
  const pages = route
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
  if (pages.length === 0) return null;
  const resolved = pages.map((page) => routeUrl(site, page));
  if (resolved.some((url) => !url)) return null;
  return resolved as URL[];
}

/** 这是不是一个「靠学习一次签到流程生成、且带页面路线」的工作流站点。 */
export function hasLearnedRoute(site: SiteConfig): boolean {
  return learnedRoutePages(site) !== null;
}

/** 路外导航预算只约束仍在路线之外的尝试，不能拦住已回到路线后的正常前进。 */
export function atLearnedRoutePage(site: SiteConfig): boolean {
  const pages = learnedRoutePages(site);
  const current = `${location.pathname}${location.hash}`;
  return pages?.some((page) => page.origin === location.origin
    && `${page.pathname}${page.hash}` === current) ?? false;
}

/**
 * 当前页是不是学习路线的**终点页**（执行签到动作、通常也显示登录账号的那一页）。
 *
 * 引擎据此决定：还没到终点页就先沿路线走、不在中途页对账号下结论；到了终点页
 * 才等身份渲染完成并严格核对。比较 `pathname + hash`，与 `route` 的存储格式一致。
 */
export function atLearnedCheckinPage(site: SiteConfig): boolean {
  const pages = learnedRoutePages(site);
  if (!pages) return false;
  const terminal = pages[pages.length - 1]!;
  const current = `${location.pathname}${location.hash}`;
  return `${terminal.pathname}${terminal.hash}` === current;
}

/**
 * 学习工作流记录的身份核验页。
 *
 * 必须是学习路线中的同源页面；**与签到终点同址是合法形态**（站点把签到按钮直接
 * 放在资料页上时，到页后先核对账号、再执行签到动作）。跨站、缺失或不在路线里的
 * 配置一律不形成身份核验入口 —— 但绝不因为"它就是签到页"而拒绝。
 */
export function learnedIdentityPageUrl(site: SiteConfig): string | null {
  const pages = learnedRoutePages(site);
  const identityPath = site.checkin?.workflow?.identityPath;
  if (!pages || typeof identityPath !== 'string' || !identityPath.trim()) return null;
  const identity = routeUrl(site, identityPath);
  if (!identity) return null;
  if (identity.username || identity.password || identity.search
    || /(?:access_token|refresh_token|id_token|code|state|token|secret|password)=/i.test(identity.hash)) {
    return null;
  }
  const identityKey = `${identity.pathname}${identity.hash}`;
  const inRoute = pages.some((page) => `${page.pathname}${page.hash}` === identityKey);
  return inRoute ? identity.href : null;
}

/** 当前文档是否正处于独立的学习资料身份页。 */
export function atLearnedIdentityPage(site: SiteConfig): boolean {
  const identityUrl = learnedIdentityPageUrl(site);
  if (!identityUrl) return false;
  const identity = new URL(identityUrl);
  return `${identity.pathname}${identity.hash}` === `${location.pathname}${location.hash}`;
}

/**
 * 沿学习路线推进到下一页。
 *
 * 用户手动签到经过的页面常常是必经的：先进控制台、再进签到页。只对齐路线末项
 * 等于跳过中间页直达终点，站点会把这种深链接重定向回首页，表现就是反复跳同一页
 * 直到放弃。这里按记录顺序逐页前进：落在路线上的哪一页，就往下一页走；
 * 走完最后一页才执行 steps。
 *
 * 收敛性由三层保证：
 * 1. 落在路线上时**只向后推进**，不会回退重走；
 * 2. 同一地址的重复跳转由引擎既有的「同一个签到页最多跳 2 次」计数兜住；
 * 3. **落点不在路线上**时不再无条件跳 route[0]（那是死循环的来源，见下），
 *    并且引擎给这条路径单独记了跨页预算（`ROUTE_OFF_PAGE_PREFIX` 标记）。
 */
function resolveRoute(site: SiteConfig, route: unknown, log: StepLog): WorkflowRunResult | null {
  if (!Array.isArray(route) || route.length === 0) return null;
  const pages = route
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
  if (pages.length === 0) return null;

  // 先整体解析再推进：路线里只要有一项跨站或非法，就整条拒绝，
  // 不能走到那一页才发现 —— 那时已经跳出过站点了。
  const resolved = pages.map((page) => routeUrl(site, page));
  if (resolved.some((url) => !url)) {
    return { status: 'failed', message: '工作流学习路线必须与站点同源' };
  }

  const currentPath = `${location.pathname}${location.hash}`;
  const currentIndex = resolved.findIndex((url) => `${url!.pathname}${url!.hash}` === currentPath);

  // 落在路线上：往后走一页；已经在末页 → 直接执行 steps。
  if (currentIndex >= 0) {
    const targetIndex = currentIndex + 1;
    if (targetIndex >= pages.length) return null;
    const url = resolved[targetIndex]!;
    if (`${url.pathname}${url.hash}` === currentPath) return null;
    log.push(`工作流沿学习路线进入 ${url.pathname}${url.hash}（第 ${targetIndex + 1}/${pages.length} 页）`);
    return { status: 'navigate', url: url.href };
  }

  /**
   * 落点不在路线上。
   *
   * 旧行为是「无条件跳 route[0]」，实测后果是一次死循环：学习时用 site.loginUrl
   * 开页，登录页 `/sign-in` 被记成 route[0]；回放时真实落点是 `/dashboard/overview`
   * （不在 route 里）→ 每次都跳回 `/sign-in` → 站点又把已登录用户重定向回控制台
   * → 日志里同一行反复出现，直到看门狗杀任务。
   *
   * 签到阶段回到登录页**没有任何意义**（站点会把已登录用户从登录页赶走，这正是
   * 往返的来源），所以先跳过路线里的登录页，取剩余项里第一个：它是「落点不在这份
   * 路线上」时最有可能真正到达的业务页。若路线上没有可跳的业务页（只剩登录页），
   * 就直接在当前页执行 steps —— 那正是引擎降级时要做的「在当前页找签到入口」。
   *
   * 「跳回路线」这件事本身还有一层预算：目标在整轮里固定，重试不产生新信息，
   * 所以引擎（`MAX_ROUTE_OFF_PAGE_NAVIGATIONS`）按这里的标记只放行一次。
   */
  const loginKey = loginPageKey(site);
  const targetIndex = resolved.findIndex(
    (url) => loginKey === null || `${url!.pathname}${url!.hash}` !== loginKey,
  );
  if (targetIndex < 0) {
    log.push(
      `${ROUTE_OFF_PAGE_PREFIX}当前页 ${currentPath} 不在学习路线上，`
      + '路线里没有可跳转的业务页，改为在当前页执行工作流步骤',
    );
    return null;
  }

  const url = resolved[targetIndex]!;
  // 标记写在动作前（与全部日志同一顺序），引擎靠它认识这次跳转的性质。
  // 地址统一写成 pathname + hash：与 route 的存储格式一致，也是引擎
  // `countOffRouteRouteNavigations` 配对时用的目标键（导航行同样只到 pathname）。
  const targetPath = `${url.pathname}${url.hash}`;
  log.push(isKnownBusinessLearningPath(currentPath)
    ? routeEntryLog(currentPath, targetPath)
    : routeOffPageLog(currentPath, targetPath));
  log.push(`工作流沿学习路线进入 ${url.pathname}${url.hash}（第 ${targetIndex + 1}/${pages.length} 页）`);
  return { status: 'navigate', url: url.href };
}

/**
 * 点击失败时，already 证据**只能来自目标控件附近**的那棵子树。
 *
 * 为什么不能读整页文本：侧栏、历史记录、说明文案里常年写着「今日已签到」，
 * 那和本次点击有没有生效毫无关系。整页判定会把「点击失败」包装成
 * 「今天早就签过了」——真失败被静默吞掉，用户下次也不会知道。
 * （`checkin.ts` 的自动签到路径早已明确不信正文里的「已签到」文案。）
 *
 * 范围取「最近的可判定容器」：`form` / `[role="dialog"]` / `[role="menu"]` / `li` /
 * `article` / `section`。签到卡片通常就是这类容器。找不到这样的祖先时退回
 * 元素自身的 `parentElement`；但父级若是 `body`/`html`，那就等于整页文本 ——
 * 此时只认元素**自身**的文字（disabled 的「已签到」状态控件正是这种形态）。
 * 连元素都没有时明确不判 already，如实返回失败。
 */
function clickEvidenceScope(element: Element | null | undefined): Element | null {
  if (!element) return null;
  // 重绘后遗留的游离节点（closest 仍可走）不能拿旧文案冒充 already：
  // 元素已经不在文档里，就不存在「附近」这个范围。
  if (typeof element.isConnected === 'boolean' && !element.isConnected) return null;
  const container = element.closest('form, [role="dialog"], [role="menu"], li, article, section');
  if (container) return container;
  const parent = element.parentElement;
  if (!parent || parent === document.body || parent === document.documentElement) return element;
  return parent;
}

/**
 * 点击失败前的**终局证据读取**：当天已签到再回放时，签到按钮会被换成
 * 「今日已签到」记录视图或 disabled 的状态控件 —— 目标根本不可点，但它附近
 * 通常留着 already 证据。此时比「点击失败」更接近事实的结论是 already。
 *
 * 证据必须落在目标控件附近（见 `clickEvidenceScope`）：不给范围、
 * 或范围里读不到 already 时，一律返回原来的失败返回与文案 —— 宁可如实报失败，
 * 也不靠整页文本假装成功。
 */
function settleClickFailure(
  failureMessage: string,
  log: StepLog,
  nearby?: Element | null,
): { status: 'failed'; message: string } | { status: 'already'; message: string } {
  const scope = clickEvidenceScope(nearby);
  if (!scope) return { status: 'failed', message: failureMessage };

  const lottery = /(?:^|\/)(?:lottery|draw|prize)(?:\/|$)/i.test(location.pathname)
    || LEARNING_LOTTERY_ACTION.test(nearby?.textContent ?? '');
  const evidence = lottery
    ? { kind: 'already' as const, words: LOTTERY_ALREADY_WORDS.filter((word) => (
        (scope.textContent ?? '').toLowerCase().includes(word.toLowerCase())
      )) }
    : readWorkflowOutcomeEvidenceIn(scope);
  if (evidence.kind === 'already' && evidence.words.length > 0) {
    log.push(`${failureMessage}；目标控件附近页面显示今日已完成：${evidence.words.join('、')}，按已完成处理`);
    return { status: 'already', message: '工作流未能完成点击，但目标控件附近证据显示今日签到已完成' };
  }
  return { status: 'failed', message: failureMessage };
}

async function runStep(
  site: SiteConfig,
  step: CheckinWorkflowStep,
  log: StepLog,
  hooks: WorkflowRunHooks,
  budget: WorkflowExecutionBudget,
  depth = 0,
  followingSteps: readonly CheckinWorkflowStep[] = [],
): Promise<WorkflowRunResult | null> {
  budget.steps += 1;
  if (budget.steps > MAX_WORKFLOW_STEPS) {
    return { status: 'failed', message: `工作流最多执行 ${MAX_WORKFLOW_STEPS} 个步骤` };
  }
  if (depth > MAX_CONDITION_DEPTH) {
    return { status: 'failed', message: `工作流条件嵌套超过 ${MAX_CONDITION_DEPTH} 层` };
  }

  const interrupted = await hooks.checkpoint?.({ phase: 'before', step });
  if (interrupted) return interrupted;
  // 分支内的输入、等待和断言与顶层走同一验证入口。
  // 点击在定位后还会核对一次；专用复合流程持有自己的动作钩子。
  if (!['click', 'if', 'leilei-daily'].includes(step.type)
    && hooks.beforeAction && !await hooks.beforeAction()) {
    return { status: 'failed', message: `工作流 ${step.type} 步骤前的人机验证未完成` };
  }
  let result: WorkflowRunResult | null;
  try {
    result = await runStepBody(site, step, log, hooks, budget, depth, followingSteps);
  } catch (error) {
    if (error instanceof WorkflowWaitInterrupted) return error.result;
    throw error;
  }
  if (result?.status === 'navigate' || result?.status === 'interrupted') return result;
  if (!result && (step.type === 'fill' || step.type === 'drag')
    && hooks.afterAction && !await hooks.afterAction()) {
    return { status: 'failed', message: `工作流 ${step.type} 步骤后的人机验证未完成` };
  }
  return await hooks.checkpoint?.({ phase: 'after', step }) ?? result;
}

async function runStepBody(
  site: SiteConfig,
  step: CheckinWorkflowStep,
  log: StepLog,
  hooks: WorkflowRunHooks,
  budget: WorkflowExecutionBudget,
  depth: number,
  followingSteps: readonly CheckinWorkflowStep[],
): Promise<WorkflowRunResult | null> {
  const waitGuard: WorkflowWaitGuard | undefined = hooks.checkpoint || hooks.beforeAction ? async () => {
    const interrupted = await hooks.checkpoint?.({ phase: 'waiting', step });
    if (interrupted) throw new WorkflowWaitInterrupted(interrupted);
    if (!hooks.checkpoint && hooks.beforeAction && hasObjectiveChallengeEvidence()
      && !await hooks.beforeAction()) {
      throw new WorkflowWaitInterrupted({ status: 'failed', message: '工作流等待期间的人机验证未完成' });
    }
  } : undefined;

  switch (step.type) {
    case 'if': {
      const branch = conditionMatches(step.condition) ? step.then : (step.else ?? []);
      if (branch.length === 0) return null;
      // 分支共用同一执行器，但不允许递归嵌套到失控；验证层和运行时都限制总步数。
      for (const [index, nested] of branch.entries()) {
        if (!isWorkflowStep(nested)) return { status: 'failed', message: '工作流条件分支包含无效步骤' };
        if (nested.type === 'navigate') {
          return { status: 'failed', message: '条件分支不能包含 navigate，请把跳转放在工作流第一步' };
        }
        const result = await runStep(site, nested, log, hooks, budget, depth + 1, branch.slice(index + 1));
        if (result) return result;
      }
      return null;
    }
    case 'navigate': {
      if (!step.url?.trim()) return { status: 'failed', message: '工作流跳转步骤缺少 url' };
      let target: URL;
      try {
        target = new URL(step.url, location.href);
      } catch {
        return { status: 'failed', message: `工作流跳转地址无效: ${step.url}` };
      }
      if (!isSameSiteUrl(site, target.href)) {
        return { status: 'failed', message: '工作流跳转地址必须与站点同源' };
      }
      if (!sameLocation(target)) {
        log.push(`工作流进入 ${target.pathname}${target.search}${target.hash}`);
        return { status: 'navigate', url: target.href };
      }
      return null;
    }

    case 'click': {
      if (!step.selector?.trim()) return { status: 'failed', message: '工作流点击步骤缺少 selector' };
      const timeout = clampTimeout(step.timeoutMs, DEFAULT_ELEMENT_TIMEOUT_MS);
      const recordedScroll = budget.pendingScroll;
      delete budget.pendingScroll;
      const shouldScroll = !!step.scrollIntoView || !!recordedScroll;
      const scrollContainer = step.scrollContainer ?? recordedScroll?.container;
      // 只替代签到动作；中间页导航仍须按原控件或完整指纹回放。
      const checkinActionStep = !budget.routeNext && isCheckinActionStep(step);
      let snapshot: CheckinSnapshotVerdict = { kind: 'none' };
      let snapshotTarget = false;
      const recovery: TargetRecovery<HTMLElement> | undefined = checkinActionStep ? {
        locate: () => {
          snapshot = snapshotCheckinControls(document, step.fingerprint);
          if (snapshot.kind !== 'action') return null;
          if (step.fingerprint) rescueVerifiedElements.set(snapshot.element, {
            fingerprint: step.fingerprint, textMatch: 'checkin',
          });
          snapshotTarget = true;
          log.push(`工作流按页面控件快照命中签到动作「${snapshot.label}」，替代失效的选择器 ${step.selector}`);
          return snapshot.element;
        },
        stop: () => snapshot.kind === 'already' || snapshot.kind === 'ambiguous',
      } : undefined;
      const snapshotResult = (): WorkflowRunResult | null => {
        if (snapshot.kind === 'already') {
          log.push(`工作流按页面控件快照判定今日已完成，跳过失效的选择器 ${step.selector}`);
          return { status: 'already', message: '页面控件快照显示今日签到已完成' };
        }
        if (snapshot.kind === 'ambiguous') {
          const message = `工作流页面控件快照命中 ${snapshot.count} 个签到候选，无法确定唯一目标，已停止`;
          log.push(message);
          return { status: 'failed', message };
        }
        return null;
      };
      let initialElement = await locateStepTarget<HTMLElement>(
        step.selector,
        timeout,
        shouldScroll,
        scrollContainer,
        log,
        step.fingerprint,
        recovery,
        waitGuard,
      );
      /**
       * 初次定位失败 ≠ 页面没有目标：站点可能把签到按钮藏在人机验证之后，必须先过
       * 验证才会挂载。这里复用 hasObjectiveChallengeEvidence（与 waitForChallenge
       * 同源，只看客观验证证据）：只有确认页面当前存在需处理的验证、且上层提供了
       * beforeAction 钩子时才补救；没有验证时零开销、零行为变化，失败语义与文案不变。
       */
      let challengeHandledBeforeLocate = false;
      if (!initialElement) {
        const settled = snapshotResult();
        if (settled) return settled;
        /**
         * 公告遮罩会连「定位」一起挡掉：内容区还没渲染出来，先定位必然超时。
         * 这时先清一次遮挡再重试定位；没有遮挡时整段直接跳过，不增加耗时，
         * 也不改变原有失败语义。
         */
        if (document.body && [...document.body.querySelectorAll<HTMLElement>('body > *')]
          .some((node) => node !== document.body && getComputedStyle(node).position === 'fixed')) {
          await dismissAnnouncements(site, log, { waitForAppear: false });
          initialElement = await locateStepTarget<HTMLElement>(
            step.selector,
            Math.max(1, Math.min(timeout, 3_000)),
            shouldScroll,
            scrollContainer,
            log,
            step.fingerprint,
            recovery,
            waitGuard,
          );
        }
        if (!initialElement && hooks.beforeAction && hasObjectiveChallengeEvidence()) {
          log.push('工作流定位失败后检测到人机验证，完成验证后重试定位');
          const challengeStartedAt = Date.now();
          if (await hooks.beforeAction()) {
            challengeHandledBeforeLocate = true;
            // 验证已处理完，只把剩余预算（至少留一点）交给重定位这一次尝试。
            initialElement = await locateStepTarget<HTMLElement>(
              step.selector,
              Math.max(1, timeout - (Date.now() - challengeStartedAt)),
              shouldScroll,
              scrollContainer,
              log,
              step.fingerprint,
              recovery,
              waitGuard,
            );
          }
        }
        if (!initialElement) {
          const mismatch = fingerprintFailureMessage(step.selector, step.fingerprint, '点击');
          // 目标根本定位不到：没有「附近」可言，也就没有可靠的 already 证据，
          // 不读整页文本，如实报失败。
          return settleClickFailure(mismatch ?? `工作流找不到可点击元素: ${step.selector}`, log, null);
        }
      }
      // 补救成功时验证已经在上面处理完，不再重复调用 beforeAction。
      if (!challengeHandledBeforeLocate && hooks.beforeAction && !await hooks.beforeAction()) {
        return { status: 'failed', message: '工作流点击前的人机验证未完成，已停止点击' };
      }

      // 验证完成后组件可能整体重绘，必须按同一声明式选择器重新定位（同样允许扫掠重试）。
      let element = challengeHandledBeforeLocate || !hooks.beforeAction
        ? initialElement
        : await locateStepTarget<HTMLElement>(step.selector, timeout, shouldScroll, scrollContainer, log, step.fingerprint, recovery, waitGuard);
      if (!element) {
        const settled = snapshotResult();
        if (settled) return settled;
        const mismatch = fingerprintFailureMessage(step.selector, step.fingerprint, '点击');
        // 重定位落空，但验证前的 initialElement 还在：证据范围取它最近的可判定容器，
        // 仍不读整页文本。
        return settleClickFailure(
          mismatch ?? `完成人机验证后工作流找不到可点击元素: ${step.selector}`,
          log,
          initialElement,
        );
      }
      // 执行动作前再核验一次指纹：宁可报「命中了错误的元素」，也不把错误控件当成目标点。
      // 这对应「选择器还在、但它指的已经不是当初那个元素」——比静默点空好排查一万倍。
      if (step.fingerprint && !verifyStepFingerprint(element, step.fingerprint, step.selector, log)) {
        return {
          status: 'failed',
          message: `工作流点击选择器命中了错误的元素: ${step.selector}`
            + `（期望 ${describeFingerprint(step.fingerprint)}，实际 ${describeFingerprint(readFingerprint(element))}）`,
        };
      }
      const connectedBeforeCleanup = element.isConnected;
      const blocker = await clearClickBlocker(element, site, log, '工作流控件');
      if (blocker) {
        return { status: 'failed', message: '工作流点击目标仍被遮挡，可能有未关闭的公告弹窗' };
      }
      if (connectedBeforeCleanup && !element.isConnected) {
        element = await locateStepTarget<HTMLElement>(step.selector, timeout, shouldScroll, scrollContainer, log, step.fingerprint, recovery, waitGuard);
        if (!element || step.fingerprint && !verifyStepFingerprint(element, step.fingerprint, step.selector, log)) {
          return { status: 'failed', message: `公告处理后无法重新确认工作流控件: ${step.selector}` };
        }
        if (await clearClickBlocker(element, site, log, '工作流控件') || !element.isConnected) {
          return { status: 'failed', message: '公告处理后工作流控件仍不稳定，已停止点击' };
        }
      }
      /**
       * 学习时用户是先滚下去才够得着这个控件的（页面很长），回放时就先滚进视口。
       *
       * `realClick` 内部也会 `scrollIntoView`，但那是**点击前的一瞬**：元素若在
       * 视口外，它会因位置不稳而报「目标控件在视口之外」「位置仍在变化」。
       * 这里提前滚一次，让位置先稳定下来；`scrollIntoView` 不依赖录制时的绝对像素，
       * 页面高度变了也仍然有效。
       */
      if (shouldScroll || snapshotTarget || rescueVerifiedElements.has(element)) {
        element.scrollIntoView({ block: 'center', inline: 'center' });
        log.push(`工作流将已定位的 ${step.selector} 滚入视口`);
        await sleep(150);
      }
      try {
        if (budget.routeNext) {
          log.push(`工作流回放中间页点击 ${step.selector}`);
          await hooks.beforeNavigate?.();
        }
        // 定位、验证、公告处理可能等待很久，真正派发动作前再核对一次当前会话。
        const interrupted = await hooks.checkpoint?.({ phase: 'action', step });
        if (interrupted) return interrupted;
        if (connectedBeforeCleanup && !element.isConnected) {
          return { status: 'failed', message: '会话核验期间工作流控件已变化，已停止点击' };
        }
        // 落点/手势/键盘语义全部作为 options 透传给 realClick（dom-utils 的 normalizeClickInput
        // 负责校验与规整；可信指针通道按同一份 anchor/gesture/key 派发）。选项按需透传：
        // 步骤没带 anchor/gesture/key 时选项对象保持 { mayNavigate }，与历史行为/断言完全一致。
        const clickMode = await realClick(element, {
          mayNavigate: !!budget.routeNext,
          ...(step.anchor ? { anchor: step.anchor } : {}),
          ...(step.gesture ? { gesture: step.gesture } : {}),
          ...(step.key ? { key: step.key } : {}),
          ...(step.holdMs != null ? { holdMs: step.holdMs } : {}),
        });
        const clickAction = step.key
          ? `用键盘 ${step.key} 触发`
          : step.gesture === 'double'
            ? '双击'
            : step.gesture === 'right'
              ? '右键点击'
              : step.gesture === 'long-press'
                ? '长按'
                : '点击';
        const clickSuffix = clickMode === 'dom' ? '（DOM 合成点击，未使用浏览器可信指针）' : '';
        log.push(`工作流已${clickAction} ${step.selector}${clickSuffix}`);
      } catch (error) {
        // 点击异常不一定是终点：当天已签到时，目标常被换成不可点的状态控件，
        // 页面上现成的 already 证据比「点击失败」更接近事实（见 settleClickFailure）。
        return settleClickFailure(
          `工作流点击失败: ${error instanceof Error ? error.message : String(error)}`,
          log,
          element,
        );
      }
      if (budget.routeNext && `${location.pathname}${location.hash}` !== budget.sourcePath) {
        const expected = new URL(budget.routeNext);
        if (location.origin !== expected.origin || `${location.pathname}${location.hash}` !== `${expected.pathname}${expected.hash}`) {
          return { status: 'failed', message: '学习流程点击后离开了预期页面，已停止后续操作' };
        }
        // 交还引擎：新页面必须重新经过身份闸门，不能在旧文档调用栈里继续签到。
        return { status: 'navigate', url: expected.href };
      }
      /**
       * 中间页点击同样可能弹验证：点击后提示「已点击」，下一跳却悄悄失败，
       * 用户完全看不到原因。因此中间页与终点一视同仁，只是文案区分。
       */
      if (hooks.afterAction && !await hooks.afterAction()) {
        return {
          status: 'failed',
          message: budget.routeNext
            ? '中间页点击后的人机验证未完成，已停止后续操作'
            : '工作流点击后的人机验证未完成，已停止后续步骤',
        };
      }
      if (step.waitFor?.trim() && !await waitWithEnvironment((windowMs) => waitFor(step.waitFor!, windowMs), timeout, waitGuard)) {
        return { status: 'failed', message: `点击后未出现 ${step.waitFor}` };
      }
      return null;
    }

    case 'fill': {
      if (!step.selector?.trim()) return { status: 'failed', message: '工作流填充步骤缺少 selector' };
      if (typeof step.value !== 'string') return { status: 'failed', message: '工作流填充步骤缺少 value' };
      const timeout = clampTimeout(step.timeoutMs, DEFAULT_ELEMENT_TIMEOUT_MS);
      // 输入框同样可能懒渲染在视口下方：带 scrollIntoView 时首屏落空就下滚重试。
      const recordedScroll = budget.pendingScroll;
      delete budget.pendingScroll;
      const shouldScroll = !!step.scrollIntoView || !!recordedScroll;
      let element = await locateStepTarget<HTMLElement>(step.selector, timeout, shouldScroll, step.scrollContainer ?? recordedScroll?.container, log, step.fingerprint, undefined, waitGuard);
      if (!element) {
        const mismatch = fingerprintFailureMessage(step.selector, step.fingerprint, '填充');
        return { status: 'failed', message: mismatch ?? `工作流找不到可输入元素: ${step.selector}` };
      }
      const connectedBeforeCleanup = element.isConnected;
      if (await clearClickBlocker(element, site, log, '工作流输入控件')) {
        return { status: 'failed', message: '工作流输入目标仍被公告遮挡，已停止输入' };
      }
      if (connectedBeforeCleanup && !element.isConnected) {
        element = await locateStepTarget<HTMLElement>(step.selector, timeout, shouldScroll, step.scrollContainer ?? recordedScroll?.container, log, step.fingerprint, undefined, waitGuard);
        if (!element || await clearClickBlocker(element, site, log, '工作流输入控件') || !element.isConnected) {
          return { status: 'failed', message: `公告处理后无法重新确认工作流输入控件: ${step.selector}` };
        }
      }
      // 执行前再核验一次指纹（同 click）：选择器命中错误元素时如实报出，不静默填错框。
      if (step.fingerprint && !verifyStepFingerprint(element, step.fingerprint, step.selector, log)) {
        return {
          status: 'failed',
          message: `工作流填充选择器命中了错误的元素: ${step.selector}`
            + `（期望 ${describeFingerprint(step.fingerprint)}，实际 ${describeFingerprint(readFingerprint(element))}）`,
        };
      }
      // 输入框在视口下方时先滚过去：`fillEditable`/`setNativeValue` 只 focus()，不 focus 不到就静默不生效。
      if ((shouldScroll || rescueVerifiedElements.has(element)) && typeof element.scrollIntoView === 'function') {
        element.scrollIntoView({ block: 'center', inline: 'center' });
        await sleep(150);
      }

      const interrupted = await hooks.checkpoint?.({ phase: 'action', step });
      if (interrupted) return interrupted;
      if (connectedBeforeCleanup && !element.isConnected) {
        return { status: 'failed', message: '会话核验期间工作流输入控件已变化，已停止输入' };
      }
      const control = step.control ?? 'text';
      if (control === 'select') {
        // 下拉框按「选项序号」选中（不存文案：站点改文案也不失效）。必须走原生
        // setter + 派发 change，否则 React/Vue 受控组件收不到这次选择。
        if (element.tagName !== 'SELECT') {
          return { status: 'failed', message: `工作流填充目标不是下拉框: ${step.selector}` };
        }
        const select = element as HTMLSelectElement;
        const choice = step.choice;
        if (choice == null || !Number.isInteger(choice) || choice < 0 || choice >= select.options.length) {
          return { status: 'failed', message: `工作流下拉选项序号无效: ${String(step.choice)}（共 ${select.options.length} 项）` };
        }
        if (select.selectedIndex === choice) {
          log.push(`工作流下拉框 ${step.selector} 已是第 ${choice} 项，跳过`);
          return null;
        }
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
        const optionValue = select.options[choice]!.value;
        if (setter) setter.call(select, optionValue);
        else select.value = optionValue;
        select.selectedIndex = choice;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        log.push(`工作流已选择 ${step.selector} 第 ${choice} 项`);
        return null;
      }
      if (control === 'checkbox' || control === 'radio') {
        // 复选/单选按「目标态」设置，而不是「点一下翻转」——翻转式回放会在
        // 「已经勾上了」的页面上把勾取消掉。已经对了就跳过。
        const input = element as HTMLInputElement;
        if (element.tagName !== 'INPUT' || (input.type !== 'checkbox' && input.type !== 'radio')) {
          return { status: 'failed', message: `工作流填充目标不是${control === 'radio' ? '单选' : '复选'}框: ${step.selector}` };
        }
        const target = step.checked ?? true;
        if (input.checked === target) {
          log.push(`工作流${control === 'radio' ? '单选' : '复选'}框 ${step.selector} 已是${target ? '选中' : '未选中'}，跳过`);
          return null;
        }
        input.click();
        log.push(`工作流已${target ? '勾选' : '取消勾选'} ${step.selector}`);
        return null;
      }

      // 文本框（缺省）：行为与旧流程一致。
      if (!isFillable(element)) {
        return { status: 'failed', message: `工作流找不到可输入元素: ${step.selector}` };
      }
      fillEditable(element, interpolate(step.value ?? '', site));
      log.push(`工作流已填充 ${step.selector}`);
      return null;
    }

    case 'scroll': {
      // 连续滚动之后有明确的操作目标：合并成一次目标定位，让浏览器滚动它的真实祖先。
      // 旧的 21% / 43% 受页面高度影响，不能在目标已存在时仍照比例来回滚。
      const next = followingSteps.find((candidate) => candidate.type !== 'scroll');
      if (next?.type === 'click' || next?.type === 'fill') {
        if (!budget.pendingScroll) log.push(`工作流合并录制滚动，先定位后续控件 ${next.selector}`);
        budget.pendingScroll = { container: step.container ?? budget.pendingScroll?.container };
        return null;
      }
      // 独立滚动没有后续目标，保留原有比例语义。
      const ratio = Number.isFinite(step.ratio) ? Math.min(1, Math.max(0, step.ratio)) : 0;
      const timeout = clampTimeout(step.timeoutMs, DEFAULT_ELEMENT_TIMEOUT_MS);
      let deadline = Date.now() + timeout;

      // 滚动表面：内层容器优先，缺省滚页面。返回当前 scrollTop / 可滚范围。
      const surface = (() => {
        if (step.container) {
          const recorded = queryFirst<HTMLElement>(step.container);
          const valid = recorded && isScrollContainer(recorded);
          const container = valid ? recorded : currentScrollContainers()[0];
          if (!valid) log.push(`工作流学习滚动容器已失效: ${step.container}，${container ? '改用当前可滚动面板' : '退回到页面滚动'}`);
          if (container) {
            return {
              label: valid ? `容器 ${step.container}` : '当前可滚动面板',
              top: () => container.scrollTop,
              max: () => Math.max(0, container.scrollHeight - container.clientHeight),
              scrollBy: (dy: number) => { container.scrollTop += dy; },
            };
          }
        }
        return {
          label: '页面',
          top: pageScrollY,
          max: () => Math.max(0, (document.scrollingElement ?? document.documentElement).scrollHeight - (window.innerHeight || 800)),
          scrollBy: (dy: number) => (dy > 0 ? scrollPageDown() : scrollPageUp()),
        };
      })();

      // 把「到 ratio」换算成目标 scrollTop，页面滚动以约一屏的步长逼近。
      // 每滚一段等懒加载稳定（SCROLL_RENDER_SETTLE_MS），并重读可滚范围（无限滚动会变长）。
      const settleMs = clampTimeout(step.settleMs, 400);
      log.push(`工作流滚动${surface.label}到 ${(ratio * 100).toFixed(0)}%`);
      let guard = 0;
      while (guard < MAX_SCROLL_ATTEMPTS && Date.now() < deadline) {
        guard += 1;
        const pausedAt = Date.now();
        await waitGuard?.();
        deadline += Math.max(0, Date.now() - pausedAt);
        const target = ratio * surface.max();
        const current = surface.top();
        const delta = target - current;
        if (Math.abs(delta) < 2) break; // 已到目标位置
        surface.scrollBy(delta);
        await sleep(SCROLL_RENDER_SETTLE_MS);
        // 位置不再变化（滚到底/卡住）就停：再滚也没有新内容。
        if (Math.abs(surface.top() - current) < 1 && Math.abs(target - surface.top()) >= 2) break;
      }
      await waitWithEnvironment(async (windowMs) => { await sleep(windowMs); return null; }, settleMs, waitGuard);
      return null;
    }

    case 'drag': {
      if (!step.selector?.trim()) return { status: 'failed', message: '工作流拖拽步骤缺少 selector' };
      if (!step.toSelector?.trim()) return { status: 'failed', message: '工作流拖拽步骤缺少 toSelector' };
      const timeout = clampTimeout(step.timeoutMs, DEFAULT_ELEMENT_TIMEOUT_MS);
      // 起点与终点都按「选择器 + 元素内 anchor」定位；懒渲染控件允许渐进扫掠找回。
      const fromEl = await locateStepTarget<HTMLElement>(step.selector, timeout, step.scrollIntoView, step.scrollContainer, log, undefined, undefined, waitGuard);
      if (!fromEl) return settleClickFailure(`工作流找不到拖拽起点: ${step.selector}`, log, null);
      const toEl = await locateStepTarget<HTMLElement>(step.toSelector, timeout, step.scrollIntoView, step.scrollContainer, log, undefined, undefined, waitGuard);
      if (!toEl) return settleClickFailure(`工作流找不到拖拽终点: ${step.toSelector}`, log, null);
      if (step.scrollIntoView && typeof fromEl.scrollIntoView === 'function') {
        fromEl.scrollIntoView({ block: 'center', inline: 'center' });
        await sleep(150);
      }
      // 拖拽的真实按住→移动→松开原语 realDrag 由 dom-utils 提供（落点/轨迹属智能体 C 的职责）。
      // 已落地则把契约字段原样透传；尚未落地时如实报「等待 realDrag」，绝不退回 window
      // 级合成拖动糊弄（滑条/可排序列表对合成轨迹的判定与真实指针不同，会静默失败）。
      const realDrag = (domUtils as unknown as {
        realDrag?: (
          fromEl: HTMLElement,
          toEl: HTMLElement,
          options: {
            fromAnchor?: WorkflowPointerAnchor;
            toAnchor?: WorkflowPointerAnchor;
            steps?: number;
          },
        ) => Promise<unknown>;
      }).realDrag;
      if (typeof realDrag !== 'function') {
        return {
          status: 'failed',
          message: `工作流拖拽原语 realDrag 尚未在 dom-utils 落地，无法回放拖拽 ${step.selector} → ${step.toSelector}`,
        };
      }
      try {
        const interrupted = await hooks.checkpoint?.({ phase: 'action', step });
        if (interrupted) return interrupted;
        await realDrag(fromEl, toEl, {
          fromAnchor: step.anchor,
          toAnchor: step.toAnchor,
          steps: step.steps,
        });
      } catch (error) {
        return settleClickFailure(
          `工作流拖拽失败: ${error instanceof Error ? error.message : String(error)}`,
          log,
          fromEl,
        );
      }
      log.push(`工作流已拖拽 ${step.selector} 到 ${step.toSelector}`);
      return null;
    }

    case 'wait': {
      if (step.selector?.trim() && step.ms !== undefined) {
        return { status: 'failed', message: '工作流等待步骤只能设置 selector 或 ms 其中一个' };
      }
      if (step.selector?.trim()) {
        const timeout = clampTimeout(step.timeoutMs, DEFAULT_ELEMENT_TIMEOUT_MS);
        if (!await waitWithEnvironment((windowMs) => waitFor(step.selector!, windowMs), timeout, waitGuard)) {
          return { status: 'failed', message: `工作流等待超时: ${step.selector}` };
        }
        return null;
      }
      await waitWithEnvironment(async (windowMs) => { await sleep(windowMs); return null; }, clampTimeout(step.ms, 500), waitGuard);
      return null;
    }

    case 'assert': {
      const hasSelector = typeof step.selector === 'string' && step.selector.trim().length > 0;
      const hasText = Array.isArray(step.text) && step.text.some((word) => typeof word === 'string' && word.trim());
      if (!hasSelector && !hasText) {
        return { status: 'failed', message: '工作流断言需要 selector 或 text' };
      }
      const matched = await waitForAssertion(step, waitGuard);
      if (!matched) {
        if (step.optional) return null;
        return { status: 'failed', message: '工作流断言未命中' };
      }
      if (step.result === 'already') return { status: 'already', message: '工作流确认今日已完成' };
      if (step.result === 'success') return { status: 'success', message: '工作流命中成功证据' };
      return null;
    }

    case 'leilei-daily': {
      // 专用流程内部可能连续点击多次；每次都走相同闸门，中断不得被内部 catch 改成失败。
      let interrupted: Extract<WorkflowRunResult, { status: 'interrupted' | 'failed' }> | null = null;
      const checkpoint = async (phase: WorkflowCheckpoint['phase']): Promise<boolean> => {
        if (interrupted) return false;
        interrupted = await hooks.checkpoint?.({ phase, step }) ?? null;
        return !interrupted;
      };
      const actionHooks = {
        beforeAction: async () => await checkpoint('before') && (!hooks.beforeAction || await hooks.beforeAction()),
        beforeDispatch: () => checkpoint('action'),
        afterAction: async () => (!hooks.afterAction || await hooks.afterAction()) && await checkpoint('after'),
      };
      const result = await runLeileiDaily(site, log, actionHooks);
      return interrupted ?? result;
    }

    default:
      return { status: 'failed', message: `不支持的工作流步骤: ${String((step as { type?: unknown }).type)}` };
  }
}

/** 执行一个不含任意脚本的站点签到工作流。 */
export async function runCheckinWorkflow(
  site: SiteConfig,
  workflow: CheckinWorkflowConfig | undefined,
  log: StepLog,
  hooks: WorkflowRunHooks = {},
): Promise<WorkflowRunResult> {
  if (!workflow || !Array.isArray(workflow.steps) || workflow.steps.length === 0) {
    return { status: 'failed', message: '工作流没有配置任何步骤' };
  }
  if (workflow.steps.length > MAX_WORKFLOW_STEPS) {
    return { status: 'failed', message: `工作流最多支持 ${MAX_WORKFLOW_STEPS} 个步骤` };
  }
  // 学习路线优先于 steps：路线非空时当前页多半不是签到页，必须先把页面
  // 推进到路线终点。已在终点则不导航，直接执行 steps（老配置 route 缺失，
  // 行为完全不变）。
  const routeResult = resolveRoute(site, workflow.route, log);
  if (routeResult) {
    if (routeResult.status !== 'navigate') return routeResult;
    const current = `${location.pathname}${location.hash}`;
    const onRoute = workflow.route?.some((path) => {
      const url = routeUrl(site, path);
      return url && `${url.pathname}${url.hash}` === current;
    });
    if (!onRoute) return routeResult;
    // 原实现这里立即导航，所有中间页 if(path) 的动作永远执行不到。
    // 只回放属于当前页的守卫块；终点的裸步骤仍须等身份核验后才能执行。
    const budget: WorkflowExecutionBudget = { steps: 0, sourcePath: current, routeNext: routeResult.url };
    for (const step of workflow.steps) {
      if (step.type !== 'if' || step.condition.type !== 'path' || !conditionMatches(step.condition)) continue;
      const result = await runStep(site, step, log, hooks, budget);
      if (!result) continue;
      /**
       * 中间页的动作只负责「去下一页」，而下一页的地址学习路线里本来就有。
       *
       * 流程是站内所有账号共用的：演示账号点的可能是印着自己名字的头像菜单，换个
       * 账号页面上就没有这个控件。还没点下去就找不到时，直接按路线进下一页 ——
       * 下一页照样要过身份核对，绕过的只是一个导航动作，不是签到也不是核对。
       * 已经点下去却跳到了别处（`failed` 但当前页变了）仍然如实失败。
       */
      if (result.status === 'failed' && `${location.pathname}${location.hash}` === current
        && /找不到|选择器|指纹|命中了错误|已失效/.test(result.message)) {
        log.push(`中间页的动作没能完成（${result.message}），按学习路线直接进入下一页`);
        return routeResult;
      }
      return result;
    }
    return routeResult;
  }
  const budget: WorkflowExecutionBudget = { steps: 0 };
  for (const [index, rawStep] of workflow.steps.entries()) {
    if (!isWorkflowStep(rawStep)) {
      return { status: 'failed', message: `工作流第 ${index + 1} 步格式无效` };
    }
    // 导航会销毁当前 content script；下一轮只能从步骤 0 重新启动。
    // 因此运行时也阻止手工写入的多页工作流，避免反复跳回第一步。
    if (rawStep.type === 'navigate' && index !== 0) {
      return { status: 'failed', message: '工作流的 navigate 只能放在第一步' };
    }
    const result = await runStep(site, rawStep, log, hooks, budget, 0, workflow.steps.slice(index + 1));
    if (result) return result;
  }

  /**
   * 步骤跑完不等于签到成功。
   *
   * 用户实测：学习出的流程点完了，日志只有「工作流步骤已完成」，而页面其实什么都没发生
   * （学到的是别的元素、或签到没生效）。原来这里无条件返回 success，等于把「点到了」
   * 当成「签到了」—— 用户看到的就是「一直卡在核对」却永远没有结论。
   *
   * 因此改为读页面证据：有证据才报成功/已完成，读不到就如实说未确认，
   * 让上层（余额差分等）继续判定，而不是由工作流替它下结论。
   */
  /**
   * 步骤跑完 ≠ 页面立刻出现结果：签到接口返回后，成功 toast / 「今日已签到」
   * 往往晚几百毫秒到几秒才挂载。只看一眼就判 unknown，会让一次真实成功的签到
   * 落到「未确认」，用户第二天看到的是失败。
   *
   * 这里只做**有界重读**（6 秒、每 400ms），不重放任何点击：已经点过的动作绝不
   * 重复执行。超时后仍读不到才如实返回 unknown，交给余额差分等上层证据。
   */
  let deadline = Date.now() + OUTCOME_EVIDENCE_WAIT_MS;
  /**
   * 同时受「截止时间」与「最大轮数」约束。
   *
   * 单测与部分宿主把 sleep 替换成立即返回，此时 Date.now 不前进，只靠截止时间会
   * 变成死循环。轮数是兜底，不改变真实环境下的 6 秒语义。
   */
  for (let attempt = 0; attempt < OUTCOME_EVIDENCE_MAX_READS; attempt += 1) {
    const checkpointStartedAt = Date.now();
    const interrupted = await hooks.checkpoint?.({ phase: 'result' });
    if (interrupted) return interrupted;
    // 会话检查也会接管晚出现的验证，不能挤占站点显示结果的时间。
    deadline += Math.max(0, Date.now() - checkpointStartedAt);
    if (hooks.whileWaitingForResult) {
      const startedAt = Date.now();
      const challenge = await hooks.whileWaitingForResult();
      if (!challenge.resolved) {
        log.push('签到结果等待期间检测到人机验证，未能完成');
        return { status: 'failed', message: '签到结果等待期间的人机验证未完成' };
      }
      // 验证可能花几分钟；完成后仍应给站点完整的结果渲染时间。
      if (challenge.detected) {
        deadline += Math.max(0, Date.now() - startedAt);
        // 验证器也可能异步切换会话；不能拿验证前的身份配验证后的成功提示。
        const recheckStartedAt = Date.now();
        const interrupted = await hooks.checkpoint?.({ phase: 'result' });
        if (interrupted) return interrupted;
        deadline += Math.max(0, Date.now() - recheckStartedAt);
      }
    }
    const settled = settleWorkflowOutcome(readWorkflowOutcomeEvidence(), log);
    if (settled.status === 'success') return { status: 'success', message: settled.message };
    if (settled.status === 'already') return { status: 'already', message: settled.message };
    if (Date.now() >= deadline) return { status: 'unknown', message: settled.message };
    await sleep(OUTCOME_EVIDENCE_POLL_MS);
  }
  return { status: 'unknown', message: '工作流步骤已执行完，未读到签到结果证据' };
}
