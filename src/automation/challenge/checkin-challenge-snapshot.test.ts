/**
 * 签到点击后的有界快照测试（回归：点击后无条件长等待安全验证）。
 *
 * 用户报告的原话：「签到已点击，开始等待本次签到触发的安全验证 —— 这个有的没有
 * 认证，就会一直等待，需要快照一下检查是否有认证」。
 *
 * 根因有两处，缺一不可：
 *   1) `engine.ts` 的 `afterCheckinClick` 无条件打印「正在等待安全验证」并进入
 *      长流程；
 *   2) `challenge.ts` 的通用 CAPTCHA 判据把「任意可见的 `[class*=captcha]` 元素」
 *      当成充分证据 —— 于是站点里一个说明性的 captcha 容器就能让
 *      `waitForChallenge` 进入最长 5 分钟的等待循环并弹出人工确认。
 *
 * 断言必须是客观的（假定时器 + 消耗的假时间 + 是否调用 onNeedsUser + 是否还有
 * 未落地的等待），不能写「看起来不会等太久」这种主观判断。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectChallenge, type ChallengeResolution, waitForChallenge } from '@/automation/challenge/challenge';
import { waitForCheckinChallenge } from '@/automation/challenge/checkin-challenge';
import { setActiveClickRunId } from '@/automation/shared/dom-utils';

const mockedClick = vi.hoisted(() => ({ realClick: vi.fn() }));

vi.mock('@/automation/shared/dom-utils', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/automation/shared/dom-utils')>(),
  realClick: mockedClick.realClick,
}));

/** 点击后快照窗口：与 engine 的 afterCheckinClick 一致。 */
const SNAPSHOT_WINDOW_MS = 2_500;
/** 现有交互式验证超时：5 分钟。守卫测试用它证明「没有验证时不消耗这个量级」。 */
const LONG_TIMEOUT_MS = 5 * 60_000;
/** 签到滑块控件就绪循环的上限：30 秒。 */
const CONTROL_READY_WAIT_MS = 30_000;
const BASE_TIME = new Date('2026-09-19T00:00:00+08:00');

/** jsdom 不做布局：可见性判据需要 getClientRects/getBoundingClientRect 有人回话。 */
function stubLayout(width = 100, height = 50): void {
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{} as DOMRect] as unknown as DOMRectList);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height,
  } as DOMRect);
}

/**
 * 记录 promise 的落点。
 *
 * 不能直接 `await promise`：长等待路径上的 promise 在假定时器里永远不会落地，
 * 测试会挂死而不是给出失败断言。
 */
function track(promise: Promise<ChallengeResolution>): { settled: () => ChallengeResolution | undefined } {
  let resolution: ChallengeResolution | undefined;
  void promise.then((value) => { resolution = value; });
  return { settled: () => resolution };
}

/**
 * 日志与人工介入钩子。
 *
 * 显式声明形参类型，而不是用 `ReturnType<typeof vi.fn>`：后者在 vitest 4 里是
 * `Mock<Procedure | Constructable>`，无法赋给 `StepLog.push(msg: string): void`，
 * 会让整个测试文件过不了 `tsc --noEmit`。
 */
interface ChallengeHooks {
  log: { push: (msg: string) => void };
  onNeedsUser: (message: string) => Promise<void>;
}

function hooks(): ChallengeHooks {
  return {
    log: { push: vi.fn() },
    onNeedsUser: vi.fn(async () => {}),
  };
}

let hitTarget: Element | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE_TIME);
  document.body.innerHTML = '';
  document.title = '';
  hitTarget = null;
  mockedClick.realClick.mockReset();
  // 模块级运行标识会跨测试残留：显式清空，让「没有活跃任务」这条路径确定可复现。
  setActiveClickRunId(null);
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: () => hitTarget,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = '';
  document.title = '';
  delete (document as Partial<Document>).elementFromPoint;
});

describe('通用 CAPTCHA 判据：命名不等于证据', () => {
  it('只有类名带 captcha、内部没有任何交互控件的干扰元素时不算验证', () => {
    stubLayout();
    document.body.innerHTML = `
      <main>
        <p>签到成功，本次获得 10 次调用额度</p>
        <div class="captcha-note-panel">本站说明：遇到人机校验时请手动完成。</div>
        <div id="captcha-placeholder"></div>
      </main>
    `;

    expect(detectChallenge()).toBeNull();
  });

  it('captcha 命名的容器里真的装着验证资源时仍算验证', () => {
    stubLayout();
    document.body.innerHTML = `
      <div class="captcha-box">
        <img class="captcha-image" src="https://example.test/api/captcha.png">
        <input name="code" type="text">
      </div>
    `;

    expect(detectChallenge()).toBe('CAPTCHA');
  });
});

describe('签到点击后的有界快照', () => {
  it('页面上没有任何验证时在窗口内放行，且不进入 5 分钟等待', async () => {
    stubLayout();
    document.body.innerHTML = `
      <main>
        <p>签到成功，本次获得 10 次调用额度</p>
        <button>查看详情</button>
      </main>
    `;
    const { log, onNeedsUser } = hooks();

    const startedAt = Date.now();
    const challenge = track(waitForCheckinChallenge(log, onNeedsUser, LONG_TIMEOUT_MS, SNAPSHOT_WINDOW_MS));
    await vi.advanceTimersByTimeAsync(SNAPSHOT_WINDOW_MS);
    await vi.advanceTimersByTimeAsync(0);

    expect(challenge.settled()).toEqual({ detected: false, resolved: true });
    // 客观度量：消耗的假时间为快照窗口，而不是统一超时或 30 秒开外。
    expect(Date.now() - startedAt).toBeLessThanOrEqual(SNAPSHOT_WINDOW_MS);
    expect(onNeedsUser).not.toHaveBeenCalled();
    // 没有验证就不该宣告「正在等待安全验证」。
    expect(log.push).toHaveBeenCalledWith('签到点击后未发现安全验证证据，继续核对本次签到结果');
  });

  it('只有「类名带 captcha、没有交互控件」的干扰元素时同样在窗口内放行', async () => {
    stubLayout();
    document.body.innerHTML = `
      <main>
        <p>签到成功</p>
        <div class="captcha-note-panel">本站说明：遇到人机校验时请手动完成。</div>
        <div id="captcha-placeholder"></div>
      </main>
    `;
    const { log, onNeedsUser } = hooks();

    const startedAt = Date.now();
    const challenge = track(waitForCheckinChallenge(log, onNeedsUser, LONG_TIMEOUT_MS, SNAPSHOT_WINDOW_MS));
    await vi.advanceTimersByTimeAsync(SNAPSHOT_WINDOW_MS);
    await vi.advanceTimersByTimeAsync(0);

    expect(challenge.settled()).toEqual({ detected: false, resolved: true });
    expect(Date.now() - startedAt).toBeLessThanOrEqual(SNAPSHOT_WINDOW_MS);

    // 再多推 30 秒：滑块控件就绪循环也不允许在这条路径上被打开。
    await vi.advanceTimersByTimeAsync(CONTROL_READY_WAIT_MS);
    expect(challenge.settled()).toEqual({ detected: false, resolved: true });
    // 误判的代价就是这个：整轮任务白等，还要用户手动确认一个不存在的验证码。
    expect(onNeedsUser).not.toHaveBeenCalled();
  });

  it('结果轮询用的即时快照（无窗口）不产生任何等待', async () => {
    document.body.innerHTML = '<main><p>今日已签到</p></main>';
    const { log, onNeedsUser } = hooks();

    await expect(waitForCheckinChallenge(log, onNeedsUser, LONG_TIMEOUT_MS))
      .resolves.toEqual({ detected: false, resolved: true });
    expect(vi.getTimerCount()).toBe(0);
    expect(onNeedsUser).not.toHaveBeenCalled();
  });

  it('真实滑块仍被判定为有验证并进入处理，不会被快照放行', async () => {
    stubLayout();
    document.body.innerHTML = `
      <div class="geetest_panel">
        <div class="geetest_widget">
          <div class="geetest_slider_button">按住左边拖动</div>
        </div>
      </div>
    `;
    const { log, onNeedsUser } = hooks();

    expect(detectChallenge()).toBe('Slider');
    await expect(waitForCheckinChallenge(log, onNeedsUser, LONG_TIMEOUT_MS, SNAPSHOT_WINDOW_MS))
      .resolves.toMatchObject({ detected: true, kind: 'Slider' });
    expect(log.push).toHaveBeenCalledWith('签到点击后检测到安全验证，开始等待本次签到触发的安全验证');
  });

  it('可见的腾讯验证码 iframe 同样进入验证处理', async () => {
    const frame = document.createElement('iframe');
    frame.id = 'tcaptcha_iframe_dy';
    document.body.append(frame);
    vi.spyOn(frame, 'getClientRects').mockReturnValue([{} as DOMRect] as unknown as DOMRectList);
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({
      x: 100, y: 100, left: 100, top: 100, right: 460, bottom: 340, width: 360, height: 240,
    } as DOMRect);
    hitTarget = frame;
    const { log, onNeedsUser } = hooks();

    expect(detectChallenge()).toBe('Slider');
    await expect(waitForCheckinChallenge(log, onNeedsUser, LONG_TIMEOUT_MS, SNAPSHOT_WINDOW_MS))
      .resolves.toMatchObject({ detected: true, kind: 'Slider' });
    expect(log.push).toHaveBeenCalledWith('签到点击后检测到安全验证，开始等待本次签到触发的安全验证');
  });

  it('Cloudflare 托管页 / Turnstile 仍然算有验证，快照不误放行', async () => {
    document.title = 'Just a moment...';
    document.body.innerHTML = `
      <div id="challenge-stage">
        <div class="turnstile-wrapper"></div>
        <input type="hidden" name="cf-turnstile-response" value="">
      </div>
      <button type="submit" disabled>登录</button>
    `;
    const stage = document.querySelector<HTMLElement>('#challenge-stage')!;
    const widget = document.querySelector<HTMLElement>('.turnstile-wrapper')!;
    for (const element of [stage, widget]) {
      vi.spyOn(element, 'getClientRects').mockReturnValue([{} as DOMRect] as unknown as DOMRectList);
      vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
        x: 100, y: 50, left: 100, top: 50, right: 482, bottom: 115, width: 382, height: 65,
      } as DOMRect);
    }
    const { log, onNeedsUser } = hooks();

    expect(detectChallenge()).toBe('Turnstile');
    const challenge = track(waitForCheckinChallenge(log, onNeedsUser, LONG_TIMEOUT_MS, SNAPSHOT_WINDOW_MS));
    await vi.advanceTimersByTimeAsync(SNAPSHOT_WINDOW_MS);

    // 不能立刻放行：托管/交互验证必须走既有的 Turnstile 点击流程。
    expect(challenge.settled()).toBeUndefined();
    expect(log.push).toHaveBeenCalledWith('签到点击后检测到安全验证，开始等待本次签到触发的安全验证');
    expect(onNeedsUser).not.toHaveBeenCalled();
  });
});

describe('等待时长与场景匹配', () => {
  it('没有验证的页面上，waitForChallenge 也只消耗出现窗口', async () => {
    document.body.innerHTML = '<main><p>签到成功</p><div class="captcha-note-panel">说明文案</div></main>';
    const { log, onNeedsUser } = hooks();

    const startedAt = Date.now();
    const challenge = track(waitForChallenge(log, onNeedsUser, LONG_TIMEOUT_MS, {
      includePendingResponse: false,
      appearanceWaitMs: SNAPSHOT_WINDOW_MS,
    }));
    await vi.advanceTimersByTimeAsync(SNAPSHOT_WINDOW_MS);
    await vi.advanceTimersByTimeAsync(0);

    expect(challenge.settled()).toEqual({ detected: false, resolved: true });
    expect(Date.now() - startedAt).toBeLessThanOrEqual(SNAPSHOT_WINDOW_MS);
    expect(onNeedsUser).not.toHaveBeenCalled();
  });
});
