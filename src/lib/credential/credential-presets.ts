/**
 * 常用凭据的纯逻辑：候选收集、去重、排序与预设维护。
 *
 * 本文件不接触 chrome.storage —— 存储封装见 credential-store.ts，
 * React 胶水层见 use-credential-presets.ts。所有函数保持纯函数，
 * 便于单元测试与复用（例如将来加自动填充入口）。
 */

import type { Account, SiteConfig } from '@/types';
import type { CredentialCandidate, CredentialKind, CredentialPreset } from '@/types/credential';
import { uid } from '@/lib/core/date';

/** 预设列表上限：防止存储无限膨胀 */
export const MAX_PRESETS = 200;

/**
 * 凭据内容指纹：kind + 规范化用户名 + 密码。
 *
 * 用户名忽略大小写与首尾空白；密码按原文精确比较 —— 同名不同密码视为两条
 * （GitHub 改过密码后新旧密码都会出现，由用户挑对的那条）。
 */
export function credentialFingerprint(kind: CredentialKind, username: string, password: string): string {
  return `${kind}:${username.trim().toLowerCase()}\u0000${password}`;
}

/** 从账号提取指定种类的凭据；缺失或为空时返回 null。 */
export function credentialFromAccount(
  account: Pick<Account, 'username' | 'password' | 'githubUsername' | 'githubPassword'>,
  kind: CredentialKind,
): { username: string; password: string } | null {
  if (kind === 'github') {
    const username = account.githubUsername?.trim() ?? '';
    const password = account.githubPassword ?? '';
    return username && password ? { username, password } : null;
  }
  const username = account.username.trim();
  return username && account.password ? { username, password: account.password } : null;
}

/** 校验手动新增/保存的凭据输入；合法返回 null，否则返回错误文案。 */
export function validatePresetInput(input: {
  kind: CredentialKind;
  username: string;
  password: string;
}): string | null {
  if (input.kind !== 'site' && input.kind !== 'github') return '凭据类型无效';
  if (!input.username.trim()) return '用户名不能为空';
  if (!input.password) return '密码不能为空';
  return null;
}

/** 与当前站点共用登录主机名的站点 id 列表（重复导入的同源站点共享 cookie，凭据互认）。 */
export function sameHostSiteIds(sites: readonly SiteConfig[], siteId: string): string[] {
  const current = sites.find((site) => site.id === siteId);
  if (!current) return [siteId];
  const host = hostnameOf(current.loginUrl);
  if (!host) return [siteId];
  return sites.filter((site) => site.id !== siteId && hostnameOf(site.loginUrl) === host)
    .map((site) => site.id)
    .concat(siteId);
}

function hostnameOf(loginUrl: string): string {
  try {
    return new URL(loginUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export interface CollectAccountOptions {
  /** 编辑账号时排除自身，避免「复制自己」 */
  excludeAccountId?: string;
  /** 只收集这些站点的账号；缺省收集全部（GitHub 凭据跨站点复用） */
  allowedSiteIds?: ReadonlySet<string>;
  /** 站点 id → 站点名，用于候选副标题 */
  siteNameOf?: (siteId: string) => string | undefined;
}

/**
 * 从账号列表收集指定种类的凭据候选。
 *
 * - 空凭据跳过；excludeAccountId 排除；
 * - 按「数组靠后的账号更新」假设倒序遍历，同一指纹只保留最新账号的候选，
 *   并统计 accountCount、汇总出现过的站点；
 * - 返回顺序：第一次遇到（最新账号）在前。
 */
export function collectAccountCandidates(
  accounts: readonly Account[],
  kind: CredentialKind,
  options: CollectAccountOptions = {},
): CredentialCandidate[] {
  const candidates: CredentialCandidate[] = [];
  const byFingerprint = new Map<string, CredentialCandidate>();

  for (let index = accounts.length - 1; index >= 0; index -= 1) {
    const account = accounts[index]!;
    if (account.id === options.excludeAccountId) continue;
    if (options.allowedSiteIds && !options.allowedSiteIds.has(account.siteId)) continue;
    const credential = credentialFromAccount(account, kind);
    if (!credential) continue;

    const fingerprint = credentialFingerprint(kind, credential.username, credential.password);
    const existing = byFingerprint.get(fingerprint);
    if (existing) {
      existing.accountCount = (existing.accountCount ?? 1) + 1;
      if (!existing.siteId) existing.siteId = account.siteId;
      // 保留最新的账号信息；备注只在主候选没有时借用
      if (existing.label === existing.username && account.label?.trim()) {
        existing.label = account.label.trim();
      }
      continue;
    }

    const candidate: CredentialCandidate = {
      id: `account:${account.id}:${kind}`,
      kind,
      username: credential.username,
      password: credential.password,
      label: account.label?.trim() || credential.username,
      origin: 'account',
      accountId: account.id,
      siteId: account.siteId,
      updatedAt: 0,
      accountCount: 1,
    };
    const siteName = options.siteNameOf?.(account.siteId);
    if (siteName) candidate.siteName = siteName;
    byFingerprint.set(fingerprint, candidate);
    candidates.push(candidate);
  }

  return candidates;
}

/**
 * 把手动预设合并进账号候选。
 *
 * - 与账号候选同指纹的预设不新增条目：预设的备注/时间补充到候选上，
 *   并记下 presetId（选中时可回写使用记录）；
 * - 独有指纹的预设追加为 origin='manual' 候选。
 */
export function mergeManualCandidates(
  candidates: CredentialCandidate[],
  presets: readonly CredentialPreset[],
): CredentialCandidate[] {
  const merged = candidates.map((candidate) => ({ ...candidate }));
  const byFingerprint = new Map<string, CredentialCandidate>(
    merged.map((candidate) => [credentialFingerprint(candidate.kind, candidate.username, candidate.password), candidate]),
  );

  for (const preset of presets) {
    const fingerprint = credentialFingerprint(preset.kind, preset.username, preset.password);
    const existing = byFingerprint.get(fingerprint);
    if (existing) {
      existing.presetId = preset.id;
      if (preset.label?.trim() && existing.label === existing.username) {
        existing.label = preset.label.trim();
      }
      if (preset.updatedAt > existing.updatedAt) existing.updatedAt = preset.updatedAt;
      if (preset.lastUsedAt && (!existing.lastUsedAt || preset.lastUsedAt > existing.lastUsedAt)) {
        existing.lastUsedAt = preset.lastUsedAt;
      }
      existing.useCount = Math.max(existing.useCount ?? 0, preset.useCount ?? 0);
      continue;
    }

    const candidate: CredentialCandidate = {
      id: preset.id,
      kind: preset.kind,
      username: preset.username,
      password: preset.password,
      label: preset.label?.trim() || preset.username,
      origin: 'manual',
      presetId: preset.id,
      siteId: preset.siteId,
      updatedAt: preset.updatedAt,
      lastUsedAt: preset.lastUsedAt,
      useCount: preset.useCount,
    };
    byFingerprint.set(fingerprint, candidate);
    merged.push(candidate);
  }

  return merged;
}

/**
 * 候选排序：当前站点的凭据优先 → 最近使用/更新时间近的优先 → 名称字母序 → id 兜底。
 *
 * 稳定排序：输入顺序不影响同分项的先后。
 */
export function rankCandidates(candidates: readonly CredentialCandidate[], currentSiteId?: string): CredentialCandidate[] {
  return [...candidates].sort((a, b) => {
    const aSame = currentSiteId ? a.siteId === currentSiteId : false;
    const bSame = currentSiteId ? b.siteId === currentSiteId : false;
    if (aSame !== bSame) return aSame ? -1 : 1;
    const aRecency = Math.max(a.lastUsedAt ?? 0, a.updatedAt ?? 0);
    const bRecency = Math.max(b.lastUsedAt ?? 0, b.updatedAt ?? 0);
    if (aRecency !== bRecency) return bRecency - aRecency;
    const byName = a.label.localeCompare(b.label);
    if (byName !== 0) return byName;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** 候选 → 手动预设（「存为常用」）；已有 presetId 时复用该 id。 */
export function presetFromCandidate(candidate: CredentialCandidate, now = Date.now()): CredentialPreset {
  const preset: CredentialPreset = {
    id: candidate.presetId ?? uid('cp'),
    kind: candidate.kind,
    username: candidate.username,
    password: candidate.password,
    updatedAt: now,
  };
  if (candidate.label !== candidate.username) preset.label = candidate.label;
  if (candidate.siteId) preset.siteId = candidate.siteId;
  if (candidate.lastUsedAt) preset.lastUsedAt = candidate.lastUsedAt;
  if (candidate.useCount) preset.useCount = candidate.useCount;
  return preset;
}

/**
 * 按 id upsert 一条预设，并合并同指纹的旧条目（避免同名密码存两条）。
 *
 * 同指纹不同 id：保留传入的新条目（以最新输入为准），丢弃旧条目。
 */
export function upsertPreset(presets: readonly CredentialPreset[], preset: CredentialPreset): CredentialPreset[] {
  const fingerprint = credentialFingerprint(preset.kind, preset.username, preset.password);
  return presets
    .filter((item) => item.id !== preset.id && credentialFingerprint(item.kind, item.username, item.password) !== fingerprint)
    .concat(preset);
}

/** 记录一次「选中回填」：lastUsedAt 置为 now，useCount +1。 */
export function markPresetUsed(presets: readonly CredentialPreset[], id: string, now = Date.now()): CredentialPreset[] {
  return presets.map((preset) => (
    preset.id === id
      ? { ...preset, lastUsedAt: now, useCount: (preset.useCount ?? 0) + 1 }
      : preset
  ));
}

export function removePreset(presets: readonly CredentialPreset[], id: string): CredentialPreset[] {
  return presets.filter((preset) => preset.id !== id);
}

/**
 * 防御性解析 storage 里的原始值。
 *
 * 旧版本/手工改坏的数据不能把界面弄崩：逐条校验字段类型，
 * 非法条目直接丢弃，并按 updatedAt 倒序裁剪到 MAX_PRESETS。
 */
export function normalizePresets(raw: unknown): CredentialPreset[] {
  if (!Array.isArray(raw)) return [];

  const seenIds = new Set<string>();
  const byFingerprint = new Map<string, CredentialPreset>();
  const normalized: CredentialPreset[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : '';
    const kind = record.kind === 'site' || record.kind === 'github' ? record.kind : null;
    const username = typeof record.username === 'string' ? record.username.trim() : '';
    const password = typeof record.password === 'string' ? record.password : '';
    if (!id || !kind || !username || !password || seenIds.has(id)) continue;
    seenIds.add(id);

    const preset: CredentialPreset = {
      id,
      kind,
      username,
      password,
      updatedAt: finiteNonNegative(record.updatedAt),
    };
    if (typeof record.label === 'string' && record.label.trim()) preset.label = record.label.trim();
    if (typeof record.siteId === 'string' && record.siteId) preset.siteId = record.siteId;
    const lastUsedAt = finiteNonNegative(record.lastUsedAt);
    if (lastUsedAt > 0) preset.lastUsedAt = lastUsedAt;
    const useCount = typeof record.useCount === 'number' && Number.isFinite(record.useCount)
      ? Math.max(0, Math.floor(record.useCount))
      : 0;
    if (useCount > 0) preset.useCount = useCount;

    // 同指纹保留更新时间较新的一条（新条目靠后 → 逐个覆盖）
    byFingerprint.set(credentialFingerprint(kind, username, password), preset);
    normalized.push(preset);
  }

  const unique = normalized.filter((preset) => (
    byFingerprint.get(credentialFingerprint(preset.kind, preset.username, preset.password)) === preset
  ));

  return unique
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, MAX_PRESETS);
}

function finiteNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}
