import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BalanceSnapshot, SiteConfig } from '@/types';

vi.mock('@/automation/shared/dom-utils', async () => {
  const actual = await vi.importActual<typeof import('@/automation/shared/dom-utils')>('@/automation/shared/dom-utils');
  return {
    ...actual,
    sleep: vi.fn().mockResolvedValue(undefined),
    realClick: vi.fn().mockResolvedValue('dom'),
  };
});

vi.mock('@/automation/balance/balance', async () => {
  const actual = await vi.importActual<typeof import('@/automation/balance/balance')>('@/automation/balance/balance');
  return {
    ...actual,
    captureBalance: vi.fn(),
  };
});

vi.mock('@/automation/shared/click-safety', () => ({
  clearClickBlocker: vi.fn().mockResolvedValue(null),
}));

import { captureBalance } from '@/automation/balance/balance';
import { performCheckin } from '@/automation/checkin/checkin';
import { realClick } from '@/automation/shared/dom-utils';

const site = (): SiteConfig => ({
  id: 'site-linux-sb',
  name: 'Linux.SB',
  loginUrl: `${window.location.origin}/login`,
  loginMethod: 'form',
  selectors: {
    username: 'input[name="login"]',
    password: 'input[name="password"]',
    submit: 'button[type="submit"]',
  },
  closeModalSelectors: [],
  checkin: {
    method: 'button',
    url: '/daily_checkin',
    buttonSelector: '.daily-checkin-page-action button:not([disabled])',
    alreadySelector: '.daily-checkin-page-action .daily-checkin-done',
    alreadyText: ['已完成', '今天已签到'],
  },
  adapter: { quotaPerUnit: 1 },
});

const before: BalanceSnapshot = {
  quota: 1476,
  usedQuota: 0,
  symbol: '积分',
  at: 1,
  fromVisibleText: true,
};
const after: BalanceSnapshot = {
  quota: 1518,
  usedQuota: 0,
  symbol: '积分',
  at: 2,
  fromVisibleText: true,
};
const log = { push: vi.fn() };

function renderButton(): void {
  document.body.innerHTML = `
    <main>
      <div class="user-rank">饼友 · 积分 1476</div>
      <div class="daily-checkin-action daily-checkin-page-action">
        <form method="post"><button type="submit">立即签到</button></form>
      </div>
    </main>
  `;
}

function renderDone(): void {
  document.body.innerHTML = `
    <main>
      <div class="user-rank">饼友 · 积分 1518</div>
      <div class="daily-checkin-action daily-checkin-page-action">
        <div class="daily-checkin-done">已完成</div>
      </div>
    </main>
  `;
}

beforeEach(() => {
  window.history.replaceState({}, '', '/daily_checkin');
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 112,
    height: 40,
    top: 0,
    left: 0,
    right: 112,
    bottom: 40,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true,
    get(this: HTMLElement) {
      return this.textContent ?? '';
    },
  });
  vi.mocked(captureBalance).mockReset();
  vi.mocked(realClick).mockReset().mockResolvedValue('dom');
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('button 整页导航的余额基线', () => {
  it('后台确认保存签到前快照后才真实点击按钮', async () => {
    renderButton();
    vi.mocked(captureBalance).mockResolvedValueOnce(before).mockResolvedValue(after);
    const saveButtonBalanceBefore = vi.fn().mockResolvedValue(undefined);
    vi.mocked(realClick).mockImplementation(async () => {
      renderDone();
      document.querySelector('main')?.insertAdjacentHTML('beforeend', '<div role="alert">签到成功</div>');
      return 'dom';
    });

    const outcome = await performCheckin(site(), log, { saveButtonBalanceBefore });

    expect(outcome).toMatchObject({ status: 'success', metrics: { reward: 42, verdict: 'rewarded' } });
    expect(saveButtonBalanceBefore).toHaveBeenCalledOnce();
    expect(saveButtonBalanceBefore).toHaveBeenCalledWith(before);
    expect(saveButtonBalanceBefore.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(realClick).mock.invocationCallOrder[0]!,
    );
  });

  it('基线写入失败时停止，不允许发出不可恢复的表单点击', async () => {
    renderButton();
    vi.mocked(captureBalance).mockResolvedValue(before);
    const saveButtonBalanceBefore = vi.fn().mockRejectedValue(new Error('基线未落盘'));

    await expect(performCheckin(site(), log, { saveButtonBalanceBefore }))
      .rejects.toThrow('基线未落盘');
    expect(realClick).not.toHaveBeenCalled();
  });

  it('重载后有 pending 标记时不重复点击，并用旧基线确认 +42 积分', async () => {
    renderDone();
    vi.mocked(captureBalance).mockResolvedValue(after);

    const outcome = await performCheckin(site(), log, { buttonBalanceBefore: before });

    expect(realClick).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      status: 'success',
      message: '签到按钮提交后页面显示已完成',
      metrics: {
        reward: 42,
        balanceDelta: 42,
        quotaAfter: 1518,
        balanceSymbol: '积分',
        verdict: 'rewarded',
      },
    });
    expect(captureBalance).toHaveBeenCalledOnce();
  });

  it('没有 pending 标记的历史已签页面仍是 already，不冒充本轮 +42', async () => {
    renderDone();
    vi.mocked(captureBalance).mockResolvedValue(after);

    const outcome = await performCheckin(site(), log);

    expect(realClick).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      status: 'already',
      metrics: { reward: 0, verdict: 'unchanged', source: 'checkin-ledger' },
    });
  });
});
