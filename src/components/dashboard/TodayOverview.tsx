import { motion, useReducedMotion } from 'motion/react';
import { AlertTriangle, CheckCircle2, Clock3, Coins, Loader2, Play, ShieldAlert } from 'lucide-react';
import { cn } from '@/lib/core/cn';
import { formatBalanceTotal, type BalanceTotal } from '@/lib/balance/balance-format';

export interface StatusCounts {
  total: number;
  done: number;
  pending: number;
  running: number;
  attention: number;
  failed: number;
  actionable: number;
  progress: number;
}

/** 今日任务概览：只表达真实队列状态和下一步操作。 */
export function TodayOverview({ stats, balanceTotal, onRunAll, actionableCount, searchScoped = false, compact = false }: { stats: StatusCounts; balanceTotal: BalanceTotal; onRunAll: () => void; actionableCount?: number; searchScoped?: boolean; compact?: boolean }) {
  const reducedMotion = useReducedMotion();
  const progress = Math.min(Math.max(stats.progress, 0), 100);
  const summary = summaryFor(stats);
  // 「执行待签到」按当前搜索范围运行：有搜索词时按钮反映的是可见账号数。
  const runnable = actionableCount ?? stats.actionable;

  return (
    <section className="mb-5 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 px-4 py-3.5 dark:border-slate-800">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">今日队列</p>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <strong className="text-2xl font-bold tabular-nums text-slate-950 dark:text-white">{stats.done}<span className="text-slate-300 dark:text-slate-700"> / </span>{stats.total}</strong>
            <span className="text-sm text-slate-500">个账号已完成</span>
          </div>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{summary}</p>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {runnable > 0 && (
            <motion.button
              whileHover={reducedMotion ? undefined : { y: -1 }}
              whileTap={reducedMotion ? undefined : { scale: 0.98 }}
              type="button"
              onClick={onRunAll}
              title={searchScoped ? '按当前搜索范围执行' : undefined}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-blue-600 px-3.5 text-xs font-semibold text-white shadow-sm shadow-blue-600/20 transition-colors hover:bg-blue-700"
            >
              <Play className="size-3.5 fill-current" />
              执行待签到（{runnable}）
            </motion.button>
          )}
        </div>
      </div>

      <div className="px-4 pt-3.5">
        <div className="mb-2 flex items-center justify-between text-[11px] font-medium text-slate-500">
          <span>执行进度</span>
          <span className="tabular-nums">{progress}%</span>
        </div>
        <div
          className="relative flex h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
          role="progressbar"
          aria-label="今日执行进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <Segment value={stats.done} total={stats.total} className="bg-emerald-500" />
          <Segment value={stats.running} total={stats.total} className="bg-blue-500" />
          <Segment value={stats.pending} total={stats.total} className="bg-amber-400" />
          <Segment value={stats.attention} total={stats.total} className="bg-cyan-500" />
          <Segment value={stats.failed} total={stats.total} className="bg-rose-500" />
          {!reducedMotion && stats.running > 0 && (
            <motion.span
              className="absolute top-1/2 size-3 -translate-y-1/2 rounded-full border-2 border-white bg-blue-600 shadow-sm dark:border-slate-950"
              initial={false}
              animate={{ left: [`${Math.max(1, progress - 2)}%`, `${Math.min(98, progress + 2)}%`, `${Math.max(1, progress - 2)}%`] }}
              transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
              aria-hidden="true"
            />
          )}
        </div>
      </div>

      <div className={cn('grid gap-px bg-slate-100 p-px dark:bg-slate-800', compact ? 'grid-cols-2' : 'grid-cols-2 md:grid-cols-6')}>
        <Metric icon={<CheckCircle2 />} label="已完成" value={stats.done} tone="text-emerald-600" />
        <Metric icon={<Clock3 />} label="待签到" value={stats.pending} tone="text-amber-600" />
        <Metric icon={<Loader2 className={stats.running ? 'animate-spin' : ''} />} label="执行中" value={stats.running} tone="text-blue-600" />
        <Metric icon={<ShieldAlert />} label="需处理" value={stats.attention} tone="text-cyan-600" />
        <Metric icon={<AlertTriangle />} label="失败" value={stats.failed} tone="text-rose-600" />
        <div className="flex items-center gap-2 bg-white px-3 py-2.5 dark:bg-slate-950">
          <span className="grid size-7 place-items-center rounded-md bg-blue-50 text-blue-600 dark:bg-blue-950/40 dark:text-blue-300"><Coins className="size-3.5" /></span>
          <span className="min-w-0">
            <span className="block text-[11px] text-slate-500">已读余额</span>
            <strong className="block text-sm tabular-nums text-slate-900 dark:text-white">{formatBalanceTotal(balanceTotal)}</strong>
            {balanceTotal.missing > 0 && <span className="block text-[10px] text-amber-600">{balanceTotal.missing} 个未获取</span>}
          </span>
        </div>
      </div>
    </section>
  );
}

function Segment({ value, total, className }: { value: number; total: number; className: string }) {
  const width = total > 0 ? `${(value / total) * 100}%` : '0%';
  return <motion.span initial={false} animate={{ width }} transition={{ type: 'spring', stiffness: 180, damping: 25 }} className={cn('h-full shrink-0', className)} />;
}

function Metric({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: number; tone: string }) {
  return (
    <div className="flex items-center gap-2 bg-white px-3 py-2.5 dark:bg-slate-950">
      <span className={cn('grid size-7 place-items-center rounded-md bg-slate-50 dark:bg-slate-900', tone)}>{icon}</span>
      <span className="min-w-0">
        <span className="block text-[11px] text-slate-500">{label}</span>
        <strong className="block text-sm tabular-nums text-slate-900 dark:text-white">{value}</strong>
      </span>
    </div>
  );
}

function summaryFor(stats: StatusCounts) {
  if (stats.failed > 0) return `${stats.failed} 个账号失败，建议先查看失败原因后重试。`;
  if (stats.attention > 0) return `${stats.attention} 个账号等待人工处理页面验证。`;
  if (stats.running > 0) return `${stats.running} 个账号正在执行，队列将自动继续。`;
  if (stats.actionable > 0) return `${stats.actionable} 个账号已准备好，可以开始执行。`;
  if (stats.total > 0) return '今天的队列已经完成。';
  return '先添加站点和账号，再开始管理签到任务。';
}
