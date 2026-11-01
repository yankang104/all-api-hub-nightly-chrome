import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { Globe2, Loader2, Pin, RotateCcw, Shuffle } from 'lucide-react';
import type { Account, ProxyConfig, SiteConfig } from '@/types';
import { cn } from '@/lib/core/cn';
import { assignProxies, type ProxyAssignment } from '@/lib/proxy/proxy-assign';
import { effectiveProxyScheme, isNameOnlyProxy } from '@/lib/proxy/proxy-config';

interface Props {
  proxies: readonly ProxyConfig[];
  accounts: readonly Account[];
  sites: readonly SiteConfig[];
  onAssign: (assignments: ProxyAssignment[]) => Promise<number>;
}

/**
 * 账号 ↔ 节点对照表。
 *
 * 规则（按用户要求）：手动改过的那一行不再被自动分配覆盖；没手动过的行
 * 由自动分配轮转填满。手动与自动的区分靠 Account.proxyPinned，不靠「有没有
 * 绑定」—— 否则上一轮自动填的绑定会被误当成用户的选择，池子扩容后新节点
 * 永远摊不下去。
 */
export function AssignTable({ proxies, accounts, sites, onAssign }: Props) {
  /** 本地未保存的改动：accountId → proxyId */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);

  const siteName = useMemo(
    () => new Map(sites.map((site) => [site.id, site.name])),
    [sites],
  );

  // 只有真实 host:port 才能作为浏览器出口；订阅里的名称条目只保留展示用途。
  const usableProxies = useMemo(() => proxies.filter((proxy) => !isNameOnlyProxy(proxy)), [proxies]);
  const usableProxyIds = useMemo(() => new Set(usableProxies.map((proxy) => proxy.id)), [usableProxies]);

  /** 自动方案只覆盖没手动指定过的账号 */
  const autoPlan = useMemo(() => {
    // 旧版本可能把 nameOnly id 留在账号上；它不应阻止新的真实出口自动填入。
    const normalizedAccounts = accounts.map((account) => {
      const stalePoolBinding = account.proxyMode === 'pool'
        && account.proxyId
        && !usableProxyIds.has(account.proxyId);
      return stalePoolBinding
        ? { ...account, proxyMode: 'inherit' as const, proxyId: undefined, proxyPinned: undefined }
        : account;
    });
    const plan = assignProxies(normalizedAccounts, usableProxies.map((proxy) => proxy.id), 'unassigned');
    return new Map(plan.assignments.map((item) => [item.accountId, item.proxyId]));
  }, [accounts, usableProxies, usableProxyIds]);

  const rows = accounts.map((account) => {
    const draft = drafts[account.id];
    const saved = account.proxyMode === 'pool' && account.proxyId && usableProxyIds.has(account.proxyId)
      ? account.proxyId
      : undefined;
    const auto = autoPlan.get(account.id);
    // 显示优先级：本地草稿 > 已保存的绑定 > 自动方案
    const effective = draft ?? saved ?? auto;
    return {
      account,
      proxyId: effective,
      // 已保存的手动固定，或本轮刚改的
      pinned: (account.proxyPinned === true && saved !== undefined) || draft !== undefined,
      source: draft !== undefined ? 'draft' : saved ? 'saved' : auto ? 'auto' : 'none',
    } as const;
  });

  /*
   * 按站点分段。
   *
   * 同一个邮箱常在多个站点各有一个账号，光看账号名会出现三行一样的
   * `330627052@qq.com`，分不清哪行是哪个站点的，改错了也发现不了。
   * 分段保持账号原顺序，段内顺序也不动 —— 轮转分配是按账号顺序算的，
   * 这里重排只影响显示，不能影响对应关系。
   */
  const sections: { siteId: string; label: string; rows: typeof rows }[] = [];
  for (const row of rows) {
    const siteId = row.account.siteId;
    const last = sections.at(-1);
    if (last?.siteId === siteId) last.rows.push(row);
    else sections.push({ siteId, label: siteName.get(siteId) ?? '未知站点', rows: [row] });
  }

  const dirty = Object.keys(drafts).length > 0;
  const pendingAuto = rows.filter((row) => row.source === 'auto').length;

  function pick(accountId: string, proxyId: string) {
    setSummary(null);
    setDrafts((current) => {
      const next = { ...current };
      if (proxyId) next[accountId] = proxyId;
      else delete next[accountId];
      return next;
    });
  }

  /** 保存：手动改过的标 pinned，自动填的不标 */
  async function save() {
    if (busy) return;
    const assignments = rows
      .filter((row) => row.proxyId)
      .map((row) => ({
        accountId: row.account.id,
        proxyId: row.proxyId!,
        ...(row.pinned ? { pinned: true } : {}),
      }));
    if (!assignments.length) {
      setSummary('还没有可保存的绑定');
      return;
    }

    setBusy(true);
    const assigned = await onAssign(assignments);
    const manual = assignments.filter((item) => item.pinned).length;
    setDrafts({});
    setSummary(`已保存 ${assigned} 个账号的绑定${manual ? `，其中 ${manual} 个为手动指定，不会被自动分配覆盖` : ''}`);
    setBusy(false);
  }

  if (!accounts.length) {
    return <p className="text-[11px] text-ink-800/45 dark:text-ink-100/35">还没有账号，先添加账号再分配节点。</p>;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between rounded-md bg-white px-2 py-1.5 text-[10px] ring-1 ring-black/5 dark:bg-ink-900 dark:ring-white/10">
        <span className="text-ink-800/60 dark:text-ink-100/50">
          {accounts.length} 个账号 · 已配置出口 {usableProxies.length} 个
          {pendingAuto > 0 && ` · ${pendingAuto} 个待自动填入`}
        </span>
        {dirty && (
          <button type="button" onClick={() => { setDrafts({}); setSummary(null); }} className="flex items-center gap-1 font-medium text-ink-800/55 hover:underline dark:text-ink-100/45">
            <RotateCcw className="size-3" />撤销改动
          </button>
        )}
      </div>
      <div className="max-h-72 overflow-y-auto rounded-lg ring-1 ring-black/5 dark:ring-white/10">
        {sections.map((section, sectionIndex) => (
          <div key={`${section.siteId}-${sectionIndex}`}>
            <div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-black/5 bg-ink-50 px-2 py-1 dark:border-white/5 dark:bg-ink-900">
              <Globe2 className="size-3 shrink-0 text-ink-800/45 dark:text-ink-100/35" />
              <span className="min-w-0 flex-1 truncate text-[10px] font-semibold text-ink-800/70 dark:text-ink-100/60" title={section.label}>
                {section.label}
              </span>
              <span className="shrink-0 text-[10px] tabular-nums text-ink-800/40 dark:text-ink-100/30">{section.rows.length}</span>
            </div>

            <div className="divide-y divide-black/5 dark:divide-white/5">
              {section.rows.map((row) => (
                <div key={row.account.id} className="flex items-center gap-2 bg-white px-2 py-1.5 dark:bg-ink-950">
                  <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-ink-900 dark:text-ink-50" title={`${section.label} · ${row.account.username}`}>
                    {row.account.label || row.account.username}
                  </span>

                  {row.pinned && (
                    <span title="手动指定，自动分配不会覆盖" className="shrink-0 text-brand-600 dark:text-brand-400">
                      <Pin className="size-3" />
                    </span>
                  )}
                  {row.source === 'auto' && (
                    <span className="shrink-0 rounded bg-ink-100 px-1 py-0.5 text-[9px] text-ink-800/55 dark:bg-white/10 dark:text-ink-100/45">自动</span>
                  )}

                  <select
                    value={row.proxyId ?? ''}
                    onChange={(event) => pick(row.account.id, event.target.value)}
                    aria-label={`为 ${section.label} 的 ${row.account.label || row.account.username} 选择节点`}
                    className="h-6 w-40 shrink-0 rounded-md border border-black/8 bg-white px-1 text-[11px] text-ink-900 outline-none focus:border-brand-500/50 dark:border-white/10 dark:bg-ink-900 dark:text-ink-50"
                  >
                    <option value="">不绑定</option>
                    {usableProxies.map((proxy) => (
                      <option key={proxy.id} value={proxy.id}>
                        {proxy.name} · {effectiveProxyScheme(proxy)}://{proxy.host}:{proxy.port}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <motion.button
        whileTap={{ scale: 0.98 }}
        type="button"
        disabled={busy || !usableProxies.length}
        onClick={save}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand-500 px-3 py-2 text-[11px] font-semibold text-white shadow-sm transition-colors hover:bg-brand-600 disabled:opacity-40"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Shuffle className="size-3.5" />}
        {busy ? '保存中...' : dirty ? '保存手动分配' : '按上表保存分配'}
      </motion.button>

      {summary && <p className="text-[10px] text-ink-800/60 dark:text-ink-100/50">{summary}</p>}

      <p className={cn('rounded-lg bg-ink-50 px-2.5 py-2 text-[10px] leading-relaxed text-ink-800/55 dark:bg-white/5 dark:text-ink-100/45')}>
        手动改过的行会标上图钉，之后点自动分配不会覆盖它；没手动过的行由自动分配按顺序轮转填入。
      </p>
    </div>
  );
}
