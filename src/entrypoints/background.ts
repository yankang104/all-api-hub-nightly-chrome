import type {
  Account,
  AccountBalance,
  CapturedAuthSession,
  CheckinSchedule,
  LearnedArtifactKind,
  LearningKind,
  LaunchMode,
  LoginTask,
  ProxyConfig,
  SiteConfig,
  TaskResult,
  WorkflowLearningEvent,
  WorkflowLearningSession,
} from '@/types';
import { KEYS, local, session } from '@/lib/core/storage';
import { LEARN_KEY, type AppMutation, type Message, type MessageResponse } from '@/lib/core/messaging';
import { BUILTIN_SITES, mergeBuiltinSite } from '@/sites';
import { loopbackListenerMissingMessage, loopbackNavigationFailureMessage, readAppliedProxyEndpoint, testProxy } from '@/lib/proxy/proxy';
import { shouldReclaimProxyLease } from '@/background/proxy/proxy-recovery';
import { navigationErrorMessage } from '@/lib/proxy/navigation-error';
import { DEFAULT_LAUNCH_MODE } from '@/lib/site/launch-mode';
import {
  isGithubAuthUrl,
  isGithubCredentialStage,
  isGithubLoggedOutUrl,
  isGithubLoginUrl,
  isGithubLogoutUrl,
  isGithubOAuthAuthorizeUrl,
  isGoogleAuthUrl,
  isSameSiteUrl,
  isTaskUrlAllowed,
  siteOrigin,
  validateSiteConfig,
} from '@/lib/site/site-security';
import {
  DEFAULT_CHECKIN_METHOD,
  describeEffectiveMethods,
  loginCredentialNeeds,
  resolveEffectiveMethods,
} from '@/lib/checkin/effective-method';
import { probeSite } from '@/lib/site/site-probe';
import { loadListenerPlan, normalizeSubscriptionUrl, planListenerDrift, saveListenerPlan } from '@/background/proxy/listener-auto';
import { createLearningWriteQueue } from '@/background/learning/learning-queue';
import { isTopFrameSender } from '@/lib/core/frame-scope';
import { buildLearningPreview } from '@/automation/learning/learning-preview';
import { isBlockedFetchHost } from '@/lib/site/url-guard';
import {
  balanceEndpointsFor,
  crossOriginBalanceProbe,
  decodeCrossOriginPayload,
  extractBalance,
  extractCrossOriginBalance,
  extractTodayCheckinRewardObservation,
  mergeCheckinRewardObservations,
  readVisibleBalance,
  readVisibleCheckinRewardObservation,
} from '@/automation/balance/balance';
import { readBalancePayloadsInPage } from '@/background/checkin/balance-page-script';
import { balanceSource, loginCheckinBalanceBaseline } from '@/lib/balance/balance-history';
import {
  LOGIN_CHECKIN_BASELINE_LOADED_NOTE,
  loginCheckinBaselineStepNote,
} from '@/lib/balance/login-checkin-baseline-note';
import { adapterCheckinFallback } from '@/automation/sites/site-adapters';
import { USER_ID_HEADER_NAMES } from '@/lib/site/compat-headers';
import { authBootstrapProbe } from '@/automation/shared/token-bootstrap';
import { CAPTURE_SPECS, type CaptureSpec } from '@/automation/login/session-capture';
import {
  extractIdentityFromPayload,
  findAccountOnPage,
  readVisibleIdentityFromText,
  verifyIdentity,
  type PageIdentity,
} from '@/automation/login/identity';
import { statusKey, todayKey, uid } from '@/lib/core/date';
import {
  DEFAULT_CHECKIN_SCHEDULE,
  latestDueScheduleSlot,
  nextScheduledAt,
  normalizeSchedule,
  scheduleRunKey,
  scheduleSignature,
  scheduledAccountIds,
  shouldRunScheduledAlarm,
} from '@/lib/checkin/schedule';
import { appRepository, migrateLegacySiteDefault } from '@/data/app-repository';
import {
  QUEUE_KEY,
  createCheckinQueue,
  type QueueLaunchResult,
  type QueueState,
} from '@/background/checkin/checkin-queue';
import { collectLiveTasks } from '@/background/checkin/live-progress';
import { orphanRunningAccounts } from '@/background/checkin/stuck-tasks';
import { shouldCloseTaskTabAfter } from '@/background/checkin/site-close-decision';
import { keepSiteTab, takeKeptSiteTabs } from '@/background/checkin/site-kept-tabs';
import { taskState } from '@/background/checkin/task-state';
import { oauthPopups } from '@/background/oauth/oauth-popups';
import {
  isExternalOAuthTask,
  isGithubTaskContinuation,
  isOAuthPopupCandidate,
  isOAuthPopupUrl,
  oauthProviderForTask,
} from '@/background/oauth/oauth-popup-policy';
import { proxyLease } from '@/background/proxy/proxy-lease';
import { appliedProxyMatchesAccount, egressMismatchReason } from '@/lib/proxy/account-proxy-match';
import { createLaunchModeController } from '@/background/checkin/launch-mode-controller';
import { effectiveProxyConfig, isLoopbackProxyHost, isNameOnlyProxy } from '@/lib/proxy/proxy-config';
import { CLASH_CONTROLLER_PORTS, discoverClashController } from '@/lib/clash/clash-controller-detect';
import type { ClashControllerConnection } from '@/lib/clash/clash-controller';
import type { ClashListenerExit } from '@/lib/messages/clash-controller';
import {
  buildClashControllerAuthHeaders,
  normalizeClashControllerAddress,
  parseClashProxyNames,
} from '@/lib/clash/clash-controller';
import type { PortScanEntry } from '@/lib/messages/port-scan';
import { parseClashListenerResponse } from '@/lib/clash/clash-listeners';
// 命名空间导入：parseClashListenerExits 由别的实现者在本工作日补上，编译期还不能
// 直接命名导入（否则 tsc 会因导出不存在而失败）。运行时 defensive 取值，见
// resolveParseClashListenerExits —— 导出缺席时返回 blocker，绝不另写一份解析。
import * as clashListeners from '@/lib/clash/clash-listeners';
import {
  tryHeadlessCheckin,
  eligibilitySignalOf,
  isHeadlessBrowserFallbackSafe,
  isHeadlessSuccess,
} from '@/background/checkin/headless-checkin';
import {
  recordHeadlessOutcome,
  shouldTryHeadless,
  type HeadlessStats,
} from '@/lib/checkin/headless-eligibility';
import {
  forgetPointer,
  trustedPointerClick,
  trustedPointerDrag,
  trustedPointerScroll,
} from '@/background/slider/trusted-pointer';
import { crackSliderChallenge } from '@/background/slider/slider-crack';
import {
  authorizedSliderFrameTarget,
  crackSliderFrameChallenge,
  handleSliderFrameMessage,
} from '@/background/slider/slider-frame';
import { readFrameEmbedding, readFramePointerTarget } from '@/background/slider/frame-target';
import { clearSiteCookiesForTab } from '@/background/checkin/site-cookies';
import {
  buildLearnedArtifacts,
  buildLearnedWorkflow,
  partitionLearningSessions,
  appendLearningEvent,
  decideLearningStart,
  sanitizeLearningEvent,
  verifyLearnedLoginAsCheckinStored,
  verifyLearnedWorkflowStored,
  shouldAutoSaveLoginAsCheckin,
  needsLoginAsCheckinChoice,
  needsCheckinEvidenceChoice,
  LOGIN_AS_CHECKIN_CHOICE_MESSAGE,
  CHECKIN_EVIDENCE_CHOICE_MESSAGE,
  type LearningArtifactIntent,
} from '@/automation/learning/learning';
import { analyzeLearningEvents, canSaveLoginAsCheckin, guideViewOf } from '@/automation/learning/learning-stage';
import {
  isLearningSenderSameOrigin,
  learningSiteOrigin,
  planLearnedLoginAccountPatch,
  planLearnedLoginPatch,
  planSiblingLoginMethodPins,
  verifyLearnedLoginStored,
} from '@/automation/learning/learning-login';
import { learningSaveOutcome } from '@/background/learning/learning-save-outcome';
import { buildLearningReport, siteHasStoredLoginConfig } from '@/automation/learning/learning-report';
import { removeTabUnlessLast } from '@/lib/core/tab-lifecycle';
import { validateCheckinWorkflow } from '@/lib/workflow/workflow-validation';
import { isLearnedLoginAsCheckin, usesCheckinWorkflow, usesLearnedCheckin, usesSiteSpecificCheckin } from '@/lib/checkin/learned-checkin';
import {
  inheritSameOriginRecognition,
  learnedCheckinForSameOriginCard,
  resolveSharedLearnedCheckin,
} from '@/lib/checkin/shared-learned-flow';

const WATCHDOG_ALARM = 'checkin-queue-watchdog';
const SCHEDULE_ALARM = 'checkin-schedule';
/**
 * 订阅/listener 漂移检查闹钟。
 *
 * 机场订阅通常每 10 分钟~1 天更新一次，节点会增删。这里用 6 小时做一次
 * 低成本核对：拉订阅 → 与已存映射 diff → 只把**新增**端口补进代理池。
 * 不修改任何 Clash Verge 配置 —— 需要重粘 Script 时只在管理页出横幅。
 */
const LISTENER_SYNC_ALARM = 'listener-sync';
const SCHEDULE_RUN_KEY = 'checkinScheduleLastRun';
const TASK_TIMEOUT_MS = 10 * 60_000;

/**
 * 解析落盘站点并应用与管理页相同的兼容迁移。
 *
 * 后台队列可能在管理页尚未打开时由计划任务或恢复逻辑启动，不能假设
 * appRepository.load() 已经提前把旧配置写回 storage。
 */
function configuredSite(siteId: string, userSites: readonly SiteConfig[]): SiteConfig | undefined {
  const builtin = BUILTIN_SITES.find((site) => site.id === siteId);
  const userSite = userSites.find((site) => site.id === siteId);
  const resolved = builtin ? mergeBuiltinSite(builtin, userSite) : userSite;
  return resolved ? migrateLegacySiteDefault(resolved) : undefined;
}

/**
 * 与目标卡片同 origin 的其它站点卡（用户站点 + 未被删除的内置站点，均已合并迁移）。
 *
 * 被用户删掉的内置站点不再参与：它的覆盖记录可能还留在存储里，但用户已经不要它了。
 */
function sameOriginConfiguredSites(
  target: SiteConfig,
  userSites: readonly SiteConfig[],
  removedBuiltinSiteIds: readonly string[] = [],
): SiteConfig[] {
  const origin = siteOrigin(target);
  if (!origin) return [];
  const removed = new Set(removedBuiltinSiteIds);
  const ids = new Set([
    ...userSites.map((site) => site.id),
    ...BUILTIN_SITES.map((site) => site.id),
  ]);
  return [...ids]
    .filter((id) => id !== target.id && !removed.has(id))
    .map((id) => configuredSite(id, userSites))
    .filter((site): site is SiteConfig => !!site && siteOrigin(site) === origin);
}

/**
 * Service Worker can resume a live tab without relaunching it. Normalize that persisted task too,
 * otherwise an old Denxio `none` snapshot keeps overriding the already-migrated site record.
 */
function migrateRecoveredTask(task: LoginTask, accountId: string): LoginTask {
  if (task.accountId !== accountId) return task;

  const site = migrateLegacySiteDefault(task.site);
  const checkinMethod = site.checkin?.method ?? DEFAULT_CHECKIN_METHOD;
  if (site === task.site && task.effectiveCheckinMethod === checkinMethod) return task;

  const previousMethod = task.effectiveCheckinMethod
    ?? task.site.checkin?.method
    ?? DEFAULT_CHECKIN_METHOD;
  const methodMarker = '；签到方式：';
  let methodLineUpdated = false;
  const steps = (task.steps ?? []).map((step) => {
    const markerIndex = step.indexOf(methodMarker);
    if (markerIndex < 0) return step;
    methodLineUpdated = true;
    return `${step.slice(0, markerIndex)}${methodMarker}${checkinMethod}（站点配置）`;
  });
  if (previousMethod !== checkinMethod) {
    if (!methodLineUpdated) steps.push(`签到方式：${checkinMethod}（站点配置）`);
    steps.push(`后台恢复任务时已同步最新签到方式（${previousMethod} -> ${checkinMethod}）`);
  }

  return {
    ...task,
    site,
    effectiveCheckinMethod: checkinMethod,
    steps,
  };
}

async function migrateRecoveredActiveTask(
  active: { accountId: string; tabId: number } | undefined,
): Promise<void> {
  if (!active || active.tabId <= 0) return;
  await taskState.update(active.tabId, (task) => migrateRecoveredTask(task, active.accountId));
}

/**
 * 按浏览器实际共享会话的边界分组账号。
 *
 * 本地 siteId 可以因重复导入而不同，但相同 origin 的标签页共享 Cookie。身份闸门
 * 若只看 siteId，会把同域第二条记录错当成单账号站点，从而允许未知身份继续签到。
 */
function accountsSharingSiteOrigin(
  accounts: readonly Account[],
  userSites: readonly SiteConfig[],
  targetSite: SiteConfig,
): Account[] {
  const targetOrigin = siteOrigin(targetSite);
  if (!targetOrigin) return accounts.filter((account) => account.siteId === targetSite.id);

  return accounts.filter((account) => {
    const accountSite = configuredSite(account.siteId, userSites);
    return accountSite ? siteOrigin(accountSite) === targetOrigin : false;
  });
}

const learningWrites = createLearningWriteQueue();
/** 学习过程中出现过验证码/OTP 时，结束时必须明确告知用户：该类步骤不会被学习。 */
/** 学习类型的中文标签（只用于固定文案，不带任何页面内容）。 */
/**
 * 演示账号在**站点页面上**可能出现的名字（登录名、GitHub 句柄、站点身份），只在本机比对，不落盘。
 *
 * 不含扩展里的备注名（label）：它只显示在扩展界面，站点页面上不会出现；用户把备注写成
 * 「每日签到」这类词时，反而会让真正的签到按钮拿不到文字选择器。
 */
function learningPersonalTexts(account: Account): string[] {
  return [
    account.username,
    account.githubUsername,
    account.identity?.username,
    account.identity?.displayName,
    account.identity?.email,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function learningKindLabel(kind: LearningKind): string {
  return kind === 'login' ? '登录' : kind === 'both' ? '登录与签到' : '登录与签到';
}

const CHALLENGE_LEARNING_WARNING = '学习过程中出现了验证码/二次验证（OTP）字段。按隐私设计，这类字段不会被学习，也不会采集任何内容；自动回放时需要你在页面上人工完成这一步。';
const launchModeController = createLaunchModeController();
let backgroundReady: Promise<void> = Promise.resolve();
let networkQueue: Promise<void> = Promise.resolve();
let terminalQueue: Promise<void> = Promise.resolve();
let scheduleAlarmQueue: Promise<void> = Promise.resolve();
let scheduleSyncQueue: Promise<void> = Promise.resolve();

function networkLocked<T>(work: () => Promise<T>): Promise<T> {
  const result = networkQueue.then(work, work);
  networkQueue = result.then(() => undefined, () => undefined);
  return result;
}

function terminalLocked<T>(work: () => Promise<T>): Promise<T> {
  const result = terminalQueue.then(work, work);
  terminalQueue = result.then(() => undefined, () => undefined);
  return result;
}

/** 只在真实任务启动时读取；WXT 构建沙箱不实现 runtime.getManifest。 */
function runtimeVersion(): string {
  const manifest = chrome.runtime.getManifest();
  return manifest.version_name ?? manifest.version;
}

const checkinQueue = createCheckinQueue({
  launch: launchAccount,
  async fail(accountId, message) {
    const status = await taskState.statusOf(accountId);
    if (status === 'done' || status === 'failed') return;
    await taskState.fail(accountId, message);
  },
  async complete(accountId, result) {
    await taskState.complete(result);
    broadcast();
  },
  async isAlive(active) {
    if (active.tabId <= 0) return false;
    const [tabAlive, task] = await Promise.all([
      chrome.tabs.get(active.tabId).then(() => true).catch(() => false),
      taskState.get(active.tabId),
    ]);
    return tabAlive && !!task?.runId && task.accountId === active.accountId;
  },
  async abandon(active) {
    if (active.tabId <= 0) return;
    // Service Worker 休眠期间可能错过 opener 的 onRemoved。优先把任务信箱和
    // 队列 active tab 迁到仍活着的 OAuth popup；这样回调还能继续跑，且下一账号
    // 不会在 popup 仍占用全局代理时被错误启动。
    const task = await taskState.get(active.tabId);
    if (task && await rebindActiveTaskToOAuthPopup(active, task)) return;

    // 没有可接管的 popup 时，仍把已转移的弹窗标成 retained，避免下面的
    // releaseTaskProxy 把它们正在使用的全局代理清掉。
    await retainOAuthPopupsForOpener(active.tabId, task);
    await taskState.remove(active.tabId);
    await removeTabUnlessLast(active.tabId).catch(() => {});
    await releaseTaskProxy(active.tabId);
  },
  changed: broadcast,
});

export default defineBackground(() => {
  void scheduleBackgroundRecovery();
  chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 });
  // 周期:6 小时。与签到闹钟互不影响,失败只记 lastError 不打断别的任务。
  chrome.alarms.create(LISTENER_SYNC_ALARM, { periodInMinutes: 6 * 60 });
  chrome.runtime.onInstalled.addListener(() => {
    void scheduleBackgroundRecovery();
  });
  chrome.runtime.onStartup.addListener(() => {
    void scheduleBackgroundRecovery();
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === WATCHDOG_ALARM) {
      void expireStaleTask();
      void recoverOrphanRunning();
    }
    if (alarm.name === SCHEDULE_ALARM) void runScheduledCheckin(alarm.scheduledTime);
    if (alarm.name === LISTENER_SYNC_ALARM) void runListenerSync().catch(() => {});
  });
  chrome.webNavigation.onErrorOccurred.addListener((details) => {
    if (details.frameId === 0) void finishNavigationFailure(details.tabId, details.error);
  });
  // OAuth 站点可能通过 window.open 开第三方授权。新标签页刚创建时 URL 还是
  // about:blank，等它变成认证提供商页面后才安全处理代理租约。
  chrome.tabs.onCreated.addListener((tab) => {
    const popupTabId = tab.id;
    const openerTabId = tab.openerTabId;
    if (popupTabId == null || openerTabId == null) return;
    void (async () => {
      // 只记「正在跑签到的标签页」开出来的窗口。用户自己点链接开的新标签页也带
      // openerTabId，全都记下来会让这张表越积越多 —— 它现在存在 session 里，
      // 不再随 Service Worker 重启自动清空。
      const task = await taskState.get(openerTabId);
      if (!task?.runId) return;
      await oauthPopups.remember(popupTabId, openerTabId);
      // GitHub 已授权后的第二次 OAuth 可能从 about:blank 直接快跳回本站，
      // github.com 中间页短到 onUpdated 完全观察不到。验证阶段创建出的这张
      // GitHub 弹窗就是任务续页，立即接管才能在回跳页关闭公告并读取余额。
      if (isGithubTaskContinuation(task, tab.url ?? 'about:blank')) {
        await handoffOAuthPopup(popupTabId, tab.url ?? 'about:blank', openerTabId);
        return;
      }
      // Chrome 通常在 onCreated 时仍给出 about:blank。不要在这个阶段把普通
      // target=_blank 窗口误当 OAuth；onUpdated 会在真正的外部授权 URL 出现
      // 后完成泛化转移。少数实现会在创建事件里直接带上目标 URL，则可立即接管。
      if (isExternalOAuthTask(task) && task.usesExtensionProxy
        && tab.url && isOAuthPopupUrl(task, tab.url)) {
        await ensureOAuthPopupProxy(popupTabId, openerTabId, oauthProviderForTask(task, tab.url));
      }
    })();
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'loading' || changeInfo.url) {
      void handoffOAuthPopup(tabId, changeInfo.url ?? tab.url, tab.openerTabId);
    }
  });
  // Side Panel 模式由 Chrome 直接响应工具栏点击；这里只处理独立页面模式。
  chrome.action.onClicked.addListener(() => {
    void (async () => {
      await backgroundReady;
      const mode = await local.get<LaunchMode>(KEYS.launchMode, DEFAULT_LAUNCH_MODE);
      if (mode === 'tab') await chrome.runtime.openOptionsPage();
    })();
  });

  chrome.runtime.onMessage.addListener(
    (msg: Message, sender, sendResponse: (r: MessageResponse) => void) => {
      handle(msg, sender)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err?.message ?? String(err) }));
      return true; // 保持消息通道开启以支持异步响应
    },
  );

  // 标签页关闭时清掉信箱。若任务尚未回报结果，说明用户中途关了页面，
  // 把「签到中」复位为待签到，避免状态永久卡住。
  chrome.tabs.onRemoved.addListener((tabId) => {
    forgetPointer(tabId);
    void handleTabRemoved(tabId);
  });
});

// tabs.onCreated 与 tabs.onUpdated 会为同一个 popup 几乎同时触发。完整接管必须
// 串行，否则落败的 rebind 分支会把胜出分支刚转移的代理租约撤回 opener。
let oauthHandoffQueue: Promise<void> = Promise.resolve();

function handoffOAuthPopup(popupTabId: number, url?: string, openerHint?: number): Promise<void> {
  const next = oauthHandoffQueue
    .catch(() => {})
    .then(() => handoffOAuthPopupOnce(popupTabId, url, openerHint));
  oauthHandoffQueue = next.catch(() => {});
  return next;
}

async function handoffOAuthPopupOnce(popupTabId: number, url?: string, openerHint?: number): Promise<void> {
  let popup = await oauthPopups.get(popupTabId);
  if (!popup && openerHint != null) {
    // onUpdated 可能先于 onCreated 的异步 storage 写入到达；用 Chrome
    // 提供的 openerTabId 补登记，避免首个 OAuth URL 被漏掉而继续直连。
    const openerTask = await taskState.get(openerHint);
    if (openerTask?.runId) {
      await oauthPopups.remember(popupTabId, openerHint);
      popup = { openerTabId: openerHint };
    }
  }
  if (!popup || !url) return;
  const openerTabId = popup.openerTabId;

  const original = await taskState.get(openerTabId);
  if (original?.runId && isExternalOAuthTask(original) && original.usesExtensionProxy
    && isOAuthPopupUrl(original, url)) {
    await ensureOAuthPopupProxy(popupTabId, openerTabId, oauthProviderForTask(original, url));
    popup = await oauthPopups.get(popupTabId) ?? popup;
  }
  if (!original?.runId || !isGithubCredentialStage(original.stage)) return;

  // 已授权过的 GitHub 会把第二次 OAuth 压缩成一次极快的 302。监听器可能完全
  // 看不到 github.com，只看到弹窗已经回到本站 /oauth/*；这仍是同一授权链。
  const isGithubPopup = isGithubTaskContinuation(original, url);
  const isGooglePopup = (
    original.effectiveLoginMethod === 'oauth'
    || original.effectiveLoginMethod === 'github'
    || original.effectiveLoginMethod === 'passkey'
  ) && isGoogleAuthUrl(url);
  if (!isGithubPopup && !isGooglePopup) return;

  if (isGooglePopup) {
    /*
     * Google 的常见实现是「弹窗授权 → postMessage 给 opener → 自动关闭」。
     * 不能把任务信箱搬到这个短命弹窗，否则它一关闭就会把仍在等待回调的
     * 原任务判成失败。只临时转移代理租约，保证 Google 页面和认证请求
     * 使用同一个账号出口；弹窗关闭时再转回 opener。
    */
    if (!original.usesExtensionProxy) return;
    /*
     * 先落盘「这个弹窗是任务的一部分」，再动租约 —— 顺序不能反。
     *
     * 两步之间 Service Worker 随时可能被回收（Google 授权页正等用户输密码，
     * 扩展这边没有任何事件）。冷启动跑的 proxyLease.recover 只放过「合法持有者」
     * 名单里的标签页；标记还没落盘的话，已经转给弹窗的租约会被当成僵尸清掉，
     * 授权页当场改走直连。标记在前，最坏情况只是多留一条无害的标记。
     */
    if (!await ensureOAuthPopupProxy(popupTabId, openerTabId, 'google')) return;
    // 标签页可能在 transfer 等待期间被用户关掉；不要把已关的 tab 留成
    // session 里的持有者，否则后续任务会一直误以为代理仍被占用。
    const popupAlive = await chrome.tabs.get(popupTabId).then(() => true).catch(() => false);
    if (!popupAlive) {
      await proxyLease.release(popupTabId).catch(() => {});
      await oauthPopups.forget(popupTabId);
      return;
    }
    return;
  }

  /*
   * `chrome.proxy` 是浏览器全局设置。OAuth 弹窗出现时不能释放旧标签页的
   * 租约，否则 Google/GitHub 页面会立即改走直连；先把持有者转过去，
   * 代理配置和认证凭据本身保持不变，任务结束后由新标签页负责 release。
   */
  const transferred = original.usesExtensionProxy
    ? await ensureOAuthPopupProxy(popupTabId, openerTabId, 'github')
    : true;
  if (!transferred) {
    await oauthPopups.clearProxyTransferred(popupTabId);
    return;
  }

  const moved = await taskState.rebind(openerTabId, popupTabId, original.runId);
  if (!moved) {
    // 并发/恢复路径可能已经把同一 run 搬到了目标 popup。此时这是幂等成功，
    // 绝不能把它正在使用的代理回滚给 opener。
    const alreadyMoved = await taskState.get(popupTabId);
    if (alreadyMoved?.runId === original.runId) return;
    if (original.usesExtensionProxy) {
      await proxyLease.transfer(popupTabId, openerTabId).catch(() => {});
      await oauthPopups.clearProxyTransferred(popupTabId);
    }
    return;
  }

  const rebound = await checkinQueue.rebindActiveTab(openerTabId, popupTabId);
  if (!rebound) {
    // 队列已结束/切到别的账号时不能留下孤儿任务，回滚到发起页。
    await taskState.rebind(popupTabId, openerTabId, original.runId).catch(() => null);
    if (original.usesExtensionProxy) {
      await proxyLease.transfer(popupTabId, openerTabId).catch(() => {});
      await oauthPopups.clearProxyTransferred(popupTabId);
    }
    return;
  }
  // 任务信箱已经搬到弹窗，它自己就是队列里的 active.tabId，不再需要这条记录。
  await oauthPopups.forget(popupTabId);
  broadcast();
}

/**
 * 弹窗关闭前先把临时转移的 OAuth 代理租约收回来。
 *
 * 该函数由 tabs.onRemoved 的唯一监听器串行调用，再进入 finalizeTab，
 * 避免「先 finalize 清理、后 transfer」的竞态把全局代理提前清掉。
 */
async function handleTabRemoved(tabId: number): Promise<void> {
  const popup = await oauthPopups.get(tabId);
  if (popup) {
    await oauthPopups.forget(tabId);
    if (popup.proxyTransferred) {
      const openerTask = await taskState.get(popup.openerTabId);
      if (openerTask?.runId) {
        await proxyLease.transfer(tabId, popup.openerTabId).catch(() => {});
      } else {
        // opener 已经完成/失败或被关闭，没人会再调用 release(openerTabId)。
        await proxyLease.release(tabId).catch(() => {});
      }
    }
  }

  /*
   * 学习标签页被关掉：清会话 + 释放它占用的全局代理租约。
   *
   * 学习现在也会 acquire 账号代理（否则只能经代理访问的站点打不开学习页）。
   * 用户直接关掉学习页时既不点「结束学习」也不点「放弃」，旧实现下这条租约没人回收——
   * 后面的签到任务会一直报「代理正被其他任务占用」，学习会话还要等 30 分钟 TTL 才消失
   * （期间同站其它账号被互斥挡住）。两者都是用户可感知的怪象。
   */
  const orphanLearning = await session.get<WorkflowLearningSession | null>(LEARN_KEY(tabId), null);
  if (orphanLearning) {
    await finishLearningSession(orphanLearning).catch(() => {});
    broadcast();
  }

  const task = await taskState.get(tabId);
  const children = await oauthPopups.entriesOf(tabId);

  /*
   * 最理想的处理是把任务本身也移到仍活着的 OAuth 弹窗：这样队列继续把
   * 它视为 active，不会在全局代理仍被弹窗占用时错误启动下一个账号。回调
   * 若落在弹窗自身（很多企业 SSO 是这种形式），content script 会正常接管；
   * 若站点依赖已关闭 opener 的 postMessage，最终会由用户关闭弹窗或 watchdog
   * 收尾，但期间代理始终不会掉线。
   */
  if (task?.runId && isExternalOAuthTask(task)) {
    const active = await checkinQueue.active();
    if (active?.tabId === tabId && active.accountId === task.accountId) {
      if (await rebindActiveTaskToOAuthPopup(active, task)) return;
    }
  }

  /*
   * opener 先被用户关闭时，不能立刻按普通任务页收尾：OAuth 弹窗可能还在
   * 登录/二次验证，且它是浏览器全局代理的实际持有者。先把所有仍存活的
   * 子窗口标成 retained，并把租约转过去；releaseTaskProxy 会识别这个标记，
   * 不会在 finalizeTab 里把弹窗的代理提前清掉。弹窗自己关闭时再释放。
   */
  await retainOAuthPopupsForOpener(tabId, task, children);

  await finalizeTab({ tabId, failure: '标签页被关闭，签到中断' });
}

/**
 * opener 失效时接管其仍存活的 OAuth 子窗口。
 *
 * 该函数同时用于 tabs.onRemoved 与队列恢复：前者处理实时事件，后者覆盖
 * Service Worker 休眠期间漏掉 onRemoved 的情况。普通表单/Token 任务的
 * target=_blank 不会被误升级为代理持有者；已经标记 transferred 的记录则
 * 即使 task 信箱已丢失也必须继续保留，直到 popup 自己关闭。
 */
async function retainOAuthPopupsForOpener(
  openerTabId: number,
  task: LoginTask | null,
  suppliedChildren?: [number, import('@/background/oauth/oauth-popups').OAuthPopupState][],
): Promise<void> {
  const children = suppliedChildren ?? await oauthPopups.entriesOf(openerTabId);
  const canRetainOAuthProxy = Boolean(task?.usesExtensionProxy && isExternalOAuthTask(task));

  for (const [popupTabId, state] of children) {
    const popupTab = await chrome.tabs.get(popupTabId).catch(() => null);
    if (!popupTab) {
      await oauthPopups.forget(popupTabId);
      continue;
    }
    // 普通表单/Token 任务也可能打开帮助链接或下载页；没有 OAuth 任务语境
    // 时绝不能把这些普通子窗口升级成代理租约持有者。
    if (!canRetainOAuthProxy && !state.proxyTransferred) {
      await oauthPopups.forget(popupTabId);
      continue;
    }
    if (task && !state.proxyTransferred && !isOAuthPopupCandidate(task, popupTab)) {
      await oauthPopups.forget(popupTabId);
      continue;
    }
    // 即使 registry 已经写了 proxyTransferred，也要再尝试一次 transfer：
    // Worker 可能在「写标记」和「改 lease holder」之间被回收，留下标记但
    // 租约仍在 opener。transfer 在 holder 已是 popup 时返回 false，不会破坏
    // 已经正确建立的状态；而 opener 先关闭时这里正是最后的接管机会。
    const moved = await proxyLease.transfer(openerTabId, popupTabId).catch(() => false);
    if (moved) {
      await oauthPopups.markProxyTransferred(popupTabId, state.provider ?? 'generic');
    }
    if ((await oauthPopups.get(popupTabId))?.proxyTransferred) {
      await oauthPopups.markProxyRetained(popupTabId);
    }
  }
}

/**
 * Service Worker 恢复时接管已经失效的 opener。
 *
 * `checkinQueue.recover()` 会在任务 tab 不存在时调用 `abandon`。如果此时
 * OAuth popup 仍在认证，单纯 abandon 会删除任务信箱；代理虽然可以 retained，
 * 但回调再也没有任务可继续。把任务和 active tab 一起 rebind 到 popup，才能
 * 让未知 OAuth 提供商、Google 以及企业 SSO 在 Worker 重启后继续完成。
 */
async function rebindActiveTaskToOAuthPopup(
  active: { accountId: string; tabId: number; startedAt: number },
  task: LoginTask,
): Promise<boolean> {
  if (!task.runId || !isExternalOAuthTask(task)) return false;

  const children = await oauthPopups.entriesOf(active.tabId);
  for (const [popupTabId, state] of children) {
    const popupTab = await chrome.tabs.get(popupTabId).catch(() => null);
    if (!popupTab) {
      await oauthPopups.forget(popupTabId);
      continue;
    }
    if (!state.proxyTransferred && !isOAuthPopupCandidate(task, popupTab)) {
      await oauthPopups.forget(popupTabId);
      continue;
    }

    const ownsProxy = task.usesExtensionProxy
      ? await ensureOAuthPopupProxy(
          popupTabId,
          active.tabId,
          state.provider ?? oauthProviderForTask(task),
        )
      : true;
    if (!ownsProxy) continue;

    const moved = await taskState.rebind(active.tabId, popupTabId, task.runId);
    if (!moved) continue;
    const rebound = await checkinQueue.rebindActiveTab(active.tabId, popupTabId);
    if (!rebound) {
      await taskState.rebind(popupTabId, active.tabId, task.runId).catch(() => null);
      continue;
    }

    // 只有一个标签页能持有全局代理。其余重复 popup 不再参与恢复，避免
    // 任务完成后残留记录挡住下一个账号。
    for (const [otherTabId, otherState] of children) {
      if (otherTabId === popupTabId) continue;
      if (otherState.proxyTransferred) await oauthPopups.clearProxyTransferred(otherTabId);
      await oauthPopups.forget(otherTabId);
    }
    await oauthPopups.forget(popupTabId);
    broadcast();
    return true;
  }
  return false;
}

/**
 * 把全局代理租约交给 OAuth 弹窗。幂等：onCreated/onUpdated 可能同时到达，
 * 已经转移过的记录只返回 true，不会再次尝试从 opener 抢租约。
 */
async function ensureOAuthPopupProxy(
  popupTabId: number,
  openerTabId: number,
  provider: 'google' | 'github' | 'generic',
): Promise<boolean> {
  const current = await oauthPopups.get(popupTabId);
  if (current?.proxyTransferred) {
    const holder = await proxyLease.holder();
    if (holder === popupTabId) return true;
    // 标记先落盘、租约后转移是为了抵抗 Worker 冷启动；若恰好在这两步
    // 之间收到 onRemoved/onUpdated，就继续完成同一笔 transfer，而不是把
    // 一个只写了标记、实际仍由 opener 持有的记录当成已完成。
    if (holder !== openerTabId) return false;
  } else {
    // onUpdated 可能早于 onCreated 的异步登记；确保 mark 不会落在不存在的
    // 记录上，导致租约已经转移但恢复表里没有对应弹窗。
    if (!current) await oauthPopups.remember(popupTabId, openerTabId);
    await oauthPopups.markProxyTransferred(popupTabId, provider);
  }
  const moved = await proxyLease.transfer(openerTabId, popupTabId);
  if (!moved) {
    // 另一个 onCreated/onUpdated 调用可能刚完成同一笔转移。holder 已是目标
    // 即为幂等成功，并补回 registry 标记，不能把胜出调用的状态清掉。
    if (await proxyLease.holder() === popupTabId) {
      await oauthPopups.markProxyTransferred(popupTabId, provider);
      return true;
    }
    await oauthPopups.clearProxyTransferred(popupTabId);
    return false;
  }
  return true;
}

function scheduleBackgroundRecovery(): Promise<void> {
  const recover = async () => {
    await syncLaunchBehavior();
    await checkinQueue.recover();
    const closedPopups = await oauthPopups.pruneDeadTabs();
    const active = await checkinQueue.active();
    // recover() intentionally keeps a live task instead of relaunching it. Its session mailbox may
    // still contain a configuration written by an older extension build, so migrate it in place.
    await migrateRecoveredActiveTask(active);

    // Worker 休眠期间 OAuth popup 可能已经自动关闭，onRemoved 因此没有机会
    // 把租约交还 opener。代理设置本身仍有效，只需修正 holder；直接 recover
    // 会把它当僵尸清掉，导致已经回调成功的原站点突然改走直连。
    for (const [popupTabId, popup] of closedPopups) {
      if (!popup.proxyTransferred) continue;
      if (active?.tabId === popup.openerTabId) {
        const openerTask = await taskState.get(popup.openerTabId);
        if (openerTask?.runId) {
          const returned = await proxyLease.transfer(popupTabId, popup.openerTabId);
          if (returned) continue;
        }
      }
      await proxyLease.release(popupTabId);
    }
    /*
     * 合法持有者 = 正在跑的任务页 **加上它名下已经拿到租约的 OAuth 弹窗**。
     *
     * 漏掉弹窗，Google 授权就会在进行到一半时被撤掉全局代理 —— Worker 每分钟
     * 被看门狗唤醒一次，每次冷启动都会走到这里。详见 proxyLease.recover 的注释。
     */
    // retained 弹窗可能已经脱离了原任务（例如 opener 被用户关掉），因此
    // 不能只从 active.tabId 反查；把 session 里所有仍标记为持有者的弹窗
    // 一并交给 recover，直到它们自己的 onRemoved 事件释放租约。
    const popupLeaseHolders = await oauthPopups.transferredPopups();
    /*
     * 任务正处在「还没拿到标签页」的启动窗口时不碰租约。
     *
     * 此时队列里的 active.tabId 还是 0，而 proxyLease 的持有者可能已经是刚建
     * 好的标签页 —— 拿 [0] 去比对必然判成僵尸，recover 会 clearProxy()，把刚
     * 设好的全局代理撤掉，任务随后用直连导航，日志里却写着「已启用扩展代理」。
     * 启动本身会在拿不到租约时就报错收尾，不需要这里代劳。
     */
    if (shouldReclaimProxyLease({
      activeTabId: active?.tabId ?? null,
      launchInFlight: await checkinQueue.launchInFlight(),
    })) {
      /*
       * 学习标签页也是**合法**的租约持有者。
       *
       * 学习现在会 acquire 账号代理（否则只能经代理访问的站点打不开学习页），
       * 而 recover 的判据是「持有者必须在 validTabIds 里，否则当僵尸清掉」。
       * 漏掉学习页就等于：用户点「开始学习」后 worker 一冷启动（几十秒一次，
       * 看门狗每分钟还会闹一次），全局代理当场被撤 —— 学习页突然改走直连，
       * 只能经代理访问的站点直接打不开，学习被迫中断，而界面上看不出原因。
       */
      const { active: learningSessions } = partitionLearningSessions(
        Object.entries(await chrome.storage.session.get(null)),
      );
      const learningLeaseHolders = learningSessions
        .map((learning) => learning.tabId)
        .filter((tabId) => tabId > 0);
      const leaseHolders = [
        ...new Set([
          ...(active ? [active.tabId] : []),
          ...popupLeaseHolders,
          ...learningLeaseHolders,
        ]),
      ];
      await proxyLease.recover(leaseHolders);
    }
    await syncScheduleAlarm();
    // 当天错过的那一轮在这里补上：闹钟只在浏览器运行时投递，关机或整天没开
    // 浏览器时，用户原本只能自己手动点一次批量签到。
    await runMissedScheduledCheckin();
  };
  backgroundReady = backgroundReady.then(recover, recover).catch((error) => {
    console.error('[后台恢复] 失败', error);
  });
  return backgroundReady;
}

async function syncLaunchBehavior(): Promise<void> {
  const mode = await local.get<LaunchMode>(KEYS.launchMode, DEFAULT_LAUNCH_MODE);
  await applyLaunchBehavior(mode);
}

async function applyLaunchBehavior(mode: LaunchMode): Promise<void> {
  await launchModeController.sync(mode).catch((error) => {
    console.error('[启动模式] 应用失败', error);
  });
}

/**
 * 只保留一个下一次闹钟。用绝对时间戳的一次性 alarm，避免按 1440 分钟重复
 * 时在跨时区/夏令时环境中逐日漂移；闹钟触发后会再次调用本函数安排下一次。
 */
function syncScheduleAlarm(): Promise<void> {
  const run = scheduleSyncQueue.then(syncScheduleAlarmOnce, syncScheduleAlarmOnce);
  scheduleSyncQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function syncScheduleAlarmOnce(): Promise<void> {
  const raw = await local.get<unknown>(KEYS.schedule, DEFAULT_CHECKIN_SCHEDULE);
  const schedule = normalizeSchedule(raw);
  const next = nextScheduledAt(schedule);
  if (!next) {
    await chrome.alarms.clear(SCHEDULE_ALARM).catch(() => false);
    return;
  }
  // Creating an alarm with the same name replaces it, so there is no gap in
  // which a concurrent configuration update could leave scheduling disabled.
  await chrome.alarms.create(SCHEDULE_ALARM, { when: next.getTime() });
}

function runScheduledCheckin(scheduledTime?: number): Promise<void> {
  const run = scheduleAlarmQueue.then(() => runScheduledCheckinOnce(scheduledTime), () => runScheduledCheckinOnce(scheduledTime));
  scheduleAlarmQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function runScheduledCheckinOnce(scheduledTime?: number): Promise<void> {
  try {
    await backgroundReady;
    const schedule = normalizeSchedule(await local.get<unknown>(KEYS.schedule, DEFAULT_CHECKIN_SCHEDULE));
    if (scheduledTime == null) return;

    const now = new Date();
    if (!shouldRunScheduledAlarm(schedule, scheduledTime, now)) return;
    await dispatchScheduledRun(schedule, new Date(scheduledTime));
  } catch (error) {
    console.error('[定时签到] 执行失败', error);
  } finally {
    // 即使本轮入队失败，也不能让后续计划消失。
    await syncScheduleAlarm().catch((error) => console.error('[定时签到] 重排闹钟失败', error));
  }
}

/**
 * 补跑当天已经到点、但一轮都没跑过的计划。
 *
 * Chrome 只在浏览器运行时投递闹钟：机器在计划时刻关机、或整个白天没开过
 * 浏览器，当天这一轮就永远不会发生 —— 用户只能自己记得手动点一次批量签到。
 * 每次 Service Worker 冷启动都会走到这里，因此开机/重开浏览器就会补上。
 * 已经跑过的那一轮由 runKey 去重，绝不会重复提交。
 *
 * 注意：调用点必须在 scheduleBackgroundRecovery 内部，且**不能** await
 * backgroundReady —— 那正是 recover 自己参与构造的 promise。
 */
async function runMissedScheduledCheckin(): Promise<void> {
  const run = scheduleAlarmQueue.then(runMissedScheduledCheckinOnce, runMissedScheduledCheckinOnce);
  scheduleAlarmQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function runMissedScheduledCheckinOnce(): Promise<void> {
  try {
    const schedule = normalizeSchedule(await local.get<unknown>(KEYS.schedule, DEFAULT_CHECKIN_SCHEDULE));
    const slot = latestDueScheduleSlot(schedule, new Date());
    if (!slot) return;
    await dispatchScheduledRun(schedule, slot);
  } catch (error) {
    console.error('[定时签到] 补跑检查失败', error);
  }
}

/** 用今天这一轮对应的 runKey 去重后入队。闹钟投递与冷启动补跑共用。 */
async function dispatchScheduledRun(schedule: CheckinSchedule, target: Date): Promise<void> {
  const targetKey = scheduleRunKey(target, schedule.time);

  const lastRun = await session.get<{ key?: string; signature?: string }>(SCHEDULE_RUN_KEY, {});
  const signature = scheduleSignature(schedule);
  if (lastRun.key === targetKey && lastRun.signature === signature) return;

  const now = new Date();
  const day = todayKey(now);
    const [accounts, status, userSites, removedBuiltinSiteIds] = await Promise.all([
      local.get<Account[]>(KEYS.accounts, []),
      local.get<Record<string, string>>(KEYS.status, {}),
      local.get<SiteConfig[]>(KEYS.sites, []),
      local.get<string[]>(KEYS.removedBuiltinSiteIds, []),
    ]);
    const hiddenBuiltinIds = new Set(removedBuiltinSiteIds);
    const validSiteIds = new Set([
      ...userSites.map((site) => site.id),
      ...BUILTIN_SITES.filter((site) => !hiddenBuiltinIds.has(site.id)).map((site) => site.id),
    ]);
    const selectedIds = scheduledAccountIds(schedule, accounts.map((account) => account.id));
    const selectedIdSet = new Set(selectedIds);
    const accountIds = accounts
      .filter((account) => {
        // 未归属账号保留凭据供用户恢复，但在恢复前绝不能进入自动队列。
        if (!validSiteIds.has(account.siteId)) return false;
        if (!selectedIdSet.has(account.id)) return false;
        const value = status[statusKey(account.id, day)];
        // attention 代表需要用户完成验证，自动计划不应反复打开新标签覆盖它。
        return value !== 'done' && value !== 'running' && value !== 'attention';
      })
      .map((account) => account.id);
    if (accountIds.length) {
      const result = await enqueueAccounts(accountIds);
      if (result.ok) console.info(`[定时签到] 已加入 ${result.queued ?? 0} 个账号，跳过 ${result.skipped ?? 0} 个`);
      else {
        console.warn(`[定时签到] 入队失败：${result.error}`);
        return;
      }
      broadcast();
    }
    // 只有成功提交队列（或明确没有待执行账号）后才标记本次计划，
    // storage/入队瞬时失败时，同一 alarm 的补投仍有机会恢复。
    await session.set(SCHEDULE_RUN_KEY, { key: targetKey, signature });
}

/**
 * 交给 GitHub 认证页的最小任务副本。
 *
 * 只含 GitHub 账密和固定的 GitHub 表单选择器：绝不带站点密码、API token、
 * 抓取的会话或原站点配置。不满足白名单条件时返回 null。
 */
function githubCredentialTask(task: LoginTask, currentUrl: string): LoginTask | null {
  const githubUsername = task.githubUsername?.trim();
  const logoutFlow = task.stage === 'github-logout'
    && (isGithubLogoutUrl(currentUrl) || isGithubLoggedOutUrl(currentUrl));
  const credentialFlow = isGithubAuthUrl(currentUrl) && isGithubCredentialStage(task.stage);
  if (
    (!logoutFlow && !credentialFlow)
    || task.effectiveLoginMethod !== 'github'
    || !githubUsername
    || !task.githubPassword
  ) {
    return null;
  }

  return {
    tabId: task.tabId,
    runId: task.runId,
    accountId: task.accountId,
    siteId: task.siteId,
    username: '',
    password: '',
    ...(credentialFlow ? {
      githubUsername,
      githubPassword: task.githubPassword,
    } : {}),
    site: {
      id: 'github-auth',
      name: 'GitHub',
      loginUrl: 'https://github.com/login',
      pointerMode: task.site.pointerMode,
      selectors: {
        username: '#login_field',
        password: '#password',
        submit: 'input[name="commit"]',
      },
      closeModalSelectors: [],
    },
    effectiveLoginMethod: 'github',
    effectiveCheckinMethod: task.effectiveCheckinMethod,
    usesExtensionProxy: task.usesExtensionProxy,
    createdAt: task.createdAt,
    stage: task.stage,
    steps: task.steps,
  };
}

/**
 * 新标签页上的 GitHub 认证页：按「当前活动任务 + opener 归属」取凭据。
 *
 * 站点用 window.open 打开授权页时，新标签页没有自己的信箱。这里回退到队列
 * 里正在跑的任务，但只有当前弹窗确实由该任务页打开时才允许回退；URL 白名单
 * 判定仍由 githubCredentialTask 统一执行。
 */
async function githubCredentialTaskFor(
  popupTabId: number,
  currentUrl?: string,
  openerHint?: number,
): Promise<LoginTask | null> {
  if (!currentUrl) return null;
  const activeTask = await activeTaskForGithubPointer(popupTabId, openerHint);
  if (!activeTask) return null;
  return githubCredentialTask(activeTask, currentUrl);
}

/**
 * 队列里正在跑、且确实打开了当前 GitHub 弹窗的任务。
 *
 * 只看“队列当前有一个任务”仍不够：用户可能同时开着普通 GitHub 登录页，
 * 那个页面也会加载 content script。必须再核对 popup registry 或 Chrome
 * 提供的 openerTabId，才能把当前账号的 GitHub 凭据交给这张授权页。
 */
async function activeTaskForGithubPointer(
  popupTabId: number,
  openerHint?: number,
): Promise<LoginTask | null> {
  const active = await checkinQueue.active();
  if (!active || active.tabId <= 0) return null;
  const popup = await oauthPopups.get(popupTabId);
  const openerTabId = popup?.openerTabId ?? openerHint;
  if (openerTabId !== active.tabId) return null;
  const activeTask = await taskState.get(active.tabId);
  return activeTask?.runId && activeTask.accountId === active.accountId
    ? activeTask
    : null;
}

/**
 * 清掉过期会话并按「没有在录」处理。
 *
 * 幂等：会话不存在或未过期时什么都不做；清理时顺手让页面停手，否则 content script
 * 里的监听器还在跑，会把用户后续操作继续上报进一个已过期的会话。
 *
 * ⚠️ 这里**必须**走 finishLearningSession，而不是自己 remove + stop：
 * 学习会话现在持有全局代理租约（否则只能经代理访问的站点打不开学习页），
 * 而「用户忘了点结束、会话超时」正是最容易漏掉释放的一条路径 ——
 * 页面上什么都没发生，后台却握着一把看不见的锁，之后的签到任务一律报
 * 「代理正被其他任务占用」，重启浏览器才能恢复。
 * finishLearningSession 的 runId 校验保证不会误删已经被新会话顶替的信箱。
 */
async function dropExpiredLearning(learning: WorkflowLearningSession): Promise<void> {
  await finishLearningSession(learning);
}

/**
 * 全局网络配置（chrome.proxy）此刻是否被占用。
 *
 * 为什么不能只看 checkinQueue.busy()：改全局代理的不止签到队列，
 * **学习会话**同样持有 proxyLease（它必须经账号代理才能打开学习页）。
 * 「测活 / 端口扫描」这两条路只在对方是签到队列时才退让，于是：
 *   1. 用户点开始学习 → 学习页挂在账号代理上；
 *   2. 用户在代理管理里点「测活」或扫描端口 → 只检查 checkinQueue.busy()，
 *      看不到学习租约，于是它照样 applyProxy 切走全局设置；
 *   3. testProxy 的 finally 里 clearProxy() —— 学习页当场改走直连，
 *      只能经代理访问的站点直接打不开，学习被迫中断。
 *
 * 反向同样成立：测活/扫描**进行中**时点学习，学习会拿不到租约（如实报错，
 * 不会静默直连），但签到队列却是被直接放行的 —— 队列启动不检查这些锁。
 * 这就是「两套锁的交叉窗口」。
 *
 * 返回非 null 时是给用户的说明，调用方直接返回它。
 */
/**
 * 测活 / 端口扫描正在占用全局代理的落盘标记。
 *
 * 这两条路走的是 networkLocked，而队列启动**不走** networkLocked ——
 * 它直接 tabs.create + proxyLease.acquire。于是存在一个交叉窗口：
 * 用户点了扫描（几十秒，每个端口都要切一次全局代理），此时点签到，
 * 队列不会退让：它 acquire 租约时可能正好落在扫描的两次 applyProxy 之间，
 * applyProxy 一跑就把扫描当前那一步的端点顶掉，两边测出来的出口全乱。
 *
 * 这里把「正在扫描/测活」落一个 session 标记，让队列启动前能看见它。
 * 用 session 而不是内存变量：MV3 的 Service Worker 随时会被回收，
 * 内存里的标志会在扫描进行中凭空消失。
 */
const NETWORK_TOOL_LOCK = 'networkToolLock';
const NETWORK_TOOL_LOCK_TTL_MS = 5 * 60_000;

/** 标记测活/扫描正在占用全局代理；返回释放函数（务必在 finally 里调）。 */
async function acquireNetworkToolLock(kind: 'test' | 'scan'): Promise<() => Promise<void>> {
  await session.set(NETWORK_TOOL_LOCK, { kind, at: Date.now() });
  return async () => {
    const current = await session.get<{ kind?: string; at?: number } | null>(NETWORK_TOOL_LOCK, null);
    // 只清自己那把：另一条路可能刚好接上。
    if (current?.kind === kind) await session.remove(NETWORK_TOOL_LOCK).catch(() => {});
  };
}

/** 有没有测活/扫描正在动全局代理（超时的标记按没有处理，不会永久堵住队列）。 */
async function networkToolBusy(): Promise<'test' | 'scan' | null> {
  const lock = await session.get<{ kind?: unknown; at?: unknown } | null>(NETWORK_TOOL_LOCK, null);
  if (!lock || typeof lock.kind !== 'string' || typeof lock.at !== 'number') return null;
  if (Date.now() - lock.at > NETWORK_TOOL_LOCK_TTL_MS) return null;
  return lock.kind === 'scan' ? 'scan' : lock.kind === 'test' ? 'test' : null;
}

async function globalNetworkOccupied(reader: 'test' | 'scan' | 'queue'): Promise<string | null> {
  if (await checkinQueue.busy()) {
    return reader === 'scan'
      ? '签到队列正在使用网络配置，请完成后再扫描'
      : reader === 'queue'
        ? '签到队列正在使用网络配置'
        : '签到队列正在使用网络配置，请完成后再测试代理';
  }
  /*
   * 学习会话持有租约时同样不能动全局代理。
   * 对签到队列（'queue'）来说这不是「退让」而是**保护不到**：队列里的账号
   * 和正在学习的账号走的是两条不同出口，同时跑必然互相踩。启动前必须挡住。
   */
  const { active: learningSessions } = partitionLearningSessions(
    Object.entries(await chrome.storage.session.get(null)),
  );
  if (learningSessions.length > 0) {
    return reader === 'scan'
      ? '有账号正在学习流程，学习会话占用着网络配置；请先结束学习再扫描'
      : reader === 'queue'
        ? '有账号正在学习流程，请先结束学习再开始签到（两者不能同时使用代理）'
        : '有账号正在学习流程，学习会话占用着网络配置；请先结束学习再测试代理';
  }
  /**
   * 反向：测活/扫描正在进行时，队列也必须退让。
   *
   * 这两条路只在「对方是签到队列」时才退让（旧实现），队列反过来却不检查
   * 它们 —— 于是用户点了扫描（每个端口都要切一次全局代理，几十秒）再点
   * 签到，队列直接启动，租约 acquire 的 applyProxy 会把扫描当前那一步的
   * 端点顶掉，两边报出来的出口都对不上真实结果。
   */
  const tool = await networkToolBusy();
  if (tool) {
    const what = tool === 'scan' ? '本机端口扫描' : '代理测活';
    return reader === 'queue'
      ? `${what}正在使用网络配置，请完成后再开始签到`
      : `${what}正在使用网络配置，请完成后再试`;
  }
  return null;
}

async function findLearningSession(accountId?: string): Promise<WorkflowLearningSession | null> {
  const { active, expired } = partitionLearningSessions(
    Object.entries(await chrome.storage.session.get(null)),
  );
  // 过期的会话按「没有在录」处理：连同页面侧监听器一起清掉，行为可重复。
  for (const learning of expired) await dropExpiredLearning(learning);
  return active.find((learning) => !accountId || learning.accountId === accountId) ?? null;
}

/**
 * 学习会话期望的站点源（带缓存）与发送方校验的组装。
 *
 * 事件字段的净化（白名单、长度、内容闸门）在 `automation/learning.ts` 的
 * `sanitizeLearningEvent` 里；这里只补它拿不到的信息：消息的**真实来源**。
 * 学习标签页会跳到 OAuth 供应商等外域页面，那些页面上报的事件必须拒绝 ——
 * 事件的 path 落盘后只剩 `pathname + hash`，无法再与原站区分。
 */
const learningOriginCache = new Map<string, string | null>();

async function learningExpectedOrigin(learning: WorkflowLearningSession): Promise<string | null> {
  const cacheKey = learning.siteId;
  if (cacheKey && learningOriginCache.has(cacheKey)) return learningOriginCache.get(cacheKey)!;
  const accounts = await local.get<Account[]>(KEYS.accounts, []);
  const account = accounts.find((item) => item.id === learning.accountId);
  const site = account
    ? configuredSite(account.siteId, await local.get<SiteConfig[]>(KEYS.sites, []))
    : undefined;
  const origin = learningSiteOrigin(site);
  if (cacheKey) learningOriginCache.set(cacheKey, origin);
  return origin;
}

/** 这条消息是不是从学习站点自己的页面发出的？拿不到任一侧的源一律拒绝。 */
async function isLearningEventSenderAllowed(
  learning: WorkflowLearningSession,
  sender: chrome.runtime.MessageSender,
): Promise<boolean> {
  return isLearningSenderSameOrigin(sender.url ?? sender.tab?.url, await learningExpectedOrigin(learning));
}

async function toggleLearning(
  accountId: string,
  requestedKind?: LearningKind,
  options: { loginAsCheckin?: boolean } = {},
): Promise<MessageResponse> {
  let existing = await findLearningSession(accountId);
  if (!existing) {
    const accounts = await local.get<Account[]>(KEYS.accounts, []);
    const account = accounts.find((item) => item.id === accountId);
    if (!account) return { ok: false, error: '账号不存在' };
    const active = partitionLearningSessions(Object.entries(await chrome.storage.session.get(null))).active;
    /**
     * 同站互斥**不再按 kind 区分**：融合学习一次产出两份站点级产物，
     * 同站同时存在两条录制必然互相污染登录态与动作流。
     */
    const decision = decideLearningStart(active, { accountId, siteId: account.siteId, kind: requestedKind });
    if (!decision.allowed) {
      const other = accounts.find((item) => item.id === decision.conflict.accountId);
      const name = other?.label || other?.username || decision.conflict.accountId;
      return { ok: false, error: `本站账号「${name}」正在学习${learningKindLabel(decision.conflict.kind ?? 'checkin')}流程；同站点只能有一条录制，请先结束或放弃那条学习` };
    }
  }
  /**
   * 结束学习：**一次演示同时编译两份产物**（站点级登录配置 + 站点级签到流程）。
   *
   * 两类产物的编译都读同一份事件流，各自只挑自己的语义；任何一半缺失都**如实**
   * 反映：只完成登录时只写登录配置，只完成签到时只写签到流程。用户不需要再点两次，
   * 也不会有「明明学到一半却被整场丢弃」的体验。
   */
  if (existing) {
    const existingKind: LearningKind = existing.kind ?? 'checkin';
    // 旧的「学习登录」入口语义原样保留：它只产出登录配置，不碰签到流程。
    const intent: LearningArtifactIntent = existingKind === 'login' ? 'login' : 'both';
    /**
     * 结束请求可以不带 kind（旧调用方）；带的话只允许与当前会话一致，
     * 避免用户在录制中途「切换学习类型」把两份产物搅在一起。
     */
    if (requestedKind && requestedKind !== existingKind && !(requestedKind === 'both' && existingKind === 'checkin')) {
      return { ok: false, error: `该账号正在进行${existingKind === 'login' ? '登录' : '登录与签到'}学习，请先结束或放弃当前学习` };
    }
    const accounts = await local.get<Account[]>(KEYS.accounts, []);
    const account = accounts.find((item) => item.id === accountId);
    const userSites = await local.get<SiteConfig[]>(KEYS.sites, []);
    const site = account ? configuredSite(account.siteId, userSites) : undefined;
    if (!account || !site) return { ok: false, error: '学习目标账号或站点不存在' };

    // 页面先结算末尾变化并等 LEARN_EVENT 回执；此时不能持有 learningWrites 锁。
    // content 侧只回传布尔「本次是否出现过验证码/OTP 字段」；不含字段名或值。
    const flushed = await flushLearningCapture(existing.tabId, existing.runId);
    if (!flushed.ok) return { ok: false, error: flushed.error ?? '学习动作尚未保存，请返回学习标签页后重试' };
    const challengeSeenDuringLearning = flushed.challengeSeen === true;
    // 三态原样透传：undefined 表示「未观测」，绝不能当成「确认没有控件」。
    const checkinControlSeen = flushed.checkinControlSeen;
    /**
     * 「读回最新事件 + 写入 challengeSeen」必须在**同一次**串行锁里完成。
     *
     * 旧实现把它拆成两次 `learningWrites.run`：第一次取快照，锁外改字段，第二次
     * 整份写回。两次获取之间到达的 LEARN_EVENT 会先落进会话，随后被这里用**读取时
     * 的旧快照**整体覆盖 —— 用户「点了签到 → 立刻点结束学习」时，最后那一步就
     * 凭空消失了（浮层已经推进过，保存结果里却没有它，是最难排查的一类丢步）。
     * storage 的读改写必须以会话为单位原子完成，中间不能有 await 空窗。
     */
    const sessionTabId = existing.tabId;
    const sessionRunId = existing.runId;
    const refreshed = await learningWrites.run(async () => {
      const current = await session.get<WorkflowLearningSession | null>(LEARN_KEY(sessionTabId), null);
      if (!current || current.runId !== sessionRunId) return null;
      // content 侧只回传布尔「本次是否出现过验证码/OTP 字段」；不含字段名或值。
      const next: WorkflowLearningSession = { ...current, challengeSeen: challengeSeenDuringLearning };
      await session.set(LEARN_KEY(sessionTabId), next);
      return next;
    });
    if (!refreshed) return { ok: false, error: '学习会话已结束，请重新开始' };
    existing = refreshed;

    /**
     * 「登录即签到」可以是用户显式选的出口，也可以在演示本身已经给出足够证据时自动判定。
     *
     * 显式路径：先用与界面按钮**同一份**保守判据复核（登录已生效、没点过退出登录、
     * 也没录到签到动作），不满足就保留会话、如实说清还差什么 —— 绝不因为用户点了
     * 按钮就替站点宣称签到完成。
     *
     * 自动路径：shouldAutoSaveLoginAsCheckin 已经内含同一份保守判据，并且额外要求
     * 结束学习那一刻页面上**确实没有可见的签到控件**、且演示停在资料页/已知业务页
     * —— 只有「没按钮可点」而非「忘了点」才会自动落到这里，因此不需要再复核一次。
     * 下面两条拒绝分支因此只对**显式请求**生效，绝不替自动判定重复判一遍。
     */
    const loginAsCheckinRequested = options.loginAsCheckin === true;
    /**
     * 自动判定再加一道**不覆盖既有配置**的闸门。
     *
     * 落盘 `{method:'none'}` 是整对象替换：站点原有入口/URL/工作流会被清掉
     * （这是有意的，避免旧入口继续被执行），但用户已经精心配好的 api/claim/
     * button/relogin 方案不该被一次「没看到按钮」的观测悄悄换掉。
     *
     * 因此自动路径只服务「还没配过」或「本来就是自动识别」的站点；站点已有明确
     * 签到方式时，仍由用户显式点「登录即签到」才改 —— 那时他知道自己在改什么。
     */
    const autoLoginAsCheckin = !loginAsCheckinRequested
      && (!site.checkin?.method || site.checkin.method === 'auto')
      && shouldAutoSaveLoginAsCheckin(existing.events, existingKind, checkinControlSeen);
    const wantsLoginAsCheckin = loginAsCheckinRequested || autoLoginAsCheckin;
    if (loginAsCheckinRequested && intent === 'login') {
      return { ok: false, error: '本次只学登录，不产出签到流程；「登录即签到」请用「学习本站流程」完成' };
    }
    if (loginAsCheckinRequested && !canSaveLoginAsCheckin(existing.events, existingKind)) {
      return {
        ok: false,
        error: '还不能按「登录即签到」保存：需要先登录成功并进入站内页面，且本次演示没有点到过签到按钮。'
          + '请继续演示（或点「结束学习」按现有内容保存）',
      };
    }

    // 演示账号自己的名字：编译时从步骤里剥掉，流程才能给同站别的账号回放。
    const personalTexts = learningPersonalTexts(account);
    const artifacts = buildLearnedArtifacts(site, existing.events, intent, {
      loginAsCheckin: wantsLoginAsCheckin,
      personalTexts,
    });
    /**
     * 「登录即签到」也要保留演示时走过的路线。
     *
     * 运行时（engine.runCheckin）要用 route 上的身份页做账号核对，一并保留
     * identityPath；否则 OAuth 站点登录成功后停在 /dashboard，身份读不到就只能
     * 单账号兜底放行，学习时走过的资料页完全作废 —— 登录即签到会退化成
     * 「登录后什么都不核对」。
     *
     * steps 不保留：登录即签到没有可点的签到按钮，回放步骤没有意义；收尾由
     * method 'none' 的语义负责。
     */
    const keptRouteForLoginAsCheckin = artifacts.checkin?.kind === 'login-as-checkin'
      ? buildLearnedWorkflow(site, existing.events, { personalTexts })?.workflow ?? null
      : null;
    /**
     * 保存后可能不按预期签到的两种演示：先停下来问一次，会话保留。
     *
     * 1. 登录成功、却没录到签到也没判成登录即签到：直接按「只保存登录」结束会话，
     *    签到仍是旧方式，而「登录即签到」按钮随会话一起消失 —— 用户只能从头再学；
     * 2. 编出了回放流程却没有任何签到证据：启用后会顶替原有签到方式，每天回放
     *    几下与签到无关的点击（开始学习时已登录的登录即签到站点最常见）。
     *
     * 两处共用一个「已问过」标记：用户看过提示后再结束，按当时能保存的内容照常保存。
     */
    // 无论模板原来采用哪种方式，缺少业务动作证据时都必须如实提示。
    const alreadyPrompted = existing.endLearningPrompted === true;
    const choiceMessage = needsLoginAsCheckinChoice({
      intent,
      loginAsCheckinRequested,
      artifacts,
      loginAsCheckinPossible: canSaveLoginAsCheckin(existing.events, existingKind),
      alreadyPrompted,
    })
      ? LOGIN_AS_CHECKIN_CHOICE_MESSAGE
      : needsCheckinEvidenceChoice({
          intent,
          artifacts,
          checkinEvidence: analyzeLearningEvents(existing.events, existingKind).checkin,
          alreadyPrompted,
        })
        ? CHECKIN_EVIDENCE_CHOICE_MESSAGE
        : null;
    if (choiceMessage) {
      const prompted = await learningWrites.run(async () => {
        const current = await session.get<WorkflowLearningSession | null>(LEARN_KEY(sessionTabId), null);
        if (!current || current.runId !== sessionRunId) return false;
        await session.set(LEARN_KEY(sessionTabId), { ...current, endLearningPrompted: true });
        return true;
      });
      if (!prompted) return { ok: false, error: '学习会话已结束，请重新开始' };
      return { ok: false, error: choiceMessage };
    }
    /** 签到那一半最终以什么形态落盘；响应据此说不同的文案。 */
    let checkinSavedAs: 'workflow' | 'login-as-checkin' | undefined;
    const saved: LearnedArtifactKind[] = [];
    const failures: string[] = [];
    const notices = [...artifacts.notices];
    if (autoLoginAsCheckin) {
      /**
       * 措辞必须是**观测口径**，不能断言「本站没有签到按钮」：扫描只覆盖主文档里
       * 可见、未禁用、文案命中词表的控件，若按钮在 iframe/Shadow DOM/懒加载区域，
       * 这里同样扫不到。用「未观察到」既如实又不给用户错误承诺，并附上可执行的退路。
       */
      notices.push('本次演示未观察到可点的签到控件，已按「登录即签到」保存：之后自动登录成功即视为完成签到；若本站其实有签到按钮，可在站点设置里改回自动识别');
    }
    /**
     * 站点**自身**配置不完整的落盘阻塞（与这次演示录到了什么无关）。
     *
     * `appRepository.updateSite` 会把**整份站点配置**过一遍 `validateSiteConfig`
     * —— 那是真实站点配置的守门人，一个字都不能放宽。于是站点自己缺账号/密码/登录
     * 按钮选择器时，连「只写签到流程」也会被拒：抛出的「缺少用户名输入框选择器」
     * 描述的是站点旧配置，而不是这次演示的结果，用户完全无法据此知道下一步该做什么。
     *
     * 所以在**动手写之前**先算一次「这份补丁落地后站点还缺什么」：
     * - 缺 → 归到 `siteConfigBlockers`，由下面统一翻译成「学到的内容没能保存，
     *   因为站点自己的配置还不完整」，并保留会话让用户补完；
     * - 不缺却仍写不进去（写入异常 / 读回不一致）→ 那才是这次学习保存的真实失败，
     *   照旧进 `failures`。
     */
    const siteConfigBlockers: string[] = [];
    const blockedBySiteConfig = (candidate: SiteConfig): boolean => {
      const [first] = validateSiteConfig(candidate);
      if (first === undefined) return false;
      siteConfigBlockers.push(first);
      return true;
    };
    /**
     * 判定第二份产物时的站点基线：必须是**第一份产物落盘之后**读回来的样子。
     *
     * 站点校验器校验的是「补丁落地后的**整份**配置」，而登录补丁会补上
     * `loginMethod` + 字段选择器 —— 正是「站点还没配登录表单、必须靠学习补上」
     * 的种子配置所缺的那部分。拿产物一之前读到的旧快照去校验产物二，会把
     * 刚刚才写进去的字段当成不存在，于是「学完登录再写签到流程」会被自己拦下。
     */
    let effectiveSite: SiteConfig = site;
    /**
     * 「识别到但有意不学」的动作必须显式告诉用户（如滑块把手的拖拽由自动
     * 破解管线接管），否则用户会以为「我做了这一步，扩展一定学会了」。
     * 文案是采集侧产出的固定字符串，不含任何页面内容。
     */
    for (const note of (flushed.unlearnedNotes ?? []).slice(0, 4)) notices.push(note);

    // ── 产物一：站点级登录配置 ────────────────────────────────────────
    if (artifacts.login) {
      const learned = artifacts.login;
      /**
       * 保存是「用这次学到的替换旧的入口配置」：补丁会带上学到的字段并清掉与
       * 登录方式矛盾的旧入口（OAuth 学完不留表单入口，form 学完不留 OAuth 入口），
       * 避免新旧混合出一份自相矛盾、回放时点错控件的配置。
       */
      const loginPatch = planLearnedLoginPatch(learned, site);
      if (!blockedBySiteConfig({ ...site, ...loginPatch })) {
        try {
          /**
           * 先把同站「跟随站点」的其它账号固定到旧登录方式，再改站点默认值。
           *
           * 顺序不能反：站点先改、账号后改的空窗里若有签到任务启动，它会按新方式
           * 登录一个并不适用的账号。学习只改「怎么登」的站点默认，不该替别的账号改。
           */
          for (const pin of planSiblingLoginMethodPins(learned, site, accounts.filter((item) => item.siteId === site.id), account.id)) {
            await appRepository.updateAccount(pin.accountId, pin.patch);
          }
          await appRepository.updateSite(site.id, loginPatch);
          // 账号级覆盖优先于站点配置：不处理的话，用户刚学到的站点登录流程会被
          // 这个账号的旧 loginMethod 继续压住，看起来就是「学习登录没有生效」。
          const accountPatch = planLearnedLoginAccountPatch(learned, account);
          if (Object.keys(accountPatch).length > 0) {
            await appRepository.updateAccount(account.id, accountPatch);
          }
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
        // 写入接口返回成功不代表可回放的配置真的落到了站点上；按登录方式逐项核对。
        if (failures.length === 0) {
          const readBack = configuredSite(site.id, await local.get<SiteConfig[]>(KEYS.sites, []));
          const verified = verifyLearnedLoginStored(learned, readBack);
          if (!verified.ok) failures.push(verified.error);
          else {
            saved.push('login');
            if (readBack) effectiveSite = readBack;
          }
        }
      }
    }

    // ── 产物二：站点级签到流程 ────────────────────────────────────────
    if (artifacts.checkin?.kind === 'login-as-checkin' && failures.length === 0) {
      /**
       * 登录即签到：没有步骤可回放，落盘的是站点级 `checkin.method = 'none'`
       * —— 引擎里「登录成功后即算签到」的一等语义（见 checkin.ts 的 performCheckin）。
       * 不写 workflow：留着的旧流程会被这个方法停用，且界面按 method 显示实际执行方式。
       */
      // `none` 是完整的签到策略，不是旧签到配置上的一个覆盖字段。
      // 必须替换整个 checkin 对象，避免历史 entry/url/workflow 在引擎里继续
      // 被当成入口或学习路线执行。
      // route + identityPath 保留（运行时身份核对要用），steps 清空：
      // 登录即签到没有签到动作可回放。
      const checkinPatch: Partial<SiteConfig> = {
        checkin: {
          method: 'none',
          // 标明来自学习演示：内置合并与旧模板迁移据此保留它，不再换回模板签到流程。
          learnedLoginAsCheckin: true,
          learnedLoginAsCheckinSource: loginAsCheckinRequested ? 'explicit' : 'auto',
          ...(keptRouteForLoginAsCheckin
            ? {
                workflow: {
                  steps: [],
                  route: keptRouteForLoginAsCheckin.route,
                  ...(keptRouteForLoginAsCheckin.identityPath
                    ? { identityPath: keptRouteForLoginAsCheckin.identityPath }
                    : {}),
                },
              }
            : {}),
        },
      };
      if (!blockedBySiteConfig({ ...effectiveSite, ...checkinPatch })) {
        try {
          await appRepository.updateSite(site.id, checkinPatch);
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
        // 读回确认：写没写进去不能靠写入接口的返回值。
        if (failures.length === 0) {
          const readBack = configuredSite(site.id, await local.get<SiteConfig[]>(KEYS.sites, []));
          const verified = verifyLearnedLoginAsCheckinStored(readBack?.checkin);
          if (!verified.ok) failures.push(verified.error);
          // 读回必须仍是「学到的」登录即签到：标记丢了，下次加载就会被迁移换回模板流程。
          else if (!readBack || !isLearnedLoginAsCheckin(readBack)) {
            failures.push('学到的「登录即签到」写入后被站点默认配置覆盖，请重试');
          } else {
            saved.push('checkin');
            checkinSavedAs = 'login-as-checkin';
            effectiveSite = readBack;
          }
        }
      }
    } else if (artifacts.checkin?.kind === 'workflow' && failures.length === 0
      && usesSiteSpecificCheckin(site) && analyzeLearningEvents(existing.events, existingKind).checkin === 'none') {
      /**
       * 本站签到是专用复合流程（VSLLM 答题翻牌、一梦五千年抽奖）：录到的点击回放
       * 没有录到业务动作的片段不能替换它；真正录到签到/抽奖动作时必须保存并回放新流程。
       */
      notices.push('本次未录到签到或抽奖动作，保留原有专用流程；已录到的登录配置照常更新');
    } else if (artifacts.checkin?.kind === 'workflow' && failures.length === 0) {
      const learned = { workflow: artifacts.checkin.workflow };
      /**
       * 身份核验页由 `learnedIdentityPath` 顺带产出：只要学到了路线，它至少是签到终点页
       * 本身（站点把签到按钮放在资料页上时两者同址）。因此这个分支只剩一种成因 ——
       * 整场演示都停在登录/认证页，没有可执行的签到页面。
       */
      if (!learned.workflow.identityPath) {
        failures.push('这次演示里没有点到真正的签到按钮（当天已签到、按钮已变成「已签到」时也会这样）。'
          + '请在按钮可点时重新演示：先登录 → 进入能看到当前账号的页面 → 点击「立即签到」→ 再点「结束学习」；'
          + '已经签到的当天无法学习签到流程');
      } else {
        // 学过的东西必须先过校验再落盘：跨站路线、超长路线这类配置一旦写进站点，
        // 之后每次签到都会跑一遍坏数据，比当场报错难查得多。
        const errors = validateCheckinWorkflow(site, learned.workflow);
        if (errors.length > 0) {
          failures.push(`学到的流程未通过校验：${errors[0]}`);
        } else {
          // 学习路线完整接管入口；把旧地址和旧点击入口从持久化配置中一并移除。
          const {
            entry: _oldEntry, url: _oldUrl,
            learnedLoginAsCheckin: _oldLoginAsCheckin,
            learnedLoginAsCheckinSource: _oldLoginAsCheckinSource,
            ...checkinSettings
          } = site.checkin ?? {};
          const checkinPatch: Partial<SiteConfig> = {
            checkin: {
              ...checkinSettings,
              method: 'workflow',
              workflow: learned.workflow,
              // 重新学习就是重新启用回放；清掉用户上一次「切回自动识别」的停用标记。
              workflowReplayDisabled: false,
            },
          };
          if (!blockedBySiteConfig({ ...effectiveSite, ...checkinPatch })) {
            try {
              await appRepository.updateSite(site.id, checkinPatch);
            } catch (error) {
              failures.push(error instanceof Error ? error.message : String(error));
            }
            // 读回确认。写入接口返回成功不代表配置真的落到了站点上，
            // 没写进去却回报「已保存」，用户下次签到才发现流程不存在。
            //
            // 逐项核对 method / steps / route：只比 `steps.length` 会漏掉最致命的一种情况 ——
            // route 没落盘（或整个 workflow 被覆盖成只有 steps）时长度依然相等，扩展照样回
            // 「已保存」，而用户下次自动签到再也找不到签到页。
            if (failures.length === 0) {
              const readBack = configuredSite(site.id, await local.get<SiteConfig[]>(KEYS.sites, []));
              const verified = verifyLearnedWorkflowStored(learned.workflow, readBack?.checkin);
              if (!verified.ok) failures.push(verified.error);
              else {
                saved.push('checkin');
                checkinSavedAs = 'workflow';
                if (readBack) effectiveSite = readBack;
              }
            }
          }
        }
      }
    }

    /**
     * 两个产物一个都没保存下来时如实报错并**保留会话**（用户补完演示后可以再点结束）。
     * 只保存了一半时继续走成功分支：已学到的那半必须先落盘，缺的半边用 notices 讲清楚。
     *
     * 失败原因必须与「这次演示录到了什么」对应：
     * - 什么都没编译出来 → failures 必然为空（这段代码根本没去写站点），于是落到
     *   notices 里那句描述**本次演示观测结果**的话（空演示时就是「还没有录到任何
     *   登录或签到动作」），绝不拿站点校验器的内部措辞冒充学习失败的原因；
     * - 站点**既有**配置不完整挡住了落盘 → 说清是站点自己的配置问题，并翻译成
     *   用户能照着改的说法（站点校验器本身一个字都不放宽）；
     * - 其它保存失败 → 如实转述这次学习的失败原因。
     *
     * 三者的判定与文案集中在 learning-save-outcome.ts（纯函数、可单测）。
     */
    /**
     * 同一域名还有别的站点卡在用学到的流程：一起换成这次学到的这一份。
     *
     * 「一个站点一份流程、谁再学一次就整体覆盖」对重复导入的卡片同样成立；不同步的话，
     * 那几张卡会一直回放旧流程。只碰本来就在用学到流程的卡（见 shared-learned-flow.ts）；
     * 某张卡写入失败不影响本次学习的结论，只在提示里说明。
     */
    if (saved.includes('checkin')) {
      const latestSites = await local.get<SiteConfig[]>(KEYS.sites, []);
      const learnedCheckin = configuredSite(site.id, latestSites)?.checkin;
      if (learnedCheckin) {
        const removedBuiltin = await local.get<string[]>(KEYS.removedBuiltinSiteIds, []);
        let synced = 0;
        let unsynced = 0;
        for (const other of sameOriginConfiguredSites(site, latestSites, removedBuiltin)) {
          const next = learnedCheckinForSameOriginCard(other, learnedCheckin);
          if (!next) continue;
          try {
            await appRepository.updateSite(other.id, { checkin: next });
            synced += 1;
          } catch {
            unsynced += 1;
          }
        }
        if (synced > 0) notices.push(`同一域名的另外 ${synced} 张站点卡也已换成这次学到的签到流程`);
        if (unsynced > 0) notices.push(`同一域名还有 ${unsynced} 张站点卡没能同步（它们自己的配置不完整），仍在用旧流程`);
      }
    }

    const outcome = learningSaveOutcome({ saved, notices, failures, siteConfigBlockers });
    if (!outcome.ok) return { ok: false, error: outcome.error };
    const mergedNotices = outcome.notices;

    await finishLearningSession(existing);
    broadcast();
    const warnings = [
      ...mergedNotices,
      ...(challengeSeenDuringLearning ? [CHALLENGE_LEARNING_WARNING] : []),
    ];
    return {
      ok: true,
      feature: {
        learning: {
          active: false,
          eventCount: existing.events.length,
          tabId: existing.tabId,
          saved: true,
          // 与旧响应形状兼容：保存了签到流程就回报 'checkin'，否则回报 'login'。
          kind: saved.includes('checkin') ? 'checkin' : 'login',
          savedKinds: saved,
          /**
           * 本次学习**本来要录哪些产物**。
           *
           * 兼容字段 `kind` 是按「实际存下了什么」推出的，只存下登录时它也是
           * 'login'，与「用户本来就只点学习登录」无法区分 —— 界面据此会把手
           * 融合学习只学一半误报成完整成功。这个字段单独表达意图，界面才能
           * 如实提示「签到那半没录到」。
           */
          intent: intent === 'login' ? 'login' : 'both',
          ...(checkinSavedAs ? { checkinSavedAs } : {}),
          /**
           * 这次演示能不能按「登录即签到」保存。保存成功后会话已清空，这个字段
           * 只是让界面能如实回放「当时为什么给了那个按钮」；正常情况下为 false。
           */
          ...(canSaveLoginAsCheckin(existing.events, existingKind) ? { loginAsCheckinAvailable: true } : {}),
          ...(warnings.length ? { warnings } : {}),
          /**
           * 完整性自检（纯函数，只读事件、只产出固定文案）。
           *
           * 管理页优先渲染这份结构化的三行结论；没有它就只能把 warnings
           * 当成「需要留意」笼统显示。区分「录全了 / 能用但缺证据 / 还差内容」
           * 是用户决定「要不要现在就去自动签到」的唯一依据，所以在这里给出。
           */
          report: (() => {
            const full = buildLearningReport(existing!.events, existingKind, {
              loginAsCheckin: checkinSavedAs === 'login-as-checkin',
              /**
               * 「开始学习时已经登录」的演示录不到登录动作，但站点上可能早就有一份
               * 可用登录配置 —— 登录即签到靠它先登录。这里把站点现状一并交给报告，
               * 避免已经能跑的流程被判成「还差内容」。
               */
              hasStoredLoginConfig: siteHasStoredLoginConfig(effectiveSite, account.loginMethod),
              /**
               * 站点**当前**的签到方式。站点本来就是「登录即签到」时，演示里录不到
               * 签到动作是正常形态 —— 报告据此给出 ok 结论，而不是让用户去找一个
               * 页面上根本不存在的签到按钮。
               */
              siteCheckinMethod: effectiveSite.checkin?.method,
              saveFailed: failures.length > 0,
            });
            return { verdict: full.verdict, lines: full.lines };
          })(),
        },
      },
    };
  }

  const accounts = await local.get<Account[]>(KEYS.accounts, []);
  const account = accounts.find((item) => item.id === accountId);
  if (!account) return { ok: false, error: '账号不存在' };
  const userSites = await local.get<SiteConfig[]>(KEYS.sites, []);
  const site = configuredSite(account.siteId, userSites);
  if (!site) return { ok: false, error: '站点配置不存在' };
  const activeTask = await checkinQueue.active();
  if (activeTask?.accountId === accountId) return { ok: false, error: '该账号正在签到，请先停止任务' };

  // 学习起始页：优先站点已配置的签到页/家族兜底入口（通常已是业务页），
  // 没有配置时才回落到登录页。
  const startUrl = balanceRefreshUrl(site);
  let existingTabId = await findTabForSite(site);

  /*
   * 已经开着的站点标签页可以就地沿用 —— 但**只能在它已经在正确出口上时**。
   *
   * 它此刻挂的是哪条网络路径，只能靠全局代理设置判断（chrome.proxy 是浏览器级
   * 设置，标签页自己不说）。出口对不上时必须另开一页：把用户正看着的页面切到
   * 学习路线之外、或把它拖进另一条出口，都不是「开始学习」该做的事。
   */
  if (existingTabId != null) {
    const reusable = await resolveProxyForAccount(account, site);
    const canReuse = reusable.ok
      && appliedProxyMatchesAccount(reusable.proxy, await readAppliedProxyEndpoint());
    if (!canReuse) existingTabId = undefined;
  }

  /*
   * 学习期间必须走账号自己的代理（与回放同一条出口）。
   *
   * 真实缺陷：学习标签页此前完全没有设置浏览器全局代理，只有任务执行与余额刷新会调
   * resolveProxyForAccount。后果有两条，都真实存在：
   *  - 只能经代理访问的站点，学习页直连根本打不开 → 用户看到「学习功能无法实现」；
   *  - 学习走直连、回放走代理时，站点看到的出口发生变化，容易触发风控 ——
   *    表现为「演示时好好的，回放就挂」。
   *
   * 沿用与任务执行同一套 proxyLease，保证「学习用的出口 == 回放用的出口」。
   * 拿不到租约时如实拒绝，不静默直连：静默直连会让用户在错误的网络路径上演示一遍，
   * 产出一份注定跑不通的流程，比直接报错更难查。
   */
  const learningProxy = await resolveProxyForAccount(account, site);
  // 解析不出来时我们**还没有**建过任何标签页（tabId 下面才声明），所以这里
  // 只需要如实报错；已经开着的用户页面更不能动。
  if (!learningProxy.ok) return { ok: false, error: learningProxy.error };

  /**
   * 签到队列在跑（或还有排队账号）时不能再开学习 —— 两个方向都要挡。
   *
   * 已有实现的缺口：入队时会检查「有没有人在学习」，但**学习反过来不检查队列**。
   * 代理的账号之所以没出事，只是因为 acquire 抢不到租约、会如实报错；真正会静默
   * 出错的是**直连账号正在签到**的情况 —— 它没有持租约，学习页照样能把全局代理
   * 切到自己这条线路上，那个正在跑的直连任务当场改走代理：站点看到同一账号的请求
   * 一半从直连来、一半从代理来，中间还夹着一次 TLS 重连。
   *
   * 学习要演示的是「回放时会走的那条路」，它和任何正在跑的签到任务都不能并存。
   */
  if (await checkinQueue.busy()) {
    return { ok: false, error: '有签到任务正在执行或排队，请等它完成后再开始学习（学习与签到不能同时使用代理）' };
  }

  /*
   * 两条学习会话也不许抢出口。
   *
   * 同站互斥（decideLearningStart）只挡了同一个站点；跨站点仍有一个真实缺口：
   * 一条**直连**的学习会话不持有租约，于是另一条**带代理**的学习会话照样能
   * 拿到租约、把全局代理切到自己那条线路上 —— 前一个学习页当场改走别人的出口，
   * 演示出来的流程与之后它自己回放时走的线路对不上。带代理的这条必须先腾位置。
   */
  if (learningProxy.proxy) {
    const { active: otherSessions } = partitionLearningSessions(
      Object.entries(await chrome.storage.session.get(null)),
    );
    if (otherSessions.length > 0) {
      return { ok: false, error: '已有账号正在学习流程；学习会话之间不能互相打断，请先结束那一条' };
    }
  }
  let tabId = existingTabId;
  if (tabId == null) {
    /*
     * 先建 about:blank，等代理设置生效后再导航到 startUrl。
     *
     * 直接 tabs.create({ url: startUrl }) 时首个请求会抢在 applyProxy 之前发出：
     * 站点只能经代理访问时，用户看到的是 chrome-error://chromewebdata/（加载失败），
     * 而代理日志里一个请求都没有 —— 与任务执行路径踩过的是同一个坑。
     */
    const tab = await chrome.tabs.create({ url: 'about:blank', active: true }).catch(() => null);
    if (!tab || tab.id == null) return { ok: false, error: '无法打开学习标签页' };
    tabId = tab.id;
  }
  /** 本次是否为这个标签页真的拿到过租约。清理时只释放自己拿到的 —— 别动别人的。 */
  let learningLeaseHeld = false;
  if (learningProxy.proxy) {
    const gotLease = await proxyLease.acquire(tabId, learningProxy.proxy).catch(() => false);
    if (!gotLease) {
      if (existingTabId == null) await removeTabUnlessLast(tabId).catch(() => {});
      return { ok: false, error: '代理正被其他任务占用，请等它完成后再开始学习' };
    }
    learningLeaseHeld = true;
  }

  /**
   * 启动学习前的出口核对。
   *
   * 为什么租约不够：**直连账号根本不申请租约**。当另一个账号的签到任务（或
   * 测活、扫描）正持有全局代理时，直连账号的学习页会从**别人的出口**出站 ——
   * 它演示出来的流程可能只在那个出口上成立，之后直连回放就挂了；站点侧看到的
   * 则是同一账号一会儿这个 IP、一会儿那个 IP。学习与回放必须走同一条线路，
   * 这条是硬要求，所以直连账号也要核对「此刻没有人替它在走代理」。
   *
   * 有代理的账号同样核对一次：租约刚刚 apply 成功，这里比对回读端点，
   * 挡住「apply 与导航之间被别的扩展/任务抢走控制权」的窗口。
   * 拿不准一律拒绝并说清原因，绝不静默换出口继续。
   */
  const learningEgressProblem = egressMismatchReason(
    learningProxy.proxy,
    await readAppliedProxyEndpoint(),
  );
  if (learningEgressProblem) {
    await session.remove(LEARN_KEY(tabId)).catch(() => {});
    // 只释放本次自己拿到的租约：直连账号这条路上我们根本没申请过，
    // 乱调 release 可能把别人正在用的全局代理撤掉。
    if (learningLeaseHeld) await proxyLease.release(tabId).catch(() => {});
    if (existingTabId == null) await removeTabUnlessLast(tabId).catch(() => {});
    return { ok: false, error: learningEgressProblem };
  }

  /*
   * 代理（若配置）此刻已生效，现在才把**我们自己开的**学习页导航到起点。
   *
   * 沿用用户已有标签页时绝不导航：那是用户的页面，把他正看着的业务页拽回登录页
   * 既打断了他的操作，也会让学习从错误的页面开始。用户已经在站点上时，他当下的
   * 位置就是最好的演示起点。
   */
  if (existingTabId == null) {
    try {
      await navigateTaskTab(tabId, startUrl);
    } catch (error) {
      await session.remove(LEARN_KEY(tabId)).catch(() => {});
      await proxyLease.release(tabId).catch(() => {});
      await removeTabUnlessLast(tabId).catch(() => {});
      return { ok: false, error: `学习页面加载失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * 融合学习：`checkin`（旧调用方与旧 UI 的默认值）与 `both` 都按「一次演示同时
   * 产出登录配置与签到流程」录制；只有显式的 `login` 保持旧的单一语义。
   */
  const learning: WorkflowLearningSession = {
    runId: uid('learn'),
    accountId,
    siteId: site.id,
    kind: requestedKind ?? 'checkin',
    tabId,
    createdAt: Date.now(),
    events: [],
    personalTexts: learningPersonalTexts(account),
  };
  await session.set(LEARN_KEY(tabId), learning);
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  /**
   * 创建标签与 document_idle 注入有竞态。收到采集器就绪回执后才告诉 UI 已开始，
   * 否则用户立刻输入/点击时采集器尚未启动，最前面的动作会整段丢失。
   *
   * 注入范围是所有 frame，因此这里等**顶层**采集器就绪后，把同一份会话广播给
   * 学习站点自己的同源子框架（跨域 iframe 不通知）。某个子框架失败不算启动失败：
   * 只要主文档采集器在，录制就能开始；该子框架稍后重新加载时会经 GET_TASK
   * 的 frameId 分支自行领到会话。
   */
  const expectedOrigin = learningSiteOrigin(site);
  let ready = false;
  for (let attempt = 0; attempt < 50 && !ready; attempt += 1) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (isLearningSenderSameOrigin(tab.url, expectedOrigin)) {
        const response = await chrome.tabs.sendMessage(tabId, { type: 'LEARN_MODE', learning }, { frameId: 0 });
        ready = response?.ok === true;
      }
    } catch { /* 页面正在加载/跳转，等待顶层采集器。 */ }
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (ready) await broadcastLearningMode(tabId, learning, expectedOrigin);
  if (!ready) {
    await session.remove(LEARN_KEY(tabId));
    await stopLearningCapture(tabId);
    return { ok: false, error: '学习页面尚未准备好，未开始录制；请等待页面加载完成后重试' };
  }
  return { ok: true, feature: { learning: { active: true, eventCount: 0, tabId, kind: requestedKind ?? 'checkin' } } };
}

/**
 * 学习引导/停止消息的目标 frame。
 *
 * 打开 allFrames 之后每个同源 iframe 都跑着一份采集器，停止录制必须让**所有**
 * frame 一起停手，否则子框架里的监听器会继续把用户后续操作上报成旧会话的动作。
 *
 * 返回 undefined 时调用方不传 frameId 选项：`chrome.tabs.sendMessage` 不给
 * frameId 就是广播给 tab 内所有 frame。只在能枚举 frame 时逐帧去重，
 * `getAllFrames` 不可用/抛错时退回广播，保证功能不因枚举失败而丢消息。
 * 顶层 frameId 0 始终包含在内，主文档既有的采集器语义不变。
 */
async function learningFrameTargets(
  tabId: number,
  expectedOrigin: string | null,
): Promise<number[] | undefined> {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    if (!frames) return undefined;
    const ids = new Set<number>([0]);
    for (const frame of frames) {
      if (frame.frameId == null) continue;
      /**
       * expectedOrigin 为 null 表示「不做同源过滤」—— 停止录制走这条：
       * 给谁都发一条退出录制是无害的，却能保证任何还在录的子框架一定停手。
       * 有期望源时（引导进入录制）只通知学习站点自己的同源框架，
       * 跨域 OAuth/广告 iframe 收不到消息，不会开始采集。
       */
      if (expectedOrigin == null || isLearningSenderSameOrigin(frame.url, expectedOrigin)) {
        ids.add(frame.frameId);
      }
    }
    return [...ids];
  } catch {
    return undefined;
  }
}

/** 向 tab 内所有 frame 广播学习模式消息；返回是否至少有一个 frame 收到了。 */
async function broadcastLearningMode(
  tabId: number,
  learning: WorkflowLearningSession | null,
  expectedOrigin: string | null,
): Promise<boolean> {
  const targets = await learningFrameTargets(tabId, expectedOrigin);
  if (!targets) {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'LEARN_MODE', learning }).catch(() => undefined);
    return response?.ok === true;
  }
  let delivered = false;
  for (const frameId of targets) {
    const response = await chrome.tabs
      .sendMessage(tabId, { type: 'LEARN_MODE', learning }, { frameId })
      .catch(() => undefined);
    if (response?.ok === true) delivered = true;
  }
  return delivered;
}

/**
 * 结算学习录制末尾的动作。
 *
 * 打开 allFrames 之后每个同源 iframe 都有一份自己的采集器，末尾动作（用户
 * 最后一击/最后一段输入）可能发生在任何一个 frame 里；只 flush 主框架会丢掉
 * 子框架里最后那一步。
 *
 * 但 challengeSeen / checkinControlSeen 这两个布尔只由**主框架**统计并回传
 * （历史语义，不含字段名/值），所以顺序是：先向 frame 0 结算并取回它的响应，
 * 再把其余同源 frame 各自结算一遍。
 * 子框架没有采集器时 content 侧会回 ok:true，不算失败；子框架已销毁/正在导航
 * 也不影响主框架的结果 —— 只有主框架结算失败才让保存流程停下。
 */
async function flushLearningCapture(
  tabId: number,
  runId: string,
): Promise<{
  ok: boolean;
  error?: string;
  challengeSeen?: boolean;
  /**
   * content 侧对结束那一刻页面上有无可见签到控件的观测，**三态**：
   * true＝确认有可点签到控件；false＝确认扫过且没有；undefined＝未观测
   * （采集器不在、跨页新文档、消息失败）。
   *
   * 不可压成布尔：把「没扫到」当成「确认没有」，会让自动判定把「用户只是
   * 忘了点」误落成 method:none，永久废掉该站原有的签到入口与流程。
   */
  checkinControlSeen?: boolean;
  unlearnedNotes?: string[];
}> {
  const main = await chrome.tabs
    .sendMessage(tabId, { type: 'FLUSH_LEARNING', runId }, { frameId: 0 })
    .catch(() => ({ ok: false, error: '无法确认学习页面的末尾动作已保存，请保持学习标签页打开后重试' }));
  if (main?.ok !== true) {
    return { ok: false, error: main?.error ?? '无法确认学习页面的末尾动作已保存，请保持学习标签页打开后重试', checkinControlSeen: undefined };
  }
  // 各 frame 的「识别到但有意不学」提示（固定文案，绝不含页面内容）。
  const unlearnedNotes = new Set<string>(
    Array.isArray(main.unlearnedNotes) ? main.unlearnedNotes.filter((note: unknown): note is string => typeof note === 'string') : [],
  );

  const senders = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
  /**
   * 各 frame 的签到控件观测按「最保守者胜」聚合。
   *
   * 签到按钮可能在同源子框架里（content 开了 allFrames），而 `checkinControls()`
   * 只扫各自文档：主框架扫不到时不能据此断定「本站没有签到按钮」。聚合规则：
   *  - 任何 frame 报 true（看到了控件）→ 整体 true；
   *  - 否则任何 frame 报 undefined（未观测/没采集器/调用失败）→ 整体 undefined；
   *  - 全部 frame 都明确报 false → 才有资格说「确认没有」。
   *
   * 只有最后一种情况才允许触发「自动按登录即签到保存」，否则一个 iframe 里的
   * 签到按钮就会让站点被永久改成 method:none。
   */
  let frameObservation: boolean | undefined = typeof main.checkinControlSeen === 'boolean'
    ? main.checkinControlSeen
    : undefined;
  const mainOrigin = (() => {
    const url = senders?.find((frame) => frame.frameId === 0)?.url;
    if (!url) return null;
    try { return new URL(url).origin; } catch { return null; }
  })();
  if (senders) {
    for (const frame of senders) {
      if (frame.frameId == null || frame.frameId === 0) continue;
      const frameResult = await chrome.tabs
        .sendMessage(tabId, { type: 'FLUSH_LEARNING', runId }, { frameId: frame.frameId })
        .catch(() => undefined);
      if (Array.isArray(frameResult?.unlearnedNotes)) {
        for (const note of frameResult.unlearnedNotes) {
          if (typeof note === 'string') unlearnedNotes.add(note);
        }
      }
      /**
       * 明确回报「本 frame 没在录制」的，不参与「有没有签到控件」的判定。
       *
       * 跨域 iframe（广告、播放器、验证码）按设计拿不到学习会话，永远不会有
       * 采集器；学习开始后动态插入的同源 frame 同样如此。旧实现把它们回的空结论
       * 当成「未观测」，按「最保守者胜」把整体压回 undefined —— 任何带 iframe 的
       * 页面都无法自动判定「登录即签到」。它们本来就观测不到本页形态，忽略才如实。
       */
      if (frameResult?.inactive === true) continue;
      // 子框架没采集器/调用失败时报 undefined，与「确认没有」区分开。
      const seen = typeof frameResult?.checkinControlSeen === 'boolean' ? frameResult.checkinControlSeen : undefined;
      if (seen === true) frameObservation = true;
      else if (seen === undefined && frameObservation !== true) {
        /**
         * 只有**同源** frame 的「无响应」才按未观测处理：它本该有采集器，
         * 失败说明这次观测不可信。跨域 frame 观测不到本站控件，不构成证据。
         * 主框架地址拿不到时保持保守（按同源处理）。
         */
        const sameOrigin = mainOrigin == null || (() => {
          try { return new URL(frame.url).origin === mainOrigin; } catch { return true; }
        })();
        if (sameOrigin) frameObservation = undefined;
      }
    }
  }
  return {
    ok: true,
    challengeSeen: main.challengeSeen === true,
    // 三态聚合结果（见上方「最保守者胜」）：只有全部 frame 都确认没有才是 false。

    checkinControlSeen: frameObservation,
    unlearnedNotes: [...unlearnedNotes].slice(0, 8),
  };
}

/**
 * 让某个标签页立刻停止录制。
 *
 * 只清信箱不够：页面里的监听器还在跑，用户随手一点就会继续往已结束的会话里
 * 上报动作，下一次学习会看到一堆不属于它的点击。
 */
async function stopLearningCapture(tabId: number): Promise<void> {
  /**
   * 停止不需要同源过滤：给所有 frame 都发一条「退出录制」是无害的
   * （没在录的 frame 收到 learning:null 只会把空采集器置空），却能保证
   * 任何正在录的子框架一定停手。expectedOrigin 传 null 表示不做过滤。
   */
  await broadcastLearningMode(tabId, null, null);
}

/** 先停止页面采集，再串行清理会话，防止在途事件写回并复活已结束的录制。 */
async function finishLearningSession(learning: WorkflowLearningSession): Promise<void> {
  await stopLearningCapture(learning.tabId);
  await learningWrites.run(async () => {
    const current = await session.get<WorkflowLearningSession | null>(LEARN_KEY(learning.tabId), null);
    if (current?.runId === learning.runId) await session.remove(LEARN_KEY(learning.tabId));
  });
  /*
   * 释放学习期间占用的全局代理租约。
   *
   * 学习现在也会 acquire 账号代理（否则只能经代理访问的站点根本打不开学习页）。
   * 不在这里释放，全局代理会被学习标签页一直占住：后续账号的签到任务拿不到租约，
   * 报「代理正被其他任务占用」，而用户其实早已结束学习 —— 典型的幽灵占用。
   *
   * 三条结束路径（正常保存 / 用户取消 / 会话过期）都会走到这里，所以只在这一处释放。
   */
  await proxyLease.release(learning.tabId).catch(() => {});
}

/** 全部在录会话，供管理页轮询显示进度。 */
async function listLearningSessions(): Promise<MessageResponse> {
  const { active, expired } = partitionLearningSessions(
    Object.entries(await chrome.storage.session.get(null)),
  );
  // 过期会话不再出现在列表里，并顺手清掉：管理页一直显示「正在学习」会让用户以为卡住了。
  for (const learning of expired) await dropExpiredLearning(learning);
  return {
    ok: true,
    feature: {
      learningSessions: active.map((learning) => ({
        accountId: learning.accountId,
        tabId: learning.tabId,
        eventCount: learning.events.length,
        kind: learning.kind ?? 'checkin',
        active: true as const,
        /**
         * 当前进度引导（与页面上的一体化浮层同一份纯函数判定）：管理页据此画
         * 步骤条与「现在该做什么」，而不是只显示一句「正在学习」。
         */
        guide: guideViewOf(analyzeLearningEvents(learning.events, learning.kind ?? 'checkin')),
        ...(canSaveLoginAsCheckin(learning.events, learning.kind ?? 'checkin')
          ? { loginAsCheckinAvailable: true }
          : {}),
        /**
         * 已录内容的可读摘要：管理页靠它显示「正在学习什么」。
         *
         * 预览在 recordLearningEvent 里随每条事件生成并落进会话；此前列表接口
         * 没把它带出去，账号行上的预览区因此永远为空 —— 融合学习要跨两段演示，
         * 用户更需要中途看到「已经学到哪一步」。
         */
        ...(learning.preview ? { preview: learning.preview } : {}),
      })),
    },
  };
}

/** 放弃录制：清会话、停页面录制，不动站点配置。 */
async function cancelLearning(accountId: string): Promise<MessageResponse> {
  const existing = await findLearningSession(accountId);
  if (!existing) return { ok: false, error: '该账号当前没有在进行的签到学习' };
  await finishLearningSession(existing);
  broadcast();
  return { ok: true, feature: { learning: { active: false, eventCount: 0, tabId: existing.tabId } } };
}

async function recordLearningEvent(
  event: WorkflowLearningEvent,
  sender: chrome.runtime.MessageSender,
  runId: string,
): Promise<MessageResponse> {
  const tabId = sender.tab?.id;
  /**
   * 主框架与**同源 iframe** 的学习事件都接受：iframe 里的操作现在是合法采集来源。
   *
   * 这里刻意**不再**用 `sender.frameId !== 0` 拒绝子框架 —— 那是打开 allFrames
   * 之前的历史约束。放宽的只有 frameId 这一条：紧接着的同源闸门仍按消息的真实
   * URL origin 校验，跨域 iframe（典型是嵌进来的 OAuth/广告框架）照旧被拒，
   * 它们的动作不会进学习记录。
   */
  if (tabId == null) return { ok: false, error: '学习事件缺少顶层标签页' };
  const learning = await session.get<WorkflowLearningSession | null>(LEARN_KEY(tabId), null);
  if (!learning || learning.runId !== runId) return { ok: false, error: '学习会话已结束' };
  /**
   * 同源闸门：学习标签页跳到 OAuth 供应商（github.com 等）时，那边的采集脚本
   * 同样会往这条会话上报。事件落盘后只剩相对 path，无法再与原站区分 ——
   * 必须先按消息的真实来源拒绝外域事件，否则 GitHub 登录框的选择器会被学成
   * 本站的账号/密码选择器或前置入口。
   */
  if (!await isLearningEventSenderAllowed(learning, sender)) {
    return { ok: false, error: '学习事件来自本站之外的页面，已忽略' };
  }
  const safe = sanitizeLearningEvent(event);
  if (!safe) return { ok: false, error: '学习事件格式无效' };
  // 过期会话不再累积事件：否则用户忘了点结束，几小时后还在往一次早已放弃的录制里写。
  const appended = appendLearningEvent(learning, safe);
  if (!appended.ok) {
    if (appended.expired) await dropExpiredLearning(learning);
    return { ok: false, error: appended.error };
  }
  // 同步生成可读预览：用户在管理页上看到的「扩展到底学会了什么」。
  // 只读展示用，不影响回放；失败不阻塞事件落盘。
  let preview: ReturnType<typeof buildLearningPreview> | undefined;
  try {
    preview = buildLearningPreview(appended.learning.events);
  } catch {
    // 预览生成失败不影响录制本身
  }
  const withPreview = preview ? { ...appended.learning, preview } : appended.learning;
  await session.set(LEARN_KEY(tabId), withPreview);
  return {
    ok: true,
    feature: { learning: { active: true, eventCount: appended.learning.events.length, tabId, ...(preview ? { preview } : {}) } },
  };
}

async function handle(
  msg: Message,
  sender: chrome.runtime.MessageSender,
): Promise<MessageResponse> {
  await backgroundReady;

  switch (msg.type) {
    case 'TOGGLE_LEARNING': {
      if (!isExtensionSender(sender)) return { ok: false, error: '仅扩展管理页可以操作学习流程' };
      return networkLocked(async () => {
        try {
          return await toggleLearning(msg.accountId, msg.kind, { loginAsCheckin: msg.loginAsCheckin === true });
        } finally {
          // FLUSH 先暂停采集以封口快照；若提示补演或保存失败，仍保留的会话必须恢复。
          const active = await findLearningSession(msg.accountId);
          if (active) await broadcastLearningMode(active.tabId, active, await learningExpectedOrigin(active));
        }
      });
    }

    case 'LEARN_EVENT':
      return learningWrites.run(() => recordLearningEvent(msg.event, sender, msg.runId));

    case 'GET_LEARNING': {
      if (!isExtensionSender(sender)) return { ok: false, error: '仅扩展管理页可以查看学习状态' };
      return listLearningSessions();
    }

    case 'CANCEL_LEARNING': {
      if (!isExtensionSender(sender)) return { ok: false, error: '仅扩展管理页可以取消学习' };
      return networkLocked(() => cancelLearning(msg.accountId));
    }

    case 'START_LOGIN':
      return enqueueAccounts([msg.accountId]);

    case 'START_BATCH':
      return enqueueAccounts(msg.accountIds);

    case 'CANCEL_CHECKIN': {
      if (!isExtensionSender(sender)) return { ok: false, error: '仅扩展管理页可以停止签到' };
      return networkLocked(async () => terminalLocked(async () => {
        const stopped = await cancelCheckins(msg.accountIds);
        broadcast();
        return { ok: true, feature: { stopped } };
      }));
    }

    case 'SET_LAUNCH_MODE': {
      await launchModeController.submit(msg.mode, msg.requestId);
      return { ok: true };
    }

    case 'MUTATE_APP': {
      if (!isExtensionSender(sender)) return { ok: false, error: '仅扩展管理页可以修改数据' };
      const response = await mutateApp(msg.mutation);
      broadcast();
      return response;
    }

    case 'GET_TASK': {
      const tabId = sender.tab?.id;
      if (tabId == null) return { ok: true, task: null };
      /**
       * 子框架只允许领取学习会话，**绝不允许领取任何任务**。
       *
       * 任务执行是主文档的专属职责：一旦 task 落到 iframe，主文档和每个 iframe
       * 会并发跑同一份流程，重复填表、重复点击、重复提交签到 POST。
       *
       * 学习会话必须整份返回：子框架的采集器要用 runId 建立自己的 recorder，
       * 才认得出之后 FLUSH_LEARNING 里的 runId；只给 siteId/kind 会让子框架
       * 永远匹配不上、结算时报「没有对应的采集器」。
       */
      if (!isTopFrameSender(sender.frameId)) {
        const learning = await session.get<WorkflowLearningSession | null>(LEARN_KEY(tabId), null);
        if (learning && await isLearningEventSenderAllowed(learning, sender)) {
          return { ok: true, task: null, feature: { learningSession: learning } };
        }
        return { ok: true, task: null };
      }
      const task = await taskState.get(tabId);
      if (!task?.runId) {
        const learning = await session.get<WorkflowLearningSession | null>(LEARN_KEY(tabId), null);
        if (learning && await isLearningEventSenderAllowed(learning, sender)) {
          return { ok: true, task: null, feature: { learningSession: learning } };
        }
        // 学习标签页跳到了外域（典型是 OAuth 供应商）：不把录制会话交给它，
        // 页面侧也就不进入录制模式；即使它自行上报，recordLearningEvent 也会拒绝。
        // 站点可能在**新标签页**打开第三方授权（Agent Router 就是这样）。
        // 新标签页没有自己的信箱，按 tabId 查必然为空，于是 GitHub 登录页
        // 拿不到任务、不填账密，流程停在那里直到看门狗超时。
        // 这里不新增填表逻辑，只把当前活动任务的 GitHub 凭据副本交给它 ——
        // 与同标签页跳转走的是同一条受限路径。
        const githubTask = await githubCredentialTaskFor(
          tabId,
          sender.url ?? sender.tab?.url,
          sender.tab?.openerTabId,
        );
        return { ok: true, task: githubTask };
      }
      if (!isTaskUrlAllowed(task, sender.url ?? sender.tab?.url)) {
        const currentUrl = sender.url ?? sender.tab?.url ?? '';
        // GitHub 账密模式只把最小凭据副本交给认证页：绝不带站点密码、token、
        // 会话或原站点配置。其他外域仍一律不派发任务。
        const githubTask = githubCredentialTask(task, currentUrl);
        if (githubTask) return { ok: true, task: githubTask };
        if (task.stage === 'verify-oauth' && !isGithubOAuthAuthorizeUrl(currentUrl)) {
          const updated = await taskState.markAttention(
            tabId,
            task.runId,
            'OAuth 等待你在授权页面完成操作',
            task.steps ?? [],
          );
          if (updated) broadcast();
        }
        return { ok: true, task: null };
      }
      // attention -> running 是两步操作：之间任务可能刚好完成，无条件
      // 写入会把 done 覆盖回 running。CAS 到存储锁内裁决，见 taskState。
      if (await taskState.resumeAttention(tabId, task.runId)) broadcast();
      return { ok: true, task };
    }

    case 'SET_STAGE': {
      const tabId = sender.tab?.id;
      if (tabId == null) return { ok: false, error: '缺少任务标签页' };
      const task = await taskState.updateStage(tabId, msg.runId, msg.stage, msg.steps);
      if (task) {
        broadcast();
        return { ok: true };
      }
      return { ok: false, error: '任务已结束' };
    }

    case 'GITHUB_LOGOUT_COMPLETE': {
      const tabId = sender.tab?.id;
      const senderUrl = sender.url ?? sender.tab?.url;
      if (tabId == null || (!isGithubLogoutUrl(senderUrl) && !isGithubLoggedOutUrl(senderUrl))) {
        return { ok: false, error: '仅 GitHub 官方退出流程可以完成账号切换' };
      }
      const task = await taskState.get(tabId);
      if (
        !task
        || task.runId !== msg.runId
        || task.stage !== 'github-logout'
        || task.effectiveLoginMethod !== 'github'
        || !task.githubUsername
        || !task.githubPassword
      ) {
        return { ok: false, error: '任务已结束或不允许切换 GitHub 账号' };
      }

      const steps = [...msg.steps, '当前 GitHub 会话已退出，返回站点并登录目标账号'];
      await taskState.setGithubCredentialsSubmitted(tabId, task.runId, false);
      const updated = await taskState.updateStage(tabId, task.runId, 'login', steps);
      if (!updated) return { ok: false, error: '任务已结束' };
      broadcast();
      await chrome.tabs.update(tabId, { url: task.site.loginUrl });
      return { ok: true };
    }

    case 'CONFIRM_IDENTITY': {
      const tabId = sender.tab?.id;
      if (tabId == null) return { ok: false, error: '缺少任务标签页' };
      const task = await taskState.confirmIdentity(tabId, msg.runId);
      return task ? { ok: true } : { ok: false, error: '任务已结束' };
    }

    case 'SAVE_IDENTITY': {
      // 来自 content script：登录后读到身份，回填账号供下次核对一致性。
      // 用 sender.tab.id 定位任务，页面无法伪造它，比信 payload 里的 id 安全。
      return networkLocked(async () => {
        const tabId = sender.tab?.id;
        if (tabId == null) return { ok: false, error: '缺少任务标签页' };
        // task 的读取必须与落库共用同一把锁。否则可能先读到旧任务，
        // 等账号已恢复到新站点后，又把旧站身份写回新归属。
        const task = await taskState.get(tabId);
        if (!task || task.runId !== msg.runId) return { ok: false, error: '任务已结束' };
        if (!(await taskStillTargetsCurrentSite(task))) {
          return { ok: false, error: '账号归属已变更，已拒绝写入旧站身份' };
        }
        /**
         * 「受管 GitHub 亲自登录后读到」的标记不信页面一面之词：只有本任务确实是受管
         * GitHub、且本轮在 github.com 上提交过保存的凭据（后台自己记的状态）才保留它。
         */
        const managedLoginProven = task.effectiveLoginMethod === 'github'
          && task.githubCredentialsSubmitted === true
          && !!task.githubUsername?.trim()
          && !!task.githubPassword;
        const { verifiedByManagedLogin, ...identityFields } = msg.identity;
        const identity = verifiedByManagedLogin === true && managedLoginProven
          ? { ...identityFields, verifiedByManagedLogin: true }
          : identityFields;
        await appRepository.saveAccountIdentity(task.accountId, identity);
        await taskState.updateIdentity(tabId, msg.runId, identity);
        return { ok: true };
      });
    }

    case 'NEEDS_USER': {
      const tabId = sender.tab?.id;
      if (tabId == null) return { ok: false, error: '缺少任务标签页' };
      // 新标签页里的 GitHub 认证页（window.open 打开的授权流程）没有自己的
      // 信箱。若不回退到活动任务，二次验证的求助会被丢掉 —— 用户收不到通知，
      // 任务静静卡到看门狗超时。凭据白名单同样适用于这条回退。
      const attentionTabId = (await taskState.get(tabId))?.runId
        ? tabId
        : (isGithubAuthUrl(sender.url ?? sender.tab?.url)
            ? (await checkinQueue.active())?.tabId ?? tabId
            : tabId);
      // 受管点击后若仍回到 GitHub 登录表单并需要人工处理，说明这次保存的
      // 凭据没有直接建立会话。撤销提交证据，避免用户随后手工登录其它账号时
      // 被 OAuth 返回页误当成这组保存凭据的结果。
      if (isGithubLoginUrl(sender.url ?? sender.tab?.url)) {
        await taskState.setGithubCredentialsSubmitted(attentionTabId, msg.runId, false);
      }
      const task = await taskState.markAttention(attentionTabId, msg.runId, msg.message, msg.steps);
      if (task) {
        /**
         * 立刻把这个账号移出队列 active：它已经进入「需处理」，不会再自己往下跑。
         *
         * 不释放的后果有两个，都是用户报过的：队列一直占着，后面站点的账号根本
         * 排不上；同时看门狗的 10 分钟超时到点后会把这个用户正要看的页面关掉。
         * 交给用户处理的页面必须留着 —— 关页只允许发生在成功收尾那条路。
         */
        // 代理租约必须一起放：这条路径不走 finalizeTab，而队列一放行，下一个
        // 账号就会去 acquire；租约还挂在等用户处理的页上时，它只会拿到
        // 「代理正被其他签到任务占用」。
        await releaseTaskProxy(attentionTabId).catch(() => {});
        await checkinQueue.finish(attentionTabId);
        broadcast();
        return { ok: true };
      }
      return { ok: false, error: '任务已结束' };
    }

    case 'TASK_RESULT': {
      const tabId = sender.tab?.id;
      if (tabId == null) return { ok: false, error: '缺少任务标签页' };
      const activeTask = await taskState.get(tabId);
      const missingMultiAccountIdentity = msg.result.ok
        && (activeTask?.siteAccountCount ?? 0) > 1
        && !activeTask?.identityConfirmed;
      const result: TaskResult = missingMultiAccountIdentity
        ? {
            accountId: activeTask?.accountId ?? msg.result.accountId,
            ok: false,
            message: '本轮未确认当前页面属于该账号，已拒绝记录签到成功和增加量',
            steps: [
              ...(msg.result.steps ?? []),
              '最终身份闸门未通过：多账号站点必须先确认页面账号，结果已改记为失败',
            ],
          }
        : msg.result;
      const completed = await finalizeTab({
        tabId,
        runId: msg.runId,
        accountId: result.accountId,
        result,
        requireActive: true,
      });
      // 先让 finalizeTab 落终态、释放代理、推进队列，并让本条消息能返回给
      // content script；直接在消息响应前关页会销毁发送方，极快完成的任务
      // 可能拿不到最后回执。失败/需人工页面仍保留。
      if (completed && result.ok) {
        // 先补余额再排关页：关页会把 content script 一起销毁，而补写用的是
        // 结果里已经带回来的快照，不依赖页面还开着，顺序上其实无所谓 ——
        // 但要保证它是「签到成功后」这条确定路径的一部分。
        await backfillBalanceAfterCheckin(result.accountId, result.metrics);
        scheduleTaskTabClose(tabId, activeTask?.siteId, result.accountId);
      }
      // 失败/需人工收尾不调度站点级关页，但本站此前为「还没跑完」保留的页
      // 不能永远留着 —— 本站已经没有成功收尾的机会了，统一回收一次。
      if (completed && !result.ok) await releaseKeptSiteTabs(activeTask?.siteId);
      return completed ? { ok: true } : { ok: false, error: '任务已结束' };
    }

    case 'TEST_PROXY': {
      if (!isExtensionSender(sender)) return { ok: false, error: '仅扩展管理页可以测试代理' };
      if (isNameOnlyProxy(msg.proxy)) {
        return { ok: true, test: { ok: false, ms: 0, message: '这是订阅节点名称，没有可用的浏览器代理出口' } };
      }
      return networkLocked(async () => {
        // 学习会话/扫描同样持有全局代理租约，不能被测活顶掉（见 globalNetworkOccupied）。
        const occupied = await globalNetworkOccupied('test');
        if (occupied) return { ok: false, error: occupied };
        // 落盘标记：队列启动不走 networkLocked，只能靠这个看见我们。
        const releaseToolLock = await acquireNetworkToolLock('test');
        try {
          const test = await testProxy(msg.proxy);
          return { ok: true, test };
        } finally {
          await releaseToolLock();
        }
      });
    }

    case 'PROBE_SITE': {
      // 只有管理页能触发：探测会往用户填的任意地址发请求，
      // 不能让页面脚本借扩展的 host permission 当跳板。
      if (!isExtensionSender(sender)) return { ok: false, error: '仅扩展管理页可以探测站点' };
      const probe = await probeSite(msg.url);
      return { ok: true, feature: { probe } };
    }

    case 'SCAN_LOCAL_PORTS': {
      if (!isExtensionSender(sender)) return { ok: false, error: '仅扩展管理页可以扫描本机端口' };
      return scanLocalPorts(msg.host, msg.ports, msg.scheme, msg.withExit === true, msg.controller);
    }

    case 'READ_CLASH_PROXIES': {
      if (!isExtensionSender(sender)) return { ok: false, error: '仅扩展管理页可以读取 Clash 节点' };
      return readClashProxyNames(msg.controller);
    }

    case 'DETECT_CLASH_CONTROLLER': {
      if (!isExtensionSender(sender)) return { ok: false, error: '仅扩展管理页可以读取内核信息' };
      return detectClashController(msg.controller);
    }

    case 'READ_CLASH_LISTENER_EXITS': {
      if (!isExtensionSender(sender)) return { ok: false, error: '仅扩展管理页可以读取内核信息' };
      return readClashListenerExits(msg.controller);
    }

    case 'SYNC_CLASH_PROXIES': {
      if (!isExtensionSender(sender)) return { ok: false, error: '仅扩展管理页可以同步 Clash 配置' };
      const clashConfigSync = await appRepository.syncClashProxies(msg.inputs);
      return { ok: true, feature: { clashConfigSync } };
    }

    case 'FETCH_SUBSCRIPTION': {
      // 同 PROBE_SITE：URL 来自用户输入，不能让页面脚本借扩展的
      // host permission 往任意地址发请求。
      if (!isExtensionSender(sender)) return { ok: false, error: '仅扩展管理页可以拉取订阅' };
      return fetchSubscription(msg.url);
    }

    case 'CHECK_LISTENER_DRIFT': {
      if (!isExtensionSender(sender)) return { ok: false, error: '仅扩展管理页可以检查订阅更新' };
      return checkListenerDrift();
    }

    case 'CAPTURE_SESSION': {
      if (!isExtensionSender(sender)) return { ok: false, error: '仅扩展管理页可以抓取登录态' };
      // 抓取过程会先读账号/站点、再注入页面、最后写会话；与归属变更
      // 串行，避免将旧站标签页抓到的会话保存给已换站的账号。
      return networkLocked(() => captureSessionForAccount(msg.accountId, msg.tabId));
    }

    case 'SESSION_REFRESHED': {
      // 来自 content script：签到途中换到了新令牌，写回账号供下次用。
      // 用 sender.tab.id 定位任务 —— 页面无法伪造它，比信 payload 里的 id 安全。
      return networkLocked(async () => {
        const tabId = sender.tab?.id;
        if (tabId == null) return { ok: false, error: '缺少标签页信息' };
        const task = await taskState.get(tabId);
        if (!task || task.runId !== msg.runId || task.accountId !== msg.accountId) {
          return { ok: false, error: '任务已结束' };
        }
        if (!(await taskStillTargetsCurrentSite(task))) {
          return { ok: false, error: '账号归属已变更，已拒绝写入旧站会话' };
        }
        await appRepository.saveAccountSession(msg.accountId, {
          accessToken: msg.accessToken,
          refreshToken: msg.refreshToken,
          tokenExpiresAt: msg.tokenExpiresAt,
          capturedAt: Date.now(),
          ...(task.site.adapter?.siteType ? { siteType: task.site.adapter.siteType } : {}),
        });
        return { ok: true };
      });
    }

    case 'CLEAR_SITE_COOKIES': {
      const tabId = sender.tab?.id;
      const senderUrl = sender.url ?? sender.tab?.url;
      if (tabId == null || sender.frameId !== 0) {
        return { ok: false, error: '缺少顶层任务标签页' };
      }
      const task = await taskState.get(tabId);
      if (!task || task.runId !== msg.runId) return { ok: false, error: '任务已结束' };
      if (!isTaskUrlAllowed(task, senderUrl)) {
        return { ok: false, error: '当前页面不属于该签到任务' };
      }

      // 目标地址只取后台任务信箱，页面消息不能传入或替换域名。
      const siteCookieClear = await clearSiteCookiesForTab(tabId, task.site.loginUrl);
      return { ok: true, feature: { siteCookieClear } };
    }

    case 'BALANCE_SNAPSHOT': {
      return networkLocked(async () => {
        const tabId = sender.tab?.id;
        if (tabId == null) return { ok: false, error: '缺少任务标签页' };
        const task = await taskState.get(tabId);
        if (!task || task.runId !== msg.runId) return { ok: false, error: '任务已结束' };
        if (msg.phase === 'button-before') {
          const senderUrl = sender.url ?? sender.tab?.url;
          if (sender.frameId !== 0 || !isTaskUrlAllowed(task, senderUrl)) {
            return { ok: false, error: '当前页面不属于顶层签到任务' };
          }
          const method = task.effectiveCheckinMethod ?? task.site.checkin?.method;
          if (task.stage !== 'checkin' || method !== 'button') {
            return { ok: false, error: '当前任务不是有效的按钮签到阶段，已拒绝写入点击基线' };
          }
        }
        if (!(await taskStillTargetsCurrentSite(task))) {
          return { ok: false, error: '账号归属已变更，已拒绝写入旧站余额' };
        }
        // Normal tabs on the same domain share cookies. On a multi-account site,
        // a snapshot observed before this run verifies its page identity may
        // belong to another configured account, even though tabId/runId are valid.
        if ((task.siteAccountCount ?? 0) > 1 && !task.identityConfirmed) {
          return { ok: false, error: '账号身份尚未确认，已拒绝写入余额快照' };
        }
        if (msg.phase === 'relogin-before') {
          if ((task.effectiveCheckinMethod ?? task.site.checkin?.method) !== 'relogin') {
            return { ok: false, error: '当前任务不是退出重登流程，已拒绝写入重登基线' };
          }
          const updated = await taskState.saveReloginBalanceBefore(
            tabId,
            task.runId,
            msg.snapshot,
          );
          if (!updated) return { ok: false, error: '任务已结束' };
        }
        if (msg.phase === 'button-before') {
          const updated = await taskState.saveButtonBalanceBefore(
            tabId,
            task.runId,
            msg.snapshot,
          );
          if (!updated) {
            return { ok: false, error: '按钮签到阶段或账号身份已变化，点击基线未写入' };
          }
        }
        // 账号 ID 取自信箱而不是 payload：页面脚本伪造不了 sender.tab.id，
        // 与 SESSION_REFRESHED 同一套口径，避免被诱导写到别的账号头上。
        await appRepository.saveBalance(task.accountId, {
          quota: msg.snapshot.quota,
          usedQuota: msg.snapshot.usedQuota,
          ...(msg.snapshot.symbol ? { symbol: msg.snapshot.symbol } : {}),
          at: msg.snapshot.at,
          source: balanceSource(msg.snapshot.fromVisibleText),
        });
        broadcast();
        return { ok: true };
      });
    }

    case 'REFRESH_BALANCE': {
      if (!isExtensionSender(sender)) return { ok: false, error: '仅扩展管理页可以刷新余额' };
      return refreshBalances(msg.accountIds);
    }

    case 'CHECKIN_REWARD_OBSERVATION': {
      /**
       * 签到成功后落盘今日奖励台账。
       *
       * 账号 ID 只从**信箱**取（`sender.tab.id` → 该标签页正在跑的任务），页面脚本
       * 伪造不了 sender，也就不能把奖励写到别的账号头上 —— 与 BALANCE_SNAPSHOT 同一套口径。
       */
      const tabId = sender.tab?.id;
      if (tabId == null) return { ok: false, error: '缺少标签页信息' };
      const task = await taskState.get(tabId);
      if (!task || task.runId !== msg.runId) return { ok: false, error: '任务已结束' };
      const account = (await local.get<Account[]>(KEYS.accounts, []))
        .find((item) => item.id === task.accountId);
      if (!account) return { ok: false, error: '账号不存在' };
      const site = configuredSite(account.siteId, await local.get<SiteConfig[]>(KEYS.sites, []));
      if (!site) return { ok: false, error: '站点配置不存在' };
      const reward = readVisibleCheckinRewardObservation(msg.bodyText, checkinRewardQuotaPerUnit(site));
      if (!reward) return { ok: true };
      await appRepository.saveCheckinReward(account.id, reward.reward, todayKey(), Date.now(), reward.symbol);
      broadcast();
      return { ok: true };
    }

    case 'GET_LIVE_TASKS': {
      // 只有管理页能查：保持与其他查询类消息一致的来源校验。
      if (!isExtensionSender(sender)) return { ok: false, error: '仅扩展管理页可以查询实时状态' };
      const [all, queueState] = await Promise.all([
        chrome.storage.session.get(null),
        session.get<QueueState>(QUEUE_KEY, { pendingAccountIds: [] }),
      ]);
      return {
        ok: true,
        feature: {
          live: collectLiveTasks(all),
          queue: {
            active: queueState.active,
            pending: queueState.pendingAccountIds,
          },
        },
      };
    }

    case 'SYNC_PROGRESS': {
      const tabId = sender.tab?.id;
      if (tabId == null) return { ok: false, error: '缺少任务标签页' };
      const task = await taskState.updateProgress(tabId, msg.runId, msg.steps);
      if (!task) return { ok: false, error: '任务已结束' };
      broadcast();
      return { ok: true };
    }

    case 'TRUSTED_POINTER_CLICK': {
      const tabId = sender.tab?.id;
      if (tabId == null) return { ok: false, error: '缺少任务标签页' };
      if (sender.frameId !== 0) {
        const frameTarget = await authorizedSliderFrameTarget(sender, msg.runId, msg.frameSessionId);
        if ((msg.anchor && msg.anchor.kind !== 'center') || !/^p-[a-z0-9-]{8,80}$/i.test(msg.targetToken)) {
          return { ok: false, error: '验证码内嵌页只允许点击本轮标记的控件中心' };
        }
        const live = await readFramePointerTarget(tabId, frameTarget, msg.targetToken, { kind: 'center' });
        if (!live) return { ok: false, error: '验证码控件已重绘或被遮挡，未执行点击' };
        const embedding = await readFrameEmbedding(tabId, frameTarget);
        const pointer = await trustedPointerClick(tabId, {
          x: live.x,
          y: live.y,
          viewportWidth: embedding.viewportWidth,
          viewportHeight: embedding.viewportHeight,
          targetToken: msg.targetToken,
          anchor: { kind: 'center' },
          deadline: msg.deadline,
          frameTarget,
        });
        return { ok: true, feature: { pointer } };
      }
      const senderUrl = sender.url ?? sender.tab?.url;
      // 站点用 window.open 打开 GitHub 授权页时，新标签页没有自己的信箱。
      // 与 GET_TASK 同理回退到活动任务，否则「填好账密后点 Sign in」会被
      // 判成「任务已结束」—— 表现为账密已填、按钮却永远没被点。
      // 指针仍然派发到发起点击的那个标签页（tabId），不会打到原站点页上。
      const task = await taskState.get(tabId)
        ?? (isGithubAuthUrl(senderUrl)
          ? await activeTaskForGithubPointer(tabId, sender.tab?.openerTabId)
          : null);
      if (!task || task.runId !== msg.runId) return { ok: false, error: '任务已结束' };
      const githubPointerAllowed = task.effectiveLoginMethod === 'github'
        && isGithubCredentialStage(task.stage)
        && isGithubLoginUrl(senderUrl);
      const managedGithubPointer = githubPointerAllowed
        && !!task.githubUsername?.trim()
        && !!task.githubPassword;
      if (!isTaskUrlAllowed(task, senderUrl) && !githubPointerAllowed) {
        return { ok: false, error: '当前页面不属于该签到任务' };
      }
      const markGithubCredentialSubmission = async () => {
        let updated = await taskState.setGithubCredentialsSubmitted(tabId, task.runId, true);
        if (!updated) {
          const active = await checkinQueue.active();
          if (active?.accountId === task.accountId) {
            updated = await taskState.setGithubCredentialsSubmitted(active.tabId, task.runId, true);
          }
        }
        if (!updated) {
          throw new Error('登录点击已派发，但无法保存 GitHub 凭据提交状态，已停止后续身份放行');
        }
      };
      const pointer = await trustedPointerClick(tabId, {
        x: msg.x,
        y: msg.y,
        viewportWidth: msg.viewportWidth,
        viewportHeight: msg.viewportHeight,
        targetToken: msg.targetToken,
        anchor: msg.anchor,
        targetSeenAt: msg.targetSeenAt,
        deadline: msg.deadline,
        ...(managedGithubPointer
          ? {
              inputAssertions: [
                { selector: '#login_field, input[name="login"]', value: task.githubUsername!.trim() },
                { selector: '#password, input[type="password"]', value: task.githubPassword! },
              ],
            }
          : {}),
      }, Math.random, {
        ...(managedGithubPointer ? { afterClick: markGithubCredentialSubmission } : {}),
      });
      return { ok: true, feature: { pointer } };
    }

    case 'TRUSTED_POINTER_SCROLL': {
      const tabId = sender.tab?.id;
      if (tabId == null || sender.frameId !== 0) return { ok: false, error: '缺少顶层任务标签页' };
      const senderUrl = sender.url ?? sender.tab?.url;
      const task = await taskState.get(tabId);
      if (!task || task.runId !== msg.runId) return { ok: false, error: '任务已结束' };
      // 滚动仅允许任务站点同源页面，绝不允许 OAuth / GitHub 等外域借此控制浏览器。
      if (!isTaskUrlAllowed(task, senderUrl)) return { ok: false, error: '当前页面不属于该签到任务' };
      const pointer = await trustedPointerScroll(tabId, {
        x: msg.x,
        y: msg.y,
        viewportWidth: msg.viewportWidth,
        viewportHeight: msg.viewportHeight,
        deltaY: msg.deltaY,
        steps: msg.steps,
      });
      return {
        ok: true,
        feature: { pointer: { mode: pointer.mode, pathPoints: 0, clickObserved: null, scroll: { deltaY: pointer.deltaY, steps: pointer.steps } } },
      };
    }

    case 'TRUSTED_POINTER_DRAG': {
      const tabId = sender.tab?.id;
      if (tabId == null || sender.frameId !== 0) return { ok: false, error: '缺少顶层任务标签页' };
      const senderUrl = sender.url ?? sender.tab?.url;
      const task = await taskState.get(tabId);
      if (!task || task.runId !== msg.runId) return { ok: false, error: '任务已结束' };
      // 与点击/滚动同一条安全闸门：拖拽也只允许任务站点同源页面。
      if (!isTaskUrlAllowed(task, senderUrl)) return { ok: false, error: '当前页面不属于该签到任务' };
      if (!Array.isArray(msg.points) || msg.points.length < 2) {
        return { ok: false, error: '拖拽轨迹至少需要 2 个点' };
      }
      const pointer = await trustedPointerDrag(tabId, {
        startX: msg.startX,
        startY: msg.startY,
        points: msg.points,
        viewportWidth: msg.viewportWidth,
        viewportHeight: msg.viewportHeight,
        ...(msg.fromTargetToken ? { targetToken: msg.fromTargetToken } : {}),
        ...(msg.toTargetToken ? { toTargetToken: msg.toTargetToken } : {}),
        ...(msg.fromAnchor ? { fromAnchor: msg.fromAnchor } : {}),
        ...(msg.toAnchor ? { toAnchor: msg.toAnchor } : {}),
      });
      return {
        ok: true,
        feature: {
          pointer: {
            mode: pointer.mode,
            pathPoints: 0,
            clickObserved: null,
            drag: { points: pointer.dragPoints, totalDistance: pointer.totalDistance },
          },
        },
      };
    }

    case 'CLAIM_TEXT_USED': {
      const tabId = sender.tab?.id;
      if (tabId == null) return { ok: false, error: '缺少任务标签页' };
      const task = await taskState.get(tabId);
      if (!task || task.runId !== msg.runId) return { ok: false, error: '任务已结束' };
      if (task.site.id !== msg.siteId) return { ok: false, error: '站点与当前任务不一致' };
      await recordClaimText(msg.siteId, msg.text);
      return { ok: true };
    }

    case 'SLIDER_FRAME_PREPARE':
    case 'SLIDER_FRAME_CONNECT':
    case 'SLIDER_FRAME_REPORT':
    case 'SLIDER_FRAME_STATUS':
    case 'SLIDER_FRAME_CANCEL':
      return handleSliderFrameMessage(msg, sender);

    case 'SLIDER_CRACK': {
      const tabId = sender.tab?.id;
      if (tabId == null) return { ok: false, error: '缺少任务标签页' };
      if (sender.frameId !== 0) {
        const target = await authorizedSliderFrameTarget(sender, msg.runId, msg.frameSessionId);
        const result = await crackSliderFrameChallenge(tabId, msg.slider, msg.options, target);
        return { ok: true, feature: { slider: result } };
      }
      const task = await taskState.get(tabId);
      if (!task || task.runId !== msg.runId) return { ok: false, error: '任务已结束' };
      const senderUrl = sender.url ?? sender.tab?.url;
      if (!isTaskUrlAllowed(task, senderUrl)) {
        return { ok: false, error: '当前页面不属于该签到任务' };
      }
      const result = await crackSliderChallenge(tabId, msg.slider, msg.options);
      // Message delivery succeeded even when image matching did not. Returning
      // the structured result lets the content-side retry loop use the reason.
      return { ok: true, feature: { slider: result } };
    }

    /**
     * 通知功能的实现已移除，只剩消息契约。
     *
     * 必须显式拒绝而不是落到下面的 `default: { ok: true }` —— 那会让管理页
     * 以为测试通知已送达，而实际什么都没发生。静默假成功比明确报错难查得多。
     */
    case 'TEST_NOTIFY':
      return { ok: false, error: '通知功能尚未实现，无法发送测试通知' };

    default:
      return { ok: true };
  }
}

const TERMINAL_RETRY_DELAYS = [0, 250, 750] as const;

async function retryTerminalCleanup(label: string, operation: () => Promise<void>): Promise<boolean> {
  let failure: unknown;
  for (const delay of TERMINAL_RETRY_DELAYS) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      await operation();
      return true;
    } catch (error) {
      failure = error;
    }
  }
  console.error(`[任务收尾] ${label}失败，已重试 ${TERMINAL_RETRY_DELAYS.length} 次`, failure);
  return false;
}

async function closeTaskTabWithRetry(tabId: number): Promise<void> {
  await retryTerminalCleanup(`关闭标签页 ${tabId}`, async () => {
    // 绝不动窗口的最后一个标签页：关掉它等于关窗口，只剩一个窗口时浏览器
    // 会直接退出，而用户还要继续签下一个站点。留下的标签页由用户/下一个
    // 任务复用，代价只是多一个页面 —— 远小于掀掉整个浏览器。
    await removeTabUnlessLast(tabId);
  });
}

/**
 * 签到成功后，把这次读到的余额补进独立存储。
 *
 * 为什么需要这一补：签到页往往只报出「今天 +$X」、没有可读的余额接口，
 * 于是 performCheckin 里的 hooks.saveBalance 因为 after == null 被跳过，
 * 库里只剩 saveCheckinReward 写的占位记录（quota=0 且带 error）。结果是
 * 同一个账号两种口径：账号行回落到 metrics.quotaAfter 显示余额，站点卡片
 * 只认独立存储、说「未获取」。
 *
 * 补写用的就是本次签到的快照本身，值来自真实读数，不是推算：
 *  - 用 metrics.quotaAfter（守恒差分读到的剩余额度）；没有就不写；
 *  - 库里已有成功快照时跳过，接口值比这个回落值更权威。
 */
async function backfillBalanceAfterCheckin(
  accountId: string,
  metrics: TaskResult['metrics'],
): Promise<void> {
  const quota = metrics?.quotaAfter;
  if (quota == null || !Number.isFinite(quota)) return;

  try {
    const balances = await local.get<Record<string, AccountBalance>>(KEYS.balances, {});
    const existing = balances[accountId];
    if (existing && !existing.error) return;

    await appRepository.saveBalance(accountId, {
      quota,
      usedQuota: existing?.usedQuota ?? 0,
      ...(metrics?.balanceSymbol ? { symbol: metrics.balanceSymbol } : {}),
      at: Date.now(),
      source: 'api',
    });
    broadcast();
  } catch {
    // 补写是加分项：失败不影响签到结论，账号行仍有展示层回落兜底。
  }
}

/**
 * 关页延迟 1.2 秒：既等本条 TASK_RESULT 回执先送达 content script，
 * 也把「本站还有没有下一个账号」的判定推迟到关页那一刻 —— 这个窗口里
 * drain 可能已经把下一个同站账号启动起来了，早一秒判断就会误关本站的页。
 */
function scheduleTaskTabClose(tabId: number, siteId?: string, accountId?: string): void {
  setTimeout(() => void closeTaskTabWhenSiteDone(tabId, siteId, accountId), 1_200);
}

/**
 * 一个账号成功收尾后的关页决策（站点级收尾）。
 *
 * 规则：本站还有 active/pending 的账号 → 这一页留着，登记进站点登记表；
 * 本站跑完了 → 把登记表里此前留下的本站任务页和当前页一起关掉 —— 每个
 * 账号各自开页，只「不关」会积出一串永远没人收的孤儿页。
 *
 * 逐页仍走 last-tab 保护（见 closeTaskTabWithRetry），绝不关掉窗口的最后
 * 一个标签页。失败/需人工的页面不走这里：TASK_RESULT 只在 result.ok 时调度，
 * 那种页面本来就该留给用户看。
 */
async function closeTaskTabWhenSiteDone(
  tabId: number,
  siteId?: string,
  accountId?: string,
): Promise<void> {
  if (!siteId || !accountId) {
    // 拿不到站点/账号归属（旧任务或异常路径）时退回逐页关，last-tab 保护仍在。
    await closeTaskTabWithRetry(tabId);
    return;
  }

  let kept: number[] = [];
  try {
    const [accounts, queue] = await Promise.all([
      local.get<Account[]>(KEYS.accounts, []),
      checkinQueue.snapshot(),
    ]);
    const shouldClose = shouldCloseTaskTabAfter({
      siteId,
      accountId,
      accounts,
      queue: {
        pendingAccountIds: queue.pendingAccountIds,
        activeAccountId: queue.active?.accountId,
      },
    });
    if (!shouldClose) {
      await keepSiteTab(siteId, tabId);
      return;
    }
    kept = await takeKeptSiteTabs(siteId);
  } catch {
    // 状态读写兜底：读不出来按老行为直接关这一页（last-tab 保护还在），
    // 登记写失败也不该变成未处理的 Promise 异常。
    await closeTaskTabWithRetry(tabId);
    return;
  }

  for (const keptTabId of kept) {
    if (keptTabId !== tabId) await closeTaskTabWithRetry(keptTabId);
  }
  await closeTaskTabWithRetry(tabId);
}

/** 一个站点最多记多少条用过的领取理由；超出后丢最旧的 */
const CLAIM_HISTORY_LIMIT = 60;

/**
 * 记下这个站点用掉的领取理由。
 *
 * 走 networkLocked 串行化：同一账号组可能连着跑多个站点，
 * 并发读改写会丢记录，下次就又挑到同一条被站点判重复。
 * 内置站点不落盘（BUILTIN_SITES 是常量），只处理用户导入的站点。
 */
async function recordClaimText(siteId: string, text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;

  await networkLocked(async () => {
    const sites = await local.get<SiteConfig[]>(KEYS.sites, []);
    const index = sites.findIndex((site) => site.id === siteId);
    if (index < 0) return { ok: true };

    const site = sites[index]!;
    /**
     * 没有 checkin 配置就不写。
     *
     * 这里曾经写成 `method: site.checkin?.method ?? 'claim'` —— 站点原本没有
     * checkin 配置时，会凭空造出 `{ method: 'claim' }`，把一个应走自动识别的
     * 站点改成需要三个领取选择器的方式，而那些选择器都没配，于是此后永久失败。
     * 记录领取理由这件事没有资格替站点决定执行方式。
     */
    if (!site.checkin) return { ok: true };

    const used = site.checkin.claimUsedTexts ?? [];
    if (used.includes(trimmed)) return { ok: true };

    const next = [...used, trimmed].slice(-CLAIM_HISTORY_LIMIT);
    sites[index] = { ...site, checkin: { ...site.checkin, claimUsedTexts: next } };
    await local.set(KEYS.sites, sites);
    return { ok: true };
  });
}

async function enqueueAccounts(accountIds: string[]): Promise<MessageResponse> {
  return networkLocked(async () => {
    // 入队前通过仓库读取一次：它会把旧站点默认值原子迁移并落盘。否则后台
    // 直接读取 storage 时仍可能把登仙的旧 none 投进任务，继续显示“登录即签到”。
    const { accounts, userSites, removedBuiltinSiteIds } = await appRepository.load();
    const hiddenBuiltinIds = new Set(removedBuiltinSiteIds);
    const validSiteIds = new Set([
      ...userSites.map((site) => site.id),
      ...BUILTIN_SITES.filter((site) => !hiddenBuiltinIds.has(site.id)).map((site) => site.id),
    ]);
    const validAccountIds = new Set(
      accounts.filter((account) => validSiteIds.has(account.siteId)).map((account) => account.id),
    );
    const validIds = accountIds.filter((accountId) => validAccountIds.has(accountId));
    if (validIds.length === 0) return { ok: false, error: '没有找到已归属站点的可执行账号' };

    /*
     * 队列空着才检查全局网络占用：队列已经在跑时不该被这条挡住（那会连
     * 「再加几个账号」都做不到，而新账号本来就会排在后面等）。
     *
     * 放在入队前而不是让每个账号在 launchAccount 里失败：用户点一次批量
     * 签到，应该立刻看到一条清楚的原因，而不是十几个账号各失败一次。
     */
    if (!await checkinQueue.busy()) {
      const occupied = await globalNetworkOccupied('queue');
      if (occupied) return { ok: false, error: occupied };
    }

    const result = await checkinQueue.enqueue(validIds);
    return {
      ok: true,
      queued: result.queued,
      skipped: accountIds.length - result.queued,
    };
  });
}

/**
 * 用户主动停止签到，让卡住的任务能立刻重试。
 *
 * 光改状态没用：队列把这个账号记在 storage.session 的 active/pending 里，
 * enqueue 会跳过队列中已有的账号 —— 表现就是「改回待签到后点执行毫无反应」。
 * 真正要清的是四样东西：任务信箱、队列占用、标签页、代理租约。
 *
 * 返回实际停下来的账号数，界面据此给反馈；一个都没停下来时说明它本来
 * 就不在跑，用户该看到的是「没有在执行的任务」而不是假装成功。
 */
async function cancelCheckins(accountIds: string[]): Promise<number> {
  const targets = [...new Set(accountIds.filter(Boolean))];
  if (targets.length === 0) return 0;

  const targetSet = new Set(targets);
  const active = await checkinQueue.active();
  const sessionSnapshot = await chrome.storage.session.get(null);
  const liveTargets = collectLiveTasks(sessionSnapshot)
    .filter((task) => targetSet.has(task.accountId));
  const taskTabIds = new Set(
    liveTargets.map((task) => task.tabId).filter((tabId) => tabId > 0),
  );
  if (active && targetSet.has(active.accountId) && active.tabId > 0) {
    taskTabIds.add(active.tabId);
  }

  // 不能只清队列当前记住的一个 tab：Worker 可能在「信箱已写、active.tabId
  // 还是 0」时休眠，留下队列不再认领的 task:* 信箱。按账号扫描全部信箱，
  // 先撤任务再关页，让迟到的 content 消息无法继续写状态。
  for (const tabId of taskTabIds) {
    await taskState.remove(tabId);
    await releaseTaskProxy(tabId, true).catch(() => {});
    await removeTabUnlessLast(tabId).catch(() => {});
  }

  const removed = await checkinQueue.cancel(targets);

  let reset = 0;
  for (const accountId of targets) {
    // 队列里没有也要复位：状态可能是没人认领的「签到中」孤儿（见 stuck-tasks）。
    if (await taskState.clearInFlight(accountId)) reset += 1;
  }
  const liveAccounts = new Set(liveTargets.map((task) => task.accountId)).size;
  return Math.max(removed, reset, liveAccounts);
}

/** 任务信箱与账号当前归属必须仍是同一站点，否则它是换站前的迟到任务。 */
async function taskStillTargetsCurrentSite(task: Pick<LoginTask, 'accountId' | 'siteId'>): Promise<boolean> {
  const accounts = await local.get<Account[]>(KEYS.accounts, []);
  return accounts.some((account) => account.id === task.accountId && account.siteId === task.siteId);
}

function isExtensionSender(sender: chrome.runtime.MessageSender): boolean {
  const source = sender.url ?? sender.origin;
  const extensionRoot = chrome.runtime.getURL('');
  return sender.id === chrome.runtime.id
    && !!source
    && (source === extensionRoot.slice(0, -1) || source.startsWith(extensionRoot));
}

async function mutateApp(mutation: AppMutation): Promise<MessageResponse> {
  switch (mutation.action) {
    case 'add-site':
      await appRepository.addSite(mutation.input);
      return { ok: true };

    case 'add-sites': {
      const userSites = await local.get<SiteConfig[]>(KEYS.sites, []);
      const existingUrls = new Set([...userSites, ...BUILTIN_SITES].map((site) => site.loginUrl.trim()));
      const added = await appRepository.addSites(mutation.inputs, existingUrls, mutation.preserveDuplicates);
      return { ok: true, added };
    }

    case 'update-site':
      await appRepository.updateSite(mutation.siteId, mutation.patch);
      return { ok: true };

    case 'move-site':
      await appRepository.moveSite(mutation.siteId, mutation.direction, mutation.orderedIds);
      return { ok: true };

    case 'delete-entities':
      return networkLocked(async () => {
        return terminalLocked(async () => {
          const accounts = await local.get<Account[]>(KEYS.accounts, []);
          const siteIds = new Set(mutation.siteIds);
          const requestedAccounts = new Set(mutation.accountIds);
          const affectedAccountIds = accounts
            .filter((account) => siteIds.has(account.siteId) || requestedAccounts.has(account.id))
            .map((account) => account.id);
          // 站点删除后账号会保留到“待恢复账号”，所以不能只撤队列占用。
          // 同时清理任务信箱、标签页、代理租约和 running/attention 状态。
          await cancelCheckins(affectedAccountIds);
          await appRepository.deleteEntities(mutation.siteIds, mutation.accountIds);
          return { ok: true };
        });
      });

    case 'add-account':
      await appRepository.addAccount(mutation.input);
      return { ok: true };

    case 'add-accounts': {
      const userSites = await local.get<SiteConfig[]>(KEYS.sites, []);
      const validSiteIds = new Set([...userSites, ...BUILTIN_SITES].map((site) => site.id));
      const result = await appRepository.addAccounts(mutation.inputs, validSiteIds, mutation.preserveDuplicates);
      return { ok: true, ...result };
    }

    case 'update-account': {
      const targetSiteId = mutation.patch.siteId;
      // 普通字段编辑不会改变任务所属站点，保持原有快路径。
      if (typeof targetSiteId !== 'string') {
        await appRepository.updateAccount(mutation.accountId, mutation.patch);
        return { ok: true };
      }

      return networkLocked(async () => terminalLocked(async () => {
        const accounts = await local.get<Account[]>(KEYS.accounts, []);
        const current = accounts.find((account) => account.id === mutation.accountId);
        if (current && targetSiteId !== current.siteId) {
          // 先等旧任务完全收尾，再原子地改归属并清理站点绑定状态。
          // networkLocked 同时拦住 SAVE_IDENTITY/SESSION_REFRESHED/BALANCE_SNAPSHOT，
          // terminalLocked 则拦住已 take 任务、正准备落终态的 finalizeTab。
          await cancelCheckins([mutation.accountId]);
        }
        await appRepository.updateAccount(mutation.accountId, mutation.patch);
        return { ok: true };
      }));
    }

    case 'add-proxy':
      await appRepository.addProxy(mutation.input);
      return { ok: true };

    case 'add-proxies': {
      const result = await appRepository.addProxies(mutation.inputs);
      return { ok: true, ...result };
    }

    case 'update-proxy':
      await appRepository.updateProxy(mutation.proxyId, mutation.patch);
      return { ok: true };

    case 'remove-proxy':
      await appRepository.removeProxy(mutation.proxyId);
      return { ok: true };

    case 'assign-account-proxies': {
      const result = await appRepository.assignAccountProxies(mutation.assignments);
      return { ok: true, ...result };
    }

    case 'update-schedule':
      await appRepository.updateSchedule(mutation.schedule);
      await syncScheduleAlarm();
      return { ok: true };

    case 'set-status':
      await taskState.setStatus(mutation.accountId, mutation.value);
      return { ok: true };

    case 'mark-done':
      await taskState.markDone(mutation.accountId);
      return { ok: true };
  }
}

/** 一次最多扫多少个端口：每个要切换一次全局代理，太多会把网络占用过久 */
const PORT_SCAN_MAX = 64;
/** 快速扫描只验证连通性；坏端口最多等 8 秒，不做出口地理查询。 */
const PORT_SCAN_CONNECT_TIMEOUT_MS = 8_000;
const CLASH_CONTROLLER_TIMEOUT_MS = 1_500;

/**
 * 逐个试本机端口，回报哪些能用，并同步 Clash listeners 名称。
 *
 * ⚠️ 必须串行：chrome.proxy 是浏览器全局设置，并发测会互相覆盖，
 * 测出来的出口 IP 会张冠李戴。
 *
 * 端口探测只允许回环地址；另会只读 Clash listeners 获取端口对应名称，
 * 不修改、不切换本地内核的配置或当前节点。
 */
async function scanLocalPorts(
  host: string,
  ports: number[],
  scheme: 'http' | 'socks5',
  withExit = false,
  controllerConnection?: ClashControllerConnection,
): Promise<MessageResponse> {
  const target = host.trim();
  if (!isLoopbackProxyHost(target)) {
    return { ok: false, error: '只支持扫描本机地址（127.0.0.1 / localhost）' };
  }

  const unique = [...new Set(ports)].filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
  if (!unique.length) return { ok: false, error: '没有要扫描的端口' };
  if (unique.length > PORT_SCAN_MAX) {
    return { ok: false, error: `一次最多扫 ${PORT_SCAN_MAX} 个端口，请缩小范围` };
  }

  // 端口本身只告诉我们出口是否可用；节点名要从 Clash 的 listeners 映射读取。
  // 读取失败不阻断扫描，用户仍能得到端口/IP 结果。
  const listenerLookup = await readClashListenerNames(unique, controllerConnection);

  return networkLocked(async () => {
    // 学习会话同样持有全局代理租约，不能被扫描顶掉（见 globalNetworkOccupied）。
    const occupied = await globalNetworkOccupied('scan');
    if (occupied) return { ok: false, error: occupied };
    // 落盘标记：一次扫描要切几十次全局代理，队列必须能看见它。
    // 落盘标记：一次扫描要切几十次全局代理，队列必须能看见它。
    const releaseToolLock = await acquireNetworkToolLock('scan');
    try {
      const entries: PortScanEntry[] = [];
      for (const port of unique.sort((a, b) => a - b)) {
        const probe: ProxyConfig = {
          id: `scan:${port}`,
          name: `${target}:${port}`,
          scheme,
          host: target,
          port,
        };
        // chrome.proxy 是浏览器全局设置，端口检查必须串行；默认不查出口
        // IP/国家，因为那两次外部地理接口请求才是扫描变慢的主要原因。
        const test = await testProxy(
          probe,
          undefined,
          withExit,
          withExit ? 12_000 : PORT_SCAN_CONNECT_TIMEOUT_MS,
        );
        entries.push({
          port,
          ok: test.ok,
          ms: test.ms,
          message: test.message,
          ...(listenerLookup.namesByPort.get(port) ? { name: listenerLookup.namesByPort.get(port) } : {}),
          ...(test.ip ? { ip: test.ip } : {}),
          ...(test.country ? { country: test.country } : {}),
        });
      }

      const live = entries.filter((entry) => entry.ok).length;
      const named = entries.filter((entry) => entry.name).length;
      return {
        ok: true,
        feature: {
          portScan: {
            entries,
            live,
            exitChecked: withExit,
            ...(withExit
              ? { distinctExits: new Set(entries.filter((entry) => entry.ip).map((entry) => entry.ip)).size }
              : {}),
            ...(named ? { named } : {}),
            ...(listenerLookup.controllerPort ? { controllerPort: listenerLookup.controllerPort } : {}),
            ...(listenerLookup.controllerOrigin ? { controllerOrigin: listenerLookup.controllerOrigin } : {}),
            ...(listenerLookup.status ? { listenerStatus: listenerLookup.status } : {}),
          },
        },
      };
    } finally {
      await releaseToolLock();
    }
  });
}

interface ClashListenerLookup {
  namesByPort: Map<number, string>;
  controllerPort?: number;
  controllerOrigin?: string;
  status?: 'mapped' | 'unsupported' | 'unauthorized' | 'empty' | 'unavailable' | 'invalid';
}

/**
 * 只读 Clash/Mihomo external-controller 的 listeners 接口。
 *
 * 有显式 controller 设置时只请求该地址，并使用用户保存在扩展本地的 secret。
 * 旧调用没有设置时仍按常见端口探测，但绝不再发送占位 Authorization 头。
 * 所有失败都只影响名称映射，不影响下面的本机代理连通性扫描。
 */
async function readClashListenerNames(
  ports: readonly number[],
  connection?: ClashControllerConnection,
): Promise<ClashListenerLookup> {
  const wanted = new Set(ports);
  const explicitOrigin = connection ? normalizeClashControllerAddress(connection.address) : null;
  if (connection && !explicitOrigin) {
    return { namesByPort: new Map(), status: 'invalid' };
  }

  const origins = explicitOrigin
    ? [explicitOrigin]
    : CLASH_CONTROLLER_PORTS.map((port) => `http://127.0.0.1:${port}`);

  // 这些请求只是只读本机 HTTP 探测，不会碰 chrome.proxy。未配置地址时并行
  // 探测，避免控制器关闭后把常见端口超时逐个累加。
  const candidates = await Promise.all(origins.map(async (origin): Promise<ClashListenerLookup> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLASH_CONTROLLER_TIMEOUT_MS);
    try {
      const response = await fetch(`${origin}/listeners`, {
        signal: controller.signal,
        cache: 'no-store',
        redirect: 'error',
        credentials: 'omit',
        headers: buildClashControllerAuthHeaders(connection?.secret),
      });
      const controllerPort = portOfControllerOrigin(origin);
      if (response.status === 401 || response.status === 403) {
        return { namesByPort: new Map(), controllerPort, controllerOrigin: origin, status: 'unauthorized' };
      }
      if (response.status === 404) {
        return { namesByPort: new Map(), controllerPort, controllerOrigin: origin, status: 'unsupported' };
      }
      if (!response.ok) {
        return { namesByPort: new Map(), controllerPort, controllerOrigin: origin, status: 'unavailable' };
      }
      const body: unknown = await response.json();
      const namesByPort = parseClashListenerResponse(body, wanted);
      return {
        namesByPort,
        controllerPort,
        controllerOrigin: origin,
        status: namesByPort.size ? 'mapped' : 'empty',
      };
    } catch {
      return { namesByPort: new Map(), controllerOrigin: origin, status: 'unavailable' };
    } finally {
      clearTimeout(timer);
    }
  }));

  return candidates.find((candidate) => candidate.status === 'mapped')
    ?? candidates.find((candidate) => candidate.status !== 'unavailable')
    ?? { namesByPort: new Map(), status: 'unavailable' };
}

/** Read all leaf node names without changing Clash state or its active selector. */
async function readClashProxyNames(connection: ClashControllerConnection): Promise<MessageResponse> {
  const origin = normalizeClashControllerAddress(connection.address);
  if (!origin) return { ok: false, error: 'Clash controller 地址无效，请填写端口、主机:端口或 http(s) 地址' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLASH_CONTROLLER_TIMEOUT_MS * 2);
  try {
    const response = await fetch(`${origin}/proxies`, {
      signal: controller.signal,
      cache: 'no-store',
      redirect: 'error',
      credentials: 'omit',
      headers: buildClashControllerAuthHeaders(connection.secret),
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: 'Clash controller 认证失败，请检查密钥' };
    }
    if (response.status === 404) {
      return { ok: false, error: '当前 Clash/Mihomo controller 不提供 /proxies 接口' };
    }
    if (!response.ok) return { ok: false, error: `Clash controller 返回 HTTP ${response.status}` };

    const body: unknown = await response.json();
    return {
      ok: true,
      feature: { clashController: { origin, names: parseClashProxyNames(body) } },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: message.toLowerCase().includes('abort')
        ? '连接 Clash controller 超时'
        : '无法连接 Clash controller，请检查地址、external-controller 和防火墙',
    };
  } finally {
    clearTimeout(timer);
  }
}

function portOfControllerOrigin(origin: string): number | undefined {
  try {
    const url = new URL(origin);
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    return Number.isInteger(port) ? port : undefined;
  } catch {
    return undefined;
  }
}

/** 只读检测 HTTP 控制接口；未命中不代表内核进程未启动（Verge 可仅使用命名管道）。 */
async function detectClashController(connection?: ClashControllerConnection): Promise<MessageResponse> {
  try {
    const detection = await discoverClashController(connection);
    return { ok: true, feature: { clashControllerDetect: detection } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '检测 HTTP 控制接口失败' };
  }
}

/**
 * 运行时取 `parseClashListenerExits`。
 *
 * 该解析器由另一位实现者在本工作日补进 `lib/clash/clash-listeners`，本文件
 * 编译时不一定存在，因此用命名空间导入 + 运行时取值，而不是命名导入。
 * 导出缺席时返回 undefined，调用方明确回报 blocker —— 绝不在这里再写一份，
 * 两套解析口径会让端口到节点的映射悄悄分叉。
 */
function resolveParseClashListenerExits():
  ((body: unknown) => ClashListenerExit[]) | undefined {
  const candidate = (clashListeners as {
    parseClashListenerExits?: (body: unknown) => ClashListenerExit[];
  }).parseClashListenerExits;
  return typeof candidate === 'function' ? candidate : undefined;
}

/**
 * 只读内核里已配置的本地出口（listeners）。
 *
 * 这些端口就是「每个账号一个出口」的落脚点：内核为每个节点各开一个本地
 * 监听端口，扩展只负责把端口收进代理池。只 GET /listeners，不修改任何配置、
 * 不切换当前节点。
 */
async function readClashListenerExits(connection: ClashControllerConnection): Promise<MessageResponse> {
  const origin = normalizeClashControllerAddress(connection.address);
  if (!origin) return { ok: false, error: 'Clash controller 地址无效，请填写端口、主机:端口或 http(s) 地址' };

  const parseExits = resolveParseClashListenerExits();
  if (!parseExits) {
    return {
      ok: false,
      error: 'BLOCKER: parseClashListenerExits 尚未导出（lib/clash/clash-listeners），无法解析内核本地出口',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLASH_CONTROLLER_TIMEOUT_MS * 2);
  try {
    const response = await fetch(`${origin}/listeners`, {
      signal: controller.signal,
      cache: 'no-store',
      redirect: 'error',
      credentials: 'omit',
      headers: buildClashControllerAuthHeaders(connection.secret),
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: '内核控制器认证失败，请检查密钥' };
    }
    if (response.status === 404) {
      return { ok: false, error: '当前内核不提供 /listeners 接口' };
    }
    if (!response.ok) return { ok: false, error: `内核控制器返回 HTTP ${response.status}` };

    const body: unknown = await response.json();
    return {
      ok: true,
      feature: { clashListenerExits: { origin, exits: parseExits(body) } },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: message.toLowerCase().includes('abort')
        ? '连接内核控制器超时'
        : '无法连接内核控制器，请检查地址、external-controller 和防火墙',
    };
  } finally {
    clearTimeout(timer);
  }
}


/** 订阅内容体积上限：正常订阅几十 KB，超过 2MB 基本是拉错了地址 */
const SUBSCRIPTION_MAX_BYTES = 2 * 1024 * 1024;
const SUBSCRIPTION_TIMEOUT_MS = 15_000;

/**
 * 拉取代理订阅原文。
 *
 * 放在 background 的理由与 probeSite 相同：管理页发跨源请求会被订阅站
 * CORS 拦掉，而这里有 `<all_urls>` host permission。
 * 只回原文不解析 —— 解析是纯函数，在管理页跑便于直接呈现预览。
 */
async function fetchSubscription(rawUrl: string): Promise<MessageResponse> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return { ok: false, error: '订阅地址格式不对，请填完整的 http(s) 链接' };
  }
  // 只允许 http(s)：file:// 之类会把本机文件读出来
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: '只支持 http/https 的订阅地址' };
  }
  // SSRF 闸门：background 带 <all_urls>，能碰到页面碰不到的本机/内网地址。
  // 挡掉指向 loopback / 内网 / 云元数据(169.254.169.254) 的订阅地址，只放行公网，
  // 否则页面能借拉订阅把内网响应体读出来。
  if (isBlockedFetchHost(url.hostname)) {
    return { ok: false, error: '订阅地址指向本机或内网，已拒绝' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUBSCRIPTION_TIMEOUT_MS);
  try {
    const response = await fetch(url.href, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) return { ok: false, error: `订阅返回 ${response.status}` };

    const text = await response.text();
    const bytes = new TextEncoder().encode(text).length;
    if (bytes > SUBSCRIPTION_MAX_BYTES) {
      return { ok: false, error: '订阅内容过大（超过 2MB），请确认地址是否正确' };
    }
    if (!text.trim()) return { ok: false, error: '订阅内容为空' };

    return { ok: true, feature: { subscription: { text, bytes } } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message.includes('abort') ? '拉取订阅超时（15 秒）' : `拉取失败: ${message}` };
  } finally {
    clearTimeout(timer);
  }
}
/**
 * 订阅/listener 自动核对。
 *
 * 只做三件事:拉订阅 → 与已存映射 diff → 把**新增**端口补进代理池。
 * 已绑定账号的旧条目一律不动(见 reconcileProxyInputs);失效节点只留在映射里
 * 做空洞,端口不复用 —— 复用会让某个账号悄悄换出口。
 *
 * 零干扰:本函数不写 Clash Verge 的任何文件或设置。新增节点需要用户重粘一次
 * Script 才会生效,所以返回 needsResync 让界面出横幅。
 */
async function checkListenerDrift(): Promise<MessageResponse> {
  const source = await local.get<{ url?: string; autoSync?: boolean } | null>(KEYS.subscriptionSource, null);
  const url = source && typeof source.url === 'string' ? normalizeSubscriptionUrl(source.url) : null;
  if (!url) return { ok: false, error: '还没有保存订阅地址:先在导入页粘一次订阅并生成配置' };

  const fetched = await fetchSubscription(url);
  if (!fetched.ok) {
    await local.set(KEYS.subscriptionSource, { ...source, lastError: fetched.error });
    return { ok: false, error: fetched.error };
  }
  const text = fetched.feature?.subscription?.text ?? '';

  const existing = await loadListenerPlan();
  if (!existing.length) return { ok: false, error: '还没有端口映射:先在导入页生成一次 listeners 配置' };

  const drift = planListenerDrift(text, existing);
  await saveListenerPlan(drift.entries);
  if (drift.poolEntries.length) {
    await appRepository.addProxies(drift.poolEntries.map((entry) => ({
      ...entry,
      sourceLabel: 'Clash Verge',
    })));
  }

  const checkedAt = Date.now();
  await local.set(KEYS.subscriptionSource, {
    ...source,
    lastCheckedAt: checkedAt,
    lastError: undefined,
  });
  return {
    ok: true,
    feature: {
      listenerDrift: {
        ok: true,
        added: drift.poolEntries.length,
        removed: drift.removedNames.length,
        total: drift.entries.length,
        checkedAt,
        needsResync: drift.addedEntries.length > 0,
      },
    },
  };
}

/** 闹钟入口:用户没开自动同步就静默跳过,不制造无谓的网络请求。 */
async function runListenerSync(): Promise<void> {
  const source = await local.get<{ url?: string; autoSync?: boolean } | null>(KEYS.subscriptionSource, null);
  if (!source || source.autoSync !== true || typeof source.url !== 'string') return;
  await checkListenerDrift();
}

/**
 * 抓取某个标签页里已登录的会话，存到指定账号。
 *
 * 这是「只能 GitHub 登录 / 登录要过人机验证」那些站点的解法：
 * 用户手动登录一次，我们把浏览器里已经存在的会话读出来存下，
 * 之后签到直接注入，不再走登录流程。
 *
 * 读 localStorage 必须在页面上下文里，所以用 chrome.scripting 注入一段函数。
 */
async function captureSessionForAccount(
  accountId: string,
  explicitTabId?: number,
): Promise<MessageResponse> {
  const accounts = await local.get<Account[]>(KEYS.accounts, []);
  const account = accounts.find((item) => item.id === accountId);
  if (!account) return { ok: false, error: '账号不存在' };

  const userSites = await local.get<SiteConfig[]>(KEYS.sites, []);
  const site = configuredSite(account.siteId, userSites);
  if (!site) return { ok: false, error: '站点配置不存在' };

  const tabId = explicitTabId ?? await findTabForSite(site);
  if (tabId == null) {
    return { ok: false, error: '没找到该站点的标签页；请先在浏览器里打开并登录该站点' };
  }

  // 注入的函数在页面上下文执行，不能引用本文件的任何变量 —— 会被序列化掉。
  // 所以把 siteType 作为参数传进去。
  const injection = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func: captureInPage,
    args: [[...CAPTURE_SPECS], site.adapter?.siteType ?? ''],
  }).catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    return reason;
  });

  if (typeof injection === 'string') {
    return { ok: false, error: `无法读取该标签页：${injection}` };
  }

  const captured = injection[0]?.result;
  if (!captured) {
    return { ok: false, error: '这个页面上没找到登录凭据；请确认已经登录，然后刷新页面重试' };
  }

  const session: CapturedAuthSession = {
    ...(captured.accessToken ? { accessToken: captured.accessToken } : {}),
    ...(captured.refreshToken ? { refreshToken: captured.refreshToken } : {}),
    ...(captured.tokenExpiresAt ? { tokenExpiresAt: captured.tokenExpiresAt } : {}),
    capturedAt: Date.now(),
    ...(captured.siteType ? { siteType: captured.siteType } : {}),
  };
  await appRepository.saveAccountSession(accountId, session);
  broadcast();

  return {
    ok: true,
    feature: { captured: { session, identity: captured.identity, evidence: captured.evidence } },
  };
}

/**
 * 在页面上下文里按规格读会话。
 *
 * ⚠️ 这个函数会被序列化后注入目标页面执行：
 *  - 不能引用本文件的任何变量、import、常量 —— 全部要靠参数传进来
 *  - 不能用可选链之外的语法糖以外的项目工具函数
 * 所以它自带了一份最小的解析逻辑，键名则来自参数（单一来源在
 * automation/session-capture.ts 的 CAPTURE_SPECS）。
 */
function captureInPage(specs: CaptureSpec[], hintedSiteType: string) {
  const text = (value: unknown): string | undefined => {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return undefined;
  };
  const readJson = (key: string): Record<string, unknown> | null => {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };

  // 探测出的族排前面试，其余按顺序兜底 —— 站点可能被认错
  const ordered = [
    ...specs.filter((spec) => spec.siteType === hintedSiteType),
    ...specs.filter((spec) => spec.siteType !== hintedSiteType),
  ];

  for (const spec of ordered) {
    let accessToken: string | undefined;
    if (spec.tokenKey) {
      accessToken = localStorage.getItem(spec.tokenKey)?.trim() || undefined;
    } else if (spec.nestedToken) {
      let cursor: unknown = readJson(spec.nestedToken.key);
      for (const segment of spec.nestedToken.path) {
        cursor = cursor && typeof cursor === 'object'
          ? (cursor as Record<string, unknown>)[segment]
          : undefined;
      }
      accessToken = text(cursor);
    }

    const user = spec.userKey ? readJson(spec.userKey) : null;
    const identity = {
      userId: text(user?.id),
      username: text(user?.username),
      email: text(user?.email),
    };

    // 拿到 token，或者（cookie 族）至少拿到 userId，才算抓到了
    const usable = accessToken || (!spec.tokenKey && !spec.nestedToken && identity.userId);
    if (!usable) continue;

    const expiresRaw = spec.expiresKey ? localStorage.getItem(spec.expiresKey) : null;
    const expires = expiresRaw ? Number.parseInt(expiresRaw, 10) : Number.NaN;

    return {
      identity,
      accessToken,
      refreshToken: spec.refreshKey
        ? localStorage.getItem(spec.refreshKey)?.trim() || undefined
        : undefined,
      tokenExpiresAt: Number.isFinite(expires) ? expires : undefined,
      siteType: spec.siteType,
      evidence: spec.evidence,
    };
  }
  return null;
}

/** 余额刷新的单账号结果，只用于汇总计数 */
type BalanceRefreshOutcome = 'refreshed' | 'failed';

/**
 * 手动刷新一批账号的余额。
 *
 * 串行而不并发：新开标签页要占全局代理（chrome.proxy 是浏览器级设置），
 * 并发就会互相抢。也顺带避免同时对一个站点打出多个请求被限流。
 */
async function refreshBalances(accountIds: string[]): Promise<MessageResponse> {
  return networkLocked(async () => {
    // 签到队列或学习会话正在跑时拒绝：它们同样在改全局代理，两边同时动会互相踩。
    // 与 TEST_PROXY 共用同一个判据。
    const occupied = await globalNetworkOccupied('test');
    if (occupied) return { ok: false, error: occupied };

    const [accounts, userSites] = await Promise.all([
      local.get<Account[]>(KEYS.accounts, []),
      local.get<SiteConfig[]>(KEYS.sites, []),
    ]);

    let refreshed = 0;
    let failed = 0;
    for (const accountId of accountIds) {
      const account = accounts.find((item) => item.id === accountId);
      if (!account) {
        failed += 1;
        continue;
      }
      const site = configuredSite(account.siteId, userSites);
      if (!site) {
        await appRepository.saveBalanceError(accountId, '站点配置不存在');
        failed += 1;
        continue;
      }

      const outcome = await refreshOneBalance(account, site);
      if (outcome === 'refreshed') refreshed += 1;
      else failed += 1;
    }

    broadcast();
    return { ok: true, feature: { refreshed, failed } };
  });
}

async function refreshOneBalance(account: Account, site: SiteConfig): Promise<BalanceRefreshOutcome> {
  const origin = siteOrigin(site);
  if (!origin) {
    await appRepository.saveBalanceError(account.id, '站点地址无效，无法读取余额');
    return 'failed';
  }

  /**
   * 已经开着这个站点的标签页，**且它此刻确实经过该账号的代理**时复用它。
   *
   * 判据是出口一致：账号该走的出口 vs 浏览器此刻实际在走的出口。chrome.proxy
   * 是浏览器级设置，所以「实际在走哪条路」必须以全局代理设置为准 —— 标签页
   * 自己不会告诉你它的网络路径。
   *
   * 为什么不能无脑复用（旧实现）：用户正好开着该站点页面时，余额会借这个标签页
   * 直连出站，而同一账号的签到任务走的是账号代理。同一账号从两个来源来，风控
   * 站点表现为「余额 401/404，但签到正常」—— 扩展这边只是安静地失败，用户查不出来。
   *
   * 为什么不无脑新开：用户此刻正看着那个页面，能不动就不动；而且复用是唯一能
   * 利用「用户已经登录好」这条会话的路径，某些站点只有这样才读得到余额。
   *
   * 解析不出账号代理（配置坏了）时也不是复用理由：那种情况下面会带着明确报错
   * 收尾，绝不能退回直连去读数据。
   */
  const existingTabId = await findTabForSite(site, { preferCheckinPage: true });
  if (existingTabId != null) {
    const reusable = await resolveProxyForAccount(account, site);
    if (reusable.ok
      && appliedProxyMatchesAccount(reusable.proxy, await readAppliedProxyEndpoint())) {
      return captureBalanceFromTab(account, site, existingTabId);
    }
  }

  const resolved = await resolveProxyForAccount(account, site);
  if (!resolved.ok) {
    await appRepository.saveBalanceError(account.id, resolved.error);
    return 'failed';
  }

  // active:false —— 刷余额不该把用户当前的标签页抢走。先建空白页，等账号
  // 代理拿到租约后再导航；直接用 loginUrl 创建会让首个请求抢在代理设置前直连。
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false }).catch(() => null);
  if (!tab || tab.id == null) {
    await appRepository.saveBalanceError(account.id, '无法创建标签页');
    return 'failed';
  }
  const tabId = tab.id;

  try {
    if (resolved.proxy && !await proxyLease.acquire(tabId, resolved.proxy)) {
      await appRepository.saveBalanceError(account.id, '代理正被其他任务占用，请稍后再刷新');
      return 'failed';
    }
    /*
     * 直连账号也要确认「此刻没有人替它走代理」：已有标签页那条捷径靠
     * appliedProxyMatchesAccount 挡住了，这里是新开页的分支 —— 若浏览器正被
     * 别的任务接管，这个「直连」账号的余额其实是从对方出口读回来的。
     */
    if (!resolved.proxy) {
      const held = await readAppliedProxyEndpoint();
      const reason = egressMismatchReason(undefined, held);
      if (reason) {
        await appRepository.saveBalanceError(account.id, reason);
        return 'failed';
      }
    }
    /*
     * 导航前再核对一次实际生效的端点。
     *
     * proxyLease.acquire 内部已经 applyProxy + 回读确认，所以走到这里基本是可靠的；
     * 这一步是给「另一个扩展在这两个 await 之间抢走了 chrome.proxy 控制权」这类竞态
     * 兜底。一旦实际端点不是这个账号该走的那条，宁可判失败也不能让余额从一个错误的
     * 出口读回来 —— 那正是本次要修的问题本身。
     */
    if (!appliedProxyMatchesAccount(resolved.proxy, await readAppliedProxyEndpoint())) {
      await appRepository.saveBalanceError(
        account.id,
        '代理未能按账号配置生效，已放弃本次余额刷新（出口不一致时读到的余额不可信）',
      );
      return 'failed';
    }
    await chrome.tabs.update(tabId, { url: balanceRefreshUrl(site) });
    await waitForTabComplete(tabId);
    return await captureBalanceFromTab(account, site, tabId);
  } finally {
    if (resolved.proxy) await proxyLease.release(tabId).catch(() => {});
    await removeTabUnlessLast(tabId).catch(() => {});
  }
}

/** 等标签页加载完，超时也继续 —— 余额接口往往比整页资源先就绪 */
async function waitForTabComplete(tabId: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    if (tab.status === 'complete') return;
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/**
 * 注入页面取原始响应，回到 background 用 balance.ts 的纯函数解析。
 *
 * 解析绝不在页面里做：extractBalance / readVisibleBalance 已经有单测覆盖，
 * 是唯一的解析实现，在注入函数里再写一份必然与它走偏。
 */
async function captureBalanceFromTab(
  account: Account,
  site: SiteConfig,
  tabId: number,
): Promise<BalanceRefreshOutcome> {
  const hvoy = (() => {
    try { return new URL(site.loginUrl).hostname.toLowerCase() === 'www.hvoy.ai'; } catch { return false; }
  })();
  const paths = (hvoy ? [] : balanceEndpointsFor(site)).filter((path) => isSameSiteUrl(site, path));
  // 站点显式配置的跨域接口（identitySource.endpoint）：SPA 站点的余额在真实
  // 跨域 API（orevx.ai ↔ server.orevx.ai/api）。安全门与运行时一致，在
  // crossOriginBalanceProbe 里（仅 https、本站域名的自身/子域、缺 token 不发）。
  const crossOriginProbe = crossOriginBalanceProbe(site);
  const injection = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func: readBalancePayloadsInPage,
    args: [paths, [...USER_ID_HEADER_NAMES], hvoy, crossOriginProbe, authBootstrapProbe(site)],
  }).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));

  if (typeof injection === 'string') {
    await appRepository.saveBalanceError(account.id, `无法读取该站点页面：${injection}`);
    return 'failed';
  }

  const read = injection[0]?.result;
  if (!read) {
    await appRepository.saveBalanceError(account.id, '页面没有返回余额数据');
    return 'failed';
  }

  const parsedPayloads = read.payloads.flatMap((payload) => {
    if (!payload.json) return [];
    try {
      return [{ path: payload.path, value: JSON.parse(payload.text) as unknown }];
    } catch {
      return [];
    }
  });

  // 跨域响应在 background 解码（页面注入只负责原样带回字节；解码/提取
  // 的唯一实现都在 balance.ts 的纯函数里）。失败即 null，走后面的正文兜底。
  const crossOriginPayload = read.crossOrigin
    ? decodeCrossOriginPayload(read.crossOrigin.contentType, read.crossOrigin.base64)
    : null;

  // 余额与今日奖励同样是账号数据。标签页复用的是 Chrome 当前站点会话，
  // 不先核对身份就保存，会把账号 A 的余额和奖励写到账号 B。
  const apiIdentity = parsedPayloads
    .filter((payload) => /\/(?:auth\/me|user\/(?:self|info))(?:\/|\?|#|$)/i.test(payload.path))
    .map((payload) => extractIdentityFromPayload(payload.value))
    .find((identity): identity is PageIdentity => !!identity)
    // 跨域接口（identitySource.endpoint）也是身份来源：它同时返回身份字段与
    // points 余额（orevx 的 /user/me 就是这样）；同源没读到就用它参与核对。
    ?? (crossOriginPayload == null
      ? undefined
      : extractIdentityFromPayload(crossOriginPayload) ?? undefined);
  const pageIdentity = apiIdentity
    ? { ...apiIdentity, source: 'api' as const }
    : readVisibleIdentityFromText(read.bodyText);
  const [allAccounts, userSites] = await Promise.all([
    local.get<Account[]>(KEYS.accounts, []),
    local.get<SiteConfig[]>(KEYS.sites, []),
  ]);
  const siteAccounts = accountsSharingSiteOrigin(allAccounts, userSites, site);
  const knownUsers = Object.fromEntries(
    siteAccounts
      .filter((item) => item.id !== account.id && item.identity?.userId)
      .map((item) => [item.identity!.userId!, item.label || item.username]),
  );
  const duplicateOwner = account.identity?.userId
    ? knownUsers[account.identity.userId]
    : undefined;
  const pageAccountMatch = findAccountOnPage(account.username, read.bodyText)?.matched;
  const effectiveLoginMethod = resolveEffectiveMethods(account, site).loginMethod;
  const githubIdentityAlias = effectiveLoginMethod === 'github'
    ? account.githubUsername?.trim()
    : undefined;
  const storedApiIdentity = account.identity?.source === 'api'
    ? account.identity
    : undefined;
  const identityVerdict = verifyIdentity(
    pageIdentity,
    account.username,
    duplicateOwner ? undefined : account.identity?.userId,
    {
      knownUsers,
      ...(pageAccountMatch ? { pageAccountMatch } : {}),
      ...(githubIdentityAlias ? { expectedAliases: [githubIdentityAlias] } : {}),
      ...(storedApiIdentity?.username || storedApiIdentity?.email
        ? {
            expectedIdentity: {
              ...(storedApiIdentity.username ? { username: storedApiIdentity.username } : {}),
              ...(storedApiIdentity.email ? { email: storedApiIdentity.email } : {}),
            },
          }
        : {}),
    },
  );
  const identityUnsafe = identityVerdict.match === 'mismatch'
    || (siteAccounts.length > 1 && identityVerdict.match !== 'confirmed');
  if (identityUnsafe) {
    await appRepository.clearBalance(account.id);
    await appRepository.saveBalanceError(
      account.id,
      `余额刷新已停止：当前页面身份未通过账号 ${account.username} 的核对（${identityVerdict.detail}）`,
    );
    return 'failed';
  }
  if (identityVerdict.match === 'confirmed' && pageIdentity?.source === 'api') {
    await appRepository.saveAccountIdentity(account.id, pageIdentity);
  }

  // The profile page can expose today's reward even when the balance API still
  // returns the old quota. Keep this ledger observation independent from the
  // balance snapshot and from the result of a previous click.
  const observedAt = Date.now();
  let checkinReward = readVisibleCheckinRewardObservation(
    read.bodyText,
    checkinRewardQuotaPerUnit(site),
  );
  if (checkinReward != null) {
    await appRepository.saveCheckinReward(
      account.id,
      checkinReward.reward,
      todayKey(),
      observedAt,
      checkinReward.symbol,
    );
  }

  for (const payload of parsedPayloads) {
    const parsed = payload.value;
    const structuredReward = extractTodayCheckinRewardObservation(
      parsed,
      checkinRewardQuotaPerUnit(site),
    );
    const mergedReward = mergeCheckinRewardObservations(checkinReward, structuredReward);
    const rewardChanged = mergedReward != null && (
      !checkinReward
      || mergedReward.reward !== checkinReward.reward
      || mergedReward.symbol !== checkinReward.symbol
    );
    if (rewardChanged) {
      checkinReward = mergedReward;
      await appRepository.saveCheckinReward(
        account.id,
        mergedReward.reward,
        todayKey(),
        observedAt,
        mergedReward.symbol,
      );
    }
    const raw = extractBalance(parsed);
    if (!raw) continue;
    await appRepository.saveBalance(account.id, {
      quota: raw.quota,
      usedQuota: raw.usedQuota,
      ...(raw.symbol ? { symbol: raw.symbol } : {}),
      at: observedAt,
      source: 'api',
    });
    return 'refreshed';
  }

  // 同源接口都没有余额字段时，用跨域接口（identitySource.endpoint）里的
  // points —— orevx 这类 SPA 的余额只存在于跨域 API 的响应里。
  const crossOriginRaw = crossOriginPayload == null ? null : extractCrossOriginBalance(crossOriginPayload);
  if (crossOriginRaw) {
    await appRepository.saveBalance(account.id, {
      quota: crossOriginRaw.quota,
      usedQuota: crossOriginRaw.usedQuota,
      ...(crossOriginRaw.symbol ? { symbol: crossOriginRaw.symbol } : {}),
      at: observedAt,
      source: 'api',
    });
    return 'refreshed';
  }

  // 接口读不到时退回页面正文的「当前余额 $X」，与签到路径同一套兜底
  const visible = readVisibleBalance(read.bodyText, site.adapter?.quotaPerUnit);
  if (visible) {
    await appRepository.saveBalance(account.id, {
      quota: visible.quota,
      usedQuota: visible.usedQuota,
      ...(visible.symbol ? { symbol: visible.symbol } : {}),
      at: observedAt,
      source: 'visible',
    });
    return 'refreshed';
  }

  await appRepository.saveBalanceError(
    account.id,
    read.payloads.length
      ? '站点返回的数据里没有余额字段'
      : '读不到余额：可能登录态已失效，或该站点没有余额接口',
  );
  return 'failed';
}

/** Prefer the configured check-in page for hidden balance refresh tabs. */
function balanceRefreshUrl(site: SiteConfig): string {
  // 历史站点可能只保存了 family/siteType，没有保存 checkin.url。此时沿用
  // 签到执行器的适配器入口：Sub2API（百倍）会进入 /check-in，才能读取
  // 「今日可得」台账；显式空 checkinPath 仍可关闭家族默认入口。
  const configured = site.checkin?.url?.trim() || adapterCheckinFallback(site);
  if (!configured) return site.loginUrl;
  try {
    const url = new URL(configured, site.loginUrl);
    return isSameSiteUrl(site, url.href) ? url.href : site.loginUrl;
  } catch {
    return site.loginUrl;
  }
}

function checkinRewardQuotaPerUnit(site: SiteConfig): number {
  if (site.adapter?.quotaPerUnit && site.adapter.quotaPerUnit > 0) return site.adapter.quotaPerUnit;
  return site.adapter?.family === 'new-api' ? 500_000 : 1;
}

/** 找一个停在目标站点上的标签页 */
async function findTabForSite(
  site: SiteConfig,
  options: { preferCheckinPage?: boolean } = {},
): Promise<number | undefined> {
  const origin = siteOrigin(site);
  if (!origin) return undefined;
  const tabs = await chrome.tabs.query({ url: `${origin}/*` }).catch(() => []);
  if (!options.preferCheckinPage) {
    // Session capture and other callers need the page the user is currently
    // viewing, even when the configured check-in route is different.
    return (tabs.find((tab) => tab.active) ?? tabs[0])?.id;
  }
  const refreshUrl = balanceRefreshUrl(site);
  const pageTab = tabs.find((tab) => samePagePath(tab.url, refreshUrl));
  // Prefer an already-open check-in page because it contains the daily ledger.
  if (pageTab) return pageTab.id;
  // If reward collection needs another route, open our own hidden tab instead
  // of navigating a page the user is currently viewing.
  if (!samePagePath(site.loginUrl, refreshUrl)) return undefined;
  return (tabs.find((tab) => tab.active) ?? tabs[0])?.id;
}

function samePagePath(left: string | undefined, right: string): boolean {
  if (!left) return false;
  try {
    const a = new URL(left);
    const b = new URL(right);
    const normalize = (path: string) => path.replace(/\/+$/, '') || '/';
    return a.origin === b.origin && normalize(a.pathname) === normalize(b.pathname);
  } catch {
    return false;
  }
}

type ProxyResolution =
  | {
      ok: true;
      proxy?: ProxyConfig;
    }
  | { ok: false; error: string };

/**
 * 决定这个账号该走哪个代理。
 *
 * 优先级：账号自己的设置 > 站点设置 > 直连。
 * 同一个站点的多个账号常常需要不同出口（不同地区/不同机房），
 * 所以代理配置要能下沉到账号级，而不是只能整站一个。
 */
async function resolveProxyForAccount(account: Account, site: SiteConfig): Promise<ProxyResolution> {
  const mode = account.proxyMode ?? 'inherit';

  if (mode === 'none') return { ok: true };

  if (mode === 'custom') {
    const custom = account.customProxy;
    if (!custom?.host || !custom.port) {
      return { ok: false, error: '账号选择了自定义代理，但地址或端口没填完整' };
    }
    return {
      ok: true,
      proxy: {
        // 账号内联代理不入全局池，id 只用于日志与租约标识
        id: `account:${account.id}`,
        name: `${custom.host}:${custom.port}`,
        scheme: custom.scheme,
        host: custom.host,
        port: custom.port,
        ...(custom.username ? { username: custom.username } : {}),
        ...(custom.password ? { password: custom.password } : {}),
      },
    };
  }

  const proxyId = mode === 'pool' ? account.proxyId : site.proxyId;
  if (!proxyId) {
    // pool 模式没选节点属于配置没填完；inherit 且站点也没配就是直连
    return mode === 'pool'
      ? { ok: false, error: '账号选择了「使用代理池节点」，但没有指定是哪个' }
      : { ok: true };
  }

  const proxies = await local.get<ProxyConfig[]>(KEYS.proxies, []);
  const proxy = proxies.find((p) => p.id === proxyId);
  if (!proxy) {
    return {
      ok: false,
      error: mode === 'pool'
        ? '账号配置的代理已不存在，请重新选择'
        : '站点配置的代理已不存在，请重新选择',
    };
  }
  // 历史数据可能曾把 nameOnly 写进账号或站点绑定。不能静默直连，也不能用同地区
  // 或跨地区的另一个出口顶替：两者都会让界面上的节点名与真实出口不一致。
  if (isNameOnlyProxy(proxy)) {
    return {
      ok: false,
      error: `「${proxy.name}」只是节点名称，没有浏览器能用的出口。请打开代理管理，选择 Clash Verge 配置并点击“同步配置”`,
    };
  }

  return { ok: true, proxy };
}

/** 打开站点登录页并把任务投进该 tab 的信箱 */

/**
 * 把任务标签页导航到站点，并**确认导航真的发生了**。
 *
 * 为什么不能只写一行 `chrome.tabs.update`：
 * 任务启动链（create → acquire → start → bindTab → update）全在 await 上，
 * MV3 的 Service Worker 可以在这条链的任意位置被回收。若在 bindTab 之后、
 * update 落地之前被打断，就会留下「队列有 active、任务信箱有任务、标签页却还是
 * about:blank」的僵尸：没有导航 → content script 拿不到任务 → 任务不会失败也不
 * 会推进，用户看到的是「签到一直转圈、logins=0」，要等 10 分钟看门狗才收。
 *
 * 因此这里做两件事：
 *  1. 导航前确认标签页还在（用户可能已经关掉它）；
 *  2. 导航后**回读 URL** 确认生效，失败时有界重试；仍然失败就抛错，
 *     让调用方的清理分支收尾（关标签页 + 落失败 + 释放租约）。
 */
async function navigateTaskTab(tabId: number, url: string): Promise<void> {
  const attempts = 5;
  let lastError = '标签页导航未生效';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('任务标签页已关闭');
    try {
      await chrome.tabs.update(tabId, { url });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
      continue;
    }
    // 回读确认：导航是异步的，给页面一点时间再核对当前 URL 是否已经落到目标站点。
    const expected = (() => {
      try { return new URL(url).origin; } catch { return null; }
    })();
    for (let wait = 0; wait < 10; wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const current = await chrome.tabs.get(tabId).catch(() => null);
      if (!current) throw new Error('任务标签页已关闭');
      const href = current.url ?? current.pendingUrl ?? '';
      if (expected && href && new URL(href).origin === expected) return;
      // about:blank 之外且已经不是空白 → 认为导航已发生（可能有重定向）
      if (href && href !== 'about:blank' && !href.startsWith('chrome://')) return;
    }
    lastError = '标签页导航后仍未离开空白页';
  }

  /**
   * 抛错之前先问一句：是不是本机代理端口没人监听。
   *
   * 只写「仍未离开空白页」是误诊：本地内核没启动时浏览器就是这个形状 ——
   * 页面永远停在空白页，navigation 既不成功也不报错。用户拿到的下一步会是
   * 「检查站点或网络」，而真正该做的是启动 Clash Verge / mihomo。
   *
   * 这里读回当前生效的扩展代理端点；只有它确实是回环地址时才换文案，
   * 远程代理或直连一律保留原文，不杜撞端口。
   */
  throw new Error(loopbackNavigationFailureMessage(
    lastError,
    await readAppliedProxyEndpoint().catch(() => null),
  ));
}

async function launchAccount(
  accountId: string,
  bindTab: (tabId: number) => Promise<void>,
): Promise<QueueLaunchResult> {
  const accounts = await local.get<Account[]>(KEYS.accounts, []);
  const account = accounts.find((a) => a.id === accountId);
  if (!account) return { ok: false, error: '账号不存在' };

  const userSites = await local.get<SiteConfig[]>(KEYS.sites, []);
  // 内置站点的用户覆盖必须逐层合并：旧覆盖记录可能缺少后来补进模板的
  // 字段（如 relogin 的 logoutApiUrl），整块取用户配置会让本可运行的
  // 站点被校验拦下，而界面上显示的是合并后的完整配置。
  const ownSite = configuredSite(account.siteId, userSites);
  if (!ownSite) return { ok: false, error: '站点配置不存在' };
  // 同一域名的另一张站点卡上学过流程时共用它；本卡缺登录成功标志 / 站点系统时
  // 也从同域名卡片补齐（见 shared-learned-flow.ts）。
  const sameOriginSites = sameOriginConfiguredSites(
    ownSite,
    userSites,
    await local.get<string[]>(KEYS.removedBuiltinSiteIds, []),
  );
  const shared = resolveSharedLearnedCheckin(ownSite, sameOriginSites);
  const recognition = inheritSameOriginRecognition(shared.site, sameOriginSites);
  const site = recognition.site;

  // 先合并账号级覆盖，再校验本次真正会执行的配置。只校验站点默认值会让
  // 「站点=form、账号=token 但没有 tokenConfig」一路启动后才在页面里失败。
  const methods = resolveEffectiveMethods(account, site);
  const credentialNeeds = loginCredentialNeeds(methods.loginMethod);
  if (credentialNeeds.password && !account.password) {
    return { ok: false, error: '该账号缺少站点密码；请编辑账号并选择「站点账号密码」后填写' };
  }
  if (credentialNeeds.github && (!account.githubUsername?.trim() || !account.githubPassword)) {
    return { ok: false, error: '该账号的 GitHub 用户名或密码不完整；请编辑账号后补齐' };
  }
  if (credentialNeeds.passkey && !account.passkey) {
    return { ok: false, error: '该账号未启用 Passkey；请编辑账号并确认登录方式' };
  }
  if (credentialNeeds.token
    && !account.apiToken?.trim()
    && !(credentialNeeds.sessionCounts && account.identity?.session?.accessToken)) {
    return { ok: false, error: '该账号没有可用的 API Token 或已抓取登录态' };
  }
  const siteForValidation: SiteConfig = {
    ...site,
    loginMethod: methods.loginMethod,
    checkin: { ...site.checkin, method: methods.checkinMethod },
  };
  const siteErrors = validateSiteConfig(siteForValidation);
  if (siteErrors.length) return { ok: false, error: `站点配置无效: ${siteErrors[0]}` };

  // 登录即签到的奖励发生在登录成功瞬间。先保留这个账号最近一次成功余额，
  // 不能等登录完成后再读，也不能从同站其它账号或浏览器当前会话推断。
  // 这里在真正 launch 时读取，而不是 enqueue 时读取，避免排队期间基线过期。
  const storedLoginCheckinBalance = methods.checkinMethod === 'none'
    ? (await local.get<Record<string, AccountBalance>>(KEYS.balances, {}))[account.id]
    : undefined;

  const siteAccounts = accountsSharingSiteOrigin(accounts, userSites, site);
  const externalIdentityLogin = methods.loginMethod === 'github'
    || methods.loginMethod === 'oauth'
    || methods.loginMethod === 'passkey';
  const reusableAccountIdentity = !externalIdentityLogin
    || account.identity?.source === 'api'
    // 受管 GitHub 亲自登录后读到的 ID：会话来源有据可查，与接口结果同等可信。
    || (methods.loginMethod === 'github' && account.identity?.verifiedByManagedLogin === true)
    ? account.identity
    : undefined;
  const duplicateIdentityOwner = account.identity?.userId
    ? siteAccounts.find((item) => (
        item.id !== account.id && item.identity?.userId === account.identity?.userId
      ))
    : undefined;

  // SiteAdapterRef belongs to the site and is therefore shared by every local
  // account. A configured adapter.userId is a valid legacy fallback only for a
  // single-account site. Multi-account runs must use the account-owned identity
  // or no ID at all; otherwise both browser and headless paths send one user's
  // compatibility header while processing another account.
  const taskUserId = duplicateIdentityOwner
    ? undefined
    : reusableAccountIdentity?.userId
      ?? (siteAccounts.length === 1 ? site.adapter?.userId : undefined);
  const siteForTask: SiteConfig = !site.adapter && !taskUserId
    ? site
    : site.adapter?.userId === taskUserId
      ? site
      : { ...site, adapter: { ...site.adapter, userId: taskUserId } };

  // 解析本次要用的代理（账号级优先于站点级）；代理是全局的，必须在开标签前生效
  const resolved = await resolveProxyForAccount(account, site);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const proxy = resolved.proxy;

  /**
   * 开标签/发请求之前，先确认这次的出口真的是这个账号的。
   *
   * 两个方向都要挡：
   *  1. 需要代理的账号 → 学习会话正持有全局代理时不能抢：抢走等于把别人的
   *     学习页/回放页换了出口，站点看到同一账号在两个 IP 间跳，学习时能打开
   *     的页面回放时也未必还能打开。
   *  2. 直连账号 → 浏览器此刻已被某条代理接管时不能开跑：那会让它在**别人的
   *     出口**上签到（队列已忙时追加的账号原本会绕过入队时的占用检查，就是这个
   *     窗口）。宁可让这一个账号如实失败，也不能拿错的出口去写签到记录。
   *
   * 判据统一收敛到 egressMismatchReason，文案与学习路径保持一致。
   */
  if (proxy) {
    const { active: learningSessions } = partitionLearningSessions(
      Object.entries(await chrome.storage.session.get(null)),
    );
    if (learningSessions.length > 0) {
      return { ok: false, error: '有账号正在学习流程，学习会话占用着网络配置；请先结束学习再开始签到（两者不能同时使用代理）' };
    }
  } else {
    const heldEndpoint = await readAppliedProxyEndpoint();
    if (heldEndpoint) {
      const reason = egressMismatchReason(undefined, heldEndpoint);
      if (reason) return { ok: false, error: reason };
    }
    /*
     * 扫描/测活会把全局代理在多个端口之间来回切，直连任务虽然自己不设代理，
     * 但它的请求同样会从扫描当前那一步的出口发出 —— 何况扫描结束时还会
     * clearProxy()，正好可能落在本任务的首个导航上。这里一并退让。
     */
    const tool = await networkToolBusy();
    if (tool) {
      return {
        ok: false,
        error: `${tool === 'scan' ? '本机端口扫描' : '代理测活'}正在使用网络配置，请完成后再开始签到`,
      };
    }
  }

  /*
   * 测活 / 端口扫描正在动全局代理时不能启动任务。
   *
   * 这两条路走 networkLocked + checkinQueue.busy()，但队列启动**不走**
   * networkLocked —— 它直接建标签页 + proxyLease.acquire。旧实现下用户点了
   * 扫描（几十秒，每端口切一次全局代理）再点签到，队列不会退让，acquire 的
   * applyProxy 会把扫描当前那一步的端点顶掉，两边报出来的出口都对不上。
   * 只在确实要挂代理时才检查：直连任务不碰全局设置，不必被扫描拦住。
   */
  if (proxy) {
    const tool = await networkToolBusy();
    if (tool) {
      return {
        ok: false,
        error: `${tool === 'scan' ? '本机端口扫描' : '代理测活'}正在使用网络配置，请完成后再开始签到`,
      };
    }
  }

  // chrome.proxy 是全局网络设置，只能在一个具体标签页的 lease 里安全持有。
  // Headless fetch also includes the domain's shared Chrome cookies. It cannot
  // prove which of several configured accounts owns that session, so every
  // multi-account site must use the visible browser flow and its identity gate.
  // workflow 明确要求执行浏览器 DOM 动作；接口签到成功不能替代后续答题、翻牌等步骤。
  // 学到的登录即签到同理：奖励来自登录本身，直连签到接口会绕开它。
  if (!usesLearnedCheckin(site)
    && !proxy
    && !duplicateIdentityOwner
    && siteAccounts.length === 1) {
    const headlessStats = await local.get<HeadlessStats>(KEYS.headlessStats, {});
    if (shouldTryHeadless(headlessStats, site.id, Date.now())) {
      const headless = await tryHeadlessCheckin(account, siteForTask);
      const nextStats = recordHeadlessOutcome(
        headlessStats,
        site.id,
        eligibilitySignalOf(headless.verdict),
        Date.now(),
      );
      await local.set(KEYS.headlessStats, nextStats);

      if (isHeadlessSuccess(headless.verdict)) {
        // 直连读到的余额必须落进独立存储。这条路不开标签页，所以浏览器流程里
        // 那个 saveBalance 钩子（见 automation/engine.ts）根本不会跑 —— 少了
        // 这一句，站点卡片和顶部合计只认 KEYS.balances，会显示「本站余额
        // 未获取」，而账号行却从 metrics.quotaAfter 读出一个数，两个口径打脸。
        if (headless.balance) {
          await appRepository.saveBalance(account.id, headless.balance);
        }
        const result: TaskResult = {
          accountId: account.id,
          ok: true,
          message: headless.message,
          steps: headless.steps,
          ...(headless.metrics ? { metrics: headless.metrics } : {}),
          via: 'headless',
        };
        return { ok: true, completedResult: result };
      }
      if (!isHeadlessBrowserFallbackSafe(headless.verdict)) {
        // 请求可能已经在站点落库。此时打开页面再执行签到会造成重复提交；
        // 如实记录“无法验证”，既不冒充成功，也不自动重试写操作。
        const result: TaskResult = {
          accountId: account.id,
          ok: false,
          message: headless.message,
          steps: headless.steps,
          ...(headless.metrics ? { metrics: headless.metrics } : {}),
          via: 'headless',
        };
        return { ok: true, completedResult: result };
      }
      // 其它 verdict 全部回退现有标签页流程。把原因放入 debug 日志，
      // 不把「直连失败」覆盖成最终失败：浏览器可能照常成功。
      console.info(`[headless] ${site.name}/${account.username}: ${headless.verdict} ${headless.message}`);
    }
  }

  const tab = await chrome.tabs.create({ url: 'about:blank', active: true }).catch(() => null);
  if (!tab || tab.id == null) return { ok: false, error: '无法创建标签页' };

  const taskCreatedAt = Date.now();
  const githubUsername = account.githubUsername?.trim();
  const loginCheckinBalanceBefore = loginCheckinBalanceBaseline(
    storedLoginCheckinBalance,
    taskCreatedAt,
  );
  const task: LoginTask = {
    tabId: tab.id,
    runId: uid('run'),
    accountId: account.id,
    siteId: site.id,
    username: account.username,
    password: account.password,
    ...(githubUsername ? { githubUsername } : {}),
    ...(account.githubPassword ? { githubPassword: account.githubPassword } : {}),
    ...(account.apiToken ? { apiToken: account.apiToken } : {}),
    // 抓来的会话是 token 站点的常规凭据来源，比手贴的 apiToken 优先
    ...(account.identity?.session ? { session: account.identity.session } : {}),
    site: siteForTask,
    effectiveLoginMethod: methods.loginMethod,
    effectiveCheckinMethod: methods.checkinMethod,
    usesExtensionProxy: !!proxy,
    ...(reusableAccountIdentity?.userId ? { accountIdentityUserId: reusableAccountIdentity.userId } : {}),
    ...(reusableAccountIdentity?.source === 'api' && reusableAccountIdentity.username
      ? { accountIdentityUsername: reusableAccountIdentity.username }
      : {}),
    ...(reusableAccountIdentity?.source === 'api' && reusableAccountIdentity.email
      ? { accountIdentityEmail: reusableAccountIdentity.email }
      : {}),
    // 读不到身份时，引擎靠这个数决定「能不能安全地继续签到」，见 engine.ts 的
    // externalIdentityLogin 分支：多账号站点必须停下来确认，不能盲签。
    siteAccountCount: siteAccounts.length,
    // 同站其它账号的 userId → 账号名，供身份核对的日志点名「登着的是谁」
    siteAccountUserIds: Object.fromEntries(
      siteAccounts
        .filter((item) => item.id !== account.id && item.identity?.userId)
        .map((item) => [item.identity!.userId!, item.label || item.username]),
    ),
    createdAt: taskCreatedAt,
    stage: 'login',
    ...(loginCheckinBalanceBefore
      ? { context: { loginCheckinBalanceBefore } }
      : {}),
    steps: [
      `扩展版本 ${runtimeVersion()}`,
      describeEffectiveMethods(methods),
      proxy
        ? (() => {
            const effective = effectiveProxyConfig(proxy);
            const correction = effective.scheme !== proxy.scheme ? '，已将本地 https 网关修正为 http' : '';
            // 标出代理是账号自己配的还是跟站点走的，排查串号时用得上
            const source = (account.proxyMode ?? 'inherit') === 'inherit' ? '站点' : '账号';
            const base = `已启用扩展代理「${proxy.name}」(${effective.scheme}://${effective.host}:${effective.port}${correction})，来自${source}配置`;
            return base;
          })()
        : '使用 Chrome/系统网络设置（扩展未覆盖代理）',
      ...(methods.checkinMethod === 'none'
        ? [loginCheckinBalanceBefore
            ? LOGIN_CHECKIN_BASELINE_LOADED_NOTE
            : loginCheckinBaselineStepNote(storedLoginCheckinBalance, taskCreatedAt)]
        : []),
      ...(duplicateIdentityOwner
        ? [`检测到旧数据冲突：站点用户 ID ${account.identity!.userId} 也绑定给账号 ${duplicateIdentityOwner.label || duplicateIdentityOwner.username}，已禁用 API 直连并改为页面重新核对`]
        : []),
      ...(shared.sharedFrom
        ? [`本站卡片还没学过签到流程，共用同一域名站点「${shared.sharedFrom.name}」上学到的流程`]
        : []),
      ...recognition.borrowed.map(({ field, from }) => (field === 'successIndicator'
        ? `本站卡片没有登录成功标志，借用同一域名站点「${from.name}」的设置`
        : `本站卡片没有站点系统信息，借用同一域名站点「${from.name}」的识别结果`)),
    ],
  };

  // 用 storage.session 当「信箱」：content script 注入后主动来取，
  // 避免 background 主动 send 时 content 尚未就绪导致丢消息。
  // 先建空白页再导航，确保代理已生效、信箱已就绪。
  try {
    if (proxy) {
      const got = await proxyLease.acquire(tab.id, proxy);
      if (!got) throw new Error('代理正被其他签到任务占用，请等它完成后再试');
    }
    await taskState.start(tab.id, task);
    await bindTab(tab.id);
    await navigateTaskTab(tab.id, site.loginUrl);
  } catch (error) {
    await taskState.remove(tab.id).catch(() => {});
    await removeTabUnlessLast(tab.id).catch(() => {});
    await proxyLease.release(tab.id).catch(() => {});
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  broadcast();

  return { ok: true, tabId: tab.id };
}

interface FinalizeRequest {
  tabId: number;
  runId?: string;
  accountId?: string;
  result?: TaskResult;
  failure?: string;
  closeTab?: boolean;
  requireActive?: boolean;
}

/**
 * 释放任务及其 OAuth 弹窗持有的全部代理租约。
 *
 * OAuth 授权常在 opener 已经收到回调后才关闭弹窗。此时任务的 tabId 仍
 * 指向 opener，但全局代理持有者可能已经是弹窗；只 release(opener) 会
 * 静默失败，下一账号就会被一扇看不见的代理租约挡住。
 * force 只给用户明确取消任务使用：此时 retained 弹窗也不得继续占用代理。
 */
async function releaseTaskProxy(tabId: number, force = false): Promise<void> {
  const popups = await oauthPopups.entriesOf(tabId);

  for (const [popupTabId, state] of popups) {
    if (!force && state.proxyRetained && state.proxyTransferred) {
      // opener 先关闭的路径已经把租约转给了仍活着的弹窗。这里故意不
      // clear/release：弹窗关闭事件会负责最终释放；冷启动恢复也靠该记录
      // 认出它是合法持有者。
      const alive = await chrome.tabs.get(popupTabId).then(() => true).catch(() => false);
      if (alive) {
        const holder = await proxyLease.holder();
        if (holder === tabId) await proxyLease.transfer(tabId, popupTabId).catch(() => false);
        if ((await proxyLease.holder()) === popupTabId) continue;
      }
      await oauthPopups.forget(popupTabId);
    }

    if (state.proxyTransferred) {
      await oauthPopups.clearProxyTransferred(popupTabId);
      await proxyLease.release(popupTabId);
    }
  }
  await proxyLease.release(tabId);
}

async function finalizeTab(request: FinalizeRequest): Promise<boolean> {
  return terminalLocked(async () => {
    const active = await checkinQueue.active();
    if (request.requireActive && (
      !active
      || active.tabId !== request.tabId
      || (request.accountId && active.accountId !== request.accountId)
    )) {
      return false;
    }

    const task = await taskState.take(request.tabId, request.runId, request.accountId);
    if (!task) return false;

    try {
      if (request.result) {
        await taskState.complete(request.result);
      } else {
        await taskState.fail(
          task.accountId,
          request.failure ?? '签到任务已中断',
          task.steps ?? [],
        );
      }
    } catch (error) {
      await taskState.put(request.tabId, task).catch(() => {});
      throw error;
    }

    if (request.closeTab) await closeTaskTabWithRetry(request.tabId);
    // 状态已经成功落库后，任何一项清理失败都不应阻止另一项，也不能让
    // TASK_RESULT 误报失败。逐项短重试，并保持先释放全局代理再推进队列。
    await retryTerminalCleanup('释放代理', () => releaseTaskProxy(request.tabId));
    await retryTerminalCleanup('推进签到队列', () => checkinQueue.finish(request.tabId));
    broadcast();

    return true;
  });
}

async function finishNavigationFailure(tabId: number, error: string): Promise<void> {
  const task = await taskState.get(tabId);
  if (!task) return;

  const usesExtensionProxy = task.usesExtensionProxy ?? !!task.site.proxyId;
  // 只有真正走扩展代理时才回读端点：没有代理却在报连接失败，编造一个端口会误导。
  const endpoint = usesExtensionProxy ? await readAppliedProxyEndpoint() : null;
  const message = navigationErrorMessage(error, usesExtensionProxy, endpoint);
  if (!message) return;

  await finalizeTab({
    tabId,
    runId: task.runId,
    accountId: task.accountId,
    failure: message,
    closeTab: true,
    requireActive: true,
  });
}

async function expireStaleTask(): Promise<void> {
  const active = await checkinQueue.active();
  if (!active || Date.now() - active.startedAt <= TASK_TIMEOUT_MS) return;

  /**
   * 「需处理」不是卡死：任务已如实收尾，只在等用户回来看，不该被超时看门狗
   * 连页带任务一起清掉。
   *
   * 曾经这条是漏的：NEEDS_USER 只写 attention、不碰队列，active 一直挂着，
   * 10 分钟后看门狗照关不误 —— 用户看到「提示要处理，过一会儿页面自己没了、
   * 浏览器也跟着退」。要处理的页面本来就是留给用户看的。
   */
  const attentionStatus = await taskState.statusOf(active.accountId);
  if (attentionStatus === 'attention') {
    // 但这个账号不能继续占着队列：让后面的站点照常往下跑。
    // 只释放队列和代理，**不覆盖** attention 状态与结果消息：那条消息正是
    // 用户回来要读的东西，写 fail 会把它抹掉，只留一句「等待用户处理」。
    await releaseTaskProxy(active.tabId).catch(() => {});
    await checkinQueue.finish(active.tabId);
    broadcast();
    return;
  }

  if (active.tabId > 0) {
    const finalized = await finalizeTab({
      tabId: active.tabId,
      accountId: active.accountId,
      failure: '签到超过 10 分钟未完成，后台已结束任务',
      closeTab: true,
      requireActive: true,
    });
    if (finalized) return;
  }

  await terminalLocked(async () => {
    const current = await checkinQueue.active();
    if (!current || current.accountId !== active.accountId || current.tabId !== active.tabId) return;
    if (current.tabId > 0) {
      await removeTabUnlessLast(current.tabId).catch(() => {});
      await releaseTaskProxy(current.tabId);
    }
    const status = await taskState.statusOf(current.accountId);
    if (status !== 'done' && status !== 'failed') {
      await taskState.fail(current.accountId, '签到任务状态丢失，后台已安全结束');
    }
    await checkinQueue.finish(current.tabId);
    broadcast();
  });
}

/**
 * 把「状态说在执行、实际没人在跑」的账号捞回待签到。
 *
 * expireStaleTask 只认队列里的 active，管不到这些孤儿：队列和任务信箱在
 * storage.session（浏览器重启即清空），状态台账在 storage.local（保留）。
 * 两边一错位，那一行就永远转圈到跨天，执行按钮还不出现 —— 用户看到的是
 * 「一直在执行、不支持重试」。判据见 background/stuck-tasks.ts。
 */
async function recoverOrphanRunning(): Promise<void> {
  const [statuses, queueState, sessionSnapshot] = await Promise.all([
    local.get<Record<string, string>>(KEYS.status, {}),
    session.get<QueueState>(QUEUE_KEY, { pendingAccountIds: [] }),
    chrome.storage.session.get(null),
  ]);

  const orphans = orphanRunningAccounts({
    statuses,
    day: todayKey(),
    activeAccountId: queueState.active?.accountId,
    pendingAccountIds: queueState.pendingAccountIds,
    liveAccountIds: collectLiveTasks(sessionSnapshot).map((task) => task.accountId),
  });
  if (orphans.length === 0) return;

  let recovered = 0;
  for (const accountId of orphans) {
    // clearInFlight 是 compare-and-set：万一这一瞬任务正好落定，不会覆盖结果。
    if (await taskState.clearInFlight(accountId)) recovered += 1;
  }
  if (recovered) broadcast();
}

/**
 * 回收某个站点残留的「先留着」任务页。
 *
 * 什么时候需要它：本站在 queue 里还有账号时页面会被登记保留，但本站剩下的
 * 账号如果是以失败 / 需人工 / 被取消收尾，成功路径的站点级收尾就永远不会再
 * 触发 —— 那些页面和登记项会永久留下。这里给失败与取消路径一个统一回收口。
 *
 * 只关本站登记过的页，且逐页走 last-tab 保护：绝不连窗口/浏览器一起关。
 */
async function releaseKeptSiteTabs(siteId: string | undefined): Promise<void> {
  if (!siteId) return;
  const kept = await takeKeptSiteTabs(siteId).catch(() => []);
  for (const keptTabId of kept) {
    await closeTaskTabWithRetry(keptTabId).catch(() => {});
  }
}

/** 通知管理页刷新（页面可能未打开，忽略投递失败） */
function broadcast(): void {
  chrome.runtime.sendMessage({ type: 'STATUS_CHANGED' } satisfies Message).catch(() => {});
}
