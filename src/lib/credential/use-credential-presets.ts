/**
 * 常用凭据的 React 胶水层：预设订阅 + 账号候选组装 + 增删改动作。
 *
 * 组件里不要自己拼候选 —— 全部经 optionsFor() 取：
 * 站点账密候选限定「本站 / 同主机站点」的账号，GitHub 候选跨站点，
 * 手动预设按 kind 合并，最后统一排序（本站优先 → 最近使用优先 → 名称）。
 */

import { useEffect, useState } from 'react';
import { uid } from '@/lib/core/date';
import { useAppStore } from '@/stores/app-store';
import type { CredentialCandidate, CredentialKind, CredentialPreset } from '@/types/credential';
import {
  collectAccountCandidates,
  markPresetUsed,
  mergeManualCandidates,
  rankCandidates,
  removePreset,
  sameHostSiteIds,
  upsertPreset,
  validatePresetInput,
} from './credential-presets';
import { loadCredentialPresets, onCredentialPresetsChanged, saveCredentialPresets } from './credential-store';

export interface SavePresetInput {
  kind: CredentialKind;
  username: string;
  password: string;
  label?: string;
  /** kind='site' 时记录来源站点，用于排序优先 */
  siteId?: string;
}

export interface UseCredentialPresets {
  /** 已归一化的手动预设（订阅 storage 变化实时更新） */
  presets: CredentialPreset[];
  /** 「存为常用」；返回错误文案或 null（成功）。同指纹旧预设被新输入替换。 */
  saveAsPreset: (input: SavePresetInput) => Promise<string | null>;
  /** 改名；label 为空则清除备注 */
  renamePreset: (id: string, label: string) => Promise<void>;
  deletePreset: (id: string) => Promise<void>;
  /** 选中回填后调用：手动预设记录使用时间与次数，账号来源候选无副作用 */
  markUsed: (candidate: CredentialCandidate) => void;
  /** 组装并排序某类凭据的下拉候选 */
  optionsFor: (
    kind: CredentialKind,
    siteId: string,
    opts?: { excludeAccountId?: string },
  ) => CredentialCandidate[];
}

export function useCredentialPresets(): UseCredentialPresets {
  const [presets, setPresets] = useState<CredentialPreset[]>([]);
  const accounts = useAppStore((state) => state.accounts);
  const sites = useAppStore((state) => state.sites);

  useEffect(() => {
    // 测试环境（jsdom）没有 chrome —— 静默降级为空列表，组件仍可渲染
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    let alive = true;
    void loadCredentialPresets().then((list) => {
      if (alive) setPresets(list);
    });
    const off = onCredentialPresetsChanged((list) => {
      if (alive) setPresets(list);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  async function commit(next: CredentialPreset[]) {
    setPresets(next);
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await saveCredentialPresets(next);
    }
  }

  const siteNameOf = (siteId: string) => sites.find((site) => site.id === siteId)?.name;

  return {
    presets,

    async saveAsPreset(input) {
      const error = validatePresetInput(input);
      if (error) return error;
      const now = Date.now();
      const next = upsertPreset(presets, {
        id: uid('cp'),
        kind: input.kind,
        username: input.username.trim(),
        password: input.password,
        updatedAt: now,
        ...(input.label?.trim() ? { label: input.label.trim() } : {}),
        ...(input.siteId ? { siteId: input.siteId } : {}),
      });
      await commit(next);
      return null;
    },

    async renamePreset(id, label) {
      const next = presets.map((preset) => (
        preset.id === id
          ? {
              ...preset,
              ...(label.trim() ? { label: label.trim() } : {}),
              updatedAt: Date.now(),
            }
          : preset
      ));
      if (label.trim() === '') {
        // 清空备注：删除 label 字段
        return commit(next.map((preset) => {
          if (preset.id !== id) return preset;
          const { label: _label, ...rest } = preset;
          return rest;
        }));
      }
      return commit(next);
    },

    async deletePreset(id) {
      return commit(removePreset(presets, id));
    },

    markUsed(candidate) {
      if (!candidate.presetId) return;
      if (!presets.some((preset) => preset.id === candidate.presetId)) return;
      void commit(markPresetUsed(presets, candidate.presetId));
    },

    optionsFor(kind, siteId, opts) {
      const allowedSiteIds = kind === 'site'
        ? new Set(sameHostSiteIds(sites, siteId))
        : undefined;
      const collected = collectAccountCandidates(accounts, kind, {
        excludeAccountId: opts?.excludeAccountId,
        allowedSiteIds,
        siteNameOf,
      });
      const merged = mergeManualCandidates(
        collected,
        presets.filter((preset) => preset.kind === kind),
      );
      return rankCandidates(merged, siteId);
    },
  };
}
