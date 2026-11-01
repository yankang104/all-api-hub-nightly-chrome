/**
 * 添加站点时，登录地址失焦就去探测站点系统；探测结果要等它回来才能保存。
 *
 * 旧实现的保存按钮不看探测状态：粘贴地址后立刻点保存，探测结果回来时弹窗已关，
 * 落盘的是空白默认值（没有登录成功标志、没有站点系统），之后打开时认不出已登录。
 */
import React, { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const messaging = vi.hoisted(() => ({ sendMessage: vi.fn() }));
vi.mock('@/lib/core/messaging', () => messaging);

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
    motion: { button: element('button'), div: element('div'), span: element('span') },
  };
});

import { SiteModal } from './SiteModal';
import { NEW_API_TEMPLATE } from '@/sites';

describe('添加站点：探测完成前不能保存', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('探测进行中保存按钮禁用；探测结果套用后再保存，预设一并落盘', async () => {
    let resolveProbe!: (value: unknown) => void;
    messaging.sendMessage.mockImplementation(() => new Promise((resolve) => { resolveProbe = resolve; }));
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    await act(async () => root.render(createElement(SiteModal, {
      open: true,
      mode: 'add',
      sites: [],
      proxies: [],
      onClose: vi.fn(),
      onSubmit,
    })));

    const input = container.querySelector<HTMLInputElement>('input[placeholder="https://..."]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'https://whitelabel.example/login');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });

    const save = () => [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('仅保存站点'))!;
    expect(messaging.sendMessage).toHaveBeenCalledWith({ type: 'PROBE_SITE', url: 'https://whitelabel.example/login' });
    expect(container.textContent).toContain('正在识别站点系统');
    expect(save().disabled).toBe(true);
    await act(async () => save().click());
    expect(onSubmit).not.toHaveBeenCalled();

    await act(async () => resolveProbe({
      ok: true,
      feature: {
        probe: {
          siteType: NEW_API_TEMPLATE.siteType,
          evidence: '/api/user/self 的响应形状符合 new-api 系',
          preset: NEW_API_TEMPLATE.preset,
          templateLabel: NEW_API_TEMPLATE.label,
          templateId: NEW_API_TEMPLATE.id,
        },
      },
    }));

    expect(container.textContent).toContain(`已识别为 ${NEW_API_TEMPLATE.label}`);
    expect(save().disabled).toBe(false);
    await act(async () => save().click());
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      successIndicator: NEW_API_TEMPLATE.preset.successIndicator,
      adapter: expect.objectContaining({ family: 'new-api' }),
    }));
  });

  it('任何登录方式下都能填写登录成功标志（不只 OAuth）', async () => {
    messaging.sendMessage.mockResolvedValue({ ok: false });
    await act(async () => root.render(createElement(SiteModal, {
      open: true,
      mode: 'add',
      sites: [],
      proxies: [],
      onClose: vi.fn(),
      onSubmit: vi.fn(),
    })));

    // 新建站点默认就是「站点账号密码」登录。
    const label = [...container.querySelectorAll('label')].find((item) => item.textContent?.includes('登录成功标志选择器'));
    expect(label).toBeDefined();
    expect(label?.querySelector('input')).not.toBeNull();
  });
});
