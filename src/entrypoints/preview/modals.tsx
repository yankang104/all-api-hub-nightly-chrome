/**
 * 预览页弹窗层。
 *
 * 字段、分组和按钮顺序对齐正式实现（ProxyModal / ScheduleModal / 站点表单 /
 * PasswordImportModal / 备份导出），数据仍是预览里的本地状态，不读写扩展存储。
 */
import {
  Activity,
  AlertTriangle,
  Bookmark,
  CalendarClock,
  Check,
  CheckCheck,
  CheckCircle2,
  Clock3,
  Coins,
  Copy,
  Database,
  Download,
  FileDown,
  Globe2,
  Layers3,
  Loader2,
  Network,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Search,
  ShieldAlert,
  Shuffle,
  Trash2,
  Unplug,
  Upload,
  Users,
  Wifi,
  X,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { Account, Site } from './data';

export type ProxyItem = {
  id: string;
  name: string;
  host: string;
  port: number;
  scheme: 'http' | 'socks5';
  source: string;
  /** 只有节点名、没有独立 listener 的条目：不能绑定账号，也不能测活。 */
  nameOnly?: boolean;
  latency?: number | null;
};

export const INITIAL_PROXIES: ProxyItem[] = [
  { id: 'p-hk', name: 'HongKong-01', host: '127.0.0.1', port: 7891, scheme: 'http', source: 'Clash Verge', latency: 82 },
  { id: 'p-jp', name: 'Japan-01', host: '127.0.0.1', port: 7892, scheme: 'http', source: 'Clash Verge', latency: 137 },
  { id: 'p-us', name: 'US-03', host: '127.0.0.1', port: 7893, scheme: 'http', source: 'Clash Verge', latency: 214 },
  { id: 'p-sg', name: 'Singapore-02', host: '127.0.0.1', port: 7894, scheme: 'socks5', source: '订阅导入', latency: null },
  { id: 'p-name', name: 'JustName（无 listener）', host: '', port: 0, scheme: 'http', source: 'Clash 名称', nameOnly: true },
];

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

export function ModalShell({ title, subtitle, onClose, children, footer, wide = false }: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" role="presentation" onClick={onClose}>
      <div
        className={`modal-dialog${wide ? ' wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <div className="modal-heading"><strong>{title}</strong>{subtitle && <span>{subtitle}</span>}</div>
          <button className="modal-close" aria-label="关闭弹窗" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}{hint && <em>{hint}</em>}</span>
      {children}
    </label>
  );
}
/* ---------------------------------------------------------------
   代理管理：导入 / 全部节点 / 账号绑定
   --------------------------------------------------------------- */

export function ProxyPanelModal({ sites, accounts, assignAccountId, onClose, onToast }: {
  sites: Site[];
  accounts: Account[];
  /** 从账号详情进来时，直接落在「账号绑定」页并高亮该账号。 */
  assignAccountId?: string;
  onClose: () => void;
  onToast: (message: string) => void;
}) {
  const [tab, setTab] = useState<'import' | 'exits' | 'assign'>(assignAccountId ? 'assign' : 'exits');
  const [list, setList] = useState<ProxyItem[]>(INITIAL_PROXIES);
  const [query, setQuery] = useState('');
  const [testing, setTesting] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [summary, setSummary] = useState<{ passed: number; total: number } | null>(null);
  const [subUrl, setSubUrl] = useState('');
  const [port, setPort] = useState('7897');
  const [assignment, setAssignment] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const site of sites) {
      for (const account of site.accounts) {
        if (account.proxy) {
          const matched = INITIAL_PROXIES.find((proxy) => proxy.name === account.proxy);
          if (matched) seed[account.id] = matched.id;
        }
      }
    }
    return seed;
  });

  const usable = list.filter((proxy) => !proxy.nameOnly);
  const visible = usable.filter((proxy) => `${proxy.name} ${proxy.host}:${proxy.port}`.toLowerCase().includes(query.trim().toLowerCase()));

  async function testOne(proxy: ProxyItem): Promise<boolean> {
    setTesting((current) => [...current, proxy.id]);
    await new Promise((resolve) => window.setTimeout(resolve, 620));
    const latency = 60 + Math.floor(Math.random() * 190);
    setList((current) => current.map((item) => (item.id === proxy.id ? { ...item, latency } : item)));
    setTesting((current) => current.filter((id) => id !== proxy.id));
    return true;
  }

  async function testAll() {
    if (!usable.length) return;
    setProgress({ done: 0, total: usable.length });
    let passed = 0;
    for (const [index, proxy] of usable.entries()) {
      const ok = await testOne(proxy);
      if (ok) passed += 1;
      setProgress({ done: index + 1, total: usable.length });
    }
    setSummary({ passed, total: usable.length });
    setProgress(null);
    onToast(`测活完成：${passed}/${usable.length} 个固定出口可用`);
  }

  function importBatch(items: ProxyItem[], label: string) {
    const existing = new Set(list.map((proxy) => proxy.id));
    const fresh = items.filter((item) => !existing.has(item.id));
    setList((current) => [...current, ...fresh]);
    onToast(fresh.length ? `${label}：导入 ${fresh.length} 个固定出口` : `${label}：没有新的出口`);
  }

  return (
    <ModalShell
      title="代理管理"
      subtitle="固定出口按账号绑定，避免同一账号在不同地区登录触发风控"
      wide
      onClose={onClose}
      footer={<>
        <span className="modal-footer-note">Clash 节点 {list.filter((proxy) => proxy.source === 'Clash Verge').length} 个 · 固定出口 {usable.length} 个
          {summary && ` · 本次测活 ${summary.passed}/${summary.total}`}</span>
        <button className="modal-button" onClick={onClose}>完成</button>
      </>}
    >
      <div className="modal-stats">
        <div className="stat-tile brand"><span>Clash 节点</span><strong>{list.filter((proxy) => proxy.source === 'Clash Verge').length || '--'}</strong></div>
        <div className="stat-tile mint"><span>固定出口</span><strong>{usable.length}</strong></div>
        <div className="stat-tile sky"><span>本次测活</span><strong>{summary ? `${summary.passed}/${summary.total}` : '--'}</strong></div>
      </div>

      <div className="modal-tabs" role="tablist" aria-label="代理管理分组">
        {([['import', FileDown, '导入代理'], ['exits', Network, '全部节点'], ['assign', Users, '账号绑定']] as const).map(([value, Icon, label]) => (
          <button key={value} role="tab" aria-selected={tab === value} className={tab === value ? 'selected' : ''} onClick={() => setTab(value)}>
            <Icon size={14} />{label}
          </button>
        ))}
      </div>

      {tab === 'exits' && (
        <section className="modal-section">
          <div className="modal-toolbar">
            <div className="search-inline"><Search size={14} /><input aria-label="搜索代理出口" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索出口名称或端口" /></div>
            <span className="toolbar-count">{visible.length}/{usable.length}</span>
            <button className="modal-button sky" disabled={Boolean(progress) || !usable.length} onClick={() => void testAll()}>
              {progress ? <Loader2 size={13} className="spin" /> : <Wifi size={13} />}
              {progress ? `${progress.done}/${progress.total}` : '全部测活'}
            </button>
          </div>
          <div className="proxy-list">
            {visible.map((proxy) => (
              <div key={proxy.id} className="proxy-row">
                {proxy.nameOnly ? <Unplug size={15} className="proxy-icon warn" /> : <Globe2 size={15} className="proxy-icon" />}
                <div className="proxy-info">
                  <strong>{proxy.name}</strong>
                  <span>{proxy.nameOnly ? '无固定 listener，暂不能绑定账号' : `${proxy.scheme}://${proxy.host}:${proxy.port}`}</span>
                </div>
                <span className="proxy-source">{proxy.source}</span>
                {testing.includes(proxy.id)
                  ? <span className="proxy-latency pending"><Loader2 size={11} className="spin" />测活中</span>
                  : proxy.nameOnly
                    ? <span className="proxy-latency bad">不可用</span>
                    : proxy.latency == null
                      ? <span className="proxy-latency idle">未测</span>
                      : <span className={`proxy-latency ${proxy.latency < 200 ? 'ok' : 'warn'}`}>{proxy.latency}ms</span>}
                <div className="proxy-actions">
                  <button aria-label={`测试 ${proxy.name}`} title="测试连通性" disabled={proxy.nameOnly || testing.includes(proxy.id)} onClick={() => void testOne(proxy)}><Wifi size={13} /></button>
                  <button aria-label={`删除 ${proxy.name}`} title="删除该出口" onClick={() => { setList((current) => current.filter((item) => item.id !== proxy.id)); onToast(`已删除 ${proxy.name}`); }}><Trash2 size={13} /></button>
                </div>
              </div>
            ))}
            {!visible.length && <div className="modal-empty"><Wifi size={20} /><strong>还没有已配置出口</strong><button onClick={() => setTab('import')}>现在导入</button></div>}
          </div>
        </section>
      )}
      {tab === 'import' && (
        <section className="modal-section">
          <div className="import-card">
            <header><FileDown size={14} /><strong>Clash Verge 固定节点</strong></header>
            <p>读取内核里的 listeners 后按本机端口生成固定出口，和 Clash Verge 列表名称保持一致。</p>
            <button className="modal-button" onClick={() => importBatch([
              { id: 'p-tw', name: 'Taiwan-01', host: '127.0.0.1', port: 7895, scheme: 'http', source: 'Clash Verge', latency: null },
              { id: 'p-de', name: 'Germany-01', host: '127.0.0.1', port: 7896, scheme: 'http', source: 'Clash Verge', latency: null },
            ], 'Clash 固定出口')}><Download size={13} />读取本地监听并导入</button>
          </div>

          <div className="import-card">
            <header><Globe2 size={14} /><strong>订阅导入</strong></header>
            <div className="import-row">
              <input aria-label="订阅地址" value={subUrl} onChange={(event) => setSubUrl(event.target.value)} placeholder="粘贴机场订阅地址，或本地 yaml 路径" />
              <button className="modal-button sky" disabled={!subUrl.trim()} onClick={() => {
                importBatch([
                  { id: `p-sub-${list.length + 1}`, name: `订阅节点-${list.length + 1}`, host: '127.0.0.1', port: 7900 + list.length, scheme: 'http', source: '订阅导入', latency: null },
                  { id: `p-sub-${list.length + 2}`, name: `订阅节点-${list.length + 2}`, host: '127.0.0.1', port: 7902 + list.length, scheme: 'socks5', source: '订阅导入', latency: null },
                ], '订阅导入');
                setSubUrl('');
              }}>导入</button>
            </div>
            <p>只保留浏览器能直接使用的 HTTP / SOCKS 出口，识别到的不支持节点会被跳过并说明原因。</p>
          </div>

          <div className="import-card">
            <header><Network size={14} /><strong>检测一个本地端口</strong></header>
            <div className="import-row">
              <input aria-label="本地端口" value={port} onChange={(event) => setPort(event.target.value.replace(/[^0-9]/g, '').slice(0, 5))} placeholder="7897" />
              <button className="modal-button" disabled={!port} onClick={() => importBatch([
                { id: `p-local-${port}`, name: `本地 ${port}`, host: '127.0.0.1', port: Number(port), scheme: 'http', source: '本地端口', latency: null },
              ], `本地端口 ${port}`)}>检测并添加</button>
            </div>
            <p>用于 Clash / V2Ray 这类在本机开混合端口的客户端，端口有响应才会入池。</p>
          </div>
        </section>
      )}

      {tab === 'assign' && (
        <section className="modal-section">
          <div className="assign-hint">
            <Shuffle size={14} />
            <span>按顺序一账号一节点固定绑定；节点少于账号时循环复用。批量分配只作用于当前没有固定的账号。</span>
          </div>
          <div className="assign-list">
            {sites.map((site) => (
              <div key={site.id} className="assign-group">
                <div className="assign-group-head"><Globe2 size={13} /><strong>{site.name}</strong><span>{site.accounts.length} 个账号</span>
                  <button className="link-button" onClick={() => {
                    const next = { ...assignment };
                    site.accounts.forEach((account, index) => { next[account.id] = usable[index % usable.length]?.id ?? ''; });
                    setAssignment(next);
                    onToast(`已为 ${site.name} 批量分配固定出口`);
                  }}>批量分配</button>
                </div>
                {site.accounts.map((account) => (
                  <div key={account.id} className={`assign-row${assignAccountId === account.id ? ' highlight' : ''}`}>
                    <span className="assign-name">{account.name}{account.label && <em>{account.label}</em>}</span>
                    <select aria-label={`${account.name} 的出口`} value={assignment[account.id] ?? ''} onChange={(event) => setAssignment((current) => ({ ...current, [account.id]: event.target.value }))}>
                      <option value="">跟随站点代理</option>
                      {usable.map((proxy) => <option key={proxy.id} value={proxy.id}>{proxy.name} · {proxy.scheme}://{proxy.host}:{proxy.port}</option>)}
                    </select>
                    <label className="pin-toggle">
                      <input type="checkbox" aria-label={`固定 ${account.name} 的出口`} checked={Boolean(assignment[account.id])} onChange={(event) => {
                        setAssignment((current) => ({ ...current, [account.id]: event.target.checked ? (usable[0]?.id ?? '') : '' }));
                      }} />
                      固定
                    </label>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <p className="modal-note">提交后账号行会显示固定出口名称；绑定不会改动站点级代理。</p>
          <button className="modal-button sky" onClick={() => onToast(`已保存 ${Object.values(assignment).filter(Boolean).length} 个账号的出口绑定`)}>保存绑定</button>
        </section>
      )}
    </ModalShell>
  );
}
/* ---------------------------------------------------------------
   定时签到：一天时间 + 星期 + 账号范围
   --------------------------------------------------------------- */

export function SchedulePanelModal({ sites, onClose, onSaved, onToast }: {
  sites: Site[];
  onClose: () => void;
  onSaved: (nextRun: string) => void;
  onToast: (message: string) => void;
}) {
  const [enabled, setEnabled] = useState(true);
  const [time, setTime] = useState('08:30');
  const [weekdays, setWeekdays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]);
  const [selected, setSelected] = useState<string[]>(() => sites.flatMap((site) => site.accounts.map((account) => account.id)));

  const totalAccounts = sites.reduce((sum, site) => sum + site.accounts.length, 0);
  const valid = weekdays.length > 0 && /^\d{2}:\d{2}$/.test(time) && selected.length > 0;
  const scopeText = selected.length === totalAccounts ? `全部账号 (${totalAccounts})` : `已选 ${selected.length}/${totalAccounts} 个账号`;

  function nextRunText(): string {
    const [hour, minute] = time.split(':').map(Number);
    const now = new Date();
    const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
    if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1);
    const sameDay = candidate.getDate() === now.getDate();
    return `${sameDay ? '今天' : '明天'} ${time}`;
  }

  function toggleAccount(accountId: string) {
    setSelected((current) => (current.includes(accountId) ? current.filter((id) => id !== accountId) : [...current, accountId]));
  }

  return (
    <ModalShell
      title="定时签到"
      wide
      onClose={onClose}
      footer={<>
        <span className="modal-footer-note">{enabled && valid ? `${nextRunText()} · ${scopeText}` : '未启用'}</span>
        <button className="modal-button" onClick={onClose}>取消</button>
        <button className="modal-button primary" disabled={!valid} onClick={() => {
          onSaved(enabled ? nextRunText() : '未启用');
          onToast(enabled ? `定时签到已保存：${nextRunText()} · ${scopeText}` : '已关闭定时签到');
          onClose();
        }}><Check size={13} />保存计划</button>
      </>}
    >
      <div className={`schedule-banner${enabled ? ' on' : ''}`}>
        <span className="schedule-icon"><CalendarClock size={18} /></span>
        <div><strong>后台计划</strong><span>下一次：{enabled ? nextRunText() : '未启用'}</span></div>
        <button className={`switch${enabled ? ' on' : ''}`} role="switch" aria-checked={enabled} aria-label={enabled ? '关闭定时签到' : '开启定时签到'} onClick={() => setEnabled((value) => !value)}>
          <span className="switch-track"><i /></span>
          <Power size={12} />
        </button>
      </div>

      <div className="form-grid">
        <Field label="执行时间">
          <input className="input" type="time" aria-label="执行时间" value={time} onChange={(event) => setTime(event.target.value)} />
        </Field>
        <Field label="执行日" hint="至少一天">
          <div className="weekday-row">
            {WEEKDAYS.map((label, index) => (
              <button key={label} className={`weekday-chip${weekdays.includes(index) ? ' on' : ''}`} aria-pressed={weekdays.includes(index)} aria-label={`星期${label}`} onClick={() => setWeekdays((current) => (current.includes(index) ? current.filter((day) => day !== index) : [...current, index]))}>{label}</button>
            ))}
          </div>
        </Field>
      </div>

      <section className="modal-section">
        <div className="picker-head">
          <div><strong><Users size={13} />签到账号</strong><span>{scopeText}</span></div>
          <div className="picker-actions">
            <button className="link-button" onClick={() => setSelected(sites.flatMap((site) => site.accounts.map((account) => account.id)))}><CheckCheck size={12} />全选</button>
            <button className="link-button muted" onClick={() => setSelected([])}>清空</button>
          </div>
        </div>
        <div className="account-picker">
          {sites.map((site) => {
            const ids = site.accounts.map((account) => account.id);
            const groupOn = ids.every((id) => selected.includes(id));
            const groupPartial = !groupOn && ids.some((id) => selected.includes(id));
            return (
              <div key={site.id} className="picker-group">
                <button className="picker-site" aria-pressed={groupOn} onClick={() => setSelected((current) => groupOn
                  ? current.filter((id) => !ids.includes(id))
                  : [...new Set([...current, ...ids])])}>
                  <span className={`marker${groupOn ? ' on' : groupPartial ? ' partial' : ''}`}>{groupOn && <Check size={11} />}</span>
                  <Globe2 size={13} />
                  <strong>{site.name}</strong>
                  <em>{site.accounts.length} 个账号</em>
                </button>
                <div className="picker-accounts">
                  {site.accounts.map((account) => {
                    const on = selected.includes(account.id);
                    return (
                      <button key={account.id} className={`picker-account${on ? ' on' : ''}`} aria-pressed={on} onClick={() => toggleAccount(account.id)}>
                        <span className={`marker${on ? ' on' : ''}`}>{on && <Check size={11} />}</span>
                        {account.label ?? account.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <div className="schedule-note"><Clock3 size={13} /><span>后台到点自动排队执行，站点卡片的「执行中」会实时反映进度。</span></div>
    </ModalShell>
  );
}
/* ---------------------------------------------------------------
   站点表单：新增 / 编辑
   --------------------------------------------------------------- */

export type SiteDraft = { name: string; domain: string; kind: string; flow: string; proxy: string };

export function SiteFormModal({ mode, site, proxies, onClose, onSave }: {
  mode: 'new' | 'edit';
  site?: Site;
  proxies: string[];
  onClose: () => void;
  onSave: (draft: SiteDraft) => void;
}) {
  const [draft, setDraft] = useState<SiteDraft>({
    name: site?.name ?? '',
    domain: site?.domain ?? '',
    kind: site?.kind ?? '本站适配',
    flow: site?.flow ?? '通用登录 → 核对当前账号 → 自动识别签到 · 可一次学习登录与签到',
    proxy: site?.proxy ?? '',
  });
  const valid = draft.name.trim().length > 0 && draft.domain.trim().length > 0;

  return (
    <ModalShell
      title={mode === 'new' ? '添加站点' : `编辑站点 · ${site?.name ?? ''}`}
      subtitle="站点地址决定适配家族；不确定时先选自动识别，签到流程可以后续学习"
      wide
      onClose={onClose}
      footer={<>
        <span className="modal-footer-note">{valid ? '字段校验通过' : '站点名称和地址必填'}</span>
        <button className="modal-button" onClick={onClose}>取消</button>
        <button className="modal-button primary" disabled={!valid} onClick={() => onSave({ ...draft, name: draft.name.trim(), domain: draft.domain.trim() })}>
          <Check size={13} />{mode === 'new' ? '创建站点' : '保存站点'}
        </button>
      </>}
    >
      <div className="form-grid">
        <Field label="站点名称">
          <input className="input" aria-label="站点名称" value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="例如 AnyRouter" />
        </Field>
        <Field label="站点地址">
          <input className="input" aria-label="站点地址" value={draft.domain} onChange={(event) => setDraft((current) => ({ ...current, domain: event.target.value }))} placeholder="anyrouter.top 或完整登录页地址" />
        </Field>
        <Field label="签到方式">
          <select className="input" aria-label="签到方式" value={draft.kind} onChange={(event) => setDraft((current) => ({ ...current, kind: event.target.value }))}>
            {['本站适配', '自动识别', '登录即签到', '学习流程回放'].map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </Field>
        <Field label="站点代理" hint="留空则跟随全局">
          <select className="input" aria-label="站点代理" value={draft.proxy} onChange={(event) => setDraft((current) => ({ ...current, proxy: event.target.value }))}>
            <option value="">跟随全局</option>
            {proxies.map((proxy) => <option key={proxy} value={proxy}>{proxy}</option>)}
          </select>
        </Field>
      </div>
      <Field label="执行流程说明" hint="展示在站点卡片上">
        <textarea className="input textarea" aria-label="执行流程说明" rows={3} value={draft.flow} onChange={(event) => setDraft((current) => ({ ...current, flow: event.target.value }))} />
      </Field>
      <div className="modal-note"><ShieldAlert size={13} /><span>站点地址填错时余额接口和签到路径都会失败；保存后可以用「刷新本站余额」先自检一次。</span></div>
    </ModalShell>
  );
}

/* ---------------------------------------------------------------
   账号表单：新增 / 编辑
   --------------------------------------------------------------- */

export type AccountDraft = { name: string; label: string; proxy: string; note: string };

export function AccountFormModal({ mode, site, account, proxies, onClose, onSave }: {
  mode: 'new' | 'edit';
  site: Site;
  account?: Account;
  proxies: string[];
  onClose: () => void;
  onSave: (draft: AccountDraft) => void;
}) {
  const [draft, setDraft] = useState<AccountDraft>({
    name: account?.name ?? '',
    label: account?.label ?? '',
    proxy: account?.proxy ?? '',
    note: account?.note ?? '',
  });
  const valid = draft.name.trim().length > 0;

  return (
    <ModalShell
      title={mode === 'new' ? `添加账号 · ${site.name}` : `编辑账号 · ${account?.name ?? ''}`}
      subtitle="账号密码存放在扩展本地存储，预览页不会读取或写入任何凭据"
      onClose={onClose}
      footer={<>
        <span className="modal-footer-note">{valid ? `归属站点：${site.name}` : '账号名称必填'}</span>
        <button className="modal-button" onClick={onClose}>取消</button>
        <button className="modal-button primary" disabled={!valid} onClick={() => onSave({ ...draft, name: draft.name.trim() })}>
          <Check size={13} />{mode === 'new' ? '添加账号' : '保存修改'}
        </button>
      </>}
    >
      <div className="form-grid">
        <Field label="账号名称">
          <input className="input" aria-label="账号名称" value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="用于区分多个账号，例如 主账号" />
        </Field>
        <Field label="标签" hint="可留空">
          <input className="input" aria-label="账号标签" value={draft.label} onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))} placeholder="生产 / 轮换 / 默认" />
        </Field>
      </div>
      <Field label="账号代理" hint="固定出口可避免异地登录风控">
        <select className="input" aria-label="账号代理" value={draft.proxy} onChange={(event) => setDraft((current) => ({ ...current, proxy: event.target.value }))}>
          <option value="">跟随站点代理</option>
          {proxies.map((proxy) => <option key={proxy} value={proxy}>{proxy}</option>)}
        </select>
      </Field>
      <Field label="备注" hint="会显示在账号行；余额失败原因也写在这里">
        <textarea className="input textarea" aria-label="账号备注" rows={2} value={draft.note} onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))} placeholder="例如：接口自检未通过，需要人工确认一次" />
      </Field>
    </ModalShell>
  );
}
/* ---------------------------------------------------------------
   备份迁移：导出 / 导入
   --------------------------------------------------------------- */

export function BackupPanelModal({ siteCount, accountCount, onClose, onToast }: {
  siteCount: number;
  accountCount: number;
  onClose: () => void;
  onToast: (message: string) => void;
}) {
  const [tab, setTab] = useState<'export' | 'import'>('export');
  const [payload, setPayload] = useState('');
  const [strategy, setStrategy] = useState<'merge' | 'replace'>('merge');
  const lines = payload.split('\n').filter((line) => line.trim().length > 0);

  return (
    <ModalShell
      title="备份与迁移"
      subtitle="备份包含站点、账号、代理与学习流程，不含明文密码"
      wide
      onClose={onClose}
      footer={<>
        <span className="modal-footer-note">{tab === 'export' ? `${siteCount} 个站点 · ${accountCount} 个账号` : lines.length ? `识别到 ${lines.length} 行数据` : '等待粘贴备份内容'}</span>
        <button className="modal-button" onClick={onClose}>关闭</button>
        {tab === 'export'
          ? <button className="modal-button primary" onClick={() => onToast(`已导出备份文件（${siteCount} 个站点 · ${accountCount} 个账号）`)}><Download size={13} />导出备份</button>
          : <button className="modal-button primary" disabled={!lines.length} onClick={() => { onToast(strategy === 'merge' ? '已按合并策略恢复备份' : '已按覆盖策略恢复备份'); onClose(); }}><Upload size={13} />开始恢复</button>}
      </>}
    >
      <div className="modal-tabs" role="tablist" aria-label="备份分组">
        {([['export', Download, '导出'], ['import', Upload, '导入']] as const).map(([value, Icon, label]) => (
          <button key={value} role="tab" aria-selected={tab === value} className={tab === value ? 'selected' : ''} onClick={() => setTab(value)}>
            <Icon size={14} />{label}
          </button>
        ))}
      </div>

      {tab === 'export' ? (
        <section className="modal-section">
          <div className="export-summary">
            <div><Database size={15} /><span>站点</span><strong>{siteCount}</strong></div>
            <div><Users size={15} /><span>账号</span><strong>{accountCount}</strong></div>
            <div><Layers3 size={15} /><span>学习流程</span><strong>1</strong></div>
            <div><Wifi size={15} /><span>固定出口</span><strong>{INITIAL_PROXIES.filter((proxy) => !proxy.nameOnly).length}</strong></div>
          </div>
          <p className="modal-note"><ShieldAlert size={13} /><span>导出文件可以跨设备恢复；恢复时如果站点 ID 冲突，会按下面的策略处理。</span></p>
          <ul className="plain-list">
            <li><Check size={12} />包含站点配置、执行流程和账号元数据</li>
            <li><Check size={12} />包含代理出口与账号绑定关系</li>
            <li><Check size={12} />不包含登录凭据、Cookie 和余额历史</li>
          </ul>
        </section>
      ) : (
        <section className="modal-section">
          <textarea className="input textarea" aria-label="备份内容" rows={6} value={payload} onChange={(event) => setPayload(event.target.value)} placeholder="粘贴 JSON 备份内容，或把导出的文件拖进来" />
          <div className="radio-row">
            {([['merge', '合并：保留本机已有站点，只补缺失账号'], ['replace', '覆盖：清空后按备份重建，适合换机迁移']] as const).map(([value, label]) => (
              <label key={value} className={`radio-card${strategy === value ? ' on' : ''}`}>
                <input type="radio" name="backup-strategy" checked={strategy === value} onChange={() => setStrategy(value)} />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </section>
      )}
    </ModalShell>
  );
}

/* ---------------------------------------------------------------
   导入账号：一行一个账号，支持常见分隔符
   --------------------------------------------------------------- */

export function ImportAccountsModal({ sites, onClose, onToast }: {
  sites: Site[];
  onClose: () => void;
  onToast: (message: string) => void;
}) {
  const [text, setText] = useState('');
  const rows = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const valid = rows.filter((line) => line.includes('----') || line.includes(',') || line.includes('\t'));

  return (
    <ModalShell
      title="导入账号"
      subtitle="每行一个账号，格式：站点域名,账号,密码 或 域名----账号----密码"
      wide
      onClose={onClose}
      footer={<>
        <span className="modal-footer-note">{rows.length ? `共 ${rows.length} 行，识别 ${valid.length} 个可用账号` : '等待粘贴账号文本'}</span>
        <button className="modal-button" onClick={onClose}>取消</button>
        <button className="modal-button primary" disabled={!valid.length} onClick={() => { onToast(`已匹配导入 ${valid.length} 个账号`); onClose(); }}><Upload size={13} />匹配导入</button>
      </>}
    >
      <textarea className="input textarea code" aria-label="账号文本" rows={7} value={text} onChange={(event) => setText(event.target.value)} placeholder={'anyrouter.top----main----password\napi.futureppo.top----backup----password'} />
      <div className="modal-stats">
        <div className="stat-tile mint"><span>可导入</span><strong>{valid.length}</strong></div>
        <div className="stat-tile brand"><span>待匹配站点</span><strong>{sites.length}</strong></div>
        <div className="stat-tile sky"><span>识别到的分隔符</span><strong>{valid.some((line) => line.includes('----')) ? '----' : valid.length ? ',' : '--'}</strong></div>
      </div>
      <p className="modal-note"><AlertTriangle size={13} /><span>站点地址匹配不到的账号会被跳过并列在结果里，不会静默丢弃。</span></p>
    </ModalShell>
  );
}

/* ---------------------------------------------------------------
   从书签导入：勾选书签生成站点
   --------------------------------------------------------------- */

export function BookmarkImportModal({ onClose, onToast }: { onClose: () => void; onToast: (message: string) => void }) {
  const bookmarks = [
    { id: 'b1', name: 'AnyRouter', url: 'https://anyrouter.top/login' },
    { id: 'b2', name: 'Future Hub', url: 'https://api.futureppo.top/login' },
    { id: 'b3', name: "1412's API", url: 'https://napi.kid1412.qzz.io/login' },
    { id: 'b4', name: '其他中转站', url: 'https://example-relay.dev/signin' },
  ];
  const [picked, setPicked] = useState<string[]>(['b1', 'b2']);

  return (
    <ModalShell
      title="从书签导入"
      subtitle="只读取书签标题和地址生成站点，不读取书签里的其他内容"
      onClose={onClose}
      footer={<>
        <span className="modal-footer-note">已选 {picked.length} 个书签</span>
        <button className="modal-button" onClick={onClose}>取消</button>
        <button className="modal-button primary" disabled={!picked.length} onClick={() => { onToast(`已从书签创建 ${picked.length} 个站点`); onClose(); }}><Bookmark size={13} />导入选中书签</button>
      </>}
    >
      <div className="check-list">
        {bookmarks.map((item) => {
          const on = picked.includes(item.id);
          return (
            <label key={item.id} className={`check-row${on ? ' on' : ''}`}>
              <input type="checkbox" checked={on} onChange={() => setPicked((current) => (on ? current.filter((id) => id !== item.id) : [...current, item.id]))} />
              <Bookmark size={14} />
              <span className="check-row-info"><strong>{item.name}</strong><em>{item.url}</em></span>
              {on && <Check size={13} className="check-row-mark" />}
            </label>
          );
        })}
      </div>
      <p className="modal-note"><CheckCircle2 size={13} /><span>导入后站点使用「自动识别」签到方式，第一次执行失败可以再学习一次流程。</span></p>
    </ModalShell>
  );
}
/* ---------------------------------------------------------------
   站点更多操作：代理 / 执行流程 / 失败诊断
   --------------------------------------------------------------- */

export function SiteMenuModal({ site, balanceTotal, onClose, onEdit, onAddAccount, onRefreshBalances, onDelete, onToast }: {
  site: Site;
  balanceTotal: string;
  onClose: () => void;
  onEdit: () => void;
  onAddAccount: () => void;
  onRefreshBalances: () => void;
  onDelete: () => void;
  onToast: (message: string) => void;
}) {
  const attention = site.accounts.filter((account) => account.status === 'attention');
  const missing = site.accounts.filter((account) => account.balance == null);

  return (
    <ModalShell title={`${site.name} · 站点信息`} subtitle={site.domain} onClose={onClose}>
      <div className="info-grid">
        <div className="info-block"><span>签到方式</span><strong>{site.kind}</strong></div>
        <div className="info-block"><span>站点代理</span><strong>{site.proxy ?? '跟随全局'}</strong></div>
        <div className="info-block"><span>本站余额</span><strong>{balanceTotal}</strong></div>
        <div className="info-block"><span>账号</span><strong>{site.accounts.length} 个 · 未获取余额 {missing.length} 个</strong></div>
      </div>

      <section className="modal-section">
        <div className="diagnosis-box">
          <header><Activity size={13} /><strong>执行流程</strong></header>
          <p>{site.flow}</p>
        </div>
        {(attention.length > 0 || missing.length > 0) && (
          <div className="diagnosis-box warn">
            <header><AlertTriangle size={13} /><strong>需要处理</strong></header>
            <p>{attention.length > 0 && `${attention.map((account) => account.name).join('、')} 等待人工验证；`}{missing.length > 0 && `${missing.length} 个账号余额未获取，先点刷新本站余额自检接口。`}</p>
          </div>
        )}
      </section>

      <div className="menu-actions">
        <button onClick={() => { onToast(`${site.name}：打开站点登录页`); }}><Globe2 size={13} />打开站点</button>
        <button onClick={() => { onRefreshBalances(); onClose(); }}><Coins size={13} />刷新本站余额</button>
        <button onClick={() => { onToast(`${site.name} 的域名已复制`); }}><Copy size={13} />复制域名</button>
        <button onClick={() => { onEdit(); }}><Pencil size={13} />编辑站点</button>
        <button onClick={() => { onAddAccount(); }}><Plus size={13} />添加账号</button>
        <button className="danger" onClick={onDelete}><Trash2 size={13} />删除站点</button>
      </div>
    </ModalShell>
  );
}

/* ---------------------------------------------------------------
   二次确认：删除站点 / 删除账号
   --------------------------------------------------------------- */

export function ConfirmModal({ title, message, detail, confirmLabel, danger = false, onConfirm, onCancel }: {
  title: string;
  message: string;
  detail?: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ModalShell
      title={title}
      onClose={onCancel}
      footer={<>
        <span className="modal-footer-note">操作会在预览数据上立即生效</span>
        <button className="modal-button" onClick={onCancel}>取消</button>
        <button className={`modal-button ${danger ? 'danger' : 'primary'}`} onClick={onConfirm}>{confirmLabel}</button>
      </>}
    >
      <div className={`confirm-body${danger ? ' danger' : ''}`}>
        <span className="confirm-icon">{danger ? <Trash2 size={18} /> : <RefreshCw size={18} />}</span>
        <div>
          <strong>{message}</strong>
          {detail && <p>{detail}</p>}
        </div>
      </div>
    </ModalShell>
  );
}