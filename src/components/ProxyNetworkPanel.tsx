import { useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CheckCircle2, Globe2, Loader2, Plus, Search, Trash2, Unplug, Wifi, XCircle } from 'lucide-react';
import type { Account, ProxyConfig, SiteConfig } from '@/types';
import { sendMessage } from '@/lib/core/messaging';
import { cn } from '@/lib/core/cn';
import { effectiveProxyScheme, isNameOnlyProxy } from '@/lib/proxy/proxy-config';
import type { ProxyAssignment } from '@/lib/proxy/proxy-assign';
import { diagnoseListenerFailures, type ListenerProbe } from '@/lib/proxy/listener-diagnosis';
import { AccountBindingPicker } from './proxy/AccountBindingPicker';
import { BulkAssign } from './proxy/BulkAssign';
import { ClashConfigImport } from './proxy/ClashConfigImport';
import { ClashControllerImport } from './proxy/ClashControllerImport';
import { ListenerPlanPanel } from './proxy/ListenerPlanPanel';
import { LocalPortScan } from './proxy/LocalPortScan';
import { SubscriptionImport } from './proxy/SubscriptionImport';
import { ProxyImportDialog } from './proxy/ProxyImportDialog';

interface Props {
  proxies: ProxyConfig[];
  accounts: Account[];
  sites: SiteConfig[];
  onAddMany: (inputs: Omit<ProxyConfig, 'id'>[]) => Promise<{ added: number; skipped: number; upgraded: number }>;
  onSyncClash: (inputs: Omit<ProxyConfig, 'id'>[]) => Promise<{ added: number; skipped: number; upgraded: number; removed: number; keptInUse: number }>;
  onRemove: (proxyId: string) => Promise<void>;
  onAssign: (assignments: ProxyAssignment[]) => Promise<number>;
  onSetAccountProxy: (accountId: string, patch: Pick<Account, 'proxyMode' | 'proxyId' | 'proxyPinned'>) => Promise<void>;
  compact?: boolean;
  onReturn?: () => void;
}

type TestState = { state: 'idle' | 'testing' | 'ok' | 'fail'; message?: string };
type Operation = 'test' | 'test-all' | 'assign' | 'bind' | 'import' | 'remove';

/** Batch assignment, proxy health, and account bindings share one workspace. */
export function ProxyNetworkPanel({ proxies, accounts, sites, onAddMany, onSyncClash, onRemove, onAssign, onSetAccountProxy, compact = false, onReturn }: Props) {
  const [query, setQuery] = useState('');
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [testingAll, setTestingAll] = useState(false);
  const [operation, setOperation] = useState<Operation | null>(null);
  const operationRef = useRef<Operation | null>(null);
  const busy = operation !== null;
  const [testProgress, setTestProgress] = useState(0);
  const [testSummary, setTestSummary] = useState<{ passed: number; total: number } | null>(null);
  const [diagnosis, setDiagnosis] = useState<ReturnType<typeof diagnoseListenerFailures> | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [missingListenerNames, setMissingListenerNames] = useState<string[]>([]);
  const [selectedProxyId, setSelectedProxyId] = useState('');
  const [mobilePane, setMobilePane] = useState<'proxies' | 'accounts'>('accounts');
  const [importOpen, setImportOpen] = useState(false);
  const bindingSection = useRef<HTMLElement>(null);
  const localPortPanel = useRef<HTMLDetailsElement>(null);

  const usableProxies = useMemo(() => proxies.filter((proxy) => !isNameOnlyProxy(proxy)), [proxies]);
  const visibleProxies = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) return proxies;
    return proxies.filter((proxy) => `${proxy.name} ${proxy.host}:${proxy.port}`.toLowerCase().includes(text));
  }, [proxies, query]);
  const usage = useMemo(() => {
    const count = new Map<string, number>();
    const siteProxy = new Map(sites.map((site) => [site.id, site.proxyId]));
    for (const account of accounts) {
      const mode = account.proxyMode ?? 'inherit';
      const proxyId = mode === 'pool'
        ? account.proxyId
        : mode === 'inherit'
          ? siteProxy.get(account.siteId)
          : undefined;
      if (proxyId) count.set(proxyId, (count.get(proxyId) ?? 0) + 1);
    }
    return count;
  }, [accounts, sites]);

  function begin(next: Operation) {
    if (operationRef.current) return false;
    operationRef.current = next;
    setOperation(next);
    return true;
  }

  function finish() {
    operationRef.current = null;
    setOperation(null);
  }

  function childBusy(next: boolean, kind: Operation) {
    if (next) {
      begin(kind);
      setTestError(null);
      if (kind === 'assign') {
        setTestSummary(null);
        setDiagnosis(null);
      }
    } else if (operationRef.current === kind) finish();
  }

  async function probe(proxy: ProxyConfig) {
    setTests((current) => ({ ...current, [proxy.id]: { state: 'testing' } }));
    try {
      const response = await sendMessage({ type: 'TEST_PROXY', proxy });
      const result = response.ok ? response.test : undefined;
      const outcome = {
        ok: result?.ok === true,
        message: result?.message || (result?.ok ? '连接正常' : response.ok ? '未收到测试结果' : response.error),
        listenerProbe: (result?.listenerProbe ?? 'unknown') as ListenerProbe,
      };
      setTests((current) => ({
        ...current,
        [proxy.id]: { state: outcome.ok ? 'ok' : 'fail', message: outcome.message },
      }));
      return outcome;
    } catch (error) {
      const message = error instanceof Error ? error.message : '连接测试失败';
      setTests((current) => ({ ...current, [proxy.id]: { state: 'fail', message } }));
      return { ok: false, message, listenerProbe: 'unknown' as ListenerProbe };
    }
  }

  async function test(proxy: ProxyConfig) {
    if (isNameOnlyProxy(proxy) || !begin('test')) return;
    setTestSummary(null);
    setDiagnosis(null);
    setTestError(null);
    try {
      await probe(proxy);
    } finally {
      finish();
    }
  }

  async function testAll() {
    if (!usableProxies.length || !begin('test-all')) return;
    setTestingAll(true);
    setTestProgress(0);
    setTestSummary(null);
    setDiagnosis(null);
    setTestError(null);
    let passed = 0;
    const outcomes: { port: number; probe: ListenerProbe; test: { ok: boolean; message: string } }[] = [];
    try {
      for (const [index, proxy] of usableProxies.entries()) {
        const result = await probe(proxy);
        if (result.ok) passed += 1;
        outcomes.push({
          port: proxy.port,
          probe: result.listenerProbe,
          test: result,
        });
        setTestProgress(index + 1);
      }
      setTestSummary({ passed, total: usableProxies.length });
      setDiagnosis(diagnoseListenerFailures(outcomes));
    } catch (error) {
      setTestError(error instanceof Error ? error.message : '连接测试失败，请重试。');
    } finally {
      setTestingAll(false);
      finish();
    }
  }

  async function remove(proxy: ProxyConfig) {
    if (!begin('remove')) return;
    setTestError(null);
    try {
      await onRemove(proxy.id);
      if (selectedProxyId === proxy.id) setSelectedProxyId('');
      setTestSummary(null);
      setDiagnosis(null);
    } catch (error) {
      setTestError(error instanceof Error ? error.message : '删除失败，请重试。');
    } finally {
      finish();
    }
  }

  function showImport() {
    setImportOpen(true);
  }

  function chooseProxy(proxyId: string) {
    setSelectedProxyId(proxyId);
    setMobilePane('accounts');
    if (compact) requestAnimationFrame(() => bindingSection.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }));
  }

  return (
    <div className={cn('w-full space-y-5 text-slate-900 dark:text-slate-100', compact && 'p-3')}>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">代理与网络</h1>
          <p className="mt-1.5 text-[13px] text-slate-500 dark:text-slate-400">批量分配可用代理，也可以为账号单独指定。</p>
        </div>
        <div className="flex items-center gap-2">
          {compact && onReturn && <button type="button" onClick={onReturn} disabled={busy} className="h-9 rounded-lg border border-slate-200 px-3 text-xs font-medium hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:hover:bg-slate-900">返回总览</button>}
          <button type="button" onClick={showImport} disabled={busy} aria-haspopup="dialog" aria-controls="proxy-import" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-[13px] font-medium hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-950 dark:hover:bg-slate-900"><Plus className="size-4" />添加代理</button>
        </div>
      </header>

      <ProxyImportDialog open={importOpen} busy={busy} onClose={() => setImportOpen(false)}>
        <fieldset disabled={busy} className="min-w-0 space-y-3">
          <legend className="sr-only">代理导入方式</legend>
          <SubscriptionImport onImport={onAddMany} onNamesParsed={setMissingListenerNames} onBusyChange={(next) => childBusy(next, 'import')} />
          {missingListenerNames.length > 0 && <ListenerPlanPanel names={missingListenerNames} onImport={onAddMany} />}
          <details ref={localPortPanel} className="rounded-lg bg-slate-50 px-3 py-3 dark:bg-slate-900">
            <summary className="cursor-pointer text-[13px] font-medium">检测一个本地端口</summary>
            <div className="mt-3"><LocalPortScan onImport={onAddMany} onBusyChange={(next) => childBusy(next, 'import')} /></div>
          </details>
          <details className="rounded-lg bg-slate-50 px-3 py-3 dark:bg-slate-900">
            <summary className="cursor-pointer text-[13px] font-medium">其他导入方式</summary>
            <div className="mt-3 space-y-3">
              <ClashConfigImport onSync={onSyncClash} onMissingNames={setMissingListenerNames} />
              <ClashControllerImport onSync={onSyncClash} onNamesRead={setMissingListenerNames} onUseLocalProxy={() => {
                if (!localPortPanel.current) return;
                localPortPanel.current.open = true;
                localPortPanel.current.scrollIntoView?.({ block: 'nearest' });
              }} />
            </div>
          </details>
        </fieldset>
      </ProxyImportDialog>

      <BulkAssign proxies={usableProxies} pool={proxies} accounts={accounts} onAssign={onAssign} disabled={busy} onBusyChange={(next) => childBusy(next, 'assign')} onTestProxy={async (proxy) => (await probe(proxy)).ok} />

      <nav aria-label="代理与账号" className="flex gap-1 rounded-lg bg-slate-200/60 p-1 xl:hidden dark:bg-slate-900">
        {([['proxies', '代理列表', proxies.length], ['accounts', '账号绑定', accounts.length]] as const).map(([pane, label, count]) => <button key={pane} type="button" aria-pressed={mobilePane === pane} onClick={() => setMobilePane(pane)} className={cn('h-9 flex-1 rounded-md text-[13px] font-medium', mobilePane === pane ? 'bg-white text-blue-700 shadow-sm dark:bg-slate-800 dark:text-blue-300' : 'text-slate-600 dark:text-slate-400')}>{label} · {count}</button>)}
      </nav>

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(20rem,0.85fr)_minmax(0,1.4fr)]">
        <section id="proxy-management" className={cn('min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950', mobilePane !== 'proxies' && 'hidden xl:block')} aria-labelledby="proxy-list-heading">
          <header className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4">
            <h2 id="proxy-list-heading" className="text-sm font-semibold">代理列表 <span className="ml-1 text-xs font-normal text-slate-500 dark:text-slate-400">{proxies.length}</span></h2>
            <button type="button" onClick={() => void testAll()} disabled={!usableProxies.length || busy} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-40 dark:text-blue-300 dark:hover:bg-blue-950/40">
              {testingAll ? <Loader2 className="size-3.5 animate-spin" /> : <Wifi className="size-3.5" />}
              {testingAll ? `测活中 ${testProgress}/${usableProxies.length}` : '全部测活'}
            </button>
          </header>
          <div className="space-y-3 px-4 pb-3 pt-3">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索代理名称或地址" aria-label="搜索代理出口" className="h-9 w-full rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-3 text-[13px] outline-none placeholder:text-slate-400 focus:border-blue-400 dark:border-slate-700 dark:bg-slate-900" />
            </label>
            <p className="text-xs text-slate-500 dark:text-slate-400">点击代理名称，为账号指定此代理。</p>
            {testSummary && <p role="status" className="text-xs text-slate-600 dark:text-slate-300">测试完成，{testSummary.passed}/{testSummary.total} 个连接正常。</p>}
            {diagnosis && diagnosis.kind !== 'ok' && <div role="status" className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:bg-amber-950/30 dark:text-amber-200"><p className="font-medium">{diagnosis.title}</p>{diagnosis.hint && <p className="mt-1">{diagnosis.hint}</p>}</div>}
            {testError && <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">{testError}</p>}
          </div>
          <div className="max-h-[34rem] divide-y divide-slate-100 overflow-y-auto border-t border-slate-100 xl:max-h-[clamp(12rem,calc(100dvh_-_34rem),34rem)] dark:divide-slate-800 dark:border-slate-800">
            <AnimatePresence initial={false}>
              {visibleProxies.map((proxy) => {
                const state = tests[proxy.id] ?? { state: 'idle' as const };
                const nameOnly = isNameOnlyProxy(proxy);
                const selected = !nameOnly && selectedProxyId === proxy.id;
                const used = usage.get(proxy.id) ?? 0;
                return (
                  <motion.article key={proxy.id} aria-label={`代理 ${proxy.name}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className={cn('border-l-2 px-3 py-3 transition-colors', selected ? 'border-l-blue-500 bg-blue-50/60 dark:bg-blue-950/25' : 'border-l-transparent hover:bg-slate-50/70 dark:hover:bg-slate-900/40')}>
                    <div className="flex items-start gap-2">
                      <button type="button" onClick={() => chooseProxy(proxy.id)} disabled={nameOnly || busy} aria-pressed={selected} aria-label={`绑定账号到 ${proxy.name}`} className="flex min-w-0 flex-1 items-start gap-2.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-default">
                        <span className={cn('mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg', nameOnly ? 'bg-amber-50 text-amber-600 dark:bg-amber-950/30' : selected ? 'bg-blue-100 text-blue-600 dark:bg-blue-950 dark:text-blue-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400')}>{nameOnly ? <Unplug className="size-4" /> : <Globe2 className="size-4" />}</span>
                        <span className="min-w-0 flex-1">
                          <span title={proxy.name} className="block truncate text-[13px] font-semibold">{proxy.name}</span>
                          <span className="mt-1 block truncate text-xs text-slate-500 dark:text-slate-400">{nameOnly ? '缺少代理地址，暂不能绑定' : `${effectiveProxyScheme(proxy)}://${proxy.host}:${proxy.port}`}</span>
                        </span>
                      </button>
                      <span className="pt-0.5 text-xs text-slate-500 dark:text-slate-400">{used} 个账号</span>
                    </div>
                    <div className="mt-2 flex items-center gap-2 pl-10">
                      <span title={state.message} className={cn('min-w-0 flex-1 truncate text-xs', state.state === 'ok' ? 'text-emerald-700 dark:text-emerald-400' : state.state === 'fail' ? 'text-rose-600 dark:text-rose-400' : 'text-slate-500 dark:text-slate-400')}>
                        {nameOnly ? '待补充' : state.state === 'testing' ? '测活中…' : state.state === 'idle' ? '未测活' : state.message}
                      </span>
                      <button type="button" onClick={() => void test(proxy)} disabled={nameOnly || busy} aria-label={`测试 ${proxy.name}`} title="测活" className="inline-flex h-7 shrink-0 items-center gap-1 rounded px-1.5 text-xs text-blue-700 hover:bg-blue-50 disabled:opacity-35 dark:text-blue-300 dark:hover:bg-blue-950">
                        {state.state === 'testing' ? <Loader2 className="size-3.5 animate-spin" /> : state.state === 'ok' ? <CheckCircle2 className="size-3.5" /> : state.state === 'fail' ? <XCircle className="size-3.5" /> : <Wifi className="size-3.5" />}测活
                      </button>
                      <button type="button" onClick={() => void remove(proxy)} disabled={busy} aria-label={`删除 ${proxy.name}`} title="删除代理" className="grid size-7 shrink-0 place-items-center rounded text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-35 dark:hover:bg-rose-950/30"><Trash2 className="size-3.5" /></button>
                    </div>
                  </motion.article>
                );
              })}
            </AnimatePresence>
            {!visibleProxies.length && <p className="px-4 py-10 text-center text-[13px] text-slate-500 dark:text-slate-400">{proxies.length ? '没有匹配的代理。' : '还没有代理，点击右上方“添加代理”。'}</p>}
          </div>
        </section>

        <section ref={bindingSection} id="account-proxy-binding" aria-labelledby="account-proxy-binding-heading" className={cn('min-w-0 scroll-mt-20 overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950', mobilePane !== 'accounts' && 'hidden xl:block')}>
          <header className="border-b border-slate-100 px-4 py-4 dark:border-slate-800">
            <h2 id="account-proxy-binding-heading" className="text-sm font-semibold">账号绑定 <span className="ml-1 text-xs font-normal text-slate-500 dark:text-slate-400">{accounts.length}</span></h2>
            <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">查看当前代理，勾选账号后可批量指定。</p>
          </header>
          <AccountBindingPicker open initialProxyId={selectedProxyId || undefined} onProxyChange={setSelectedProxyId} proxies={proxies} accounts={accounts} sites={sites} onAssign={onAssign} onSetAccountProxy={onSetAccountProxy} disabled={busy} onBusyChange={(next) => childBusy(next, 'bind')} onShowImport={showImport} />
        </section>
      </div>
    </div>
  );
}
