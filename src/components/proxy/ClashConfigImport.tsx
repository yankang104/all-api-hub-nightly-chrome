import { useRef, useState } from 'react';
import { FileUp, Loader2, RefreshCw } from 'lucide-react';
import type { ProxyConfig } from '@/types';
import { CLASH_VERGE_CONFIG_PATH, parseClashListenerConfig } from '@/lib/clash/clash-config';
import { cn } from '@/lib/core/cn';

interface Props {
  onSync: (inputs: Omit<ProxyConfig, 'id'>[]) => Promise<{ added: number; skipped: number; upgraded: number; removed: number; keptInUse: number }>;
  /** 配置里有节点但没有固定 listener 时，交给上层生成 listener 方案。 */
  onMissingNames?: (names: string[]) => void;
}

type ImportStatus = { ok: boolean; text: string; missingNames?: string[] };

export function ClashConfigImport({ onSync, onMissingNames }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<ImportStatus | null>(null);

  async function importFile(file: File) {
    setBusy(true);
    setStatus(null);
    onMissingNames?.([]);
    try {
      const parsed = parseClashListenerConfig(await file.text());
      if (!parsed.nodes.length && !parsed.catalog.missingListenerNames.length) {
        const nodeText = parsed.catalog.detected ? `已读到 ${parsed.catalog.realNodes} 个真实节点，但` : '';
        setStatus({ ok: false, text: `${nodeText}没有节点配置独立 HTTP/SOCKS listener` });
        return;
      }
      onMissingNames?.(parsed.catalog.missingListenerNames);
      const missingNodes: Omit<ProxyConfig, 'id'>[] = parsed.catalog.missingListenerNames.map((name) => ({
        name,
        scheme: 'http',
        host: '-',
        port: 0,
        nameOnly: true,
        sourceLabel: 'Clash Verge',
      }));
      const result = await onSync(parsed.nodes.concat(missingNodes));
      if (parsed.catalog.detected) {
        const details = [
          file.name ? file.name : '',
          `真实节点 ${parsed.catalog.realNodes}`,
          `可绑定 ${parsed.catalog.fixedNodes}/${parsed.catalog.realNodes}`,
          parsed.catalog.missingListenerNames.length ? `缺 listener ${parsed.catalog.missingListenerNames.length}` : '',
          parsed.catalog.groupListeners ? `忽略策略组 ${parsed.catalog.groupListeners}` : '',
          parsed.catalog.staleListeners ? `忽略失效项 ${parsed.catalog.staleListeners}` : '',
          result.removed ? `清理旧出口 ${result.removed}` : '',
          // 被账号/站点绑定的旧出口不会删；必须说出来，否则用户会以为它们已经没了
          result.keptInUse ? `保留仍在使用的旧出口 ${result.keptInUse}（账号绑定不受影响）` : '',
        ].filter(Boolean);
        setStatus({
          ok: true,
          text: details.join(' · '),
          missingNames: parsed.catalog.missingListenerNames,
        });
      } else {
        setStatus({
          ok: true,
          text: `同步 ${parsed.nodes.length} 个固定出口${result.keptInUse ? ` · 保留仍在使用的旧出口 ${result.keptInUse}` : ''}`,
        });
      }
    } catch (error) {
      setStatus({ ok: false, text: error instanceof Error ? `读取失败：${error.message}` : '读取 Clash 配置失败' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-brand-200 bg-brand-50/60 p-3 sm:flex-row sm:items-center dark:border-brand-900/70 dark:bg-brand-950/20">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-500 text-white">
        <RefreshCw className={cn('size-4', busy && 'animate-spin')} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-ink-900 dark:text-ink-50">Clash Verge 固定节点</p>
        <p className={cn('mt-0.5 text-[10px] leading-relaxed', status?.ok === false ? 'text-rose-600 dark:text-rose-400' : 'text-ink-800/55 dark:text-ink-100/45')}>
          {status?.text ?? '选择当前运行的 clash-verge.yaml；profiles 配置也能读取，缺少 listener 时会在下方生成配置'}
        </p>
        {!status && (
          // 文件对话框里可以直接把这一行粘到地址栏，不用在资源管理器里翻。
          // 用 %APPDATA% 而不是写死 C:\Users\<用户名> —— 后者用户往往会把
          // 尖括号一起粘进去。
          <p className="mt-1 break-all font-mono text-[10px] text-ink-800/40 dark:text-ink-100/30">
            {CLASH_VERGE_CONFIG_PATH}
          </p>
        )}
        {status?.missingNames?.length ? (
          <p className="mt-0.5 truncate text-[10px] text-amber-700 dark:text-amber-300" title={status.missingNames.join('、')}>
            无固定端口：{status.missingNames.join('、')}
          </p>
        ) : null}
      </div>
      <button type="button" disabled={busy} onClick={() => inputRef.current?.click()} className="flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-brand-500 px-3 text-xs font-semibold text-white transition-colors hover:bg-brand-600 disabled:opacity-40">
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <FileUp className="size-3.5" />}
        {busy ? '同步中' : '同步节点'}
      </button>
      <input ref={inputRef} type="file" accept=".yaml,.yml,text/yaml,text/x-yaml,text/plain" aria-label="选择 Clash Verge 配置文件" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = ''; }} />
    </div>
  );
}
