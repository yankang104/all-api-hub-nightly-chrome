import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  detectCheckinManualChallenge,
  waitForCheckinChallenge,
} from '@/automation/challenge/checkin-challenge';
import { isChallengeElementVisible } from '@/automation/challenge/challenge-click';
import { setActiveClickRunId } from '@/automation/shared/dom-utils';

/** jsdom 不做布局：只给探针子树一个正几何，保持 display:none 判据可用。 */
function stubLayout(element: Element): void {
  const geometry = () => ({
    x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 50, width: 100, height: 50,
  } as DOMRect);
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function getClientRects(this: Element) {
    return element === this || this.contains(element) || element.contains(this)
      ? [geometry()] as unknown as DOMRectList
      : [] as unknown as DOMRectList;
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function getBoundingClientRect(this: Element) {
    return element === this || this.contains(element) || element.contains(this)
      ? geometry()
      : { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
  });
}

describe('签到阶段的验证输入控件识别与接续', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setActiveClickRunId(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    setActiveClickRunId(null);
    document.body.innerHTML = '';
  });

  it('可见的一次性验证码输入框保留当前调用，验证结束后自动接续', async () => {
    document.body.innerHTML = '<div id="layout-probe"><input autocomplete="one-time-code"></div>';
    stubLayout(document.querySelector('#layout-probe')!);
    expect(isChallengeElementVisible(document.querySelector('input')!)).toBe(true);
    expect(detectCheckinManualChallenge()).toBe(true);

    const log = { push: vi.fn() };
    const onNeedsUser = vi.fn(async () => {});
    const pending = waitForCheckinChallenge(log, onNeedsUser, 5_000);
    const settled = vi.fn();
    void pending.then(settled);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).not.toHaveBeenCalled();
    expect(onNeedsUser).not.toHaveBeenCalled();
    document.querySelector('input')!.remove();
    await vi.advanceTimersByTimeAsync(250);
    await expect(pending).resolves.toMatchObject({
      detected: true,
      resolved: true,
      kind: 'VerificationCode',
    });
    expect(onNeedsUser).not.toHaveBeenCalled();
  });

  it('隐藏旧输入框不会遮住后来挂载的同名可见输入框', () => {
    document.body.innerHTML = '<input name="otp" style="display:none"><input name="otp">';
    stubLayout(document.body);
    expect(detectCheckinManualChallenge()).toBe(true);
  });

  it.each(['otp', 'totp', 'mfa', '2fa'])('识别只有 id 的 %s 输入框', (id) => {
    document.body.innerHTML = `<input id="${id}">`;
    stubLayout(document.body);
    expect(detectCheckinManualChallenge()).toBe(true);
  });

  it('祖先隐藏的一次性验证码和二次验证输入框不算当前验证', () => {
    document.body.innerHTML = '<div style="display:none"><input autocomplete="one-time-code"><input id="mfa"><input name="otp"></div>';
    stubLayout(document.body);
    expect(detectCheckinManualChallenge()).toBe(false);
  });

  it('快照期间才出现的验证输入框不会漏放，结束后仍在同一调用返回', async () => {
    document.body.innerHTML = '<main></main>';
    stubLayout(document.body);
    const onNeedsUser = vi.fn(async () => {});
    const pending = waitForCheckinChallenge({ push: vi.fn() }, onNeedsUser, 5_000, 2_500);
    const settled = vi.fn();
    void pending.then(settled);
    setTimeout(() => { document.body.innerHTML = '<input id="otp">'; }, 500);
    await vi.advanceTimersByTimeAsync(3_500);
    expect(settled).not.toHaveBeenCalled();
    expect(onNeedsUser).not.toHaveBeenCalled();
    document.querySelector('input')!.remove();
    await vi.advanceTimersByTimeAsync(250);
    await expect(pending).resolves.toMatchObject({ detected: true, resolved: true });
    expect(onNeedsUser).not.toHaveBeenCalled();
  });

  it('验证输入框等待有界，超时保留未解决结果且不转人工', async () => {
    document.body.innerHTML = '<input id="mfa">';
    stubLayout(document.body);
    const onNeedsUser = vi.fn(async () => {});
    const pending = waitForCheckinChallenge({ push: vi.fn() }, onNeedsUser, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toMatchObject({ detected: true, resolved: false, kind: 'VerificationCode' });
    expect(onNeedsUser).not.toHaveBeenCalled();
  });

  it('验证输入框等待期间停止任务立即退出，不转人工也不继续操作', async () => {
    document.body.innerHTML = '<input id="otp">';
    stubLayout(document.body);
    setActiveClickRunId('first');
    const onNeedsUser = vi.fn(async () => {});
    const pending = waitForCheckinChallenge({ push: vi.fn() }, onNeedsUser, 5_000);
    await vi.advanceTimersByTimeAsync(250);
    setActiveClickRunId('second');
    await vi.advanceTimersByTimeAsync(250);
    await expect(pending).resolves.toMatchObject({ detected: true, resolved: false, error: '签到任务已停止' });
    expect(onNeedsUser).not.toHaveBeenCalled();
  });

  it('普通文本输入框不判为人工验证', () => {
    document.body.innerHTML = '<div id="layout-probe"><label>搜索关键词<input type="text" name="code" inputmode="numeric"></label></div>';
    stubLayout(document.querySelector('#layout-probe')!);
    expect(isChallengeElementVisible(document.querySelector('input')!)).toBe(true);
    expect(detectCheckinManualChallenge()).toBe(false);
  });

  it('隐藏的验证码输入框不判为人工验证', () => {
    document.body.innerHTML = [
      '<input autocomplete="one-time-code" style="display:none">',
      '<div style="display:none">',
      '<label>短信验证码<input name="code" inputmode="numeric"></label>',
      '<button>发送验证码</button>',
      '</div>',
    ].join('');
    stubLayout(document.body);
    expect(isChallengeElementVisible(document.querySelector('input')!)).toBe(false);
    expect(detectCheckinManualChallenge()).toBe(false);
  });
});
