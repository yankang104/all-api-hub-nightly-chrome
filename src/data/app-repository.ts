import {
  ADAPTER_FAMILIES,
  SITE_TYPES,
  type Account,
  type AccountBalance,
  type AccountIdentity,
  type CapturedAuthSession,
  type LastResult,
  type LaunchMode,
  type RewardSymbol,
  type ProxyConfig,
  type CheckinSchedule,
  type SiteConfig,
  type TaskResult,
} from '@/types';
import { statusKey, uid } from '@/lib/core/date';
import { KEYS, local } from '@/lib/core/storage';
import { assertValidSiteConfig } from '@/lib/site/site-security';
import { validateCheckinWorkflow } from '@/lib/workflow/workflow-validation';
import { isLearnedLoginAsCheckin } from '@/lib/checkin/learned-checkin';
import { DEFAULT_LAUNCH_MODE } from '@/lib/site/launch-mode';
import {
  AGENTROUTER_SITE_PRESET,
  BUILTIN_SITES,
  DENXIO_SITE_PRESET,
  HVOY_SITE_PRESET,
  LEILEI_SITE_PRESET,
  LINUX_SB_SITE_PRESET,
  LINXI_SITE_PRESET,
  NEW_API_NEXT_SITE_PRESET,
  NEW_API_NEXT_TEMPLATE,
  TABIAI_SITE_PRESET,
  VSLLM_SITE_PRESET,
} from '@/sites';
import { STORAGE_LOCKS, withStorageWriteLock } from '@/lib/core/storage-lock';
import { DEFAULT_CHECKIN_SCHEDULE, normalizeSchedule, pruneScheduleAccountIds } from '@/lib/checkin/schedule';
import { pruneHeadlessStats, type HeadlessStats } from '@/lib/checkin/headless-eligibility';
import { normalizeProxyName, planProxyUpgrade, proxyEndpointKey } from '@/lib/proxy/proxy-upgrade';
import { appendDailyBalance, appendDailyReward } from '@/lib/balance/balance-history';
import { manualDoneResult } from '@/lib/checkin/manual-checkin';

export interface PersistedAppData {
  userSites: SiteConfig[];
  accounts: Account[];
  proxies: ProxyConfig[];
  status: Record<string, string>;
  results: Record<string, LastResult>;
  balances: Record<string, AccountBalance>;
  launchMode: LaunchMode;
  schedule: CheckinSchedule;
  /** 用户从界面删除过的内置站点 ID（内置站点不落盘，删除需持久化标记） */
  removedBuiltinSiteIds: string[];
}

/** 正式 ChatAI 内置站点与早期测试/用户导入版本的归并规则。 */
const CHATAI_SITE_ID = 'builtin-chatai-codex';
function isLegacyChatAiSite(site: SiteConfig): boolean {
  try {
    return site.id === 'real-sharedchat' || new URL(site.loginUrl).hostname === 'new.sharedchat.cc';
  } catch {
    return site.id === 'real-sharedchat';
  }
}

function stripLegacyAccountCheckinMethod(accounts: Account[]): Account[] {
  const next = accounts.map((account) => {
    const legacy = account as Account & { checkinMethod?: unknown };
    if (!Object.prototype.hasOwnProperty.call(legacy, 'checkinMethod')) return account;
    const { checkinMethod: _ignored, ...clean } = legacy;
    return clean;
  });
  return next;
}

/** 同一站点身份不能同时属于多个本地账号；返回所有存在歧义的账号 ID。 */
function duplicateSiteIdentityAccountIds(accounts: Account[]): Set<string> {
  const owners = new Map<string, string[]>();
  for (const account of accounts) {
    const userId = account.identity?.userId?.trim();
    if (!userId) continue;
    const key = `${account.siteId}\u0000${userId}`;
    const ids = owners.get(key) ?? [];
    ids.push(account.id);
    owners.set(key, ids);
  }

  return new Set(
    [...owners.values()].filter((ids) => ids.length > 1).flat(),
  );
}

function clearAmbiguousAccountIdentity(account: Account): Account {
  return {
    ...account,
    // 会话令牌仍由 token 路径单独验证归属；其余身份字段和依赖身份读取的
    // 余额/奖励都不能保留，否则升级后仍会显示旧版本串到这里的数据。
    identity: account.identity?.session ? { session: account.identity.session } : undefined,
  };
}

function hostnameOf(site: SiteConfig): string {
  try {
    return new URL(site.loginUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isAgentRouterSite(site: SiteConfig): boolean {
  return hostnameOf(site) === 'agentrouter.org' || hostnameOf(site) === 'ps.air-outer.com';
}

/** Upgrade both root-URL imports and the pre-2026-08-21 dashboard selectors. */
function upgradeAgentRouterSite(site: SiteConfig): SiteConfig {
  const loginUrl = (() => {
    try {
      const url = new URL(site.loginUrl);
      url.pathname = '/login';
      url.search = '';
      url.hash = '';
      return url.href;
    } catch {
      return site.loginUrl;
    }
  })();
  const oldSuccessIndicator = 'a[href="/console/token"], a[href="/console/topup"]';
  const useCurrentSuccessIndicator = !site.successIndicator || site.successIndicator === oldSuccessIndicator;
  const checkin = site.checkin?.method === 'relogin'
    ? {
        ...AGENTROUTER_SITE_PRESET.checkin!,
        ...site.checkin,
        logoutStorageKeys: [...new Set([
          ...(site.checkin.logoutStorageKeys ?? []),
          ...(AGENTROUTER_SITE_PRESET.checkin?.logoutStorageKeys ?? []),
        ])],
      }
    : site.checkin;

  return {
    ...site,
    loginUrl,
    pointerMode: site.pointerMode ?? AGENTROUTER_SITE_PRESET.pointerMode,
    successIndicator: useCurrentSuccessIndicator
      ? AGENTROUTER_SITE_PRESET.successIndicator
      : site.successIndicator,
    closeModalSelectors: [...new Set([
      'button >> text=今日关闭',
      'button >> text=关闭公告',
      ...(site.closeModalSelectors ?? []).filter((selector) => (
        selector !== 'button >> text=今日关闭' && selector !== 'button >> text=关闭公告'
      )),
    ])],
    ...(checkin ? { checkin } : {}),
  };
}

function isLegacyFutureHubSite(site: SiteConfig): boolean {
  if (hostnameOf(site) !== 'api.futureppo.top') return false;
  // 学到的「登录即签到」与旧默认 none 长得一样，但它是用户演示出的流程，不是旧预设。
  if (isLearnedLoginAsCheckin(site)) return false;

  const checkin = site.checkin;
  return !checkin
    || ((checkin.method === 'auto' || checkin.method === 'none')
      && checkin.workflow === undefined
      && !checkin.buttonSelector
      && !checkin.alreadySelector
      && !checkin.successSelector);
}

/**
 * 用户自己导入过的 anyrouter.top 记录。
 *
 * 这些记录不带内置 ID，因而不经过 mergeBuiltinSite —— 它们在导入时套的是
 * 当时的通用 new-api 预设（`auto` + `/console/personal`），而这个站点根本
 * 没有签到按钮，于是每次都跳去 /console/personal 等满 12 秒再报
 * 「签到页未找到明确按钮或已签到状态」。
 *
 * 只迁移 auto/none 且没配任何签到控件的旧默认形态。用户明确选过 button /
 * api / relogin / claim / workflow，或写过选择器的，一律不动 —— 有人可能
 * 特意配成 relogin 来强制每轮都拿奖励，那比「登录即签到」更强，不该被降级。
 */
function isLegacyAnyRouterSite(site: SiteConfig): boolean {
  if (hostnameOf(site) !== 'anyrouter.top') return false;
  // 升级会整块重写成 `{method:'none'}`，学到的身份路线会被丢掉。
  if (isLearnedLoginAsCheckin(site)) return false;

  const checkin = site.checkin;
  if (!checkin) return true;
  return (checkin.method === 'auto' || checkin.method === 'none')
    && checkin.workflow === undefined
    && !checkin.buttonSelector
    && !checkin.alreadySelector
    && !checkin.successSelector;
}

/**
 * Linux.SB 早期模板没有保存真实签到页，登录后只能在首页猜入口。只升级缺失
 * 签到地址的 auto/button 形态；明确配置过 URL、API、站内入口或工作流的记录
 * 仍由用户拥有。已有按钮与结果选择器会在 upgradeLinuxSbSite 中原样保留。
 */
function isLegacyLinuxSbSite(site: SiteConfig): boolean {
  if (hostnameOf(site) !== 'linux.sb') return false;

  const checkin = site.checkin;
  if (!checkin) return true;
  if (checkin.method !== 'auto' && checkin.method !== 'button') return false;

  return !checkin.url
    && !checkin.apiUrl
    && !checkin.entry
    && !checkin.claimEntrySelector
    && !checkin.claimConfirmSelector
    && !checkin.logoutSelector
    && !checkin.logoutApiUrl
    && !checkin.workflow;
}

/**
 * Linux.SB 的旧导入记录可能只保存了根页。只修正这个历史默认入口；
 * 用户明确配置过 button/api/workflow 等签到方式时，也必须保留其余字段。
 */
function hasLegacyLinuxSbLoginUrl(site: SiteConfig): boolean {
  if (hostnameOf(site) !== 'linux.sb') return false;
  try {
    return new URL(site.loginUrl).pathname.replace(/\/+$/, '') === '';
  } catch {
    return false;
  }
}

function upgradeLinuxSbLoginUrl(site: SiteConfig): SiteConfig {
  if (!hasLegacyLinuxSbLoginUrl(site)) return site;
  try {
    const url = new URL(site.loginUrl);
    url.pathname = '/login';
    url.search = '';
    url.hash = '';
    return { ...site, loginUrl: url.href };
  } catch {
    return site;
  }
}

function upgradeLinuxSbSite(site: SiteConfig): SiteConfig {
  const checkin = LINUX_SB_SITE_PRESET.checkin!;
  const adapter = LINUX_SB_SITE_PRESET.adapter!;
  const existingCheckin = site.checkin;
  const loginUrl = (() => {
    try {
      const url = new URL(site.loginUrl);
      url.pathname = '/login';
      url.search = '';
      url.hash = '';
      return url.href;
    } catch {
      return site.loginUrl;
    }
  })();

  return {
    ...site,
    loginUrl,
    pointerMode: site.pointerMode ?? LINUX_SB_SITE_PRESET.pointerMode,
    loginMethod: site.loginMethod || LINUX_SB_SITE_PRESET.loginMethod || 'form',
    selectors: { ...LINUX_SB_SITE_PRESET.selectors, ...site.selectors },
    closeModalSelectors: site.closeModalSelectors?.length
      ? [...site.closeModalSelectors]
      : [...LINUX_SB_SITE_PRESET.closeModalSelectors],
    successIndicator: site.successIndicator ?? LINUX_SB_SITE_PRESET.successIndicator,
    checkin: {
      ...checkin,
      ...existingCheckin,
      // 该迁移只会在旧记录没有 url 时进入，因此固定补上已确认的真实签到页。
      url: checkin.url,
      successText: existingCheckin?.successText
        ? [...existingCheckin.successText]
        : [...(checkin.successText ?? [])],
      alreadyText: existingCheckin?.alreadyText
        ? [...existingCheckin.alreadyText]
        : [...(checkin.alreadyText ?? [])],
    },
    adapter: {
      ...site.adapter,
      ...adapter,
      checkin: {
        ...site.adapter?.checkin,
        ...adapter.checkin,
        pathPatterns: [...(adapter.checkin?.pathPatterns ?? [])],
        titleWords: [...(adapter.checkin?.titleWords ?? [])],
      },
    },
  };
}

function configuredPathIs(site: SiteConfig, value: string | undefined, expected: string): boolean {
  if (!value) return false;
  try {
    const normalize = (path: string) => path.replace(/\/+$/, '') || '/';
    return normalize(new URL(value, site.loginUrl).pathname) === normalize(expected);
  } catch {
    return false;
  }
}

function sameStringList(actual: string[] | undefined, expected: readonly string[]): boolean {
  return !!actual
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

const HVOY_HOSTNAME = 'www.hvoy.ai';

/** 只迁移 Hvoy 过去误套通用 new-api 模板保存下来的原样配置。 */
function isLegacyHvoySite(site: SiteConfig): boolean {
  if (hostnameOf(site) !== HVOY_HOSTNAME) return false;
  try {
    const login = new URL(site.loginUrl);
    const path = login.pathname.replace(/\/+$/, '') || '/';
    if (
      login.protocol !== 'https:'
      || login.hostname.toLowerCase() !== HVOY_HOSTNAME
      || login.port
      || !new Set(['/', '/login', '/user/login', '/console', '/console/personal', '/dashboard']).has(path)
    ) return false;
  } catch {
    return false;
  }
  const checkin = site.checkin;
  if (!checkin || checkin.method !== 'auto') return false;
  if (!Object.keys(checkin).every((key) => ['method', 'url', 'apiUrl'].includes(key))) return false;
  if (checkin.url
    && !configuredPathIs(site, checkin.url, '/')
    && !configuredPathIs(site, checkin.url, '/console/personal')) return false;
  if (checkin.apiUrl && !configuredPathIs(site, checkin.apiUrl, '/api/user/checkin')) return false;

  const adapter = site.adapter;
  if (adapter?.family && adapter.family !== ADAPTER_FAMILIES.NEW_API) return false;
  if (adapter?.siteType && adapter.siteType !== SITE_TYPES.NEW_API) return false;
  if (adapter?.checkinPath && !configuredPathIs(site, adapter.checkinPath, '/console/personal')) return false;
  if (adapter?.quotaPerUnit != null && adapter.quotaPerUnit !== 500_000) return false;
  if (adapter?.checkin?.pathPatterns
    && !sameStringList(adapter.checkin.pathPatterns, ['/console/personal*', '/dashboard*'])) return false;
  if (adapter?.checkin?.titleWords
    && !sameStringList(adapter.checkin.titleWords, ['每日签到', 'daily check-in'])) return false;
  return true;
}

function upgradeHvoySite(site: SiteConfig): SiteConfig {
  const preset = HVOY_SITE_PRESET;
  const checkin = preset.checkin!;
  const adapter = preset.adapter!;
  const loginUrl = (() => {
    try {
      const url = new URL(site.loginUrl);
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const legacyPaths = new Set(['/', '/login', '/user/login', '/console', '/console/personal', '/dashboard']);
      if (!legacyPaths.has(path)) return site.loginUrl;
      // Hvoy 首页才有页头「登录」入口；登录页由 revealLoginForm 通过可信点击进入。
      url.pathname = '/';
      url.search = '';
      url.hash = '';
      return url.href;
    } catch {
      return site.loginUrl;
    }
  })();

  return {
    ...site,
    loginUrl,
    pointerMode: site.pointerMode ?? preset.pointerMode,
    preLoginClickSelector: site.preLoginClickSelector ?? preset.preLoginClickSelector,
    loginMethod: site.loginMethod === 'auto'
      ? (preset.loginMethod ?? 'form')
      : site.loginMethod || preset.loginMethod || 'form',
    selectors: { ...preset.selectors, ...site.selectors },
    closeModalSelectors: site.closeModalSelectors?.length
      ? [...site.closeModalSelectors]
      : [...preset.closeModalSelectors],
    checkin: {
      ...checkin,
      successText: [...(checkin.successText ?? [])],
      alreadyText: [...(checkin.alreadyText ?? [])],
    },
    adapter: {
      ...site.adapter,
      siteType: adapter.siteType,
      family: adapter.family,
      checkinPath: adapter.checkinPath,
      checkin: {
        pathPatterns: [...(adapter.checkin?.pathPatterns ?? [])],
        titleWords: [...(adapter.checkin?.titleWords ?? [])],
      },
      quotaPerUnit: adapter.quotaPerUnit,
    },
  };
}

/** 只迁移 VSLLM 过去从通用旧版 new-api 模板保存下来的原样签到配置。 */
function isLegacyVsllmSite(site: SiteConfig): boolean {
  if (hostnameOf(site) !== 'vsllm.com') return false;
  const checkin = site.checkin;
  // 完全没有 checkin 块的旧记录也要接管：它会退化成通用扫描，
  // 而 vsllm 的签到按钮藏在折叠面板里，扫不到。
  if (!checkin) return true;
  if (checkin.method !== 'auto') return false;
  if (!Object.keys(checkin).every((key) => ['method', 'url', 'apiUrl'].includes(key))) return false;
  /*
   * 两个路径字段各自独立判断，**不要求同时存在**。
   *
   * 原来写的是 `configuredPathIs(url) && configuredPathIs(apiUrl)` —— 缺任何一个
   * 就整体不迁移。而一条裸 `{method:'auto'}` 记录（用户从书签导入、或早期版本
   * 保存的）两个都没有，于是永远命中不到，一直用通用扫描跑。
   *
   * vsllm 的「每日签到」是**折叠面板**：`立即签到` 按钮在展开前不在 DOM 里，
   * 通用扫描等满 12 秒也只能列出导航栏，最后报「签到页未找到明确按钮」。
   * 专用工作流 `vsllm-daily` 会先展开面板再点，这正是这条迁移要接管的原因。
   *
   * 用户明确写过别的路径时仍然不动 —— 判据是「填了但不是旧默认值」。
   */
  if (checkin.url && !configuredPathIs(site, checkin.url, '/console/personal')) return false;
  if (checkin.apiUrl && !configuredPathIs(site, checkin.apiUrl, '/api/user/checkin')) return false;
  return true;
}

function upgradeVsllmSite(site: SiteConfig): SiteConfig {
  const preset = VSLLM_SITE_PRESET;
  const templateAdapter = preset.adapter!;
  const loginUrl = (() => {
    try {
      const url = new URL(site.loginUrl);
      const path = url.pathname.replace(/\/+$/, '');
      const legacyPaths = new Set(['', '/login', '/console', '/console/personal', '/console/topup']);
      if (!legacyPaths.has(path)) return site.loginUrl;
      url.pathname = '/login';
      url.search = '';
      url.hash = '';
      return url.href;
    } catch {
      return site.loginUrl;
    }
  })();

  return {
    ...site,
    loginUrl,
    pointerMode: site.pointerMode ?? preset.pointerMode,
    loginMethod: site.loginMethod || preset.loginMethod || 'auto',
    selectors: { ...preset.selectors, ...site.selectors },
    closeModalSelectors: site.closeModalSelectors?.length
      ? [...site.closeModalSelectors]
      : [...preset.closeModalSelectors],
    // VSLLM 已不再需要专用执行器：折叠面板由通用扫描展开，签到本身是普通按钮。
    checkin: {
      ...preset.checkin!,
      successText: [...(preset.checkin?.successText ?? [])],
      alreadyText: [...(preset.checkin?.alreadyText ?? [])],
    },
    adapter: {
      ...site.adapter,
      siteType: templateAdapter.siteType,
      family: templateAdapter.family,
      checkinPath: templateAdapter.checkinPath,
      checkin: {
        pathPatterns: [...(templateAdapter.checkin?.pathPatterns ?? [])],
        titleWords: [...(templateAdapter.checkin?.titleWords ?? [])],
      },
      quotaPerUnit: site.adapter?.quotaPerUnit ?? templateAdapter.quotaPerUnit,
    },
  };
}

/**
 * 把仍带 `vsllm-daily` 步骤的旧记录转成普通按钮流程。
 *
 * 该专用执行器已删除（它做的读题算答案、按次数循环翻牌、解析充能计数，
 * 学习流程都表达不了，也不再需要）。留在存储里的步骤会让校验直接报
 * 「不支持的工作流步骤」，站点从此跑不了。这里只替换**确实**是 VSLLM
 * 专用步骤的配置，其它 workflow 一律不动。
 */
function migrateVsllmDailyStep(site: SiteConfig): SiteConfig {
  if (hostnameOf(site) !== 'vsllm.com') return site;
  const steps = site.checkin?.workflow?.steps;
  if (!Array.isArray(steps)) return site;
  const hasVsllmDaily = steps.some((step) => (step as { type?: unknown })?.type === 'vsllm-daily');
  if (!hasVsllmDaily) return site;
  const preset = VSLLM_SITE_PRESET.checkin!;
  return {
    ...site,
    checkin: {
      ...preset,
      successText: [...(preset.successText ?? [])],
      alreadyText: [...(preset.alreadyText ?? [])],
    },
  };
}

const LEILEI_HOSTNAME = 'fapi.leileihog.top';

/** 只修复旧学习把明确的抽奖路线误写成 none；不是恢复并不存在的录制动作。 */
function repairLeileiLearnedNone(site: SiteConfig): SiteConfig {
  const checkin = site.checkin;
  if (checkin?.method !== 'none' || !checkin.learnedLoginAsCheckin
    || checkin.learnedLoginAsCheckinSource === 'explicit'
    || (checkin.workflow?.steps.length ?? 0) > 0) return site;
  try {
    const url = new URL(site.loginUrl);
    if (url.protocol !== 'https:' || url.hostname !== LEILEI_HOSTNAME || url.port) return site;
  } catch {
    return site;
  }
  // 旧版导航-only 演示没有可编译步骤，连 route 都不会保存，不能要求残留路线作证明。
  // 仅处理这个已确认依靠抽奖的精确站点；未标记的 none 与明确选择的策略仍不动。
  return {
    ...site,
    checkin: {
      method: 'workflow',
      workflow: { steps: [{ type: 'leilei-daily' }] },
    },
  };
}

/** 只迁移一梦五千年过去继承的通用 new-api 默认签到配置。 */
function isLegacyLeileiSite(site: SiteConfig): boolean {
  if (hostnameOf(site) !== LEILEI_HOSTNAME) return false;
  try {
    const login = new URL(site.loginUrl);
    if (login.protocol !== 'https:' || login.hostname.toLowerCase() !== LEILEI_HOSTNAME || login.port) return false;
    const path = login.pathname.replace(/\/+$/, '') || '/';
    if (!new Set(['/','/login','/sign-in','/profile','/console','/console/personal']).has(path)) return false;
  } catch {
    return false;
  }
  const checkin = site.checkin;
  // 已经是专用工作流，或用户明确选择了其它策略，不覆盖。
  // `checkin` 缺省时仍要继续检查下面的 adapter；不能因为旧记录没有
  // checkin 块就跳过用户自定义的签到路径/能力。
  if (checkin?.method === 'workflow') return false;
  if (checkin && checkin.method !== 'auto' && checkin.method !== 'button') return false;
  if (checkin?.method === 'button') {
    if (!(
      configuredPathIs(site, checkin.url, '/profile')
      && checkin.buttonSelector === 'button >> text=立即签到, button >> text=签到'
      && checkin.alreadySelector === 'button >> text=已签到'
      && (!checkin.successText || sameStringList(checkin.successText, ['签到成功', '今天 +']))
      && (!checkin.alreadyText || sameStringList(checkin.alreadyText, ['已签到', '今日已签到']))
      && Object.keys(checkin).every((key) => [
        'method', 'url', 'buttonSelector', 'alreadySelector', 'successText', 'alreadyText',
      ].includes(key))
    )) return false;
  }
  if (checkin?.method === 'auto') {
    if (!Object.keys(checkin).every((key) => ['method', 'url', 'apiUrl'].includes(key))) return false;
    if (checkin.url
      && !configuredPathIs(site, checkin.url, '/profile')
      && !configuredPathIs(site, checkin.url, '/console/personal')) return false;
    if (checkin.apiUrl && !configuredPathIs(site, checkin.apiUrl, '/api/user/checkin')) return false;
  }

  // 自定义额度/适配器属于用户配置；只接管旧 new-api 默认形态。
  const adapter = site.adapter;
  if (adapter?.family && adapter.family !== ADAPTER_FAMILIES.NEW_API) return false;
  if (adapter?.siteType && adapter.siteType !== SITE_TYPES.NEW_API) return false;
  if (adapter?.checkinPath
    && !configuredPathIs(site, adapter.checkinPath, '/profile')
    && !configuredPathIs(site, adapter.checkinPath, '/console/personal')) return false;
  /*
   * `quotaPerUnit` 刻意**不**参与"是不是旧记录"的判断。
   *
   * 它只影响金额的美元换算显示，与签到流程无关。把它当成"用户自定义过、
   * 整体不要动"会让改过换算率的用户永久卡在这个站点的重定向死循环里 ——
   * 保守守卫守错了对象。用户的自定义值由 upgradeLeileiSite 原样保留
   * （`site.adapter?.quotaPerUnit ?? adapter.quotaPerUnit`）。
   */
  /*
   * 白名单必须包含**通用 new-api 模板**留下的形态。
   *
   * 漏掉它的后果是实测过的：用户在专用模板加入之前导入这个站点，套用的是
   * 通用 new-api 预设（`/console/personal*` + `['每日签到','daily check-in']`）。
   * 两条都不在原来的白名单里，于是迁移一次都不触发 —— 而站点会把
   * `/console/personal` 重定向到 `/profile`，签到流程因此无限跳转，
   * 日志里同一段反复出现直到看门狗超时。
   */
  if (adapter?.checkin?.pathPatterns
    && !sameStringList(adapter.checkin.pathPatterns, ['/profile*'])
    && !sameStringList(adapter.checkin.pathPatterns, ['/profile*', '/lottery*'])
    && !sameStringList(adapter.checkin.pathPatterns, ['/console/personal*'])) return false;
  if (adapter?.checkin?.titleWords
    && !sameStringList(adapter.checkin.titleWords, ['每日签到'])
    && !sameStringList(adapter.checkin.titleWords, ['每日签到', '浮梦引光', '抽奖'])
    && !sameStringList(adapter.checkin.titleWords, ['每日签到', 'daily check-in'])) return false;
  return true;
}

function upgradeLeileiSite(site: SiteConfig): SiteConfig {
  const preset = LEILEI_SITE_PRESET;
  const adapter = preset.adapter!;
  const workflow = preset.checkin?.workflow;
  const loginUrl = (() => {
    try {
      const url = new URL(site.loginUrl);
      url.pathname = '/sign-in';
      url.search = '';
      url.hash = '';
      return url.href;
    } catch {
      return site.loginUrl;
    }
  })();
  return {
    ...site,
    loginUrl,
    pointerMode: site.pointerMode ?? preset.pointerMode,
    loginMethod: site.loginMethod || preset.loginMethod || 'auto',
    selectors: { ...preset.selectors, ...site.selectors },
    successIndicator: site.successIndicator || preset.successIndicator,
    closeModalSelectors: site.closeModalSelectors?.length
      ? [...site.closeModalSelectors]
      : [...preset.closeModalSelectors],
    checkin: {
      method: 'workflow',
      workflow: {
        steps: (workflow?.steps ?? []).map((step) => ({ ...step })),
      },
    },
    adapter: {
      ...site.adapter,
      siteType: adapter.siteType,
      family: adapter.family,
      checkinPath: adapter.checkinPath,
      checkin: {
        pathPatterns: [...(adapter.checkin?.pathPatterns ?? [])],
        titleWords: [...(adapter.checkin?.titleWords ?? [])],
      },
      quotaPerUnit: site.adapter?.quotaPerUnit ?? adapter.quotaPerUnit,
    },
    // 轮换令牌引导与新前端同一批：页面不再把令牌落 localStorage，缺了它
    // 余额/身份接口一律 401（见 types 里 authBootstrap 的说明）。必须与落地页
    // 同一次写入，否则「迁移跑第二遍才补上」，幂等用例会立刻抓出来。
    ...(preset.authBootstrap ? { authBootstrap: { ...preset.authBootstrap } } : {}),
  };
}

/**
 * 已经在用专用工作流、但落地页还指着 `/profile` 的一梦五千年记录。
 *
 * 为什么需要单独一条：`isLegacyLeileiSite` 见到 `method === 'workflow'` 就返回
 * false（那是「已经迁过了」的意思），所以上面那条迁移碰不到这批记录。而站点
 * 改版后 `/profile` 已经没有签到入口（2026-08-26 用户确认），继续指着它等于
 * 每轮都先白跑一趟个人页。
 *
 * 判据卡得很紧：必须是这个 hostname、必须已经是 leilei-daily 工作流、
 * 且落地页确实还是旧的 `/profile`。不满足任何一条都原样返回。
 */
function needsLeileiLotteryLanding(site: SiteConfig): boolean {
  if (hostnameOf(site) !== LEILEI_HOSTNAME) return false;
  if (site.checkin?.method !== 'workflow') return false;
  const steps = site.checkin.workflow?.steps ?? [];
  if (!steps.some((step) => step.type === 'leilei-daily')) return false;

  const path = site.adapter?.checkinPath;
  const patterns = site.adapter?.checkin?.pathPatterns ?? [];
  return path === '/profile' || !patterns.some((pattern) => pattern.startsWith('/lottery'));
}

/**
 * 已存在的一梦记录还没有「轮换令牌引导」配置（模板新加的 authBootstrap）。
 *
 * 判据同样卡紧：必须是这个 hostname、已经启用工作流、且还没配过 authBootstrap。
 * 学到的 DOM 流程同样依赖它核对身份；用户自己填过引导地址就绝不动它。
 */
function needsLeileiAuthBootstrap(site: SiteConfig): boolean {
  if (hostnameOf(site) !== LEILEI_HOSTNAME) return false;
  if (site.checkin?.method !== 'workflow') return false;
  // 专用流程与新学到的点击回放都需要同一份身份/余额引导，不能因学习替换而丢失。
  return !site.authBootstrap?.endpoint;
}

/** 只补 authBootstrap 一个字段；其余配置原样保留。 */
function upgradeLeileiAuthBootstrap(site: SiteConfig): SiteConfig {
  const bootstrap = LEILEI_SITE_PRESET.authBootstrap;
  return bootstrap ? { ...site, authBootstrap: { ...bootstrap } } : site;
}

/** 把落地页从 `/profile` 挪到 `/lottery`，只动这两个字段。 */
function upgradeLeileiLotteryLanding(site: SiteConfig): SiteConfig {
  const adapter = LEILEI_SITE_PRESET.adapter!;
  return {
    ...site,
    adapter: {
      ...site.adapter,
      siteType: site.adapter?.siteType ?? adapter.siteType,
      family: site.adapter?.family ?? adapter.family,
      checkinPath: adapter.checkinPath,
      checkin: {
        pathPatterns: [...(adapter.checkin?.pathPatterns ?? [])],
        titleWords: [...(adapter.checkin?.titleWords ?? [])],
      },
      quotaPerUnit: site.adapter?.quotaPerUnit ?? adapter.quotaPerUnit,
    },
  };
}

/**
 * 使用新版 new-api React 页面（`/sign-in` + `/profile`）的精确 hostname。
 *
 * `htai91.com`（海獭 AI）实测属于这一代：用户截图确认 `/profile` 上的
 * 「每日签到」卡片与 NEW_API_NEXT 模板逐项对应 —— 「立即签到」按钮、
 * 签到后变灰的「已签到」、奖励文案「今天 +$3.06」。
 *
 * 它此前不在名单里，旧记录套的是通用 new-api 预设的 `/console/personal`；
 * 站点把那个地址重定向到 `/profile`，于是反复跳转后报「未找到签到按钮」。
 */
/**
 * 迁移名单与模板名单**同一个来源**：模板里加了域名、这里就自动跟上。
 *
 * 旧写法是手抄三个域名，模板后来扩到六个时 kapibala.asia、api.gemai.cc、
 * gy.leyanshi.me 漏掉了 —— 早先添加的这些卡片一直停在旧版预设上（/login 是站点
 * 404 页、没有 successIndicator），已登录时既认不出登录态也找不到表单。
 */
const ORBELIS_SEEKAI_HOSTS = new Set(
  (NEW_API_NEXT_TEMPLATE.fingerprints.hostnames ?? []).map((host) => host.toLowerCase()),
);

/** 百倍历史记录曾被保存成 none/auto，导致登录后在错误页面直接收尾。 */
function isLegacyBaibeiSite(site: SiteConfig): boolean {
  if (hostnameOf(site) !== 'sub.100xlabs.space') return false;

  const checkin = site.checkin;
  if (!checkin) return true;
  if (isLearnedLoginAsCheckin(site)) return false;
  if (checkin.method === 'none') {
    return Object.keys(checkin).every((key) => ['method', 'url'].includes(key))
      && (!checkin.url
        || configuredPathIs(site, checkin.url, '/check-in')
        || configuredPathIs(site, checkin.url, '/console/personal'));
  }
  if (checkin.method !== 'auto') return false;
  if (!Object.keys(checkin).every((key) => ['method', 'url', 'apiUrl'].includes(key))) return false;
  const oldSub2ApiDefault = configuredPathIs(site, checkin.url, '/check-in') && !checkin.apiUrl;
  const oldNewApiDefault = configuredPathIs(site, checkin.url, '/console/personal')
    && configuredPathIs(site, checkin.apiUrl, '/api/user/checkin');
  return oldSub2ApiDefault || oldNewApiDefault;
}

function upgradeBaibeiSite(site: SiteConfig): SiteConfig {
  // 与站点注册表保持同一来源，不另建百倍私有点击配置。
  const preset = LINXI_SITE_PRESET;
  const checkin = preset.checkin!;
  const adapter = preset.adapter!;
  const loginUrl = (() => {
    try {
      const url = new URL(site.loginUrl);
      const path = url.pathname.replace(/\/+$/, '');
      if (!['', '/check-in', '/dashboard', '/console/personal'].includes(path)) return site.loginUrl;
      url.pathname = '/login';
      url.search = '';
      url.hash = '';
      return url.href;
    } catch {
      return site.loginUrl;
    }
  })();

  return {
    ...site,
    loginUrl,
    // 现有账号已经明确选择的 form/token 仍优先；没有旧值时使用当前表单默认。
    loginMethod: site.loginMethod || preset.loginMethod || 'form',
    selectors: { ...preset.selectors, ...site.selectors },
    closeModalSelectors: site.closeModalSelectors?.length
      ? [...site.closeModalSelectors]
      : [...preset.closeModalSelectors],
    ...(preset.tokenConfig || site.tokenConfig
      ? { tokenConfig: { ...preset.tokenConfig, ...site.tokenConfig } as SiteConfig['tokenConfig'] }
      : {}),
    checkin: {
      ...checkin,
      successText: [...(checkin.successText ?? [])],
      alreadyText: [...(checkin.alreadyText ?? [])],
    },
    adapter: {
      ...site.adapter,
      ...adapter,
      checkin: {
        ...adapter.checkin,
        pathPatterns: [...(adapter.checkin?.pathPatterns ?? [])],
        titleWords: [...(adapter.checkin?.titleWords ?? [])],
      },
    },
  };
}

function isOrbelisOrSeekAiSite(site: SiteConfig): boolean {
  return ORBELIS_SEEKAI_HOSTS.has(hostnameOf(site));
}

/**
 * 只把旧通用模板的默认签到块升级到新版 `/profile` 流程。
 * button/api/workflow/claim/relogin 及任何自定义选择器都属于用户配置，不覆盖。
 */
function hasLegacyNewApiNextCheckin(site: SiteConfig): boolean {
  const checkin = site.checkin;
  if (!checkin) return true;
  if (isLearnedLoginAsCheckin(site)) return false;
  if (checkin.method !== 'auto' && checkin.method !== 'none') return false;
  if (!Object.keys(checkin).every((key) => ['method', 'url', 'apiUrl'].includes(key))) return false;
  if (checkin.url
    && !configuredPathIs(site, checkin.url, '/console/personal')
    && !configuredPathIs(site, checkin.url, '/profile')) return false;
  if (checkin.apiUrl && !configuredPathIs(site, checkin.apiUrl, '/api/user/checkin')) return false;
  return true;
}

/**
 * Orbelis 与 SeekAI 使用同一套新版 new-api React 页面。迁移只按精确 hostname
 * 生效，并保留站点 id、名称、代理、登录方式及用户明确写过的签到动作。
 */
function upgradeOrbelisOrSeekAiSite(site: SiteConfig): SiteConfig {
  const preset = NEW_API_NEXT_SITE_PRESET;
  const replaceCheckin = hasLegacyNewApiNextCheckin(site);
  const usesProfile = replaceCheckin || configuredPathIs(site, site.checkin?.url, '/profile');
  const loginUrl = (() => {
    try {
      const url = new URL(site.loginUrl);
      const path = url.pathname.replace(/\/+$/, '');
      const legacyPaths = new Set(['', '/login', '/profile', '/console', '/console/personal', '/keys', '/wallet']);
      if (!legacyPaths.has(path)) return site.loginUrl;
      url.pathname = '/sign-in';
      url.search = '';
      url.hash = '';
      return url.href;
    } catch {
      return site.loginUrl;
    }
  })();
  const templateCheckin = preset.checkin!;
  const templateAdapter = preset.adapter!;
  const oldGenericSubmit = site.selectors.submit === 'button[type="submit"]';
  const oldGenericSuccess = site.successIndicator === 'a[href="/console/token"], a[href="/console/topup"]';

  return {
    ...site,
    loginUrl,
    pointerMode: site.pointerMode ?? preset.pointerMode,
    loginMethod: site.loginMethod || preset.loginMethod || 'auto',
    selectors: {
      ...preset.selectors,
      ...site.selectors,
      ...(oldGenericSubmit ? { submit: preset.selectors.submit } : {}),
    },
    successIndicator: !site.successIndicator || oldGenericSuccess
      ? preset.successIndicator
      : site.successIndicator,
    ...(replaceCheckin ? {
      checkin: {
        ...templateCheckin,
        successText: [...(templateCheckin.successText ?? [])],
        alreadyText: [...(templateCheckin.alreadyText ?? [])],
      },
    } : {}),
    adapter: {
      ...site.adapter,
      siteType: SITE_TYPES.NEW_API,
      family: ADAPTER_FAMILIES.NEW_API,
      ...(usesProfile ? {
        checkinPath: '/profile',
        checkin: site.adapter?.checkin ?? {
          pathPatterns: [...(templateAdapter.checkin?.pathPatterns ?? [])],
          titleWords: [...(templateAdapter.checkin?.titleWords ?? [])],
        },
      } : {}),
      quotaPerUnit: site.adapter?.quotaPerUnit ?? templateAdapter.quotaPerUnit,
    },
  };
}

/**
 * 只识别林夕遗留的泛化默认配置，不覆盖用户明确配置的签到流程。
 *
 * 只按真实 hostname 识别，不能按用户可编辑的显示名迁移，否则同名的其它站点
 * 会被错误改写。旧版本可能保存 `none`，也可能保存通用 new-api 的
 * `auto + /console/personal + /api/user/checkin`；Sub2API 通用模板还曾保存
 * `auto + /check-in`。这些默认形态都统一到真实 `/check-in` 按钮流程。
 *
 * `auto` 必须精确匹配旧模板的完整路径组合；裸 `auto` 与 `/profile` 等其它路径
 * 一律视为用户配置。上一轮未发布的错误补丁曾生成一份非常具体的
 * `button + /profile + new-api` 配置，也只按其完整指纹纠正。
 */
function isLegacyLinxiSite(site: SiteConfig): boolean {
  if (hostnameOf(site) !== 'k40.shengqainbang.cn') return false;

  const checkin = site.checkin;
  if (!checkin) return true;
  // 旧版 none 是「假成功」默认值；学到的 none 是用户亲自演示的登录即签到。
  if (isLearnedLoginAsCheckin(site)) return false;
  if (checkin.method === 'none') return true;

  const erroneousProfilePreset = checkin.method === 'button'
    && configuredPathIs(site, checkin.url, '/profile')
    && checkin.buttonSelector === 'button >> text=立即签到, button >> text=立即簽到, button >> text=Check in now'
    && checkin.alreadySelector === 'button >> text=已签到, button >> text=已簽到, button >> text=Checked in'
    && sameStringList(checkin.successText, ['签到成功', '簽到成功', 'Check-in successful'])
    && sameStringList(checkin.alreadyText, ['已签到', '今日已签到', '已簽到', '今日已簽到', 'Checked in'])
    && Object.keys(checkin).every((key) => [
      'method',
      'url',
      'buttonSelector',
      'alreadySelector',
      'successText',
      'alreadyText',
    ].includes(key))
    && site.adapter?.family === ADAPTER_FAMILIES.NEW_API
    && site.adapter?.checkinPath === '/profile'
    && site.adapter?.quotaPerUnit === 500_000;
  if (erroneousProfilePreset) return true;
  if (checkin.method !== 'auto') return false;

  /*
   * 林夕**刻意**要求 url 与 apiUrl 同时命中旧默认值。
   *
   * 与 isLegacyVsllmSite 看起来是同一个模式，但两者的情况不同，不能一并放宽：
   * vsllm 的签到按钮藏在折叠面板里，通用扫描**必然**找不到（用户截图确认），
   * 所以裸 `{method:'auto'}` 也必须接管；而林夕只是"希望用更严格的 /check-in
   * 按钮证据"，通用扫描本身能不能跑通没有证据支持。
   *
   * 在没有实测依据时放宽迁移条件，等于拿用户可能已经调好的配置去赌 ——
   * 那比多等一次失败更糟。`app-repository.test.ts` 里的用例锁死了这个边界。
   */
  const legacyNewApi = configuredPathIs(site, checkin.url, '/console/personal')
    && configuredPathIs(site, checkin.apiUrl, '/api/user/checkin')
    && Object.keys(checkin).every((key) => ['method', 'url', 'apiUrl'].includes(key));
  const legacySub2Api = configuredPathIs(site, checkin.url, '/check-in')
    && Object.keys(checkin).every((key) => ['method', 'url'].includes(key));
  return legacyNewApi || legacySub2Api;
}

function upgradeLinxiSite(site: SiteConfig): SiteConfig {
  const checkin = LINXI_SITE_PRESET.checkin!;
  const adapter = LINXI_SITE_PRESET.adapter!;
  const loginUrl = (() => {
    try {
      const url = new URL(site.loginUrl);
      url.pathname = '/login';
      url.search = '';
      url.hash = '';
      return url.href;
    } catch {
      return site.loginUrl;
    }
  })();
  return {
    ...site,
    loginUrl,
    selectors: { ...site.selectors, ...LINXI_SITE_PRESET.selectors },
    // 这是站点默认；账号自己的 loginMethod 仍会在运行时覆盖它。
    loginMethod: LINXI_SITE_PRESET.loginMethod || 'form',
    ...(LINXI_SITE_PRESET.tokenConfig || site.tokenConfig
      ? { tokenConfig: { ...site.tokenConfig, ...LINXI_SITE_PRESET.tokenConfig } as SiteConfig['tokenConfig'] }
      : {}),
    checkin: {
      ...checkin,
      successText: [...(checkin.successText ?? [])],
      alreadyText: [...(checkin.alreadyText ?? [])],
    },
    adapter: {
      ...site.adapter,
      ...adapter,
      checkin: {
        ...site.adapter?.checkin,
        ...adapter.checkin,
        pathPatterns: [...(adapter.checkin?.pathPatterns ?? [])],
        titleWords: [...(adapter.checkin?.titleWords ?? [])],
      },
    },
  };
}

/**
 * 登仙旧记录曾被保存成 `none`，或继承 Sub2API 通用的 `/check-in`（带连字符）。
 * 只迁移这些没有自定义动作的默认形态；button/api/workflow/claim 等明确配置保留。
 */
function isLegacyDenxioSite(site: SiteConfig): boolean {
  if (hostnameOf(site) !== 'api.denxio.top') return false;

  const checkin = site.checkin;
  if (isLearnedLoginAsCheckin(site)) return false;
  if (!checkin || checkin.method === 'none') return true;
  if (checkin.method !== 'auto') return false;
  if (
    checkin.buttonSelector
    || checkin.alreadySelector
    || checkin.successSelector
    || checkin.claimConfirmSelector
    || checkin.workflow
    || checkin.claimEntrySelector
    || checkin.logoutSelector
  ) return false;
  if (checkin.apiUrl && !configuredPathIs(site, checkin.apiUrl, '/api/user/checkin')) return false;

  return !checkin.url
    || configuredPathIs(site, checkin.url, '/check-in')
    || configuredPathIs(site, checkin.url, '/console/personal')
    // 旧包已经写对路径、但还没有“立即签到 → 领取奖励”的精确动作配置。
    || configuredPathIs(site, checkin.url, '/checkin');
}

function upgradeDenxioSite(site: SiteConfig): SiteConfig {
  const checkin = DENXIO_SITE_PRESET.checkin!;
  const adapter = DENXIO_SITE_PRESET.adapter!;
  const loginUrl = (() => {
    try {
      const url = new URL(site.loginUrl);
      url.pathname = '/login';
      url.search = '';
      url.hash = '';
      return url.href;
    } catch {
      return site.loginUrl;
    }
  })();

  return {
    ...site,
    loginUrl,
    // 保留用户已经验证可用的表单选择器，模板只补缺失项。
    selectors: { ...DENXIO_SITE_PRESET.selectors, ...site.selectors },
    loginMethod: site.loginMethod || DENXIO_SITE_PRESET.loginMethod || 'form',
    ...(DENXIO_SITE_PRESET.tokenConfig || site.tokenConfig
      ? { tokenConfig: { ...DENXIO_SITE_PRESET.tokenConfig, ...site.tokenConfig } as SiteConfig['tokenConfig'] }
      : {}),
    checkin: {
      ...checkin,
      successText: [...(checkin.successText ?? [])],
      alreadyText: [...(checkin.alreadyText ?? [])],
    },
    adapter: {
      ...site.adapter,
      ...adapter,
      checkin: {
        ...site.adapter?.checkin,
        ...adapter.checkin,
        pathPatterns: [...(adapter.checkin?.pathPatterns ?? [])],
        titleWords: [...(adapter.checkin?.titleWords ?? [])],
      },
    },
  };
}

/** Tabitoken 升级到新版路由前，由旧通用模板保存下来的默认记录。 */
function isLegacyTabitokenSite(site: SiteConfig): boolean {
  if (hostnameOf(site) !== 'tabitoken.com') return false;

  const checkin = site.checkin;
  const unchangedLegacyCheckin = !checkin
    || (checkin.method === 'auto'
      && (!checkin.url || checkin.url === '/console/personal')
      && !checkin.buttonSelector
      && !checkin.alreadySelector
      && !checkin.successSelector
      && Object.keys(checkin).every((key) => ['method', 'url'].includes(key)));
  const previousProfilePreset = checkin?.method === 'button'
    && configuredPathIs(site, checkin.url, '/profile')
    && checkin.buttonSelector === 'button >> text=立即签到, button >> text=签到'
    && checkin.alreadySelector === 'button >> text=已签到'
    && !checkin.entry;
  return unchangedLegacyCheckin || previousProfilePreset;
}

/**
 * 把历史中以普通站点形式保存的 Future Hub 升级为已验证的按钮签到流程。
 *
 * 旧版记录没有内置站点 ID，因而不会经过 mergeBuiltinSite；它会继续携带 auto/none
 * 策略和不完整 adapter，最终出现「自动识别已签到」或原始 quota 被显示为美元。
 * 只迁移未自定义签到选择器的旧默认记录，用户明确改过的流程绝不覆盖。
 *
 * AnyRouter 走的是反方向的同一类修正：它没有签到按钮，登录本身就是签到，
 * 旧记录的 auto + /console/personal 只会白等 12 秒再判失败。
 */
function preserveSiteIdentityWhenUnchanged(site: SiteConfig, migrated: SiteConfig): SiteConfig {
  // SiteConfig is persisted JSON. Keeping the original reference for an equal value makes
  // migrations idempotent and prevents appRepository.load() from rewriting storage on every run.
  return JSON.stringify(site) === JSON.stringify(migrated) ? site : migrated;
}

/**
 * 旧版「学习签到」把录制结果留在 method:'auto' 下，而当时的运行时会自动回放；
 * 新版把自动识别与学习回放拆开后，只有 method:'workflow' 才进入学习路线。
 * 不做兼容，升级后用户已经学过的流程会静默失效 —— 表现正是「学完了却不按
 * 学习流程走」。
 *
 * 只迁移能完整回放的历史记录：步骤、路线、身份页必须通过校验，且身份页确实在
 * 路线中。不完整的记录保持 auto，让自动识别继续工作；强行迁成 workflow 只会让
 * 引擎在缺少身份页时停机。用户在新界面明确点过「自动识别」会带
 * workflowReplayDisabled 标记，这类记录不迁移，保证兼容不覆盖用户的显式选择。
 */
function migrateLegacyAutoLearnedWorkflow(site: SiteConfig): SiteConfig {
  const checkin = site.checkin;
  const workflow = checkin?.workflow;
  if (!checkin || checkin.method !== 'auto'
    || checkin.workflowReplayDisabled === true
    || !workflow
    || typeof workflow.identityPath !== 'string'
    || !workflow.identityPath.trim()
    || validateCheckinWorkflow(site, workflow).length > 0) {
    return site;
  }
  return { ...site, checkin: { ...checkin, method: 'workflow' } };
}

/**
 * SharedChat 旧模板的登录成功标志里带着一条 Element Plus 通用类组合
 * （`button.el-button--primary.el-button--large`）—— 登录页的提交按钮上也有，
 * 会把登录页误判成已登录。只替换**原样**的旧默认值，用户改过的不动。
 */
const LEGACY_SHAREDCHAT_SUCCESS_INDICATOR = 'button.refresh-btn, button.invite-entry-button, button.el-button--primary.el-button--large';
const SHAREDCHAT_SUCCESS_INDICATOR = 'button.refresh-btn, button.invite-entry-button';

function upgradeSharedChatSuccessIndicator(site: SiteConfig): SiteConfig {
  return site.successIndicator === LEGACY_SHAREDCHAT_SUCCESS_INDICATOR
    ? { ...site, successIndicator: SHAREDCHAT_SUCCESS_INDICATOR }
    : site;
}

export function migrateLegacySiteDefault(site: SiteConfig): SiteConfig {
  let migrated = upgradeLinuxSbLoginUrl(site);
  migrated = upgradeSharedChatSuccessIndicator(migrated);
  // 这条兼容必须跑在内置站点迁移链之前：已有学习流程的 auto 记录一旦先被旧模板
  // 判定为「历史默认值」替换掉，用户录制的内容就再也回不来了。
  migrated = migrateLegacyAutoLearnedWorkflow(migrated);
  migrated = migrateVsllmDailyStep(migrated);
  migrated = repairLeileiLearnedNone(migrated);
  // 这条要在下面的 if/else 链之前跑：链里每个分支都是互斥的，而
  // 「已迁到工作流、只是落地页过时」这批记录一个分支都命中不了，
  // 放在链后面会被 else 分支的提前 return 跳过。
  if (needsLeileiLotteryLanding(migrated)) migrated = upgradeLeileiLotteryLanding(migrated);
  // 轮换令牌引导与落地页迁移互不相干：已迁过落地页的记录仍可能缺 authBootstrap。
  if (needsLeileiAuthBootstrap(migrated)) migrated = upgradeLeileiAuthBootstrap(migrated);
  if (isLegacyHvoySite(migrated)) migrated = upgradeHvoySite(migrated);
  else if (isLegacyVsllmSite(migrated)) migrated = upgradeVsllmSite(migrated);
  else if (isLegacyLeileiSite(migrated)) migrated = upgradeLeileiSite(migrated);
  else if (isLegacyBaibeiSite(migrated)) migrated = upgradeBaibeiSite(migrated);
  else if (isOrbelisOrSeekAiSite(migrated)) migrated = upgradeOrbelisOrSeekAiSite(migrated);
  else if (isAgentRouterSite(migrated)) migrated = upgradeAgentRouterSite(migrated);
  else if (isLegacyLinuxSbSite(migrated)) migrated = upgradeLinuxSbSite(migrated);
  else if (isLegacyDenxioSite(migrated)) migrated = upgradeDenxioSite(migrated);
  else if (isLegacyLinxiSite(migrated)) migrated = upgradeLinxiSite(migrated);
  else if (isLegacyTabitokenSite(migrated)) migrated = upgradeTabitokenSite(migrated);
  else if (isLegacyAnyRouterSite(migrated)) migrated = upgradeAnyRouterSite(migrated);
  else if (!isLegacyFutureHubSite(migrated)) return preserveSiteIdentityWhenUnchanged(site, migrated);
  else migrated = {
    ...migrated,
    loginUrl: 'https://api.futureppo.top/login',
    loginMethod: site.loginMethod || 'auto',
    checkin: {
      method: 'button',
      url: '/console/personal',
      buttonSelector: 'button >> text=立即签到',
      alreadySelector: 'button >> text=今日已签到',
      alreadyText: ['今日已签到'],
    },
    adapter: {
      ...site.adapter,
      siteType: SITE_TYPES.NEW_API,
      family: ADAPTER_FAMILIES.NEW_API,
      checkinPath: '/console/personal',
      checkin: { pathPatterns: ['/console/personal*'], titleWords: ['每日签到'] },
      quotaPerUnit: 500_000,
    },
  };

  return preserveSiteIdentityWhenUnchanged(site, migrated);
}

export function migrateLegacySiteDefaults(userSites: SiteConfig[]): SiteConfig[] {
  return userSites.map(migrateLegacySiteDefault);
}

/**
 * 只升级旧模板原样保存的 Tabitoken 记录。
 *
 * 登录表单仍由页面语义扫描处理；这里仅校准已确认变化的登录/签到路由。用户写过
 * 自定义签到控件的记录不会命中 isLegacyTabitokenSite，因此不会被覆盖。
 */
function upgradeTabitokenSite(site: SiteConfig): SiteConfig {
  const legacyCheckin = !site.checkin
    || (site.checkin.method === 'auto'
      && (!site.checkin.url || site.checkin.url === '/console/personal')
      && !site.checkin.buttonSelector
      && !site.checkin.alreadySelector
      && !site.checkin.successSelector
      && Object.keys(site.checkin).every((key) => ['method', 'url'].includes(key)));
  const previousProfilePreset = site.checkin?.method === 'button'
    && configuredPathIs(site, site.checkin.url, '/profile')
    && site.checkin.buttonSelector === 'button >> text=立即签到, button >> text=签到'
    && site.checkin.alreadySelector === 'button >> text=已签到'
    && !site.checkin.entry;
  const presetCheckin = TABIAI_SITE_PRESET.checkin!;
  const clonedEntry = presetCheckin.entry
    ? {
        ...presetCheckin.entry,
        steps: presetCheckin.entry.steps.map((step) => ({ ...step })),
      }
    : undefined;
  const loginUrl = (() => {
    try {
      const url = new URL(site.loginUrl);
      if (url.pathname.replace(/\/+$/, '') !== '/login') return site.loginUrl;
      url.pathname = '/sign-in';
      url.search = '';
      url.hash = '';
      return url.href;
    } catch {
      return site.loginUrl;
    }
  })();

  return {
    ...site,
    loginUrl,
    loginMethod: site.loginMethod || 'auto',
    pointerMode: site.pointerMode ?? 'trusted',
    successIndicator: site.successIndicator ?? TABIAI_SITE_PRESET.successIndicator,
    ...(legacyCheckin ? {
      checkin: {
        ...presetCheckin,
        successText: [...(presetCheckin.successText ?? [])],
        alreadyText: [...(presetCheckin.alreadyText ?? [])],
        ...(clonedEntry ? { entry: clonedEntry } : {}),
      },
    } : previousProfilePreset && clonedEntry ? {
      // 上一版已经有正确按钮配置，只补“头像 → 个人资料”入口，保留其它字段。
      checkin: { ...site.checkin!, entry: clonedEntry },
    } : {}),
    adapter: {
      ...site.adapter,
      siteType: SITE_TYPES.NEW_API,
      family: ADAPTER_FAMILIES.NEW_API,
      ...(legacyCheckin || previousProfilePreset ? {
        checkinPath: '/profile',
        checkin: { pathPatterns: ['/profile*'], titleWords: ['每日签到'] },
      } : {}),
      quotaPerUnit: site.adapter?.quotaPerUnit ?? 500_000,
    },
  };
}

/**
 * 把旧的 AnyRouter 记录改成「登录即签到」。
 *
 * 三处都要改，少一处就还会跳转：
 *  - `checkin` 整块替换成 `{method:'none'}`，**不保留 url** —— none 方式若配了
 *    签到页仍会先跳过去，等于白跑一趟；
 *  - `adapter.checkinPath: ''` 关掉 new-api 家族默认的 /console/personal 兜底；
 *  - `adapter.checkin` 里的 pathPatterns 一并清掉，避免继续把 /console/personal
 *    认成签到页（那只影响等待时长和日志措辞，但没有理由留着不一致的声明）。
 *
 * quotaPerUnit 和 family 保持 new-api：余额读取与美元换算仍走这一族。
 */
function upgradeAnyRouterSite(site: SiteConfig): SiteConfig {
  return {
    ...site,
    loginMethod: site.loginMethod || 'auto',
    checkin: { method: 'none' },
    adapter: {
      ...site.adapter,
      siteType: SITE_TYPES.ANYROUTER,
      family: ADAPTER_FAMILIES.NEW_API,
      checkinPath: '',
      checkin: { pathPatterns: [], titleWords: [] },
      quotaPerUnit: site.adapter?.quotaPerUnit ?? 500_000,
    },
  };
}

function changedByIdentity<T>(before: readonly T[], after: readonly T[]): boolean {
  return before.length !== after.length || before.some((value, index) => value !== after[index]);
}

/**
 * 撤销那些「站点被隐藏、但它下面还有账号」的删除标记。
 *
 * 内置站点删除只写 removedBuiltinSiteIds，账号仍留在 storage 里。若之后又给这个
 * 内置站点加了账号（AnyRouter 就是这种情况），卡片不显示、账号也就永远执行不到，
 * 看起来像“账号被删了”。账号是用户明确添加的数据，优先级高于早先的隐藏意图：
 * 只要还有账号指向它，就恢复显示，而不是静默丢弃这些账号。
 */
export function restoreHiddenSitesWithAccounts(
  removedBuiltinSiteIds: readonly string[],
  accounts: readonly Account[],
): string[] {
  const withAccounts = new Set(accounts.map((account) => account.siteId));
  return removedBuiltinSiteIds.filter((siteId) => !withAccounts.has(siteId));
}

/**
 * 一次性归并旧 SharedChat/测试站点到正式 ChatAI 内置站点。
 *
 * 早期真实 e2e 会写 real-sharedchat，用户导入也会生成随机 ID；若不迁移，
 * 账号仍指向旧 ID，正式 ChatAI 卡片就显示“没有账号”。迁移只动 siteId，
 * 保留账号全部凭据/会话、状态和结果；旧站的领取理由历史合并为内置覆盖项。
 */
async function migrateLegacyChatAi(
  userSites: SiteConfig[],
  accounts: Account[],
): Promise<{ userSites: SiteConfig[]; accounts: Account[] }> {
  const legacy = userSites.filter(isLegacyChatAiSite);
  const affected = legacy.length > 0 || accounts.some((account) => account.siteId === 'real-sharedchat');
  if (!affected) return { userSites, accounts };

  const base = BUILTIN_SITES.find((site) => site.id === CHATAI_SITE_ID);
  if (!base) return { userSites, accounts };
  const existing = userSites.find((site) => site.id === CHATAI_SITE_ID);
  const used = new Set([
    ...(base.checkin?.claimUsedTexts ?? []),
    ...(existing?.checkin?.claimUsedTexts ?? []),
    ...legacy.flatMap((site) => site.checkin?.claimUsedTexts ?? []),
  ]);
  const override: SiteConfig = {
    ...(existing ?? base),
    id: CHATAI_SITE_ID,
    builtin: true,
    checkin: { method: 'claim', ...(existing ?? base).checkin, claimUsedTexts: [...used] },
  };
  const nextSites = userSites.filter((site) => !isLegacyChatAiSite(site) && site.id !== CHATAI_SITE_ID).concat(override);
  const legacyIds = new Set(legacy.map((site) => site.id).concat('real-sharedchat'));
  const nextAccounts = accounts.map((account) => (
    legacyIds.has(account.siteId) ? { ...account, siteId: CHATAI_SITE_ID } : account
  ));
  await local.setMany({ [KEYS.sites]: nextSites, [KEYS.accounts]: nextAccounts });
  return { userSites: nextSites, accounts: nextAccounts };
}
/**
 * 清理已从 BUILTIN_SITES 移除、且没有账号引用的旧内置站点覆盖。
 *
 * 账号是用户录入的凭据，不能因为代码删了一条内置预设就跟着永久消失。
 * 仍有账号引用的旧站点会降级为普通站点继续显示；确实已经失去站点记录的
 * 账号则由主页的「待恢复账号」区域接管。两种情况都保留账号原始凭据。
 */
async function pruneRemovedBuiltinSites(
  userSites: SiteConfig[],
  accounts: Account[],
): Promise<{ userSites: SiteConfig[]; accounts: Account[] }> {
  const currentIds = new Set(BUILTIN_SITES.map((site) => site.id));
  const removed = userSites.filter((site) => (
    site.id.startsWith('builtin-') && site.builtin !== false && !currentIds.has(site.id)
  ));
  if (removed.length === 0) return { userSites, accounts };

  const removedIds = new Set(removed.map((site) => site.id));
  const referencedSiteIds = new Set(accounts.map((account) => account.siteId));
  const nextSites = userSites.flatMap((site) => {
    if (!removedIds.has(site.id)) return [site];
    if (!referencedSiteIds.has(site.id)) return [];
    // 退役预设不再受内置站点限制；保留其 URL/名称，方便用户确认归属。
    // 旧版本可能没有落 builtin 字段，也要明确降级，否则每次 load 都会重复迁移。
    return [{ ...site, builtin: false }];
  });

  await local.set(KEYS.sites, nextSites);
  return { userSites: nextSites, accounts };
}

/**
 * 所有写入都在同一把跨上下文锁内串行执行。
 *
 * 用共享锁而非模块级队列，是因为 side panel、options、background
 * 各跑在独立 JS 上下文里，模块级队列拦不住彼此的并发读改写。
 */
function writeLocked<T>(work: () => Promise<T>): Promise<T> {
  return withStorageWriteLock(STORAGE_LOCKS.APP_DATA, work);
}

function usableProxyIds(proxies: readonly ProxyConfig[]): Set<string> {
  return new Set(proxies.filter((proxy) => proxy.nameOnly !== true).map((proxy) => proxy.id));
}

interface ProxyReconcileResult {
  proxies: ProxyConfig[];
  accounts: Account[];
  sites: SiteConfig[];
  added: number;
  skipped: number;
  upgraded: number;
  removed: number;
  /** 因为仍被账号或站点绑定而**没有**被剪掉的旧出口数量。 */
  keptInUse: number;
  changed: boolean;
}

/** Merge imported exits while preserving ids, then optionally replace one managed source. */
function reconcileProxyInputs(
  proxies: readonly ProxyConfig[],
  accounts: readonly Account[],
  sites: readonly SiteConfig[],
  inputs: readonly Omit<ProxyConfig, 'id'>[],
  replaceSourceLabel?: string,
): ProxyReconcileResult {
  const { upgrades, merges, additions: pending } = planProxyUpgrade(proxies, inputs);
  const upgradeById = new Map(upgrades.map((upgrade) => [upgrade.id, upgrade.patch]));
  const redirectById = new Map(merges.map(({ fromId, toId }) => [fromId, toId]));
  const mergedIds = new Set(redirectById.keys());
  const endpointOf = (proxy: Omit<ProxyConfig, 'id'>) => proxy.nameOnly
    ? `name:${proxy.name.trim()}`
    : proxyEndpointKey(proxy);

  const upgraded = proxies.flatMap((proxy) => {
    if (mergedIds.has(proxy.id)) return [];
    const patch = upgradeById.get(proxy.id);
    if (!patch) return [proxy];
    const { nameOnly: _dropped, ...rest } = proxy;
    return [{ ...rest, ...patch }];
  });

  const seen = new Set(upgraded.map(endpointOf));
  const additions: ProxyConfig[] = [];
  for (const input of pending) {
    const key = endpointOf(input);
    if (seen.has(key)) continue;
    seen.add(key);
    additions.push({ ...input, id: uid('px') });
  }

  const desiredEndpoints = replaceSourceLabel
    ? new Set(inputs.filter((input) => input.nameOnly !== true).map(proxyEndpointKey))
    : undefined;
  const desiredNameOnlyNames = replaceSourceLabel
    ? new Set(inputs.filter((input) => input.nameOnly === true).map((input) => normalizeProxyName(input.name)))
    : undefined;

  /*
   * 仍被账号或站点绑定的旧出口一律不剪。
   *
   * 「同步内核出口」会按来源整批替换，早期实现把不在这次 inputs 里的旧条目
   * 直接删掉，并把绑定它的账号改成 inherit、删掉 proxyId。于是内核 listeners
   * 只要变一次（换订阅、重载配置、端口漂移、控制器临时读不到），用户的账号就
   * 被静默改成直连：站点若只能经代理访问，签到当场连不上，而日志里没有任何
   * 线索，只能逐个账号重新绑定 —— 每次同步都要重来一遍。
   *
   * 宁可留下一条已经失效的旧出口：任务会在日志里报出「本机 127.0.0.1:<端口>
   * 上没有程序在监听」，用户据此能判断该重新同步还是该改绑，而不是被当成直连。
   * 要清掉它，先解绑对应账号即可。
   */
  const inUseProxyIds = new Set<string>();
  for (const account of accounts) if (account.proxyId) inUseProxyIds.add(account.proxyId);
  for (const site of sites) if (site.proxyId) inUseProxyIds.add(site.proxyId);

  const prunedIds = new Set<string>();
  let keptInUse = 0;
  const nextProxies = upgraded.concat(additions).filter((proxy) => {
    if (!replaceSourceLabel || proxy.sourceLabel !== replaceSourceLabel) return true;
    if (proxy.nameOnly !== true && desiredEndpoints?.has(proxyEndpointKey(proxy))) return true;
    if (proxy.nameOnly === true && desiredNameOnlyNames?.has(normalizeProxyName(proxy.name))) return true;
    if (inUseProxyIds.has(proxy.id)) {
      keptInUse += 1;
      return true;
    }
    prunedIds.add(proxy.id);
    return false;
  });

  /*
   * 账号/站点的绑定只在 id 被合并（重定向）时改写；被剪掉的出口不可能还被
   * 引用 —— 上面已把 inUseProxyIds 排除在 prunedIds 之外。这两处保留为兜底，
   * 万一将来有别的集合也引用 proxyId，也不会静默退回直连。
   */
  const nextAccounts = accounts.map((account) => {
    if (!account.proxyId) return account;
    const redirected = redirectById.get(account.proxyId);
    if (redirected) return { ...account, proxyId: redirected };
    if (!prunedIds.has(account.proxyId)) return account;
    const next = { ...account, proxyMode: 'inherit' as const };
    delete next.proxyId;
    delete next.proxyPinned;
    return next;
  });
  const nextSites = sites.map((site) => {
    if (!site.proxyId) return site;
    const redirected = redirectById.get(site.proxyId);
    if (redirected) return { ...site, proxyId: redirected };
    return prunedIds.has(site.proxyId) ? { ...site, proxyId: undefined } : site;
  });

  return {
    proxies: nextProxies,
    accounts: nextAccounts,
    sites: nextSites,
    added: additions.length,
    skipped: inputs.length - additions.length - upgrades.length,
    upgraded: upgrades.length,
    removed: prunedIds.size,
    keptInUse,
    changed: additions.length > 0 || upgrades.length > 0 || mergedIds.size > 0 || prunedIds.size > 0,
  };
}

function assertUsableProxyId(proxyId: string | undefined, usableIds: ReadonlySet<string>): void {
  if (proxyId && !usableIds.has(proxyId)) {
    throw new Error('只能绑定有真实 HTTP/SOCKS 出口的代理；仅名称条目不能分配');
  }
}

/** Merge an account editor patch and apply its JSON-safe clear sentinels. */
export function mergeAccountUpdate(account: Account, patch: Partial<Account>): Account {
  const updated = { ...account, ...patch, id: account.id };

  if ('loginMethod' in patch && !patch.loginMethod) delete updated.loginMethod;
  if ('proxyMode' in patch && patch.proxyMode !== 'pool') {
    delete updated.proxyId;
    // 离开 pool 模式后「手动固定」失去意义，留着会让下次自动分配继续跳过它
    delete updated.proxyPinned;
  }
  if ('proxyMode' in patch && patch.proxyMode !== 'custom') delete updated.customProxy;
  return updated;
}

export const appRepository = {
  async load(): Promise<PersistedAppData> {
    return writeLocked(async () => {
      // 迁移会按需整表回写，读取也必须位于同一把锁内。否则另一上下文刚添加的
      // 账号可能被这里先前读到的旧快照覆盖，表现为「提示添加成功后账号消失」。
      const [rawUserSites, rawAccounts, proxies, status, results, balances, launchMode, rawSchedule, removedBuiltinSiteIds, headlessStats] = await Promise.all([
        local.get<SiteConfig[]>(KEYS.sites, []),
        local.get<Account[]>(KEYS.accounts, []),
        local.get<ProxyConfig[]>(KEYS.proxies, []),
        local.get<Record<string, string>>(KEYS.status, {}),
        local.get<Record<string, LastResult>>(KEYS.results, {}),
        local.get<Record<string, AccountBalance>>(KEYS.balances, {}),
        local.get<LaunchMode>(KEYS.launchMode, DEFAULT_LAUNCH_MODE),
        local.get<unknown>(KEYS.schedule, DEFAULT_CHECKIN_SCHEDULE),
        local.get<string[]>(KEYS.removedBuiltinSiteIds, []),
        local.get<HeadlessStats>(KEYS.headlessStats, {}),
      ]);
      const { userSites, accounts } = await migrateLegacyChatAi(rawUserSites, rawAccounts);
      const pruned = await pruneRemovedBuiltinSites(userSites, accounts);
      const upgradedSites = migrateLegacySiteDefaults(pruned.userSites);
      const cleanedAccounts = stripLegacyAccountCheckinMethod(pruned.accounts);
      const duplicateIdentityIds = duplicateSiteIdentityAccountIds(cleanedAccounts);
      const identitySafeAccounts = duplicateIdentityIds.size
        ? cleanedAccounts.map((account) => (
            duplicateIdentityIds.has(account.id) ? clearAmbiguousAccountIdentity(account) : account
          ))
        : cleanedAccounts;
      const duplicatePrefixes = [...duplicateIdentityIds].map((accountId) => `${accountId}:`);
      const identitySafeStatus = duplicateIdentityIds.size
        ? Object.fromEntries(
            Object.entries(status).filter(([key]) => !duplicatePrefixes.some((prefix) => key.startsWith(prefix))),
          )
        : status;
      const identitySafeResults = duplicateIdentityIds.size
        ? Object.fromEntries(
            Object.entries(results).filter(([accountId]) => !duplicateIdentityIds.has(accountId)),
          )
        : results;
      const identitySafeBalances = duplicateIdentityIds.size
        ? Object.fromEntries(
            Object.entries(balances).filter(([accountId]) => !duplicateIdentityIds.has(accountId)),
          )
        : balances;
      // headless 熔断统计按 siteId 存，站点删掉后必须一起清，
      // 否则与 results/balances 一样会永久累积孤儿记录。
      const liveSiteIds = [...BUILTIN_SITES, ...upgradedSites].map((site) => site.id);
      const cleanedHeadlessStats = pruneHeadlessStats(headlessStats, liveSiteIds);
      const keptRemovedIds = restoreHiddenSitesWithAccounts(removedBuiltinSiteIds, identitySafeAccounts);
      const writes: Record<string, unknown> = {};
      if (changedByIdentity(pruned.userSites, upgradedSites)) writes[KEYS.sites] = upgradedSites;
      if (changedByIdentity(pruned.accounts, identitySafeAccounts)) writes[KEYS.accounts] = identitySafeAccounts;
      if (duplicateIdentityIds.size) {
        writes[KEYS.status] = identitySafeStatus;
        writes[KEYS.results] = identitySafeResults;
        writes[KEYS.balances] = identitySafeBalances;
      }
      if (changedByIdentity(removedBuiltinSiteIds, keptRemovedIds)) {
        writes[KEYS.removedBuiltinSiteIds] = keptRemovedIds;
      }
      if (cleanedHeadlessStats !== headlessStats) {
        writes[KEYS.headlessStats] = cleanedHeadlessStats;
      }
      if (Object.keys(writes).length) await local.setMany(writes);
      return {
        userSites: upgradedSites,
        accounts: identitySafeAccounts,
        proxies,
        status: identitySafeStatus,
        results: identitySafeResults,
        balances: identitySafeBalances,
        launchMode,
        schedule: normalizeSchedule(rawSchedule),
        removedBuiltinSiteIds: keptRemovedIds,
      };
    });
  },

  /**
   * 站点排序写入。
   *
   * - 面板给了 `orderedIds`（箭头微调后的完整显示顺序）：直接把它记成 sortOrder，
   *   「字母排序之后还能手动调整」就靠这一步把显示顺序固化下来；
   * - 没给时退回旧的相邻换位（按存储顺序），保持兼容。
   */
  async moveSite(siteId: string, direction: 'up' | 'down', orderedIds?: string[]): Promise<void> {
    return writeLocked(async () => {
      const saved = await local.get<SiteConfig[]>(KEYS.sites, []);
      const missing = BUILTIN_SITES.filter((site) => !saved.some((item) => item.id === site.id));
      const all = [...saved, ...missing];
      let ordered: SiteConfig[];
      if (orderedIds?.length) {
        const rank = new Map<string, number>();
        for (const [index, id] of orderedIds.entries()) {
          if (!rank.has(id)) rank.set(id, index);
        }
        // 显示顺序里没有的站点（被删除标记隐藏的内置站点等）排在后面，互相保持原相对次序。
        ordered = all
          .map((site, index) => ({ site, key: rank.get(site.id) ?? orderedIds.length + index }))
          .sort((a, b) => a.key - b.key)
          .map(({ site }) => site);
      } else {
        ordered = all
          .map((site, index) => ({ ...site, sortOrder: site.sortOrder ?? index }))
          .sort((a, b) => a.sortOrder! - b.sortOrder! || a.name.localeCompare(b.name));
        const from = ordered.findIndex((site) => site.id === siteId);
        const to = direction === 'up' ? from - 1 : from + 1;
        if (from < 0 || to < 0 || to >= ordered.length) return;
        [ordered[from], ordered[to]] = [ordered[to]!, ordered[from]!];
      }
      await local.set(KEYS.sites, ordered.map((site, index) => ({ ...site, sortOrder: index })));
    });
  },

  addSite(input: Omit<SiteConfig, 'id'>): Promise<void> {
    return writeLocked(async () => {
      assertValidSiteConfig(input);
      const [sites, proxies] = await Promise.all([
        local.get<SiteConfig[]>(KEYS.sites, []),
        local.get<ProxyConfig[]>(KEYS.proxies, []),
      ]);
      assertUsableProxyId(input.proxyId, usableProxyIds(proxies));
      await local.set(KEYS.sites, sites.concat({ ...input, id: uid('site') }));
    });
  },

  addSites(
    inputs: Omit<SiteConfig, 'id'>[],
    existingUrls: ReadonlySet<string>,
    preserveDuplicates = false,
  ): Promise<number> {
    return writeLocked(async () => {
      inputs.forEach(assertValidSiteConfig);
      const [sites, proxies] = await Promise.all([
        local.get<SiteConfig[]>(KEYS.sites, []),
        local.get<ProxyConfig[]>(KEYS.proxies, []),
      ]);
      const usableIds = usableProxyIds(proxies);
      const seen = new Set(existingUrls);
      sites.forEach((site) => seen.add(site.loginUrl.trim()));
      const additions: SiteConfig[] = [];
      for (const input of inputs) {
        const key = input.loginUrl.trim();
        if (!key
          || (!preserveDuplicates && seen.has(key))
          || (input.proxyId && !usableIds.has(input.proxyId))) continue;
        seen.add(key);
        additions.push({ ...input, id: uid('site') });
      }
      if (additions.length) await local.set(KEYS.sites, sites.concat(additions));
      return additions.length;
    });
  },

  updateSite(siteId: string, patch: Partial<SiteConfig>): Promise<void> {
    return writeLocked(async () => {
      const [sites, proxies] = await Promise.all([
        local.get<SiteConfig[]>(KEYS.sites, []),
        local.get<ProxyConfig[]>(KEYS.proxies, []),
      ]);
      const builtin = BUILTIN_SITES.find((site) => site.id === siteId);
      const current = sites.find((site) => site.id === siteId) ?? builtin;
      if ('proxyId' in patch && patch.proxyId !== current?.proxyId) {
        assertUsableProxyId(patch.proxyId, usableProxyIds(proxies));
      }
      let found = false;
      const next = sites.map((site) => {
        if (site.id !== siteId) return site;
        found = true;
        const updated = { ...site, ...patch, ...(builtin ? { builtin: true } : {}) };
        assertValidSiteConfig(updated);
        return updated;
      });
      // 内置站点默认不落盘；首次编辑时写入一条同 ID 覆盖记录。
      if (!found && builtin) {
        const updated = { ...builtin, ...patch, builtin: true };
        assertValidSiteConfig(updated);
        next.push(updated);
      }
      await local.set(KEYS.sites, next);
    });
  },

  deleteEntities(siteIds: string[], accountIds: string[]): Promise<void> {
    return writeLocked(async () => {
      const siteIdSet = new Set(siteIds);
      const accountIdSet = new Set(accountIds);
      const [sites, accounts, status, results, balances, rawSchedule, removedBuiltinSiteIds, headlessStats] = await Promise.all([
        local.get<SiteConfig[]>(KEYS.sites, []),
        local.get<Account[]>(KEYS.accounts, []),
        local.get<Record<string, string>>(KEYS.status, {}),
        local.get<Record<string, LastResult>>(KEYS.results, {}),
        local.get<Record<string, AccountBalance>>(KEYS.balances, {}),
        local.get<unknown>(KEYS.schedule, DEFAULT_CHECKIN_SCHEDULE),
        local.get<string[]>(KEYS.removedBuiltinSiteIds, []),
        local.get<HeadlessStats>(KEYS.headlessStats, {}),
      ]);
      // 删除站点只移除站点配置。账号凭据保留为未归属账号，用户可以在主页
      // 重新归属；只有明确传入 accountIds 的账号才会永久删除。
      const removedAccountIds = new Set(
        accounts.filter((account) => accountIdSet.has(account.id)).map((account) => account.id),
      );
      const prefixes = [...removedAccountIds].map((accountId) => `${accountId}:`);
      const schedule = pruneScheduleAccountIds(
        normalizeSchedule(rawSchedule),
        accounts.filter((account) => !removedAccountIds.has(account.id)).map((account) => account.id),
      );

      // 内置站点不落盘（BUILTIN_SITES 是常量），删除时把 ID 记入持久化标记，
      // 下次加载由 app-store 过滤掉；普通站点直接删除 storage 里的记录。
      const builtinIds = new Set(BUILTIN_SITES.map((site) => site.id));
      const removedBuiltin = siteIds.filter((id) => builtinIds.has(id));
      const nextRemovedBuiltinIds = [
        ...new Set([...removedBuiltinSiteIds, ...removedBuiltin]),
      ];

      await local.setMany({
        [KEYS.sites]: sites.filter((site) => !siteIdSet.has(site.id)),
        [KEYS.accounts]: accounts.filter((account) => !removedAccountIds.has(account.id)),
        [KEYS.status]: Object.fromEntries(
          Object.entries(status).filter(([key]) => !prefixes.some((prefix) => key.startsWith(prefix))),
        ),
        [KEYS.results]: Object.fromEntries(
          Object.entries(results).filter(([accountId]) => !removedAccountIds.has(accountId)),
        ),
        [KEYS.balances]: Object.fromEntries(
          Object.entries(balances).filter(([accountId]) => !removedAccountIds.has(accountId)),
        ),
        [KEYS.schedule]: schedule,
        [KEYS.removedBuiltinSiteIds]: nextRemovedBuiltinIds,
        // 站点删除后它的 headless 熔断统计也失去意义，一并清掉
        [KEYS.headlessStats]: Object.fromEntries(
          Object.entries(headlessStats).filter(([siteId]) => !siteIdSet.has(siteId)),
        ),
      });
    });
  },

  async saveBalance(accountId: string, balance: AccountBalance): Promise<void> {
    return writeLocked(async () => {
      const balances = await local.get<Record<string, AccountBalance>>(KEYS.balances, {});
      const previous = balances[accountId];
      const effectiveSymbol = balance.symbol ?? previous?.symbol;
      const normalizedBalance: AccountBalance = effectiveSymbol
        ? { ...balance, symbol: effectiveSymbol }
        : balance;
      const next: AccountBalance = {
        ...(previous ?? {}),
        ...normalizedBalance,
        daily: appendDailyBalance(previous, normalizedBalance),
      };
      // A successful read clears the previous error. Optional ledger fields are
      // intentionally retained when this write comes from a non-check-in path.
      delete next.error;
      await local.set(KEYS.balances, { ...balances, [accountId]: next });
    });
  },

  /** Persist a page-reported daily check-in reward independently of balance data. */
  async saveCheckinReward(
    accountId: string,
    reward: number,
    day: string,
    at = Date.now(),
    symbol?: RewardSymbol,
  ): Promise<void> {
    return writeLocked(async () => {
      const balances = await local.get<Record<string, AccountBalance>>(KEYS.balances, {});
      const previous = balances[accountId];
      const base: AccountBalance = previous ?? {
        quota: 0,
        usedQuota: 0,
        at,
        error: '余额尚未读取',
      };
      const effectiveSymbol = symbol ?? (
        previous?.checkinRewardDay === day && previous.checkinReward === reward
          ? previous.checkinRewardSymbol
          : undefined
      );
      const next: AccountBalance = {
        ...base,
        checkinReward: reward,
        checkinRewardDay: day,
        checkinRewardAt: at,
        daily: appendDailyReward(base.daily, day, reward, at, undefined, effectiveSymbol),
      };
      if (effectiveSymbol) next.checkinRewardSymbol = effectiveSymbol;
      else delete next.checkinRewardSymbol;
      await local.set(KEYS.balances, {
        ...balances,
        [accountId]: next,
      });
    });
  },

  async clearBalance(accountId: string): Promise<void> {
    return writeLocked(async () => {
      const balances = await local.get<Record<string, AccountBalance>>(KEYS.balances, {});
      if (!(accountId in balances)) return;
      const next = { ...balances };
      delete next[accountId];
      await local.set(KEYS.balances, next);
    });
  },

  /**
   * 手动刷新失败也要落盘：quota 保留上次成功值，但 error 告诉 UI 这不是当前值。
   */
  async saveBalanceError(accountId: string, error: string): Promise<void> {
    return writeLocked(async () => {
      const balances = await local.get<Record<string, AccountBalance>>(KEYS.balances, {});
      const previous = balances[accountId];
      await local.set(KEYS.balances, {
        ...balances,
        [accountId]: {
          ...(previous ?? {}),
          quota: previous?.quota ?? 0,
          usedQuota: previous?.usedQuota ?? 0,
          at: Date.now(),
          error,
        },
      });
    });
  },
  addAccount(input: Omit<Account, 'id'>): Promise<void> {
    return writeLocked(async () => {
      const [accounts, proxies] = await Promise.all([
        local.get<Account[]>(KEYS.accounts, []),
        local.get<ProxyConfig[]>(KEYS.proxies, []),
      ]);
      if ((input.proxyMode ?? 'inherit') === 'pool') {
        if (!input.proxyId) throw new Error('账号选择了代理池，但没有指定真实出口');
        assertUsableProxyId(input.proxyId, usableProxyIds(proxies));
      }
      await local.set(KEYS.accounts, accounts.concat({ ...input, id: uid('acc') }));
    });
  },

  addAccounts(
    inputs: Omit<Account, 'id'>[],
    validSiteIds: ReadonlySet<string>,
    preserveDuplicates = false,
  ): Promise<{ added: number; skipped: number }> {
    return writeLocked(async () => {
      const [accounts, proxies] = await Promise.all([
        local.get<Account[]>(KEYS.accounts, []),
        local.get<ProxyConfig[]>(KEYS.proxies, []),
      ]);
      const usableIds = usableProxyIds(proxies);
      const seen = new Set(accounts.map((account) => `${account.siteId}\u0000${account.username.trim().toLowerCase()}`));
      const additions: Account[] = [];
      for (const input of inputs) {
        const username = input.username.trim();
        const key = `${input.siteId}\u0000${username.toLowerCase()}`;
        if (!validSiteIds.has(input.siteId)
          || !username
          || !input.password
          || (!preserveDuplicates && seen.has(key))
          || ((input.proxyMode ?? 'inherit') === 'pool' && (!input.proxyId || !usableIds.has(input.proxyId)))) continue;
        seen.add(key);
        additions.push({ ...input, username, label: input.label?.trim() || undefined, id: uid('acc') });
      }
      if (additions.length) await local.set(KEYS.accounts, accounts.concat(additions));
      return { added: additions.length, skipped: inputs.length - additions.length };
    });
  },

  /**
   * 局部更新一个账号。
   *
   * 阶段三写入 `identity`（登录后从站点读到的用户 ID）要用它。
   * 用 patch 而非整体替换，避免并发时把别人刚写的字段覆盖掉。
   */
  updateAccount(accountId: string, patch: Partial<Account>): Promise<void> {
    return writeLocked(async () => {
      const [accounts, userSites, removedBuiltinSiteIds, proxies] = await Promise.all([
        local.get<Account[]>(KEYS.accounts, []),
        local.get<SiteConfig[]>(KEYS.sites, []),
        local.get<string[]>(KEYS.removedBuiltinSiteIds, []),
        local.get<ProxyConfig[]>(KEYS.proxies, []),
      ]);
      const current = accounts.find((account) => account.id === accountId);
      if (!current) throw new Error('账号不存在或已被删除');

      const preview = mergeAccountUpdate(current, patch);
      if ((preview.proxyMode ?? 'inherit') === 'pool'
        && (preview.proxyId !== current.proxyId || (current.proxyMode ?? 'inherit') !== 'pool')) {
        if (!preview.proxyId) throw new Error('账号选择了代理池，但没有指定真实出口');
        assertUsableProxyId(preview.proxyId, usableProxyIds(proxies));
      }

      const siteChanged = typeof patch.siteId === 'string' && patch.siteId !== current.siteId;
      if (!siteChanged) {
        await local.set(KEYS.accounts, accounts.map((account) => (
          account.id === accountId ? mergeAccountUpdate(account, patch) : account
        )));
        return;
      }

      const targetSiteId = patch.siteId!.trim();
      const hiddenBuiltinIds = new Set(removedBuiltinSiteIds);
      const targetExists = userSites.some((site) => site.id === targetSiteId)
        || BUILTIN_SITES.some((site) => site.id === targetSiteId && !hiddenBuiltinIds.has(site.id));
      if (!targetExists) throw new Error('目标站点不存在，请重新选择');

      const normalizedUsername = current.username.trim().toLowerCase();
      const duplicate = accounts.some((account) => (
        account.id !== accountId
        && account.siteId === targetSiteId
        && account.username.trim().toLowerCase() === normalizedUsername
      ));
      if (duplicate) throw new Error('目标站点已有同名账号，不能重复归属');

      const updated = mergeAccountUpdate(current, { ...patch, siteId: targetSiteId });
      // identity、token 和账号级登录方式都绑定旧站。孤立记录已经没有原站 URL 可供
      // 比对，不能证明用户选中的目标与旧站同源，因此跨站归属时只保留普通账密、
      // 代理和备注；目标站会重新按自身默认方式登录。
      delete updated.identity;
      delete updated.loginMethod;
      delete updated.apiToken;
      delete updated.githubUsername;
      delete updated.githubPassword;
      delete updated.passkey;
      const nextAccounts = accounts.map((account) => account.id === accountId ? updated : account);
      const [status, results, balances] = await Promise.all([
        local.get<Record<string, string>>(KEYS.status, {}),
        local.get<Record<string, LastResult>>(KEYS.results, {}),
        local.get<Record<string, AccountBalance>>(KEYS.balances, {}),
      ]);
      const statusPrefix = `${accountId}:`;

      await local.setMany({
        [KEYS.accounts]: nextAccounts,
        [KEYS.status]: Object.fromEntries(
          Object.entries(status).filter(([key]) => !key.startsWith(statusPrefix)),
        ),
        [KEYS.results]: Object.fromEntries(
          Object.entries(results).filter(([id]) => id !== accountId),
        ),
        [KEYS.balances]: Object.fromEntries(
          Object.entries(balances).filter(([id]) => id !== accountId),
        ),
      });
    });
  },

  /**
   * 写入账号的登录会话。
   *
   * 不能用 `updateAccount({ identity: ... })` —— 那样会把 identity 整块替换掉，
   * 连带删掉 userId / group 这些别处写进去的字段。这里只动 session 子键。
   */
  saveAccountSession(accountId: string, session: CapturedAuthSession): Promise<void> {
    return writeLocked(async () => {
      const accounts = await local.get<Account[]>(KEYS.accounts, []);
      const next = accounts.map((account) =>
        account.id === accountId
          ? { ...account, identity: { ...account.identity, session } }
          : account,
      );
      await local.set(KEYS.accounts, next);
    });
  },

  /**
   * 合并写入账号身份（登录后从站点读到的 userId / 邮箱 / 用户名等）。
   *
   * 与 saveAccountSession 同理：只并入传入的子键，保留已存的 session、
   * group 等字段，不用 updateAccount 整块替换 identity。
   * 空值不覆盖已有值 —— 读到部分字段时不该把之前存的抹掉。
   */
  saveAccountIdentity(accountId: string, identity: Partial<AccountIdentity>): Promise<void> {
    return writeLocked(async () => {
      const accounts = await local.get<Account[]>(KEYS.accounts, []);
      const target = accounts.find((account) => account.id === accountId);
      if (!target) return;
      const clean = Object.fromEntries(
        Object.entries(identity).filter(([, value]) => value != null && value !== ''),
      );
      const incomingUserId = typeof clean.userId === 'string' ? clean.userId : undefined;
      const displacedIds = new Set(
        incomingUserId
          ? accounts
              .filter((account) => (
                account.id !== accountId
                && account.siteId === target.siteId
                && account.identity?.userId === incomingUserId
              ))
              .map((account) => account.id)
          : [],
      );
      const identityChanged = !!incomingUserId
        && !!target.identity?.userId
        && target.identity.userId !== incomingUserId;

      /**
       * 「受管 GitHub 亲自登录后读到」只对**这一次**写入的 userId 成立：新写入没带这个标记、
       * 或换了一个 userId 时，旧标记不能继续为新数据背书。
       */
      const keepsManagedProof = clean.verifiedByManagedLogin === true
        || (target.identity?.verifiedByManagedLogin === true
          && (!incomingUserId || incomingUserId === target.identity.userId)
          && clean.source === undefined);
      const next = accounts.map((account) =>
        account.id === accountId
          ? {
              ...account,
              identity: (() => {
                const merged = { ...account.identity, ...clean, fetchedAt: Date.now() };
                if (keepsManagedProof) merged.verifiedByManagedLogin = true;
                else delete merged.verifiedByManagedLogin;
                return merged;
              })(),
            }
          : displacedIds.has(account.id)
            ? {
                ...account,
                // 同站身份只能属于一个账号。旧串号账号的身份字段全部不可信；
                // 独立抓取的 session 暂时保留，后续仍会按 token 重新验证归属。
                identity: account.identity?.session ? { session: account.identity.session } : undefined,
              }
          : account,
      );

      if (displacedIds.size === 0 && !identityChanged) {
        await local.set(KEYS.accounts, next);
        return;
      }

      const [status, results, balances] = await Promise.all([
        local.get<Record<string, string>>(KEYS.status, {}),
        local.get<Record<string, LastResult>>(KEYS.results, {}),
        local.get<Record<string, AccountBalance>>(KEYS.balances, {}),
      ]);
      const resetResultIds = new Set(displacedIds);
      if (identityChanged) resetResultIds.add(accountId);
      const displacedPrefixes = [...displacedIds].map((id) => `${id}:`);

      await local.setMany({
        [KEYS.accounts]: next,
        [KEYS.status]: Object.fromEntries(
          Object.entries(status).filter(([key]) => !displacedPrefixes.some((prefix) => key.startsWith(prefix))),
        ),
        [KEYS.results]: Object.fromEntries(
          Object.entries(results).filter(([id]) => !resetResultIds.has(id)),
        ),
        [KEYS.balances]: Object.fromEntries(
          Object.entries(balances).filter(([id]) => !resetResultIds.has(id)),
        ),
      });
    });
  },

  addProxy(input: Omit<ProxyConfig, 'id'>): Promise<void> {
    return writeLocked(async () => {
      const proxies = await local.get<ProxyConfig[]>(KEYS.proxies, []);
      await local.set(KEYS.proxies, proxies.concat({ ...input, id: uid('px') }));
    });
  },

  /**
   * 批量入池，用于订阅导入。
   *
   * 真实代理按 scheme://host:port 去重（含与池中已有节点比对）：同一出口重复
   * 入池，「一账号一节点」的轮转分配就会把多个账号绑到同一个 IP，等于没做隔离。
   *
   * 名称条目按名字去重。它们没有 host:port（都是占位值），按出口去重会把
   * 整批不同国家的节点名压成一条，用户会以为导入丢了节点。
   */
  addProxies(inputs: Omit<ProxyConfig, 'id'>[]): Promise<{ added: number; skipped: number; upgraded: number }> {
    return writeLocked(async () => {
      const [proxies, accounts, sites] = await Promise.all([
        local.get<ProxyConfig[]>(KEYS.proxies, []),
        local.get<Account[]>(KEYS.accounts, []),
        local.get<SiteConfig[]>(KEYS.sites, []),
      ]);

      const result = reconcileProxyInputs(proxies, accounts, sites, inputs);
      if (result.changed) {
        const writes: Record<string, unknown> = {
          [KEYS.proxies]: result.proxies,
        };
        if (result.accounts.some((account, index) => account !== accounts[index])) {
          writes[KEYS.accounts] = result.accounts;
        }
        if (result.sites.some((site, index) => site !== sites[index])) {
          writes[KEYS.sites] = result.sites;
        }
        await local.setMany(writes);
      }
      return {
        added: result.added,
        skipped: result.skipped,
        upgraded: result.upgraded,
      };
    });
  },

  /**
   * Replace the Clash-managed listener set and remove selector/stale entries from older imports.
   *
   * 只清理**没有任何账号或站点绑定**的旧条目：被绑定的旧出口留着，避免一次
   * 同步就把用户全部账号静默改成直连（见 reconcileProxyInputs 的注释）。
   */
  syncClashProxies(
    inputs: Omit<ProxyConfig, 'id'>[],
  ): Promise<{ added: number; skipped: number; upgraded: number; removed: number; keptInUse: number }> {
    return writeLocked(async () => {
      const [proxies, accounts, sites] = await Promise.all([
        local.get<ProxyConfig[]>(KEYS.proxies, []),
        local.get<Account[]>(KEYS.accounts, []),
        local.get<SiteConfig[]>(KEYS.sites, []),
      ]);
      const result = reconcileProxyInputs(proxies, accounts, sites, inputs, 'Clash Verge');
      if (result.changed) {
        await local.setMany({
          [KEYS.proxies]: result.proxies,
          [KEYS.accounts]: result.accounts,
          [KEYS.sites]: result.sites,
        });
      }
      return {
        added: result.added,
        skipped: result.skipped,
        upgraded: result.upgraded,
        removed: result.removed,
        keptInUse: result.keptInUse,
      };
    });
  },

  updateProxy(proxyId: string, patch: Partial<ProxyConfig>): Promise<void> {
    return writeLocked(async () => {
      const proxies = await local.get<ProxyConfig[]>(KEYS.proxies, []);
      await local.set(KEYS.proxies, proxies.map((proxy) => proxy.id === proxyId ? { ...proxy, ...patch } : proxy));
    });
  },

  /**
   * 删除池内节点，并清掉所有指向它的引用。
   *
   * ⚠️ 账号侧的清理是必须的：账号绑定后若只清站点引用，账号仍是
   * `proxyMode: 'pool'` 指着一个不存在的 id，签到会直接失败在
   * 「账号配置的代理已不存在」（见 background 的 resolveProxyForAccount）。
   * 批量分配让账号绑定成为常态，这个残留会从偶发变成必然。
   * 回落 'inherit' 而不是 'none'：跟随站点配置是账号的默认语义。
   */
  removeProxy(proxyId: string): Promise<void> {
    return writeLocked(async () => {
      const [proxies, sites, accounts] = await Promise.all([
        local.get<ProxyConfig[]>(KEYS.proxies, []),
        local.get<SiteConfig[]>(KEYS.sites, []),
        local.get<Account[]>(KEYS.accounts, []),
      ]);
      await local.setMany({
        [KEYS.proxies]: proxies.filter((proxy) => proxy.id !== proxyId),
        [KEYS.sites]: sites.map((site) => site.proxyId === proxyId ? { ...site, proxyId: undefined } : site),
        [KEYS.accounts]: accounts.map((account) => {
          if (account.proxyId !== proxyId) return account;
          const next = { ...account, proxyMode: 'inherit' as const };
          delete next.proxyId;
          return next;
        }),
      });
    });
  },

  /**
   * 批量把账号绑到池内节点。
   *
   * 只接受池内存在且有真实出口的 proxyId。传进来一个已删除的 id 会造出
   * 悬空引用；传入 nameOnly 则会让界面显示一个节点、实际执行却没有出口。
   *
   * `pinned` 的那几条标记成用户手动指定，后续自动分配不再覆盖它们。
   */
  assignAccountProxies(
    assignments: { accountId: string; proxyId: string; pinned?: boolean }[],
  ): Promise<{ assigned: number }> {
    return writeLocked(async () => {
      const [accounts, proxies] = await Promise.all([
        local.get<Account[]>(KEYS.accounts, []),
        local.get<ProxyConfig[]>(KEYS.proxies, []),
      ]);
      const poolIds = usableProxyIds(proxies);
      const wanted = new Map(
        assignments
          .filter((item) => poolIds.has(item.proxyId))
          .map((item) => [item.accountId, item]),
      );
      if (!wanted.size) return { assigned: 0 };

      let assigned = 0;
      const next = accounts.map((account) => {
        const item = wanted.get(account.id);
        if (!item) return account;
        assigned += 1;
        const updated = mergeAccountUpdate(account, { proxyMode: 'pool', proxyId: item.proxyId });
        if (item.pinned) return { ...updated, proxyPinned: true };
        // 自动分配写入的绑定不带标记，下一轮扩容后还能被重新摊平
        const { proxyPinned: _dropped, ...unpinned } = updated;
        return unpinned;
      });

      if (assigned) await local.set(KEYS.accounts, next);
      return { assigned };
    });
  },

  updateSchedule(schedule: CheckinSchedule): Promise<void> {
    return writeLocked(async () => {
      await local.set(KEYS.schedule, normalizeSchedule(schedule));
    });
  },

  async setStatus(key: string, value: string): Promise<Record<string, string>> {
    return writeLocked(async () => {
      const status = await local.get<Record<string, string>>(KEYS.status, {});
      if (value === 'pending') delete status[key];
      else status[key] = value;
      await local.set(KEYS.status, status);
      return { ...status };
    });
  },

  /**
   * 只在状态仍未落定时把它清回待签到，返回是否真的清了。
   *
   * 用 compare-and-set 而不是直接 setStatus：停止任务和 watchdog 捞孤儿都是
   * 「先读快照、再决定」的两步操作，中间那一瞬任务可能刚好跑完并写下 done。
   * 无条件覆盖会把成功记录抹成待签到，界面上表现为签到成功后又变回待签，
   * 「全部执行」还会再白跑一遍。判断和写入放进同一把写锁里才排除得掉。
   */
  async clearInFlightStatus(key: string): Promise<boolean> {
    return writeLocked(async () => {
      const status = await local.get<Record<string, string>>(KEYS.status, {});
      if (status[key] !== 'running' && status[key] !== 'attention') return false;
      delete status[key];
      await local.set(KEYS.status, status);
      return true;
    });
  },

  async getStatus(key: string): Promise<string | undefined> {
    const status = await local.get<Record<string, string>>(KEYS.status, {});
    return status[key];
  },

  /** 手动完成时原子读取余额历史并写入差值结果，避免刷新与标记交错。 */
  markDone(accountId: string): Promise<void> {
    return writeLocked(async () => {
      const [status, results, balances] = await Promise.all([
        local.get<Record<string, string>>(KEYS.status, {}),
        local.get<Record<string, LastResult>>(KEYS.results, {}),
        local.get<Record<string, AccountBalance>>(KEYS.balances, {}),
      ]);
      const result = manualDoneResult(accountId, balances[accountId]);
      status[statusKey(accountId)] = 'done';
      results[accountId] = { ...result, at: Date.now() };
      await local.setMany({ [KEYS.status]: status, [KEYS.results]: results });
    });
  },

  /**
   * 仅在状态仍未落定时写入 value，返回是否真的写了。
   *
   * updateStage 以及「恢复 attention」这类路径是「先读状态、再决定是否改」
   * 的两步操作：读和写必须与 complete()/fail() 的终态写入在同一把存储写锁里
   * 裁决，否则两步之间完成的签到会被这个非终态写覆盖 —— results 里明明有
   * 成功记录，状态却永远停在「签到中」，界面上转圈。
   */
  async setStatusUnlessTerminal(key: string, value: string): Promise<boolean> {
    return writeLocked(async () => {
      const status = await local.get<Record<string, string>>(KEYS.status, {});
      if (status[key] === 'done' || status[key] === 'failed') return false;
      if (value === 'pending') delete status[key];
      else status[key] = value;
      await local.set(KEYS.status, status);
      return true;
    });
  },

  /**
   * 仅当状态等于 expected 时才写入 value，返回是否真的写了。
   *
   * 调用方在锁外先看到 attention，不能假定真正写入时它仍是 attention：
   * 两步之间任务可能刚好完成，无条件写入会把 done 覆盖回 running。
   * compare-and-set 把「判断」和「写入」放进同一把写锁里，消掉这个窗口。
   */
  async setStatusIfExpected(key: string, expected: string, value: string): Promise<boolean> {
    return writeLocked(async () => {
      const status = await local.get<Record<string, string>>(KEYS.status, {});
      if (status[key] !== expected) return false;
      if (value === 'pending') delete status[key];
      else status[key] = value;
      await local.set(KEYS.status, status);
      return true;
    });
  },

  setStatusAndResult(value: string, result: TaskResult): Promise<void> {
    return writeLocked(async () => {
      const [status, results] = await Promise.all([
        local.get<Record<string, string>>(KEYS.status, {}),
        local.get<Record<string, LastResult>>(KEYS.results, {}),
      ]);
      status[statusKey(result.accountId)] = value;
      results[result.accountId] = { ...result, at: Date.now() };
      await local.setMany({ [KEYS.status]: status, [KEYS.results]: results });
    });
  },

  setOutcome(result: TaskResult): Promise<void> {
    return this.setStatusAndResult(result.ok ? 'done' : 'failed', result);
  },
};
