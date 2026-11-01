import { create } from 'zustand';
import type { Account, AccountBalance, CheckinSchedule, DailyStatus, LastResult, LaunchMode, ProxyConfig, SiteConfig } from '@/types';
import { statusKey } from '@/lib/core/date';
import { BUILTIN_SITES, mergeBuiltinSite } from '@/sites';
import { DEFAULT_LAUNCH_MODE } from '@/lib/site/launch-mode';
import { type AppMutation, sendMessage } from '@/lib/core/messaging';
import type { LiveQueue, LiveTask } from '@/lib/messages/live';
import { appRepository } from '@/data/app-repository';
import { DEFAULT_CHECKIN_SCHEDULE } from '@/lib/checkin/schedule';

let launchModeRevision = 0;
let dataLoadRevision = 0;

/** 站点归并只按登录域名比较；路径、查询串在不同入口下常不一致。 */
function hostKeyOf(loginUrl: string): string {
  try {
    return new URL(loginUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

async function mutate(mutation: AppMutation) {
  const response = await sendMessage({ type: 'MUTATE_APP', mutation });
  if (!response.ok) throw new Error(response.error);
  return response;
}

/** 拉取后台正在签到任务的实时快照，后台未就绪时静默降级为空。 */
async function fetchLive(): Promise<{ live: LiveTask[]; queue: LiveQueue }> {
  try {
    const response = await sendMessage({ type: 'GET_LIVE_TASKS' });
    if (response.ok && response.feature?.live && response.feature?.queue) {
      return { live: response.feature.live, queue: response.feature.queue };
    }
  } catch {
    // 后台未就绪或旧版本扩展，界面退化为只显示状态徽标
  }
  return { live: [], queue: { pending: [] } };
}

interface AppState {
  sites: SiteConfig[];
  accounts: Account[];
  proxies: ProxyConfig[];
  status: Record<string, string>;
  results: Record<string, LastResult>;
  /** 每个账号最近一次读到的余额，与签到结果分开存 */
  balances: Record<string, AccountBalance>;
  /** 正在刷新余额的账号 ID，界面据此显示转圈 */
  refreshingBalances: ReadonlySet<string>;
  /** 正在签到任务的实时进度（阶段/步骤/已运行时长） */
  live: LiveTask[];
  /** 后台队列快照：谁在排队、谁在跑 */
  queue: LiveQueue;
  loading: boolean;
  launchMode: LaunchMode;
  schedule: CheckinSchedule;

  load: () => Promise<void>;
  setLaunchMode: (mode: LaunchMode) => Promise<void>;
  syncLaunchMode: (mode: LaunchMode) => void;
  setSchedule: (schedule: CheckinSchedule) => Promise<void>;

  addSite: (site: Omit<SiteConfig, 'id'>) => Promise<void>;
  addSites: (sites: Omit<SiteConfig, 'id'>[], preserveDuplicates?: boolean) => Promise<void>;
  updateSite: (siteId: string, patch: Partial<SiteConfig>) => Promise<void>;
  /** 移动站点；orderedIds 是界面当前显示顺序（含本次移动），提供给后台固化排序。 */
  moveSite: (siteId: string, direction: 'up' | 'down', orderedIds?: string[]) => Promise<void>;
  removeSite: (siteId: string) => Promise<void>;
  removeMany: (siteIds: string[], accountIds: string[]) => Promise<void>;

  addAccount: (input: Omit<Account, 'id'>) => Promise<void>;
  addAccounts: (inputs: Omit<Account, 'id'>[], preserveDuplicates?: boolean) => Promise<{ added: number; skipped: number }>;
  updateAccount: (accountId: string, patch: Partial<Account>) => Promise<void>;
  removeAccount: (accountId: string) => Promise<void>;

  addProxy: (input: Omit<ProxyConfig, 'id'>) => Promise<void>;
  /** 批量入池（订阅导入），返回去重后实际写入的数量。upgraded 是补上真实出口的既有名称条目数 */
  addProxies: (inputs: Omit<ProxyConfig, 'id'>[]) => Promise<{ added: number; skipped: number; upgraded: number }>;
  /** 以 Clash YAML 为准替换此前同步的本地固定节点出口。 */
  syncClashProxies: (inputs: Omit<ProxyConfig, 'id'>[]) => Promise<{ added: number; skipped: number; upgraded: number; removed: number; keptInUse: number }>;
  updateProxy: (proxyId: string, patch: Partial<ProxyConfig>) => Promise<void>;
  removeProxy: (proxyId: string) => Promise<void>;
  /** 批量把账号绑到池内节点，返回实际写入的账号数 */
  assignAccountProxies: (assignments: { accountId: string; proxyId: string; pinned?: boolean }[]) => Promise<number>;

  /** 取某账号今日状态 */
  statusOf: (accountId: string) => DailyStatus;
  /** 取某账号最近一次执行详情 */
  resultOf: (accountId: string) => LastResult | undefined;
  /** 取某账号最近一次读到的余额，从没读到过则为 undefined */
  balanceOf: (accountId: string) => AccountBalance | undefined;
  /** 手动刷新一批账号的余额，返回成功/失败计数 */
  refreshBalances: (accountIds: string[]) => Promise<{ refreshed: number; failed: number }>;
  /** 取某账号正在签到的实时进度，没有则为 undefined */
  liveOf: (accountId: string) => LiveTask | undefined;
  /** 该账号是否在后台队列里排队等待 */
  isQueued: (accountId: string) => boolean;
  /** 手动标记（用于「已签到」的手工修正） */
  setStatus: (accountId: string, value: DailyStatus) => Promise<void>;
  /** 手动标记今日已签到，同时写一条 manual 结果，见 lib/manual-checkin.ts */
  markDone: (accountId: string) => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  sites: [],
  accounts: [],
  proxies: [],
  status: {},
  results: {},
  balances: {},
  refreshingBalances: new Set<string>(),
  live: [],
  queue: { pending: [] },
  loading: true,
  launchMode: DEFAULT_LAUNCH_MODE,
  schedule: DEFAULT_CHECKIN_SCHEDULE,

  async load() {
    const loadRevision = ++dataLoadRevision;
    const modeRevisionAtStart = launchModeRevision;
    const [{ userSites, accounts, proxies, status, results, balances, launchMode, schedule, removedBuiltinSiteIds }, liveData] = await Promise.all([
      appRepository.load(),
      fetchLive(),
    ]);
    if (loadRevision !== dataLoadRevision) return;
    // 用户导入站点排在前面；同 ID 的用户配置是内置站点的持久化覆盖，不能重复展示。
    // 已被用户删除的内置站点不再展示（删除标记持久化在 removedBuiltinSiteIds）。
    const removedBuiltinIds = new Set(removedBuiltinSiteIds);
    const builtinIdSet = new Set(BUILTIN_SITES.map((site) => site.id));
    const ordinaryUserSites = userSites.filter((site) => !builtinIdSet.has(site.id));
    const accountSiteIds = new Set(accounts.map((account) => account.siteId));
    /**
     * 同一登录域名下，用户自己导入的站点优先。
     *
     * 内置站点的登录地址可能与用户早先导入的记录完全一致（Future Hub 就是这样）。
     * 两张卡片同时显示会让账号、状态和执行历史被拆到两处；用户那条带着账号和
     * 历史，内置那条只是预设，所以隐藏内置的重复项。若账号实际挂在内置站点上，
     * 则必须保留它，否则这些账号又会不可见。
     */
    const userHosts = new Set(ordinaryUserSites.map((site) => hostKeyOf(site.loginUrl)).filter(Boolean));
    const visibleBuiltinSites = BUILTIN_SITES.filter((site) => {
      if (removedBuiltinIds.has(site.id)) return false;
      if (accountSiteIds.has(site.id)) return true;
      return !userHosts.has(hostKeyOf(site.loginUrl));
    });
    const builtinIds = new Set(visibleBuiltinSites.map((site) => site.id));
    const userOverrides = new Map(userSites.filter((site) => builtinIds.has(site.id)).map((site) => [site.id, site]));
    const resolvedBuiltinSites = visibleBuiltinSites.map((site) => mergeBuiltinSite(site, userOverrides.get(site.id)));
    set({
      sites: [...ordinaryUserSites, ...resolvedBuiltinSites]
        .sort((a, b) => (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name)),
      accounts,
      proxies,
      status,
      results,
      balances,
      live: liveData.live,
      queue: liveData.queue,
      ...(modeRevisionAtStart === launchModeRevision ? { launchMode } : {}),
      schedule,
      loading: false,
    });
  },

  async setLaunchMode(mode) {
    const previous = get().launchMode;
    if (previous === mode) return;

    const requestId = ++launchModeRevision;
    set({ launchMode: mode });
    const response = await sendMessage({ type: 'SET_LAUNCH_MODE', mode, requestId });
    if (requestId !== launchModeRevision) return;
    if (response.ok) return;

    launchModeRevision += 1;
    set({ launchMode: previous });
    throw new Error(response.error);
  },

  syncLaunchMode(mode) {
    if (get().launchMode === mode) return;
    launchModeRevision += 1;
    set({ launchMode: mode });
  },

  async setSchedule(schedule) {
    await mutate({ action: 'update-schedule', schedule });
    set({ schedule });
  },

  async addSite(input) {
    await mutate({ action: 'add-site', input });
    await get().load();
  },

  async addSites(inputs, preserveDuplicates = false) {
    if (inputs.length === 0) return;
    const response = await mutate({ action: 'add-sites', inputs, preserveDuplicates });
    if (response.added) await get().load();
  },

  async updateSite(siteId, patch) {
    await mutate({ action: 'update-site', siteId, patch });
    await get().load();
  },

  async moveSite(siteId, direction, orderedIds) {
    await mutate({ action: 'move-site', siteId, direction, orderedIds });
    await get().load();
  },

  async removeSite(siteId) {
    await get().removeMany([siteId], []);
  },

  async removeMany(siteIds, accountIds) {
    if (siteIds.length === 0 && accountIds.length === 0) return;

    await mutate({ action: 'delete-entities', siteIds, accountIds });
    await get().load();
  },

  async addAccount(input) {
    await mutate({ action: 'add-account', input });
    await get().load();
  },

  async addAccounts(inputs, preserveDuplicates = false) {
    if (inputs.length === 0) return { added: 0, skipped: 0 };

    const response = await mutate({ action: 'add-accounts', inputs, preserveDuplicates });
    const result = { added: response.added ?? 0, skipped: response.skipped ?? inputs.length };
    if (result.added) await get().load();
    return result;
  },

  async updateAccount(accountId, patch) {
    await mutate({ action: 'update-account', accountId, patch });
    await get().load();
  },

  async removeAccount(accountId) {
    await get().removeMany([], [accountId]);
  },

  async addProxy(input) {
    await mutate({ action: 'add-proxy', input });
    await get().load();
  },

  async addProxies(inputs) {
    if (inputs.length === 0) return { added: 0, skipped: 0, upgraded: 0 };

    const response = await mutate({ action: 'add-proxies', inputs });
    const result = {
      added: response.added ?? 0,
      skipped: response.skipped ?? inputs.length,
      upgraded: response.upgraded ?? 0,
    };
    // 升级也改了池内数据，必须重载，否则界面上那条还显示成「节点名」
    if (result.added || result.upgraded) await get().load();
    return result;
  },

  async syncClashProxies(inputs) {
    const response = await sendMessage({ type: 'SYNC_CLASH_PROXIES', inputs });
    if (!response.ok) throw new Error(response.error);
    const result = response.feature?.clashConfigSync ?? {
      added: 0,
      skipped: inputs.length,
      upgraded: 0,
      removed: 0,
      keptInUse: 0,
    };
    // 即使本次全部被判为已存在也要重读：用户可能在另一个管理页或旧版本
    // 扩展里留下了过时的代理池，单看变更计数会让当前页面继续显示旧数量。
    await get().load();
    return result;
  },

  async updateProxy(proxyId, patch) {
    await mutate({ action: 'update-proxy', proxyId, patch });
    await get().load();
  },

  async removeProxy(proxyId) {
    await mutate({ action: 'remove-proxy', proxyId });
    await get().load();
  },

  async assignAccountProxies(assignments) {
    if (assignments.length === 0) return 0;

    const response = await mutate({ action: 'assign-account-proxies', assignments });
    const assigned = response.assigned ?? 0;
    if (assigned) await get().load();
    return assigned;
  },

  statusOf(accountId) {
    // 键含日期，跨天后自然查不到旧记录 → 回落 pending，实现每日自动重置
    const raw = get().status[statusKey(accountId)];
    if (raw === 'done' || raw === 'failed' || raw === 'running' || raw === 'attention') return raw;
    return 'pending';
  },

  resultOf(accountId) {
    return get().results[accountId];
  },

  balanceOf(accountId) {
    return get().balances[accountId];
  },

  async refreshBalances(accountIds) {
    if (accountIds.length === 0) return { refreshed: 0, failed: 0 };

    // 先标记在刷新，让按钮立刻转圈；否则点下去几秒内毫无反馈，
    // 用户会以为没响应而反复点。
    set({ refreshingBalances: new Set([...get().refreshingBalances, ...accountIds]) });
    try {
      const response = await sendMessage({ type: 'REFRESH_BALANCE', accountIds });
      if (!response.ok) throw new Error(response.error);
      await get().load();
      return {
        refreshed: response.feature?.refreshed ?? 0,
        failed: response.feature?.failed ?? 0,
      };
    } finally {
      const next = new Set(get().refreshingBalances);
      for (const accountId of accountIds) next.delete(accountId);
      set({ refreshingBalances: next });
    }
  },

  liveOf(accountId) {
    return get().live.find((task) => task.accountId === accountId);
  },

  isQueued(accountId) {
    return get().queue.pending.includes(accountId);
  },

  async setStatus(accountId, value) {
    await mutate({ action: 'set-status', accountId, value });
    await get().load();
  },

  async markDone(accountId) {
    await mutate({ action: 'mark-done', accountId });
    await get().load();
  },
}));
