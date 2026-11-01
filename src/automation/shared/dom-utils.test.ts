import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/core/messaging', () => ({ sendMessage: vi.fn() }));

import { sendMessage } from '@/lib/core/messaging';
import { queryFirst, realClick, setActiveClickRunId } from '@/automation/shared/dom-utils';

function installVisibleElement(rects: Array<Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>> = [
  { left: 10, top: 20, width: 100, height: 40 },
]) {
  const click = vi.fn();
  let rectIndex = 0;
  const attributes = new Map<string, string>();
  const element = {
    click,
    contains: (candidate: unknown) => candidate === element,
    dispatchEvent: vi.fn(),
    getAttribute: (name: string) => attributes.get(name) ?? null,
    getBoundingClientRect: () => rects[Math.min(rectIndex++, rects.length - 1)] as DOMRect,
    removeAttribute: (name: string) => attributes.delete(name),
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    scrollIntoView: vi.fn(),
  } as unknown as HTMLElement;

  vi.stubGlobal('window', { innerWidth: 800, innerHeight: 600 });
  vi.stubGlobal('document', { elementFromPoint: () => element });
  vi.stubGlobal('MouseEvent', class {
    constructor(
      readonly type: string,
      readonly init?: MouseEventInit,
    ) {}
  });
  vi.stubGlobal('chrome', { runtime: { id: 'test-extension' } });

  return { click, element };
}

afterEach(() => {
  setActiveClickRunId(null);
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('realClick pointer mode', () => {
  it('uses verified DOM clicking when the site explicitly requests dom mode', async () => {
    const { click, element } = installVisibleElement();
    setActiveClickRunId('run-dom', 'dom');

    await expect(realClick(element)).resolves.toBe('dom');

    expect(click).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('keeps trusted browser input as the default for active production tasks', async () => {
    const { click, element } = installVisibleElement();
    vi.mocked(sendMessage).mockResolvedValue({
      ok: true,
      feature: { pointer: { mode: 'trusted', pathPoints: 12, clickObserved: true } },
    });
    setActiveClickRunId('run-trusted');

    await expect(realClick(element)).resolves.toBe('trusted');

    expect(click).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'TRUSTED_POINTER_CLICK',
      runId: 'run-trusted',
      x: 60,
      y: 40,
      viewportWidth: 800,
      viewportHeight: 600,
      targetToken: expect.stringMatching(/^p-/),
    }));
  });

  it('preserves the Turnstile inset and exposes the final live target diagnostics', async () => {
    const { element } = installVisibleElement();
    const onPointerResult = vi.fn();
    const pointer = {
      mode: 'trusted' as const,
      pathPoints: 12,
      clickObserved: false,
      target: {
        x: 34,
        y: 40,
        rect: { left: 10, top: 20, width: 100, height: 40 },
        hit: true,
        withinHost: true,
      },
    };
    vi.mocked(sendMessage).mockResolvedValue({ ok: true, feature: { pointer } });
    setActiveClickRunId('run-turnstile');

    await expect(realClick(element, {
      insetLeftPx: 24,
      shadowTarget: true,
      onPointerResult,
    })).resolves.toBe('trusted');

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      x: 34,
      y: 40,
      anchor: { kind: 'inset-left', px: 24 },
    }));
    expect(onPointerResult).toHaveBeenCalledWith(pointer);
  });

  it('waits for smooth scrolling to settle before sending trusted coordinates', async () => {
    const { element } = installVisibleElement([
      { left: 10, top: 120, width: 100, height: 40 },
      { left: 10, top: 80, width: 100, height: 40 },
      { left: 10, top: 40, width: 100, height: 40 },
      { left: 10, top: 40, width: 100, height: 40 },
      { left: 10, top: 40, width: 100, height: 40 },
    ]);
    vi.mocked(sendMessage).mockResolvedValue({
      ok: true,
      feature: { pointer: { mode: 'trusted', pathPoints: 12, clickObserved: true } },
    });
    setActiveClickRunId('run-smooth-scroll');

    await realClick(element);

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ x: 60, y: 60 }));
  });

  it('accepts a lost trusted response only for clicks that explicitly expect navigation', async () => {
    const { click, element } = installVisibleElement();
    vi.mocked(sendMessage).mockResolvedValue({ ok: true });
    setActiveClickRunId('run-navigation');

    await expect(realClick(element, { mayNavigate: true })).resolves.toBe('trusted');
    expect(click).not.toHaveBeenCalled();
  });

  it('continues terminal reconciliation when a navigation click response times out', async () => {
    const { click, element } = installVisibleElement();
    vi.mocked(sendMessage).mockResolvedValue({
      ok: false,
      error: '后台在 45 秒内没有响应 TRUSTED_POINTER_CLICK（Service Worker 可能已被回收）',
    });
    setActiveClickRunId('run-navigation-timeout');

    await expect(realClick(element, {
      mayNavigate: true,
      reconcileAfterLostResponse: true,
    })).resolves.toBe('trusted');
    expect(click).not.toHaveBeenCalled();
  });

  it('also reconciles when the background CDP command reports an unknown result', async () => {
    const { click, element } = installVisibleElement();
    vi.mocked(sendMessage).mockResolvedValue({
      ok: false,
      error: '可信点击阶段「CDP Runtime.evaluate」超时（点击结果可能未知）',
    });
    setActiveClickRunId('run-cdp-timeout');

    await expect(realClick(element, {
      mayNavigate: true,
      reconcileAfterLostResponse: true,
    })).resolves.toBe('trusted');
    expect(click).not.toHaveBeenCalled();
  });

  it('does not hide trusted click timeouts without explicit terminal reconciliation', async () => {
    const { element } = installVisibleElement();
    vi.mocked(sendMessage).mockResolvedValue({
      ok: false,
      error: '后台在 45 秒内没有响应 TRUSTED_POINTER_CLICK（Service Worker 可能已被回收）',
    });
    setActiveClickRunId('run-navigation-timeout-without-reconciliation');

    await expect(realClick(element, { mayNavigate: true })).rejects.toThrow('浏览器级鼠标点击失败');
  });

  it('does not hide non-timeout failures for navigation clicks', async () => {
    const { element } = installVisibleElement();
    vi.mocked(sendMessage).mockResolvedValue({ ok: false, error: '当前页面不属于该签到任务' });
    setActiveClickRunId('run-navigation-rejected');

    await expect(realClick(element, { mayNavigate: true })).rejects.toThrow('当前页面不属于该签到任务');
  });

  it('still rejects a missing trusted response for ordinary in-page controls', async () => {
    const { element } = installVisibleElement();
    vi.mocked(sendMessage).mockResolvedValue({ ok: true });
    setActiveClickRunId('run-in-page');

    await expect(realClick(element)).rejects.toThrow('没有返回可信执行结果');
  });

  it('rejects a debugger command that did not deliver a trusted click to the target', async () => {
    const { element } = installVisibleElement();
    vi.mocked(sendMessage).mockResolvedValue({
      ok: true,
      feature: { pointer: { mode: 'trusted', pathPoints: 12, clickObserved: false } },
    });
    setActiveClickRunId('run-missed-target');

    await expect(realClick(element)).rejects.toThrow('鼠标事件未到达目标控件');
  });
});

/**
 * 签到按钮选择的两个真实故障，都来自 1412's API 的 /profile 页。
 *
 * 该页的「每日签到」卡片标题本身是一个可折叠 button，而真正的动作按钮
 * 写的是「立即签到」。两者都含「签到」、都是 4 个字。
 */
describe('realClick 视口外目标的处理', () => {
  /*
   * 场景：签到按钮在页面下方，`scrollIntoView` 之后**仍然**落在视口之外
   * （页面已到底、或元素被固定在不可滚的容器里）。
   *
   * 现在的实现把坐标夹进视口：`Math.min(window.innerHeight - 1, rect.top + h/2)`。
   * 于是真实指针点到了视口边缘的**另一个元素**，而扩展以为点成功了 ——
   * 用户看到的是「签到被点了、但什么都没发生」，这是最难查的一类假成功。
   * 正确行为是明确拒绝点击并说清原因。
   */
  it('目标滚进视口后仍不可达时拒绝点击，而不是把坐标夹到视口边缘', async () => {
    // 元素始终在视口下方（top=900，视口高 600）——scrollIntoView 也没能把它带进来
    const { element } = installVisibleElement([
      { left: 10, top: 900, width: 100, height: 40 },
    ]);
    vi.mocked(sendMessage).mockResolvedValue({
      ok: true,
      feature: { pointer: { mode: 'trusted', pathPoints: 12, clickObserved: true } },
    });
    setActiveClickRunId('run-out-of-view');

    await expect(realClick(element)).rejects.toThrow(/视口|可见/);
    // 关键：绝不能把一个「夹到边缘」的坐标当成用户点击发出去
    expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'TRUSTED_POINTER_CLICK',
    }));
  });
});

describe('queryFirst 的 text= 选择', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  /** 造一个够用的假元素：queryFirst 只用到 innerText / 可见性 / 属性 */
  function fakeEl(
    text: string,
    attrs: Record<string, string> = {},
    children: unknown[] = [],
  ): HTMLElement {
    return {
      innerText: text,
      getAttribute: (name: string) => attrs[name] ?? null,
      hasAttribute: (name: string) => name in attrs,
      querySelector: () => children[0] ?? null,
      getBoundingClientRect: () => ({ width: 120, height: 36 }) as DOMRect,
    } as unknown as HTMLElement;
  }

  /** 按文档顺序返回候选，模拟 querySelectorAll */
  function stubDom(
    elements: HTMLElement[],
    cssMatches: Record<string, HTMLElement | null> = {},
  ) {
    vi.stubGlobal('document', {
      // 带选择器时要模拟 CSS 查询：只回传该选择器命中的元素。
      // 旧桩无条件返回全部候选，于是 `text=…, .css` 这类回退链里
      // CSS 分支永远拿不到元素，和真实浏览器的行为不一致。
      querySelectorAll: (selector?: string) => {
        if (!selector) return elements;
        const hit = cssMatches[selector];
        return hit ? [hit] : elements;
      },
      querySelector: (selector: string) => cssMatches[selector] ?? null,
    });
    vi.stubGlobal('window', { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) });
  }

  it('折叠卡片标题排在动作按钮之后，即使文字一样长、还排在前面', () => {
    // 关键回归：标题「每日签到」在 DOM 里排在「立即签到」前面，长度相同。
    // 旧实现只按长度排序 → 打平 → 取文档顺序第一个 → 点到折叠开关，
    // 卡片收起来了但没签到，最后报「点击签到后未检测到明确结果」。
    const header = fakeEl('每日签到', { 'aria-expanded': 'true' });
    const action = fakeEl('立即签到');
    stubDom([header, action]);

    expect(queryFirst('button >> text=签到')).toBe(action);
  });

  it('Radix 那套 data-state 折叠控件同样排到后面', () => {
    const header = fakeEl('每日签到', { 'data-state': 'open' });
    const action = fakeEl('立即签到');
    stubDom([header, action]);

    expect(queryFirst('button >> text=签到')).toBe(action);
  });

  it('内部嵌着别的按钮的容器不会被当成动作按钮', () => {
    const container = fakeEl('每日签到', {}, [{}]);
    const action = fakeEl('立即签到');
    stubDom([container, action]);

    expect(queryFirst('button >> text=签到')).toBe(action);
  });

  it('带 text= 的回退列表按顺序逐个尝试', () => {
    // 关键回归：以前首个 text= 之后的一切都被当成文字，于是整串被当成
    // 一个选择器去找「立即签到, button >> text=签到」这段文字，必然扑空 ——
    // 所有带 text= 的回退写法整个失效，而配置看着完全合理。
    const only = fakeEl('签到');
    stubDom([only]);

    expect(queryFirst('button >> text=立即签到, button >> text=签到')).toBe(only);
  });

  it('优先命中回退列表里的第一条', () => {
    const action = fakeEl('立即签到');
    stubDom([action]);

    expect(queryFirst('button >> text=立即签到, button >> text=签到')).toBe(action);
  });

  it('文字未命中时继续尝试 class CSS 回退', () => {
    const oauthButton = fakeEl('使用 GitHub 继续');
    stubDom([], { '.oauth-github': oauthButton });

    expect(queryFirst('text=不存在, .oauth-github')).toBe(oauthButton);
  });

  it('文字未命中时继续尝试带属性的标签 CSS 回退', () => {
    const tokenLink = fakeEl('账户数据');
    stubDom([], { 'a[href="/console/token"]': tokenLink });

    expect(queryFirst('div >> text=Account Data, a[href="/console/token"]')).toBe(tokenLink);
  });

  it('text= 内部的逗号仍然是文字，不当分隔符', () => {
    // 「使用 GitHub 继续, 稍后」这类文案里的逗号不能切
    const btn = fakeEl('使用 GitHub 继续, 稍后');
    stubDom([btn]);

    expect(queryFirst('text=使用 GitHub 继续, 稍后')).toBe(btn);
  });

  it('图案按钮（无可见文字、名称只在 aria-label 上）也能被 text= 命中', () => {
    // orevx.ai 实测：登录入口是「Sign in with Google」图案按钮，可见区域只有图标，
    // 名称只存在于 aria-label。学习侧正是从 aria-label 生成 `text=` 选择器
    // （learningSelector 的 aria-label 档），回放侧却只读 innerText ——
    // 学到的选择器永远解析不到，报「找不到 OAuth 按钮: text=Sign in with Google」。
    const icon = fakeEl('', { 'aria-label': 'Sign in with Google' });
    stubDom([icon]);

    expect(queryFirst('text=Sign in with Google')).toBe(icon);
  });

  it('title 属性同样是可匹配的无障碍名称', () => {
    const icon = fakeEl('', { title: 'Continue with GitHub' });
    stubDom([icon]);

    expect(queryFirst('text=continue with github')).toBe(icon);
  });

  it('role="menuitem" 的菜单项也属于 text= 的回放候选范围', () => {
    document.body.innerHTML = '<div role="menuitem">个人资料</div>';
    const menuItem = document.querySelector<HTMLElement>('[role="menuitem"]')!;
    vi.spyOn(menuItem, 'getBoundingClientRect').mockReturnValue({
      width: 120,
      height: 36,
    } as DOMRect);

    expect(queryFirst('text=个人资料')).toBe(menuItem);
  });

  it('零宽字符与 emoji 变体选择符不参与文字匹配（看着一样就必须能命中）', () => {
    // 学习时用户看到的按钮文案是「签到 ✅」，录成 text=签到 ✅；页面实际渲染的
    // DOM 里 emoji 带了变体选择符 U+FE0F、文字中间夹了零宽连接符 U+200D。
    // 旧实现只把 \s 归一成空格，这些码位原样参与 includes —— 两个肉眼一模一样的
    // 字符串匹配不上，回放报「找不到可点击元素」。
    document.body.innerHTML = '<button>签\u200D到 \u2705\uFE0F</button>';
    const button = document.querySelector<HTMLElement>('button')!;
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
      width: 120,
      height: 36,
    } as DOMRect);

    expect(queryFirst('text=签到 ✅')).toBe(button);
    expect(queryFirst('text=签\u200D到 ✅\uFE0F')).toBe(button);
  });

  it('归一化不抹掉语义差异：全角括号与半角括号仍是两个不同的控件', () => {
    // 反向红线：归一化只删不可见字符、不折叠全半角。页面同时存在「签到(1)」与
    // 「签到（1）」时，各自的 text= 必须各自命中，不能被判成同一个控件。
    document.body.innerHTML = '<button>签到(1)</button><button>签到（1）</button>';
    const [half, full] = [...document.querySelectorAll<HTMLElement>('button')];
    for (const element of [half!, full!]) {
      vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
        width: 120,
        height: 36,
      } as DOMRect);
    }

    expect(queryFirst('text=签到(1)')).toBe(half);
    expect(queryFirst('text=签到（1）')).toBe(full);
  });
});
