import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SiteSortToolbar } from './SiteSortToolbar';
import { SITE_SORT_STORAGE_KEY, useSiteSortMode } from './useSiteSortMode';
import { ACCOUNT_SORT_STORAGE_KEY, useAccountSortMode } from './useAccountSortMode';

// 动画由真实扩展 E2E 验证；这里只验证偏好读写与状态展示。
vi.mock('motion/react', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  const element = (tag: string) => ({ children, layout: _l, layoutId: _id, initial: _i,
    animate: _a, transition: _t, whileTap: _tap, ...props }: Record<string, unknown>) => (
    React.createElement(tag, props, children as ReactNode)
  );
  return { motion: { div: element('div'), span: element('span'), button: element('button') } };
});

type Listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('站点排序小面板与独立偏好', () => {
  let root: Root;
  let container: HTMLDivElement;
  let stored: Record<string, unknown>;
  let listeners: Set<Listener>;
  let get: ReturnType<typeof vi.fn>;
  let set: ReturnType<typeof vi.fn>;
  let errors: unknown[];

  function broadcast(patch: Record<string, unknown>, area = 'local') {
    const changes = Object.fromEntries(Object.entries(patch).map(([key, newValue]) => [key, { newValue }]));
    for (const listener of listeners) listener(changes, area);
  }

  function Harness() {
    const [value, save] = useSiteSortMode();
    const [accountSortMode, saveAccounts] = useAccountSortMode();
    return createElement(SiteSortToolbar, {
      value,
      onChange: (next) => { void save(next).catch((error: unknown) => errors.push(error)); },
      accountSortMode,
      onAccountSortChange: (next) => { void saveAccounts(next); },
    });
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    stored = {};
    listeners = new Set();
    errors = [];
    get = vi.fn(async (key: string) => ({ [key]: stored[key] }));
    set = vi.fn(async (patch: Record<string, unknown>) => {
      Object.assign(stored, patch);
      broadcast(patch);
    });
    vi.stubGlobal('chrome', { storage: {
      local: { get, set },
      onChanged: { addListener: (fn: Listener) => listeners.add(fn), removeListener: (fn: Listener) => listeners.delete(fn) },
    } });
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

  function toggles() {
    return [...container.querySelectorAll<HTMLButtonElement>('button[aria-label="排序设置"]')];
  }

  function pressed() {
    return [...container.querySelectorAll('[aria-label="站点排序"] button[aria-pressed="true"]')]
      .map((button) => button.getAttribute('aria-label'));
  }

  async function openPanel(index = 0) {
    await act(async () => toggles()[index]!.click());
  }

  async function choose(name: string) {
    await act(async () => container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!.click());
  }

  it('默认收起为一个小按钮；点开才显示排序选项，A→Z 默认选中', async () => {
    await act(async () => root.render(createElement(Harness)));
    expect(toggles()[0]!.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[aria-label="站点排序"]')).toBeNull();
    await openPanel();
    expect(pressed()).toEqual(['名称 A→Z']);
    expect(container.querySelector('select[aria-label="账号排序"]')).not.toBeNull();
    expect(set).not.toHaveBeenCalled();
  });

  it('选择 Z→A 保存站点偏好，不影响账号排序偏好', async () => {
    stored[ACCOUNT_SORT_STORAGE_KEY] = 'added';
    await act(async () => root.render(createElement(Harness)));
    await openPanel();
    await choose('名称 Z→A');
    expect(set).toHaveBeenCalledWith({ siteSortMode: 'name-desc' });
    expect(stored).toEqual({ siteSortMode: 'name-desc', accountSortMode: 'added' });
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="账号排序"]')!.value).toBe('added');
  });

  it('手动微调只是状态不是选项：没有“手动”按钮，提示当前已微调', async () => {
    stored[SITE_SORT_STORAGE_KEY] = 'manual';
    await act(async () => root.render(createElement(Harness)));
    await openPanel();
    expect(pressed()).toEqual([]);
    expect(container.querySelector('button[aria-label="手动排序"]')).toBeNull();
    expect(container.textContent).toContain('手动微调');
    await choose('名称 A→Z');
    expect(stored.siteSortMode).toBe('name-asc');
  });

  it('跨页面同步只接受 local 的站点偏好，账号偏好互不干扰', async () => {
    await act(async () => root.render(createElement('div', null,
      createElement(Harness), createElement(Harness),
    )));
    await openPanel(0);
    await openPanel(1);
    await choose('名称 Z→A');
    expect(pressed()).toEqual(['名称 Z→A', '名称 Z→A']);
    await act(async () => broadcast({ siteSortMode: 'name-desc' }, 'session'));
    expect(pressed()).toEqual(['名称 Z→A', '名称 Z→A']);
    await act(async () => broadcast({ accountSortMode: 'name-desc' }));
    expect(pressed()).toEqual(['名称 Z→A', '名称 Z→A']);
    await act(async () => broadcast({ siteSortMode: undefined }));
    expect(pressed()).toEqual(['名称 A→Z', '名称 A→Z']);
  });

  it('迟到的初始化读取不覆盖用户刚选择的模式', async () => {
    const read = deferred<Record<string, unknown>>();
    get.mockReturnValueOnce(read.promise);
    await act(async () => root.render(createElement(Harness)));
    await openPanel();
    await choose('名称 Z→A');
    await act(async () => read.resolve({ siteSortMode: 'manual' }));
    expect(stored.siteSortMode).toBe('name-desc');
    expect(pressed()).toEqual(['名称 Z→A']);
  });

  it('快速切换按顺序保存，失败不阻断下次保存', async () => {
    const first = deferred<void>();
    set.mockImplementationOnce(async (patch: Record<string, unknown>) => {
      await first.promise;
      Object.assign(stored, patch);
      broadcast(patch);
    });
    await act(async () => root.render(createElement(Harness)));
    await openPanel();
    await choose('名称 Z→A');
    await choose('名称 A→Z');
    expect(set).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve());
    expect(stored.siteSortMode).toBe('name-asc');
    set.mockRejectedValueOnce(new Error('unavailable'));
    await choose('名称 Z→A');
    expect(errors).toHaveLength(1);
    await choose('名称 A→Z');
    expect(stored.siteSortMode).toBe('name-asc');
  });
});
