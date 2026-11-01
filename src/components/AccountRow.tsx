import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, Ban, BookOpen, Check, CheckCheck, ChevronDown, CircleDot, Clock3, Coins, Compass, Globe2, KeyRound, Loader2, MousePointerClick, Move, Pencil, Pin, PinOff, Play, RotateCcw, RotateCw, ScrollText, ShieldAlert, Square, TextCursorInput, Trash2, X, Zap } from 'lucide-react';
import type { Account, AccountBalance, AdapterFamily, CheckinMethod, CheckinMetrics, DailyStatus, LastResult, LearningKind, ProxyConfig } from '@/types';
import { describeAge, displayBalanceOf, formatQuota as formatBalance, formatQuotaChange } from '@/lib/balance/balance-format';
import { effectiveProxyScheme, type AccountProxyLabel } from '@/lib/proxy/proxy-config';
import { StatusBadge } from './StatusBadge';
import { describeEvidence, evidenceOf } from '@/lib/checkin/checkin-evidence';
import { DiagnosisHint } from './DiagnosisHint';
import { diagnoseFailure } from '@/automation/shared/diagnostics';
import { cn } from '@/lib/core/cn';
import type { LiveTask } from '@/lib/messages/live';
import { stageLabel, formatElapsed } from '@/lib/checkin/stage-label';
import { actionWords, statusLabelFor } from '@/lib/checkin/action-label';
import { todayKey } from '@/lib/core/date';
import { balanceHistoryRows, type BalanceHistoryRow } from '@/lib/balance/balance-history';
import { learningNoticeTitle, type LearningNotice } from '@/lib/learning/learning-notice';
import { learningActionCount, learningPreviewViewSet, type LearningPreviewKind, type LearningPreviewLike } from '@/lib/learning/learning-preview-view';
import type { LearningGuideView } from '@/automation/learning/learning-stage';
import type { WorkflowLearningPreview } from '@/types/workflow';

interface Props {
  account: Account;
  status: DailyStatus;
  result?: LastResult;
  siteCheckinMethod?: CheckinMethod;
  /**
   * 所属站点名。
   *
   * 同一个邮箱常在多个站点各注册一个账号，只显示邮箱时几行长得一模一样，
   * 搜索或滚动后更分不清哪行属于哪个站点。
   */
  siteName?: string;
  quotaPerUnit?: number;
  adapterFamily?: AdapterFamily;
  /** 该账号最近一次读到的余额，与签到结果无关 */
  balance?: AccountBalance;
  /** 该账号的余额正在刷新 */
  balanceRefreshing?: boolean;
  liveTask?: LiveTask;
  queued?: boolean;
  proxyLabel?: AccountProxyLabel;
  /** 账号行就地选择代理；保存后会标记为手动固定 */
  proxies?: readonly ProxyConfig[];
  proxyUsage?: ReadonlyMap<string, number>;
  siteProxyName?: string;
  proxyEndpoint?: string;
  onSetProxy?: (accountId: string, patch: Pick<Account, 'proxyMode' | 'proxyId' | 'proxyPinned'>) => Promise<void>;
  onRun: (accountId: string) => void;
  onRefreshBalance?: (accountId: string) => void;
  onRemove: (accountId: string) => void;
  onReset?: (accountId: string) => void;
  /** 停止正在执行或排队中的任务，状态改回待签到 */
  onStop?: (accountId: string) => void;
  /** 停止当前任务并立刻重新执行一次 */
  onRetry?: (accountId: string) => void;
  onMarkDone?: (accountId: string) => void;
  onCaptureSession?: (accountId: string) => void;
  onLearn?: (accountId: string, kind: LearningKind, options?: { loginAsCheckin?: boolean }) => void;
  /** 该账号正在录制登录或签到流程时的实时状态；未录制时为 undefined */
  learning?: {
    eventCount: number;
    kind?: LearningKind;
    preview?: WorkflowLearningPreview[];
    /**
     * 当前演示能不能按「登录即签到」保存（后台用保守判据算出，见 learning-stage.ts）。
     *
     * 为 true 时面板里出现「登录即签到」出口：本站没有签到按钮、登录成功即算签到时，
     * 用户不用干等一个永远录不到的签到动作。
     */
    loginAsCheckinAvailable?: boolean;
    /** 后台算出的当前进度引导（步骤条 + 该做什么），与页面浮层同一份判定。 */
    guide?: LearningGuideView;
  };
  /** 放弃当前录制，不保存任何流程 */
  onCancelLearn?: (accountId: string) => void;
  /**
   * 上一次「结束学习」的完整性自检：保存后由管理页带回来（缺省表示还没有结论）。
   *
   * 只渲染固定文案，绝不显示页面内容或输入值。
   */
  learningNotice?: LearningNotice;
  /**
   * 上一次学习**结束**时留下的动作摘要（会话已清空，所以由管理页存一份带回来）。
   *
   * 用户点「结束学习」后最想知道的就是「我刚才那几步到底学到没有」——只有一句
   * 「已保存」等于让他第二天自己试错。这里渲染的是同一份脱敏摘要，不新增任何采集。
   */
  learnedSteps?: readonly WorkflowLearningPreview[];
  onEdit?: (account: Account) => void;
  selectionMode?: boolean;
  selected?: boolean;
  selectionDisabled?: boolean;
  selectionDisabledReason?: string;
  onToggleSelect?: (accountId: string) => void;
  ref?: React.Ref<HTMLDivElement>;
}

export function AccountRow({
  account, status, result, siteCheckinMethod, siteName, quotaPerUnit, adapterFamily, balance: accountBalance, balanceRefreshing = false,
  liveTask, ref, queued = false, proxyLabel, onRun, onRefreshBalance, onRemove, onReset, onStop, onRetry,
  onMarkDone, onCaptureSession, onLearn, learning, onCancelLearn, learningNotice, learnedSteps, onEdit, selectionMode = false, selected = false, selectionDisabled = false, selectionDisabledReason, onToggleSelect,
  proxies = [], proxyUsage = new Map(), siteProxyName, proxyEndpoint, onSetProxy,
}: Props) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [proxySaving, setProxySaving] = useState(false);
  const clickable = status === 'pending' || status === 'failed';
  const disabledSelectionLabel = selectionDisabledReason ?? '删除站点后，该账号会保留到待恢复账号';
  /**
   * 「还没落定」的两种状态都要能停。
   *
   * attention 以前只给了「重置为待签到」，那是个陷阱：状态看着变回待签了，
   * 队列却还占着这个账号（标签页也还开着），再点执行会被 enqueue 静默跳过 ——
   * 用户看到的就是「点了没反应，只能干等」。停止走的是真取消：清信箱、
   * 清队列、关页面、放代理租约。
   */
  const inFlight = status === 'running' || status === 'attention';
  const queuedPending = queued && status === 'pending';
  const resettable = status === 'done';
  const markable = status !== 'done' && status !== 'running';
  /**
   * 「学习本站流程」的入口条件。
   *
   * 学习是「用这个账号登录该站、手动签一次，把流程存成本站 workflow」，与正在进行的
   * 任务互斥：正在执行、等待人工、已排队时不给入口，避免抢占同一个标签页。剩下的
   * 待签/失败/已完成都可以随时开学（已完成也允许，方便流程变了重新学一遍）。
   */
  const canStartLearn = !learning && !inFlight && !queued;
  const method = liveTask?.method || siteCheckinMethod;
  const words = actionWords(method);
  const evidence = evidenceOf(result);
  const refreshedLedgerReward = accountBalance?.checkinRewardDay === todayKey()
    && accountBalance.checkinReward != null
    ? formatQuotaChange(
      accountBalance.checkinReward,
      { quotaPerUnit, family: adapterFamily },
      accountBalance.checkinRewardSymbol,
    )
    : null;
  const reward = refreshedLedgerReward ? `+${refreshedLedgerReward}` : rewardLabel(result?.metrics, quotaPerUnit, adapterFamily);
  const rewardTitle = refreshedLedgerReward
    ? '今日签到奖励（余额刷新时从页面签到台账读取）'
    : result?.manual && reward
      ? '手动标记：按已保存余额的总额度差值估算，可能包含同期间其它入账'
      : undefined;
  /**
   * 余额优先读独立存储，回落到本次签到的守恒差分。
   *
   * 回落是为了别在升级后出现「明明刚签到成功、余额却空着」：老用户的
   * balances 还是空的，而 result.metrics.quotaAfter 里有值。
   */
  const scale = { quotaPerUnit, family: adapterFamily };
  /**
   * 余额的展示口径与站点卡片、顶部合计共用 displayBalanceOf。
   *
   * 曾经这里是内联的三分支：存储优先、否则回落 metrics.quotaAfter。逻辑本身
   * 是对的，但只写在这一处 —— 站点卡片没跟上，于是同一个账号「账号行有余额、
   * 站点说未获取」。抽成共用函数后，三处不可能再各说各话。
   *
   * 回落值不显示「几分钟前更新」：它的时刻来自本次签到，不是一次独立刷新。
   */
  const display = displayBalanceOf(accountBalance, result);
  const balance = display.balance
    ? {
        text: `余额 ${formatBalance(display.balance.quota, scale, display.balance.symbol)}`,
        age: display.fromCheckinResult ? null : describeAge(display.balance.at),
      }
    : null;
  const balanceError = accountBalance?.error;
  const steps = liveTask?.steps ?? result?.steps ?? [];
  const balanceHistory = balanceHistoryRows(accountBalance);
  const hasDetails = Boolean(liveTask || result || balanceHistory.length > 0);
  const active = status === 'running' || status === 'attention';

  const proxyChoice = account.proxyMode === 'pool'
    ? account.proxyId ?? ''
    : account.proxyMode === 'none'
      ? '__direct__'
      : account.proxyMode === 'custom'
        ? '__custom__'
        : '__inherit__';
  const realProxyUsage = proxies.filter((proxy) => !proxy.nameOnly).map((proxy) => proxyUsage.get(proxy.id) ?? 0);
  const leastProxyUsage = realProxyUsage.length ? Math.min(...realProxyUsage) : 0;

  async function setProxyChoice(value: string): Promise<void> {
    if (!onSetProxy || proxySaving || value === proxyChoice) return;
    if (value === '__custom__') {
      onEdit?.({ ...account, proxyMode: 'custom' });
      return;
    }

    setProxySaving(true);
    try {
      if (value === '__direct__') await onSetProxy(account.id, { proxyMode: 'none' });
      else if (value === '__inherit__') await onSetProxy(account.id, { proxyMode: 'inherit' });
      else await onSetProxy(account.id, { proxyMode: 'pool', proxyId: value, proxyPinned: true });
    } finally {
      setProxySaving(false);
    }
  }

  async function setCurrentProxyPinned(pinned: boolean): Promise<void> {
    if (!onSetProxy || proxySaving || !account.proxyId) return;
    setProxySaving(true);
    try {
      await onSetProxy(account.id, {
        proxyMode: 'pool',
        proxyId: account.proxyId,
        proxyPinned: pinned,
      });
    } finally {
      setProxySaving(false);
    }
  }

  useEffect(() => {
    if (!active || !liveTask) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, liveTask]);

  useEffect(() => {
    if (active) {
      setOpen(true);
      return;
    }
    // 成功后收起本账号的执行时间线；失败和需人工处理的详情继续展开，
    // 用户仍能直接看到原因。收起后仍可手动重新打开查看完整记录。
    if (status === 'done') setOpen(false);
  }, [active, status]);

  return (
    <motion.div
      ref={ref}
      data-account-id={account.id}
      data-account-status={status}
      layout="position"
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 6 }}
      className={cn('border-l-2 px-3 py-3 transition-colors hover:bg-slate-50 dark:hover:bg-slate-900/50', statusBorder(status), selected && 'bg-rose-50 dark:bg-rose-950/20')}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 sm:flex-nowrap sm:gap-3">
        <div data-account-summary className="flex min-w-0 basis-full items-start gap-3 sm:basis-auto sm:flex-1 sm:items-center">
          {selectionMode && <button type="button" disabled={selectionDisabled} onClick={() => onToggleSelect?.(account.id)} aria-pressed={selected} aria-label={selectionDisabled ? `${account.label || account.username}：${disabledSelectionLabel}` : `${selected ? '取消选择' : '选择'}账号 ${account.label || account.username}`} title={selectionDisabled ? disabledSelectionLabel : selected ? '取消选择账号' : '选择账号'} className={cn('grid size-6 shrink-0 place-items-center rounded-md disabled:cursor-not-allowed disabled:opacity-45', selected ? 'bg-rose-500 text-white' : 'bg-slate-100 text-slate-500 dark:bg-slate-900')}>
            {selected ? <Check className="size-3.5" /> : <Square className="size-4" />}
          </button>}
          <Initial status={status} name={account.label || account.username} />
          <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <strong className="truncate text-sm text-slate-900 dark:text-white" title={account.label || account.username}>{account.label || account.username}</strong>
            {result && <span className="shrink-0 text-[10px] tabular-nums text-slate-400">{new Date(result.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>}
          </div>
          {account.label && <p className="truncate text-[11px] text-slate-500" title={account.username}>{account.username}</p>}
          {active && <p className={cn('mt-1 flex items-center gap-1.5 text-[11px] font-medium', status === 'attention' ? 'text-cyan-700 dark:text-cyan-300' : 'text-blue-700 dark:text-blue-300')}>
            {status === 'attention' ? <ShieldAlert className="size-3" /> : <Loader2 className="size-3 animate-spin" />}
            <span className="truncate">{liveTask ? stageLabel(liveTask.stage, method) : '正在执行'}</span><span className="shrink-0 tabular-nums opacity-65">{formatElapsed(now - (liveTask?.startedAt ?? now))}</span>
          </p>}
          {!active && result?.message && <p className={cn('mt-0.5 truncate text-[11px]', status === 'failed' ? 'text-rose-600 dark:text-rose-400' : 'text-slate-500')} title={result.message}>{result.message}</p>}
          {queued && status === 'pending' && <p className="mt-1 text-[11px] text-slate-500">排队中，等待前一个账号完成</p>}
          {/**
            * 学习入口旁的一句话说明：先手动登录，再完成一次签到，最后结束学习。
            *
            * 只在这一行**没有**在录、且真的可以开始时出现（录制中由下方的详细引导接管），
            * 避免和「正在学习」面板里的长文案重复。
            */}
          {onLearn && !learning && canStartLearn && <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
            先手动登录，再完成一次签到，最后点「结束学习」；若本站登录成功后即算签到、没有签到按钮，登录后改点「登录即签到」。全程不要点「退出登录」。
          </p>}
          <div className="mt-1 flex flex-wrap gap-1">
            {siteName && <Tag tone="slate" title={`所属站点：${siteName}`}><Globe2 className="size-3" />{siteName}</Tag>}
            {reward && <Tag tone="emerald" title={rewardTitle}><Coins className="size-3" />{reward}</Tag>}
            {balanceRefreshing
              ? <Tag tone="slate"><Loader2 className="size-3 animate-spin" />读取余额…</Tag>
              : balance
                ? <Tag tone="blue" title={balance.age ? `余额更新于 ${balance.age}` : undefined}><Coins className="size-3" />{balance.text}{balance.age && <span className="opacity-60">· {balance.age}</span>}</Tag>
                /* 读不到必须说原因：站点没有余额接口、登录态失效、被代理挡住，
                   对用户是三种不同的处置。留空只会让人以为扩展坏了。 */
                : balanceError
                  ? <Tag tone="slate" title={balanceError}><Coins className="size-3" />余额未获取</Tag>
                  : null}
            {result?.via === 'headless' && <Tag tone="emerald"><Zap className="size-3" />API 直连</Tag>}
            {proxyLabel && <Tag tone={proxyLabel.kind === 'invalid' || proxyLabel.kind === 'name-only' ? 'rose' : 'slate'} title={proxyEndpoint}>{proxyLabel.kind === 'direct' ? '直连' : proxyLabel.kind === 'invalid' ? proxyLabel.label : proxyLabel.kind === 'name-only' ? `节点名无出口 · ${proxyLabel.label}` : `${proxyLabel.inherited ? '站点代理' : account.proxyMode === 'custom' ? '自定义代理' : account.proxyPinned ? '手动代理' : '自动代理'} · ${proxyLabel.label}`}</Tag>}
            {proxyEndpoint && (
              <Tag tone="slate" title="实际使用的代理地址"><span className="max-w-[220px] truncate">{proxyEndpoint}</span></Tag>
            )}
          </div>
          {!selectionMode && onSetProxy && (
            <div className="mt-1.5 flex min-w-0 items-center gap-1.5">
              <Globe2 className="size-3 shrink-0 text-slate-400" />
              <span className="shrink-0 text-[10px] text-slate-400">分配代理</span>
              <select
                value={proxyChoice}
                disabled={proxySaving || active || queued}
                onChange={(event) => { void setProxyChoice(event.target.value); }}
                aria-label={`手动设置 ${account.label || account.username} 的代理`}
                title={active || queued ? '任务执行或排队期间不能更换代理，请先停止任务' : '选择后立即保存，并固定为手动代理'}
                className="min-w-0 max-w-full flex-1 rounded-md border border-slate-200 bg-white px-1.5 py-1 text-[10px] text-slate-700 outline-none transition-colors focus:border-blue-400 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
              >
                <option value="__inherit__">跟随站点代理{siteProxyName ? ` · ${siteProxyName}` : ''}</option>
                <option value="__direct__">不使用代理（直连）</option>
                <option value="__custom__">自定义代理地址（打开账号编辑）</option>
                {proxies.map((proxy) => (
                  <option key={proxy.id} value={proxy.id} disabled={proxy.nameOnly}>
                    {proxy.name}{proxy.nameOnly
                      ? '（仅名称，无出口）'
                      : ` · ${effectiveProxyScheme(proxy)}://${proxy.host}:${proxy.port} · 已用 ${proxyUsage.get(proxy.id) ?? 0}${(proxyUsage.get(proxy.id) ?? 0) === leastProxyUsage ? ' · 推荐' : ''}`}
                  </option>
                ))}
              </select>
              {account.proxyMode === 'pool' && account.proxyId && !active && !queued && (
                <button
                  type="button"
                  onClick={() => { void setCurrentProxyPinned(!account.proxyPinned); }}
                  title={account.proxyPinned ? '取消手动固定，保留当前节点但允许后续自动分配覆盖' : '固定当前自动代理，后续自动分配不再覆盖'}
                  aria-label={`${account.proxyPinned ? '取消固定' : '固定'} ${account.label || account.username} 当前使用的代理`}
                  className="grid size-6 shrink-0 place-items-center rounded-md text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40"
                >
                  {account.proxyPinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                </button>
              )}
              {proxySaving && <Loader2 className="size-3 shrink-0 animate-spin text-blue-500" />}
            </div>
          )}
          </div>
        </div>

        <button data-account-status-control type="button" disabled={selectionMode || !clickable} onClick={() => clickable && onRun(account.id)} title={clickable ? `执行${words.noun}` : statusLabelFor(status, method)} className={cn('shrink-0 rounded-full', clickable && 'cursor-pointer')}>
          <StatusBadge status={status} evidence={evidence ?? undefined} method={method} />
        </button>
        {/**
          * 动作区在宽屏下**限宽**并允许自己换行。
          *
          * 管理页是两列卡片，窄卡片里的带文字操作会占用横向空间；不给上限时动作区
          * 会把左侧账号摘要挤窄，名字、备注、余额和刚学到的动作都难以阅读。
          * 限宽后操作可换行，摘要列始终有可读宽度。
          */}
        {!selectionMode && <div data-account-actions className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-0.5 sm:max-w-[16rem] sm:flex-none">
          {clickable && <Action title={`执行${words.noun}`} accent onClick={() => onRun(account.id)}><Play className="size-3.5 fill-current" /></Action>}
          {onEdit && <Action title="编辑账号" onClick={() => onEdit(account)}><Pencil className="size-3.5" /></Action>}
          {onRefreshBalance && <Action title={balanceRefreshing ? '正在读取余额' : '刷新余额'} onClick={() => !balanceRefreshing && onRefreshBalance(account.id)}>{balanceRefreshing ? <Loader2 className="size-3.5 animate-spin" /> : <Coins className="size-3.5" />}</Action>}
          {onCaptureSession && <Action title="抓取或更新登录态" onClick={() => onCaptureSession(account.id)}><KeyRound className="size-3.5" /></Action>}
          {onLearn && (learning || canStartLearn) && <Action
            label={learning ? '结束学习' : '学习本站流程'}
            title={learning
              ? `结束学习并保存${(learning.kind ?? 'both') === 'both' ? '登录与签到' : learning.kind === 'login' ? '登录' : '签到'}流程`
              : '学习本站登录与签到流程：先手动登录，再完成一次签到，最后点「结束学习」——一次演示同时学会登录配置与签到步骤；只保存可安全回放的选择器（本站账号共用），不保存账号或密码内容'}
            onClick={() => onLearn(account.id, learning ? learning.kind ?? 'both' : 'both')}
            accent
          ><BookOpen className="size-3.5" /></Action>}
          {learning && onCancelLearn && <Action title="放弃本次学习，不保存流程" danger onClick={() => onCancelLearn(account.id)}><X className="size-3.5" /></Action>}
          {inFlight && onRetry && <Action title={`停止并重新${words.noun}`} accent onClick={() => onRetry(account.id)}><RotateCw className="size-3.5" /></Action>}
          {(inFlight || queuedPending) && onStop && <Action title={inFlight ? '停止任务，改回待执行' : '从队列中移除'} onClick={() => onStop(account.id)}><Ban className="size-3.5" /></Action>}
          {markable && onMarkDone && <Action title={`手动标记为${words.done}`} onClick={() => onMarkDone(account.id)}><CheckCheck className="size-3.5" /></Action>}
          {resettable && onReset && <Action title={`收回${words.done}状态，改为${words.pending}`} accent onClick={() => onReset(account.id)}><RotateCcw className="size-3.5" /></Action>}
          {hasDetails && <Action title={open ? '收起账号详情' : '查看账号详情'} onClick={() => setOpen((value) => !value)}><motion.span animate={{ rotate: open ? 180 : 0 }} className="block"><ChevronDown className="size-3.5" /></motion.span></Action>}
          <Action title="删除账号" danger onClick={() => onRemove(account.id)}><Trash2 className="size-3.5" /></Action>
        </div>}
      </div>

      {/**
        * 学习进度、动作回看和完整性自检放在整行**下方、独占整宽**。
        *
        * 原因：动作列表和学习说明需要完整行宽，避免窄卡片挤压后难以阅读。
        */}
      {learning && <div data-learning-panel className="mt-2 space-y-1 rounded-lg bg-violet-50 px-2.5 py-2 text-[11px] leading-relaxed dark:bg-violet-950/40">
        <p className="flex items-center gap-1.5 font-medium text-violet-700 dark:text-violet-300"><BookOpen className="size-3 shrink-0" />正在学习{learningKindLabel(learning.kind)}，已记录 {learningActionCount(learning.preview, learning.eventCount)} 个动作</p>
        <LearningProgressSteps guide={learning.guide} />
        <LearningSteps title="正在记录的动作" preview={learning.preview} testId="learning-live-steps" />
        <p className="text-slate-500">{learning.guide?.hint ?? learningGuide(learning.kind)}</p>
        {learning.guide?.warning && <p className="text-amber-700 dark:text-amber-400">{learning.guide.warning}</p>}
        {/**
          * 「登录即签到」出口。
          *
          * 站点没有签到按钮时，正常流程永远录不到「点击签到」这一步；按钮只在
          * 后台判定「登录已生效、没点退出登录、也没录到签到动作」时出现，
          * 点它 = 结束学习并按登录即签到保存（后台用同一判据复核）。
          */}
        {learning.loginAsCheckinAvailable && onLearn && <div className="pt-0.5">
          <button
            type="button"
            data-learning-login-as-checkin
            onClick={() => onLearn(account.id, learning.kind ?? 'both', { loginAsCheckin: true })}
            title="本站是「登录即签到」时点这里：登录成功后即算完成签到，不再需要点签到按钮。保存后自动签到按登录即签到收尾"
            className="rounded-md bg-violet-600 px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-violet-700"
          >登录即签到（没有签到按钮）</button>
        </div>}
      </div>}
          {/**
            * 学习结束后回看：会话已经被后台清空，摘要由管理页在结束那一刻截下来。
            *
            * 目的很直接 —— 用户点完「结束学习」，还应该能看见「刚才我做的哪几步被记住了」，
            * 而不是只拿到一句结论。这里同样只渲染脱敏摘要，不含输入值与选择器。
            */}
          {!learning && <LearningSteps title="这次学到的动作" preview={learnedSteps} testId="learning-last-steps" tone="slate" />}
          {/**
            * 完整性自检（保存后由管理页带回来）：逐行列出「学到了什么 / 缺什么」。
            *
            * 它在**录制结束之后**才出现（learning 已经清空），所以刻意放在
            * 「正在学习」面板之外 —— 放在里面会在用户点「结束学习」的瞬间消失。
            * 只渲染后台给出的固定文案，这里不自行判断，也绝不显示页面内容或输入值。
            */}
          {!learning && learningNotice && learningNotice.lines.length > 0 && <div data-learning-notice={learningNotice.verdict} className="mt-1 rounded-lg bg-slate-100 px-2 py-1.5 text-[11px] leading-relaxed dark:bg-slate-800/70">
            <p className="mb-1 font-medium text-slate-700 dark:text-slate-200">{learningNoticeTitle(learningNotice.verdict)}</p>
            <ul className="space-y-0.5">
              {learningNotice.lines.map((line, index) => <li key={index} className="break-words text-slate-600 dark:text-slate-300">{line.text}</li>)}
            </ul>
          </div>}

      <AnimatePresence initial={false}>
        {!selectionMode && open && hasDetails && <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="mt-3 overflow-hidden rounded-lg border border-slate-100 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/60">
          <div className="space-y-2 px-3 py-2.5">
            {/**
              * 失败诊断：标题 + 说明 + 下一步，用户能自己修。
              *
              * 原始失败说明仍然显示（在账号行的摘要行里，不在这一块），
              * 诊断负责的是「我该做什么」，两者不互相替代。
              */}
            {result && !result.ok && <DiagnosisHint code={diagnoseFailure(result.message, result.steps).code} />}
            {refreshedLedgerReward && <p className="text-[11px] text-emerald-700 dark:text-emerald-300">余额刷新读到今日签到奖励 +{refreshedLedgerReward}（页面台账）</p>}
            {result?.ok && describeEvidence(evidence, result) && <p className="text-[11px] text-slate-500">{describeEvidence(evidence, result)}</p>}
            {balanceHistory.length > 0 && <BalanceHistoryList rows={balanceHistory} quotaPerUnit={quotaPerUnit} family={adapterFamily} />}
            {steps.length > 0 && <ol className={cn('space-y-1.5', balanceHistory.length > 0 && 'border-t border-slate-200 pt-2 dark:border-slate-700')}>
              {steps.map((step, index) => <li key={`${index}-${step}`} className="flex items-start gap-2 text-[11px] leading-5 text-slate-600 dark:text-slate-300"><span className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', index === steps.length - 1 && active ? 'bg-blue-500' : 'bg-slate-300 dark:bg-slate-600')} /><span>{step}</span></li>)}
            </ol>}
          </div>
        </motion.div>}
      </AnimatePresence>
    </motion.div>
  );
}

function Initial({ name, status }: { name: string; status: DailyStatus }) {
  return <span className={cn('grid size-9 shrink-0 place-items-center rounded-lg text-xs font-bold', status === 'done' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' : status === 'failed' ? 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300' : status === 'attention' ? 'bg-cyan-50 text-cyan-700 dark:bg-cyan-950/40 dark:text-cyan-300' : status === 'running' ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300' : 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300')}>{name.trim().slice(0, 1).toUpperCase()}</span>;
}
function Tag({ children, tone, title }: { children: React.ReactNode; tone: 'emerald' | 'blue' | 'rose' | 'slate'; title?: string }) {
  const tones = { emerald: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300', blue: 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300', rose: 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300', slate: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' };
  return <span title={title} className={cn('inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium', tones[tone])}>{children}</span>;
}
/** 学习类型的中文标签（固定文案，不含任何页面内容）。 */
function learningKindLabel(kind?: LearningKind): string {
  if (kind === 'login') return '登录';
  if (kind === 'both') return '登录与签到';
  if (kind === 'checkin') return '签到';
  return '登录与签到';
}

/**
 * 学习中的引导文案。
 *
 * 统一入口按 `both` 开始，覆盖两段：先手动登录，再完成一次签到。
 * 兼容已有会话的 kind；若旧会话是 `login`，继续显示对应的登录引导。
 * 「签到按钮就在个人资料页上时直接在该页签到，否则先经过资料页核验身份」这句必须保留 ——
 * 它解释了回放时为什么要先核对账号，也是既有 e2e 与单测断言的原文。
 */
function learningGuide(kind?: LearningKind): string {
  if (kind === 'login') {
    return '本次请手动完成登录，再点「结束学习」。只保存可安全回放的选择器（本站账号共用），不保存账号或密码内容。';
  }
  return '本次请先手动登录；然后在能显示当前账号的页面上完成一次签到（签到按钮就在个人资料页上时，直接在该页签到即可；否则先经过资料页核验身份，再进入签到页签到），最后点「结束学习」。只保存可安全回放的选择器（本站账号共用），不保存账号或密码内容。';
}

/**
 * 「① 登录 → ② 账号页 → ③ 签到 → ④ 结束」步骤条（可视化的学习进度）。
 *
 * 数据来自后台对事件流的阶段判定（learning-stage.ts 的 guideViewOf），与页面上的
 * 一体化浮层是同一份：标签全是固定短词，不含页面内容与输入值。旧后台没有 guide
 * 时整块不渲染 —— 绝不自己猜阶段。
 */
function LearningProgressSteps({ guide }: { guide?: LearningGuideView }) {
  if (!guide || guide.steps.length === 0) return null;
  return (
    <div data-learning-steps-bar={guide.step} className="flex flex-wrap items-center gap-1">
      {guide.steps.map((step, index) => (
        <span
          key={`${index}-${step.label}`}
          data-learning-step={step.state}
          className={cn(
            'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium',
            step.state === 'current' && 'bg-violet-600/15 text-violet-700 dark:text-violet-300',
            step.state === 'done' && 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
            step.state === 'todo' && 'bg-slate-500/10 text-slate-500 dark:text-slate-400',
          )}
        >
          <span className="opacity-60">{index + 1}</span>{step.label}
        </span>
      ))}
    </div>
  );
}

/**
 * 动作类型的图标。
 *
 * 给出区分度，但**不参与** aria 名称 —— 既有 e2e 里有 34 条可访问性断言按
 * 按钮名称定位，图标一律 aria-hidden，避免把可访问名称搞得忽长忽短。
 */
function LearningPreviewIcon({ kind }: { kind: LearningPreviewKind | 'unknown' }) {
  const className = 'size-3 shrink-0 opacity-70';
  if (kind === 'click') return <MousePointerClick className={className} aria-hidden="true" />;
  if (kind === 'fill') return <TextCursorInput className={className} aria-hidden="true" />;
  if (kind === 'scroll') return <ScrollText className={className} aria-hidden="true" />;
  if (kind === 'drag') return <Move className={className} aria-hidden="true" />;
  if (kind === 'navigation') return <Compass className={className} aria-hidden="true" />;
  return <CircleDot className={className} aria-hidden="true" />;
}

const LEARNING_STEPS_TONES = {
  violet: {
    box: 'rounded-lg bg-violet-50 px-2 py-1.5 dark:bg-violet-950/40',
    title: 'text-violet-800 dark:text-violet-200',
    row: 'text-violet-700/80 dark:text-violet-300/80',
  },
  slate: {
    box: 'rounded-lg bg-slate-100 px-2 py-1.5 dark:bg-slate-800/70',
    title: 'text-slate-700 dark:text-slate-200',
    row: 'text-slate-600 dark:text-slate-300',
  },
} as const;

/**
 * 「学到了哪些动作」的共用列表。
 *
 * 只接受 `{ kind, text }`：其余字段（路径、时间戳、坐标、任何未来新增的内部字段）
 * 在类型层面就进不来 —— 隐私保证靠类型收窄 + 纯函数截断，而不是靠调用方自觉。
 *
 * 没有任何可展示条目时**整块不渲染**，不会留下一个空标题。
 */
function LearningSteps({ title, preview, testId, tone = 'violet' }: {
  title: string;
  preview: readonly WorkflowLearningPreview[] | undefined;
  testId: string;
  tone?: keyof typeof LEARNING_STEPS_TONES;
}) {
  const steps = learningPreviewViewSet(preview);
  if (steps.items.length === 0) return null;
  const palette = LEARNING_STEPS_TONES[tone];
  return (
    <div data-learning-steps={testId} className={palette.box}>
      <p className={`mb-1 font-medium ${palette.title}`}>{title}</p>
      <ul className="space-y-0.5">
        {steps.items.map((item) => (
          <li key={item.index} className={`flex items-start gap-1.5 ${palette.row}`}>
            <span className="shrink-0 tabular-nums opacity-60">{item.index}.</span>
            <LearningPreviewIcon kind={item.kind} />
            <span className="break-all">{item.text}</span>
          </li>
        ))}
        {steps.hidden > 0 && (
          <li className={`opacity-70 ${palette.row}`}>… 还有 {steps.hidden} 个动作</li>
        )}
      </ul>
    </div>
  );
}

function Action({ title, label, onClick, children, accent = false, danger = false }: { title: string; label?: string; onClick: () => void; children: React.ReactNode; accent?: boolean; danger?: boolean }) {
  return <motion.button whileTap={{ scale: 0.92 }} type="button" title={title} aria-label={title} onClick={onClick} className={cn('shrink-0 rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-900 dark:hover:text-white', label ? 'inline-flex h-7 items-center gap-1 whitespace-nowrap px-2 text-[11px] font-medium' : 'grid size-7 place-items-center', accent && 'text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40', danger && 'hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/40 dark:hover:text-rose-400')}>{children}{label}</motion.button>;
}

function BalanceHistoryList({ rows, quotaPerUnit, family }: { rows: BalanceHistoryRow[]; quotaPerUnit?: number; family?: AdapterFamily }) {
  const scale = { quotaPerUnit, family };
  return (
    <section aria-label="余额历史">
      <div className="flex items-center justify-between gap-2 text-[10px] text-slate-500">
        <span className="inline-flex items-center gap-1 font-semibold text-slate-700 dark:text-slate-200"><Coins className="size-3" />余额记录</span>
        <span>最近 {rows.length} 个日期</span>
      </div>
      <div className="mt-1 divide-y divide-slate-200 dark:divide-slate-700">
        {rows.map((row) => {
          const date = historyDateLabel(row.day);
      const delta = row.withinDayDelta != null
            ? { label: '当天', value: row.withinDayDelta }
            : row.previousDay && row.previousDayDelta != null
              ? { label: `较${historyDateLabel(row.previousDay).label}`, value: row.previousDayDelta }
              : null;
          const sourceTitle = row.latest.source === 'visible'
            ? '页面可见余额；页面未提供累计消耗时，差额证据较弱'
            : '结构化余额接口';
          return (
            <div key={row.day} data-balance-day={row.day} className="grid min-w-0 grid-cols-[minmax(82px,0.8fr)_minmax(100px,1fr)] items-center gap-x-3 gap-y-1 py-1.5 text-[10px] sm:grid-cols-[minmax(100px,0.8fr)_minmax(110px,1fr)_minmax(150px,1.3fr)]">
              <div className="min-w-0">
                <span className="font-semibold text-slate-700 dark:text-slate-200">{date.label}</span>
                {date.detail && <span className="ml-1 text-slate-400">{date.detail}</span>}
              </div>
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="font-semibold tabular-nums text-slate-800 dark:text-slate-100">{formatBalance(row.latest.quota, scale, row.latest.symbol)}</span>
                <span title={sourceTitle} className={cn('shrink-0 font-medium', row.latest.source === 'visible' ? 'text-amber-600 dark:text-amber-400' : 'text-blue-600 dark:text-blue-400')}>{row.latest.source === 'visible' ? '页面' : 'API'}</span>
              </div>
              <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-slate-500 sm:col-span-1 sm:justify-end">
                {delta && <span>{delta.label} <strong className={cn('tabular-nums', delta.value > 0 ? 'text-emerald-600 dark:text-emerald-400' : delta.value < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-600 dark:text-slate-300')}>{formatDelta(delta.value, scale, row.latest.symbol)}</strong></span>}
                {row.checkinReward != null && <span className="text-emerald-700 dark:text-emerald-300">奖励 <strong className="tabular-nums">+{formatQuotaChange(row.checkinReward, scale, row.checkinRewardSymbol)}</strong></span>}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function historyDateLabel(day: string, now = new Date()): { label: string; detail?: string } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return { label: day };
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const current = /^(\d{4})-(\d{2})-(\d{2})$/.exec(todayKey(now));
  if (!current) return { label: day };
  const currentYear = Number(current[1]);
  const currentOrdinal = Date.UTC(currentYear, Number(current[2]) - 1, Number(current[3])) / 86_400_000;
  const ordinal = Date.UTC(year, month - 1, date) / 86_400_000;
  const daysAgo = currentOrdinal - ordinal;
  const detail = `${month}月${date}日`;
  if (daysAgo === 0) return { label: '今天', detail };
  if (daysAgo === 1) return { label: '昨天', detail };
  if (daysAgo === 2) return { label: '前天', detail };
  return year === currentYear ? { label: detail } : { label: `${year}年${detail}` };
}

function formatDelta(
  value: number,
  scale: { quotaPerUnit?: number; family?: AdapterFamily },
  symbol?: AccountBalance['symbol'],
): string {
  const amount = formatQuotaChange(Math.abs(value), scale, symbol);
  if (value > 0) return `+${amount}`;
  if (value < 0) return `-${amount}`;
  return amount;
}
/**
 * 「本次涨了多少」，与余额是两回事：余额是「现在有多少」。
 * 两个标签都要保留 —— 只显示余额看不出这次签到有没有真的到账。
 *
 * 换算走 lib/balance-format：这里曾经自己写了一份 500000 兜底，
 * 与 balance.ts 各写一个必然走偏。
 */
function rewardLabel(metrics: CheckinMetrics | undefined, quotaPerUnit?: number, family?: AdapterFamily): string | null {
  const symbol = metrics?.rewardSymbol ?? metrics?.balanceSymbol;
  return metrics?.verdict === 'rewarded' && metrics.reward
    ? `+${formatQuotaChange(metrics.reward, { quotaPerUnit, family }, symbol)}`
    : null;
}
function statusBorder(status: DailyStatus) { return status === 'done' ? 'border-l-emerald-500' : status === 'running' ? 'border-l-blue-500' : status === 'attention' ? 'border-l-cyan-500' : status === 'failed' ? 'border-l-rose-500' : 'border-l-amber-400'; }

