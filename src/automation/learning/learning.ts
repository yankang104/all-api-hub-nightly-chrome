import type {
  CheckinWorkflowConfig,
  CheckinWorkflowStep,
  LearningKind,
  SiteConfig,
  SiteSelectors,
  WorkflowElementFingerprint,
  WorkflowFormControl,
  WorkflowGesture,
  WorkflowKey,
  WorkflowLearningEvent,
  WorkflowLearningSession,
  WorkflowPointerAnchor,
} from '@/types';
import { isVisible, queryAll, selectorVisibleText, TEXT_SELECTOR_SCOPE } from '@/automation/shared/dom-utils';
import { isKnownBusinessLearningPath, isLoginLandingPath } from './learning-paths';
import {
  analyzeLearningEvents,
  canSaveLoginAsCheckin,
  eventPath,
  isAuthLearningPath,
  isLogoutLearningEvent,
  isProfileLearningPath,
  type CheckinEvidenceLevel,
} from './learning-stage';
import { isChallengeSurfaceTarget } from '@/automation/challenge/challenge';
import {
  SUCCESS_WORDS as SHARED_SUCCESS_WORDS,
  ALREADY_WORDS as SHARED_ALREADY_WORDS,
  LOTTERY_SUCCESS_WORDS,
  LOTTERY_ALREADY_WORDS,
  LEARNING_LOTTERY_ACTION,
} from '@/automation/checkin/checkin-vocab';

/**
 * 学习事件上的「界面出现了什么」与「这个动作之前页面滚到了哪里」。
 *
 * `WorkflowLearningEvent` 已冻结为 navigation / click / fill 三种顶层事件，因此
 * 「这一步之后页面发生了什么变化」作为 click/fill 上的可选字段承载：命中的有限关键词
 * （成功/已完成/失败/验证类）+ 最多两条、每条 ≤ 60 字符的可见文本片段。
 *
 * **滚动同样不新增顶层 type**，而是作为动作上的一条可选属性：
 * - `scrollBeforeY`：这个动作发生前页面（`html`/`body` 的滚动条）已经停在哪一像素位置，
 *   0 ~ `LEARNING_SCROLL_MAX_Y`；
 * - `scrollPageTop`：滚动发生在锚在文档上的滚动容器里（页面本身没动）时，容器坐标与
 *   页面坐标不是同一把尺子，像素不可回放，只标记「这个动作之前页面被滚过」。
 *
 * 两者都是**去抖合并后的最终位置**，不是滚动轨迹、时间序列或鼠标坐标。
 * 绝不保存页面正文、输入值、密码、token、cookie、localStorage 或请求头。
 */
export type LearningEventWithChange = WorkflowLearningEvent & {
  afterText?: string[];
  scrollBeforeY?: number;
  scrollPageTop?: boolean;
  /**
   * 在输入框里按下并触发提交的非打印功能键（如 Enter）；采集侧新增，
   * `WorkflowLearningEvent` 已冻结不含它，但 sanitize/编译都按可选字段透传。
   * 绝不记可打印字符。
   */
  key?: WorkflowKey;
};

/** 「界面出现了什么」的片段上限：最多两条、每条 ≤ 60 字符。 */
export const LEARNING_SNIPPET_LIMIT = 2;
export const LEARNING_SNIPPET_MAX_CHARS = 60;
/** 关键词命中上限，避免把一个动作的证据写成一整段。 */
export const LEARNING_KEYWORD_LIMIT = 4;
/** 一次动作之后等待界面稳定的时间：太短看不到异步渲染出来的结果。 */
export const LEARNING_SETTLE_MS = 700;
/** 连续重复动作的合并窗口：同一控件 250ms 内的重复上报是同一次动作。 */
const RAPID_DUPLICATE_MS = 250;
/**
 * 滚动停止的判定窗口：`scroll` 连续静默这么久才认为「这次滚动结束了」。
 *
 * 用户在页面里往下滚一次会产生几十个 scroll 事件，逐个上报会把 30 步的额度瞬间吃满。
 * 200ms 与既有 `LEARNING_SETTLE_MS` 同一量级：比人手滚动的停顿短，又足够把一次
 * 惯性滚动（滚轮/触控板会持续派发事件）合并成一件事。
 */
export const LEARNING_SCROLL_STOP_MS = 200;
/**
 * 记录的滚动位置上限（像素）。
 *
 * 长页面（尤其是无限滚动的信息流）能把 `scrollY` 撑到几百万，照抄会把一个没有意义的
 * 天文数字写进站点配置 —— 回放时也不可复现。超过上限就记成上限值：学习只需要
 * 「用户当时确实往下滚过」这一个事实。
 */
export const LEARNING_SCROLL_MAX_Y = 1_000_000;
/**
 * 拖拽判定阈值（像素）：按下到松开的位移达到它，就认为这是一次「拖拽」——
 * 滑块验证的核心手势。位移小于它的按-松是手抖的点击，按正常点击录制。
 */
export const LEARNING_DRAG_TOLERANCE_PX = 12;
/**
 * 「值得记成一步」的拖拽最小位移。
 *
 * 按下后在同一个控件里轻微抖动（手抖、按钮内的拖动反馈）不该变成一步拖拽；
 * 真正的拖拽（滑块、排序、拖放）位移远大于它。
 */
export const LEARNING_DRAG_RECORD_PX = 24;
/**
 * 纯把手/装饰性拖拽的语义判据。
 *
 * 学习里最典型的「拖了但不算业务步骤」是把滑块验证的把手拖到位：验证交互由
 * 回放侧的自动破解管线接管，录成业务步骤会让回放去拖一个验证码把手。
 * 判据只看**语义与命名**，不看位移本身 —— 位移正是真实拖拽的判据。
 */
const DRAG_HANDLE_HINT = /(?:^|[-_\s])(?:knob|handle|thumb|slider|drag|pull)(?:$|[-_\s])|滑块|滑轨|拖动|拉动|向右滑/i;

/**
 * 拖拽端点解析：按 composedPath 由内向外选「控件本体」。
 *
 * 与点击目标同一口径：可点语义控件优先，其次才是最内层的任意元素。拖拽区
 * 常常是普通 div，因此这里比点击多一层「任意元素」兜底。
 */
function dragEndpoint(path: readonly EventTarget[]): HTMLElement | null {
  let fallback: HTMLElement | null = null;
  for (const item of path) {
    if (!(item instanceof HTMLElement)) continue;
    if (fallback === null) fallback = item;
    if (isStrongClickTarget(item)) return item;
  }
  return fallback;
}

/**
 * 这个元素能不能当**拖拽端点**？
 *
 * 真实拖拽（排序、拖放、拖到目标）的两端必须是站点明确声明可交互/可拖拽的元素；
 * 只有这样的端点才能稳定回放。把「在按钮上按住、拖到页面空白处松手」录成
 * `button → body` 这类步骤，回放时只会乱动页面 —— 宁可明确说「这一步没学到」。
 */
function isDraggableEndpoint(element: HTMLElement | null): boolean {
  let current: HTMLElement | null = element;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (current.draggable === true) return true;
    if ((current.getAttribute('draggable') ?? '').toLowerCase() === 'true') return true;
    if (current.getAttribute('role') === 'slider') return true;
    if (isStrongClickTarget(current)) return true;
    current = current.parentElement;
  }
  return false;
}

/** 控件本身或祖先链上是否有「把手/滑块」的语义或命名。 */
function looksLikeDragHandle(element: HTMLElement): boolean {
  let current: HTMLElement | null = element;
  for (let depth = 0; current && depth < 4; depth += 1) {
    const role = current.getAttribute('role') ?? '';
    const name = [
      current.tagName,
      current.id,
      typeof current.className === 'string' ? current.className : '',
      current.getAttribute('aria-label') ?? '',
      current.getAttribute('title') ?? '',
      current.getAttribute('data-testid') ?? '',
      role,
    ].join(' ');
    if (role === 'slider' || DRAG_HANDLE_HINT.test(name)) return true;
    current = current.parentElement;
  }
  return false;
}
/**
 * 拖拽松手后浏览器补发的 click 距松开的时间上限（毫秒）。
 *
 * Chrome 在按下与松开落在同一元素（或其后代）上时，会在 mouseup 之后补发一次
 * click —— 那是拖拽的尾巴，不是用户的点击。它必定紧随松开（同一轮输入处理），
 * 500ms 足够宽裕；超过这个窗口的点击与那次拖拽无关，不能被误伤。
 */
export const LEARNING_DRAG_TAIL_MS = 500;
/** 滚动位置在事件与步骤之间传递时的字段名（两处必须一致）。 */
const SCROLL_STEP_FIELD = 'scrollIntoView';

/**
 * 学习到的单个动作：保留「点了什么/输入了什么、在哪个页面、之后界面出现了什么」。
 *
 * scroll 也是真实的一步（用户「滚下去看内容再找按钮」不该整段丢失）：
 * 它没有 selector/label，只有最终落点比例与可选的滚动容器。
 */
interface LearningAction {
  kind: 'click' | 'fill' | 'scroll' | 'drag';
  /** drag：松开点所在的控件（与 selector 一起构成一次拖拽）。 */
  toSelector?: string;
  /** drag：松开点在目标控件内的相对落点。 */
  toAnchor?: WorkflowPointerAnchor;
  selector?: string;
  label?: string;
  path: string;
  /** 凭据字段语义（融合采集才有）：登录编译器用它，签到编译器据此过滤。 */
  fieldRole?: 'username' | 'password';
  /** 点击的登录角色（入口/提交/第三方）：融合采集时同样标注，供两个编译器各自使用。 */
  loginAction?: 'entry' | 'submit' | 'oauth';
  href?: string;
  hasValue?: boolean;
  /** scroll 动作的最终落点比例 0..1。 */
  ratio?: number;
  afterText?: string[];
  evidence?: { kind: 'success' | 'already'; words: string[] };
  /** 这个动作发生**之前**用户把页面滚到了哪里（去抖合并后的最终位置）。 */
  scrollBeforeY?: number;
  /** 页面本身没动、但滚动容器滚过：位置不可信，只记「滚过」。 */
  scrollPageTop?: boolean;
  /** 实际滚动的内层面板（CSS），不是整个窗口。 */
  scrollContainer?: string;
  /** 点击落点 / 手势 / 键盘键 / 长按时长 / 拖拽终点 / 控件指纹与目标态（契约透传字段）。 */
  anchor?: WorkflowPointerAnchor;
  gesture?: WorkflowGesture;
  key?: WorkflowKey;
  holdMs?: number;
  dragToSelector?: string;
  dragToAnchor?: WorkflowPointerAnchor;
  fingerprint?: WorkflowElementFingerprint;
  control?: WorkflowFormControl;
  choice?: number;
  checked?: boolean;
  at: number;
}

/** 与 workflow-validation.ts 的 MAX_ROUTE_LENGTH 保持一致：学出的路线必须能通过保存校验。 */
const MAX_ROUTE_PAGES = 12;
/** 与 workflow-validation.ts 的 MAX_WORKFLOW_STEPS 保持一致。 */
const MAX_WORKFLOW_STEPS = 30;
/**
 * 结尾「今日已签到 / 签到成功」分支占住的额度。
 *
 * 校验器把分支里的断言也计入总步数，因此这里要预留 **3** 步（1 个 if + then/else 两个断言），
 * 否则动作多的流程会在保存那一步被自己的校验器拒掉。
 */
const RESERVED_STEPS = 3;

const CHECKIN_LABEL = /签到|打卡|领取|奖励|福利|抽奖|抽签|翻牌|check[\s-]?in|claim|attendance|daily|\b(?:start\s+)?draw\b/i;
const CHECKIN_PATH = /(?:^|\/)(?:check-?in|daily-check-?in|sign-?in|attendance|rewards?|benefit|lottery|draw|prize)(?:\/|$)/i;
const PROFILE_LABEL = /个人资料|个人信息|账户信息|账号信息|我的(?:账户|账号|资料)|profile|my\s+account|account\s+(?:settings|info|details)|user\s+center/i;
const PROFILE_PATH = /(?:^|\/)(?:profile|personal|account|user|me)(?:\/|$)/i;
/**
 * 明显不是「显示当前账号」的页面（偏好 / 财务 / 安全 / 通知等）。
 *
 * `/settings`、`/account/billing` 这类页面会命中 PROFILE_PATH 的泛词，却看不到
 * 登录账号；被推成 identityPath 后回放每次都在错误的页面等身份、永远停机，
 * 而 identityPath 没有直接修正入口。宁可推断不出（保存时提示先访问真正的
 * 个人资料页），也不要推错。
 */
const PROFILE_PATH_EXCLUDE = /(?:^|\/)(?:settings?|preferences?|config|billing|payments?|invoices?|subscription|plans?|pricing|orders?|usage|logs?|tokens?|keys?|api-?keys?|security|passwords?|passkeys?|2fa|mfa|notifications?|invites?|affiliate|referrals?)(?:\/|$)/i;
/**
 * 「去某个页面」的导航/资料类标签：这类点击本身不是签到动作。
 *
 * 现场故障（CottonAPI 实测）：用户当天已签到、页面上没有「立即签到」按钮，演示时最后
 * 点的是导航项「个人资料」。旧实现把**最后一个动作兜底**当成签到动作，学出的流程以
 * 「点击个人资料」收尾；回放时当然找不到真正的签到按钮，用户看到的就是「根本没学到我的操作」。
 * 宁可当场拒结保存、让用户再演示一次，也不保存一份「看着有、跑起来没有」的流程。
 */
const NAVIGATION_LABEL = /个人(?:资料|信息|中心)|账户信息|账号信息|我的(?:账户|账号|资料|信息)|控制台|首页|设置|偏好|仪表盘|退出|登出|profile|personal|account|dashboard|console|preferences?|logout|log\s?out/i;
const SUCCESS_WORDS = [...SHARED_SUCCESS_WORDS, ...LOTTERY_SUCCESS_WORDS];
const ALREADY_WORDS = [...SHARED_ALREADY_WORDS, ...LOTTERY_ALREADY_WORDS];
/** 失败与验证类词：它们是「界面出现了什么」的一部分，也提示这一步为何没生效。 */
const FAILURE_WORDS = ['领取失败', '签到失败', '操作失败', '请稍后重试', '系统繁忙', 'check-in failed'];
const CHALLENGE_WORDS = ['请完成验证', '人机验证', '验证码', '请先登录', '登录已过期', 'verify you are human'];
const CHANGE_WORDS = [...ALREADY_WORDS, ...SUCCESS_WORDS, ...FAILURE_WORDS, ...CHALLENGE_WORDS];

/**
 * 认证动作的判定依据。
 *
 * 登录/注册/授权点击不该被回放 —— 但「看到登录两个字就丢」会把用户真实的动作一起丢掉。
 * 这里只排除三种**精确**情况：控件地址指向认证页、明确的认证输入框、纯登录词标签。
 */
const AUTH_PATH = /(?:^|\/)(?:login|log-in|signin|sign-in|signup|sign-up|register|oauth|authorize|auth|logout)(?:\/|$|\?)/i;
const AUTH_FIELD = /password|passwd|pwd|token|secret|captcha|otp|验证码|密码/i;
const AUTH_LABEL_ONLY = /^(?:登录|登出|退出|退出登录|注销|注册|立即登录|去登录|免费注册|sign\s?in|sign\s?up|log\s?in|log\s?out|logout|oauth|github|google|passkey)$/i;
const LOGIN_IDENTIFIER_HINT = /(?:user(?:name)?|account|e-?mail|login|phone|mobile|用户名|用户|账号|账户|邮箱|手机号|手机)/i;
const LOGIN_NON_CREDENTIAL_HINT = /(?:one[-_ ]?time|captcha|verification|verify|otp|totp|mfa|2fa|security[-_ ]?code|验证码|校验码|动态码|token|secret)/i;
const LOGIN_OAUTH_HINT = /(?:github|google|discord|telegram|microsoft|linux.?do|oauth|sso|passkey|webauthn|第三方)/i;
const LOGIN_ENTRY_HINT = /(?:log\s?in|sign\s?in|登录|登陆|账号密码|邮箱登录|使用密码|use password|email login)/i;
const LOGIN_SUBMIT_HINT = /^(?:log\s?in|sign\s?in|login|登录|登陆|立即登录|提交|继续|下一步|continue|next|submit)$/i;

/**
 * 含凭据的回调 hash（OAuth access_token / 验证码 state 等）绝不落盘。
 *
 * 采集侧 `currentPath` 已经剥过一次，但事件可能来自旧版本录制、也可能被页面脚本
 * 伪造；路线与步骤真正落盘的这一刻必须再剥一次 —— 写进站点配置的 URL 是永久泄漏面。
 */
const SENSITIVE_HASH_PARAM = /(?:^#|[?&])(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|code|state|secret|password|credential|session|auth)=/i;

/** hash 里出现凭据类参数时整体丢弃（宁可少一段 hash 路由，也不写敏感值）。 */
function safeHash(hash: string): string {
  return SENSITIVE_HASH_PARAM.test(hash) ? '' : hash;
}

function sameOriginPath(site: SiteConfig, value: string): string | undefined {
  // 空值不能被解析成基准地址，否则会把 loginUrl 误当成用户经过的页面。
  if (!value.trim()) return undefined;
  try {
    const target = new URL(value, site.loginUrl);
    const origin = new URL(site.loginUrl).origin;
    if (target.origin !== origin) return undefined;
    return `${target.pathname}${safeHash(target.hash)}`;
  } catch {
    return undefined;
  }
}

function uniqueWords(text: string, words: string[]): string[] {
  return words.filter((word) => text.toLocaleLowerCase().includes(word.toLocaleLowerCase()));
}

/**
 * 事件里携带的变化证据；越界或**疑似含密钥/凭据**的片段一律丢弃（长度、内容与条数三重上限）。
 *
 * 这里是把变化证据编译成 `assert` 步骤、写进站点配置的读回侧：在采集侧 `isSafeSnippet`
 * 之外再兜同一层内容过滤 —— 存进 session 的旧事件、或绕过采集侧的伪造事件，都不能把
 * API 密钥（`sk-…`/`ghp_…` 这类没有六位连号的形态）明文带进配置。
 */
function afterTextOf(event: WorkflowLearningEvent): string[] {
  const raw = (event as { afterText?: unknown }).afterText;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.replace(/\s+/g, ' ').trim())
    .filter(isSafeSnippet)
    .slice(0, LEARNING_SNIPPET_LIMIT + LEARNING_KEYWORD_LIMIT);
}

/**
 * 断言词的内容闸门：与 `afterText` 同一套判据。
 *
 * `evidence.words` 会被编译成 `assert` 步骤**明文写进站点配置**；正常采集只产出
 * 固定词表里的短词，但事件可能来自旧会话或被页面脚本伪造 —— 疑似密钥/凭据/邮箱的
 * 词一律丢弃，绝不让它借断言通道落盘。
 */
function safeEvidence(
  evidence: { kind: 'success' | 'already'; words: string[] } | undefined,
): LearningAction['evidence'] | undefined {
  if (!evidence || (evidence.kind !== 'success' && evidence.kind !== 'already')) return undefined;
  if (!Array.isArray(evidence.words)) return undefined;
  const words = evidence.words
    .filter((word): word is string => typeof word === 'string' && isSafeSnippet(word))
    .slice(0, 4);
  return words.length ? { kind: evidence.kind, words } : undefined;
}

/** 选择器里内嵌的 href（`a[href="/login"]` 这类），用于判定是否指向认证页面。 */
function hrefFromSelector(selector: string): string | undefined {
  const match = /\[href\s*[*^$|~]?=\s*["']?([^"'\]]+)["']?\]/i.exec(selector);
  return match?.[1];
}

/**
 * 用户已经把页面滚到了哪里 —— 学习时挂在动作上，回放时靠它把目标滚进视口。
 *
 * 只读滚动位置一个数，不读滚动轨迹、不读鼠标坐标、不读任何页面内容。
 */
export interface LearnScrollState {
  /** 页面本身（`html` / `body`）的滚动位置；拿不到时为 undefined。 */
  pageY?: number;
  /** 点击前页面确实被滚过（页面没动但滚动容器滚了时也置真）。 */
  scrolled?: boolean;
  scrollContainer?: string;
  /**
   * 页面自身滚动的最终落点比例 0..1（`pageY / max(1, scrollHeight - clientHeight)`）。
   * 只在页面自身滚动时出现；内层容器滚动用 `containerRatio` 承载，二者互斥。
   * 纯滚动事件（`type: 'scroll'`）据此产生，回放时按比例还原真实像素。
   */
  ratio?: number;
  /** 内层滚动容器的最终落点比例 0..1（`scrollTop / max(1, scrollHeight - clientHeight)`）。 */
  containerRatio?: number;
}

/** 可滚动容器内当前的纵向偏移（取最大者）：判断「页面没动但其实滚过」用。 */
function maxContainerScrollTop(): number {
  let max = 0;
  for (const element of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
    if (element.scrollTop > max) max = element.scrollTop;
  }
  return max;
}

/**
 * 「用户滚到哪了」的采集口径。
 *
 * 1. 页面自身（`html` / `body`）的滚动条位置 —— 这是最有用的证据，也是回放时
 *    「把目标滚进视口」的直接依据；
 * 2. `window.scrollY` 在部分浏览器/整页滚动时与 `documentElement` 不同步，取最大值
 *    兜底，宁可大一点也不要漏掉「用户明明滚过」；
 * 3. 站点把内容放在自己的滚动容器里（`overflow: auto` 的列表/面板）时，页面本身没动，
 *    容器的 `scrollTop` 与页面坐标不是同一把尺子 —— 这种偏移**只标记滚过**，
 *    绝不把容器像素当成页面位置记下来（那会在回放时滚错地方）。
 */
/** 容器/页面的滚动比例：当前偏移 / 可滚动总长度，钳到 0..1。 */
function scrollRatio(offset: number, scrollHeight: number, clientHeight: number): number {
  const span = Math.max(1, scrollHeight - clientHeight);
  return Math.min(1, Math.max(0, offset / span));
}

export function learnScrollState(target?: HTMLElement): LearnScrollState {
  // 点击/输入时只认目标自己的滚动祖先，不能把已滚动的侧栏套到主区动作上。
  for (let node: HTMLElement | null = target ?? null; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    if (node.scrollTop <= 0 || !/(auto|scroll|overlay)/.test(getComputedStyle(node).overflowY)) continue;
    const selector = node.id && !isUnstableGeneratedId(node.id) ? `#${node.id}` : structuredPath(node);
    if (selector && selector.length <= 300 && document.querySelectorAll(selector).length === 1) {
      return { scrolled: true, scrollContainer: selector, containerRatio: scrollRatio(node.scrollTop, node.scrollHeight, node.clientHeight) };
    }
  }
  const pageY = Math.max(
    Math.round(document.documentElement?.scrollTop ?? 0),
    Math.round(document.body?.scrollTop ?? 0),
    Math.max(0, Math.round(window.scrollY ?? 0)),
  );
  const pageMoved = pageY > 0;
  // 页面比例总是算：点击/输入前的 takeScroll 路径靠 scrollEvidenceFields 只取
  // pageY/scrolled（scrollIntoView 用语义），而纯滚动事件需要 ratio 来记录
  // 「滚到了哪里」。ratio 与 pageY 并存，互不影响。
  const root = document.documentElement;
  const pageRatio = root
    ? scrollRatio(pageY, root.scrollHeight, root.clientHeight)
    : undefined;
  return {
    ...(pageMoved ? { pageY } : {}),
    ...(pageMoved && pageRatio !== undefined ? { ratio: pageRatio } : {}),
    ...(pageMoved || (!target && maxContainerScrollTop() > 0) ? { scrolled: true } : {}),
  };
}

/** 钉死滚动位置的长度上限；非有限值一律丢弃（不把 NaN/Infinity 写进配置）。 */
function clampScrollY(value: number): number | undefined {
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.min(Math.round(value), LEARNING_SCROLL_MAX_Y);
}

/**
 * 回放侧要挂的字段：点击/输入**之前先把目标滚进视口**。
 *
 * 可选、且只在录制时确实滚过页面才出现；`true` 只是「需要滚一下」的开关，
 * 不携带任何绝对像素 —— 页面高度变了也照样能用。
 */
export interface ScrollStepFields {
  /** 回放时先把目标滚进视口（相对该控件自身，不依赖绝对像素）。 */
  scrollIntoView?: true;
  scrollContainer?: string;
}

/**
 * 事件上的滚动证据是否可用。
 *
 * 只认「有限且为正的像素位置」与「滚过标记」；`NaN` / `Infinity` / 负数 / 空字符串
 * 一律按「没滚过」处理 —— 宁可少塞一个属性，也不产出回放不了的步骤。
 */
export function hasScrollEvidence(event: WorkflowLearningEvent | undefined): boolean {
  if (!event) return false;
  const raw = (event as { scrollBeforeY?: unknown }).scrollBeforeY;
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0;
  const marker = (event as { scrollPageTop?: unknown }).scrollPageTop;
  return marker === true && raw === undefined;
}

/**
 * 把事件上的滚动信息原样搬进动作。
 *
 * 只搬这两条已脱敏字段，**不搬任何别的**：事件是外部（页面脚本 → 消息通道 → 会话存储）
 * 来的数据，编译器不应该顺手把它当成通用属性表使用。
 */
function safeScrollContainer(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const selector = value.trim();
  return selector && selector.length <= 300 && !selector.includes('text=') && !hasUnstableIdSelector(selector)
    ? selector : undefined;
}

function scrollFieldsOf(event: WorkflowLearningEvent): Pick<LearningAction, 'scrollBeforeY' | 'scrollPageTop' | 'scrollContainer'> {
  const raw = (event as { scrollBeforeY?: unknown }).scrollBeforeY;
  const scrollContainer = safeScrollContainer((event as { scrollContainer?: unknown }).scrollContainer);
  const container = scrollContainer ? { scrollContainer } : {};
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return { scrollBeforeY: Math.min(Math.round(raw), LEARNING_SCROLL_MAX_Y), ...container };
  }
  const marker = (event as { scrollPageTop?: unknown }).scrollPageTop;
  return marker === true ? { scrollPageTop: true, ...container } : {};
}

/** 事件上承载滚动证据的字段（只在 learning.ts 内部生成）。 */
type ScrollEventFields = { scrollBeforeY?: number; scrollPageTop?: boolean; scrollContainer?: string };

/** 提交前把滚动值钉上限长：越界/非法值退回「滚过」标记，绝不写不可回放的像素。 */
function sanitizeScrollFields(fields: ScrollEventFields): ScrollEventFields {
  const raw = fields.scrollBeforeY;
  const scrollContainer = safeScrollContainer(fields.scrollContainer);
  const marker: ScrollEventFields = fields.scrollPageTop
    ? { scrollPageTop: true, ...(scrollContainer ? { scrollContainer } : {}) } : {};
  if (raw === undefined) return marker;
  const y = clampScrollY(raw);
  return y !== undefined && y > 0 ? { scrollBeforeY: y } : marker;
}

/**
 * 动作上要不要带滚动信息、带哪种。
 *
 * 两种来源说的是同一件事：「这个动作发生前用户把页面滚过」。位置是精确证据，
 * **只有页面真的停在那个位置**才算 —— 用户可能又滚回顶部点了第二个按钮。
 * 用户的滚动也可能还没到去抖时间就点了控件，所以位置读自 DOM 而不是只靠去抖结果。
 */
function scrollEvidenceFields(state: LearnScrollState | null): ScrollEventFields {
  if (state?.pageY !== undefined && state.pageY > 0) return { scrollBeforeY: state.pageY };
  if (state?.scrolled) return { scrollPageTop: true, ...(state.scrollContainer ? { scrollContainer: state.scrollContainer } : {}) };
  return {};
}

/** 动作侧的同一判断，供编译器决定要不要给这个步骤加 `scrollIntoView`。 */
function actionScrollFields(action: LearningAction): ScrollStepFields {
  return hasActionScroll(action)
    ? { [SCROLL_STEP_FIELD]: true, ...(action.scrollContainer ? { scrollContainer: action.scrollContainer } : {}) } as ScrollStepFields
    : {};
}

/** 这个动作是不是认证动作？（只做精确判定，不做关键词扫射；scroll 动作没有控件，永不命中） */
function isAuthAction(action: LearningAction & { kind: 'click' | 'fill' }): boolean {
  const target = action.href ?? hrefFromSelector(action.selector ?? '');
  if (target) {
    try {
      const url = new URL(target, 'https://placeholder.invalid');
      if (AUTH_PATH.test(`${url.pathname}${url.search}`)) return true;
    } catch {
      // 地址解析不了就退回其它判定，不影响采集。
    }
  }
  if (action.kind === 'fill' && AUTH_FIELD.test(`${action.selector ?? ''} ${action.label ?? ''}`)) return true;
  return AUTH_LABEL_ONLY.test((action.label ?? '').trim());
}

/**
 * 这个动作是不是「登录凭据动作」？
 *
 * 融合学习会把登录页上的账号/密码输入与登录/第三方入口点击如实录进同一份事件流。
 * 签到流程**只能**包含登录之后的动作：把凭据输入回放进签到，轻则填错框，
 * 重则把 {{claimText}} 填进密码框。判据是采集侧给出的**语义标注**
 * （\`fieldRole\` 与 \`loginAction\`），不是按页面文字扫射 —— 正常业务页上
 * 「登录」两个字太常见，扫射会连真实动作一起丢掉。
 *
 * 注意 \`loginAction === 'entry'\` 不算凭据动作：它可能只是业务页上的普通入口，
 * 而且签到编译器已经按「动作所在页是不是认证页」做过一轮过滤。
 */
function isCredentialAction(action: LearningAction): boolean {
  if (action.fieldRole === 'username' || action.fieldRole === 'password') return true;
  if (action.kind !== 'click') return false;
  /*
   * `oauth` 一定是凭据动作：只有登录页上的第三方登录入口会被这样标注。
   */
  if (action.loginAction === 'oauth') return true;
  /*
   * `submit` 不能单独作数。
   *
   * 采集侧按「表单里的按钮 / type=submit」判提交，而这套判据在业务页上同样成立：
   * 站点把签到按钮放进 <form>（或它本来就是 type=submit）时，一次真实的签到点击
   * 会带着 loginAction='submit' 进到编译器。若在这里按标签直接丢弃，整份流程
   * 编译成 null，用户看到「还没有录到可识别的签到动作」—— 他明明点过签到。
   *
   * 因此 `submit` 只在**签到证据不足**时才当成凭据动作：文案命中签到词，或链接指向
   * 业务页面，都说明这是真实业务动作，必须保留。真正落在认证页上的提交由
   * isAuthAction 负责剔除，那条判据看的是页面路径，比标签可靠。
   */
  if (action.loginAction !== 'submit') return false;
  if (CHECKIN_LABEL.test(action.label ?? '')) return false;
  if (action.href && !AUTH_PATH.test(action.href)) return false;
  return true;
}

type LearningActionEvent = Extract<WorkflowLearningEvent, { type: 'click' | 'fill' }>;
type DragLearningEvent = Extract<WorkflowLearningEvent, { type: 'drag' }>;

/** drag 事件的对应键：起点/终点/页面/时间。 */
function dragActionKey(event: DragLearningEvent): string {
  return `drag|${event.selector}|${event.toSelector}|${event.path}|${event.at}`;
}

/** 后续上报（界面变化 / 输入的最终状态）与它描述的那个动作的对应键。 */
function actionKey(event: LearningActionEvent): string {
  return `${event.type}|${event.selector}|${event.path}|${event.at}`;
}

/** scroll 事件的对应键：没有 selector，用 path + ratio 区分。 */
function scrollActionKey(event: Extract<WorkflowLearningEvent, { type: 'scroll' }>): string {
  return `scroll|${event.path}|${event.ratio}|${event.at}`;
}

/**
 * 把事件的真实顺序投影成动作序列；不做「取某一段」的裁剪，也不按标签关键词丢弃。
 *
 * 两条去重规则都不合并不同的步骤：
 * 1. 带相同 `at` 的后续上报是对同一个动作的补充说明（点击后补报的界面变化、输入结束后的
 *    最终状态），挂回原动作而不是新增一步 —— 这是「一次动作 = 一步」的保证；
 * 2. 同一控件、同一页面、250ms 内的重复上报是同一次动作的双发（事件冒泡、双击抖动）。
 */
function actionSteps(events: readonly WorkflowLearningEvent[]): LearningAction[] {
  const actions: LearningAction[] = [];
  const indexByKey = new Map<string, number>();
  for (const event of events) {
    if (event.type === 'navigation') continue;
    if (event.type === 'scroll') {
      // 纯滚动是真实的一步：保留它的最终落点；编译时再决定与「动作前滚动」合并还是单独成步。
      const ratio = event.ratio;
      if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) continue;
      // 与同页动作**紧邻且同位置**的重复滚动只占额度：动作间的多次停顿式滚动
      // （滚一段停一下继续滚）只有最终落点有回放价值。滚动停在哪、之后隔了多久
      // 才点的控件不影响「滚到这里 → 滚进视口再点」的等价性，因此不设时间窗。
      const previous = actions.at(-1);
      if (previous?.kind === 'scroll'
        && pageKey(previous.path) === pageKey(event.path)
        && (previous.scrollContainer ?? '') === (event.container ?? '')
        && Math.abs((previous.ratio ?? 0) - Math.min(1, Math.max(0, ratio))) <= 0.02) {
        continue;
      }
      actions.push({
        kind: 'scroll',
        path: event.path,
        ratio: Math.min(1, Math.max(0, ratio)),
        ...(event.container ? { scrollContainer: event.container } : {}),
        at: event.at,
      });
      continue;
    }
    if (event.type === 'drag') {
      /*
       * 拖拽是**一步**：起点/终点选择器与各自落点一起投影成 LearningAction。
       * 与 click/fill 不同，它没有 afterText/evidence（拖拽的「结果」由后续
       * 的断言或页面变化承载），但仍然带动作前滚动证据。
       */
      const fromSelector = event.selector.trim();
      const toSelector = event.toSelector.trim();
      if (!fromSelector || !toSelector) continue;
      /*
       * 同一 at 的补报（拖拽后界面的变化）与前一条合并回同一步：
       * 拖拽只该占一个动作额度。这里的 afterText/evidence 与 click 走同一套
       * 内容闸门，绝不把页面正文原样落盘。
       */
      const previous = actions[actions.length - 1];
      if (previous?.kind === 'drag'
        && previous.selector === fromSelector
        && previous.toSelector === toSelector
        && previous.path === event.path
        && previous.at === event.at) {
        const afterText = afterTextOf(event);
        const evidence = safeEvidence(event.evidence);
        if (afterText.length) previous.afterText = afterText;
        if (evidence) previous.evidence = evidence;
        if (hasScrollEvidence(event)) Object.assign(previous, scrollFieldsOf(event));
        continue;
      }
      const afterText = afterTextOf(event);
      const evidence = safeEvidence(event.evidence);
      actions.push({
        kind: 'drag',
        selector: fromSelector,
        toSelector,
        label: event.label ?? '',
        path: event.path,
        ...(event.anchor ? { anchor: event.anchor } : {}),
        ...(event.toAnchor ? { toAnchor: event.toAnchor } : {}),
        ...(afterText.length ? { afterText } : {}),
        ...(evidence ? { evidence } : {}),
        ...(hasScrollEvidence(event) ? scrollFieldsOf(event) : {}),
        at: event.at,
      });
      continue;
    }
    const selector = event.selector?.trim();
    if (!selector) continue;
    // 事件里的断言词先过内容闸门；后面只认识已经过闸的 evidence。
    const evidence = event.type === 'click' ? safeEvidence(event.evidence) : undefined;

    const existing = indexByKey.get(actionKey(event as LearningActionEvent));
    if (existing !== undefined) {
      const action = actions[existing]!;
      const afterText = afterTextOf(event);
      if (afterText.length) action.afterText = afterText;
      if (evidence) action.evidence = evidence;
      if (event.type === 'fill') action.hasValue = event.hasValue;
      if (hasScrollEvidence(event)) Object.assign(action, scrollFieldsOf(event));
      continue;
    }

    const afterText = afterTextOf(event);
    const action: LearningAction = {
      kind: event.type,
      selector,
      label: event.label ?? '',
      path: event.path,
      ...(event.type === 'click' && event.href ? { href: event.href } : {}),
      ...(event.type === 'fill' ? { hasValue: event.hasValue } : {}),
      ...(event.type === 'fill' && event.fieldRole ? { fieldRole: event.fieldRole } : {}),
      // 「怎么点的/怎么填的」契约字段透传：落点、手势、键盘、长按、拖拽、指纹、控件目标态。
      ...(event.type === 'click' && event.anchor ? { anchor: event.anchor } : {}),
      ...(event.type === 'click' && event.gesture ? { gesture: event.gesture } : {}),
      ...(event.type === 'click' && event.key ? { key: event.key } : {}),
      ...(event.type === 'click' && typeof event.holdMs === 'number' ? { holdMs: event.holdMs } : {}),
      ...(event.type === 'click' && event.dragToSelector ? { dragToSelector: event.dragToSelector } : {}),
      ...(event.type === 'click' && event.dragToAnchor ? { dragToAnchor: event.dragToAnchor } : {}),
      ...(event.type === 'click' && event.loginAction ? { loginAction: event.loginAction } : {}),
      ...(event.fingerprint ? { fingerprint: event.fingerprint } : {}),
      ...(event.type === 'fill' && event.control ? { control: event.control } : {}),
      ...(event.type === 'fill' && typeof event.choice === 'number' ? { choice: event.choice } : {}),
      ...(event.type === 'fill' && typeof event.checked === 'boolean' ? { checked: event.checked } : {}),
      ...(afterText.length ? { afterText } : {}),
      ...(evidence ? { evidence } : {}),
      // 滚动信息与动作同生共死：它就是「这一步之前页面已经被滚到哪」这一件事。
      ...(hasScrollEvidence(event) ? scrollFieldsOf(event) : {}),
      at: event.at,
    };
    if (action.kind !== 'scroll') {
      // 认证页动作（旧的路径/标签判据）与凭据语义动作（融合采集新带来的 fieldRole /
      // submit / oauth 标注）都不进签到流程：它只回放登录**之后**的步骤。
      if (isAuthAction(action as LearningAction & { kind: 'click' | 'fill' })) continue;
      if (isCredentialAction(action)) continue;
    }

    const previous = actions.at(-1);
    if (previous
      && previous.selector === action.selector
      && previous.kind === action.kind
      && previous.path === action.path
      && Math.abs(action.at - previous.at) <= RAPID_DUPLICATE_MS
      // 双击/连点/键盘触发是**真实**的不同操作，不能被合并。
      && !action.gesture && !action.key
      && !previous.gesture && !previous.key) {
      if (action.evidence) previous.evidence = action.evidence;
      if (action.afterText) previous.afterText = action.afterText;
      // 补报（界面变化那一份）丢不掉滚动信息：用户可能就是在补报之前才滚的页面。
      if (action.scrollBeforeY !== undefined) previous.scrollBeforeY = action.scrollBeforeY;
      if (action.scrollPageTop) previous.scrollPageTop = true;
      if (action.scrollContainer) previous.scrollContainer = action.scrollContainer;
      indexByKey.set(actionKey(event), actions.length - 1);
      continue;
    }
    indexByKey.set(actionKey(event), actions.length);
    actions.push(action);
  }
  // 空输入的 fill 是「看了一眼没填」，回放时不该去填任何东西。
  return actions.filter((action) => action.kind !== 'fill' || action.hasValue !== false);
}

/** 路径条件只比较 pathname，事件里的 path 是 pathname+hash，必须剥掉哈希。 */
function pathnameOf(path: string): string {
  const hashAt = path.indexOf('#');
  const withoutHash = hashAt >= 0 ? path.slice(0, hashAt) : path;
  return withoutHash || '/';
}

/**
 * 页面分组/步骤守卫使用的页面键。
 *
 * 普通站点只靠 pathname 就够了，但 hash router 的所有页面 pathname 都是 `/`。
 * 如果这里继续调用 `pathnameOf`，`/#/console` 和 `/#/check-in` 会被合并成同一组，
 * 回放时入口动作就会和最终签到动作一起执行，学习出来的流程看起来像“少了一步”。
 * 查询串仍然忽略，和 route 的存储及回放规则保持一致。
 */
function pageKey(path: string): string {
  try {
    const url = new URL(path, 'https://placeholder.invalid');
    return `${url.pathname || '/'}${safeHash(url.hash)}`;
  } catch {
    const trimmed = path.trim();
    return trimmed || '/';
  }
}

/**
 * 登录/注册/授权页面的**路径**判定。
 *
 * 判据只有两条，两条都只看路径，绝不看页面文字：
 * 1. 与 `site.loginUrl` 的 pathname 相同 —— 学习就是从这一页开页的（`toggleLearning` 用
 *    `site.loginUrl` 开页），它必然是登录页；这条最精准，也不依赖站点用什么词命名；
 * 2. 路径本身就是登录/注册/授权语义（`/sign-in`、`/login`、`/register`、`/auth/callback`）。
 *
 * 刻意不看文字：正常业务页上也会出现「请先登录」这类提示，用关键词扫射会把
 * `/login-history` 这种真实页面一起丢掉。段边界用 `(?:^|/)` / `(?:/|$)` 卡住，
 * `login-history`、`authors` 这类不等于认证页。
 */
const AUTH_PAGE_PATH = /(?:^|\/)(?:sign-?in|sign-?up|log-?in|log-?out|logout|register|auth|oauth|authorize|password|reset|forgot)(?:\/|$)/i;

/** `site.loginUrl` 对应的登录页路线项（哈希路由站点要连 hash 一起比，否则会把 `/` 全判成登录页）。 */
function loginPagePath(site: SiteConfig): string | undefined {
  if (isKnownBusinessLearningPath(site.loginUrl)) return undefined;
  try {
    const url = new URL(site.loginUrl);
    if (url.hash) return `${url.pathname}${url.hash}`;
    // 根路径 `/` 不是「登录页」这一具体页面：哈希路由站点（`https://x.com/#/checkin`）的
    // pathname 全都是 `/`，把 `/` 判成登录页会让整条路线被清空。
    return url.pathname && url.pathname !== '/' ? url.pathname : undefined;
  } catch {
    return undefined;
  }
}

/** 这一页是不是登录/认证页？是的话它绝不能进路线。 */
function isAuthPage(site: SiteConfig, page: string): boolean {
  const loginPage = loginPagePath(site);
  if (loginPage) {
    const same = loginPage.includes('#') ? page === loginPage : pathnameOf(page) === loginPage;
    if (same) return true;
  }
  const hashPath = page.includes('#') ? page.slice(page.indexOf('#') + 1) : '';
  return AUTH_PAGE_PATH.test(pathnameOf(page))
    || (hashPath.startsWith('/') && AUTH_PAGE_PATH.test(hashPath));
}

/** 动作发生在哪个同源页面：优先它记录的 path，退化为链接目标。 */
function actionPage(site: SiteConfig, action: LearningAction): string | undefined {
  return sameOriginPath(site, action.path) ?? sameOriginPath(site, action.href ?? '');
}

/** 这个动作在录制时是不是「先滚了页面才够得着」？是的话回放要先滚进视口。 */
function hasActionScroll(action: LearningAction): boolean {
  if (typeof action.scrollBeforeY === 'number') {
    return Number.isFinite(action.scrollBeforeY) && action.scrollBeforeY > 0;
  }
  return action.scrollPageTop === true;
}

/**
 * 这个点击是「跳去另一个页面」吗？
 *
 * 两种判据：标签命中导航/资料词，或链接指向**别的**同源页面。带这种点击的流程
 * 会先跳走再回放，而签到步骤只能在当前文档执行 —— 让它当终点页动作会变成
 * 「跳过去、再从头跳一次」的往返。
 */
function looksLikePageNavigation(site: SiteConfig, action: LearningAction): boolean {
  if (action.kind !== 'click') return false;
  if (NAVIGATION_LABEL.test(action.label ?? '')) return true;
  const hrefPage = action.href ? sameOriginPath(site, action.href) : undefined;
  return !!hrefPage && pageKey(hrefPage) !== pageKey(action.path);
}

/**
 * 学习同源页面路线（「学会网址」的载体）。
 *
 * 规则：
 * - 只收集与 `site.loginUrl` 同源的 `pathname + hash`，按访问顺序排列，外域导航一律丢弃；
 * - **登录/认证页一律不进路线**（`isAuthPage`）。学习是从 `site.loginUrl` 开页的，而采集器
 *   首次加载就会上报一个 navigation 事件，于是登录页会变成 `route[0]`。回放时用户落在
 *   `/dashboard/overview` 这类被重定向到的真实页面，它不在 route 里 → `resolveRoute` 里
 *   `currentIndex === -1` → 每次都跳 `route[0]` = 登录页 → 站点又重定向回来，
 *   表现就是日志三行完全一样地重复、永远到不了签到页；
 * - 顺序由 navigation 事件与**动作所在页面**共同按时间归并：整页跳转后注入的采集脚本
 *   可能来不及上报 navigation，只看事件流会把用户真实走过的一页丢掉，回放时那一页的动作
 *   会落到别的页面上执行；
 * - 只去掉**连续**重复项：用户中途回到同一页要保留，它可能是真实路线的一段；
 * - 最后一项必须是记录到有效签到动作的那个页面。路线要么以签到页收尾，要么整体不给
 *   （返回空数组，调用方退化成「只执行 steps」，与老配置一样），
 *   绝不产出末项不是签到页的半条路线 —— 那会让回放停在半路执行签到页的动作。
 */
function learnedRoute(
  site: SiteConfig,
  events: readonly WorkflowLearningEvent[],
  actions: readonly LearningAction[],
): string[] {
  const timeline: string[] = [];
  const push = (page: string | undefined): void => {
    if (!page || isAuthPage(site, page)) return;
    if (timeline.at(-1) === page) return;
    timeline.push(page);
  };

  // 终点页只能在「非认证页面上的动作」里挑：登录页上的动作当不了签到动作。
  const candidates = actions.filter((action) => {
    const page = actionPage(site, action);
    return !!page && !isAuthPage(site, page);
  });
  const evidenceTarget = [...candidates].reverse().find((action) => !!action.evidence);
  const labelTarget = [...candidates].reverse().find((action) => (
    CHECKIN_LABEL.test(action.label ?? '') || CHECKIN_PATH.test(action.path)
  ));
  const fallbackTarget = candidates.at(-1);
  const target = evidenceTarget ?? labelTarget ?? fallbackTarget;
  /**
   * 导航点击不能当签到动作。
   *
   * - 兜底挑中的最后一个动作（既无成功/已完成证据、也无签到关键词）一看就是页面导航时，
   *   说明这次演示根本没有录到签到点击 —— 返回空路线，让调用方报「没录到签到动作」，
   *   而不是保存一份「点击个人资料」当成签到的流程；
   * - 命中签到关键词但链接指向别的页面（菜单里的「签到」导航项）同样不能当终点页动作：
   *   回放会先跳走，再被路线拉回来，变成往返。有明确成功/已完成证据的动作不受此限。
   */
  if (target && !evidenceTarget) {
    // 链接指向别的页面：回放会先跳走、再被路线拉回来，不能当终点动作。
    const hrefPage = target.href ? sameOriginPath(site, target.href) : undefined;
    if (hrefPage && pageKey(hrefPage) !== pageKey(target.path)) return [];
    // 既无签到关键词、又一看就是页面导航：这次演示根本没录到签到点击。
    if (!labelTarget && looksLikePageNavigation(site, target)) return [];
  }
  // 挑不出可用终点页（用户整遍都停在登录页）就没有路线可言，交给调用方退化。
  const targetPage = target ? actionPage(site, target) : undefined;
  if (!target || !targetPage) return [];

  // 事件按时间归并：动作之后的导航（例如跳转到结果页）不属于路线：路线必须终止在签到页。
  const marks: Array<{ at: number; page: string | undefined }> = [];
  for (const event of events) {
    if (event.type !== 'navigation' || event.at > target.at) continue;
    marks.push({ at: event.at, page: sameOriginPath(site, event.path) });
  }
  for (const action of candidates) {
    if (action.at > target.at) continue;
    marks.push({ at: action.at, page: actionPage(site, action) });
  }
  // 时间相同时导航排在动作前（插入顺序稳定），与「先跳页再做动作」的真实顺序一致。
  marks.sort((a, b) => a.at - b.at);
  for (const mark of marks) push(mark.page);

  // 签到页必须收尾：签到动作之前没上报过 navigation 时它不在路线里，这里补在末尾。
  if (timeline.at(-1) !== targetPage) timeline.push(targetPage);

  return trimRoute(timeline);
}

/**
 * 在 pathname 与 hash 路由（`#/x`）两处分别应用同一个判定，任一命中即真。
 *
 * hash 路由站点的所有页面 pathname 都是 `/`，资料页只体现在 hash 里；两条路都要看，
 * 否则 `/#/profile` 会被当成 `/`。解析失败时退回整串判定（与旧实现一致）。
 */
function pathOrHashMatches(path: string, matches: (candidate: string) => boolean): boolean {
  try {
    const url = new URL(path, 'https://placeholder.invalid');
    const hashPath = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
    return matches(url.pathname) || (hashPath.startsWith('/') && matches(hashPath));
  } catch {
    return matches(path);
  }
}

/**
 * 路径是否**以资料词收尾**（`/profile`、`/console/personal`、`/me`）。
 *
 * 用来区分强弱候选：`/user/dashboard`、`/account/overview` 只是中间夹了一段资料词，
 * 多半是仪表盘/概览，页面上并不显示当前账号。路线里更靠前的这类页面若抢走身份页，
 * 后面的真资料页（`/user/profile`）就永远轮不到 —— 同样是「每次签到都停机」。
 */
const PROFILE_LEAF = /(?:^|\/)(?:profile|personal|account|user|me)\/?$/i;

/**
 * 单个路径候选是否明确「看不到当前账号」（偏好 / 财务 / 安全 / 通知等）。
 *
 * 以资料词收尾的页面例外：`/settings/profile` 是先被排除词命中、最后落在资料页上的
 * 真实形态（GitHub 就是 `/settings/profile`），与 `/settings` 这种纯设置页不同。
 */
function isExcludedCandidate(candidate: string): boolean {
  return PROFILE_PATH_EXCLUDE.test(candidate) && !PROFILE_LEAF.test(candidate);
}

function isProfilePath(path: string): boolean {
  return pathOrHashMatches(path, (candidate) => PROFILE_PATH.test(candidate)
    && !isExcludedCandidate(candidate));
}

/**
 * 排除闸：任何来源（用户点过的链接、路线里的页面）都不该把「看不到账号」的页面当身份页。
 *
 * 链接分支曾经只看标签就取址，于是「账户信息」这类标签指向 `/account/settings` 的入口
 * 会把身份页钉到一个永远读不到账号的页面 —— 回放每次都在那里停机，而 identityPath
 * 没有修正入口，用户只能整段重学。
 */
function isExcludedAccountPath(path: string): boolean {
  return pathOrHashMatches(path, isExcludedCandidate);
}

/**
 * 从用户演示的个人资料入口、常见资料页路径，或签到终点页本身找出身份核验页。
 *
 * 站点形态差异很大，三种来源按可信度排序，都要能学出来：
 * 1. 用户点过的「个人资料 / 我的账户」入口 —— 那个链接地址最可信；
 * 2. 路线中签到终点**之前**出现过像资料页的地址（`/profile`、`/console/personal`…）；
 * 3. **签到页本身就是资料页**（卡片式签到站点把账号和签到按钮放在同一页）：
 *    这类站点没有"另一个页面"可访问，只能由签到终点页自己承担身份核验 ——
 *    回放时到页后先读当前账号，读不到就停机（引擎的身份闸门），绝不盲签。
 *
 * 偏好顺序不能反：有独立资料页时始终用它，兜底只在推断不出独立资料页时生效。
 */
function learnedIdentityPath(
  site: SiteConfig,
  actions: readonly LearningAction[],
  route: readonly string[],
): string | undefined {
  const checkinTarget = route.at(-1);
  if (!checkinTarget) return undefined;
  /**
   * 链接分支比路径分支宽松：站点自己的命名未必命中资料词（`/u/123`、`/myinfo`），
   * 用户点过「个人资料 / 账户信息」这笔点击比路径猜测更可信。
   *
   * 但一笔点击要能证明「存在一个能看账号的页面」，三件事必须成立：
   * 1. 地址不是被排除页 —— 标签命中不等于页面能显示账号（`/account/settings`）；
   * 2. 地址与点击所在页**不同** —— `<a href="#">个人资料</a>` 这类菜单锚点的 href
   *    会解析成当前页（甚至站点根），拿它当身份页就是把回放钉在看不出账号的页面上；
   * 3. **逐个候选往下看** —— 第一个命中标签的入口若是被排除页，不能挡住后面真正的资料入口。
   */
  const linkedPath = actions
    .filter((action) => action.kind === 'click' && PROFILE_LABEL.test(action.label ?? '') && !!action.href)
    .map((action) => ({ action, path: sameOriginPath(site, action.href ?? '') }))
    .find(({ action, path }) => !!path
      && path !== checkinTarget
      && path !== actionPage(site, action)
      && !isAuthPage(site, path)
      && !isExcludedAccountPath(path))?.path;
  if (linkedPath) return linkedPath;
  const profilePages = route.slice(0, -1)
    .filter((page) => isProfilePath(page) && !isAuthPage(site, page));
  // 强候选优先：以资料词收尾的页面（`/user/profile`）比中间夹一段资料词的业务页
  // （`/user/dashboard`）可信；后者更靠前，直接取第一个会把真资料页挤掉。
  const earlier = profilePages.find((page) => pathOrHashMatches(page, (candidate) => PROFILE_LEAF.test(candidate)))
    ?? profilePages[0];
  if (earlier) return earlier;
  // 兜底：签到终点页自己当身份核验页（与终点同址是合法形态，不再要求必须是另一个页面）。
  return isAuthPage(site, checkinTarget) ? undefined : checkinTarget;
}

/**
 * 身份页必须位于路线中（不晚于签到终点）；若导航事件漏报，也由安全推断的路径补入路线。
 *
 * 身份页与签到终点同址时它已经在路线里，**不能再插一次** —— 旧实现会把终点复制成
 * `[…, target, target]`，路线里出现连续的重复页。
 */
function withIdentityPath(route: string[], identityPath: string | undefined): string[] {
  if (!identityPath || route.length === 0) return route;
  if (route.includes(identityPath)) return route;

  const target = route.at(-1)!;
  const candidate = [...route.slice(0, -1), identityPath, target];
  if (candidate.length <= MAX_ROUTE_PAGES) return candidate;
  // 裁路线时保住身份页与签到目标两个语义锚点；普通页面从前段裁掉。
  return [
    ...candidate.slice(-MAX_ROUTE_PAGES, -2),
    identityPath,
    target,
  ];
}

/**
 * 裁到校验器允许的长度，且**必须保住最后一页**。
 *
 * 用户学习时可能顺路点开十几个页面才到签到页。route 若超长，`validateCheckinWorkflow`
 * 会在保存那一步直接拒掉 —— 用户认真演示完一遍，最后只得到一个「未通过校验」，
 * 而且不知道该怎么改。这里主动裁，并保留结尾：末页才是执行签到动作的目标页，
 * 丢掉它自动签到会停在半路。
 */
function trimRoute(route: string[]): string[] {
  if (route.length <= MAX_ROUTE_PAGES) return route;
  return [...route.slice(0, MAX_ROUTE_PAGES - 1), route[route.length - 1]!];
}

/** 连续同页的动作合成一段：同一页上的动作要在同一个「页面守卫」里执行。 */
function groupByPage(actions: LearningAction[]): LearningAction[][] {
  const groups: LearningAction[][] = [];
  for (const action of actions) {
    const current = groups.at(-1);
    if (current && pageKey(current[0]!.path) === pageKey(action.path)) current.push(action);
    else groups.push([action]);
  }
  return groups;
}

/**
 * 把动作编译成步骤：**顺序与录制完全一致**，每个动作紧跟它的变化检查。
 *
 * - 每个动作 → `click` / `fill`（fill 一律落成 `{{claimText}}`，绝不回放用户的输入值）；
 * - 动作带变化证据 → 紧跟一个 `optional` 的 `assert`，核对界面确实变成了当时的样子
 *   （「点了没事、其实没生效」的站点就靠它暴露）；没有证据就不硬塞断言；
 * - 动作发生在哪个页面，就用 `if (path)` 把它围起来：回放沿 route 走到该页时才执行，
 *   停在别的页面时不会去点一个不存在的控件；
 * - 录制时用户**先滚动页面**才够得着控件的话，这一步带 `scrollIntoView: true`：
 *   回放时先把目标滚进视口再点。它不是新步骤（步骤上限只有 30），也不写绝对像素
 *   （页面高度、字体、弹窗都会让像素对不上），因此页面布局变了也仍然可用。
 */
function compileSteps(actions: LearningAction[], route: string[], reservedSteps = RESERVED_STEPS): CheckinWorkflowStep[] {
  const targetPage = pageKey(route.at(-1) ?? actions.at(-1)?.path ?? '');
  /** 除了签到页以外的每个连续页面段都要一层页面守卫。 */
  const guardsOf = (list: LearningAction[]): number => list.length
    ? groupByPage(list).filter((group) => pageKey(group[0]!.path) !== targetPage).length
    : 0;

  let kept = actions;
  // 动作数量本身就超过额度时（用户录了几十次点击），只从**最前面**裁：
  // 真正决定成败的是最后一段 —— 签到页上的那串动作。
  while (kept.length > 0 && kept.length + guardsOf(kept) > MAX_WORKFLOW_STEPS - reservedSteps) {
    kept = kept.slice(1);
  }

  const groups = groupByPage(kept);
  const budget = MAX_WORKFLOW_STEPS - reservedSteps - kept.length - guardsOf(kept);
  // 变化检查的额度从后往前分配：越靠后的动作，它的界面变化越接近「这次到底成没成」。
  const checked = new Set<number>();
  for (let index = kept.length - 1; index >= 0 && checked.size < budget; index -= 1) {
    if (kept[index]!.afterText?.length) checked.add(index);
  }

  const steps: CheckinWorkflowStep[] = [];
  let cursor = 0;
  for (const group of groups) {
    const body: CheckinWorkflowStep[] = [];
    for (const action of group) {
      // 先滚再动：用户在录制时就是这样才够得着这个控件的。
      const scroll = actionScrollFields(action);
      if (action.kind === 'scroll') {
        // 纯滚动是真实的一步：保留最终落点比例与可选容器。
        body.push({ type: 'scroll', ratio: action.ratio ?? 0, ...(action.scrollContainer ? { container: action.scrollContainer } : {}) });
        cursor += 1;
        continue;
      }
      if (!action.selector) continue;
      /*
       * 历史产物可能带着 dragToSelector（旧采集器曾把拖拽尾巴录成一步）。
       * 这类步骤一律编译成 drag：即使新采集器不再产生它，读旧数据时也不能退化成
       * 「点击起点控件」——那正是把拖拽把手当按钮点的来源。
       */
      if (action.kind === 'drag') {
        // 拖拽步骤：起点/终点选择器 + 各自落点；真实轨迹由 realDrag 原语重建。
        if (!action.toSelector) continue;
        const dragScroll = actionScrollFields(action);
        body.push({
          type: 'drag',
          selector: action.selector,
          toSelector: action.toSelector,
          ...(action.anchor ? { anchor: action.anchor } : {}),
          ...(action.toAnchor ? { toAnchor: action.toAnchor } : {}),
          ...dragScroll,
        });
        cursor += 1;
        continue;
      }
      if (action.kind === 'click' && action.dragToSelector) {
        body.push({
          type: 'drag',
          selector: action.selector,
          ...(action.anchor ? { anchor: action.anchor } : {}),
          toSelector: action.dragToSelector,
          ...(action.dragToAnchor ? { toAnchor: action.dragToAnchor } : {}),
          ...(action.scrollContainer ? { scrollContainer: action.scrollContainer } : {}),
          ...(action.scrollBeforeY !== undefined || action.scrollPageTop ? { scrollIntoView: true } : {}),
        });
        cursor += 1;
        continue;
      }
      body.push(action.kind === 'fill'
        ? { type: 'fill', selector: action.selector, value: '{{claimText}}', ...scroll,
            ...(action.control ? { control: action.control } : {}),
            ...(action.choice !== undefined ? { choice: action.choice } : {}),
            ...(action.checked !== undefined ? { checked: action.checked } : {}),
            ...(action.fingerprint ? { fingerprint: action.fingerprint } : {}) }
        : { type: 'click', selector: action.selector, ...scroll,
            ...(action.anchor ? { anchor: action.anchor } : {}),
            ...(action.gesture ? { gesture: action.gesture } : {}),
            ...(action.key ? { key: action.key } : {}),
            ...(action.holdMs !== undefined ? { holdMs: action.holdMs } : {}),
            ...(action.fingerprint ? { fingerprint: action.fingerprint } : {}) });
      // 变化证据是「界面出现了什么」的可执行形态：断言可选，站点改文案也不会一票否决。
      if (checked.has(cursor) && action.afterText) {
        body.push({ type: 'assert', text: action.afterText, optional: true, timeoutMs: 5_000 });
      }
      cursor += 1;
    }
    // 动作发生在哪个页面，就把它围在那个页面的守卫里；签到页上的动作直接执行。
    if (group[0] && pageKey(group[0]!.path) !== targetPage) {
      steps.push({ type: 'if', condition: { type: 'path', pattern: pageKey(group[0]!.path) }, then: body });
    } else {
      steps.push(...body);
    }
  }
  return steps;
}

/**
 * 把一次手动操作转换为受限 workflow。
 *
 * 学习模式只负责找出「用户真实做了哪些动作」「每一步之后界面出现了什么」和
 * 「经过了哪些同源页面」；认证、可信点击、公告清理仍由现有通用执行器接管，
 * 不把录制出来的任意 DOM 事件直接回放。
 * 用户报过「没有学到真实的每一步」：这里**不丢任何非认证动作**，也不按标签关键词扫射，
 * 因此回放顺序与录制顺序逐项一致。导航由 `route` 承载，route 非空时 steps 里不放 navigate。
 */
/** 太短的名字（`ab`）在任意文案里都会撞上，不参与判定（与身份核对同一口径）。 */
const PERSONAL_TEXT_MIN_CHARS = 3;

/**
 * 「这段文字里有没有演示账号自己的名字」的判定器。
 *
 * 只认完整词边界（左右不能再接名字字符），大小写不敏感；邮箱额外按 `@` 前的
 * 本地部分再比一次（站点常只显示 `alice` 而不是 `alice@example.com`）。
 */
function personalTextMatcher(texts: readonly string[] | undefined): (value: string | undefined) => boolean {
  const needles = new Set<string>();
  for (const raw of texts ?? []) {
    const value = raw?.trim().toLowerCase();
    if (!value) continue;
    if (value.length >= PERSONAL_TEXT_MIN_CHARS) needles.add(value);
    const at = value.indexOf('@');
    if (at >= PERSONAL_TEXT_MIN_CHARS) needles.add(value.slice(0, at));
  }
  if (needles.size === 0) return () => false;
  const nameChar = /[\p{L}\p{N}._+@-]/u;
  return (value) => {
    const haystack = value?.toLowerCase();
    if (!haystack) return false;
    for (const needle of needles) {
      for (let from = haystack.indexOf(needle); from >= 0; from = haystack.indexOf(needle, from + 1)) {
        const before = haystack[from - 1];
        const after = haystack[from + needle.length];
        if ((!before || !nameChar.test(before)) && (!after || !nameChar.test(after))) return true;
      }
    }
    return false;
  };
}

/**
 * 保存前再清一遍**只属于演示账号**的文字（采集侧之外的第二道）。
 *
 * 流程属于站点、站内所有账号共用。采集侧已经不再用名字当选择器（见
 * `learningSelector` 的 `isPersonal`）；这里兜的是升级前开始的会话、以及指纹与
 * 「点击后界面出现了什么」里顺带录到的名字：
 * - 指纹里含名字的 `text` / `aria` 删掉（少一个字段只会让核验更宽，不会点错别的）；
 * - afterText 里含名字的片段不落盘（它只编成可选断言）。
 *
 * **绝不删步骤、绝不改选择器**：头像菜单常是下拉的开关，删了它，下一步「个人资料」
 * 就点不到了；连演示账号自己的回放也会坏。别的账号点不到名字时，由回放侧按学习
 * 路线直接进下一页兜底（见 workflow.ts 的中间页处理）。
 * 签到动作本身（有成功证据、或文案是签到词）一个字都不碰：用户名恰好是常见词
 * （`daily`）时，不能把「Daily Check-in」当成名字清掉。
 */
function withoutPersonalText(
  action: LearningAction,
  isPersonal: (value: string | undefined) => boolean,
): LearningAction {
  if (action.kind === 'scroll') return action;
  if (action.evidence || CHECKIN_LABEL.test(action.label ?? '')) return action;
  const next: LearningAction = { ...action };
  if (next.afterText) {
    const kept = next.afterText.filter((line) => !isPersonal(line));
    if (kept.length) next.afterText = kept;
    else delete next.afterText;
  }
  if (next.fingerprint) {
    const fingerprint = { ...next.fingerprint };
    if (isPersonal(fingerprint.text)) delete fingerprint.text;
    if (isPersonal(fingerprint.aria)) delete fingerprint.aria;
    if (Object.keys(fingerprint).some((key) => key !== 'tag')) next.fingerprint = fingerprint;
    else delete next.fingerprint;
  }
  return next;
}

export function buildLearnedWorkflow(
  site: SiteConfig,
  events: readonly WorkflowLearningEvent[],
  options: { personalTexts?: readonly string[] } = {},
): { workflow: CheckinWorkflowConfig; eventCount: number } | null {
  /**
   * 只编译**最后一次退出登录之后**的事件。
   *
   * 同站多账号时用户常要先退出别的账号、再用本账号登录后演示签到。退出之前录到的
   * 页面与点击属于另一个会话（甚至另一个账号），并进路线会让回放先去走一段与
   * 本账号无关的路，证据判定那边（learning-stage）也早已把它们作废。
   */
  const lastLogout = events.reduce((latest, event, index) => (isLogoutLearningEvent(event) ? index : latest), -1);
  const list = lastLogout >= 0 ? events.slice(lastLogout + 1) : [...events];
  // 学习只接管登录后的签到。仅过滤“登录”按钮标签会漏掉用户名框、
  // “继续”按钮等认证页动作，导致回放时拿领取文本去填登录表单。
  const personal = personalTextMatcher(options.personalTexts);
  const actions = actionSteps(list).filter((action) => {
    const page = actionPage(site, action);
    return !!page && !isAuthPage(site, page);
  }).map((action) => withoutPersonalText(action, personal));
  if (actions.length === 0) return null;

  const route = learnedRoute(site, list, actions);
  const identityPath = learnedIdentityPath(site, actions, route);
  const routeWithIdentity = withIdentityPath(route, identityPath);
  const lottery = actions.some((action) => LEARNING_LOTTERY_ACTION.test(action.label ?? ''));
  // 抽奖额外占 3 步：已完成前置分支及其断言、异步结果等待。
  const steps = compileSteps(actions, routeWithIdentity, RESERVED_STEPS + (lottery ? 3 : 0));

  const evidence = [...actions].reverse().find((action) => action.evidence)?.evidence;
  // 抽奖页的「今日已抽 / Draw completed」可能只是接口加载占位，不能作为结果。
  const successWords = lottery
    ? LOTTERY_SUCCESS_WORDS
    : evidence?.kind === 'success' ? evidence.words : SUCCESS_WORDS;
  const alreadyWords = lottery
    ? LOTTERY_ALREADY_WORDS
    : evidence?.kind === 'already' ? evidence.words : ALREADY_WORDS;
  if (lottery) {
    // 先等异步开奖，再选终态分支；不能在动画结束前就进入「已完成」断言。
    steps.push({ type: 'assert', text: [...successWords, ...alreadyWords], timeoutMs: 15_000 });
    steps.unshift({
      type: 'if',
      condition: { type: 'text', words: LOTTERY_ALREADY_WORDS },
      then: [{ type: 'assert', text: LOTTERY_ALREADY_WORDS, result: 'already' }],
    });
  }
  /*
   * 终局分支的优先级与 workflow-outcome.ts 完全一致：**先判成功、再判已签到**。
   *
   * 签到完成后页面往往同时出现「签到成功」提示和「今日已签到」按钮；先判 already
   * 会把本轮真实签到降级成「之前就签过了」，奖励归因就错了。两边必须保持一致，
   * 任何一侧改动都要同步另一侧。
   *
   * 空词表语义沿用回放侧既有实现（workflow.ts 的 textMatches）：`words` 为空时条件
   * 恒假，因此走 else 分支；对应分支里的 assert 也会因为无可断言文本而失败。
   */
  steps.push({
    type: 'if',
    condition: { type: 'text', words: successWords },
    then: [{ type: 'assert', text: successWords, result: 'success', timeoutMs: 5_000 }],
    // 抽奖动作已真实派发后才出现的结束通知属于本轮完成；进入页面就已结束由前置分支处理。
    else: [{ type: 'assert', text: alreadyWords, result: lottery ? 'success' : 'already', timeoutMs: 5_000 }],
  });

  return {
    workflow: routeWithIdentity.length
      ? { steps, route: routeWithIdentity, ...(identityPath ? { identityPath } : {}) }
      : { steps },
    eventCount: events.length,
  };
}

/**
 * 一次学习的**两份产物**：站点级登录配置与站点级签到流程。
 *
 * 两个编译器读的是**同一份事件流**，各自只挑自己的语义：
 * - 登录编译器看 \`fieldRole\` / \`loginAction\`（融合采集始终标注）；
 * - 签到编译器看登录之后的真实动作，并过滤掉认证页与凭据动作。
 *
 * 因此「只完成一半」是**如实反映**，不是错误：
 * - 只演示了登录 → \`login\` 有、\`checkin\` 为 null；
 * - 只演示了签到（本来就在登录态） → \`checkin\` 有、\`login\` 为 null。
 *
 * 调用方必须据此**部分保存**并明确告诉用户缺的是哪一半，绝不因为缺一半而整场丢弃，
 * 也绝不拿半份证据拼出一份看似完整、回放却跑不通的配置。
 */
/**
 * 学习产出的「签到那一半」有两种形态：
 *
 * - `workflow`：普通站点 —— 录到真实签到动作，编译成可回放的流程；
 * - `login-as-checkin`：登录即签到站点（如 AnyRouter）—— 页面上没有签到按钮，
 *   登录成功即算签到。它没有步骤可回放，落盘方式是站点级 `checkin.method = 'none'`
 *   （引擎里「登录即签到」的一等语义），因此和 workflow 明确区分，绝不互相冒充。
 */
export type LearnedCheckinArtifact =
  | { kind: 'workflow'; workflow: CheckinWorkflowConfig }
  | { kind: 'login-as-checkin' };

export interface LearnedArtifacts {
  login: LearnedLoginSettings | null;
  checkin: LearnedCheckinArtifact | null;
  /** 本次演示录到的事件总数（两份产物共用同一条时间线）。 */
  eventCount: number;
  /** 只含固定文案的「缺了什么 / 为什么没保存」提示，可直接给用户看。 */
  notices: string[];
}

export interface LearnedArtifactOptions {
  /**
   * 用户明确声明「本站是登录即签到」。
   *
   * 只有演示满足保守判据（进过站内业务页、没点退出登录、也没录到签到动作，
   * 见 `canSaveLoginAsCheckin`）时才产出 `login-as-checkin` 产物；
   * 否则照常编译普通流程，并附一条固定文案说明。
   */
  loginAsCheckin?: boolean;
  /**
   * 演示账号自己的名字（登录名、站点用户名、邮箱、显示名）。
   *
   * 流程属于站点、站内所有账号共用；演示时点的「alice ▾」头像菜单若原样写进
   * 选择器或指纹，别的账号回放时页面上印的是自己的名字，这一步必然找不到。
   * 编译时据此把这类文字从步骤里剥掉（见 `withoutPersonalText`）。
   */
  personalTexts?: readonly string[];
}

/** 一次学习的意图：产出哪几份产物。 */
export type LearningArtifactIntent = 'login' | 'checkin' | 'both';

/**
 * 按融合学习生成两份产物。
 *
 * \`intent === 'login'\` 时只产出登录配置（旧「学习登录」入口的语义原样保留）；
 * \`'checkin'\` 与 \`'both'\` 都产出两份（\`'checkin'\` 是旧调用方的取值，
 * 融合后它同样能得到登录配置 —— 这正是「一次学习同时学会登录与签到」的落点）。
 */
export function buildLearnedArtifacts(
  site: SiteConfig,
  events: readonly WorkflowLearningEvent[],
  intent: LearningArtifactIntent = 'both',
  options: LearnedArtifactOptions = {},
): LearnedArtifacts {
  const eventCount = events.length;
  // 登录配置三类意图都要产出：签到/融合学习同样会标注并编译凭据语义。
  const login = buildLearnedLoginSettings(site, events);
  /**
   * 用户点了「登录即签到」才考虑这份产物；且必须过保守判据 ——
   * 没点到按钮和站点没有按钮在事件里长得一样，只有「登录已生效、没点退出、
   * 也没录到任何签到动作」时才把它当作一条合法出路（判定见 learning-stage.ts）。
   */
  const wantsLoginAsCheckin = intent !== 'login' && options.loginAsCheckin === true;
  const loginAsCheckin = wantsLoginAsCheckin
    && canSaveLoginAsCheckin(events, intent === 'checkin' ? 'checkin' : 'both');
  /**
   * 即使没点「登录即签到」，也先算一次同一份保守判据：用于在「登录已生效、
   * 只是没录到签到动作」时把用户引到那条显式出口 —— 站点把奖励挂在登录成功
   * 上时，页面上根本没有按钮可点，让他「在按钮可点时重新演示」是死路。
   */
  const loginAsCheckinPossible = intent !== 'login'
    && canSaveLoginAsCheckin(events, intent === 'checkin' ? 'checkin' : 'both');
  let checkin: LearnedCheckinArtifact | null = null;
  if (intent !== 'login') {
    if (loginAsCheckin) {
      checkin = { kind: 'login-as-checkin' };
    } else {
      const workflow = buildLearnedWorkflow(site, events, { personalTexts: options.personalTexts })?.workflow ?? null;
      /**
       * 没有身份核验页的 workflow 只是「录到了一些页面动作」，还不是一份
       * 可保存的签到流程：保存侧会以「没有点到真正的签到按钮」拒绝它。
       * 不把它算作 checkin 产物，下面的 notices 才能走「没录到签到」分支，
       * 把「登录即签到」这条真实出路给到用户。
       */
      if (workflow?.identityPath) checkin = { kind: 'workflow', workflow };
    }
  }

  /**
   * 「这次演示录到了什么」的**唯一事实源**：两份产物各自编译出了没有。
   *
   * 之所以要把它单独拎出来：用户点「开始学习」后**什么都没来得及做**就点
   * 「结束学习」时，两份产物都是 null，而旧提示是按「缺了哪一半」拼的 ——
   * 它会说「没有录到完整的登录动作……这次只保存签到流程」，可签到流程同样
   * 没录到，那句话自相矛盾；更糟的是接着会拿一份**空的**登录补丁去写站点
   * 配置，站点校验器抛出「缺少用户名输入框选择器」，用户看到的是一句与他
   * 自己做了什么毫无关系的实现细节。
   *
   * 因此把三种情形分开，一句话只描述这次演示的**观测结果**：
   * - 一份都没有 → 空演示，明确告诉用户「还没开始演示、会话保留着，请继续」；
   * - 只有一份 → 如实说存了哪一半、缺的另一半怎么补；
   * - 两份都有 → 不提示。
   */
  const notices: string[] = [];
  if (intent === 'login') {
    // 旧「学习登录」入口：只可能产出登录配置，不拿「没录到签到」去烦他。
    if (!login) notices.push('还没有录到完整的登录动作；请手动完成登录后再结束学习');
  } else if (!login && !checkin) {
    /**
     * 空演示。这句文案必须满足两件事：
     * 1. 说清真实状态（本次演示没有录到任何登录或签到动作）；
     * 2. 给出可执行的下一步（在原页面上继续演示，**不必重新点开始**）。
     * 调用方据此在保存前拦下来，绝不把空补丁交给站点校验器。
     */
    notices.push(loginAsCheckinPossible
      ? '这次演示还没有录到任何登录或签到动作。若本站是「登录即签到」（登录成功后自动完成、页面上没有签到按钮），在账号行点「登录即签到」即可保存完整流程；否则请继续在原页面演示：完成一遍登录并点到签到按钮，再点「结束学习」；本次学习还在继续，不需要重新开始'
      : '这次演示还没有录到任何登录或签到动作。请先在打开的站点页面里完成一遍登录、并点到签到按钮，再点「结束学习」；本次学习还在继续，不需要重新开始');
  } else if (!login) {
    notices.push('没有录到完整的登录动作（账号/密码字段或第三方登录入口），这次只保存签到流程');
  } else if (!checkin) {
    notices.push(loginAsCheckinPossible
      ? '没有录到签到动作：若本站是「登录即签到」（登录成功后自动完成、页面上没有签到按钮），在账号行点「登录即签到」即可保存完整流程；否则请在签到按钮可点时重新演示一次'
      : '没有录到登录之后的签到动作，这次只保存登录配置；请在按钮可点时重新演示一次签到');
  }
  if (wantsLoginAsCheckin && !loginAsCheckin) {
    notices.push('这次演示还不满足「登录即签到」的保存条件（需要先登录成功进入站内页面，且没有点到签到按钮），已按普通签到流程处理');
  }

  return { login, checkin, eventCount, notices };
}

/**
 * 学习时「确实没有签到按钮」是否足以自动按「登录即签到」保存？
 *
 * 用户诉求：本站是登录即签到（登录成功即算完成、页面上没有签到按钮）时，不该逼
 * 用户先去点一次「登录即签到」按钮才肯保存 —— 学习过程本身就带着这个证据。
 *
 * 三条同时成立才算证据充分：
 * 1. `canSaveLoginAsCheckin` 的保守判据：进过站内业务页（登录已生效）、没点过退出、
 *    也没录到任何签到动作。少任何一条都说明这次演示不足以说明站点的签到形态；
 * 2. `checkinControlSeen === false`：结束学习那一刻，页面上确实**没有**可见可点的
 *    签到控件（由 content 侧按共享词表扫描后只回传布尔）。若为 true，说明页面上
 *    就摆着按钮，用户只是**忘了点** —— 这种情况绝不能替他断言「本站不需要点」，
 *    否则会保存一条永不点击的流程，用户下次自动签到只会看到假成功；
 * 3. 页面限定：最后一个带 path 的事件必须停在能代表签到形态的页面（资料页或已知
 *    业务页）。用户可能停在学习中途打开的帮助页/设置页，那些页面本来就没有签到
 *    控件 —— 用「那里没有按钮」推断「本站是登录即签到」是错的。
 *
 * 纯函数、只看事件与一个布尔，便于把上述三条逐条锁进测试。
 */
export function shouldAutoSaveLoginAsCheckin(
  events: readonly WorkflowLearningEvent[],
  kind: LearningKind,
  checkinControlSeen: boolean | undefined,
): boolean {
  if (checkinControlSeen !== false) return false;
  const analysis = analyzeLearningEvents(events, kind);
  if (!analysis.loginAsCheckinAvailable) return false;

  const lastPath = [...events].reverse().map(eventPath).find((path) => !!path);
  if (!lastPath) return false;
  /**
   * 登录后落在根路径/首页/工作台这类通用落地页时同样可以自动保存。
   *
   * 这些路径本身是歧义的：`/` 既可能是登录表单所在的页面，也可能是登录后的
   * 仪表盘。因此要求两条额外证据同时成立：
   * 1. 本次演示**确实发起了登录**（`analysis.login`：提交/OAuth/Enter，且录到凭据）；
   * 2. 结束页面不是登录表单所在的页面 —— 登录失败被弹回原页时，最后路径
   *    与录入凭据的页面相同，不能据此断言「本站登录即签到」。
   *
   * `/help`、`/settings` 这类页面仍然不放行：它们本来就没有签到控件，
   * 「那里没有按钮」推不出「本站没有按钮」。
   */
  let lastCredentialPath: string | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== 'fill') continue;
    const path = eventPath(event);
    if (!path) continue;
    if (event.fieldRole !== undefined || (event.hasValue && isAuthLearningPath(path))) {
      lastCredentialPath = path;
      break;
    }
  }
  const loginLanding = analysis.login
    && isLoginLandingPath(lastPath)
    && lastPath !== lastCredentialPath;
  return isProfileLearningPath(lastPath) || isKnownBusinessLearningPath(lastPath) || loginLanding;
}

export interface LoginAsCheckinChoiceInput {
  intent: LearningArtifactIntent;
  /** 用户这次是否已经明确选了「登录即签到」。 */
  loginAsCheckinRequested: boolean;
  /** 编译出的两份产物。 */
  artifacts: Pick<LearnedArtifacts, 'login' | 'checkin'>;
  /** 演示满足「登录即签到」保守判据（`canSaveLoginAsCheckin`）。 */
  loginAsCheckinPossible: boolean;
  /** 这次学习会话里是否已经问过一次。 */
  alreadyPrompted: boolean;
}

/**
 * 结束学习时，是否要先停下来让用户在「登录即签到 / 补演签到」之间做选择。
 *
 * 不问的后果：自动判定没有命中（站点已有模板签到方式、或页面上能看到签到字样）
 * 时，这次演示只会保存登录配置并**结束会话** —— 签到仍按旧方式执行，而界面上
 * 「登录即签到」按钮只在会话进行中出现，随会话一起消失。用户想把这站改成登录
 * 即签到，只能从头再学一遍；看起来就是「学完了还在走旧流程」。
 *
 * 只问一次：用户看过提示后再点「结束学习」，说明他确实只想保存登录配置。
 */
export function needsLoginAsCheckinChoice(input: LoginAsCheckinChoiceInput): boolean {
  return input.intent !== 'login'
    && !input.loginAsCheckinRequested
    && !input.alreadyPrompted
    && input.loginAsCheckinPossible
    && !!input.artifacts.login
    && !input.artifacts.checkin;
}

/** 提示文案：说清两条出路；会话保留，不需要重新开始。 */
export const LOGIN_AS_CHECKIN_CHOICE_MESSAGE = '这次演示登录成功了，但没有录到签到动作。'
  + '若本站登录成功就算签到（页面上没有签到按钮），请点账号行的「登录即签到（没有签到按钮）」保存；'
  + '若本站有签到按钮，请在原页面点一次签到后再点「结束学习」。'
  + '本次学习还在继续；确认只保存登录配置的话，再点一次「结束学习」';

export interface CheckinEvidenceChoiceInput {
  intent: LearningArtifactIntent;
  artifacts: Pick<LearnedArtifacts, 'checkin'>;
  /** 演示里录到的签到证据强度（`analyzeLearningEvents(...).checkin`）。 */
  checkinEvidence: CheckinEvidenceLevel;
  alreadyPrompted: boolean;
}

/**
 * 编译出了回放流程，却没有任何签到证据（没点到签到/领取类按钮，也没出现签到结果）。
 *
 * `buildLearnedWorkflow` 会把登录页之外的每个动作都编进流程：开始学习时已登录、
 * 只点了菜单或导航的演示，也能得到一份带身份页的 workflow。直接按 method:'workflow'
 * 启用，它会顶替原来的签到方式，每天回放几下与签到无关的点击 —— 登录即签到站点
 * 最容易落进这里（页面上本来就没有按钮可点）。
 *
 * 不直接拒绝：按钮文案不在词表里的站点同样没有证据，那是真实的签到流程。
 * 先问一次，用户确认后照旧保存。
 */
export function needsCheckinEvidenceChoice(input: CheckinEvidenceChoiceInput): boolean {
  return input.intent !== 'login'
    && !input.alreadyPrompted
    && input.artifacts.checkin?.kind === 'workflow'
    && input.checkinEvidence === 'none';
}

export const CHECKIN_EVIDENCE_CHOICE_MESSAGE = '这次演示没有录到签到动作（没有点到签到/领取按钮），保存后自动签到会回放刚才的点击，可能并不会签到。'
  + '若本站登录成功就算签到：请先放弃本次学习，在站点上退出登录后重新开始学习并完成一次登录；'
  + '若刚才点的就是签到按钮（文案比较特别），再点一次「结束学习」即按回放流程保存';
export interface LearnedLoginSettings {
  loginMethod?: 'form' | 'oauth';
  loginUrl?: string;
  selectors?: Partial<SiteSelectors>;
  preLoginClickSelector?: string;
  preLoginClickSelectors?: string[];
  oauthButtonSelector?: string;
}

/**
 * 从通用登录演示提取现有登录引擎能安全回放的配置。
 *
 * 只保存选择器和有限动作角色；账号/密码值、OTP、页面文本和任意脚本都不进入配置。
 * 标准表单之后交给既有 form 登录器，它继续负责账号凭据、提交、验证和登录态确认。
 */
export function buildLearnedLoginSettings(
  site: SiteConfig,
  events: readonly WorkflowLearningEvent[],
): LearnedLoginSettings | null {
  const validSelector = (selector: string): string | undefined => {
    const value = selector.trim();
    if (value.length === 0 || value.length > 300) return undefined;
    // 自动生成 id 在采集侧就不会被选出来；这里再拒一次，兜住旧会话与伪造事件。
    if (hasUnstableIdSelector(value)) return undefined;
    return value;
  };
  const sameSiteEvent = (event: WorkflowLearningEvent): boolean => !!sameOriginPath(site, event.path);
  const latestField = (role: 'username' | 'password') => [...events].reverse().find((event) => (
    event.type === 'fill' && event.fieldRole === role && sameSiteEvent(event)
  ));
  const username = latestField('username');
  const password = latestField('password');
  const result: LearnedLoginSettings = {};

  const rememberLoginPage = (path: string): void => {
    const page = sameOriginPath(site, path);
    if (!page) return;
    const url = new URL(page, site.loginUrl).href;
    if (url !== new URL(site.loginUrl).href) result.loginUrl = url;
    else delete result.loginUrl;
  };

  // 多次展开属于同一条登录流程，不能只记最后一次而丢掉它的前置条件。
  const entrySequenceBefore = (at: number, path: string): string[] => {
    const sequence: string[] = [];
    const actions = new Map<string, Extract<WorkflowLearningEvent, { type: 'click' | 'fill' }>>();
    for (const event of events) {
      if (event.type !== 'click' && event.type !== 'fill') continue;
      const key = JSON.stringify([event.type, event.at, event.path, event.selector]);
      const previous = actions.get(key);
      // 点击先上报动作、后补报界面变化，补报没有角色；保留原动作的登录语义。
      actions.set(key, { ...previous, ...event });
    }
    for (const event of [...actions.values()].sort((a, b) => a.at - b.at)) {
      if (event.at >= at) break;
      if (pageKey(event.path) !== pageKey(path) || !sameSiteEvent(event)) {
        sequence.length = 0;
        continue;
      }
      if (event.type !== 'click' || event.loginAction !== 'entry') {
        sequence.length = 0;
        continue;
      }
      const selector = validSelector(event.selector);
      if (selector && (!event.href || !!sameOriginPath(site, event.href))) sequence.push(selector);
    }
    return sequence;
  };

  /**
   * 学到的入口点击。
   *
   * 优先「与目标动作同页、就在它之前」的那一下 —— 用户在同一页上先点了某个控件、
   * 目标控件才出现（展开账密表单 / 切到第三方登录区）。跨页导航的入口点击只在
   * 没有同页候选时兜底：回放起点本来就是 `loginUrl`，导航交给现成的登录链接逻辑。
   */
  const entryBefore = (before: number, samePage?: string): WorkflowLearningEvent | undefined => {
    const candidates = events.filter((event) => (
      event.type === 'click'
      && event.loginAction === 'entry'
      && event.at < before
      && sameSiteEvent(event)
      && (!event.href || !!sameOriginPath(site, event.href))
    ));
    if (samePage !== undefined) {
      const onSamePage = [...candidates].reverse().find((event) => pageKey(event.path) === samePage);
      if (onSamePage) return onSamePage;
    }
    return candidates[0];
  };

  if (username?.type === 'fill' && password?.type === 'fill' && username.hasValue && password.hasValue) {
    const usernameSelector = validSelector(username.selector);
    const passwordSelector = validSelector(password.selector);
    if (usernameSelector && passwordSelector) {
      result.loginMethod = 'form';
      rememberLoginPage(username.path);
      const finalSubmit = [...events].reverse().find((event) => (
        event.type === 'click'
        && event.loginAction === 'submit'
        && event.at >= password.at
        && sameSiteEvent(event)
        && (!event.href || !!sameOriginPath(site, event.href))
      ));
      const submitSelector = finalSubmit?.type === 'click'
        ? validSelector(finalSubmit.selector)
        : undefined;
      result.selectors = {
        username: usernameSelector,
        password: passwordSelector,
        ...(submitSelector ? { submit: submitSelector } : {}),
      };

      const firstCredentialAt = Math.min(username.at, password.at);
      const entry = entryBefore(firstCredentialAt, pageKey(username.path));
      if (entry?.type === 'click') {
        const selector = validSelector(entry.selector);
        if (selector) result.preLoginClickSelector = selector;
      }
      const sequence = entrySequenceBefore(firstCredentialAt, username.path);
      if (sequence.length > 1) result.preLoginClickSelectors = sequence;
    }
  }

  const oauth = [...events].reverse().find((event) => (
    event.type === 'click' && event.loginAction === 'oauth' && sameSiteEvent(event)
  ));
  if (oauth?.type === 'click') {
    const selector = validSelector(oauth.selector);
    if (selector) {
      result.loginMethod = 'oauth';
      rememberLoginPage(oauth.path);
      result.oauthButtonSelector = selector;
      delete result.preLoginClickSelectors;
      /**
       * OAuth 的入口前置点击只认**直接通向 OAuth 按钮**的那一下：
       * - 同页：跨页导航由 revealExternalLogin 的同源登录链接逻辑负责；
       * - 之间没有任何凭据输入：中间还填过账号/密码的入口点击是表单动作，
       *   不能拿来当 OAuth 入口 —— 回放时点它可能反而把第三方登录区藏起来
       *   （这正是「OAuth 入口被旧表单 selector 干扰」）。
       */
      const entry = [...events].reverse().find((event) => (
        event.type === 'click'
        && event.loginAction === 'entry'
        && event.at < oauth.at
        && sameSiteEvent(event)
        && pageKey(event.path) === pageKey(oauth.path)
        && (!event.href || !!sameOriginPath(site, event.href))
        && !events.some((other) => (
          other.type === 'fill' && other.at > event.at && other.at < oauth.at
        ))
      ));
      const evidenced = entry?.type === 'click' ? validSelector(entry.selector) : undefined;
      if (evidenced) result.preLoginClickSelector = evidenced;
      else delete result.preLoginClickSelector;
      const sequence = entrySequenceBefore(oauth.at, oauth.path);
      if (sequence.length > 1) result.preLoginClickSelectors = sequence;
    }
  }

  return Object.keys(result).length ? result : null;
}

/** 页面端使用的有限证据提取，不返回完整页面文本。 */
export function evidenceFromText(text: string, lottery = false): { kind: 'success' | 'already'; words: string[] } | undefined {
  const already = uniqueWords(text, lottery ? LOTTERY_ALREADY_WORDS : ALREADY_WORDS);
  if (already.length) return { kind: 'already', words: already.slice(0, 4) };
  const success = uniqueWords(text, lottery ? LOTTERY_SUCCESS_WORDS : SUCCESS_WORDS);
  if (success.length) return { kind: 'success', words: success.slice(0, 4) };
  return undefined;
}

/* ------------------------------------------------------------------ *
 * 学习会话的生命周期：有界过期与事件累积上限
 * ------------------------------------------------------------------ */

/**
 * 学习会话的有界存活时间。
 *
 * 用户点开学习后又去干别的事、忘了点「结束学习」，会话就会一直留在 `storage.session`：
 * 该 tab 此后所有点击/输入都被记进一次早已放弃的录制，管理页也永远显示「正在学习」。
 * 30 分钟足够覆盖一次手动签到（含登录、二次验证、慢慢找按钮），又不会让废弃会话过夜。
 */
export const LEARNING_TTL_MS = 30 * 60_000;
/** 单个会话最多记录的事件数，防止长时间录制把 session storage 撑爆。 */
export const LEARNING_EVENT_LIMIT = 100;

/** 会话是否已过期。`now` 可注入，便于测试。 */
export function isLearningSessionExpired(
  learning: Pick<WorkflowLearningSession, 'createdAt'>,
  now = Date.now(),
): boolean {
  return !Number.isFinite(learning.createdAt) || now - learning.createdAt > LEARNING_TTL_MS;
}

export interface LearningSessionPartition {
  /** 仍在录制中的会话。 */
  active: WorkflowLearningSession[];
  /** 已过期、应当清理的会话。 */
  expired: WorkflowLearningSession[];
}

/**
 * 同一站点同时只能有一条学习会话。
 *
 * 学习结果是站点级唯一事实：若同站账号 B 在账号 A 演示期间再开一条录制，
 * A 结束时保存 A 看到（且可能已被 B 登录态污染）的步骤，B 再结束时又覆盖一次。
 * 两次学习都“成功”，但最终回放的流程与用户实际演示的哪一次都可能不同。
 *
 * 只拦同站、异账号；同账号的继续/结束学习不算冲突。
 *
 * **融合学习之后不再按 kind 区分**：一次演示同时产出登录配置与签到流程，两者都是
 * 站点级唯一事实。若还按 kind 放行，A 账号在演示登录时 B 账号可以同时演示签到，
 * 两条录制互相污染登录态，最终保存的配置与谁演示的都对不上。
 * \`kind\` 参数保留在签名里只为向后兼容旧调用方，判定不再读它。
 */
export function findConflictingLearningSession(
  sessions: readonly WorkflowLearningSession[],
  request: { accountId: string; siteId: string; kind?: LearningKind },
): WorkflowLearningSession | null {
  return sessions.find((session) => (
    session.accountId !== request.accountId
    && session.siteId === request.siteId
  )) ?? null;
}
/**
 * 把「是否允许开工」与「冲突是谁」放在同一个决策里。
 *
 * background 的 TOGGLE_LEARNING 目前由 networkLocked 串行，但这个纯函数是
 * 站点级唯一性的最后一道可测契约：调用方无论从哪个入口都不能先读后写绕过它。
 */
export type LearningStartDecision =
  | { allowed: true }
  | { allowed: false; conflict: WorkflowLearningSession };

export function decideLearningStart(
  sessions: readonly WorkflowLearningSession[],
  request: { accountId: string; siteId: string; kind?: LearningKind },
): LearningStartDecision {
  const conflict = findConflictingLearningSession(sessions, request);
  return conflict ? { allowed: false, conflict } : { allowed: true };
}
/**
 * 把 storage 里的 `learn:*` 条目按是否过期分开。
 *
 * 纯函数 + 可注入 `now`：过期判定是「忘了点结束就永远在录」这个 bug 的修复点，
 * 必须在单测里可验证，而不是只能靠人等到 30 分钟后手动观察。
 */
export function partitionLearningSessions(
  entries: Iterable<[string, unknown]>,
  now = Date.now(),
): LearningSessionPartition {
  const active: WorkflowLearningSession[] = [];
  const expired: WorkflowLearningSession[] = [];
  for (const [key, value] of entries) {
    if (!key.startsWith('learn:') || !value || typeof value !== 'object') continue;
    const candidate = value as Partial<WorkflowLearningSession>;
    if (typeof candidate.runId !== 'string' || typeof candidate.accountId !== 'string') continue;
    if (!Number.isFinite(candidate.createdAt)) continue;
    const tabId = typeof candidate.tabId === 'number'
      ? candidate.tabId
      : Number(key.slice('learn:'.length));
    const learning = { ...candidate, tabId } as WorkflowLearningSession;
    (isLearningSessionExpired(learning, now) ? expired : active).push(learning);
  }
  return { active, expired };
}

export type LearningAppendResult =
  | { ok: true; learning: WorkflowLearningSession }
  | { ok: false; error: string; expired: boolean };

/**
 * 核对学到的流程是否**完整**落盘。
 *
 * 只比 `steps.length` 会漏掉最致命的一种情况：route 没写进去（或整个 workflow 被覆盖成
 * 只有 steps）时长度依然相等，于是扩展照样回「已保存」，而用户下次自动签到再也找不到
 * 签到页 —— 这正是这个功能最不能出的错。因此 method、步骤数、路线逐项都要核对。
 * 学习产出的 route 已经过 `trimRoute` 截断，这里**不再截断**，只做逐项相等比较。
 */
/** Chrome storage 不保证对象键的插入顺序；只比较字段值与数组顺序。 */
function canonicalLearningJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
  });
}

/**
 * 核对「登录即签到」是否**完整**落盘。
 *
 * 只认 `method === 'none'`：那是引擎里「登录即签到」的显式语义（只有站点明确写了
 * none 才宣称登录即签到，见 automation/checkin/checkin.ts）。写回的是别的值却回报
 * 「已保存」，用户下次自动签到就会去别处找根本不存在的签到按钮。
 */
export function verifyLearnedLoginAsCheckinStored(
  readBack: {
    method?: string;
    workflow?: unknown;
    entry?: unknown;
    url?: unknown;
    buttonSelector?: unknown;
    alreadySelector?: unknown;
    successSelector?: unknown;
    claimConfirmSelector?: unknown;
    apiUrl?: unknown;
    logoutApiUrl?: unknown;
    claimEntrySelector?: unknown;
    claimInputSelector?: unknown;
    claimSubmitSelector?: unknown;
  } | undefined,
): { ok: true } | { ok: false; error: string } {
  if (readBack?.method !== 'none') {
    return {
      ok: false,
      error: '学到的「登录即签到」没有写入站点配置（签到方式未生效），旧配置未改动，请重试',
    };
  }
  // 「登录即签到」允许携带学习路线（workflow.route + identityPath，steps 必须为空）：
  // OAuth 类站点登录后常停在身份不暴露的落地页，路线是运行时按资料页核对账号的
  // 唯一依据；没有它，「登录即签到」在运行时退化成「登录后什么都不核对」。
  // steps 非空意味着这条 workflow 是旧的完整签到回放，与 none 语义冲突，必须拒绝。
  const storedWorkflow = readBack?.workflow as { steps?: unknown; route?: unknown; identityPath?: unknown } | undefined;
  if (storedWorkflow && Array.isArray(storedWorkflow.steps) && storedWorkflow.steps.length > 0) {
    return {
      ok: false,
      error: '学到的「登录即签到」仍保留旧签到步骤，自动签到可能跳错页面；旧配置未改动，请重试',
    };
  }
  const staleFields = [
    'entry',
    'url',
    'buttonSelector',
    'alreadySelector',
    'successSelector',
    'claimConfirmSelector',
    'apiUrl',
    'logoutApiUrl',
    'claimEntrySelector',
    'claimInputSelector',
    'claimSubmitSelector',
  ] as const;
  if (staleFields.some((field) => readBack?.[field] !== undefined)) {
    return {
      ok: false,
      error: '学到的「登录即签到」仍保留旧签到入口配置，自动签到可能跳错页面；旧配置未改动，请重试',
    };
  }
  return { ok: true };
}

export function verifyLearnedWorkflowStored(
  learned: CheckinWorkflowConfig,
  readBack: { method?: string; workflow?: CheckinWorkflowConfig } | undefined,
): { ok: true } | { ok: false; error: string } {
  const method = readBack?.method;
  if (!readBack || method !== 'workflow') {
    return { ok: false, error: '学到的流程未启用回放（当前是自动识别或其它签到方式），请重试' };
  }
  const stored = readBack.workflow;
  if (stored?.steps?.length !== learned.steps.length) {
    return { ok: false, error: '学到的流程未完整写入站点配置（步骤数不一致），旧配置未改动，请重试' };
  }
  if (canonicalLearningJson(stored.steps) !== canonicalLearningJson(learned.steps)) {
    return { ok: false, error: '学到的动作或滚动配置未完整写入站点配置，请重试' };
  }
  const route = learned.route;
  if (route?.length) {
    const storedRoute = stored.route;
    if (!Array.isArray(storedRoute)
      || storedRoute.length !== route.length
      || storedRoute.some((page, index) => page !== route[index])) {
      return { ok: false, error: '学到的页面路线未写入站点配置（自动签到将找不到签到页），旧配置未改动，请重试' };
    }
  }
  if (stored.identityPath !== learned.identityPath) {
    return { ok: false, error: '学到的个人资料身份核验路径未写入站点配置，旧配置未改动，请重试' };
  }
  return { ok: true };
}

/**
 * 把一条已脱敏的事件追加进会话。
 *
 * 过期会话**不再累积**任何事件：否则用户忘了点结束，几小时后还在往一次早已放弃的
 * 录制里写，直到撞上 100 条上限才失败。返回值里带 `expired`，让调用方顺手清掉会话。
 */
export function appendLearningEvent(
  learning: WorkflowLearningSession,
  event: WorkflowLearningEvent,
  now = Date.now(),
): LearningAppendResult {
  if (isLearningSessionExpired(learning, now)) {
    return { ok: false, error: '学习会话已过期，请重新开始学习', expired: true };
  }
  if (learning.events.length >= LEARNING_EVENT_LIMIT) {
    return { ok: false, error: '学习事件已达到上限', expired: false };
  }
  return {
    ok: true,
    learning: { ...learning, events: [...learning.events, event] },
  };
}

/* ------------------------------------------------------------------ *
 * 事件落盘闸门：来自页面脚本的数据在进入录制信箱前统一净化
 * ------------------------------------------------------------------ */

/** 界面变化片段的落盘上限（与编译侧一致：够它挑关键词与片段，再多不落盘）。 */
export const LEARNING_AFTER_TEXT_LIMIT = 6;
/** 学习事件的字段上限：选择器 ≤ 300、标签 ≤ 100、地址 ≤ 500。 */
export const LEARNING_SELECTOR_MAX_CHARS = 300;
export const LEARNING_LABEL_MAX_CHARS = 100;
export const LEARNING_PATH_MAX_CHARS = 500;

/**
 * 界面变化片段的净化：条数、长度**与内容**三重上限。
 *
 * 内容闸门（`isSafeSnippet`）必须在**入口**就过一遍：`afterText` 会被编译成
 * `assert` 步骤明文写进站点配置，存进会话的旧事件或绕过采集侧的伪造事件都可能
 * 夹带邮箱、验证码、API 密钥。编译侧还会再兜一次，这里是更早的一道。
 */
function sanitizeAfterText(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const words = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.replace(/\s+/g, ' ').trim())
    .filter((item) => !!item && item.length <= LEARNING_SNIPPET_MAX_CHARS && isSafeSnippet(item))
    .slice(0, LEARNING_AFTER_TEXT_LIMIT);
  return words.length ? words : undefined;
}

/**
 * 校验滚动证据（`scrollBeforeY` / `scrollPageTop`）。
 *
 * 与采集侧同一套上限：非有限数、负数、超出上限一律丢弃；标记位只接受 `true`。
 * 页面脚本能伪造这两个字段，因此不能原样透传 —— 它们最终会变成
 * `scrollIntoView` 步骤属性，由执行器去滚动真实页面。
 */
function sanitizeLearningScrollFields(event: { scrollBeforeY?: unknown; scrollPageTop?: unknown; scrollContainer?: unknown }): {
  scrollBeforeY?: number;
  scrollPageTop?: true;
  scrollContainer?: string;
} {
  const result: { scrollBeforeY?: number; scrollPageTop?: true; scrollContainer?: string } = {};
  const y = event.scrollBeforeY;
  if (typeof y === 'number' && Number.isFinite(y) && y >= 0 && y <= LEARNING_SCROLL_MAX_Y) {
    result.scrollBeforeY = Math.round(y);
  }
  if (event.scrollPageTop === true) result.scrollPageTop = true;
  const container = safeScrollContainer(event.scrollContainer);
  if (container && (result.scrollPageTop || (result.scrollBeforeY ?? 0) > 0)) result.scrollContainer = container;
  return result;
}

/**
 * 事件 path 的落盘形态：同源 `pathname + 安全 hash`，查询串一律丢掉。
 *
 * 查询串里可能带 OAuth `code`/`state` 或一次性参数；hash 里带凭据类参数时整体
 * 丢弃（`safeHash`）。采集侧 `currentPath` 已经这样就做过，这里兜的是旧会话与
 * 伪造事件 —— 路线会作为 `route` 明文写进站点配置，是永久泄漏面。
 */
function sanitizeLearningPath(value: string): string {
  try {
    const url = new URL(value, 'https://learning.invalid');
    return `${url.pathname || '/'}${safeHash(url.hash)}`.slice(0, LEARNING_PATH_MAX_CHARS);
  } catch {
    const path = value.split(/[?#]/, 1)[0] ?? '';
    return path.slice(0, LEARNING_PATH_MAX_CHARS) || '/';
  }
}

/** 点击目标的链接形态：只留 `origin + pathname`，去掉 userinfo / 查询串 / hash。 */
function sanitizeLearningHref(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 1_000) return undefined;
  try {
    const url = new URL(value, 'https://learning.invalid');
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return `${url.origin}${url.pathname}`.slice(0, 1_000);
  } catch {
    return undefined;
  }
}

/** 净化一次指针落点 `{ rx, ry }`：两个分量都必须是有限数，钳到 0..1。 */
function sanitizeAnchor(value: unknown): WorkflowPointerAnchor | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { rx, ry } = value as { rx?: unknown; ry?: unknown };
  if (typeof rx !== 'number' || !Number.isFinite(rx)) return undefined;
  if (typeof ry !== 'number' || !Number.isFinite(ry)) return undefined;
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  return { rx: clamp(rx), ry: clamp(ry) };
}

/** 净化控件身份指纹：只留白名单字段，每条都是有限长度字符串。 */
function sanitizeFingerprint(value: unknown): WorkflowElementFingerprint | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  const take = (key: keyof WorkflowElementFingerprint): string | undefined => {
    const item = source[key];
    return typeof item === 'string' && item.trim() && item.length <= 200 ? item.trim() : undefined;
  };
  const fingerprint: WorkflowElementFingerprint = {};
  const tag = take('tag'); if (tag) fingerprint.tag = tag;
  const aria = take('aria'); if (aria) fingerprint.aria = aria;
  const name = take('name'); if (name) fingerprint.name = name;
  const testId = take('testId'); if (testId) fingerprint.testId = testId;
  const inputType = take('inputType'); if (inputType) fingerprint.inputType = inputType;
  const text = take('text'); if (text) fingerprint.text = text;
  const role = take('role'); if (role) fingerprint.role = role;
  return Object.keys(fingerprint).length ? fingerprint : undefined;
}

const SANITIZE_KEYS: ReadonlySet<string> = new Set<WorkflowKey>([
  'Enter', 'Space', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);

/** 净化手势语义：只认白名单取值。 */
function sanitizeGesture(value: unknown): WorkflowGesture | undefined {
  return value === 'click' || value === 'double' || value === 'right' || value === 'long-press'
    ? value : undefined;
}

/** 净化键盘键：只认非打印功能键白名单。 */
function sanitizeKey(value: unknown): WorkflowKey | undefined {
  return typeof value === 'string' && SANITIZE_KEYS.has(value as WorkflowKey) ? (value as WorkflowKey) : undefined;
}

/**
 * 把一条页面事件净化成**只含白名单字段**的录制事件；不认识/不合规就返回 null。
 *
 * 这里刻意是「重建式」净化而不是删字段：页面脚本能塞进任何键值（输入值、token、
 * 整段正文），重建后它们一个都进不了录制信箱。fill 更没有 `value` 通道 ——
 * 只有「里面有没有内容」这一个布尔与字段角色。
 */
/**
 * 步骤选择器的落盘规则：非空、限长、不含 text=、不含自动生成的 id。
 *
 * click/fill 与 drag 共用同一套闸门；任何一步落盘前都要过它。
 */
function sanitizeStepSelector(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const selector = value.trim();
  if (!selector || selector.length > LEARNING_SELECTOR_MAX_CHARS) return undefined;
  if (hasUnstableIdSelector(selector)) return undefined;
  return selector;
}

export function sanitizeLearningEvent(event: WorkflowLearningEvent): WorkflowLearningEvent | null {
  if (!event || typeof event !== 'object' || !Number.isFinite(event.at)) return null;
  if (event.type === 'navigation') {
    return typeof event.path === 'string' && event.path.length <= LEARNING_PATH_MAX_CHARS
      ? { type: 'navigation', path: sanitizeLearningPath(event.path), at: event.at }
      : null;
  }
  if (event.type === 'scroll') {
    // 纯滚动是真实的一步：只保留 path、比例与可选容器；比例必须是有限数且在 0..1。
    const ratio = (event as { ratio?: unknown }).ratio;
    if (typeof event.path !== 'string' || event.path.length > LEARNING_PATH_MAX_CHARS) return null;
    if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0 || ratio > 1) return null;
    const container = safeScrollContainer((event as { container?: unknown }).container);
    return {
      type: 'scroll',
      path: sanitizeLearningPath(event.path),
      ratio: Math.min(1, Math.max(0, ratio)),
      ...(container ? { container } : {}),
      at: event.at,
    } as WorkflowLearningEvent;
  }
  if (event.type === 'drag') {
    /*
     * 拖拽事件的落盘闸门与 click 同源：选择器/标签/路径长度、相对落点、
     * 滚动证据全部按同一份白名单重建；原始坐标一律没有通道。
     */
    const raw = event as { selector?: unknown; toSelector?: unknown; label?: unknown; path?: unknown };
    const selector = sanitizeStepSelector(raw.selector);
    const toSelector = sanitizeStepSelector(raw.toSelector);
    if (!selector || !toSelector) return null;
    if (typeof raw.label !== 'string' || raw.label.length > LEARNING_LABEL_MAX_CHARS) return null;
    if (typeof raw.path !== 'string' || raw.path.length > LEARNING_PATH_MAX_CHARS) return null;
    const anchor = sanitizeAnchor((event as { anchor?: unknown }).anchor);
    const toAnchor = sanitizeAnchor((event as { toAnchor?: unknown }).toAnchor);
    const scrollFields = sanitizeLearningScrollFields(event as { scrollBeforeY?: unknown; scrollPageTop?: unknown });
    const afterText = sanitizeAfterText((event as { afterText?: unknown }).afterText);
    const rawEvidence = (event as { evidence?: unknown }).evidence;
    const evidence = rawEvidence && typeof rawEvidence === 'object'
      ? safeEvidence(rawEvidence as { kind: 'success' | 'already'; words: string[] })
      : undefined;
    return {
      type: 'drag',
      selector,
      toSelector,
      label: raw.label.trim().slice(0, LEARNING_LABEL_MAX_CHARS),
      path: sanitizeLearningPath(raw.path),
      ...scrollFields,
      ...(anchor ? { anchor } : {}),
      ...(toAnchor ? { toAnchor } : {}),
      ...(afterText ? { afterText } : {}),
      ...(evidence ? { evidence } : {}),
      at: event.at,
    } as WorkflowLearningEvent;
  }
  if (event.type !== 'click' && event.type !== 'fill') return null;
  if (typeof event.selector !== 'string' || !event.selector.trim()
    || event.selector.length > LEARNING_SELECTOR_MAX_CHARS) return null;
  if (typeof event.label !== 'string' || event.label.length > LEARNING_LABEL_MAX_CHARS) return null;
  if (typeof event.path !== 'string' || event.path.length > LEARNING_PATH_MAX_CHARS) return null;
  const afterText = sanitizeAfterText((event as { afterText?: unknown }).afterText);
  const scrollFields = sanitizeLearningScrollFields(event as { scrollBeforeY?: unknown; scrollPageTop?: unknown });
  const label = event.label.trim().slice(0, LEARNING_LABEL_MAX_CHARS);
  const path = sanitizeLearningPath(event.path);
  const selector = event.selector.trim();

  if (event.type === 'fill') {
    // **绝不接受任何输入值**：事件里只有「有没有内容」这一个布尔。
    const fingerprint = sanitizeFingerprint((event as { fingerprint?: unknown }).fingerprint);
    const key = sanitizeKey((event as { key?: unknown }).key);
    return {
      type: 'fill',
      selector,
      label,
      path,
      hasValue: event.hasValue === true,
      ...(event.fieldRole === 'username' || event.fieldRole === 'password'
        ? { fieldRole: event.fieldRole }
        : {}),
      ...(afterText ? { afterText } : {}),
      ...scrollFields,
      ...(fingerprint ? { fingerprint } : {}),
      ...(key ? { key } : {}),
      at: event.at,
    } as WorkflowLearningEvent;
  }

  const evidence = event.evidence && (
    event.evidence.kind === 'success' || event.evidence.kind === 'already'
  ) && Array.isArray(event.evidence.words)
    ? {
        kind: event.evidence.kind,
        words: event.evidence.words
          .filter((word) => typeof word === 'string' && isSafeSnippet(word))
          .slice(0, 4),
      }
    : undefined;
  // 「怎么点的」契约字段：落点、手势、键盘、长按、拖拽终点、指纹 —— 全部白名单净化，
  // 绝不让伪造事件把任意键值带进录制信箱。单击左键（缺省）不写 gesture。
  const anchor = sanitizeAnchor((event as { anchor?: unknown }).anchor);
  const gesture = sanitizeGesture((event as { gesture?: unknown }).gesture);
  const key = sanitizeKey((event as { key?: unknown }).key);
  const rawHold = (event as { holdMs?: unknown }).holdMs;
  const holdMs = typeof rawHold === 'number' && Number.isFinite(rawHold) && rawHold > 0 && rawHold <= 60_000
    ? Math.round(rawHold) : undefined;
  const dragToAnchor = sanitizeAnchor((event as { dragToAnchor?: unknown }).dragToAnchor);
  const fingerprint = sanitizeFingerprint((event as { fingerprint?: unknown }).fingerprint);
  const rawDragTo = (event as { dragToSelector?: unknown }).dragToSelector;
  const dragToSelector = typeof rawDragTo === 'string' && rawDragTo.trim()
    && rawDragTo.length <= LEARNING_SELECTOR_MAX_CHARS
    && !rawDragTo.includes('text=') && !hasUnstableIdSelector(rawDragTo.trim())
    ? rawDragTo.trim() : undefined;
  return {
    type: 'click',
    selector,
    label,
    path,
    ...(sanitizeLearningHref(event.href) ? { href: sanitizeLearningHref(event.href) } : {}),
    ...(event.loginAction === 'entry' || event.loginAction === 'submit' || event.loginAction === 'oauth'
      ? { loginAction: event.loginAction }
      : {}),
    ...(evidence ? { evidence } : {}),
    ...(afterText ? { afterText } : {}),
    ...scrollFields,
    ...(anchor ? { anchor } : {}),
    ...(gesture ? { gesture } : {}),
    ...(key ? { key } : {}),
    ...(holdMs !== undefined ? { holdMs } : {}),
    ...(dragToSelector ? { dragToSelector } : {}),
    ...(dragToAnchor ? { dragToAnchor } : {}),
    ...(fingerprint ? { fingerprint } : {}),
    at: event.at,
  } as WorkflowLearningEvent;
}

/**
 * 单条可见片段是否**可能含凭据/验证码/API 密钥** —— 只用于丢弃，不做替换。
 *
 * 片段是页面文字，可能顺带带上邮箱、六位验证码、JWT，或**签到后弹层里回显的中转密钥**。
 * 这类内容一律不采集：录制记录会作为 `assert` 步骤明文写进站点配置（chrome storage），
 * 多一条敏感串就多一份泄露面。它是把敏感串挡在站点配置之外的**唯一内容闸门**，所以除了
 * 原有的邮箱 / 六位连号 / 明文凭据词，还要拦住那些既没有六位连号、也不含 `token`/`secret`
 * 字样的 API 密钥形态（`sk-…`、`ghp_…`、`glpat-…`、`xoxb-…`）。
 *
 * 新增两条判据（**保守**：只拦明显是密钥/高熵串的，普通中英文短标签与句子一律放行）：
 * 1. 已知密钥前缀 + 分隔符 + 字母数字：OpenAI `sk`/`pk`、GitHub `ghp`/`gho`/`ghu`/`ghs`、
 *    GitLab `glpat`、Slack `xox[baprs]`。前缀锚在词首（`\b`），`task-`、`disk-` 这类普通词里
 *    嵌着的 `sk-` 不会被误伤；
 * 2. 连续 20+ 位、且**数字与字母混排**的字母数字串 —— 各家密钥/哈希/base64 的通用形态。
 *    纯字母的长单词（`internationalization`）不含数字、纯数字序号已被六位连号规则拦下，
 *    都不在此列，因此不会误伤正常界面文字。
 */
export function isSafeSnippet(text: string): boolean {
  if (!text || text.length > LEARNING_SNIPPET_MAX_CHARS) return false;
  if (/@[\w-]+\.[\w-]+/.test(text)) return false;
  if (/\d{6,}/.test(text)) return false;
  if (/eyJ[\w-]{6,}|bearer\s|password|token|secret|密码/i.test(text)) return false;
  // 1. 已知密钥前缀：前缀锚在词首，`task-`/`disk-` 里嵌的 `sk-` 不误伤。
  if (/\b(?:sk|pk|ghp|gho|ghu|ghs|glpat|xox[baprs])[-_][A-Za-z0-9]/i.test(text)) return false;
  // 2. 连续 20+ 位、数字与字母混排的高熵串（密钥/哈希/base64）；纯字母词、纯数字序号都不具备。
  if (text.match(/[A-Za-z0-9]{20,}/g)?.some((run) => /[A-Za-z]/.test(run) && /\d/.test(run))) {
    return false;
  }
  return true;
}

/** 元素是否可见：不可见的文字不该被学成「界面出现了什么」。 */
function isVisibleElement(element: HTMLElement): boolean {
  try {
    return isVisible(element);
  } catch {
    // jsdom 等没有布局引擎的环境 getComputedStyle 可能抛错；采集宁可少一条也不能中断。
    return true;
  }
}

/**
 * 采集当前页面的「短可见文本」快照，用于和动作后的快照做差集。
 *
 * 只取叶子节点的短文字（≤ 60 字符）：容器文字会随整页刷新而变，记下来既不可回放，
 * 也最容易把页面正文写进录制记录。扫描有上界，超大页面也不会拖慢手动签到。
 */
export function collectVisibleSnippets(limit = 300): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const elements = document.body?.querySelectorAll<HTMLElement>('*');
  if (!elements) return out;
  let scanned = 0;
  for (const element of elements) {
    if (scanned >= 4_000 || out.length >= limit) break;
    scanned += 1;
    // 有子元素的是容器，它的文字是拼出来的，回放时不会逐字重现。
    if (element.children.length > 0) continue;
    const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > LEARNING_SNIPPET_MAX_CHARS || seen.has(text)) continue;
    if (!isSafeSnippet(text) || !isVisibleElement(element)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/**
 * 「界面出现了什么」：动作前后新出现的可见文字 + 限定的关键词命中。
 *
 * 关键词优先于片段：关键词是**可回放**的稳定证据，随机文案不是。返回 undefined 表示
 * 没有可识别的变化，调用方就不该硬塞断言（不能凭猜）。
 */
export function pageChangeEvidence(
  before: readonly string[],
  after: readonly string[],
  newText: string,
): string[] | undefined {
  const known = new Set(before);
  const fresh = after.filter((text) => !known.has(text));
  const keywords = uniqueWords(`${newText} ${fresh.join(' ')}`, CHANGE_WORDS).slice(0, LEARNING_KEYWORD_LIMIT);
  const snippets = fresh
    .filter(isSafeSnippet)
    .filter((text) => !keywords.some((word) => text.includes(word)))
    .slice(0, LEARNING_SNIPPET_LIMIT);
  const merged = [...new Set([...keywords, ...snippets])];
  return merged.length ? merged : undefined;
}

/* ------------------------------------------------------------------ *
 * 页面侧采集：选择器、标签、可见文本快照与事件监听
 * ------------------------------------------------------------------ */

/** 兜底 `text=` 选择器里控件文字的长度上限。 */
const SELECTOR_TEXT_MAX_CHARS = 24;

function cssQuote(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * 采集控件文字，作为兜底 `text=` 选择器的素材。
 *
 * 只取控件的可见文字，与回放侧一致；textContent 会把 SVG title/desc 拼进去，
 * 例如「GitHub使用 GitHub 继续」，而浏览器 innerText 只有「使用 GitHub 继续」。
 * 逗号后的文字不参与生成，避免与多选择器回退语法产生歧义。
 */
function selectorText(element: HTMLElement): string {
  const raw = element instanceof HTMLInputElement
    // 输入类控件不能用 value 当选择器文字（里面可能是用户输入内容，绝不采集）。
    ? (element.getAttribute('aria-label') ?? element.getAttribute('title') ?? '')
    : selectorVisibleText(element);
  const first = raw.replace(/\s+/g, ' ').trim().split(',')[0]?.trim() ?? '';
  // 纯数字/纯符号的短文字（序号、图标字符）回放时极易误命中，不作为选择器。
  if (!/[\p{L}\p{Script=Han}]/u.test(first)) return '';
  return first.slice(0, SELECTOR_TEXT_MAX_CHARS).trim();
}

/** 合法 id 的基本形态：`#id` 选择器只在这条通过后才会被考虑。 */
const ID_SHAPE = /^[A-Za-z][A-Za-z0-9_-]{0,80}$/;

/**
 * React 19 / Base UI 的 `useId` 下划线形态：`_r_h_`、`_r_1_`。
 *
 * React 19（以及基于它的 Base UI）生成的 id 就是 `_r_` + 短随机串 + `_`，
 * 且不同元素会**反复拿到同一个**；带库前缀或组件后缀时形如 `base-ui-_r_h_`、
 * `radix-_r_1_`、`_r_2_-form-item`。边界前后必须是 `-`/`_`/串首尾：
 * `form_r_1_data` 这种只有一个下划线分隔的普通蛇形 id 不在此列。
 */
const USE_ID_UNDERSCORE = /(?:^|[-_])_r_[0-9a-z]{1,4}_(?:$|[-_])/i;

/**
 * 生成 id 的库前缀。
 *
 * Radix / Base UI 自己生成 id，`radix-`、`base-ui-` 开头的 id 一定不是人手写的；
 * 站点自己的控件不会起这种名字。
 */
const GENERATED_ID_PREFIX = /^(?:radix|base-?ui)-/i;

/**
 * 按序号生成的 ARIA 组合框 id（react-select / downshift）。
 *
 * `react-select-2-input` 里的 `2` 是第几个实例，页面上新增/移除一个组件就会整体错位，
 * 回放时指向别的控件。手写 id 不会长成这样。
 */
const ORDINAL_WIDGET_ID = /(?:^|[-_])(?:react-select|downshift)-\d+(?:[-_]|$)/i;

/** 纯 UUID：整串只有十六进制与分隔符，一眼看出是数据库/前端随机生成的。 */
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 单段随机串的最小长度：短于此即便全是十六进制也当成人手写的（`fade`、`2026`）。 */
const RANDOM_SEGMENT_MIN_CHARS = 8;

/** 一段字符是不是「随机串」：够长、全是十六进制字符、**同时**含数字与字母。 */
function isRandomSegment(segment: string): boolean {
  if (segment.length < RANDOM_SEGMENT_MIN_CHARS) return false;
  if (!/^[0-9a-f]+$/i.test(segment)) return false;
  return /\d/.test(segment) && /[a-f]/i.test(segment);
}

/**
 * 这个 id 是**运行时自动生成**的、不能当选择器用吗？
 *
 * 故障现场：站点「卡皮巴拉API」的签到按钮 id 是 `base-ui-_r_h_`（Base UI / React `useId`），
 * 学习把它学成了 `#base-ui-_r_h_`。这类 id **每次渲染都可能变，不同元素还会拿到同一个**，
 * 回放时指向的是别的元素 —— 点错元素、反复点同一个选择器，用户看到的就是「一直卡在核对」。
 *
 * 判据（**保守**：宁可多拒绝、回落成文字选择器，也不放过任何随机形态）：
 * 1. 连合法 `#id` 形态都不满足（空串、前导数字/横线、含空格或冒号）——
 *    React 18 的 `:r1:` / `:R2ab:` 就落在这条里，它们本来也写不进选择器；
 * 2. `useId` 下划线形态（`_r_h_`、`base-ui-_r_1_-form-item`）；
 * 3. 生成 id 的库前缀（`radix-`、`base-ui-`）；
 * 4. 按序号生成的组合框 id（`react-select-2-input`、`downshift-1-input`）；
 * 5. UUID；
 * 6. 某一段是够长的十六进制随机串（`el-3f2a91b4`、`a1b2c3d4e5f6`）。
 *
 * 刻意**不**用的判据：只看「有没有数字」「长不长」。真实手写 id 里
 * `dashboard-2026`、`step-1`、`login-form`、`checkin-btn` 都很常见，
 * 按那些粗糙特征判会把手写 id 一起误伤 —— 那比学错随机 id 更糟：
 * 用户明明写死了稳定 id，扩展却去猜文字。
 */
export function isUnstableGeneratedId(id: string): boolean {
  const value = id.trim();
  // 1. 形态就不合法：写不成 `#id`，当然也不能当选择器。
  if (!ID_SHAPE.test(value)) return true;
  if (USE_ID_UNDERSCORE.test(value)) return true;
  if (GENERATED_ID_PREFIX.test(value)) return true;
  if (ORDINAL_WIDGET_ID.test(value)) return true;
  if (UUID_LIKE.test(value)) return true;
  // 6. 逐段看：`el-3f2a91b4` 的 `3f2a91b4`、`a1b2c3d4e5f6` 整串，都是随机十六进制段。
  return value.split(/[-_]/).some(isRandomSegment);
}

/** CSS 选择器里 `#id` 锚点的形态：串首或组合符之后，属性选择器内部除外。 */
const SELECTOR_ID_TOKEN = /(?:^|[\s>+~,(])#([^\s>+~,[\]]+)/g;

/** React 18 `useId` 的 `:r1:` / `:R2ab:` 形态：本身写不进合法选择器，也绝不该落盘。 */
const REACT_COLON_USE_ID = /^[#.]?:r[0-9a-z]+:$/i;

/**
 * 这个**选择器文本**里有没有自动生成 id？—— 落盘前的最后一道闸门。
 *
 * 采集侧 `learningSelector` 已经不会产出这类选择器，但事件可能来自旧会话、被页面
 * 脚本伪造，或由别的入口写进录制信箱；把 `#base-ui-_r_h_` 写进站点配置，回放时
 * 轻则找不到控件，重则点到另一个拿到同一个 id 的元素。判据与 `isUnstableGeneratedId`
 * 完全一致，只额外处理「选择器文本里的 `#id` 锚点」与 React 18 的冒号形态。
 *
 * `text=` 内容里的 `#` 是文字不是 id；`[data-testid="#x"]` 这类属性值内部也不按 id 解析。
 */
export function hasUnstableIdSelector(selector: string): boolean {
  const value = selector.trim();
  if (!value) return false;
  if (REACT_COLON_USE_ID.test(value)) return true;
  for (const part of value.split('>>')) {
    if (part.trim().startsWith('text=')) continue;
    for (const match of part.matchAll(SELECTOR_ID_TOKEN)) {
      if (isUnstableGeneratedId(match[1]!)) return true;
    }
  }
  return false;
}

/**
 * 这个选择器在当前页是否**指向别的元素或命中多个** —— 只有此时才拒绝它。
 *
 * 判据刻意用回放侧的同一套解析（`queryAll`，含 `text=` 语义与可见性过滤）：
 * 学习那一刻就按「回放时会选到谁」来验收，避免学出一个当场看着合理、回放却点错的选择器。
 *
 * text= 支持的按钮/链接若当场零命中也必须拒绝，不能把不可回放的选择器落盘。
 * 其它控件（如普通文本输入框）仍沿用原有的零命中处理。
 */
/**
 * 元素所在的影子根链（最外层在前）。空数组表示它在主文档里。
 *
 * `getRootNode()` 返回 ShadowRoot 时说明元素被封装在影子树里 —— 顶层的
 * `document.querySelector` 永远看不到它，选择器必须写成 `host >>> inner` 才回放得到。
 */
function shadowHostChain(element: HTMLElement): string[] {
  const chain: string[] = [];
  let node: Node | null = element;
  while (node) {
    const root = node.getRootNode();
    if (!(root instanceof ShadowRoot)) break;
    const host = root.host as HTMLElement;
    chain.unshift(learningSelectorInRoot(host, host.getRootNode()));
    node = host;
  }
  return chain;
}

/** 在给定作用域里算一条能唯一指向 element 的选择器（影子根内的那一层）。 */
function learningSelectorInRoot(element: HTMLElement, root: Node): string {
  const scope = root as ParentNode;
  const uniq = (selector: string): boolean => {
    try {
      const matches = scope.querySelectorAll(selector);
      return matches.length === 1 && matches[0] === element;
    } catch {
      return false;
    }
  };
  const testId = element.getAttribute('data-testid');
  if (testId) {
    const selector = `[data-testid="${cssQuote(testId)}"]`;
    if (uniq(selector)) return selector;
  }
  if (element.id && !isUnstableGeneratedId(element.id)) {
    const selector = `#${element.id}`;
    if (uniq(selector)) return selector;
  }
  const tag = element.tagName.toLowerCase();
  const siblings = element.parentElement
    ? [...element.parentElement.children].filter((item) => item.tagName === element.tagName)
    : [element];
  const index = siblings.indexOf(element) + 1;
  const nth = `${tag}:nth-of-type(${index > 0 ? index : 1})`;
  return uniq(nth) ? nth : tag;
}

function ambiguousSelector(selector: string, element: HTMLElement): boolean {
  let matches: HTMLElement[];
  try {
    matches = queryAll<HTMLElement>(selector);
  } catch {
    return true;
  }
  /*
   * 影子根里的元素：顶层选择器**必然**命中 0 个，但这不代表选择器唯一 ——
   * 只说明它在这个作用域里根本解析不到。老实现把 0 命中当成「不歧义」放行，
   * 于是学出的 `#shadow-claim` 在回放时永远找不到目标（学得到、回放不了）。
   * 这里如实判成歧义，让调用方继续往下走、最终用 `>>>` 路径表达。
   */
  if (shadowHostChain(element).length > 0) return true;
  if (matches.length === 0) return selector.includes('text=') && element.matches(TEXT_SELECTOR_SCOPE);
  return !(matches.length === 1 && matches[0] === element);
}

/**
 * 结构化路径兜底：`#最近稳定祖先 > tag:nth-of-type(n) > …`。
 *
 * 没有 testid / 稳定 id / name / aria / 文字的控件（纯图标 `<button>`、`<div role=button>`）
 * 旧实现直接返回裸标签名 `button`，回放时 `queryFirst('button')` 命中全页第一个按钮 ——
 * 这正是「识别不到我做的操作 / 点错元素」的根。这里改为从录制元素向上走，在最近的
 * **稳定 id 祖先**处收尾（`isUnstableGeneratedId` 判过），中间每层用 `:nth-of-type`
 * 定位同类兄弟里的第几个，保证唯一指向录制的那个控件；同时锚定在稳定祖先上，
 * 无关区域的增删不会让路径整体错位。
 */
function structuredPath(element: HTMLElement): string {
  const segments: string[] = [];
  let node: HTMLElement | null = element;
  while (node && node !== document.body && node.nodeType === 1) {
    if (node !== element && node.id && !isUnstableGeneratedId(node.id)) {
      segments.unshift(`#${node.id}`);
      return segments.join(' > ');
    }
    const parent: HTMLElement | null = node.parentElement;
    const tag = node.tagName.toLowerCase();
    if (!parent) {
      segments.unshift(tag);
      break;
    }
    // 存进 const 打破 TS 对可变 `node` 的循环类型推断（TS7022），也让 filter 闭包捕获稳定引用。
    const current: HTMLElement = node;
    const sameTag = [...parent.children].filter((child) => child.tagName === current.tagName);
    const nth = sameTag.indexOf(current) + 1;
    segments.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${nth})` : tag);
    node = parent;
  }
  return segments.join(' > ');
}

/** 允许录制的非打印功能键（与 `WorkflowKey` 一一对应；可打印字符绝不进来）。 */
const LEARNING_NON_PRINTABLE_KEYS: ReadonlySet<string> = new Set<WorkflowKey>([
  'Enter', 'Space', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);

/** KeyboardEvent.key 的取值 → `WorkflowKey`（`" "` 与 `Spacebar` 都归一成 `Space`）。 */
function learningKeyOf(event: KeyboardEvent): WorkflowKey | undefined {
  const key = event.key;
  if (key === ' ' || key === 'Spacebar') return 'Space';
  return LEARNING_NON_PRINTABLE_KEYS.has(key) ? (key as WorkflowKey) : undefined;
}

/**
 * 把控件内的一次指针落点换算成相对比例 `{ rx, ry }`，钳到 0..1。
 *
 * 只存比例，绝不存 clientX/clientY：比例与视口、缩放、滚动位置全部无关，回放时
 * 用 `rect.left + rect.width * rx` 还原到控件内同一处。读不到布局（jsdom 零尺寸）
 * 时返回 undefined，宁可缺省按中心点，也不写回不可信的落点。
 */
function pointerAnchor(element: HTMLElement, x: number, y: number): WorkflowPointerAnchor | undefined {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  const rect = element.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) return undefined;
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return {
    rx: clamp((x - rect.left) / rect.width),
    ry: clamp((y - rect.top) / rect.height),
  };
}

/**
 * 录制时控件的身份指纹：tag/aria/name/testId/inputType/text/role。
 *
 * 选择器在站点改版后常会命中**另一个**元素；指纹把「当初那个元素长什么样」
 * 存成一组稳定特征，回放时逐条核验。只写有把握的字段。
 *
 * **contenteditable 宿主不读它的可见文字**（隐私红线：`innerText` 就是用户正在
 * 输入的正文），与普通按钮分开处理。
 */
function learningFingerprint(element: HTMLElement): WorkflowElementFingerprint | undefined {
  const fingerprint: WorkflowElementFingerprint = { tag: element.tagName.toLowerCase() };
  const aria = element.getAttribute('aria-label')?.trim();
  if (aria) fingerprint.aria = aria;
  const name = element.getAttribute('name')?.trim();
  if (name) fingerprint.name = name;
  const testId = element.getAttribute('data-testid')?.trim();
  if (testId) fingerprint.testId = testId;
  const role = element.getAttribute('role')?.trim();
  if (role) fingerprint.role = role;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    fingerprint.inputType = element instanceof HTMLInputElement ? element.type : 'textarea';
    // 输入类控件绝不读 value/正文（可能是凭据/验证码）。
  } else if (!isContentEditableHost(element)) {
    const text = selectorVisibleText(element);
    if (text) fingerprint.text = text.slice(0, 80);
  }
  return Object.keys(fingerprint).length > 1 ? fingerprint : undefined;
}

/**
 * 控件选择器：**优先稳定、其次简短、始终唯一**。
 *
 * `data-testid` / 稳定 `id` / `name` / `aria-label` 不受文案变化影响，优先级最高；只有它们
 * 都拿不到时才回落到控件自身的短文字，仍拿不到才回落到结构化路径。
 * **不使用 `learningLabel`** —— 它把 aria-label 与文字拼在一起，拼出来的多半匹配不到控件；
 * label 只用于过滤判断，选择器只用于定位。
 *
 * 每一档都要过 `ambiguousSelector`：一个 `name` / 文字在页面上命中多个控件时（两个表单
 * 各有 `input[name="claim"]`、两个按钮都写「签到」）用它回放会点错，此时这一档被跳过、
 * 继续往下回落，直到某一档能**唯一指向录制的那个控件**。
 *
 * `id` 这一档还要过 `isUnstableGeneratedId`：自动生成的 id（`base-ui-_r_h_`）被踢掉后
 * 继续往下走，而不是直接放弃。
 */
export function learningSelector(
  element: HTMLElement,
  /** 演示账号自己的名字：按它们生成的 `text=` 选择器换个账号就找不到，跳过这两档。 */
  isPersonal: (value: string | undefined) => boolean = () => false,
): string {
  const testId = element.getAttribute('data-testid');
  if (testId) {
    const selector = `[data-testid="${cssQuote(testId)}"]`;
    if (!ambiguousSelector(selector, element)) return selector;
  }
  if (element.id && !isUnstableGeneratedId(element.id)) {
    const selector = `#${element.id}`;
    if (!ambiguousSelector(selector, element)) return selector;
  }
  const name = element.getAttribute('name');
  if (name) {
    const selector = `${element.tagName.toLowerCase()}[name="${cssQuote(name)}"]`;
    if (!ambiguousSelector(selector, element)) return selector;
  }
  const aria = element.getAttribute('aria-label');
  if (aria?.trim() && !isPersonal(aria)) {
    const selector = `text=${aria.replace(/,/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)}`;
    if (!ambiguousSelector(selector, element)) return selector;
  }
  // contenteditable 宿主的可见文字**就是用户正在输入的正文**（理由/评论，甚至误填的
  // 验证码），绝不允许走 `text=` 这一档 —— 那会把正文切 24 字符塞进选择器落盘。
  // 与 `learningLabel` 同一保护：只允许 aria-label/稳定 data-*/name/id，拿不到就回落
  // 结构化路径。普通按钮的 textContent 是「签到」这类标题，读它无妨，照旧。
  if (!isContentEditableHost(element)) {
    const text = selectorText(element);
    if (text && !isPersonal(text)) {
      const selector = `text=${text}`;
      if (!ambiguousSelector(selector, element)) return selector;
    }
  }
  // 全部稳定语义都拿不到或都不唯一：用结构化路径唯一指向录制元素，绝不回落到裸标签名。
  /*
   * 影子根里的控件：先按宿主链拼出 `host >>> inner`，回放才能穿透进去。
   * 顶层 `document` 查不到它，任何不含 `>>>` 的选择器在回放时都必然落空 ——
   * 这正是「学得到、自动签到点不到」在 Web Components 站点上的根因。
   */
  const shadowChain = shadowHostChain(element);
  if (shadowChain.length > 0) {
    return [...shadowChain, learningSelectorInRoot(element, element.getRootNode())].join(' >>> ');
  }
  return structuredPath(element) || element.tagName.toLowerCase();
}

/**
 * 受限长度的控件文案，只用于本地角色判定；事件标签由 learningLabel 脱敏后输出。
 *
 * `contenteditable` 富文本宿主的 `textContent` **就是用户输入的正文**（理由、评论，
 * 甚至误填的验证码），绝不能当标签读进录制里。对这类元素只取 `aria-label` /
 * `placeholder`，永不读它的文本内容。普通按钮的 `textContent` 是「签到」这类标题，
 * 读它无妨，照旧。
 */
function learningLabelText(element: HTMLElement): string {
  const editable = isContentEditableHost(element);
  const textPart = editable
    ? element.getAttribute('placeholder') ?? ''
    : element.innerText ?? element.textContent ?? '';
  return `${element.getAttribute('aria-label') ?? ''} ${textPart}`
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** 标签会写进录制记录，包含凭据类提示时仍抹成空串。 */
export function learningLabel(element: HTMLElement): string {
  const label = learningLabelText(element);
  return /密码|password|token|secret|验证码|captcha/i.test(label) ? '' : label;
}

function currentPath(): string {
  try {
    const url = new URL(location.href);
    // OAuth callback fragments may carry credentials even though search is omitted.
    return `${url.pathname}${safeHash(url.hash)}`.slice(0, 500);
  } catch {
    return '/';
  }
}

function safeLearningHref(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return `${url.origin}${url.pathname}`.slice(0, 1_000);
  } catch {
    return undefined;
  }
}

function bodyText(): string {
  return document.body?.innerText ?? document.body?.textContent ?? '';
}

/**
 * 语义可点控件：`<button>`/`<a>`/表单按钮/label，以及带可点 ARIA role 的元素
 * （走 composedPath，穿透 Shadow DOM）。
 *
 * 直接取用 dom-utils 的 TEXT_SELECTOR_SCOPE，与回放的 `text=` 候选范围共用
 * 同一张表 —— 两边各写一份字面量正是「菜单项学得到、回放点不到」的成因，
 * 不允许再分叉。
 */
const CLICKABLE = TEXT_SELECTOR_SCOPE;

/**
 * 自定义按钮的「非语义」信号：内联 onclick、可聚焦 tabindex。
 *
 * 国内站大量用 `<div onClick>` / `<span onClick>` 当按钮，这些元素没有语义标签。
 * 内联 `onclick` 一眼可判；`tabindex` 表示作者刻意让它可聚焦（自定义控件的常见做法），
 * 但 `tabindex="-1"` 只是「可编程聚焦、不进 Tab 键序」的焦点管理，不算按钮。
 */
const INTERACTIVE_ATTR = '[onclick], [tabindex]:not([tabindex="-1"])';

/**
 * **强**可交互信号：语义控件或可点 ARIA role（`CLICKABLE`），或内联 `onclick` /
 * 可聚焦 `tabindex`（`INTERACTIVE_ATTR`）。命中即采用。
 */
function isStrongClickTarget(el: HTMLElement): boolean {
  return el.matches(CLICKABLE) || el.matches(INTERACTIVE_ATTR);
}

/**
 * **弱**可交互信号：计算样式 `cursor: pointer`。
 *
 * React/Vue 的 `onClick` 不会在 DOM 上留任何属性，唯一通用的旁证就是站点把光标改成
 * 了手型。但它会沿 CSS 继承扩散进按钮内部的**装饰层**（glow/ring 罩层、ripple、
 * 进度圈）：装饰层没有子元素、中心点被同层兄弟覆盖，学成回放目标后 `realClick`
 * 的遮挡预检必然失败。所以弱命中只作兜底 —— 扫完整条祖先链没有强命中时才用它。
 * 排除 `<html>`/`<body>`，避免整页被判成按钮。
 */
function isWeakClickTarget(el: HTMLElement): boolean {
  if (el === document.body || el === document.documentElement) return false;
  try {
    return getComputedStyle(el).cursor === 'pointer';
  } catch {
    // 没有布局引擎的环境（jsdom）读不到计算样式，忽略即可。
    return false;
  }
}

/** 可编辑控件：`<input>`/`<textarea>`，或 `contenteditable` 富文本宿主。 */
type EditableElement = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

/** `contenteditable=""` / `contenteditable="true"` 的元素才算可编辑宿主（`"false"`/`"inherit"` 不算）。 */
function isContentEditableHost(el: HTMLElement): boolean {
  const attr = el.getAttribute('contenteditable');
  return attr === '' || attr?.toLowerCase() === 'true';
}

/** 这是个可编辑控件吗？（供 composedPath 类型收窄用） */
function isEditableElement(target: EventTarget | null): target is EditableElement {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true;
  return target instanceof HTMLElement && isContentEditableHost(target);
}

/**
 * 只读「里面有没有内容」这一个布尔 —— **绝不读取值本身**。
 *
 * input/textarea 读 `value`，contenteditable 读 `textContent`：两者都只用于判断
 * `hasValue`，值本身既不返回也不上报（里面可能是验证码、邀请码或被误填的密码）。
 */
function editableHasContent(el: EditableElement): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return !!el.value.trim();
  }
  return !!(el.textContent ?? '').trim();
}

/**
 * 验证码/OTP/二次验证字段判定。
 *
 * 只用于在学习结束时告诉用户「这类字段不会被学习、回放要人工处理」，
 * 判定结果**不携带任何字段名、选择器或值**，避免把验证控件细节写进配置。
 */
/**
 * 语义上「一眼就是验证码/OTP」的字段：autocomplete=one-time-code，或
 * 名称/标签命中验证码、动态码、token、secret 这类固定词表。
 *
 * 刻意**不含** `inputMode === 'numeric'`：签到页上的数字输入（数量、金额、期数）
 * 也是 numeric，把整类判成验证码会让融合学习丢掉真实的一步，还会误报验证码提示。
 */
function isChallengeLookingInput(target: EditableElement): boolean {
  if (!(target instanceof HTMLInputElement)) return false;
  const semantic = [
    target.name,
    target.id,
    target.autocomplete,
    target.getAttribute('aria-label') ?? '',
    target.placeholder,
    ...(target.labels ? [...target.labels].map((label) => label.textContent ?? '') : []),
  ].join(' ');
  return target.autocomplete === 'one-time-code' || LOGIN_NON_CREDENTIAL_HINT.test(semantic);
}

function isChallengeInput(target: EditableElement): boolean {
  if (!(target instanceof HTMLInputElement)) return false;
  return isChallengeLookingInput(target) || target.inputMode === 'numeric';
}

function loginFieldRole(target: EditableElement): 'username' | 'password' | undefined {
  if (!(target instanceof HTMLInputElement)) return undefined;
  const semantic = [
    target.name,
    target.id,
    target.autocomplete,
    target.getAttribute('aria-label') ?? '',
    target.placeholder,
    ...(target.labels ? [...target.labels].map((label) => label.textContent ?? '') : []),
  ].join(' ');
  if (LOGIN_NON_CREDENTIAL_HINT.test(semantic) || target.autocomplete === 'new-password') return undefined;
  if (target.type === 'password' || target.autocomplete === 'current-password') return 'password';
  if (target.autocomplete === 'username'
    || target.type === 'email'
    || target.type === 'tel'
    || LOGIN_IDENTIFIER_HINT.test(semantic)) {
    return 'username';
  }
  return undefined;
}

function loginActionFor(
  target: HTMLElement,
  label: string,
  href: string | undefined,
  passwordSeen: boolean,
): 'entry' | 'submit' | 'oauth' | undefined {
  const hint = `${label} ${target.getAttribute('aria-label') ?? ''} ${href ?? ''}`;
  if (LOGIN_OAUTH_HINT.test(hint)) return 'oauth';
  /*
   * `nativeSubmit` 只认**显式**声明的提交控件。
   *
   * 绝不能按 `target.type === 'submit'` 判：HTML 里 `<button>` 没写 type 时
   * 默认值就是 submit，于是每个普通按钮都会被判成登录提交。融合学习下
   * 这个误判是致命的 —— 签到编译器按 `loginAction === 'submit'` 过滤凭据动作，
   * 于是一颗「立即签到」按钮被当成登录提交丢掉，整份流程编译成 null，
   * 用户看到的是「还没有录到可识别的签到动作」，而他明明点过。
   * 只认源码里写明的 type="submit"/"image"，才既有据可依又不会误伤。
   */
  const declaredSubmit = target.getAttribute('type');
  const nativeSubmit = (target instanceof HTMLButtonElement || target instanceof HTMLInputElement)
    && (declaredSubmit === 'submit' || declaredSubmit === 'image');
  /*
   * 表单里的按钮同理：必须同时有「提交语义」的证据（type=submit/image 或文案命中
   * 登录提交词），不能仅凭「在 <form> 里」就判成登录提交 —— 搜索框、筛选表单、
   * 以及站点把签到按钮放进 form 的写法都会被误伤。
   */
  if (nativeSubmit) return 'submit';
  if (passwordSeen && LOGIN_SUBMIT_HINT.test(label)) return 'submit';
  if (LOGIN_ENTRY_HINT.test(label)) return 'entry';
  return undefined;
}

export interface LearningCaptureOptions {
  /** 上报一个事件；上报失败不影响页面本身。 */
  onEvent: (event: LearningEventWithChange) => void;
  /**
   * 演示账号自己的名字。流程站内所有账号共用，按名字生成的选择器（`text=alice`）
   * 换个账号就找不到，所以采集时跳过这一档、改用结构化路径。
   */
  personalTexts?: readonly string[];
  /** 动作之后等界面稳定的时间，默认 `LEARNING_SETTLE_MS`。 */
  settleMs?: number;
  /** 滚动停止的判定窗口，默认 `LEARNING_SCROLL_STOP_MS`；测试可缩短。 */
  scrollStopMs?: number;
  /**
   * 采集档位。
   *
   * - \`login\`：只采凭据字段（fieldRole）与入口/提交/OAuth 动作；
   * - \`checkin\` / \`both\`：**融合采集** —— 既记录登录后的完整动作流（点击/滚动/
   *   普通输入），也把凭据字段的 fieldRole 一并记下。同一份事件流随后分别喂给
   *   \`buildLearnedLoginSettings\` 与 \`buildLearnedWorkflow\`，一次演示产出两份产物。
   *
   * 缺省按 \`checkin\` 处理（兼容旧会话）。
   */
  kind?: LearningKind;
}

interface PendingFill {
  selector: string;
  label: string;
  path: string;
  at: number;
  before: string[];
  /** 当下这个输入框里**有没有内容** —— 只记布尔，绝不记值本身。 */
  hasValue: boolean;
  fieldRole?: 'username' | 'password';
  /** 输入开始之前用户滚到了哪里：输入框也常在视口下方。 */
  scroll: LearnScrollState;
  /** 在输入框里按下的非打印功能键（如 Enter 提交）：只记键名，绝不记可打印字符。 */
  key?: WorkflowKey;
  /** 录制时控件的身份指纹。 */
  fingerprint?: WorkflowElementFingerprint;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * 学习采集器：把用户真实做过的一遍操作采集为事件流。
 *
 * 采集三类事件，每一步都能回答「我点击/输入了什么、界面出现了什么、我跳到了哪个网站」：
 * - `navigation`：当前页 path（含 SPA 的 pushState/replaceState/hashchange/首次加载）；
 * - `click`：控件选择器、限长可见标签、所在 path、跳转目标 href、动作后的界面变化；
 * - `fill`：输入框选择器、限长标签、所在 path、`hasValue`（**绝不采集输入值本身**）、
 *   动作后的界面变化。
 *
 * 「界面出现了什么」用两次可见文本快照的差集算出来，只保留限长限量的片段与有限关键词。
 * 变化证据以**相同 `at` 的后续上报**发出：编译器把它挂回原动作，一次动作始终只有一步。
 */
export class LearningCapture {
  private readonly onEvent: (event: LearningEventWithChange) => void;
  private readonly settleMs: number;
  private readonly scrollStopMs: number;
  private readonly learningKind: LearningKind;
  /**
   * 是否按「融合采集」跑：完整的登录后动作流 + 凭据字段语义同时采集。
   *
   * \`checkin\` 与 \`both\` 都是融合采集；只有显式的 \`login\` 走旧的「只采登录语义」。
   */
  private readonly fused: boolean;
  private readonly pending = new Set<() => void>();
  private readonly restoreHistory: Array<() => void> = [];
  private lastPath = '';
  private navigationTimer: ReturnType<typeof setInterval> | null = null;
  private attached = false;
  /** 正在输入的控件：settle 之后才上报最终 hasValue，避免逐字上报。 */
  private pendingFill: PendingFill | null = null;
  /** 滚动去抖：`scrollStop` 到点后把「滚到哪了」定成最终位置。 */
  private scrollTimer: ReturnType<typeof setTimeout> | null = null;
  /** 去抖合并后的最终滚动位置：只保留最后停下的地方。 */
  private pendingScroll: LearnScrollState | null = null;
  /** 还没被任何动作「消费」掉的滚动：消费后立即清空。 */
  private scrollState: LearnScrollState | null = null;
  private passwordSeen = false;
  /** 本次登录学习中是否出现过验证码/OTP 字段（只记布尔，绝不记值）。 */
  private challengeSeen = false;
  /**
   * 最近一次指针按压的起点：松手时用它判断这次手势是不是「拖拽」。
   * 只存坐标与元素引用，不存任何页面内容。
   */
  private pointerDown: { x: number; y: number; target: Element | null; at: number } | null = null;
  /** mouse 族的按下点，与 pointer 族分开存：两族都派发时不能互相覆盖。 */
  private mouseDown: { x: number; y: number; target: Element | null; at: number } | null = null;
  /** 最近一次指针松开：拖拽松手后浏览器补发的那次 click 要按它转成「拖拽一步」。 */
  private pointerUp: {
    dragged: boolean;
    downTarget: Element | null;
    upTarget: Element | null;
    at: number;
    /**
     * 这次拖拽是否已经在 `pointerup/mouseup` 当场落盘。
     *
     * 有些站点（排序库、自定义滑轨）在 `pointerdown` 上调用 `preventDefault()`，
     * 浏览器因此**不会**补发 mousedown/mouseup/click —— 只等 click 尾巴的话，
     * 这类拖拽永远学不到。所以在指针抬起时先落盘；若随后仍收到补发的 click，
     * 只把它消费掉，绝不重复记一步。
     */
    recorded?: boolean;
    /** 按压起点坐标：拖拽事件要回到起点控件，并把落点换算进目标内。 */
    downX: number;
    downY: number;
    /** 松开点坐标：换算 dragToAnchor 用。 */
    upX: number;
    upY: number;
    /** 按压时长（毫秒）：≥ 阈值视为长按，用于普通点击的 gesture/holdMs。 */
    holdMs: number;
  } | null = null;
  /**
   * 最近一次按下的**非打印**功能键（Enter/Space/Escape/Tab/方向键）。
   * 浏览器会把 button 上的 Enter/Space 派发成合成 click：采集侧把它挂回那一下，
   * 让「用键盘提交」与「用鼠标点」区分开。可打印字符一律不记（输入内容红线）。
   */
  private pendingKey: { key: WorkflowKey; target: EventTarget | null; at: number } | null = null;

  /**
   * 这次演示里**识别到但有意不学**的动作。
   *
   * 目前有两类：滑块验证/装饰把手的拖拽，以及人机验证控件上的点击 —— 回放时均由
   * 自动破解管线接管，录成业务步骤只会在回放时找不到早已消失的控件。学习报告会
   * 显式提示它们，不让用户以为「我操作过了，扩展一定学到了」。
   */
  private readonly unlearned: string[] = [];

  /**
   * 演示账号自己的名字：选择器不按它们生成（见 `learningSelector`）。
   *
   * 签到类文案（「签到」「Daily Check-in」）永远不算名字：用户名恰好是常见词时，
   * 不能让真正的签到按钮丢掉它最稳的文字选择器。
   */
  private readonly isPersonal: (value: string | undefined) => boolean;

  constructor(options: LearningCaptureOptions) {
    this.onEvent = options.onEvent;
    this.settleMs = options.settleMs ?? LEARNING_SETTLE_MS;
    this.scrollStopMs = options.scrollStopMs ?? LEARNING_SCROLL_STOP_MS;
    this.learningKind = options.kind ?? 'checkin';
    this.fused = this.learningKind !== 'login';
    const matchesName = personalTextMatcher(options.personalTexts);
    this.isPersonal = (value) => !CHECKIN_LABEL.test(value ?? '') && matchesName(value);
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    document.addEventListener('click', this.onClick, true);
    document.addEventListener('contextmenu', this.onContextMenu, true);
    document.addEventListener('input', this.onInput, true);
    document.addEventListener('change', this.onInput, true);
    document.addEventListener('keydown', this.onKeyDown, true);
    // 拖拽判定只需要按下/松开的坐标：滑块拖完松手时浏览器会补发一次 click，
    // 靠这对坐标识别出「这是拖拽的尾巴」，不把它录成点击。pointer 事件覆盖触摸，
    // mouse 事件覆盖所有环境（jsdom 单测也派发 mouse 事件）。
    document.addEventListener('pointerdown', this.onPointerDown, true);
    document.addEventListener('pointerup', this.onPointerUp, true);
    document.addEventListener('mousedown', this.onPointerDown, true);
    document.addEventListener('mouseup', this.onPointerUp, true);
    // 捕获阶段监听 `scroll`：它不冒泡，而用户真正滚下去的常常是站点自己的滚动容器
    // （`overflow: auto` 的列表/面板），挂在 document 上的捕获监听能一起收到。
    document.addEventListener('scroll', this.onScroll, true);
    // 整页滚动在 Chrome 中通常以 window 为事件目标，不一定经过 document 的捕获链。
    // 两处都监听才能覆盖 window/document/站点内部滚动容器；onScroll 会按位置去抖，
    // 同一帧重复收到的事件只会更新同一个 pending 状态，不会多生成学习动作。
    window.addEventListener('scroll', this.onScroll, true);
    window.addEventListener('popstate', this.recordNavigation);
    window.addEventListener('hashchange', this.recordNavigation);
    // pushState/replaceState **不会**触发 popstate，不补记的话用户点进签到页那一步
    // 就整段丢失，路线停在登录落地页。包装只做转发和记录，不改参数与返回值。
    this.restoreHistory.push(this.wrap('pushState'), this.wrap('replaceState'));
    // 扩展在 isolated world，页面主世界的 pushState 不会经过这里的包装。
    // 只在录制期间轮询地址，并在动作采集前同步检查，补上真正的 SPA 导航。
    this.navigationTimer = setInterval(this.recordNavigation, 200);
    this.recordNavigation();
  }

  detach(): void {
    if (!this.attached) return;
    // 先结算再摘监听器：用户常常是「看到成功提示 → 点结束学习」，最后那一击的界面变化
    // 正是最关键的证据。摘了监听器再结算就来不及发出去，录制会缺最后一笔。
    // （滚动没有「最后那一笔」要补：它只有在被某个动作引用时才进入录制。）
    this.flushPending();
    this.attached = false;
    if (this.navigationTimer) clearInterval(this.navigationTimer);
    this.navigationTimer = null;
    document.removeEventListener('click', this.onClick, true);
    document.removeEventListener('contextmenu', this.onContextMenu, true);
    document.removeEventListener('input', this.onInput, true);
    document.removeEventListener('change', this.onInput, true);
    document.removeEventListener('keydown', this.onKeyDown, true);
    document.removeEventListener('pointerdown', this.onPointerDown, true);
    document.removeEventListener('pointerup', this.onPointerUp, true);
    document.removeEventListener('mousedown', this.onPointerDown, true);
    document.removeEventListener('mouseup', this.onPointerUp, true);
    document.removeEventListener('scroll', this.onScroll, true);
    window.removeEventListener('scroll', this.onScroll, true);
    window.removeEventListener('popstate', this.recordNavigation);
    window.removeEventListener('hashchange', this.recordNavigation);
    for (const restore of this.restoreHistory) restore();
    this.restoreHistory.length = 0;
  }

  /**
   * 立刻结算所有挂起的检查并清空定时器。
   *
   * 停止录制时调用：否则 detach 之后仍有一个定时器在跑，会把用户结束学习之后的
   * 界面变化补报进已经结束的会话。测试也用它替代真实的 700ms 等待。
   */
  /** 本次登录学习中是否出现过验证码/OTP 字段（仅布尔，绝不暴露字段细节）。 */
  get sawChallengeField(): boolean {
    return this.challengeSeen;
  }

  /** 本次演示里「识别到但有意不学」的动作说明（固定文案，含任何页面内容）。 */
  get unlearnedNotes(): readonly string[] {
    return this.unlearned;
  }

  flushPending(): void {
    if (this.attached) this.recordNavigation();
    const tasks = [...this.pending];
    this.pending.clear();
    const fill = this.pendingFill;
    this.pendingFill = null;
    if (fill) {
      if (fill.timer) clearTimeout(fill.timer);
      this.emitFill(fill, true);
    }
    // 滚动去抖也要能立刻结算：用户滚完就点了结束学习，那一下滚动不能丢。
    this.flushScroll();
    for (const task of tasks) task();
  }

  /**
   * 滚动监听（捕获阶段，事件不冒泡也能收到滚动容器）。
   *
   * 这里**只更新时间戳与待定位置，不上报任何事件**：滚动自己不是一个动作，
   * 用户滚十下不该产生十步。位置被记下来，等下一个动作（点击/输入）发生时挂上去。
   */
  private onScroll = (event: Event): void => {
    if (!this.attached) return;
    this.recordNavigation();
    this.pendingScroll = learnScrollState(event.target instanceof HTMLElement ? event.target : undefined);
    if (this.scrollTimer) clearTimeout(this.scrollTimer);
    // 去抖：连续静默 scrollStopMs 才认为「这次滚动结束了」，只留最终位置。
    this.scrollTimer = setTimeout(() => {
      this.scrollTimer = null;
      this.settleScroll();
    }, this.scrollStopMs);
  };

  /** 立刻结算滚动去抖（停止录制时调用，语义与 `flushPending` 一致）。 */
  private flushScroll(): void {
    if (this.scrollTimer) {
      clearTimeout(this.scrollTimer);
      this.scrollTimer = null;
    }
    this.settleScroll();
  }

  private settleScroll(): void {
    if (!this.pendingScroll) return;
    const state = this.pendingScroll;
    this.pendingScroll = null;
    // 页面已被滚回顶部：用户看到的和没滚过一样，不该在步骤里留下滚动。
    if (!state.pageY && !state.scrolled) {
      this.scrollState = null;
      return;
    }
    this.scrollState = state;
    // 纯滚动也是真实的一步：用户「滚下去看内容再找按钮」不该整段丢失。
    // 在确定「确实滚过」时额外上报一条 scroll 事件；回放时按比例还原真实像素。
    // 这条事件**不参与** takeScroll 的「动作前滚动」消费（takeScroll 只服务于
    // click/fill 的 scrollIntoView），两者互不影响。
    const ratio = state.scrollContainer !== undefined
      ? state.containerRatio
      : state.ratio;
    if (ratio !== undefined && Number.isFinite(ratio) && ratio > 0 && this.attached) {
      this.onEvent({
        type: 'scroll',
        path: currentPath(),
        ratio: Math.min(1, Math.max(0, ratio)),
        ...(state.scrollContainer ? { container: state.scrollContainer } : {}),
        at: Date.now(),
      });
    }
  }

  /**
   * 取走待附加的滚动信息。**只给紧随其后的那个动作**：它描述的就是「这个动作发生前
   * 页面在哪」，后面的动作重复带同一个位置没有任何增量信息。
   *
   * 连「还没到去抖时间」的那次滚动也一并取走：用户滚完立刻点按钮时，`scroll` 事件与
   * `click` 之间往往还不到 `scrollStopMs`，但那正是最典型的一次「先滚再点」。
   * 取走时顺手撤掉定时器，防止它稍后把已经用掉的滚动位置又挂到下一个动作上。
   */
  private takeScroll(): LearnScrollState | null {
    const state = this.pendingScroll ?? this.scrollState;
    this.scrollState = null;
    this.pendingScroll = null;
    if (this.scrollTimer) {
      clearTimeout(this.scrollTimer);
      this.scrollTimer = null;
    }
    return state;
  }

  /**
   * 沿 composedPath（由内向外）选出录制目标，两档强度：
   *
   * 1. **强命中**（语义控件 / 可交互属性）立即返回：点在按钮里的图标/文字上时，
   *    命中的是那个小元素而不是整张卡片，回放点击照样冒泡到真正的处理器；
   * 2. **弱命中**（仅 cursor:pointer，通常是继承手型光标的装饰罩层）先临时记住，
   *    继续往外扫；整条链都没有强命中（纯 cursor 的自制控件）才回退到它，保证
   *    这类无强祖先的控件不被漏采。
   *
   * 都没有返回 null。装饰层因此让位给外包的按钮本体，不再学出「回放 realClick
   * 遮挡预检注定失败」的装饰层步骤。
   */
  private currentElement(event: Event): HTMLElement | null {
    let weak: HTMLElement | null = null;
    for (const item of event.composedPath()) {
      // 非 HTMLElement（如 SVG）没有匹配语义，照旧跳过。
      if (!(item instanceof HTMLElement)) continue;
      if (isStrongClickTarget(item)) return item;
      if (!weak && isWeakClickTarget(item)) weak = item;
    }
    return weak;
  }

  private recordNavigation = (): void => {
    const path = currentPath();
    if (path === this.lastPath) return;
    this.lastPath = path;
    this.takeScroll();
    this.onEvent({ type: 'navigation', path, at: Date.now() });
  };

  private wrap = (method: 'pushState' | 'replaceState'): (() => void) => {
    const original = history[method];
    const recordNavigation = this.recordNavigation;
    const patched = function patched(this: History, ...args: Parameters<History['pushState']>) {
      const result = original.apply(this, args);
      // 地址栏已经变了才记录；同一路径的重复调用不该产生新事件。
      recordNavigation();
      return result;
    };
    history[method] = patched as History[typeof method];
    return () => { history[method] = original; };
  };

  /** 安排一次「动作之后界面稳了没有」的检查。 */
  private schedule(task: () => void, delayMs = this.settleMs): void {
    const timer = setTimeout(() => {
      this.pending.delete(run);
      task();
    }, delayMs);
    const run = () => {
      clearTimeout(timer);
      task();
    };
    this.pending.add(run);
  }

  /**
   * 记录指针按压起点。滑块验证是「按下 → 大幅移动 → 松开」；浏览器在按下与松开
   * 落在同一元素（或其后代）上时，会在 mouseup 之后补发一次 click —— 这段状态
   * 就是为了把那一次合成 click 识别出来。只记录坐标与元素引用，不读取页面内容。
   */
  private onPointerDown = (event: MouseEvent): void => {
    const down = {
      x: event.clientX,
      y: event.clientY,
      target: event.target instanceof Element ? event.target : null,
      at: Date.now(),
    };
    // 按事件族分别记：pointerdown 只喂 pointerup，mousedown 只喂 mouseup。
    // 两族混用一个槽位时，后到的那族会把先到那族的坐标覆盖掉，拖拽裁定随之失真。
    if (event.type === 'pointerdown') this.pointerDown = down;
    else this.mouseDown = down;
    // 新手势开始：上一次拖拽的尾巴（还没等到 click 的）不再有效。
    this.pointerUp = null;
  };

  /**
   * 记录一次**非打印**功能键按下；浏览器若随后把它派发成合成 click（button 上按
   * Enter/Space 正是如此），就把 key 挂回那一下。可打印字符一律不记：输入内容
   * 走 fill 的「有没有内容」布尔，绝不进事件流。
   */
  private onKeyDown = (event: KeyboardEvent): void => {
    if (!this.attached) return;
    const key = learningKeyOf(event);
    if (!key) {
      this.pendingKey = null;
      return;
    }
    this.pendingKey = { key, target: event.target, at: Date.now() };
    // 输入框里按功能键（典型：Enter 提交表单）不会触发 click，但它是真实操作：
    // 挂到正在输入的那个 fill 上，让「填完按 Enter 提交」被忠实记录。
    const fill = this.pendingFill;
    if (fill && event.target instanceof Element) {
      const fillTarget = this.findFillTarget(fill.selector);
      if (fillTarget && (fillTarget === event.target || fillTarget.contains(event.target))) {
        fill.key = key;
      }
    }
  };

  /**
   * 取走「紧随这次 click 的那次功能键按下」：键盘触发与鼠标点击只差一次输入处理，
   * 且 click 目标必须是当时获得焦点的那个元素（或其后代）。取走即消费，不会把
   * 同一个键挂到后续无关点击上；没有命中时返回 undefined。
   */
  private takePendingKey(target: HTMLElement): WorkflowKey | undefined {
    const pending = this.pendingKey;
    this.pendingKey = null;
    if (!pending) return undefined;
    if (Date.now() - pending.at > 1_000) return undefined;
    const focused = pending.target instanceof Element ? pending.target : null;
    if (focused !== null && focused !== target && !focused.contains(target) && !target.contains(focused)) {
      return undefined;
    }
    return pending.key;
  }

  private onPointerUp = (event: MouseEvent): void => {
    // 按事件族取自己那一族的按下点：pointerup 用 pointer 族的，mouseup 用 mouse 族的。
    const isPointerFamily = event.type === 'pointerup';
    const down = isPointerFamily ? this.pointerDown : this.mouseDown;
    // 真实浏览器把 pointerup 与 mouseup 成对派发（桌面鼠标同样如此，实测顺序即
    // pointerup 在前、mouseup 在后）：第一条 up 事件已消费掉按下点并算出裁定。
    // 第二条 up 没有新的按下可消费，此时必须保留上一条的裁定——若照旧重算，
    // dragged 会被覆盖成 false，拖拽尾巴的过滤随之失效，松手补发的 click 被误录成步骤。
    // 例外：同族 mouseup 自己跟了一次（touch 环境 pointerup 之后没有 mouseup，
    // 纯鼠标环境 mousedown 之后也可能先 pointerup），那时第二条 up 会把 holdMs
    // 从「按住总时长」错误刷新成 0。用「上次裁定坐标没变」识别这种同族重发，跳过。
    // 上一条 up 已消费按下点（pointerup 与 mouseup 成对派发时）：保留那次裁定，
    // 绝不用「没有按下可消费」的第二条 up 重算 —— 否则 dragged 会被覆盖回 false。
    if (down === null) return;
    if (isPointerFamily) this.pointerDown = null;
    else this.mouseDown = null;
    const dragged = Math.hypot(event.clientX - down.x, event.clientY - down.y) >= LEARNING_DRAG_TOLERANCE_PX;
    // 两族都要能独立判定拖拽：任一族判定为拖拽，它随后的补发 click 就必须被过滤。
    // 若上一族已判定为拖拽，这一族也不能把它改回「单击」（拖拽的事实不会因为
    // 另一族坐标恰好接近按下点而消失）。
    const previouslyDragged = this.pointerUp?.dragged === true
      && Date.now() - (this.pointerUp?.at ?? 0) <= LEARNING_DRAG_TAIL_MS;
    // 同一族的第二条 up（pointer 与 mouse 成对派发）不能重复落盘。
    const alreadyRecorded = this.pointerUp?.recorded === true;
    this.pointerUp = {
      dragged: dragged || previouslyDragged,
      downTarget: down.target,
      upTarget: event.target instanceof Element ? event.target : null,
      at: Date.now(),
      downX: down.x,
      downY: down.y,
      upX: event.clientX,
      upY: event.clientY,
      holdMs: Date.now() - down.at,
    };
    /*
     * 指针抬起当场结算拖拽。
     *
     * 不能只等浏览器补发的 click：站点在 pointerdown 上 preventDefault 时
     * （排序库/自定义滑轨的标准写法）根本不会有 click，拖拽会整条消失 ——
     * 用户以为学到了，回放却什么也不做。
     */
    if (this.attached && this.pointerUp.dragged && !alreadyRecorded) {
      const handled = this.recordDrag(this.pointerUp, event);
      // 标记只在状态仍然存在时写（recordDrag 不清状态，这里保留给补发的 click）。
      if (handled && this.pointerUp) this.pointerUp.recorded = true;
    }
  };

  /**
   * 这一次 click 是拖拽松手后浏览器补发的「尾巴」吗？
   *
   * 三个条件同时成立才算：位移达到拖拽阈值、click 紧随松开（`LEARNING_DRAG_TAIL_MS` 内）、
   * 且 click 落在按下/松开元素的祖先链上（浏览器正是向两者的公共祖先补发 click）。
   * 命中后**返回这次拖拽的信息**（起点/松开点坐标与元素），由 onClick 决定
   * 「记成拖拽一步」还是「识别到但有意不学」；消费掉状态：尾巴只属于紧随其后的那一次 click。
   */
  private dragTailClick(event: MouseEvent): NonNullable<LearningCapture['pointerUp']> | null {
    const up = this.pointerUp;
    if (!up || !up.dragged) return null;
    if (Date.now() - up.at > LEARNING_DRAG_TAIL_MS) return null;
    const clickTarget = event.target instanceof Element ? event.target : null;
    const related = clickTarget !== null
      && [up.downTarget, up.upTarget].some((element) => element !== null
        && (element === clickTarget || element.contains(clickTarget) || clickTarget.contains(element)));
    if (!related) return null;
    this.pointerUp = null;
    return up;
  }

  /**
   * 把一次真实拖拽录成一步 —— 前提是它能被正确回放。
   *
   * 三类情况**绝不静默处理**：
   * 1. 位移小于「值得记成一步」的阈值：按钮内的手抖不算拖拽，按其本来的
   *    点击语义继续走（返回 false，交给 onClick）；
   * 2. 人机验证控件上的拖拽（滑块/Turnstile 等）：回放时由自动破解管线接管，
   *    录成业务步骤只会让回放去拖一个已经消失的把手 —— 记入未学习清单并消费掉；
   * 3. 起终点选择器拿不到稳定形态（拖拽把手、匿名装饰层）：同样记入未学习清单，
   *    绝不静默丢弃，也绝不写出一个回放必落空的选择器。
   */
  private recordDrag(up: NonNullable<LearningCapture['pointerUp']>, event: MouseEvent): boolean {
    const distance = Math.hypot(up.upX - up.downX, up.upY - up.downY);
    // 位移不够：这不是拖拽，按普通点击继续处理。
    if (distance < LEARNING_DRAG_RECORD_PX) return false;
    const from = up.downTarget instanceof HTMLElement
      ? up.downTarget
      : dragEndpoint(event.composedPath());
    const to = up.upTarget instanceof HTMLElement
      ? up.upTarget
      : dragEndpoint(event.composedPath());
    /**
     * 「这条拖拽已被处理」——调用方据此决定是否消费补发的 click。
     *
     * 这里**不**清 pointerUp：状态要留给紧随其后的合成 click 做关联判定
     * （否则一次拖拽会被 pointerup 与 mouseup 两族各记一步）。
     */
    const consumes = (): true => true;
    // 人机验证控件：识别到但有意不学（回放由破解管线接管）。
    if ((from && isChallengeSurfaceTarget(from)) || (to && isChallengeSurfaceTarget(to))) {
      this.unlearned.push('拖拽验证控件：这一步不会写进流程（回放时由自动验证处理）');
      return consumes();
    }
    if (!from || !to || !isDraggableEndpoint(from) || !isDraggableEndpoint(to)) {
      /*
       * 拖拽的两端必须是站点声明可交互/可拖拽的元素，且必须能写成稳定选择器。
       * 把「在按钮上按住、拖到空白处松手」录成步骤，回放时只会乱动页面 ——
       * 明确告诉用户这一步没学到，而不是写一条注定失败或乱跑的步骤。
       */
      this.unlearned.push('这一步拖拽的起点或终点不是可稳定回放的控件，未写进流程');
      return consumes();
    }
    const selector = learningSelector(from, this.isPersonal);
    const toSelector = learningSelector(to, this.isPersonal);
    if (!selector || !toSelector) {
      this.unlearned.push('这一步拖拽没有可回放的稳定选择器，未写进流程');
      return consumes();
    }
    /*
     * 把手噪声：两端命名都带把手/滑块语义，且抬起点仍在起点控件内
     * （滑块把手拖出去再弹回、拖到轨道上但松手仍在把手上）。
     * 这类拖拽由验证破解或站点自身状态机承载，录成业务步骤会让回放
     * 去拖一个不是签到控件的元素。
     */
    const sameElement = to === from || from.contains(to) || to.contains(from);
    if (sameElement && looksLikeDragHandle(from)) {
      this.unlearned.push('识别到一次把手/滑块拖拽：这类拖拽不会写进流程，回放时由站点自身处理');
      return consumes();
    }
    const path = currentPath();
    const at = Date.now();
    const anchor = pointerAnchor(from, up.downX, up.downY);
    const toAnchor = pointerAnchor(to, up.upX, up.upY);
    const recordedScroll = this.takeScroll();
    const currentScroll = learnScrollState(from);
    const scroll = sanitizeScrollFields(scrollEvidenceFields(
      currentScroll.scrolled ? currentScroll : recordedScroll?.pageY ? recordedScroll : currentScroll,
    ));
    /*
     * 动作本身立刻上报：跳转随时会销毁本脚本，晚一步就整段丢失。
     * 界面变化的补报与 click 一样带**同一个 at**，由上层的同一个
     * actionKey 合并回这一步 —— 一次动作始终只有一步。
     */
    const label = learningLabel(from);
    const snapshotBefore = this.learningKind === 'login' ? [] : collectVisibleSnippets();
    this.onEvent({
      ...scroll,
      type: 'drag',
      selector,
      toSelector,
      label,
      path,
      ...(anchor ? { anchor } : {}),
      ...(toAnchor ? { toAnchor } : {}),
      at,
    });
    if (this.learningKind === 'login') return consumes();
    this.schedule(() => {
      if (!this.attached) return;
      if (currentPath() !== path) return;
      const afterText = pageChangeEvidence(snapshotBefore, collectVisibleSnippets(), bodyText());
      const evidence = evidenceFromText(bodyText(), LEARNING_LOTTERY_ACTION.test(label));
      if (!afterText && !evidence) return;
      this.onEvent({
        ...scroll,
        type: 'drag',
        selector,
        toSelector,
        label,
        path,
        ...(afterText ? { afterText } : {}),
        ...(evidence ? { evidence } : {}),
        at,
      });
    });
    return consumes();
  }


  /**
   * 右键点击：浏览器**不**派发 click，只派发 contextmenu。右键是真实操作（打开上下文
   * 菜单、自定义控件的 secondary action），必须录成 gesture: 'right' 的一步。
   */
  private onContextMenu = (event: MouseEvent): void => {
    if (!this.attached) return;
    this.recordNavigation();
    const target = this.currentElement(event);
    if (!target) return;
    if (isChallengeSurfaceTarget(target)) {
      this.unlearned.push('点击人机验证控件：这一步不会写进流程，回放时由自动验证接管，可能需要人工完成');
      return;
    }
    const path = currentPath();
    const selector = learningSelector(target, this.isPersonal);
    const label = learningLabel(target);
    const anchor = pointerAnchor(target, event.clientX, event.clientY);
    const fingerprint = learningFingerprint(target);
    const recordedScroll = this.takeScroll();
    const currentScroll = learnScrollState(target);
    const scroll = sanitizeScrollFields(scrollEvidenceFields(
      currentScroll.scrolled ? currentScroll : recordedScroll?.pageY ? recordedScroll : currentScroll,
    ));
    this.onEvent({
      ...scroll,
      type: 'click',
      selector,
      label,
      path,
      gesture: 'right',
      ...(anchor ? { anchor } : {}),
      ...(fingerprint ? { fingerprint } : {}),
      at: Date.now(),
    });
  };

  private onClick = (event: MouseEvent): void => {
    this.recordNavigation();
    /**
     * 拖拽松手后浏览器补发的合成 click —— **整条过滤，不录成任何步骤**。
     *
     * 为什么不是「录成 drag 步骤」：这类补发的 click 落点常常是**拖拽把手本身**
     * （滑块弹回原位、或松手位置仍在把手上）。把它录成一步，回放就会去「点/拖」
     * 那个把手，而把手根本不是签到控件 —— 实测回归：学习产物里出现
     * `#pull-knob` 步骤，回放卡住或静默无效，而真正的签到按钮被挤掉。
     *
     * 真正的拖拽（学习侧需要重放的那种）由显式的拖拽路径承载；这里只负责
     * 不把噪声写进流程。宁可少录一步，也不把把手当成按钮。
     */
    const drag = this.dragTailClick(event);
    if (drag) {
      // 已在 pointerup 当场结算过：这里只消费掉这条补发的尾巴，绝不重复记一步。
      if (drag.recorded === true) {
        this.pointerUp = null;
        return;
      }
      if (this.recordDrag(drag, event)) {
        this.pointerUp = null;
        return;
      }
      // recordDrag 拒绝（位移不足 / 端点不可回放）时按普通点击继续处理。
      this.pointerUp = null;
    }
    const target = this.currentElement(event);
    if (!target) return;
    // 人机验证控件（滑块/Turnstile/reCAPTCHA/hCaptcha）的任何交互同理：回放侧由
    // 自动破解管线接管，录制侧识别到就跳过，绝不录成工作流步骤；但要留下可见提示，
    // 否则用户点过验证控件却不知道这一步没学到、回放时可能需要人工完成。
    if (isChallengeSurfaceTarget(target)) {
      this.unlearned.push('点击人机验证控件：这一步不会写进流程，回放时由自动验证接管，可能需要人工完成');
      return;
    }
    const rawHref = target instanceof HTMLAnchorElement ? target.href : undefined;
    if (rawHref && /^(?:javascript:|mailto:|tel:)/i.test(rawHref)) return;
    const href = rawHref ? safeLearningHref(rawHref) : undefined;
    const path = currentPath();
    const selector = learningSelector(target, this.isPersonal);
    const label = learningLabel(target);
    /**
     * 融合采集时也要给点击打登录角色（entry/submit/oauth）：登录编译器靠它挑入口与
     * 提交按钮，而它同时**不影响**签到编译器 —— 后者按 isAuthAction 过滤认证页动作。
     * 旧行为是只有 login 档位打这个标签，融合后必须一直打。
     */
    const loginAction = this.fused || this.learningKind === 'login'
      // 先从控件文案判定角色，再用脱敏标签落盘，否则「使用账号密码登录」
      // 会因含「密码」而丢失 entry 角色，截断多级登录入口。这里只输出角色枚举。
      ? loginActionFor(target, learningLabelText(target), href, this.passwordSeen)
      : undefined;
    const at = Date.now();
    const before = this.learningKind === 'login' ? [] : collectVisibleSnippets();
    // 用户是「先滚到按钮看得见、再点」的：滚动信息跟着这一次点击走。
    // 上报前统一钉上限长，越界值直接丢掉（绝不把超大值写进录制记录）。
    const recordedScroll = this.takeScroll();
    const currentScroll = learnScrollState(target);
    const scroll = sanitizeScrollFields(scrollEvidenceFields(
      currentScroll.scrolled ? currentScroll : recordedScroll?.pageY ? recordedScroll : currentScroll,
    ));

    // 「怎么点的」契约字段：落点、手势、键盘、长按、拖拽终点、指纹。
    // 全部可选，缺省等价于「中心单击左键」，旧流程行为不变。
    const anchor = pointerAnchor(target, event.clientX, event.clientY);
    // 手势：双击 > 右键 > 长按；普通单击左键不写 gesture（旧行为）。
    const holdMs = this.pointerUp?.holdMs ?? (this.pointerDown ? at - this.pointerDown.at : undefined);
    let gesture: WorkflowGesture | undefined;
    if (event.detail >= 2) gesture = 'double';
    else if (event.button === 2) gesture = 'right';
    else if (holdMs !== undefined && holdMs >= 500) gesture = 'long-press';
    // 键盘触发：button 上按 Enter/Space 会被浏览器派发成合成 click，把它挂回来。
    const key = this.takePendingKey(target);
    const fingerprint = learningFingerprint(target);
    // 动作本身立刻上报：跳转随时会销毁本脚本，晚一步就整段丢掉。
    this.onEvent({
      ...scroll,
      type: 'click',
      selector,
      label,
      path,
      ...(href ? { href } : {}),
      ...(loginAction ? { loginAction } : {}),
      ...(anchor ? { anchor } : {}),
      ...(gesture ? { gesture } : {}),
      ...(key ? { key } : {}),
      ...(gesture === 'long-press' && holdMs !== undefined ? { holdMs } : {}),
      ...(fingerprint ? { fingerprint } : {}),
      at,
    });
    // 纯登录学习只需要受限的控件语义（选择器/角色），不把登录后页面文字或结果
    // 片段写进会话；融合学习则要继续采「界面出现了什么」，签到编译器依赖它做断言。
    if (this.learningKind === 'login') return;
    // 界面变化晚一点补报（带同一个 at）：用户点完页面异步渲染出的文字才看得到。
    const reportChange = () => {
      if (!this.attached) return;
      // 已经整页跳走，这一步的变化就是「跳到了哪个网站」，由 navigation 事件承载。
      if (currentPath() !== path) return;
      const afterText = pageChangeEvidence(before, collectVisibleSnippets(), bodyText());
      const evidence = evidenceFromText(bodyText(), LEARNING_LOTTERY_ACTION.test(label));
      if (!afterText && !evidence) return;
      this.onEvent({
        ...scroll,
        type: 'click',
        selector,
        label,
        path,
        ...(href ? { href } : {}),
        ...(afterText ? { afterText } : {}),
        ...(evidence ? { evidence } : {}),
        at,
      });
    };
    this.schedule(reportChange);
    // 抽奖动画常晚于普通 DOM 稳定窗口。只补报同一个动作，绝不重复点击；
    // 结束学习时 flushPending 也会采样，避免把尚未开奖的占位文案学成成功。
    if (LEARNING_LOTTERY_ACTION.test(label)) {
      for (const delay of [2_500, 6_000, 12_000]) this.schedule(reportChange, delay);
    }
  };

  /**
   * 输入采集。
   *
   * 融合采集（`checkin` / `both`）的两条语义在这里**同时**成立：
   * 1. 凭据字段仍然只记 fieldRole 与选择器（登录编译器用它；值绝不采集）；
   * 2. 登录之后的普通输入照旧走完整动作流（签到编译器用它）。
   *
   * 唯一的例外是验证码/OTP：它既不是可回放的登录字段，也不是签到步骤，
   * 只把「出现过」这一个布尔记下来，选择器、标签、值一律不采。
   */
  private onInput = (event: Event): void => {
    this.recordNavigation();
    const target = event.composedPath().find(isEditableElement);
    if (!target || !isVisibleElement(target)) return;
    /**
     * 验证码/OTP 字段只标记「出现过」，绝不采集值、选择器或标签内容。
     *
     * 判据用精确档（`isChallengeLookingInput`）而不是含 `inputMode=numeric` 的宽档：
     * 融合学习里数字输入太常见（数量/金额/期数），按宽档判会一边丢动作、一边误报。
     */
    if (isChallengeLookingInput(target)) {
      this.challengeSeen = true;
      return;
    }
    const fieldRole = this.fused || this.learningKind === 'login' ? loginFieldRole(target) : undefined;
    if (this.learningKind === 'login' && !fieldRole) return;
    if (fieldRole === 'password') this.passwordSeen = true;
    /**
     * 带凭据角色的字段（username/password）会照常落一条 fill 事件，但只带 fieldRole
     * 与选择器 —— **绝不采集输入值**。它不会污染签到流程：`buildLearnedWorkflow`
     * 按 fieldRole 与认证页双重过滤，登录动作永远不会被回放进签到。
     */

    const selector = learningSelector(target, this.isPersonal);
    const label = learningLabel(target);
    const path = currentPath();
    const hasValue = editableHasContent(target);
    const pending = this.pendingFill;
    if (pending && pending.selector === selector && pending.path === path) {
      pending.hasValue = hasValue;
      if (pending.timer) clearTimeout(pending.timer);
      pending.timer = this.scheduleFill(pending);
      return;
    }
    if (pending?.timer) clearTimeout(pending.timer);
    const fill: PendingFill = {
      selector,
      label,
      path,
      at: Date.now(),
      before: collectVisibleSnippets(),
      hasValue,
      ...(fieldRole ? { fieldRole } : {}),
      // 输入框也常在视口下方：用户先滚下去才点得进来。
      scroll: learnScrollState(target),
      fingerprint: learningFingerprint(target),
    };
    fill.timer = this.scheduleFill(fill);
    this.pendingFill = fill;
    // 输入过程中立即上报一次（hasValue 是当下的真实状态）：用户的动作顺序不能被延时上报打乱。
    // settle 之后再补报最终状态与界面变化，两者 at 相同，编译器会挂回同一个动作。
    this.emitFill(fill, false);
  };

  /**
   * 输入结束后结算。
   *
   * `change`（离开输入框/提交表单）本来就更早触发，但为了不依赖浏览器差异，
   * 统一按 settleMs 防抖：用户可能连打几十个字，逐字上报会把事件上限吃满。
   */
  private scheduleFill(fill: PendingFill): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      if (this.pendingFill === fill) this.pendingFill = null;
      this.emitFill(fill, true);
    }, this.settleMs);
  }

  /** 上报一次 fill。`settled=false` 是「刚打了第一个字」的即时上报。 */
  private emitFill(fill: PendingFill, settled: boolean): void {
    if (!this.attached) return;
    let hasValue = fill.hasValue;
    if (settled) {
      // 结算时以输入框的**最终有无内容**为准（用户可能又把内容清空）；同样只读布尔值。
      const element = this.findFillTarget(fill.selector);
      if (element) hasValue = editableHasContent(element);
    }
    const afterText = settled && !fill.fieldRole && currentPath() === fill.path
      ? pageChangeEvidence(fill.before, collectVisibleSnippets(), bodyText())
      : undefined;
    // 上报（含结算补报）之前统一把滚动值钉上限长；越界值直接丢掉，绝不落盘。
    const scroll = sanitizeScrollFields(scrollEvidenceFields(fill.scroll));
    this.onEvent({
      ...scroll,
      type: 'fill',
      selector: fill.selector,
      label: fill.label,
      path: fill.path,
      // **绝不采集输入值本身**：只上报「里面有没有内容」。
      hasValue,
      ...(fill.fieldRole ? { fieldRole: fill.fieldRole } : {}),
      // 输入框里按下的功能键（如 Enter 提交）：键名不是输入内容，属于「怎么提交的」。
      ...(fill.key ? { key: fill.key } : {}),
      ...(fill.fingerprint ? { fingerprint: fill.fingerprint } : {}),
      ...(afterText ? { afterText } : {}),
      at: fill.at,
    });
  }

  /** 用选择器回找可编辑控件，只读「有没有内容」这一个布尔，不读取值的内容。 */
  private findFillTarget(selector: string): EditableElement | null {
    if (selector.startsWith('text=') || selector.includes(',')) return null;
    try {
      const found = document.querySelector(selector);
      if (found instanceof HTMLInputElement || found instanceof HTMLTextAreaElement) return found;
      return found instanceof HTMLElement && isContentEditableHost(found) ? found : null;
    } catch {
      return null;
    }
  }
}


