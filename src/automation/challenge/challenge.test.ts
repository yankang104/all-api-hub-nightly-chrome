/**
 * challenge.ts 的检测与完成判定测试。
 *
 * 只测真正 import 进来的导出函数。点击时序（过早点击会永久污染 Turnstile
 * widget）无法在 jsdom 里复现，由 tests/probe-click-timing.mjs 在真站点上验证，
 * 结论记在 memory 的 turnstile-click-timing。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { detectChallenge, waitForChallenge } from '@/automation/challenge/challenge';

beforeEach(() => {
  document.body.innerHTML = '';
  document.title = '';
});

describe('detectChallenge', () => {
  it('干净页面上不报告验证', () => {
    document.body.innerHTML = '<form><input name="email"><button>登录</button></form>';
    expect(detectChallenge()).toBeNull();
  });

  it('识别出 Turnstile —— 即使容器里没有任何 iframe', () => {
    // 真站点实测（K40）：challenge iframe 在 closed shadow root 里，light DOM 看不到，
    // 所以检测不能依赖 iframe 存在。此时可用的顶层信号是「空的响应字段 + 被禁用的
    // 提交按钮」，这也是 hasPendingResponseField 走的那条路径。
    document.body.innerHTML = `
      <div class="turnstile-wrapper">
        <div class="turnstile-container">
          <div><input type="hidden" name="cf-turnstile-response" id="cf-chl-widget-x_response" value=""></div>
        </div>
      </div>
      <button type="submit" disabled>登录</button>
    `;
    expect(detectChallenge()).toBe('Turnstile');
  });

  it('令牌已就位时不再报告验证', () => {
    document.body.innerHTML = `
      <div class="turnstile-wrapper">
        <input type="hidden" name="cf-turnstile-response" value="1.abcdef">
      </div>
    `;
    expect(detectChallenge()).toBeNull();
  });

  it('aria-checked 为真时视为已完成', () => {
    document.body.innerHTML = `
      <div class="cf-turnstile" aria-checked="true">
        <input type="hidden" name="cf-turnstile-response" value="">
      </div>
    `;
    expect(detectChallenge()).toBeNull();
  });

  it('识别 reCAPTCHA 与 hCaptcha', () => {
    // 同 Turnstile 那条：jsdom 不做布局，元素拿不到尺寸，可见性判定必然为假，
    // 所以走「空响应字段 + 被禁用的提交按钮」这条顶层信号路径。
    document.body.innerHTML = `
      <div class="g-recaptcha" data-sitekey="k">
        <textarea name="g-recaptcha-response"></textarea>
      </div>
      <button type="submit" disabled>登录</button>
    `;
    expect(detectChallenge()).toBe('reCAPTCHA');

    document.body.innerHTML = `
      <div class="h-captcha" data-sitekey="k">
        <textarea name="h-captcha-response"></textarea>
      </div>
      <button type="submit" disabled>登录</button>
    `;
    expect(detectChallenge()).toBe('hCaptcha');
  });

  /**
   * 标题兜底必须要有客观证据，否则会造成「干等 120 秒然后报安全验证超时」。
   *
   * 曾经只要标题含「安全验证」「captcha」这类词就报 CAPTCHA，而
   * waitForChallenge 进入等待循环后判据永不改变（标题不会自己变），只能等到超时。
   * 标题里含这些词的正常页面很多，代价完全不对等。
   */
  describe('标题兜底判据', () => {
    it('只有标题像验证页、页面上没有任何证据时不报验证', () => {
      document.title = '安全验证 - 帮助中心';
      document.body.innerHTML = '<main><h1>如何开启两步验证</h1><p>进入设置页即可。</p></main>';
      expect(detectChallenge()).toBeNull();
    });

    it('标题含 captcha 但无证据同样不报', () => {
      document.title = 'CAPTCHA 说明文档';
      document.body.innerHTML = '<article>本文介绍 CAPTCHA 的原理。</article>';
      expect(detectChallenge()).toBeNull();
    });

    it('标题 + Cloudflare 挑战平台指纹 → 报验证', () => {
      document.title = '安全验证';
      document.body.innerHTML = '<div id="cf-wrapper"></div>';
      expect(detectChallenge()).toBe('CAPTCHA');
    });

    it('标题 + 明确的交互提示 → 报验证', () => {
      document.title = '人机验证';
      document.body.innerHTML = '<div><p>请点击下方方框以继续</p></div>';
      // jsdom 不实现 innerText（返回 undefined），而被测代码读的正是它 ——
      // 不补这个属性，这条判据在测试里永远走不到，等于没测。
      Object.defineProperty(document.body, 'innerText', {
        value: '请点击下方方框以继续',
        configurable: true,
      });
      expect(detectChallenge()).toBe('CAPTCHA');
    });

    it('干净页面即使有 Cloudflare 指纹也不报（标题不像验证页）', () => {
      // 站点整体挂在 Cloudflare 后面是常态，指纹单独存在不代表正在验证
      document.title = '控制台';
      document.body.innerHTML = '<div id="cf-wrapper"><main>正常页面</main></div>';
      expect(detectChallenge()).toBeNull();
    });
  });

  it('data-state=verified 时视为已完成', () => {
    document.body.innerHTML = `
      <div class="g-recaptcha" data-sitekey="k" data-state="verified">
        <textarea name="g-recaptcha-response"></textarea>
      </div>
    `;
    expect(detectChallenge()).toBeNull();
  });
});

describe('AgentRouter WAF 滑动验证', () => {
  beforeEach(() => {
    vi.stubGlobal('location', new URL('https://agentrouter.org/register'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('在 agentrouter.org 上识别三个 WAF 标记同时存在的整页验证', () => {
    document.body.innerHTML = `
      <script>
        window.CF_APP_WAF = {};
        window.AC_Opt = {};
        const sceneId = 'waf-slide';
      </script>
      <main>slide to complete the verification process</main>
    `;
    expect(detectChallenge()).toBe('Slider');
  });

  /**
   * 无活跃任务时不能报「没有验证」。
   *
   * 这里曾断言 `{ detected: false, resolved: true }` —— 那句话的含义是
   * 「这一页没有人机验证，照常继续」。调用方（engine 的 resolveChallenge）
   * 会据此放行后续步骤，于是一个被 WAF 拦住的页面被判成「未找到登录成功证据」，
   * 真正的原因（有滑块、但没有任务上下文可用来拖）在日志里完全看不到。
   *
   * 准确的回答是「检测到了、没解决」：detected 为真让调用方知道页面确实被拦，
   * resolved 为假让它停下来交人工，而不是继续往下跑然后归因错误。
   */
  it('识别到 WAF 滑块后尝试自动破解，无活跃任务时如实报告未解决', async () => {
    document.body.innerHTML = `
      <script>
        window.CF_APP_WAF = {};
        window.AC_Opt = {};
        const sceneId = 'waf-slide';
      </script>
    `;
    const log = { push: vi.fn() };
    const onNeedsUser = vi.fn(async () => {});

    await expect(waitForChallenge(log, onNeedsUser)).resolves.toEqual({
      detected: true,
      resolved: false,
      kind: 'Slider',
      error: '没有活跃签到任务',
      sliderAttemptStarted: false,
    });
    // 日志要说清为什么没解决，否则用户只看到「验证未完成」
    expect(log.push).toHaveBeenCalledWith(expect.stringContaining('没有活跃签到任务'));
  });

  it('缺少任一固定标记时不误报', () => {
    document.body.innerHTML = `
      <script>
        window.CF_APP_WAF = {};
        const sceneId = 'ordinary-page';
      </script>
    `;
    expect(detectChallenge()).toBeNull();
  });

  it('相同标记出现在非 AgentRouter 域名时不误报', () => {
    vi.stubGlobal('location', new URL('https://example.test/register'));
    document.body.innerHTML = `
      <script>
        window.CF_APP_WAF = {};
        window.AC_Opt = {};
        const sceneId = 'unrelated';
      </script>
    `;
    expect(detectChallenge()).toBeNull();
  });

  it('支持 ps.air-outer.com 这个 AgentRouter 别名', () => {
    vi.stubGlobal('location', new URL('https://ps.air-outer.com/login'));
    document.body.innerHTML = `
      <script>
        window.CF_APP_WAF = {};
        window.AC_Opt = {};
        const sceneId = 'waf-slide';
      </script>
    `;
    expect(detectChallenge()).toBe('Slider');
  });
});

/**
 * 滑块验证码（Slider）。
 *
 * jsdom 不做布局：isActuallyVisible 需要 getClientRects 非空且
 * getBoundingClientRect 宽高 > 0，所以这组测试先 stub 这两个方法，
 * 让极验/通用滑块元素能通过可见性判定（真实浏览器里天然成立）。
 */
describe('滑块验证码（Slider）', () => {
  const stubLayout = () => {
    vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([
      {} as DOMRect,
    ] as unknown as DOMRectList);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 100,
      height: 50,
      top: 0,
      left: 0,
    } as DOMRect);
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('识别 Geetest 极验滑块', () => {
    stubLayout();
    document.body.innerHTML = `
      <div class="geetest_panel">
        <div class="geetest_widget">
          <div class="geetest_slider_button">按住左边拖动</div>
        </div>
      </div>
    `;
    expect(detectChallenge()).toBe('Slider');
  });

  it('识别通用滑块容器（slide-verify）', () => {
    stubLayout();
    document.body.innerHTML = `
      <div class="slide-verify">
        <div class="slide-verify-slider-mask-item"></div>
      </div>
    `;
    expect(detectChallenge()).toBe('Slider');
  });

  it('滑块容器消失后不再报告验证', () => {
    stubLayout();
    document.body.innerHTML = '<div class="geetest_panel"></div>';
    expect(detectChallenge()).toBe('Slider');

    // 用户拖完后面板关闭/移除 → 完成
    document.body.innerHTML = '';
    expect(detectChallenge()).toBeNull();
  });

  it('出现成功标记后不再报告验证', () => {
    stubLayout();
    document.body.innerHTML = `
      <div class="geetest_panel">
        <div class="geetest_success"></div>
      </div>
    `;
    expect(detectChallenge()).toBeNull();
  });

  it('通用 data-state=verified 的滑块容器视为已完成', () => {
    stubLayout();
    document.body.innerHTML = `
      <div class="slide-verify" data-state="verified"></div>
    `;
    expect(detectChallenge()).toBeNull();
  });

  it('轮播图等普通 slider 不误报', () => {
    stubLayout();
    document.body.innerHTML = `
      <div class="slider">
        <div class="slide">第 1 张</div>
        <div class="slide">第 2 张</div>
      </div>
      <div class="carousel"></div>
    `;
    expect(detectChallenge()).toBeNull();
  });
});
