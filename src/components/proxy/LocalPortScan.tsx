import { useState } from 'react';
import { CheckCircle2, Loader2, PlugZap, XCircle } from 'lucide-react';
import type { ProxyConfig } from '@/types';
import { sendMessage } from '@/lib/core/messaging';
import { cn } from '@/lib/core/cn';

interface Props {
  onImport: (inputs: Omit<ProxyConfig, 'id'>[]) => Promise<{ added: number; skipped: number; upgraded?: number }>;
  onBusyChange?: (busy: boolean) => void;
}

const SCHEMES = [
  { value: 'http' as const, label: 'HTTP' },
  { value: 'socks5' as const, label: 'SOCKS5' },
];

type Result = {
  state: 'ok' | 'fail';
  title: string;
  detail?: string;
};

/** Detect and add one browser-compatible local proxy endpoint. */
export function LocalPortScan({ onImport, onBusyChange }: Props) {
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState('7897');
  const [scheme, setScheme] = useState<'http' | 'socks5'>('http');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const portNumber = Number(port);
  const valid = Boolean(host.trim())
    && Number.isInteger(portNumber)
    && portNumber > 0
    && portNumber <= 65535;

  async function detectAndAdd() {
    if (!valid || busy) return;
    setBusy(true);
    onBusyChange?.(true);
    setResult(null);

    try {
      const target = host.trim();
      const response = await sendMessage({
        type: 'SCAN_LOCAL_PORTS',
        host: target,
        ports: [portNumber],
        scheme,
        withExit: true,
      });

      if (!response.ok) {
        setResult({ state: 'fail', title: response.error });
        return;
      }

      const entry = response.feature?.portScan?.entries[0];
      if (!entry?.ok) {
        setResult({
          state: 'fail',
          title: `${scheme.toUpperCase()}://${target}:${portNumber} 不可用`,
          detail: entry?.message ?? '没有检测到可连接的本机代理服务',
        });
        return;
      }

      const imported = await onImport([{
        name: target === '127.0.0.1' && portNumber === 7897
          ? 'Clash 当前出口'
          : `${target}:${portNumber}`,
        sourceLabel: '本机代理',
        scheme,
        host: target,
        port: portNumber,
      }]);

      const action = imported.added
        ? '已加入代理池'
        : imported.upgraded
          ? '已更新代理池'
          : '代理池中已存在';
      const exit = [entry.country, entry.ip].filter(Boolean).join(' · ');
      setResult({
        state: 'ok',
        title: `${action}：${scheme.toUpperCase()}://${target}:${portNumber}`,
        detail: exit ? `当前出口 ${exit} · ${entry.ms}ms` : `连通正常 · ${entry.ms}ms`,
      });
    } catch (error) {
      setResult({
        state: 'fail',
        title: error instanceof Error ? error.message : '检测本机代理失败',
      });
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex items-start gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-500 text-white">
          <PlugZap className="size-4" />
        </span>
        <div className="min-w-0">
          <h4 className="text-xs font-semibold text-ink-900 dark:text-ink-50">添加 Clash 本机出口</h4>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-800/55 dark:text-ink-100/45">
            默认检测 Clash Verge 的 mixed-port 7897。这个端口会跟随 Clash 当前选中的节点，扩展不会切换节点或修改 Clash 配置。
          </p>
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_88px] gap-2">
        <label className="col-span-2 space-y-1 sm:col-span-1">
          <span className="block text-[10px] text-ink-800/55 dark:text-ink-100/45">主机</span>
          <input
            value={host}
            onChange={(event) => setHost(event.target.value)}
            aria-label="本机代理主机"
            autoComplete="off"
            className="h-9 w-full rounded-lg border border-black/8 bg-white px-2.5 text-xs text-ink-900 outline-none focus:border-brand-500/50 focus:ring-2 focus:ring-brand-500/15 dark:border-white/10 dark:bg-ink-900 dark:text-ink-50"
          />
        </label>

        <label className="space-y-1">
          <span className="block text-[10px] text-ink-800/55 dark:text-ink-100/45">端口</span>
          <input
            value={port}
            onChange={(event) => setPort(event.target.value.replace(/\D/g, ''))}
            inputMode="numeric"
            aria-label="本机代理端口"
            className="h-9 w-full rounded-lg border border-black/8 bg-white px-2.5 text-xs tabular-nums text-ink-900 outline-none focus:border-brand-500/50 focus:ring-2 focus:ring-brand-500/15 dark:border-white/10 dark:bg-ink-900 dark:text-ink-50"
          />
        </label>
      </div>

      <div>
        <span className="mb-1 block text-[10px] text-ink-800/55 dark:text-ink-100/45">协议</span>
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-ink-100 p-1 dark:bg-ink-900">
          {SCHEMES.map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => setScheme(item.value)}
              aria-pressed={scheme === item.value}
              className={cn(
                'h-8 rounded-md text-[11px] font-medium transition-colors',
                scheme === item.value
                  ? 'bg-white text-ink-900 shadow-sm dark:bg-ink-800 dark:text-ink-50'
                  : 'text-ink-800/50 hover:text-ink-900 dark:text-ink-100/40 dark:hover:text-ink-50',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <button
        type="button"
        disabled={!valid || busy}
        onClick={() => void detectAndAdd()}
        className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-brand-500 px-4 text-sm font-semibold text-white transition-colors hover:bg-brand-600 disabled:opacity-40"
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
        {busy ? '正在检测出口...' : '检测并加入代理池'}
      </button>

      {result && (
        <div className={cn(
          'flex items-start gap-2 rounded-lg px-3 py-2.5 ring-1',
          result.state === 'ok'
            ? 'bg-emerald-500/10 text-emerald-800 ring-emerald-500/20 dark:text-emerald-200'
            : 'bg-rose-500/10 text-rose-700 ring-rose-500/20 dark:text-rose-300',
        )}>
          {result.state === 'ok'
            ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
            : <XCircle className="mt-0.5 size-4 shrink-0" />}
          <div className="min-w-0">
            <p className="break-words text-[11px] font-medium">{result.title}</p>
            {result.detail && <p className="mt-0.5 break-words text-[10px] opacity-75">{result.detail}</p>}
          </div>
        </div>
      )}
    </section>
  );
}
