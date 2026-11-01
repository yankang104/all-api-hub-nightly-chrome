import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, SiteConfig } from '@/types';
import type { CredentialKind, CredentialPreset } from '@/types/credential';
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

import { CredentialPicker } from './CredentialPicker';

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

function makeAccount(input: {
  id: string;
  siteId: string;
  username: string;
  password?: string;
  label?: string;
  githubUsername?: string;
  githubPassword?: string;
}): Account {
  return {
    id: input.id,
    siteId: input.siteId,
    username: input.username,
    password: input.password ?? '',
    ...(input.label ? { label: input.label } : {}),
    ...(input.githubUsername ? { githubUsername: input.githubUsername } : {}),
    ...(input.githubPassword ? { githubPassword: input.githubPassword } : {}),
  };
}

interface PickerProps {
  kind: CredentialKind;
  siteId: string;
  excludeAccountId?: string;
  username?: string;
  password?: string;
  disabled?: boolean;
}

function pickerOptions(container: HTMLElement): string[] {
  const select = container.querySelector('select');
  if (!select) throw new Error('未找到凭据下拉框');
  return [...select.options].map((option) => option.textContent?.replace(/\s+/g, ' ').trim() ?? '');
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((item) => item.textContent === text);
  if (!button) throw new Error(`未找到按钮：${text}`);
  return button;
}

describe('CredentialPicker 常用凭据选择器', () => {
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

  /** 渲染选择器并冲刷 hook 的异步 storage 读取 */
  async function renderPicker(props: PickerProps, onPick = vi.fn()) {
    await act(async () => root.render(createElement(CredentialPicker, {
      kind: props.kind,
      siteId: props.siteId,
      ...(props.excludeAccountId ? { excludeAccountId: props.excludeAccountId } : {}),
      username: props.username ?? '',
      password: props.password ?? '',
      ...(props.disabled ? { disabled: true } : {}),
      onPick,
    })));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    return onPick;
  }

  it('site 候选只收集同主机站点账号，同站优先并按账号数合并', async () => {
    useAppStore.setState({
      sites: [
        makeSite('site-a', '主站', 'https://example.com/login'),
        makeSite('site-b', '镜像站', 'https://example.com/sso'),
        makeSite('site-c', '异站', 'https://other.com/login'),
      ],
      accounts: [
        makeAccount({ id: 'a1', siteId: 'site-a', username: 'alice', password: 'pw-alice-1' }),
        makeAccount({ id: 'a2', siteId: 'site-a', username: 'alice', password: 'pw-alice-1' }),
        makeAccount({ id: 'a3', siteId: 'site-b', username: 'bob', password: 'pw-bob', label: 'Bob' }),
        makeAccount({ id: 'a4', siteId: 'site-c', username: 'carol', password: 'pw-carol' }),
        makeAccount({ id: 'a5', siteId: 'site-a', username: 'ghost', githubUsername: 'gh-ghost', githubPassword: 'gh-pass' }),
      ],
    });

    await renderPicker({ kind: 'site', siteId: 'site-a' });

    expect(container.textContent).toContain('选择已保存的站点账号');
    expect(pickerOptions(container)).toEqual([
      '手动输入',
      'alice · 主站（2 个账号）',
      'Bob · 镜像站',
    ]);

    const select = container.querySelector('select');
    if (!select) throw new Error('未找到凭据下拉框');
    // option 的 value 是候选 id，绝不携带密码
    expect([...select.options].map((option) => option.value)).not.toContain('pw-alice-1');
    expect(container.textContent).not.toContain('pw-alice-1');
    expect(container.textContent).not.toContain('pw-bob');
    expect(container.textContent).not.toContain('pw-carol');
    // 异站账号与 GitHub 凭据都不该出现在站点候选里
    expect(container.textContent).not.toContain('carol');
    expect(container.textContent).not.toContain('gh-ghost');
    expect(container.textContent).not.toContain('gh-pass');
  });

  it('github 候选跨站点收集，不含站点密码', async () => {
    useAppStore.setState({
      sites: [
        makeSite('site-a', '主站', 'https://example.com/login'),
        makeSite('site-c', '异站', 'https://other.com/login'),
      ],
      accounts: [
        makeAccount({ id: 'a1', siteId: 'site-a', username: 'site-user', password: 'site-pw' }),
        makeAccount({ id: 'a2', siteId: 'site-c', username: 'gholder', githubUsername: 'gh-1', githubPassword: 'gh-pass-1' }),
        makeAccount({ id: 'a3', siteId: 'site-a', username: 'gholder2', githubUsername: 'gh-1', githubPassword: 'gh-pass-1' }),
      ],
    });

    await renderPicker({ kind: 'github', siteId: 'site-a' });

    expect(container.textContent).toContain('选择已保存的 GitHub 账号');
    expect(pickerOptions(container)).toEqual([
      '手动输入',
      'gh-1 · 主站（2 个账号）',
    ]);
    expect(container.textContent).not.toContain('site-pw');
    expect(container.textContent).not.toContain('gh-pass-1');
  });

  it('选中候选后回填并复位下拉，显示提示并记录使用', async () => {
    const { store } = stubChrome({
      [CREDENTIAL_PRESETS_KEY]: [
        { id: 'cp-gh', kind: 'github', username: 'gh-user', password: 'gh-secret', label: '工作号', updatedAt: 100 },
      ],
    });
    useAppStore.setState({
      sites: [makeSite('site-a', '主站', 'https://example.com/login')],
      accounts: [],
    });

    const onPick = vi.fn();
    await renderPicker({ kind: 'github', siteId: 'site-a' }, onPick);

    const select = container.querySelector('select');
    if (!select) throw new Error('未找到凭据下拉框');
    await vi.waitFor(() => {
      expect(pickerOptions(container)).toContain('工作号');
    });

    await act(async () => {
      select.value = 'cp-gh';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(onPick).toHaveBeenCalledWith({ username: 'gh-user', password: 'gh-secret' });
    expect(select.value).toBe('');
    expect(container.textContent).toContain('已填入 工作号');
    expect(container.textContent).not.toContain('gh-secret');

    // 手动预设要记使用时间与次数（markUsed → 落盘）
    await vi.waitFor(() => {
      const saved = store.get(CREDENTIAL_PRESETS_KEY) as CredentialPreset[] | undefined;
      const preset = saved?.find((item) => item.id === 'cp-gh');
      expect(preset?.useCount).toBe(1);
      expect(preset?.lastUsedAt).toBeGreaterThan(0);
    });
  });

  it('没有候选时显示说明文字，下拉只剩手动输入', async () => {
    await renderPicker({ kind: 'site', siteId: 'site-a' });

    const select = container.querySelector('select');
    if (!select) throw new Error('未找到凭据下拉框');
    expect([...select.options].map((option) => option.textContent)).toEqual(['手动输入']);
    expect(select.disabled).toBe(true);
    expect(container.textContent).toContain('还没有可选的站点凭据');
  });

  it('「将当前输入存为常用」持久化预设并显示成功提示', async () => {
    const { store } = stubChrome();
    useAppStore.setState({
      sites: [makeSite('site-a', '主站', 'https://example.com/login')],
      accounts: [],
    });

    await renderPicker({ kind: 'site', siteId: 'site-a', username: 'new-user', password: 'new-pass' });

    const saveButton = findButton(container, '将当前输入存为常用');
    expect(saveButton.disabled).toBe(false);

    await act(async () => {
      saveButton.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain('已保存，之后可直接在下拉中选择');
    expect(container.textContent).not.toContain('new-pass');

    const saved = store.get(CREDENTIAL_PRESETS_KEY) as CredentialPreset[] | undefined;
    expect(saved).toEqual([
      expect.objectContaining({ kind: 'site', username: 'new-user', password: 'new-pass', siteId: 'site-a' }),
    ]);
  });

  it('用户名或密码为空时不能存为常用', async () => {
    await renderPicker({ kind: 'github', siteId: 'site-a', username: 'only-user', password: '' });
    expect(findButton(container, '将当前输入存为常用').disabled).toBe(true);
  });

  it('「管理常用凭据…」打开凭据库弹窗', async () => {
    await renderPicker({ kind: 'github', siteId: 'site-a' });

    const manageButton = findButton(container, '管理常用凭据…');
    await act(async () => manageButton.click());

    expect(container.textContent).toContain('还没有保存的常用凭据');
  });

  it('disabled 时下拉与操作按钮全部禁用', async () => {
    useAppStore.setState({
      sites: [makeSite('site-a', '主站', 'https://example.com/login')],
      accounts: [makeAccount({ id: 'a1', siteId: 'site-a', username: 'alice', password: 'pw-alice' })],
    });

    await renderPicker({ kind: 'site', siteId: 'site-a', username: 'u', password: 'p', disabled: true });

    const select = container.querySelector('select');
    if (!select) throw new Error('未找到凭据下拉框');
    expect(select.disabled).toBe(true);
    expect(findButton(container, '将当前输入存为常用').disabled).toBe(true);
    expect(findButton(container, '管理常用凭据…').disabled).toBe(true);
  });

  it('编辑账号时 excludeAccountId 排除自身候选', async () => {
    useAppStore.setState({
      sites: [makeSite('site-a', '主站', 'https://example.com/login')],
      accounts: [
        makeAccount({ id: 'self', siteId: 'site-a', username: 'self-user', password: 'self-pass' }),
        makeAccount({ id: 'other', siteId: 'site-a', username: 'other-user', password: 'other-pass' }),
      ],
    });

    await renderPicker({ kind: 'site', siteId: 'site-a', excludeAccountId: 'self' });

    expect(pickerOptions(container)).toEqual([
      '手动输入',
      'other-user · 主站',
    ]);
    expect(container.textContent).not.toContain('self-user');
    expect(container.textContent).not.toContain('self-pass');
    expect(container.textContent).not.toContain('other-pass');
  });
});
