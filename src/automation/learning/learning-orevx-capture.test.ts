/**
 * 「学习签到」采集/编译回归：图标按钮的**装饰层吸收点击**与**同名控件**两类通用缺陷。
 *
 * 现场（orevx.ai 演示的一次真实症状，按通用类别表述）：
 *   - 圆形纯图标「签到」按钮（无可见文字，可访问名只有 aria-label）被用户点击后，
 *     回放日志没有任何「工作流已点击」行，流程以页面奖励证据收尾；
 *   - 采集/编译链路本身能产出点击步骤（本文件锁定），真正的丢点机制是：
 *
 *   通用缺陷 A（采集目标选择，**已修复**）：分层装饰按钮把「环形/边缘可视区域」的
 *     点击变成对内层装饰 `<span>`（glow/ring 罩层）的点击 —— 它继承 `cursor:pointer`
 *     （真实 Chromium 复核：button 上 `cursor-pointer` 类沿继承传给所有子元素），
 *     旧实现的三档判定（任一命中即可）因此把它当作可点目标，学出的步骤选择器指向
 *     装饰层；回放端 `realClick` 的可点击性预检（dom-utils.ts:488-491）以**元素中心**
 *     做命中测试并通过 `hit===el || el.contains(hit) || hit.contains(el)` 判定遮挡 ——
 *     装饰层没有子元素、其中心点被同层的 svg/图标兄弟覆盖（真实 Chromium 复核
 *     pass=false），该判定恒为假 → 抛「目标控件被 … 遮挡」→ 点击永远不会发生。
 *     影响面：任何用绝对定位装饰罩层拼出的圆形/圆角图标按钮（UI 组件库常态形态：
 *     光晕、边框环、ripple、进度圈），用户没点准中心就会踩到。
 *
 *     修复：采集端沿 composedPath 由内向外做**两档强度扫描** —— 强命中（语义控件 /
 *     可点 ARIA role / [onclick]、[tabindex]）立即采用；仅 cursor:pointer 的**弱命中**
 *     （装饰层的唯一信号）只临时记住作兜底，扫完整条祖先链没有强命中才回退到它。
 *     环形/边缘点击因此归并到外包的按钮本体；无任何强祖先的纯 cursor 自制控件
 *     行为不变（见下方守卫用例）。
 *
 *   通用缺陷 B（同名控件抢走文字档）：导航/侧栏有一个可见文字「签到」的链接
 *     （如 <a href="/user/checkins">签到</a>），与图标按钮的 aria-label「签到」
 *     同名。学习端当前的歧义闸门（learning.ts:1364-1373 ambiguousSelector）会
 *     正确拒绝 `text=签到` 档、回落结构化路径 —— 本文件同时锁定：这道闸门是
 *     承重的，没有它 `queryFirst('text=签到')` 会命中导航链接（点了等于没点）。
 *
 * 真实 Chromium 复核数据（仅作依据，测试本身在 jsdom 运行）：
 *   - 中心点击（±48px 内）：hit=svg → 跳过 SVGElement → 目标 = button，
 *     结构化路径 `main > div > button`，遮挡预检 pass=true；
 *   - 环形带点击（距中心 ~52px，落在 size-24 svg 之外、inset-2 罩层之内）：
 *     修复前 hit=span.ring（装饰层）→ 采集目标 = span.ring，路径 `… > span:nth-of-type(2)`，
 *     其中心处 hit=svg（兄弟节点）→ 遮挡预检 pass=false → 回放注定点不动；
 *     修复后同一次单击归并到 button，产物与中心点击一致（`main > div > button`）；
 *   - 外带点击（~69px）：修复前同上，目标 = span.glow（`… > span:nth-of-type(1)`）。
 *
 * 本文件锁定**修复后**的现状：环形/边缘点击归并到强可交互祖先、不再把装饰层学成
 * 点击目标；缺陷 B 的歧义闸门与其余现状照旧锁定。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SiteConfig, WorkflowLearningEvent } from '@/types';
import {
  buildLearnedWorkflow,
  LearningCapture,
} from '@/automation/learning/learning';
import { queryFirst } from '@/automation/shared/dom-utils';
import { validateCheckinWorkflow } from '@/lib/workflow/workflow-validation';

const site: SiteConfig = {
  id: 'layered-icon-button',
  name: '分层图标按钮形状测试站',
  loginUrl: 'https://example.test/login',
  selectors: { username: '', password: '', submit: '' },
  closeModalSelectors: [],
};

/**
 * 形状一（orevx 页复现）：导航里一条可见文字「签到」的链接 +
 * 主区圆形按钮（aria-label「签到」、无可见文字、两个绝对定位装饰 `<span>` 罩层 +
 * 两个 `<svg>`）。装饰层在真实浏览器里继承 button 的 `cursor:pointer` —— jsdom
 * 不实现 CSS 继承，本文件用行内 `cursor:pointer` 作等价代理（真实继承已被独立的
 * 真实 Chromium 复核证实）。
 */
const LAYERED_PAGE = [
  '<nav class="app-nav"><a href="/user/checkins" class="nav-link">签到</a></nav>',
  '<main>',
  '  <div class="checkin-card flex flex-col items-center">',
  '    <button type="button" aria-label="签到" aria-busy="false"',
  '            class="group relative grid size-36 place-items-center rounded-full cursor-pointer">',
  '      <span class="glow absolute inset-0 rounded-full opacity-16" style="cursor:pointer"></span>',
  '      <span class="ring absolute inset-2 rounded-full border" style="cursor:pointer"></span>',
  '      <svg class="mid relative size-24" viewBox="0 0 35.6 35.6" aria-hidden="true">',
  '        <circle cx="17.8" cy="17.8" r="17.8"></circle>',
  '      </svg>',
  '      <svg class="icon absolute size-9" viewBox="0 0 24 24" aria-hidden="true">',
  '        <rect x="5" y="7" width="14" height="12"></rect>',
  '      </svg>',
  '    </button>',
  '    <p class="mt-4 text-sm">签到可领取 190 积分</p>',
  '  </div>',
  '</main>',
].join('');

/** 点击成功后按钮区域换成「已签到」记录视图（同一路径，界面变化证据）。 */
const CHECKED_IN_VIEW = [
  '<div class="checked-in flex flex-col items-center">',
  '  <div class="relative grid size-36 place-items-center rounded-full">已签到</div>',
  '  <div>今日已签到 奖励 190</div>',
  '</div>',
].join('');

/** 资料页（身份核验页），用户演示通常先经过它。 */
const PROFILE_PAGE = [
  '<nav class="app-nav"><a href="/user/checkins" class="nav-link">签到</a></nav>',
  '<main><div class="profile-card"><h1>我的资料</h1><p>当前账号：学习演示账号</p></div></main>',
].join('');

/**
 * 形状二（不同布局复核）：悬浮区（稳定 id 祖先 `#hub`）里的非原生圆钮
 * （`div[role=button]` + 装饰罩层），**没有**同名文字 —— 用来对照：
 * 同样的分层装饰缺陷在不带同名文字的不同布局下同样成立；
 * 而文字档的候选一旦唯一，选择器就走 aria 档而不是结构路径。
 */
const HUB_FAB_PAGE = [
  '<section id="hub" class="hub">',
  '  <div class="fab-hint"><span class="tip">每日福利</span></div>',
  '  <div role="button" tabindex="0" aria-label="签到" class="fab" style="cursor:pointer">',
  '    <span class="halo" style="cursor:pointer"></span>',
  '    <span class="disc" style="cursor:pointer"></span>',
  '    <svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle></svg>',
  '  </div>',
  '</section>',
].join('');

function dumpJson(name: string, value: unknown): void {
  try {
    const dir = process.env.OREVX_DUMP_DIR ?? join(tmpdir(), 'orevx-learning-dump');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), JSON.stringify(value, null, 2), 'utf8');
  } catch {
    // 测试进程里落盘只是证据留痕，失败不影响断言。
  }
}

describe('分层装饰图标按钮：采集/编译把点击学成了什么（orevx 形状复现）', () => {
  /** 让 jsdom 里所有元素都算可见（与 learning.test.ts 的 stubLayout 相同）。 */
  function stubLayout(): void {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 100, height: 30, top: 0, left: 0, right: 100, bottom: 30, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    Object.defineProperty(HTMLElement.prototype, 'innerText', {
      configurable: true,
      get(this: HTMLElement) { return this.textContent ?? ''; },
    });
  }

  beforeEach(() => {
    stubLayout();
    document.body.innerHTML = '';
    window.history.replaceState({}, '', '/user/checkins');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  function startCapture() {
    const events: WorkflowLearningEvent[] = [];
    const capture = new LearningCapture({ settleMs: 0, scrollStopMs: 0, onEvent: (event) => events.push(event) });
    return { events, capture };
  }

  it('前提：同名「签到」链接先命中文字解析；装饰层继承手形光标（修复前被当成可点目标）', () => {
    document.body.innerHTML = LAYERED_PAGE;
    const button = document.querySelector('button')!;
    const ring = button.querySelector('.ring') as HTMLElement;

    // 缺陷 B 的前提：全页 `text=签到` 先命中导航链接（文档序在前、等长文本）。
    const byText = queryFirst('text=签到');
    expect(byText).not.toBeNull();
    expect((byText as HTMLElement).tagName).toBe('A');

    // 缺陷 A 的触发前提：装饰罩层继承手型光标（真实 Chromium 复核 cursor=pointer），
    // jsdom 用行内样式作代理 —— 修复后它只是「弱命中」，会被归并到外包的 button。
    expect(getComputedStyle(ring).cursor).toBe('pointer');
    expect(getComputedStyle(button.querySelector('.glow') as HTMLElement).cursor).toBe('pointer');
  });

  it('点按钮中心：目标是 button（不是装饰层），选择器唯一且回放解析回按钮，编译出点击步骤', () => {
    document.body.innerHTML = LAYERED_PAGE;
    const { events, capture } = startCapture();
    capture.attach();

    // 中心点击：真实 Chromium 里落在最上层的 svg 上、SVGElement 被跳过 → 目标=button。
    const icon = document.querySelector('svg.icon')!;
    icon.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, clientX: 50, clientY: 50 }));
    document.querySelector('.checkin-card')!.innerHTML = CHECKED_IN_VIEW;
    capture.flushPending();
    capture.detach();

    const clicks = events.filter((event) => event.type === 'click');
    dumpJson('layered-center.events.json', events);
    expect(clicks.length).toBeGreaterThan(0);
    const selector = (clicks[0] as { selector: string }).selector;

    // 学习端产物：锚定结构路径（因为 `text=签到` 档被同名链接的歧义闸门拒绝，
    // 见 learning.ts:1364-1373）。
    expect(selector).toBe('main > div > button');

    // 回放端解析（与学习端唯一性校验共用同一解析器）：重新渲染同一页面，
    // 选择器必须解析回按钮本身。
    document.body.innerHTML = LAYERED_PAGE;
    const freshButton = document.querySelector('button')!;
    const resolved = queryFirst<HTMLElement>(selector);
    expect(resolved).not.toBeNull();
    expect(resolved === freshButton || freshButton.contains(resolved!)).toBe(true);

    // 编译：可执行点击步骤在位。
    const learned = buildLearnedWorkflow(site, events);
    dumpJson('layered-center.learned.json', learned);
    expect(learned).not.toBeNull();
    const clickSteps = learned!.workflow.steps.filter((step) => step.type === 'click');
    expect(clickSteps.length).toBeGreaterThan(0);
    expect((clickSteps[0] as { selector: string }).selector).toBe(selector);
  });

  it('点环形装饰带：目标归并到最近的强可交互祖先（button），不再学成装饰 span', () => {
    document.body.innerHTML = LAYERED_PAGE;
    const ring = document.querySelector('.ring') as HTMLElement;
    const { events, capture } = startCapture();
    capture.attach();

    // 真实 Chromium 复核：点击环形带（距中心 ~52px）时最上层命中就是这层装饰 span。
    ring.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, clientX: 78, clientY: 102 }));
    document.querySelector('.checkin-card')!.innerHTML = CHECKED_IN_VIEW;
    capture.flushPending();
    capture.detach();

    const clicks = events.filter((event) => event.type === 'click');
    dumpJson('layered-ring.events.json', events);
    expect(clicks.length).toBeGreaterThan(0);
    const selector = (clicks[0] as { selector: string }).selector;

    // 修复后：装饰 span 只是弱命中（继承 cursor:pointer），让位给外包的 button 本体；
    // aria 文字档被同名导航链接的歧义闸门拒绝，落回与中心点击一致的结构化路径。
    expect(selector).toBe('main > div > button');

    // 回放端用同一解析器解析：重新渲染同一页面，选择器必须解析回按钮本体。
    document.body.innerHTML = LAYERED_PAGE;
    const freshButton = document.querySelector('button')!;
    const resolved = queryFirst<HTMLElement>(selector);
    expect(resolved).not.toBeNull();
    expect(resolved === freshButton || freshButton.contains(resolved!)).toBe(true);
  });

  it('守卫：仅靠 cursor:pointer 的自制控件（无任何强可交互祖先）仍被采集且能编译出步骤', () => {
    // 弱命中是兜底：React/Vue 用 onClick 的自制控件在 DOM 上没有任何强信号，
    // 「强命中优先」不得把这类无强祖先的控件变成漏采。
    document.body.innerHTML = '<div id="bare" style="cursor:pointer">点我</div>';
    const bare = document.querySelector('#bare') as HTMLElement;
    const { events, capture } = startCapture();
    capture.attach();
    bare.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    capture.flushPending();
    capture.detach();

    const clicks = events.filter((event) => event.type === 'click');
    expect(clicks.length).toBeGreaterThan(0);
    const selector = (clicks[0] as { selector: string }).selector;
    // 目标仍是这个弱元素本身，而不是被归并到 body / 被整段丢弃。
    expect(selector).toBe('#bare');
    document.body.innerHTML = '<div id="bare" style="cursor:pointer">点我</div>';
    expect(queryFirst<HTMLElement>(selector)).toBe(document.querySelector('#bare'));

    // 编译链路照常产出点击步骤。
    const learned = buildLearnedWorkflow(site, events);
    expect(learned).not.toBeNull();
    expect(learned!.workflow.steps.filter((step) => step.type === 'click').length).toBeGreaterThan(0);
  });

  it('完整演示（资料页 → 签到页 → 点圆按钮）：点击步骤在保存校验下仍在位', () => {
    document.body.innerHTML = PROFILE_PAGE;
    window.history.replaceState({}, '', '/user/profile');
    const { events, capture } = startCapture();
    capture.attach();

    window.history.pushState({}, '', '/user/checkins');
    document.body.innerHTML = LAYERED_PAGE;
    const icon = document.querySelector('svg.icon')!;
    icon.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    document.querySelector('.checkin-card')!.innerHTML = CHECKED_IN_VIEW;
    capture.flushPending();
    capture.detach();

    const learned = buildLearnedWorkflow(site, events);
    dumpJson('layered-full-demo.events.json', events);
    dumpJson('layered-full-demo.learned.json', learned);
    expect(learned).not.toBeNull();

    // 保存链路前置条件与校验（background.ts:999-1034 的两道闸门）。
    expect(learned!.workflow.identityPath).toBe('/user/profile');
    expect(validateCheckinWorkflow(site, learned!.workflow)).toEqual([]);

    const clickSteps = learned!.workflow.steps.filter((step) => step.type === 'click');
    expect(clickSteps.length).toBeGreaterThan(0);
    document.body.innerHTML = LAYERED_PAGE;
    const freshButton = document.querySelector('button')!;
    const resolved = queryFirst<HTMLElement>((clickSteps[0] as { selector: string }).selector);
    expect(resolved === freshButton || freshButton.contains(resolved!)).toBe(true);
  });

  it('演示未经过独立身份页：签到终点页自己承担身份核验，整份流程不再被保存链路丢弃', () => {
    // 常见演示形态：直接打开签到页点击（没有先访问个人资料页）。
    document.body.innerHTML = LAYERED_PAGE;
    const { events, capture } = startCapture();
    capture.attach();
    document.querySelector('svg.icon')!.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    capture.flushPending();
    capture.detach();

    const learned = buildLearnedWorkflow(site, events);
    expect(learned).not.toBeNull();

    /*
     * 站点形态差异很大：很多站（1412、新版 new-api 家族）把「每日签到」卡片直接放在
     * 个人资料页上 —— 资料页与签到页是同一个地址，没有"另一个页面"可访问。
     *
     * 旧实现要求身份核验页必须与签到终点不同，这类演示只能得到 `identityPath === undefined`，
     * 保存链路（background.ts）再把它整体拒绝 —— 用户认真演示完却什么也没留下。
     *
     * 现在身份核验页只需是路线成员：推断不出独立资料页时兜底用签到终点页本身。
     * 回放时引擎到页后先读当前账号，读不到就停机（绝不盲签），形态放宽不降低安全性。
     */
    expect(learned!.workflow.steps.filter((step) => step.type === 'click').length).toBeGreaterThan(0);
    expect(learned!.workflow.identityPath).toBe('/user/checkins');
    expect(validateCheckinWorkflow(site, learned!.workflow)).toEqual([]);
  });
});

describe('不同布局复核：悬浮区圆钮（无同名文字、稳定 id 祖先）', () => {
  function stubLayout(): void {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 100, height: 30, top: 0, left: 0, right: 100, bottom: 30, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    Object.defineProperty(HTMLElement.prototype, 'innerText', {
      configurable: true,
      get(this: HTMLElement) { return this.textContent ?? ''; },
    });
  }

  beforeEach(() => {
    stubLayout();
    document.body.innerHTML = '';
    window.history.replaceState({}, '', '/console');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  function startCapture() {
    const events: WorkflowLearningEvent[] = [];
    const capture = new LearningCapture({ settleMs: 0, scrollStopMs: 0, onEvent: (event) => events.push(event) });
    return { events, capture };
  }

  it('没有同名文字时走 aria 档（text=签到）；中心点击目标=按钮本体，解析唯一', () => {
    document.body.innerHTML = HUB_FAB_PAGE;
    const { events, capture } = startCapture();
    capture.attach();
    document.querySelector('svg.mark')!.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    capture.flushPending();
    capture.detach();

    const click = events.find((event) => event.type === 'click') as { selector: string } | undefined;
    expect(click).toBeDefined();
    dumpJson('hub-center.events.json', events);

    // 对照形状一：候选唯一 → 文字档被采用，不再回落结构路径。
    expect(click!.selector).toBe('text=签到');

    document.body.innerHTML = HUB_FAB_PAGE;
    const freshFab = document.querySelector('[role="button"]')!;
    expect(queryFirst<HTMLElement>(click!.selector)).toBe(freshFab);

    const learned = buildLearnedWorkflow(site, events);
    dumpJson('hub-center.learned.json', learned);
    expect(learned!.workflow.steps.filter((step) => step.type === 'click').length).toBeGreaterThan(0);
  });

  it('同一分层装饰缺陷在另一种布局同样归并：点装饰带解析到 div[role=button]（无同名文字 → aria 档）', () => {
    document.body.innerHTML = HUB_FAB_PAGE;
    const disc = document.querySelector('.disc') as HTMLElement;
    const { events, capture } = startCapture();
    capture.attach();
    disc.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    capture.flushPending();
    capture.detach();

    const click = events.find((event) => event.type === 'click') as { selector: string } | undefined;
    dumpJson('hub-disc.events.json', events);
    expect(click).toBeDefined();

    // 修复后：装饰 span 的弱命中让位给强命中 div[role=button]；本页无同名文字，
    // aria 档唯一 → 选择器是 text=签到，而不是指向装饰层的结构路径。
    expect(click!.selector).toBe('text=签到');
    document.body.innerHTML = HUB_FAB_PAGE;
    const freshFab = document.querySelector('[role="button"]')!;
    expect(queryFirst<HTMLElement>(click!.selector)).toBe(freshFab);
  });
});
