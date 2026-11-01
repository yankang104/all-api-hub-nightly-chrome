import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForChallenge } from '@/automation/challenge/challenge';
import { waitForCheckinChallenge } from '@/automation/challenge/checkin-challenge';
import { setActiveClickRunId } from '@/automation/shared/dom-utils';

vi.mock('@/automation/challenge/challenge', () => ({
  hasObjectiveChallengeEvidence: vi.fn().mockReturnValue(true),
  waitForChallenge: vi.fn(),
}));

const pendingSlider = {
  detected: true, resolved: false, kind: 'Slider', sliderAttemptStarted: false,
  error: '当前验证码文档未找到可接收拖动的滑块把手（可能仍在加载或被遮挡）',
};

beforeEach(() => {
  vi.useFakeTimers();
  setActiveClickRunId('readiness-run');
  vi.mocked(waitForChallenge).mockReset().mockResolvedValue(pendingSlider);
});

afterEach(() => {
  vi.useRealTimers();
  setActiveClickRunId(null);
});

describe('签到滑块控件就绪恢复', () => {
  it('控件后挂载时保留本次调用重新采集，求解完成后接续且不转人工', async () => {
    vi.mocked(waitForChallenge).mockResolvedValueOnce(pendingSlider)
      .mockResolvedValueOnce({ detected: true, resolved: true, kind: 'Slider' });
    const log = { push: vi.fn() };
    const onNeedsUser = vi.fn(async () => {});
    const pending = waitForCheckinChallenge(log, onNeedsUser, 5_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(waitForChallenge).toHaveBeenCalledOnce();
    expect(log.push).toHaveBeenCalledWith(expect.stringContaining('给控件约 30 秒加载时间'));
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toMatchObject({ detected: true, resolved: true, kind: 'Slider' });
    expect(waitForChallenge).toHaveBeenCalledTimes(2);
    expect(waitForChallenge).toHaveBeenLastCalledWith(expect.any(Object), onNeedsUser, 5_000,
      { includePendingResponse: false, appearanceWaitMs: 0 });
    expect(onNeedsUser).not.toHaveBeenCalled();
  });

  it('已经开始拖动的失败不得重新开启求解尝试', async () => {
    vi.mocked(waitForChallenge).mockResolvedValue({ ...pendingSlider, sliderAttemptStarted: true });
    const onNeedsUser = vi.fn(async () => {});
    await expect(waitForCheckinChallenge({ push: vi.fn() }, onNeedsUser, 5_000))
      .resolves.toMatchObject({ resolved: false, sliderAttemptStarted: true });
    expect(waitForChallenge).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(onNeedsUser).not.toHaveBeenCalled();
  });

  it('明确的取图或求解失败不作为控件加载中反复重试', async () => {
    vi.mocked(waitForChallenge).mockResolvedValue({ ...pendingSlider, error: '验证码图片获取失败' });
    const onNeedsUser = vi.fn(async () => {});
    await expect(waitForCheckinChallenge({ push: vi.fn() }, onNeedsUser, 5_000))
      .resolves.toMatchObject({ resolved: false, error: '验证码图片获取失败' });
    expect(waitForChallenge).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(onNeedsUser).not.toHaveBeenCalled();
  });

  it('控件持续未就绪时 30 秒结束，保留失败原因且不转人工', async () => {
    const onNeedsUser = vi.fn(async () => {});
    const startedAt = Date.now();
    const pending = waitForCheckinChallenge({ push: vi.fn() }, onNeedsUser, 120_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pending).resolves.toMatchObject({
      detected: true, resolved: false, sliderAttemptStarted: false,
      error: expect.stringContaining('就绪等待期结束'),
    });
    expect(Date.now() - startedAt).toBe(30_000);
    expect(waitForChallenge).toHaveBeenCalledTimes(30);
    expect(onNeedsUser).not.toHaveBeenCalled();
  });

  it('等待控件时停止任务，不再采集或拖动', async () => {
    const onNeedsUser = vi.fn(async () => {});
    const pending = waitForCheckinChallenge({ push: vi.fn() }, onNeedsUser, 120_000);
    await vi.advanceTimersByTimeAsync(0);
    setActiveClickRunId('another-run');
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toMatchObject({ resolved: false, error: '签到任务已停止' });
    expect(waitForChallenge).toHaveBeenCalledOnce();
    expect(onNeedsUser).not.toHaveBeenCalled();
  });
});
