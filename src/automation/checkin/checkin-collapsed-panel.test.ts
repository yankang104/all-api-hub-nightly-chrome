/**
 * 通用扫描展开折叠的签到面板。
 *
 * 修的是实测两次的同一件事（维云、海獭 AI）：新版界面把「每日签到」做成
 * 手风琴面板，**折叠状态下 `立即签到` 按钮不在 DOM 里**。通用扫描等满 12 秒
 * 也只能列出导航栏和侧栏：
 *
 *   页面可点元素：跳到主内容 / Toggle Sidebar / 海獭AI 返回主页 / 搜索 ⌘K
 *                / 通知 / 更改语言 / 打开主题设置 / Y
 *
 * 而用户截图里页面上明明有个蓝色的「立即签到」。原来 `checkin.ts` 里
 * 没有任何 `aria-expanded` 处理 —— 专用工作流（vsllm-daily）有，通用路径没有。
 */

import { describe, expect, it, vi } from 'vitest';
import type { SiteConfig } from '@/types';

const realClick = vi.hoisted(() => vi.fn());

vi.mock('@/automation/shared/dom-utils', () => ({
  describeElement: (el: Element) => el.tagName.toLowerCase(),
  isVisible: () => true,
  queryFirst: (selector: string) => document.querySelector(selector),
  realClick,
  setNativeValue: vi.fn(),
  sleep: vi.fn().mockResolvedValue(undefined),
  waitFor: vi.fn().mockResolvedValue(null),
  elementBlocking: vi.fn().mockReturnValue(null),
  pressEnter: vi.fn(),
  domClick: vi.fn(),
}));

vi.mock('@/automation/balance/balance', () => ({
  captureBalance: vi.fn().mockResolvedValue(null),
  describeMetrics: vi.fn().mockReturnValue(''),
  diffBalance: vi.fn().mockReturnValue({ verdict: 'unknown' }),
  readNewVisibleCheckinRewardObservation: vi.fn().mockReturnValue(null),
  readVisibleCheckinRewardObservation: vi.fn().mockReturnValue(null),
  // checkin.ts 会用它把「页面宣告了今日奖励」提升为签到证据；
  // 本文件只关心折叠面板的展开，恒等替身让结论原样穿过。
  withVisibleTodayRewardEvidence: vi.fn((metrics: unknown) => metrics),
}));

vi.mock('@/automation/shared/announcements', () => ({
  dismissAnnouncements: vi.fn().mockResolvedValue({ closed: 0, blocked: false }),
}));

vi.mock('@/automation/shared/click-safety', () => ({
  clearClickBlocker: vi.fn().mockResolvedValue(null),
}));

const { performCheckin } = await import('@/automation/checkin/checkin');

function site(): SiteConfig {
  return {
    id: 'site-otter',
    name: '海獭AI',
    loginUrl: `${window.location.origin}/login`,
    selectors: { username: '#username', password: '#password', submit: 'button' },
    closeModalSelectors: [],
    checkin: { method: 'auto' },
    adapter: { family: 'unsupported', quotaPerUnit: 1 },
  };
}

/**
 * 复刻实测页面：几个折叠面板 + 一堆页面骨架控件。
 * 折叠时签到按钮不在 DOM 里，点开标题才插入。
 */
function collapsedPage() {
  document.body.innerHTML = `
    <nav>
      <a href="#main">跳到主内容</a>
      <button>Toggle Sidebar</button>
      <a href="/">海獭AI 返回主页</a>
      <button>搜索 ⌘ K</button>
      <button>通知</button>
      <button>更改语言</button>
      <button>打开主题设置</button>
    </nav>
    <div class="panel" id="pool">
      <div role="button" aria-expanded="false">号池状态预览</div>
    </div>
    <div class="panel" id="daily">
      <div role="button" aria-expanded="false">每日签到</div>
    </div>
  `;

  // 点开「每日签到」标题时才插入按钮 —— 折叠面板的真实行为
  const header = document.querySelector<HTMLElement>('#daily [role="button"]')!;
  realClick.mockImplementation(async (element: unknown) => {
    if (element !== header) return;
    header.setAttribute('aria-expanded', 'true');
    const body = document.createElement('div');
    body.innerHTML = '<button id="sign">立即签到</button>';
    document.querySelector('#daily')!.appendChild(body);
  });
  return header;
}

describe('折叠签到面板', () => {
  it('等不到按钮时展开面板，然后找到「立即签到」', async () => {
    const header = collapsedPage();
    const log = { push: vi.fn() };

    await performCheckin(site(), log, {});

    // 点开了签到面板
    expect(realClick).toHaveBeenCalledWith(header);
    // 日志要说清做了什么
    expect(log.push).toHaveBeenCalledWith(expect.stringContaining('已展开折叠的签到面板'));
    // 展开后按钮确实进了 DOM
    expect(document.querySelector('#sign')).not.toBeNull();
  }, 40_000);

  it('不展开与签到无关的面板（「号池状态预览」）', async () => {
    collapsedPage();
    const log = { push: vi.fn() };

    await performCheckin(site(), log, {});

    const clicked = realClick.mock.calls.map(([el]) => (el as HTMLElement).textContent?.trim());
    expect(clicked).not.toContain('号池状态预览');
  }, 40_000);

  it('已展开的面板不会被再点一次（点了会收起来）', async () => {
    document.body.innerHTML = `
      <div class="panel" id="daily">
        <div role="button" aria-expanded="true">每日签到</div>
        <div><button id="sign">立即签到</button></div>
      </div>
    `;
    const log = { push: vi.fn() };
    realClick.mockClear();
    realClick.mockResolvedValue(undefined);

    await performCheckin(site(), log, {});

    const clicked = realClick.mock.calls.map(([el]) => (el as HTMLElement).textContent?.trim());
    expect(clicked).not.toContain('每日签到');
  }, 40_000);

  it('页面上没有折叠面板时行为不变（不影响现有站点）', async () => {
    document.body.innerHTML = '<nav><button>通知</button></nav>';
    const log = { push: vi.fn() };
    realClick.mockClear();
    realClick.mockResolvedValue(undefined);

    const outcome = await performCheckin(site(), log, {});

    expect(realClick).not.toHaveBeenCalled();
    expect(outcome.status).toBe('failed');
    expect(log.push).not.toHaveBeenCalledWith(expect.stringContaining('已展开折叠'));
  }, 40_000);

  it('两层同名标题时展开最外层（内层会让作用域缩小）', async () => {
    document.body.innerHTML = `
      <div class="panel" id="daily">
        <div role="button" aria-expanded="false" id="outer">每日签到</div>
        <div id="inner-wrap">
          <div role="button" aria-expanded="false" id="inner">每日签到</div>
        </div>
      </div>
    `;
    const log = { push: vi.fn() };
    realClick.mockClear();
    realClick.mockResolvedValue(undefined);

    await performCheckin(site(), log, {});

    const clickedIds = realClick.mock.calls.map(([el]) => (el as HTMLElement).id);
    expect(clickedIds).toContain('outer');
    // 内层在外层里面，不该被单独点
    expect(clickedIds).not.toContain('inner');
  }, 40_000);
});
