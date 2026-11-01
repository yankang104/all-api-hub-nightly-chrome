import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, ClipboardCopy, Loader2, RefreshCw, Server, Wand2 } from 'lucide-react';
import type { ProxyConfig } from '@/types';
import { buildListenerPlan, DEFAULT_LISTENER_START_PORT, type ListenerPlanEntry } from '@/lib/clash/clash-listeners';
import { KEYS, local } from '@/lib/core/storage';
import { sendMessage } from '@/lib/core/messaging';
import { cn } from '@/lib/core/cn';
import { NodePicker } from './NodePicker';

interface Props {
  /** 上游读到的节点名（控制器 /proxies、订阅里 Chrome 用不了的那些） */
  names: readonly string[];
  onImport: (inputs: Omit<ProxyConfig, 'id'>[]) => Promise<{ added: number; skipped: number; upgraded: number }>;
}

/**
 * 「一个节点一个本地端口」的配置生成器。
 *
 * 这是补上代理池最后一环的地方。此前唯一的导入路径是读 `clash-verge.yaml` 已有的
 * `listeners:`，而机场订阅的 vmess/vless 节点默认根本没有 listener —— 于是几十个
 * 节点里只有手工配过的那两三个能进来，看起来像「加载不全」，实际是信息源里没有。
 *
 * 这里反过来做：先拿到节点名，替用户把 `listeners:` 写出来，粘进 Clash Verge 重载
 * 之后每个节点都有自己的 `127.0.0.1:<port>` 出口，浏览器就能按账号分别绑定。
 *
 * 端口与节点的对应关系必须**先入池再改配置**吗？不必，两边顺序无关 —— 入池只是
 * 记下 `name → 127.0.0.1:port`，真正的连通性由用户重载配置后各条目的测试按钮确认。
 */
export function ListenerPlanPanel({ names, onImport }: Props) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(names));
  const [startPort, setStartPort] = useState(String(DEFAULT_LISTENER_START_PORT));
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [autoSync, setAutoSync] = useState(true);
  const [checking, setChecking] = useState(false);
  const [drift, setDrift] = useState<{ added: number; removed: number; needsResync: boolean; checkedAt: number } | null>(null);
  const [hasSource, setHasSource] = useState(false);

  // 每次从新配置读取节点时默认全选，避免用户面对几十个名称还要再点一次；
  // 用户手动清空/缩小范围后，names 不变时不会被这个同步覆盖。
  useEffect(() => {
    setSelected(new Set(names));
  }, [names]);

  const portNumber = Number(startPort);
  const portValid = Number.isInteger(portNumber) && portNumber > 0 && portNumber <= 65535;

  /** 按 names 的原始顺序生成，端口分配才与用户看到的列表一致 */
  const picked = useMemo(
    () => names.filter((name) => selected.has(name)),
    [names, selected],
  );

  // 端口按「节点名」锁定：每次进来先读持久化映射，老节点沿用老端口。
  // stored 是异步的：空数组时先用空映射渲染，加载完成后自然重渲染一次。
  const [stored, setStored] = useState<ListenerPlanEntry[]>([]);
  useEffect(() => {
    let disposed = false;
    void local.get<ListenerPlanEntry[]>(KEYS.listenerPlan, []).then((value) => {
      if (!disposed && Array.isArray(value)) setStored(value);
    }).catch(() => {});
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    let disposed = false;
    void local.get<{ url?: string; autoSync?: boolean } | null>(KEYS.subscriptionSource, null).then((value) => {
      if (disposed || !value) return;
      setHasSource(typeof value.url === 'string' && value.url.length > 0);
      setAutoSync(value.autoSync !== false);
    }).catch(() => {});
    return () => { disposed = true; };
  }, []);

  const plan = useMemo(
    () => buildListenerPlan(picked, portValid ? portNumber : DEFAULT_LISTENER_START_PORT, undefined, stored),
    [picked, portNumber, portValid, stored],
  );

  // 成功构建(有选中节点)后把映射原子写回；空选择不覆盖旧映射。
  useEffect(() => {
    if (!plan.entries.length) return;
    void local.set(KEYS.listenerPlan, plan.entries).catch(() => {});
  }, [plan.entries]);

  const portOf = useMemo(
    () => new Map(plan.entries.map((entry) => [entry.nodeName, entry.port])),
    [plan.entries],
  );

  async function copyYaml() {
    if (!plan.yaml) return;
    try {
      await navigator.clipboard.writeText(plan.yaml);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_800);
    } catch {
      setNote('复制失败，请手动选中下面的配置文本');
    }
  }

  const [copiedScript, setCopiedScript] = useState(false);
  async function copyScript() {
    if (!plan.script) return;
    try {
      await navigator.clipboard.writeText(plan.script);
      setCopiedScript(true);
      setTimeout(() => setCopiedScript(false), 1_800);
    } catch {
      setNote('复制失败，请手动选中下面的脚本文本');
    }
  }

  /**
   * 立即检查订阅更新:后台拉订阅 → diff → 只把新端口补进池。
   * 不触碰 Clash Verge;有新节点时提示重粘一次 Script。
   */
  async function checkNow() {
    if (checking) return;
    setChecking(true);
    setNote(null);
    try {
      const response = await sendMessage({ type: 'CHECK_LISTENER_DRIFT' });
      if (!response.ok) throw new Error(response.error);
      const report = response.feature?.listenerDrift;
      if (!report) throw new Error('后台没有返回检查结果');
      setDrift({ added: report.added, removed: report.removed, needsResync: report.needsResync, checkedAt: report.checkedAt });
      setNote(report.needsResync
        ? `订阅里有 ${report.added} 个新节点已补进代理池;请重新「复制自动更新脚本」并粘回 Clash Verge,它们才会真正监听`
        : `订阅无新增节点${report.removed ? `;${report.removed} 个节点已从订阅消失(端口保留不复用)` : ''}`);
    } catch (error) {
      setNote(error instanceof Error ? `检查失败:${error.message}` : '检查失败');
    } finally {
      setChecking(false);
    }
  }

  async function toggleAutoSync() {
    const next = !autoSync;
    setAutoSync(next);
    const current = await local.get<{ url?: string; autoSync?: boolean } | null>(KEYS.subscriptionSource, null);
    if (current) await local.set(KEYS.subscriptionSource, { ...current, autoSync: next }).catch(() => {});
  }

  async function importPool() {
    if (!plan.poolEntries.length || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const result = await onImport(plan.poolEntries.map((entry) => ({
        ...entry,
        sourceLabel: 'Clash Verge',
      })));
      const parts = [`已按方案入池 ${plan.poolEntries.length} 个出口`];
      if (result.added) parts.push(`新增 ${result.added}`);
      if (result.upgraded) parts.push(`补上真实出口 ${result.upgraded}`);
      if (result.skipped) parts.push(`已存在 ${result.skipped}`);
      setNote(`${parts.join(' · ')}。改完 Clash 配置并重载后，用列表里的测试按钮确认连通性。`);
    } catch (error) {
      setNote(error instanceof Error ? `入池失败：${error.message}` : '入池失败');
    } finally {
      setBusy(false);
    }
  }

  if (!names.length) {
    return (
      <section className="rounded-xl border border-dashed border-ink-200 px-4 py-6 text-center dark:border-ink-700">
        <Server className="mx-auto size-5 text-ink-800/25 dark:text-ink-100/20" />
        <p className="mt-2 text-[11px] leading-relaxed text-ink-800/55 dark:text-ink-100/45">
          先用上面的「读取控制器节点目录」或「从订阅导入」取到节点名，
          这里就能替你把每个节点的本地监听端口写出来。
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-3 rounded-xl border border-brand-200 bg-brand-50/60 p-3 dark:border-brand-900/70 dark:bg-brand-950/20">
      <div className="flex items-start gap-2">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-500 text-white">
          <Wand2 className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h4 className="text-xs font-semibold text-ink-900 dark:text-ink-50">生成 listeners 配置（第 1 / 3 步）</h4>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-800/60 dark:text-ink-100/50">
            vmess / vless / trojan / hysteria2 这些协议浏览器不能直连，但让 Clash 为每个节点
            各开一个本地端口，浏览器就能用了。下面 {names.length} 个节点都还没有自己的端口。
          </p>
        </div>
      </div>

      <NodePicker
        names={names}
        selected={selected}
        onChange={setSelected}
        noteOf={(name) => {
          const port = portOf.get(name);
          return port ? `:${port}` : '';
        }}
      />

      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1">
          <span className="block text-[10px] text-ink-800/55 dark:text-ink-100/45">起始端口</span>
          <input
            value={startPort}
            onChange={(event) => setStartPort(event.target.value.replace(/\D/g, ''))}
            inputMode="numeric"
            aria-label="listener 起始端口"
            className="h-8 w-24 rounded-md border border-black/8 bg-white px-2 text-[11px] tabular-nums text-ink-900 outline-none focus:border-brand-500/50 dark:border-white/10 dark:bg-ink-900 dark:text-ink-50"
          />
        </label>
        <p className="min-w-0 flex-1 text-[10px] leading-relaxed text-ink-800/50 dark:text-ink-100/40">
          依次递增，避开内核自己占用的 7890 / 7891 / 7897。
          {plan.dropped > 0 && <span className="text-amber-600 dark:text-amber-400">　有 {plan.dropped} 个节点因端口越界未分配</span>}
        </p>
      </div>

      <AnimatePresence initial={false}>
        {plan.yaml && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 text-[10px] font-medium text-ink-800/60 dark:text-ink-100/50">
                  {plan.entries.length} 个 listener · 端口 {plan.entries[0]!.port}–{plan.entries[plan.entries.length - 1]!.port}
                </span>
                <button
                  type="button"
                  onClick={() => void copyYaml()}
                  className="flex items-center gap-1 rounded-md bg-white px-2 py-1 text-[10px] font-medium text-brand-600 ring-1 ring-black/5 hover:bg-brand-50 dark:bg-ink-900 dark:text-brand-400 dark:ring-white/10"
                >
                  {copied ? <Check className="size-3" /> : <ClipboardCopy className="size-3" />}
                  {copied ? '已复制' : '复制配置'}
                </button>
                <button
                  type="button"
                  onClick={() => void copyScript()}
                  title="粘进 Clash Verge「扩展配置 → Script」：订阅更新后端口映射自动重建，无需再粘"
                  className="flex items-center gap-1 rounded-md bg-white px-2 py-1 text-[10px] font-semibold text-white bg-brand-500 hover:bg-brand-600"
                >
                  {copiedScript ? <Check className="size-3" /> : <ClipboardCopy className="size-3" />}
                  {copiedScript ? '脚本已复制' : '复制自动更新脚本'}
                </button>
              </div>
              <pre className="max-h-40 overflow-auto rounded-lg bg-white px-2.5 py-2 font-mono text-[10px] leading-relaxed text-ink-900 ring-1 ring-black/5 dark:bg-ink-950 dark:text-ink-50 dark:ring-white/10">{plan.yaml}</pre>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/*
       * 粘贴位置必须写死在这里。这半步用户最容易做错，而做错的表现是
       * 「配置粘了、重载了、点了测试 —— 全部超时」，但完全看不出是粘贴位置的问题：
       *  - 粘进订阅本身 → 下次自动更新整段被覆盖，端口全断；
       *  - 粘进 Clash Verge 的「扩展配置(Merge)」→ 每次生成配置时合并，订阅更新不影响。
       * 顺带说明重载这一步：不重载内核不会新开端口。
       */}
      {/* 自动更新状态区:没有订阅源时只提示去导入页,不显示无效开关 */}
      <div className="space-y-2 rounded-lg bg-white/70 px-3 py-2 ring-1 ring-black/5 dark:bg-ink-950/50 dark:ring-white/10">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-semibold text-ink-900 dark:text-ink-50">订阅自动更新</span>
          {hasSource ? (
            <>
              <button
                type="button"
                role="switch"
                aria-checked={autoSync}
                onClick={() => void toggleAutoSync()}
                className={cn(
                  'rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 transition-colors',
                  autoSync
                    ? 'bg-emerald-500/12 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300'
                    : 'bg-ink-100 text-ink-800/50 ring-black/5 dark:bg-ink-900 dark:text-ink-100/40 dark:ring-white/10',
                )}
              >
                {autoSync ? '已开启 · 每 6 小时检查' : '已关闭'}
              </button>
              <button
                type="button"
                disabled={checking}
                onClick={() => void checkNow()}
                className="flex items-center gap-1 rounded-md bg-brand-500 px-2 py-1 text-[10px] font-semibold text-white hover:bg-brand-600 disabled:opacity-40"
              >
                {checking ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
                {checking ? '检查中...' : '立即检查'}
              </button>
            </>
          ) : (
            <span className="text-[10px] text-ink-800/50 dark:text-ink-100/40">先在导入页粘一次订阅地址，即可自动跟随更新</span>
          )}
        </div>
        {drift && (
          <p className={cn(
            'text-[10px] leading-relaxed',
            drift.needsResync ? 'text-amber-700 dark:text-amber-300' : 'text-ink-800/55 dark:text-ink-100/45',
          )}>
            {drift.needsResync
              ? `新增 ${drift.added} 个节点 · 需重新复制并粘贴 Script（已自动补进代理池）`
              : `无新增节点${drift.removed ? ` · ${drift.removed} 个节点已消失（端口保留，不复用）` : ''}`}
          </p>
        )}
      </div>
      {/*
       * 自动模式(推荐)与兼容模式(静态 YAML)并存:
       *  - Script 粘一次,Verge 每次订阅更新/重载时自动重建 listeners;
       *  - 静态 YAML 每次订阅更新都要重粘,只作为来不及换 Script 时的兜底。
       * 对 Verge 的写入仍然只有「用户本人粘贴」这一个动作,扩展绝不代写。
       */}
      <p className="text-[10px] leading-relaxed text-brand-700 dark:text-brand-300">
        推荐:<b>复制自动更新脚本</b> → 粘到 Clash Verge 飞鸟云订阅的「右键 → 编辑扩展配置 → Script」并保存。
        之后订阅每次更新,Verge 会按这份映射自动重建所有端口,端口由本扩展锁定永不漂移。
        想完全回滚:清空那个 Script 文件并重载即可,不留任何痕迹。
      </p>

      <ol className="space-y-1 rounded-lg bg-white/70 px-3 py-2 text-[10px] leading-relaxed text-ink-800/70 ring-1 ring-black/5 dark:bg-ink-950/50 dark:text-ink-100/60 dark:ring-white/10">
        <li><span className="font-semibold">兼容模式</span>　复制上面的配置，粘进 Clash Verge 的「扩展配置(Merge)」并保存<span className="opacity-70">（不要粘进订阅本身：订阅一更新就被覆盖）</span></li>
        <li><span className="font-semibold">3 / 3</span>　在 Clash Verge 里重载 / 重启一次内核，让新端口生效</li>
        <li className="pt-0.5 opacity-70">端口已生效后再点下面的按钮入池；之后到「全部节点」逐个测试连通性。</li>
      </ol>

      <button
        type="button"
        disabled={!plan.poolEntries.length || busy}
        onClick={() => void importPool()}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand-500 px-3 py-2 text-[11px] font-semibold text-white transition-colors hover:bg-brand-600 disabled:opacity-40"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Server className="size-3.5" />}
        {busy ? '入池中...' : `重载完成后，把这 ${plan.poolEntries.length} 个出口加入代理池`}
      </button>

      {note && <p className="text-[10px] leading-relaxed text-ink-800/60 dark:text-ink-100/50">{note}</p>}
    </section>
  );
}
