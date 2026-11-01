import { useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Loader2, Shuffle, Wrench } from 'lucide-react';
import type { Account, ProxyConfig } from '@/types';
import { sendMessage } from '@/lib/core/messaging';
import { cn } from '@/lib/core/cn';
import { assignProxies, type AssignMode, type ProxyAssignment } from '@/lib/proxy/proxy-assign';
import { planNameOnlyRepair, nameOnlyBoundAccounts } from '@/lib/proxy/proxy-repair';
import { isNameOnlyProxy } from '@/lib/proxy/proxy-config';

interface Props {
  /** 已剔除「无出口节点名」的可用出口：测活与批量分配只在它们之间进行。 */
  proxies: readonly ProxyConfig[];
  /**
   * 完整代理池（含无出口的订阅节点名）。
   *
   * 修复入口必须看得到那些「没有出口」的条目，否则它根本认不出谁绑死在上面；
   * 而批量分配恰恰不能拿到它们。两个列表因此必须分开传。缺省退回 proxies，
   * 兼容只传一个列表的旧调用方。
   */
  pool?: readonly ProxyConfig[];
  accounts: readonly Account[];
  onAssign: (assignments: ProxyAssignment[]) => Promise<number>;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onTestProxy?: (proxy: ProxyConfig) => Promise<boolean>;
}

const MODES: { value: AssignMode; label: string; hint: string }[] = [
  { value: 'unassigned', label: '保留手动绑定', hint: '分配其余账号，保留手动绑定、直连和自定义代理' },
  { value: 'all', label: '全部重新分配', hint: '覆盖已有绑定，包括直连和自定义地址' },
];

/**
 * 把池里的节点批量绑到账号，一账号一节点。
 *
 * 测活必须串行：chrome.proxy 是浏览器全局设置，并发测会互相踩。
 * 所以这里自己循环发 TEST_PROXY 并显示进度，而不是丢给后台一个批量消息 ——
 * 后台跑几十秒没有任何反馈，用户只会以为界面卡死了。
 */
export function BulkAssign({ proxies, pool, accounts, onAssign, disabled = false, onBusyChange, onTestProxy }: Props) {
  const repairPool = pool ?? proxies;
  const usableProxies = useMemo(() => proxies.filter((proxy) => !isNameOnlyProxy(proxy)), [proxies]);
  const operationBusy = useRef(false);
  const [mode, setMode] = useState<AssignMode>('unassigned');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [repairBusy, setRepairBusy] = useState(false);
  const [repairSummary, setRepairSummary] = useState<string | null>(null);
  const targets = assignProxies(accounts, usableProxies.map((proxy) => proxy.id), mode).assignments.length;

  /**
   * 绑在「没有出口的节点名」上的账号数 —— 它们是死局，但界面此前从不提示。
   *
   * 判定与换绑共用 nameOnlyBoundAccounts，避免按钮上写 3 个、点下去改 5 个。
   */
  const stuck = useMemo(() => nameOnlyBoundAccounts(accounts, repairPool), [accounts, repairPool]);

  /**
   * 把死局账号换绑到**同地区的真实出口**。
   *
   * 与「悄悄改走直连」是两件事：换到同地区节点保住了用户真正在意的出口国家，
   * 站点不会因此触发异地登录风控；直连则把出口整个丢掉，所以只做前者。
   */
  async function repair() {
    if (disabled || operationBusy.current) return;
    const plan = planNameOnlyRepair(accounts, repairPool);
    if (!plan.assignments.length) {
      setRepairSummary(plan.unresolved.length
        ? `没有可匹配的代理，${plan.unresolved.length} 个账号尚未换绑。请先添加代理。`
        : '没有需要换绑的账号。');
      return;
    }
    operationBusy.current = true;
    setRepairBusy(true);
    onBusyChange?.(true);
    setRepairSummary(null);
    try {
      const assigned = await onAssign(plan.assignments);
      setRepairSummary([
        `已把 ${assigned} 个账号换到真实出口`,
        plan.crossRegion ? `其中 ${plan.crossRegion} 个只能跨区顶上（同地区没有可用出口），出口国家已改变` : '',
        plan.unresolved.length ? `${plan.unresolved.length} 个账号尚未找到可匹配的代理` : '',
      ].filter(Boolean).join(' · '));
    } catch (error) {
      setRepairSummary(error instanceof Error ? `换绑失败：${error.message}` : '换绑失败，请重试。');
    } finally {
      operationBusy.current = false;
      setRepairBusy(false);
      onBusyChange?.(false);
    }
  }

  async function run() {
    if (disabled || !targets || operationBusy.current) return;
    operationBusy.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setSummary(null);

    /*
     * 名称条目**不参与分配**。
     *
     * 它们没有浏览器能用的出口，绑上去就是个死局：`resolveProxyForAccount`
     * 见到名称条目一律报错「只是订阅里的节点名，没有浏览器能用的出口」，
     * 签到当场失败，`refreshOneBalance` 走同一条解析，站点卡片的余额也
     * 永远停在「未获取」。用户看到的是一行红字，却不知道是这里发出去的。
     *
     * 曾经放它们进来是为了「界面显示 + 账号绑定」，但那点管理价值换来的是
     * 注定跑不起来的绑定 —— 分配和执行两边对同一条数据给出相反的判断，
     * 这种不一致必须由发放的一方兜住。它们仍留在池里可看、可被同名的
     * 真实出口原地升级（见 lib/proxy-upgrade.ts），只是不再发给账号。
     */
    try {
      const live: string[] = [];
      for (const [index, proxy] of usableProxies.entries()) {
        setProgress(`测活 ${index + 1}/${usableProxies.length} · ${proxy.name}`);
        const ok = onTestProxy
          ? await onTestProxy(proxy)
          : await sendMessage({ type: 'TEST_PROXY', proxy }).then((response) => response.ok && response.test?.ok === true);
        if (ok) live.push(proxy.id);
      }
      setProgress(null);

      if (!live.length) {
        setSummary(`池里 ${usableProxies.length} 个已配置出口全部不通，没有写入任何绑定`);
        return;
      }

      const plan = assignProxies(accounts, live, mode);
      if (!plan.assignments.length) {
        setSummary('所有账号均有手动代理设置，没有需要分配的账号');
        return;
      }

      const assigned = await onAssign(plan.assignments);
      setSummary([
        `已为 ${assigned} 个账号绑定节点`,
        live.length < usableProxies.length ? `排除不通节点 ${usableProxies.length - live.length} 个` : '',
        plan.skipped ? `保留手动设置 ${plan.skipped} 个` : '',
        plan.unusedProxies ? `剩余未使用节点 ${plan.unusedProxies} 个` : '',
      ].filter(Boolean).join(' · '));
    } catch (error) {
      setSummary(error instanceof Error ? `测活或分配失败：${error.message}` : '测活或分配失败，请重试。');
    } finally {
      operationBusy.current = false;
      setProgress(null);
      setBusy(false);
      onBusyChange?.(false);
    }
  }

  return (
    <section aria-labelledby="bulk-assign-heading" className="space-y-4 rounded-xl border border-blue-200 bg-white p-4 sm:p-5 dark:border-blue-900 dark:bg-slate-950">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="bulk-assign-heading" className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
          <Shuffle className="size-4 text-blue-600 dark:text-blue-400" />批量分配
        </h2>
        <span className="text-xs text-slate-500 dark:text-slate-400">{usableProxies.length} 个代理 · {accounts.length} 个账号</span>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_12rem]">
        <fieldset className="min-w-0" disabled={disabled || busy || repairBusy}>
          <legend className="mb-2 text-xs font-medium text-slate-600 dark:text-slate-300">分配方式</legend>
          <div className="grid grid-cols-2 gap-2">
            {MODES.map((item) => (
              <label
                key={item.value}
                className={cn(
                  'flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 text-[13px] transition-colors',
                  mode === item.value
                    ? 'border-blue-400 bg-blue-50/70 text-blue-800 dark:border-blue-500 dark:bg-blue-950/30 dark:text-blue-200'
                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200 dark:hover:bg-slate-900',
                )}
              >
                <input
                  type="radio"
                  name="assign-mode"
                  className="mt-0.5 size-4 shrink-0 accent-blue-600"
                  aria-label={item.label}
                  value={item.value}
                  checked={mode === item.value}
                  disabled={disabled || busy || repairBusy}
                  onChange={() => setMode(item.value)}
                />
                <span>
                  <span className="block font-medium">{item.label}</span>
                  <span className="mt-0.5 hidden text-xs leading-relaxed text-slate-500 sm:block dark:text-slate-400">{item.hint}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-slate-500 sm:hidden dark:text-slate-400">{MODES.find((item) => item.value === mode)?.hint}</p>
        </fieldset>

        <div className="space-y-2 lg:pt-6">
          <motion.button
            whileTap={{ scale: 0.98 }}
            type="button"
            disabled={disabled || !targets || busy || repairBusy}
            onClick={run}
            className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-45"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Shuffle className="size-4" />}
            {busy ? '正在测活并分配…' : '测活并分配'}
          </motion.button>
          <p className="text-center text-xs text-slate-500 dark:text-slate-400">本次分配 {targets} 个账号</p>
        </div>
      </div>

      <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">先检查连接，再把通过测活的代理按顺序分给账号；代理不足时循环使用。</p>
      {progress && <p role="status" className="break-words rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">{progress}</p>}
      {!usableProxies.length && <p className="text-xs text-amber-700 dark:text-amber-300">请先添加代理。</p>}
      {!!usableProxies.length && !targets && <p className="text-xs text-slate-500 dark:text-slate-400">{accounts.length ? '当前账号均有手动设置。如需覆盖，请选择“全部重新分配”。' : '请先添加账号。'}</p>}
      {summary && <p role="status" className="rounded-lg bg-slate-50 px-3 py-2.5 text-[13px] leading-relaxed text-slate-700 dark:bg-slate-900 dark:text-slate-200">{summary}</p>}

      {stuck.length > 0 && (
        <div className="space-y-2 rounded-lg bg-amber-50 p-2.5 ring-1 ring-amber-500/20 dark:bg-amber-950/30">
          <p className="text-[11px] leading-relaxed text-amber-800 dark:text-amber-200">
            {stuck.length} 个账号绑定的节点缺少代理地址，可尝试匹配同地区的代理。
          </p>
          <motion.button
            whileTap={{ scale: 0.98 }}
            type="button"
            disabled={disabled || busy || repairBusy}
            onClick={repair}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-amber-500 px-3 py-2 text-[11px] font-medium text-white transition-colors hover:bg-amber-600 disabled:opacity-40"
          >
            {repairBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Wrench className="size-3.5" />}
            {repairBusy ? '换绑中...' : `换到同地区的真实出口（${stuck.length} 个）`}
          </motion.button>
        </div>
      )}

      {/*
        * 结果必须留在面板外面。
        *
        * 换绑成功后「死局账号」变成 0 个，上面那块提示连同里面的文案会一起消失 ——
        * 用户点完按钮看不到任何确认。跨区那一条尤其不能丢：出口国家变了要如实说，
        * 否则用户以为账号还走原来的地区。
        */}
      {repairSummary && (
        <p className="rounded-lg bg-amber-50 p-2.5 text-[11px] leading-relaxed text-amber-800 ring-1 ring-amber-500/20 dark:bg-amber-950/30 dark:text-amber-200">
          {repairSummary}
        </p>
      )}
    </section>
  );
}
