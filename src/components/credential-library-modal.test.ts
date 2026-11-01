import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SiteConfig } from '@/types';
import type { CredentialPreset } from '@/types/credential';
import { CREDENTIAL_PRESETS_KEY } from '@/lib/credential/credential-store';
import { useAppStore } from '@/stores/app-store';

vi.mock('motion/react', async () => {
  const ReactModule = await vi.importActual<typeof import('react')>('react');
  const element = (tag: string) => ({
    children,
    initial: _initial,
    animate: _animate,
    exit: _exit,
    transition: _transition,
    whileHover: _whileHover,
    whileTap: _whileTap,
    ...props
  }: Record<string, unknown>) => ReactModule.createElement(tag, props, children as ReactNode);

  return {
    AnimatePresence: ({ children }: { children?: ReactNode }) => ReactModule.createElement(ReactModule.Fragment, null, children),
    motion: {
      button: element('button'),
      div: element('div'),
    },
  };
});

import { CredentialLibraryModal } from './CredentialLibraryModal';

type StorageListener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void;

/** 参照 credential-store.test.ts 的内存 chrome.storage.local 桩 */
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

function makeSite(id: string, name: string, loginUrl: string): SiteConfig {
  return {
    id,
    name,
    loginUrl,
    loginMethod: 'form',
    selectors: { username: '#username', password: '#password', submit: 'button[type="submit"]' },
    closeModalSelectors: [],
    checkin: { method: 'auto' },
  };
}

/** 用原生 value setter 写受控 input 并触发 React onChange（避免 React 的值追踪器拦截） */
function setValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function findButtonByLabel(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((item) => item.getAttribute('aria-label') === label);
  if (!button) throw new Error(`未找到按钮：${label}`);
  return button;
}

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((item) => item.textContent === text);
  if (!button) throw new Error(`未找到按钮：${text}`);
  return button;
}

function storedPresets(store: Map<string, unknown>): CredentialPreset[] {
  return (store.get(CREDENTIAL_PRESETS_KEY) ?? []) as CredentialPreset[];
}

describe('CredentialLibraryModal 常用凭据库', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.unstubAllGlobals();
    useAppStore.setState({ accounts: [], sites: [], proxies: [] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  /** 渲染弹窗并冲刷 hook 的异步 storage 读取 */
  async function renderModal() {
    await act(async () => root.render(createElement(CredentialLibraryModal, { open: true, onClose: vi.fn() })));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }

  it('open=false 时不渲染任何内容', async () => {
    await act(async () => root.render(createElement(CredentialLibraryModal, { open: false, onClose: vi.fn() })));
    expect(container.textContent).toBe('');
  });

  it('按站点/GitHub 分组并按更新时间倒序列出，密码不进 DOM 文本', async () => {
    stubChrome({
      [CREDENTIAL_PRESETS_KEY]: [
        { id: 'cp-gh-1', kind: 'github', username: 'gh1', password: 'gh-secret-1', updatedAt: 100 },
        { id: 'cp-site-1', kind: 'site', username: 's1', password: 'site-secret-1', label: '主号', updatedAt: 200 },
        { id: 'cp-gh-2', kind: 'github', username: 'gh2', password: 'gh-secret-2', updatedAt: 300 },
      ],
    });

    await renderModal();

    await vi.waitFor(() => {
      expect([...container.querySelectorAll('[data-kind]')]).toHaveLength(3);
    });

    expect(container.textContent).toContain('站点账号');
    expect(container.textContent).toContain('GitHub 账号');

    // 组内按 updatedAt 倒序
    const githubRows = [...container.querySelectorAll('[data-kind="github"]')];
    expect(githubRows.map((row) => row.textContent?.replace(/\s+/g, ' ').trim() ?? '')).toEqual([
      expect.stringContaining('gh2'),
      expect.stringContaining('gh1'),
    ]);
    expect(githubRows[0]?.textContent).not.toContain('gh1');

    const siteRows = [...container.querySelectorAll('[data-kind="site"]')];
    expect(siteRows).toHaveLength(1);
    expect(siteRows[0]?.textContent).toContain('主号');
    expect(siteRows[0]?.textContent).toContain('s1');

    // 密码绝不进任何文本节点
    expect(container.textContent).not.toContain('gh-secret-1');
    expect(container.textContent).not.toContain('gh-secret-2');
    expect(container.textContent).not.toContain('site-secret-1');

    // 密码只存在于遮蔽输入框的 value 里
    const maskedValues = [...container.querySelectorAll('[data-kind] input[type="password"]')]
      .map((input) => (input as HTMLInputElement).value)
      .sort();
    expect(maskedValues).toEqual(['gh-secret-1', 'gh-secret-2', 'site-secret-1']);
  });

  it('密码遮蔽输入框可主动显示/隐藏', async () => {
    stubChrome({
      [CREDENTIAL_PRESETS_KEY]: [
        { id: 'cp-1', kind: 'site', username: 's1', password: 'top-secret', updatedAt: 50 },
      ],
    });

    await renderModal();
    await vi.waitFor(() => {
      expect(container.querySelector('[data-kind="site"] input[type="password"]')).toBeTruthy();
    });

    const row = container.querySelector('[data-kind="site"]');
    const masked = row?.querySelector('input[type="password"]') as HTMLInputElement;
    expect(masked.value).toBe('top-secret');

    await act(async () => findButtonByLabel(container, '显示 s1 的密码').click());

    const shown = row?.querySelector('input[type="text"]') as HTMLInputElement;
    expect(shown.value).toBe('top-secret');
    // 即便明文显示，也只是输入框 value，绝不成为文本节点
    expect(container.textContent).not.toContain('top-secret');

    await act(async () => findButtonByLabel(container, '隐藏 s1 的密码').click());
    expect(row?.querySelector('input[type="password"]')).toBeTruthy();
    expect(row?.querySelector('input[type="text"]')).toBeNull();
  });

  it('关闭再打开后密码重新遮蔽，不残留明文状态', async () => {
    stubChrome({
      [CREDENTIAL_PRESETS_KEY]: [
        { id: 'cp-1', kind: 'site', username: 's1', password: 'top-secret', updatedAt: 50 },
      ],
    });

    await renderModal();
    await vi.waitFor(() => {
      expect(container.querySelector('[data-kind="site"] input[type="password"]')).toBeTruthy();
    });
    await act(async () => findButtonByLabel(container, '显示 s1 的密码').click());
    expect(container.querySelector('[data-kind="site"] input[type="text"]')).toBeTruthy();

    // 弹窗关闭（组件不卸载）后再打开：应重新遮蔽
    await act(async () => root.render(createElement(CredentialLibraryModal, { open: false, onClose: vi.fn() })));
    await act(async () => root.render(createElement(CredentialLibraryModal, { open: true, onClose: vi.fn() })));
    await vi.waitFor(() => {
      expect(container.querySelector('[data-kind="site"] input[type="password"]')).toBeTruthy();
    });
    expect(container.querySelector('[data-kind="site"] input[type="text"]')).toBeNull();
    expect(container.textContent).not.toContain('top-secret');
  });

  it('改名保存后列表与存储同步更新', async () => {
    const { store } = stubChrome({
      [CREDENTIAL_PRESETS_KEY]: [
        { id: 'cp-1', kind: 'github', username: 'gh1', password: 'p1', updatedAt: 50 },
      ],
    });

    await renderModal();
    await vi.waitFor(() => {
      expect(container.textContent).toContain('gh1');
    });

    await act(async () => findButtonByLabel(container, '改名 gh1').click());

    const draft = container.querySelector('input[placeholder="备注（留空清除）"]') as HTMLInputElement;
    if (!draft) throw new Error('未找到改名输入框');
    await act(async () => {
      setValue(draft, '工作账号');
    });
    await act(async () => {
      findButtonByLabel(container, '确认改名').click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await vi.waitFor(() => {
      const saved = storedPresets(store);
      expect(saved).toEqual([
        expect.objectContaining({ id: 'cp-1', label: '工作账号' }),
      ]);
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain('工作账号');
    });
    expect(container.textContent).not.toContain('p1');
  });

  it('删除需要二次确认，确认后从列表与存储移除', async () => {
    const { store } = stubChrome({
      [CREDENTIAL_PRESETS_KEY]: [
        { id: 'cp-1', kind: 'site', username: 's1', password: 'p1', updatedAt: 50 },
        { id: 'cp-2', kind: 'github', username: 'gh1', password: 'p2', updatedAt: 60 },
      ],
    });

    await renderModal();
    await vi.waitFor(() => {
      expect([...container.querySelectorAll('[data-kind]')]).toHaveLength(2);
    });

    // 第一次点击只是进入确认态，不删除
    await act(async () => findButtonByLabel(container, '删除 s1').click());
    expect(container.textContent).toContain('确认删除');
    expect(storedPresets(store)).toHaveLength(2);

    // 第二次点击才真正删除
    await act(async () => {
      findButtonByLabel(container, '确认删除 s1').click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await vi.waitFor(() => {
      expect(storedPresets(store).map((preset) => preset.id)).toEqual(['cp-2']);
    });
    expect([...container.querySelectorAll('[data-kind="site"]')]).toHaveLength(0);
    expect(container.textContent).not.toContain('p1');
  });

  it('新增凭据表单可保存站点凭据并绑定来源站点', async () => {
    const { store } = stubChrome();
    useAppStore.setState({
      sites: [
        makeSite('site-a', '主站', 'https://example.com/login'),
        makeSite('site-b', '镜像站', 'https://example.com/sso'),
      ],
      accounts: [],
    });

    await renderModal();

    const usernameInput = container.querySelector('input[placeholder="用户名"]') as HTMLInputElement;
    const passwordInput = container.querySelector('input[placeholder="密码"]') as HTMLInputElement;
    const labelInput = container.querySelector('input[placeholder="备注（可选）"]') as HTMLInputElement;
    const siteSelect = container.querySelectorAll('select')[1];
    if (!usernameInput || !passwordInput || !labelInput || !siteSelect) throw new Error('未找到新增凭据表单');

    await act(async () => {
      setValue(usernameInput, 'new-site-user');
      setValue(passwordInput, 'new-site-pass');
      setValue(labelInput, '小号');
      (siteSelect as HTMLSelectElement).value = 'site-a';
      siteSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await act(async () => {
      findButtonByText(container, '保存凭据').click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await vi.waitFor(() => {
      expect(storedPresets(store)).toEqual([
        expect.objectContaining({
          kind: 'site',
          username: 'new-site-user',
          password: 'new-site-pass',
          label: '小号',
          siteId: 'site-a',
        }),
      ]);
    });
    expect(container.textContent).toContain('已保存到常用凭据');
    expect(container.textContent).not.toContain('new-site-pass');
    // 成功后清空表单，列表里出现新条目
    await vi.waitFor(() => {
      expect(container.textContent).toContain('小号');
    });
    expect(usernameInput.value).toBe('');
  });

  it('新增凭据校验用户名与密码，错误经表单提示', async () => {
    const { store } = stubChrome();

    await renderModal();

    const usernameInput = container.querySelector('input[placeholder="用户名"]') as HTMLInputElement;
    const passwordInput = container.querySelector('input[placeholder="密码"]') as HTMLInputElement;
    if (!usernameInput || !passwordInput) throw new Error('未找到新增凭据表单');

    const addButton = findButtonByText(container, '保存凭据');

    await act(async () => {
      addButton.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain('用户名不能为空');

    await act(async () => {
      setValue(usernameInput, 'u1');
      addButton.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain('密码不能为空');
    expect(storedPresets(store)).toHaveLength(0);
  });

  it('storage 里混入坏数据时只展示合法条目，不崩溃', async () => {
    stubChrome({
      [CREDENTIAL_PRESETS_KEY]: [
        null,
        'garbage',
        { bad: true },
        { id: '', kind: 'site', username: 'x', password: 'y', updatedAt: 1 },
        { id: 'cp-ok', kind: 'site', username: ' u ', password: 'ok-pass', updatedAt: 5 },
        { id: 'cp-dup', kind: 'site', username: 'u', password: 'ok-pass', updatedAt: 9 },
      ],
    });

    await renderModal();

    await vi.waitFor(() => {
      expect([...container.querySelectorAll('[data-kind="site"]')]).toHaveLength(1);
    });
    const siteRows = [...container.querySelectorAll('[data-kind="site"]')];
    // 同指纹只保留更新时间较新的一条
    expect(siteRows[0]?.textContent).toContain('u');
    expect(container.textContent).not.toContain('ok-pass');
    expect(container.textContent).not.toContain('garbage');
  });
});
