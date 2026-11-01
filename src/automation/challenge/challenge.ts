import { getActiveClickRunId, sleep } from '@/automation/shared/dom-utils';
import type { StepLog } from '@/automation/login/steps';
import { trySolveSlider, trySolveTencentSliderInPage, type SliderSolveResult } from '@/automation/slider/slider-solve';
import {
  executeChallengeInteraction,
  isChallengeElementVisible,
  type ClickChallengeDefinition,
} from '@/automation/challenge/challenge-click';
import {
  findArithmeticChallenge,
  isSolvedArithmeticAnswer,
  solveArithmeticChallenge,
} from '@/automation/challenge/arithmetic-challenge';
import {
  SLIDER_SUCCESS_SELECTORS,
  SLIDER_WIDGET_SELECTORS as SLIDER_SELECTORS,
  hasExplicitSliderSuccess,
  hasVisibleSliderWidget,
  readSliderDomState,
} from '@/automation/slider/slider-dom';
import { findVisibleSliderFrame, TENCENT_SLIDER_SELECTORS } from '@/automation/slider/slider-frame-dom';
import { solveSliderInFrame } from '@/automation/slider/slider-frame';

type InteractiveKind = 'Turnstile' | 'reCAPTCHA' | 'hCaptcha' | 'Slider' | 'Arithmetic' | 'CAPTCHA';

interface ChallengeState {
  category: 'managed' | 'interactive';
  kind: 'Cloudflare' | InteractiveKind;
  embeddedInteractive?: InteractiveKind;
}

export interface ChallengeResolution {
  detected: boolean;
  resolved: boolean;
  kind?: string;
  /** 原样传给业务调度层的失败原因，不改变验证通过判据。 */
  error?: string;
  /** 已进入求解尝试时，业务层不得重新开启一整轮滑块重试。 */
  sliderAttemptStarted?: boolean;
}

interface InteractiveDefinition {
  kind: Exclude<InteractiveKind, 'CAPTCHA' | 'Arithmetic'>;
  selectors: string;
  tokenSelectors: string;
  candidateElements?: () => Element[];
}

const MANAGED_CLOUDFLARE_SELECTORS = [
  '#challenge-running',
  '#cf-challenge-running',
  '.cf-challenge-running',
  '#challenge-stage',
  'form#challenge-form',
].join(', ');

const CLOUDFLARE_FINGERPRINT_SELECTORS = [
  'script[src*="/cdn-cgi/challenge-platform/"]',
  'link[href*="/cdn-cgi/challenge-platform/"]',
  'iframe[src*="/cdn-cgi/challenge-platform/"]',
  '#cf-wrapper',
  '[data-ray]',
].join(', ');

/**
 * AgentRouter 的整页 WAF 滑动验证。
 *
 * 该页不会稳定暴露极验/易盾一类的普通控件选择器，而是在内联配置中声明
 * `CF_APP_WAF`、`AC_Opt` 与 `sceneId`。三个标记联用并限制为 agentrouter.org，
 * 避免把普通含有 slider 字样的页面误判为验证码。
 */
const AGENTROUTER_WAF_HOSTNAME = /(^|\.)agentrouter\.org$|^ps\.air-outer\.com$/i;
const AGENTROUTER_WAF_MARKERS = ['CF_APP_WAF', 'AC_Opt', 'sceneId'] as const;

const TURNSTILE_WIDGET_SELECTORS = [
  '.cf-turnstile',
  '.turnstile-wrapper',
  '.turnstile-container',
  '[class*="turnstile" i]',
  '[data-sitekey][class*="turnstile" i]',
  '[id^="cf-chl-widget-"]:not(input):not(textarea)',
  '#challenge-stage input[type="checkbox"]',
  '#challenge-stage [role="checkbox"]',
  '#challenge-stage button:not([disabled])',
  'iframe[src*="challenges.cloudflare.com"]',
  'iframe[title*="cloudflare security challenge" i]',
].join(', ');

const CLICK_CHALLENGE_DEFINITIONS = [
  {
    kind: 'Turnstile',
    selectors: TURNSTILE_WIDGET_SELECTORS,
    tokenSelectors: 'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]',
    candidateElements: findCloudflareClosedShadowTurnstileHosts,
    strategy: {
      shadowTarget: true,
      insetLeftPx: 24,
      minVisibleMs: 10_000,
      safetyWindowMs: 15_000,
      mountWaitMs: 15_000,
      layoutWaitMs: 10_000,
      maxAttempts: 3,
      retryDelayMs: 3_000,
      responseWaitMs: 20_000,
    },
  },
  {
    kind: 'reCAPTCHA',
    selectors: [
      '.g-recaptcha',
      '[class*="recaptcha" i][data-sitekey]',
      'iframe[src*="recaptcha"]',
      'iframe[title*="recaptcha" i]',
    ].join(', '),
    tokenSelectors: 'input[name="g-recaptcha-response"], textarea[name="g-recaptcha-response"]',
    strategy: {
      shadowTarget: true,
      mountWaitMs: 10_000,
      maxAttempts: 3,
    },
  },
  {
    kind: 'hCaptcha',
    selectors: [
      '.h-captcha',
      '[class*="hcaptcha" i][data-sitekey]',
      'iframe[src*="hcaptcha.com"]',
      'iframe[title*="hcaptcha" i]',
    ].join(', '),
    tokenSelectors: 'input[name="h-captcha-response"], textarea[name="h-captcha-response"]',
    strategy: {
      shadowTarget: true,
      mountWaitMs: 10_000,
      maxAttempts: 3,
    },
  },
] satisfies readonly ClickChallengeDefinition[];

const INTERACTIVE_DEFINITIONS: readonly InteractiveDefinition[] = [
  ...CLICK_CHALLENGE_DEFINITIONS,
  {
    kind: 'Slider',
    selectors: SLIDER_SELECTORS,
    // 滑块验证没有统一的隐藏响应字段；完成判定走 SLIDER_SUCCESS_SELECTORS
    // 或「全部滑块容器消失」。留空让 hasPendingResponseField 直接跳过。
    tokenSelectors: '',
  },
] as const;

/**
 * 「学习录制」侧的人机验证控件判据：元素本身或其祖先属于已识别的人机验证控件
 * （滑块 / Turnstile / reCAPTCHA / hCaptcha / 腾讯滑块）。
 *
 * 验证交互由回放侧的自动破解管线接管，不是用户工作流的一部分：录制时把它们
 * 录成步骤，回放时验证多已被自动处理、控件早已消失，那一步只会报
 * 「找不到可点击元素」。选择器与回放检测（INTERACTIVE_DEFINITIONS）同源，
 * 保证「录的时候认识、放的时候管得了」是同一批控件。
 */
const CHALLENGE_SURFACE_SELECTORS = [
  SLIDER_SELECTORS,
  TENCENT_SLIDER_SELECTORS.widgets,
  TURNSTILE_WIDGET_SELECTORS,
  '.g-recaptcha',
  '[class*="recaptcha" i][data-sitekey]',
  'iframe[src*="recaptcha"]',
  'iframe[title*="recaptcha" i]',
  '.h-captcha',
  '[class*="hcaptcha" i][data-sitekey]',
  'iframe[src*="hcaptcha.com"]',
  'iframe[title*="hcaptcha" i]',
].join(', ');

/**
 * 学习录制用：这个元素属于人机验证控件吗（含其内部任意子元素）？
 * 录入侧据此「认识并跳过」验证交互；回放侧照旧自动检测与破解。
 */
export function isChallengeSurfaceTarget(element: Element): boolean {
  try {
    return element.matches(CHALLENGE_SURFACE_SELECTORS)
      || Boolean(element.closest(CHALLENGE_SURFACE_SELECTORS));
  } catch {
    return false;
  }
}

const GENERIC_CAPTCHA_SELECTORS = [
  '[class*="captcha" i]',
  '[id*="captcha" i]',
  'iframe[src*="captcha" i]',
  'img[src*="captcha" i]',
  'canvas[class*="captcha" i]',
  'input[name*="captcha" i]:not([type="hidden"])',
].join(', ');

/**
 * 通用 CAPTCHA 里「元素自己就声明了它是验证资源」的那几条选择器。
 *
 * 必须与 `[class*="captcha"]` / `[id*="captcha"]` 这种纯命名匹配分开：命名匹配
 * 在说明性文案容器、登录弹窗里预挂载的空壳、上一轮已处理完的外壳上都会命中，
 * 单独成立时不足以判定「页面上有一个需要等待的验证码」。跨域验证码 iframe、
 * 验证码图片、带 captcha 命名的 canvas、非隐藏的答案输入框才是页面自己写下的
 * 验证资源声明。
 */
const CAPTCHA_RESOURCE_SELECTORS = [
  'iframe[src*="captcha" i]',
  'img[src*="captcha" i]',
  'canvas[class*="captcha" i]',
  'input[name*="captcha" i]:not([type="hidden"])',
].join(', ');

const CAPTCHA_CONTAINER_SELECTORS = [
  '[class*="captcha" i]',
  '[id*="captcha" i]',
].join(', ');

/**
 * captcha 命名容器里「真的装着验证控件」的判据。
 *
 * 只认可交互/可识别的元素，且必须真的可见：容器里只有说明文字、空白占位或已
 * 移除的旧控件时，它就是一个普通元素，让整轮任务等它等于白等。
 */
const CAPTCHA_CONTAINER_CONTROL_SELECTORS = [
  'iframe',
  'img',
  'canvas',
  'svg',
  'input:not([type="hidden"])',
  'textarea',
  'select',
  'button',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="slider"]',
  '[role="textbox"]',
  '[contenteditable="true"]',
  '[onclick]',
  '[tabindex]',
].join(', ');

const MANAGED_TITLE_PARTS = [
  'just a moment',
  'checking your browser',
  'performing security verification',
  'attention required',
  '请稍候',
  '请稍等',
  '正在检查您的浏览器',
  '浏览器检查',
];

const CHALLENGE_TITLE_PARTS = [
  ...MANAGED_TITLE_PARTS,
  'security verification',
  'verify you are human',
  'captcha',
  '安全验证',
  '人机验证',
  '验证您是真人',
  '验证你是真人',
];

const INTERACTION_PROMPTS = [
  /check (?:the )?(?:box|checkbox)/i,
  /click (?:the )?(?:box|checkbox|button)/i,
  /select all (?:images|squares)/i,
  /complete (?:the )?(?:captcha|challenge)/i,
  /verify (?:that )?you are human/i,
  /请(?:点击|勾选|选择)/,
  /请完成(?:验证码|人机验证|安全验证)/,
  /(?:确认|验证)(?:您|你)?是(?:真人|人类)/,
];

const VERIFIED_STATES = new Set(['complete', 'completed', 'passed', 'success', 'verified']);
const MANAGED_WIDGET_GRACE_MS = 1_500;
const GENERIC_WIDGET_GRACE_MS = 1_200;
const POLL_INTERVAL_MS = 250;

function queryAll(selectors: string): Element[] {
  try {
    return [...document.querySelectorAll(selectors)];
  } catch {
    return [];
  }
}

function sourceHasAgentRouterWafMarkers(source: string): boolean {
  return AGENTROUTER_WAF_MARKERS.every((marker) => source.includes(marker));
}

/**
 * 识别 AgentRouter 的整页 WAF 滑动验证。
 *
 * 先查内联 script；部分 WAF 响应会把初始化配置直接写到文档里，再用整页源码兜底。
 * 不读取或记录配置中的 token / 用户标识，只检查三个固定的产品标记。
 */
function isAgentRouterWafSliderPage(): boolean {
  if (!AGENTROUTER_WAF_HOSTNAME.test(location.hostname)) return false;

  if (queryAll('script').some((script) => sourceHasAgentRouterWafMarkers(script.textContent ?? ''))) {
    return true;
  }

  return sourceHasAgentRouterWafMarkers(document.documentElement?.innerHTML ?? '');
}

function isActuallyVisible(element: Element): boolean {
  return isChallengeElementVisible(element);
}

function hasVisible(selectors: string): boolean {
  return queryAll(selectors).some(isActuallyVisible);
}

function matchesAny(element: Element, selectors: string): boolean {
  try {
    return element.matches(selectors);
  } catch {
    return false;
  }
}

/**
 * 通用 CAPTCHA 的**客观证据**判据。
 *
 * 这是「签到点击后要不要进入长等待」的闸门，所以判据必须客观。
 *
 * 曾经这里是 `queryAll(GENERIC_CAPTCHA_SELECTORS).find(isActuallyVisible)` ——
 * 只要页面上有一个可见的 `[class*="captcha"]` 元素就报 CAPTCHA。可这个名字到处
 * 都在用：说明性文案容器、登录弹窗里预挂载的空壳、上一轮已经处理完留在 DOM 里
 * 的外壳、埋点/骨架屏容器……于是站点压根没有验证码，`waitForChallenge` 也会带着
 * 这个 CAPTCHA 结论进入最长 5 分钟的等待循环、期间还调用 onNeedsUser 让用户手动
 * 确认一个不存在的验证码。用户报告的现象（「签到已点击，开始等待本次签到触发的
 * 安全验证」之后一直不动）就是这么来的。
 *
 * 现在只认两类客观证据：
 *   1) 元素本身是页面声明的验证资源（验证码 iframe / 图片 / canvas / 答案输入框）；
 *   2) captcha 命名的容器里确实装着可见的可交互控件。
 * 只有命名、没有控件的容器不算。漏判的代价是稍后轮询还能补上（轮询仍在跑），
 * 误判的代价是整轮任务白等，后者严重得多。
 */
function hasObjectiveCaptchaEvidence(elements: readonly Element[]): boolean {
  return elements.some((element) => (
    matchesAny(element, CAPTCHA_RESOURCE_SELECTORS)
    || (matchesAny(element, CAPTCHA_CONTAINER_SELECTORS)
      && queryAllWithin(element, CAPTCHA_CONTAINER_CONTROL_SELECTORS).some(isActuallyVisible))
  ));
}

function hasVisibleTencentPageSlider(): boolean {
  return hasVisible(TENCENT_SLIDER_SELECTORS.widgets);
}

function titleIncludes(parts: readonly string[]): boolean {
  const title = document.title.trim().toLowerCase();
  return parts.some((part) => title.includes(part));
}

function hasChallengeTitle(): boolean {
  return titleIncludes(CHALLENGE_TITLE_PARTS);
}

function isManagedCloudflarePage(): boolean {
  if (hasVisible(MANAGED_CLOUDFLARE_SELECTORS)) return true;
  return titleIncludes(MANAGED_TITLE_PARTS) && queryAll(CLOUDFLARE_FINGERPRINT_SELECTORS).length > 0;
}

function controlValue(element: Element): string {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element.value.trim();
  }
  return (element.getAttribute('value') ?? '').trim();
}

/**
 * Cloudflare's full-page challenge can keep the real Turnstile iframe inside
 * a closed shadow root. In that shape the only light-DOM link to the visible
 * host is the empty response field mounted directly below it.
 *
 * Keep this fallback deliberately narrow: Cloudflare's generated response-field
 * id/name pair and a visible direct parent are both required. Inline Turnstile
 * widgets legitimately live inside login forms and post-action dialogs, so a
 * surrounding form cannot be used to exclude them. The returned host still
 * goes through the shared layout, maturity and trusted-pointer checks.
 */
function findCloudflareClosedShadowTurnstileHosts(): Element[] {
  if (hasVisible(TURNSTILE_WIDGET_SELECTORS)) return [];

  const fields = queryAll(
    'input[id^="cf-chl-widget-"][name="cf-turnstile-response"], '
    + 'textarea[id^="cf-chl-widget-"][name="cf-turnstile-response"]',
  );
  const hosts = fields.flatMap((field) => {
    if (controlValue(field).length > 0) return [];
    const host = field.parentElement;
    if (!host || host === document.body || host === document.documentElement || host instanceof HTMLFormElement) return [];
    return isActuallyVisible(host) ? [host] : [];
  });
  return [...new Set(hosts)];
}

function elementsForDefinition(definition: InteractiveDefinition): Element[] {
  return [...new Set([
    ...queryAll(definition.selectors),
    ...(definition.candidateElements?.() ?? []),
  ])];
}

function responseFieldsFor(
  definition: InteractiveDefinition,
  widget?: Element,
): Element[] {
  if (!widget) return queryAll(definition.tokenSelectors);

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

function hasVerifiedToken(definition: InteractiveDefinition, widget?: Element): boolean {
  const responseFields = responseFieldsFor(definition, widget);
  return responseFields.length > 0
    && responseFields.every((element) => controlValue(element).length > 0);
}

function hasPendingResponseField(definition: InteractiveDefinition): boolean {
  const responseFields = queryAll(definition.tokenSelectors);
  const pendingFields = responseFields.filter((element) => controlValue(element).length === 0);
  if (pendingFields.length === 0) return false;

  // Cloudflare 生成的字段 id + name 是强指纹。新版 new-api 登录页与签到弹窗
  // 都可能把 closed-shadow Turnstile 放在表单/对话框里，同时保持业务按钮可用；
  // 若仍要求 submit.disabled，就会把这种真正待处理的验证直接放行。
  const generatedTurnstileResponse = definition.kind === 'Turnstile'
    && pendingFields.some((field) => (
      /^cf-chl-widget-.+_response$/i.test(field.id)
      && field.getAttribute('name') === 'cf-turnstile-response'
      && !!field.parentElement
      && isActuallyVisible(field.parentElement)
    ));

  // 整页托管检查有时还没生成稳定 id，只留下 challenge-platform 指纹与空 token。
  const cloudflareTurnstileEvidence = definition.kind === 'Turnstile'
    && queryAll(CLOUDFLARE_FINGERPRINT_SELECTORS).length > 0;

  // Some Turnstile integrations render the cross-origin widget outside the
  // light DOM. Bind each empty response field to its own form before checking
  // the disabled action; a solved registration form must not mask the current
  // login form, and an unrelated disabled button must not activate the field.
  return generatedTurnstileResponse || cloudflareTurnstileEvidence || pendingFields.some((field) => {
    const scope = field.closest('form') ?? document;
    return queryAllWithin(scope, 'button[type="submit"], input[type="submit"]').some((element) => (
      element instanceof HTMLButtonElement || element instanceof HTMLInputElement
    ) && element.disabled);
  });
}

function elementHasVerifiedState(element: Element): boolean {
  if (element.getAttribute('aria-checked') === 'true') return true;
  if (element instanceof HTMLInputElement && element.type === 'checkbox' && element.checked) return true;

  for (const attribute of ['data-state', 'data-status']) {
    const value = element.getAttribute(attribute)?.trim().toLowerCase();
    if (value && VERIFIED_STATES.has(value)) return true;
  }

  for (const attribute of ['data-response', 'data-hcaptcha-response']) {
    if ((element.getAttribute(attribute) ?? '').trim()) return true;
  }

  return false;
}

function hasVerifiedState(definition: InteractiveDefinition, widget?: Element): boolean {
  const roots = widget ? [widget] : queryAll(definition.selectors);
  for (const root of roots) {
    if (elementHasVerifiedState(root)) return true;
    const descendants = queryAllWithin(root, '[aria-checked], [data-state], [data-status], [data-response], [data-hcaptcha-response]');
    if (descendants.some(elementHasVerifiedState)) return true;
  }

  if (definition.kind === 'reCAPTCHA') {
    const scope = widget?.closest('form') ?? widget ?? document;
    if (queryAllWithin(scope, '.recaptcha-checkbox-checked').length > 0) return true;
  }
  return false;
}

function queryAllWithin(root: ParentNode, selectors: string): Element[] {
  try {
    return [...root.querySelectorAll(selectors)];
  } catch {
    return [];
  }
}

function hasCompletionEvidence(kind: InteractiveKind, widget?: Element): boolean {
  if (kind === 'Arithmetic') {
    const challenge = findArithmeticChallenge();
    return !challenge || challenge.input.value.trim() === challenge.answer;
  }

  if (kind === 'CAPTCHA') {
    return queryAll(
      '[class*="captcha" i][data-state="verified" i], [class*="captcha" i][data-status="success" i], [id*="captcha" i][data-state="verified" i], [id*="captcha" i][data-status="success" i]',
    ).some(elementHasVerifiedState);
  }

  if (kind === 'Slider') {
    // 新签到挑战在 iframe 中；主文档上次登录残留的 success 不能放行它。
    if (findVisibleSliderFrame()) return false;
    // 页面内腾讯组件也交给既有腾讯适配器读取本轮面板，不能沿用旧登录的成功标记。
    if (hasVisibleTencentPageSlider()) return readSliderDomState(undefined, 'tencent-page').success;
    // AgentRouter 的 WAF 是整页滑动验证，没有普通的 DOM 滑块容器；只要三个
    // WAF 标记仍存在，就必须持续视为未完成，不能因 SLIDER_SELECTORS 为空放行。
    if (isAgentRouterWafSliderPage()) return false;
    // 成功标记出现（极验/易盾的 success 元素，或通用 data-state/data-status）
    if (hasExplicitSliderSuccess() || queryAll(SLIDER_SUCCESS_SELECTORS).length > 0) return true;
    // 所有滑块容器都显式标记为已验证（slide-verify 等通用容器不保证含
    // "captcha" 字样，SLIDER_SUCCESS_SELECTORS 覆盖不到，需按容器逐个检查）
    const sliderContainers = queryAll(SLIDER_SELECTORS);
    if (sliderContainers.length > 0 && sliderContainers.every(elementHasVerifiedState)) return true;
    // 验证通过后面板会关闭或从 DOM 移除：所有滑块容器都不再可见即视为完成
    return !hasVisibleSliderWidget();
  }

  const definition = INTERACTIVE_DEFINITIONS.find((item) => item.kind === kind);
  return definition ? hasVerifiedToken(definition, widget) || hasVerifiedState(definition, widget) : false;
}

function belongsToKnownWidget(element: Element): boolean {
  if (isSolvedArithmeticAnswer(element)) return true;

  return INTERACTIVE_DEFINITIONS.some((definition) => {
    try {
      return element.matches(definition.selectors) || Boolean(element.closest(definition.selectors));
    } catch {
      return false;
    }
  });
}

function detectInteractive(includePendingResponse = true): InteractiveKind | null {
  // AgentRouter WAF 是整页验证，未必有可查询的普通滑块控件；优先按其内联
  // 配置指纹识别，避免落到通用 CAPTCHA 分支后被当成已消失而提前放行。
  if (isAgentRouterWafSliderPage()) return 'Slider';

  // 只在调度层区分腾讯组件所在文档，普通滑块仍沿用原来的入口。
  if (findVisibleSliderFrame()) return 'Slider';
  if (hasVisibleTencentPageSlider() && !hasCompletionEvidence('Slider')) return 'Slider';

  // Capability discovery covers slider implementations whose class names do
  // not appear in the weighted selector hints below.
  if (hasVisibleSliderWidget() && !hasCompletionEvidence('Slider')) return 'Slider';

  let sawKnownWidget = false;
  for (const definition of INTERACTIVE_DEFINITIONS) {
    const elements = elementsForDefinition(definition);
    const hasPendingToken = includePendingResponse && hasPendingResponseField(definition);
    if (elements.length === 0 && !hasPendingToken) continue;

    sawKnownWidget = true;
    const hasUnresolvedVisibleWidget = elements.some((element) => (
      isActuallyVisible(element) && !hasCompletionEvidence(definition.kind, element)
    ));
    if (hasUnresolvedVisibleWidget || hasPendingToken) {
      return definition.kind;
    }
  }

  // Arithmetic challenges often use a field named "captcha". Recognize the
  // equation before the generic CAPTCHA branch so a solvable form is not sent
  // to manual intervention.
  if (findArithmeticChallenge()) return 'Arithmetic';

  const genericElements = queryAll(GENERIC_CAPTCHA_SELECTORS).filter((element) => !belongsToKnownWidget(element));
  const visibleGenericElements = genericElements.filter(isActuallyVisible);
  if (hasObjectiveCaptchaEvidence(visibleGenericElements) && !hasCompletionEvidence('CAPTCHA')) return 'CAPTCHA';

  // A solved widget can remain mounted. Once it is hidden or carries explicit
  // completion evidence, a stale page title must not reactivate it.
  if (sawKnownWidget || genericElements.length > 0) return null;

  /**
   * 标题只作为**加权信号**，不能单独成立。
   *
   * 曾经这里是 `hasChallengeTitle() && !isManagedCloudflarePage()` —— 页面上没有
   * 任何验证控件，只要标题含「安全验证」「captcha」这类词就报 CAPTCHA。后果是
   * `waitForChallenge` 进入等待循环后判据永不改变（标题不会自己变），只能干等到
   * 120 秒超时，报「安全验证超时」。而站点可能压根没有验证 —— 标题里出现这些词
   * 的正常页面很多（帮助文档、设置页里的「安全验证」入口）。
   *
   * 现在要求标题之外还有客观证据：Cloudflare 的挑战平台指纹，或页面上有明确的
   * 交互提示。两者都没有就当没有验证 —— 漏判的代价是稍后真验证出现时再检测到
   * （轮询还在跑），误判的代价是整轮任务白等两分钟，后者严重得多。
   */
  if (!hasChallengeTitle() || isManagedCloudflarePage()) return null;
  const hasObjectiveEvidence = queryAll(CLOUDFLARE_FINGERPRINT_SELECTORS).length > 0
    || hasExplicitInteractionPrompt();
  return hasObjectiveEvidence ? 'CAPTCHA' : null;
}

function hasExplicitInteractionPrompt(): boolean {
  if (
    hasVisible(
      '#challenge-stage input[type="checkbox"], #challenge-stage [role="checkbox"], #challenge-stage button, iframe[title*="checkbox" i]',
    )
  ) {
    return true;
  }

  const text = (document.body?.innerText ?? '').slice(0, 20_000);
  return INTERACTION_PROMPTS.some((pattern) => pattern.test(text));
}

function inspectChallenge(includePendingResponse = true): ChallengeState | null {
  const managed = isManagedCloudflarePage();
  const interactive = detectInteractive(includePendingResponse);

  if (managed) {
    /**
     * A managed Cloudflare page can transition from a passive browser check to
     * an interactive Turnstile without exposing its prompt in the light DOM.
     * In particular, the checkbox text can live inside a closed shadow tree.
     * A visible, known widget host is therefore sufficient interaction
     * evidence; only a pending response field with no mounted host stays on the
     * passive managed path while the widget finishes mounting.
     */
    const hasVisibleInteractiveHost = interactive
      ? INTERACTIVE_DEFINITIONS.some((definition) => (
          definition.kind === interactive
          && elementsForDefinition(definition).some(isActuallyVisible)
        ))
      : false;
    if (
      interactive
      && (interactive !== 'Turnstile' || hasVisibleInteractiveHost || hasExplicitInteractionPrompt())
    ) {
      return { category: 'interactive', kind: interactive };
    }
    return { category: 'managed', kind: 'Cloudflare', embeddedInteractive: interactive ?? undefined };
  }

  return interactive ? { category: 'interactive', kind: interactive } : null;
}

export function detectChallenge(): string | null {
  return inspectChallenge()?.kind ?? null;
}

/**
 * 是否存在**客观的**验证证据（供签到点击后的有界快照使用）。
 *
 * 直接复用 `inspectChallenge`：判据只允许存在一处，否则快照放行而
 * `waitForChallenge` 又判定有验证，两边就会互相打脸。`includePendingResponse`
 * 默认 false，与签到路径一致 —— 签到只看看得见的控件，不把「空响应字段 + 被
 * 禁用的提交按钮」算成正在验证（登录提交前那条路径才需要后者）。
 */
export function hasObjectiveChallengeEvidence(includePendingResponse = false): boolean {
  return inspectChallenge(includePendingResponse) !== null;
}

function tryResolveArithmeticChallenge(log: StepLog): boolean {
  // The solver performs a fresh DOM lookup on every invocation. This matters
  // when the site regenerates the equation after a refresh or account switch.
  const solved = solveArithmeticChallenge();
  if (!solved) return false;

  log.push(`已识别动态算式 ${solved.expression}，并填写计算结果 ${solved.answer}`);
  return true;
}

async function tryAutomateChallenge(
  kind: InteractiveKind,
  log: StepLog,
  detectedAt: number,
  deadline: number,
): Promise<boolean> {
  if (kind === 'Arithmetic') return tryResolveArithmeticChallenge(log);

  if (kind === 'CAPTCHA') {
    log.push('通用 CAPTCHA 类型无法自动化，需要人工识别');
    return false;
  }

  const definition = CLICK_CHALLENGE_DEFINITIONS.find((item) => item.kind === kind);
  if (!definition) return false;

  return executeChallengeInteraction(definition, {
    log,
    detectedAt,
    deadline,
    // Before a visible host exists, only response tokens are reliable. A stale
    // verified widget in another form must not make a pending login widget look
    // complete. Once a candidate is mounted, bind all evidence to that widget.
    isComplete: (widget) => {
      if (widget) return hasCompletionEvidence(kind, widget);
      const responseFields = responseFieldsFor(definition);
      return responseFields.length > 0
        && responseFields.every((field) => controlValue(field).length > 0);
    },
  });
}
/**
 * Handle only a full-page Cloudflare gate before touching the login form.
 * Inline widgets are intentionally deferred until credentials have been
 * filled so the user only needs to verify once immediately before submit.
 */
export async function waitForManagedChallenge(
  log: StepLog,
  onNeedsUser: (message: string) => Promise<void>,
  timeoutMs = 120_000,
): Promise<ChallengeResolution> {
  if (!isManagedCloudflarePage()) return { detected: false, resolved: true };

  /**
   * 二次确认，避免把「页面刚开始加载」误判成托管检查。
   *
   * 实测（SharedChat，2026-08-14）：SPA 启动瞬间 document.title 为空、DOM 尚未
   * 渲染，此时若恰好命中任一托管特征，就会进入等待循环；而循环的判据是
   * inspectChallenge()，它在托管特征消失后仍可能因别的分支继续等，最终干等到
   * 120 秒超时报「Cloudflare超时」—— 而那个页面全程没有任何验证控件
   * （高频采样 103 帧确认）。
   *
   * 真正的托管检查会持续数秒以上，不会在半秒内消失；这里等一小会儿再看，
   * 瞬时误判自然消散，真实的托管页则仍然成立。
   */
  await sleep(600);
  if (!isManagedCloudflarePage()) {
    return { detected: false, resolved: true };
  }
  return waitForChallenge(log, onNeedsUser, timeoutMs);
}

async function solveDetectedSlider(log: StepLog): Promise<SliderSolveResult & { attemptStarted: boolean }> {
  let attemptStarted = false;
  // 现有求解器在控件采集完成后、请求取图/拖动前发出尝试日志。仅在调度层记录
  // 这个边界，不修改求解器、识别条件、拖动次数或通过判据。复用中的任务也不可重开。
  const trackedLog: StepLog = {
    push(message) {
      if (message.startsWith('滑块第 ') || message.startsWith('滑块求解已经在执行')) {
        attemptStarted = true;
      }
      log.push(message);
    },
  };
  const runId = getActiveClickRunId();
  if (runId && findVisibleSliderFrame()) {
    const result = await solveSliderInFrame(trackedLog, runId);
    return { ...result, attemptStarted };
  }

  const tencentPageDetected = hasVisibleTencentPageSlider();
  const result = await (tencentPageDetected
    ? trySolveTencentSliderInPage(trackedLog)
    : trySolveSlider(trackedLog));
  // 外壳先出现、iframe 后挂载时，由调度层接手；普通求解循环不切换策略。
  if (runId && getActiveClickRunId() === runId && findVisibleSliderFrame()) {
    const frameResult = await solveSliderInFrame(trackedLog, runId);
    return { ...frameResult, attemptStarted };
  }
  // 腾讯组件可能晚于外壳挂载。仅在普通入口尚未开始求解时交接，不能给已拖动的
  // 失败挑战重开整轮，也不重复点击签到；后续取图、拖动和验收仍由原处理器负责。
  if (!tencentPageDetected && !attemptStarted && !result.solved && !result.dismissed
    && runId && getActiveClickRunId() === runId && hasVisibleTencentPageSlider()) {
    const pageResult = await trySolveTencentSliderInPage(trackedLog);
    return { ...pageResult, attemptStarted };
  }
  return { ...result, attemptStarted };
}

/**
 * Wait for a managed Cloudflare check to finish naturally. Interactive
 * challenges are now attempted with automated clicking before falling back
 * to user intervention.
 */
export async function waitForChallenge(
  log: StepLog,
  onNeedsUser: (message: string) => Promise<void>,
  timeoutMs = 120_000,
  options: { includePendingResponse?: boolean; appearanceWaitMs?: number } = {},
): Promise<ChallengeResolution> {
  const includePendingResponse = options.includePendingResponse ?? true;
  let initial = inspectChallenge(includePendingResponse);
  const appearanceWaitMs = Math.max(0, options.appearanceWaitMs ?? 0);
  if (!initial && appearanceWaitMs > 0) {
    const appearanceDeadline = Date.now() + appearanceWaitMs;
    while (!initial && Date.now() < appearanceDeadline) {
      await sleep(Math.min(POLL_INTERVAL_MS, appearanceDeadline - Date.now()));
      initial = inspectChallenge(includePendingResponse);
    }
  }
  if (!initial) return { detected: false, resolved: true };

  // 滑块/WAF 检测到后，尝试自动破解；失败必须保留检测结果并明确返回未解决。
  if (initial.kind === 'Slider' || initial.embeddedInteractive === 'Slider') {
    const sliderResult = await solveDetectedSlider(log);
    if (sliderResult.dismissed) {
      log.push('验证码窗口已关闭，继续核对本次操作结果');
      return { detected: true, resolved: true, kind: 'Slider' };
    }
    if (sliderResult.solved) {
      log.push(`滑块验证已自动破解（${sliderResult.method}，距离=${sliderResult.distance}px）`);
      return { detected: true, resolved: true, kind: 'Slider' };
    }
    return {
      detected: true, resolved: false, kind: 'Slider',
      error: sliderResult.error, sliderAttemptStarted: sliderResult.attemptStarted,
    };
  }

  if (initial.kind === 'Arithmetic' || initial.embeddedInteractive === 'Arithmetic') {
    return {
      detected: true,
      resolved: tryResolveArithmeticChallenge(log),
      kind: 'Arithmetic',
    };
  }

  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const startedWithChallengeTitle = hasChallengeTitle();
  const automatedKinds = new Set<InteractiveKind>();
  const notifiedKinds = new Set<InteractiveKind>();
  const detectedAt = new Map<InteractiveKind, number>();
  let resultKind: string = initial.kind;

  const handleInteractive = async (kind: InteractiveKind): Promise<void> => {
    if (automatedKinds.has(kind) || notifiedKinds.has(kind)) return;
    resultKind = kind;
    if (!detectedAt.has(kind)) detectedAt.set(kind, Date.now());

    // 先出现的 captcha 外壳不代表最终类型。继续轮询，让稍后挂载的滑块
    // 进入专用流程；窗口过后仍是通用验证码才通知人工，期间不放行任务。
    if (kind === 'CAPTCHA' && Date.now() - detectedAt.get(kind)! < GENERIC_WIDGET_GRACE_MS) return;

    // 先尝试自动化点击
    const automated = await tryAutomateChallenge(kind, log, detectedAt.get(kind)!, deadline);
    if (automated) {
      automatedKinds.add(kind);
      return;
    }

    // 自动化失败时回退到人工介入
    notifiedKinds.add(kind);
    log.push(`${kind}验证控件无法自动完成，等待你在当前标签页手动完成`);
    await onNeedsUser(`${kind}需要你在当前标签页完成验证；自动点击未能成功验证`);
  };

  if (initial.category === 'interactive') {
    await handleInteractive(initial.kind as InteractiveKind);
  } else {
    log.push('检测到Cloudflare托管式安全检查，等待页面自然完成并跳转');
  }

  while (Date.now() - startedAt < timeoutMs) {
    await sleep(POLL_INTERVAL_MS);

    const completedKind = [...automatedKinds, ...notifiedKinds].find((kind) => hasCompletionEvidence(kind));
    const current = inspectChallenge(includePendingResponse);

    if (current?.kind === 'Arithmetic' || current?.embeddedInteractive === 'Arithmetic') {
      return {
        detected: true,
        resolved: tryResolveArithmeticChallenge(log),
        kind: 'Arithmetic',
      };
    }

    // 页面加载后才弹出的滑块/WAF 同样直接返回未解决，避免把失败伪装成
    // 未检测到验证并继续后续业务动作。
    if (current?.kind === 'Slider' || current?.embeddedInteractive === 'Slider') {
      const sliderResult = await solveDetectedSlider(log);
      if (sliderResult.dismissed) {
        log.push('验证码窗口已关闭，继续核对本次操作结果');
        return { detected: true, resolved: true, kind: 'Slider' };
      }
      if (sliderResult.solved) {
        log.push(`滑块验证已自动破解（${sliderResult.method}，距离=${sliderResult.distance}px）`);
        return { detected: true, resolved: true, kind: 'Slider' };
      }
      return {
        detected: true, resolved: false, kind: 'Slider',
        error: sliderResult.error, sliderAttemptStarted: sliderResult.attemptStarted,
      };
    }

    if (
      startedWithChallengeTitle
      && !hasChallengeTitle()
      && current?.category !== 'interactive'
      && !current?.embeddedInteractive
    ) {
      log.push('页面已离开安全验证状态，继续执行');
      return { detected: true, resolved: true, kind: resultKind };
    }

    /**
     * 托管检查已经消失、也没有需要人工处理的交互控件 —— 直接放行。
     *
     * 不能只依赖上面那条：它要求「进入时标题就像验证页」，而 SPA 启动瞬间
     * 标题往往是空的，于是 startedWithChallengeTitle 为 false，捷径永久失效，
     * 任务只能干等到超时。这里按当前实际状态判断，与进入时的标题无关。
     */
    if (
      initial.category === 'managed'
      && !isManagedCloudflarePage()
      && current?.category !== 'interactive'
    ) {
      log.push('Cloudflare 托管检查已结束，继续执行');
      return { detected: true, resolved: true, kind: resultKind };
    }

    if (!current) {
      log.push(
        completedKind
          ? `${completedKind}已通过验证信号确认完成，继续执行`
          : '安全验证控件已隐藏或页面已离开验证状态，继续执行',
      );
      return { detected: true, resolved: true, kind: resultKind };
    }

    if (current.category === 'interactive') {
      await handleInteractive(current.kind as InteractiveKind);
      continue;
    }

    const elapsed = Date.now() - startedAt;
    if (
      current.embeddedInteractive &&
      (hasExplicitInteractionPrompt() || elapsed >= MANAGED_WIDGET_GRACE_MS)
    ) {
      await handleInteractive(current.embeddedInteractive);
    }
  }

  return { detected: true, resolved: false, kind: resultKind };
}
