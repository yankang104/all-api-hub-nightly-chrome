import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  CheckCircle2,
  FileDown,
  Globe2,
  Loader2,
  Network,
  Search,
  Trash2,
  Unplug,
  Users,
  Wifi,
  XCircle,
} from 'lucide-react';
import type { Account, ProxyConfig, SiteConfig } from '@/types';
import { Modal } from './Modal';
import { sendMessage } from '@/lib/core/messaging';
import { cn } from '@/lib/core/cn';
import { effectiveProxyScheme } from '@/lib/proxy/proxy-config';
import type { ProxyAssignment } from '@/lib/proxy/proxy-assign';
import { diagnoseListenerFailures, type ListenerProbe } from '@/lib/proxy/listener-diagnosis';
import { AccountBindingPicker } from './proxy/AccountBindingPicker';
import { ClashConfigImport } from './proxy/ClashConfigImport';
import { ClashControllerImport } from './proxy/ClashControllerImport';
import { ListenerPlanPanel } from './proxy/ListenerPlanPanel';
import { LocalPortScan } from './proxy/LocalPortScan';
import { SubscriptionImport } from './proxy/SubscriptionImport';

interface Props {
  open: boolean;
  initialTab?: Tab;
  initialProxyId?: string;
  proxies: ProxyConfig[];
  accounts: Account[];
  sites: SiteConfig[];
  onClose: () => void;
  onAddMany: (inputs: Omit<ProxyConfig, 'id'>[]) => Promise<{ added: number; skipped: number; upgraded: number }>;
  onSyncClash: (inputs: Omit<ProxyConfig, 'id'>[]) => Promise<{ added: number; skipped: number; upgraded: number; removed: number; keptInUse: number }>;
  onRemove: (proxyId: string) => Promise<void>;
  onAssign: (assignments: ProxyAssignment[]) => Promise<number>;
  onSetAccountProxy: (accountId: string, patch: Pick<Account, 'proxyMode' | 'proxyId' | 'proxyPinned'>) => Promise<void>;
}

type TestState = { state: 'idle' | 'testing' | 'ok' | 'fail'; message?: string };
type Tab = 'import' | 'exits' | 'assign';

/** Manage only browser-usable HTTP/SOCKS exits. */
export function ProxyModal({ open, initialTab = 'import', initialProxyId, proxies, accounts, sites, onClose, onAddMany, onSyncClash, onRemove, onAssign, onSetAccountProxy }: Props) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [query, setQuery] = useState('');
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [testingAll, setTestingAll] = useState(false);
  const [testProgress, setTestProgress] = useState(0);
  const [testSummary, setTestSummary] = useState<{ passed: number; total: number } | null>(null);
  const [diagnosis, setDiagnosis] = useState<ReturnType<typeof diagnoseListenerFailures> | null>(null);
  const [missingListenerNames, setMissingListenerNames] = useState<string[]>([]);
  const localPortPanel = useRef<HTMLDetailsElement>(null);

  useLayoutEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  const clashProxies = useMemo(() => proxies.filter((proxy) => proxy.sourceLabel === 'Clash Verge'), [proxies]);
  const usableProxies = useMemo(() => proxies.filter((proxy) => !proxy.nameOnly), [proxies]);
  const displayProxies = useMemo(
    () => proxies.filter((proxy) => !proxy.nameOnly || proxy.sourceLabel === 'Clash Verge'),
    [proxies],
  );
  const visibleProxies = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) return displayProxies;
    return displayProxies.filter((proxy) => `${proxy.name} ${proxy.host}:${proxy.port}`.toLowerCase().includes(text));
  }, [displayProxies, query]);

  async function test(proxy: ProxyConfig): Promise<boolean> {
    if (proxy.nameOnly) return false;
    setTests((current) => ({ ...current, [proxy.id]: { state: 'testing' } }));
    const response = await sendMessage({ type: 'TEST_PROXY', proxy });
    const result = response.ok ? response.test : undefined;
    const error = response.ok ? undefined : response.error;
    setTests((current) => ({
      ...current,
      [proxy.id]: result?.ok
        ? { state: 'ok', message: result.message }
        : { state: 'fail', message: result?.message ?? error ?? '测试失败' },
    }));
    return result?.ok === true;
  }

  async function testAll() {
    if (!usableProxies.length || testingAll) return;
    setTestingAll(true);
    setTestProgress(0);
    setTestSummary(null);
    setDiagnosis(null);
    let passed = 0;
    /*
     * 逐个测活并收集「端口是否在监听」。汇总后交给 diagnoseListenerFailures
     * 给出「脚本没生效」还是「节点连不通」的结论 —— 全失败时这比 44 条
     * 一模一样的「连不上」有用得多。
     */
    const outcomes: { port: number; probe: ListenerProbe; test: { ok: boolean; message: string } }[] = [];
    for (const [index, proxy] of usableProxies.entries()) {
      const response = await sendMessage({ type: 'TEST_PROXY', proxy });
      const result = response.ok ? response.test : undefined;
      const ok = result?.ok === true;
      if (ok) passed += 1;
      setTests((current) => ({
        ...current,
        [proxy.id]: result?.ok
          ? { state: 'ok', message: result.message }
          : { state: 'fail', message: result?.message ?? (response.ok ? '测试失败' : response.error) },
      }));
      outcomes.push({
        port: proxy.port,
        probe: (result?.listenerProbe ?? 'unknown') as ListenerProbe,
        test: { ok, message: result?.message ?? '' },
      });
      setTestProgress(index + 1);
    }
    setTestSummary({ passed, total: usableProxies.length });
    setDiagnosis(diagnoseListenerFailures(outcomes));
    setTestingAll(false);
  }

  return (
    <Modal open={open} title={tab === 'assign' ? '绑定账号' : '代理管理'} onClose={onClose} wide>
      <div className="space-y-4">
        {tab !== 'assign' && (
          <>
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-lg bg-brand-50 px-3 py-2.5 dark:bg-brand-950/20">
                <p className="text-[10px] text-brand-700/70 dark:text-brand-300/60">Clash 节点</p>
                <p className="mt-0.5 text-lg font-semibold tabular-nums text-brand-700 dark:text-brand-300">{clashProxies.length || '--'}</p>
              </div>
              <div className="rounded-lg bg-emerald-50 px-3 py-2.5 dark:bg-emerald-950/20">
                <p className="text-[10px] text-emerald-700/70 dark:text-emerald-300/60">固定出口</p>
                <p className="mt-0.5 text-lg font-semibold tabular-nums text-emerald-700 dark:text-emerald-300">{usableProxies.length}</p>
              </div>
              <div className="rounded-lg bg-sky-50 px-3 py-2.5 dark:bg-sky-950/20">
                <p className="text-[10px] text-sky-700/70 dark:text-sky-300/60">本次测活</p>
                <p className="mt-0.5 text-lg font-semibold tabular-nums text-sky-700 dark:text-sky-300">
                  {testSummary ? `${testSummary.passed}/${testSummary.total}` : '--'}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-1 rounded-lg bg-ink-100 p-1 dark:bg-ink-900">
              {([
                ['import', FileDown, '导入代理'],
                ['exits', Network, '全部节点'],
                ['assign', Users, '账号绑定'],
              ] as const).map(([value, Icon, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setTab(value)}
                  className={cn(
                    'flex min-w-0 items-center justify-center gap-1.5 rounded-md px-1.5 py-2 text-xs font-medium transition-colors',
                    tab === value
                      ? 'bg-white text-ink-900 shadow-sm dark:bg-ink-800 dark:text-ink-50'
                      : 'text-ink-800/55 hover:text-ink-900 dark:text-ink-100/45 dark:hover:text-ink-50',
                  )}
                >
                  <Icon className="size-3.5 shrink-0" />
                  <span className="truncate">{label}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {tab === 'import' && (
          /*
           * 顺序就是用户实际的路径：粘订阅 → （订阅里全是浏览器用不了的协议时）
           * 就地生成 listeners 配置 → 重载内核 → 入池。
           *
           * 生成面板必须紧跟订阅框：它是导入动作的直接续作，隔在文件导入和控制器
           * 后面的那段空档里，用户会以为「导入失败」就到此为止了。
           */
          <section className="space-y-3">
            <SubscriptionImport onImport={onAddMany} onNamesParsed={setMissingListenerNames} />
            {missingListenerNames.length > 0 && (
              <ListenerPlanPanel names={missingListenerNames} onImport={onAddMany} />
            )}
            <details ref={localPortPanel} className="rounded-lg bg-ink-50 px-3 py-2.5 dark:bg-ink-900/70">
              <summary className="cursor-pointer text-xs font-medium text-ink-800/70 dark:text-ink-100/60">
                检测一个本地端口
              </summary>
              <div className="mt-3">
                <LocalPortScan onImport={onAddMany} />
              </div>
            </details>

            {/* 其余导入路径：确实需要时再展开，避免把主路径埋掉 */}
            <details className="rounded-lg bg-ink-50 px-3 py-2.5 dark:bg-ink-900/70">
              <summary className="cursor-pointer text-xs font-medium text-ink-800/70 dark:text-ink-100/60">
                其他导入方式（已有固定端口 / 读内核节点目录 / 手工清单）
              </summary>
              <div className="mt-3 space-y-3">
                <ClashConfigImport onSync={onSyncClash} onMissingNames={setMissingListenerNames} />
                <ClashControllerImport
                  onNamesRead={setMissingListenerNames}
                  onUseLocalProxy={() => {
                    if (!localPortPanel.current) return;
                    localPortPanel.current.open = true;
                    localPortPanel.current.scrollIntoView({ block: 'nearest' });
                  }}
                />
              </div>
            </details>
          </section>
        )}

        {tab === 'exits' && (
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <label className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-800/35 dark:text-ink-100/30" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索出口名称或端口"
                  aria-label="搜索代理出口"
                  className="h-8 w-full rounded-lg bg-ink-50 pl-8 pr-3 text-xs text-ink-900 outline-none ring-1 ring-black/5 placeholder:text-ink-800/35 focus:ring-2 focus:ring-brand-500/40 dark:bg-ink-900 dark:text-ink-50 dark:ring-white/10"
                />
              </label>
              <span className="shrink-0 text-[11px] tabular-nums text-ink-800/50 dark:text-ink-100/40">{visibleProxies.length}/{displayProxies.length}</span>
              <button
                type="button"
                onClick={() => void testAll()}
                disabled={!usableProxies.length || testingAll}
                title="逐个测试全部固定出口的实际联网能力"
                className="flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-sky-600 px-2.5 text-[11px] font-semibold text-white transition-colors hover:bg-sky-700 disabled:opacity-40"
              >
                {testingAll ? <Loader2 className="size-3.5 animate-spin" /> : <Wifi className="size-3.5" />}
                {testingAll ? `${testProgress}/${usableProxies.length}` : '全部测活'}
              </button>
            </div>

            {/* 测活诊断结论:只在有失败项时出现,直接给出下一步 */}
            {diagnosis && diagnosis.kind !== 'ok' && (
              <div
                role="status"
                className={cn(
                  'rounded-lg px-3 py-2.5 text-[11px] leading-relaxed ring-1',
                  diagnosis.kind === 'listener-missing'
                    ? 'bg-amber-500/10 text-amber-800 ring-amber-500/20 dark:text-amber-200'
                    : 'bg-rose-500/10 text-rose-700 ring-rose-500/20 dark:text-rose-300',
                )}
              >
                <p className="font-semibold">{diagnosis.title}</p>
                {diagnosis.hint && <p className="mt-0.5 opacity-85">{diagnosis.hint}</p>}
              </div>
            )}
            {!displayProxies.length ? (
              <div className="border-y border-dashed border-ink-200 px-4 py-8 text-center dark:border-ink-700">
                <Wifi className="mx-auto size-6 text-ink-800/25 dark:text-ink-100/20" />
                <p className="mt-2 text-xs font-medium text-ink-800/65 dark:text-ink-100/55">还没有已配置出口</p>
                <button
                  type="button"
                  onClick={() => setTab('import')}
                  className="mt-3 text-xs font-semibold text-brand-600 hover:underline dark:text-brand-400"
                >
                  现在导入
                </button>
              </div>
            ) : (
              <div className="max-h-[380px] space-y-1.5 overflow-y-auto pr-0.5">
                <AnimatePresence mode="popLayout">
                  {visibleProxies.map((proxy) => {
                    const state = tests[proxy.id] ?? { state: 'idle' as const };
                    const scheme = proxy.nameOnly ? null : effectiveProxyScheme(proxy);
                    return (
                      <motion.div
                        key={proxy.id}
                        layout
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, height: 0 }}
                        className="flex items-center gap-2.5 rounded-lg bg-ink-50 px-3 py-2.5 ring-1 ring-black/5 dark:bg-ink-900 dark:ring-white/10"
                      >
                        {proxy.nameOnly
                          ? <Unplug className="size-4 shrink-0 text-amber-500" />
                          : <Globe2 className="size-4 shrink-0 text-brand-500" />}
                        <div className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium text-ink-900 dark:text-ink-50" title={proxy.name}>{proxy.name}</span>
                          <p className={cn(
                            'truncate text-[11px]',
                            proxy.nameOnly
                              ? 'text-amber-700 dark:text-amber-300'
                              : 'text-ink-800/50 dark:text-ink-100/40',
                          )}>
                            {proxy.nameOnly ? '无固定 listener，暂不能绑定' : `${scheme}://${proxy.host}:${proxy.port}`}
                          </p>
                        </div>
                        {state.state !== 'idle' && (
                          <span
                            className={cn(
                              'hidden max-w-[120px] truncate text-[10px] font-medium sm:block',
                              state.state === 'ok' && 'text-emerald-600 dark:text-emerald-400',
                              state.state === 'fail' && 'text-rose-600 dark:text-rose-400',
                              state.state === 'testing' && 'text-ink-800/40 dark:text-ink-100/40',
                            )}
                            title={state.message}
                          >
                            {state.state === 'testing' ? '测试中' : state.message}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => void test(proxy)}
                          disabled={proxy.nameOnly || state.state === 'testing' || testingAll}
                          title={proxy.nameOnly ? '该节点没有独立 listener' : '测试连通性'}
                          aria-label={`测试 ${proxy.name}`}
                          className="shrink-0 rounded-md p-1.5 text-brand-600 hover:bg-brand-500/10 disabled:opacity-40 dark:text-brand-400"
                        >
                          {state.state === 'testing'
                            ? <Loader2 className="size-3.5 animate-spin" />
                            : state.state === 'ok'
                              ? <CheckCircle2 className="size-3.5" />
                              : state.state === 'fail'
                                ? <XCircle className="size-3.5" />
                                : <Wifi className="size-3.5" />}
                        </button>
                        <button
                          type="button"
                          onClick={() => void onRemove(proxy.id)}
                          title="删除出口"
                          aria-label={`删除 ${proxy.name}`}
                          className="shrink-0 rounded-md p-1.5 text-rose-500 hover:bg-rose-500/10"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
                {!visibleProxies.length && <p className="py-8 text-center text-xs text-ink-800/45 dark:text-ink-100/35">没有匹配的出口</p>}
              </div>
            )}
          </section>
        )}

        {tab === 'assign' && (
          <section className="space-y-3">
            <AccountBindingPicker
              key={initialProxyId ?? 'all-proxies'}
              open={open}
              initialProxyId={initialProxyId}
              proxies={proxies}
              accounts={accounts}
              sites={sites}
              onAssign={onAssign}
              onSetAccountProxy={onSetAccountProxy}
              onShowImport={() => setTab('import')}
            />
          </section>
        )}
      </div>
    </Modal>
  );
}
