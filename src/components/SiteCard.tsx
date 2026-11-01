import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { AlertTriangle, ArrowDown, ArrowUp, Ban, Check, CheckCircle2, ChevronDown, Clock3, Coins, Globe2, Loader2, Pencil, Plus, Play, Square, Trash2 } from 'lucide-react';
import type { Account, AccountBalance, DailyStatus, LastResult, LearningKind, ProxyConfig, SiteConfig } from '@/types';
import type { LearningNotice } from '@/lib/learning/learning-notice';
import type { WorkflowLearningPreview } from '@/types/workflow';
import { describeAge, displayBalanceOf, formatBalanceTotal, formatQuota as formatBalance, sumBalances } from '@/lib/balance/balance-format';
import type { LiveTask } from '@/lib/messages/live';
import { AccountRow } from './AccountRow';
import { hostOf } from '@/lib/core/date';
import { cn } from '@/lib/core/cn';
import { describeAccountProxy, describeAccountProxyEndpoint } from '@/lib/proxy/proxy-config';
import { loginCredentialNeeds, resolveEffectiveMethods } from '@/lib/checkin/effective-method';
import { resolveSiteAdapter } from '@/automation/sites/site-adapters';
import { usesCheckinWorkflow } from '@/lib/checkin/learned-checkin';
import { diagnoseFailure } from '@/automation/shared/diagnostics';
import { SiteFavicon } from './SiteFavicon';

interface Props {
  site: SiteConfig;
  /** 本卡没学过、签到时会共用的同域名站点卡（见 shared-learned-flow.ts）。 */
  sharedFlowFrom?: SiteConfig;
  accounts: Account[];
  proxy?: ProxyConfig;
  proxies: readonly ProxyConfig[];
  proxyUsage: ReadonlyMap<string, number>;
  statusOf: (accountId: string) => DailyStatus;
  resultOf: (accountId: string) => LastResult | undefined;
  liveOf: (accountId: string) => LiveTask | undefined;
  balanceOf: (accountId: string) => AccountBalance | undefined;
  refreshingBalanceIds?: ReadonlySet<string>;
  onRefreshBalances?: (accountIds: string[]) => void;
  isQueued: (accountId: string) => boolean;
  onRun: (accountId: string) => void;
  onRunAll: (siteId: string) => void;
  /** 停止本站所有正在执行/排队的账号 */
  onStopAll: (siteId: string) => void;
  onResetAccount: (accountId: string) => void;
  onStopAccount: (accountId: string) => void;
  onRetryAccount: (accountId: string) => void;
  onMarkAccountDone: (accountId: string) => void;
  onCaptureSession: (accountId: string) => void;
  onLearnAccount?: (accountId: string, kind: LearningKind, options?: { loginAsCheckin?: boolean }) => void;
  /** 正在录制登录或签到流程的账号 → 状态 */
  learningAccounts?: ReadonlyMap<string, number | {
    eventCount: number;
    kind?: LearningKind;
    preview?: WorkflowLearningPreview[];
    /** 「登录即签到」出口是否可用；见 AccountRow 上同名字段。 */
    loginAsCheckinAvailable?: boolean;
    /** 后台算出的当前进度引导（步骤条 + 该做什么）。 */
    guide?: import('@/automation/learning/learning-stage').LearningGuideView;
  }>;
  /** 各账号上一次「结束学习」的完整性自检结论；缺省表示还没有结论。 */
  learningNotices?: ReadonlyMap<string, LearningNotice>;
  /** 各账号上一次学习结束时留下的动作摘要；缺省表示这次没抓到。 */
  learnedSteps?: ReadonlyMap<string, readonly WorkflowLearningPreview[]>;
  /** 放弃某账号的录制，不保存 */
  onCancelLearnAccount?: (accountId: string) => void;
  onEditAccount: (account: Account) => void;
  onSetAccountProxy: (accountId: string, patch: Pick<Account, 'proxyMode' | 'proxyId' | 'proxyPinned'>) => Promise<void>;
  onRemoveAccount: (accountId: string) => void;
  onAddAccount: (siteId: string) => void;
  onEditSite: (site: SiteConfig) => void;
  onRemoveSite: (siteId: string) => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  onMove?: (siteId: string, direction: 'up' | 'down') => void;
  /** 顶部搜索是否生效：命中的账号必须显示出来，否则搜索等于失效 */
  searchActive?: boolean;
  selectionMode: boolean;
  siteSelected: boolean;
  selectedAccountIds: ReadonlySet<string>;
  onToggleSite: (siteId: string) => void;
  onToggleAccount: (accountId: string) => void;
  ref?: React.Ref<HTMLDivElement>;
}

export function SiteCard({
  site, sharedFlowFrom, accounts, proxy, proxies, proxyUsage, statusOf, resultOf, liveOf, balanceOf, refreshingBalanceIds, onRefreshBalances, isQueued, onRun, onRunAll, onStopAll,
  onResetAccount, onStopAccount, onRetryAccount, onMarkAccountDone,
  onCaptureSession, onLearnAccount, learningAccounts, learningNotices, learnedSteps, onCancelLearnAccount, onEditAccount, onSetAccountProxy, onRemoveAccount, onAddAccount, onEditSite, onRemoveSite, canMoveUp = false, canMoveDown = false,
  onMove, searchActive = false, selectionMode, siteSelected, selectedAccountIds, onToggleSite, onToggleAccount, ref,
}: Props) {
  // 默认收起：站点一多，全站账号铺开会把概览和站点标题挤出屏幕。
  // 空站点例外 —— 收起后连「添加本站账号」入口都看不到，等于没有出口。
  const [accountsCollapsed, setAccountsCollapsed] = useState(() => accounts.length > 0);
  const counts = accounts.reduce((sum, account) => ({ ...sum, [statusOf(account.id)]: sum[statusOf(account.id)] + 1 }), {
    pending: 0, running: 0, attention: 0, done: 0, failed: 0,
  });
  const actionable = counts.pending + counts.failed;
  // 能停下来的：正在跑的、等人工的，加上还排在队列里的
  const stoppable = counts.running + counts.attention
    + accounts.filter((account) => statusOf(account.id) === 'pending' && isQueued(account.id)).length;
  const status: DailyStatus = counts.failed ? 'failed' : counts.attention ? 'attention' : counts.running ? 'running' : accounts.length && counts.done === accounts.length ? 'done' : 'pending';
  const allAccountsDone = accounts.length > 0 && counts.done === accounts.length;
  const progress = accounts.length ? Math.round((counts.done / accounts.length) * 100) : 0;
  const checkin = site.checkin?.method ?? 'auto';
  const adapter = resolveSiteAdapter(site);
  const flow = sharedFlowFrom
    ? `通用登录 → 核对当前账号 → 执行同一域名站点「${sharedFlowFrom.name}」上学到的签到流程 · 本站账号共用`
    : describeSiteFlow(site);
  /**
   * 站点合计必须和账号行走同一套回落：
   *
   * 独立存储里可能只有一条带 error 的占位记录（页面只报了「今天 +$X」、
   * 或在写库前被身份闸门拒绝），而本次签到的 metrics 里其实已经有读到的余额。
   * 只认存储的话，账号行显示「余额 $7.91」、站点标题同时说「未获取」——
   * 同一个账号两种口径，用户只会以为扩展坏了。
   */
  const siteBalance = sumBalances(accounts.map((account) => ({
    balance: displayBalanceOf(balanceOf(account.id), resultOf(account.id)).balance,
    scale: { quotaPerUnit: site.adapter?.quotaPerUnit, family: adapter.family },
  })));
  const siteBalanceRefreshing = accounts.some((account) => refreshingBalanceIds?.has(account.id));
  useEffect(() => {
    // 本站全部成功后收起账号列表。失败或等待人工处理时保持展开，避免把
    // 诊断信息藏起来；用户之后仍可用展开按钮重新查看每个账号的结果。
    if (allAccountsDone) setAccountsCollapsed(true);
  }, [allAccountsDone]);

  // 搜索/批量选择时仍需显示账号，否则对应的交互入口会被藏起来。
  // 正在执行或等待人工处理的账号也必须保持可见，方便继续操作和排查。
  const forcedOpen = selectionMode ? '批量选择期间不能收起账号'
    : searchActive ? '搜索命中期间保持展开'
      : counts.running + counts.attention > 0 ? '有账号正在执行或待处理'
        : null;
  const accountsVisible = Boolean(forcedOpen) || !accountsCollapsed;
  /**
   * 本站第一条失败对应的诊断，供卡片头部显示。
   *
   * 站点卡片收起账号列表后，失败原因就看不见了 —— 用户只看到「失败 1」，
   * 还得自己展开、找到那一行、再点详情。这里把结论与第一步提到卡片上，
   * 展开账号后仍能在账号行里看到完整的「标题 + 说明 + 下一步」。
   */
  const failedAccount = accounts.find((account) => statusOf(account.id) === 'failed');
  const failedResult = failedAccount ? resultOf(failedAccount.id) : undefined;
  const diagnosis = failedResult && !failedResult.ok
    ? diagnoseFailure(failedResult.message, failedResult.steps)
    : null;

  return (
    <motion.section
      ref={ref}
      layout="position"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ type: 'spring', stiffness: 320, damping: 30 }}
      className={cn('relative overflow-hidden rounded-xl border bg-white shadow-sm transition-shadow duration-200 hover:shadow-md motion-reduce:transition-none dark:bg-slate-950 dark:hover:shadow-black/20', cardBorder(status), siteSelected && 'ring-2 ring-rose-500/30')}
    >
      <span className={cn('absolute inset-y-0 left-0 w-1', statusTone(status))} aria-hidden="true" />
      <header className="border-b border-slate-100 px-4 py-3.5 dark:border-slate-800">
        <div className="flex flex-wrap items-start gap-3">
          {selectionMode && <button type="button" disabled={site.builtin} onClick={() => onToggleSite(site.id)} aria-label={site.builtin ? `内置站点 ${site.name} 不可删除` : `${siteSelected ? '取消选择' : '选择'}站点 ${site.name}`} title={site.builtin ? '内置站点不可删除' : undefined} className={cn('mt-1 grid size-7 place-items-center rounded-md disabled:cursor-not-allowed disabled:opacity-40', siteSelected ? 'bg-rose-500 text-white' : 'bg-slate-100 text-slate-500 dark:bg-slate-900')}>
            {siteSelected ? <Check className="size-4" /> : <Square className="size-4" />}
          </button>}
          <SiteIcon site={site} />
          <div className="min-w-[160px] flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <a
                href={site.loginUrl}
                target="_blank"
                rel="noreferrer noopener"
                title={`打开 ${site.name}`}
                className="truncate text-sm font-semibold text-slate-950 hover:text-blue-600 dark:text-white dark:hover:text-blue-400"
              >
                {site.name}
              </a>
              <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-slate-900 dark:text-slate-300">{usesCheckinWorkflow(site) || sharedFlowFrom ? '学习流程回放' : checkin === 'none' ? '登录即签到' : checkin === 'auto' ? '自动识别' : '本站适配'}</span>
              {proxy && <span className="inline-flex items-center gap-1 rounded-md bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 dark:bg-violet-950/40 dark:text-violet-300"><Globe2 className="size-2.5" />{proxy.name}</span>}
              <span className="inline-flex items-center gap-1 rounded-md bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"><Coins className="size-2.5" />本站余额 {formatBalanceTotal(siteBalance)}{siteBalance.missing > 0 && ` · ${siteBalance.missing} 个未获取`}</span>
            </div>
            <p className="mt-0.5 truncate text-[11px] text-slate-500">{hostOf(site.loginUrl)}</p>
            <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-slate-600 dark:text-slate-300"><span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-blue-500" /><span>{flow}</span></p>
          </div>
          {!selectionMode && <div className="flex items-center gap-1">
            {actionable > 0 && <button type="button" onClick={() => onRunAll(site.id)} className="inline-flex h-8 items-center gap-1 rounded-md bg-blue-600 px-2.5 text-[11px] font-semibold text-white hover:bg-blue-700"><Play className="size-3 fill-current" />执行 {actionable}</button>}
            {stoppable > 0 && <button type="button" onClick={() => onStopAll(site.id)} title="停止本站正在执行和排队中的任务" className="inline-flex h-8 items-center gap-1 rounded-md bg-slate-100 px-2.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"><Ban className="size-3" />停止 {stoppable}</button>}
            {onRefreshBalances && <Icon title={siteBalanceRefreshing ? '正在刷新本站余额' : '刷新本站余额'} disabled={siteBalanceRefreshing || accounts.length === 0} onClick={() => onRefreshBalances(accounts.map((account) => account.id))}>{siteBalanceRefreshing ? <Loader2 className="size-4 animate-spin" /> : <Coins className="size-4" />}</Icon>}
            <Icon title="添加账号" onClick={() => onAddAccount(site.id)}><Plus className="size-4" /></Icon>
            {onMove && <><Icon title="上移站点" disabled={!canMoveUp} onClick={() => onMove(site.id, 'up')}><ArrowUp className="size-4" /></Icon><Icon title="下移站点" disabled={!canMoveDown} onClick={() => onMove(site.id, 'down')}><ArrowDown className="size-4" /></Icon></>}
            <Icon title="编辑站点" onClick={() => onEditSite(site)}><Pencil className="size-4" /></Icon>
            {!site.builtin && <Icon title="删除站点" danger onClick={() => onRemoveSite(site.id)}><Trash2 className="size-4" /></Icon>}
          </div>}
        </div>
        {diagnosis && !accountsVisible && <div
          data-site-diagnosis={diagnosis.code}
          className="mt-3 rounded-lg bg-amber-500/[0.07] px-2.5 py-2 ring-1 ring-inset ring-amber-500/20 dark:bg-amber-400/[0.06]"
        >
          <p data-diagnosis-title className="text-[11px] font-semibold text-amber-900 dark:text-amber-100">
            {diagnosis.title}
          </p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-800/60 dark:text-ink-100/50">
            下一步：{diagnosis.nextActions[0]}
          </p>
          <button
            type="button"
            onClick={() => setAccountsCollapsed(false)}
            className="mt-1 text-[11px] font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            展开账号查看完整排查步骤
          </button>
        </div>}
        <div className="mt-3 flex items-center gap-3">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"><motion.span className={cn('block h-full origin-left rounded-full', statusTone(status))} initial={false} animate={{ scaleX: progress / 100 }} /></div>
          <span className="text-[11px] font-semibold tabular-nums text-slate-500">{counts.done}/{accounts.length}</span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] font-medium">
          <Stat icon={<CheckCircle2 />} label="完成" value={counts.done} tone="text-emerald-700 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-950/40" />
          <Stat icon={<Clock3 />} label="待签" value={counts.pending} tone="text-amber-700 bg-amber-50 dark:text-amber-300 dark:bg-amber-950/40" />
          {counts.running > 0 && <Stat icon={<Loader2 className="animate-spin" />} label="执行中" value={counts.running} tone="text-blue-700 bg-blue-50 dark:text-blue-300 dark:bg-blue-950/40" />}
          {counts.attention > 0 && <Stat icon={<AlertTriangle />} label="需处理" value={counts.attention} tone="text-cyan-700 bg-cyan-50 dark:text-cyan-300 dark:bg-cyan-950/40" />}
          {counts.failed > 0 && <Stat icon={<AlertTriangle />} label="失败" value={counts.failed} tone="text-rose-700 bg-rose-50 dark:text-rose-300 dark:bg-rose-950/40" />}
          {/*
           * 带文字的展开开关。
           *
           * 原来是图标按钮，和上移/下移三个 chevron 挤在一排 —— 三个箭头长得
           * 一样，谁也认不出哪个是收起账号。这里写清「展开/收起 N 个账号」，
           * 上移下移则换成实心箭头，语义不再撞车。
           */}
          {!selectionMode && accounts.length > 0 && <button
            type="button"
            title={forcedOpen ?? undefined}
            aria-label={`${accountsVisible ? '收起' : '展开'}账号 ${site.name}`}
            aria-expanded={accountsVisible}
            disabled={Boolean(forcedOpen)}
            onClick={() => setAccountsCollapsed((value) => !value)}
            className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-slate-600 ring-1 ring-slate-200 transition-colors hover:bg-slate-100 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-45 dark:text-slate-300 dark:ring-slate-700 dark:hover:bg-slate-900 dark:hover:text-white"
          >
            <motion.span animate={{ rotate: accountsVisible ? 180 : 0 }} className="block"><ChevronDown className="size-3" /></motion.span>
            {accountsVisible ? '收起' : '展开'} {accounts.length} 个账号
          </button>}
        </div>
      </header>

      <AnimatePresence initial={false}>
        {accountsVisible && <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          className="overflow-hidden"
        >
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            <AnimatePresence mode="popLayout">
              {accounts.map((account) => {
                const accountStatus = statusOf(account.id);
                const queued = isQueued(account.id);
                const learningValue = learningAccounts?.get(account.id);
                const learning = typeof learningValue === 'number'
                  ? { eventCount: learningValue, kind: 'checkin' as const }
                  : learningValue;
                return <AccountRow key={account.id} account={account} status={accountStatus} result={resultOf(account.id)} siteCheckinMethod={checkin} siteName={site.name} quotaPerUnit={site.adapter?.quotaPerUnit} adapterFamily={adapter.family} balance={balanceOf(account.id)} balanceRefreshing={refreshingBalanceIds?.has(account.id)} onRefreshBalance={onRefreshBalances ? () => onRefreshBalances([account.id]) : undefined} liveTask={liveOf(account.id)} queued={queued} proxyLabel={describeAccountProxy(account, site, proxies)} proxyEndpoint={describeAccountProxyEndpoint(account, site, proxies)} proxies={proxies} proxyUsage={proxyUsage} siteProxyName={proxy?.name} onSetProxy={onSetAccountProxy} onRun={onRun} onReset={onResetAccount} onStop={onStopAccount} onRetry={onRetryAccount} onMarkDone={onMarkAccountDone} onLearn={onLearnAccount} learning={learning} learningNotice={learningNotices?.get(account.id)} learnedSteps={learnedSteps?.get(account.id)} onCancelLearn={onCancelLearnAccount} onCaptureSession={loginCredentialNeeds(resolveEffectiveMethods(account, site).loginMethod).sessionCounts ? onCaptureSession : undefined} onEdit={onEditAccount} onRemove={onRemoveAccount} selectionMode={selectionMode} selected={siteSelected || selectedAccountIds.has(account.id)} selectionDisabled={siteSelected} onToggleSelect={onToggleAccount} />;
              })}
            </AnimatePresence>
            {!accounts.length && !selectionMode && <button type="button" onClick={() => onAddAccount(site.id)} className="m-3 flex w-[calc(100%-1.5rem)] items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 py-3 text-xs text-slate-500 hover:border-blue-400 hover:text-blue-600 dark:border-slate-700"><Plus className="size-3.5" />添加本站账号</button>}
          </div>
        </motion.div>}
      </AnimatePresence>
    </motion.section>
  );
}

function describeSiteFlow(site: SiteConfig): string {
  if (usesCheckinWorkflow(site)) return '通用登录 → 核对当前账号 → 执行已保存签到流程 · 本站账号共用，可重新学习';
  if (site.checkin?.method === 'none') return '通用登录 → 登录成功即完成签到 · 不再寻找签到按钮 · 可重新学习';
  if (site.checkin?.method && site.checkin.method !== 'auto') return '通用登录 → 确认账号 → 按本站已有适配完成签到 · 可学习';
  return '通用登录 → 确认账号 → 自动识别签到 · 可一次学习登录与签到';
}

function SiteIcon({ site }: { site: SiteConfig }) {
  const letter = site.name.trim().slice(0, 1).toUpperCase();
  return <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg bg-slate-100 text-sm font-bold text-slate-600 ring-1 ring-inset ring-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-800"><SiteFavicon site={site} className="size-5 rounded" fallback={letter} /></span>;
}

function Icon({ title, onClick, children, danger = false, disabled = false }: { title: string; onClick: () => void; children: React.ReactNode; danger?: boolean; disabled?: boolean }) {
  return <button type="button" title={title} disabled={disabled} onClick={onClick} className={cn('grid size-8 place-items-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-30 dark:text-slate-400 dark:hover:bg-slate-900 dark:hover:text-white', danger && 'hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/40 dark:hover:text-rose-400')}>{children}</button>;
}

function Stat({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: number; tone: string }) {
  return <span className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5', tone)}>{icon}{label} {value}</span>;
}

function cardBorder(status: DailyStatus) {
  if (status === 'failed') return 'border-rose-200 dark:border-rose-950';
  if (status === 'attention') return 'border-cyan-200 dark:border-cyan-950';
  if (status === 'running') return 'border-blue-200 dark:border-blue-950';
  return 'border-slate-200 dark:border-slate-800';
}
function statusTone(status: DailyStatus) {
  if (status === 'done') return 'bg-emerald-500';
  if (status === 'running') return 'bg-blue-500';
  if (status === 'attention') return 'bg-cyan-500';
  if (status === 'failed') return 'bg-rose-500';
  return 'bg-amber-400';
}


