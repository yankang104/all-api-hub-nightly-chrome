import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PageShell, type ShellStatus } from './PageShell';

const status: ShellStatus = { version: 'test', running: 0, attention: 0, total: 0, done: 0 };
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('PageShell', () => {
  it('sidepanel 模式只渲染内容，不渲染桌面导航，也不能把内容隐藏', async () => {
    await act(async () => {
      root.render(
        React.createElement(
          PageShell,
          {
            shellVisible: false,
            view: 'overview',
            onViewChange: () => {},
            search: '',
            onSearchChange: () => {},
            status,
            children: React.createElement('div', { id: 'compact-content' }, '紧凑布局'),
          },
        ),
      );
    });

    expect(container.querySelector('nav[aria-label="主导航"]')).toBeNull();
    const content = container.querySelector('#compact-content');
    expect(content?.textContent).toBe('紧凑布局');
    expect(content?.closest('.hidden')).toBeNull();
  });

  it('管理页模式渲染桌面导航和内容', async () => {
    await act(async () => {
      root.render(
        React.createElement(
          PageShell,
          {
            view: 'overview',
            onViewChange: () => {},
            search: '',
            onSearchChange: () => {},
            status,
            children: React.createElement('div', { id: 'page-content' }, '管理页内容'),
          },
        ),
      );
    });

    expect(container.querySelector('nav[aria-label="主导航"]')).not.toBeNull();
    expect(container.querySelector('#page-content')?.textContent).toBe('管理页内容');
  });
});
