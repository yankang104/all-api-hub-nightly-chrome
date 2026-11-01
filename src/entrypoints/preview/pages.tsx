/**
 * 预览页的三个二级页面：执行记录、账号总览、代理与网络。
 *
 * 数据由站点/账号状态派生，和主页面共用同一份演示数据，
 * 所以在站点页点过的操作会立刻反映到这里的统计上。
 */
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Coins,
  Copy,
  Globe2,
  Layers3,
  ListChecks,
  Loader2,
  Play,
  RefreshCw,
  Search,
  ShieldAlert,
  Users,
  Wifi,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { INITIAL_PROXIES, type ProxyItem } from './modals';
import type { Account, Site } from './data';

function money(value: number): string {
  return `$${value.toFixed(4)}`;
}

/* ---------------------------------------------------------------
   执行记录
   --------------------------------------------------------------- */

type RecordStatus = 'success' | 'failed' | 'attention' | 'running';

type StepLog = { label: string; at: string; ok: boolean; note?: string };

type RunRecord = {
  id: string;
  day: '今天' | '昨天';
  time: string;
  siteId: string;
  siteName: string;
  accountId: string;
  accountName: string;
  status: RecordStatus;
  duration: string;
  reward?: number;
  balanceAfter?: number;
  steps: StepLog[];
  diagnosis?: { title: string; detail: string; next: string };
};

const recordMeta: Record<RecordStatus, { label: string; tone: string; icon: typeof Check }> = {
  success: { label: '成功', tone: 'done', icon: Check },
  failed: { label: '失败', tone: 'attention', icon: AlertTriangle },
  attention: { label: '需处理', tone: 'attention', icon: ShieldAlert },
  running: { label: '执行中', tone: 'running', icon: Activity },
};

const okSteps = (siteLabel: string): StepLog[] => [
  { label: '打开站点登录页', at: '0.4s', ok: true },
  { label: '填写账号并提交登录', at: '1.6s', ok: true },
  { label: `核对当前账号（${siteLabel}）`, at: '2.1s', ok: true },
  { label: '执行签到动作', at: '3.4s', ok: true },
  { label: '读取签到后余额', at: '4.2s', ok: true },
];

/** 由当前站点状态派生一批执行记录：成功、失败、需处理各来几条，便于核对详情样式。 */
function buildRecords(sites: Site[]): RunRecord[] {
  const records: RunRecord[] = [];
  const flat = sites.flatMap((site) => site.accounts.map((account) => ({ site, account })));

  flat.forEach(({ site, account }, index) => {
    const base: Pick<RunRecord, 'siteId' | 'siteName' | 'accountId' | 'accountName'> = {
      siteId: site.id,
      siteName: site.name,
      accountId: account.id,
      accountName: account.name,
    };
    const day: RunRecord['day'] = index % 3 === 0 ? '昨天' : '今天';
    const time = ['08:31:04', '08:31:26', '08:32:10', '08:33:02', '08:34:18', '08:35:41'][index % 6] ?? '08:31:04';

    if (account.status === 'attention') {
      records.push({
        ...base,
        id: `r-${account.id}-1`,
        day,
        time,
        status: 'attention',
        duration: '6.8s',
        steps: [
          ...okSteps(site.name).slice(0, 3),
          { label: '执行签到动作', at: '4.1s', ok: false, note: '页面要求二次验证' },
        ],
        diagnosis: {
          title: '站点要求人工验证',
          detail: '登录成功后在签到入口弹出了人机校验，自动流程停在原地等待。',
          next: '在站点页面手动完成一次校验，或用「学习签到」重录这段流程。',
        },
      });
      return;
    }

    if (account.status === 'pending' && index % 4 === 1) {
      records.push({
        ...base,
        id: `r-${account.id}-2`,
        day,
        time,
        status: 'failed',
        duration: '9.4s',
        steps: [
          { label: '打开站点登录页', at: '0.6s', ok: true },
          { label: '填写账号并提交登录', at: '2.2s', ok: true },
          { label: '核对当前账号', at: '3.0s', ok: false, note: '余额接口返回 502' },
        ],
        diagnosis: {
          title: '余额接口异常',
          detail: '登录与签到都成功，但读取余额时站点返回 502，本轮记成失败。',
          next: '点「刷新本站余额」重试；连续失败时检查站点是否改了接口地址。',
        },
      });
      return;
    }

    if (account.status === 'running') {
      records.push({
        ...base,
        id: `r-${account.id}-3`,
        day: '今天',
        time,
        status: 'running',
        duration: '18s',
        steps: [
          { label: '打开站点登录页', at: '0.5s', ok: true },
          { label: '填写账号并提交登录', at: '1.9s', ok: true },
          { label: '等待站点确认签到', at: '进行中', ok: true, note: '站点响应较慢' },
        ],
      });
      return;
    }

    if (account.status === 'done') {
      records.push({
        ...base,
        id: `r-${account.id}-4`,
        day,
        time,
        status: 'success',
        duration: `${(3.4 + (index % 5) * 0.4).toFixed(1)}s`,
        reward: account.reward,
        balanceAfter: account.balance,
        steps: okSteps(site.name),
      });
    }
  });

  return records;
}

export function RecordsPage({ sites, onToast }: { sites: Site[]; onToast: (message: string) => void }) {
  const [range, setRange] = useState<'今天' | '近 7 天' | '全部'>('今天');
  const [status, setStatus] = useState<'全部' | RecordStatus>('全部');
  const [keyword, setKeyword] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const allRecords = useMemo(() => buildRecords(sites), [sites]);
  const visible = allRecords.filter((record) => {
    if (range === '今天' && record.day !== '今天') return false;
    if (status !== '全部' && record.status !== status) return false;
    const text = `${record.siteName} ${record.accountName}`.toLowerCase();
    return !keyword.trim() || text.includes(keyword.trim().toLowerCase());
  });

  const successCount = visible.filter((record) => record.status === 'success').length;
  const failedCount = visible.filter((record) => record.status === 'failed' || record.status === 'attention').length;
  const rewardTotal = visible.reduce((sum, record) => sum + (record.reward ?? 0), 0);
  const successRate = visible.length ? Math.round((successCount / visible.length) * 100) : 0;
  const days: Array<RunRecord['day']> = range === '今天' ? ['今天'] : ['今天', '昨天'];

  return (
    <div className="page-body">
      <section className="page-hero">
        <div>
          <h1>执行记录</h1>
          <p>每次签到都留下可回查的步骤流水，失败的那一步直接标出原因和下一步动作。</p>
        </div>
        <div className="page-hero-actions">
          <button className="secondary-button" onClick={() => onToast('执行记录已导出为 CSV（预览）')}><ArrowUpRight size={15} />导出记录</button>
          <button className="secondary-button" onClick={() => onToast('已重新拉取最近执行记录')}><RefreshCw size={15} />刷新</button>
        </div>
      </section>

      <section className="metric-grid" aria-label="执行统计">
        <Metric label="执行次数" value={visible.length} detail={`${range}范围`} tone="blue" icon={ListChecks} />
        <Metric label="成功率" value={`${successRate}%`} detail={`成功 ${successCount} 条`} tone="mint" icon={CheckCircle2} />
        <Metric label="需要处理" value={failedCount} detail="失败与待人工确认" tone="coral" icon={ShieldAlert} />
        <Metric label="奖励合计" value={money(rewardTotal)} detail="本次范围内的签到奖励" tone="amber" icon={Coins} />
      </section>

      <div className="record-toolbar">
        <div className="segmented-control" role="tablist" aria-label="时间范围">
          {(['今天', '近 7 天', '全部'] as const).map((item) => (
            <button key={item} className={range === item ? 'selected' : ''} onClick={() => setRange(item)}>{item}</button>
          ))}
        </div>
        <div className="segmented-control" role="tablist" aria-label="执行状态">
          {(['全部', 'success', 'failed', 'attention', 'running'] as const).map((item) => (
            <button key={item} className={status === item ? 'selected' : ''} onClick={() => setStatus(item)}>
              {item === '全部' ? '全部' : recordMeta[item].label}
            </button>
          ))}
        </div>
        <div className="search-inline record-search">
          <Search size={14} />
          <input aria-label="搜索执行记录" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索站点或账号" />
        </div>
      </div>
      <section className="record-list" aria-label="执行流水">
        {days.map((day) => {
          const dayRecords = visible.filter((record) => record.day === day);
          if (!dayRecords.length) return null;
          return (
            <div key={day} className="record-day">
              <div className="record-day-head"><CalendarClock size={13} /><strong>{day}</strong><span>{dayRecords.length} 次执行</span></div>
              {dayRecords.map((record) => {
                const meta = recordMeta[record.status];
                const Icon = meta.icon;
                const open = openId === record.id;
                return (
                  <article key={record.id} className={`record-row ${open ? 'open' : ''}`}>
                    <button className="record-summary" aria-expanded={open} onClick={() => setOpenId(open ? null : record.id)}>
                      <span className={`record-status ${meta.tone}`}><Icon size={13} /></span>
                      <span className="record-main">
                        <strong>{record.accountName}<em>{record.siteName}</em></strong>
                        <span className="record-meta">{record.time} · 耗时 {record.duration}{record.reward != null && <> · 奖励 <b className="record-reward">+{money(record.reward)}</b></>}{record.balanceAfter != null && <> · 余额 {money(record.balanceAfter)}</>}</span>
                      </span>
                      <span className={`status-pill ${meta.tone}`}>{meta.label}</span>
                      <ChevronDown size={15} className="record-chevron" />
                    </button>
                    {open && (
                      <div className="record-detail">
                        {record.diagnosis && (
                          <div className="diagnosis-box warn">
                            <header><AlertTriangle size={13} /><strong>{record.diagnosis.title}</strong></header>
                            <p>{record.diagnosis.detail}</p>
                            <p className="diagnosis-next">下一步：{record.diagnosis.next}</p>
                          </div>
                        )}
                        <ol className="step-log">
                          {record.steps.map((step) => (
                            <li key={step.label} className={step.ok ? 'ok' : 'bad'}>
                              <span className="step-dot">{step.ok ? <Check size={11} /> : <AlertTriangle size={11} />}</span>
                              <div><strong>{step.label}</strong>{step.note && <small>{step.note}</small>}</div>
                              <em>{step.at}</em>
                            </li>
                          ))}
                        </ol>
                        <div className="record-actions">
                          <button onClick={() => onToast(`已复制 ${record.accountName} 的执行日志`)}><Copy size={12} />复制日志</button>
                          <button onClick={() => onToast(`已重跑 ${record.accountName}`)}><Play size={12} />重跑这次</button>
                          <button onClick={() => onToast(`已打开 ${record.siteName} 的站点详情`)}><Globe2 size={12} />去站点</button>
                        </div>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          );
        })}
        {!visible.length && (
          <div className="empty-result">
            <ListChecks size={22} />
            <strong>这个范围内没有执行记录</strong>
            <span>换个时间范围，或者先执行一次签到</span>
          </div>
        )}
      </section>
    </div>
  );
}

/* ---------------------------------------------------------------
   账号总览
   --------------------------------------------------------------- */

type AccountRowView = { site: Site; account: Account };

export function AccountsPage({ sites, onToast, onOpenSite }: { sites: Site[]; onToast: (message: string) => void; onOpenSite: (siteId: string) => void }) {
  const [keyword, setKeyword] = useState('');
  const [only, setOnly] = useState<'全部' | '未获取余额' | '需处理' | '已完成'>('全部');

  const rows: AccountRowView[] = sites.flatMap((site) => site.accounts.map((account) => ({ site, account })));
  const visible = rows.filter(({ site, account }) => {
    const text = `${account.name} ${account.label ?? ''} ${site.name}`.toLowerCase();
    if (keyword.trim() && !text.includes(keyword.trim().toLowerCase())) return false;
    if (only === '未获取余额') return account.balance == null;
    if (only === '需处理') return account.status === 'attention';
    if (only === '已完成') return account.status === 'done';
    return true;
  });

  const withBalance = rows.filter(({ account }) => account.balance != null);
  const total = withBalance.reduce((sum, { account }) => sum + (account.balance ?? 0), 0);
  const rewardTotal = rows.reduce((sum, { account }) => sum + (account.reward ?? 0), 0);

  return (
    <div className="page-body">
      <section className="page-hero">
        <div>
          <h1>账号总览</h1>
          <p>所有站点的账号放到一张表里，按余额是否取到、是否需要人工处理来筛。</p>
        </div>
        <div className="page-hero-actions">
          <button className="secondary-button" onClick={() => onToast('已刷新全部账号的登录态（预览）')}><RefreshCw size={15} />刷新登录态</button>
        </div>
      </section>

      <section className="metric-grid" aria-label="账号统计">
        <Metric label="账号总数" value={rows.length} detail={`${sites.length} 个站点`} tone="blue" icon={Users} />
        <Metric label="余额合计" value={money(total)} detail={`${rows.length - withBalance.length} 个未获取`} tone="amber" icon={Coins} />
        <Metric label="签到奖励" value={money(rewardTotal)} detail="最近一轮的奖励合计" tone="mint" icon={Check} />
        <Metric label="需处理" value={rows.filter(({ account }) => account.status === 'attention').length} detail="等待人工验证" tone="coral" icon={ShieldAlert} />
      </section>

      <div className="record-toolbar">
        <div className="segmented-control" role="tablist" aria-label="账号筛选">
          {(['全部', '未获取余额', '需处理', '已完成'] as const).map((item) => (
            <button key={item} className={only === item ? 'selected' : ''} onClick={() => setOnly(item)}>{item}</button>
          ))}
        </div>
        <div className="search-inline record-search">
          <Search size={14} />
          <input aria-label="搜索账号" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索账号、标签或站点" />
        </div>
      </div>

      <section className="account-table" aria-label="账号列表">
        <div className="account-table-head">
          <span>账号</span><span>站点</span><span>状态</span><span>余额</span><span>签到奖励</span><span>最近执行</span><span />
        </div>
        {visible.map(({ site, account }) => (
          <div key={account.id} className="account-table-row">
            <span className="account-table-name">{account.name}{account.label && <em>{account.label}</em>}</span>
            <button className="link-button" onClick={() => onOpenSite(site.id)}>{site.name}</button>
            <span className={`status-pill ${account.status === 'done' ? 'done' : account.status === 'pending' ? 'pending' : account.status === 'running' ? 'running' : 'attention'}`}>
              {account.status === 'done' ? '已完成' : account.status === 'pending' ? '待签到' : account.status === 'running' ? '执行中' : '需处理'}
            </span>
            <span className="account-table-balance">{account.balance != null ? money(account.balance) : <em>未获取</em>}</span>
            <span className="account-table-balance">{account.reward != null ? `+${money(account.reward)}` : '--'}</span>
            <span className="account-table-muted">{account.lastRun}</span>
            <span className="account-table-actions">
              <button aria-label={`执行 ${account.name}`} title="执行" onClick={() => onToast(`已开始执行 ${account.name}`)}><Play size={13} /></button>
              <button aria-label={`刷新 ${account.name} 的余额`} title="刷新余额" onClick={() => onToast(`${account.name} 余额已刷新`)}><RefreshCw size={13} /></button>
            </span>
          </div>
        ))}
        {!visible.length && (
          <div className="empty-result">
            <Users size={22} />
            <strong>没有匹配的账号</strong>
            <span>换个关键词或筛选条件</span>
          </div>
        )}
      </section>
    </div>
  );
}
/* ---------------------------------------------------------------
   代理与网络
   --------------------------------------------------------------- */

export function ProxyPage({ onOpenProxyPanel, onToast }: { onOpenProxyPanel: (accountId?: string) => void; onToast: (message: string) => void }) {
  const [list, setList] = useState<ProxyItem[]>(INITIAL_PROXIES);
  const [testing, setTesting] = useState<string[]>([]);

  const usable = list.filter((proxy) => !proxy.nameOnly);
  const online = usable.filter((proxy) => (proxy.latency ?? 999) < 200).length;
  const average = usable.filter((proxy) => proxy.latency != null).length
    ? Math.round(usable.reduce((sum, proxy) => sum + (proxy.latency ?? 0), 0) / usable.filter((proxy) => proxy.latency != null).length)
    : 0;

  async function test(proxy: ProxyItem) {
    setTesting((current) => [...current, proxy.id]);
    await new Promise((resolve) => window.setTimeout(resolve, 640));
    const latency = 60 + Math.floor(Math.random() * 190);
    setList((current) => current.map((item) => (item.id === proxy.id ? { ...item, latency } : item)));
    setTesting((current) => current.filter((id) => id !== proxy.id));
    onToast(`${proxy.name} 测活完成：${latency}ms`);
  }

  return (
    <div className="page-body">
      <section className="page-hero">
        <div>
          <h1>代理与网络</h1>
          <p>固定出口决定每个账号从哪个地区登录。同一账号长期绑定同一个出口，最不容易触发风控。</p>
        </div>
        <div className="page-hero-actions">
          <button className="secondary-button" onClick={() => onOpenProxyPanel()}><Wifi size={15} />管理代理</button>
          <button className="secondary-button" onClick={() => onOpenProxyPanel()}><Layers3 size={15} />批量分配</button>
        </div>
      </section>

      <section className="metric-grid" aria-label="网络统计">
        <Metric label="固定出口" value={usable.length} detail={`共 ${list.length} 条记录`} tone="blue" icon={Wifi} />
        <Metric label="可用出口" value={online} detail="延迟低于 200ms" tone="mint" icon={CheckCircle2} />
        <Metric label="平均延迟" value={`${average}ms`} detail="仅统计已测活的出口" tone="amber" icon={Activity} />
        <Metric label="无 listener" value={list.filter((proxy) => proxy.nameOnly).length} detail="只有节点名，不能绑定" tone="coral" icon={AlertTriangle} />
      </section>

      <section className="proxy-page-list" aria-label="出口列表">
        {list.map((proxy) => (
          <article key={proxy.id} className="proxy-page-row">
            <span className={`proxy-page-icon${proxy.nameOnly ? ' warn' : ''}`}>{proxy.nameOnly ? <AlertTriangle size={16} /> : <Globe2 size={16} />}</span>
            <div className="proxy-page-info">
              <strong>{proxy.name}</strong>
              <span>{proxy.nameOnly ? '无固定 listener，不能绑定账号' : `${proxy.scheme}://${proxy.host}:${proxy.port}`}</span>
            </div>
            <span className="proxy-source">{proxy.source}</span>
            {testing.includes(proxy.id)
              ? <span className="proxy-latency pending"><Loader2 size={11} className="spin" />测活中</span>
              : proxy.nameOnly
                ? <span className="proxy-latency bad">不可用</span>
                : proxy.latency == null
                  ? <span className="proxy-latency idle">未测</span>
                  : <span className={`proxy-latency ${proxy.latency < 200 ? 'ok' : 'warn'}`}>{proxy.latency}ms</span>}
            <div className="proxy-page-actions">
              <button disabled={proxy.nameOnly || testing.includes(proxy.id)} onClick={() => void test(proxy)}><Wifi size={13} />测活</button>
              <button onClick={() => onOpenProxyPanel()}><Users size={13} />绑定账号</button>
            </div>
          </article>
        ))}
      </section>

      <section className="network-notes">
        <div className="diagnosis-box">
          <header><Clock3 size={13} /><strong>什么时候需要固定出口</strong></header>
          <p>同一个账号今天从日本、明天从香港登录，站点容易判定为异地登录并要求二次验证。固定在同一个出口后，签到成功率会稳定很多。</p>
        </div>
        <div className="diagnosis-box warn">
          <header><AlertTriangle size={13} /><strong>测活失败怎么办</strong></header>
          <p>先确认本地代理客户端在运行、端口没有改；端口变了就重新扫一次本地端口，再回来批量分配。</p>
        </div>
      </section>
    </div>
  );
}

/* ---------------------------------------------------------------
   站点总览
   --------------------------------------------------------------- */

export function SitesPage({ sites, onToast, onOpenSite }: { sites: Site[]; onToast: (message: string) => void; onOpenSite: (siteId: string) => void }) {
  const [keyword, setKeyword] = useState('');
  const visible = sites.filter((site) => !keyword.trim() || `${site.name} ${site.domain}`.toLowerCase().includes(keyword.trim().toLowerCase()));

  const withBalance = sites.flatMap((site) => site.accounts).filter((account) => account.balance != null);
  const total = withBalance.reduce((sum, account) => sum + (account.balance ?? 0), 0);
  const missing = sites.flatMap((site) => site.accounts).length - withBalance.length;
  const empty = sites.filter((site) => site.accounts.length === 0).length;
  const attention = sites.filter((site) => site.accounts.some((account) => account.status === 'attention')).length;

  return (
    <div className="page-body">
      <section className="page-hero">
        <div>
          <h1>站点总览</h1>
          <p>每个站点一行：签到方式、账号数、余额合计和今天还差多少没签。</p>
        </div>
        <div className="page-hero-actions">
          <button className="secondary-button" onClick={() => onToast('已刷新全部站点的余额')}><RefreshCw size={15} />刷新全部余额</button>
        </div>
      </section>

      <section className="metric-grid" aria-label="站点统计">
        <Metric label="站点数" value={sites.length} detail={empty ? `${empty} 个还没有账号` : '全部有账号'} tone="blue" icon={Globe2} />
        <Metric label="余额合计" value={money(total)} detail={missing ? `${missing} 个账号未获取` : '全部已获取'} tone="amber" icon={Coins} />
        <Metric label="需处理站点" value={attention} detail="含等待人工验证的账号" tone="coral" icon={ShieldAlert} />
        <Metric label="固定出口" value={INITIAL_PROXIES.filter((proxy) => !proxy.nameOnly).length} detail="站点继承或账号固定" tone="mint" icon={Wifi} />
      </section>

      <div className="record-toolbar">
        <div className="search-inline record-search">
          <Search size={14} />
          <input aria-label="搜索站点" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索站点名称或域名" />
        </div>
      </div>

      <section className="site-table" aria-label="站点列表">
        {visible.map((site) => {
          const known = site.accounts.filter((account) => account.balance != null);
          const sum = known.reduce((acc, account) => acc + (account.balance ?? 0), 0);
          const done = site.accounts.filter((account) => account.status === 'done').length;
          const progress = site.accounts.length ? Math.round((done / site.accounts.length) * 100) : 0;
          return (
            <article key={site.id} className={`site-table-row ${site.accent}`}>
              <span className="site-symbol"><Globe2 size={16} /></span>
              <div className="site-table-main">
                <strong>{site.name}<em>{site.kind}</em></strong>
                <span>{site.domain}</span>
              </div>
              <span className="site-table-cell"><em>账号</em>{site.accounts.length}</span>
              <span className="site-table-cell"><em>今日完成</em>{done}/{site.accounts.length}</span>
              <span className="site-table-cell"><em>余额</em>{money(sum)}{site.accounts.length - known.length > 0 && <i> · {site.accounts.length - known.length} 未获取</i>}</span>
              <span className="site-table-progress"><span style={{ width: `${progress}%` }} /></span>
              <span className="site-table-actions">
                <button onClick={() => onOpenSite(site.id)}><ArrowUpRight size={13} />打开</button>
                <button onClick={() => onToast(`${site.name}：编辑站点`)}><ChevronDown size={13} />更多</button>
              </span>
            </article>
          );
        })}
        {!visible.length && (
          <div className="empty-result">
            <Globe2 size={22} />
            <strong>没有匹配的站点</strong>
            <span>换个关键词试试</span>
          </div>
        )}
      </section>
    </div>
  );
}

/* ---------------------------------------------------------------
   页面内复用的小组件
   --------------------------------------------------------------- */

function Metric({ label, value, detail, tone, icon: Icon }: { label: string; value: string | number; detail: string; tone: string; icon: typeof Check }) {
  return (
    <article className={`metric-card ${tone}`}>
      <div className="metric-icon"><Icon size={17} /></div>
      <div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>
      <div className="metric-bars"><i /><i /><i /><i /><i /></div>
    </article>
  );
}