/**
 * 外壳预览入口：渲染真实的 PageShell + AccountsView / NetworkView / RecordsView。
 *
 * 目的只有一个 —— 在不加载扩展运行时的浏览器标签页里核对重构后的外壳，
 * 免得每次都开 Chrome 加载扩展。store 的数据在无扩展环境拿不到，
 * 这里用演示数据代替（和 preview 页同一份）；组件本身与正式页完全相同。
 */
import { createRoot } from 'react-dom/client';
import { PageShell, type ShellStatus } from '@/components/shell/PageShell';
import { AccountsView, NetworkView, RecordsView } from '@/components/shell/views';
import { useMemo, useState } from 'react';
import type { Account, AccountBalance, DailyStatus, LastResult, ProxyConfig, SiteConfig } from '@/types';
import '@/assets/tailwind.css';

// 与 preview 页同型的演示数据，字段结构与真实 store 一致。
type DemoSite = SiteConfig & { accounts: Account[] };
const sites: SiteConfig[] = [];
const accounts: Account[] = [];
const balances = new Map<string, AccountBalance>();
const results = new Map<string, LastResult>();

const statusOf = (_id: string): DailyStatus => 'pending';
const resultOf = (id: string) => results.get(id);
const makeBalance = (quota: number): AccountBalance => ({ quota, usedQuota: 0, at: Date.now(), symbol: '$' });
balances.set('demo-1', makeBalance(16_092_350));
balances.set('demo-2', makeBalance(2_660_500));
const balanceOf = (id: string) => balances.get(id);

const status: ShellStatus = { version: '0.2.2-preview', running: 1, attention: 1, total: 9, done: 6 };

function Demo() {
  const [view, setView] = useState<'accounts' | 'network' | 'records' | 'overview'>('accounts');
  const [search, setSearch] = useState('');
  const [proxies, setProxies] = useState<ProxyConfig[]>([]);
  const [networkAccounts, setNetworkAccounts] = useState(accounts);

  return (
    <PageShell view={view} onViewChange={(next) => setView(next as typeof view)} search={search} onSearchChange={setSearch} status={status}>
      {view === 'accounts' && (
        <AccountsView sites={sites} accounts={accounts} statusOf={statusOf} balanceOf={balanceOf} onRunAccount={() => {}} onRefreshBalance={() => {}} onToast={() => {}} />
      )}
      {view === 'network' && <NetworkView
        proxies={proxies} accounts={networkAccounts} sites={sites}
        onAddMany={async (inputs) => {
          setProxies((current) => current.concat(inputs.map((input) => ({ ...input, id: crypto.randomUUID() }))));
          return { added: inputs.length, skipped: 0, upgraded: 0 };
        }}
        onSyncClash={async (inputs) => {
          setProxies(inputs.map((input) => ({ ...input, id: crypto.randomUUID() })));
          return { added: inputs.length, skipped: 0, upgraded: 0, removed: 0, keptInUse: 0 };
        }}
        onRemove={async (id) => setProxies((current) => current.filter((proxy) => proxy.id !== id))}
        onAssign={async (assignments) => {
          const byId = new Map(assignments.map((item) => [item.accountId, item]));
          setNetworkAccounts((current) => current.map((account) => {
            const assignment = byId.get(account.id);
            return assignment ? { ...account, proxyMode: 'pool', proxyId: assignment.proxyId, proxyPinned: assignment.pinned } : account;
          }));
          return assignments.length;
        }}
        onSetAccountProxy={async (id, patch) => setNetworkAccounts((current) => current.map((account) => account.id === id ? { ...account, ...patch } : account))}
      />}
      {view === 'records' && <RecordsView sites={sites} accounts={accounts} resultOf={resultOf} statusOf={statusOf} />}
      {view === 'overview' && <div className="text-sm text-ink-800/60">总览演示位（真实数据在扩展页）</div>}
    </PageShell>
  );
}

const host = globalThis as typeof globalThis & { __shellPreviewRoot?: ReturnType<typeof import('react-dom/client')['createRoot']> };
const root = host.__shellPreviewRoot ?? createRoot(document.getElementById('root')!);
host.__shellPreviewRoot = root;
root.render(<Demo />);
