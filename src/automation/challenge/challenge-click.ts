import type { PointerTargetDiagnostics, TurnstileReadinessDiagnostics } from '@/lib/messages/pointer';
import { realClick, sleep } from '@/automation/shared/dom-utils';
import type { StepLog } from '@/automation/login/steps';

export type ClickChallengeKind = 'Turnstile' | 'reCAPTCHA' | 'hCaptcha';

export interface ChallengeClickStrategy {
  /** The challenge owns an iframe or closed shadow tree below the visible host. */
  shadowTarget?: boolean;
  /** Fixed distance from the host's left edge to the real checkbox centre. */
  insetLeftPx?: number;
  /** Minimum age of a newly mounted host before the first trusted click. */
  minVisibleMs?: number;
  /** Conservative host age required when the inner control cannot be observed. */
  safetyWindowMs?: number;
  /** How long a pending response field may wait for its visible host to mount. */
  mountWaitMs?: number;
  /** How long to observe response-field attachment and stable host geometry. */
  layoutWaitMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  responseWaitMs?: number;
  debugVisualize?: boolean;
}

export interface ClickChallengeDefinition {
  kind: ClickChallengeKind;
  selectors: string;
  tokenSelectors: string;
  /**
   * Optional runtime candidates for widgets that do not expose a stable
   * light-DOM selector (for example a Cloudflare closed-shadow host).
   * Candidates are still passed through the shared visibility/layout/click
   * pipeline; the resolver must only return elements with strong evidence.
   */
  candidateElements?: () => Element[];
  strategy?: ChallengeClickStrategy;
}

export interface ChallengeInteractionContext {
  log: StepLog;
  detectedAt: number;
  deadline: number;
  isComplete: (widget?: Element) => boolean;
}

type VisibleWidgetResult =
  | { state: 'ready'; widgets: Element[]; appearedAt: number }
  | { state: 'completed' }
  | { state: 'missing' };

type PreparedWidget =
  | { state: 'ready'; widget: Element }
  | { state: 'completed' }
  | { state: 'missing' }
  | { state: 'timed-out' };

const DEFAULT_MOUNT_WAIT_MS = 10_000;
const DEFAULT_LAYOUT_WAIT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1_200;
const DEFAULT_RESPONSE_WAIT_MS = 20_000;
const WIDGET_POLL_MS = 250;
const LAYOUT_POLL_MS = 300;
const DISAPPEARANCE_GRACE_MS = 1_500;
const POINTER_DEADLINE_BUFFER_MS = 1_000;

function queryAll(selectors: string): Element[] {
  if (!selectors.trim()) return [];
  try {
    return [...document.querySelectorAll(selectors)];
  } catch {
    return [];
  }
}

function candidateElements(definition: ClickChallengeDefinition): Element[] {
  const candidates = definition.candidateElements?.() ?? [];
  return candidates.filter((element): element is Element => element instanceof Element);
}

function allWidgets(definition: ClickChallengeDefinition): Element[] {
  return [...new Set([...queryAll(definition.selectors), ...candidateElements(definition)])];
}

export function isChallengeElementVisible(element: Element): boolean {
  if (!element.isConnected || element.getClientRects().length === 0) return false;

  let current: Element | null = element;
  while (current) {
    const style = window.getComputedStyle(current);
    if (
      style.display === 'none'
      || style.visibility === 'hidden'
      || style.visibility === 'collapse'
      || style.opacity === '0'
      || current.getAttribute('aria-hidden') === 'true'
      || (current instanceof HTMLElement && current.hidden)
    ) {
      return false;
    }
    current = current.parentElement;
  }

  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * 视口内判定的安全边距（像素）。
 *
 * 真实指针点击走 chrome.debugger 的 `Input.dispatchMouseEvent`，用的是**视口坐标**；
 * 控件中心正好压在视口边缘时，按下与抬起之间页面只要抖动一下，坐标就会落到视口外
 * 的另一个元素上。这里留 2px 只是把「正好压在边上」判成不在视口内，不改变判定粒度。
 */
const VIEWPORT_EDGE_MARGIN_PX = 2;

/**
 * 「滚动再判」的尝试上限：**最多两次**。
 *
 * 为什么是 2：第一次滚动解决绝大多数「控件挂在视口下方」的情况；第二次留给异步
 * 滚动（平滑滚动、内层滚动容器）这种一次滚不到位的场景。再多不会带来新信息 ——
 * 页面要么滚得动（一次就够），要么滚不动（几次都一样），继续滚只会把用户眼前的
 * 页面反复推动。
 */
const DEFAULT_REVEAL_MAX_ATTEMPTS = 2;

/** 每次滚动后等待布局稳定的时间：滚动（含平滑滚动）异步生效，立刻采样会读到旧矩形。 */
const REVEAL_SETTLE_MS = 180;

/**
 * 一轮「滚动再判」的总耗时上限：1 秒量级。
 *
 * 这段时间加在**快照窗口之内**。调用方给快照的窗口本身只有 2.5 秒，滚动占掉一大半
 * 就等于把刚修好的「有界快照」又变回「长时间不动」，所以必须比窗口小一个量级。
 */
const DEFAULT_REVEAL_BUDGET_MS = 1_000;

/** 一次扫描最多保留多少个验证码候选，避免在超长页面上逐个滚动。 */
const MAX_REVEAL_CANDIDATES = 8;

/**
 * 控件是否在**当前视口**内。
 *
 * 这与 `isChallengeElementVisible` 是两件不同的事，谁也不能替代谁：
 *   - 可见性（display/visibility/尺寸）回答「这个控件到底存不存在、有没有布局」；
 *   - 视口位置回答「现在能不能真的点到它」—— 真实指针点击的坐标就是视口坐标，
 *     落在视口外的坐标会点到别的元素，或干脆无效。
 *
 * 关键：**绝不能把「视口外」当成「不可见」**。控件可能只是需要滚动才看得到，
 * 判成不可见就会把真实存在的验证码漏掉（用户明明需要过验证），那比多点一次更严重。
 * 视口外只意味着「要滚一下再看」，由 `revealOffscreenChallengeCandidates` 负责。
 */
export function isChallengeElementInViewport(element: Element): boolean {
  if (!element.isConnected) return false;
  const rect = element.getBoundingClientRect();
  // 没有布局盒（尚未渲染 / 宽高为 0）时不能当作「在视口内」：这类控件正是
  // 「滚进视口才会被真正渲染」的那一类，交给滚动再判处理。
  if (rect.width <= 0 || rect.height <= 0) return false;

  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const width = window.innerWidth;
  const height = window.innerHeight;
  // 视口尺寸读不到（极少见的降级环境）时不下「视口外」的结论：误判成视口外只会
  // 多滚一次（并可能把页面推走），误判成视口内则回到修复前的行为，两者都可接受，
  // 但不能因为读不到尺寸就把控件判成不存在。
  if (!(width > 0) || !(height > 0)) return true;

  return centerX >= VIEWPORT_EDGE_MARGIN_PX
    && centerY >= VIEWPORT_EDGE_MARGIN_PX
    && centerX <= width - VIEWPORT_EDGE_MARGIN_PX
    && centerY <= height - VIEWPORT_EDGE_MARGIN_PX;
}

/**
 * 「可能承载验证码」的候选选择器（**刻意比客观判据宽**）。
 *
 * 这份列表只决定「值得把页面滚到哪里」，**从不参与**「有没有验证码」的判定 ——
 * 判定仍然只有一处（`challenge.ts` 的 `hasObjectiveChallengeEvidence`）。
 * 宽一点是安全的：多几个普通元素只会多花一次轻微滚动；漏掉候选的代价却是真实
 * 验证码继续待在视口下方不被渲染，快照就会误判成「本次点击没有触发验证」。
 *
 * `REVEAL_CAPTCHA_SELECTORS` 与 `challenge.ts` 的 `CLICK_CHALLENGE_DEFINITIONS`
 * 中 captcha / Turnstile / reCAPTCHA / hCaptcha 的 `selectors` 同源，改一处要同步。
 * 这里刻意保留更宽的子串匹配，不能直接换成那些定义里的 `selectors` 字符串：后者的
 * `.g-recaptcha`、`.h-captcha`、`[data-sitekey]`、`challenges.cloudflare.com` 等条件
 * 更窄，直接替换会缩小候选范围，导致视口下方的懒渲染验证控件不被滚动揭露。
 */
const REVEAL_CAPTCHA_SELECTORS = [
  'iframe[src*="captcha" i]',
  'iframe[src*="turnstile" i]',
  'iframe[src*="challenge" i]',
  'iframe[title*="captcha" i]',
  '[class*="captcha" i]',
  '[id*="captcha" i]',
  '[class*="turnstile" i]',
  '[class*="hcaptcha" i]',
  '[class*="recaptcha" i]',
] as const;

/**
 * 本文件独有，不属于 `challenge.ts` 的通用定义。
 *
 * 这几类宽匹配不在 `challenge.ts` 的 captcha / Turnstile / reCAPTCHA / hCaptcha
 * 定义中，专门用于把站点自带的第三方滑动/校验容器也纳入「值得滚动揭露」的范围。
 * 它们只影响 reveal 候选，不参与验证码判定。
 */
const REVEAL_LOCAL_SELECTORS = [
  '[class*="geetest" i]',
  '[class*="yidun" i]',
  '[class*="nc-container" i]',
  '[class*="tcaptcha" i]',
  '[class*="slider" i]',
  '[class*="verify" i]',
] as const;

/** Flattened for `querySelectorAll` and kept exported so drift is testable. */
export const REVEAL_CANDIDATE_SELECTORS = [
  ...REVEAL_CAPTCHA_SELECTORS,
  ...REVEAL_LOCAL_SELECTORS,
] as const;

const REVEAL_CANDIDATE_SELECTOR_QUERY = REVEAL_CANDIDATE_SELECTORS.join(', ');

/** 供快照层取「值得滚一下再判」的候选；判定不在这里做。 */
export function findChallengeRevealCandidates(): Element[] {
  const elements = queryAll(REVEAL_CANDIDATE_SELECTOR_QUERY);
  return elements.length > MAX_REVEAL_CANDIDATES ? elements.slice(0, MAX_REVEAL_CANDIDATES) : elements;
}

export type ChallengeRevealOutcome = 'in-viewport' | 'revealed' | 'blocked';

export interface ChallengeRevealResult {
  /**
   * `in-viewport`：没有需要滚动的候选（**零开销**路径，一次都没滚）；
   * `revealed`：滚动后候选确实进了视口，调用方应当重新判定一次；
   * `blocked`：滚不动（页面无滚动空间、没有可用的滚动锚点、环境不支持），
   * 或尝试/耗时已用尽 —— 调用方不要再重试。
   */
  outcome: ChallengeRevealOutcome;
  /** 实际发出的滚动次数。0 表示一次都没滚。 */
  attempts: number;
  /** 滚动前需要被带进视口的候选数量。 */
  offViewport: number;
}

/**
 * 为候选挑滚动锚点：元素自己没有布局盒时（`content-visibility: auto`、懒挂载、
 * iframe 尚未初始化）向上找最近的**有尺寸**祖先 —— 把祖先滚进视口，同样能让浏览器
 * 真正渲染这块内容；对没有盒子的元素本身调 `scrollIntoView` 是无效的。
 */
function scrollAnchorFor(element: Element): Element | null {
  let current: Element | null = element;
  while (current) {
    const rect = current.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return current;
    current = current.parentElement;
  }
  return null;
}

function rectSignature(element: Element): string {
  const rect = element.getBoundingClientRect();
  return `${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)},${Math.round(rect.height)}`;
}

function scrollOffsetSignature(): string {
  const x = typeof window.scrollX === 'number' ? window.scrollX : 0;
  const y = typeof window.scrollY === 'number' ? window.scrollY : 0;
  return `${Math.round(x)},${Math.round(y)}`;
}

function scrollIntoViewVertically(anchor: Element): boolean {
  // jsdom 等无布局环境没有实现 scrollIntoView（真浏览器上个别元素也可能抛错）。
  // 滚不了就如实返回失败，让调用方立刻放弃，而不是以为滚动成功、反复重试。
  try {
    if (typeof (anchor as HTMLElement).scrollIntoView !== 'function') return false;
    anchor.scrollIntoView({ block: 'center' });
    return true;
  } catch {
    return false;
  }
}

/**
 * 「先滚再判」里的**滚动**部分：把不在视口内的验证码候选温和地带进视口，
 * 然后**重新采样**它到底进没进来。
 *
 * 为什么必须「滚 + 重新判定」而不是「不在视口 → 判成不可见」：
 * 站点常把验证控件放在视口下方，靠 `content-visibility: auto` 或
 * IntersectionObserver 懒挂载 —— 没滚到之前它宽高为 0，任何基于尺寸的可见性判据
 * 都会如实报「看不见」，于是真实验证码被漏判、任务继续往下跑。滚动让页面把这块
 * 内容真正渲染出来，之后仍然由调用方**唯一的那处客观判据**下结论。
 *
 * 温和与可回退：只用 `scrollIntoView({ block: 'center' })`（不横向跳、不模拟拖拽、
 * 不碰业务状态），滚动是用户本来就看得见的页面位移；页面滚不动时立即放弃。
 */
export async function revealOffscreenChallengeCandidates(
  candidates: readonly Element[] = findChallengeRevealCandidates(),
  options: { maxAttempts?: number; budgetMs?: number } = {},
): Promise<ChallengeRevealResult> {
  const unique = [...new Set(candidates)].filter((element) => element.isConnected);
  const pending = unique.filter((element) => !isChallengeElementInViewport(element));
  if (pending.length === 0) return { outcome: 'in-viewport', attempts: 0, offViewport: 0 };

  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_REVEAL_MAX_ATTEMPTS));
  const deadline = Date.now() + Math.max(0, options.budgetMs ?? DEFAULT_REVEAL_BUDGET_MS);
  let attempts = 0;
  let remaining = pending;

  while (attempts < maxAttempts && Date.now() < deadline) {
    const anchors = [...new Set(
      remaining.map(scrollAnchorFor).filter((anchor): anchor is Element => anchor !== null),
    )];
    if (anchors.length === 0) return { outcome: 'blocked', attempts, offViewport: pending.length };

    const beforeOffset = scrollOffsetSignature();
    const beforeRects = anchors.map(rectSignature).join('|');
    if (!scrollIntoViewVertically(anchors[0]!)) {
      return { outcome: 'blocked', attempts, offViewport: pending.length };
    }
    attempts += 1;
    await sleep(Math.min(REVEAL_SETTLE_MS, Math.max(0, deadline - Date.now())));

    remaining = remaining.filter((element) => !isChallengeElementInViewport(element));
    if (remaining.length === 0) return { outcome: 'revealed', attempts, offViewport: pending.length };

    // 滚完之后视口和锚点几何都没动 → 页面根本没有滚动空间（已到顶/到底、
    // 容器不可滚、固定布局）。再滚多少次结果都一样，立刻收手。
    const moved = scrollOffsetSignature() !== beforeOffset
      || anchors.map(rectSignature).join('|') !== beforeRects;
    if (!moved) return { outcome: 'blocked', attempts, offViewport: pending.length };
  }

  return { outcome: 'blocked', attempts, offViewport: pending.length };
}

function visibleWidgets(definition: ClickChallengeDefinition): Element[] {
  return allWidgets(definition)
    .filter(isChallengeElementVisible)
    .sort((a, b) => {
      const rectA = a.getBoundingClientRect();
      const rectB = b.getBoundingClientRect();
      return rectA.width * rectA.height - rectB.width * rectB.height;
    });
}

function currentVisibleWidget(definition: ClickChallengeDefinition): Element | null {
  return visibleWidgets(definition)[0] ?? null;
}

function currentWidgetForCandidate(
  definition: ClickChallengeDefinition,
  preferred: Element | null,
): Element | null {
  if (preferred && isChallengeElementVisible(preferred)) return preferred;
  return currentVisibleWidget(definition);
}

function queryAllWithin(root: ParentNode, selectors: string): Element[] {
  if (!selectors.trim()) return [];
  try {
    return [...root.querySelectorAll(selectors)];
  } catch {
    return [];
  }
}

function scopeForWidget(widget: Element): ParentNode {
  return widget.closest('form') ?? widget.parentElement ?? document;
}

function elementsInScope(scope: ParentNode, selectors: string): Element[] {
  const self = scope instanceof Element && (() => {
    try {
      return scope.matches(selectors);
    } catch {
      return false;
    }
  })()
    ? [scope]
    : [];
  return [...self, ...queryAllWithin(scope, selectors)];
}

function responseFieldsForWidget(definition: ClickChallengeDefinition, widget: Element): Element[] {
  const insideWidget = queryAllWithin(widget, definition.tokenSelectors);
  if (insideWidget.length > 0) return insideWidget;

  const form = widget.closest('form');
  if (form) {
    const insideForm = queryAllWithin(form, definition.tokenSelectors);
    if (insideForm.length > 0) return insideForm;
  }

  const parent = widget.parentElement;
  return parent ? queryAllWithin(parent, definition.tokenSelectors) : [];
}

function responseValue(element: Element): string {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element.value.trim();
  }
  return (element.getAttribute('value') ?? '').trim();
}

function hasPendingResponseInScope(
  definition: ClickChallengeDefinition,
  scope: ParentNode,
): boolean {
  return elementsInScope(scope, definition.tokenSelectors).some((field) => responseValue(field).length === 0);
}

function isDisabledSubmit(element: Element): boolean {
  if (element.getAttribute('aria-disabled') === 'true') return true;
  return (element instanceof HTMLButtonElement || element instanceof HTMLInputElement) && element.disabled;
}

function submitControls(scope: ParentNode): Element[] {
  return elementsInScope(
    scope,
    'button[type="submit"], input[type="submit"], button:not([type])',
  );
}

interface ChallengeScopeSnapshot {
  scope: ParentNode;
  hadDisabledSubmit: boolean;
  /** A response field must have existed in this scope before disappearance
   * can be treated as a completion signal. */
  responseFields: Element[];
  hadPendingResponse: boolean;
  /** Set only after a previously pending field is observed with a value. */
  observedResponseValue: boolean;
}

function captureChallengeScope(
  definition: ClickChallengeDefinition,
  widget: Element,
  previous?: ChallengeScopeSnapshot,
): ChallengeScopeSnapshot {
  const scope = scopeForWidget(widget);
  const responseFields = elementsInScope(scope, definition.tokenSelectors);
  const hadPendingResponse = responseFields.some((field) => responseValue(field).length === 0);
  return {
    scope,
    hadDisabledSubmit: submitControls(scope).some(isDisabledSubmit),
    responseFields,
    hadPendingResponse,
    observedResponseValue: previous?.observedResponseValue ?? false,
  };
}

function observeResponseValue(
  snapshot: ChallengeScopeSnapshot,
  definition: ClickChallengeDefinition,
): void {
  if (!snapshot.hadPendingResponse || snapshot.observedResponseValue) return;

  // Keep sampling both the original nodes and any replacement nodes. A
  // framework may replace the hidden field along with the widget after the
  // token is written, so the original node is not necessarily still in the
  // current scope when completion is checked.
  const fields = [
    ...snapshot.responseFields,
    ...elementsInScope(snapshot.scope, definition.tokenSelectors),
  ];
  snapshot.observedResponseValue = fields.some((field) => responseValue(field).length > 0);
}

function visibleWidgetsInScope(
  definition: ClickChallengeDefinition,
  scope: ParentNode,
): Element[] {
  const scopedCandidates = candidateElements(definition).filter((element) => (
    scope === document || scope instanceof Element && scope.contains(element)
  ));
  return [...new Set([
    ...elementsInScope(scope, definition.selectors),
    ...scopedCandidates,
  ])]
    .filter(isChallengeElementVisible)
    .sort((a, b) => {
      const rectA = a.getBoundingClientRect();
      const rectB = b.getBoundingClientRect();
      return rectA.width * rectA.height - rectB.width * rectB.height;
    });
}

function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

async function sleepWithin(ms: number, deadline: number): Promise<boolean> {
  const remaining = remainingMs(deadline);
  if (remaining <= 0) return false;
  await sleep(Math.min(ms, remaining));
  return Date.now() < deadline;
}

async function waitForVisibleChallengeWidget(
  definition: ClickChallengeDefinition,
  context: ChallengeInteractionContext,
): Promise<VisibleWidgetResult> {
  const initial = visibleWidgets(definition);
  if (initial.length > 0) {
    return { state: 'ready', widgets: initial, appearedAt: context.detectedAt };
  }

  const waitMs = Math.min(
    definition.strategy?.mountWaitMs ?? DEFAULT_MOUNT_WAIT_MS,
    remainingMs(context.deadline),
  );
  if (waitMs <= 0) return { state: 'missing' };

  context.log.push(
    `已识别${definition.kind}待处理状态，正在等待可见验证控件挂载（最长 ${Math.ceil(waitMs / 1000)}s）`,
  );
  const mountDeadline = Math.min(context.deadline, Date.now() + waitMs);

  while (Date.now() < mountDeadline) {
    if (context.isComplete()) {
      context.log.push(`${definition.kind}在控件挂载等待期间已出现完成信号`);
      return { state: 'completed' };
    }

    const widgets = visibleWidgets(definition);
    if (widgets.length > 0) {
      context.log.push(`${definition.kind}可见控件已挂载，进入统一点击流程`);
      return { state: 'ready', widgets, appearedAt: Date.now() };
    }

    await sleepWithin(WIDGET_POLL_MS, mountDeadline);
  }

  context.log.push(`${definition.kind}在等待窗口内仍未挂载可见控件`);
  return { state: 'missing' };
}

function findClickableTarget(root: Element): HTMLElement | null {
  const interactives = [...root.querySelectorAll(
    'input[type="checkbox"], [role="checkbox"], button:not([disabled]), [role="button"]',
  )].filter(isChallengeElementVisible);
  if (interactives.length > 0) return interactives[0] as HTMLElement;
  return root instanceof HTMLElement ? root : null;
}

type LayoutResult = 'stable' | 'completed' | 'replaced' | 'timed-out';

async function waitForWidgetLayout(
  widget: Element,
  definition: ClickChallengeDefinition,
  context: ChallengeInteractionContext,
  timeoutMs: number,
): Promise<LayoutResult> {
  const deadline = Math.min(context.deadline, Date.now() + timeoutMs);
  let previous: { width: number; height: number } | null = null;
  let stableSamples = 0;
  let sawResponseField = responseFieldsForWidget(definition, widget).length > 0;

  while (Date.now() < deadline) {
    if (context.isComplete(widget)) {
      context.log.push(`${definition.kind}在布局等待期间已出现完成信号`);
      return 'completed';
    }

    if (!widget.isConnected || !isChallengeElementVisible(widget)) {
      context.log.push(`${definition.kind}控件在布局等待期间已重绘，准备重新定位`);
      return 'replaced';
    }

    if (!sawResponseField && responseFieldsForWidget(definition, widget).length > 0) {
      sawResponseField = true;
    }

    const rect = widget.getBoundingClientRect();
    const current = { width: Math.round(rect.width), height: Math.round(rect.height) };
    const laidOut = current.width > 50 && current.height > 20;
    if (laidOut && previous && current.width === previous.width && current.height === previous.height) {
      stableSamples += 1;
    } else {
      stableSamples = 0;
    }
    previous = current;

    if (laidOut && stableSamples >= 4 && (sawResponseField || !definition.tokenSelectors.trim())) {
      context.log.push(
        `验证控件布局已稳定（${current.width}×${current.height}${sawResponseField ? '，响应字段已挂载' : ''}）`,
      );
      return 'stable';
    }

    await sleepWithin(LAYOUT_POLL_MS, deadline);
  }

  context.log.push(
    `等待${definition.kind}布局稳定超时（响应字段${sawResponseField ? '已' : '未'}挂载，尺寸${stableSamples >= 4 ? '已' : '未'}稳定），继续执行点击前保护`,
  );
  return 'timed-out';
}

type FirstClickWindowResult =
  | { state: 'ready'; widget: Element }
  | { state: 'completed' }
  | { state: 'missing' }
  | { state: 'timed-out' };

async function waitForFirstClickWindow(
  initialWidget: Element,
  definition: ClickChallengeDefinition,
  widgetSeenAt: WeakMap<Element, number>,
  context: ChallengeInteractionContext,
): Promise<FirstClickWindowResult> {
  let widget = initialWidget;
  const minVisibleMs = definition.strategy?.minVisibleMs ?? 0;

  while (Date.now() < context.deadline) {
    const seenAt = widgetSeenAt.get(widget) ?? Date.now();
    widgetSeenAt.set(widget, seenAt);
    const readyAt = Math.min(context.deadline, seenAt + minVisibleMs);
    const initialRemaining = readyAt - Date.now();

    if (initialRemaining > 0) {
      context.log.push(
        `${definition.kind}首次点击保护：再等待 ${Math.ceil(initialRemaining / 1000)}s，`
        + `执行通用 ${minVisibleMs / 1000}s 最低成熟策略`,
      );
    }

    while (Date.now() < readyAt) {
      if (context.isComplete(widget)) {
        context.log.push(`${definition.kind}在首次点击保护期间已自行完成，无需点击`);
        return { state: 'completed' };
      }

      const current = currentWidgetForCandidate(definition, widget);
      if (current && current !== widget) {
        widget = current;
        if (!widgetSeenAt.has(widget)) widgetSeenAt.set(widget, Date.now());
        context.log.push(`${definition.kind}宿主已重绘，已重新定位并重新计算成熟窗口`);
        break;
      }

      if (!await sleepWithin(WIDGET_POLL_MS, readyAt)) break;
    }

    if (context.isComplete(widget)) {
      context.log.push(`${definition.kind}在首次点击前已出现完成信号，无需点击`);
      return { state: 'completed' };
    }

    const current = currentWidgetForCandidate(definition, widget);
    if (!current) return { state: 'missing' };
    if (current !== widget) {
      widget = current;
      if (!widgetSeenAt.has(widget)) widgetSeenAt.set(widget, Date.now());
      context.log.push(`${definition.kind}宿主已重绘，已重新定位并重新计算成熟窗口`);
      continue;
    }

    if (Date.now() < seenAt + minVisibleMs) continue;
    if (minVisibleMs > 0) {
      context.log.push(
        `${definition.kind}宿主已出现 ${Math.max(0, Math.round((Date.now() - seenAt) / 100) / 10)}s，进入内部就绪检查`,
      );
    }
    return { state: 'ready', widget };
  }

  return { state: 'timed-out' };
}

async function prepareWidget(
  initialWidget: Element,
  definition: ClickChallengeDefinition,
  widgetSeenAt: WeakMap<Element, number>,
  context: ChallengeInteractionContext,
  layoutTimeoutMs: number,
): Promise<PreparedWidget> {
  let widget = initialWidget;
  let timeoutMs = layoutTimeoutMs;

  while (Date.now() < context.deadline) {
    if (!widgetSeenAt.has(widget)) widgetSeenAt.set(widget, Date.now());
    const layout = await waitForWidgetLayout(widget, definition, context, timeoutMs);
    if (layout === 'completed') return { state: 'completed' };
    if (context.isComplete(widget)) return { state: 'completed' };

    const current = currentWidgetForCandidate(definition, widget);
    if (!current) return { state: 'missing' };
    if (current !== widget || layout === 'replaced') {
      widget = current;
      if (!widgetSeenAt.has(widget)) widgetSeenAt.set(widget, Date.now());
      timeoutMs = Math.min(3_000, remainingMs(context.deadline));
      context.log.push(`${definition.kind}控件已重绘，统一点击模块已重新定位`);
      continue;
    }

    const clickWindow = await waitForFirstClickWindow(widget, definition, widgetSeenAt, context);
    if (clickWindow.state !== 'ready') return clickWindow;
    return { state: 'ready', widget: clickWindow.widget };
  }

  return { state: 'timed-out' };
}

function describeTarget(target: HTMLElement): string {
  return target.tagName.toLowerCase()
    + (target.id ? `#${target.id}` : '')
    + (target.className ? `.${String(target.className).split(/\s+/)[0]}` : '');
}

async function clickChallengeTarget(
  definition: ClickChallengeDefinition,
  widget: Element,
  widgetSeenAt: WeakMap<Element, number>,
  context: ChallengeInteractionContext,
  attempt: number,
): Promise<void> {
  const target = findClickableTarget(widget);
  if (!target) throw new Error('未找到可点击目标');

  const targetDesc = describeTarget(target);
  context.log.push(`第 ${attempt} 次点击前已定位${definition.kind}控件 ${targetDesc}`);

  const hostSurface = target === widget;
  const insetLeftPx = hostSurface ? definition.strategy?.insetLeftPx : undefined;
  const targetSeenAt = hostSurface && (definition.strategy?.minVisibleMs ?? 0) > 0
    ? widgetSeenAt.get(widget)
    : undefined;
  const safetyWindowMs = hostSurface ? definition.strategy?.safetyWindowMs : undefined;
  if (targetSeenAt != null && safetyWindowMs != null) {
    const requiredUntil = Math.max(Date.now(), targetSeenAt + safetyWindowMs) + POINTER_DEADLINE_BUFFER_MS;
    if (requiredUntil >= context.deadline) {
      throw new Error(`${definition.kind}剩余执行时间不足，已取消本轮可信点击`);
    }
  }
  let pointerTarget: PointerTargetDiagnostics | undefined;
  let screenOffsetMatches: boolean | undefined;
  let readiness: TurnstileReadinessDiagnostics | undefined;
  const clickMode = await realClick(target, {
    shadowTarget: definition.strategy?.shadowTarget ?? false,
    insetLeftPx,
    deadline: context.deadline,
    debugVisualize: Boolean(definition.strategy?.debugVisualize && hostSurface),
    targetSeenAt,
    onPointerResult: (result) => {
      pointerTarget = result.target;
      screenOffsetMatches = result.screenOffset?.matches;
      readiness = result.turnstileReadiness;
    },
  });

  if (hostSurface && insetLeftPx != null) {
    const rect = pointerTarget?.rect ?? target.getBoundingClientRect();
    const x = pointerTarget?.x ?? (rect.left + Math.min(insetLeftPx, rect.width / 2));
    const y = pointerTarget?.y ?? (rect.top + rect.height / 2);
    const readinessKind = readiness?.signal === 'inner-frame'
      ? '内部验证帧已稳定'
      : readiness?.signal === 'interactive-control'
        ? '内部复选框已稳定'
        : '内部状态不可观测，已走满安全窗口';
    const hitKind = pointerTarget
      ? ((pointerTarget.hit || pointerTarget.withinHost)
          ? `${definition.kind}目标范围（${readinessKind}）`
          : `未命中${definition.kind}目标`)
      : `${clickMode === 'trusted' ? '可信' : 'DOM'}点击前目标检查通过`;
    const offsetWarning = screenOffsetMatches === false ? '；浏览器屏幕坐标偏移异常' : '';
    const readinessDetail = readiness
      ? `；成熟检查=${readinessKind}，控件已出现 ${(readiness.widgetAgeMs / 1000).toFixed(1)}s，本次额外等待 ${(readiness.waitedMs / 1000).toFixed(1)}s`
      : '';
    context.log.push(
      `第 ${attempt} 次${clickMode === 'trusted' ? '可信' : 'DOM'}点击已发出：`
      + `坐标 (${Math.round(x)}, ${Math.round(y)})，目标区域 `
      + `left=${Math.round(rect.left)} top=${Math.round(rect.top)} `
      + `${Math.round(rect.width)}×${Math.round(rect.height)}，命中=${hitKind}`
      + `${readinessDetail}${offsetWarning}；等待验证响应`,
    );
  } else {
    context.log.push(`第 ${attempt} 次${clickMode === 'trusted' ? '可信' : 'DOM'}点击已发送到验证控件，等待验证响应`);
  }
}

async function waitForCompletionAfterClick(
  definition: ClickChallengeDefinition,
  clickedWidget: Element,
  widgetSeenAt: WeakMap<Element, number>,
  context: ChallengeInteractionContext,
): Promise<boolean> {
  const waitMs = Math.min(
    definition.strategy?.responseWaitMs ?? DEFAULT_RESPONSE_WAIT_MS,
    remainingMs(context.deadline),
  );
  const startedAt = Date.now();
  const deadline = Math.min(context.deadline, startedAt + waitMs);
  let lastLogAt = startedAt - 4_000;
  let activeWidget = clickedWidget;
  let scopeSnapshot = captureChallengeScope(definition, clickedWidget);
  let missingSince: number | null = null;

  while (Date.now() < deadline) {
    await sleepWithin(400, deadline);

    observeResponseValue(scopeSnapshot, definition);

    if (context.isComplete(activeWidget)) {
      context.log.push(`${definition.kind}验证已自动完成（检测到当前控件的 token 或已验证状态）`);
      return true;
    }

    const scopedWidgets = visibleWidgetsInScope(definition, scopeSnapshot.scope);
    let observedWidget = scopedWidgets.includes(activeWidget)
      ? activeWidget
      : scopedWidgets[0] ?? null;
    if (!observedWidget && scopeSnapshot.scope instanceof Element && !scopeSnapshot.scope.isConnected) {
      observedWidget = currentVisibleWidget(definition);
    }

    if (observedWidget) {
      if (observedWidget !== activeWidget) {
        activeWidget = observedWidget;
        scopeSnapshot = captureChallengeScope(definition, observedWidget, scopeSnapshot);
        context.log.push(`${definition.kind}控件在点击后已重挂载，继续按新控件校验完成状态`);
      }
      if (!widgetSeenAt.has(observedWidget)) widgetSeenAt.set(observedWidget, Date.now());
      missingSince = null;
    } else {
      missingSince ??= Date.now();
      if (Date.now() - missingSince >= DISAPPEARANCE_GRACE_MS) {
        observeResponseValue(scopeSnapshot, definition);
        const responseSettled = scopeSnapshot.hadPendingResponse
          && scopeSnapshot.observedResponseValue
          && !hasPendingResponseInScope(definition, scopeSnapshot.scope);
        const submitUnlocked = scopeSnapshot.hadDisabledSubmit
          && submitControls(scopeSnapshot.scope).some((control) => !isDisabledSubmit(control));
        if (responseSettled || submitUnlocked) {
          context.log.push(
            `${definition.kind}控件消失后未重新挂载，`
            + `${submitUnlocked ? '所属表单提交控件已解锁' : '所属作用域已无待处理响应字段'}，视为验证完成`,
          );
          return true;
        }
      }
    }

    if (Date.now() - lastLogAt >= 4_000) {
      lastLogAt = Date.now();
      context.log.push(`等待${definition.kind}验证完成中... (${Math.round((Date.now() - startedAt) / 1000)}s)`);
    }

  }

  return context.isComplete(activeWidget);
}

/**
 * Execute a recognized checkbox-style challenge through one shared pipeline:
 * wait for delayed mounting, relocate after framework redraws, trusted-click,
 * then verify completion. Site workflows only recognize and route here.
 */
export async function executeChallengeInteraction(
  definition: ClickChallengeDefinition,
  context: ChallengeInteractionContext,
): Promise<boolean> {
  const initiallyVisible = visibleWidgets(definition);
  if (
    initiallyVisible.length > 0
      ? initiallyVisible.every((widget) => context.isComplete(widget))
      : context.isComplete()
  ) {
    return true;
  }

  /**
   * 「先滚再判」：控件挂在**当前视口下方**时先温和地滚一次，再进入既有的等待/点击流程。
   *
   * 为什么必须在选控件之前滚：真实指针点击（chrome.debugger 的
   * `Input.dispatchMouseEvent`）用的是视口坐标，落在视口外的坐标会点到别的元素或
   * 干脆无效；而懒渲染的控件（`content-visibility: auto`、IntersectionObserver 挂载）
   * 在滚到之前根本没有布局盒，后面的可见性/布局轮询只会一直等它、最终报「未挂载」。
   *
   * 有界：滚动尝试与耗时上限都写在 `revealOffscreenChallengeCandidates` 里
   * （最多 2 次、1 秒量级），且不越过本轮执行截止时间；没有视口外候选时是零开销的
   * 一次扫描，一次都不滚。
   */
  const reveal = await revealOffscreenChallengeCandidates(findChallengeRevealCandidates(), {
    budgetMs: Math.min(DEFAULT_REVEAL_BUDGET_MS, remainingMs(context.deadline)),
  });
  if (reveal.outcome === 'revealed') {
    context.log.push(`${definition.kind}控件原本位于视口外，已滚动页面将其带入视口后重新判定`);
  }

  const mounted = await waitForVisibleChallengeWidget(definition, context);
  if (mounted.state === 'completed') return true;
  if (mounted.state === 'missing') return false;

  const widgetSeenAt = new WeakMap<Element, number>();
  for (const widget of mounted.widgets) widgetSeenAt.set(widget, mounted.appearedAt);

  // Keep a queue of visible candidates. A page can contain more than one
  // same-kind widget (for example separate forms), and React may mount a new
  // candidate while an earlier one is being processed. Do not return after
  // the first successful candidate if another unresolved widget remains.
  const candidates = [...mounted.widgets];
  const queued = new Set(candidates);
  for (let widgetIndex = 0; widgetIndex < candidates.length; widgetIndex++) {
    let widget = candidates[widgetIndex]!;
    if (context.isComplete(widget)) continue;
    const maxAttempts = definition.strategy?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    for (let attempt = 1; attempt <= maxAttempts && Date.now() < context.deadline; attempt++) {
      try {
        if (attempt > 1) {
          await sleepWithin(definition.strategy?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS, context.deadline);
            if (context.isComplete(widget)) {
            context.log.push(`${definition.kind}已完成（重试前检测到完成信号），无需再次点击`);
            break;
          }
        }

        const current = currentWidgetForCandidate(definition, widget);
        if (!current) {
          const remounted = await waitForVisibleChallengeWidget(definition, {
            ...context,
            detectedAt: Date.now(),
            deadline: Math.min(context.deadline, Date.now() + 3_000),
          });
          if (remounted.state === 'completed') return true;
          if (remounted.state !== 'ready') break;
          widget = remounted.widgets[0]!;
          widgetSeenAt.set(widget, remounted.appearedAt);
        } else if (current !== widget) {
          widget = current;
          if (!widgetSeenAt.has(widget)) widgetSeenAt.set(widget, Date.now());
        }

        const prepared = await prepareWidget(
          widget,
          definition,
          widgetSeenAt,
          context,
          Math.min(
            attempt === 1 ? definition.strategy?.layoutWaitMs ?? DEFAULT_LAYOUT_WAIT_MS : 3_000,
            remainingMs(context.deadline),
          ),
        );
        if (prepared.state === 'completed') break;
        if (prepared.state !== 'ready') break;
        widget = prepared.widget;

        if (attempt > 1) context.log.push(`${definition.kind}尚未完成，尝试再次点击`);
        await clickChallengeTarget(definition, widget, widgetSeenAt, context, attempt);
        if (await waitForCompletionAfterClick(definition, widget, widgetSeenAt, context)) break;

        const currentGeneration = currentWidgetForCandidate(definition, widget);
        if (currentGeneration && (definition.strategy?.shadowTarget || (definition.strategy?.minVisibleMs ?? 0) > 0)) {
          widget = currentGeneration;
          widgetSeenAt.set(widget, Date.now());
          context.log.push(`${definition.kind}未返回完成信号，下一次重试将按新一代控件重新计算成熟窗口`);
        }

        if (attempt < maxAttempts) {
          context.log.push(
            `${definition.kind}第 ${attempt} 次点击后未出现完成信号，稍后尝试第 ${attempt + 1} 次点击`,
          );
        } else {
          context.log.push(`已重试 ${attempt} 次仍未完成${definition.kind}验证，需要人工介入`);
        }
      } catch (error) {
        context.log.push(`点击${definition.kind}控件失败：${error instanceof Error ? error.message : String(error)}`);
        const currentGeneration = currentWidgetForCandidate(definition, widget);
        if (currentGeneration && (definition.strategy?.shadowTarget || (definition.strategy?.minVisibleMs ?? 0) > 0)) {
          widget = currentGeneration;
          widgetSeenAt.set(widget, Date.now());
        }
        if (attempt < maxAttempts) {
          await sleepWithin(800, context.deadline);
        } else if (widgetIndex < candidates.length - 1) {
          context.log.push('当前控件无法点击，尝试下一个候选控件');
        }
      }
    }

    // Re-scan after each candidate. This catches a second same-kind widget
    // that was mounted by a framework redraw while the first was processing.
    for (const current of visibleWidgets(definition)) {
      if (!queued.has(current)) {
        queued.add(current);
        candidates.push(current);
        widgetSeenAt.set(current, Date.now());
      }
    }

    if (widgetIndex < candidates.length - 1) {
      context.log.push(`${definition.kind}当前候选未完成验证，尝试下一个候选控件`);
    }
  }

  const unresolved = visibleWidgets(definition).some((widget) => !context.isComplete(widget));
  if (!unresolved) return true;

  context.log.push(`${definition.kind}所有候选控件均未能自动完成验证，需要人工介入`);
  return false;
}
