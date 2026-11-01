import { useEffect, useMemo, useRef, useState } from 'react';
import { Globe2, Loader2, Search, Users } from 'lucide-react';
import type { Account, ProxyConfig, SiteConfig } from '@/types';
import { describeAccountProxy, effectiveProxyScheme, isNameOnlyProxy } from '@/lib/proxy/proxy-config';
import type { ProxyAssignment } from '@/lib/proxy/proxy-assign';

interface Props {
  open: boolean;
  initialProxyId?: string;
  proxies: readonly ProxyConfig[];
  accounts: readonly Account[];
  sites: readonly SiteConfig[];
  onAssign: (assignments: ProxyAssignment[]) => Promise<number>;
  onSetAccountProxy: (accountId: string, patch: Pick<Account, 'proxyMode' | 'proxyId' | 'proxyPinned'>) => Promise<void>;
  onShowImport: () => void;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onProxyChange?: (proxyId: string) => void;
}

/** A short, explicit flow: choose an exit, select accounts, and save their bindings. */
export function AccountBindingPicker({ open, initialProxyId, proxies, accounts, sites, onAssign, onSetAccountProxy, onShowImport, disabled = false, onBusyChange, onProxyChange }: Props) {
  const usableProxies = useMemo(() => proxies.filter((proxy) => !isNameOnlyProxy(proxy)), [proxies]);
  const [proxyId, setProxyId] = useState(initialProxyId ?? '');
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [unbindingAccountId, setUnbindingAccountId] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ text: string; error?: boolean } | null>(null);
  const operationBusy = useRef(false);
  const locked = disabled || busy || unbindingAccountId !== null;

  useEffect(() => {
    if (!open) return;
    setProxyId(initialProxyId ?? '');
  }, [open, initialProxyId]);

  useEffect(() => {
    if (!open) return;
    setSelectedAccountIds(new Set());
    setQuery('');
    setSummary(null);
  }, [open]);

  useEffect(() => {
    setSummary(null);
  }, [proxyId]);

  const proxy = usableProxies.find((item) => item.id === proxyId);
  const siteById = useMemo(() => new Map(sites.map((site) => [site.id, site])), [sites]);
  const visibleAccounts = accounts.filter((account) => {
    const site = siteById.get(account.siteId);
    return !query.trim() || `${account.username} ${account.label ?? ''} ${site?.name ?? ''}`.toLowerCase().includes(query.trim().toLowerCase());
  });
  const selectedAccounts = accounts.filter((account) => selectedAccountIds.has(account.id));
  const allVisibleSelected = visibleAccounts.length > 0 && visibleAccounts.every((account) => selectedAccountIds.has(account.id));

  const grouped = new Map<string, { siteId: string; siteName: string; accounts: Account[] }>();
  for (const account of visibleAccounts) {
    const group = grouped.get(account.siteId) ?? { siteId: account.siteId, siteName: siteById.get(account.siteId)?.name ?? '未知站点', accounts: [] };
    group.accounts.push(account);
    grouped.set(account.siteId, group);
  }
  const groups = [...grouped.values()];

  function toggleAccount(accountId: string) {
    setSummary(null);
    setSelectedAccountIds((current) => {
      const next = new Set(current);
      if (next.has(accountId)) next.delete(accountId);
      else next.add(accountId);
      return next;
    });
  }

  function toggleVisible() {
    setSummary(null);
    setSelectedAccountIds((current) => {
      const next = new Set(current);
      for (const account of visibleAccounts) {
        if (allVisibleSelected) next.delete(account.id);
        else next.add(account.id);
      }
      return next;
    });
  }

  async function save() {
    if (disabled || !proxy || operationBusy.current || !selectedAccountIds.size) return;
    const assignments: ProxyAssignment[] = selectedAccounts.map((account) => ({
      accountId: account.id,
      proxyId: proxy.id,
      pinned: true,
    }));
    if (!assignments.length) return;
    operationBusy.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setSummary(null);
    try {
      const assigned = await onAssign(assignments);
      setSelectedAccountIds(new Set());
      setSummary({ text: `已为 ${assigned} 个账号绑定到“${proxy.name}”。` });
    } catch (error) {
      setSummary({ text: error instanceof Error ? error.message : '保存失败，请重试。', error: true });
    } finally {
      operationBusy.current = false;
      setBusy(false);
      onBusyChange?.(false);
    }
  }

  async function unbind(account: Account) {
    if (disabled || operationBusy.current) return;
    operationBusy.current = true;
    setUnbindingAccountId(account.id);
    onBusyChange?.(true);
    setSummary(null);
    try {
      await onSetAccountProxy(account.id, { proxyMode: 'inherit' });
      setSummary({ text: `${account.label || account.username} 已取消绑定，将跟随站点设置。` });
    } catch (error) {
      setSummary({ text: error instanceof Error ? error.message : '取消绑定失败，请重试。', error: true });
    } finally {
      operationBusy.current = false;
      setUnbindingAccountId(null);
      onBusyChange?.(false);
    }
  }

  if (!accounts.length) {
    return <p className="px-4 py-12 text-center text-[13px] text-slate-500 dark:text-slate-400">还没有账号，添加账号后即可分配代理。</p>;
  }

  return (
    <div>
      <div className="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)]">
        <label className="block min-w-0 space-y-1.5">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">绑定到</span>
          <select value={proxy?.id ?? ''} onChange={(event) => { setProxyId(event.target.value); onProxyChange?.(event.target.value); }} disabled={locked || !usableProxies.length} aria-label="选择绑定代理" className="h-9 w-full min-w-0 rounded-lg border border-slate-200 bg-white px-2 text-[13px] outline-none focus:border-blue-400 dark:border-slate-700 dark:bg-slate-900">
            <option value="">{usableProxies.length ? '选择代理' : '暂无代理'}</option>
            {usableProxies.map((item) => <option key={item.id} value={item.id}>{item.name} · {effectiveProxyScheme(item)}://{item.host}:{item.port}</option>)}
          </select>
        </label>
        <label className="block min-w-0 space-y-1.5">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">查找账号</span>
          <span className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} disabled={locked} aria-label="搜索绑定账号" placeholder="账号或站点名称" className="h-9 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-[13px] outline-none placeholder:text-slate-400 focus:border-blue-400 dark:border-slate-700 dark:bg-slate-900" />
          </span>
        </label>
      </div>

      {!usableProxies.length && <p className="px-4 pb-3 text-xs text-slate-500 dark:text-slate-400">尚无可绑定的代理。<button type="button" onClick={onShowImport} disabled={locked} className="ml-1 font-medium text-blue-600 hover:underline disabled:opacity-40 dark:text-blue-400">去添加代理</button></p>}

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)_2.5rem] items-center gap-2 border-y border-slate-100 bg-slate-50 px-4 py-2.5 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
        <label className="flex cursor-pointer items-center gap-2.5">
          <input type="checkbox" aria-label="全选当前结果" className="size-4 shrink-0 accent-blue-600" checked={allVisibleSelected} onChange={toggleVisible} disabled={locked || !visibleAccounts.length} />
          账号
        </label>
        <span>当前代理</span>
        <span className="text-right">操作</span>
      </div>
      <div className="max-h-[28rem] overflow-y-auto xl:max-h-[clamp(12rem,calc(100dvh_-_42rem),28rem)]">
        {groups.map((group) => (
          <section key={group.siteId} aria-label={group.siteName}>
            <header className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-slate-100 bg-slate-50/95 px-4 py-2 text-xs text-slate-500 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95 dark:text-slate-400">
              <Globe2 className="size-3.5 shrink-0" />
              <strong className="min-w-0 flex-1 truncate font-medium">{group.siteName}</strong>
              <span>{group.accounts.length} 个账号</span>
            </header>
            {group.accounts.map((account) => {
              const route = describeAccountProxy(account, siteById.get(account.siteId) ?? {}, proxies);
              const currentProxy = route.kind === 'direct' ? '直连'
                : route.kind === 'name-only' ? `${route.label}（缺少地址）` : route.label;
              const routeDetail = route.kind === 'proxy' && route.inherited ? '跟随站点'
                : account.proxyMode === 'pool' ? account.proxyPinned ? '手动绑定' : '自动分配' : '';
              const selected = selectedAccountIds.has(account.id);
              const unbinding = unbindingAccountId === account.id;
              return (
                <div key={account.id} className={`grid grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)_2.5rem] items-center gap-2 border-b border-slate-100 px-4 py-3 last:border-b-0 dark:border-slate-800 ${selected ? 'bg-blue-50/70 dark:bg-blue-950/25' : 'hover:bg-slate-50/70 dark:hover:bg-slate-900/40'}`}>
                  <label className="flex min-w-0 cursor-pointer items-center gap-2.5">
                    <input type="checkbox" className="size-4 shrink-0 accent-blue-600" checked={selected} onChange={() => toggleAccount(account.id)} disabled={locked} aria-label={`选择 ${account.label || account.username}`} />
                    <span className="min-w-0">
                      <strong title={account.label || account.username} className="block truncate text-[13px] font-medium">{account.label || account.username}</strong>
                      {account.label && <span title={account.username} className="mt-0.5 block truncate text-xs text-slate-500 dark:text-slate-400">{account.username}</span>}
                    </span>
                  </label>
                  <span className="min-w-0">
                    <span title={currentProxy} className={`block truncate text-[13px] ${route.kind === 'invalid' || route.kind === 'name-only' ? 'text-amber-700 dark:text-amber-300' : 'text-slate-600 dark:text-slate-300'}`}>{currentProxy}</span>
                    {routeDetail && <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">{routeDetail}</span>}
                  </span>
                  {account.proxyMode === 'pool' && account.proxyId ? <button type="button" onClick={() => void unbind(account)} disabled={locked} aria-label={`取消 ${account.label || account.username} 的绑定`} className="h-8 rounded-md text-right text-xs text-slate-500 hover:text-blue-600 disabled:opacity-40 dark:text-slate-400 dark:hover:text-blue-300">{unbinding ? <Loader2 className="ml-auto size-3.5 animate-spin" /> : '解绑'}</button> : <span className="text-right text-xs text-slate-300 dark:text-slate-600">—</span>}
                </div>
              );
            })}
          </section>
        ))}
        {!groups.length && <p className="px-4 py-10 text-center text-[13px] text-slate-500 dark:text-slate-400">没有匹配的账号。</p>}
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50/60 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/40">
        <div className="min-w-0 text-xs text-slate-500 dark:text-slate-400">
          <span>{selectedAccounts.length ? `已选 ${selectedAccounts.length} 个账号` : '勾选要绑定的账号'}</span>
          {selectedAccounts.length > 0 && !proxy && <span className="ml-2 text-amber-700 dark:text-amber-300">请选择目标代理</span>}
        </div>
        <button type="button" disabled={locked || !proxy || !selectedAccounts.length} onClick={() => void save()} className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-4 text-[13px] font-medium text-white hover:bg-blue-700 disabled:opacity-40">
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Users className="size-3.5" />}{busy ? '保存中…' : '保存绑定'}
        </button>
      </footer>
      {summary && <p role={summary.error ? 'alert' : 'status'} className={`border-t border-slate-100 px-4 py-3 text-[13px] dark:border-slate-800 ${summary.error ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-700 dark:text-emerald-400'}`}>{summary.text}</p>}
    </div>
  );
}
