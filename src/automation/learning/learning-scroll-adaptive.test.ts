/**
 * 「先滑动页面再点击签到」的**自适应**回归（学习 → 编译 → 回放 全链路）。
 *
 * 用户原话：「滑动不是死板的 X，也要判断滑动有没有到能够点击签到的地方，
 * 因为有的滑动的初始位置不对，你滑动的距离就不一样」。
 *
 * 本文件锁定四件事：
 * 1. 回放不依赖学习时的绝对像素：滚动定位只用相对量（每次约 0.9 屏），
 *    学习停在 Y=800 这个事实只编译成 `scrollIntoView` 开关，从不回放像素；
 * 2. 学习停在中间位置、回放从 Y=0 / Y=500 / 接近底部开始，**均能定位并点到**
 *    签到控件 —— 滚动次数随起点自适应（4 次 / 3 次 / 0 次），且到得了才停；
 * 3. 找不到目标时明确失败（「工作流找不到可点击元素」）、有界收尾、绝不点到
 *    其它元素 —— 这一条用**真实 realClick** 验证：视口外目标的拒绝会如实
 *    传导成失败，而不是「点了但没生效」的假成功；
 * 4. 滚动容器场景（页面没动、内层容器滚了）：录制只标记「滚过」、不记像素，
 *    回放走元素级 `scrollIntoView`，由浏览器负责滚可滚动祖先，不做页面级滚动。
 *
 * 备注：回放起点在页面下半部、目标懒渲染在当前位置**上方**的场景，曾按「已知缺陷」
 * 钉成失败规范（当时实现只向下滚、够不着）。现由 `workflow.ts` 的**有界向上扫掠**
 * 修复：向下扫掠失败后在剩余预算内向上扫掠，把控件找回 —— 该用例已转绿。
 *
 * mock 口径与 workflow-scroll.test.ts 一致（window.scrollBy/scrollY 桩 +
 * scrollIntoView stub）。唯一增强：`realClick` 保留**真实实现**（`vi.fn` 包装
 * 仅为记录调用），否则「不点错」只是 mock 的自说自话。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/automation/shared/dom-utils', async () => {
  const actual = await vi.importActual<typeof import('@/automation/shared/dom-utils')>('@/automation/shared/dom-utils');
  return {
    ...actual,
    realClick: vi.fn(actual.realClick),
    // 回放的等待全部瞬时化：本文件只关心「滚了几次、滚到哪、点没点」。
    sleep: vi.fn().mockResolvedValue(undefined),
    waitFor: vi.fn(),
  };
});

vi.mock('@/automation/shared/click-safety', () => ({
  clearClickBlocker: vi.fn().mockResolvedValue(null),
}));

import { buildLearnedWorkflow } from '@/automation/learning/learning';
import { runCheckinWorkflow } from '@/automation/learning/workflow';
import { realClick, waitFor } from '@/automation/shared/dom-utils';
import { clearClickBlocker } from '@/automation/shared/click-safety';
import { validateCheckinWorkflow } from '@/lib/workflow/workflow-validation';
import type { CheckinWorkflowStep, SiteConfig, WorkflowLearningEvent } from '@/types';

const site: SiteConfig = {
  id: 'site-adaptive',
  name: '自适应站',
  loginUrl: `${window.location.origin}/login`,
  selectors: { username: '#user', password: '#pass', submit: '#submit' },
  closeModalSelectors: [],
  checkin: { method: 'workflow', claimText: '每日签到' },
};

const log = { push: vi.fn() };

/** workflow 每次下滚的相对量：约 0.9 屏（与 workflow.ts 的 scrollPageDown 同口径）。 */
function scrollStepPx(): number {
  return Math.max(1, Math.round((window.innerHeight || 800) * 0.9));
}

/**
 * 页面滚动模型：`window.scrollBy` 推进模型位置（夹在 [0, maxY]），`window.scrollY`
 * 读模型位置。jsdom 没有布局引擎，没有这层桩页面位置恒为 0，会被当成「已到底」。
 */
function installScrollModel(startY: number, maxY: number) {
  let y = startY;
  const scrollBy = vi.fn((_dx: number, dy: number) => {
    y = Math.min(maxY, Math.max(0, y + dy));
  });
  Object.defineProperty(window, 'scrollBy', { configurable: true, value: scrollBy });
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => y });
  return { scrollBy, getY: () => y };
}

/**
 * 造一个「真实可点」的签到按钮：几何在视口内（top < innerHeight）、
 * `elementFromPoint` 命中它 —— 这样真实 realClick 会在它身上真的派发点击事件。
 */
function makeClaimButton(top: number) {
  const button = document.createElement('button');
  button.id = 'claim';
  button.textContent = '立即签到';
  document.body.appendChild(button);
  const clickSpy = vi.fn();
  button.addEventListener('click', clickSpy);
  const scrollIntoView = vi.fn();
  Object.defineProperty(button, 'scrollIntoView', { configurable: true, value: scrollIntoView });
  vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
    x: 10, y: top, top, left: 10, right: 110, bottom: top + 40, width: 100, height: 40,
    toJSON: () => ({}),
  } as DOMRect);
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => button });
  return { button, clickSpy, scrollIntoView };
}

/**
 * 编译产物尾部带成功词断言（learning.ts 生成）。页面先放好成功词，让断言在
 * 第一个采样点立即命中 —— 否则（sleep 已瞬时化）断言会空转满 5 秒超时。
 */
function appendSuccessEvidence(): void {
  const div = document.createElement('div');
  div.textContent = '签到成功';
  document.body.appendChild(div);
}

/** 把「页面守卫」拆开，只为按真实顺序断言动作本身（与 learning.test.ts 同款）。 */
function flattenSteps(steps: CheckinWorkflowStep[]): CheckinWorkflowStep[] {
  return steps.flatMap((step) => (
    step.type === 'if' && step.condition.type === 'path' ? flattenSteps(step.then) : [step]
  ));
}

/** 断言 scrollIntoView 只用相对定位语义：block/inline 居中，且没有任何像素字段。 */
function expectNoPixelIntoView(siv: ReturnType<typeof vi.fn>): void {
  expect(siv).toHaveBeenCalled();
  for (const [arg] of siv.mock.calls) {
    expect(arg).toEqual({ block: 'center', inline: 'center' });
  }
}

/** 文档级点击计数：证明「一个都没点」（含误点其它元素）。 */
let docClickCount = 0;
function onDocumentClick(): void {
  docClickCount += 1;
}

beforeEach(() => {
  vi.mocked(clearClickBlocker).mockResolvedValue(null);
  window.history.replaceState({}, '', '/check-in');
  document.body.innerHTML = '';
  docClickCount = 0;
  document.addEventListener('click', onDocumentClick, true);
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
  // jsdom 不实现 scrollIntoView（真实浏览器 HTMLElement 上恒有）；补一个 no-op。
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  // jsdom 未实现 innerText；补成 textContent 的别名，让「页面文字证据」按真实逻辑走。
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true,
    get(this: HTMLElement) { return this.textContent ?? ''; },
  });
});

afterEach(() => {
  document.removeEventListener('click', onDocumentClick, true);
  vi.clearAllMocks();
  document.body.innerHTML = '';
  window.history.replaceState({}, '', '/login');
  delete (window as unknown as Record<string, unknown>).scrollY;
  delete (window as unknown as Record<string, unknown>).scrollBy;
  Reflect.deleteProperty(document, 'elementFromPoint');
});

/**
 * 学习时用户滚到页面中间（Y=800）才够得着签到控件。编译侧只允许留下
 * `scrollIntoView: true` 这一个开关 —— 800 这个像素是那一刻页面高度的产物，
 * 回放时页面高度、初始位置都可能不同，绝不能照抄。
 */
const MID_PAGE_LEARNING_EVENTS: WorkflowLearningEvent[] = [
  { type: 'click', selector: '#claim', label: '立即签到', path: '/check-in', scrollBeforeY: 800, at: 1 },
];

async function replayClaimFrom(startY: number, appearAtY: number, maxY: number) {
  const { button, clickSpy, scrollIntoView } = makeClaimButton(100);
  appendSuccessEvidence();
  const model = installScrollModel(startY, maxY);
  // 懒渲染：页面滚到 appearAtY 之后，控件才挂进 DOM。
  vi.mocked(waitFor).mockImplementation(async () => (model.getY() >= appearAtY ? button : null));
  const learned = buildLearnedWorkflow(site, MID_PAGE_LEARNING_EVENTS)!;
  const result = await runCheckinWorkflow(site, learned.workflow, log);
  return { learned, result, button, clickSpy, scrollIntoView, model };
}

describe('学习停在中间位置（Y=800）：回放从不同初始滚动位置都能找到并点到目标', () => {
  it('编译产物只带 scrollIntoView 开关：没有学习时的绝对像素（800 / scrollBeforeY）', () => {
    const learned = buildLearnedWorkflow(site, MID_PAGE_LEARNING_EVENTS)!;

    expect(flattenSteps(learned.workflow.steps).filter((step) => step.type === 'click'))
      .toEqual([{ type: 'click', selector: '#claim', scrollIntoView: true }]);
    const json = JSON.stringify(learned.workflow);
    expect(json).not.toContain('800');
    expect(json).not.toContain('scrollBeforeY');
    // 新字段必须能过保存前校验（否则用户根本存不下学到的流程）
    expect(validateCheckinWorkflow(site, learned.workflow)).toEqual([]);
  });

  it('回放从页面顶部（Y=0）开始：按相对量逐屏下滚，到得了控件才停（4 次 × 0.9 屏）', async () => {
    const step = scrollStepPx();
    const APPEAR_AT = 2_400;
    const r = await replayClaimFrom(0, APPEAR_AT, 3_000);

    // 真的点到了（真实 realClick 在按钮上派发了点击事件），而不是「以为点了」
    expect(r.clickSpy).toHaveBeenCalledTimes(1);
    expect(r.result.status).toBe('success');
    // 每一次滚动都是相对量（0, ≈0.9 屏）：学习时的 800 从不出现，也没有别的绝对像素
    expect(r.model.scrollBy).toHaveBeenCalledTimes(Math.ceil(APPEAR_AT / step));
    expect(r.model.scrollBy.mock.calls.every(([x, dy]) => x === 0 && dy === step)).toBe(true);
    // 「判断有没有到能够点击的地方」：滚过渲染阈值就命中停手，不多滚
    expect(r.model.getY()).toBeGreaterThanOrEqual(APPEAR_AT);
    // 元素级 scrollIntoView 同样只带相对定位语义，不带像素
    expectNoPixelIntoView(r.scrollIntoView);
  });

  it('回放从 Y=500 开始：所需滚动次数随起点变化（3 次），依旧定位并点到', async () => {
    const step = scrollStepPx();
    const APPEAR_AT = 2_400;
    const r = await replayClaimFrom(500, APPEAR_AT, 3_000);

    expect(r.clickSpy).toHaveBeenCalledTimes(1);
    expect(r.result.status).toBe('success');
    expect(r.model.scrollBy).toHaveBeenCalledTimes(Math.max(0, Math.ceil((APPEAR_AT - 500) / step)));
    expect(r.model.scrollBy.mock.calls.every(([x, dy]) => x === 0 && dy === step)).toBe(true);
    expectNoPixelIntoView(r.scrollIntoView);
  });

  it('回放从接近底部（Y=2900）开始：控件已在渲染区，直接点到、不多滚一像素', async () => {
    const r = await replayClaimFrom(2_900, 2_400, 3_000);

    expect(r.clickSpy).toHaveBeenCalledTimes(1);
    expect(r.result.status).toBe('success');
    // 起点不同 → 根本不需要滚动：这正说明回放是「按当前位置判断够没够到」，不是死板地滚 X 下
    expect(r.model.scrollBy).not.toHaveBeenCalled();
    expect(r.model.getY()).toBe(2_900);
    expectNoPixelIntoView(r.scrollIntoView);
  });
});

/**
 * 「只向下滚」的边界：目标在当前位置**上方**且是懒渲染。
 *
 * 非懒渲染的目标不在此列（见下方对照组）：初始探到就直接 scrollIntoView 居中，
 * 浏览器会向上滚。修复前的缺陷只在「目标不在 DOM + 在上方」这个组合上成立。
 */
describe('回放起点在页面下半部、目标懒渲染在当前位置上方：向下扫掠失败后由有界向上扫掠找回', () => {
  /*
   * 用户原话：「有的滑动的初始位置不对，你滑动的距离就不一样」。
   *
   * 场景：回放打开页面时浏览器把滚动位置恢复到页面下半部（≈3 屏），签到控件在
   * 页面上方且是懒渲染（视口离得远就不在 DOM，虚拟列表）。初始短探落空后，只能
   * 靠滚动把它带进 DOM。修复前 scrollToLocate **只向下滚**：越滚越远，目标永远
   * 不渲染，最终有界收尾、安全失败 —— 不误点，但「够得着的控件」被漏掉。
   *
   * 修复后：向下扫掠落空（本场景里页面很快滚到底、目标仍未出现）后进入**有界向上
   * 扫掠**（相对量、与向下段共享同一尝试预算、滚不动即停），把上方懒渲染的控件
   * 找回来再点。本用例按修复后行为断言（此前按缺陷钉成失败规范，故意跑红）。
   */
  it('应能找到并点到上方的签到控件（向下扫掠失败 → 有界向上扫掠命中）', async () => {
    const step = scrollStepPx();
    const RENDER_TOP = step;   // 视口进入顶部一屏内，控件才挂进 DOM（懒渲染）
    const startY = step * 3;   // 回放起点：页面下半部（浏览器恢复的滚动位置）
    const { button, clickSpy } = makeClaimButton(100);
    appendSuccessEvidence();
    const model = installScrollModel(startY, step * 8);
    vi.mocked(waitFor).mockImplementation(async () => (model.getY() <= RENDER_TOP ? button : null));

    const learned = buildLearnedWorkflow(site, [
      { type: 'click', selector: '#claim', label: '立即签到', path: '/check-in', scrollBeforeY: 1_800, at: 1 },
    ])!;
    const result = await runCheckinWorkflow(site, learned.workflow, log);

    // 期望：向上扫掠回渲染区后定位并点到（完整走通到 success）。修复前这里收到
    // 的是安全但够不着的失败收尾 { status: 'failed', message: '工作流找不到可点击元素: #claim' }。
    expect(result).toEqual({ status: 'success', message: expect.stringContaining('成功') });
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('对照组（非懒渲染、同样在上方）：初始探到即点，方向本身不是问题', async () => {
    const { button, clickSpy, scrollIntoView } = makeClaimButton(100);
    appendSuccessEvidence();
    const model = installScrollModel(scrollStepPx() * 3, scrollStepPx() * 8);
    vi.mocked(waitFor).mockImplementation(async () => button);

    const result = await runCheckinWorkflow(site, {
      steps: [{ type: 'click', selector: '#claim', scrollIntoView: true }],
    }, log);

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('success');
    // 控件在 DOM 就直接命中：页面级滚动一次都没发生，方向交给 scrollIntoView 居中
    expect(model.scrollBy).not.toHaveBeenCalled();
    expectNoPixelIntoView(scrollIntoView);
  });
});

describe('滚动容器场景：页面没动、内层容器滚过（scrollPageTop）', () => {
  const CONTAINER_EVENTS: WorkflowLearningEvent[] = [
    { type: 'click', selector: '#claim', label: '立即签到', path: '/check-in', scrollPageTop: true, at: 1 },
  ];

  it('只标记「滚过」的录制：编译成 scrollIntoView 开关，两种滚动字段都不落进步骤', () => {
    const learned = buildLearnedWorkflow(site, CONTAINER_EVENTS)!;

    expect(flattenSteps(learned.workflow.steps).filter((step) => step.type === 'click'))
      .toEqual([{ type: 'click', selector: '#claim', scrollIntoView: true }]);
    const json = JSON.stringify(learned.workflow);
    expect(json).not.toContain('scrollBeforeY');
    expect(json).not.toContain('scrollPageTop');
    expect(validateCheckinWorkflow(site, learned.workflow)).toEqual([]);
  });

  it('回放靠元素级 scrollIntoView（浏览器滚可滚动祖先），不做页面级滚动、不带像素', async () => {
    const container = document.createElement('div');
    container.style.overflow = 'auto';
    document.body.appendChild(container);
    const { button, clickSpy, scrollIntoView } = makeClaimButton(100);
    container.appendChild(button);   // 控件在滚动容器里：页面本身不需要动
    appendSuccessEvidence();
    const model = installScrollModel(0, 1_500);
    vi.mocked(waitFor).mockImplementation(async () => button);

    const learned = buildLearnedWorkflow(site, CONTAINER_EVENTS)!;
    const result = await runCheckinWorkflow(site, learned.workflow, log);

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('success');
    // scrollIntoView 的语义就是「把元素滚进视口，途经的所有可滚动祖先都会被滚」：
    // 只给定位语义（居中），不给任何像素 —— 容器坐标与页面坐标不是同一把尺子。
    expectNoPixelIntoView(scrollIntoView);
    // 页面本身没动过：容器滚动不靠页面级 scrollBy（学习没记页面像素，回放也不该造）
    expect(model.scrollBy).not.toHaveBeenCalled();
  });
});

describe('找不到目标：明确失败，绝不点到其它元素', () => {
  it('页面可滚但目标始终不出现：有界收尾报「找不到」，全程零点击', async () => {
    appendSuccessEvidence();   // 页面上有其它内容，有没有误点一目了然
    const decoy = document.createElement('button');
    decoy.id = 'other-claim';
    decoy.textContent = '立即签到（诱饵）';
    document.body.appendChild(decoy);
    const step = scrollStepPx();
    const model = installScrollModel(0, step * 40);   // 页面很长，永远滚不到底
    vi.mocked(waitFor).mockResolvedValue(null);       // 目标永远不出现

    const result = await runCheckinWorkflow(site, {
      steps: [{ type: 'click', selector: '#missing', scrollIntoView: true, timeoutMs: 10_000 }],
    }, log);

    expect(result).toEqual({ status: 'failed', message: '工作流找不到可点击元素: #missing' });
    expect(realClick).not.toHaveBeenCalled();
    expect(docClickCount).toBe(0);              // 诱饵没有被点，其它任何元素也没有
    // 有界：滚动次数被硬顶（MAX_SCROLL_ATTEMPTS=24）兜住，绝不无限下滚
    expect(model.scrollBy.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(model.scrollBy.mock.calls.length).toBeLessThanOrEqual(24);
    expect(vi.mocked(waitFor).mock.calls.length).toBeLessThanOrEqual(25);   // 首探 + 每滚一次一探
    expect(model.scrollBy.mock.calls.every(([x, dy]) => x === 0 && dy === step)).toBe(true);
  });

  it('目标在视口外且滚不进视口：真实 realClick 明确拒绝，工作流如实失败且不继续后续点击', async () => {
    const { clickSpy: claimClick } = makeClaimButton(900);   // top=900 > 视口高 768：滚不进来
    const next = document.createElement('button');
    next.id = 'next';
    document.body.appendChild(next);
    const nextClick = vi.fn();
    next.addEventListener('click', nextClick);
    vi.mocked(waitFor).mockResolvedValue(document.getElementById('claim'));   // 元素找得到

    const result = await runCheckinWorkflow(site, {
      steps: [
        { type: 'click', selector: '#claim', scrollIntoView: true },
        { type: 'click', selector: '#next', scrollIntoView: true },
      ],
    }, log);

    // 真实 realClick 的视口外拒绝被如实上抛为失败 —— 不是「点了但没生效」的假成功
    expect(realClick).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'failed', message: expect.stringContaining('视口之外') });
    expect(result).toMatchObject({ message: expect.stringContaining('已取消点击以免点到其它元素') });
    // 安全底线：拒绝就是拒绝 —— 没有派发任何点击，也没有继续执行第二步
    expect(claimClick).not.toHaveBeenCalled();
    expect(nextClick).not.toHaveBeenCalled();
    expect(docClickCount).toBe(0);
    expect(log.push).not.toHaveBeenCalledWith(expect.stringContaining('工作流已点击'));
  });
});
