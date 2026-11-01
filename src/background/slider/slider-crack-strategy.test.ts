import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SliderChallengeInfo } from '@/types/slider';

const mocks = vi.hoisted(() => ({
  openSession: vi.fn(),
  trustedDrag: vi.fn(),
  decode: vi.fn(),
  locateGap: vi.fn(),
  prepareImages: vi.fn(),
  measureProbe: vi.fn(),
  validateGeometry: vi.fn(),
  buildPlan: vi.fn(),
  buildTrack: vi.fn(),
  buildPoints: vi.fn(),
}));

vi.mock('@/background/slider/trusted-pointer', () => ({
  openTrustedDragSession: mocks.openSession,
  trustedPointerDrag: mocks.trustedDrag,
}));

vi.mock('@/background/slider/slider-image', () => ({
  decodePngBase64: mocks.decode,
  holeSilhouetteMatch: vi.fn(),
  locateSliderGap: mocks.locateGap,
  nccTemplateMatch: vi.fn(),
  pieceLooksTextured: vi.fn(() => true),
  prepareSliderImages: mocks.prepareImages,
}));

vi.mock('@/background/slider/slider-geometry', () => ({
  buildSliderDragPlan: mocks.buildPlan,
  validateSliderGeometry: mocks.validateGeometry,
}));

vi.mock('@/background/slider/slider-probe', () => ({
  measurePieceFromProbe: mocks.measureProbe,
}));

vi.mock('@/background/slider/slider-track', () => ({
  buildSliderDragPoints: mocks.buildPoints,
  buildSliderDragTrack: mocks.buildTrack,
}));

const { crackSliderChallenge } = await import('@/background/slider/slider-crack');

const info: SliderChallengeInfo = {
  panelRect: { x: 10, y: 10, width: 320, height: 240 },
  backgroundRect: { x: 20, y: 20, width: 280, height: 160 },
  pieceRect: { x: 30, y: 70, width: 40, height: 40 },
  trackRect: { x: 20, y: 200, width: 280, height: 36 },
  handleRect: { x: 20, y: 200, width: 36, height: 36 },
  viewportWidth: 1_280,
  viewportHeight: 720,
  devicePixelRatio: 1,
  challengeKey: 'challenge-1',
};

describe('滑块尝试路径', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateGeometry.mockReturnValue(null);
    mocks.decode.mockResolvedValue({
      width: 1_280,
      height: 720,
      data: new Uint8ClampedArray(1_280 * 720 * 4),
    });
  });

  it('奇数轮实测失败后不再用旧挑战执行第二次拖拽', async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    mocks.openSession.mockResolvedValue({
      current: { x: 38, y: 218 },
      screenshot: vi.fn().mockResolvedValue('png'),
      moveBy: vi.fn().mockResolvedValue(undefined),
      release,
    });
    mocks.measureProbe.mockReturnValue({ ok: false, reason: '页面动画干扰差分' });

    const result = await crackSliderChallenge(101, info, { attempt: 1 }, () => 0.5);

    expect(result).toMatchObject({ solved: false, errorCode: 'match-not-found' });
    expect(release).toHaveBeenCalledTimes(1);
    expect(mocks.prepareImages).not.toHaveBeenCalled();
    expect(mocks.trustedDrag).not.toHaveBeenCalled();
  });

  it('偶数轮直接使用静态图像路径，不先按下把手探测', async () => {
    mocks.prepareImages.mockResolvedValue({
      background: { width: 280, height: 160, data: new Uint8ClampedArray(280 * 160 * 4) },
      source: 'viewport-screenshot',
      imageScaleX: 1,
      imageScaleY: 1,
      cropOffsetX: 0,
      cropOffsetPieceX: 0,
    });
    mocks.locateGap.mockResolvedValue(null);

    const result = await crackSliderChallenge(102, info, { attempt: 2 }, () => 0.5);

    expect(result).toMatchObject({ solved: false, errorCode: 'match-not-found' });
    expect(mocks.prepareImages).toHaveBeenCalledTimes(1);
    expect(mocks.openSession).not.toHaveBeenCalled();
    expect(mocks.trustedDrag).not.toHaveBeenCalled();
  });

  it.each([1, 3, 5])('保留原图来源后，第 %i 轮沿用主页面静态路径，即使取图最终回退到截图', async (attempt) => {
    const withSources: SliderChallengeInfo = {
      ...info,
      backgroundSource: { kind: 'url', value: 'https://slider.example/background.png' },
      pieceSource: { kind: 'url', value: 'https://slider.example/piece.png' },
    };
    mocks.prepareImages.mockResolvedValue({
      background: { width: 280, height: 160, data: new Uint8ClampedArray(280 * 160 * 4) },
      source: 'viewport-screenshot',
      imageScaleX: 1,
      imageScaleY: 1,
      cropOffsetX: 0,
      cropOffsetPieceX: 0,
    });
    mocks.locateGap.mockResolvedValue(null);

    await crackSliderChallenge(103, withSources, { attempt }, () => 0.5);

    expect(mocks.prepareImages).toHaveBeenCalledExactlyOnceWith(103, withSources);
    expect(mocks.locateGap).toHaveBeenCalledTimes(1);
    expect(mocks.openSession).not.toHaveBeenCalled();
    expect(mocks.trustedDrag).not.toHaveBeenCalled();
  });

  it('只有背景和参考图时也保留首轮静态路径，不要求伪造拼图来源', async () => {
    const withReference: SliderChallengeInfo = {
      ...info,
      backgroundSource: { kind: 'url', value: 'https://slider.example/background.png' },
      referenceBackgroundSource: { kind: 'url', value: 'https://slider.example/original.png' },
    };
    mocks.prepareImages.mockResolvedValue({
      background: { width: 280, height: 160, data: new Uint8ClampedArray(280 * 160 * 4) },
      source: 'raw-image',
      imageScaleX: 1,
      imageScaleY: 1,
      cropOffsetX: 0,
      cropOffsetPieceX: 0,
    });
    mocks.locateGap.mockResolvedValue(null);

    await crackSliderChallenge(104, withReference, { attempt: 1 }, () => 0.5);

    expect(mocks.prepareImages).toHaveBeenCalledTimes(1);
    expect(mocks.openSession).not.toHaveBeenCalled();
  });

  it.each([2, 4])('保留原图来源后，第 %i 轮仍沿用已有探测分支，不修改交替算法', async (attempt) => {
    const release = vi.fn().mockResolvedValue(undefined);
    mocks.openSession.mockResolvedValue({
      current: { x: 38, y: 218 },
      screenshot: vi.fn().mockResolvedValue('png'),
      moveBy: vi.fn().mockResolvedValue(undefined),
      release,
    });
    mocks.measureProbe.mockReturnValue({ ok: false, reason: 'fixture: unmatched regions' });

    await crackSliderChallenge(105, {
      ...info,
      backgroundSource: { kind: 'url', value: 'https://slider.example/background.png' },
      pieceSource: { kind: 'url', value: 'https://slider.example/piece.png' },
    }, { attempt }, () => 0.5);

    expect(mocks.openSession).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(mocks.prepareImages).not.toHaveBeenCalled();
    expect(mocks.trustedDrag).not.toHaveBeenCalled();
  });
});
