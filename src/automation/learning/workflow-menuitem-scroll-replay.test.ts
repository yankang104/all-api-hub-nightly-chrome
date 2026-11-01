/**
 * 「滚动面板里的 role=menuitem『个人资料』，回放时点不到」独立回归。
 *
 * 现场（用户真实回放）：沿学习路线进入 /profile，点了中间的 text=Y 之后，
 * 日志只剩「向下/向上滚动查找 text=个人资料」，始终没有「工作流已点击 text=个人资料」。
 *
 * 已知根因是 TEXT_SELECTOR_SCOPE 不含 [role="menuitem"]，回放解析不到学习时
 * 录到的 text=个人资料。本文件独立复现存活的运行时事实：在候选范围已包含
 * menuitem 的前提下，「滚动面板 + 懒渲染 + 真实 realClick」整条链路能点到，
 * 并在日志里写出「工作流已点击 text=个人资料」。
 *
 * 选择器解析、等待、点击全部保留真实实现；只把 sleep 瞬时化以加速测试。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/automation/shared/dom-utils', async () => {
  const actual = await vi.importActual<typeof import('@/automation/shared/dom-utils')>(
    '@/automation/shared/dom-utils',
  );
  return {
    ...actual,
    realClick: vi.fn(actual.realClick),
    sleep: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('@/automation/shared/click-safety', () => ({
  clearClickBlocker: vi.fn().mockResolvedValue(null),
}));

import { realClick } from '@/automation/shared/dom-utils';
import { runCheckinWorkflow } from '@/automation/learning/workflow';
import type { SiteConfig } from '@/types';

const site: SiteConfig = {
  id: 'site-menuitem',
  name: '菜单项站',
  loginUrl: `${window.location.origin}/login`,
  selectors: { username: '#user', password: '#pass', submit: '#submit' },
  closeModalSelectors: [],
};

const log = { push: vi.fn() };

/** 模拟一个可滚动的菜单面板：clientHeight/scrollHeight 是 scrollToLocate 的判据。 */
function makeScrollPanel(): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'menu-panel';
  document.body.appendChild(panel);
  Object.defineProperty(panel, 'clientHeight', { configurable: true, value: 120 });
  Object.defineProperty(panel, 'scrollHeight', { configurable: true, value: 600 });
  Object.defineProperty(panel, 'scrollTop', { configurable: true, writable: true, value: 0 });
  Object.defineProperty(window, 'getComputedStyle', {
    configurable: true,
    value: ((el: Element) => (
      el === panel
        ? { overflowY: 'auto', display: 'block', visibility: 'visible', opacity: '1' }
        : { overflowY: 'visible', display: 'block', visibility: 'visible', opacity: '1' }
    )) as unknown as typeof window.getComputedStyle,
  });
  return panel;
}

beforeAll(() => {
  // jsdom 没有布局引擎：给所有元素非零矩形，让 isVisible 按真实逻辑判可见。
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    return {
      x: 0, y: 0, width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20,
      toJSON: () => ({}),
    } as DOMRect;
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

let elementFromPointTarget: Element | null = null;

beforeEach(() => {
  window.history.replaceState({}, '', '/profile');
  document.body.innerHTML = '';
  elementFromPointTarget = null;
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: () => elementFromPointTarget,
  });
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
  Reflect.deleteProperty(document, 'elementFromPoint');
});

describe('轨迹回放：滚动面板里的 role=menuitem「个人资料」', () => {
  it('面板在首屏下方、内容靠 IntersectionObserver 懒挂载：窗口被滚动后菜单项才挂载，最终点击成功', async () => {
    const panel = makeScrollPanel();
    const menuItem = document.createElement('div');
    menuItem.setAttribute('role', 'menuitem');
    menuItem.textContent = '个人资料';
    elementFromPointTarget = menuItem;
    const clicks: string[] = [];
    menuItem.addEventListener('click', () => clicks.push('click'));

    // 真实形态：面板整体位于视口下方（top=500），只有窗口滚动把面板带进视口后，
    // 内容才由 IntersectionObserver 挂载 —— 只改 panel.scrollTop 永远不会挂载。
    let pageY = 0;
    const windowScrolls: number[] = [];
    const panelRects: DOMRect[] = [];
    // 每个用例单独补丁，避免污染 Element.prototype 影响后续用例。
    Object.defineProperty(panel, 'getBoundingClientRect', {
      configurable: true,
      value: (): DOMRect => {
        const rect = {
          x: 0, y: 500 - pageY, width: 100, height: 120,
          top: 500 - pageY, left: 0, right: 100, bottom: 620 - pageY,
          toJSON: () => ({}),
        } as DOMRect;
        panelRects.push(rect);
        return rect;
      },
    });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
    Object.defineProperty(window, 'scrollBy', {
      configurable: true,
      value: (_x: number, y: number) => {
        windowScrolls.push(y);
        pageY += y;
        // IntersectionObserver 等价物：面板进入视口后才把菜单项挂进 DOM。
        if (pageY > 0 && !menuItem.isConnected) panel.appendChild(menuItem);
      },
    });
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => pageY });

    const result = await runCheckinWorkflow(
      site,
      { steps: [{ type: 'click', selector: 'text=个人资料', scrollIntoView: true, scrollContainer: '.menu-panel' }] },
      log,
    );

    // 关键证明一：容器场景确实滚了窗口（而不是只改 panel.scrollTop）。
    expect(windowScrolls.some((y) => y > 0)).toBe(true);
    expect(log.push).toHaveBeenCalledWith(expect.stringContaining('工作流滚动页面向下查找 text=个人资料'));
    // 关键证明二：懒挂载的菜单项最终被点到，并如实写出降级点击日志。
    expect(clicks).toEqual(['click']);
    expect(log.push).toHaveBeenCalledWith('工作流已点击 text=个人资料（DOM 合成点击，未使用浏览器可信指针）');
    expect(result.status).not.toBe('failed');
  });

  it('菜单项已在 DOM：真实解析到它、真实触发点击，日志出现「工作流已点击 text=个人资料」', async () => {
    const panel = makeScrollPanel();
    panel.innerHTML = '<div role="menuitem">个人资料</div>';
    const menuItem = document.querySelector<HTMLElement>('[role="menuitem"]')!;
    elementFromPointTarget = menuItem;

    const clicks: string[] = [];
    menuItem.addEventListener('click', () => clicks.push('click'));

    const result = await runCheckinWorkflow(
      site,
      { steps: [{ type: 'click', selector: 'text=个人资料', scrollIntoView: true, scrollContainer: '.menu-panel' }] },
      log,
    );

    expect(clicks).toEqual(['click']);
    expect(realClick).toHaveBeenCalledWith(menuItem, { mayNavigate: false });
    expect(log.push).toHaveBeenCalledWith('工作流已点击 text=个人资料（DOM 合成点击，未使用浏览器可信指针）');
    expect(result.status).not.toBe('failed');
  });

  it('菜单项懒渲染：面板先滚动、菜单项后挂载，仍能定位并记录「工作流已点击 text=个人资料」', async () => {
    const panel = makeScrollPanel();
    const menuItem = document.createElement('div');
    menuItem.setAttribute('role', 'menuitem');
    menuItem.textContent = '个人资料';
    elementFromPointTarget = menuItem;
    const clicks: string[] = [];
    menuItem.addEventListener('click', () => clicks.push('click'));

    // 模拟懒渲染：面板的 scrollTop 第一次被推大时，菜单项才挂进 DOM。
    // jsdom 对 scrollTop 赋值不派发 scroll 事件，所以在 setter 里挂载。
    let scrollTop = 0;
    Object.defineProperty(panel, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
        if (scrollTop > 0 && !menuItem.isConnected) panel.appendChild(menuItem);
      },
    });

    const result = await runCheckinWorkflow(
      site,
      { steps: [{ type: 'click', selector: 'text=个人资料', scrollIntoView: true, scrollContainer: '.menu-panel' }] },
      log,
    );

    expect(clicks).toEqual(['click']);
    expect(log.push).toHaveBeenCalledWith('工作流滚动学习面板 .menu-panel向下查找 text=个人资料');
    expect(log.push).toHaveBeenCalledWith('工作流已点击 text=个人资料（DOM 合成点击，未使用浏览器可信指针）');
    expect(result.status).not.toBe('failed');
  });
});
