/**
 * 「学习签到回放自己不点击」的三条可疑路径审计 —— 全部按**通用缺陷类别**组织，不是某站点专用。
 *
 * 现场（通用形态）：站点 UI 库对 `isTrusted=false` 的合成点击不予响应（React / Radix /
 * Base UI 等组件库普遍做法），扩展的受信点击经由 `chrome.debugger` 发送真实指针事件；
 * 重放日志里没有一行「工作流已点击」，用户感知为「他自己也不点击」。
 *
 * 本文件锁定三件事，每件都标注「哪些站点形态会踩到」：
 *
 * 1. 受信点击接线（`dom-utils.ts` realClick + `auto-login.content.ts:72`）：
 *    - 有接线（runId）时走 TRUSTED_POINTER_CLICK（受信通道生效）；
 *    - 任何原因（① 未接线无 runId、② chrome.runtime.id 缺失/扩展上下文失效、
 *      ③ 站点配置 pointerMode='dom'）都会**静默回落** DOM 合成点击；
 *    - `workflow.ts:539` 丢弃 realClick 的返回值，日志无论走哪条路都写「工作流已点击」
 *      —— 对 isTrusted 校验的 UI，「点了没事」被记成「已点击」。
 *    踩到的站点形态：任何使用 isTrusted 校验的组件库站点（第三方 OAuth 图标按钮、
 *    自绘按钮、受控表单），只要该次回放的任何一环使它走了降级路径。
 *
 * 2. 选择器重名（`learning.ts` learningSelector / `dom-utils.ts` queryByText）：
 *    学习端的「唯一性」校验（`learning.ts:1364` ambiguousSelector → queryAll）与回放端
 *    是**同一实现**，但它只验证**学习那一刻的 DOM**。回放 DIFF 时：
 *    - 导航链接「签到」与主区图标按钮（aria-label=签到）同名时，`text=` 按
 *      「折叠等级 → 最短文本 → 文档序」静默改点导航链接 =「点了等于没点」；
 *    - 两处同名图标按钮（页头浮层 + 主区工具栏）同理。
 *    踩到的站点形态：侧栏/顶栏导航里有「签到」入口的站点、浮动组件与主区按钮同名的
 *    站点、按状态渲染出同名元素的站点（懒渲染、折叠侧栏、A-B 渲染都会造成学习/回放
 *    两刻的 DOM 不同）。
 *
 * 3. 无属性/无文字控件的兜底（`learning.ts` structuredPath）：圆形纯图标按钮这类控件在
 *    aria/text 档被拒或为空时落成 `main > div > button` 这类**结构路径**（orevx 实测形状
 *    的真实学习产物：`main > div > button` / `main > div > button > span:nth-of-type(3)`）。
 *    它依赖层级与兄弟顺序：状态替换、重绘增删一层/一个 span 就解析为空（或指错），回放
 *    报「找不到可点击元素」—— 同样表现为日志里没有「工作流已点击」。
 *    踩到的站点形态：按钮无文字、无 testid/id/name、a11y 名只在 aria-label 的图标按钮 UI。
 *
 * 4. 当天已签到再回放（`workflow.ts` click 分支 + 尾部 already 判定）：
 *    - 目标整体消失（换成不可点的「今日已签到」记录视图）→ 定位失败时**不再读整页
 *      文本**：连目标都没有，「附近」无从谈起，如实报「找不到可点击元素」；
 *    - 目标被替换成 disabled 的「已签到」状态控件时，`text=` 子串匹配（「已签到」包含
 *      「签到」）把它当动作目标：受信路径如实报「未到达目标控件」，但控件就在那儿，
 *      它所在卡片里的 already 证据仍被判为 already；降级路径静默空点（disabled 控件
 *      不派发 click）→ 靠尾部判定 already。
 *    关键收紧：click 分支三个失败出口（初次定位失败 / 验证后重定位失败 / 点击异常）
 *    统一走 `settleClickFailure`，already 证据**只从目标控件附近子树**读取
 *    （`form/[role=dialog]/[role=menu]/li/article/section` → `parentElement` → 不判）。
 *    侧栏/页脚等远处的「今日已签到」不再能把点击失败粉饰成成功。
 *    踩到的站点形态：任何「按钮点击后原地换成状态/记录视图」的签到页（本项目的通用
 *    签到形态），回放在完成过一次签到的当日执行时必然进入该状态。
 *
 * mock 口径照抄 workflow-scroll.test.ts：dom-utils 必须覆盖 workflow.ts 引用的全部导出
 * （少一个报 No X export）。这里改用 importActual + 局部覆盖，保留**真实**的选择器解析
 * 与点击语义 —— 本文件要验证的正是「回放时到底解析到谁、点到谁、告诉上层什么」。
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
  };
});

vi.mock('@/automation/shared/click-safety', () => ({
  clearClickBlocker: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/core/messaging', () => ({ sendMessage: vi.fn() }));

import { realClick, queryFirst, setActiveClickRunId } from '@/automation/shared/dom-utils';
import { sendMessage } from '@/lib/core/messaging';
import { runCheckinWorkflow } from '@/automation/learning/workflow';
import { buildLearnedWorkflow, learningSelector } from '@/automation/learning/learning';
import { readWorkflowOutcomeEvidence } from '@/automation/learning/workflow-outcome';
import type { CheckinWorkflowConfig, SiteConfig, WorkflowLearningEvent } from '@/types';

const site = (): SiteConfig => ({
  id: 'site-1',
  name: '测试站',
  loginUrl: `${window.location.origin}/login`,
  selectors: { username: '#user', password: '#pass', submit: '#submit' },
  closeModalSelectors: [],
});

const log = { push: vi.fn() };

/** realClick 的遮挡校验读 elementFromPoint；按用例指定「这一刻坐标上是谁」。 */
let elementFromPointTarget: Element | null = null;

beforeAll(() => {
  // jsdom 没有布局引擎：给所有元素非零矩形，让 isVisible 按真实逻辑判可见。
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    return {
      x: 0, y: 0, width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20,
      toJSON: () => ({}),
    } as DOMRect;
  };
  // jsdom 不实现 innerText（恒为 undefined），而 queryByText 与页面证据读取都读它。
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true,
    get(this: HTMLElement) { return this.textContent ?? ''; },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: () => {},
  });
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: () => elementFromPointTarget,
  });
});

beforeEach(() => {
  window.history.replaceState({}, '', '/check-in');
  document.body.innerHTML = '';
  elementFromPointTarget = null;
});

afterEach(() => {
  setActiveClickRunId(null);
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

/** 记录元素收到的 click 事件真伪（isTrusted：CDP 真实输入为 true，合成事件为 false）。 */
function captureTrust(el: Element): boolean[] {
  const seen: boolean[] = [];
  el.addEventListener('click', (event) => seen.push(event.isTrusted));
  return seen;
}

/** 只记录「有没有 click 到达」。 */
function captureClicks(el: Element): string[] {
  const seen: string[] = [];
  el.addEventListener('click', () => seen.push('click'));
  return seen;
}

/* ------------------------------------------------------------------ *
 * 一、受信点击接线：生效条件 与 三条静默回落路径
 * ------------------------------------------------------------------ */

describe('受信点击接线：有 runId 走 chrome.debugger；任一条件缺失即静默回落 DOM 合成点击', () => {
  it('有接线且扩展上下文可用：回放点击走 TRUSTED_POINTER_CLICK（带 runId），页面收不到合成事件', async () => {
    vi.stubGlobal('chrome', { runtime: { id: 'test-extension' } });
    setActiveClickRunId('run-audit', 'trusted');
    vi.mocked(sendMessage).mockResolvedValue({
      ok: true,
      feature: { pointer: { mode: 'trusted', pathPoints: 3, clickObserved: true } },
    });
    document.body.innerHTML = '<button aria-label="签到"></button>';
    const button = document.querySelector('button')!;
    const seen = captureTrust(button);
    elementFromPointTarget = button;

    const result = await runCheckinWorkflow(
      site(),
      { steps: [{ type: 'click', selector: 'text=签到' }] },
      log,
    );

    // dom-utils.ts:403-410：runId 存在且 chrome.runtime.id 可用 → 走受信通道
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'TRUSTED_POINTER_CLICK',
      runId: 'run-audit',
    }));
    // 走的是 CDP 通道：content script 不向页面派发任何合成点击
    expect(seen).toEqual([]);
    expect(result.status).not.toBe('failed');
  });

  it('未接线（无 runId）：静默回落 DOM 合成点击（isTrusted=false），日志仍写「工作流已点击」', async () => {
    // 不调用 setActiveClickRunId —— 等价于该文档没有拿到任务接线
    document.body.innerHTML = '<button aria-label="签到"></button>';
    const button = document.querySelector('button')!;
    const seen = captureTrust(button);
    elementFromPointTarget = button;

    const result = await runCheckinWorkflow(
      site(),
      { steps: [{ type: 'click', selector: 'text=签到' }] },
      log,
    );

    // dom-utils.ts:407-410 → useDomPointer=true；L493-497 走 domClick（合成 MouseEvent + el.click()）
    expect(seen).toEqual([false]);
    // workflow.ts:539 丢弃 realClick 的 'dom' 返回值：受信/降级在日志里完全一样
    expect(log.push).toHaveBeenCalledWith(expect.stringContaining('工作流已点击 text=签到'));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(result.status).not.toBe('failed');
  });

  it('扩展上下文失效（chrome.runtime.id 缺失）时：同样静默回落 DOM 合成点击', async () => {
    vi.stubGlobal('chrome', {});
    setActiveClickRunId('run-orphan', 'trusted');
    document.body.innerHTML = '<button aria-label="签到"></button>';
    const button = document.querySelector('button')!;
    const seen = captureTrust(button);
    elementFromPointTarget = button;

    await runCheckinWorkflow(site(), { steps: [{ type: 'click', selector: 'text=签到' }] }, log);

    // dom-utils.ts:410 `!chrome.runtime?.id` → 降级；扩展重载后的旧标签页就是这条路径
    expect(seen).toEqual([false]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('站点配置 pointerMode=dom 时：即使接线存在也合成点击，且没有任何降级日志', async () => {
    vi.stubGlobal('chrome', { runtime: { id: 'test-extension' } });
    setActiveClickRunId('run-dom', 'dom');
    document.body.innerHTML = '<button aria-label="签到"></button>';
    const button = document.querySelector('button')!;
    const seen = captureTrust(button);
    elementFromPointTarget = button;

    await runCheckinWorkflow(site(), { steps: [{ type: 'click', selector: 'text=签到' }] }, log);

    // dom-utils.ts:407 `activePointerMode === 'dom'` → 显式降级；生产预设全部是 'trusted'，
    // 但该字段可由存储/导入产物改写，且 UI 不展示 —— 配错一次就永久静默合成点击。
    expect(seen).toEqual([false]);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(log.push).toHaveBeenCalledWith(expect.stringContaining('工作流已点击 text=签到'));
  });

  it('无接线时 realClick 返回 dom —— 调用方丢弃该值，降级对上层不可见', async () => {
    const button = document.createElement('button');
    elementFromPointTarget = button;
    await expect(realClick(button)).resolves.toBe('dom');
  });
});

/* ------------------------------------------------------------------ *
 * 二、学到的 text= 选择器在回放端解析到别的同名元素
 * ------------------------------------------------------------------ */

describe('学到的 text= 选择器在回放端解析到别的同名元素（学习端唯一 ≠ 回放端唯一）', () => {
  it('role="menuitem" 的个人资料：回放真实触发点击并记录工作流已点击日志', async () => {
    document.body.innerHTML = '<div role="menuitem">个人资料</div>';
    const menuItem = document.querySelector<HTMLElement>('[role="menuitem"]')!;
    const selector = learningSelector(menuItem);

    expect(selector).toBe('text=个人资料');
    expect(queryFirst(selector)).toBe(menuItem);

    const seen = captureClicks(menuItem);
    elementFromPointTarget = menuItem;
    const result = await runCheckinWorkflow(
      site(),
      { steps: [{ type: 'click', selector }] },
      log,
    );

    expect(seen).toEqual(['click']);
    expect(log.push).toHaveBeenCalledWith(expect.stringContaining('工作流已点击 text=个人资料'));
    expect(result.status).not.toBe('failed');
  });

  it('导航链接「签到」与主区图标按钮（aria-label=签到）同名：回放 text=签到 点到导航链接，图标按钮没被点', async () => {
    // 学习时刻：导航未展开/未渲染（折叠侧栏、懒渲染、独立页演示都是通用成因），
    // 导航链接被 isVisible 过滤掉，图标按钮是 text=签到 的唯一命中。
    document.body.innerHTML = [
      '<nav><a href="#checkin" style="display:none">签到</a></nav>',
      '<main><button aria-label="签到"></button></main>',
    ].join('');
    const learnedButton = document.querySelector('button')!;
    expect(learningSelector(learnedButton)).toBe('text=签到');

    // 回放时刻：侧栏展开（或导航懒渲染完成），同名链接进入可点集合。
    document.body.innerHTML = [
      '<nav><a href="#checkin">签到</a></nav>',
      '<main><button aria-label="签到"></button></main>',
    ].join('');
    const link = document.querySelector('a')!;
    const button = document.querySelector('button')!;

    // 根因实锤：queryByText 的排序是「折叠等级 → 最短文本 → 文档序」，
    // 两者同为 2 字、文档序链接在前 → text=签到 命中导航链接。
    expect(queryFirst('text=签到')).toBe(link);
    expect(queryFirst('text=签到')).not.toBe(button);

    // 学习端唯一性校验与回放端共用同一解析器（learning.ts:1364 ambiguousSelector → queryAll）；
    // 两元素同刻存在时它不会产出 text=签到，而是回落结构路径 —— 但校验只覆盖学习那一刻的 DOM。
    expect(learningSelector(button)).not.toBe('text=签到');
    expect(queryFirst(learningSelector(button))).toBe(button);

    // 完整回放：点击落在导航链接上（点了等于没点），日志仍写「已点击」。
    const onLink = captureClicks(link);
    const onButton = captureClicks(button);
    elementFromPointTarget = link;
    const result = await runCheckinWorkflow(
      site(),
      { steps: [{ type: 'click', selector: 'text=签到' }] },
      log,
    );

    expect(onLink).toEqual(['click']);
    expect(onButton).toEqual([]);
    expect(log.push).toHaveBeenCalledWith(expect.stringContaining('工作流已点击 text=签到'));
    expect(result.status).not.toBe('failed');
  });

  it('两处同名图标按钮（页头浮层 + 主区工具栏）：学习时只有一处渲染，回放点到的却是先序的另一处', async () => {
    // 学习时刻：页头图标尚未挂载（滚动后才挂载的浮层/懒渲染是通用形态）。
    document.body.innerHTML = '<main id="app"><section><button aria-label="签到"></button></section></main>';
    const learnedButton = document.querySelector('button')!;
    expect(learningSelector(learnedButton)).toBe('text=签到');

    // 回放时刻：页头浮层按钮先挂载（DOM 序在前）。
    document.body.innerHTML = [
      '<header><button aria-label="签到"></button></header>',
      '<main id="app"><section><button aria-label="签到"></button></section></main>',
    ].join('');
    const headerButton = document.querySelector<HTMLElement>('header button')!;
    const toolbarButton = document.querySelector<HTMLElement>('main button')!;

    // 命中的是另一个控件（等长文本按文档序取先序者）。
    expect(queryFirst('text=签到')).toBe(headerButton);
    expect(queryFirst('text=签到')).not.toBe(toolbarButton);

    // 同刻校验（同一解析器）会拒绝这种歧义、回落为锚定稳定祖先的结构路径：
    // 歧义检测存在，只是不覆盖「学习/回放两刻的 DOM 差异」。
    expect(learningSelector(toolbarButton)).toBe('#app > section > button');

    const onHeader = captureClicks(headerButton);
    const onToolbar = captureClicks(toolbarButton);
    elementFromPointTarget = headerButton;
    await runCheckinWorkflow(site(), { steps: [{ type: 'click', selector: 'text=签到' }] }, log);

    expect(onHeader).toEqual(['click']);
    expect(onToolbar).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 三、无属性/无文字控件的兜底：结构路径在状态替换/结构变动后失配（orevx 实测形状）
 * ------------------------------------------------------------------ */

describe('圆形纯图标按钮（无属性、无可见文字）：兜底结构路径依赖层级与兄弟顺序', () => {
  /** orevx 实测形状：圆形图标按钮（aria-label=签到，无可见文字）+ 同名导航链接。 */
  const OREVX_SHAPE = [
    '<nav><a href="/user/checkins">签到</a></nav>',
    '<main><div class="card"><button type="button" aria-label="签到">',
    '<span></span><span></span><span class="icon"><svg aria-hidden="true"></svg></span>',
    '</button></div></main>',
  ].join('');
  /** 点击成功后站点把卡片内容原地替换成「今日已签到」记录视图（通用的状态替换形态）。 */
  const CHECKED_IN_VIEW = '<div>已签到</div><div>今日已签到 奖励 190</div>';

  it('学习端：同名导航链接在场 → text=签到 被判歧义拒绝，无文字控件回落结构路径 main > div > button', () => {
    document.body.innerHTML = OREVX_SHAPE;
    const button = document.querySelector<HTMLElement>('main button')!;
    const link = document.querySelector('nav a')!;
    // 同名陷阱：全页 text=签到 先命中导航链接（learningSelector 的同一解析器此刻也会读到两个命中）
    expect(queryFirst('text=签到')).toBe(link);
    // aria 档被同一套解析器（queryAll）拒绝；按钮无文字 → 兜底结构化路径（orevx 实测产物同形）
    expect(learningSelector(button)).toBe('main > div > button');
  });

  it('回放端：按钮仍在时结构路径可解析；被「已签到」状态视图替换后按终局证据报已完成（依旧绝无「工作流已点击」）', async () => {
    window.history.replaceState({}, '', '/user/checkins');
    document.body.innerHTML = OREVX_SHAPE;
    const button = document.querySelector<HTMLElement>('main button')!;
    const selector = learningSelector(button);
    expect(selector).toBe('main > div > button');
    expect(queryFirst(selector)).toBe(button); // 按钮还在 → 结构路径有效

    // 当天已签到再回放：站点把卡片内容换成状态视图，按钮从 DOM 消失。
    document.querySelector('main .card')!.innerHTML = CHECKED_IN_VIEW;
    expect(queryFirst(selector)).toBeNull();

    const events: WorkflowLearningEvent[] = [
      { type: 'navigation', path: '/user/checkins', at: 1_000 },
      {
        type: 'click',
        selector,
        label: '签到',
        path: '/user/checkins',
        evidence: { kind: 'already', words: ['已签到'] },
        at: 2_000,
      },
    ];
    const built = buildLearnedWorkflow(site(), events)!;
    const result = await runCheckinWorkflow(site(), built.workflow, log);

    // 目标元素整体消失 → 定位不到「目标控件附近」这个范围。
    // 此时页面上的「今日已签到」只在被替换掉的卡片里（远处/无归属），
    // 按新规则不判 already，如实报失败（宁真失败，不假成功）。
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error(`期望 failed，实际 ${result.status}`);
    expect(log.push).not.toHaveBeenCalledWith(expect.stringContaining('工作流已点击'));
    expect(result.message).toContain('工作流找不到可点击元素');
    expect(readWorkflowOutcomeEvidence().kind).toBe('already');
  });

  it('图标 span 上的点按同样兜底为 nth-of-type 结构路径：兄弟顺序一变就指到别的元素', () => {
    document.body.innerHTML = OREVX_SHAPE;
    const iconSpan = document.querySelector('main button span.icon') as HTMLElement;
    // 与 orevx 实测产物同形（edge-span-click 事件里的选择器）
    expect(learningSelector(iconSpan)).toBe('main > div > button > span:nth-of-type(3)');

    // 站点重绘时在前面插入一个装饰 span：同一个选择器改指另一个 span。
    const button = document.querySelector('main button')!;
    button.insertAdjacentHTML('afterbegin', '<span class="new-glow"></span>');
    const resolved = queryFirst('main > div > button > span:nth-of-type(3)');
    expect(resolved).not.toBe(iconSpan);
    expect(resolved).toBe(button.querySelectorAll('span')[2]);
  });
});

/* ------------------------------------------------------------------ *
 * 四、当天已签到再回放：目标消失/被状态控件替换时的误判
 * ------------------------------------------------------------------ */

/** 学习产物的真实形状：click text=签到 + 尾部 already/success 判定（与 compileSteps 收尾一致）。 */
function learnedCheckinWorkflow() {
  const events: WorkflowLearningEvent[] = [
    { type: 'navigation', path: '/check-in', at: 1_000 },
    {
      type: 'click',
      selector: 'text=签到',
      label: '签到',
      path: '/check-in',
      evidence: { kind: 'already', words: ['已签到'] },
      at: 2_000,
    },
  ];
  const built = buildLearnedWorkflow(site(), events);
  if (!built) throw new Error('学习产物构建失败（审计前提）');
  return built.workflow;
}

describe('当天已签到再回放：只在目标控件附近判 already，整页文本不再算数', () => {
  it('侧栏有「今日已签到」但点击目标所在卡片没有该字样：不得把整页文本当 already，如实报失败', async () => {
    vi.stubGlobal('chrome', { runtime: { id: 'test-extension' } });
    setActiveClickRunId('run-sidebar-only', 'trusted');
    vi.mocked(sendMessage).mockResolvedValue({
      ok: true,
      feature: { pointer: { mode: 'trusted', pathPoints: 3, clickObserved: false } },
    });
    const workflow = learnedCheckinWorkflow();
    // 侧栏有「今日已签到」记录（历史数据），但真正的签到卡片里只有动作按钮：
    // 目标区域没有任何 already 证据 —— 这次点击失败就是失败。
    document.body.innerHTML = [
      '<aside class="history">今日已签到 累计 29 天</aside>',
      '<main><section class="card"><button type="button">签到</button></section></main>',
    ].join('');
    const cardButton = document.querySelector('main button')!;
    elementFromPointTarget = cardButton;

    const result = await runCheckinWorkflow(site(), workflow, log);

    expect(result.status).toBe('failed');
    expect(log.push).not.toHaveBeenCalledWith(expect.stringContaining('按已完成处理'));
  });

  it('目标卡片里明确写着「今日已签到」：点击失败时仍在卡片范围内读到证据 → 按已完成收尾', async () => {
    vi.stubGlobal('chrome', { runtime: { id: 'test-extension' } });
    setActiveClickRunId('run-card-already', 'trusted');
    vi.mocked(sendMessage).mockResolvedValue({
      ok: true,
      feature: { pointer: { mode: 'trusted', pathPoints: 3, clickObserved: false } },
    });
    const workflow = learnedCheckinWorkflow();
    document.body.innerHTML = '<main><section class="card"><div>今日已签到 奖励 190</div><button type="button">签到</button></section></main>';
    const cardButton = document.querySelector('main button')!;
    elementFromPointTarget = cardButton;

    const result = await runCheckinWorkflow(site(), workflow, log);

    expect(result.status).toBe('already');
    if (result.status !== 'already') throw new Error(`期望 already，实际 ${result.status}`);
    expect(log.push).toHaveBeenCalledWith(expect.stringContaining('页面显示今日已完成'));
  });

  it('按钮换成不可点的「今日已签到」记录视图且目标已不存在：定位不到目标 → 如实报失败，不用整页文本判 already', async () => {
    const workflow = learnedCheckinWorkflow();
    document.body.innerHTML = '<div class="today">今日已签到</div><div>+$190</div>';

    // 整页仍然读得到 already 证据（另一个调用方的语义没变）……
    expect(readWorkflowOutcomeEvidence().kind).toBe('already');

    const result = await runCheckinWorkflow(site(), workflow, log);

    // ……但目标控件已定位不到，「附近」这个范围不存在：
    // 收紧后的 click 失败出口不再读整页文本，如实返回 failed。
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error(`期望 failed，实际 ${result.status}`);
    expect(result.message).toContain('工作流找不到可点击元素');
    expect(log.push).not.toHaveBeenCalledWith(expect.stringContaining('按已完成处理'));
  });

  it('选择器整体失效、但页面上有可点签到按钮：按页面控件快照兜底点击，不再空滚后判失败', async () => {
    // 现场形态（1412's API）：学习时的选择器/结构路径在回放时失配，回放对着滚动面板
    // 来回扫掠 24 次后报「找不到可点击元素」—— 而页面上明明有一个可点的签到按钮。
    // 站点改版后按钮文案变了（学习时录到「立即签到」，页面上现在是「领取今日额度」），
    // `text=` 严格按文字匹配，因此选择器整体失效 —— 快照必须据此兜底。
    const workflow: CheckinWorkflowConfig = {
      steps: [{ type: 'click', selector: 'text=立即签到' }],
    };
    document.body.innerHTML = '<button>领取今日额度</button>';
    const button = document.querySelector('button')!;
    const clicked = captureClicks(button);
    elementFromPointTarget = button;

    const result = await runCheckinWorkflow(site(), workflow, log);

    // 快照按「页面上真实存在的可点签到控件」兜底，而不是继续滚或直接判死。
    expect(clicked).toEqual(['click']);
    expect(log.push).toHaveBeenCalledWith(expect.stringContaining('页面控件快照命中签到动作'));
    expect(result.status).not.toBe('failed');
  });

  it('选择器失效且页面上只剩禁用态签到控件：按快照判「今日已完成」，不去点也不空滚', async () => {
    const workflow: CheckinWorkflowConfig = {
      steps: [{ type: 'click', selector: 'text=立即签到' }],
    };
    document.body.innerHTML = '<button disabled>已签到</button>';
    const stateButton = document.querySelector('button')!;
    const clicked = captureClicks(stateButton);
    elementFromPointTarget = stateButton;

    const result = await runCheckinWorkflow(site(), workflow, log);

    expect(clicked).toEqual([]);
    expect(log.push).toHaveBeenCalledWith(expect.stringContaining('页面控件快照判定今日已完成'));
    expect(result.status).toBe('already');
  });

  it('受信路径：按钮被替换成 disabled 的「已签到」状态控件（子串同样命中「签到」）—— 真实点击探测不到 click，终局证据 already → 按已完成收尾', async () => {
    vi.stubGlobal('chrome', { runtime: { id: 'test-extension' } });
    setActiveClickRunId('run-already', 'trusted');
    vi.mocked(sendMessage).mockResolvedValue({
      ok: true,
      feature: { pointer: { mode: 'trusted', pathPoints: 3, clickObserved: false } },
    });
    const workflow = learnedCheckinWorkflow();
    document.body.innerHTML = '<button disabled>已签到</button>';
    const stateButton = document.querySelector('button')!;
    elementFromPointTarget = stateButton;

    const result = await runCheckinWorkflow(site(), workflow, log);

    // 解析到的其实是「已签到」状态控件（text= 是子串匹配，「已签到」包含「签到」）；
    // 受信点击如实报「未到达目标控件」—— 失败原因仍会写进日志，
    // 但点击失败出口先读终局证据：页面「已签到」→ 按已完成收尾，不再误报 failed。
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'TRUSTED_POINTER_CLICK',
      runId: 'run-already',
    }));
    expect(result.status).toBe('already');
    if (result.status !== 'already') throw new Error(`期望 already，实际 ${result.status}`);
    expect(result.message).toContain('已完成');
    expect(log.push).toHaveBeenCalledWith(expect.stringContaining('浏览器级鼠标事件未到达目标控件'));
    expect(log.push).toHaveBeenCalledWith(expect.stringContaining('页面显示今日已完成'));
  });

  it('降级路径（无接线）：同一页面、disabled 控件上合成点击静默无效，反而靠尾部判定得到 already —— 同页两种结论', async () => {
    const workflow = learnedCheckinWorkflow();
    document.body.innerHTML = '<button disabled>已签到</button>';
    const stateButton = document.querySelector('button')!;
    const seen = captureClicks(stateButton);
    elementFromPointTarget = stateButton;

    const result = await runCheckinWorkflow(site(), workflow, log);

    // disabled 控件不派发 click（浏览器原生行为，jsdom 同规范）—— 合成点击全落在空处。
    expect(seen).toEqual([]);
    // 日志说点了，实际什么都没点到；随后尾部判定读到「已签到」→ already。
    expect(log.push).toHaveBeenCalledWith(expect.stringContaining('工作流已点击 text=签到'));
    expect(result.status).toBe('already');
  });

  it('目标控件直挂 body（无容器）：只认控件自身文字，远处的侧栏文案不作数', async () => {
    vi.stubGlobal('chrome', { runtime: { id: 'test-extension' } });
    setActiveClickRunId('run-body-level', 'trusted');
    vi.mocked(sendMessage).mockResolvedValue({
      ok: true,
      feature: { pointer: { mode: 'trusted', pathPoints: 3, clickObserved: false } },
    });
    const workflow = learnedCheckinWorkflow();
    // 侧栏写着「今日已签到」（历史数据），目标按钮本身只是「签到」：
    // 控件直挂 body，父级就是整页 —— 收紧后只认控件自身文字，不得判 already。
    document.body.innerHTML = [
      '<aside>今日已签到 累计 29 天</aside>',
      '<button type="button">签到</button>',
    ].join('');
    const button = document.querySelector('button')!;
    elementFromPointTarget = button;

    const result = await runCheckinWorkflow(site(), workflow, log);

    expect(result.status).toBe('failed');
  });
});
