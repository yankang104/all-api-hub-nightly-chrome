import { useState } from 'react';
import { ClipboardPaste, Download, Link2, Loader2 } from 'lucide-react';
import type { ProxyConfig } from '@/types';
import { sendMessage } from '@/lib/core/messaging';
import { KEYS, local } from '@/lib/core/storage';
import { cn } from '@/lib/core/cn';
import { parseSubscription, type SkippedGroup } from '@/lib/proxy/proxy-subscription';

interface Props {
  onImport: (inputs: Omit<ProxyConfig, 'id'>[]) => Promise<{
    added: number;
    skipped: number;
    upgraded: number;
  }>;
  onNamesParsed?: (names: string[]) => void;
  onBusyChange?: (busy: boolean) => void;
}

type Note = { tone: 'ok' | 'info' | 'err'; text: string; hint?: string };

/**
 * 一整份订阅全是浏览器不能直连的协议时该说什么。
 *
 * 这不是错误，是机场订阅的**默认形态** —— vmess/vless/trojan/hysteria2 这些协议
 * `chrome.proxy` 一个都不认。在这里报「导入失败」会让用户以为功能坏了，而真正
 * 有用的信息是「下一步点哪里」：节点名已经交给 listeners 生成面板了。
 */
function unsupportedOnlyNote(skipped: readonly SkippedGroup[], nodeCount: number): Note {
  const schemes = [...new Set(
    skipped
      .filter((group) => group.reason === 'unsupported-scheme' && group.scheme)
      .map((group) => group.scheme!),
  )];
  return {
    tone: 'info',
    text: `识别到 ${nodeCount} 个节点，都是浏览器不能直连的协议${schemes.length ? `（${schemes.join('、')}）` : ''}。`
      + '已在下方列出它们：复制 listeners 配置 → 粘进 Clash Verge 的 Merge / 扩展配置 → 重载 → 回来点「加入代理池」。',
    hint: '只想先用起来？展开下面的「检测一个本地端口」，默认 7897 就是 Clash 当前选中的出口（所有账号共用同一个出口）。',
  };
}

/** One-click subscription and pasted endpoint import. */
export function SubscriptionImport({ onImport, onNamesParsed, onBusyChange }: Props) {
  const [url, setUrl] = useState('');
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);

  async function importText(text: string) {
    const parsed = parseSubscription(text);
    onNamesParsed?.(parsed.unsupportedNames);

    if (!parsed.nodes.length) {
      // 先把节点名交给上层（listeners 面板要靠它们生成配置），再决定说什么。
      // 有节点名时**不是**失败：这是订阅的正常形态，用户需要的是下一步。
      if (parsed.unsupportedNames.length) {
        setNote(unsupportedOnlyNote(parsed.skipped, parsed.unsupportedNames.length));
        return;
      }
      throw new Error('没有识别到代理地址，请使用 host:port 或 http/socks 地址');
    }

    const inputs = parsed.nodes.map((node) => (
      isLoopbackHost(node.host) ? { ...node, sourceLabel: 'Clash Verge' } : node
    ));
    const result = await onImport(inputs);
    const parts = [
      result.added ? `新增 ${result.added} 个` : '',
      result.upgraded ? `补全 ${result.upgraded} 个` : '',
      result.skipped ? `已有 ${result.skipped} 个` : '',
      parsed.unsupportedNames.length ? `另有 ${parsed.unsupportedNames.length} 个节点需要 Clash listener` : '',
    ].filter(Boolean);
    setNote({ tone: 'ok', text: parts.length ? parts.join('，') : '代理已经在列表中' });
  }

  async function importFromUrl() {
    if (!url.trim() || busy) return;
    setBusy(true);
    onBusyChange?.(true);
    setNote(null);
    try {
      const response = await sendMessage({ type: 'FETCH_SUBSCRIPTION', url: url.trim() });
      if (!response.ok) throw new Error(response.error);
      /*
       * 记住订阅源。自动更新(6 小时闹钟 + 面板「立即检查」)要靠它,
       * 换电脑时也会随备份一起走 —— 这是「一次配置,处处可用」的关键。
       * 只存本地:URL 里带 token,不进任何远端。
       */
      await local.set(KEYS.subscriptionSource, {
        url: url.trim(),
        autoSync: true,
        lastCheckedAt: Date.now(),
      }).catch(() => {});
      await importText(response.feature?.subscription?.text ?? '');
    } catch (error) {
      setNote({ tone: 'err', text: error instanceof Error ? error.message : '订阅导入失败' });
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  }

  async function importPasted() {
    if (!pasted.trim() || busy) return;
    setBusy(true);
    onBusyChange?.(true);
    setNote(null);
    try {
      await importText(pasted);
    } catch (error) {
      setNote({ tone: 'err', text: error instanceof Error ? error.message : '代理导入失败' });
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900/40">
      <div className="flex items-center gap-2">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-emerald-600 text-white">
          <Link2 className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">订阅地址</p>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">粘贴地址后直接导入</p>
        </div>
      </div>

      <div className="flex gap-2">
        <input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void importFromUrl();
          }}
          placeholder="https://..."
          aria-label="代理订阅地址"
          className="h-10 min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 text-[13px] text-slate-900 outline-none placeholder:text-slate-400 focus:border-blue-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        />
        <button
          type="button"
          disabled={!url.trim() || busy}
          onClick={() => void importFromUrl()}
          className="flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3 text-[13px] font-medium text-white hover:bg-blue-700 disabled:opacity-40"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
          导入
        </button>
      </div>

      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[13px] font-medium text-slate-600 dark:text-slate-300">
          <ClipboardPaste className="size-3.5" />
          直接粘贴代理地址
        </summary>
        <div className="mt-2 space-y-2">
          <textarea
            value={pasted}
            onChange={(event) => setPasted(event.target.value)}
            placeholder={'127.0.0.1:7890\nsocks5://127.0.0.1:7891'}
            aria-label="代理地址列表"
            rows={4}
            className="w-full resize-y rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-[13px] leading-relaxed text-slate-900 outline-none placeholder:text-slate-400 focus:border-blue-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          />
          <button
            type="button"
            disabled={!pasted.trim() || busy}
            onClick={() => void importPasted()}
            className="flex h-10 w-full items-center justify-center gap-1.5 rounded-lg bg-blue-600 text-[13px] font-medium text-white hover:bg-blue-700 disabled:opacity-40"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ClipboardPaste className="size-3.5" />}
            导入这些地址
          </button>
        </div>
      </details>

      {note && (
        <div
          role="status"
          className={cn(
            'space-y-1 rounded-md px-3 py-2 text-xs leading-relaxed',
            note.tone === 'ok' && 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/25 dark:text-emerald-300',
            note.tone === 'info' && 'bg-amber-50 text-amber-700 dark:bg-amber-950/25 dark:text-amber-300',
            note.tone === 'err' && 'bg-rose-50 text-rose-700 dark:bg-rose-950/25 dark:text-rose-300',
          )}
        >
          <p>{note.text}</p>
          {note.hint && <p className="opacity-75">{note.hint}</p>}
        </div>
      )}
    </div>
  );
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}
