import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    captureBalance: vi.fn().mockResolvedValue(null),
    diffBalance: vi.fn().mockReturnValue({ verdict: 'unknown' }),
    describeMetrics: vi.fn().mockReturnValue(''),
  };
});

vi.mock('@/automation/shared/click-safety', () => ({
  clearClickBlocker: vi.fn().mockResolvedValue(null),
}));

import { DENXIO_SITE_PRESET } from '@/sites';
import type { SiteConfig } from '@/types';
import { performCheckin } from '@/automation/checkin/checkin';
import { realClick, sleep } from '@/automation/shared/dom-utils';

const log = { push: vi.fn() };

function denxioSite(): SiteConfig {
  return {
    id: 'site-denxio',
    name: '登仙公益站',
    loginUrl: 'https://api.denxio.top/login',
    ...DENXIO_SITE_PRESET,
    selectors: { ...DENXIO_SITE_PRESET.selectors },
    closeModalSelectors: [...(DENXIO_SITE_PRESET.closeModalSelectors ?? [])],
    checkin: { ...DENXIO_SITE_PRESET.checkin! },
    adapter: { ...DENXIO_SITE_PRESET.adapter! },
  };
}

function renderPage(): void {
  document.body.innerHTML = `
    <main>
      <button id="bonus-checkin" type="button">加成签到</button>
      <button id="normal-checkin" type="button">立即签到</button>
    </main>
  `;
}

function openClaimDialog(disabled: boolean): void {
  const dialog = document.createElement('div');
  dialog.id = 'sponsor-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.innerHTML = `
    <h2>登仙赞助站</h2>
    <p>赞助人鸣谢</p>
    <button id="claim-reward" type="button" ${disabled ? 'disabled' : ''}>领取奖励</button>
  `;
  document.body.appendChild(dialog);
}

function markPrimaryCheckedIn(): void {
  const button = document.querySelector<HTMLButtonElement>('#normal-checkin')!;
  button.disabled = true;
  button.textContent = '今日已签到';
  const notice = document.createElement('div');
  notice.setAttribute('role', 'alert');
  notice.textContent = '签到成功';
  document.body.appendChild(notice);
}

beforeEach(() => {
  vi.mocked(sleep).mockResolvedValue(undefined);
  vi.mocked(realClick).mockResolvedValue('dom');
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 160,
    height: 40,
    top: 0,
    left: 0,
    right: 160,
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
  window.history.replaceState({}, '', '/checkin');
  renderPage();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe('登仙 /checkin 二次领取', () => {
  it('优先点立即签到，并等待禁用的领取奖励重绘解锁后再点击', async () => {
    let pendingPolls = 0;
    vi.mocked(sleep).mockImplementation(async () => {
      const pending = document.querySelector<HTMLButtonElement>('#claim-reward:disabled');
      if (!pending) return;
      pendingPolls += 1;
      if (pendingPolls === 3) {
        const enabled = pending.cloneNode(true) as HTMLButtonElement;
        enabled.disabled = false;
        pending.replaceWith(enabled);
      }
    });
    vi.mocked(realClick).mockImplementation(async (target) => {
      if (target.id === 'normal-checkin') {
        markPrimaryCheckedIn();
        openClaimDialog(true);
        return 'dom';
      }
      if (target.id === 'claim-reward') {
        document.querySelector('#sponsor-dialog')?.remove();
        const notice = document.createElement('div');
        notice.textContent = '领取成功';
        document.body.appendChild(notice);
        return 'dom';
      }
      throw new Error(`误点了非目标按钮: ${target.id}`);
    });

    const outcome = await performCheckin(denxioSite(), log);
    const clickedIds = vi.mocked(realClick).mock.calls.map(([target]) => target.id);

    expect(clickedIds).toEqual(['normal-checkin', 'claim-reward']);
    expect(pendingPolls).toBeGreaterThanOrEqual(3);
    expect(log.push).toHaveBeenCalledWith('已出现二次确认按钮，等待「领取奖励」解锁');
    expect(log.push).toHaveBeenCalledWith('已点击二次确认按钮「领取奖励」（第 1 次）');
    expect(outcome).toMatchObject({ status: 'success', message: '页面出现领取奖励成功提示' });
  });

  it('领取点击未获浏览器确认时不计作成功，也不被主卡片已签到状态短路', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      now += 1_000;
      return now;
    });
    vi.mocked(realClick).mockImplementation(async (target) => {
      if (target.id === 'normal-checkin') {
        markPrimaryCheckedIn();
        openClaimDialog(false);
        return 'dom';
      }
      throw new Error('可信点击未抵达目标');
    });

    const outcome = await performCheckin(denxioSite(), log);

    expect(outcome.status).toBe('failed');
    expect(log.push).toHaveBeenCalledWith(expect.stringContaining('二次确认按钮点击未获浏览器确认'));
    expect(log.push).not.toHaveBeenCalledWith(expect.stringContaining('已点击二次确认按钮'));
  });
});
