/**
 * 常用凭据的 chrome.storage.local 封装。
 *
 * 与账号主数据（MUTATE_APP 通道）不同，凭据预设属于 UI 本地偏好，
 * 与排序模式（useAccountSortMode）一样由界面直连 chrome.storage.local：
 * 不经过 background，也不进入备份文件的迁移范围。
 *
 * 写入一律经 normalizePresets 归一化，坏数据不会进存储。
 */

import type { CredentialPreset } from '@/types/credential';
import { normalizePresets } from './credential-presets';

/** 常用凭据的存储键 */
export const CREDENTIAL_PRESETS_KEY = 'credentialPresets';

export async function loadCredentialPresets(): Promise<CredentialPreset[]> {
  const result = await chrome.storage.local.get(CREDENTIAL_PRESETS_KEY);
  return normalizePresets(result[CREDENTIAL_PRESETS_KEY]);
}

export async function saveCredentialPresets(presets: CredentialPreset[]): Promise<void> {
  await chrome.storage.local.set({ [CREDENTIAL_PRESETS_KEY]: normalizePresets(presets) });
}

/**
 * 订阅凭据变化（sidepanel / options 两个页面互相同步）。
 * 返回取消订阅函数。
 */
export function onCredentialPresetsChanged(callback: (presets: CredentialPreset[]) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
    if (areaName !== 'local' || !(CREDENTIAL_PRESETS_KEY in changes)) return;
    callback(normalizePresets(changes[CREDENTIAL_PRESETS_KEY]?.newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
