import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * 回放侧「先滚再点」的回归。
 *
 * 用户报的缺陷：签到控件在首屏下方，学习时用户**先滑动页面**才够得着它。真实站点这
 * 一类控件常常是**懒渲染**（虚拟列表 / 滚动加载）：页面停在顶部时它根本不在 DOM。
 * 回放时执行器在首屏 `waitFor` 到超时都找不到它 → 报「工作流找不到可点击元素」，
 * 而学习明明记下了 `scrollIntoView:true`。这里锁定：带 `scrollIntoView` 的步骤在首屏
 * 找不到目标时，应先渐进向下滚动页面、每滚一段重试定位，直到控件出现后再点/填。
 *
 * mock 口径与 workflow.test.ts 完全一致（包含 dom-utils 全部被 workflow.ts 引用的导出，
 * 少一个整文件会报 No X export）。
 */
vi.mock('@/automation/shared/dom-utils', () => ({
  isVisible: vi.fn().mockReturnValue(true),
  queryFirst: vi.fn(),
  realClick: vi.fn().mockResolvedValue('dom'),
  setNativeValue: vi.fn(),
  fillEditable: vi.fn(),
  isFillable: vi.fn().mockReturnValue(true),
  sleep: vi.fn().mockResolvedValue(undefined),
  waitFor: vi.fn(),
}));

vi.mock('@/automation/shared/click-safety', () => ({
  clearClickBlocker: vi.fn().mockResolvedValue(null),
}));

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

/** 用 defineProperty 装一个可观察、可推进的 window.scrollBy（jsdom 原生是 no-op）。 */
function installScrollBy(fn: (x: number, y: number) => void): ReturnType<typeof vi.fn> {
  const spy = vi.fn(fn);
  Object.defineProperty(window, 'scrollBy', { configurable: true, value: spy });
  return spy;
}

/**
 * 复刻「控件懒渲染在首屏下方」：页面在顶部时 `waitFor` 落空，向下滚 `appearAfter`
 * 段之后控件才挂进 DOM。滚动通过 window.scrollBy 的桩推进 window.scrollY —— 不打桩
 * 的话 jsdom 里页面位置恒为 0，回放侧会把它当成「已到底」。
 */
function stubLazyControl(element: Element, appearAfter: number) {
  let scrolls = 0;
  const scrollBy = installScrollBy(() => {
    scrolls += 1;
    Object.defineProperty(window, 'scrollY', { configurable: true, value: scrolls * 720 });
  });
  vi.mocked(waitFor).mockImplementation(async () => (scrolls >= appearAfter ? (element as HTMLElement) : null));
  return { scrollBy };
}

beforeEach(() => {
  vi.mocked(clearClickBlocker).mockResolvedValue(null);
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
  // jsdom 不实现 scrollIntoView（真实浏览器 HTMLElement 上恒有）；补一个 no-op，
  // 让 workflow.ts click 分支里 element.scrollIntoView(...) 能在测试环境跑通。
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
  window.history.replaceState({}, '', '/login');
  delete (window as unknown as Record<string, unknown>).scrollY;
  delete (window as unknown as Record<string, unknown>).scrollBy;
});

describe('回放：签到控件在首屏下方且懒渲染', () => {
  it('带 scrollIntoView 的点击：首屏找不到就渐进下滚，控件出现后真的点到它', async () => {
    const button = document.createElement('button');
    const { scrollBy } = stubLazyControl(button, 2);

    const result = await runCheckinWorkflow(
      site,
      { steps: [{ type: 'click', selector: '#claim', scrollIntoView: true }] },
      log,
    );

    // 核心回归：不再是「找不到可点击元素」，而是滚下去把它点到
    expect(scrollBy).toHaveBeenCalled();
    expect(realClick).toHaveBeenCalledTimes(1);
    expect(realClick).toHaveBeenCalledWith(button, { mayNavigate: false });
    expect(result).not.toEqual({ status: 'failed', message: '工作流找不到可点击元素: #claim' });
  });

  it('带 scrollIntoView 的填充：输入框懒渲染在下方，也能滚到后填入', async () => {
    const textarea = document.createElement('textarea');
    const { scrollBy } = stubLazyControl(textarea, 2);

    const result = await runCheckinWorkflow(
      { ...site, checkin: { method: 'workflow', claimText: '感谢' } },
      { steps: [{ type: 'fill', selector: '#reason', value: '{{claimText}}', scrollIntoView: true }] },
      log,
    );

    expect(scrollBy).toHaveBeenCalled();
    expect(fillEditable).toHaveBeenCalledWith(textarea, '感谢');
    expect(result).not.toEqual({ status: 'failed', message: '工作流找不到可输入元素: #reason' });
  });

  it('不带 scrollIntoView 的普通点击：只探测一次，绝不滚动页面（老行为不变）', async () => {
    const button = document.createElement('button');
    const scrollBy = installScrollBy(() => {});
    vi.mocked(waitFor).mockResolvedValue(button);

    await runCheckinWorkflow(
      site,
      { steps: [{ type: 'click', selector: '#claim' }] },
      log,
    );

    expect(waitFor).toHaveBeenCalledTimes(1);
    expect(scrollBy).not.toHaveBeenCalled();
    expect(realClick).toHaveBeenCalledTimes(1);
  });

  it('控件始终不出现且页面滚不动时，有界收尾报「找不到」而不是无限下滚', async () => {
    // scrollBy 为 no-op：页面位置恒为 0（已在底部/不可滚动），控件也永远不出现
    const scrollBy = installScrollBy(() => {});
    vi.mocked(waitFor).mockResolvedValue(null);

    const result = await runCheckinWorkflow(
      site,
      { steps: [{ type: 'click', selector: '#missing', scrollIntoView: true, timeoutMs: 3_000 }] },
      log,
    );

    expect(result).toEqual({ status: 'failed', message: '工作流找不到可点击元素: #missing' });
    expect(realClick).not.toHaveBeenCalled();
    // 给过懒渲染机会（尝试滚过），但没有陷入无限循环
    expect(scrollBy).toHaveBeenCalled();
  });

  it('学习时的滚动面板已不存在：退回通用滚动查找，不因面板改版直接失败', async () => {
    // 站点改版把学习时的内层面板组件换掉了（选择器解析不到）。这类旧学习产物
    // 不能因此永远失败：降级成「可见面板 + 整页」的通用扫描，目标仍能被滚出来。
    vi.mocked(queryFirst).mockReturnValue(null);
    const button = document.createElement('button');
    const { scrollBy } = stubLazyControl(button, 2);

    const result = await runCheckinWorkflow(
      site,
      { steps: [{ type: 'click', selector: '#claim', scrollIntoView: true, scrollContainer: '#panel-gone' }] },
      log,
    );

    expect(scrollBy).toHaveBeenCalled();
    expect(realClick).toHaveBeenCalledWith(button, { mayNavigate: false });
    expect(result).not.toEqual({ status: 'failed', message: '工作流找不到可点击元素: #claim' });
    expect(log.push).toHaveBeenCalledWith(expect.stringContaining('退回到页面通用滚动查找'));
  });

  /*
   * 学习没记到滚动（老配置产物，或回放时页面比学习时更长）也要能兜底。
   *
   * Motomoto 实测：学出的流程步骤上没有 `scrollIntoView`，而真实站点把签到栏放在首屏
   * 下方且懒渲染。若只对带标记的步骤下滚，这类产物永远够不着控件、日志停在「未滑动到
   * 签到那一栏」。所以普通步骤在首屏 `waitFor` 等满仍落空时，也要下滚兜底一次。
   */
  it('不带 scrollIntoView 的步骤：首屏等满仍落空时，也下滚兜底把懒渲染控件找回来', async () => {
    const button = document.createElement('button');
    const { scrollBy } = stubLazyControl(button, 2);

    const result = await runCheckinWorkflow(
      site,
      // 注意：步骤上没有 scrollIntoView
      { steps: [{ type: 'click', selector: '#claim', timeoutMs: 1_000 }] },
      log,
    );

    // 首屏等满找不到后仍下滚，最终点到控件，而不是直接报「找不到」
    expect(scrollBy).toHaveBeenCalled();
    expect(realClick).toHaveBeenCalledTimes(1);
    expect(realClick).toHaveBeenCalledWith(button, { mayNavigate: false });
    expect(result).not.toEqual({ status: 'failed', message: '工作流找不到可点击元素: #claim' });
  });
});
