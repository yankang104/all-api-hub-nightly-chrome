import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, MotionConfig } from 'motion/react';
import {
  AlertTriangle,
  ArrowDownUp,
  CalendarClock,
  FileKey2,
  Globe2,
  Import,
  Loader2,
  Radio,
  Search,
  SquarePlus,
  Trash2,
  UserPlus,
  X,
  Zap,
} from 'lucide-react';
import type { Account, CheckinSchedule, DailyStatus, LearningKind, SiteConfig } from '@/types';
import { useAppStore } from '@/stores/app-store';
import { SiteCard } from './SiteCard';
import { SiteModal } from './SiteModal';
import { AddAccountModal } from './AddAccountModal';
import { PasswordImportModal } from './PasswordImportModal';
import { AccountBackupModal } from './AccountBackupModal';
import { resolvePendingIds, resolveSiteProxyBindings } from '@/lib/backup/account-backup';
import { planBookmarkSiteImport } from '@/lib/backup/bookmark-import';
import { resolveSharedLearnedCheckin } from '@/lib/checkin/shared-learned-flow';
import { ProxyNetworkPanel } from './ProxyNetworkPanel';
import { ScheduleModal } from './ScheduleModal';
import { Modal } from './Modal';
import { sendMessage } from '@/lib/core/messaging';
import { learningNoticeFromResponse, learningSavedToastText, type LearningNotice } from '@/lib/learning/learning-notice';
import type { WorkflowLearningPreview } from '@/types/workflow';

/**
 * 学习状态轮询的「立刻查一次」句柄。
 *
 * 无人录制时轮询退到 30 秒一次省电，但用户刚点「开始学习」的那一下不该干等：
 * 管理页挂载时把踢动函数登记进来，点击开始/结束后调用它并重置节奏。
 * 同一时刻只会有一个管理页实例在轮询，所以用模块级变量而不是 Context。
 */
let kickLearningPoll: (() => void) | null = null;
import { cn } from '@/lib/core/cn';
import { sortAccounts } from '@/lib/core/account-sort';
import { moveSiteIdInOrder, sortSites } from '@/lib/core/site-sort';
import { SiteSortToolbar } from './dashboard/SiteSortToolbar';
import { useSiteSortMode } from './dashboard/useSiteSortMode';
import { useAccountSortMode } from './dashboard/useAccountSortMode';
import { activateLaunchMode } from '@/lib/site/launch-mode';
import { ActionBtn } from './dashboard/ActionBtn';
import { EmptyState } from './dashboard/EmptyState';
import { LaunchModeSwitch } from './dashboard/LaunchModeSwitch';
import { SelectionToolbar } from './dashboard/SelectionToolbar';
import { TodayOverview, type StatusCounts } from './dashboard/TodayOverview';
import { LiveActivity } from './dashboard/LiveActivity';
import { sumBalances, displayBalanceOf } from '@/lib/balance/balance-format';
import { OrphanAccountsPanel } from './OrphanAccountsPanel';
import { PageShell, type ShellView } from './shell/PageShell';
import { ErrorBoundary } from './ErrorBoundary';
import { AccountsView, RecordsView } from './shell/views';

interface SiteSummary extends StatusCounts {
  site: SiteConfig;
  accounts: Account[];
}

type PendingDelete =
  | { kind: 'account'; id: string; name: string }
  | { kind: 'site'; id: string; name: string; accountCount: number };

const extensionManifest = chrome.runtime.getManifest();
const extensionVersion = extensionManifest.version_name ?? extensionManifest.version;

function countAccountStatus(accounts: Account[], statusOf: (accountId: string) => DailyStatus): StatusCounts {
  const counts = { total: accounts.length, done: 0, pending: 0, running: 0, attention: 0, failed: 0 };

  for (const account of accounts) {
    counts[statusOf(account.id)] += 1;
  }

  return {
    ...counts,
    actionable: counts.pending + counts.failed,
    progress: counts.total ? Math.round((counts.done / counts.total) * 100) : 0,
  };
}

export function App({ surface = 'page' }: { surface?: 'page' | 'sidepanel' }) {
  const {
    sites, accounts, proxies, status, live, queue, loading, launchMode, schedule,
    balances,
    load, setLaunchMode, syncLaunchMode, addSite, addSites, updateSite, moveSite, removeSite, removeMany,
    addAccount, addAccounts, updateAccount, removeAccount,
    addProxies, syncClashProxies, removeProxy, assignAccountProxies, setSchedule,
    statusOf, resultOf, balanceOf, refreshingBalances, refreshBalances, liveOf, isQueued, setStatus, markDone,
  } = useAppStore();
  const compact = surface === 'sidepanel';
  /** 独立管理页用 PageShell 分页；sidepanel 宽度太小，保持原单列。 */
  const [shellView, setShellView] = useState<ShellView>('overview');
  const shellEnabled = surface === 'page';
  const proxyNodeCount = useMemo(
    () => proxies.filter((proxy) => proxy.nameOnly !== true || proxy.sourceLabel === 'Clash Verge').length,
    [proxies],
  );

  const [siteModal, setSiteModal] = useState(false);
  const [siteModalMode, setSiteModalMode] = useState<'add' | 'import'>('add');
  const [accountSetupRequested, setAccountSetupRequested] = useState(false);
  const [pendingAccountSiteId, setPendingAccountSiteId] = useState<string | null>(null);
  const [editingSite, setEditingSite] = useState<SiteConfig | null>(null);
  const [accModal, setAccModal] = useState(false);
  const [passwordImportModal, setPasswordImportModal] = useState(false);
  const [backupModal, setBackupModal] = useState(false);
  const [accSiteId, setAccSiteId] = useState<string | undefined>();
  /** 正在编辑的账号，null 表示新建 */
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [scheduleModal, setScheduleModal] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedSiteIds, setSelectedSiteIds] = useState<Set<string>>(new Set());
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(new Set());
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [launchFxId, setLaunchFxId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [accountSortMode, setAccountSortMode] = useAccountSortMode();
  const [siteSortMode, setSiteSortMode] = useSiteSortMode();
  const [currentWindowId, setCurrentWindowId] = useState<number>();
  const launchTransitionBusy = useRef(false);
  const [launchTransitioning, setLaunchTransitioning] = useState(false);
  /** 正在录制签到流程的账号 → 已记录动作数。学习是跨页长流程，靠轮询保持界面可见。 */
  const [learningAccounts, setLearningAccounts] = useState<Map<string, LearningAccountState>>(() => new Map());
  /**
   * 各账号上一次「结束学习」的完整性自检结论（保存后由后台带回）。
   *
   * 用户下一步动作（重新开始学习 / 放弃）时清掉：过期结论留在行上比没有结论更误导。
   */
  const [learningNotices, setLearningNotices] = useState<Map<string, LearningNotice>>(() => new Map());
  /**
   * 各账号上一次「结束学习」时抓到的动作摘要（此时会话已经被后台清空）。
   *
   * 后台的结束响应里不带 preview，会话又会在保存后立刻消失 —— 不在这里留一份，
   * 用户点完「结束学习」就再也看不到「这次我做的哪几步被记住了」，只剩一句结论。
   */
  const [learnedSteps, setLearnedSteps] = useState<Map<string, WorkflowLearningPreview[]>>(() => new Map());
  /**
   * 同一时刻在录的账号集合（用 ref 保存，因为 handleLearn 里的异步分支需要
   * 读到**点击那一刻**的真实状态，不能依赖可能已经过期的闭包变量）。
   */
  const learningAccountIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    void load();
    // background 完成任务后广播，收到就刷新状态
    const listener = (msg: { type?: string }) => {
      if (msg?.type === 'STATUS_CHANGED') void load();
    };
    chrome.runtime.onMessage.addListener(listener);
    const storageListener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      const mode = changes.launchMode?.newValue;
      if (areaName === 'local' && (mode === 'sidepanel' || mode === 'tab')) syncLaunchMode(mode);
    };
    chrome.storage.onChanged.addListener(storageListener);
    return () => {
      chrome.runtime.onMessage.removeListener(listener);
      chrome.storage.onChanged.removeListener(storageListener);
    };
  }, [load, syncLaunchMode]);

  /**
   * 轮询录制状态。
   *
   * 录制期间用户在新标签页里手动签到，管理页收不到任何广播，只能主动问。
   * 没人录制时用很慢的节奏（30 秒）兜底，避免管理页长期开着空转；一旦发现有
   * 录制在跑就切到 3 秒，让「已记录几个动作」实时可见。
   */
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const schedule = (delayMs: number) => {
      timer = window.setTimeout(() => { void tick(); }, delayMs);
    };
    const tick = async () => {
      if (cancelled) return;
      const resp = await sendMessage({ type: 'GET_LEARNING' }).catch(() => null);
      if (cancelled) return;
      const next = new Map<string, LearningAccountState>();
      if (resp?.ok) {
        for (const session of resp.feature?.learningSessions ?? []) {
          next.set(session.accountId, {
            eventCount: session.eventCount,
            kind: session.kind ?? 'checkin',
            ...(session.preview ? { preview: session.preview } : {}),
            ...(session.guide ? { guide: session.guide } : {}),
            ...(session.loginAsCheckinAvailable ? { loginAsCheckinAvailable: true } : {}),
          });
        }
      }
      setLearningAccounts((prev) => (sameLearningMap(prev, next) ? prev : next));
      learningAccountIdsRef.current = new Set(next.keys());
      schedule(next.size > 0 ? 3_000 : 30_000);
    };
    /**
     * 把这段循环的「下一次查询」暴露出去：用户点开始/结束学习时必须**立刻**看到结果。
     *
     * 慢节奏（无人录制时 30 秒）是省电设计，但对刚点了「开始学习」的人来说，
     * 那 30 秒里账号行上什么动作都没有 —— 看起来就像功能没生效。学习是用户
     * 正盯着屏幕的阶段，宁可多问一次也别让他干等。
     */
    kickLearningPoll = () => {
      if (cancelled) return;
      if (timer !== undefined) window.clearTimeout(timer);
      void tick();
    };
    void tick();
    return () => {
      cancelled = true;
      kickLearningPoll = null;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  // 缓存当前窗口 ID。切换到侧栏时必须在 click 手势链路里同步调用
  // sidePanel.open，不能等异步读取窗口信息后再打开。
  useEffect(() => {
    const refreshWindowId = () => {
      void chrome.windows.getCurrent()
        .then((windowInfo) => {
          if (windowInfo.id != null) setCurrentWindowId(windowInfo.id);
        })
        .catch(() => {
          // 没有窗口信息时 activateLaunchMode 会使用 Chrome 的 current sentinel。
        });
    };
    refreshWindowId();
    chrome.windows.onFocusChanged.addListener(refreshWindowId);
    return () => chrome.windows.onFocusChanged.removeListener(refreshWindowId);
  }, []);

  // 新站点保存并关闭后再打开账号弹窗，避免两个独立 Modal 的进出动画叠在一起。
  useEffect(() => {
    if (siteModal || !pendingAccountSiteId) return;
    const siteId = pendingAccountSiteId;
    const timer = window.setTimeout(() => {
      setPendingAccountSiteId(null);
      setAccSiteId(siteId);
      setEditingAccount(null);
      setAccModal(true);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [pendingAccountSiteId, siteModal]);

  const sortedAccounts = useMemo(() => sortAccounts(accounts, accountSortMode), [accounts, accountSortMode]);
  const sortedSites = useMemo(() => sortSites(sites, siteSortMode), [sites, siteSortMode]);

  const siteSummaries = useMemo<SiteSummary[]>(() => {
    // status 必须在依赖里：statusOf 是稳定引用，仅靠它无法感知状态变化
    return sortedSites.map((site) => {
      const siteAccounts = sortedAccounts.filter((a) => a.siteId === site.id);
      return {
        site,
        accounts: siteAccounts,
        ...countAccountStatus(siteAccounts, statusOf),
      };
    });
    // live/queue 必须进依赖：实时进度更新时界面要跟着刷新
  }, [sortedAccounts, sortedSites, status, live, queue, statusOf]);

  const siteDisplayIndex = useMemo(
    () => new Map(siteSummaries.map((item, index) => [item.site.id, index])),
    [siteSummaries],
  );

  const knownSiteIds = useMemo(() => new Set(sites.map((site) => site.id)), [sites]);
  const orphanAccounts = useMemo(
    () => sortedAccounts.filter((account) => !knownSiteIds.has(account.siteId)),
    [sortedAccounts, knownSiteIds],
  );

  const proxyUsage = useMemo(() => {
    const siteProxy = new Map(sites.map((site) => [site.id, site.proxyId]));
    const usage = new Map<string, number>();
    for (const account of accounts) {
      const mode = account.proxyMode ?? 'inherit';
      const proxyId = mode === 'pool'
        ? account.proxyId
        : mode === 'inherit'
          ? siteProxy.get(account.siteId)
          : undefined;
      if (proxyId) usage.set(proxyId, (usage.get(proxyId) ?? 0) + 1);
    }
    return usage;
  }, [accounts, sites]);

  const filteredSiteSummaries = useMemo<SiteSummary[]>(() => {
    const query = search.trim().toLowerCase();
    if (!query) return siteSummaries;
    return siteSummaries.flatMap((summary) => {
      const siteText = `${summary.site.name} ${summary.site.loginUrl}`.toLowerCase();
      if (siteText.includes(query)) return [summary];
      const matchingAccounts = summary.accounts.filter((account) => (
        `${account.username} ${account.label ?? ''}`.toLowerCase().includes(query)
      ));
      return matchingAccounts.length
        ? [{ ...summary, accounts: matchingAccounts, ...countAccountStatus(matchingAccounts, statusOf) }]
        : [];
    });
  }, [search, siteSummaries, statusOf]);

  const filteredOrphanAccounts = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return orphanAccounts;
    return orphanAccounts.filter((account) => (
      `${account.username} ${account.label ?? ''} ${account.siteId}`.toLowerCase().includes(query)
    ));
  }, [orphanAccounts, search]);

  const stats = useMemo<StatusCounts>(() => {
    const base = siteSummaries.reduce(
      (sum, s) => ({
        total: sum.total + s.total,
        done: sum.done + s.done,
        pending: sum.pending + s.pending,
        running: sum.running + s.running,
        attention: sum.attention + s.attention,
        failed: sum.failed + s.failed,
      }),
      { total: 0, done: 0, pending: 0, running: 0, attention: 0, failed: 0 },
    );

    return {
      ...base,
      actionable: base.pending + base.failed,
      progress: base.total ? Math.round((base.done / base.total) * 100) : 0,
    };
  }, [siteSummaries]);

  const balanceTotal = useMemo(() => sumBalances(sites.flatMap((site) => {
    const adapterFamily = site.adapter?.family;
    return accounts
      .filter((account) => account.siteId === site.id)
      .map((account) => ({
        // 与站点卡片、账号行共用同一套回落，三处口径必须一致。
        balance: displayBalanceOf(balanceOf(account.id), resultOf(account.id)).balance,
        scale: { quotaPerUnit: site.adapter?.quotaPerUnit, family: adapterFamily },
      }));
  })), [accounts, sites, balances, balanceOf, resultOf]);

  const selectedSiteCount = selectedSiteIds.size;
  const selectedAccountCount = selectedAccountIds.size;
  const preservedSiteAccountCount = accounts.filter((account) => selectedSiteIds.has(account.siteId)).length;
  const selectedCount = selectedSiteCount + selectedAccountCount;
  /**
   * 「执行待签到」尊重当前搜索筛选：搜索词生效时只收集当前可见、且待签/失败的账号。
   * 无搜索词时等于全量，与之前行为一致；queued 语义保持不变（入队侧会跳过已排队账号）。
   */
  const visibleActionableAccountIds = useMemo(() => (
    filteredSiteSummaries.flatMap((summary) => summary.accounts
      .filter((account) => {
        const currentStatus = statusOf(account.id);
        return currentStatus === 'pending' || currentStatus === 'failed';
      })
      .map((account) => account.id))
  ), [filteredSiteSummaries, statusOf]);
  const modalOpen = siteModal || accModal || passwordImportModal || scheduleModal || deleteConfirmOpen || !!pendingDelete;

  async function handleRun(accountId: string) {
    const resp = await sendMessage({ type: 'START_LOGIN', accountId });
    if (!resp.ok) showToast(`启动失败: ${resp.error}`);
    // 队列跳过已在其中的账号。不说一声的话，点了执行什么都不发生，
    // 用户只会以为按钮坏了 —— 实际是这个账号还被上一轮任务占着。
    else if (resp.queued === 0) showToast('该账号已在执行或排队中，可先停止再重试');
    else setLaunchFxId(Date.now());
    void load();
  }

  /**
   * 停止正在执行/排队中的任务，可选择顺手重跑一次。
   *
   * 这是「卡在签到中」唯一的出口：状态改回待签到不够，队列还占着这个账号，
   * 再点执行会被静默跳过。真正的取消在 background（清任务信箱、清队列、
   * 关标签页、放代理租约），见 messages/control.ts。
   */
  async function stopCheckins(accountIds: string[], retry = false) {
    if (accountIds.length === 0) return;
    const resp = await sendMessage({ type: 'CANCEL_CHECKIN', accountIds });
    if (!resp.ok) {
      showToast(`停止失败: ${resp.error}`);
      return;
    }

    const stopped = resp.feature?.stopped ?? 0;
    if (!retry) {
      showToast(stopped ? `已停止 ${stopped} 个任务，可以重新执行了` : '这些账号当前没有在执行的任务');
      void load();
      return;
    }

    const started = await sendMessage({ type: 'START_BATCH', accountIds });
    void load();
    if (!started.ok) {
      showToast(`已停止，但重新执行失败: ${started.error}`);
      return;
    }
    setLaunchFxId(Date.now());
    showToast(started.queued ? `已停止并重新排队 ${started.queued} 个账号` : '已停止，但没有可重新执行的账号');
  }

  /**
   * 把状态改回待签到。
   *
   * 留给「签到被误判为成功」用：站点改了文案，扩展看到「已签到」字样就当
   * 成功了，用户得有办法推翻这个结论重跑一次。
   *
   * 卡住的任务（签到中 / 需人工处理）不走这里 —— 只改状态会留下一个假象：
   * 界面显示待签到，队列却还占着这个账号，点执行毫无反应。那种情况用
   * stopCheckins 真取消。
   */
  async function handleReset(accountId: string) {
    try {
      await setStatus(accountId, 'pending');
      showToast('已改回待签到，可以重新签到了');
    } catch (error) {
      showToast(`重置失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 手动标记今日已签到。
   *
   * 给那些扩展跑不过去的站点用：指纹不干净拿不到人机验证令牌、只能第三方
   * 登录、签到入口藏在活动页里 —— 用户自己在浏览器里点完了，得有个地方
   * 告诉扩展，否则「全部签到」每天都会再白跑一遍，概览完成度也一直是错的。
   */
  async function handleMarkDone(accountId: string) {
    try {
      await markDone(accountId);
      showToast('已标记为已签到，今天不再提醒');
    } catch (error) {
      showToast(`标记失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 抓取账号在浏览器里已登录的会话。
   *
   * 这是「只能 GitHub 登录」「登录要过人机验证」那些站点的解法：
   * 用户手动登录一次，把会话抓下来，之后签到不再需要登录。
   */
  async function handleCaptureSession(accountId: string) {
    const resp = await sendMessage({ type: 'CAPTURE_SESSION', accountId });
    if (!resp.ok) {
      showToast(`抓取失败: ${resp.error}`);
      return;
    }

    const captured = resp.feature?.captured;
    if (!captured) {
      showToast('没抓到登录凭据，请确认已在该站点登录');
      return;
    }

    void load();
    const who = captured.identity.email ?? captured.identity.username ?? captured.identity.userId;
    // 没有 refresh token 的会话过几小时就会失效，得提前告诉用户
    showToast(
      captured.session.refreshToken
        ? `已抓取登录态${who ? `（${who}）` : ''}，之后签到不用再登录`
        : `已抓取登录态${who ? `（${who}）` : ''}，但站点没给 refresh token，过期后需重新抓取`,
    );
  }

  async function handleLearn(
    accountId: string,
    kind: LearningKind,
    options?: { loginAsCheckin?: boolean },
  ): Promise<boolean> {
    /**
     * 这次点击是「结束学习」还是「开始学习」：状态里已经有该账号的会话就是结束。
     *
     * 只有结束这次才要抓摘要 —— 开始时直接复用返回的实时预览即可。
     */
    const finishing = learningAccountIdsRef.current.has(accountId);
    const snapshot = finishing ? await captureLearningPreview(accountId) : undefined;
    const resp = await sendMessage({
      type: 'TOGGLE_LEARNING',
      accountId,
      kind,
      ...(options?.loginAsCheckin ? { loginAsCheckin: true } : {}),
    });
    if (!resp.ok) {
      showToast(`学习失败: ${resp.error}`);
      return false;
    }
    const learning = resp.feature?.learning;
    if (learning?.active) {
      learningAccountIdsRef.current = new Set([...learningAccountIdsRef.current, accountId]);
      setLearningAccounts((prev) => {
        const next = new Map(prev);
        next.set(accountId, { eventCount: learning.eventCount, kind: learning.kind ?? kind, ...(learning.preview ? { preview: learning.preview } : {}) });
        return next;
      });
      // 重新开始学习：上一条完整性自检与动作摘要都已过期，先收起再重录。
      clearLearningNotice(accountId);
      clearLearnedSteps(accountId);
      // 立即拉一次会话状态：否则最坏要等 30 秒才在这行上看到「正在记录的动作」。
      kickLearningPoll?.();
      showToast(learning.kind === 'login'
        ? '已开始学习登录：点开始 → 手动登录 → 点结束。只保存安全选择器，不保存账号或密码内容'
        : '已开始学习本站流程：一次演示里先手动登录 → 再完成一次签到 → 点结束；登录配置与签到步骤会一起保存。全程不要点「退出登录」');
    } else if (learning?.saved) {
      const remainingIds = new Set(learningAccountIdsRef.current);
      remainingIds.delete(accountId);
      learningAccountIdsRef.current = remainingIds;
      setLearningAccounts((prev) => {
        const next = new Map(prev);
        next.delete(accountId);
        return next;
      });
      /**
       * 保存后的两件事：
       * 1) 在账号行上留下**完整性自检**（学到了什么 / 缺什么），那是用户下次回来时的依据；
       * 2) toast 只讲最关键的一条，全文留给账号行，避免一长串糊在一起。
       *
       * 结论由后台给出：优先 `learning.report`，缺省回落已有的 `learning.warnings`；
       * 两者都没有时什么都不显示 —— 不编一句「已保存」来凑数。
       */
      const notice = learningNoticeFromResponse(learning);
      setLearningNotices((prev) => {
        const next = new Map(prev);
        if (notice) next.set(accountId, notice);
        else next.delete(accountId);
        return next;
      });
      /**
       * 动作摘要随账号行留存：`snapshot` 是点「结束学习」前最后一刻抓到的实时预览。
       *
       * 抓不到就**不显示**（而不是沿用上一次的快照）—— 站点流程刚被这次学习覆盖，
       * 拿旧摘要顶替会让人以为那些动作是这次学到的。
       */
      setLearnedSteps((prev) => {
        const next = new Map(prev);
        if (snapshot && snapshot.length > 0) next.set(accountId, [...snapshot]);
        else next.delete(accountId);
        return next;
      });
      kickLearningPoll?.();
      /**
       * 如实说明这一轮**实际**保存了什么。
       *
       * 融合学习允许只完成一半（只登录、或本来就在登录态只有签到步骤）：
       * 后台用 `savedKinds` 告诉我们落了哪几份产物，缺的那半边走「部分保存」文案，
       * 绝不笼统地说一句「已保存」把用户蒙过去。
       */
      /**
       * 「存了什么 / 这次算不算完整 / toast 该怎么说」全部收敛到
       * learning-notice.ts 的两个纯函数里：判据必须按**意图**（intent）而不是
       * 兼容字段 kind —— 融合学习只存下登录时 kind 也回 'login'，据此会把
       * 学了一半说成「登录与签到都学会」。那里有单测逐条钉死这些分支。
       */
      showToast(learningSavedToastText(learning));
      void load();
    }
    return true;
  }

  /**
   * 结束学习前抓一份最新摘要。
   *
   * GET_LEARNING 拿到的是后台此刻落盘的会话；失败或还没落盘时回落到轮询状态里
   * 的预览（最多 3 秒前），保证「抓不到也不丢光」。两个来源都拿不到就如实不显示。
   */
  async function captureLearningPreview(accountId: string): Promise<WorkflowLearningPreview[] | undefined> {
    const resp = await sendMessage({ type: 'GET_LEARNING' }).catch(() => null);
    const session = (resp?.ok ? resp.feature?.learningSessions : undefined)?.find((item) => item.accountId === accountId);
    const preview = session?.preview ?? learningAccounts.get(accountId)?.preview;
    return preview && preview.length > 0 ? [...preview] : undefined;
  }

  /** 清掉某个账号学习结束时留下的动作摘要（重新开始 / 放弃学习时调用）。 */
  function clearLearnedSteps(accountId: string): void {
    setLearnedSteps((prev) => {
      if (!prev.has(accountId)) return prev;
      const next = new Map(prev);
      next.delete(accountId);
      return next;
    });
  }

  /** 清掉某个账号的完整性自检结论（重新开始 / 放弃学习时调用）。 */
  function clearLearningNotice(accountId: string): void {
    setLearningNotices((prev) => {
      if (!prev.has(accountId)) return prev;
      const next = new Map(prev);
      next.delete(accountId);
      return next;
    });
  }

  /** 放弃录制：清掉会话，不写入任何流程。 */
  async function handleCancelLearn(accountId: string) {
    const resp = await sendMessage({ type: 'CANCEL_LEARNING', accountId });
    if (!resp.ok) {
      showToast(`取消失败: ${resp.error}`);
      return;
    }
    const remainingIds = new Set(learningAccountIdsRef.current);
    remainingIds.delete(accountId);
    learningAccountIdsRef.current = remainingIds;
    setLearningAccounts((prev) => {
      const next = new Map(prev);
      next.delete(accountId);
      return next;
    });
    clearLearningNotice(accountId);
    clearLearnedSteps(accountId);
    kickLearningPoll?.();
    showToast('已放弃本次学习，站点配置未改动');
  }

  async function runMany(ids: string[]): Promise<{ ok: boolean; queued: number }> {
    if (ids.length === 0) return { ok: false, queued: 0 };
    const resp = await sendMessage({ type: 'START_BATCH', accountIds: ids });
    if (!resp.ok) {
      showToast(`批量启动失败: ${resp.error}`);
      return { ok: false, queued: 0 };
    }
    const queued = resp.queued ?? 0;
    setLaunchFxId(Date.now());
    void load();
    showToast(queued
      ? `已加入后台队列 ${queued} 个账号`
      : '这些账号已经在签到队列中');
    return { ok: true, queued };
  }

  /** 能被停下来的账号：正在跑的、等人工的，以及还排在队列里的 */
  const stoppableIdsOf = (siteId?: string) =>
    accounts
      .filter((a) => (siteId ? a.siteId === siteId : true))
      .filter((a) => {
        const s = statusOf(a.id);
        return s === 'running' || s === 'attention' || (s === 'pending' && isQueued(a.id));
      })
      .map((a) => a.id);

  const pendingIdsOf = (siteId?: string) =>
    accounts
      .filter((a) => (siteId ? a.siteId === siteId : knownSiteIds.has(a.siteId)))
      .filter((a) => {
        const s = statusOf(a.id);
        return s === 'pending' || s === 'failed';
      })
      .map((a) => a.id);

  async function recoverAccount(accountId: string, siteId: string) {
    const account = accounts.find((item) => item.id === accountId);
    const site = sites.find((item) => item.id === siteId);
    if (!account || !site) throw new Error('账号或目标站点已发生变化，请刷新后重试');
    await updateAccount(accountId, { siteId });
    showToast(`已将 ${account.label || account.username} 恢复到 ${site.name}；账号密码和代理已保留，旧站专属凭据已清除`);
  }

  async function handleSingleDelete() {
    if (!pendingDelete || deleting) return;
    const target = pendingDelete;
    setDeleting(true);
    try {
      if (target.kind === 'account') {
        await removeAccount(target.id);
        showToast(`已删除账号 ${target.name}`);
      } else {
        await removeSite(target.id);
        showToast(target.accountCount
          ? `已删除站点 ${target.name}，${target.accountCount} 个账号已移到待恢复账号`
          : `已删除站点 ${target.name}`);
      }
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  }

  function openAddSite(forAccount = false) {
    setEditingSite(null);
    setSiteModalMode('add');
    setAccountSetupRequested(forAccount);
    setSiteModal(true);
  }

  function openSiteImport() {
    setEditingSite(null);
    setSiteModalMode('import');
    setAccountSetupRequested(false);
    setSiteModal(true);
  }

  function openAddAccount(siteId?: string) {
    setEditingAccount(null);
    if (sites.length === 0) {
      setAccSiteId(undefined);
      openAddSite(true);
      return;
    }
    setAccSiteId(siteId);
    setAccModal(true);
  }

  async function addSiteAndContinueToAccount(data: Omit<SiteConfig, 'id'>) {
    const previousIds = new Set(useAppStore.getState().sites.map((site) => site.id));
    await addSite(data);
    const currentSites = useAppStore.getState().sites;
    const created = currentSites.find((site) => (
      !previousIds.has(site.id) && site.loginUrl.trim() === data.loginUrl.trim()
    )) ?? currentSites.find((site) => !previousIds.has(site.id));

    if (!created) {
      showToast('站点已保存，请从站点卡片添加账号');
      return;
    }
    setPendingAccountSiteId(created.id);
  }

  async function handleLaunchModeChange(mode: 'sidepanel' | 'tab') {
    const alreadyAtSurface = mode === 'tab' ? surface === 'page' : surface === 'sidepanel';
    if (launchTransitionBusy.current || (mode === launchMode && alreadyAtSurface)) return;
    const previousMode = launchMode;
    launchTransitionBusy.current = true;
    setLaunchTransitioning(true);

    const errorText = (reason: unknown, fallback: string) => (
      reason instanceof Error ? reason.message : fallback
    );

    try {
      if (mode === 'sidepanel') {
        // sidePanel.open 必须在第一次 await 前启动；持久化失败时会尽力关闭
        // 刚打开的面板，避免视觉状态和保存状态分叉。
        const activation = activateLaunchMode(mode, surface, currentWindowId);
        const persistence = setLaunchMode(mode);
        const [saved, activated] = await Promise.allSettled([persistence, activation]);

        if (saved.status === 'rejected') {
          if (activated.status === 'fulfilled' && previousMode === 'tab') {
            await activateLaunchMode('tab', surface, currentWindowId).catch(() => {});
          }
          showToast(`启动模式保存失败：${errorText(saved.reason, '请重试')}`);
          return;
        }
        if (activated.status === 'rejected') {
          showToast(`模式已保存，但当前界面未能立即切换：${errorText(activated.reason, '请点击扩展图标重试')}`);
          return;
        }
        showToast('已切换并打开侧边栏');
        return;
      }

      // 切到独立页不依赖用户手势，先保存成功再迁移当前界面，保存失败时
      // 不会出现“页面已经换了但仍是旧模式”的半完成状态。
      try {
        await setLaunchMode(mode);
      } catch (error) {
        showToast(`启动模式保存失败：${errorText(error, '请重试')}`);
        return;
      }

      try {
        const activated = await activateLaunchMode(mode, surface, currentWindowId);
        if (!activated.sidePanelClosed) {
          showToast('独立页模式已开启；当前 Chrome 版本请手动关闭侧栏');
        } else {
          showToast('已切换并打开独立页面');
        }
      } catch (error) {
        showToast(`模式已保存，但当前界面未能立即切换：${errorText(error, '请点击扩展图标重试')}`);
      }
    } finally {
      launchTransitionBusy.current = false;
      setLaunchTransitioning(false);
    }
  }

  function clearSelection() {
    setSelectedSiteIds(new Set());
    setSelectedAccountIds(new Set());
  }

  function toggleSelectionMode() {
    if (selectionMode) clearSelection();
    setSelectionMode((value) => !value);
    setDeleteConfirmOpen(false);
  }

  function toggleSiteSelection(siteId: string) {
    const site = sites.find((item) => item.id === siteId);
    if (!site || site.builtin) return;

    const selecting = !selectedSiteIds.has(siteId);
    setSelectedSiteIds((current) => {
      const next = new Set(current);
      if (selecting) next.add(siteId);
      else next.delete(siteId);
      return next;
    });
    if (selecting) {
      setSelectedAccountIds((current) => {
        const next = new Set(current);
        accounts.filter((account) => account.siteId === siteId).forEach((account) => next.delete(account.id));
        return next;
      });
    }
  }

  function toggleAccountSelection(accountId: string) {
    const account = accounts.find((item) => item.id === accountId);
    if (!account || selectedSiteIds.has(account.siteId)) return;

    setSelectedAccountIds((current) => {
      const next = new Set(current);
      if (next.has(accountId)) next.delete(accountId);
      else next.add(accountId);
      return next;
    });
  }

  function selectAllDeletable() {
    const siteIds = new Set(sites.filter((site) => !site.builtin).map((site) => site.id));
    setSelectedSiteIds(siteIds);
    // 未归属账号不在站点卡片里，不能被「全选」暗中选中并删除。
    setSelectedAccountIds(new Set());
  }

  async function handleBulkDelete() {
    if (selectedCount === 0) return;
    const siteIds = [...selectedSiteIds];
    const accountIds = [...selectedAccountIds];
    setDeleting(true);
    try {
      await removeMany(siteIds, accountIds);
      setDeleteConfirmOpen(false);
      setSelectionMode(false);
      clearSelection();
      showToast(preservedSiteAccountCount
        ? `已删除 ${siteIds.length} 个站点、${selectedAccountCount} 个账号；${preservedSiteAccountCount} 个站点账号已保留待恢复`
        : `已删除 ${siteIds.length} 个站点、${selectedAccountCount} 个账号`);
    } finally {
      setDeleting(false);
    }
  }

  const visualPhase = stats.running > 0
    ? 'running'
    : stats.attention > 0
      ? 'attention'
      : stats.failed > 0
        ? 'failed'
        : 'idle';

  return (
    /*
     * reducedMotion="user" 让所有 motion 组件跟随系统的「减少动态效果」偏好。
     *
     * tailwind.css 里那段全局 reduce 规则只压得住 CSS 动画 —— motion 13 默认是
     * reducedMotion: "never"，JS 驱动的 inline transform 完全不受影响。实测在
     * reduce 偏好下点启动模式开关，旋钮飞行中仍然有 translateX 中间态。
     * 包这一层后 motion 会自动跳过位移/缩放/旋转，只保留 opacity 过渡 ——
     * 状态变化仍然看得见，只是不再有运动。
    */
    <MotionConfig reducedMotion="user">
    <ErrorBoundary>
    <div className={cn('min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-50', compact && 'min-h-full')} data-phase={visualPhase}>

      <PageShell
        shellVisible={!compact}
        view={shellView}
        onViewChange={setShellView}
        search={search}
        onSearchChange={setSearch}
        status={{ version: extensionVersion, running: stats.running, attention: stats.attention, total: stats.total, done: stats.done }}
      >
      <AnimatePresence>
        {launchFxId !== null && (
          <LaunchBurst key={launchFxId} onDone={() => setLaunchFxId(null)} />
        )}
      </AnimatePresence>
      {shellEnabled && shellView === 'accounts' && (
        <div className='space-y-4'>
          <AccountsView
            sites={sites}
            accounts={accounts}
            statusOf={statusOf}
            balanceOf={balanceOf}
            refreshingBalanceIds={refreshingBalances}
            onRunAccount={(accountId) => { void handleRun(accountId); }}
            onRefreshBalance={(accountId) => { void refreshBalances([accountId]).catch((error: unknown) => showToast(error instanceof Error ? error.message : String(error))); }}
            onToast={showToast}
          />
        </div>
      )}
      {shellView === 'network' && (
        <ProxyNetworkPanel
          proxies={proxies}
          accounts={accounts}
          sites={sites}
          compact={compact}
          onReturn={() => setShellView('overview')}
          onAddMany={addProxies}
          onSyncClash={syncClashProxies}
          onRemove={removeProxy}
          onAssign={assignAccountProxies}
          onSetAccountProxy={async (accountId, patch) => updateAccount(accountId, patch)}
        />
      )}
      {shellEnabled && shellView === 'records' && (
        <RecordsView sites={sites} accounts={accounts} resultOf={resultOf} statusOf={statusOf} />
      )}
      {shellEnabled && shellView === 'settings' && (
        <section className='rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-950'>
          <h1 className='text-base font-bold tracking-tight'>设置</h1>
          <p className='mt-1.5 text-[11px] text-ink-800/55 dark:text-ink-100/50'>扩展打开方式、站点与账号排序在总览页顶部工具栏。</p>
        </section>
      )}
      <div className={(shellEnabled && shellView !== 'overview' && shellView !== 'sites') || (compact && shellView === 'network') ? 'hidden' : undefined}>
          <div className={cn(
            'relative z-10 mx-auto px-4 pt-5 pb-7 sm:px-5 sm:pt-6',
            compact ? 'max-w-none px-3 pt-4 sm:px-3 sm:pt-4' : 'w-full max-w-none',
            selectionMode && 'pb-28',
          )}>
            <motion.header
              initial={{ opacity: 0, y: -12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: 'spring', stiffness: 320, damping: 28, delay: 0.04 }}
              className={cn(
                'relative z-20 mb-5 flex flex-wrap items-center rounded-xl border border-slate-200 bg-white px-3.5 py-3.5 shadow-sm dark:border-slate-800 dark:bg-slate-950',
                (stats.running > 0 || stats.attention > 0) && 'border-blue-200 dark:border-blue-900',
                compact ? 'gap-3' : 'gap-4 sm:px-4 sm:py-4',
              )}
            >
              <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-blue-600 text-sm font-bold text-white shadow-sm shadow-blue-600/20" aria-hidden="true">签</div>

              <div className="min-w-0 flex-1 sm:min-w-[260px]">
                <h1 className={cn('flex min-w-0 items-center gap-2 font-bold tracking-tight', compact ? 'flex-wrap text-base' : 'text-lg')}>
                  <span className={cn(compact ? 'basis-full whitespace-nowrap' : 'truncate')}>签到管理台</span>
                  <span
                    title="当前扩展构建版本"
                    className="shrink-0 rounded-md bg-slate-900 px-1.5 py-0.5 text-[9px] font-semibold text-white dark:bg-slate-100 dark:text-slate-900"
                  >
                    v{extensionVersion}
                  </span>
                  {(stats.running > 0 || stats.attention > 0) && (
                    <motion.span
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[9px] font-bold text-blue-700 dark:bg-blue-950/50 dark:text-blue-300"
                    >
                      <Radio className="size-2.5 animate-pulse" /> LIVE
                    </motion.span>
                  )}
                </h1>
                <p className="text-xs text-ink-800/50 dark:text-ink-100/40">
                  今日 {stats.done}/{stats.total} 已完成
                  {stats.pending > 0 && <span className="ml-1 text-amber-600 dark:text-amber-400">· {stats.pending} 个待签到</span>}
                  {stats.running > 0 && <span className="ml-1 text-brand-600 dark:text-brand-400">· {stats.running} 个进行中</span>}
                  {stats.attention > 0 && <span className="ml-1 text-cyan-700 dark:text-cyan-300">· {stats.attention} 个需处理</span>}
                  {stats.failed > 0 && <span className="ml-1 text-rose-600 dark:text-rose-400">· {stats.failed} 个失败</span>}
                </p>
              </div>

              <div className={cn(
                'flex w-full flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-1.5 dark:border-slate-800 dark:bg-slate-900/60',
                compact ? 'justify-start' : 'justify-end lg:w-auto',
              )}>
                <label className={cn('relative min-w-[160px] flex-1', !compact && 'lg:w-56 lg:flex-none')}>
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-800/35 dark:text-ink-100/35" />
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="搜索站点、账号或备注"
                    aria-label="搜索站点、账号或备注"
                    className="h-8 w-full rounded-md border border-black/8 bg-white py-1 pl-8 pr-7 text-[11px] text-ink-900 outline-none placeholder:text-ink-800/35 focus:border-brand-500/50 focus:ring-2 focus:ring-brand-500/15 dark:border-white/10 dark:bg-ink-900 dark:text-ink-50 dark:placeholder:text-ink-100/30"
                  />
                  {search && (
                    <button type="button" onClick={() => setSearch('')} aria-label="清空搜索" className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-ink-800/40 hover:bg-black/5 hover:text-ink-800 dark:text-ink-100/40 dark:hover:bg-white/10 dark:hover:text-ink-100">
                      <X className="size-3" />
                    </button>
                  )}
                </label>
                <SiteSortToolbar
                  value={siteSortMode}
                  onChange={(mode) => {
                    void setSiteSortMode(mode).catch(() => showToast('站点排序已切换，但偏好保存失败，请重试'));
                  }}
                  accountSortMode={accountSortMode}
                  onAccountSortChange={(mode) => {
                    void setAccountSortMode(mode).catch(() => showToast('账号排序已切换，但偏好保存失败，请重试'));
                  }}
                />
                <LaunchModeSwitch
                  mode={launchMode}
                  compact={compact}
                  surface={surface}
                  disabled={launchTransitioning}
                  onChange={handleLaunchModeChange}
                />
                {stats.actionable > 0 && (
                  <ActionBtn
                    icon={<Zap className="size-4" />}
                    label={`全部签到 (${stats.actionable})`}
                    accent
                    compact={compact}
                    onClick={() => runMany(pendingIdsOf())}
                  />
                )}
                <ActionBtn
                  icon={<Globe2 className="size-4" />}
                  label={proxyNodeCount ? `代理 (${proxyNodeCount})` : '代理'}
                  compact={compact}
                  onClick={() => setShellView('network')}
                />
                <ActionBtn
                  icon={<ArrowDownUp className="size-4" />}
                  label="备份迁移"
                  compact={compact}
                  onClick={() => setBackupModal(true)}
                />
                <ActionBtn
                  icon={<CalendarClock className="size-4" />}
                  label={schedule.enabled ? `定时 ${schedule.time}` : '定时签到'}
                  primary={schedule.enabled}
                  compact={compact}
                  onClick={() => setScheduleModal(true)}
                />
                <ActionBtn
                  icon={<SquarePlus className="size-4" />}
                  label="添加站点"
                  compact={compact}
                  onClick={() => openAddSite()}
                />
                <ActionBtn
                  icon={<Import className="size-4" />}
                  label="从书签导入"
                  compact={compact}
                  onClick={openSiteImport}
                />
                <ActionBtn
                  icon={<UserPlus className="size-4" />}
                  label="添加账号"
                  primary
                  compact={compact}
                  onClick={() => openAddAccount()}
                />
                <ActionBtn
                  icon={<FileKey2 className="size-4" />}
                  label="导入账号"
                  compact={compact}
                  onClick={() => {
                    if (sites.length === 0) {
                      showToast('请先添加或导入站点，再导入账号');
                      return;
                    }
                    setPasswordImportModal(true);
                  }}
                />
                {sites.length > 0 && (
                  <ActionBtn
                    icon={selectionMode ? <X className="size-4" /> : <Trash2 className="size-4" />}
                    label={selectionMode ? '退出批量' : '批量删除'}
                    danger={selectionMode}
                    compact={compact}
                    onClick={toggleSelectionMode}
                  />
                )}
              </div>
            </motion.header>

            <AnimatePresence initial={false}>
              <LiveActivity
                accounts={accounts}
                sites={sites}
                live={live}
                queue={queue}
                compact={compact}
                statusOf={statusOf}
                onStopAll={() => { void stopCheckins(stoppableIdsOf()); }}
              />
            </AnimatePresence>

            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: 'spring', stiffness: 300, damping: 30, delay: 0.1 }}
            >
              <TodayOverview
                stats={stats}
                balanceTotal={balanceTotal}
                onRunAll={() => runMany(visibleActionableAccountIds)}
                actionableCount={visibleActionableAccountIds.length}
                searchScoped={search.trim().length > 0}
                compact={compact}
              />
            </motion.div>

            {loading ? (
              <div className="py-20 text-center text-sm text-ink-800/40 dark:text-ink-100/30">加载中...</div>
            ) : (
              <>
                {filteredOrphanAccounts.length > 0 && (
                  <OrphanAccountsPanel
                    accounts={filteredOrphanAccounts}
                    sites={sites}
                    compact={compact}
                    onRecover={recoverAccount}
                    onAddSite={() => openAddSite()}
                  />
                )}
                {sites.length === 0 ? (
                  <EmptyState
                    onAdd={() => openAddSite()}
                    onImport={openSiteImport}
                  />
                ) : (
                  <motion.div
                    layout
                    initial="hidden"
                    animate="show"
                    variants={{
                      hidden: {},
                      show: { transition: { staggerChildren: 0.055, delayChildren: 0.14 } },
                    }}
                    className="grid gap-4 lg:grid-cols-2"
                  >
                    <AnimatePresence mode="popLayout">
                      {filteredSiteSummaries.map(({ site, accounts: siteAccounts }) => (
                    <SiteCard
                      key={site.id}
                      site={site}
                      sharedFlowFrom={resolveSharedLearnedCheckin(site, sites).sharedFrom}
                      accounts={siteAccounts}
                      proxy={proxies.find((p) => p.id === site.proxyId)}
                      proxies={proxies}
                      proxyUsage={proxyUsage}
                      statusOf={statusOf}
                      resultOf={resultOf}
                      liveOf={liveOf}
                      balanceOf={balanceOf}
                      refreshingBalanceIds={refreshingBalances}
                      onRefreshBalances={(accountIds) => { void refreshBalances(accountIds).catch((error: unknown) => showToast(error instanceof Error ? error.message : String(error))); }}
                      isQueued={isQueued}
                      onRun={handleRun}
                      onRunAll={(siteId) => runMany(pendingIdsOf(siteId))}
                      onStopAll={(siteId) => { void stopCheckins(stoppableIdsOf(siteId)); }}
                      onResetAccount={handleReset}
                      onStopAccount={(accountId) => { void stopCheckins([accountId]); }}
                      onRetryAccount={(accountId) => { void stopCheckins([accountId], true); }}
                      onMarkAccountDone={handleMarkDone}
                      onCaptureSession={handleCaptureSession}
                      onLearnAccount={handleLearn}
                      learningAccounts={learningAccounts}
                      learningNotices={learningNotices}
                      learnedSteps={learnedSteps}
                      onCancelLearnAccount={(accountId) => { void handleCancelLearn(accountId); }}
                      onEditAccount={(account) => {
                        setEditingAccount(account);
                        setAccModal(true);
                      }}
                      onSetAccountProxy={async (accountId, patch) => {
                        try {
                          await updateAccount(accountId, patch);
                          showToast(patch.proxyMode === 'pool'
                            ? patch.proxyPinned === false ? '已取消手动固定，后续可由自动分配调整' : '已固定该账号的代理节点'
                            : patch.proxyMode === 'none' ? '该账号已设为直连' : '该账号已改为跟随站点代理');
                        } catch (error) {
                          showToast(error instanceof Error ? error.message : String(error));
                        }
                      }}
                      onRemoveAccount={(accountId) => {
                        const account = accounts.find((item) => item.id === accountId);
                        if (account) setPendingDelete({ kind: 'account', id: account.id, name: account.label || account.username });
                      }}
                      onAddAccount={openAddAccount}
                      onEditSite={(s) => {
                        setEditingSite(s);
                        setSiteModalMode('add');
                        setAccountSetupRequested(false);
                        setSiteModal(true);
                      }}
                      onRemoveSite={(siteId) => {
                        const target = sites.find((item) => item.id === siteId);
                        if (target) {
                          setPendingDelete({
                            kind: 'site',
                            id: target.id,
                            name: target.name,
                            accountCount: accounts.filter((account) => account.siteId === target.id).length,
                          });
                        }
                      }}
                      canMoveUp={(siteDisplayIndex.get(site.id) ?? 0) > 0}
                      canMoveDown={(siteDisplayIndex.get(site.id) ?? 0) < siteSummaries.length - 1}
                      onMove={(siteId, direction) => {
                        // 字母排序下也允许手动微调：先算好「当前可见顺序移动一步」的完整顺序，
                        // 再交给后台落盘并切到手动顺序，避免下一轮按名称重排又弹回去。
                        const visibleIds = new Set(filteredSiteSummaries.map((item) => item.site.id));
                        const orderedIds = moveSiteIdInOrder(
                          siteSummaries.map((item) => item.site.id),
                          siteId,
                          direction,
                          visibleIds,
                        );
                        void moveSite(siteId, direction, orderedIds)
                          .then(() => {
                            if (siteSortMode !== 'manual') {
                              void setSiteSortMode('manual').catch(() => showToast('顺序已调整，但偏好保存失败'));
                            }
                          })
                          .catch(() => showToast('站点顺序调整失败，请重试'));
                      }}
                      searchActive={search.trim().length > 0}
                      selectionMode={selectionMode}
                      siteSelected={selectedSiteIds.has(site.id)}
                      selectedAccountIds={selectedAccountIds}
                      onToggleSite={toggleSiteSelection}
                      onToggleAccount={toggleAccountSelection}
                    />
                      ))}
                    </AnimatePresence>
                  </motion.div>
                )}
              </>
            )}
          </div>
      </div>
      </PageShell>

      <SiteModal
        open={siteModal}
        mode={siteModalMode}
        editing={editingSite}
        accountSetupRequested={accountSetupRequested}
        sites={sites}
        proxies={proxies}
        onClose={() => {
          setSiteModal(false);
          setAccountSetupRequested(false);
        }}
        onSubmitMany={async (inputs, options) => {
          const currentSites = useAppStore.getState().sites;
          const plan = planBookmarkSiteImport(inputs, currentSites, options);
          const previousIds = new Set(useAppStore.getState().sites.map((site) => site.id));
          let updated = 0;
          for (const update of plan.updates) {
            try {
              await updateSite(update.siteId, update.patch);
              updated += 1;
            } catch {
              // One stale or invalid match must not cancel the rest of the batch.
            }
          }
          if (plan.additions.length > 0) await addSites(plan.additions);
          const added = useAppStore.getState().sites.filter((site) => !previousIds.has(site.id)).length;
          const skipped = Math.max(0, inputs.length - added - updated);
          showToast(`书签导入完成：新增 ${added} 个，更新 ${updated} 个，跳过 ${skipped} 个`);
          return { added, updated, skipped };
        }}
        onSubmit={async (data) => {
          if (editingSite) {
            await updateSite(editingSite.id, data);
            showToast('站点设置已保存');
          } else {
            await addSite(data);
            showToast('站点已添加');
          }
        }}
        onSubmitAndAddAccount={addSiteAndContinueToAccount}
      />
      <AddAccountModal
        open={accModal}
        sites={sites}
        proxies={proxies}
        defaultSiteId={accSiteId}
        editing={editingAccount}
        onClose={() => {
          setAccModal(false);
          setEditingAccount(null);
        }}
        onSubmit={async (input) => {
          if (editingAccount) {
            await updateAccount(editingAccount.id, input);
            showToast('账号设置已保存');
          } else {
            await addAccount(input);
            showToast('账号已添加');
          }
        }}
      />
      <PasswordImportModal
        open={passwordImportModal}
        sites={sites}
        accounts={accounts}
        onClose={() => setPasswordImportModal(false)}
        onImport={async (inputs) => {
          const result = await addAccounts(inputs);
          showToast(result.skipped > 0
            ? `已导入 ${result.added} 个账号，跳过 ${result.skipped} 个重复项`
            : `已导入 ${result.added} 个匹配账号`);
        }}
      />
      <AccountBackupModal
        open={backupModal}
        sites={sites}
        accounts={accounts}
        proxies={proxies}
        onClose={() => setBackupModal(false)}
        onImport={async (plan) => {
          /*
           * 三步落地：代理 → 站点 → 账号。
           *
           * 顺序是必须的：账号和站点的代理绑定要指向真实的 proxyId，所以代理得先
           * 存在。`addProxies` / `addSites` 都不返回新建条目的 id 映射，只能在它们
           * 内部 load() 刷新 store 之后重读一次，把占位符换成真实 id。
           *
           * 刻意不合成一个原子事务：这几个方法各自已经加锁，硬要合并就得动
           * MUTATE_APP 契约。中途失败的后果是「代理/站点建好了但账号没进来」，
           * 用户重跑一次导入即可（都会被判重跳过），不会产生错数据。
           */
          // 按 id 差集数新建条目，而不是比较长度：闭包里的 sites/proxies 是渲染时的
          // 快照，与落地后的 store 之间可能已经隔了别的刷新。
          const beforeProxyIds = new Set(useAppStore.getState().proxies.map((proxy) => proxy.id));
          if (plan.newProxies.length > 0) await addProxies(plan.newProxies);

          const previousSiteIds = new Set(useAppStore.getState().sites.map((site) => site.id));
          if (plan.newSites.length > 0) await addSites(plan.newSites, true);

          const freshSites = useAppStore.getState().sites;
          const freshAccounts = useAppStore.getState().accounts;
          const freshProxies = useAppStore.getState().proxies;

          // 站点的代理绑定只能在两者都落地后补
          for (const patch of resolveSiteProxyBindings(plan.siteProxyNames, freshSites, freshProxies)) {
            await updateSite(patch.siteId, { proxyId: patch.proxyId });
          }

          const { resolved, unresolved, duplicateCount, droppedProxyBindings } = resolvePendingIds(
            plan.accounts,
            freshSites,
            freshAccounts,
            freshProxies,
          );

          const result = resolved.length > 0
            ? await addAccounts(resolved, true)
            : { added: 0, skipped: 0 };

          const createdSites = freshSites.filter((site) => !previousSiteIds.has(site.id)).length;
          const createdProxies = freshProxies.filter((proxy) => !beforeProxyIds.has(proxy.id)).length;
          if (unresolved > 0) {
            showToast(`有 ${unresolved} 个账号所属的站点没能建立，请检查备份文件`);
          }
          const lostBindings = droppedProxyBindings + plan.unresolvedProxyBindings;
          if (lostBindings > 0) {
            showToast(`${lostBindings} 个账号的代理绑定找不到对应节点，已改为跟随站点`);
          }
          return {
            sites: createdSites,
            accounts: result.added,
            proxies: createdProxies,
            skipped: result.skipped + duplicateCount + plan.duplicateCount,
          };
        }}
      />
      <ScheduleModal
        open={scheduleModal}
        schedule={schedule}
        sites={sites}
        accounts={accounts}
        onClose={() => setScheduleModal(false)}
        onSave={async (next: CheckinSchedule) => {
          await setSchedule(next);
          showToast(next.enabled ? `定时签到已开启：${next.time}` : '定时签到已关闭');
        }}
      />

      <Modal open={deleteConfirmOpen} title="确认批量删除" onClose={() => !deleting && setDeleteConfirmOpen(false)}>
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-rose-500/12 text-rose-600 dark:text-rose-400">
              <AlertTriangle className="size-5" />
            </span>
            <div>
              <p className="text-sm font-semibold text-ink-900 dark:text-white">确认删除所选项目</p>
              <p className="mt-1 text-xs leading-5 text-ink-800/55 dark:text-ink-100/45">
                将删除 {selectedSiteCount} 个站点和 {selectedAccountCount} 个明确选中的账号。
                {preservedSiteAccountCount > 0
                  ? ` 所选站点下的 ${preservedSiteAccountCount} 个账号会保留到「待恢复账号」，不会丢失凭据。`
                  : ' 被删除账号的签到状态与执行记录也会一并清理。'}
              </p>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              disabled={deleting}
              onClick={() => setDeleteConfirmOpen(false)}
              className="h-9 rounded-lg px-3 text-xs font-medium text-ink-800 ring-1 ring-black/10 hover:bg-black/5 disabled:opacity-50 dark:text-ink-100 dark:ring-white/10 dark:hover:bg-white/10"
            >
              取消
            </button>
            <button
              type="button"
              disabled={deleting}
              onClick={() => void handleBulkDelete()}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-rose-500 px-3 text-xs font-semibold text-white shadow-lg shadow-rose-500/20 hover:bg-rose-600 disabled:opacity-50"
            >
              {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
              {deleting ? '正在删除' : '确认删除'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={!!pendingDelete}
        title={pendingDelete?.kind === 'site' ? '确认删除站点' : '确认删除账号'}
        onClose={() => !deleting && setPendingDelete(null)}
      >
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-rose-500/12 text-rose-600 dark:text-rose-400">
              <AlertTriangle className="size-5" />
            </span>
            <div>
              <p className="text-sm font-semibold text-ink-900 dark:text-white">
                {pendingDelete?.kind === 'site'
                  ? `删除站点「${pendingDelete.name}」？`
                  : `永久删除账号「${pendingDelete?.name ?? ''}」？`}
              </p>
              <p className="mt-1 text-xs leading-5 text-ink-800/55 dark:text-ink-100/45">
                {pendingDelete?.kind === 'site'
                  ? pendingDelete.accountCount > 0
                    ? `站点配置会删除，${pendingDelete.accountCount} 个账号及其凭据会保留到「待恢复账号」。`
                    : '该站点没有账号，删除后只移除站点配置。'
                  : '账号凭据、签到状态、执行记录和余额都会删除，当前没有历史回收站。'}
              </p>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              disabled={deleting}
              onClick={() => setPendingDelete(null)}
              className="h-9 rounded-lg px-3 text-xs font-medium text-ink-800 ring-1 ring-black/10 hover:bg-black/5 disabled:opacity-50 dark:text-ink-100 dark:ring-white/10 dark:hover:bg-white/10"
            >
              取消
            </button>
            <button
              type="button"
              disabled={deleting}
              onClick={() => void handleSingleDelete()}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-rose-500 px-3 text-xs font-semibold text-white hover:bg-rose-600 disabled:opacity-50"
            >
              {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
              {deleting ? '正在删除' : '确认删除'}
            </button>
          </div>
        </div>
      </Modal>

      <AnimatePresence>
        {selectionMode && (
          <SelectionToolbar
            siteCount={selectedSiteCount}
            accountCount={selectedAccountCount}
            onSelectAll={selectAllDeletable}
            onClear={clearSelection}
            onDelete={() => setDeleteConfirmOpen(true)}
          />
        )}
      </AnimatePresence>

      {/* 轻提示 */}
      <AnimatePresence>
        {toast && !modalOpen && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.96 }}
            className={cn(
              'fixed left-1/2 z-[60] -translate-x-1/2 rounded-xl bg-ink-900 px-4 py-2.5 text-xs font-medium text-white shadow-2xl dark:bg-white dark:text-ink-900',
              selectionMode ? 'bottom-24' : 'bottom-5',
            )}
          >
            {toast}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
    </ErrorBoundary>
    </MotionConfig>
  );
}

/** 执行任务成功入队时的一次性能量发射反馈，不在后台常驻。 */
/**
 * 录制中的账号在管理页里的状态。
 *
 * `guide` 与 `loginAsCheckinAvailable` 都来自后台对同一份事件流的判定
 * （learning-stage.ts），界面只负责画：步骤条、当前该做什么、以及
 * 「本站没有签到按钮时按登录即签到保存」的出口。
 */
interface LearningAccountState {
  eventCount: number;
  kind: LearningKind;
  preview?: WorkflowLearningPreview[];
  guide?: import('@/automation/learning/learning-stage').LearningGuideView;
  loginAsCheckinAvailable?: boolean;
}

/**
 * 两份录制状态是否等价。
 *
 * 轮询每 3 秒一次，直接 setState 会让整棵列表每 3 秒重渲染一次，
 * 录制期间界面反而更卡。只有内容真的变了才更新。
 */
function sameLearningMap(
  a: ReadonlyMap<string, LearningAccountState>,
  b: ReadonlyMap<string, LearningAccountState>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    const next = b.get(key);
    if (!next || next.eventCount !== value.eventCount || next.kind !== value.kind) return false;
    // 步骤条与「登录即签到」出口是录制期间会随事件推进变化的状态，
    // 转速一致也必须重渲染，否则面板停在旧进度上。
    if ((next.guide?.step ?? 0) !== (value.guide?.step ?? 0)) return false;
    if ((next.loginAsCheckinAvailable ?? false) !== (value.loginAsCheckinAvailable ?? false)) return false;
    // 事件数没变但摘要内容变了（例如同一动作的文案被修正）也要重渲染。
    if ((next.preview?.length ?? 0) !== (value.preview?.length ?? 0)) return false;
    if (next.preview && value.preview) {
      for (let i = 0; i < next.preview.length; i += 1) {
        if (next.preview[i]?.text !== value.preview[i]?.text) return false;
      }
    }
  }
  return true;
}

function LaunchBurst({ onDone }: { onDone: () => void }) {
  return (
    <motion.div
      className="launch-burst"
      initial={{ opacity: 0 }}
      animate={{ opacity: [0, 1, 1, 0] }}
      transition={{ duration: 0.86, times: [0, 0.12, 0.68, 1], ease: 'easeOut' }}
      onAnimationComplete={onDone}
      aria-hidden="true"
    >
      <motion.span
        className="launch-burst-wave"
        initial={{ x: '-50%', scaleX: 0.02, opacity: 0.95 }}
        animate={{ x: '-50%', scaleX: 1, opacity: 0 }}
        transition={{ duration: 0.78, ease: [0.16, 1, 0.3, 1] }}
      />
      <motion.span
        className="launch-burst-ring"
        initial={{ scale: 0.2, opacity: 0.9 }}
        animate={{ scale: 3.4, opacity: 0 }}
        transition={{ duration: 0.72, ease: 'easeOut' }}
      />
      <motion.span
        className="launch-burst-ring launch-burst-ring-late"
        initial={{ scale: 0.35, opacity: 0.72 }}
        animate={{ scale: 2.5, opacity: 0 }}
        transition={{ duration: 0.68, delay: 0.08, ease: 'easeOut' }}
      />
      <motion.span
        className="launch-burst-core"
        initial={{ scale: 0.4, rotate: -45 }}
        animate={{ scale: [0.4, 1.25, 0], rotate: 45 }}
        transition={{ duration: 0.62, ease: 'easeOut' }}
      >
        <Zap className="size-4" />
      </motion.span>
    </motion.div>
  );
}
