import { useRef, useState } from 'react';
import { ClipboardPaste, FileUp, Loader2, RefreshCw } from 'lucide-react';
import type { ProxyConfig } from '@/types';
import { parseSubscription } from '@/lib/proxy/proxy-subscription';
import { cn } from '@/lib/core/cn';

interface Props {
  onImport: (inputs: Omit<ProxyConfig, 'id'>[]) => Promise<{ added: number; skipped: number; upgraded: number }>;
}

/**
 * 导入 Clash Verge 导出的本地监听清单。
 *
 * 每一行形如 `http://127.0.0.1:7902#节点名`。名称来自 fragment，
 * 端口来自地址；重新导入同一端口时，仓库会保留原 id 并更新名称。
 */
export function ClashListenerImport({ onImport }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function importText(raw: string) {
    const parsed = parseSubscription(raw);
    if (!parsed.nodes.length) {
      setNote('没有识别到带端口的节点，请粘贴 http://127.0.0.1:端口#节点名 格式');
      return;
    }

    setBusy(true);
    setNote(null);
    const result = await onImport(parsed.nodes.map((node) => ({
      ...node,
      sourceLabel: 'Clash Verge',
    })));
    const parts = [`已读取 ${parsed.nodes.length} 个节点`];
    if (result.added) parts.push(`新增 ${result.added}`);
    if (result.upgraded) parts.push(`更新名称 ${result.upgraded}`);
    if (result.skipped) parts.push(`跳过 ${result.skipped}`);
    setNote(parts.join(' · '));
    setBusy(false);
  }

  function readFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const value = typeof reader.result === 'string' ? reader.result : '';
      setText(value);
      void importText(value);
    };
    reader.onerror = () => setNote('读取文件失败，请改用粘贴方式');
    reader.readAsText(file);
  }

  return (
    <section className="space-y-3 rounded-xl border border-brand-200 bg-brand-50/70 p-3 dark:border-brand-900/70 dark:bg-brand-950/20">
      <div className="flex items-start gap-2">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-500 text-white">
          <RefreshCw className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h4 className="text-xs font-semibold text-ink-900 dark:text-ink-50">同步 Clash Verge 节点名称</h4>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-800/60 dark:text-ink-100/50">
            导入后按本机端口匹配，列表名称会与 Clash Verge 完全一致，已有账号绑定不会改变。
          </p>
        </div>
        <button
          type="button"
          title="选择清单文件"
          aria-label="选择 Clash Verge 清单文件"
          onClick={() => fileRef.current?.click()}
          className="shrink-0 rounded-lg p-1.5 text-brand-600 hover:bg-brand-500/10 dark:text-brand-400"
        >
          <FileUp className="size-4" />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".txt,.list,.conf,.yaml,.yml,text/plain"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) readFile(file);
            event.target.value = '';
          }}
        />
      </div>

      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={4}
        placeholder={'http://127.0.0.1:7902#美国02aws\nhttp://127.0.0.1:7903#新加坡SG-A'}
        aria-label="Clash Verge 本地监听清单"
        className="w-full resize-y rounded-lg border border-brand-200 bg-white px-2.5 py-2 font-mono text-[10px] leading-relaxed text-ink-900 outline-none placeholder:text-ink-800/30 focus:border-brand-500/60 dark:border-brand-900 dark:bg-ink-950 dark:text-ink-50"
      />

      <button
        type="button"
        disabled={!text.trim() || busy}
        onClick={() => void importText(text)}
        className={cn('flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand-500 px-3 py-2 text-[11px] font-semibold text-white transition-colors hover:bg-brand-600 disabled:opacity-40')}
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ClipboardPaste className="size-3.5" />}
        {busy ? '同步中...' : '同步名称并更新代理池'}
      </button>

      {note && <p className="text-[10px] leading-relaxed text-ink-800/60 dark:text-ink-100/50">{note}</p>}
    </section>
  );
}
