import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountSortSelect } from './AccountSortSelect';
import { ACCOUNT_SORT_STORAGE_KEY, useAccountSortMode } from './useAccountSortMode';

type StorageListener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('账号排序选择和偏好同步', () => {
  let root: Root;
  let container: HTMLDivElement;
  let stored: Record<string, unknown>;
  let listeners: Set<StorageListener>;
  let get: ReturnType<typeof vi.fn>;
  let set: ReturnType<typeof vi.fn>;
  let errors: unknown[];

  function broadcast(value: unknown, areaName = 'local') {
    for (const listener of listeners) {
      listener({ [ACCOUNT_SORT_STORAGE_KEY]: { newValue: value } }, areaName);
    }
  }

  function Harness({ compact = false }: { compact?: boolean }) {
    const [mode, save] = useAccountSortMode();
    return createElement(AccountSortSelect, {
      value: mode,
      compact,
      onChange: (next) => { void save(next).catch((error: unknown) => errors.push(error)); },
    });
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    stored = {};
    listeners = new Set();
    errors = [];
    get = vi.fn(async () => ({ ...stored }));
    set = vi.fn(async (patch: Record<string, unknown>) => {
      Object.assign(stored, patch);
      broadcast(patch[ACCOUNT_SORT_STORAGE_KEY]);
    });
    vi.stubGlobal('chrome', {
      storage: {
        local: { get, set },
        onChanged: {
          addListener: (listener: StorageListener) => listeners.add(listener),
          removeListener: (listener: StorageListener) => listeners.delete(listener),
        },
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    expect(listeners.size).toBe(0);
    container.remove();
    vi.unstubAllGlobals();
  });

  function selects() {
    return [...container.querySelectorAll<HTMLSelectElement>('select[aria-label="账号排序"]')];
  }

  function selectAt(index = 0): HTMLSelectElement {
    const select = selects()[index];
    if (!select) throw new Error(`未找到第 ${index + 1} 个账号排序选择框`);
    return select;
  }

  async function choose(value: string, index = 0) {
    await act(async () => {
      const select = selectAt(index);
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  it('默认明确显示名称 A→Z，侧栏提供三种可选方式', async () => {
    await act(async () => root.render(createElement(Harness, { compact: true })));

    expect(selectAt().value).toBe('name-asc');
    expect([...selectAt().options].map((option) => option.textContent))
      .toEqual(['名称 A→Z（默认）', '名称 Z→A', '添加顺序']);
    expect(container.textContent).toContain('账号排序');
    expect(set).not.toHaveBeenCalled();
  });

  it('读取已保存排序而不把默认值写回存储', async () => {
    stored[ACCOUNT_SORT_STORAGE_KEY] = 'name-desc';
    await act(async () => root.render(createElement(Harness)));
    expect(selectAt().value).toBe('name-desc');
    expect(set).not.toHaveBeenCalled();
  });

  it('一次选择会保存并同步管理页和侧栏，清除偏好后回落默认', async () => {
    await act(async () => root.render(createElement('div', {},
      createElement(Harness), createElement(Harness, { compact: true }),
    )));
    await choose('added');

    expect(stored[ACCOUNT_SORT_STORAGE_KEY]).toBe('added');
    expect(selects().map((select) => select.value)).toEqual(['added', 'added']);

    await act(async () => broadcast('name-desc', 'session'));
    expect(selectAt().value).toBe('added');
    await act(async () => broadcast(undefined));
    expect(selects().map((select) => select.value)).toEqual(['name-asc', 'name-asc']);
  });

  it('较晚完成的初始化读取不能覆盖刚刚选择的排序', async () => {
    const read = deferred<Record<string, unknown>>();
    get.mockReturnValueOnce(read.promise);
    await act(async () => root.render(createElement(Harness)));
    await choose('name-desc');
    await act(async () => read.resolve({ [ACCOUNT_SORT_STORAGE_KEY]: 'added' }));

    expect(selectAt().value).toBe('name-desc');
    expect(stored[ACCOUNT_SORT_STORAGE_KEY]).toBe('name-desc');
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('较晚完成的初始化读取不能覆盖另一页面的新排序', async () => {
    const read = deferred<Record<string, unknown>>();
    get.mockReturnValueOnce(read.promise);
    await act(async () => root.render(createElement(Harness)));
    await act(async () => broadcast('name-desc'));
    await act(async () => read.resolve({ [ACCOUNT_SORT_STORAGE_KEY]: 'added' }));
    expect(selectAt().value).toBe('name-desc');
    expect(set).not.toHaveBeenCalled();
  });

  it('连续选择按顺序保存，最终保留最后一次选择', async () => {
    const firstWrite = deferred<void>();
    set.mockImplementationOnce(async (patch: Record<string, unknown>) => {
      await firstWrite.promise;
      Object.assign(stored, patch);
      broadcast(patch[ACCOUNT_SORT_STORAGE_KEY]);
    });
    await act(async () => root.render(createElement(Harness)));
    await choose('name-desc');
    await choose('added');
    expect(set).toHaveBeenCalledTimes(1);
    await act(async () => firstWrite.resolve());

    expect(set).toHaveBeenCalledTimes(2);
    expect(stored[ACCOUNT_SORT_STORAGE_KEY]).toBe('added');
    expect(selectAt().value).toBe('added');
  });

  it('无效偏好和读取失败使用默认值；写入失败后仍能再次保存', async () => {
    stored[ACCOUNT_SORT_STORAGE_KEY] = 'invalid';
    get.mockRejectedValueOnce(new Error('read unavailable'));
    set.mockRejectedValueOnce(new Error('write unavailable'));
    await act(async () => root.render(createElement(Harness)));
    expect(selectAt().value).toBe('name-asc');
    await choose('name-desc');
    expect(errors).toHaveLength(1);
    await choose('added');
    expect(stored[ACCOUNT_SORT_STORAGE_KEY]).toBe('added');
    await act(async () => broadcast('invalid'));
    expect(selectAt().value).toBe('name-asc');
  });
});
