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

import type { SiteConfig } from '@/types';
import { performCheckin } from '@/automation/checkin/checkin';
import { realClick, sleep } from '@/automation/shared/dom-utils';

const log = { push: vi.fn() };

/** 用户自建的 denxio 同形站点：界面上没有二次领取入口，所以没有 claimConfirmSelector */
function userSite(overrides: Partial<NonNullable<SiteConfig['checkin']>> = {}): SiteConfig {
  return {
    id: 'site-user',
    name: '用户自建同形站',
    loginUrl: 'https://example.com/login',
    selectors: { username: '#email', password: '#password', submit: 'button[type=submit]' },
    checkin: {
      method: 'auto',
      url: '/checkin',
      ...overrides,
    },
  } as SiteConfig;
}

function renderPage(): void {
  document.body.innerHTML = `<main><button id="normal-checkin" type="button">立即签到</button></main>`;
}

function openClaimDialog(label: string, withSponsorContext: boolean, disabled: boolean): void {
  const dialog = document.createElement('div');
  dialog.id = 'claim-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.innerHTML = `
    ${withSponsorContext ? '<p>赞助人鸣谢</p>' : '<p>每日奖励</p>'}
    <button id="claim-reward" type="button" ${disabled ? 'disabled' : ''}>${label}</button>
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
    width: 160, height: 40, top: 0, left: 0, right: 160, bottom: 40, x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect);
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true,
    get(this: HTMLElement) { return this.textContent ?? ''; },
  });
  window.history.replaceState({}, '', '/checkin');
  renderPage();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe('未配置 claimConfirmSelector 时的语义兜底', () => {
  it('A. 按钮文案是「领取奖励」→ 语义扫描是否仍点了它？', async () => {
    vi.mocked(realClick).mockImplementation(async (target) => {
      if (target.id === 'normal-checkin') {
        markPrimaryCheckedIn();
        openClaimDialog('领取奖励', true, false);
        return 'dom';
      }
      if (target.id === 'claim-reward') {
        document.querySelector('#claim-dialog')?.remove();
        const notice = document.createElement('div');
        notice.textContent = '领取成功';
        document.body.appendChild(notice);
        return 'dom';
      }
      throw new Error(`误点: ${target.id}`);
    });

    const outcome = await performCheckin(userSite(), log);
    const clicked = vi.mocked(realClick).mock.calls.map(([t]) => t.id);
    console.log('【A 结果】clicked =', JSON.stringify(clicked), 'outcome =', JSON.stringify(outcome));
    expect(clicked).toBeDefined();
  });

  it('B. 按钮文案是「领取」且弹窗无赞助语境 → 是否漏点？', async () => {
    vi.mocked(realClick).mockImplementation(async (target) => {
      if (target.id === 'normal-checkin') {
        markPrimaryCheckedIn();
        openClaimDialog('领取', false, false);
        return 'dom';
      }
      if (target.id === 'claim-reward') {
        document.querySelector('#claim-dialog')?.remove();
        const notice = document.createElement('div');
        notice.textContent = '领取成功';
        document.body.appendChild(notice);
        return 'dom';
      }
      throw new Error(`误点: ${target.id}`);
    });

    const outcome = await performCheckin(userSite(), log);
    const clicked = vi.mocked(realClick).mock.calls.map(([t]) => t.id);
    console.log('【B 结果】clicked =', JSON.stringify(clicked), 'outcome =', JSON.stringify(outcome));
    expect(clicked).toBeDefined();
  });

  it('C. 「领取奖励」弹窗迟于 4.5s 宽限窗口才出现 → 是否漏点？', async () => {
    let now = 0;
    // 每次 Date.now() 前进 1 秒，模拟宽限窗口很快耗尽
    vi.spyOn(Date, 'now').mockImplementation(() => { now += 1_000; return now; });
    let polls = 0;
    vi.mocked(sleep).mockImplementation(async () => {
      polls += 1;
      // 迟到的弹窗：第 12 轮轮询才出现
      if (polls === 12 && !document.querySelector('#claim-dialog')) {
        openClaimDialog('领取奖励', true, false);
      }
    });
    vi.mocked(realClick).mockImplementation(async (target) => {
      if (target.id === 'normal-checkin') { markPrimaryCheckedIn(); return 'dom'; }
      if (target.id === 'claim-reward') {
        document.querySelector('#claim-dialog')?.remove();
        const notice = document.createElement('div');
        notice.textContent = '领取成功';
        document.body.appendChild(notice);
        return 'dom';
      }
      throw new Error(`误点: ${target.id}`);
    });

    const outcome = await performCheckin(userSite(), log);
    const clicked = vi.mocked(realClick).mock.calls.map(([t]) => t.id);
    console.log('【C 结果】clicked =', JSON.stringify(clicked), 'outcome =', JSON.stringify(outcome));
    expect(clicked).toBeDefined();
  });

  it('D. 对照：配置了 claimConfirmSelector 的同一页面', async () => {
    vi.mocked(realClick).mockImplementation(async (target) => {
      if (target.id === 'normal-checkin') {
        markPrimaryCheckedIn();
        openClaimDialog('领取奖励', true, false);
        return 'dom';
      }
      if (target.id === 'claim-reward') {
        document.querySelector('#claim-dialog')?.remove();
        const notice = document.createElement('div');
        notice.textContent = '领取成功';
        document.body.appendChild(notice);
        return 'dom';
      }
      throw new Error(`误点: ${target.id}`);
    });

    const outcome = await performCheckin(
      userSite({ claimConfirmSelector: 'button >> text=领取奖励' }),
      log,
    );
    const clicked = vi.mocked(realClick).mock.calls.map(([t]) => t.id);
    console.log('【D 结果】clicked =', JSON.stringify(clicked), 'outcome =', JSON.stringify(outcome));
    expect(clicked).toBeDefined();
  });
});
