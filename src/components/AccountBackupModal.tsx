import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Download,
  FileUp,
  Loader2,
  Lock,
  Upload,
} from 'lucide-react';
import type { Account, ProxyConfig, SiteConfig } from '@/types';
import {
  backupFileName,
  buildBackupPayload,
  parseBackupPayload,
  planBackupImport,
  type ImportPlan,
} from '@/lib/backup/account-backup';
import {
  decryptBackup,
  encryptBackup,
  isEncryptedEnvelope,
} from '@/lib/backup/backup-crypto';
import { CLASH_VERGE_CONFIG_PATH } from '@/lib/clash/clash-config';
import { Field, inputCls, Modal } from './Modal';
import { cn } from '@/lib/core/cn';

interface Props {
  open: boolean;
  sites: SiteConfig[];
  accounts: Account[];
  proxies: ProxyConfig[];
  onClose: () => void;
  /** 落地导入。返回实际写入的数量，用于给用户一个确定的结果。 */
  onImport: (plan: ImportPlan) => Promise<{
    sites: number;
    accounts: number;
    proxies: number;
    skipped: number;
  }>;
}

type Tab = 'export' | 'import';

export function AccountBackupModal({ open, sites, accounts, proxies, onClose, onImport }: Props) {
  const [tab, setTab] = useState<Tab>('import');

  // 导出侧
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const [exportedName, setExportedName] = useState('');

  // 导入侧
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  /** 读进来的原始文本；等口令时先存着。 */
  const [rawContent, setRawContent] = useState('');
  const [needsPassphrase, setNeedsPassphrase] = useState(false);
  const [importPassphrase, setImportPassphrase] = useState('');
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [importError, setImportError] = useState('');
  const [importing, setImporting] = useState(false);
  const [importDone, setImportDone] = useState('');

  useEffect(() => {
    setTab('import');
    setPassphrase('');
    setConfirmPassphrase('');
    setExporting(false);
    setExportError('');
    setExportedName('');
    setFileName('');
    setRawContent('');
    setNeedsPassphrase(false);
    setImportPassphrase('');
    setPlan(null);
    setImportError('');
    setImporting(false);
    setImportDone('');
  }, [open]);

  const passphraseMismatch = confirmPassphrase.length > 0 && passphrase !== confirmPassphrase;
  const canExport = passphrase.length > 0 && passphrase === confirmPassphrase && !exporting;

  async function runExport() {
    if (!canExport) return;
    setExporting(true);
    setExportError('');
    setExportedName('');
    let url = '';
    try {
      const payload = buildBackupPayload(sites, accounts, proxies);
      const envelope = await encryptBackup(JSON.stringify(payload), passphrase, {
        exportedAt: Date.now(),
        extensionVersion: chrome.runtime?.getManifest?.().version,
      });
      const name = backupFileName(new Date());
      const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
      url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setExportedName(name);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : '导出失败');
    } finally {
      // 立刻回收：Blob URL 不释放会一直占着内存里的整份备份数据
      if (url) URL.revokeObjectURL(url);
      setExporting(false);
    }
  }

  /** 读取文件结构。加密文件先等用户输入口令，点击一次即可解密并导入。 */
  function analyze(content: string) {
    setImportError('');
    setPlan(null);
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(content);
    } catch {
      setImportError('这个文件不是有效的 JSON，请确认选的是扩展导出的备份文件');
      return;
    }

    if (isEncryptedEnvelope(parsedJson)) {
      setNeedsPassphrase(true);
      return;
    }

    setNeedsPassphrase(false);
    buildPlanFrom(parsedJson);
  }

  function buildPlanFrom(raw: unknown): ImportPlan | null {
    try {
      const nextPlan = planBackupImport(parseBackupPayload(raw), sites, accounts, proxies);
      setPlan(nextPlan);
      return nextPlan;
    } catch (error) {
      setImportError(error instanceof Error ? error.message : '备份内容无法解析');
      return null;
    }
  }

  async function pickFile(file: File) {
    setFileName(file.name);
    setImportPassphrase('');
    setImportDone('');
    const content = await file.text();
    setRawContent(content);
    analyze(content);
  }

  async function runImport() {
    if (importing) return;
    setImporting(true);
    setImportError('');
    try {
      let nextPlan = plan;
      if (!nextPlan && needsPassphrase && rawContent) {
        const envelope = JSON.parse(rawContent) as unknown;
        if (!isEncryptedEnvelope(envelope)) throw new Error('备份文件的加密结构不完整');
        const plain = await decryptBackup(envelope, importPassphrase);
        nextPlan = buildPlanFrom(JSON.parse(plain));
      }
      if (!nextPlan) throw new Error('没有可导入的数据');

      const result = await onImport(nextPlan);
      const parts = [
        result.sites ? `新建站点 ${result.sites}` : '',
        `导入账号 ${result.accounts}`,
        result.proxies ? `代理节点 ${result.proxies}` : '',
        result.skipped ? `已有记录 ${result.skipped}` : '',
      ].filter(Boolean);
      setImportDone(parts.join(' · '));
      setPlan(null);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : '导入失败');
    } finally {
      setImporting(false);
    }
  }

  const canImport = Boolean(fileName)
    && !importing
    && (plan !== null || (needsPassphrase && importPassphrase.length > 0));

  return (
    <Modal open={open} title="数据迁移" onClose={onClose} wide>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-ink-100 p-1 dark:bg-ink-900">
          {([
            ['import', Upload, '导入到本机'],
            ['export', Download, '导出备份'],
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
              <Icon className="size-3.5" />
              {label}
            </button>
          ))}
        </div>

        {tab === 'export' ? (
          <div className="space-y-3">
            <div className="rounded-lg bg-ink-50 px-3 py-2.5 text-xs text-ink-800/70 dark:bg-ink-900 dark:text-ink-100/60">
              将导出 <b className="tabular-nums">{sites.length}</b> 个站点、
              <b className="tabular-nums">{accounts.length}</b> 个账号（含密码）、
              <b className="tabular-nums">{proxies.length}</b> 个代理节点及其绑定关系。
              <span className="mt-1 block text-[11px] text-ink-800/45 dark:text-ink-100/35">
                不含签到历史、抓取的登录态，以及代理认证密码 —— 这些都与本机绑定，换机器后需重新配置。
              </span>
            </div>

            <div className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2.5 dark:bg-amber-950/20">
              <Lock className="mt-0.5 size-3.5 shrink-0 text-amber-700 dark:text-amber-300" />
              <p className="text-[11px] leading-relaxed text-amber-800 dark:text-amber-200">
                文件用你设的口令加密（PBKDF2 + AES-GCM）。
                <b>口令不会保存在任何地方</b> —— 忘了就打不开这个文件，只能重新导出。
              </p>
            </div>

            <Field label="导出口令">
              <input
                type="password"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
                className={inputCls}
                placeholder="用于加密备份文件"
                autoComplete="new-password"
              />
            </Field>
            <Field label="再输一次" hint={passphraseMismatch ? '两次输入不一致' : undefined}>
              <input
                type="password"
                value={confirmPassphrase}
                onChange={(event) => setConfirmPassphrase(event.target.value)}
                className={cn(inputCls, passphraseMismatch && 'ring-2 ring-rose-500/50')}
                autoComplete="new-password"
              />
            </Field>

            {exportError && (
              <p className="text-xs text-rose-600 dark:text-rose-400">{exportError}</p>
            )}
            {exportedName && (
              <p className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
                <Check className="size-3.5" />
                已导出 {exportedName}
              </p>
            )}

            <button
              type="button"
              disabled={!canExport}
              onClick={() => void runExport()}
              className="flex h-10 w-full items-center justify-center gap-1.5 rounded-xl bg-brand-500 text-sm font-semibold text-white shadow-lg shadow-brand-500/25 transition-colors hover:bg-brand-600 disabled:opacity-40 disabled:shadow-none"
            >
              {exporting ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
              {exporting ? '加密中' : '导出备份文件'}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="flex min-h-20 w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-brand-300 bg-brand-50/60 px-4 text-sm font-semibold text-brand-700 transition-colors hover:bg-brand-50 dark:border-brand-800 dark:bg-brand-950/20 dark:text-brand-300"
            >
              <FileUp className="size-4" />
              {fileName || '选择备份文件开始迁移'}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              aria-label="选择备份文件"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void pickFile(file);
                event.target.value = '';
              }}
            />

            {needsPassphrase && (
              <Field label="备份口令" hint="导出这个文件时设置的口令">
                <input
                  type="password"
                  value={importPassphrase}
                  onChange={(event) => setImportPassphrase(event.target.value)}
                  className={inputCls}
                  placeholder="输入导出时设置的口令"
                  autoComplete="current-password"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && canImport) void runImport();
                  }}
                />
              </Field>
            )}

            {importError && (
              <p className="text-xs text-rose-600 dark:text-rose-400">{importError}</p>
            )}

            {plan && (
              <div className="space-y-2">
                <div className="grid grid-cols-4 gap-2">
                  <Stat label="新建站点" value={plan.newSites.length} tone="brand" />
                  <Stat label="导入账号" value={plan.accounts.length} tone="emerald" />
                  <Stat label="代理节点" value={plan.newProxies.length} tone="sky" />
                  <Stat label="已导入过" value={plan.duplicateCount} tone="ink" />
                </div>
                {(plan.reusedSiteCount > 0 || plan.reusedProxyCount > 0) && (
                  <p className="text-[11px] text-ink-800/50 dark:text-ink-100/40">
                    {plan.reusedSiteCount > 0 && `另有 ${plan.reusedSiteCount} 个站点本机已存在，账号会挂到已有站点上。`}
                    {plan.reusedProxyCount > 0 && `${plan.reusedSiteCount > 0 ? ' ' : ''}${plan.reusedProxyCount} 个代理节点本机已存在，按节点名复用。`}
                  </p>
                )}
                {plan.newProxies.length > 0 && (
                  <div className="rounded-lg bg-sky-50 px-3 py-2.5 dark:bg-sky-950/20">
                    <p className="text-[11px] leading-relaxed text-sky-800 dark:text-sky-200">
                      <b>代理端口是导出那台电脑的。</b>导入后请到「代理」面板点「同步节点」，
                      选择本机当前运行的 <code className="rounded bg-sky-100 px-1 dark:bg-sky-900/50">clash-verge.yaml</code>，
                      同名节点会自动补上本机的真实端口。
                    </p>
                    <p className="mt-1 break-all font-mono text-[10px] text-sky-700/70 dark:text-sky-300/60">
                      {CLASH_VERGE_CONFIG_PATH}
                    </p>
                  </div>
                )}
                {plan.unmatched.length > 0 && (
                  <div className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2.5 dark:bg-amber-950/20">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-700 dark:text-amber-300" />
                    <div className="min-w-0 text-[11px] leading-relaxed text-amber-800 dark:text-amber-200">
                      <b>{plan.unmatched.length} 个账号找不到对应站点</b>，不会被导入：
                      <span className="mt-0.5 block truncate" title={plan.unmatched.map((item) => `${item.username} @ ${item.siteLoginUrl}`).join('、')}>
                        {plan.unmatched.slice(0, 3).map((item) => item.username).join('、')}
                        {plan.unmatched.length > 3 ? ` 等 ${plan.unmatched.length} 个` : ''}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {fileName && (
              <button
                type="button"
                disabled={!canImport}
                onClick={() => void runImport()}
                className="flex h-10 w-full items-center justify-center gap-1.5 rounded-lg bg-brand-500 text-sm font-semibold text-white shadow-lg shadow-brand-500/25 transition-colors hover:bg-brand-600 disabled:opacity-40 disabled:shadow-none"
              >
                {importing ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
                {importing ? '正在迁移' : '全部导入到本机'}
              </button>
            )}

            {importDone && (
              <p className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
                <Check className="size-3.5" />
                {importDone}
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'brand' | 'emerald' | 'sky' | 'ink';
}) {
  const tones = {
    brand: 'bg-brand-50 text-brand-700 dark:bg-brand-950/20 dark:text-brand-300',
    emerald: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-300',
    sky: 'bg-sky-50 text-sky-700 dark:bg-sky-950/20 dark:text-sky-300',
    ink: 'bg-ink-100 text-ink-800/70 dark:bg-ink-900 dark:text-ink-100/60',
  } as const;
  return (
    <div className={cn('rounded-lg px-3 py-2.5', tones[tone])}>
      <p className="text-[10px] opacity-70">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}
