import { useEffect, useRef, useState } from 'react';
import { Download, Eye, EyeOff, Loader2, Server, Wand2 } from 'lucide-react';
import type { ClashControllerConnection, ClashControllerSettings } from '@/lib/clash/clash-controller';
import {
  CLASH_CONTROLLER_SETTINGS_KEY,
  DEFAULT_CLASH_CONTROLLER_ADDRESS,
  normalizeClashControllerAddress,
} from '@/lib/clash/clash-controller';
import { CLASH_CONTROLLER_NOT_FOUND } from '@/lib/clash/clash-controller-detect';
import { listenerExitToPoolEntry } from '@/lib/clash/clash-listeners';
import { sendMessage } from '@/lib/core/messaging';
import { cn } from '@/lib/core/cn';
import type { ProxyConfig } from '@/types';

/**
 * 「只导入一次订阅，剩下全自动」的入口。
 *
 * 安全边界：本组件对内核只读 —— 只 GET /proxies 与 GET /listeners，
 * 绝不写入或修改 Clash Verge 的任何配置，也绝不调用会改内核状态的接口
 * （尤其是不碰 PUT /proxies，不切换当前选中节点）。
 *
 * 内核里「一个节点一个本地端口」的 listeners 段是用户在自己的内核配置里加的，
 * 扩展只负责把这些固定端口收进代理池，不替用户改配置。
 */

interface Props {
  /** 把内核里「还没有本地出口」的节点名交给上层，用于点亮「生成 listeners 配置」面板 */
  onNamesRead?: (names: string[]) => void;
  /** 使用普通本机代理端口，无需启用 HTTP 控制接口。 */
  onUseLocalProxy?: () => void;
  onSync?: (inputs: Omit<ProxyConfig, 'id'>[]) => Promise<{ added: number; skipped: number; upgraded: number; removed: number; keptInUse: number }>;
}

type Note = { tone: 'ok' | 'info' | 'err'; text: string };

export function ClashControllerImport({ onNamesRead, onUseLocalProxy, onSync }: Props) {
  const [settings, setSettings] = useState<ClashControllerSettings>({
    address: DEFAULT_CLASH_CONTROLLER_ADDRESS,
    secret: '',
  });
  const [showSecret, setShowSecret] = useState(false);
  const [busy, setBusy] = useState<'detect' | 'sync' | null>(null);
  const [note, setNote] = useState<Note | null>(null);

  const valid = Boolean(normalizeClashControllerAddress(settings.address));

  // 挂载时读回上次填的地址/密钥；读取失败就用默认值静默降级，不影响手动填写。
  useEffect(() => {
    let disposed = false;
    void chrome.storage.local.get(CLASH_CONTROLLER_SETTINGS_KEY).then((stored) => {
      if (disposed) return;
      const value = stored[CLASH_CONTROLLER_SETTINGS_KEY];
      if (!value || typeof value !== 'object') return;
      const address = (value as { address?: unknown }).address;
      const secret = (value as { secret?: unknown }).secret;
      setSettings((current) => ({
        address: typeof address === 'string' && address ? address : current.address,
        secret: typeof secret === 'string' ? secret : current.secret,
      }));
    }).catch(() => {
      // 读取失败不覆盖本页输入，也不写回任何东西。
    });
    return () => {
      disposed = true;
    };
  }, []);

  // 首次渲染跳过，避免把默认值写进存储；之后每次改动都落盘一次。
  // 存储失败静默：只是下次要重填，不该挡住同步。
  const hydrated = useRef(false);
  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    void chrome.storage.local
      .set({ [CLASH_CONTROLLER_SETTINGS_KEY]: settings })
      .catch(() => {});
  }, [settings]);

  function controller(): ClashControllerConnection {
    return {
      address: settings.address,
      ...(settings.secret.trim() ? { secret: settings.secret } : {}),
    };
  }

  async function detect() {
    if (busy) return;
    setBusy('detect');
    setNote(null);
    try {
      const response = await sendMessage({ type: 'DETECT_CLASH_CONTROLLER', controller: controller() });
      if (!response.ok) throw new Error(response.error);
      const found = response.feature?.clashControllerDetect;
      if (!found || found.status !== 'found') {
        setNote({ tone: 'info', text: found?.message ?? CLASH_CONTROLLER_NOT_FOUND });
        return;
      }
      setSettings((current) => ({
        address: found.address,
        // 自动探测换了端口后，旧地址的密钥不能被后续同步发送给另一项本机服务。
        secret: normalizeClashControllerAddress(current.address) === found.address ? current.secret : '',
      }));
      setNote(found.needsSecret
        ? { tone: 'info', text: '该 HTTP 接口要求认证；请核对它是 Clash 控制接口，并填写正确密钥后再检测。接口可达不等于代理节点不可用。' }
        : { tone: 'ok', text: '已验证 Clash/Mihomo HTTP 控制接口，地址已填入' });
    } catch (error) {
      setNote({ tone: 'err', text: error instanceof Error ? error.message : '自动检测失败' });
    } finally {
      setBusy(null);
    }
  }

  /** GET /proxies 读全部叶子节点名；失败返回 null，交给调用方决定是否跳过。 */
  async function readLeafNames(): Promise<string[] | null> {
    const response = await sendMessage({ type: 'READ_CLASH_PROXIES', controller: controller() });
    if (!response.ok) return null;
    return response.feature?.clashController?.names ?? [];
  }

  async function syncExits() {
    if (!valid || busy) return;
    setBusy('sync');
    setNote(null);
    try {
      const exitsResponse = await sendMessage({
        type: 'READ_CLASH_LISTENER_EXITS',
        controller: controller(),
      });
      if (!exitsResponse.ok) throw new Error(exitsResponse.error);
      const exits = exitsResponse.feature?.clashListenerExits?.exits ?? [];

      // 读一次节点总表，算出「还没有本地出口」的节点交给生成面板。
      // 只交缺口的节点：已有 listener 的节点再生成一遍会与内核里已有的重复。
      const leafNames = await readLeafNames();
      if (leafNames) {
        const exited = new Set(exits.map((exit) => exit.nodeName));
        onNamesRead?.(leafNames.filter((name) => !exited.has(name)));
      }

      if (!exits.length) {
        setNote({
          tone: 'info',
          text: '内核里还没有每节点本地端口：请在 Clash Verge 的这份订阅里加一段 listeners（扩展代理管理→导入页可以生成），重载后再点同步',
        });
        return;
      }

      const inputs = exits.map((exit) => listenerExitToPoolEntry(exit));
      const result = onSync ? await onSync(inputs) : await (async () => {
        const response = await sendMessage({ type: 'SYNC_CLASH_PROXIES', inputs });
        if (!response.ok) throw new Error(response.error);
        return response.feature?.clashConfigSync;
      })();
      setNote({
        tone: 'ok',
        text: `已同步 ${exits.length} 个出口（新增 ${result?.added ?? 0} / 补全 ${result?.upgraded ?? 0} / 已存在 ${result?.skipped ?? 0}${result?.keptInUse ? ` / 保留在用旧出口 ${result.keptInUse}` : ''}）`,
      });
    } catch (error) {
      setNote({ tone: 'err', text: error instanceof Error ? error.message : '同步内核出口失败' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-brand-500/25 bg-white p-3 dark:border-brand-500/20 dark:bg-ink-950">
      <div className="flex items-start gap-2">
        <Server className="mt-0.5 size-4 shrink-0 text-brand-500" />
        <div className="min-w-0">
          <p className="text-xs font-semibold text-ink-900 dark:text-ink-50">Clash HTTP 控制接口（同步节点用）</p>
          <p className="mt-0.5 text-[10px] leading-relaxed text-ink-800/55 dark:text-ink-100/45">
            只读读取内核的节点与本地出口，不修改配置或切换节点。这里检测的是 HTTP 控制接口，不是内核进程。
            Clash Verge 若仅使用 Windows 命名管道，需要另行启用外部控制器（HTTP）才能同步；代理端口 7897 不等于控制端口 9097。
          </p>
        </div>
      </div>

      <button
        type="button"
        disabled={busy !== null}
        onClick={() => void detect()}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-ink-100 px-3 py-2 text-[11px] font-semibold text-ink-900 transition-colors hover:bg-ink-200 disabled:opacity-40 dark:bg-ink-900 dark:text-ink-50 dark:hover:bg-ink-800"
      >
        {busy === 'detect' ? <Loader2 className="size-3.5 animate-spin" /> : <Wand2 className="size-3.5" />}
        {busy === 'detect' ? '正在检测...' : '检测 HTTP 控制接口'}
      </button>

      <div className="grid gap-2 sm:grid-cols-[1fr_1fr]">
        <label className="space-y-1">
          <span className="block text-[10px] text-ink-800/55 dark:text-ink-100/45">Controller 地址</span>
          <input
            value={settings.address}
            onChange={(event) => setSettings((current) => ({ ...current, address: event.target.value }))}
            placeholder="127.0.0.1:9097"
            aria-label="Clash controller 地址"
            className="h-8 w-full rounded-md border border-black/8 bg-white px-2 text-[11px] text-ink-900 outline-none focus:border-brand-500/50 dark:border-white/10 dark:bg-ink-900 dark:text-ink-50"
          />
        </label>

        <label className="space-y-1">
          <span className="block text-[10px] text-ink-800/55 dark:text-ink-100/45">密钥</span>
          <span className="relative block">
            <input
              type={showSecret ? 'text' : 'password'}
              value={settings.secret}
              onChange={(event) => setSettings((current) => ({ ...current, secret: event.target.value }))}
              placeholder="未设置密钥可留空"
              aria-label="Clash controller 密钥"
              className="h-8 w-full rounded-md border border-black/8 bg-white pl-2 pr-8 text-[11px] text-ink-900 outline-none focus:border-brand-500/50 dark:border-white/10 dark:bg-ink-900 dark:text-ink-50"
            />
            <button
              type="button"
              onClick={() => setShowSecret((value) => !value)}
              title={showSecret ? '隐藏密钥' : '显示密钥'}
              aria-label={showSecret ? '隐藏 Clash 密钥' : '显示 Clash 密钥'}
              className="absolute right-1 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded text-ink-800/45 hover:bg-black/5 dark:text-ink-100/40 dark:hover:bg-white/5"
            >
              {showSecret ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </button>
          </span>
        </label>
      </div>

      {!valid && settings.address.trim() && (
        <p className="text-[10px] text-rose-600 dark:text-rose-400">地址格式无效，请填写端口、主机:端口或 http(s) 地址</p>
      )}

      <button
        type="button"
        disabled={!valid || busy !== null}
        onClick={() => void syncExits()}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand-500 px-3 py-2 text-[11px] font-semibold text-white transition-colors hover:bg-brand-600 disabled:opacity-40"
      >
        {busy === 'sync' ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
        {busy === 'sync' ? '正在同步...' : '同步内核出口到代理池'}
      </button>

      {onUseLocalProxy && (
        <button
          type="button"
          onClick={onUseLocalProxy}
          className="text-[11px] font-medium text-brand-600 underline dark:text-brand-300"
        >
          只使用当前 Clash 出口（无需控制接口）
        </button>
      )}

      {note && (
        <p
          role="status"
          className={cn(
            'text-[10px] leading-relaxed',
            note.tone === 'ok' && 'text-emerald-600 dark:text-emerald-400',
            note.tone === 'info' && 'text-amber-700 dark:text-amber-400',
            note.tone === 'err' && 'text-rose-600 dark:text-rose-400',
          )}
        >
          {note.text}
        </p>
      )}
    </div>
  );
}
