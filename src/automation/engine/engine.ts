import type { CheckinMetrics, LoginTask, TaskResult, TaskStage } from '@/types';
import {
  closeAnnouncements,
  fillCredentials,
  submitLogin,
  verifyLogin,
  clickOAuthButton,
  detectManualLoginStep,
  detectAlreadyLoggedIn,
  hasVisibleLoginPrompt,
  pageShowsSignedIn,
  revealExternalLogin,
  revealLoginForm,
  resubmitLoginAfterResolvedChallenge,
  waitForExternalLoginNavigation,
} from '@/automation/login/steps';
import { isCurrentCheckinPage, performCheckin, type CheckinOutcome } from '@/automation/checkin/checkin';
import { sleep } from '@/automation/shared/dom-utils';
import { prepareCheckinEntry } from '@/automation/checkin/checkin-entry';
import { waitForChallenge, waitForManagedChallenge, type ChallengeResolution } from '@/automation/challenge/challenge';
import { waitForCheckinChallenge } from '@/automation/challenge/checkin-challenge';
import { isSameSiteUrl, siteOrigin } from '@/lib/site/site-security';
import { DEFAULT_LOGIN_METHOD } from '@/lib/checkin/effective-method';
import { usesCheckinWorkflow } from '@/lib/checkin/learned-checkin';
import { detectPageAvailabilityIssue } from '@/automation/shared/page-health';
import { classifyFailure, planRetry } from '@/automation/shared/diagnostics';
import {
  findAccountOnPage,
  injectToken,
  logoutSession,
  readPageIdentity,
  readVisibleIdentity,
  verifyIdentity,
  type PageIdentity,
} from '@/automation/login/identity';
import type { SiteCookieClearResult } from '@/lib/messages/site-cookies';
import { decideIdentityAction } from '@/automation/login/identity-policy';
import { ensureFreshToken, type RefreshedTokens } from '@/automation/login/token-refresh';
import { clearAuthBootstrapCache } from '@/automation/shared/token-bootstrap';
import type { BalanceSnapshot } from '@/types';
import { captureBalance, describeMetrics, diffBalance } from '@/automation/balance/balance';
import {
  ROUTE_ENTRY_PREFIX,
  ROUTE_OFF_PAGE_PREFIX,
  atLearnedCheckinPage,
  atLearnedIdentityPage,
  atLearnedRoutePage,
  hasLearnedRoute,
  learnedIdentityPageUrl,
  type WorkflowCheckpoint,
  type WorkflowRunResult,
} from '@/automation/learning/workflow';
import { isAuthLearningPath } from '@/automation/learning/learning-stage';

const PAGE_RETRY_DELAYS = [3_000, 8_000, 15_000];
const PAGE_RETRY_MARKER = '页面暂不可用，自动重试';
/** 按错误分类重试的日志标记，靠它在跨页跳转后数出已重试次数 */
const RETRY_MARKER = '自动重试:';
/** 切换账号时重载登录页的标记，同样靠日志跨跳转计数，防止无限重载 */
const SWITCH_RELOAD_MARKER = '切换账号:';
/** 切换账号最多重载登录页几次 —— 一次够了，再多说明 cookie 清不掉 */
const MAX_SWITCH_RELOADS = 1;
/** 受管 GitHub 切号标记；跨页面保存在 steps 中，防止错误凭据导致无限循环。 */
const GITHUB_SWITCH_MARKER = '自动切换 GitHub 账号:';
const WORKFLOW_LOGIN_RECOVERY_MARKER = '学习流程恢复登录:';
const MAX_WORKFLOW_LOGIN_RECOVERIES = 2;
/**
 * 步骤总数上限，重试的兜底护栏。
 *
 * 一次正常签到大约 15 步（含登录、公告、验证、签到、余额）。设到 60 给
 * 重试留足空间，又能在计数失效导致的无限循环里及时刹车。
 */
const MAX_STEPS_BEFORE_GIVING_UP = 60;
/** 跳转签到页的日志标记，靠它跨页面数出同一个地址已经跳了几次 */
const CHECKIN_NAV_MARKER = '进入签到页: ';
/**
 * 同一个签到页最多跳几次。
 *
 * 2 次足够：第一次是正常跳转，第二次容许一次瞬时失败（SPA 路由没生效、
 * 接口超时导致页面没渲染）。第三次仍在原地就必然是重定向，再跳只是打转。
 */
const MAX_CHECKIN_NAVIGATIONS = 2;
/**
 * 「落点不在学习路线上」这种跳转最多放行几次。
 *
 * 工作流的 resolveRoute 在当前页不在 route 里时只能猜一个业务页进去（见
 * `workflow.ts` 的 `ROUTE_OFF_PAGE_PREFIX`）。实测站点（卡皮巴拉API）会把猜错
 * 的那一页再重定向回落地页，于是「跳 /sign-in → 被送回 /dashboard/overview →
 * 再跳 /sign-in」两页来回，日志里三行完全相同。
 *
 * 与 MAX_CHECKIN_NAVIGATIONS 的区别：那个按**目标地址**计数，挡不住这种往返；
 * 这里按**事件**计数（落点不在路线上）= 一次。一次就够：能到的站点一次就到，
 * 到不了的站点重试同一个地址不会产生任何新信息，只会把用户看到的东西重复一遍。
 * 用尽后放弃沿路线推进，改为在当前页执行工作流步骤（与跳不过去时的降级同一套）。
 */
const MAX_ROUTE_OFF_PAGE_NAVIGATIONS = 1;
/** 识别两页往返时回看的导航条数，够看清 A→B→A 即可 */
const CHECKIN_NAV_OSCILLATION_WINDOW = 3;
/**
 * 配置的签到页到不了、当前页也没有入口时，按顺序试这些常见路由。
 *
 * 来自各代 new-api / Sub2API 界面的实际路径。顺序即命中概率：新版界面的
 * `/profile` 和旧版的 `/console/personal` 最常见，`/dashboard/*` 是这一代
 * 白标站的控制台（海獭 AI 就落在这里），`/check-in` 是 Sub2API 系。
 *
 * 每个只试一次，靠步骤日志跨页面去重。全试完仍无入口才判失败 —— 那时才
 * 真的需要用户去改配置。
 */
const FALLBACK_CHECKIN_ROUTES = [
  '/profile',
  '/console/personal',
  '/dashboard/overview',
  '/dashboard',
  '/console',
  '/check-in',
  '/checkin',
] as const;
const INTERACTIVE_CHALLENGE_TIMEOUT_MS = 5 * 60_000;
const CHECKIN_IDENTITY_WAIT_MS = 12_000;
/** 跨文档保存已在身份核验页核验通过的标记（核验页可能是独立资料页，也可能是签到页本身）；绝不把未经核验的页面结论当身份凭据。 */
const PROFILE_IDENTITY_CONFIRMED_MARKER = '个人资料身份已核验:';
/**
 * 「本轮已全新登录」的跨文档标记。
 *
 * 登录即签到 + 学习路线时，身份核对要跨文档导航（登录落地页 → 资料页）；
 * loginCompletedThisRun 是内存标记，页面跳一次就没了。下一轮注入靠读 steps
 * 恢复「本轮真的登录过」，余额差分才有升级 success 的资格。
 * 与 PROFILE_IDENTITY_CONFIRMED_MARKER 同一套机制（写进落地 step）。
 *
 * 与那个标记一样，它只代表**写它的那一刻之后**那次登录：会话重建（重试重登、
 * 切号、退出重登）之后必须失效，否则下一次自动重试会把「打开时本来就已登录」
 * 的历史会话当成「本轮刚登录」，把历史余额变化误判成本轮奖励 —— 假成功。
 */
const FRESH_LOGIN_MARKER = '本轮已全新登录:';

/** 已发起的签到页跳转目标序列（按时间顺序，来自跨页步骤日志）。 */
function checkinNavTargets(steps: string[]): string[] {
  return steps
    .filter((step) => step.startsWith(CHECKIN_NAV_MARKER))
    .map((step) => step.slice(CHECKIN_NAV_MARKER.length).trim());
}

/** 找到 steps 中最后一个以 prefix 开头的下标；没有时返回 -1。 */
function lastIndexOfPrefix(steps: string[], prefix: string): number {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (steps[index]!.startsWith(prefix)) return index;
  }
  return -1;
}

/**
 * 会让「个人资料身份已核验」标记失效的会话重建事件（日志前缀）。
 *
 * 标记只代表**它之前那个会话**。除了切换账号 / 受管 GitHub 重授权，自动重试
 * 重登（failOrRetry 跳回登录页重登）、token 清号（logoutSession 清本地登录态
 * 或站点退出接口）以及「退出后重新登录（relogin）」都会重建会话；这些事件之后
 * 仍认旧标记，等于跳过本轮资料页核验直接把签到记到未知会话上。
 */
const SESSION_REBUILD_MARKERS = [
  SWITCH_RELOAD_MARKER,
  GITHUB_SWITCH_MARKER,
  RETRY_MARKER,
  WORKFLOW_LOGIN_RECOVERY_MARKER,
  '开始第二次登录',
  '已清除',
  '已调用站点退出接口',
];

/** 最近一次会话重建事件在 steps 里的下标；没有时返回 -1。 */
function lastSessionRebuildIndex(steps: string[]): number {
  return SESSION_REBUILD_MARKERS.reduce(
    (latest, prefix) => Math.max(latest, lastIndexOfPrefix(steps, prefix)),
    -1,
  );
}

/**
 * 「个人资料身份已核验」跨页标记是否仍然有效：标记必须晚于最近一次会话重建。
 */
function profileIdentityConfirmedInSteps(steps: string[]): boolean {
  const confirmed = lastIndexOfPrefix(steps, PROFILE_IDENTITY_CONFIRMED_MARKER);
  if (confirmed < 0) return false;
  return confirmed > lastSessionRebuildIndex(steps);
}

/**
 * 「本轮已全新登录」跨页标记是否仍然有效：与身份标记同一套会话重建失效规则。
 *
 * `loginCompletedThisRun` 只在当前文档内有效；跨文档（登录落地页 → 资料页）
 * 之后只能靠 steps 里的标记恢复。但 steps 会被整轮重试沿用，所以不能只做
 * `startsWith` 存在性判断 —— 那会把早已结束的上一轮登录算进本轮。
 */
function freshLoginInSteps(steps: string[]): boolean {
  const fresh = lastIndexOfPrefix(steps, FRESH_LOGIN_MARKER);
  if (fresh < 0) return false;
  return fresh > lastSessionRebuildIndex(steps);
}

/**
 * 识别「两页往返」震荡：最近三次跳转的目标是 A → B → A（A ≠ B）。
 *
 * 只看「同一个地址跳了几次」是不够的。站点把登录页重定向到控制台时，真实日志是
 * 「跳 /sign-in（第 1 次）→ 被送回 /dashboard/overview → 又想跳 /sign-in」——
 * 同一个地址的计数要到第三次才拦得住，而中间那次往返已经把用户看到的日志变成
 * 复读机。A→B→A 一旦出现，就说明目标页根本到不了、每次都被重定向回去。
 *
 * 连续重复（A→A→A）不在这里处理：那是 MAX_CHECKIN_NAVIGATIONS 的「容许一次
 * 瞬时失败」语义，必须保留。
 */
function detectCheckinOscillation(targets: string[]): { first: string; second: string } | null {
  if (targets.length < CHECKIN_NAV_OSCILLATION_WINDOW) return null;
  const window = targets.slice(-CHECKIN_NAV_OSCILLATION_WINDOW);
  const [first, middle, last] = window as [string, string, string];
  if (first === middle || first !== last) return null;
  return { first, second: middle };
}

/**
 * 解析签到跳转键的 pathname 与 hash。
 *
 * 键来自 `navigationKey`（pathname + search + hash），也兼容只存 pathname 的
 * 历史步骤；无法解析时按整串当 pathname 处理，不做猜测。
 */
function navigationKeyParts(key: string): { pathname: string; hash: string } {
  try {
    const parsed = new URL(key, location.origin);
    return { pathname: parsed.pathname, hash: parsed.hash };
  } catch {
    return { pathname: key, hash: '' };
  }
}

/**
 * 两个签到跳转键是否算「同一页」。
 *
 * - 两边都带 hash：按 hash 区分 —— hash 路由站点上 `/#/profile` 与 `/#/check-in`
 *   是两个页面，必须各自计数（只按 pathname 折叠会让整条路线共用一个 key，
 *   第三跳被误判成「重复跳转」而停机）。
 * - 任一边不带 hash：按 pathname 视为同一页 —— 站点把配置地址（无 hash）重定向
 *   到带 hash 的子路由时，重复跳转护栏必须仍然生效。
 */
function sameNavigationPage(a: string, b: string): boolean {
  if (a === b) return true;
  const left = navigationKeyParts(a);
  const right = navigationKeyParts(b);
  if (left.pathname !== right.pathname) return false;
  if (left.hash && right.hash) return left.hash === right.hash;
  return true;
}

/**
 * 数出「从路线外接入学习路线而发起的跳转」次数。
 *
 * 计数靠日志里的成对标记：`workflow.ts` 的 resolveRoute 在跳转前写下
 * 新产物写「工作流接入学习路线: … 进入 <目标>」；旧产物和未知路径仍可能写
 * 「学习路线未命中: … 尝试进入 <目标>」。引擎**放行**这次跳转时才写下
 * 「进入签到页: <目标>」。两行相邻，用后者定位前者 —— 因此「被拦下没跳成」的
 * 那次不会被算进去，预算不会被空转消耗。
 */
function countOffRouteRouteNavigations(steps: string[]): number {
  let count = 0;
  steps.forEach((step, index) => {
    if (!step.startsWith(CHECKIN_NAV_MARKER)) return;
    const target = step.slice(CHECKIN_NAV_MARKER.length).trim();
    const before = steps.slice(Math.max(0, index - 2), index);
    const explains = before.some(
      (line) => (
        (line.startsWith(ROUTE_ENTRY_PREFIX) && line.endsWith(`进入 ${target}`))
        || (line.startsWith(ROUTE_OFF_PAGE_PREFIX) && line.endsWith(`尝试进入 ${target}`))
      ),
    );
    if (explains) count += 1;
  });
  return count;
}

export interface EngineHost {
  markStage(stage: TaskStage, steps: string[]): Promise<void>;
  navigate(url: string, steps: string[], stage: TaskStage): Promise<void>;
  needsUser(message: string, steps: string[]): Promise<void>;
  /** 由 background 清除当前任务站点的浏览器 Cookie；content 不接收目标 URL。 */
  clearSiteCookies?(): Promise<SiteCookieClearResult>;
  /** 只跳到 GitHub 官方退出页；完成后由 background 安全地带回本站登录页。 */
  startGithubLogout?(steps: string[]): Promise<void>;
  /** 每新增一步就同步安全日志，让管理页真正逐步刷新。 */
  reportProgress?(steps: string[]): Promise<void>;
  /**
   * 把换到的新令牌写回账号。
   *
   * 可选：只有 token 认证的站点会用到。不实现的话每次签到都要重新换一遍
   * （能跑，但白白轮换 refresh token）。
   */
  saveSession?(tokens: RefreshedTokens): Promise<void>;
  /**
   * 记下这次用掉的领取理由。
   *
   * 可选：只有要求「理由不能与历史重复」的站点会用到（claimUniqueText）。
   * 不实现的话每次都会挑到候选池里的第一条，第二次起必然被站点拒收。
   */
  saveClaimText?(text: string): Promise<void>;
  /**
   * 本任务亲自登录成功后落地身份确认标记，使后续页面跳转不再重复重登。
   * 只由表单/OAuth/token 本轮成功路径调用，不用于「打开时本来就已登录」。
   */
  confirmIdentity?(): Promise<void>;
  /**
   * 把登录后从站点读到的身份（userId / 邮箱等）回填到账号。
   *
   * 可选：让下次签到能核对「当前登录的是不是本账号」——尤其是 OAuth 账号，
   * 它的 userId 只有登录后才知道，记下来才能在复签时判断一致性。
   */
  saveIdentity?(identity: PageIdentity): Promise<void>;
  /** 把签到时读到的余额保存为账号的独立状态 */
  saveBalance?(snapshot: BalanceSnapshot): Promise<void>;
  /**
   * 签到确认成功后，把页面上「今日奖励 / 今天 +$X」落盘到签到台账（daily）。
   *
   * 只有 workflow 与 button 方式在成功后才调：api/none 这类不需要。
   * 它的实现在 background 里会再次在签到页采集页面正文，把
   * `daily.checkinReward` 写进余额历史 —— 否则余额记录里那天永远 $0.00，
   * 只有日志里才显示「今日签到记录奖励 $0.28」，界面和记录两处看不到一致。
   */
  saveCheckinReward?(bodyText: string): Promise<void>;
  /** 把 relogin 退出前余额写进跨页任务上下文，同时保存为当前账号余额。 */
  saveReloginBalanceBefore?(snapshot: BalanceSnapshot): Promise<void>;
  /** 把普通 button 真实点击前的余额写进跨页任务上下文。 */
  saveButtonBalanceBefore?(snapshot: BalanceSnapshot): Promise<void>;
}

export async function runTask(task: LoginTask, host: EngineHost): Promise<TaskResult | null> {
  const steps: string[] = [...(task.steps ?? [])];
  /**
   * 本次实际使用的登录方式。
   *
   * background 派发时已经算好了账号级覆盖，这里只对老任务兜底 ——
   * 升级前躺在 storage.session 里的任务没有这个字段，读到 undefined
   * 会让 token 站点误走表单登录。
   */
  const loginMethod = task.effectiveLoginMethod ?? task.site.loginMethod ?? DEFAULT_LOGIN_METHOD;
  const externalLogin = loginMethod === 'oauth' || loginMethod === 'github' || loginMethod === 'passkey';
  // Future Hub 一类站点返回 GitHub 句柄而不是站点账号名。保存的 GitHub
  // 用户名是账号级、严格的第三方身份别名：即使本轮沿用浏览器已有会话，
  // 也可以用它核对 `demo104` ↔ `demo_104`，避免先退出再登录一遍。
  // verifyIdentity 只做大小写不敏感的完整字段匹配，不删除 `_`/`-`，且
  // userId 冲突仍会在别名之前拦截。
  const githubIdentityAlias = loginMethod === 'github'
    ? task.githubUsername?.trim()
    : undefined;
  const canSwitchAccount = loginMethod === 'github'
    && !!task.githubUsername
    && !!task.githubPassword
    && !!host.startGithubLogout;
  /**
   * 同站其它账号的 userId → 账号名。
   *
   * 「当前登录的是用户 ID 5544」看不出是误判还是真登着别人；能点名
   * 「本站账号 fzk521」时用户立刻就能判断这次退出重登该不该发生。
   * 这张表同时是唯一性防线：当前账号保存的 ID 若也出现在这里，说明历史版本
   * 已把同一站点身份绑定给多个本地账号，旧绑定不能继续作为核对基准。
   */
  const knownUsers = { knownUsers: task.siteAccountUserIds ?? {} };
  // adapter.userId lives on the shared site configuration. It is only a safe
  // legacy fallback when the site has exactly one configured account; on a
  // multi-account site it cannot identify which local account owns that ID.
  const legacySingleAccountUserId = task.siteAccountCount === 1
    ? task.site.adapter?.userId
    : undefined;
  const rawStoredUserId = task.accountIdentityUserId ?? legacySingleAccountUserId;
  const duplicateBindingOwner = rawStoredUserId
    ? knownUsers.knownUsers[rawStoredUserId]
    : undefined;
  const storedUserId = duplicateBindingOwner ? undefined : rawStoredUserId;

  /**
   * 本轮从站点读到的用户 ID，用于补 new-api 系的 user-id 兼容头。
   * 重复绑定的旧 ID 必须先丢弃，否则身份接口会带着错误的 user-id 请求头，
   * 连“当前到底登录了谁”都可能被旧数据污染。
   */
  let discoveredUserId: string | undefined = storedUserId;
  let discoveredIdentityUsername = task.accountIdentityUsername;
  let discoveredIdentityEmail = task.accountIdentityEmail;
  const expectedUserId = () => discoveredUserId ?? storedUserId;

  const siteWithCurrentIdentity = (): LoginTask['site'] => {
    if (!task.site.adapter && !discoveredUserId) return task.site;
    if (task.site.adapter?.userId === discoveredUserId) return task.site;
    return {
      ...task.site,
      adapter: { ...task.site.adapter, userId: discoveredUserId },
    };
  };

  /**
   * 使用本次解析出的签到方式。构造浅拷贝而不是改 task.site ——
   * task.site 会被写回信箱，污染它会让下一个阶段读到错的配置。
   *
   * 每次调用时重新构造：本轮读到的 userId 要立刻生效，等下一轮再用就晚了。
   */
  const checkinSite = () => {
    const identitySafeSite = siteWithCurrentIdentity();
    const base = task.effectiveCheckinMethod
      ? {
          ...identitySafeSite,
          checkin: { ...identitySafeSite.checkin, method: task.effectiveCheckinMethod },
        }
      : identitySafeSite;
    /**
     * 「登录即签到」保留学习路线与身份核验页（若演示过）：运行时的身份闸门
     * 需要按学到的资料页核对当前账号 —— OAuth 类站点登录成功后常停在身份
     * 不暴露的落地页，丢掉路线就把「登录即签到」退化成「登录后什么都不核对」。
     *
     * 清掉的是不可信/无用的残留：
     *  - entry/url：旧签到入口与地址，none 不去找按钮，留着只会把流程带偏；
     *  - workflow.steps：历史上的旧步骤不再回放（新学习保存的就是 steps:[]）。
     *    route/identityPath 是身份闸门的依据，不是签到动作，必须保留。
     */
    if (base.checkin?.method === 'none') {
      const checkin = { ...base.checkin };
      delete checkin.entry;
      delete checkin.url;
      if (checkin.workflow?.steps?.length) {
        checkin.workflow = {
          ...checkin.workflow,
          steps: [],
        };
      }
      return { ...base, checkin };
    }
    if (!usesCheckinWorkflow(base) || !base.checkin) return base;
    // 旧手工工作流可能用 entry 进入页面，再执行无 route 的 steps；保留这条配置契约。
    if (base.checkin.method === 'workflow' && !base.checkin.workflow?.route?.length) return base;
    // 兼容旧存储或内置模板合并带回的入口，执行时仍由学习流程拥有签到入口。
    // 旧 entry 不能抢先点击，已有 route 也不能被旧 url 拉去另一个页面。
    const checkin = { ...base.checkin };
    delete checkin.entry;
    if (checkin.workflow?.route?.length) delete checkin.url;
    return { ...base, checkin };
  };

  /**
   * 只在当前页找签到入口的站点配置。
   *
   * 配置的签到页反复跳不过去时用它：清掉 `checkin.url`、适配器的兜底路径与
   * 工作流的学习路线，否则扫描会再次返回「去那个地址」—— 而那个地址已经证明
   * 到不了，于是又绕回死循环。清掉之后扫描只看当前文档，那正是我们要的。
   *
   * 工作流的 `steps` 必须保留：那才是「在当前页怎么签到」的定义（点哪个按钮、
   * 断言什么），清掉它等于把一个到不了的地址升级成「这站不会签到」。只清
   * `route`（怎么到达）不动 `steps`（到了之后做什么）。
   *
   * `adapter.checkinPath` 显式设为空字符串（不是 undefined）：
   * `resolveSiteAdapter` 把空串解析成"关闭家族默认兜底"，而 undefined 会
   * 让它回落到 new-api 家族的 `/console/personal` —— 正是要避开的那个地址。
   */
  const localCheckinSite = (): LoginTask['site'] => {
    const base = checkinSite();
    /**
     * 把**当前路径**声明为签到页。
     *
     * 关键：`checkin.ts` 用 `onCheckinPage` 决定等多久 —— 在签到页等 12 秒
     * （给 SPA 拉接口、渲染面板），不在签到页只等 3 秒。上一版把
     * `pathPatterns` 清成空数组，于是当前页被判成"不是签到页"，只等 3 秒就
     * 扫描，SPA 还没把「每日签到」面板渲染出来 —— 日志里只列出导航栏和侧栏，
     * 而用户截图上面板明明在那儿。
     *
     * 清掉的只有 `checkin.url`、家族兜底 `checkinPath` 与工作流的学习路线
     * （它们指向到不了的地址，留着会让扫描再次要求跳转）；当前路径必须留在
     * pathPatterns 里。
     */
    const currentPath = (() => {
      try {
        return new URL(location.href).pathname || '/';
      } catch {
        return '/';
      }
    })();
    const localSite: LoginTask['site'] = {
      ...base,
      adapter: {
        ...base.adapter,
        checkinPath: '',
        checkin: {
          pathPatterns: [currentPath],
          titleWords: [...(base.adapter?.checkin?.titleWords ?? [])],
        },
      },
    };
    if (base.checkin) {
      const localCheckin = { ...base.checkin };
      delete localCheckin.url;
      // 学习路线已经证明到不了：留着它，工作流（method:'workflow'）会再次返回
      // 「跳到 route 首项」。只清 route，steps 原样保留。
      if (localCheckin.workflow?.route) {
        const { route: _dropped, ...workflowWithoutRoute } = localCheckin.workflow;
        localCheckin.workflow = workflowWithoutRoute;
      }
      localSite.checkin = localCheckin;
    }
    return localSite;
  };
  const log = {
    push: (m: string) => {
      steps.push(m);
      console.log('[签到助手]', m);
      void host.reportProgress?.([...steps]);
    },
  };

  if (duplicateBindingOwner && !steps.some((step) => step.startsWith('身份绑定冲突:'))) {
    log.push(
      `身份绑定冲突: 站点用户 ID ${rawStoredUserId} 同时绑定给当前账号和 ${duplicateBindingOwner}；`
      + '本轮已忽略这个旧绑定，必须重新核对页面身份后才能签到',
    );
  }

  const fail = (message: string, metrics?: CheckinMetrics): TaskResult =>
    ({ accountId: task.accountId, ok: false, message, steps, ...(metrics ? { metrics } : {}) });

  /**
   * 失败前先问一句：这类失败值得重试吗？
   *
   * 站点 5xx 和网络抖动过几分钟自己就好了，重试有意义；选择器对不上
   * 是配置问题，重试一百次结果一样。所以按诊断分类决定，而不是一律重试
   * 或一律不重试。
   *
   * 重试次数记在步骤日志里（而不是内存变量），因为 content script 每次
   * 整页跳转都会被销毁重建 —— 只有写进日志的东西能跨跳转存活。
   */
  async function failOrRetry(message: string, metrics?: CheckinMetrics): Promise<TaskResult | null> {
    const code = classifyFailure(message, steps);
    const attemptsSoFar = steps.filter((step) => step.startsWith(RETRY_MARKER)).length;

    // 硬上限：重试计数依赖步骤日志跨跳转存活，万一某条路径没把日志带过去，
    // 计数会永远停在 0 而无限重试 —— 任务卡在 running 直到超时，用户什么
    // 也看不到。用总步数兜底：正常签到十几步就结束，超过这个量级说明在打转。
    if (steps.length > MAX_STEPS_BEFORE_GIVING_UP) {
      return fail(`${message}（已重试多次仍未成功，停止重试）`, metrics);
    }

    const decision = planRetry(code, attemptsSoFar);
    if (!decision.retry) return fail(message, metrics);

    log.push(`${RETRY_MARKER} ${message} → ${decision.reason}`);
    await sleep(decision.delayMs);
    // 回到本站起点重来：失败可能发生在任意深度的页面上
    await host.navigate(task.site.loginUrl, steps, 'login');
    return null;
  }
  const done = (message: string, metrics?: CheckinMetrics): TaskResult =>
    ({ accountId: task.accountId, ok: true, message, steps, ...(metrics ? { metrics } : {}) });
  const credentialFailure = () => [...steps].reverse().find((step) => (
    step.startsWith('找不到') || step.startsWith('当前页没有')
  )) ?? '未能识别登录表单';

  const checkinHooks = {
    workflowCheckpoint: checkWorkflowSession,
    // 签到控件可能晚于首次页面检查才挂载验证框。每次真实签到点击前再检查一次，
    // 复用登录提交前同一套 Turnstile/验证码/滑块处理与可信指针点击。
    beforeCheckinClick: () => waitBeforeSubmit('checkin'),
    beforeWorkflowNavigate: () => host.markStage('checkin', steps),
    // 签到是独立业务动作，不能沿用登录时的验证结果。点击后由 checkin-challenge
    // 先做一次有界快照：只有真的探测到客观验证证据才进入长流程（日志也只在那一刻
    // 才宣告「正在等待安全验证」），没有验证的站点立即继续业务。尚未挂载的控件
    // 交给后面的结果轮询继续接管 —— 它同样先快照，不会重复宣告。
    afterCheckinClick: async () => (await waitForCheckinActionChallenge(2_500)).resolved,
    whileWaitingForCheckinResult: () => waitForCheckinActionChallenge(),
    saveReloginStage: () => host.markStage('relogin', steps),
    saveReloginBalanceBefore: async (snapshot: BalanceSnapshot) => {
      if (host.saveReloginBalanceBefore) await host.saveReloginBalanceBefore(snapshot);
      else await host.saveBalance?.(snapshot);
    },
    saveButtonBalanceBefore: async (snapshot: BalanceSnapshot) => {
      if (!host.saveButtonBalanceBefore) {
        throw new Error('当前运行环境无法持久化按钮签到基线，已停止点击');
      }
      await host.saveButtonBalanceBefore(snapshot);
    },
    buttonBalanceBefore: task.context?.buttonCheckinPending === true
      ? task.context.balanceBefore
      : undefined,
    /**
     * 把签到时读到的余额落进独立存储。
     *
     * 不接这一路，`performCheckin` 里的 `hooks.saveBalance?.(after)` 会被可选链
     * 静默跳过 —— 余额永远写不进去。表现是同一个余额出现两个口径互相打脸：
     * 账号行回落到 `result.metrics.quotaAfter`（本次签到的差分结果）显示
     * 「余额 $455.70」，而站点卡片和顶部合计走 `sumBalances`、只认独立存储，
     * 于是同时说「本站余额 未获取 · 1 个未获取」。
     */
    saveBalance: async (snapshot: BalanceSnapshot | null) => {
      if (!snapshot) return;
      try {
        await host.saveBalance?.(snapshot);
      } catch (error) {
        /**
         * 写入失败不能冒泡成任务失败（签到本身是成功的），但必须留痕。
         *
         * 静默吞掉的代价已经出现过：多账号站点身份未确认时后台会拒绝写入
         * 余额快照，用户看到「签到成功」+「余额未获取」，日志里没有任何线索，
         * 只能怀疑是站点接口坏了。这里把后台的原话记下来，配合展示层的回落
         * （见 lib/balance/balance-format.ts 的 displayBalanceOf），账号行至少
         * 还能显示本次签到读到的余额。
         */
        log.push(`余额快照未能写入账号（${error instanceof Error ? error.message : String(error)}）；本次签到结果不受影响`);
      }
    },
  };

  /**
   * 落地身份的唯一出口。
   *
   * 除了回填账号，还把 userId 记进 discoveredUserId —— 余额采集要靠它拼
   * user-id 兼容头。所有读到身份的路径都必须走这里，漏一处就会出现
   * 「身份读到了、余额还是 401」的割裂状态。
   */
  /**
   * 把身份写进长期账号映射的唯一出口。
   *
   * ⚠️ 只接受**站点服务端**的回答（`source === 'api'`）。
   *
   * `visible`（页面文字）与本地存储副本都不能落盘为长期映射：
   * - `identityFromAccountOnPage` 会凭空造出 `{username: task.username, source:'visible'}`，
   *   它的内容就是账号名本身 —— 存进去以后，下一次核对必然「一致」：
   *   形成**自证循环**（页面印着名字 → 存成身份 → 下次印着同样名字 → 判一致）。
   * - 本地副本可能是过期会话的残留。
   *
   * 本轮核对仍可以用这些弱证据（见 `rememberTrustedIdentity` 的调用方日志），
   * 但它们不具备写进磁盘、影响以后轮次的资格。早先只在 `externalLogin` 时才拦
   * `visible`，普通表单登录照样存 —— 一旦页面被同 origin 的内容影响，错误的
   * userId 会成为后续「该不该切号」的判定基准。
   */
  async function rememberIdentity(identity: PageIdentity): Promise<void> {
    if (identity.userId) discoveredUserId = identity.userId;
    if (identity.username) discoveredIdentityUsername = identity.username;
    if (identity.email) discoveredIdentityEmail = identity.email;
    if (identity.source !== 'api') return;
    await host.saveIdentity?.(identity);
  }

  /**
   * 本轮核对用的身份落地。
   *
   * 与 `rememberIdentity` 的区别只在**返回值语义**：这里回答「这份证据能不能
   * 当长期映射用」，供调用方决定日志措辞。两者对「什么能落盘」的判据已统一到
   * `source === 'api'`，不会再出现「本轮说存了、下次却读不到」的割裂。
   */
  async function rememberTrustedIdentity(identity: PageIdentity): Promise<boolean> {
    const trusted = identity.source === 'api';
    await rememberIdentity(identity);
    return trusted;
  }

  /** 第二次登录后的统一收尾：刷新余额，并用退出前基线计算本次奖励。 */
  async function finishRelogin(loginLabel: string): Promise<TaskResult> {
    let after: BalanceSnapshot | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await sleep(1_000);
      const sample = await captureBalance(siteWithCurrentIdentity());
      if (sample) {
        after = sample;
        break;
      }
    }

    if (after) await host.saveBalance?.(after);
    else log.push('第二次登录成功，但未能读取登录后的余额');

    const before = task.context?.balanceBefore;
    if (!before || !after) {
      return done(`${loginLabel}成功；余额差额暂无法核对`);
    }

    const metrics = {
      ...diffBalance(before, after),
      source: 'balance-diff' as const,
    };
    const summary = describeMetrics(
      metrics,
      siteWithCurrentIdentity().adapter?.quotaPerUnit,
      siteWithCurrentIdentity().adapter?.family,
    );
    if (summary) log.push(`重登前后差额：${summary}`);

    if (metrics.verdict === 'rewarded') {
      return done(`${loginLabel}成功，余额差额确认签到奖励已到账`, metrics);
    }
    if (metrics.verdict === 'already-used') {
      return done(`${loginLabel}成功，今日总额度未增加（期间有消耗，可能已领取）`, metrics);
    }
    return done(`${loginLabel}成功，余额未增加（今日可能已领取）`, metrics);
  }

  /**
   * 三个来源都读不到身份时的最后一招：页面上有没有印着**本账号**的名字。
   *
   * 修的是这句日志：「无法确认当前登录身份（读不到当前登录身份），按切换账号处理」。
   * 读不到不等于无从判断 —— 站点常把当前账号印在页头或个人页上，只是格式不合
   * 正则的胃口（没有「用户 ID」标签、不是 @句柄、邮箱还被打了码）。换个问法就能
   * 答上来：不问站点「你是谁」，问这一页「有没有我要签的这个人」。
   *
   * 命中即按用户名核对通过；没命中仍走原来的保守路径，不会把闸门变松。
   */
  function identityFromAccountOnPage(where: string): PageIdentity | null {
    const onPage = findAccountOnPage(task.username);
    if (!onPage) return null;
    log.push(`${where}读不到身份接口，但页面上印着本账号 ${onPage.matched}${onPage.masked ? '（打码显示）' : ''}，按用户名核对`);
    return { username: task.username, source: 'visible' };
  }

  interface CurrentIdentityEvidence {
    identity: PageIdentity | null;
    pageAccountMatch?: string;
  }

  /**
   * 同时收集结构化身份和页面上的严格账号名旁证。
   *
   * 1412 的资料页会显示 `demo-user 用户 ID 436` 与 GitHub 句柄
   * `@demo-github`。只保留后者会把正确的 demo-user 判成另一个人；只信正文
   * 又可能被公告误导。因此旁证只交给 verifyIdentity，并且不能覆盖 API 身份。
   */
  async function readCurrentIdentity(where: string): Promise<CurrentIdentityEvidence> {
    const identity = await readPageIdentity(siteWithCurrentIdentity());
    const onPage = findAccountOnPage(task.username);
    if (!identity) {
      return { identity: identityFromAccountOnPage(where) };
    }
    if (onPage && identity.source === 'visible') {
      log.push(`${where}同时显示站点账号 ${onPage.matched}，作为当前账号的页面旁证`);
      return { identity, pageAccountMatch: onPage.matched };
    }
    return { identity };
  }

  function verifyCurrentIdentity(evidence: CurrentIdentityEvidence) {
    const expectedIdentity = discoveredIdentityUsername || discoveredIdentityEmail
      ? {
          ...(discoveredIdentityUsername ? { username: discoveredIdentityUsername } : {}),
          ...(discoveredIdentityEmail ? { email: discoveredIdentityEmail } : {}),
        }
      : undefined;
    return verifyIdentity(evidence.identity, task.username, expectedUserId(), {
      ...knownUsers,
      ...(evidence.pageAccountMatch ? { pageAccountMatch: evidence.pageAccountMatch } : {}),
      ...(githubIdentityAlias ? { expectedAliases: [githubIdentityAlias] } : {}),
      ...(expectedIdentity ? { expectedIdentity } : {}),
    });
  }

  function hasAuthoritativeApiMismatch(
    evidence: CurrentIdentityEvidence,
    verdict: ReturnType<typeof verifyIdentity>,
  ): boolean {
    if (evidence.identity?.source !== 'api') return false;
    const userId = evidence.identity.userId;
    // TaBiAI 的 API 可能只返回 GitHub 句柄（如 demo-github），而资料页才会
    // 显示站点账号 demo-user。只有已有 ID 基准或已知其它账号 ID 才是明确串号。
    if (userId && expectedUserId()) return userId !== expectedUserId();
    if (userId && knownUsers.knownUsers[userId]) return true;
    return verdict.match === 'mismatch' && !externalLogin;
  }

  function hasConflictingCheckinUserId(evidence: CurrentIdentityEvidence): boolean {
    const userId = evidence.identity?.userId;
    if (!userId) return false;
    // API 身份是服务端回答，保存的 ID 冲突可以直接作为强证据；页面文本
    // 只有在该 ID 已知属于本站另一个账号时才足够强，普通可见数字仍可能来自
    // 公告/其它卡片，继续保留用户名旁证的兼容行为。
    if (evidence.identity?.source === 'api' && expectedUserId() && userId !== expectedUserId()) return true;
    return !!knownUsers.knownUsers[userId];
  }

  function forceCheckinUserIdMismatch(
    evidence: CurrentIdentityEvidence,
    verdict: ReturnType<typeof verifyIdentity>,
  ): ReturnType<typeof verifyIdentity> {
    if (!hasConflictingCheckinUserId(evidence)) return verdict;
    const userId = evidence.identity!.userId!;
    const owner = knownUsers.knownUsers[userId];
    const source = evidence.identity?.source === 'api'
      ? '站点接口'
      : evidence.identity?.source === 'storage'
        ? '本地登录态'
        : '页面文本';
    return {
      match: 'mismatch',
      detail: expectedUserId()
        ? `当前登录的是用户 ID ${userId}${owner ? `（本站账号 ${owner}）` : ''}（读自${source}），本次要签到的是 ${expectedUserId()}`
        : `当前登录的是用户 ID ${userId}（本站账号 ${owner}，读自${source}），不是本次账号 ${task.username}`,
    };
  }

  /**
   * 判断资料页上的“不一致”是否已经足够强，可以安全地触发自动切号。
   *
   * OAuth 站点经常同时存在两套名字：站点账号与第三方句柄。TaBiAI 会先显示
   * `@demo-github`，稍后才把站点账号 `demo-user` 渲染出来；单凭前者不同就
   * 清 Cookie、退出 GitHub，会把正确会话误判成错误账号。
   *
   * 用户 ID 与已保存/已知账号冲突才是强证据。账密或 Token 登录没有这种第三方
   * 别名关系，明确读到不同用户名时仍可沿用原来的自动切号行为。
   */
  function hasStrongCheckinMismatch(
    evidence: CurrentIdentityEvidence,
    verdict: ReturnType<typeof verifyIdentity>,
  ): boolean {
    if (hasConflictingCheckinUserId(evidence)) return true;
    if (verdict.match !== 'mismatch') return false;
    if (hasAuthoritativeApiMismatch(evidence, verdict)) return true;

    const identity = evidence.identity;
    if (!identity) return false;

    // 邮箱账号之间的明确冲突不是 GitHub 昵称/站点账号别名问题。
    if (task.username.includes('@') && identity.email) return true;
    return !externalLogin;
  }

  /**
   * 受管 GitHub 账号**本轮刚用自己保存的凭据亲自登录过**。
   *
   * 这一轮的 GitHub 会话是扩展在 github.com 官方页上用该账号保存的用户名密码提交出来的
   * （`githubCredentialsSubmitted`，只在受管退出 → 重新登录之后才为真）。此时 OAuth 带回来的
   * 站点会话**就是**这个 GitHub 账号的，站点显示的句柄（demo-github）、`github_123` 这类名字
   * 与扩展里的账号名对不上是第三方登录的常态，不是串号证据。
   *
   * 只认三条同时成立：受管 GitHub、本轮确实提交过保存的凭据、读到的用户 ID 没有与本站
   * 其它账号或本账号已存 ID 冲突（冲突是强证据，任何情况都不能放行）。
   */
  function managedGithubSessionThisRun(evidence: CurrentIdentityEvidence): boolean {
    return loginMethod === 'github'
      && canSwitchAccount
      && task.githubCredentialsSubmitted === true
      && !!evidence.identity?.userId
      && !hasConflictingCheckinUserId(evidence);
  }

  /**
   * 第三方登录的资料页只显示第三方句柄（读不到站点账号名）时该怎么办。
   *
   * - 本轮刚用保存的 GitHub 凭据登录过 → 这就是本账号：记住站点用户 ID 作为以后的核对基准；
   * - 受管 GitHub、本轮还没亲自登录过（沿用的是浏览器里已有的 GitHub 会话，可能是别人的）
   *   → 退出 GitHub、用本账号保存的凭据重新登录一次；
   * - 其它第三方登录（没有保存的凭据可用）→ 照旧交给用户确认。
   */
  type ExternalHandleOutcome = 'confirmed' | 'switching' | 'unresolved';
  async function resolveExternalHandleIdentity(
    evidence: CurrentIdentityEvidence,
    where: string,
  ): Promise<ExternalHandleOutcome> {
    if (managedGithubSessionThisRun(evidence)) {
      const identity = evidence.identity!;
      // 页面身份可用于本轮核对；只有接口身份可以保存为长期映射。
      await rememberIdentity({ ...identity, verifiedByManagedLogin: true });
      log.push(
        `本轮已用账号 ${task.username} 保存的 GitHub 凭据登录，${where}显示的 ${identity.username ?? identity.displayName ?? identity.email ?? '第三方身份'}`
        + `（用户 ID ${identity.userId}）就是本账号；`
        + (identity.source === 'api' ? '已记住该用户 ID，以后直接按 ID 核对' : '本轮按该身份继续核对，不保存为长期账号映射'),
      );
      return 'confirmed';
    }
    if (loginMethod === 'github' && canSwitchAccount) {
      log.push(`${where}只显示第三方身份，且本轮沿用的是浏览器里已有的 GitHub 会话，改为用本账号保存的 GitHub 凭据重新登录`);
      const switched = await startManagedGithubSwitch();
      if (switched === 'started') return 'switching';
    }
    return 'unresolved';
  }

  function incompleteExternalIdentityVerdict(
    evidence: CurrentIdentityEvidence,
  ): ReturnType<typeof verifyIdentity> {
    const identity = evidence.identity;
    const visibleName = identity?.username ?? identity?.displayName ?? identity?.email;
    return {
      match: 'unknown',
      detail: visibleName
        ? `资料页目前只显示第三方身份 ${visibleName}，尚未显示站点账号 ${task.username}`
        : `资料页尚未显示站点账号 ${task.username}`,
    };
  }

  /**
   * 站点配了一个「同源、且不是当前页」的签到页时返回它的绝对地址。
   *
   * 身份核对用它来判断「还有没有一页可以去读身份」：新版 new-api 界面的落地页
   * 读不到身份，而签到页（`/profile`）上印着用户 ID。同源校验不能省 ——
   * 这个地址会被用来导航，配置若被改成站外地址就会把登录态带出去。
   */
  function checkinPageElsewhere(): string | null {
    const site = checkinSite();
    const checkin = site.checkin;
    if (!checkin?.url || !isSameSiteUrl(site, checkin.url)) return null;
    try {
      const target = new URL(checkin.url, location.href);
      return isCurrentCheckinPage(site, checkin, location.href) ? null : target.href;
    } catch {
      return null;
    }
  }

  const pathOf = (url: string) => {
    try {
      const parsed = new URL(url);
      return `${parsed.pathname}${parsed.search}`;
    } catch {
      return url;
    }
  };

  /**
   * 跳转计数用的地址键：pathname + search + hash。
   *
   * 必须带上 hash：hash 路由站点（`/#/profile`、`/#/check-in`）的页面差别全在
   * hash 里，只取 pathname 会让整条学习路线共用一个 key，跳第三页就撞上
   * `MAX_CHECKIN_NAVIGATIONS` 被当成「重复跳转」而停机。格式与
   * `automation/learning/workflow.ts` 写入「学习路线未命中: … 尝试进入
   * pathname+hash」的约定一致，路外预算的成对计数也能配对成功。
   * hash 变体该不该折叠交给 `sameNavigationPage` 处理。
   */
  const navigationKey = (url: string) => {
    try {
      const parsed = new URL(url, location.href);
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return url;
    }
  };

  async function resolveChallengeResult(
    stage: TaskStage,
    timeoutMs = 120_000,
    includePendingResponse = true,
    appearanceWaitMs = 0,
  ): Promise<ChallengeResolution> {
    const challenge = await waitForChallenge(
      log,
      (message) => host.needsUser(message, steps),
      timeoutMs,
      { includePendingResponse, appearanceWaitMs },
    );
    if (!challenge.resolved) {
      log.push(`${challenge.kind ?? '安全验证'}未在等待时间内完成`);
      return challenge;
    }
    if (challenge.detected) await host.markStage(stage, steps);
    return challenge;
  }

  async function resolveChallenge(
    stage: TaskStage,
    timeoutMs = 120_000,
    includePendingResponse = true,
    appearanceWaitMs = 0,
  ): Promise<boolean> {
    return (await resolveChallengeResult(stage, timeoutMs, includePendingResponse, appearanceWaitMs)).resolved;
  }

  function resolveVisibleChallenge(stage: TaskStage, timeoutMs = 120_000): Promise<boolean> {
    return resolveChallenge(stage, timeoutMs, false);
  }

  async function waitBeforeSubmit(stage: TaskStage): Promise<boolean> {
    // Controlled input/change events often cause the challenge host to mount
    // after the response field. Submission is the point where pending-only
    // evidence becomes actionable and the shared click module waits for it.
    await sleep(600);
    return resolveChallenge(stage, INTERACTIVE_CHALLENGE_TIMEOUT_MS);
  }

  /**
   * 点击业务动作之后，React 可能下一帧才挂载 Turnstile。这里给挂载留一个
   * 有界窗口；若没有验证只是短暂停顿，若出现验证则完整复用统一处理器。
   */
  function waitAfterAction(stage: TaskStage): Promise<boolean> {
    return resolveChallenge(stage, INTERACTIVE_CHALLENGE_TIMEOUT_MS, true, 2_500);
  }

  function waitAfterActionResult(stage: TaskStage): Promise<ChallengeResolution> {
    return resolveChallengeResult(stage, INTERACTIVE_CHALLENGE_TIMEOUT_MS, true, 2_500);
  }

  async function waitForCheckinActionChallenge(appearanceWaitMs = 0): Promise<ChallengeResolution> {
    // 签到专用调度会保留“已出现验证外壳、但控件尚未就绪”的中间态，避免
    // 初次采集失败直接结束任务，导致后面的结果轮询根本没有机会运行。
    const challenge = await waitForCheckinChallenge(
      log,
      (message) => host.needsUser(message, steps),
      INTERACTIVE_CHALLENGE_TIMEOUT_MS,
      appearanceWaitMs,
    );
    if (!challenge.resolved) {
      log.push(challenge.error ? `签到验证未完成：${challenge.error}` : `${challenge.kind ?? '安全验证'}未在等待时间内完成`);
      return challenge;
    }
    if (challenge.detected) {
      await host.markStage('checkin', steps);
      log.push('本次签到的安全验证处理已结束，继续等待明确的签到结果');
    }
    return challenge;
  }

  async function verifyWithIntervention(
    stage: TaskStage,
    onChallenge?: (result: ChallengeResolution) => void,
  ): Promise<boolean> {
    const challenge = await resolveChallengeResult(stage);
    onChallenge?.(challenge);
    if (!challenge.resolved) return false;

    const verifyCurrentPage = async (): Promise<boolean> => {
      const returnedToSite = location.origin === siteOrigin(task.site);
      const postLoginStage = stage === 'verify'
        || stage === 'verify-oauth'
        || stage === 'relogin-verify';

      if (returnedToSite && postLoginStage) {
        // Agent Router 登录成功后先渲染系统公告，再渲染仪表盘。公告必须在
        // 成功验证之前关闭，否则旧的 DOM 标志看不见时流程会先判失败，永远
        // 走不到原先放在成功分支后的公告清理。
        await closeAnnouncements(task.site, log, { waitForAppear: true });

        // 新版控制台把导航项改成 onClick 菜单，不再生成旧版的 <a href>。
        // 带当前 Cookie 的身份接口是更稳定的认证证据；只接受 API 来源，页面
        // 文本和本地残留不用于放宽登录成功判据。
        // 学习路线把账号核验固定在资料页。返回页的身份不能提前成为账号基准，
        // 否则错误会话会先被保存，到了资料页反而与这个错误的新基准“一致”。
        if (!hasLearnedRoute(checkinSite()) || atLearnedIdentityPage(checkinSite())) {
          const identity = await readPageIdentity(siteWithCurrentIdentity());
          if (identity?.source === 'api') {
            log.push('站点身份接口确认登录成功');
            return true;
          }
        }
      }

      return verifyLogin(task.site, log);
    };

    if (await verifyCurrentPage()) return true;

    const manualStep = detectManualLoginStep();
    if (!manualStep) return false;

    log.push(`检测到${manualStep}，等待你在当前标签页完成`);
    await host.needsUser(`${manualStep}需要你在当前标签页完成`, steps);
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline && detectManualLoginStep()) await sleep(500);
    if (detectManualLoginStep()) {
      log.push(`${manualStep}等待超时`);
      return false;
    }

    log.push(`${manualStep}已完成，继续验证登录结果`);
    await host.markStage(stage, steps);
    return verifyCurrentPage();
  }

  /**
   * OAuth/Passkey 既可能整页跳转，也可能由 SPA 在当前文档完成登录。
   * 两条路径都要把身份写回账号；否则下一轮没有 userId 时会把当前浏览器
   * 里任意一个第三方账号误当成本账号继续签到。
   */
  async function rememberExternalIdentity(): Promise<boolean> {
    if (hasLearnedRoute(checkinSite())) {
      log.push('OAuth 会话已建立，账号身份交由个人资料页统一核验');
      return true;
    }
    const evidence = await readCurrentIdentity('OAuth 返回页');
    const verdict = verifyCurrentIdentity(evidence);

    /**
     * 受管 GitHub 首次建立“本地账号 ↔ 站点身份”映射。
     *
     * 只有以下证据同时成立才放行：本轮在 GitHub 官方页精确提交了该账号保存的
     * 凭据、OAuth 已成功回到本站、站点确实返回了身份、且 userId 没有与当前账号
     * 已保存值或本站其它账号发生强冲突。站点用户名与账号标识不同本身不是串号：
     * Future Hub 会把 `demo_104` 对应的 GitHub 身份显示成 `demo104`。
     */
    const managedGithubIdentity = loginMethod === 'github'
      && task.githubCredentialsSubmitted === true
      && evidence.identity?.source === 'api'
      // A submitted credential is useful evidence only when the returned API
      // identity also matches the saved GitHub handle (or the saved primary
      // identity through verifyIdentity). Never let an unknown/mismatching
      // username become an account mapping merely because OAuth completed.
      && verdict.match === 'confirmed'
      && !hasAuthoritativeApiMismatch(evidence, verdict)
      && !hasConflictingCheckinUserId(evidence);
    if (managedGithubIdentity) {
      await rememberIdentity(evidence.identity!);
      const siteIdentity = evidence.identity!.username
        ?? evidence.identity!.email
        ?? evidence.identity!.displayName
        ?? evidence.identity!.userId
        ?? '已验证身份';
      log.push(
        `本轮已使用账号 ${task.username} 保存的 GitHub 凭据完成登录；`
        + `站点返回身份 ${siteIdentity}，已建立账号映射并继续签到`,
      );
      await host.confirmIdentity?.();
      return true;
    }

    /**
     * TaBiAI 这类 SPA 的 OAuth 返回页只证明“站点会话已建立”，不一定渲染站点
     * 用户名。先让统一入口打开资料页，再用资料页的站点账号 + GitHub 句柄核对；
     * 但站点身份接口若明确返回别人，仍立即阻断，不能被入口旁证覆盖。
     */
    if (
      (checkinSite().checkin?.entry || hasLearnedRoute(checkinSite()))
      && verdict.match !== 'confirmed'
      && !hasAuthoritativeApiMismatch(evidence, verdict)
    ) {
      log.push('OAuth 返回页身份字段不完整，将进入本站签到页面后核对');
      return true;
    }

    // 只读到第三方句柄：受管 GitHub 账号本轮亲自登录过就是本人；没登录过就换号重登。
    if (verdict.match !== 'confirmed' && !hasAuthoritativeApiMismatch(evidence, verdict) && evidence.identity) {
      const outcome = await resolveExternalHandleIdentity(evidence, 'OAuth 返回页');
      if (outcome === 'switching') return false;
      if (outcome === 'confirmed') {
        await host.confirmIdentity?.();
        return true;
      }
    }

    const decision = decideIdentityAction({
      loginMethod,
      verdict: verdict.match,
      siteAccountCount: task.siteAccountCount,
      checkinPageAvailable: !!checkinPageElsewhere(),
      canSwitchAccount,
    });

    if (decision.action === 'proceed') {
      if (decision.reason === 'confirmed' && evidence.identity) {
        const label = loginMethod === 'passkey'
          ? 'Passkey'
          : loginMethod === 'github'
            ? 'GitHub OAuth'
            : 'OAuth';
        if (await rememberTrustedIdentity(evidence.identity)) {
          log.push(`已核对并记住 ${label} 账号身份：${verdict.detail}`);
        } else {
          log.push(`已核对 ${label} 当前页面身份：${verdict.detail}`);
          log.push('当前身份证据不是站点接口结果，只用于本轮核对，不更新账号长期映射');
        }
      } else {
        log.push(`${loginMethod} 登录后仍读不到身份，但本站只有该账号，继续执行`);
      }
      await host.confirmIdentity?.();
      return true;
    }

    if (decision.action === 'defer-to-checkin-page') {
      log.push('OAuth 返回页读不到可核对身份，将在签到页核对后再执行签到');
      return true;
    }

    if (decision.action === 'switch-account') {
      const switched = await startManagedGithubSwitch();
      if (switched === 'started') return false;
      await host.needsUser(
        switched === 'exhausted'
          ? githubSwitchExhaustedMessage(verdict, 'OAuth 返回页')
          : '无法同时退出当前站点会话和 GitHub 会话，为避免给错账号签到已停止。',
        steps,
      );
      return false;
    }

    await host.needsUser(
      verdict.match === 'mismatch'
        ? `OAuth 返回后核对到当前登录的是别的账号（${verdict.detail}）。请切换到 ${task.username} 后重新签到。`
        : `OAuth 返回后仍无法确认当前身份，而本站配置了 ${task.siteAccountCount ?? '多个'} 个不同账号。`
          + `请确认页面登录的是 ${task.username} 后重新签到。`,
      steps,
    );
    return false;
  }

  /**
   * 从「别人的登录态」切换到本次要签的账号。
   *
   * 这是修一个真实 bug：以前只清 localStorage 就直接去填表单，
   * 而 HttpOnly cookie 还留着上一个账号的会话，结果是
   * 「点账号 B，站点认成 A」—— 要么给 A 签了到（B 显示绿勾但一天没签），
   * 要么表单提交撞上会话/CSRF 校验直接登录失败。
   *
   * 只有 cookie 站点需要这么麻烦。Token 认证的站点凭据全在 localStorage，
   * 清掉就等于退出了，不用重载页面。
   *
   * 返回值决定调用方怎么继续：
   *  - 'cleared'   退干净了，可以直接在当前页重新登录
   *  - 'reloading' 已重载登录页，本次执行结束，等脚本重新注入后继续
   *  - 'blocked'   退不掉且重载也没意义（重载计数用尽），必须停下报错
   */
  async function switchAccount(): Promise<'cleared' | 'reloading' | 'blocked'> {
    const outcome = await logoutSession(task.site, log, host.clearSiteCookies);

    if (!outcome.cookieMayRemain) {
      // Token 站点接下来会直接注入本账号凭据，不依赖当前页面上的登录表单。
      if (loginMethod === 'token') return 'cleared';

      // Cookie 虽然已经清掉，但当前文档仍可能是旧账号的控制台 DOM。必须重新
      // 打开登录页，让站点按无会话状态渲染表单，不能在旧页面上继续找输入框。
      const reloads = steps.filter((step) => step.startsWith(SWITCH_RELOAD_MARKER)).length;
      if (reloads >= MAX_SWITCH_RELOADS) return 'blocked';
      log.push(`${SWITCH_RELOAD_MARKER} 本站浏览器 Cookie 已清除，重新打开登录页`);
      await host.navigate(task.site.loginUrl, steps, 'login');
      return 'reloading';
    }

    // 兼容没有浏览器 Cookie API 的旧 host：纯 Token 站点仍可依赖本地凭据隔离。
    if (loginMethod === 'token') {
      log.push('该站点凭据只存在本地，清空即已退出，无需重载页面');
      return 'cleared';
    }

    // 没有退出接口：cookie 还在。带着旧 cookie 填表单大概率被站点忽略，
    // 所以重载登录页 —— 本地存储已清空，很多站点在没有 token 的情况下
    // 会把 cookie 会话也当作无效，从而正常渲染登录表单。
    const reloads = steps.filter((step) => step.startsWith(SWITCH_RELOAD_MARKER)).length;
    if (reloads >= MAX_SWITCH_RELOADS) {
      // 已经重载过还是被认成旧账号，说明 cookie 确实清不掉。
      // 宁可失败也不能给错账号签到。
      return 'blocked';
    }

    log.push(`${SWITCH_RELOAD_MARKER} 本地登录态已清空，重新打开登录页以彻底退出`);
    await host.navigate(task.site.loginUrl, steps, 'login');
    return 'reloading';
  }

  /**
   * 受管 GitHub 切号必须同时退出两层会话：本站会话和 github.com 会话。
   * 只清本站会让下一次 OAuth 继续沿用旧 GitHub 账号，正是多账号串号的根因。
   */
  async function startManagedGithubSwitch(): Promise<'started' | 'blocked' | 'exhausted'> {
    if (!canSwitchAccount || !host.startGithubLogout) return 'blocked';
    if (steps.some((step) => step.startsWith(GITHUB_SWITCH_MARKER))) return 'exhausted';

    const outcome = await logoutSession(task.site, log, host.clearSiteCookies);
    if (outcome.cookieMayRemain) return 'blocked';

    log.push(`${GITHUB_SWITCH_MARKER} 已退出站点账号，正在退出当前 GitHub 会话`);
    await host.startGithubLogout(steps);
    return 'started';
  }

  /**
   * Token 认证登录：注入账号自己的会话，跳过表单和 OAuth。
   *
   * 凭据有两个来源，优先级不同：
   *  1. `task.session` —— 用户点「抓取登录态」抓下来的，含 refresh token，
   *     快到期时能自己换新，这是常规路径；
   *  2. `task.apiToken` —— 用户手贴的裸 token，没有 refresh 能力，
   *     过期了只能重贴。留作兜底。
   *
   * 同站多账号各自持有独立凭据，注入前 `logoutSession` 已清掉上一个账号的键。
   */
  async function loginWithToken(): Promise<TaskResult | null> {
    if (!task.site.tokenConfig) {
      return fail('站点未配置 Token 参数（存储键名/请求头），请在站点编辑里补全');
    }

    const session = task.session;
    if (!session?.accessToken && !task.apiToken) {
      return fail('该账号还没有登录凭据；请手动登录该站点一次后点「抓取登录态」');
    }

    // 先清掉可能残留的别人的 token，再写自己的。
    // 必须 await：退出接口还在飞的时候就注入新 token，两个账号的凭据会短暂共存。
    const logout = await logoutSession(task.site, log, host.clearSiteCookies);
    if (host.clearSiteCookies && logout.cookieMayRemain) {
      return fail('无法清除本站浏览器 Cookie，为避免复用其他账号会话已停止');
    }

    let activeToken = session?.accessToken ?? task.apiToken!;
    if (!injectToken(task.site, activeToken, log)) {
      return fail('Token 注入失败，无法继续');
    }

    // 抓来的会话可能已经放了一阵子，先看 access token 是不是快到期了。
    // 注入之后再换：ensureFreshToken 要写回 localStorage，得先有东西可写。
    if (session) {
      const refreshed = await ensureFreshToken(task.site, session, log);
      if (refreshed.status === 'expired') {
        return fail(`${refreshed.reason}；请重新登录该站点后再点「抓取登录态」`);
      }
      if (refreshed.status === 'refreshed') {
        activeToken = refreshed.tokens.accessToken;
        // 让 background 把换到的新令牌写回账号，否则下次又得再换一遍
        await host.saveSession?.(refreshed.tokens);
      }
    }

    // 立刻验证有效性，避免带着废 token 一路跑到签到才失败
    const identity = await readPageIdentity(siteWithCurrentIdentity(), activeToken);
    if (!identity) {
      return fail(
        session
          ? '登录凭据已失效，请重新登录该站点后点「抓取登录态」'
          : 'Token 无效或已过期，请重新从站点获取',
      );
    }

    // 核对读到的身份确实是本次要签的账号 —— 凭据可能是从别的账号抓错的
    const verdict = verifyIdentity(identity, task.username, expectedUserId(), knownUsers);
    if (verdict.match === 'mismatch') {
      return fail(`凭据对应的不是本账号：${verdict.detail}；请重新抓取该账号的登录态`);
    }
    log.push(`Token 认证成功：${identity.email ?? identity.username ?? identity.userId}`);
    await host.confirmIdentity?.();

    await closeAnnouncements(task.site, log, { waitForAppear: true });
    return runCheckin(true);
  }

  /**
   * `loginHappenedThisRun` 与 runCheckin 注入的 hook 同源（loginCompletedThisRun）：
   * settle 在闭包外定义，拿不到 runCheckin 内部的 hooks，所以显式传进来，
   * 用于区分「打开时已登录」和「本轮登录但无签到证据」两种 unverified。
   */
  async function settle(
    outcome: CheckinOutcome,
    loginHappenedThisRun = false,
  ): Promise<TaskResult | null> {
    if (outcome.status === 'interrupted') return outcome.terminal ? fail(outcome.message) : null;
    if (outcome.status === 'navigate') {
      /**
       * 同一个签到页最多跳几次。
       *
       * 站点可能把配置的签到页**重定向**到别处：一梦五千年配的是
       * `/console/personal`，站点却把它转到 `/profile`。于是每次跳转后
       * `samePageUrl(目标, 当前)` 都判为「还没到」，`stage` 又还是 `checkin`，
       * 脚本重新注入后再跳一次 —— 无限循环，日志里同一段反复出现，
       * 直到 10 分钟看门狗把任务杀掉。用户看到的是「一直在签到」。
       *
       * 计数必须写进步骤日志：整页跳转会销毁 content script，内存变量存不住。
       * 与 PAGE_RETRY_MARKER / SWITCH_RELOAD_MARKER 同一套办法。
       */
      const target = navigationKey(outcome.url);
      const navigatedTargets = checkinNavTargets(steps);
      // 按「同一页」语义计数（见 sameNavigationPage）：hash 路由站点的不同
      // hash 页面各自计数，不带 hash 的配置地址仍按 pathname 折叠。
      const already = navigatedTargets.filter((visited) => sameNavigationPage(visited, target)).length;
      const oscillation = detectCheckinOscillation([...navigatedTargets, target]);
      const offRouteNavigations = countOffRouteRouteNavigations(steps);
      /**
       * 三道护栏，共用一个降级出口（下面「在当前页直接寻找签到入口」那段）：
       *
       * 1. 同一个目标地址跳了 `MAX_CHECKIN_NAVIGATIONS` 次还没到（原有）；
       * 2. 两页往返震荡 A→B→A（新增，见 `detectCheckinOscillation`）——
       *    用户日志里「工作流沿学习路线进入 /sign-in」重复出现就是它；
       * 3. 落点不在学习路线上的跳转预算用尽（新增，见
       *    `MAX_ROUTE_OFF_PAGE_NAVIGATIONS`）—— 那是工作流侧死循环的入口。
       *
       * 复用一个出口的理由：三种情况的结论完全相同 —— 那个地址到不了，
       * 该在当前页找入口了。分头写只会让三份逻辑慢慢走偏。
       */
      const blocked = already >= MAX_CHECKIN_NAVIGATIONS
        ? `签到页 ${target} 已跳转 ${already} 次仍未到达（站点把它重定向到了 `
          + `${navigationKey(location.href)}）`
        : oscillation
          ? `签到页在 ${oscillation.first} 与 ${oscillation.second} 之间往返：站点每次都把当前页 `
            + `${navigationKey(location.href)} 重定向回去，再跳只是原样重复`
          : !atLearnedRoutePage(checkinSite()) && offRouteNavigations >= MAX_ROUTE_OFF_PAGE_NAVIGATIONS
            ? `当前页 ${navigationKey(location.href)} 不在学习路线上，已为此跳了 `
              + `${offRouteNavigations} 次仍未落到路线上`
            : null;
      if (blocked) {
        const identityPage = learnedIdentityPageUrl(checkinSite());
        const profileIdentityConfirmed = profileIdentityConfirmedInSteps(steps);
        if (identityPage && !profileIdentityConfirmed) {
          log.push('身份核验页无法到达，拒绝降级绕过身份核验执行签到');
          await host.needsUser(
            '身份核验页未能到达，且跳转预算已用尽；为避免给错账号签到，已停止签到。请检查学习路线中的身份核验页地址。',
            steps,
          );
          return null;
        }
        // 学习路线是用户实际演示的流程；通用地址探测只属于自动识别策略。
        // 在错误页面删掉 route 再跑 steps，会把已学会的流程重新带回旧的猜测路径。
        if (hasLearnedRoute(checkinSite())) {
          log.push(`${blocked}，学习路线无法继续，已停止本次回放`);
          await host.needsUser(
            `学习路线无法继续：${blocked}。已保存的流程仍保留；请确认站点页面可正常打开后重试，页面已改版时重新学习。`,
            steps,
          );
          return null;
        }
        /**
         * 跳不过去时**在当前页尝试签到**，而不是直接失败。
         *
         * 站点把配置的签到页重定向到别处（配 `/console/personal`、实际落在
         * `/dashboard/overview`），说明那个配置地址在这个站上根本不存在。
         * 但**当前落地页很可能就有签到入口** —— 它就是站点自己的控制台。
         *
         * 原来这里直接 `fail`，等于「因为配置写错了地址，就放弃这一页上明摆着
         * 的签到按钮」。实测四个站点踩了同一个坑（一梦五千年、禾维、维云、
         * 海獭），共同点都是配置路径与站点实际路由不符。
         *
         * 扫描当前页是只读的，失败也只是回到原来的失败结论，没有额外风险。
         */
        log.push(`${blocked}，改为在当前页直接寻找签到入口`);
        const local = await performCheckin(
          // 清掉 checkin.url、家族兜底路径与工作流的学习路线：留着它们只会让扫描
          // 再次要求跳转，而那个地址已经证明到不了（工作流的 steps 保留 ——
          // 在当前页执行它们才是「在当前页找签到入口」）。
          localCheckinSite(),
          log,
          checkinHooks,
        );
        /**
         * `failed` 也要继续试别的路由。
         *
         * 这是上一版的实际 bug：降级扫描找不到入口时返回的是 **`failed`**
         * （见 checkin.ts 末尾「签到页未找到明确按钮或已签到状态」），
         * 不是 `navigate`。而当时只对 `navigate` 触发候选路由，于是 `failed`
         * 直接被 `settle` 判成终态失败 —— 候选表一次都没跑到，日志停在
         * 「页面可点元素：跳到主内容 / Toggle Sidebar / …」。
         *
         * `already` / `success` 是真结论，必须原样收尾；`skipped` 是「这一页
         * 确实没有签到功能」，换页仍有意义。
         */
        const exhausted = local.status === 'success' || local.status === 'already';
        if (exhausted) return settle(local);

        /**
         * 当前页也没有入口时，再试一个**还没去过的**常见签到路由。
         *
         * 实测海獭 AI：配置写 `/console/personal`，站点转到 `/profile`，而
         * `/profile` 上只有页面骨架（侧栏、搜索、通知、主题），签到入口在
         * 别的路由上。只扫一页就放弃，等于把「配置地址错了」变成「这站不支持」。
         *
         * 候选来自各代 new-api 界面的实际路由，逐个只试**一次**（靠日志计数
         * 跨页面去重），全试完仍无入口才失败。
         */
        const visited = new Set(navigatedTargets);
        visited.add(navigationKey(location.href));
        const nextRoute = FALLBACK_CHECKIN_ROUTES
          .find((route) => !visited.has(route) && isSameSiteUrl(task.site, route));
        if (nextRoute) {
          log.push(`${CHECKIN_NAV_MARKER}${nextRoute}`);
          log.push(`当前页没有签到入口，改试常见签到路由 ${nextRoute}`);
          await host.navigate(new URL(nextRoute, location.href).href, steps, 'checkin');
          return null;
        }

        return fail(
          `签到页 ${target} 无法到达（站点重定向到 ${navigationKey(location.href)}），`
          + `已试过 ${[...visited].join('、')} 都没有签到入口。`
          + '请打开站点编辑，把签到页改成实际地址',
        );
      }
      log.push(`${CHECKIN_NAV_MARKER}${target}`);
      await host.navigate(outcome.url, steps, 'checkin');
      return null;
    }
    if (outcome.status === 'relogin') {
      log.push(outcome.message);
      await host.navigate(outcome.url, steps, 'relogin');
      return null;
    }
    // 用掉或被站点判重复的领取理由都必须落盘，否则下一轮又会挑到同一条。
    const claimTexts = new Set([
      ...(outcome.claimTextsUsed ?? []),
      ...(outcome.claimTextUsed ? [outcome.claimTextUsed] : []),
    ]);
    for (const text of claimTexts) {
      await host.saveClaimText?.(text);
    }
    // 成功签到的台账只有在手动刷新余额时才写到 `daily.checkinReward`，否则余额
    // 记录里那天永远 $0.00。这里在签到页把当前页面正文交给 background 再采集、
    // 落盘 —— 页面没卸载才调，失败不阻塞签到流程。
    if (outcome.status === 'success' || outcome.status === 'already') {
      void host.saveCheckinReward?.(document.body?.innerText ?? '').catch(() => {});
    }
    // 守恒差分的结果跟着终态一起走，界面才能显示签到收益
    if (outcome.status === 'failed') return failOrRetry(outcome.message, outcome.metrics);
    // skipped 是「这个站点没有签到入口」，属于配置事实，重试没有意义
    if (outcome.status === 'skipped') return fail(outcome.message, outcome.metrics);
    /**
     * unverified：none 走到了「没有签到控件」的兜底。它有两个来源，不能合并成一句话：
     *
     * A. 打开时就已经登录（loginHappenedThisRun === false）——本轮没有可归因的
     *    登录动作，页面上也没有可点的签到控件；不能凭「本来登录着」记绿勾。
     * B. 本轮确实完成了登录，但既没有登录前余额基线可比对、页面也没有签到控件或
     *    完成文案——同样不能凭「登录过」直接判成功。
     *
     * hook 由 runCheckin 注入（loginHappenedThisRun 只认 loginCompletedThisRun），
     * 这里据此选措辞，让「打开时已登录」和「本轮登录但无证据」不再互相冒充。
     *
     * 两个分支都不并入 skipped（换页也变不出一个登录动作），也不走 failOrRetry：
     * classifyFailure 只看文字，可能把它误判成登录态失效而重试，而重试后
     * 页面仍是「打开时已登录」，结论不会变，只会白跑一轮。
     *
     * 交给 needsUser 进入「需处理」而不是直接判失败：这里没有可复现的站点
     * 故障，缺的是用户自己的判断。自动计划会跳过 attention，
     * 不会每次重开这一页再得到同一个结论。
     */
    if (outcome.status === 'unverified') {
      // 两种来源各自点名，末尾固定一条下一步；诊断规则锚定「没有签到动作可确认」
      // 与 outcome.message 的原文，措辞不要改写这两段。
      const lead = loginHappenedThisRun
        ? '本轮已登录，但没有签到动作可确认，未执行签到。'
        : '打开时已登录，本轮没有重新登录，无法把「登录即签到」归因到本轮，未执行签到。';
      const nextStep = loginHappenedThisRun
        ? '请打开该站点标签页确认余额是否已经增加。'
        : '若确认今天的额度已经到账，可在账号行手动标记完成；想每轮都强制退出再登录，请把本站签到方式改成「退出再登录」。';
      const tailEnd = /[。！？]$/.test(outcome.message) ? '' : '。';
      const message = `${lead}${outcome.message}${tailEnd}${nextStep}`;
      log.push(message);
      await host.needsUser(message, steps);
      return null;
    }
    return done(outcome.message, outcome.metrics);
  }

  function githubSwitchExhaustedMessage(
    verdict: ReturnType<typeof verifyIdentity>,
    where: string,
  ): string {
    return verdict.match === 'mismatch'
      ? `已自动切换过 GitHub 账号，但${where}明确核对到的仍不是 ${task.username}`
        + `（${verdict.detail}）；请检查该账号保存的 GitHub 凭据`
      : `已自动切换过 GitHub 账号，但${where}仍未读取到足够的身份信息`
        + `（${verdict.detail}）；这不能证明 GitHub 凭据错误，已停止签到以避免记到错误账号`;
  }

  function logIdentityDiagnostics(
    evidence: CurrentIdentityEvidence,
    verdict: ReturnType<typeof verifyIdentity>,
  ): void {
    const identity = evidence.identity;
    const fields = [
      `URL ${location.href}`,
      `来源 ${identity?.source ?? 'none'}`,
      `userId ${identity?.userId ?? '未读取'}`,
      `username ${identity?.username ?? '未读取'}`,
      `email ${identity?.email ?? '未读取'}`,
      `displayName ${identity?.displayName ?? '未读取'}`,
      `页面账号旁证 ${evidence.pageAccountMatch ?? '未命中'}`,
      `受控身份别名 ${githubIdentityAlias ?? '未配置'}`,
      `结论 ${verdict.match}: ${verdict.detail}`,
    ];
    log.push(`身份页诊断：${fields.join('；')}`);
  }

  function readVisibleCheckinEvidence(): CurrentIdentityEvidence {
    const identity = readVisibleIdentity();
    const onPage = findAccountOnPage(task.username);
    if (!identity) {
      return {
        identity: onPage ? { username: task.username, source: 'visible' } : null,
        ...(onPage ? { pageAccountMatch: onPage.matched } : {}),
      };
    }
    return {
      identity,
      ...(onPage ? { pageAccountMatch: onPage.matched } : {}),
    };
  }

  /**
   * 资料页的 React 内容可能晚于路由和签到按钮挂载。完整身份接口只请求一次，
   * 后续轮询只读当前 DOM，避免每几百毫秒连打多个身份接口。
   */
  async function waitForCheckinIdentity(): Promise<{
    evidence: CurrentIdentityEvidence;
    verdict: ReturnType<typeof verifyIdentity>;
  }> {
    let evidence = await readCurrentIdentity('个人资料页');
    let verdict = verifyCurrentIdentity(evidence);
    verdict = forceCheckinUserIdMismatch(evidence, verdict);
    // 声明了站内入口、或学习路线已经走到独立的个人资料身份页时，都要给 SPA 一点
    // 时间把账号名和用户 ID 渲染出来 —— 否则会读到 unknown，把「其实能核对」误判。
    const shouldWaitForProfile = !!checkinSite().checkin?.entry
      || atLearnedIdentityPage(checkinSite());
    if (!shouldWaitForProfile || verdict.match === 'confirmed') return { evidence, verdict };
    // 站点接口明确说是另一个用户时立即阻断，页面文字不能覆盖权威答案。
    if (hasAuthoritativeApiMismatch(evidence, verdict)) return { evidence, verdict };

    log.push('个人资料页身份信息尚未稳定，等待账号名和用户 ID 完整渲染');
    const deadline = Date.now() + CHECKIN_IDENTITY_WAIT_MS;
    let previousSignature = '';
    let stableSamples = 0;
    let delayMs = 300;

    while (Date.now() < deadline) {
      await sleep(delayMs);
      delayMs = Math.min(1_200, delayMs + 180);
      evidence = readVisibleCheckinEvidence();
      verdict = verifyCurrentIdentity(evidence);
      verdict = forceCheckinUserIdMismatch(evidence, verdict);
      if (verdict.match === 'confirmed') return { evidence, verdict };

      const signature = JSON.stringify({
        identity: evidence.identity,
        pageAccountMatch: evidence.pageAccountMatch,
        match: verdict.match,
      });
      stableSamples = signature === previousSignature ? stableSamples + 1 : 1;
      previousSignature = signature;
      // 只有用户 ID 等强证据连续稳定时才提前切号。第三方句柄与站点账号可能
      // 本来就不同，必须继续等待站点账号区域完成渲染。
      if (
        verdict.match === 'mismatch'
        && stableSamples >= 2
        && hasStrongCheckinMismatch(evidence, verdict)
      ) {
        return { evidence, verdict };
      }
    }

    if (stableSamples < 2) {
      log.push('个人资料页身份在等待期内仍未形成连续稳定样本');
    }
    if (verdict.match === 'mismatch' && !hasStrongCheckinMismatch(evidence, verdict)) {
      log.push('个人资料页只读到第三方句柄，不能据此判定 GitHub 凭据错误或自动切换账号');
      return { evidence, verdict: incompleteExternalIdentityVerdict(evidence) };
    }
    return { evidence, verdict };
  }

  type CheckinIdentityGate =
    | { proceed: true }
    | { proceed: false; result: TaskResult | null };

  async function passCheckinIdentityGate(): Promise<CheckinIdentityGate> {
    const { evidence, verdict } = await waitForCheckinIdentity();
    return applyCheckinIdentityGate(evidence, verdict);
  }

  async function applyCheckinIdentityGate(
    evidence: CurrentIdentityEvidence,
    verdict: ReturnType<typeof verifyCurrentIdentity>,
  ): Promise<CheckinIdentityGate> {

    // 站内资料入口和学习路线的 identityPath 都把“此页可核对身份”作为硬前提。
    // unknown 不能因为只有一个账号或持有 GitHub 凭据而被放行/切号：那正是
    // TaBiAI 之前把尚未渲染完成误报为“当前仍不是 demo-user”的根因。
    const requiresProfileIdentity = !!checkinSite().checkin?.entry
      || atLearnedIdentityPage(checkinSite());
    // 第三方登录只读到第三方句柄：受管 GitHub 可以自己核实（本轮亲自登录过）或自己换号。
    if (verdict.match === 'unknown' && externalLogin && evidence.identity) {
      const outcome = await resolveExternalHandleIdentity(evidence, '个人资料页');
      if (outcome === 'switching') return { proceed: false, result: null };
      if (outcome === 'confirmed') {
        if (atLearnedIdentityPage(checkinSite())) log.push(PROFILE_IDENTITY_CONFIRMED_MARKER);
        await host.confirmIdentity?.();
        return { proceed: true };
      }
    }
    if (requiresProfileIdentity && verdict.match === 'unknown') {
      logIdentityDiagnostics(evidence, verdict);
      await host.needsUser(
        `身份核验页仍未显示可核对的账号身份（${verdict.detail}）。`
          + '已停止签到和奖励读取，请确认该页面已完整加载后重试；'
          + '若这一页本来就不显示当前账号，请重新学习签到流程，并先访问一个能显示当前账号的个人资料页。',
        steps,
      );
      return { proceed: false, result: null };
    }

    const decision = decideIdentityAction({
      loginMethod,
      verdict: verdict.match,
      siteAccountCount: task.siteAccountCount,
      // 本轮已登录只能解释“暂时读不到”；明确不匹配仍必须阻断。
      identityConfirmedThisRun: verdict.match === 'unknown'
        && !requiresProfileIdentity
        ? task.identityConfirmed
        : false,
      checkinPageAvailable: false,
      canSwitchAccount,
    });

    if (decision.action === 'proceed') {
      if (decision.reason === 'confirmed') {
        if (evidence.identity && !(await rememberTrustedIdentity(evidence.identity))) {
          log.push('个人资料页身份只来自页面或本地副本，本轮核对通过但不更新长期账号映射');
        }
        log.push(`个人资料页已核对账号身份：${verdict.detail}`);
        if (atLearnedIdentityPage(checkinSite())) log.push(PROFILE_IDENTITY_CONFIRMED_MARKER);
        await host.confirmIdentity?.();
      } else if (decision.reason === 'already-confirmed-this-run') {
        log.push('本轮登录账号已经确认，签到页暂未返回额外身份字段，继续签到');
      } else {
        log.push('个人资料页读不到可核对的身份，但本站只有该账号，继续签到');
      }
      return { proceed: true };
    }

    logIdentityDiagnostics(evidence, verdict);

    if (decision.action === 'handoff' || decision.action === 'defer-to-checkin-page') {
      await host.needsUser(
        verdict.match === 'mismatch'
          ? `个人资料页当前登录的不是账号 ${task.username}（${verdict.detail}）。已停止签到和奖励读取，请切换账号后重试。`
          : `个人资料页无法确认当前登录的是账号 ${task.username}，而本站配置了 ${task.siteAccountCount ?? '多个'} 个不同账号。`
            + '已停止签到和奖励读取，请确认账号后重试。',
        steps,
      );
      return { proceed: false, result: null };
    }

    if (decision.action === 'switch-account') {
      if (canSwitchAccount) {
        const switched = await startManagedGithubSwitch();
        if (switched === 'started') return { proceed: false, result: null };
        return {
          proceed: false,
          result: fail(switched === 'exhausted'
            ? githubSwitchExhaustedMessage(verdict, '个人资料页')
            : '无法清除当前站点的浏览器 Cookie，为避免给错账号签到已停止；请检查扩展 Cookie 权限或残留项'),
        };
      }

      const switched = await switchAccount();
      if (switched === 'reloading') return { proceed: false, result: null };
      if (switched === 'blocked') {
        return {
          proceed: false,
          result: fail('无法清除当前站点的浏览器 Cookie，为避免给错账号签到已停止；请检查扩展 Cookie 权限或残留项'),
        };
      }
      await host.navigate(task.site.loginUrl, steps, 'login');
      return { proceed: false, result: null };
    }

    return {
      proceed: false,
      result: fail(`个人资料页核对到账号不符：${verdict.detail}；已停止签到和奖励读取`),
    };
  }

  /** 学习步骤只负责业务动作，公告、验证和会话变化由运行时接管。 */
  async function checkWorkflowSession(
    context: WorkflowCheckpoint,
  ): Promise<Extract<WorkflowRunResult, { status: 'interrupted' | 'failed' }> | null> {
    const site = checkinSite();
    if (!usesCheckinWorkflow(site)) return null;
    if (!isSameSiteUrl(site, location.href)) {
      const message = '学习流程已离开本站，停止页面操作';
      return { status: 'interrupted', message, terminal: true };
    }
    // 最终动作闸门只核对身份，不能再清公告或解验证而使已定位的控件失效。
    if (context.phase !== 'action') await closeAnnouncements(site, log, { waitForAppear: false });
    // 先过验证再定位，沿用原有自动求解与等待机制，不新增转人工即中断的分支。
    if (context.phase !== 'action') {
      const challenge = await waitForCheckinActionChallenge();
      if (!challenge.resolved) {
        const message = challenge.error ?? '学习流程的人机验证未完成，已停止操作';
        return { status: 'interrupted', message, terminal: true };
      }
    }

    const loginPrompt = hasVisibleLoginPrompt(site) && !pageShowsSignedIn(site);
    const onAuthPage = isAuthLearningPath(`${location.pathname}${location.hash}`) && !pageShowsSignedIn(site);
    // 业务操作前和结算时向服务端核对；其它检查只读 DOM，避免高频轮询身份接口。
    //
    // 只用来「尽力读到身份」，**不**用 401 判断掉线：new-api 各分叉的身份接口
    // 只认 `Authorization: Bearer`，用 cookie 去问必然 401，页面却可能正停在
    // 已登录的资料页上（见 identity.ts 的长注释）。掉线只认页面形态与导航行为。
    const mustReadServer = loginPrompt || onAuthPage || context.phase === 'result' || context.phase === 'action'
      || context.phase === 'after' && context.step?.type === 'assert';
    const serverIdentity = mustReadServer
      ? await readPageIdentity(siteWithCurrentIdentity(), undefined, { serverOnly: true })
      : null;

    const evidence = serverIdentity?.source === 'api'
      ? { identity: serverIdentity }
      : readVisibleCheckinEvidence();
    const verdict = verifyCurrentIdentity(evidence);
    if (hasStrongCheckinMismatch(evidence, verdict)) {
      log.push(`学习流程中检测到账号变化：${verdict.detail}`);
      const gate = await applyCheckinIdentityGate(evidence, forceCheckinUserIdMismatch(evidence, verdict));
      if (!gate.proceed) {
        if (gate.result) return { status: 'interrupted', message: gate.result.message, terminal: true };
        return { status: 'interrupted', message: '账号已变化，正在切换到目标账号后重新执行' };
      }
    }
    /**
    /**
     * 什么才算「登录状态真的失效」？
     *
     * 只认**页面自己承认**的两条客观证据，都与站点文案无关：
     * - `loginPrompt`：页面上摆着**登录用的**密码框（已排除改密码表单）；
     * - `onAuthPage`：当前停在登录/鉴权路由上，且页面不像已登录。
     *
     * 身份接口的 401 **不参与**这个判断。实测 8 个 new-api 分叉：它们的身份接口
     * 只认 `Authorization: Bearer`，用 cookie 问必然 401，而页面可能正停在已登录
     * 的资料页上。按响应体措辞逐站打补丁追不完（新增站点换一种说法就再坏一次），
     * 所以这条证据被整体移除，见 identity.ts 的长注释。
     */
    if ((loginPrompt || onAuthPage) && serverIdentity?.source !== 'api') {
      const message = '学习流程中登录状态已失效，需要重新登录';
      const attempts = steps.filter((step) => step.startsWith(WORKFLOW_LOGIN_RECOVERY_MARKER)).length;
      if (attempts >= MAX_WORKFLOW_LOGIN_RECOVERIES) {
        return { status: 'interrupted', message: `${message}；自动恢复 ${MAX_WORKFLOW_LOGIN_RECOVERIES} 次仍未保持会话`, terminal: true };
      } else {
        log.push(`${WORKFLOW_LOGIN_RECOVERY_MARKER} ${attempts + 1}/${MAX_WORKFLOW_LOGIN_RECOVERIES}，返回登录页重新认证`);
        clearAuthBootstrapCache();
        await host.navigate(task.site.loginUrl, steps, 'login');
      }
      return { status: 'interrupted', message };
    }
    return null;
  }

  /**
   * 所有登录成功路径统一从这里进入签到，避免某一分支继续直接请求 /profile。
   * `loginCompletedThisRun` 只在当前任务确实完成认证的出口置为 true；打开时
   * 已有登录态不能据此把历史余额变化冒充成本轮登录奖励。
   */
  async function runCheckin(loginCompletedThisRun = false): Promise<TaskResult | null> {
    // `none` 的历史遗留 entry/url 已在 checkinSite() 里清掉；学习到的
    // route/identityPath 保留 —— none 不回放签到步骤，但登录后的身份核对
    // 仍然按学到的资料页走。本函数与身份闸门辅助函数看到同一份快照。
    const site = checkinSite();
    // 跨文档回跳登录页时仍处于 checkin 阶段，先恢复认证，不能继续沿旧路线跳转。
    if (usesCheckinWorkflow(site) && (isAuthLearningPath(`${location.pathname}${location.hash}`)
      || hasVisibleLoginPrompt(site) && !pageShowsSignedIn(site))) {
      const interrupted = await checkWorkflowSession({ phase: 'before' });
      if (interrupted) return interrupted.status === 'failed' || interrupted.terminal ? fail(interrupted.message) : null;
    }
    const loginCheckin = site.checkin?.method === 'none';
    const entry = site.checkin?.entry;
    // `task` 是当前文档注入时的不可变快照。OAuth 可能直接落到签到页：下面虽会
    // 把后台阶段写成 checkin，本函数里的 task.stage 仍是 verify-oauth。若只看旧
    // stage 就会在当前页直接点按钮，完全绕过身份闸门。
    const buttonAlreadyOnCurrentPage = site.checkin?.method === 'button'
      && !checkinPageElsewhere();
    /**
     * 学习路线必须包含身份核验页：独立的资料页，或与签到终点同址的签到页本身
     * （站点把签到按钮放在资料页上）。route 在异步导航之间保持同一顺序；
     * 到核验页时先核对身份，再继续签到。
     */
    const learnedRoute = hasLearnedRoute(site);
    const identityPage = learnedIdentityPageUrl(site);
    if (learnedRoute && !identityPage) {
      log.push('学习签到路线缺少身份核验页');
      await host.needsUser(
        '该学习签到流程没有记录到可核验账号的身份页；'
          + '请重新学习签到流程：先访问能显示当前账号的个人资料页（签到按钮就在资料页上时直接在该页签到），再结束学习。',
        steps,
      );
      return null;
    }

    const atLearnedCheckinTerminal = atLearnedCheckinPage(site);
    const atProfileIdentityPage = atLearnedIdentityPage(site);
    const profileIdentityConfirmed = profileIdentityConfirmedInSteps(steps);
    if (identityPage && atLearnedCheckinTerminal && !profileIdentityConfirmed && !atProfileIdentityPage) {
      log.push('已到达签到目标页但本轮尚未核验个人资料身份，先返回 identityPath');
      return settle({ status: 'navigate', url: identityPage });
    }

    /**
     * 「登录即签到」且学过身份页：先去资料页核对账号，再回来收尾。
     *
     * 1412 那类站点登录后停在 /dashboard，身份和余额都不在落地页上；不主动走
     * 学习路线，身份闸门就没有可核对的页面，none 只能永远转「需处理」。
     * 到达身份页后（下一轮注入）requiresCheckinGate 会命中 atProfileIdentityPage，
     * 走完闸门再回 landing 页收尾。
     */
    if (loginCheckin && identityPage && !atProfileIdentityPage && !profileIdentityConfirmed) {
      log.push(`登录即签到：先按学习路线前往身份核验页 ${identityPage}`);
      // 跨文档导航会销毁内存里的 loginCompletedThisRun；把「本轮已全新登录」
      // 写进步骤日志，下一轮注入据此恢复（见检查 FRESH_LOGIN_MARKER 的分支）。
      if (loginCompletedThisRun) log.push(`${FRESH_LOGIN_MARKER}${task.username}`);
      return settle({ status: 'navigate', url: identityPage });
    }

    const routeStillEnRoute = learnedRoute && !atLearnedCheckinTerminal;
    /**
     * `none` 的旧 entry/url/workflow 已从站点快照清掉，因此不再有入口导航与
     * 学习路线专属闸门；但普通身份闸门仍然保留 —— 跨文档续跑落到 checkin
     * 阶段时（task.stage === 'checkin'），本轮登录身份已确认就走放行分支，
     * 多账号且身份读不到时交给用户确认，绝不把「登录即签到」当成盲签的借口。
     */
    const requiresCheckinGate = identityPage
      ? atProfileIdentityPage
      : task.stage === 'checkin'
        || !!entry
        || buttonAlreadyOnCurrentPage
        || atLearnedCheckinTerminal;

    if (entry || (site.checkin?.method === 'button' && task.stage !== 'checkin')) {
      // 第一个入口或签到按钮点击前先落盘。button 的跨页余额基线只允许在
      // checkin 阶段写入，避免其它页面伪造 `button-before` 快照。
      await host.markStage('checkin', steps);
    }

    if (requiresCheckinGate) {
      if (!await resolveChallenge('checkin')) return fail('安全验证超时，请完成后重新签到');
      await closeAnnouncements(site, log, { waitForAppear: true });
    }

    if (entry) {
      const prepared = await prepareCheckinEntry(site, log, {
        beforeAction: () => resolveChallenge('checkin', INTERACTIVE_CHALLENGE_TIMEOUT_MS),
      });
      if (prepared.status === 'navigate') {
        await host.navigate(prepared.url, steps, 'checkin');
        return null;
      }
      if (prepared.status === 'failed') return fail(prepared.message);
      // 资料页本身也可能挂载新的公告或验证控件。
      await closeAnnouncements(site, log, { waitForAppear: true });
    }

    // 学习路线上的非身份页只负责按路线导航；身份闸门固定在 identityPath ——
    // 独立资料页时在那一页跑，与签到终点同址时就在终点页上、点击之前跑。
    const shouldPassIdentityGate = identityPage
      ? requiresCheckinGate
      : requiresCheckinGate && !routeStillEnRoute;
    if (shouldPassIdentityGate) {
      if (!await resolveChallenge('checkin', INTERACTIVE_CHALLENGE_TIMEOUT_MS)) {
        return fail('个人资料页身份核对前的人机验证未完成');
      }
      const identityGate = await passCheckinIdentityGate();
      if (!identityGate.proceed) return identityGate.result;
    }

    const currentSite = checkinSite();
    /**
     * none 的「登录即签到」必须以本轮真的发生过登录为前提。
     *
     * `loginHappenedThisRun` 只认 `loginCompletedThisRun` 这一个来源，不从
     * 页面登录态、身份确认标记或余额基线反推 —— 打开时本来就已登录的页面
     * 同样「已登录」，但那是上一轮留下的会话，不能证明本轮登录动作发生过。
     * 余额基线仍只在刚登录成功时注入：打开时已登录时它的历史变化同样不能
     * 冒充成本轮登录奖励。
     *
     * 跨文档恢复（见 FRESH_LOGIN_MARKER）：
     *
     * 整页跳转会销毁 content script，`loginCompletedThisRun` 这个内存变量
     * 随之丢失；「登录即签到」又恰好必须跨一次文档（登录落地页 → 学习路线里
     * 的资料页），所以两个信号都要从 steps 里恢复：
     *  - `loginHappenedThisRun` —— 允许把无控件的页面判成 success；
     *  - `loginCheckinBalanceBefore` —— 缺了它 `performCheckin` 的升级条件
     *    永远差一半，于是余额明明涨了、页面也确实没有签到控件，结果仍是
     *    unverified（用户看到灰标）。基线本身存在 storage.session 的任务信箱
     *    里，本来就活过了跳转，只是此前没取出来用。
     */
    const freshLoginAfterNavigation = loginCompletedThisRun || freshLoginInSteps(steps);
    /**
     * 基线只在**本轮确实登录过**时注入。`loginCompletedThisRun` 为 false 时
     * 不能丢这份基线：它来自任务信箱，值本身已经过「只认本轮登录前采样」的
     * 检验（见 background 的 loginCheckinBalanceBaseline），跨文档后仍然成立。
     */
    const loginCheckinBalanceBefore = freshLoginAfterNavigation
      ? task.context?.loginCheckinBalanceBefore
      : undefined;
    const hooks = currentSite.checkin?.method === 'none'
      ? {
          ...checkinHooks,
          loginHappenedThisRun: freshLoginAfterNavigation,
          ...(loginCheckinBalanceBefore ? { loginCheckinBalanceBefore } : {}),
        }
      : checkinHooks;
    // settle 的第二个参数同样要认跨文档标记：否则本轮登录过、签到也确实成功，
    // 也会被当成「打开时已登录」而丢掉本轮奖励口径。
    return settle(await performCheckin(currentSite, log, hooks), freshLoginAfterNavigation);
  }

  try {
    const pageIssue = detectPageAvailabilityIssue();
    if (pageIssue) {
      const previousRetries = steps.filter((step) => step.startsWith(PAGE_RETRY_MARKER)).length;
      if (pageIssue.retryable && previousRetries < PAGE_RETRY_DELAYS.length) {
        const attempt = previousRetries + 1;
        log.push(`${PAGE_RETRY_MARKER} ${attempt}/${PAGE_RETRY_DELAYS.length}: ${pageIssue.message}`);
        await sleep(PAGE_RETRY_DELAYS[previousRetries]!);
        await host.navigate(location.href, steps, task.stage);
        return null;
      }
      return fail(`${pageIssue.message}，已停止本次签到；这不是表单选择器问题`);
    }

    const managedChallenge = await waitForManagedChallenge(
      log,
      (message) => host.needsUser(message, steps),
    );
    if (!managedChallenge.resolved) {
      return fail(`${managedChallenge.kind ?? 'Cloudflare 安全验证'}超时，请完成后重新签到`);
    }
    if (managedChallenge.detected) await host.markStage(task.stage, steps);

    // Only full-page managed challenges block entry to a stage. Inline widgets
    // are resolved by the action hook immediately before their real click.

    switch (task.stage) {
      // ── 签到阶段 ─────────────────────────────────
      case 'checkin': {
        /**
         * 跨文档续跑：登录成功后跳一次页，content script 被销毁重建，
         * `loginCompletedThisRun` 永远不会到这里。只能从 steps 里的标记恢复，
         * 否则「登录即签到」在续跑这一轮会被当成「打开时已登录」。
         */
        return runCheckin(freshLoginInSteps(steps));
      }

      // ── 登录后校验 ────────────────────────────────
      case 'verify': {
        // 等页面稳定
        await sleep(800);
        if (location.origin !== siteOrigin(task.site)) {
          return fail('登录跳转到了非本站页面，已停止自动操作');
        }
        const verified = await verifyWithIntervention('verify');
        if (!verified) return fail(`未找到明确的登录成功证据(${location.pathname})`);
        log.push(`登录结果已确认(${location.pathname})`);
        if (!hasLearnedRoute(checkinSite())) {
          // 旧站点保留本轮登录确认；学习路线必须先经过资料页身份核验，
          // 不能把“表单提交后有人登录”当成“确实是目标账号”。
          await host.confirmIdentity?.();
          const verifiedIdentity = await readPageIdentity(siteWithCurrentIdentity());
          if (verifiedIdentity) await rememberTrustedIdentity(verifiedIdentity);
        }
        return runCheckin(true);
      }

      // ── OAuth 跳回校验 ────────────────────────────
      case 'verify-oauth': {
        await sleep(1200);
        if (location.origin !== siteOrigin(task.site)) {
          return fail('OAuth 尚未返回本站，请在授权页完成操作');
        }
        const verified = await verifyWithIntervention('verify-oauth');
        if (!verified) return fail('OAuth 授权后缺少明确的登录成功证据');
        log.push(`OAuth 授权完成，已跳回本站(${location.pathname})`);
        // OAuth 返回不等于账号正确：GitHub 可能直接沿用浏览器里另一个账号的
        // 会话。先核对身份，确认后才记作以后复签的基准。
        if (!await rememberExternalIdentity()) return null;
        return runCheckin(true);
      }

      // ── 退出后的第二次登录 ────────────────────────
      case 'relogin': {
        log.push('开始第二次登录以完成签到');
        await closeAnnouncements(task.site, log);

        /**
         * 退出真的生效了吗？
         *
         * 站点退出接口常常无论如何都回 success（AgentRouter 的 /api/user/logout 未登录也回
         * `{success:true}`），会话 cookie 却还在。此时页面仍是已登录的控制台，去找登录
         * 按钮只会报「未找到 OAuth 按钮」，让人以为是登录配置坏了。先问一次站点：还能读到
         * 身份就如实说清是「退出没生效」，而不是去找一个不存在的登录入口。
         *
         * 只有**接口和页面都说还在站内**才下这个结论。接口单方面说有会话、页面却已是
         * 登录页时，可能只是存储里残留的旧 Bearer 还被接口认 —— 第二次登录会覆盖它，
         * 照常往下走，不能把一次本来能成的重登拦下。
         */
        if (loginMethod !== 'token' && !hasVisibleLoginPrompt(task.site)) {
          const stillSignedIn = await readPageIdentity(siteWithCurrentIdentity(), undefined, { serverOnly: true });
          if (stillSignedIn?.source === 'api' && !pageShowsSignedIn(task.site)) {
            log.push('站点接口仍返回登录身份，但页面上已没有站内证据，照常进行第二次登录');
          } else if (stillSignedIn?.source === 'api') {
            log.push('站点退出后会话仍然有效（身份接口还能读到当前账号），退出没有生效');
            await host.needsUser(
              '本站的退出操作没有真正结束会话（退出接口返回成功，但站点仍保持登录），无法完成「退出再登录」。'
                + '请在站点设置里补充退出按钮选择器（或退出前要先点开的头像菜单），或改用「登录即签到」。',
              steps,
            );
            return null;
          } else {
            /*
             * 探测没读到身份（未登录，或接口需要扩展拿不到的认证信息）。
             *
             * 与 login 阶段同一口径：读不到也要说一声，否则「探测真的跑过、
             * 只是没结论」与「压根没探测」在日志里长得一模一样。
             *
             * 清缓存只属于这一支：探测时若顺手试过令牌引导，失败结果会被缓存
             * 20 秒，而接下来马上要登录 —— 不能让它挡住登录后的读取。反向的两
             * 支要么已经停机、要么本来就没有会话要读，没有这个顾虑。
             */
            log.push('站点身份接口没有返回当前登录身份（未登录，或接口需要扩展拿不到的认证信息），按已退出处理');
            clearAuthBootstrapCache();
          }
        }

        if (loginMethod === 'token') {
          // token 站点的「退出再登录」就是重新注入 token
          const session = task.session;
          if (!session?.accessToken && !task.apiToken) {
            return fail('该账号未填写 API Token 也没有抓取登录态，无法完成第二次登录');
          }
          const activeToken = session?.accessToken ?? task.apiToken!;
          if (!injectToken(task.site, activeToken, log)) return fail('Token 注入失败，第二次登录未完成');
          const identity = await readPageIdentity(siteWithCurrentIdentity(), activeToken);
          if (!identity) return fail('第二次注入 Token 后仍读不到身份，签到未完成');
          log.push(`第二次 Token 认证成功：${identity.email ?? identity.username ?? identity.userId}`);
          return finishRelogin('退出后重新登录（Token）');
        }

        if (externalLogin) {
          // relogin 退出后可能落在站点首页；与首次 OAuth 登录一样，
          // 先进入登录页再找第三方授权按钮。
          await closeAnnouncements(task.site, log, { waitForAppear: true });
          if (!await resolveVisibleChallenge('relogin', INTERACTIVE_CHALLENGE_TIMEOUT_MS)) {
            return fail('展开第二次登录入口前的人机验证未完成');
          }
          await revealExternalLogin(
            task.site,
            log,
            loginMethod === 'github' ? 'github' : loginMethod === 'passkey' ? 'passkey' : 'oauth',
            { beforeClick: () => resolveVisibleChallenge('relogin', INTERACTIVE_CHALLENGE_TIMEOUT_MS) },
          );
          if (!await resolveChallenge('relogin')) return fail('安全验证超时，请完成后重新签到');
          const ok = await clickOAuthButton(
            task.site,
            log,
            {
              beforeClick: () => waitBeforeSubmit('relogin'),
              afterClick: () => waitAfterAction('relogin-verify'),
              beforeAuxiliaryClick: () => resolveVisibleChallenge('relogin', INTERACTIVE_CHALLENGE_TIMEOUT_MS),
              beforeNavigate: () => host.markStage('relogin-verify', steps),
            },
            loginMethod === 'github' ? 'github' : loginMethod === 'passkey' ? 'passkey' : 'oauth',
          );
          if (!ok) return fail(`未找到${loginMethod === 'passkey' ? ' Passkey' : ' OAuth'} 按钮，无法完成第二次登录`);
          // 同首次登录：等这一跳真的开始，别在还没卸载的登录页上判失败
          if (await waitForExternalLoginNavigation(task.site, log)) return null;
          const verified = await verifyWithIntervention('relogin-verify');
          if (!verified) return fail(`第二次${loginMethod === 'passkey' ? ' Passkey' : ' OAuth'} 登录未确认成功`);
          if (!await rememberExternalIdentity()) return null;
          return finishRelogin(`退出后重新登录（${loginMethod === 'passkey' ? 'Passkey' : loginMethod === 'github' ? 'GitHub OAuth' : 'OAuth'}）`);
        }

        // form fallback
        await revealLoginForm(task.site, log, {
          beforeClick: () => resolveVisibleChallenge('relogin', INTERACTIVE_CHALLENGE_TIMEOUT_MS),
        });
        const filled = await fillCredentials(
          task.site,
          task.username,
          task.password,
          log,
          async () => {
            await host.markStage('relogin', steps);
            return waitBeforeSubmit('relogin');
          },
          () => resolveVisibleChallenge('relogin', INTERACTIVE_CHALLENGE_TIMEOUT_MS),
        );
        if (!filled) return fail(credentialFailure());
        await closeAnnouncements(task.site, log);
        const submitted = await submitLogin(task.site, log, {
          beforeClick: () => waitBeforeSubmit('relogin'),
          afterClick: () => waitAfterAction('relogin-verify'),
          beforeAuxiliaryClick: () => resolveVisibleChallenge('relogin', INTERACTIVE_CHALLENGE_TIMEOUT_MS),
          beforeNavigate: () => host.markStage('relogin-verify', steps),
        });
        if (!submitted) return fail('未能提交登录表单');
        const ok = await verifyWithIntervention('relogin-verify');
        return ok ? finishRelogin('退出后重新登录') : fail('第二次登录未确认成功');
      }

      // ── relogin 第二次登录后校验 ──────────────────
      case 'relogin-verify': {
        await sleep(1000);
        const verified = await verifyWithIntervention('relogin-verify');
        if (!verified) return fail('重新登录后缺少明确的登录成功证据，签到未完成');
        if (externalLogin && !await rememberExternalIdentity()) return null;
        log.push('第二次登录成功，签到完成');
        return finishRelogin('退出后重新登录');
      }

      // ── 首次登录（处理三种方式）────────────────────
      default: {
        log.push(`开始处理站点「${task.site.name}」账号 ${task.username}`);
        await closeAnnouncements(task.site, log);

        // 所有登录方式都先检测现有会话，避免已登录时仍在仪表盘找用户名框。
        /**
         * 这里只给页面很短的时间给出**明确**结论（登录表单或站内证据），
         * 不靠它把「页面到底登录了没」等到底。
         *
         * 紧接在后面的身份接口探测才是权威答案，而且是单次请求、有明确
         * 成功/失败。如果这里也等满 6 秒，一次普通签到会先白等好几秒，
         * 再发出本来一秒就能发出的请求。`detectAlreadyLoggedIn` 先等 2 秒让
         * SPA 跳走，之后每 300ms 轮询一次；看见表单就立刻返回。超时只决定
         * 「既无站内证据、也无登录表单」的尴尬页最多等多久 —— 2 秒太短，
         * 已登录站点会在路由就绪前被误判成未登录（一梦五千年 /sign-in 实测）。
         */
        let alreadyIn = await detectAlreadyLoggedIn(task.site, log, 6_000);
        /**
         * 页面上既没有站内证据、也没有登录表单（SPA 外壳还没渲染、或落在了一个
         * 不认识的落地页）时，**先问站点「当前是谁」**，再决定要不要找输入框。
         *
         * 这是最快的核对方式：身份接口 / 本地登录态一次读完，不必等页面渲染。
         * 读到身份就按「已登录」处理，交给下面同一道核对：本账号 → 直接签到；
         * 别的账号 → 退出后用本账号登录。读不到才按未登录继续找表单。
         * 旧逻辑在这里直接去找输入框，已登录的浏览器会落到「页面上找不到要操作的
         * 控件」—— 让用户重新学习一个本来就没有坏的登录流程。
         */
        /** 探测拿到的服务端身份：下面的核对直接用它，不再回头去读本地副本。 */
        let probedIdentity: PageIdentity | null = null;
        // Token 站点的凭据就在扩展手里：直接注入本账号 token 更快也更确定，不靠探测。
        if (!alreadyIn && loginMethod !== 'token' && !hasVisibleLoginPrompt(task.site)) {
          // serverOnly：Sub2API 系会先读本地 auth_user 副本并直接返回，不问接口 ——
          // 那份副本可能是过期会话的残留。这里必须让服务端回答「当前是谁」。
          const probed = await readPageIdentity(siteWithCurrentIdentity(), undefined, { serverOnly: true });
          // 只认**站点接口**的回答：它证明会话 Cookie 此刻有效。本地登录态副本可能是
          // 过期残留；登录页上读到的「页面身份」可能只是页脚的联系邮箱 —— 误判成已登录
          // 会沿学习路线反复被站点踢回登录页，最后卡在「身份核验页未能到达」。
          if (probed?.source === 'api') {
            log.push('页面上没有登录表单，但站点接口返回了当前登录身份，按已登录处理并核对账号');
            alreadyIn = true;
            probedIdentity = probed;
          } else {
            // 读不到要能查：失败原因多半是站点需要额外的认证头，日志里点明比静默回落好。
            log.push('站点身份接口没有返回当前登录身份（未登录，或接口需要扩展拿不到的认证信息），按未登录处理');
            // 探测时若顺手试过令牌引导，失败结果会被缓存 20 秒；接下来马上要登录，不能让它挡住登录后的读取。
            clearAuthBootstrapCache();
          }
        }
        if (alreadyIn) {
          /**
           * 本轮任务已经亲自登录过（跨页面标记），当前登录态就是这次填的账号，
           * 不需要再核对一次。
           *
           * 为什么必须有这条捷径：有的站点（SharedChat）只用 HttpOnly cookie，
           * 页面、localStorage、接口都读不到用户名 —— 每次跳转都会判成
           * 「读不到身份」而保守重登，于是流程在登录页与领取页之间来回打转，
           * 永远走不到领取那一步。
           */
          if (task.identityConfirmed) {
            log.push('本轮已确认过登录账号，直接继续');
            await closeAnnouncements(task.site, log, { waitForAppear: true });
            /**
             * 这里必须如实把「本轮登录过」交给 runCheckin。
             *
             * `task.identityConfirmed` 为真意味此前已在本轮通过身份闸门，
             * 而闸门只在本轮真的完成认证后才会置位；无参调用 runCheckin 会
             * 按「打开时已登录」处理，登录即签到的余额差分因此失效。
             * （本轮尚未登录过时该表达式为 false，行为与原实现一致。）
             */
            return runCheckin(freshLoginInSteps(steps));
          }

          // ⚠️ 多账号安全核查：「有人登录」≠「登录的是本次要签的那个人」。
          // 如果不校验就直接签到，点账号 B 可能给账号 A 签了到 ——
          // 界面上 B 显示绿色对勾，B 实际一天都没签。
          // 需要语义入口的站点必须先进入资料页；仪表盘的空壳身份不能触发
          // GitHub 切号，也不能把 /profile 直接地址导航当成入口。
          //
          // 学习出来的工作流站点同理：它没有 entry，显示账号的资料页藏在
          // workflow.route 末项里。在落地页（多半是仪表盘）读不到身份就当场决策，
          // 会把「其实跳一页就能核对」误判成重登或盲签。交给 runCheckin：它沿
          // route 走到资料页终点，再在那里跑同一道身份闸门。
          if (checkinSite().checkin?.entry || hasLearnedRoute(checkinSite())) return runCheckin(freshLoginInSteps(steps));

          // 刚问过站点接口就直接用它的回答：再走 readCurrentIdentity 会让本地副本抢答。
          const evidence: CurrentIdentityEvidence = probedIdentity
            ? { identity: probedIdentity }
            : await readCurrentIdentity('当前页');
          const verdict = verifyCurrentIdentity(evidence);
          // 决策规则抽到 identity-policy.ts：这段判断决定「会不会给错账号签到」，
          // 必须被单元测试锁住，而 engine 依赖真实 DOM 和跨页跳转，测不了。
          const decision = decideIdentityAction({
            loginMethod,
            verdict: verdict.match,
            siteAccountCount: task.siteAccountCount,
            checkinPageAvailable: !!checkinPageElsewhere(),
            canSwitchAccount,
          });

          /**
           * 当前页读不到身份，但签到页读得到 —— 先跳过去，让签到页那道核对来判。
           *
           * 这修的是你在日志里指出的矛盾：落地页写「读不到可核对的身份，但本站
           * 只有该账号，继续签到」，两步之后签到页却写「已核对账号身份：用户 ID
           * 436 一致」。闸门开在了信息最少的那一页。
           */
          if (decision.action === 'defer-to-checkin-page') {
            const target = checkinPageElsewhere()!;
            log.push(`当前页读不到可核对的身份，先进入签到页 ${pathOf(target)} 再核对账号`);
            await host.navigate(target, steps, 'checkin');
            return null;
          }

          if (decision.action === 'proceed') {
            if (decision.reason === 'confirmed') {
              log.push(`已确认当前登录账号：${verdict.detail}`);
              if (evidence.identity && !(await rememberTrustedIdentity(evidence.identity))) {
                log.push('当前身份证据不是站点接口结果，本轮继续但不更新长期账号映射');
              }
            } else {
              log.push(`${loginMethod} 登录：读不到可核对的身份，但本站只有该账号，继续签到`);
            }
            await host.confirmIdentity?.();
            // 已登录状态下打开站点，公告同样是接口回来后才弹的
            await closeAnnouncements(task.site, log, { waitForAppear: true });
            return runCheckin(freshLoginInSteps(steps));
          }

          // 到这里说明：有人登录着，但不是（或无法确认是）本次要签的账号。
          if (verdict.match === 'mismatch') log.push(`检测到账号不符：${verdict.detail}`);

          if (decision.action === 'handoff') {
            /**
             * 没有受管凭据的第三方身份登录（oauth/passkey/普通 github）由浏览器
             * 或系统持有身份，扩展没有「以另一个身份重登」的手段。
             * 既不能清登录态（只会毁掉有效会话），也不能当成「可以签」——
             * 那等于放弃核对，浏览器登着别的账号时会把签到记到错的账号头上。
             * 唯一诚实的做法是停下来交给用户。
             */
            await host.needsUser(
              decision.reason === 'mismatch-external'
                ? `当前浏览器登录的是别的账号（${verdict.detail}）。请在浏览器里切换到 ${task.username} 后重新签到。`
                : `读不到当前登录身份（${verdict.detail}），而本站配置了 ${task.siteAccountCount ?? '多个'} 个账号，`
                  + '无法确认浏览器里登录的是不是本账号。请在浏览器里确认后重新签到。',
              steps,
            );
            return null;
          }

          // switch-account：扩展持有凭据，偏保守 —— 把「可能是别人」当「是别人」处理。
          if (verdict.match !== 'mismatch') {
            log.push(`无法确认当前登录身份（${verdict.detail}），按切换账号处理`);
          }

          if (canSwitchAccount) {
            const switched = await startManagedGithubSwitch();
            if (switched === 'started') return null;
            return fail(switched === 'exhausted'
              ? githubSwitchExhaustedMessage(verdict, '当前页面')
              : '无法清除当前站点的浏览器 Cookie，为避免给错账号签到已停止；请检查扩展 Cookie 权限或残留项');
          }

          const switched = await switchAccount();
          // 已重载登录页：本次执行到此结束，重新注入后的脚本接着跑
          if (switched === 'reloading') return null;
          if (switched === 'blocked') {
            return fail('无法清除当前站点的浏览器 Cookie，为避免给错账号签到已停止；请检查扩展 Cookie 权限或残留项');
          }
          // 走到这里只可能是 token 方式的 'cleared'（cookie 站点要么 reloading、
          // 要么 blocked）；下面统一走 loginWithToken()：注入该账号凭据后用站点
          // 接口自校验，不在这里补跳转（旧分支 `loginMethod !== 'token'` 恒为
          // false，是死代码）。
        }
        if (loginMethod === 'token') return loginWithToken();
        if (loginMethod === 'auto') {
          return fail(
            '未检测到登录状态，且账号凭据无法唯一确定登录方式；'
            + '请在账号编辑中选择「站点账号密码」或「GitHub 账号密码」并填写对应凭据',
          );
        }
        if (loginMethod === 'oauth' || loginMethod === 'github' || loginMethod === 'passkey') {
          // 站点首页可能只显示公告和右上角「登录」入口，OAuth 按钮要在
          // 关闭公告后进入登录页才会渲染。这个前置步骤对直接打开登录页
          // 的站点是幂等的，对 Agent Router 这类首页入口站点则是必须的。
          await closeAnnouncements(task.site, log, { waitForAppear: true });
          if (!await resolveVisibleChallenge(task.stage, INTERACTIVE_CHALLENGE_TIMEOUT_MS)) {
            return fail('展开第三方登录入口前的人机验证未完成');
          }
          await revealExternalLogin(task.site, log, loginMethod, {
            beforeClick: () => resolveVisibleChallenge(task.stage, INTERACTIVE_CHALLENGE_TIMEOUT_MS),
          });
          const ok = await clickOAuthButton(task.site, log, {
            beforeClick: () => waitBeforeSubmit(task.stage),
            afterClick: () => waitAfterAction('verify-oauth'),
            beforeAuxiliaryClick: () => resolveVisibleChallenge(task.stage, INTERACTIVE_CHALLENGE_TIMEOUT_MS),
            beforeNavigate: () => host.markStage('verify-oauth', steps),
          }, loginMethod);
          if (!ok) return fail(loginMethod === 'passkey' ? '未找到 Passkey 登录按钮，请检查选择器配置' : '未找到 OAuth 按钮，请检查选择器配置');
          if (loginMethod === 'passkey') {
            log.push('已触发 Passkey 登录，请在浏览器/系统原生提示中确认');
          }
          // 授权跳转通常在点击后几百毫秒才发生。立刻同步校验会在还没离开
          // 登录页的文档上找不到成功证据，把正在正常进行的授权判成失败。
          // 确认离开本页就结束本次执行，由回跳后的脚本接着走 verify-oauth。
          if (await waitForExternalLoginNavigation(task.site, log)) return null;
          // 没有整页跳转：说明站点在当前文档内完成登录（SPA），照旧同步校验
          const verified = await verifyWithIntervention('verify-oauth');
          if (!verified) return fail('OAuth 授权后未能确认登录成功');
          if (!await rememberExternalIdentity()) return null;
          return runCheckin(true);
        }

        // form 登录：先把可能被折叠的账密表单展开
        await revealLoginForm(task.site, log, {
          beforeClick: () => resolveVisibleChallenge(task.stage, INTERACTIVE_CHALLENGE_TIMEOUT_MS),
        });
        const filled = await fillCredentials(
          task.site,
          task.username,
          task.password,
          log,
          async () => {
            await host.markStage('login', steps);
            return waitBeforeSubmit('login');
          },
          () => resolveVisibleChallenge('login', INTERACTIVE_CHALLENGE_TIMEOUT_MS),
        );
        if (!filled) return fail(credentialFailure());
        await closeAnnouncements(task.site, log);
        let solvedSlider = false;
        const submitted = await submitLogin(task.site, log, {
          beforeClick: () => waitBeforeSubmit(task.stage),
          afterClick: async () => {
            const challenge = await waitAfterActionResult('verify');
            solvedSlider ||= challenge.detected && challenge.resolved && challenge.kind === 'Slider';
            return challenge.resolved;
          },
          beforeAuxiliaryClick: () => resolveVisibleChallenge(task.stage, INTERACTIVE_CHALLENGE_TIMEOUT_MS),
          beforeNavigate: () => host.markStage('verify', steps),
        });
        if (!submitted) return fail('未能提交登录表单');
        let ok = await verifyWithIntervention('verify', (challenge) => {
          solvedSlider ||= challenge.detected && challenge.resolved && challenge.kind === 'Slider';
        });
        const exactHvoyOrigin = (() => {
          try {
            const configured = new URL(task.site.loginUrl);
            return configured.protocol === 'https:'
              && configured.hostname.toLowerCase() === 'www.hvoy.ai'
              && configured.port === ''
              && location.origin === 'https://www.hvoy.ai';
          } catch {
            return false;
          }
        })();

        if (
          !ok
          && task.stage === 'login'
          && loginMethod === 'form'
          && exactHvoyOrigin
          && solvedSlider
        ) {
          // Hvoy's first click only opens the slider. In some runs the final
          // successful solve happens in verifyWithIntervention, so retrying
          // solely inside submitLogin.afterClick would still miss it.
          const retry = await resubmitLoginAfterResolvedChallenge(task.site, log, {
            afterClick: () => waitAfterAction('verify'),
            beforeNavigate: () => host.markStage('verify', steps),
          });
          if (retry === 'blocked') return fail('滑块通过后无法安全地重新提交登录表单');
          ok = await verifyWithIntervention('verify');
        }
        if (!ok) return fail('登录结果未确认，请手动查看该标签页');
        if (!hasLearnedRoute(checkinSite())) await host.confirmIdentity?.();
        log.push(hasLearnedRoute(checkinSite())
          ? '表单登录成功，账号身份交由个人资料页统一核验'
          : `本轮账号 ${task.username} 登录成功，已记住身份供后续页面使用`);
        await closeAnnouncements(task.site, log);
        return runCheckin(true);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.push(`异常: ${message}`);
    return fail(message);
  }
}
