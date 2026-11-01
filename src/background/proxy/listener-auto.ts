import { diffListenerPlan, buildListenerPlan, type ListenerPlanEntry } from '@/lib/clash/clash-listeners';
import type { ProxyConfig } from '@/types';
import { parseSubscription } from '@/lib/proxy/proxy-subscription';
import { KEYS, local } from '@/lib/core/storage';

/**
 * listener 自动更新的纯逻辑层。
 *
 * 职责边界:这里只做「订阅文本 + 已存映射 → 新映射 + 新池条目」的推导,
 * 网络拉取与 repository 写入由 background 编排 —— 便于单测与复用。
 *
 * 与零干扰约束一致:本模块绝不碰 Clash/Verge 的任何文件或进程,
 * 输出的 script 由用户本人粘进 Verge。
 */

export interface SubscriptionSourceSettings {
  url: string;
  autoSync: boolean;
  lastCheckedAt?: number;
  lastError?: string;
}

/**
 * 只允许 http(s) 且拒绝本机/内网地址(SSRF),与 fetchSubscription 的闸门保持同一口径。
 * 这里再做一次是因为闹钟路径可能绕过 UI。
 */
export function normalizeSubscriptionUrl(raw: string): string | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  let url: URL;
  try { url = new URL(text); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0'
    || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || host.endsWith('.local') || host === '169.254.169.254') return null;
  return url.href;
}

export interface DriftPlan {
  entries: ListenerPlanEntry[];
  /** 映射里新增的端口条目(仅这些需要 addProxies) */
  addedEntries: ListenerPlanEntry[];
  removedNames: string[];
  /** 仅新增节点的池条目(与 buildListenerPlan 同形,可直接交给 addProxies) */
  poolEntries: Omit<ProxyConfig, 'id'>[];
}

/** 订阅文本 + 已存映射 → 下一步状态(不写库不拉网)。 */
/**
 * 名字是否像机场公告/推广行。
 *
 * 与 proxy-subscription 的 isAirportNotice 同一口径，但那边不导出。这里重复一份
 * 是因为**历史映射里可能已经混进公告行**（早期解析把它们当成节点分配了端口），
 * 必须在每次核对时把它们剔出去，否则那些端口永远占着、还骗用户去测活。
 */
const NOTICE_HINTS = [
  '剩余流量', '套餐到期', '过滤掉', '距离下次', '重置', '官网', '订阅', '有效期',
  '到期时间', '剩余时间', '流量重置', '请勿', '群组', '客服', 'telegram', '教程',
  '电报群', '防失联', 't.me', 'github.com', '客户端', '发布页', '频道',
];
function looksLikeNotice(name: string): boolean {
  const text = name.trim().toLowerCase();
  if (!text) return true;
  return NOTICE_HINTS.some((word) => text.includes(word.toLowerCase()));
}

export function planListenerDrift(subText: string, existing: readonly ListenerPlanEntry[]): DriftPlan {
  const parsed = parseSubscription(subText);
  const names = parsed.unsupportedNames.filter((name) => !looksLikeNotice(name));
  // 历史映射里的公告行也要剔掉:留着会让新节点永远拿不到那个端口
  const cleaned = existing.filter((entry) => !looksLikeNotice(entry.nodeName));
  const drift = diffListenerPlan(names, cleaned);
  const plan = buildListenerPlan([...drift.kept.map((e) => e.nodeName), ...drift.addedNames], undefined, undefined, cleaned);
  const addedNames = new Set(drift.addedNames);
  return {
    entries: plan.entries,
    addedEntries: plan.entries.filter((e) => addedNames.has(e.nodeName)),
    removedNames: drift.removed.map((e) => e.nodeName),
    poolEntries: plan.poolEntries.filter((e) => addedNames.has(e.name)),
  };
}

export async function loadListenerPlan(): Promise<ListenerPlanEntry[]> {
  const value = await local.get<ListenerPlanEntry[]>(KEYS.listenerPlan, []);
  return Array.isArray(value) ? value : [];
}

export async function saveListenerPlan(entries: readonly ListenerPlanEntry[]): Promise<void> {
  await local.set(KEYS.listenerPlan, [...entries]);
}
