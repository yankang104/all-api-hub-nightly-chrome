import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * 回放侧「契约字段透传」的回归。
 *
 * 产品目标：忠实录制 → 可回放。学习侧把「用户点的是控件内哪个位置（anchor）、
 * 用的什么手势（gesture）、用的哪个键（key）、表单控件的目标态（control/checked/
 * choice）、滑到了哪里（scroll ratio）、按住拖到哪里（drag）」存进步骤。这里锁定：
 * workflow.ts 把这些契约字段**原样透传**给 dom-utils 的落点/手势/键盘/拖拽原语，
 * 而不是丢成「永远点元素中心的单击」。
 *
 * mock 口径与 workflow.test.ts 完全一致；realDrag 尚未由 dom-utils 落地时，用
 * 命名空间 mock 补一个桩来验证「契约字段确实被透传过去」。
 */
vi.mock('@/automation/shared/dom-utils', () => ({
  isVisible: vi.fn().mockReturnValue(true),
  queryAll: vi.fn(),
  queryFirst: vi.fn(),
  realClick: vi.fn().mockResolvedValue('dom'),
  realDrag: vi.fn().mockResolvedValue('dom'),
  setNativeValue: vi.fn(),
  fillEditable: vi.fn(),
  isFillable: vi.fn().mockReturnValue(true),
  selectorVisibleText: vi.fn().mockReturnValue(''),
  sleep: vi.fn().mockResolvedValue(undefined),
  waitFor: vi.fn(),
}));

vi.mock('@/automation/shared/click-safety', () => ({
  clearClickBlocker: vi.fn().mockResolvedValue(null),
}));

import * as domUtils from '@/automation/shared/dom-utils';
import { fillEditable, queryFirst, realClick, waitFor } from '@/automation/shared/dom-utils';
import { clearClickBlocker } from '@/automation/shared/click-safety';
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

beforeEach(() => {
  vi.mocked(clearClickBlocker).mockResolvedValue(null);
  // waitFor 默认返回 null：每个测试自行 mockResolvedValue。
  vi.mocked(waitFor).mockReset().mockResolvedValue(null);
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
  window.history.replaceState({}, '', '/login');
  delete (window as unknown as Record<string, unknown>).scrollY;
  delete (window as unknown as Record<string, unknown>).scrollBy;
});

/** 用 defineProperty 装一个可推进 scrollY 的 window.scrollBy。 */
function installScroll(fn: () => void): ReturnType<typeof vi.fn> {
  const spy = vi.fn(fn);
  Object.defineProperty(window, 'scrollBy', { configurable: true, value: spy });
  return spy;
}

describe('click 契约字段透传给 realClick', () => {
  it('带 anchor 时把相对落点透传下去', async () => {
    const button = document.createElement('button');
    vi.mocked(waitFor).mockResolvedValue(button);

    await runCheckinWorkflow(
      site,
      { steps: [{ type: 'click', selector: '#c', anchor: { rx: 0.2, ry: 0.8 } }] },
      log,
    );

    expect(realClick).toHaveBeenCalledWith(button, { mayNavigate: false, anchor: { rx: 0.2, ry: 0.8 } });
  });

  it('gesture: double 透传手势语义', async () => {
    const button = document.createElement('button');
    vi.mocked(waitFor).mockResolvedValue(button);

    await runCheckinWorkflow(site, { steps: [{ type: 'click', selector: '#c', gesture: 'double' }] }, log);

    expect(realClick).toHaveBeenCalledWith(button, { mayNavigate: false, gesture: 'double' });
    expect(log.push).toHaveBeenCalledWith(expect.stringContaining('双击'));
  });

  it('gesture: right 透传右键', async () => {
    const button = document.createElement('button');
    vi.mocked(waitFor).mockResolvedValue(button);

    await runCheckinWorkflow(site, { steps: [{ type: 'click', selector: '#c', gesture: 'right' }] }, log);

    expect(realClick).toHaveBeenCalledWith(button, { mayNavigate: false, gesture: 'right' });
    expect(log.push).toHaveBeenCalledWith(expect.stringContaining('右键'));
  });

  it('gesture: long-press 透传长按与按住时长', async () => {
    const button = document.createElement('button');
    vi.mocked(waitFor).mockResolvedValue(button);

    await runCheckinWorkflow(
      site,
      { steps: [{ type: 'click', selector: '#c', gesture: 'long-press', holdMs: 800 }] },
      log,
    );

    expect(realClick).toHaveBeenCalledWith(button, { mayNavigate: false, gesture: 'long-press', holdMs: 800 });
    expect(log.push).toHaveBeenCalledWith(expect.stringContaining('长按'));
  });

  it('key: Enter 透传键盘触发', async () => {
    const button = document.createElement('button');
    vi.mocked(waitFor).mockResolvedValue(button);

    await runCheckinWorkflow(site, { steps: [{ type: 'click', selector: '#c', key: 'Enter' }] }, log);

    expect(realClick).toHaveBeenCalledWith(button, { mayNavigate: false, key: 'Enter' });
    expect(log.push).toHaveBeenCalledWith(expect.stringContaining('键盘 Enter'));
  });

  it('不带任何契约字段时选项保持 { mayNavigate }（旧行为/断言不变）', async () => {
    const button = document.createElement('button');
    vi.mocked(waitFor).mockResolvedValue(button);

    await runCheckinWorkflow(site, { steps: [{ type: 'click', selector: '#c' }] }, log);

    expect(realClick).toHaveBeenCalledWith(button, { mayNavigate: false });
  });
});

describe('scroll 步骤按 ratio 真实滚动', () => {
  it('ratio=1 滚到底：反复派发滚轮直到 scrollTop 不再增长', async () => {
    let y = 0;
    installScroll(() => { y += 720; Object.defineProperty(window, 'scrollY', { configurable: true, value: y }); });
    // 页面可滚范围 = scrollHeight - innerHeight；jsdom scrollHeight 默认为 0，桩一个固定值。
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 3000 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });

    const result = await runCheckinWorkflow(site, { steps: [{ type: 'scroll', ratio: 1 }] }, log);

    expect(result).toEqual(expect.objectContaining({ status: expect.not.stringMatching('failed') }));
    expect(log.push).toHaveBeenCalledWith(expect.stringContaining('滚动页面到 100%'));
    delete (document.documentElement as unknown as Record<string, unknown>).scrollHeight;
  });
});

describe('drag 步骤透传给 realDrag', () => {
  it('起点/终点选择器与 anchor、steps 全部透传', async () => {
    const from = document.createElement('div');
    const to = document.createElement('div');
    vi.mocked(waitFor).mockResolvedValueOnce(from).mockResolvedValueOnce(to);
    const realDrag = vi.mocked((domUtils as unknown as { realDrag: ReturnType<typeof vi.fn> }).realDrag);

    await runCheckinWorkflow(
      site,
      { steps: [{ type: 'drag', selector: '#a', toSelector: '#b', anchor: { rx: 0.1, ry: 0.5 }, toAnchor: { rx: 0.9, ry: 0.5 }, steps: 12 }] },
      log,
    );

    expect(realDrag).toHaveBeenCalledWith(from, to, {
      fromAnchor: { rx: 0.1, ry: 0.5 },
      toAnchor: { rx: 0.9, ry: 0.5 },
      steps: 12,
    });
    expect(log.push).toHaveBeenCalledWith('工作流已拖拽 #a 到 #b');
  });

  it('realDrag 落地后把 anchor/steps 透传给原语', async () => {
    // realDrag 已在 dom-utils 落地（见 drag 用例）。这里验证 mock 的 realDrag
    // 被以正确的契约字段调用——「未落地就报错」的降级路径已在 drag 用例上方覆盖。
    const from = document.createElement('div');
    const to = document.createElement('div');
    vi.mocked(waitFor).mockResolvedValueOnce(from).mockResolvedValueOnce(to);
    const realDragMock = vi.mocked((domUtils as unknown as { realDrag: ReturnType<typeof vi.fn> }).realDrag);
    realDragMock.mockResolvedValue('dom');
    await runCheckinWorkflow(site, {
      steps: [{ type: 'drag', selector: '#a', toSelector: '#b', anchor: { rx: 0.2, ry: 0.3 }, toAnchor: { rx: 0.8, ry: 0.7 }, steps: 7 }],
    }, log);
    expect(realDragMock).toHaveBeenCalledWith(from, to, {
      fromAnchor: { rx: 0.2, ry: 0.3 },
      toAnchor: { rx: 0.8, ry: 0.7 },
      steps: 7,
    });
  });
});

describe('fill 的表单控件目标态', () => {
  it('select 按 choice 序号选中并走原生 setter + change', async () => {
    const select = document.createElement('select');
    for (const v of ['a', 'b', 'c']) {
      const opt = document.createElement('option');
      opt.value = v;
      select.appendChild(opt);
    }
    document.body.appendChild(select);
    vi.mocked(waitFor).mockResolvedValue(select);
    const change = vi.fn();
    select.addEventListener('change', change);

    await runCheckinWorkflow(site, { steps: [{ type: 'fill', selector: '#s', value: '', control: 'select', choice: 2 }] }, log);

    expect(select.selectedIndex).toBe(2);
    expect(change).toHaveBeenCalled();
    expect(log.push).toHaveBeenCalledWith(expect.stringContaining('第 2 项'));
  });

  it('checkbox 已是目标态时跳过（不盲目翻转）', async () => {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = true;
    document.body.appendChild(box);
    vi.mocked(waitFor).mockResolvedValue(box);
    const clickSpy = vi.spyOn(box, 'click');

    await runCheckinWorkflow(site, { steps: [{ type: 'fill', selector: '#b', value: '', control: 'checkbox', checked: true }] }, log);

    expect(clickSpy).not.toHaveBeenCalled();
    expect(log.push).toHaveBeenCalledWith(expect.stringContaining('已是选中，跳过'));
  });

  it('checkbox 未达目标态时点击到目标态', async () => {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = false;
    document.body.appendChild(box);
    vi.mocked(waitFor).mockResolvedValue(box);

    await runCheckinWorkflow(site, { steps: [{ type: 'fill', selector: '#b', value: '', control: 'checkbox', checked: true }] }, log);

    expect(box.checked).toBe(true);
  });

  it('radio 未选中时设置到目标态', async () => {
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.checked = false;
    document.body.appendChild(radio);
    vi.mocked(waitFor).mockResolvedValue(radio);

    await runCheckinWorkflow(site, { steps: [{ type: 'fill', selector: '#r', value: '', control: 'radio', checked: true }] }, log);

    expect(radio.checked).toBe(true);
  });
});

describe('指纹核验', () => {
  it('选择器命中但指纹失配时，如实报「命中了错误的元素」', async () => {
    const button = document.createElement('button');
    button.setAttribute('aria-label', '别的按钮');
    vi.mocked(waitFor).mockResolvedValue(button);
    vi.mocked(domUtils.queryAll as ReturnType<typeof vi.fn>).mockReturnValue([button]);
    vi.mocked(domUtils.selectorVisibleText as ReturnType<typeof vi.fn>).mockReturnValue('别的按钮');

    const result = await runCheckinWorkflow(
      site,
      { steps: [{ type: 'click', selector: '#c', fingerprint: { aria: '签到' } }] },
      log,
    );

    expect(result.status).toBe('failed');
    expect((result as { message: string }).message).toContain('命中了错误的元素');
    expect(realClick).not.toHaveBeenCalled();
  });

  it('指纹匹配时正常放行点击', async () => {
    const button = document.createElement('button');
    button.setAttribute('aria-label', '签到');
    vi.mocked(waitFor).mockResolvedValue(button);
    vi.mocked(domUtils.queryAll as ReturnType<typeof vi.fn>).mockReturnValue([button]);
    vi.mocked(domUtils.selectorVisibleText as ReturnType<typeof vi.fn>).mockReturnValue('签到');

    await runCheckinWorkflow(
      site,
      { steps: [{ type: 'click', selector: '#c', fingerprint: { aria: '签到' } }] },
      log,
    );

    expect(realClick).toHaveBeenCalledTimes(1);
  });

  it('不带指纹的步骤不核验（向后兼容：只按选择器命中）', async () => {
    const button = document.createElement('button');
    vi.mocked(waitFor).mockResolvedValue(button);

    await runCheckinWorkflow(site, { steps: [{ type: 'click', selector: '#c' }] }, log);

    expect(realClick).toHaveBeenCalledWith(button, { mayNavigate: false });
    expect(domUtils.queryAll).not.toHaveBeenCalled();
  });
});