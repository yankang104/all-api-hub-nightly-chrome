import React, { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckinMethod, SiteConfig } from '@/types';

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

import { CheckinMethodSection } from './site-form/CheckinMethodSection';
import { SiteModal } from './SiteModal';
import { AddAccountModal } from './AddAccountModal';

const site: SiteConfig = {
  id: 'site-1',
  name: '测试站',
  loginUrl: 'https://example.com/login',
  loginMethod: 'form',
  selectors: { username: '#username', password: '#password', submit: 'button[type="submit"]' },
  closeModalSelectors: [],
  checkin: { method: 'auto' },
};

describe('自动识别签到设置', () => {
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

  /**
   * UI 只剩「自主学习」一种入口：三种执行方式（自动识别 / 学习流程回放 /
   * 登录即签到）由学习结束时的观测自动判定，不再让用户在三者之间挑。这里断言
   * 「没有可点的模式按钮」以及「当前会怎么做被如实显示」。
   */
  it('未配置时不出现可点的模式按钮，如实说明当前为自动识别', async () => {
    await act(async () => root.render(createElement(CheckinMethodSection, { form: site, onChange: vi.fn() })));

    expect(container.textContent).toContain('自主学习');
    expect(container.textContent).toContain('自动识别签到');
    expect(container.textContent).toContain('① 登录并确认账号');
    expect(container.textContent).toContain('② 完成签到');
    expect(container.textContent).toContain('学到流程后会自动改为回放');
    // 三种执行方式不再是让用户选的按钮。
    expect(container.querySelectorAll('[aria-pressed]')).toHaveLength(0);
    expect(container.textContent).toContain('遇到没经历过的页面会自己判断');
  });

  it('站点已配成登录即签到时，如实显示该结论而不是让用户再选一次', async () => {
    await act(async () => root.render(createElement(CheckinMethodSection, {
      form: { ...site, checkin: { method: 'none' } },
      onChange: vi.fn(),
    })));

    expect(container.textContent).toContain('登录即签到');
    expect(container.textContent).toContain('登录成功后即视为完成签到');
    expect(container.querySelectorAll('[aria-pressed]')).toHaveLength(0);
  });

  it('启用回放时展示路线和人话步骤，并可配置回放填写文本', async () => {
    const onChange = vi.fn();
    const learnedSite: SiteConfig = {
      ...site,
      checkin: {
        method: 'workflow',
        workflow: {
          route: ['/console', '/console/checkin'],
          steps: [
            { type: 'click', selector: 'text=领取权益' },
            { type: 'fill', selector: 'textarea', value: '{{claimText}}' },
            { type: 'assert', text: ['签到成功'], result: 'success' },
          ],
        },
      },
    };
    await act(async () => root.render(createElement(CheckinMethodSection, { form: learnedSite, onChange })));

    expect(container.textContent).toContain('已保存签到流程');
    expect(container.textContent).toContain('3 个步骤 · 2 个页面');
    expect(container.textContent).toContain('/console/checkin');
    expect(container.textContent).toContain('点击「领取权益」');
    expect(container.textContent).toContain('请补充文本后再执行');
    const textarea = container.querySelector('textarea');
    expect(textarea).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '日常签到填写内容');
      textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith({ claimText: '日常签到填写内容' });
  });

  it.each(['auto', 'workflow'] as const)('空的 %s 流程仍可见并提示重新学习', async (method) => {
    await act(async () => root.render(createElement(CheckinMethodSection, {
      form: { ...site, checkin: { method, workflow: { steps: [] } } },
      onChange: vi.fn(),
    })));

    expect(container.textContent).toContain('已保存签到流程');
    expect(container.textContent).not.toContain('还没有学习签到流程');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('需要修正后才能回放');
  });

  it('已保存的流程停用后仍保留展示，不会因执行方式变化被丢弃', async () => {
    const workflow = { steps: [{ type: 'click' as const, selector: '#old' }] };
    await act(async () => root.render(createElement(CheckinMethodSection, {
      form: { ...site, checkin: { method: 'auto', workflow } },
      onChange: vi.fn(),
    })));

    expect(container.textContent).toContain('未启用，仅保留记录');
    expect(container.textContent).toContain('查看保存的流程');
  });

  it('UI 只剩自主学习：不再提供可点的执行方式按钮', async () => {
    await act(async () => root.render(createElement(CheckinMethodSection, {
      form: { ...site, checkin: { method: 'workflow', workflow: { steps: [{ type: 'click' as const, selector: '#old' }] } } },
      onChange: vi.fn(),
    })));
    expect(container.querySelectorAll('[aria-pressed]')).toHaveLength(0);
  });
  it.each<CheckinMethod>(['relogin', 'api', 'button', 'claim'])('保存旧 %s 站点不会丢失内部适配字段', async (method) => {
    const checkin = {
      method,
      apiUrl: '/api/checkin',
      logoutApiUrl: '/api/logout',
      buttonSelector: '#checkin',
      claimText: '原来的签到填写文本',
    };
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    await act(async () => root.render(createElement(SiteModal, {
      open: true,
      mode: 'add',
      editing: { ...site, checkin },
      sites: [],
      proxies: [],
      onClose: vi.fn(),
      onSubmit,
    })));
    const settings = container.querySelector('[aria-label="签到设置"]');
    expect(settings?.textContent).toContain('沿用本站已有的签到适配');
    // 不再有任何可点的模式按钮：执行方式由学习自动判定。
    expect(settings?.querySelectorAll('[aria-pressed]')).toHaveLength(0);
    const save = [...container.querySelectorAll('button')].find((button) => button.textContent === '保存修改');
    expect(save).toBeDefined();
    await act(async () => save!.click());
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ checkin }));
  });

  it('账号编辑如实显示当前为学习流程回放而不是自动识别', async () => {
    await act(async () => root.render(createElement(AddAccountModal, {
      open: true,
      sites: [{ ...site, checkin: { method: 'workflow', workflow: { steps: [] } } }],
      proxies: [],
      onClose: vi.fn(),
      onSubmit: vi.fn(),
    })));
    const field = [...container.querySelectorAll('label')].find((label) => label.textContent?.startsWith('签到流程'));
    expect(field?.textContent).toContain('学习流程回放');
    expect(field?.textContent).not.toContain('自动识别');
    expect(field?.textContent).toContain('先登录并确认账号');
    expect(field?.textContent).toContain('执行本站已保存的签到流程');
    expect(field?.textContent).not.toContain('workflow');
  });

  it('账号编辑如实显示登录即签到而不是本站适配', async () => {
    await act(async () => root.render(createElement(AddAccountModal, {
      open: true,
      sites: [{ ...site, checkin: { method: 'none' } }],
      proxies: [],
      onClose: vi.fn(),
      onSubmit: vi.fn(),
    })));
    const field = [...container.querySelectorAll('label')].find((label) => label.textContent?.startsWith('签到流程'));
    expect(field?.textContent).toContain('登录即签到');
    expect(field?.textContent).toContain('登录成功后直接视为签到完成');
    expect(field?.textContent).not.toContain('本站适配');
  });
});
