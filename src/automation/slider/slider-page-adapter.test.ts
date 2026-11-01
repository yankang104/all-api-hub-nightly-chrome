import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SliderChallengeInfo } from '@/types/slider';
import { waitForChallenge } from '@/automation/challenge/challenge';
import { waitForCheckinChallenge } from '@/automation/challenge/checkin-challenge';
import { setActiveClickRunId } from '@/automation/shared/dom-utils';
import { collectSliderChallenge, readSliderDomState } from '@/automation/slider/slider-dom';
import { requestSliderRefresh } from '@/automation/slider/slider-feedback';
import { trySolveSliderInCurrentFrame, trySolveTencentSliderInPage } from '@/automation/slider/slider-solve';

const mocks = vi.hoisted(() => ({ sendMessage: vi.fn(), realClick: vi.fn() }));

vi.mock('@/lib/core/messaging', () => ({ sendMessage: mocks.sendMessage }));
vi.mock('@/automation/shared/dom-utils', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/automation/shared/dom-utils')>(),
  realClick: mocks.realClick,
}));

const BACKGROUND = { kind: 'url', value: 'https://slider.example/background.png' } as const;
const REFERENCE = { kind: 'url', value: 'https://slider.example/original.png' } as const;
const PIECE = { kind: 'url', value: 'https://slider.example/piece.png' } as const;
const originalElementFromPoint = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
let hitTargets: Element[] = [];

function geometry(element: Element, x: number, y: number, width: number, height: number): void {
  const rect = { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height };
  Object.defineProperties(element, {
    getBoundingClientRect: { configurable: true, value: () => rect },
    getClientRects: { configurable: true, value: () => [rect] },
    scrollIntoView: { configurable: true, value: () => {} },
  });
  hitTargets.push(element);
}

function image(className: string, source: string, width: number, height: number): HTMLImageElement {
  const element = document.createElement('img');
  element.className = className;
  element.src = source;
  Object.defineProperties(element, {
    complete: { configurable: true, value: true },
    naturalWidth: { configurable: true, value: width },
    naturalHeight: { configurable: true, value: height },
  });
  return element;
}

/** 合成布局，不冒充真实站点快照；外层比实际背景高，用于区分两套选图规则。 */
function buildSlider(options: { generic?: boolean; genericHandle?: boolean } = {}) {
  const panel = document.createElement('div');
  panel.className = 'captcha-panel';
  const prompt = document.createElement('p');
  prompt.textContent = '拖动下方滑块完成拼图';
  const wrapper = document.createElement('div');
  wrapper.className = options.generic ? 'captcha-image-region' : 'tencent-captcha-dy__verify-bg';
  const background = image('captcha-background', BACKGROUND.value, 330, 191.5);
  const reference = image('captcha-background-full', REFERENCE.value, 330, 191.5);
  reference.hidden = true;
  const piece = image(options.generic ? 'captcha-piece' : 'tencent-captcha-dy__fg-item', PIECE.value, 58.9, 58.9);
  const track = document.createElement('div');
  track.className = options.generic ? 'slider-track' : 'tencent-captcha-dy__slider-groove';
  const handle = document.createElement('div');
  handle.className = options.generic ? 'slider-btn' : 'tencent-captcha-dy__slider-block';
  if (options.generic || options.genericHandle) handle.setAttribute('role', 'slider');
  const refresh = document.createElement('div');
  refresh.className = 'tencent-captcha-dy__footer-icon--refresh';
  wrapper.append(background, reference, piece);
  track.append(handle);
  panel.append(prompt, wrapper, track);
  // 腾讯工具栏可以是面板的兄弟节点；仍沿用已有腾讯刷新按钮定位。
  document.body.append(panel, refresh);
  geometry(panel, 80, 50, 370, 370);
  geometry(prompt, 100, 65, 330, 25);
  geometry(wrapper, 100, 100, 330, 235.7);
  geometry(background, 100, 100, 330, 191.5);
  geometry(reference, 100, 100, 330, 191.5);
  geometry(piece, 124, 160, 58.9, 58.9);
  geometry(track, 100, 350, 330, 60);
  geometry(handle, 100, 350, 60, 60);
  geometry(refresh, 400, 425, 24, 24);
  return { panel, background, reference, piece, wrapper, track, handle, refresh };
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
  document.title = '';
  hitTargets = [];
  setActiveClickRunId('slider-adapter-run');
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: (x: number, y: number) => hitTargets.findLast((element) => {
      if (!element.isConnected || element.closest('[hidden]')) return false;
      const rect = element.getBoundingClientRect();
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    }) ?? null,
  });
  // 仅模拟后台已发送拖动及页面确认；不把此用例当作图像识别成功率测试。
  mocks.sendMessage.mockImplementation(async (message: { type: string; slider: SliderChallengeInfo }) => {
    expect(message.type).toBe('SLIDER_CRACK');
    const handle = document.querySelector(`[data-aah-pointer-target="${message.slider.handleToken}"]`);
    expect(handle).not.toBeNull();
    handle!.setAttribute('data-state', 'verified');
    return { ok: true, feature: { slider: { solved: true, method: 'fixture:accepted', distance: 95 } } };
  });
});

afterEach(() => {
  setActiveClickRunId(null);
  document.body.innerHTML = '';
  if (originalElementFromPoint) Object.defineProperty(document, 'elementFromPoint', originalElementFromPoint);
  else Reflect.deleteProperty(document, 'elementFromPoint');
});

describe('腾讯页面控件与 iframe 取图策略隔离', () => {
  it('腾讯页面和通用页面采集相同的背景、原图、参考图与拼图输入', async () => {
    const scene = buildSlider({ genericHandle: true });
    const page = await collectSliderChallenge({ mountTimeoutMs: 0 });
    const tencentPage = await collectSliderChallenge({ mode: 'tencent-page', mountTimeoutMs: 0 });

    expect(page).not.toBeNull();
    expect(tencentPage).not.toBeNull();
    expect(tencentPage!.match.background).toBe(scene.background);
    expect(tencentPage!.info).toMatchObject({
      backgroundRect: page!.info.backgroundRect,
      pieceRect: page!.info.pieceRect,
      backgroundSource: BACKGROUND,
      referenceBackgroundSource: REFERENCE,
      pieceSource: PIECE,
    });
    expect(tencentPage!.info.backgroundRect.height).toBe(191.5);
    tencentPage!.releaseHandleMarker();
    page!.releaseHandleMarker();
  });

  it('没有通用 role/把手类名时仍能定位腾讯把手、轨道和唯一拼图', async () => {
    const scene = buildSlider();
    const collected = await collectSliderChallenge({ mode: 'tencent-page', mountTimeoutMs: 0 });

    expect(collected).not.toBeNull();
    expect(collected!.match.handle).toBe(scene.handle);
    expect(collected!.match.track).toBe(scene.track);
    expect(collected!.match.piece).toBe(scene.piece);
    expect(collected!.info.pieceSource).toEqual(PIECE);
    collected!.releaseHandleMarker();
  });

  it('真正 iframe 保留原有容器加权和仅截图输入，不受页面入口调整影响', async () => {
    const scene = buildSlider();
    const collected = await collectSliderChallenge({ mode: 'tencent-frame', mountTimeoutMs: 0 });

    expect(collected).not.toBeNull();
    expect(collected!.match.background).toBe(scene.wrapper);
    expect(collected!.info.backgroundRect.height).toBe(235.7);
    expect(collected!.info.backgroundSource).toBeUndefined();
    expect(collected!.info.referenceBackgroundSource).toBeUndefined();
    expect(collected!.info.pieceSource).toBeUndefined();
    collected!.releaseHandleMarker();
  });

  it('腾讯页面入口实际发给后台的图片源不再被 iframe 策略清空', async () => {
    buildSlider();
    const result = await trySolveTencentSliderInPage({ push: vi.fn() });

    expect(result.solved).toBe(true);
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage.mock.calls[0]![0]).toMatchObject({
      runId: 'slider-adapter-run',
      slider: { backgroundSource: BACKGROUND, referenceBackgroundSource: REFERENCE, pieceSource: PIECE },
      options: { attempt: 1, correctionPx: 0 },
    });
    expect(mocks.sendMessage.mock.calls[0]![0]).not.toHaveProperty('frameSessionId');
  });

  it('iframe 入口仍发送真实会话并保持仅截图输入', async () => {
    buildSlider();
    setActiveClickRunId('slider-adapter-run', 'trusted', 'frame-session');
    const result = await trySolveSliderInCurrentFrame({ push: vi.fn() }, 'frame-session', Date.now() + 10_000);

    expect(result.solved).toBe(true);
    const request = mocks.sendMessage.mock.calls[0]![0];
    expect(request.frameSessionId).toBe('frame-session');
    expect(request.slider.backgroundSource).toBeUndefined();
    expect(request.slider.pieceSource).toBeUndefined();
  });

  it('登录通过后，签到的新挑战仍独立调用一次，并保留同样的页面图片输入', async () => {
    const log = { push: vi.fn() };
    const onNeedsUser = vi.fn();
    const login = buildSlider({ generic: true });
    await expect(waitForChallenge(log, onNeedsUser, 2_000)).resolves.toMatchObject({
      detected: true, resolved: true, kind: 'Slider',
    });
    login.panel.hidden = true;
    login.refresh.hidden = true;
    const oldSuccess = document.createElement('div');
    oldSuccess.className = 'geetest_success';
    document.body.append(oldSuccess);
    geometry(oldSuccess, 20, 20, 20, 20);
    buildSlider();

    await expect(waitForCheckinChallenge(log, onNeedsUser, 2_000)).resolves.toMatchObject({
      detected: true, resolved: true, kind: 'Slider',
    });
    expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
    const requests = mocks.sendMessage.mock.calls.map(([request]) => request);
    for (const request of requests) {
      expect(request.slider).toMatchObject({ backgroundSource: BACKGROUND, pieceSource: PIECE });
      expect(request.options).toEqual({ attempt: 1, correctionPx: 0 });
      expect(request.frameSessionId).toBeUndefined();
    }
    expect(requests[0].slider.handleToken).not.toBe(requests[1].slider.handleToken);
    expect(log.push.mock.calls.filter(([message]) => message.startsWith('滑块第 1/5 次'))).toHaveLength(2);
    expect(onNeedsUser).not.toHaveBeenCalled();
  });

  it('旧登录成功标记不能放行当前仍可见的腾讯签到挑战', () => {
    const oldSuccess = document.createElement('div');
    oldSuccess.className = 'geetest_success';
    document.body.append(oldSuccess);
    geometry(oldSuccess, 20, 20, 20, 20);
    const scene = buildSlider();

    expect(readSliderDomState(undefined, 'tencent-page').success).toBe(false);
    scene.track.classList.add('tencent-captcha-dy__slider-groove--success');
    expect(readSliderDomState(undefined, 'tencent-page').success).toBe(true);
  });

  it('页面内腾讯组件仍能使用自身的刷新按钮', async () => {
    const scene = buildSlider();
    await expect(requestSliderRefresh('tencent-page')).resolves.toBe(true);
    expect(mocks.realClick).toHaveBeenCalledExactlyOnceWith(scene.refresh);
  });

  it('多个腾讯前景物体时仍不把任意一块当作拼图', async () => {
    const scene = buildSlider();
    const other = image('tencent-captcha-dy__fg-item', PIECE.value, 58.9, 58.9);
    scene.wrapper.append(other);
    geometry(other, 240, 160, 58.9, 58.9);
    const collected = await collectSliderChallenge({ mode: 'tencent-page', mountTimeoutMs: 0 });

    expect(collected).not.toBeNull();
    expect(collected!.info.pieceRect).toBeUndefined();
    expect(collected!.info.pieceSource).toBeUndefined();
    collected!.releaseHandleMarker();
  });

  it('腾讯把手被遮挡时仍拒绝采集，不绕过可点击性检查', async () => {
    buildSlider();
    const overlay = document.createElement('div');
    document.body.append(overlay);
    geometry(overlay, 0, 0, 800, 600);
    await expect(collectSliderChallenge({ mode: 'tencent-page', mountTimeoutMs: 0 })).resolves.toBeNull();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });
});
