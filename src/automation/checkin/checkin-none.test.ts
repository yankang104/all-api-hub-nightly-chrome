import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 「登录即签到」（method: 'none'）不去别处找签到入口。
 *
 * 锁的是 AnyRouter 那个真实故障：站点登录本身就是签到，控制台上没有任何签到
 * 控件，而旧实现会顺着「同源入口链接 → checkin.url → 适配器兜底路径」跳去
 * /console/personal，在那儿等满 12 秒渲染再报「签到页未找到明确按钮或已签到
 * 状态」—— 一次本该成功的签到被判成失败。
 *
 * 只测判定分支，不测真实 SPA 时序：sleep/waitFor 被打桩掉，余额采集也 mock 成
 * 读不到（AnyRouter 的额度端点在这里没法真实请求）。
 *
 * 「登录即签到」必须绑定本轮的登录动作：hooks.loginHappenedThisRun 为 true 才
 * 表示本轮真的登录过。打开时本来就已登录时这个标记为 false，此时没有登录动作
 * 可归因，必须报 unverified，不能假装成功。
 */

vi.mock('@/automation/shared/dom-utils', async () => {
  const actual = await vi.importActual<typeof import('@/automation/shared/dom-utils')>('@/automation/shared/dom-utils');
  return {
    ...actual,
    sleep: vi.fn().mockResolvedValue(undefined),
    waitFor: vi.fn().mockResolvedValue(null),
    realClick: vi.fn().mockResolvedValue('dom'),
  };
});

vi.mock('@/automation/balance/balance', async () => {
  const actual = await vi.importActual<typeof import('@/automation/balance/balance')>('@/automation/balance/balance');
  return {
    ...actual,
    captureBalance: vi.fn().mockResolvedValue(null),
    diffBalance: vi.fn().mockReturnValue({ verdict: 'unknown' }),
    describeMetrics: vi.fn().mockReturnValue(''),
  };
});

// clearClickBlocker 靠 document.elementFromPoint 判遮挡，jsdom 没实现
vi.mock('@/automation/shared/click-safety', () => ({
  clearClickBlocker: vi.fn().mockResolvedValue(null),
}));

import { realClick } from '@/automation/shared/dom-utils';
import { performCheckin } from '@/automation/checkin/checkin';
import { captureBalance, describeMetrics, diffBalance } from '@/automation/balance/balance';
import type { CheckinMethod, SiteConfig } from '@/types';

const site = (method: CheckinMethod, extra: Partial<SiteConfig> = {}): SiteConfig => ({
  id: 'builtin-anyrouter',
  name: 'AnyRouter',
  loginUrl: `${window.location.origin}/login`,
  loginMethod: 'auto',
  selectors: { username: '#username', password: '#password', submit: 'button[type="submit"]' },
  closeModalSelectors: [],
  checkin: { method },
  adapter: { family: 'new-api', checkinPath: '', quotaPerUnit: 500_000 },
  ...extra,
});

const log = { push: vi.fn() };

/**
 * 补齐 jsdom 缺的两样浏览器行为，否则测出来的结论说明不了任何事：
 *
 *  1. 不做布局，getBoundingClientRect 一律 0×0 —— 而控件识别要求
 *     width/height > 0（isVisibleElement），不打桩页面上所有按钮都算不可见；
 *  2. 压根没有 innerText —— 签到判定到处读它（按钮文案、正文成功/已签到文案），
 *     不打桩就永远读到空串，「没找到签到控件」是假的。
 */
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 80, height: 32, top: 0, left: 0, right: 80, bottom: 32, x: 0, y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true,
    get(this: HTMLElement) {
      return this.textContent ?? '';
    },
  });
});

beforeEach(() => {
  // 实测的 AnyRouter 控制台：可点元素只有导航和头像，没有任何签到控件
  document.body.innerHTML = `
    <nav>
      <a href="/">首页</a>
      <a href="/console">控制台</a>
      <a href="/pricing">定价</a>
    </nav>
    <button>切换主题</button>
    <button>切换语言</button>
    <button>F fzy520</button>
  `;
  window.history.replaceState({}, '', '/console');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  document.body.innerHTML = '';
  window.history.replaceState({}, '', '/login');
});

describe('method: none —— 登录即签到', () => {
  it('本轮登录过但没有奖励证据：无控件时返回 unverified，不跳转去找签到页', async () => {
    // 关键新行为：登录动作只提供归因前提，不提供完成证据。没有登录前基线、
    // 页面也没有任何成功/已签到文案时，不能凭「登过」直接报成功。
    const outcome = await performCheckin(site('none'), log, { loginHappenedThisRun: true });

    expect(outcome.status).toBe('unverified');
    if (outcome.status === 'unverified') {
      expect(outcome.message).toContain('没有余额入账或页面证据');
      expect(outcome.message).toContain('无法确认本次签到');
    }
    expect(log.push).toHaveBeenCalledWith(expect.stringContaining('没有余额入账或页面证据'));
  });

  it('打开时已登录但本轮没有登录动作：没有控件时不得报成功', async () => {
    // 这是假成功的来源：页面有登录态（来自上一轮），本轮既没登录也没有登录前
    // 基线，却按「登录即签到」收尾，用户看到的绿色对勾无法核实。
    const outcome = await performCheckin(site('none'), log);

    expect(outcome.status).toBe('unverified');
    expect(outcome.status).not.toBe('success');
    if (outcome.status === 'unverified') {
      expect(outcome.message).toContain('本轮没有发生登录动作');
      expect(outcome.message).toContain('无法确认');
    }
    // 日志必须写清原因，否则用户只看到一个没有出处的弱结论
    expect(log.push).toHaveBeenCalledWith(
      expect.stringContaining('本轮没有发生登录动作'),
    );
  });

  it('即使站点配了签到页地址也不跳 —— 这条路只看当前页', async () => {
    // 旧记录常带着 url:'/console/personal'；跳过去只会白等 12 秒再判失败。
    // 页面给出明确完成证据，验证「不跳转」与结论无关。
    document.body.innerHTML = '<div>今日已签到</div>';
    const outcome = await performCheckin(
      site('none', { checkin: { method: 'none', url: '/console/personal' } }),
      log,
      { loginHappenedThisRun: true },
    );

    expect(outcome.status).toBe('success');
  });

  it('不点导航链接，也不把它当签到入口', async () => {
    await performCheckin(site('none'), log, { loginHappenedThisRun: true });
    expect(realClick).not.toHaveBeenCalled();
  });

  it('同一个页面上 auto 会去找签到入口，两种方式必须分得开', async () => {
    // 对照组：auto 在这页找不到控件，会顺着 checkin.url 跳转
    const outcome = await performCheckin(
      site('auto', { checkin: { method: 'auto', url: '/console/personal' } }),
      log,
    );

    expect(outcome.status).toBe('navigate');
    if (outcome.status === 'navigate') expect(outcome.url).toContain('/console/personal');
  });

  it('页面已显示今日已签到时报 already，而不是盖成一次新的成功', async () => {
    document.body.innerHTML = '<button disabled>今日已签到</button>';

    const outcome = await performCheckin(site('none'), log);
    expect(outcome.status).toBe('already');
  });

  it('无控件但页面显示「今日已签到」：仍然 success', async () => {
    document.body.innerHTML = '<div>今日已签到</div>';
    const outcome = await performCheckin(site('none'), log, { loginHappenedThisRun: true });

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') expect(outcome.message).toBe('登录即签到');
  });

  it('当前页正好有签到按钮时仍然点它', async () => {
    // 「登录即签到」不等于「什么都不做」：这一页有真按钮就该点
    document.body.innerHTML = '<button>立即签到</button>';
    const button = document.querySelector('button')!;
    // 点击后站点渲染成功文案
    vi.mocked(realClick).mockImplementation(async () => {
      document.body.innerHTML = '<div>签到成功</div>';
      return 'dom';
    });

    const outcome = await performCheckin(site('none'), log);

    expect(realClick).toHaveBeenCalledWith(button, { mayNavigate: true });
    expect(outcome.status).toBe('success');
  });

  it('无控件但有登录前基线且差分 rewarded：仍然 success', async () => {
    const before = { quota: 1_000_000, usedQuota: 0, at: 1 };
    const after = { quota: 1_100_000, usedQuota: 0, at: 2 };
    // 基线来自登录前历史快照；收尾差分读到 after 后确认 rewarded。
    vi.mocked(captureBalance).mockResolvedValueOnce(after);
    vi.mocked(diffBalance).mockReturnValueOnce({
      verdict: 'rewarded',
      reward: 100_000,
      usageDelta: 0,
      balanceDelta: 100_000,
      quotaAfter: after.quota,
    });

    const outcome = await performCheckin(site('none'), log, {
      loginHappenedThisRun: true,
      loginCheckinBalanceBefore: before,
    });

    expect(diffBalance).toHaveBeenCalledWith(before, after);
    expect(outcome).toMatchObject({
      status: 'success',
      metrics: { verdict: 'rewarded', reward: 100_000 },
    });
  });

  it('使用登录前的账号总额度基线计算增加量，不再采登录后的值冒充 before', async () => {
    const before = { quota: 595_000_000, usedQuota: 0, at: 1 };
    const after = { quota: 597_295_000, usedQuota: 500_000, at: 2 };
    vi.mocked(captureBalance).mockResolvedValueOnce(after);
    vi.mocked(diffBalance).mockReturnValueOnce({
      verdict: 'rewarded',
      reward: 2_795_000,
      usageDelta: 500_000,
      balanceDelta: 2_295_000,
      quotaAfter: after.quota,
    });

    const outcome = await performCheckin(site('none'), log, {
      // 基线只在本轮真的登录过时才有意义，标记必须一起给
      loginHappenedThisRun: true,
      loginCheckinBalanceBefore: before,
    });

    expect(captureBalance).toHaveBeenCalledOnce();
    expect(diffBalance).toHaveBeenCalledWith(before, after);
    expect(outcome).toMatchObject({
      status: 'success',
      metrics: { verdict: 'rewarded', reward: 2_795_000 },
    });
  });

  it('登录前没有基线：登录后才采到的“前值”不能把 unverified 升级成 success', async () => {
    // 登录后才采到的“前值”本身已经是动作后状态，不能作为本轮登录奖励的因果基线：
    // 否则恰好发生的余额变化会被误报成本次「登录即签到」成功。
    const capturedAfterLogin = { quota: 1_000_000, usedQuota: 0, at: 1 };
    const later = { quota: 1_100_000, usedQuota: 0, at: 2 };
    vi.mocked(captureBalance)
      .mockResolvedValueOnce(capturedAfterLogin)
      .mockResolvedValueOnce(later);
    vi.mocked(diffBalance).mockReturnValueOnce({
      verdict: 'rewarded',
      reward: 100_000,
      usageDelta: 0,
      balanceDelta: 100_000,
      quotaAfter: later.quota,
    });
    const summary = '签到获得 $0.20，当前余额 $2.20';
    vi.mocked(describeMetrics).mockReturnValueOnce(summary);

    const outcome = await performCheckin(site('none'), log, { loginHappenedThisRun: true });

    expect(captureBalance).toHaveBeenCalledTimes(2);
    expect(diffBalance).toHaveBeenCalledWith(capturedAfterLogin, later);
    expect(outcome.status).toBe('unverified');
    expect(outcome.status).not.toBe('success');
    expect(outcome).toMatchObject({
      status: 'unverified',
      metrics: { verdict: 'rewarded', reward: 100_000 },
    });
    if (outcome.status === 'unverified') {
      expect(outcome.message).toContain('无法确认本次签到');
    }
    // 差分摘要仍然展示，但结论必须留在 unverified，不能把外部变化包装成签到成功。
    expect(log.push).toHaveBeenCalledWith(summary);
  });
});
