import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Activity, AlertTriangle, Ban, CheckCircle2, Clock3, Loader2, Timer } from 'lucide-react';
import type { Account, DailyStatus, SiteConfig } from '@/types';
import type { LiveQueue, LiveTask } from '@/lib/messages/live';
import { formatElapsed, stageLabel } from '@/lib/checkin/stage-label';
import { cn } from '@/lib/core/cn';
import { SiteFavicon } from '@/components/SiteFavicon';

interface Props {
  accounts: Account[];
  sites: SiteConfig[];
  live: LiveTask[];
  queue: LiveQueue;
  compact?: boolean;
  statusOf: (accountId: string) => DailyStatus;
  /** 停掉正在执行和排队中的全部任务 */
  onStopAll?: () => void;
}

/** 仅在有执行任务时显示的实时进度面板。 */
export function LiveActivity({ accounts, sites, live, queue, compact = false, statusOf, onStopAll }: Props) {
  const [now, setNow] = useState(() => Date.now());
  const reducedMotion = useReducedMotion();
  const accountMap = useMemo(() => new Map(accounts.map((account) => [account.id, account])), [accounts]);
  const siteMap = useMemo(() => new Map(sites.map((site) => [site.id, site])), [sites]);

  useEffect(() => {
    if (!live.length) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live.length]);

  if (!live.length && !queue.pending.length) return null;

  return (
    <motion.section
      layout
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className="live-console mb-5 overflow-hidden rounded-xl border border-blue-200 bg-white shadow-sm dark:border-blue-900/60 dark:bg-slate-950"
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-blue-100 bg-blue-50/70 px-4 py-3 dark:border-blue-950 dark:bg-blue-950/25">
        <span className="grid size-9 place-items-center rounded-lg bg-blue-600 text-white shadow-sm shadow-blue-600/25">
          <Activity className={cn('size-4', live.length && !reducedMotion && 'animate-pulse')} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-slate-950 dark:text-white">实时执行</h2>
          <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
            {live.length ? `${live.length} 个账号正在执行` : '执行队列已建立，等待下一个账号启动'}
            {queue.pending.length ? ` · ${queue.pending.length} 个排队` : ''}
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-2 py-1 text-[10px] font-semibold text-blue-700 ring-1 ring-blue-200 dark:bg-slate-900 dark:text-blue-300 dark:ring-blue-900">
          <span className="size-1.5 animate-pulse rounded-full bg-blue-500" />运行中
        </span>
        {/* 面板只在有任务时出现，出口就该在这里 —— 任务卡住时用户第一眼看的是它 */}
        {onStopAll && <button type="button" onClick={onStopAll} title="停止正在执行和排队中的全部任务" className="inline-flex h-7 items-center gap-1 rounded-md bg-white px-2 text-[10px] font-semibold text-slate-600 ring-1 ring-slate-200 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-700 dark:hover:bg-slate-800 dark:hover:text-white">
          <Ban className="size-3" />全部停止
        </button>}
      </div>

      <div className={cn('grid', live.length > 1 && !compact ? 'lg:grid-cols-2' : 'grid-cols-1')}>
        <AnimatePresence mode="popLayout">
          {live.map((task, index) => {
            const account = accountMap.get(task.accountId);
            const site = siteMap.get(task.siteId);
            const attention = statusOf(task.accountId) === 'attention';
            const lastStep = task.steps.at(-1);
            return (
              <motion.article
                layout="position"
                key={task.runId}
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }}
                className={cn('min-w-0 px-4 py-3.5', index > 0 && 'border-t border-slate-100 dark:border-slate-800', live.length > 1 && !compact && index % 2 === 1 && 'lg:border-t-0 lg:border-l')}
              >
                <div className="flex min-w-0 items-start gap-3">
                  <SiteGlyph site={site} attention={attention} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-semibold text-slate-900 dark:text-white">{account?.label || account?.username || task.accountId}</div>
                    <div className="mt-0.5 truncate text-[11px] text-slate-500">{site?.name ?? '未知站点'}</div>
                    <div className={cn('mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]', attention ? 'text-cyan-700 dark:text-cyan-300' : 'text-blue-700 dark:text-blue-300')}>
                      {attention ? <AlertTriangle className="size-3" /> : <Loader2 className="size-3 animate-spin" />}
                      <span className="font-medium">{stageLabel(task.stage, task.method ?? site?.checkin?.method)}</span>
                      <span className="inline-flex items-center gap-1 text-slate-500 dark:text-slate-400"><Clock3 className="size-3" />{formatElapsed(now - task.startedAt)}</span>
                    </div>
                    {lastStep && <p className="mt-1.5 truncate text-[11px] text-slate-500 dark:text-slate-400" title={lastStep}>{lastStep}</p>}
                    <ol className="mt-2 space-y-1 border-t border-slate-100 pt-2 dark:border-slate-800">
                      {task.steps.map((step, stepIndex) => (
                        <li key={`${stepIndex}-${step}`} className={cn('flex items-start gap-1.5 text-[10px] leading-4', stepIndex === task.steps.length - 1 ? 'font-medium text-slate-700 dark:text-slate-200' : 'text-slate-500 dark:text-slate-400')}>
                          <span className={cn('mt-1.5 size-1 shrink-0 rounded-full', stepIndex === task.steps.length - 1 ? 'bg-blue-500' : 'bg-slate-300 dark:bg-slate-600')} />
                          <span>{step}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                  <span className="shrink-0 text-[10px] tabular-nums text-slate-400">{task.steps.length} 步</span>
                </div>
              </motion.article>
            );
          })}
        </AnimatePresence>
      </div>

      {queue.pending.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 bg-slate-50 px-4 py-2.5 dark:border-slate-800 dark:bg-slate-900/60">
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-500"><Timer className="size-3.5" />等待队列</span>
          {queue.pending.map((accountId, index) => {
            const account = accountMap.get(accountId);
            return (
              <span key={accountId} className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-white px-2 py-1 text-[10px] text-slate-600 ring-1 ring-slate-200 dark:bg-slate-950 dark:text-slate-300 dark:ring-slate-800">
                <span className="font-semibold tabular-nums text-blue-600">{index + 1}</span>
                <span className="max-w-40 truncate">{account?.label || account?.username || accountId}</span>
              </span>
            );
          })}
        </div>
      )}
    </motion.section>
  );
}

function SiteGlyph({ site, attention }: { site?: SiteConfig; attention: boolean }) {
  const label = (site?.name || '?').trim().slice(0, 1).toUpperCase();
  return (
    <span className={cn('grid size-9 shrink-0 place-items-center overflow-hidden rounded-lg text-xs font-bold ring-1 ring-inset', attention ? 'bg-cyan-50 text-cyan-700 ring-cyan-200 dark:bg-cyan-950/40 dark:text-cyan-300 dark:ring-cyan-900' : 'bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:ring-blue-900')}>
      {site ? <SiteFavicon site={site} className="size-5 rounded" fallback={label} /> : label}
    </span>
  );
}
