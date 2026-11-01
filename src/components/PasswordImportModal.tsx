import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Check, FileKey2, FileUp, KeyRound, Loader2, Search, Square } from 'lucide-react';
import type { Account, SiteConfig } from '@/types';
import {
  matchChromePasswords,
  parseChromePasswordCsv,
  passwordAccountKey,
  type PasswordMatch,
  type PasswordMatchKind,
} from '@/lib/backup/password-import';
import { Modal } from './Modal';
import { cn } from '@/lib/core/cn';

interface Props {
  open: boolean;
  sites: SiteConfig[];
  accounts: Account[];
  onClose: () => void;
  onImport: (accounts: Omit<Account, 'id'>[]) => Promise<void>;
}

type Filter = 'all' | 'matched' | 'unmatched' | 'existing';

export function PasswordImportModal({ open, sites, accounts, onClose, onImport }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [matches, setMatches] = useState<PasswordMatch[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [fileName, setFileName] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setMatches([]);
    setSelected(new Set());
    setFileName('');
    setQuery('');
    setFilter('all');
    setError('');
  }, [open]);

  const existingKeys = useMemo(
    () => new Set(accounts.map((account) => passwordAccountKey(account.siteId, account.username))),
    [accounts],
  );

  const assignmentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const match of matches) {
      if (!match.siteId || !match.credential.username) continue;
      const key = passwordAccountKey(match.siteId, match.credential.username);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [matches]);

  const counts = useMemo(() => {
    let matched = 0;
    let unmatched = 0;
    let existing = 0;
    let invalid = 0;
    for (const match of matches) {
      if (match.kind === 'invalid') invalid += 1;
      else if (match.siteId && existingKeys.has(passwordAccountKey(match.siteId, match.credential.username))) existing += 1;
      else if (match.siteId) matched += 1;
      else unmatched += 1;
    }
    return { all: matches.length, matched, unmatched, existing, invalid };
  }, [existingKeys, matches]);

  const visibleMatches = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return matches.filter((match) => {
      const existing = isExisting(match, existingKeys);
      const bucket = existing ? 'existing' : match.siteId ? 'matched' : 'unmatched';
      if (filter !== 'all' && bucket !== filter) return false;
      if (!normalizedQuery) return true;
      const siteName = sites.find((site) => site.id === match.siteId)?.name ?? '';
      return [match.credential.host, match.credential.username, match.credential.name, siteName]
        .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
    });
  }, [existingKeys, filter, matches, query, sites]);

  async function loadFile(file?: File) {
    if (!file) return;
    setError('');
    try {
      const nextMatches = matchChromePasswords(parseChromePasswordCsv(await file.text()), sites, accounts);
      setMatches(nextMatches);
      setSelected(new Set(nextMatches.filter((match) => match.kind === 'matched').map((match) => match.credential.id)));
      setFileName(file.name);
      setFilter('all');
      setQuery('');
    } catch (err) {
      setMatches([]);
      setSelected(new Set());
      setFileName(file.name);
      setError(err instanceof Error ? err.message : '无法读取 Chrome 密码 CSV');
    }
  }

  function changeSite(matchId: string, siteId: string) {
    const current = matches.find((match) => match.credential.id === matchId);
    if (!current) return;
    const nextKind: PasswordMatchKind = !siteId
      ? current.candidateSiteIds.length > 1 ? 'ambiguous' : 'unmatched'
      : existingKeys.has(passwordAccountKey(siteId, current.credential.username)) ? 'existing' : 'manual';

    setMatches((items) => items.map((match) =>
      match.credential.id === matchId ? { ...match, siteId: siteId || undefined, kind: nextKind } : match,
    ));
    setSelected((items) => {
      const next = new Set(items);
      next.delete(matchId);
      if (siteId && nextKind !== 'existing') {
        const key = passwordAccountKey(siteId, current.credential.username);
        for (const match of matches) {
          if (match.siteId && passwordAccountKey(match.siteId, match.credential.username) === key) {
            next.delete(match.credential.id);
          }
        }
        next.add(matchId);
      }
      return next;
    });
  }

  function toggle(match: PasswordMatch) {
    if (!match.siteId || match.kind === 'invalid' || isExisting(match, existingKeys)) return;
    setSelected((items) => {
      const next = new Set(items);
      if (next.has(match.credential.id)) {
        next.delete(match.credential.id);
        return next;
      }

      const key = passwordAccountKey(match.siteId!, match.credential.username);
      for (const other of matches) {
        if (other.siteId && passwordAccountKey(other.siteId, other.credential.username) === key) {
          next.delete(other.credential.id);
        }
      }
      next.add(match.credential.id);
      return next;
    });
  }

  async function submit() {
    if (selected.size === 0 || busy) return;
    const inputs = matches.flatMap((match) => {
      if (!selected.has(match.credential.id) || !match.siteId || isExisting(match, existingKeys)) return [];
      return [{
        siteId: match.siteId,
        username: match.credential.username.trim(),
        password: match.credential.password,
      } satisfies Omit<Account, 'id'>];
    });
    if (inputs.length === 0) return;

    setBusy(true);
    try {
      await onImport(inputs);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} title="匹配导入账号" onClose={() => !busy && onClose()} wide>
      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(event) => {
          void loadFile(event.target.files?.[0]);
          event.target.value = '';
        }}
      />

      {matches.length === 0 ? (
        <div className="space-y-3">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="flex w-full flex-col items-center justify-center rounded-lg border border-dashed border-black/10 py-12 text-center transition-colors hover:border-brand-500/40 hover:bg-brand-500/[0.03] dark:border-white/10 dark:hover:bg-brand-500/[0.06]"
          >
            <span className="mb-3 flex size-12 items-center justify-center rounded-lg bg-brand-500/10 text-brand-600 dark:text-brand-400">
              <FileKey2 className="size-5" />
            </span>
            <span className="text-sm font-semibold text-ink-900 dark:text-white">选择 Chrome 密码 CSV</span>
            <span className="mt-1 text-[11px] text-ink-800/40 dark:text-ink-100/35">仅自动勾选域名唯一匹配的账号</span>
          </button>
          {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">{error}</p>}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-500/10 text-brand-600 dark:text-brand-400">
              <FileKey2 className="size-4" />
            </span>
            <div className="min-w-[160px] flex-1">
              <p className="truncate text-xs font-semibold text-ink-900 dark:text-white">{fileName}</p>
              <p className="text-[10px] text-ink-800/40 dark:text-ink-100/35">共 {counts.all} 条记录</p>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-medium text-brand-600 ring-1 ring-brand-500/20 hover:bg-brand-500/10 disabled:opacity-40 dark:text-brand-400"
            >
              <FileUp className="size-3.5" />
              更换文件
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Summary label="已匹配" value={counts.matched} tone="emerald" />
            <Summary label="待匹配" value={counts.unmatched} tone="amber" />
            <Summary label="已存在" value={counts.existing} tone="ink" />
            <Summary label="无效" value={counts.invalid} tone="rose" />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[180px] flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-800/30 dark:text-ink-100/25" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索域名、用户名或站点"
                className="h-9 w-full rounded-lg bg-ink-50 pl-8 pr-3 text-xs outline-none ring-1 ring-black/5 focus:ring-2 focus:ring-brand-500/40 dark:bg-ink-950/50 dark:ring-white/10"
              />
            </div>
            <div className="flex rounded-lg bg-ink-50 p-1 ring-1 ring-black/5 dark:bg-ink-950/50 dark:ring-white/10">
              {([
                ['all', '全部'],
                ['matched', '已匹配'],
                ['unmatched', '待匹配'],
                ['existing', '已存在'],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setFilter(value)}
                  className={cn(
                    'h-7 rounded-md px-2 text-[10px] font-medium transition-colors',
                    filter === value
                      ? 'bg-white text-ink-900 shadow-sm dark:bg-ink-800 dark:text-white'
                      : 'text-ink-800/45 hover:text-ink-900 dark:text-ink-100/40 dark:hover:text-white',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="max-h-[360px] overflow-y-auto rounded-lg ring-1 ring-black/5 dark:ring-white/10">
            {visibleMatches.map((match) => {
              const existing = isExisting(match, existingKeys);
              const duplicate = match.siteId
                ? (assignmentCounts.get(passwordAccountKey(match.siteId, match.credential.username)) ?? 0) > 1
                : false;
              const checked = selected.has(match.credential.id);
              const selectable = !!match.siteId && match.kind !== 'invalid' && !existing;
              const orderedSites = [...sites].sort((a, b) =>
                Number(match.candidateSiteIds.includes(b.id)) - Number(match.candidateSiteIds.includes(a.id)),
              );

              return (
                <div
                  key={match.credential.id}
                  className={cn(
                    'flex flex-wrap items-center gap-2 border-b border-black/5 px-3 py-2.5 last:border-b-0 dark:border-white/5',
                    checked && 'bg-emerald-500/[0.045] dark:bg-emerald-500/[0.06]',
                  )}
                >
                  <button
                    type="button"
                    disabled={!selectable}
                    onClick={() => toggle(match)}
                    aria-label={`${checked ? '取消选择' : '选择'}账号 ${match.credential.username || match.credential.host}`}
                    className={cn(
                      'flex size-5 shrink-0 items-center justify-center rounded border transition-colors',
                      checked
                        ? 'border-emerald-500 bg-emerald-500 text-white'
                        : 'border-black/15 text-transparent dark:border-white/20',
                      !selectable && 'cursor-not-allowed opacity-35',
                    )}
                  >
                    {checked ? <Check className="size-3.5 stroke-[3]" /> : <Square className="size-3.5" />}
                  </button>

                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-ink-50 text-ink-800/35 ring-1 ring-black/5 dark:bg-white/5 dark:text-ink-100/35 dark:ring-white/10">
                    <KeyRound className="size-3.5" />
                  </span>

                  <div className="min-w-[130px] flex-1">
                    <p className="truncate text-xs font-medium text-ink-900 dark:text-white">{match.credential.username || '缺少用户名'}</p>
                    <p className="truncate text-[10px] text-ink-800/40 dark:text-ink-100/35">{match.credential.host || match.credential.url || '无效地址'}</p>
                  </div>

                  <select
                    aria-label={`匹配站点 ${match.credential.username || match.credential.host}`}
                    value={match.siteId ?? ''}
                    disabled={match.kind === 'invalid' || busy}
                    onChange={(event) => changeSite(match.credential.id, event.target.value)}
                    className="h-8 w-full rounded-lg bg-ink-50 px-2 text-[11px] text-ink-900 outline-none ring-1 ring-black/5 focus:ring-2 focus:ring-brand-500/40 disabled:opacity-40 dark:bg-ink-950/50 dark:text-white dark:ring-white/10 sm:w-44"
                  >
                    <option value="">未匹配站点</option>
                    {orderedSites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
                  </select>

                  <MatchBadge match={match} existing={existing} duplicate={duplicate} />
                </div>
              );
            })}
            {visibleMatches.length === 0 && (
              <div className="py-10 text-center text-xs text-ink-800/40 dark:text-ink-100/35">没有符合当前条件的记录</div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-ink-800/50 dark:text-ink-100/40">已选择 {selected.size} 个账号</span>
            <motion.button
              whileTap={{ scale: selected.size ? 0.98 : 1 }}
              type="button"
              disabled={selected.size === 0 || busy}
              onClick={() => void submit()}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand-500 px-4 text-xs font-semibold text-white shadow-lg shadow-brand-500/20 hover:bg-brand-600 disabled:opacity-40 disabled:shadow-none"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <FileKey2 className="size-4" />}
              {busy ? '导入中' : `导入匹配账号 (${selected.size})`}
            </motion.button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function isExisting(match: PasswordMatch, existingKeys: ReadonlySet<string>) {
  return !!match.siteId && existingKeys.has(passwordAccountKey(match.siteId, match.credential.username));
}

function Summary({ label, value, tone }: { label: string; value: number; tone: 'emerald' | 'amber' | 'ink' | 'rose' }) {
  const tones = {
    emerald: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    amber: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
    ink: 'bg-black/5 text-ink-800/60 dark:bg-white/10 dark:text-ink-100/55',
    rose: 'bg-rose-500/10 text-rose-700 dark:text-rose-300',
  };
  return (
    <div className={cn('flex items-center justify-between rounded-lg px-3 py-2', tones[tone])}>
      <span className="text-[10px] font-medium">{label}</span>
      <span className="text-sm font-bold tabular-nums">{value}</span>
    </div>
  );
}

function MatchBadge({ match, existing, duplicate }: { match: PasswordMatch; existing: boolean; duplicate: boolean }) {
  if (match.kind === 'invalid') return <Badge label="无效" className="bg-rose-500/10 text-rose-700 dark:text-rose-300" />;
  if (existing) return <Badge label="已存在" className="bg-black/5 text-ink-800/55 dark:bg-white/10 dark:text-ink-100/50" />;
  if (!match.siteId && match.kind === 'ambiguous') return <Badge label="多个候选" className="bg-amber-500/10 text-amber-700 dark:text-amber-300" />;
  if (!match.siteId) return <Badge label="未匹配" className="bg-amber-500/10 text-amber-700 dark:text-amber-300" />;
  if (duplicate || match.kind === 'duplicate') return <Badge label="同账号多条" className="bg-amber-500/10 text-amber-700 dark:text-amber-300" />;
  if (match.kind === 'manual') return <Badge label="手动匹配" className="bg-brand-500/10 text-brand-700 dark:text-brand-300" />;
  return <Badge label="域名匹配" className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" />;
}

function Badge({ label, className }: { label: string; className: string }) {
  return <span className={cn('shrink-0 rounded-md px-1.5 py-1 text-[10px] font-medium', className)}>{label}</span>;
}
