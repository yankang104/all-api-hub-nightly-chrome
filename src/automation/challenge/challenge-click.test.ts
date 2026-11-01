/**
 * 验证码控件的**视口判定**与「先滚再判」测试。
 *
 * 用户报告的原话：「这个不应该滑动页面再快照吗？」
 *
 * 根因：`isChallengeElementVisible` 只判 display / visibility / 尺寸，**完全不看
 * 元素是否在当前视口内**。两个方向都会出错：
 *   1) 控件挂在视口下方但宽高 > 0 → 被判成「可见」直接进入处理流程，而真实指针点击
 *      （chrome.debugger 的 `Input.dispatchMouseEvent`）用的是视口坐标，落在视口外
 *      的坐标会点到别的元素、点击无效；
 *   2) 懒渲染的控件（`content-visibility: auto`、IntersectionObserver 挂载）在滚到
 *      之前根本没有布局盒，任何基于尺寸的判据都会如实报「看不见」→ **真实存在的**
 *      验证码被漏判成「本次点击没有触发验证」，任务带着未完成的验证继续往下跑。
 *
 * 所以正确行为是「滚一下、重新采样矩形、再看一次」，而不是把「视口外」直接当成
 * 「不可见」。断言必须客观：滚了几次、滚的是谁、耗掉多少时间、最终判成有没有验证。
 *
 * jsdom 没有布局引擎（`getBoundingClientRect` 恒为 0、`scrollIntoView` 未实现、
 * 视口固定 1024×768），所以这里按仓库既有做法给原型补非零矩形、给元素装可变的
 * 矩形与滚动桩 —— 不把可见性整个 mock 掉，要测的正是这套判定本身。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChallengeResolution } from '@/automation/challenge/challenge';

const mockedClick = vi.hoisted(() => ({ realClick: vi.fn() }));

vi.mock('@/automation/shared/dom-utils', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/automation/shared/dom-utils')>(),
  realClick: mockedClick.realClick,
}));

import {
  executeChallengeInteraction,
  findChallengeRevealCandidates,
  isChallengeElementInViewport,
  revealOffscreenChallengeCandidates,
  type ChallengeInteractionContext,
  type ClickChallengeDefinition,
} from '@/automation/challenge/challenge-click';
import { waitForCheckinChallenge } from '@/automation/challenge/checkin-challenge';
import { setActiveClickRunId } from '@/automation/shared/dom-utils';

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 视口内：中心 (291, 232.5)，jsdom 视口 1024×768。 */
const IN_VIEWPORT: Box = { left: 100, top: 200, width: 382, height: 65 };
/** 视口下方：中心 y = 932.5，远超视口高度 768。 */
const BELOW_FOLD: Box = { left: 100, top: 900, width: 382, height: 65 };

const SNAPSHOT_WINDOW_MS = 2_500;
const LONG_TIMEOUT_MS = 5 * 60_000;

const scrollCalls: { target: Element; options: unknown }[] = [];

function toRect(box: Box): DOMRect {
  return {
    x: box.left,
    y: box.top,
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
    right: box.left + box.width,
    bottom: box.top + box.height,
    toJSON: () => ({}),
  } as DOMRect;
}

/**
 * 给元素装上**可变**几何：`geometry()` 返回 null 表示这个元素当前没有布局盒
 * （懒渲染、尚未挂载），正是「滚动之后才渲染出来」那类控件在 jsdom 里的样子。
 */
function installGeometry(element: Element, geometry: () => Box | null): void {
  Object.defineProperties(element, {
    getBoundingClientRect: {
      configurable: true,
      value: () => toRect(geometry() ?? { left: 0, top: 0, width: 0, height: 0 }),
    },
    getClientRects: {
      configurable: true,
      value: () => {
        const box = geometry();
        return (box ? [toRect(box)] : []) as unknown as DOMRectList;
      },
    },
  });
}

function installScroll(element: Element, handler?: (this: Element) => void): void {
  Object.defineProperty(element, 'scrollIntoView', {
    configurable: true,
    value(this: Element, options?: unknown) {
      scrollCalls.push({ target: this, options });
      handler?.call(this);
    },
  });
}

function track(promise: Promise<ChallengeResolution>): { settled: () => ChallengeResolution | undefined } {
  let resolution: ChallengeResolution | undefined;
  void promise.then((value) => { resolution = value; });
  return { settled: () => resolution };
}

interface ChallengeHooks {
  log: { push: (msg: string) => void };
  onNeedsUser: (message: string) => Promise<void>;
}

function hooks(): ChallengeHooks {
  return { log: { push: vi.fn() }, onNeedsUser: vi.fn(async () => {}) };
}

/** 与签到路径同一形状的最小定义：所有等待窗口压到 0，让断言只反映滚动行为。 */
const DEFINITION: ClickChallengeDefinition = {
  kind: 'Turnstile',
  selectors: '.turnstile-wrapper',
  tokenSelectors: 'input[name="cf-turnstile-response"]',
  strategy: {
    minVisibleMs: 0,
    mountWaitMs: 0,
    layoutWaitMs: 0,
    responseWaitMs: 0,
    maxAttempts: 1,
  },
};

function interactionContext(isComplete: (widget?: Element) => boolean): ChallengeInteractionContext {
  return {
    log: { push: vi.fn() },
    detectedAt: Date.now(),
    deadline: Date.now() + 60_000,
    isComplete,
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.title = '';
  scrollCalls.length = 0;
  setActiveClickRunId(null);
  mockedClick.realClick.mockReset();
  mockedClick.realClick.mockResolvedValue('trusted');

  // jsdom 的元素默认矩形恒为 0，连 body/html 都没有布局盒 —— 不补一个「页面上的
  // 普通元素有尺寸且就在视口里」的默认值，就无法区分「懒渲染的控件」与
  // 「页面上根本没有这块布局」。需要视口外的元素在用例里单独覆盖。
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    () => toRect({ left: 0, top: 0, width: 1024, height: 300 }),
  );
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(
    () => [toRect({ left: 0, top: 0, width: 1024, height: 300 })] as unknown as DOMRectList,
  );
  // jsdom 未实现 scrollIntoView；装一个可观察的桩，让「滚了没有 / 滚了几次」可断言。
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value(this: Element, options?: unknown) {
      scrollCalls.push({ target: this, options });
    },
  });
});

afterEach(() => {
  delete (Element.prototype as Partial<Element>).scrollIntoView;
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = '';
  document.title = '';
});

describe('isChallengeElementInViewport：视口判定不代替可见性判定', () => {
  it('控件在视口下方时判为不在视口内', () => {
    const element = document.createElement('div');
    document.body.append(element);
    installGeometry(element, () => BELOW_FOLD);

    expect(isChallengeElementInViewport(element)).toBe(false);
    // 关键：它仍然是「有布局盒的可见控件」—— 视口外只意味着要滚一下再看，
    // 不能当作不存在，否则真实验证码会被漏掉。
    expect(element.getClientRects().length).toBe(1);
  });

  it('控件在视口内时判为在视口内', () => {
    const element = document.createElement('div');
    document.body.append(element);
    installGeometry(element, () => IN_VIEWPORT);

    expect(isChallengeElementInViewport(element)).toBe(true);
  });

  it('还没有布局盒（懒渲染）的控件判为不在视口内，需要滚动才会渲染', () => {
    const element = document.createElement('div');
    document.body.append(element);
    installGeometry(element, () => null);

    expect(isChallengeElementInViewport(element)).toBe(false);
  });

  it('已从文档移除的控件判为不在视口内', () => {
    const element = document.createElement('div');
    installGeometry(element, () => IN_VIEWPORT);

    expect(isChallengeElementInViewport(element)).toBe(false);
  });
});

describe('「先滚再判」：滚动有界、可回退', () => {
  it('候选都在视口内时一次都不滚（零开销）', async () => {
    const element = document.createElement('div');
    element.className = 'turnstile-wrapper';
    document.body.append(element);
    installGeometry(element, () => IN_VIEWPORT);

    const result = await revealOffscreenChallengeCandidates(findChallengeRevealCandidates());

    expect(result).toEqual({ outcome: 'in-viewport', attempts: 0, offViewport: 0 });
    expect(scrollCalls).toEqual([]);
  });

  it('控件在视口下方且页面可滚 → 用 scrollIntoView({block:"center"}) 带进视口并重新判定', async () => {
    const element = document.createElement('div');
    document.body.append(element);
    let inViewport = false;
    installGeometry(element, () => (inViewport ? IN_VIEWPORT : BELOW_FOLD));
    installScroll(element, () => { inViewport = true; });

    const result = await revealOffscreenChallengeCandidates([element]);

    expect(result).toEqual({ outcome: 'revealed', attempts: 1, offViewport: 1 });
    expect(scrollCalls).toEqual([{ target: element, options: { block: 'center' } }]);
    // 重新采样之后它真的进了视口 —— 这就是「先滚再判」相对「只看视口」的差别。
    expect(isChallengeElementInViewport(element)).toBe(true);
  });

  it('页面滚不动（几何完全没变）→ 立刻放弃，不反复滚', async () => {
    const element = document.createElement('div');
    document.body.append(element);
    installGeometry(element, () => BELOW_FOLD);
    installScroll(element);

    const result = await revealOffscreenChallengeCandidates([element]);

    expect(result).toEqual({ outcome: 'blocked', attempts: 1, offViewport: 1 });
    expect(scrollCalls).toHaveLength(1);
  });

  it('页面一直在动但控件始终进不了视口 → 用满尝试上限就停，且不超过时间预算', async () => {
    const element = document.createElement('div');
    document.body.append(element);
    // 每次采样位置都变（模拟持续重排/动画），但始终留在视口下方。
    let samples = 0;
    installGeometry(element, () => ({ ...BELOW_FOLD, top: BELOW_FOLD.top - samples++ }));
    installScroll(element);

    const startedAt = Date.now();
    const result = await revealOffscreenChallengeCandidates([element]);
    const elapsed = Date.now() - startedAt;

    // 具名常量：最多 2 次、1 秒量级 —— 绝不允许无限重试。
    expect(result).toEqual({ outcome: 'blocked', attempts: 2, offViewport: 1 });
    expect(scrollCalls).toHaveLength(2);
    expect(elapsed).toBeLessThanOrEqual(1_000);
  });

  it('环境没有实现 scrollIntoView（无布局引擎）→ 直接放弃，不死循环', async () => {
    const element = document.createElement('div');
    document.body.append(element);
    installGeometry(element, () => BELOW_FOLD);
    delete (Element.prototype as Partial<Element>).scrollIntoView;

    const result = await revealOffscreenChallengeCandidates([element]);

    expect(result).toEqual({ outcome: 'blocked', attempts: 0, offViewport: 1 });
  });

  it('控件自己没有布局盒时，滚动它最近的**有尺寸祖先**把它带进视口', async () => {
    const area = document.createElement('div');
    area.id = 'challenge-area';
    const widget = document.createElement('div');
    widget.className = 'turnstile-wrapper';
    area.append(widget);
    document.body.append(area);

    let rendered = false;
    let areaTop = 1_200;
    installGeometry(area, () => ({ left: 0, top: areaTop, width: 1024, height: 400 }));
    installGeometry(widget, () => (rendered ? IN_VIEWPORT : null));
    installScroll(area, () => {
      // 把容器滚进视口后，懒渲染的控件才会真正拿到布局盒。
      areaTop = 200;
      rendered = true;
    });

    const result = await revealOffscreenChallengeCandidates([widget]);

    expect(result).toEqual({ outcome: 'revealed', attempts: 1, offViewport: 1 });
    expect(scrollCalls).toEqual([{ target: area, options: { block: 'center' } }]);
    expect(isChallengeElementInViewport(widget)).toBe(true);
  });
});

describe('统一验证码点击流程：进入点击前先滚再判', () => {
  it('控件在视口下方 → 滚动一次、把控件带进视口后继续处理', async () => {
    const widget = document.createElement('div');
    widget.className = 'turnstile-wrapper';
    document.body.append(widget);
    let inViewport = false;
    let completed = false;
    installGeometry(widget, () => (inViewport ? IN_VIEWPORT : BELOW_FOLD));
    installScroll(widget, () => { inViewport = true; completed = true; });

    const context = interactionContext(() => completed);
    const result = await executeChallengeInteraction(DEFINITION, context);

    expect(result).toBe(true);
    expect(scrollCalls).toEqual([{ target: widget, options: { block: 'center' } }]);
    expect(context.log.push).toHaveBeenCalledWith(
      'Turnstile控件原本位于视口外，已滚动页面将其带入视口后重新判定',
    );
  });

  it('控件本来就在视口内 → 一次都不滚（零开销）', async () => {
    const widget = document.createElement('div');
    widget.className = 'turnstile-wrapper';
    document.body.append(widget);
    installGeometry(widget, () => IN_VIEWPORT);

    const result = await executeChallengeInteraction(DEFINITION, interactionContext(() => false));

    expect(scrollCalls).toEqual([]);
    // 无法自动完成的控件仍然如实返回未解决，绝不静默放行。
    expect(result).toBe(false);
  });

  it('控件在视口下方且滚不动 → 不放行：仍按「需要人工介入」收尾，滚动次数有界', async () => {
    const widget = document.createElement('div');
    widget.className = 'turnstile-wrapper';
    document.body.append(widget);
    installGeometry(widget, () => BELOW_FOLD);
    installScroll(widget);

    const context = interactionContext(() => false);
    const result = await executeChallengeInteraction(DEFINITION, context);

    expect(result).toBe(false);
    expect(scrollCalls.length).toBeLessThanOrEqual(2);
    expect(context.log.push).toHaveBeenCalledWith(
      expect.stringContaining('所有候选控件均未能自动完成验证，需要人工介入'),
    );
  });
});

describe('签到快照：先滚再判，不放行真实存在的验证', () => {
  it('验证码懒渲染在视口下方 → 快照先滚动再重新判定，判为有验证', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <main><p>签到成功，本次获得 10 次调用额度</p></main>
      <div id="challenge-area"><div class="turnstile-wrapper"></div></div>
    `;
    const area = document.querySelector<HTMLElement>('#challenge-area')!;
    const widget = document.querySelector<HTMLElement>('.turnstile-wrapper')!;

    // 滚动前：验证控件在视口下方，而且因为懒渲染根本没有布局盒 —— 任何基于尺寸的
    // 可见性判据都会报「看不见」，这正是「真验证码被漏判」的样子。
    let rendered = false;
    installGeometry(area, () => ({ left: 0, top: rendered ? 200 : 1_200, width: 1024, height: 400 }));
    installGeometry(widget, () => (rendered ? { left: 100, top: 250, width: 382, height: 65 } : null));
    installScroll(area, () => { rendered = true; });

    const { log, onNeedsUser } = hooks();
    const challenge = track(waitForCheckinChallenge(log, onNeedsUser, LONG_TIMEOUT_MS, SNAPSHOT_WINDOW_MS));
    await vi.advanceTimersByTimeAsync(SNAPSHOT_WINDOW_MS);
    await vi.advanceTimersByTimeAsync(0);

    // 先把承载验证码的容器滚进视口，才谈得上「有没有验证」。
    expect(scrollCalls.map((call) => call.target)).toEqual([area]);
    expect(log.push).toHaveBeenCalledWith('签到点击后检测到安全验证，开始等待本次签到触发的安全验证');
    // 快照判为有验证 → 进入长流程，绝不放行。
    expect(challenge.settled()).toBeUndefined();
    expect(log.push).not.toHaveBeenCalledWith('签到点击后未发现安全验证证据，继续核对本次签到结果');
  });

  it('页面上没有视口外的验证候选时，快照仍然在窗口内放行且一次都不滚', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <main>
        <p>签到成功</p>
        <div class="captcha-note-panel">本站说明：遇到人机校验时请手动完成。</div>
      </main>
    `;

    const startedAt = Date.now();
    const { log, onNeedsUser } = hooks();
    const challenge = track(waitForCheckinChallenge(log, onNeedsUser, LONG_TIMEOUT_MS, SNAPSHOT_WINDOW_MS));
    await vi.advanceTimersByTimeAsync(SNAPSHOT_WINDOW_MS);
    await vi.advanceTimersByTimeAsync(0);

    expect(challenge.settled()).toEqual({ detected: false, resolved: true });
    // 「没有验证」这条路径上不能多花时间，也不能顺手把页面滚走。
    expect(Date.now() - startedAt).toBeLessThanOrEqual(SNAPSHOT_WINDOW_MS);
    expect(scrollCalls).toEqual([]);
    expect(onNeedsUser).not.toHaveBeenCalled();
  });

  it('结果轮询用的即时快照（无窗口）不滚动、不产生任何等待', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <main><p>今日已签到</p></main>
      <div id="captcha-area"><div class="captcha-note-panel">说明文案</div></div>
    `;
    const area = document.querySelector<HTMLElement>('#captcha-area')!;
    installGeometry(area, () => ({ left: 0, top: 1_200, width: 1024, height: 400 }));
    installScroll(area);

    const { log, onNeedsUser } = hooks();
    await expect(waitForCheckinChallenge(log, onNeedsUser, LONG_TIMEOUT_MS))
      .resolves.toEqual({ detected: false, resolved: true });

    expect(vi.getTimerCount()).toBe(0);
    expect(scrollCalls).toEqual([]);
  });
});
