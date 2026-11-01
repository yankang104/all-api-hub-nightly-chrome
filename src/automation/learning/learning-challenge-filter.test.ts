/**
 * 学习录制 × 人机验证过滤：覆盖面与误伤边界（全部数据虚构，不改动 src）。
 *
 * 背景：learning.ts 的 onClick 用 isChallengeSurfaceTarget（challenge.ts）识别
 * 人机验证控件 —— 元素本身**或其祖先**属于已识别的验证控件（滑块 / 腾讯滑块 /
 * Turnstile / reCAPTCHA / hCaptcha）就跳过，不录成工作流步骤。理由是回放侧由
 * 自动破解管线接管（challenge.ts 的 waitForChallenge → solveDetectedSlider /
 * executeChallengeInteraction，engine.ts 在签到/重登阶段调用）：录制时把验证
 * 交互录进去，回放时控件早已消失，那一步只会报「找不到可点击元素」。
 *
 * 本文件做两件事：
 * 1. 覆盖矩阵：极验/通用滑块、腾讯滑块、Turnstile、reCAPTCHA、hCaptcha 的
 *    「控件本体点击」与「控件内子元素点击」两档采集用例；
 * 2. 误伤边界：普通按钮 / 价格、音量滑块等正常 UI 不被跳过；加一张按
 *    CHALLENGE_SURFACE_SELECTORS 逐条对照的选择器语义判据表（只断言真实
 *    选择器语义），并记录两类已知边界（开放 shadow root、#challenge-stage 撞名）。
 *
 * 与 learning.test.ts 已知用例的关系：那边已覆盖 .geetest_slider_button 把手、
 * .cf-turnstile 内按钮、普通按钮三例；本文件用互不重复的夹具补齐其余组合。
 *
 * jsdom 约定：jsdom 没有布局引擎与 cursor:pointer 计算样式，真实浏览器里靠
 * cursor/onmousedown 等信号可点的控件在这里不成立，因此给被点控件补一个最小
 * 交互标记（tabindex/role）。这样「没被采集」只可能来自人机验证过滤，而不是
 * 元素压根解析不成可点目标；正常 UI 亦按同一约定处理，保证断言方向对称。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowLearningEvent } from '@/types';
import { LearningCapture } from '@/automation/learning/learning';
import { isChallengeSurfaceTarget } from '@/automation/challenge/challenge';

/** 让 jsdom 里所有元素都算可见 —— 否则采集会把控件全跳过。与 learning.test.ts 同款。 */
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

describe('学习录制 × 人机验证过滤（覆盖面与误伤边界）', () => {
  beforeEach(() => {
    stubLayout();
    document.body.innerHTML = '';
    window.history.replaceState({}, '', '/checkin');
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

  /** 铺好页面、真实点一次，再经 flush 出口取回本次录制的固定提示。 */
  async function clickThenFlush(html: string, selector: string) {
    document.body.innerHTML = html;
    const target = document.querySelector(selector)!;
    const { events, capture } = startCapture();
    capture.attach();
    plainClick(target);
    capture.flushPending();
    capture.detach();
    return {
      challengeTarget: isChallengeSurfaceTarget(target),
      events,
      unlearnedNotes: capture.unlearnedNotes,
    };
  }

  /** 原地点击（按下与松开位移为零）：只让验证过滤生效，不与拖拽尾巴过滤混淆。 */
  function plainClick(element: Element): void {
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true, clientX: 20, clientY: 40 }));
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true, clientX: 20, clientY: 40 }));
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, clientX: 20, clientY: 40 }));
  }

  /** 铺好 html、点击 selector 指向的元素，返回采到的 click 事件（只断言采集行为）。 */
  function recordClickOn(html: string, selector: string): Array<{ selector: string }> {
    document.body.innerHTML = html;
    const { events, capture } = startCapture();
    capture.attach();
    plainClick(document.querySelector(selector)!);
    capture.flushPending();
    capture.detach();
    return events.filter((event) => event.type === 'click') as Array<{ selector: string }>;
  }

  describe('覆盖矩阵：控件类型 × 控件本体 / 控件内子元素', () => {
    it('极验滑块拖动旋钮本体（.gt_slider_knob）点击不采集', () => {
      const clicks = recordClickOn(
        '<div id="gt-knob" class="gt_slider_knob" tabindex="0">➜</div>',
        '#gt-knob',
      );
      expect(clicks).toHaveLength(0);
    });

    it('极验把手内的惰性子元素（<i> 图标）点击不采集 —— 解析到 .geetest_slider_button', () => {
      const clicks = recordClickOn([
        '<div id="gt-panel" class="geetest_panel">',
        '  <div id="gt-handle" class="geetest_slider_button" tabindex="0"><i id="gt-icon">➜</i></div>',
        '</div>',
      ].join(''), '#gt-icon');
      expect(clicks).toHaveLength(0);
    });

    it('通用滑块容器（.slide-verify）内的可点子元素（role=button）点击不采集 —— closest 命中容器', () => {
      const clicks = recordClickOn([
        '<div id="sv" class="slide-verify">',
        '  <span id="sv-hint" role="button">按住滑块，拖动到最右边</span>',
        '</div>',
      ].join(''), '#sv-hint');
      expect(clicks).toHaveLength(0);
    });

    it('腾讯滑块把手本体（.tencent-captcha-dy__slider-block）点击不采集', () => {
      const clicks = recordClickOn(
        '<div id="tc-block" class="tencent-captcha-dy__slider-block" tabindex="0">➜</div>',
        '#tc-block',
      );
      expect(clicks).toHaveLength(0);
    });

    it('腾讯滑块轨道（.tencent-captcha-dy__slider-groove）内的子按钮点击不采集', () => {
      const clicks = recordClickOn([
        '<div id="tc-groove" class="tencent-captcha-dy__slider-groove">',
        '  <button id="tc-btn" type="button">拖动滑块</button>',
        '</div>',
      ].join(''), '#tc-btn');
      expect(clicks).toHaveLength(0);
    });

    it('腾讯验证背景（.tencent-captcha-dy__verify-bg）内的子元素点击不采集', () => {
      const clicks = recordClickOn([
        '<div id="tc-bg" class="tencent-captcha-dy__verify-bg">',
        '  <div id="tc-piece" tabindex="0">缺块</div>',
        '</div>',
      ].join(''), '#tc-piece');
      expect(clicks).toHaveLength(0);
    });

    it('Turnstile 容器本体（.cf-turnstile）点击不采集', () => {
      const clicks = recordClickOn(
        '<div id="ts-host" class="cf-turnstile" data-sitekey="fake-sitekey-000" tabindex="0"></div>',
        '#ts-host',
      );
      expect(clicks).toHaveLength(0);
    });

    it('Turnstile 容器内的勾选子元素（role=checkbox）点击不采集', () => {
      const clicks = recordClickOn([
        '<div id="ts-host2" class="cf-turnstile" data-sitekey="fake-sitekey-000">',
        '  <div id="ts-check" role="checkbox" aria-checked="false" tabindex="0">Verify you are human</div>',
        '</div>',
      ].join(''), '#ts-check');
      expect(clicks).toHaveLength(0);
    });

    it('reCAPTCHA 容器本体（.g-recaptcha）点击不采集', () => {
      const clicks = recordClickOn(
        '<div id="rc" class="g-recaptcha" data-sitekey="fake-sitekey-000" tabindex="0"></div>',
        '#rc',
      );
      expect(clicks).toHaveLength(0);
    });

    it('reCAPTCHA 容器内的勾选子元素点击不采集', () => {
      const clicks = recordClickOn([
        '<div id="rc2" class="g-recaptcha" data-sitekey="fake-sitekey-000">',
        "  <div id=\"rc-check\" role=\"checkbox\" aria-checked=\"false\" tabindex=\"0\">I'm not a robot</div>",
        '</div>',
      ].join(''), '#rc-check');
      expect(clicks).toHaveLength(0);
    });

    it('reCAPTCHA 的 iframe（src 含 recaptcha）本体点击不采集', () => {
      const clicks = recordClickOn(
        '<iframe id="rc-frame" src="https://www.recaptcha.net/recaptcha/api2/anchor?k=fake-sitekey-000" title="reCAPTCHA" tabindex="0"></iframe>',
        '#rc-frame',
      );
      expect(clicks).toHaveLength(0);
    });

    it('reCAPTCHA 变体容器（[class*=recaptcha][data-sitekey]）内的子按钮点击不采集', () => {
      const clicks = recordClickOn([
        '<div id="rc3" class="app-recaptcha-widget" data-sitekey="fake-sitekey-000">',
        '  <button id="rc3-btn" type="button">Verify</button>',
        '</div>',
      ].join(''), '#rc3-btn');
      expect(clicks).toHaveLength(0);
    });

    it('hCaptcha 容器本体（.h-captcha）点击不采集', () => {
      const clicks = recordClickOn(
        '<div id="hc" class="h-captcha" data-sitekey="fake-sitekey-000" tabindex="0"></div>',
        '#hc',
      );
      expect(clicks).toHaveLength(0);
    });

    it('hCaptcha 容器内的勾选子元素点击不采集', () => {
      const clicks = recordClickOn([
        '<div id="hc2" class="h-captcha" data-sitekey="fake-sitekey-000">',
        '  <div id="hc-check" role="checkbox" aria-checked="false" tabindex="0">I am human</div>',
        '</div>',
      ].join(''), '#hc-check');
      expect(clicks).toHaveLength(0);
    });

    it('hCaptcha 的 iframe（src 含 hcaptcha.com）本体点击不采集', () => {
      const clicks = recordClickOn(
        '<iframe id="hc-frame" src="https://newassets.hcaptcha.com/captcha/v1/fake.js" title="hCaptcha" tabindex="0"></iframe>',
        '#hc-frame',
      );
      expect(clicks).toHaveLength(0);
    });
  });

  describe('误伤边界：正常 UI 不被跳过', () => {
    /**
     * 价格/音量滑块经逐条对照 CHALLENGE_SURFACE_SELECTORS 确认**不命中**：
     * 滑块类选择器都要求「验证」语义的双词组合（captcha+slider / verify+slider /
     * slide-verify 子串）或具体厂商类名，裸的 slider / price-slider / el-slider /
     * volume-slider 均不在清单内。本组用例同时给出采集级与判据级证据；若未来
     * 选择器扩到纯 [class*=slider]，这里会率先报警。
     */
    it('普通签到按钮照常采集', () => {
      const clicks = recordClickOn('<button id="checkin" type="button">立即签到</button>', '#checkin');
      expect(clicks).toHaveLength(1);
      expect(clicks[0]!.selector).toBe('#checkin');
    });

    it('价格滑块（input[type=range].price-slider）照常采集 —— 选择器不命中它', () => {
      document.body.innerHTML = '<input id="price" type="range" class="price-slider" tabindex="0" aria-label="价格区间">';
      // 先确认判据：不命中（tabindex 仅为在 jsdom 里成为可点目标）
      expect(isChallengeSurfaceTarget(document.querySelector('#price')!)).toBe(false);

      const { events, capture } = startCapture();
      capture.attach();
      plainClick(document.querySelector('#price')!);
      capture.flushPending();
      capture.detach();
      const clicks = events.filter((event) => event.type === 'click');
      expect(clicks).toHaveLength(1);
      expect((clicks[0] as { selector: string }).selector).toBe('#price');
    });

    it('音量滑块（.volume-slider[role=slider]）照常采集 —— 只带 slider 词不构成验证控件', () => {
      const clicks = recordClickOn(
        '<div id="volume" class="volume-slider" role="slider" aria-valuenow="40" tabindex="0">音量</div>',
        '#volume',
      );
      expect(clicks).toHaveLength(1);
    });

    it('captcha 命名的说明元素（.captcha-tip，文案也含「验证码」）照常采集 —— 命名/文案都不等于控件', () => {
      const clicks = recordClickOn(
        '<div id="tip" class="captcha-tip" onclick="void 0">请先完成上方验证码</div>',
        '#tip',
      );
      expect(clicks.length).toBeGreaterThanOrEqual(1);
      expect(clicks[0]!.selector).toBe('#tip');
      // 说明文案里出现「验证码」时，关键词证据会以**同一个 at** 补报一次
      // （编译器挂回原动作，编译器视角仍是一步）；按不同 at 判动作数。
      const actionCount = new Set(clicks.map((click) => (click as unknown as { at: number }).at)).size;
      expect(actionCount).toBe(1);
    });

    it('常见滑块/轮播库命名（.bootstrap-slider）照常采集', () => {
      const clicks = recordClickOn(
        '<div id="hero" class="bootstrap-slider" onclick="void 0">轮播图</div>',
        '#hero',
      );
      expect(clicks).toHaveLength(1);
    });
  });

  describe('人机验证点击的可见提示', () => {
    const CLICK_NOTE = '点击人机验证控件：这一步不会写进流程，回放时由自动验证接管，可能需要人工完成';

    it('点击 Turnstile 控件产生「未学到、回放由自动验证接管」提示，且不录成步骤', async () => {
      const { challengeTarget, events, unlearnedNotes } = await clickThenFlush(
        '<div id="turnstile" class="cf-turnstile" data-sitekey="fake-sitekey-000" tabindex="0"></div>',
        '#turnstile',
      );
      expect(challengeTarget).toBe(true);
      expect(events.filter((event) => event.type === 'click')).toHaveLength(0);
      expect(unlearnedNotes).toContain(CLICK_NOTE);
    });

    it('点击普通按钮不产生该提示，且照常录成一步', async () => {
      const { challengeTarget, events, unlearnedNotes } = await clickThenFlush(
        '<button id="checkin" type="button">立即签到</button>',
        '#checkin',
      );
      expect(challengeTarget).toBe(false);
      expect(events.filter((event) => event.type === 'click')).toHaveLength(1);
      expect(unlearnedNotes).not.toContain(CLICK_NOTE);
    });
  });

  describe('选择器语义判据表（与回放检测 INTERACTIVE_DEFINITIONS 同源，只断言真实语义）', () => {
    /** 铺好 html，取 selector 指向的元素，返回判据结果。 */
    function predicateResult(html: string, selector: string): boolean {
      document.body.innerHTML = html;
      const element = document.querySelector(selector);
      if (!element) throw new Error(`fixture 缺少目标元素：${selector}`);
      return isChallengeSurfaceTarget(element);
    }

    it.each([
      ['极验面板 .geetest_panel', '<div id="t" class="geetest_panel"></div>', '#t'],
      ['极验容器 .geetest_holder', '<div id="t" class="geetest_holder"></div>', '#t'],
      ['极验拖动按钮 .geetest_slider_button', '<div id="t" class="geetest_slider_button"></div>', '#t'],
      ['极验容器 .gt_holder', '<div id="t" class="gt_holder"></div>', '#t'],
      ['极验容器 .gt_widget', '<div id="t" class="gt_widget"></div>', '#t'],
      ['极验拖动旋钮 .gt_slider_knob', '<div id="t" class="gt_slider_knob"></div>', '#t'],
      ['通用滑块 .slide-verify', '<div id="t" class="slide-verify"></div>', '#t'],
      ['通用滑块 .slider-captcha', '<div id="t" class="slider-captcha"></div>', '#t'],
      ['通用滑块 .captcha-slider', '<div id="t" class="captcha-slider"></div>', '#t'],
      ['通用滑块 .verify-slider', '<div id="t" class="verify-slider"></div>', '#t'],
      ['通用滑块 .jigsaw-slider', '<div id="t" class="jigsaw-slider"></div>', '#t'],
      ['通用拖拽验证 .drag-captcha', '<div id="t" class="drag-captcha"></div>', '#t'],
      ['易盾 .yidun_slider', '<div id="t" class="yidun_slider"></div>', '#t'],
      ['易盾 .yidun_panel', '<div id="t" class="yidun_panel"></div>', '#t'],
      ['阿里云验证码 .nc-container', '<div id="t" class="nc-container"></div>', '#t'],
      ['阿里云滑块按钮 .nc_iconfont.btn_slide', '<div id="t" class="nc_iconfont btn_slide"></div>', '#t'],
      ['captcha+slider 双词类名', '<div id="t" class="my-captcha-slider-box"></div>', '#t'],
      ['captcha+slider 双词 id', '<div id="captcha-slider-box"></div>', '#captcha-slider-box'],
      ['verify+slider 双词类名', '<div id="t" class="verify-slider-x"></div>', '#t'],
      ['slider+verify 双词类名', '<div id="t" class="slider-verify-x"></div>', '#t'],
      ['jigsaw+slider 双词类名', '<div id="t" class="jigsaw-slider-x"></div>', '#t'],
      ['slide-verify 子串类名', '<div id="t" class="my-slide-verify-box"></div>', '#t'],
      ['腾讯滑块轨道 .tencent-captcha-dy__slider-groove', '<div id="t" class="tencent-captcha-dy__slider-groove"></div>', '#t'],
      ['腾讯滑块把手 .tencent-captcha-dy__slider-block', '<div id="t" class="tencent-captcha-dy__slider-block"></div>', '#t'],
      ['腾讯验证背景 .tencent-captcha-dy__verify-bg', '<div id="t" class="tencent-captcha-dy__verify-bg"></div>', '#t'],
      ['Turnstile .cf-turnstile', '<div id="t" class="cf-turnstile"></div>', '#t'],
      ['Turnstile .turnstile-wrapper', '<div id="t" class="turnstile-wrapper"></div>', '#t'],
      ['Turnstile .turnstile-container', '<div id="t" class="turnstile-container"></div>', '#t'],
      ['Turnstile 子串类名 [class*=turnstile]', '<div id="t" class="cloudflare-turnstile-box"></div>', '#t'],
      ['Turnstile data-sitekey 联用', '<div id="t" class="turnstile-widget" data-sitekey="k"></div>', '#t'],
      ['Cloudflare 生成宿主 [id^=cf-chl-widget-]（非 input/textarea）', '<div id="cf-chl-widget-fake002"></div>', '#cf-chl-widget-fake002'],
      ['#challenge-stage 内 checkbox', '<div id="challenge-stage"><input id="t" type="checkbox"></div>', '#t'],
      ['#challenge-stage 内 role=checkbox', '<div id="challenge-stage"><div id="t" role="checkbox" aria-checked="false"></div></div>', '#t'],
      ['#challenge-stage 内未禁用按钮', '<div id="challenge-stage"><button id="t" type="button">Verify</button></div>', '#t'],
      ['Cloudflare 挑战 iframe（challenges.cloudflare.com）', '<iframe id="t" src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x"></iframe>', '#t'],
      ['Cloudflare 挑战 iframe 标题', '<iframe id="t" title="Cloudflare security challenge"></iframe>', '#t'],
      ['reCAPTCHA .g-recaptcha', '<div id="t" class="g-recaptcha"></div>', '#t'],
      ['reCAPTCHA 变体 [class*=recaptcha][data-sitekey]', '<div id="t" class="app-recaptcha-widget" data-sitekey="k"></div>', '#t'],
      ['reCAPTCHA iframe src', '<iframe id="t" src="https://www.google.com/recaptcha/api2/anchor?k=fake"></iframe>', '#t'],
      ['reCAPTCHA iframe 标题', '<iframe id="t" title="reCAPTCHA"></iframe>', '#t'],
      ['hCaptcha .h-captcha', '<div id="t" class="h-captcha"></div>', '#t'],
      ['hCaptcha 变体 [class*=hcaptcha][data-sitekey]', '<div id="t" class="app-hcaptcha-widget" data-sitekey="k"></div>', '#t'],
      ['hCaptcha iframe src', '<iframe id="t" src="https://newassets.hcaptcha.com/captcha/v1/fake.js"></iframe>', '#t'],
      ['hCaptcha iframe 标题', '<iframe id="t" title="hCaptcha"></iframe>', '#t'],
      ['控件内部的惰性子元素（closest 语义）', '<div class="g-recaptcha"><span id="t">●</span></div>', '#t'],
      ['腾讯控件内部的惰性子元素（closest 语义）', '<div class="tencent-captcha-dy__slider-block"><i id="t"></i></div>', '#t'],
    ])('视为人机验证控件：%s', (_label, html, selector) => {
      expect(predicateResult(html, selector)).toBe(true);
    });

    it.each([
      ['普通按钮', '<button id="t" type="button">立即签到</button>', '#t'],
      ['价格滑块 input[type=range].price-slider', '<input id="t" type="range" class="price-slider" aria-label="价格区间">', '#t'],
      ['价格筛选滑块 .slider.price-filter（只含 slider 词）', '<div id="t" class="slider price-filter"></div>', '#t'],
      ['音量滑块 .volume-slider[role=slider]', '<div id="t" class="volume-slider" role="slider" aria-valuenow="40"></div>', '#t'],
      ['轮播 .carousel-slider', '<div id="t" class="carousel-slider"></div>', '#t'],
      ['裸 .slider 容器', '<div id="t" class="slider"></div>', '#t'],
      ['常见滑块库 .bootstrap-slider', '<div id="t" class="bootstrap-slider"></div>', '#t'],
      ['Element UI 滑块 .el-slider', '<div id="t" class="el-slider"></div>', '#t'],
      ['拖拽排序把手 .drag-handle', '<div id="t" class="drag-handle"></div>', '#t'],
      ['带 captcha 命名的说明容器 .captcha-tip', '<div id="t" class="captcha-tip">请先完成验证码</div>', '#t'],
      ['带 verify 命名的徽标 .verify-badge', '<span id="t" class="verify-badge">已认证</span>', '#t'],
      ['协议勾选框 input[type=checkbox].terms-checkbox', '<input id="t" type="checkbox" class="terms-checkbox">', '#t'],
      ['普通业务 iframe（title=analytics）', '<iframe id="t" title="analytics" src="https://example.com/frame"></iframe>', '#t'],
      ['Cloudflare 响应字段 input（选择器显式排除 input/textarea）', '<input id="cf-chl-widget-fake001">', '#cf-chl-widget-fake001'],
      ['#challenge-stage 容器本身（只有其中的控件被识别）', '<div id="challenge-stage" tabindex="0"></div>', '#challenge-stage'],
      ['#challenge-stage 内被禁用的按钮（:not([disabled]) 排除）', '<div id="challenge-stage"><button id="t" disabled>提交</button></div>', '#t'],
      ['验证控件外的兄弟节点不连坐', '<div class="g-recaptcha" data-sitekey="k"></div><span id="t">说明文字</span>', '#t'],
    ])('不视为人机验证控件：%s', (_label, html, selector) => {
      expect(predicateResult(html, selector)).toBe(false);
    });
  });

  describe('已知边界与收窄取舍（characterization，记录现状）', () => {
    /**
     * 缺口：`Element.closest` 与 `matches` 都不跨越 shadow 边界。开放 shadow root
     * 内的可点元素（某些三方滑块封装）不会被 isChallengeSurfaceTarget 识别，点击
     * 会被录成步骤；且学习选择器多半只生成 shadow 内的 #id，回放时 document 作用域
     * 查不到，只会报「找不到可点击元素」—— 正是过滤器要消灭的失败形态。主流实现
     * （Turnstile 用 closed shadow、reCAPTCHA/hCaptcha 用跨域 iframe）不受影响。
     * 修复方向（按 composedPath 遍历每个元素做 matches，而不是只对解析结果做
     * closest）不在本次改动内，这里把现状固定成证据。
     */
    function shadowVerifyButton(): HTMLElement {
      const host = document.createElement('div');
      host.className = 'cf-turnstile';
      host.setAttribute('data-sitekey', 'fake-sitekey-000');
      const root = host.attachShadow({ mode: 'open' });
      const inner = document.createElement('button');
      inner.id = 'shadow-verify';
      inner.type = 'button';
      inner.textContent = 'Verify';
      root.appendChild(inner);
      document.body.appendChild(host);
      return inner;
    }

    it('shadow root 内部的可点元素不被判为验证控件（closest 不跨边界）', () => {
      expect(isChallengeSurfaceTarget(shadowVerifyButton())).toBe(false);
    });

    it('同一场景下点击会被录成步骤（现状；若日后修复，此断言应改为 0）', () => {
      const inner = shadowVerifyButton();
      const { events, capture } = startCapture();
      capture.attach();
      plainClick(inner);
      capture.flushPending();
      capture.detach();
      expect(events.filter((event) => event.type === 'click')).toHaveLength(1);
    });

    /**
     * 收窄取舍：`#challenge-stage button:not([disabled])` 是回放侧
     * TURNSTILE_WIDGET_SELECTORS 的既有选择器，学习侧同源引用。对 Cloudflare
     * 之外的页面，若恰好使用同名 id="challenge-stage"，其中未禁用按钮会被静默
     * 跳过 —— 条件命中的误伤（低概率），用本用例把边界固定下来。
     */
    it('同名 id="challenge-stage" 的非 Cloudflare 页面，其中按钮会被跳过', () => {
      const clicks = recordClickOn([
        '<div id="challenge-stage">',
        '  <button id="stage-next" type="button">下一关</button>',
        '</div>',
      ].join(''), '#stage-next');
      expect(clicks).toHaveLength(0);
    });
  });
});
