/**
 * 管理页子视图：账号总览、代理与网络、执行记录。
 *
 * 数据全部来自 app store 的真实状态（statusOf / balanceOf / resultOf），
 * 不引入演示数据。站点总览沿用原 SiteCard 网格，不在这里重复实现。
 */
import {
  Activity, AlertTriangle, Check, CheckCircle2, Coins, Globe2, Play, RefreshCw,
  Search, ShieldAlert, Users,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Account, AccountBalance, DailyStatus, LastResult, SiteConfig } from '@/types';
import { formatQuota, sumBalances } from '@/lib/balance/balance-format';
import { resolveSiteAdapter } from '@/automation/sites/site-adapters';
import { cn } from '@/lib/core/cn';

type StatusOf = (accountId: string) => DailyStatus;
type ResultOf = (accountId: string) => LastResult | undefined;
type BalanceOf = (accountId: string) => AccountBalance | undefined;

const STATUS_LABEL: Record<DailyStatus, string> = {
  done: '已完成', pending: '待签到', running: '执行中', attention: '需处理', failed: '失败',
};

const STATUS_TONE: Record<DailyStatus, string> = {
  done: 'bg-mint-50 text-mint-700 dark:bg-mint-600/15 dark:text-mint-300',
  pending: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  running: 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
  attention: 'bg-cyan-50 text-cyan-700 dark:bg-cyan-950/40 dark:text-cyan-300',
  failed: 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',
};

function StatCard({ label, value, detail, tone, icon: Icon }: { label: string; value: string | number; detail: string; tone: 'blue' | 'mint' | 'amber' | 'coral'; icon: typeof Check }) {
  const tones: Record<string, string> = {
    blue: 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
    mint: 'bg-mint-50 text-mint-700 dark:bg-mint-600/15 dark:text-mint-300',
    amber: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
    coral: 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',
  };
  return (
    <article className="relative flex min-h-24 items-start gap-3 overflow-hidden rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition-shadow hover:shadow-md dark:border-slate-800 dark:bg-slate-950">
      <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg", tones[tone])}><Icon className="size-4" /></span>
      <div className="min-w-0">
        <span className="block text-[10px] text-ink-800/55 dark:text-ink-100/50">{label}</span>
        <strong className="mt-0.5 block text-xl font-semibold leading-none tracking-tight text-ink-900 tabular-nums dark:text-ink-50">{value}</strong>
        <small className="mt-1 block text-[10px] text-ink-800/50 dark:text-ink-100/45">{detail}</small>
      </div>
    </article>
  );
}

/* --------------------------------------------------------------- 账号总览 */

export function AccountsView({ sites, accounts, statusOf, balanceOf, refreshingBalanceIds, onRunAccount, onRefreshBalance, onToast }: {
  sites: SiteConfig[];
  accounts: Account[];
  statusOf: StatusOf;
  balanceOf: BalanceOf;
  refreshingBalanceIds?: ReadonlySet<string>;
  onRunAccount: (accountId: string) => void;
  onRefreshBalance: (accountId: string) => void;
  onToast: (message: string) => void;
}) {
  const [keyword, setKeyword] = useState('');
  const [only, setOnly] = useState<'全部' | '未获取余额' | '需处理' | '已完成'>('全部');

  const siteNameOf = useMemo(() => new Map(sites.map((site) => [site.id, site.name])), [sites]);
  const siteOf = useMemo(() => new Map(sites.map((site) => [site.id, site])), [sites]);

  const rows = accounts.filter((account) => {
    const site = siteOf.get(account.siteId);
    const text = `${account.username} ${account.label ?? ''} ${site?.name ?? ''}`.toLowerCase();
    if (keyword.trim() && !text.includes(keyword.trim().toLowerCase())) return false;
    if (only === '未获取余额') return balanceOf(account.id) == null;
    if (only === '需处理') return statusOf(account.id) === 'attention';
    if (only === '已完成') return statusOf(account.id) === 'done';
    return true;
  });

  const missing = accounts.filter((account) => balanceOf(account.id) == null).length;
  const attention = accounts.filter((account) => statusOf(account.id) === 'attention').length;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight">账号总览</h1>
        <p className="mt-1 text-[11px] text-ink-800/55 dark:text-ink-100/50">所有站点的账号放进一张表，按余额是否取到、是否需要人工处理来筛。</p>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="账号统计">
        <StatCard label='账号总数' value={accounts.length} detail={`${sites.length} 个站点`} tone='blue' icon={Users} />
        <StatCard label='余额未获取' value={missing} detail={missing ? '点行尾刷新重试' : '全部已获取'} tone='amber' icon={Coins} />
        <StatCard label='需处理' value={attention} detail='等待人工验证' tone='coral' icon={ShieldAlert} />
        <StatCard label='已完成' value={accounts.filter((account) => statusOf(account.id) === 'done').length} detail='今日已签到' tone='mint' icon={CheckCircle2} />
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg bg-slate-100 p-1 dark:bg-slate-900" role="tablist" aria-label="账号筛选">
          {(['全部', '未获取余额', '需处理', '已完成'] as const).map((item) => (
            <button
              key={item}
              type="button"
              aria-selected={only === item}
              onClick={() => setOnly(item)}
              className={cn(
                'h-7 rounded-md px-2.5 text-[11px] font-medium transition-colors',
                only === item ? 'bg-white text-blue-700 shadow-sm dark:bg-slate-800 dark:text-blue-300' : 'text-ink-800/55 hover:text-ink-900 dark:text-ink-100/50',
              )}
            >
              {item}
            </button>
          ))}
        </div>
        <label className="relative min-w-52 flex-1 sm:max-w-xs">
          <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-800/35 dark:text-ink-100/35" />
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            aria-label="搜索账号"
            placeholder="搜索账号、标签或站点"
            className="h-9 w-full rounded-lg border border-black/8 bg-white pl-8 pr-3 text-[11px] outline-none focus:border-brand-500/50 focus:ring-2 focus:ring-brand-500/15 dark:border-white/10 dark:bg-slate-900"
          />
        </label>
      </div>

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950" aria-label="账号列表">
        {rows.map((account) => {
          const status = statusOf(account.id);
          const balance = balanceOf(account.id);
          const site = siteOf.get(account.siteId);
          const adapter = site ? resolveSiteAdapter(site) : undefined;
          const refreshing = refreshingBalanceIds?.has(account.id) ?? false;
          return (
            <div key={account.id} className="grid grid-cols-2 items-center gap-3 border-b border-slate-100 px-4 py-3 last:border-b-0 md:grid-cols-[minmax(140px,1.4fr)_minmax(120px,1fr)_88px_130px_96px] dark:border-slate-800/70">
              <span className="min-w-0 truncate text-xs font-semibold text-ink-900 dark:text-ink-50">
                {account.label || account.username}
                {account.label && <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium text-ink-800/55 dark:bg-slate-800 dark:text-ink-100/50">{account.username}</span>}
              </span>
              <span className="min-w-0 truncate text-[11px] text-ink-800/60 dark:text-ink-100/55">{siteNameOf.get(account.siteId) ?? '未知站点'}</span>
              <span className={cn("inline-flex h-fit w-fit items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold", STATUS_TONE[status])}>{STATUS_LABEL[status]}</span>
              <span className="text-[11px] font-semibold tabular-nums text-amber-700 dark:text-amber-300">
                {balance
                  ? formatQuota(balance.quota, { quotaPerUnit: site?.adapter?.quotaPerUnit, family: adapter?.family }, balance.symbol)
                  : <span className="font-medium text-ink-800/45 dark:text-ink-100/40">未获取</span>}
              </span>
              <span className="flex items-center justify-end gap-1.5">
                <button
                  type="button"
                  aria-label={`执行 ${account.username}`}
                  title="执行"
                  onClick={() => onRunAccount(account.id)}
                  className="grid size-7 place-items-center rounded-md text-ink-800/50 ring-1 ring-black/5 transition-colors hover:bg-blue-50 hover:text-blue-600 dark:text-ink-100/50 dark:ring-white/10"
                >
                  <Play className="size-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={`刷新 ${account.username} 的余额`}
                  title="刷新余额"
                  disabled={refreshing}
                  onClick={() => onRefreshBalance(account.id)}
                  className="grid size-7 place-items-center rounded-md text-ink-800/50 ring-1 ring-black/5 transition-colors hover:bg-blue-50 hover:text-blue-600 disabled:opacity-45 dark:text-ink-100/50 dark:ring-white/10"
                >
                  <RefreshCw className={cn("size-3.5", refreshing && 'animate-spin')} />
                </button>
              </span>
            </div>
          );
        })}
        {!rows.length && (
          <div className="flex flex-col items-center gap-2 px-4 py-14 text-center">
            <Users className="size-6 text-ink-800/25 dark:text-ink-100/20" />
            <strong className="text-xs text-ink-800/70 dark:text-ink-100/60">没有匹配的账号</strong>
            <span className="text-[11px] text-ink-800/45 dark:text-ink-100/40">换个关键词或筛选条件</span>
          </div>
        )}
      </section>
      {rows.length === 0 && accounts.length > 0 && (
        <p className="text-[11px] text-ink-800/45 dark:text-ink-100/40">提示：账号添加入口在总览页顶部工具栏的 {String.fromCharCode(39)}添加账号{String.fromCharCode(39)} 按钮。</p>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- 代理与网络 */

export { ProxyNetworkPanel as NetworkView } from '../ProxyNetworkPanel';

/* --------------------------------------------------------------- 执行记录 */

export function RecordsView({ sites, accounts, resultOf, statusOf }: {
  sites: SiteConfig[];
  accounts: Account[];
  resultOf: ResultOf;
  statusOf: StatusOf;
}) {
  const [only, setOnly] = useState<'全部' | '成功' | '失败'>('全部');
  const siteNameOf = useMemo(() => new Map(sites.map((site) => [site.id, site.name])), [sites]);

  const records = useMemo(() => accounts
    .map((account) => ({ account, result: resultOf(account.id), status: statusOf(account.id) }))
    .filter((row) => row.result != null)
    .sort((a, b) => (b.result?.at ?? 0) - (a.result?.at ?? 0)), [accounts, resultOf, statusOf]);

  const visible = records.filter((row) => {
    if (only === '成功') return row.result?.ok === true;
    if (only === '失败') return row.result?.ok === false;
    return true;
  });

  const success = records.filter((row) => row.result?.ok === true).length;
  const failed = records.filter((row) => row.result?.ok === false).length;
  const rate = records.length ? Math.round((success / records.length) * 100) : 0;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight">执行记录</h1>
        <p className="mt-1 text-[11px] text-ink-800/55 dark:text-ink-100/50">每个账号最近一次执行的步骤流水，失败的那一步直接标出原因。</p>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="执行统计">
        <StatCard label='有记录账号' value={records.length} detail={`共 ${accounts.length} 个账号`} tone='blue' icon={Check} />
        <StatCard label='成功率' value={`${rate}%`} detail={`成功 ${success} 条`} tone='mint' icon={CheckCircle2} />
        <StatCard label='失败' value={failed} detail='最近一次未成功' tone='coral' icon={AlertTriangle} />
        <StatCard label='需处理' value={accounts.filter((account) => statusOf(account.id) === 'attention').length} detail='等待人工验证' tone='amber' icon={ShieldAlert} />
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg bg-slate-100 p-1 dark:bg-slate-900" role="tablist" aria-label="执行结果筛选">
          {(['全部', '成功', '失败'] as const).map((item) => (
            <button
              key={item}
              type="button"
              aria-selected={only === item}
              onClick={() => setOnly(item)}
              className={cn("h-7 rounded-md px-3 text-[11px] font-medium transition-colors", only === item ? "bg-white text-blue-700 shadow-sm dark:bg-slate-800 dark:text-blue-300" : "text-ink-800/55 hover:text-ink-900 dark:text-ink-100/50")}
            >
              {item}
            </button>
          ))}
        </div>
      </div>

      <section className="space-y-2" aria-label="执行流水">
        {visible.map(({ account, result, status }) => {
          const ok = result?.ok === true;
          const steps = result?.steps ?? [];
          return (
            <article key={account.id} className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950">
              <header className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span className={cn("grid size-7 shrink-0 place-items-center rounded-lg", ok ? 'bg-mint-50 text-mint-700 dark:bg-mint-600/15 dark:text-mint-300' : 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300')}>
                  {ok ? <Check className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
                </span>
                <span className="min-w-0 flex-1">
                  <strong className="block truncate text-xs font-semibold text-ink-900 dark:text-ink-50">
                    {account.label || account.username}
                    <em className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium not-italic text-ink-800/55 dark:bg-slate-800 dark:text-ink-100/50">{siteNameOf.get(account.siteId) ?? '未知站点'}</em>
                  </strong>
                  <span className="mt-0.5 block truncate text-[11px] text-ink-800/55 dark:text-ink-100/50">{result?.message || '无附加说明'}</span>
                </span>
                <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold", STATUS_TONE[status])}>{STATUS_LABEL[status]}</span>
              </header>
              {steps.length > 0 && (
                <ol className="divide-y divide-slate-100 border-t border-slate-100 dark:divide-slate-800/70 dark:border-slate-800/70">
                  {steps.map((step, index) => {
                    /* result.steps 是已完成动作的纯文本列表；失败原因在 message 里。
                       最后一步在失败时标红，成功时打勾。 */
                    const last = index === steps.length - 1;
                    const bad = last && result?.ok === false;
                    return (
                      <li key={`${account.id}-${index}`} className="flex items-start gap-2.5 px-4 py-2">
                        <span className={cn("mt-0.5 grid size-4 shrink-0 place-items-center rounded-full", bad ? 'bg-rose-50 text-rose-600 dark:bg-rose-950/40' : 'bg-mint-50 text-mint-700 dark:bg-mint-600/15')}>
                          {bad ? <AlertTriangle className="size-2.5" /> : <Check className="size-2.5" />}
                        </span>
                        <span className="min-w-0 flex-1 text-[11px] text-ink-800/75 dark:text-ink-100/65">{step}</span>
                        {last && <span className={cn("shrink-0 text-[10px]", bad ? 'text-rose-600 dark:text-rose-400' : 'text-mint-700 dark:text-mint-300')}>{bad ? '中断' : '完成'}</span>}
                      </li>
                    );
                  })}
                </ol>
              )}
              {result?.manual && (
                <p className="border-t border-amber-100 bg-amber-50/60 px-4 py-2 text-[10px] text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-300">
                  用户手动标记的结果：这条没有扩展的守恒差分证据，仅作记录。
                </p>
              )}
            </article>
          );
        })}
        {!visible.length && (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-slate-300 px-4 py-14 text-center dark:border-slate-700">
            <Activity className="size-6 text-ink-800/25 dark:text-ink-100/20" />
            <strong className="text-xs text-ink-800/70 dark:text-ink-100/60">还没有执行记录</strong>
            <span className="text-[11px] text-ink-800/45 dark:text-ink-100/40">先执行一次签到，这里会留下每一步的结果</span>
          </div>
        )}
      </section>
    </div>
  );
}
