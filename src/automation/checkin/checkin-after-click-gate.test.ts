/**
 * 点签到后才挂载的人机验证。
 *
 * 禾维 AI 是这种形态：登录提交后一道滑块，点「每日签到」之后**还有一道**。
 *
 * 钩子（`afterCheckinClick`）早就在 engine 里定义并注入了，但 `checkin.ts` 的
 * auto / button 两条路径都没调用它 —— 只有 workflow 通过 `afterAction` 接上。
 * 漏接的后果不是"验证过不去"，而是**报错报在错的地方**：等终态的循环只看到
 * 一个挡在前面的验证框，等满超时再报「未检测到明确结果」，而真正的原因
 * （有验证要做）在日志里完全看不到，用户会去核对根本没问题的按钮选择器。
 */

import { describe, expect, it, vi } from 'vitest';
import type { SiteConfig } from '@/types';

vi.mock('@/automation/shared/dom-utils', () => ({
  describeElement: (el: Element) => el.tagName.toLowerCase(),
  domClick: vi.fn(),
  queryFirst: (selector: string) => document.querySelector(selector),
  realClick: vi.fn().mockResolvedValue(undefined),
  setNativeValue: vi.fn(),
  sleep: vi.fn().mockResolvedValue(undefined),
  waitFor: vi.fn().mockResolvedValue(null),
  elementBlocking: vi.fn().mockReturnValue(null),
  isVisible: vi.fn().mockReturnValue(true),
  pressEnter: vi.fn(),
}));

vi.mock('@/automation/balance/balance', () => ({
  captureBalance: vi.fn().mockResolvedValue(null),
  describeMetrics: vi.fn().mockReturnValue(''),
  diffBalance: vi.fn().mockReturnValue({ verdict: 'unknown' }),
  readNewVisibleCheckinReward: vi.fn().mockReturnValue(null),
  readNewVisibleCheckinRewardObservation: vi.fn().mockReturnValue(null),
  readVisibleCheckinReward: vi.fn().mockReturnValue(null),
  readVisibleCheckinRewardObservation: vi.fn().mockReturnValue(null),
  // checkin.ts 会用它把「页面宣告了今日奖励」提升为签到证据；
  // 本文件只关心点击闸门，所以用恒等替身让结论原样穿过。
  withVisibleTodayRewardEvidence: vi.fn((metrics: unknown) => metrics),
  formatQuota: vi.fn().mockReturnValue('$0'),
}));

vi.mock('@/automation/shared/announcements', () => ({
  dismissAnnouncements: vi.fn().mockResolvedValue({ closed: 0, blocked: false }),
}));

vi.mock('@/automation/shared/click-safety', () => ({
  clearClickBlocker: vi.fn().mockResolvedValue(null),
}));

const { performCheckin } = await import('@/automation/checkin/checkin');

function siteWith(method: 'auto' | 'button'): SiteConfig {
  return {
    id: 'site-hvoy',
    name: '禾维',
    loginUrl: `${window.location.origin}/`,
    selectors: { username: '#email', password: '#password', submit: 'button[type="submit"]' },
    closeModalSelectors: [],
    checkin: {
      method,
      url: '/',
      buttonSelector: '#checkin-btn',
      successText: ['签到成功'],
      alreadyText: ['今日已签到'],
    },
    adapter: { family: 'unsupported', quotaPerUnit: 1 },
  };
}

describe('签到点击后的人机验证闸门', () => {
  it('auto 路径：验证未完成时报「点击后的人机验证未完成」，不是「未检测到明确结果」', async () => {
    document.body.innerHTML = '<button id="checkin-btn">每日签到</button>';
    const log = { push: vi.fn() };
    const afterCheckinClick = vi.fn().mockResolvedValue(false);

    const outcome = await performCheckin(siteWith('auto'), log, {
      beforeCheckinClick: vi.fn().mockResolvedValue(true),
      afterCheckinClick,
    });

    expect(afterCheckinClick).toHaveBeenCalled();
    expect(outcome.status).toBe('failed');
    // 失败原因必须指向验证，否则用户会去核对没问题的按钮选择器
    expect(outcome.status === 'failed' && outcome.message).toContain('人机验证');
  });

  it('button 路径：同样过闸门', async () => {
    document.body.innerHTML = '<button id="checkin-btn">每日签到</button>';
    const log = { push: vi.fn() };
    const afterCheckinClick = vi.fn().mockResolvedValue(false);

    const outcome = await performCheckin(siteWith('button'), log, {
      beforeCheckinClick: vi.fn().mockResolvedValue(true),
      afterCheckinClick,
    });

    expect(afterCheckinClick).toHaveBeenCalled();
    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' && outcome.message).toMatch(/验证/);
  });

  /*
   * 「放行后的行为」刻意不在这里断言。
   *
   * 闸门放行后会进入真实的终态等待循环，那个循环用墙钟 `Date.now()` 计算 22 秒
   * 上限，mock 掉 `sleep` 也绕不过去 —— 两条这样的用例会给整个套件白加 88 秒。
   * 而这个文件要锁的只有一件事：**闸门被调用、且未通过时失败原因指向验证**。
   * 上面两条已经把它锁死了；放行后的终态判定由 checkin-button.test.ts 等
   * 既有用例覆盖。
   */
  it('闸门只在真实点击后调用一次，不会在恢复二次领取流程时重复调用', async () => {
    document.body.innerHTML = '<button id="checkin-btn">每日签到</button>';
    const log = { push: vi.fn() };
    const afterCheckinClick = vi.fn().mockResolvedValue(false);

    await performCheckin(siteWith('auto'), log, {
      beforeCheckinClick: vi.fn().mockResolvedValue(true),
      afterCheckinClick,
    });

    expect(afterCheckinClick).toHaveBeenCalledTimes(1);
  });
});
