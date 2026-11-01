/**
 * 无文案时的几何判读。
 *
 * 修的是实测日志里两次出现的「页面没有给出通过或刷新反馈」：站点只用图标、
 * 或改了文案，正则全部落空，判读退化成 unchanged，于是剩下几次尝试靠校准
 * 序列盲试。把手位置不依赖文案，回弹到起点就是被拒。
 *
 * 判读**只用回弹这一个信号**下 failed 结论：把手停在终点不能判成功，
 * 有的站点接受位置但仍在等服务端校验，提前判成功会跳过真正的验收。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/automation/shared/dom-utils', () => ({
  realClick: vi.fn(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}));

const domState = vi.hoisted(() => ({ current: [] as unknown[], last: undefined as unknown }));

vi.mock('@/automation/slider/slider-dom', () => ({
  findSliderDomMatch: () => null,
  isVisibleSliderElement: () => true,
  readSliderDomState: () => {
    if (domState.current.length) domState.last = domState.current.shift();
    // 场景最后一帧持续存在，不能下一次读取就无故清空文案和把手坐标。
    return domState.last ?? { visible: true, success: false, statusText: '' };
  },
}));

const { waitForSliderAttemptOutcome } = await import('@/automation/slider/slider-feedback');

beforeEach(() => {
  vi.useFakeTimers();
  domState.current = [];
  domState.last = undefined;
});

afterEach(() => vi.useRealTimers());

interface StateInput {
  statusText?: string;
  handleOffsetX?: number;
  handleRange?: number;
  challengeKey?: string;
  success?: boolean;
  visible?: boolean;
}

function state(input: StateInput) {
  return {
    visible: input.visible ?? true,
    success: input.success ?? false,
    statusText: input.statusText ?? '',
    ...(input.handleOffsetX != null ? { handleOffsetX: input.handleOffsetX } : {}),
    ...(input.handleRange != null ? { handleRange: input.handleRange } : {}),
    ...(input.challengeKey ? { challengeKey: input.challengeKey } : {}),
  };
}

function queue(...states: StateInput[]) {
  domState.current = states.map(state);
  domState.last = undefined;
}

async function waitForOutcome(before: ReturnType<typeof state>, timeoutMs = 1_200) {
  const pending = waitForSliderAttemptOutcome(before, timeoutMs);
  // 现有反馈逻辑要求负面信号持续 900ms；使用虚拟时间覆盖稳定窗口，不空转墙钟。
  await vi.advanceTimersByTimeAsync(timeoutMs);
  return pending;
}

describe('几何反馈：无文案时判读把手位置', () => {
  it('等待不足稳定窗口时，不把一次回弹立即判成失败', async () => {
    const before = state({ handleOffsetX: 0, handleRange: 270 });
    queue({ handleOffsetX: 2, handleRange: 270 });

    expect((await waitForOutcome(before, 400)).kind).toBe('unchanged');
  });

  it('短暂复位后出现成功信号，仍以页面确认成功为准', async () => {
    const before = state({ handleOffsetX: 0, handleRange: 270 });
    queue(
      { handleOffsetX: 0, handleRange: 270 },
      { handleOffsetX: 0, handleRange: 270 },
      { success: true, handleOffsetX: 0, handleRange: 270 },
    );

    expect((await waitForOutcome(before)).kind).toBe('success');
  });

  it('短暂失败提示已经消失时，不遗留上一帧的失败结论', async () => {
    const before = state({ handleOffsetX: 0, handleRange: 270 });
    queue(
      { statusText: '验证失败', handleOffsetX: 175, handleRange: 270 },
      { statusText: '', handleOffsetX: 175, handleRange: 270 },
    );

    expect((await waitForOutcome(before)).kind).toBe('unchanged');
  });

  it('把手回弹到起点 → failed', async () => {
    const before = state({ handleOffsetX: 0, handleRange: 270 });
    // 拖动已派发，但把手仍在起点附近（回弹）
    queue({ handleOffsetX: 2, handleRange: 270 });

    const outcome = await waitForOutcome(before);

    expect(outcome.kind).toBe('failed');
  });

  it('把手停在拖动终点 → 不下结论，继续等待（不能冒充成功）', async () => {
    const before = state({ handleOffsetX: 0, handleRange: 270 });
    // 把手确实移动到了目标位置，但页面没有任何文案
    queue(
      { handleOffsetX: 175, handleRange: 270 },
      { handleOffsetX: 175, handleRange: 270 },
      { handleOffsetX: 175, handleRange: 270 },
    );

    const outcome = await waitForOutcome(before);

    expect(outcome.kind).toBe('unchanged');
  });

  it('明确的失败文案优先于几何判据', async () => {
    const before = state({ statusText: '', handleOffsetX: 0, handleRange: 270 });
    // 把手停在终点（几何上不判失败），但文案明确说失败
    queue({ statusText: '验证失败，请重试', handleOffsetX: 175, handleRange: 270 });

    const outcome = await waitForOutcome(before);

    expect(outcome.kind).toBe('failed');
  });

  it('明确的方向反馈优先于几何判据', async () => {
    const before = state({ statusText: '', handleOffsetX: 0, handleRange: 270 });
    // 把手回弹（几何会判 failed），但文案说的是"距离过短"—— 应该微调重试
    queue({ statusText: '距离过短，请再滑远一点', handleOffsetX: 1, handleRange: 270 });

    const outcome = await waitForOutcome(before);

    expect(outcome.kind).toBe('too-short');
  });

  it('缺少 handleOffsetX 时几何判据不参与，保持原有行为', async () => {
    const before = state({ handleRange: 270 });
    queue(
      { handleRange: 270 },
      { handleRange: 270 },
      { handleRange: 270 },
    );

    const outcome = await waitForOutcome(before);

    expect(outcome.kind).toBe('unchanged');
  });

  it('轨道行程过短时不用几何判据（噪声大于信号）', async () => {
    const before = state({ handleOffsetX: 0, handleRange: 12 });
    queue(
      { handleOffsetX: 0, handleRange: 12 },
      { handleOffsetX: 0, handleRange: 12 },
      { handleOffsetX: 0, handleRange: 12 },
    );

    const outcome = await waitForOutcome(before);

    // 行程 12px < 20px 门槛，回弹信号不可信，不判 failed
    expect(outcome.kind).toBe('unchanged');
  });

  it('成功文案仍然正确识别', async () => {
    const before = state({ statusText: '', handleOffsetX: 0, handleRange: 270 });
    queue({ statusText: '验证成功', handleOffsetX: 175, handleRange: 270 });

    const outcome = await waitForOutcome(before);

    expect(outcome.kind).toBe('success');
  });

  it('挑战刷新仍然正确识别', async () => {
    const before = state({ challengeKey: 'old', handleOffsetX: 0, handleRange: 270 });
    queue({ challengeKey: 'new', handleOffsetX: 0, handleRange: 270 });

    const outcome = await waitForOutcome(before);

    expect(outcome.kind).toBe('refreshed');
  });
});
