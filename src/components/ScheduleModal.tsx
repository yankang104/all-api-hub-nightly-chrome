import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CalendarClock, Check, CheckCheck, Globe2, Loader2, Minus, Power, Users } from 'lucide-react';
import type { Account, CheckinSchedule, SiteConfig } from '@/types';
import {
  nextScheduledAt,
  normalizeSchedule,
  pruneScheduleAccountIds,
  WEEKDAY_LABELS,
} from '@/lib/checkin/schedule';
import { cn } from '@/lib/core/cn';
import { Modal, Field, inputCls, btnPrimary } from './Modal';

interface Props {
  open: boolean;
  schedule: CheckinSchedule;
  sites: SiteConfig[];
  accounts: Account[];
  onClose: () => void;
  onSave: (schedule: CheckinSchedule) => Promise<void>;
}

interface AccountGroup {
  siteId: string;
  siteName: string;
  accounts: Account[];
}

function formatNextRun(schedule: CheckinSchedule): string {
  const next = nextScheduledAt(schedule);
  if (!next) return '未安排';
  const weekday = WEEKDAY_LABELS[next.getDay()];
  const today = new Date();
  const sameDay = next.toDateString() === today.toDateString();
  return `${sameDay ? '今天' : `${next.getMonth() + 1}/${next.getDate()} 周${weekday}`} ${schedule.time}`;
}

function selectionText(schedule: CheckinSchedule, accountCount: number, selectedCount: number): string {
  if (schedule.accountIds === undefined) return `全部账号${accountCount ? ` (${accountCount})` : ''}`;
  if (selectedCount === 0) return '未选择账号';
  return `已选 ${selectedCount} 个账号`;
}

function Marker({ selected, partial = false }: { selected: boolean; partial?: boolean }) {
  return (
    <span
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded border transition-colors',
        selected || partial
          ? 'border-brand-500 bg-brand-500 text-white'
          : 'border-ink-800/20 bg-white/70 dark:border-white/20 dark:bg-ink-900/70',
      )}
      aria-hidden="true"
    >
      {partial ? <Minus className="size-3" /> : selected ? <Check className="size-3" /> : null}
    </span>
  );
}

export function ScheduleModal({ open, schedule, sites, accounts, onClose, onSave }: Props) {
  const allAccountIds = useMemo(() => accounts.map((account) => account.id), [accounts]);
  const accountIdSet = useMemo(() => new Set(allAccountIds), [allAccountIds]);
  const groups = useMemo<AccountGroup[]>(() => {
    const grouped = sites.map((site) => ({
      siteId: site.id,
      siteName: site.name,
      accounts: accounts.filter((account) => account.siteId === site.id),
    }));
    const knownSiteIds = new Set(sites.map((site) => site.id));
    const orphanAccounts = accounts.filter((account) => !knownSiteIds.has(account.siteId));
    if (orphanAccounts.length) grouped.push({ siteId: '__orphan__', siteName: '未归属站点', accounts: orphanAccounts });
    return grouped.filter((group) => group.accounts.length > 0);
  }, [accounts, sites]);

  const [draft, setDraft] = useState<CheckinSchedule>(() => (
    pruneScheduleAccountIds(normalizeSchedule(schedule), allAccountIds)
  ));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (open) {
      setDraft(pruneScheduleAccountIds(normalizeSchedule(schedule), allAccountIds));
      setError(undefined);
    }
  }, [allAccountIds, open, schedule]);

  const valid = /^\d{2}:\d{2}$/.test(draft.time) && draft.weekdays.length > 0;
  const selectedIds = useMemo(
    () => new Set(draft.accountIds === undefined ? allAccountIds : draft.accountIds.filter((id) => accountIdSet.has(id))),
    [accountIdSet, allAccountIds, draft.accountIds],
  );
  const selectedCount = draft.accountIds === undefined ? accounts.length : selectedIds.size;
  const allSelected = draft.accountIds === undefined;
  const nextRun = useMemo(() => (valid && draft.enabled ? formatNextRun(draft) : '未启用'), [draft, valid]);

  function toggleDay(day: number) {
    setDraft((current) => {
      const weekdays = current.weekdays.includes(day)
        ? current.weekdays.filter((item) => item !== day)
        : [...current.weekdays, day].sort((a, b) => a - b);
      return { ...current, weekdays };
    });
  }

  function replaceSelectedIds(ids: Iterable<string>) {
    const next = [...new Set(ids)].filter((id) => accountIdSet.has(id)).sort();
    setDraft((current) => ({ ...current, accountIds: next }));
  }

  function toggleAccount(accountId: string) {
    const next = new Set(selectedIds);
    if (next.has(accountId)) next.delete(accountId);
    else next.add(accountId);
    replaceSelectedIds(next);
  }

  function toggleSite(group: AccountGroup) {
    const next = new Set(selectedIds);
    const siteAccountIds = group.accounts.map((account) => account.id);
    const shouldRemove = siteAccountIds.every((accountId) => next.has(accountId));
    siteAccountIds.forEach((accountId) => {
      if (shouldRemove) next.delete(accountId);
      else next.add(accountId);
    });
    replaceSelectedIds(next);
  }

  function selectAll() {
    setDraft((current) => ({ ...current, accountIds: undefined }));
  }

  function clearAll() {
    setDraft((current) => ({ ...current, accountIds: [] }));
  }

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const cleaned = pruneScheduleAccountIds({
        ...draft,
        time: draft.time,
        weekdays: [...new Set(draft.weekdays)].sort((a, b) => a - b),
      }, allAccountIds);
      await onSave(cleaned);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} title="定时签到" wide onClose={() => !busy && onClose()}>
      <div className="space-y-5">
        <motion.div
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          className={cn(
            'flex items-center gap-3 rounded-xl px-3.5 py-3 ring-1 transition-colors',
            draft.enabled
              ? 'bg-mint-500/10 text-mint-700 ring-mint-500/20 dark:text-mint-300'
              : 'bg-ink-50 text-ink-800/55 ring-black/5 dark:bg-ink-900/60 dark:text-ink-100/45 dark:ring-white/10',
          )}
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/80 shadow-sm dark:bg-white/10">
            <CalendarClock className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">后台计划</div>
            <div className="mt-0.5 text-[11px] opacity-70">下一次：{nextRun}</div>
          </div>
          <label className="relative inline-flex shrink-0 cursor-pointer items-center" title={draft.enabled ? '关闭定时签到' : '开启定时签到'}>
            <input
              type="checkbox"
              className="peer sr-only"
              aria-label={draft.enabled ? '关闭定时签到' : '开启定时签到'}
              checked={draft.enabled}
              onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))}
            />
            <span className="h-6 w-11 rounded-full bg-ink-900/15 transition-colors peer-checked:bg-mint-500 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500/50 dark:bg-white/15" />
            <span className="absolute left-1 top-1 flex size-4 items-center justify-center rounded-full bg-white shadow transition-transform peer-checked:translate-x-5 dark:bg-ink-50">
              <Power className="size-2.5 text-ink-800/45" />
            </span>
          </label>
        </motion.div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="执行时间">
            <input
              type="time"
              className={inputCls}
              value={draft.time}
              onChange={(event) => setDraft((current) => ({ ...current, time: event.target.value }))}
            />
          </Field>

          <Field label="执行日">
            <div className="grid grid-cols-7 gap-1.5">
              {WEEKDAY_LABELS.map((label, day) => {
                const selected = draft.weekdays.includes(day);
                return (
                  <motion.button
                    key={label}
                    whileTap={{ scale: 0.9 }}
                    type="button"
                    aria-pressed={selected}
                    aria-label={`星期${label}`}
                    onClick={() => toggleDay(day)}
                    className={cn(
                      'relative flex h-9 items-center justify-center rounded-lg text-xs font-semibold transition-colors',
                      selected
                        ? 'bg-brand-500 text-white shadow-md shadow-brand-500/20'
                        : 'bg-ink-50 text-ink-800/50 ring-1 ring-black/5 hover:bg-brand-500/10 dark:bg-ink-900/60 dark:text-ink-100/45 dark:ring-white/10',
                    )}
                  >
                    <AnimatePresence initial={false}>
                      {selected && (
                        <motion.span
                          initial={{ opacity: 0, scale: 0.6 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.6 }}
                          className="absolute inset-0 rounded-lg ring-2 ring-brand-300/50"
                          aria-hidden="true"
                        />
                      )}
                    </AnimatePresence>
                    <span className="relative z-[1]">{label}</span>
                  </motion.button>
                );
              })}
            </div>
          </Field>
        </div>

        <section className="space-y-2" aria-label="计划账号范围">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="flex items-center gap-1.5 text-xs font-medium text-ink-800/70 dark:text-ink-100/60">
                <Users className="size-3.5" />
                签到账号
              </div>
              <div className="mt-0.5 text-[11px] text-ink-800/40 dark:text-ink-100/35">
                {selectionText(draft, accounts.length, selectedCount)}
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                aria-label="全选账号"
                disabled={busy || allSelected}
                onClick={selectAll}
                className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] font-medium text-brand-600 ring-1 ring-brand-500/20 transition-colors hover:bg-brand-500/10 disabled:opacity-40 dark:text-brand-300"
              >
                <CheckCheck className="size-3.5" />
                全选
              </button>
              <button
                type="button"
                aria-label="清空账号"
                disabled={busy || selectedCount === 0}
                onClick={clearAll}
                className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] font-medium text-ink-800/55 ring-1 ring-black/10 transition-colors hover:bg-black/5 disabled:opacity-40 dark:text-ink-100/50 dark:ring-white/10 dark:hover:bg-white/10"
              >
                清空
              </button>
            </div>
          </div>

          <div className="max-h-64 space-y-2 overflow-y-auto rounded-xl bg-ink-50/70 p-2 ring-1 ring-black/5 dark:bg-ink-900/45 dark:ring-white/10">
            {groups.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-8 text-xs text-ink-800/40 dark:text-ink-100/35">
                <Globe2 className="size-4" />
                暂无可执行账号
              </div>
            ) : groups.map((group) => {
              const groupSelected = group.accounts.every((account) => selectedIds.has(account.id));
              const groupPartial = !groupSelected && group.accounts.some((account) => selectedIds.has(account.id));
              return (
                <motion.div layout key={group.siteId} className="rounded-lg bg-white/70 p-2 ring-1 ring-black/5 dark:bg-white/[0.04] dark:ring-white/10">
                  <button
                    type="button"
                    aria-pressed={groupSelected}
                    aria-label={`选择站点 ${group.siteName}`}
                    onClick={() => toggleSite(group)}
                    className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-brand-500/8"
                  >
                    <Marker selected={groupSelected} partial={groupPartial} />
                    <Globe2 className={cn('size-3.5', groupSelected || groupPartial ? 'text-brand-500' : 'text-ink-800/40 dark:text-ink-100/35')} />
                    <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink-900 dark:text-ink-50">{group.siteName}</span>
                    <span className="text-[10px] text-ink-800/40 dark:text-ink-100/35">{group.accounts.length} 个账号</span>
                  </button>
                  <div className="mt-1 grid gap-1 sm:grid-cols-2">
                    {group.accounts.map((account) => {
                      const selected = selectedIds.has(account.id);
                      const displayName = account.label?.trim() || account.username;
                      return (
                        <button
                          key={account.id}
                          type="button"
                          aria-pressed={selected}
                          aria-label={`选择账号 ${displayName}`}
                          onClick={() => toggleAccount(account.id)}
                          className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-brand-500/8"
                        >
                          <Marker selected={selected} />
                          <span className="min-w-0 flex-1 truncate text-[11px] text-ink-800/70 dark:text-ink-100/65">{displayName}</span>
                        </button>
                      );
                    })}
                  </div>
                </motion.div>
              );
            })}
          </div>
        </section>

        <div className="flex items-center justify-between rounded-lg bg-sun-500/10 px-3 py-2 text-[11px] text-ink-800/60 dark:text-ink-100/55">
          <span>下一次执行</span>
          <span className="font-semibold text-ink-900 dark:text-ink-50">{draft.enabled && valid ? `${formatNextRun(draft)} · ${selectionText(draft, accounts.length, selectedCount)}` : '未启用'}</span>
        </div>

        {error && <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
        {!draft.weekdays.length && <p className="text-xs text-amber-600 dark:text-amber-400">至少选择一天</p>}

        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="h-10 flex-1 rounded-xl px-4 text-sm font-medium text-ink-800 ring-1 ring-black/10 transition-colors hover:bg-black/5 disabled:opacity-40 dark:text-ink-100 dark:ring-white/10 dark:hover:bg-white/10"
          >
            取消
          </button>
          <motion.button
            whileTap={{ scale: 0.98 }}
            type="button"
            disabled={!valid || busy}
            onClick={() => void submit()}
            className={cn(btnPrimary, 'flex h-10 flex-1 items-center justify-center gap-1.5')}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
            {busy ? '保存中...' : '保存计划'}
          </motion.button>
        </div>
      </div>
    </Modal>
  );
}
