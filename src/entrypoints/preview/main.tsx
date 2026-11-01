/**
 * 新设计预览页 —— 独立入口，不接入扩展运行时。
 *
 * 结构：工作台（侧栏 + 主区）
 *   主区 → 站点工具条 → 站点卡片 → 嵌套层：站点统计 / 站点操作条 / 账号行 / 账号详情 / 学习面板
 *
 * 数据为演示数据；按钮点击会真的改本地状态（执行、标记完成、删除、批量选择、余额刷新），
 * 方便对着正式页逐项核对功能位和交互反馈。
 */
import { createRoot, type Root } from 'react-dom/client';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Ban,
  Bell,
  BookOpen,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Clock3,
  Coins,
  Command,
  Database,
  ExternalLink,
  Gauge,
  Globe2,
  Layers3,
  LayoutDashboard,
  Link2,
  ListChecks,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Square,
  StopCircle,
  Sun,
  Trash2,
  Upload,
  Users,
  Wifi,
  Zap,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import './preview.css';
import { INITIAL_SITES, statusMeta, type Account, type Site, type Status } from './data';
import {
  AccountFormModal,
  BackupPanelModal,
  BookmarkImportModal,
  ConfirmModal,
  ImportAccountsModal,
  INITIAL_PROXIES,
  ProxyPanelModal,
  SchedulePanelModal,
  SiteFormModal,
  SiteMenuModal,
  type AccountDraft,
  type SiteDraft,
} from './modals';
import { AccountsPage, ProxyPage, RecordsPage, SitesPage } from './pages';

// 数据与演示数据抽到 data.ts；NAV_ITEMS 与工具函数在下方保留。
const NAV_ITEMS: ReadonlyArray<readonly [typeof LayoutDashboard, string]> = [
  [LayoutDashboard, '总览'],
  [Globe2, '站点'],
  [Users, '账号'],
  [Wifi, '代理与网络'],
  [ListChecks, '执行记录'],
];

/** 金额统一四位小数：签到奖励和余额都靠这个。 */
function money(value: number): string {
  return `$${value.toFixed(4)}`;
}

/** 站点余额汇总：已取到的相加，没取到的单独计数。 */
function siteBalance(site: Site) {
  const known = site.accounts.filter((account) => account.balance != null);
  const total = known.reduce((sum, account) => sum + (account.balance ?? 0), 0);
  return { total, known: known.length, missing: site.accounts.length - known.length };
}

type ModalState =
  | { kind: 'proxy'; assignAccountId?: string }
  | { kind: 'schedule' }
  | { kind: 'backup' }
  | { kind: 'bookmarks' }
  | { kind: 'import-accounts' }
  | { kind: 'site-form'; mode: 'new' | 'edit'; siteId?: string }
  | { kind: 'account-form'; mode: 'new' | 'edit'; siteId: string; accountId?: string }
  | { kind: 'site-menu'; siteId: string }
  | { kind: 'confirm'; title: string; message: string; detail?: string; confirmLabel: string; danger?: boolean; action: () => void }
  | null;

function App() {
  const [sites, setSites] = useState<Site[]>(INITIAL_SITES);
  const [activeNav, setActiveNav] = useState('总览');
  const [filter, setFilter] = useState<'全部' | '执行中' | '需处理'>('全部');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>('oneapi');
  const [running, setRunning] = useState(true);
  const [toast, setToast] = useState('');
  const [learningAccountId, setLearningAccountId] = useState<string | null>(null);
  const [learningStep, setLearningStep] = useState(0);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [batchMode, setBatchMode] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [sortByName, setSortByName] = useState(false);
  const [expandAll, setExpandAll] = useState(false);
  const [startMode, setStartMode] = useState<'顺序' | '并发'>('顺序');
  const [refreshingIds, setRefreshingIds] = useState<string[]>([]);
  const [nextRun, setNextRun] = useState('明天 08:30');
  const [modal, setModal] = useState<ModalState>(null);

  const allAccounts = sites.flatMap((site) => site.accounts);
  const runningCount = allAccounts.filter((account) => account.status === 'running').length;
  const pendingCount = allAccounts.filter((account) => account.status === 'pending').length;
  const attentionCount = allAccounts.filter((account) => account.status === 'attention').length;
  const doneCount = allAccounts.filter((account) => account.status === 'done').length;
  const actionableCount = pendingCount + attentionCount;
  const completionRate = allAccounts.length ? Math.round((doneCount / allAccounts.length) * 100) : 0;
  const grandTotal = sites.reduce((sum, site) => sum + siteBalance(site).total, 0);
  const missingTotal = sites.reduce((sum, site) => sum + siteBalance(site).missing, 0);

  const filteredSites = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return sites
      .map((site) => ({
        site,
        accounts: site.accounts.filter((account) => {
          // 正在学习的账号不因搜索或筛选消失：否则学习状态还在，面板却看不见了。
          if (account.id === learningAccountId) return true;
          const haystack = `${site.name} ${site.domain} ${account.name} ${account.label ?? ''} ${account.note ?? ''}`.toLowerCase();
          const matchesQuery = !normalized || haystack.includes(normalized);
          const matchesFilter = filter === '全部'
            || (filter === '执行中' && account.status === 'running')
            || (filter === '需处理' && account.status === 'attention');
          return matchesQuery && matchesFilter;
        }),
      }))
      .filter((entry) => {
        if (entry.accounts.length > 0) return true;
        // 刚建好还没加账号的站点必须留下：否则站点一创建就从列表里消失，
        // 「添加账号」的入口跟着没了，等于站点建了也进不去。
        return !normalized && filter === '全部' && entry.site.accounts.length === 0;
      });
  }, [sites, filter, query, learningAccountId]);

  const visibleEntries = useMemo(() => {
    if (!sortByName) return filteredSites;
    return [...filteredSites].sort((a, b) => a.site.name.localeCompare(b.site.name, 'zh-Hans-CN'));
  }, [filteredSites, sortByName]);

  const visibleAccountCount = visibleEntries.reduce((sum, entry) => sum + entry.accounts.length, 0);
  const runningAccount = allAccounts.find((account) => account.status === 'running');
  const runningSite = runningAccount ? sites.find((site) => site.accounts.some((account) => account.id === runningAccount.id)) : undefined;
  const queuedAccounts = allAccounts.filter((account) => account.status === 'pending').slice(0, 3);

  function showToast(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(''), 2200);
  }
  function updateAccount(accountId: string, patch: Partial<Account>) {
    setSites((current) => current.map((site) => ({
      ...site,
      accounts: site.accounts.map((account) => (account.id === accountId ? { ...account, ...patch } : account)),
    })));
  }

  function runAccount(accountId: string, name: string) {
    updateAccount(accountId, { status: 'running', lastRun: '执行中' });
    showToast(`已开始执行 ${name}`);
  }

  function stopAccount(accountId: string, name: string) {
    updateAccount(accountId, { status: 'pending', lastRun: '已停止' });
    showToast(`已停止 ${name}`);
  }

  function refreshBalances(accountIds: string[], label: string) {
    if (!accountIds.length) return;
    setRefreshingIds((current) => [...new Set([...current, ...accountIds])]);
    window.setTimeout(() => {
      setRefreshingIds((current) => current.filter((id) => !accountIds.includes(id)));
      setSites((current) => current.map((site) => ({
        ...site,
        accounts: site.accounts.map((account) => (accountIds.includes(account.id) ? { ...account, balanceAt: '刚刚' } : account)),
      })));
      showToast(`${label} 余额已刷新`);
    }, 900);
  }

  function runSite(siteId: string) {
    const site = sites.find((item) => item.id === siteId);
    if (!site) return;
    const targets = site.accounts.filter((account) => account.status === 'pending' || account.status === 'attention');
    if (!targets.length) {
      showToast(`${site.name} 没有待执行的账号`);
      return;
    }
    setSites((current) => current.map((item) => (item.id === siteId
      ? { ...item, accounts: item.accounts.map((account) => (account.status === 'pending' || account.status === 'attention' ? { ...account, status: 'running' as Status, lastRun: '执行中' } : account)) }
      : item)));
    showToast(`已开始执行 ${site.name} 的 ${targets.length} 个账号`);
  }

  function stopSite(siteId: string) {
    const site = sites.find((item) => item.id === siteId);
    if (!site) return;
    const targets = site.accounts.filter((account) => account.status === 'running');
    if (!targets.length) {
      showToast(`${site.name} 没有正在执行的账号`);
      return;
    }
    setSites((current) => current.map((item) => (item.id === siteId
      ? { ...item, accounts: item.accounts.map((account) => (account.status === 'running' ? { ...account, status: 'pending' as Status, lastRun: '已停止' } : account)) }
      : item)));
    showToast(`已停止 ${site.name} 的 ${targets.length} 个账号`);
  }

  function startRun() {
    setRunning(true);
    showToast(`已开始执行 ${actionableCount} 个账号（${startMode}）`);
  }

  function pauseRun() {
    setRunning(false);
    showToast(`已暂停当前队列，${runningCount} 个执行中账号转入待续`);
  }

  function toggleLearning(accountId: string, accountName: string) {
    if (learningAccountId === accountId) {
      if (learningStep < 3) {
        showToast('请先完成登录、核对账号和签到，再结束学习');
        return;
      }
      setLearningAccountId(null);
      setLearningStep(0);
      showToast(`已保存 ${accountName} 的学习签到流程，后续执行会按流程回放`);
      return;
    }
    setLearningAccountId(accountId);
    setLearningStep(0);
    showToast('已开始学习：手动登录 → 核对账号 → 完成签到');
  }

  function advanceLearning() {
    if (!learningAccountId) return;
    setLearningStep((step) => Math.min(step + 1, 3));
  }

  function cancelLearning() {
    setLearningAccountId(null);
    setLearningStep(0);
    showToast('已放弃本次学习，没有保存流程');
  }

  function toggleSelected(accountId: string) {
    setSelected((current) => (current.includes(accountId)
      ? current.filter((id) => id !== accountId)
      : [...current, accountId]));
  }

  function deleteSelected() {
    if (!selected.length) return;
    const count = selected.length;
    setSites((current) => current.map((site) => ({
      ...site,
      accounts: site.accounts.filter((account) => !selected.includes(account.id)),
    })));
    setSelected([]);
    showToast(`已删除 ${count} 个账号（预览数据，刷新即恢复）`);
  }

  function saveSite(draft: SiteDraft) {
    if (modal?.kind === 'site-form' && modal.mode === 'edit' && modal.siteId) {
      const siteId = modal.siteId;
      setSites((current) => current.map((site) => (site.id === siteId
        ? { ...site, name: draft.name, domain: draft.domain, kind: draft.kind, flow: draft.flow, proxy: draft.proxy || undefined }
        : site)));
      showToast(`已保存站点 ${draft.name}`);
    } else {
      const accent = ['blue', 'violet', 'mint'][sites.length % 3] ?? 'blue';
      const id = `site-${Date.now()}`;
      setSites((current) => [...current, { id, name: draft.name, domain: draft.domain, kind: draft.kind, accent, flow: draft.flow, proxy: draft.proxy || undefined, accounts: [] }]);
      setExpanded(id);
      showToast(`已创建站点 ${draft.name}，先添加账号再执行`);
    }
    setModal(null);
  }

  function saveAccount(draft: AccountDraft) {
    if (modal?.kind !== 'account-form') return;
    const { siteId, accountId, mode } = modal;
    if (mode === 'edit' && accountId) {
      setSites((current) => current.map((site) => (site.id === siteId
        ? { ...site, accounts: site.accounts.map((account) => (account.id === accountId ? { ...account, name: draft.name, label: draft.label || undefined, proxy: draft.proxy || undefined, note: draft.note || undefined } : account)) }
        : site)));
      showToast(`已保存账号 ${draft.name}`);
    } else {
      const id = `acc-${Date.now()}`;
      setSites((current) => current.map((site) => (site.id === siteId
        ? { ...site, accounts: [...site.accounts, { id, name: draft.name, label: draft.label || undefined, status: 'pending' as Status, lastRun: '未执行', proxy: draft.proxy || undefined, note: draft.note || undefined }] }
        : site)));
      setExpanded(siteId);
      showToast(`已添加账号 ${draft.name}`);
    }
    setModal(null);
  }

  function requestDeleteSite(siteId: string) {
    const site = sites.find((item) => item.id === siteId);
    if (!site) return;
    setModal({
      kind: 'confirm',
      title: '删除站点',
      message: `确定删除 ${site.name}？`,
      detail: `该站点的 ${site.accounts.length} 个账号和已学习的签到流程会一起移除，此操作不可撤销。`,
      confirmLabel: '删除站点',
      danger: true,
      action: () => {
        setSites((current) => current.filter((item) => item.id !== siteId));
        setSelected((current) => current.filter((id) => !site.accounts.some((account) => account.id === id)));
        showToast(`已删除站点 ${site.name}`);
      },
    });
  }

  function requestDeleteAccount(siteId: string, account: Account) {
    setModal({
      kind: 'confirm',
      title: '删除账号',
      message: `确定删除 ${account.name}？`,
      detail: '账号的登录态、余额历史和学习流程会一起移除。',
      confirmLabel: '删除账号',
      danger: true,
      action: () => {
        setSites((current) => current.map((site) => (site.id === siteId ? { ...site, accounts: site.accounts.filter((row) => row.id !== account.id) } : site)));
        showToast(`已删除 ${account.name}`);
      },
    });
  }
  return (
    <div className="preview-app">
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <aside className="preview-sidebar" aria-label="侧边导航">
        <div className="brand-block">
          <div className="brand-mark"><Zap size={18} strokeWidth={2.5} /></div>
          <div>
            <strong>签到管理台</strong>
            <span>Nightly workspace</span>
          </div>
        </div>

        <div className="workspace-switcher">
          <div className="workspace-avatar">N</div>
          <div className="workspace-copy"><strong>默认工作区</strong><span>{allAccounts.length} 个账号 · {sites.length} 个站点</span></div>
          <ChevronDown size={15} />
        </div>

        <div className="nav-label">工作台</div>
        <nav className="main-nav" aria-label="主导航">
          {NAV_ITEMS.map(([Icon, label]) => (
            <button
              key={label}
              className={`nav-item ${activeNav === label ? 'active' : ''}`}
              aria-current={activeNav === label ? 'page' : undefined}
              /* 窄屏只留图标，文字被隐藏后按钮会失去可读名称，所以显式补 aria-label。 */
              aria-label={label}
              title={label}
              onClick={() => setActiveNav(label as string)}
            >
              <Icon size={17} />
              <span>{label}</span>
              {label === '执行记录' && <em>12</em>}
            </button>
          ))}
        </nav>

        <div className="sidebar-spacer" />
        <div className="nav-label">系统</div>
        <button className="nav-item" onClick={() => showToast('设置面板即将打开')}><Settings2 size={17} /><span>设置</span></button>
        <button className="nav-item" onClick={() => showToast('帮助中心即将打开')}><CircleHelp size={17} /><span>帮助与反馈</span></button>
        <div className="sidebar-status"><span className="status-dot" />后台服务正常<span>v0.2.2</span></div>
      </aside>

      <main className="preview-main" id="main-content" tabIndex={-1}>
        <header className="topbar">
          <div className="breadcrumb"><span>工作台</span><span>/</span><strong>{activeNav}</strong></div>
          <div className="topbar-actions">
            <div className="global-search"><Search size={15} /><input aria-label="全局搜索" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索站点、账号或备注" /><kbd><Command size={11} /> K</kbd></div>
            <button className="icon-button" aria-label="通知" onClick={() => showToast('没有新的通知')}><Bell size={17} /><span className="notification-dot" /></button>
            <button className="icon-button" aria-label="切换主题" onClick={() => showToast('主题切换已保留在预览中')}><Sun size={17} /></button>
            <div className="user-avatar">GY</div>
          </div>
        </header>

        <div className="content-wrap">
          {activeNav === '执行记录' && <RecordsPage sites={sites} onToast={showToast} />}
          {activeNav === '账号' && <AccountsPage sites={sites} onToast={showToast} onOpenSite={(siteId) => { setActiveNav('总览'); setExpanded(siteId); setExpandAll(false); }} />}
          {activeNav === '代理与网络' && <ProxyPage onOpenProxyPanel={(accountId) => setModal({ kind: 'proxy', assignAccountId: accountId })} onToast={showToast} />}
          {activeNav === '站点' && <SitesPage sites={sites} onToast={showToast} onOpenSite={(siteId) => { setActiveNav('总览'); setExpanded(siteId); setExpandAll(false); }} />}

          {activeNav === '总览' && <div className="page-body-shell">
          <section className="welcome-row">
            <div>
              <div className="eyebrow"><span className="live-dot" />实时同步中 · 2026 年 10 月 16 日 星期五</div>
              <h1>今天的签到，一眼看清。</h1>
              <p>集中管理站点、账号和执行状态，把需要处理的任务留在视线里。</p>
            </div>
            <div className="welcome-actions">
              <button className="secondary-button" onClick={() => showToast('数据已刷新')}><RefreshCw size={16} />刷新数据</button>
              <button className={`primary-button ${running ? 'running' : ''}`} onClick={running ? pauseRun : startRun}>
                {running ? <StopCircle size={16} /> : <Play size={16} />}{running ? '暂停队列' : '开始执行'}
              </button>
            </div>
          </section>

          <section className="metric-grid" aria-label="今日统计" aria-live="polite">
            <Metric label="待签到" value={pendingCount} detail={`共 ${actionableCount} 个待执行`} tone="amber" icon={Clock3} />
            <Metric label="执行中" value={runningCount} detail="平均耗时 18s" tone="blue" icon={Activity} />
            <Metric label="今日完成" value={doneCount} detail={`完成率 ${completionRate}%`} tone="mint" icon={Check} />
            <Metric label="需处理" value={attentionCount} detail="需要人工验证" tone="coral" icon={ShieldAlert} />
          </section>

          <div className="section-heading">
            <div><h2>站点与账号</h2><span>{visibleEntries.length} / {sites.length} 个站点 · {visibleAccountCount} / {allAccounts.length} 个账号 · 余额合计 {money(grandTotal)}{missingTotal > 0 && `（${missingTotal} 个未获取）`}</span></div>
            <div className="section-tools">
              <div className="segmented-control" role="tablist" aria-label="筛选状态">
                {(['全部', '执行中', '需处理'] as const).map((item) => (
                  <button key={item} className={filter === item ? 'selected' : ''} onClick={() => setFilter(item)}>
                    {item}
                    {item === '执行中' && runningCount > 0 && <b>{runningCount}</b>}
                    {item === '需处理' && attentionCount > 0 && <b>{attentionCount}</b>}
                  </button>
                ))}
              </div>
              <button className="filter-button" onClick={() => showToast('高级筛选：按站点、状态、标签与余额是否获取过筛选')}><SlidersHorizontal size={15} />筛选</button>
            </div>
          </div>

          <div className="site-toolbar">
            <div className="toolbar-group">
              <button className="toolbar-button" onClick={() => setSortByName((value) => !value)}><ArrowUp size={14} />排序：{sortByName ? '名称 ↑' : '手动顺序'}</button>
              <button className="toolbar-button" onClick={() => setStartMode((mode) => (mode === '顺序' ? '并发' : '顺序'))}><Layers3 size={14} />启动模式：{startMode}</button>
              <button className="toolbar-button" onClick={() => { const anyOpen = expandAll || Boolean(expanded); setExpandAll(!anyOpen); setExpanded(null); }}>{expandAll || expanded ? '全部收起' : '全部展开'}</button>
            </div>
            <div className="toolbar-group">
              <button className="toolbar-button" onClick={() => setModal({ kind: 'proxy' })}><Wifi size={14} />代理管理</button>
              <button className="toolbar-button" onClick={() => setModal({ kind: 'backup' })}><Database size={14} />备份迁移</button>
              <button className="toolbar-button" onClick={() => setModal({ kind: 'schedule' })}><CalendarClock size={14} />定时签到</button>
              <button className="toolbar-button" onClick={() => setModal({ kind: 'site-form', mode: 'new' })}><Plus size={14} />添加站点</button>
              <button className="toolbar-button" onClick={() => setModal({ kind: 'bookmarks' })}><Link2 size={14} />从书签导入</button>
              <button className="toolbar-button" onClick={() => setModal({ kind: 'import-accounts' })}><Upload size={14} />导入账号</button>
              <button className={`toolbar-button danger ${batchMode ? 'on' : ''}`} onClick={() => { setBatchMode((value) => !value); setSelected([]); }}><Trash2 size={14} />批量删除</button>
            </div>
          </div>
          <div className="dashboard-grid">
            <section className="site-list">
              {visibleEntries.map(({ site, accounts }) => (
                <SitePanel
                  key={site.id}
                  site={site}
                  accounts={accounts}
                  filtered={accounts.length !== site.accounts.length}
                  expanded={expandAll || expanded === site.id}
                  onToggle={() => {
                    if (expandAll) { setExpandAll(false); setExpanded(null); return; }
                    setExpanded(expanded === site.id ? null : site.id);
                  }}
                  onAction={showToast}
                  onOpenMenu={() => setModal({ kind: 'site-menu', siteId: site.id })}
                  onEditSite={() => setModal({ kind: 'site-form', mode: 'edit', siteId: site.id })}
                  onDeleteSite={() => requestDeleteSite(site.id)}
                  onAddAccount={() => setModal({ kind: 'account-form', mode: 'new', siteId: site.id })}
                  onEditAccount={(account) => setModal({ kind: 'account-form', mode: 'edit', siteId: site.id, accountId: account.id })}
                  onAssignProxy={(account) => setModal({ kind: 'proxy', assignAccountId: account.id })}
                  batchMode={batchMode}
                  selected={selected}
                  onToggleSelected={toggleSelected}
                  learningAccountId={learningAccountId}
                  learningStep={learningStep}
                  onLearningToggle={(accountId, accountName) => { setExpanded(site.id); toggleLearning(accountId, accountName); }}
                  onLearningAdvance={advanceLearning}
                  onLearningCancel={cancelLearning}
                  detailId={detailId}
                  onToggleDetail={(accountId) => setDetailId(detailId === accountId ? null : accountId)}
                  refreshingIds={refreshingIds}
                  onRunAccount={runAccount}
                  onStopAccount={stopAccount}
                  onRefreshBalances={refreshBalances}
                  onMarkDone={(account) => { updateAccount(account.id, { status: 'done', lastRun: '刚刚' }); showToast(`已标记 ${account.name} 为完成`); }}
                  onResetAccount={(account) => { updateAccount(account.id, { status: 'pending', lastRun: '未执行' }); showToast(`已收回 ${account.name} 的完成状态`); }}
                  onDeleteAccount={(account) => requestDeleteAccount(site.id, account)}
                  onRunSite={runSite}
                  onStopSite={stopSite}
                />
              ))}
              {visibleEntries.length === 0 && (
                <div className="empty-result">
                  <Search size={22} />
                  <strong>没有匹配的账号</strong>
                  <span>试试其他关键词或清除筛选条件</span>
                  <button className="empty-reset" onClick={() => { setQuery(''); setFilter('全部'); }}>清除搜索与筛选</button>
                </div>
              )}
              {batchMode && (
                <div className="batch-bar">
                  <span><Trash2 size={14} />已选 {selected.length} 个账号</span>
                  <div>
                    <button onClick={() => setSelected([])}>清空</button>
                    <button className="danger" disabled={!selected.length} onClick={deleteSelected}>删除所选</button>
                    <button onClick={() => { setBatchMode(false); setSelected([]); }}>退出批量</button>
                  </div>
                </div>
              )}
            </section>

            <aside className="activity-panel">
              <div className="panel-heading"><div><h2>实时执行</h2><span>最近 30 分钟</span></div><span className="panel-live"><span className="status-dot" />LIVE</span></div>
              {runningAccount ? (
                <>
                  <div className="activity-focus"><div className="focus-icon"><Activity size={18} /></div><div><strong>{runningAccount.name}</strong><span>{runningSite?.name} · 正在签到</span></div><span className="focus-time">18s</span></div>
                  <div className="activity-progress"><div className="progress-label"><span>登录与签到流程</span><strong>3 / 5</strong></div><div className="progress-track"><span style={{ width: '62%' }} /></div></div>
                  <ol className="activity-steps">
                    <li className="complete"><span><Check size={12} /></span><div><strong>打开站点登录页</strong><small>刚刚</small></div></li>
                    <li className="complete"><span><Check size={12} /></span><div><strong>已填写用户名和密码</strong><small>刚刚</small></div></li>
                    <li className="current"><span><LoaderIcon /></span><div><strong>等待站点确认签到</strong><small>进行中</small></div></li>
                    <li><span>4</span><div><strong>读取今日余额</strong><small>等待中</small></div></li>
                    <li><span>5</span><div><strong>写入执行结果</strong><small>等待中</small></div></li>
                  </ol>
                </>
              ) : (
                <div className="activity-empty"><CheckCircle2 size={20} /><strong>队列空闲</strong><span>没有正在执行的账号</span></div>
              )}
              <div className="queue-block">
                <div className="queue-heading"><span>排队中</span><strong>{queuedAccounts.length}</strong></div>
                {queuedAccounts.length > 0 ? (
                  <ul className="queue-list">
                    {queuedAccounts.map((account) => (
                      <li key={account.id}>
                        <span>{account.name}</span>
                        <small>{sites.find((site) => site.accounts.some((row) => row.id === account.id))?.name}</small>
                      </li>
                    ))}
                  </ul>
                ) : <p className="queue-empty">没有排队的账号</p>}
              </div>
              <button className="activity-link" onClick={() => showToast('执行记录已打开')}>查看全部执行记录 <ArrowUpRight size={15} /></button>
            </aside>
          </div>

          <section className="bottom-strip" aria-label="运行概况与快捷操作">
            <div className="strip-metrics">
              <div className="strip-metric"><span className="strip-icon blue"><Gauge size={15} /></span><span className="strip-copy"><em>今日平均响应</em><strong>1.8s</strong></span></div>
              <div className="strip-metric"><span className="strip-icon violet"><CalendarClock size={15} /></span><span className="strip-copy"><em>下次自动执行</em><strong>{nextRun}</strong></span></div>
              <div className="strip-metric"><span className="strip-icon amber"><Coins size={15} /></span><span className="strip-copy"><em>余额合计</em><strong>{money(grandTotal)}</strong></span></div>
              <div className="strip-metric"><span className="strip-icon mint"><Layers3 size={15} /></span><span className="strip-copy"><em>代理节点</em><strong>4 个在线</strong></span></div>
            </div>
            <div className="strip-actions">
              <button className="strip-button ghost" onClick={() => showToast('快捷操作已打开')}><SlidersHorizontal size={15} />快捷操作</button>
              <button className="strip-button primary" onClick={() => setModal({ kind: 'site-form', mode: 'new' })}><Plus size={15} />添加站点</button>
            </div>
          </section>
          </div>}
        </div>
      </main>
      {modal?.kind === 'proxy' && <ProxyPanelModal sites={sites} accounts={allAccounts} assignAccountId={modal.assignAccountId} onClose={() => setModal(null)} onToast={showToast} />}
      {modal?.kind === 'schedule' && <SchedulePanelModal sites={sites} onClose={() => setModal(null)} onSaved={setNextRun} onToast={showToast} />}
      {modal?.kind === 'backup' && <BackupPanelModal siteCount={sites.length} accountCount={allAccounts.length} onClose={() => setModal(null)} onToast={showToast} />}
      {modal?.kind === 'bookmarks' && <BookmarkImportModal onClose={() => setModal(null)} onToast={showToast} />}
      {modal?.kind === 'import-accounts' && <ImportAccountsModal sites={sites} onClose={() => setModal(null)} onToast={showToast} />}
      {modal?.kind === 'site-form' && (
        <SiteFormModal
          mode={modal.mode}
          site={modal.siteId ? sites.find((site) => site.id === modal.siteId) : undefined}
          proxies={INITIAL_PROXIES.filter((proxy) => !proxy.nameOnly).map((proxy) => proxy.name)}
          onClose={() => setModal(null)}
          onSave={saveSite}
        />
      )}
      {modal?.kind === 'account-form' && (() => {
        const target = sites.find((item) => item.id === modal.siteId);
        if (!target) return null;
        return (
          <AccountFormModal
            mode={modal.mode}
            site={target}
            account={modal.accountId ? target.accounts.find((account) => account.id === modal.accountId) : undefined}
            proxies={INITIAL_PROXIES.filter((proxy) => !proxy.nameOnly).map((proxy) => proxy.name)}
            onClose={() => setModal(null)}
            onSave={saveAccount}
          />
        );
      })()}
      {modal?.kind === 'site-menu' && (() => {
        const target = sites.find((item) => item.id === modal.siteId);
        if (!target) return null;
        return (
          <SiteMenuModal
            site={target}
            balanceTotal={money(siteBalance(target).total)}
            onClose={() => setModal(null)}
            onEdit={() => setModal({ kind: 'site-form', mode: 'edit', siteId: target.id })}
            onAddAccount={() => setModal({ kind: 'account-form', mode: 'new', siteId: target.id })}
            onRefreshBalances={() => refreshBalances(target.accounts.map((account) => account.id), target.name)}
            onDelete={() => requestDeleteSite(target.id)}
            onToast={showToast}
          />
        );
      })()}
      {modal?.kind === 'confirm' && (
        <ConfirmModal
          title={modal.title}
          message={modal.message}
          detail={modal.detail}
          confirmLabel={modal.confirmLabel}
          danger={modal.danger}
          onCancel={() => setModal(null)}
          onConfirm={() => { modal.action(); setModal(null); }}
        />
      )}
      <div className="toast" role="status" aria-live="polite" aria-atomic="true">{toast && <><Sparkles size={15} />{toast}</>}</div>
    </div>
  );
}

function Metric({ label, value, detail, tone, icon: Icon }: { label: string; value: string | number; detail: string; tone: string; icon: typeof Check }) {
  return <article className={`metric-card ${tone}`}><div className="metric-icon"><Icon size={17} /></div><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div><div className="metric-bars"><i /><i /><i /><i /><i /></div></article>;
}
type SitePanelProps = {
  site: Site;
  accounts: Account[];
  filtered: boolean;
  expanded: boolean;
  onToggle: () => void;
  onAction: (message: string) => void;
  onOpenMenu: () => void;
  onEditSite: () => void;
  onDeleteSite: () => void;
  onAddAccount: () => void;
  onEditAccount: (account: Account) => void;
  onAssignProxy: (account: Account) => void;
  batchMode: boolean;
  selected: string[];
  onToggleSelected: (accountId: string) => void;
  learningAccountId: string | null;
  learningStep: number;
  onLearningToggle: (accountId: string, accountName: string) => void;
  onLearningAdvance: () => void;
  onLearningCancel: () => void;
  detailId: string | null;
  onToggleDetail: (accountId: string) => void;
  refreshingIds: string[];
  onRunAccount: (accountId: string, name: string) => void;
  onStopAccount: (accountId: string, name: string) => void;
  onRefreshBalances: (accountIds: string[], label: string) => void;
  onMarkDone: (account: Account) => void;
  onResetAccount: (account: Account) => void;
  onDeleteAccount: (account: Account) => void;
  onRunSite: (siteId: string) => void;
  onStopSite: (siteId: string) => void;
};

function SitePanel({
  site, accounts, filtered, expanded, onToggle, onAction, onOpenMenu, onEditSite, onDeleteSite, onAddAccount,
  onEditAccount, onAssignProxy, batchMode, selected, onToggleSelected,
  learningAccountId, learningStep, onLearningToggle, onLearningAdvance, onLearningCancel,
  detailId, onToggleDetail, refreshingIds, onRunAccount, onStopAccount, onRefreshBalances,
  onMarkDone, onResetAccount, onDeleteAccount, onRunSite, onStopSite,
}: SitePanelProps) {
  const done = site.accounts.filter((account) => account.status === 'done').length;
  const attention = site.accounts.filter((account) => account.status === 'attention').length;
  const runningHere = site.accounts.filter((account) => account.status === 'running').length;
  const pendingHere = site.accounts.filter((account) => account.status === 'pending').length;
  const progress = site.accounts.length ? Math.round((done / site.accounts.length) * 100) : 0;
  const balance = siteBalance(site);
  const refreshing = site.accounts.filter((account) => refreshingIds.includes(account.id));
  const actionable = pendingHere + attention;

  return <article className={`site-panel ${site.accent}`}>
    <div className="site-panel-head">
      <div className="site-symbol"><Globe2 size={18} /></div>
      <div className="site-title">
        <div>
          <h3>{site.name}</h3>
          <span className="site-kind">{site.kind}</span>
          {site.proxy && <span className="site-proxy"><Wifi size={11} />{site.proxy}</span>}
        </div>
        <p>{site.domain}</p>
        <p className="site-flow"><span className="flow-dot" />{site.flow}</p>
      </div>
      <div className="site-balance">
        <span className="balance-pill" title="本站账号余额合计（换算后的展示币种）">
          <Coins size={12} />本站余额 {money(balance.total)}
        </span>
        {balance.missing > 0 && <small>{balance.missing} 个未获取</small>}
      </div>
      <div className="site-summary"><strong>{done}<span>/{site.accounts.length}</span></strong><small>今日完成</small></div>
      <button className="site-more" aria-label={`${site.name} 更多操作`} onClick={onOpenMenu}><MoreHorizontal size={17} /></button>
      <button className="site-toggle" aria-label={expanded ? `收起 ${site.name}` : `展开 ${site.name}`} onClick={onToggle}><ChevronDown size={17} /></button>
    </div>

    <div className="site-progress"><div><span style={{ width: `${progress}%` }} /></div><strong>{progress}%</strong></div>

    <div className="site-stats">
      <span className="stat-chip mint">完成 {done}</span>
      <span className="stat-chip amber">待签 {pendingHere}</span>
      {runningHere > 0 && <span className="stat-chip blue">执行中 {runningHere}</span>}
      {attention > 0 && <span className="stat-chip coral">需处理 {attention}</span>}
      <span className="stat-chip muted">余额未获取 {balance.missing}</span>
      {filtered && <span className="stat-chip violet">已筛出 {accounts.length} / {site.accounts.length}</span>}
      {site.accounts.length > 0 && <button className="stat-toggle" aria-expanded={expanded} onClick={onToggle}>{expanded ? '收起' : '展开'} {site.accounts.length} 个账号</button>}
    </div>

    <div className="site-actions">
      {actionable > 0 && <button className="mini-button primary" onClick={() => onRunSite(site.id)}><Play size={13} />执行 {actionable}</button>}
      {runningHere > 0 && <button className="mini-button" onClick={() => onStopSite(site.id)}><Ban size={13} />停止 {runningHere}</button>}
      <button className="mini-button" disabled={refreshing.length > 0 || !site.accounts.length} onClick={() => onRefreshBalances(site.accounts.map((account) => account.id), site.name)}>
        {refreshing.length > 0 ? <LoaderIcon /> : <Coins size={13} />}刷新本站余额
      </button>
      <button className="mini-button" onClick={onAddAccount}><Plus size={13} />添加账号</button>
      <div className="site-actions-tail">
        <button className="mini-icon" title="上移站点" onClick={() => onAction(`${site.name}：已上移（预览）`)}><ArrowUp size={14} /></button>
        <button className="mini-icon" title="下移站点" onClick={() => onAction(`${site.name}：已下移（预览）`)}><ArrowDown size={14} /></button>
        <button className="mini-icon" title="编辑站点" onClick={onEditSite}><Pencil size={14} /></button>
        <button className="mini-icon danger" title="删除站点" onClick={onDeleteSite}><Trash2 size={14} /></button>
      </div>
    </div>
    {(expanded || site.accounts.length === 0) && (
      <div className="account-list">
        {site.accounts.length === 0 && (
          <div className="account-empty">
            <Plus size={15} />
            <span>这个站点还没有账号，先添加一个再执行</span>
            <button className="mini-button primary" onClick={onAddAccount}>添加账号</button>
          </div>
        )}
        {accounts.map((account) => (
          <AccountRow
            key={account.id}
            account={account}
            batchMode={batchMode}
            selected={selected.includes(account.id)}
            onToggleSelected={onToggleSelected}
            learning={learningAccountId === account.id}
            learningStep={learningStep}
            onLearningToggle={() => onLearningToggle(account.id, account.name)}
            onLearningAdvance={onLearningAdvance}
            onLearningCancel={onLearningCancel}
            detailOpen={detailId === account.id}
            onToggleDetail={() => onToggleDetail(account.id)}
            refreshing={refreshingIds.includes(account.id)}
            onAction={onAction}
            onRunAccount={onRunAccount}
            onStopAccount={onStopAccount}
            onRefreshBalances={onRefreshBalances}
            onMarkDone={onMarkDone}
            onResetAccount={onResetAccount}
            onDeleteAccount={onDeleteAccount}
            onEditAccount={onEditAccount}
            onAssignProxy={onAssignProxy}
          />
        ))}
      </div>
    )}

    <div className="site-footer">
      <span><Users size={14} />{site.accounts.length} 个账号 · 站点代理 {site.proxy ?? '跟随全局'}</span>
      <button onClick={() => onAction(`已打开 ${site.name} 的账号管理`)}>管理账号 <ArrowUpRight size={14} /></button>
    </div>
  </article>;
}

type AccountRowProps = {
  account: Account;
  batchMode: boolean;
  selected: boolean;
  onToggleSelected: (accountId: string) => void;
  learning: boolean;
  learningStep: number;
  onLearningToggle: () => void;
  onLearningAdvance: () => void;
  onLearningCancel: () => void;
  detailOpen: boolean;
  onToggleDetail: () => void;
  refreshing: boolean;
  onAction: (message: string) => void;
  onRunAccount: (accountId: string, name: string) => void;
  onStopAccount: (accountId: string, name: string) => void;
  onRefreshBalances: (accountIds: string[], label: string) => void;
  onMarkDone: (account: Account) => void;
  onResetAccount: (account: Account) => void;
  onDeleteAccount: (account: Account) => void;
  onEditAccount: (account: Account) => void;
  onAssignProxy: (account: Account) => void;
};

function AccountRow({
  account, batchMode, selected, onToggleSelected, learning, learningStep,
  onLearningToggle, onLearningAdvance, onLearningCancel, detailOpen, onToggleDetail, refreshing,
  onAction, onRunAccount, onStopAccount, onRefreshBalances, onMarkDone, onResetAccount, onDeleteAccount,
  onEditAccount, onAssignProxy,
}: AccountRowProps) {
  const meta = statusMeta[account.status];
  const Icon = meta.icon;
  const learningLabels = ['手动登录', '核对当前账号', '完成一次签到', '保存流程'];
  const learningBlocked = account.status === 'running' || account.status === 'attention';

  return (
    <div className={`account-row ${learning ? 'learning-active' : ''} ${detailOpen ? 'detail-active' : ''}`}>
      <div className="account-main">
        {batchMode && (
          <button
            className={`check-box ${selected ? 'on' : ''}`}
            aria-label={selected ? `取消选择 ${account.name}` : `选择 ${account.name}`}
            aria-pressed={selected}
            onClick={() => onToggleSelected(account.id)}
          >
            {selected ? <Check size={13} /> : <Square size={13} />}
          </button>
        )}
        <div className="account-avatar">{account.name.slice(0, 1)}</div>
        <div className="account-info">
          <strong>{account.name}{account.label && <em>{account.label}</em>}</strong>
          <span>最近执行：{account.lastRun}{account.proxy && <> · 代理 {account.proxy}</>}</span>
          <div className="account-meta-line">
            {account.balance != null
              ? <span className="balance-line"><Coins size={11} />余额 <b>{money(account.balance)}</b>{account.balanceAt && <em>{account.balanceAt}</em>}</span>
              : <span className="balance-line missing"><Coins size={11} />余额未获取</span>}
            {account.reward != null && <span className="reward-line">签到奖励 <b>+{money(account.reward)}</b></span>}
          </div>
          {account.note && <span className="account-note">{account.note}</span>}
        </div>
        <span className={`status-pill ${meta.tone}`}><Icon size={13} />{meta.label}</span>
        <div className="account-actions">
          <button
            className={`learning-action ${learning ? 'active' : ''}`}
            aria-label={learning ? `结束学习 ${account.name}` : `学习签到 ${account.name}`}
            title={learningBlocked ? '请先结束当前任务，再开始学习' : undefined}
            disabled={!learning && learningBlocked}
            onClick={onLearningToggle}
          >
            <BookOpen size={15} /><span>{learning ? '结束学习' : '学习签到'}</span>
          </button>
          {account.status === 'running'
            ? <button className="row-action" aria-label={`停止 ${account.name}`} title="停止" onClick={() => onStopAccount(account.id, account.name)}><StopCircle size={15} /></button>
            : <button className="row-action" aria-label={`执行 ${account.name}`} title="执行" onClick={() => onRunAccount(account.id, account.name)}><Play size={15} /></button>}
          <button
            className={`row-action ${detailOpen ? 'on' : ''}`}
            aria-label={`${detailOpen ? '收起' : '展开'} ${account.name} 详情`}
            aria-expanded={detailOpen}
            title="详情：余额历史、代理、最近结果"
            onClick={onToggleDetail}
          >
            <ChevronDown size={15} />
          </button>
          <button className="row-action" aria-label={`打开 ${account.name}`} title="打开站点" onClick={() => onAction(`已打开 ${account.name}`)}><ExternalLink size={14} /></button>
        </div>
      </div>      {learning && <LearningPanel step={learningStep} labels={learningLabels} onAdvance={onLearningAdvance} onFinish={onLearningToggle} onCancel={onLearningCancel} />}

      {detailOpen && (
        <div className="account-detail">
          <div className="detail-grid">
            <section className="detail-card">
              <header><Coins size={13} />余额与历史</header>
              <div className="detail-balance">
                <strong>{account.balance != null ? money(account.balance) : '未获取'}</strong>
                <span>{account.balanceAt ?? '等待刷新'}</span>
              </div>
              {account.history && account.history.length > 1 ? (
                <ul className="balance-history">
                  {account.history.map((point, index) => {
                    const previous = account.history?.[index - 1];
                    const delta = previous ? point.amount - previous.amount : null;
                    return (
                      <li key={point.day}>
                        <span>{point.day}</span>
                        <b>{money(point.amount)}</b>
                        {delta != null && <em className={delta > 0 ? 'up' : delta < 0 ? 'down' : ''}>{delta > 0 ? '+' : ''}{delta.toFixed(4)}</em>}
                      </li>
                    );
                  })}
                </ul>
              ) : <p className="detail-empty">还没有累计到两天的记录</p>}
              <button className="detail-link" disabled={refreshing} onClick={() => onRefreshBalances([account.id], account.name)}>
                {refreshing ? <LoaderIcon /> : <RefreshCw size={12} />}刷新余额
              </button>
            </section>

            <section className="detail-card">
              <header><Wifi size={13} />代理与网络</header>
              <p className="detail-value">{account.proxy ?? '跟随站点代理'}</p>
              <p className="detail-hint">同一账号固定出口，避免异地登录触发风控。</p>
              <button className="detail-link" onClick={() => onAssignProxy(account)}>分配 / 固定代理</button>
            </section>

            <section className="detail-card">
              <header><Activity size={13} />最近执行</header>
              <p className="detail-value">{meta.label} · {account.lastRun}</p>
              <p className="detail-hint">{account.status === 'attention' ? '需要人工验证后才会继续排队。' : '步骤：打开站点 → 登录 → 核对账号 → 签到 → 读余额。'}</p>
              <button className="detail-link" onClick={() => onAction(`${account.name}：查看执行详情`)}>查看完整步骤</button>
            </section>
          </div>

          <div className="detail-actions">
            <button onClick={() => onEditAccount(account)}><Pencil size={13} />编辑账号</button>
            <button onClick={() => onAction(`${account.name}：抓取登录态`)}><RefreshCw size={13} />抓取登录态</button>
            {account.status === 'done'
              ? <button onClick={() => onResetAccount(account)}><Clock3 size={13} />收回完成状态</button>
              : <button onClick={() => onMarkDone(account)}><CheckCircle2 size={13} />手动标记完成</button>}
            <button onClick={() => onAction(`${account.name}：已重试`)}><RefreshCw size={13} />重试</button>
            <button className="danger" onClick={() => onDeleteAccount(account)}><Trash2 size={13} />删除账号</button>
          </div>
        </div>
      )}
    </div>
  );
}

function LearningPanel({ step, labels, onAdvance, onFinish, onCancel }: { step: number; labels: string[]; onAdvance: () => void; onFinish: () => void; onCancel: () => void }) {
  const completed = Math.min(step, 3);
  const isReady = step >= 3;
  return <div className="learning-panel">
    <div className="learning-panel-heading"><div><strong><BookOpen size={15} />正在学习本站签到流程</strong><span>动作只保存可安全回放的选择器，不保存账号和密码</span></div><span className="learning-live"><i />RECORDING</span></div>
    <div className="learning-steps" aria-label="学习签到进度">
      {labels.map((label, index) => <div key={label} className={`learning-step ${index < completed ? 'done' : index === step ? 'current' : ''}`}><span>{index < completed ? <Check size={12} /> : index + 1}</span><b>{label}</b>{index < labels.length - 1 && <i />}</div>)}
    </div>
    <div className="learning-detail"><div className="learning-detail-icon">{isReady ? <CheckCircle2 size={17} /> : <Activity size={17} />}</div><div><strong>{isReady ? '签到动作已记录，可以保存流程' : `请完成：${labels[step]}`}</strong><span>{isReady ? '保存后，后续自动执行会优先回放这套学习流程。' : '预览中可用按钮模拟当前学习步骤。真实使用时请在站点页面手动完成对应动作。'}</span></div></div>
    <div className="learning-actions"><button className="learning-cancel" onClick={onCancel}>放弃</button>{isReady ? <button className="learning-save" onClick={onFinish}><Check size={14} />结束学习并保存</button> : <button className="learning-next" onClick={onAdvance}>模拟完成当前步骤 <ArrowUpRight size={14} /></button>}</div>
  </div>;
}

function LoaderIcon() {
  return <span className="loader-icon" />;
}

/**
 * HMR 下模块会被重复执行，而 createRoot 只能对同一个容器调用一次 ——
 * 否则每次热更新都会抛 "container has already been passed to createRoot()"。
 * 把 root 挂在 globalThis 上复用，热更新只重新 render。
 */
const rootHost = globalThis as typeof globalThis & { __previewRoot?: Root };
const previewRoot = rootHost.__previewRoot ?? createRoot(document.getElementById('root')!);
rootHost.__previewRoot = previewRoot;
previewRoot.render(<App />);
