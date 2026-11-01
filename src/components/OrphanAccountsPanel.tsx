import { useState } from 'react';
import { AlertTriangle, Link2, Loader2, SquarePlus } from 'lucide-react';
import type { Account, SiteConfig } from '@/types';
import { cn } from '@/lib/core/cn';

interface Props {
  accounts: Account[];
  sites: SiteConfig[];
  compact?: boolean;
  onRecover: (accountId: string, siteId: string) => Promise<void>;
  onAddSite: () => void;
}

export function OrphanAccountsPanel({ accounts, sites, compact = false, onRecover, onAddSite }: Props) {
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<string>();

  async function recover(account: Account) {
    const targetSiteId = targets[account.id];
    if (!targetSiteId || busyId) return;
    setBusyId(account.id);
    setError(undefined);
    try {
      await onRecover(account.id, targetSiteId);
      setTargets((current) => {
        const next = { ...current };
        delete next[account.id];
        return next;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '恢复账号归属失败');
    } finally {
      setBusyId(undefined);
    }
  }

  return (
    <section className="mb-4 overflow-hidden border-y border-amber-300 bg-amber-50/80 dark:border-amber-900 dark:bg-amber-950/20">
      <div className={cn('flex items-start gap-3 px-4 py-3', compact && 'px-3')}>
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300">
          <AlertTriangle className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">待恢复账号</h2>
            <span className="text-[11px] font-medium text-amber-700 dark:text-amber-300">{accounts.length} 个</span>
          </div>
          <p className="mt-0.5 text-[11px] leading-5 text-slate-600 dark:text-slate-300">
            原站点记录已不存在；恢复会保留账号密码、代理和备注，并清除旧站 token、登录方式与会话。
          </p>
        </div>
        {sites.length === 0 && (
          <button
            type="button"
            onClick={onAddSite}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-amber-600 px-2.5 text-[11px] font-semibold text-white hover:bg-amber-700"
          >
            <SquarePlus className="size-3.5" />
            添加站点
          </button>
        )}
      </div>

      <div className="divide-y divide-amber-200/80 border-t border-amber-200/80 dark:divide-amber-900/70 dark:border-amber-900/70">
        {accounts.map((account) => {
          const targetSiteId = targets[account.id] ?? '';
          const busy = busyId === account.id;
          return (
            <div key={account.id} className={cn('flex flex-wrap items-center gap-3 px-4 py-3', compact && 'px-3')}>
              <div className="min-w-[180px] flex-1">
                <p className="truncate text-sm font-semibold text-slate-900 dark:text-white" title={account.label || account.username}>
                  {account.label || account.username}
                </p>
                {account.label && <p className="truncate text-[11px] text-slate-500" title={account.username}>{account.username}</p>}
                <p className="mt-0.5 truncate font-mono text-[10px] text-slate-500" title={account.siteId}>原站点 ID: {account.siteId}</p>
              </div>

              {sites.length > 0 && (
                <div className="flex min-w-0 basis-full items-center gap-2 sm:basis-auto">
                  <select
                    value={targetSiteId}
                    disabled={busy}
                    onChange={(event) => setTargets((current) => ({ ...current, [account.id]: event.target.value }))}
                    aria-label={`选择 ${account.label || account.username} 的所属站点`}
                    className="h-8 min-w-0 flex-1 rounded-md border border-amber-300 bg-white px-2 text-[11px] text-slate-800 outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-500/15 disabled:opacity-50 dark:border-amber-900 dark:bg-slate-950 dark:text-slate-100 sm:w-48"
                  >
                    <option value="">选择所属站点</option>
                    {sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
                  </select>
                  <button
                    type="button"
                    disabled={!targetSiteId || busy || !!busyId}
                    onClick={() => void recover(account)}
                    className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-slate-900 px-2.5 text-[11px] font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100"
                  >
                    {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Link2 className="size-3.5" />}
                    {busy ? '正在恢复' : '恢复归属'}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {error && <p className="border-t border-rose-200 bg-rose-50 px-4 py-2 text-[11px] text-rose-700 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300">{error}</p>}
    </section>
  );
}
