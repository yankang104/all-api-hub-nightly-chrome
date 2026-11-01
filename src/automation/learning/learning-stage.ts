/**
 * 学习引导的**阶段判定**（纯函数）。
 *
 * 用户演示「融合学习」时最容易踩的两个坑：
 *  1) 演示做到一半就点「结束学习」，只学到半条流程；
 *  2) 走错页面（点了「退出登录」），录到的是一段未登录状态下的操作。
 *
 * 这里把「已采集到的事件」翻译成用户看得懂的当前阶段。判定**只读事件**，
 * 不看页面内容、不猜站点形态：没有证据就停在上一阶段，绝不提前宣称「已签到」。
 *
 * 与 `automation/learning/learning.ts`（编译器）的分工：那边决定「这份录制能不能
 * 编译成流程」，这里只决定「现在该提示用户做什么」。因此本文件的判据刻意保守 ——
 * 宁可多提示一步，也不让用户以为录全了。
 */
import type { LearningKind, WorkflowLearningEvent } from '@/types';

/**
 * 融合学习（`both`）与签到学习走同一套采集/编译语义（见 types/workflow.ts 的
 * `LearningKind` 注释），因此引导与判定也共用同一路：登录 → 资料页 → 签到 → 结束。
 */
function isFusedLearning(kind: LearningKind): boolean {
  return kind !== 'login';
}
import { isKnownBusinessLearningPath } from './learning-paths';

/** `#/x` 形态的哈希路由（站点所有页面的 pathname 都是 `/`，路由只在 hash 里）。 */
function hashRouteOf(path: string): string {
  const index = path.indexOf('#');
  if (index < 0) return '';
  const hash = path.slice(index + 1);
  return hash.startsWith('/') ? hash : '';
}

/** 认证页：`/login`、`/sign-in`、`/auth/callback`；哈希路由同样判定。 */
const AUTH_PATH = /(?:^|\/)(?:login|log-in|signin|sign-in|signup|sign-up|register|oauth|authorize|auth|password|reset|forgot)(?:\/|$)/i;
/** 退出登录页：它既是「会话已作废」的证据，也是用户走错路的证据。 */
const LOGOUT_PATH = /(?:^|\/)(?:logout|log-out|signout|sign-out)(?:\/|$)/i;
/** 个人资料类页面（以资料词收尾的形态）。 */
const PROFILE_LEAF = /(?:^|\/)(?:profile|personal|account|user|me)\/?$/i;
/**
 * 明显不看当前账号的页（设置 / 账单 / 密钥 / 安全…）。
 *
 * 与学习编译器的 `PROFILE_PATH_EXCLUDE` 同一口径：`/settings/profile` 这类
 * 「先被排除词命中、最后落在资料页上」的形态要放行，纯 `/settings` 要挡掉 ——
 * 否则浮层会在一个看不到账号的页面上催用户「请完成一次签到」。
 */
const PROFILE_EXCLUDE = /(?:^|\/)(?:settings?|preferences?|config|billing|payments?|invoices?|subscription|plans?|pricing|orders?|usage|logs?|tokens?|keys?|api-?keys?|security|passwords?|passkeys?|2fa|mfa|notifications?|invites?|affiliate|referrals?)(?:\/|$)/i;
/**
 * 签到类页面：卡片式站点把账号与签到按钮放在同一页上。
 *
 * lottery / draw 是具体站点的签到落地页（一梦五千年用 /lottery 抽奖代替
 * 每日签到）。它们不在通用词表里，漏掉会让「打开时已登录」的学习停在
 * 「请登录」，用户明明在站内却被要求再登录一次。
 */
const CHECKIN_PATH = /(?:^|\/)(?:check-?in|daily|rewards?|claim|points|lottery|draw|prize)(?:\/|$)/i;
/** 明确的签到/抽奖业务页不能因当时没有按钮而被降级成「登录即签到」。 */
export function isInteractiveCheckinLearningPath(path: string): boolean {
  return CHECKIN_PATH.test(path.split(/[?#]/)[0] ?? '') || CHECKIN_PATH.test(hashRouteOf(path).split('?')[0] ?? '');
}
/** 「退出登录」按钮的整标签形态（只认整个标签，避免误伤「退出全屏」这类文案）。 */
const LOGOUT_LABEL = /^(?:退出登录|退出账号|退出|登出|注销|log\s?out|sign\s?out|logout)$/i;
/** 签到/领取类按钮标签。 */
const CHECKIN_LABEL = /(?:签到|打卡|领取|抽奖|抽签|翻牌|check[\s-]?in|daily|claim|redeem|\b(?:start\s+)?draw\b)/i;
/** 页面导航项标签：点它只是「去某个页面」，不是签到动作。 */
const NAVIGATION_LABEL = /个人(?:资料|信息|中心)|账户信息|账号信息|我的(?:账户|账号|资料|信息)|控制台|首页|设置|偏好|仪表盘|退出|登出|profile|personal|account|dashboard|console|preferences?|logout|log\s?out/i;

/** 签到证据强度：没录到 → 录到动作 → 页面确认成功 → 页面显示今日已完成。 */
export type CheckinEvidenceLevel = 'none' | 'action' | 'confirmed' | 'already';

export type LearningStage = 'login' | 'profile' | 'checkin' | 'done';

/** 事件自带的页面路径；所有事件形态都带 `path`。 */
export function eventPath(event: WorkflowLearningEvent): string | undefined {
  const raw = (event as { path?: unknown }).path;
  return typeof raw === 'string' && raw.trim() ? raw : undefined;
}

/** 认证页判定（pathname 与哈希路由两处分别判定，任一命中即真）。 */
export function isAuthLearningPath(path: string): boolean {
  const hash = hashRouteOf(path);
  return AUTH_PATH.test(path) || (!!hash && AUTH_PATH.test(hash));
}

/** 退出登录页判定。 */
export function isLogoutLearningPath(path: string): boolean {
  const hash = hashRouteOf(path);
  return LOGOUT_PATH.test(path) || (!!hash && LOGOUT_PATH.test(hash));
}

/** 「能显示当前账号」的页面：资料页（排除设置/账单类）或签到页本身。 */
export function isProfileLearningPath(path: string): boolean {
  const profileLike = (candidate: string): boolean => PROFILE_LEAF.test(candidate)
    || (CHECKIN_PATH.test(candidate) && !PROFILE_EXCLUDE.test(candidate));
  const hash = hashRouteOf(path);
  return profileLike(path) || (!!hash && profileLike(hash));
}

/** 这个动作是不是「点了退出登录」？（按钮标签、按钮指向的地址、已站在退出页上） */
export function isLogoutLearningEvent(event: WorkflowLearningEvent): boolean {
  if (isLogoutLearningPath(eventPath(event) ?? '')) return true;
  if (event.type === 'navigation') return false;
  if (event.type !== 'click' && event.type !== 'fill') return false;
  if (LOGOUT_LABEL.test((event.label ?? '').trim())) return true;
  if (event.type !== 'click') return false;
  const href = (event as { href?: unknown }).href;
  if (typeof href !== 'string' || !href.trim()) return false;
  try {
    return isLogoutLearningPath(new URL(href, 'https://learning.invalid').pathname);
  } catch {
    return false;
  }
}

/** 点击是否只是「跳去另一个页面」（导航项 / 指向别的页面），不算签到动作。 */
function looksLikePageNavigation(event: Extract<WorkflowLearningEvent, { type: 'click' }>): boolean {
  const label = (event.label ?? '').trim();
  if (label && NAVIGATION_LABEL.test(label)) return true;
  const href = (event as { href?: unknown }).href;
  const path = eventPath(event);
  if (typeof href !== 'string' || !href.trim() || !path) return false;
  try {
    return new URL(href, 'https://learning.invalid').pathname !== path;
  } catch {
    return false;
  }
}

/**
 * 只按**标签**判断「这是一笔页面导航」。
 *
 * 与 `looksLikePageNavigation` 分开：那个还会看 href 是否指向别的地址，用于
 * 「这个动作算不算签到动作」的总判定；这里只回答「标签本身是不是导航入口」，
 * 供证据判定先行拦截使用 —— 见 `checkinEvidenceOf` 里为什么标签要优先于证据。
 */
function looksLikeNavigationLabel(event: Extract<WorkflowLearningEvent, { type: 'click' }>): boolean {
  const label = (event.label ?? '').trim();
  return !!label && NAVIGATION_LABEL.test(label);
}

/**
 * 单次动作的签到证据强度。
 *
 * - `confirmed` / `already`：动作之后界面**真的**出现了签到成功 / 今日已签到的字样
 *   （采集侧写进事件里的固定词表），这是最可信的一条；
 * - `action`：按钮标签本身是签到/领取语义，且不是导航项、不是登录入口 ——
 *   当作「你点过签到按钮了」，但**不**等于签到成功（保存时仍会如实提示）。
 */
export function checkinEvidenceOf(event: WorkflowLearningEvent): CheckinEvidenceLevel {
  if (event.type === 'click') {
    const path = eventPath(event);
    if (path && isAuthLearningPath(path)) return 'none';
    if (event.loginAction && !(event.loginAction === 'submit' && CHECKIN_LABEL.test(event.label ?? ''))) return 'none';
    if (isLogoutLearningEvent(event)) return 'none';
    /**
     * 导航**标签**先于证据判定：点「个人资料 / 控制台 / 设置」这类入口时，
     * 页面本来就可能写着「今日已签到」（侧栏记录、连续签到说明、公告），
     * 采集侧的补报又会把整页文本挂到这一笔点击上。若让证据先判定，这条导航
     * 点击会被当成签到动作，还可能被 `learnedRoute` 选成路线终点页 ——
     * 学出的流程会跳到资料页去点一个和签到无关的入口，回放必然失败。
     *
     * 只按**标签**拦（`NAVIGATION_LABEL`）：href 指向别处的点击仍允许携带证据，
     * 因为站点把签到做成 `<a href="/checkin">立即签到</a>` 并被 SPA 就地接管时，
     * 地址并不会真的变（补报才发得出来），那笔点击是真实的签到动作。
     */
    if (looksLikeNavigationLabel(event)) return 'none';
    if (event.evidence?.kind === 'already') return 'already';
    if (event.evidence?.kind === 'success') return 'confirmed';
    if (looksLikePageNavigation(event)) return 'none';
    return event.label && CHECKIN_LABEL.test(event.label) ? 'action' : 'none';
  }
  if (event.type === 'fill' || event.type === 'drag') {
    // 拖拽与输入共用同一套界面变化证据：它们的「结果」同样只能由页面说了算。
    const afterText = event.afterText ?? [];
    if (afterText.some((line) => /已签到|今日已|已经签到/.test(line))) return 'already';
    if (afterText.some((line) => /签到成功|打卡成功|领取成功/.test(line))) return 'confirmed';
  }
  return 'none';
}

const EVIDENCE_RANK: Record<CheckinEvidenceLevel, number> = {
  none: 0,
  action: 1,
  confirmed: 2,
  already: 3,
};

/** 事件顺序里的页面序列（去掉连续重复项）：报告里的「经过几个页面」用它。 */
export function learningPageSequence(events: readonly WorkflowLearningEvent[]): string[] {
  const pages: string[] = [];
  for (const event of events) {
    const path = eventPath(event);
    if (!path || path === pages[pages.length - 1]) continue;
    pages.push(path);
  }
  return pages;
}

/** 录到的动作数（navigation 之外的每一步）。 */
export function learningActionCount(events: readonly WorkflowLearningEvent[]): number {
  return events.filter((event) => event.type !== 'navigation').length;
}

export interface LearningAnalysis {
  kind: LearningKind;
  /** 当前阶段；无法再往前推进时停在上一阶段 */
  stage: LearningStage;
  /** 最后一个事件所在页面 */
  path?: string;
  /** 走过的页面数（连续重复项已合并） */
  pages: number;
  /** 录到的动作数 */
  actions: number;
  /** 录到的签到证据强度 */
  checkin: CheckinEvidenceLevel;
  /** 认证页上留下了账号/密码输入或登录提交动作 */
  credentials: boolean;
  /** 到达过认证页之外、站点的业务页（登录已生效的证据） */
  signedIn: boolean;
  /** 登录动作是否已经录全（登录学习据此提示「可以结束了」） */
  login: boolean;
  /** 演示走到过「退出登录」，且之后**还没有**重新登录成功（会话仍是断开的） */
  logout: boolean;
  /**
   * 这份录制能不能按「登录即签到」保存？
   *
   * 命中条件是「登录已生效（进过站内业务页）+ 全程没点退出登录 + 还没录到签到动作」。
   * 它只说明**可以给用户这个选项**（扩展面板上的「登录即签到」按钮），不等于站点
   * 就是登录即签到 —— 最终由用户显式点按钮确认，绝不自动替站点下结论。
   */
  loginAsCheckinAvailable: boolean;
}

/**
 * 把事件流归约成当前阶段。
 *
 * 状态机只允许前进，唯一例外是「退出登录」：会话作废，必须回到「请登录」，
 * 并且把之前的签到证据清掉 —— 在已登出的会话上录到的签到动作不能算数。
 * 退出之后重新登录成功即恢复正常推进，退出提醒随之撤下。
 */
export function analyzeLearningEvents(
  events: readonly WorkflowLearningEvent[],
  kind: LearningKind,
): LearningAnalysis {
  let stage: LearningStage = 'login';
  let checkin: CheckinEvidenceLevel = 'none';
  let logout = false;
  let credentials = false;
  let signedIn = false;
  let submitted = false;
  let oauth = false;
  /**
   * 演示中是否**离开过**认证页。
   *
   * 「打开登录页 → 被站点直接带回站内首页」是「本来就已经登录」的典型形态
   * （登录即签到站点尤其常见）。认证页上的事件本身不算登录证据，但先见过
   * 认证页、之后还能落到非认证页面，说明这个会话已经不在登录表单上。
   *
   * 必须先有 `authPageSeen` 才置位：普通落地页本身可能只是公开首页，不能
   * 仅凭单个非认证页推断「已有会话」。
   */
  let leftAuthPage = false;
  /** 是否见过认证页，用于确认「离开认证页」确实发生过。 */
  let authPageSeen = false;
  let interactiveCheckinPageSeen = false;

  for (const event of events) {
    if (isLogoutLearningEvent(event)) {
      logout = true;
      stage = 'login';
      checkin = 'none';
      credentials = false;
      signedIn = false;
      submitted = false;
      oauth = false;
      authPageSeen = false;
      leftAuthPage = false;
      interactiveCheckinPageSeen = false;
      continue;
    }

    const path = eventPath(event);
    const onAuthPage = !!path && isAuthLearningPath(path);
    if (onAuthPage) authPageSeen = true;

    // 登录证据：两类学习共用同一批字段（登录学习带 fieldRole，签到学习看认证页）。
    if (event.type === 'fill' && (event.fieldRole !== undefined || (onAuthPage && event.hasValue))) {
      credentials = true;
    }
    /**
     * 本事件**之前**是否已经发起过登录。
     *
     * 用「之前」而不是「包含本事件」：登录表单也可能放在 `/` 这种非认证路径上，
     * 点提交按钮的那一刻还没登录成功。只有提交**之后**出现的站内页面
     * （导航事件或用户的新动作）才算「登录已生效」的证据。
     */
    const loginActionSeen = submitted || oauth;
    if (event.type === 'click' && event.loginAction === 'submit') submitted = true;
    if (event.type === 'click' && event.loginAction === 'oauth') oauth = true;
    /**
     * 在登录框里按 Enter 提交：采集侧把键名挂在 fill 事件上（键盘提交不会派发
     * click）。只认认证页或密码框上的 Enter —— 普通搜索框里的 Enter 不是登录。
     */
    if (event.type === 'fill' && event.key === 'Enter'
      && (event.fieldRole === 'password' || onAuthPage)) submitted = true;

    if (!isFusedLearning(kind)) {
      if (oauth || (credentials && submitted)) {
        stage = 'done';
        // 登录学习本来就常要先退出旧会话才看得到登录表单；退出后录全了登录即恢复。
        logout = false;
      }
      continue;
    }

    if (onAuthPage) continue;
    if (path && isInteractiveCheckinLearningPath(path)) interactiveCheckinPageSeen = true;

    // 见过认证页后又落到非认证页：站点把已有会话直接带回了站内。
    if (path && authPageSeen) leftAuthPage = true;

    const business = !!path && isKnownBusinessLearningPath(path);
    const profileLike = !!path && isProfileLearningPath(path);
    /**
     * 「登录已生效」的三类证据：
     *
     * 1. 当前页本身是资料页/已知业务页（演示开始时已登录、或站点用常见路由命名）；
     * 2. 本事件之前**确实发起过登录**（点提交按钮 / OAuth / 登录框里按 Enter），
     *    而现在事件已经落在认证页之外的页面上。登录成功后的落地页命名五花八门
     *    （`/`、`/home`、`/workspace`、`/zh/...`），靠词表穷举必然漏掉真实站点；
     *    而「登录即签到」站点恰恰没有任何签到动作可录，漏掉这一步就等于整场演示白做；
     * 3. 先见过认证页、随后被站点带回任意非认证页：这是**已有会话、被站点从登录页
     *    带回**的证据，不宣称本轮登录过；`analysis.login` 仍为 false，与「登录即签到」
     *    报告给出 warn 的语义一致。
     */
    if (business || profileLike || loginActionSeen || leftAuthPage) signedIn = true;
    /**
     * 退出之后又亲自登录成功：会话已经重建，「会话已断开」不再成立。
     *
     * 同站多账号时浏览器常登着别的账号，用户必须先退出、再用本账号登录 —— 这是
     * 正当演示，不能一直挂着「不建议保存」。只认退出**之后**的登录动作（提交 /
     * OAuth / 密码框回车，它们在退出时已被清零），再落到认证页之外的页面。
     */
    // 登录按钮不一定被标成提交（不在 form 里的自绘按钮）：退出后填过账密、
    // 随后进了站内业务页，同样说明已经重新登录。
    if (logout && signedIn && (loginActionSeen || credentials)) logout = false;
    if (stage === 'login' && signedIn) stage = 'profile';
    if (stage === 'profile' && profileLike) stage = 'checkin';

    const level = checkinEvidenceOf(event);
    if (level !== 'none' && EVIDENCE_RANK[level] > EVIDENCE_RANK[checkin]) {
      checkin = level;
      // 录到签到动作就说明人已经在签到页上：前面没跟上的阶段一并补齐。
      if (stage === 'login') stage = 'profile';
      if (stage === 'profile') stage = 'checkin';
      stage = 'done';
    }
  }

  const lastEvent = events[events.length - 1];
  const lastPath = lastEvent ? eventPath(lastEvent) : undefined;
  return {
    kind,
    stage,
    ...(lastPath ? { path: lastPath } : {}),
    pages: learningPageSequence(events).length,
    actions: learningActionCount(events),
    checkin,
    credentials,
    signedIn,
    login: oauth || (credentials && submitted),
    logout,
    /**
     * 「登录即签到」的可用性判据（只读事件、刻意保守）：
     *
     *  - 只有融合学习（kind !== 'login'）才需要它 —— 登录学习不产出签到流程；
     *  - 演示必须真的走到认证页之外的业务页（`signedIn`）：登录已经生效，
     *    站点确实在没有签到按钮的情况下给了用户一个可用的已登录会话；
     *  - 当前会话没有停在「已退出」上（logout 会让会话与证据一起作废；
     *    退出后重新登录成功则会话已重建，退出前的证据仍已清零）；
     *  - 演示里**没有**录到任何签到动作：用户一旦点过签到按钮，正常的流程编译
     *    总是更精确的产物，不该被换成更弱的「登录即签到」。
     *
     * 为什么不自动按它保存：没点到按钮的原因可能是「忘了点」，也可能是
     * 「本站没有按钮」。两种情形在事件流里长得一样，只有用户能区分 ——
     * 所以只把它做成一个**显式选项**，绝不替用户宣称签到完成。
     */
    loginAsCheckinAvailable: isFusedLearning(kind) && signedIn && !logout && checkin === 'none'
      && !interactiveCheckinPageSeen,
  };
}

/**
 * 这次演示能不能按「登录即签到」保存？（`analyzeLearningEvents` 里的同一判据）
 *
 * 给后台保存路径与界面按钮用的显式入口：调用方只需要回答「要不要给这个选项」。
 */
export function canSaveLoginAsCheckin(
  events: readonly WorkflowLearningEvent[],
  kind: LearningKind,
): boolean {
  return analyzeLearningEvents(events, kind).loginAsCheckinAvailable;
}

export interface LearningGuideStep {
  /** 固定短标签（如「登录」）；只含界面口径的词，绝不来自页面内容 */
  label: string;
  /** done = 已经走过；current = 当前这一步；todo = 还没到 */
  state: 'done' | 'current' | 'todo';
}

export interface LearningGuideView {
  /** 第几步（1 起） */
  step: number;
  total: number;
  /** 阶段主文案，如「① 请登录」 */
  title: string;
  /** 一句话补充：告诉用户具体该做什么 */
  hint: string;
  /** 走错路（点了退出登录）时的醒目提醒；没有问题时为 undefined */
  warning?: string;
  /**
   * 整条流程的步骤条（固定标签）。
   *
   * 扩展里的学习面板与页面上的一体化浮层画的是**同一份**步骤条，
   * 这样「我演示到第几步了」在两处看到的是同一个答案。
   */
  steps: LearningGuideStep[];
}

const STEP_NUMBER = ['①', '②', '③', '④'] as const;

/** 融合学习的四步固定短标签，与步骤序号一一对应。 */
const FUSED_STEP_LABELS = ['登录', '账号页', '签到', '结束'] as const;
/** 登录学习只有两步。 */
const LOGIN_STEP_LABELS = ['登录', '结束'] as const;

const LOGOUT_WARNING = '检测到这次演示点了「退出登录」：会话已经断开，请重新登录后再继续演示（这段演示不建议保存）';

const CHECKIN_HINTS: Record<LearningStage, string> = {
  login: '在打开的站点上手动登录；全程不要点「退出登录」',
  profile: '先经过能显示当前账号的页面（如「个人资料 / 我的账户」），再进签到页',
  checkin: '点一次真正的签到/领取按钮；当天已经签过的站点学不到签到流程',
  done: '回到扩展里点「结束学习」保存',
};

/**
 * 「登录即签到」站点没有签到按钮可点时的替代出口。
 *
 * 只在 `loginAsCheckinAvailable` 命中时追加到提示末尾：多数站点仍然要把
 * 签到按钮点完；只有「登录已生效、却没有签到动作」的演示才需要看到这句话。
 */
const LOGIN_AS_CHECKIN_HINT = '若本站是「登录即签到」（登录成功后自动完成、页面上没有签到按钮），回扩展里点「登录即签到」即可保存完整流程';

const LOGIN_HINTS: Record<LearningStage, string> = {
  login: '手动完成一次登录（填好账号密码并提交，或点第三方登录），全程不要点「退出登录」',
  profile: CHECKIN_HINTS.profile,
  checkin: CHECKIN_HINTS.checkin,
  done: '回到扩展里点「结束学习」保存',
};

/** 阶段主文案（不含序号与「可以结束了」补语）。 */
function stageTitle(kind: LearningKind, stage: LearningStage): string {
  if (!isFusedLearning(kind)) return stage === 'done' ? '已录到登录动作' : '请登录';
  if (stage === 'login') return '请登录';
  if (stage === 'profile') return '已检测到登录成功，请前往能显示当前账号的页面';
  if (stage === 'checkin') return '请完成一次签到';
  return '已录到签到动作';
}

/** 阶段评估 → 浮层文案。登录学习只有两步，签到学习是完整四步。 */
export function guideViewOf(analysis: LearningAnalysis): LearningGuideView {
  const loginOnly = analysis.kind === 'login';
  const total = loginOnly ? 2 : 4;
  const step = loginOnly
    ? (analysis.stage === 'done' ? 2 : 1)
    : analysis.stage === 'login' ? 1 : analysis.stage === 'profile' ? 2 : analysis.stage === 'checkin' ? 3 : 4;
  const marker = STEP_NUMBER[step - 1] ?? '';
  const done = analysis.stage === 'done';
  const baseHint = loginOnly ? LOGIN_HINTS[analysis.stage] : CHECKIN_HINTS[analysis.stage];
  const steps: LearningGuideStep[] = (loginOnly ? LOGIN_STEP_LABELS : FUSED_STEP_LABELS).map((label, index) => ({
    label,
    state: index + 1 < step ? 'done' : index + 1 === step ? 'current' : 'todo',
  }));
  return {
    step,
    total,
    title: `${marker} ${stageTitle(analysis.kind, analysis.stage)}${done ? '，可以点「结束学习」了' : ''}`,
    hint: !loginOnly && analysis.loginAsCheckinAvailable ? `${baseHint}；${LOGIN_AS_CHECKIN_HINT}` : baseHint,
    steps,
    ...(analysis.logout ? { warning: LOGOUT_WARNING } : {}),
  };
}
