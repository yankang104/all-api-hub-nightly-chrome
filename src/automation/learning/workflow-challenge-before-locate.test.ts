/**
 * P3-r：click 分支「初次定位失败」时的人机验证补救。
 *
 * 现场：站点把签到按钮藏在 Turnstile/滑块之后，必须先过验证才渲染按钮。旧顺序是
 * `locateStepTarget → hooks.beforeAction → 重定位 → 点击`，初次定位会先失败并直接
 * 报「找不到可点击元素」，永远走不到验证钩子。
 *
 * 本文件锁定两件事：
 * 1. 定位等待中发现验证就接管，不再先耗尽查找预算；验证通过后挂载控件，点击前
 *    再核验一次，业务点击仍只有一次（指纹核验 → clearClickBlocker → realClick）；
 * 2. 页面没有验证证据时，beforeAction 的调用时机与次数与改动前完全一致（回归）。
 *
 * mock 口径参考 workflow-replay-click-audit.test.ts：dom-utils 走 importActual + 局部
 * 覆盖（保留真实选择器解析与可见性语义），click-safety 与 messaging 直接替换。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/automation/shared/dom-utils', async () => {
  const actual = await vi.importActual<typeof import('@/automation/shared/dom-utils')>(
    '@/automation/shared/dom-utils',
  );
  return {
    ...actual,
    sleep: vi.fn().mockResolvedValue(undefined),
    // 立即按真实 queryFirst 判定一次，不空等元素超时（解析逻辑保持真实实现）。
    waitFor: vi.fn(async (selector: string) => actual.queryFirst(selector)),
    // 点击本身在此用例中只需证明「真实点击被发起」，不需要真实指针/遮挡链路。
    realClick: vi.fn().mockResolvedValue('dom'),
  };
});

vi.mock('@/automation/shared/click-safety', () => ({
  clearClickBlocker: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/core/messaging', () => ({ sendMessage: vi.fn() }));

import { clearClickBlocker } from '@/automation/shared/click-safety';
import { realClick } from '@/automation/shared/dom-utils';
import { runCheckinWorkflow } from '@/automation/learning/workflow';
import type { SiteConfig } from '@/types';

const site: SiteConfig = {
  id: 'site-1',
  name: '测试站',
  loginUrl: `${window.location.origin}/login`,
  selectors: { username: '#user', password: '#pass', submit: '#submit' },
  closeModalSelectors: [],
};

const log = { push: vi.fn() };

beforeAll(() => {
  // jsdom 没有布局引擎：给所有元素非零矩形，让可见性判据按真实逻辑工作。
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    return {
      x: 0, y: 0, width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20,
      toJSON: () => ({}),
    } as DOMRect;
  };
  Element.prototype.getClientRects = function (): DOMRectList {
    const rect = this.getBoundingClientRect();
    return [rect] as unknown as DOMRectList;
  };
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true,
    get(this: HTMLElement) { return this.textContent ?? ''; },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: () => {},
  });
});

beforeEach(() => {
  window.history.replaceState({}, '', '/check-in');
  document.body.innerHTML = '';
  vi.mocked(clearClickBlocker).mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

/** 站点把签到按钮藏在 Turnstile 之后：验证控件先挂载，按钮在验证完成后才出现。 */
it('按钮在验证完成后才挂载：定位等待接管验证 → 点击前复查 → 只点击一次', async () => {
  const challenge = document.createElement('div');
  challenge.className = 'cf-turnstile';
  challenge.setAttribute('data-sitekey', 'test-sitekey');
  document.body.appendChild(challenge);

  const order: string[] = [];
  const beforeAction = vi.fn(async () => {
    order.push('beforeAction');
    if (!challenge.isConnected) return true;
    // 模拟「用户/自动流程完成验证」后按钮才挂载。
    challenge.remove();
    const button = document.createElement('button');
    button.id = 'checkin';
    button.textContent = '签到';
    document.body.appendChild(button);
    return true;
  });
  vi.mocked(realClick).mockImplementation(async (element: HTMLElement) => {
    order.push(`click:${element.id}`);
    return 'dom';
  });

  const result = await runCheckinWorkflow(
    site,
    { steps: [{ type: 'click', selector: '#checkin' }] },
    log,
    { beforeAction },
  );

  expect(beforeAction).toHaveBeenCalledTimes(2);
  expect(document.querySelectorAll('#checkin')).toHaveLength(1);
  expect(log.push).not.toHaveBeenCalledWith('工作流定位失败后检测到人机验证，完成验证后重试定位');
  expect(realClick).toHaveBeenCalledTimes(1);
  expect(vi.mocked(realClick).mock.calls[0]![0]).toHaveProperty('id', 'checkin');
  expect(order).toEqual(['beforeAction', 'beforeAction', 'click:checkin']);
  expect(clearClickBlocker).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'checkin' }),
    expect.any(Object),
    log,
    '工作流控件',
  );
  expect(result.status).toBe('unknown');
  if (result.status === 'unknown') expect(result.message).toContain('未读到签到结果证据');
});

/** 回归：页面没有验证证据时，不调用钩子、不加等待、行为与改动前一致。 */
it('页面没有验证时不触发补救：beforeAction 不调用，仍如实报找不到可点击元素', async () => {
  const beforeAction = vi.fn(async () => true);

  const result = await runCheckinWorkflow(
    site,
    { steps: [{ type: 'click', selector: '#checkin' }] },
    log,
    { beforeAction },
  );

  expect(beforeAction).not.toHaveBeenCalled();
  expect(realClick).not.toHaveBeenCalled();
  expect(log.push).not.toHaveBeenCalledWith('工作流定位失败后检测到人机验证，完成验证后重试定位');
  expect(result).toEqual({
    status: 'failed',
    message: '工作流找不到可点击元素: #checkin',
  });
});

/** 回归：目标本来就定位得到时，验证钩子仍按原有顺序只调用一次。 */
it('目标首次定位就命中：beforeAction 在点击前调用一次，验证补救分支不介入', async () => {
  const button = document.createElement('button');
  button.id = 'checkin';
  button.textContent = '签到';
  document.body.appendChild(button);

  const beforeAction = vi.fn(async () => true);
  vi.mocked(realClick).mockResolvedValue('dom');

  await runCheckinWorkflow(
    site,
    { steps: [{ type: 'click', selector: '#checkin' }] },
    log,
    { beforeAction },
  );

  expect(beforeAction).toHaveBeenCalledTimes(1);
  expect(log.push).not.toHaveBeenCalledWith('工作流定位失败后检测到人机验证，完成验证后重试定位');
  expect(realClick).toHaveBeenCalledTimes(1);
});
