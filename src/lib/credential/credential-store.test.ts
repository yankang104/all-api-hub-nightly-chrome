import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CredentialPreset } from '@/types/credential';
import {
  CREDENTIAL_PRESETS_KEY,
  loadCredentialPresets,
  onCredentialPresetsChanged,
  saveCredentialPresets,
} from './credential-store';

type StorageListener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void;

function stubChrome(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  const listeners = new Set<StorageListener>();
  const chromeStub = {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: store.get(key) })),
        set: vi.fn(async (values: Record<string, unknown>) => {
          const changes: Record<string, chrome.storage.StorageChange> = {};
          for (const [key, value] of Object.entries(values)) {
            const oldValue = store.get(key);
            store.set(key, value);
            changes[key] = { oldValue, newValue: value };
          }
          for (const listener of [...listeners]) listener(changes, 'local');
        }),
        remove: vi.fn(async (key: string) => { store.delete(key); }),
      },
      onChanged: {
        addListener: (fn: StorageListener) => listeners.add(fn),
        removeListener: (fn: StorageListener) => listeners.delete(fn),
      },
    },
  };
  vi.stubGlobal('chrome', chromeStub);
  return { store, listeners };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const preset: CredentialPreset = { id: 'cp1', kind: 'github', username: 'gh', password: 'p', updatedAt: 1 };

describe('credential-store', () => {
  it('load 读不到时返回空数组，读到坏数据时归一化', async () => {
    stubChrome();
    expect(await loadCredentialPresets()).toEqual([]);

    stubChrome({ [CREDENTIAL_PRESETS_KEY]: [{ id: 'cp1', kind: 'site', username: ' u ', password: 'p', updatedAt: 3 }, { bad: true }] });
    expect(await loadCredentialPresets()).toEqual([
      { id: 'cp1', kind: 'site', username: 'u', password: 'p', updatedAt: 3 },
    ]);
  });

  it('save 写入归一化后的列表', async () => {
    const { store } = stubChrome();
    await saveCredentialPresets([
      preset,
      { id: 'bad', kind: 'site', username: '', password: 'x', updatedAt: 2 } as CredentialPreset,
    ]);
    expect(store.get(CREDENTIAL_PRESETS_KEY)).toEqual([preset]);
  });

  it('onCredentialPresetsChanged 只响应本键的 local 变化，返回取消函数', () => {
    const { listeners } = stubChrome();
    const callback = vi.fn();
    const off = onCredentialPresetsChanged(callback);

    for (const listener of [...listeners]) listener({ other: { newValue: 1 } }, 'local');
    expect(callback).not.toHaveBeenCalled();

    for (const listener of [...listeners]) listener({ [CREDENTIAL_PRESETS_KEY]: { newValue: [preset] } }, 'sync');
    expect(callback).not.toHaveBeenCalled();

    for (const listener of [...listeners]) listener({ [CREDENTIAL_PRESETS_KEY]: { newValue: [preset] } }, 'local');
    expect(callback).toHaveBeenCalledWith([preset]);

    off();
    expect(listeners.size).toBe(0);
  });
});
