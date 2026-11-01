import React, { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DIAGNOSIS, type DiagnosisCode } from '@/lib/checkin/diagnosis';

vi.mock('motion/react', async () => {
  const ReactModule = await vi.importActual<typeof import('react')>('react');
  const element = (tag: string) => ({ children, ...props }: Record<string, unknown>) =>
    ReactModule.createElement(tag, props, children as ReactNode);
  return {
    motion: { div: element('div') },
  };
});

import { DiagnosisHint } from './DiagnosisHint';

/**
 * 诊断提示的渲染契约。
 *
 * 这段 UI 的目标只有一个：用户看完知道**下一步做什么**。所以断言不看样式，
 * 只看三段结构有没有落地 —— 标题、说明、以及带编号的下一步列表。
 * 少任何一段都会退回「一句笼统的失败」，正是这次要修的问题。
 */
describe('DiagnosisHint 渲染结构化诊断', () => {
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
  });

  async function render(code: DiagnosisCode): Promise<void> {
    await act(async () => root.render(createElement(DiagnosisHint, { code })));
  }

  it('渲染标题、说明与下一步三段，并把诊断码写进 DOM 供排查', async () => {
    await render(DIAGNOSIS.PROXY_UNREACHABLE);

    const title = container.querySelector('[data-diagnosis-title]');
    expect(title?.textContent).toBe('本机代理端口没有程序在监听');
    expect(container.querySelector('[data-diagnosis-code]')?.getAttribute('data-diagnosis-code'))
      .toBe('proxy-unreachable');
    expect(container.textContent).toContain('内核（Clash Verge / mihomo）没启动');

    const actions = container.querySelectorAll('[data-diagnosis-actions] > li');
    expect(actions.length).toBeGreaterThan(0);
    // 每一条都带序号，用户才能说清「我做到第几步了」。
    expect(actions[0]?.textContent).toContain('1.');
    expect(container.textContent).toContain('Clash Verge');
  });

  it('选择器失效时给出「重新演示」这条可照做的动作', async () => {
    await render(DIAGNOSIS.SELECTOR_MISMATCH);

    const actions = container.querySelector('[data-diagnosis-actions]')?.textContent ?? '';
    expect(actions).toContain('学习本站流程');
    expect(actions).toContain('重新演示');
  });

  it('每一类诊断都能渲染出非空的三段结构（没有半成品）', async () => {
    for (const code of Object.values(DIAGNOSIS) as DiagnosisCode[]) {
      await render(code);
      const title = container.querySelector('[data-diagnosis-title]')?.textContent?.trim() ?? '';
      const actions = container.querySelectorAll('[data-diagnosis-actions] > li');
      expect(title.length, code).toBeGreaterThan(0);
      expect(actions.length, code).toBeGreaterThan(0);
      for (const action of actions) {
        expect(action.textContent?.trim().length ?? 0, `${code}: ${action.textContent}`).toBeGreaterThan(4);
      }
    }
  });
});






