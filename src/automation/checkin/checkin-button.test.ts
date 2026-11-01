import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 林夕（k40.shengqainbang.cn）真实使用的是 Sub2API 的 `/check-in` 页面。
 * 这里按页面语义覆盖 button 流程，不再复用 new-api 新版 `/profile` 卡片。
 *
 * sleep 被打桩，避免单测真的等待 8-12 秒；余额与点击的站点侧结果分别由
 * mock 和 DOM 更新表达。
 */

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

import { LINXI_SITE_PRESET } from '@/sites';
import type { CheckinConfig, SiteConfig } from '@/types';
import { performCheckin } from '@/automation/checkin/checkin';
import { realClick, sleep } from '@/automation/shared/dom-utils';

const LINXI_ORIGIN = 'https://k40.shengqainbang.cn';

function linxiSite(checkin: Partial<CheckinConfig> = {}): SiteConfig {
  return {
    id: 'site-linxi',
    name: '林夕',
    loginUrl: `${LINXI_ORIGIN}/login`,
    ...LINXI_SITE_PRESET,
    selectors: { ...LINXI_SITE_PRESET.selectors },
    closeModalSelectors: [...LINXI_SITE_PRESET.closeModalSelectors],
    checkin: {
      ...LINXI_SITE_PRESET.checkin!,
      ...checkin,
    },
    adapter: { ...LINXI_SITE_PRESET.adapter! },
  };
}

const log = { push: vi.fn() };

/** jsdom 不做布局也没有 innerText，不补齐的话所有控件都算不可见。 */
beforeEach(() => {
  vi.mocked(sleep).mockResolvedValue(undefined);
  vi.mocked(realClick).mockResolvedValue('dom');
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
  window.history.replaceState({}, '', '/check-in');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

interface CheckinPageOptions {
  buttonClass?: string;
  buttonVersion?: string;
  disabled?: boolean;
  label?: string;
}

/** 复刻林夕 `/check-in` 页的关键语义，省略与签到无关的布局节点。 */
function renderCheckinPage(options: CheckinPageOptions = {}): HTMLButtonElement {
  const {
    buttonClass = 'btn btn-primary',
    buttonVersion = 'initial',
    disabled = false,
    label = '立即签到',
  } = options;

  document.body.innerHTML = `
    <main data-page="check-in">
      <section class="checkin-card">
        <h1>每日签到</h1>
        <p>每日签到可获得随机额度奖励</p>
        <button
          type="button"
          class="${buttonClass}"
          data-checkin-version="${buttonVersion}"
          ${disabled ? 'disabled' : ''}
        >${label}</button>
      </section>
    </main>
  `;

  return document.querySelector<HTMLButtonElement>('[data-checkin-version]')!;
}

function appendCheckinMessage(message: string): void {
  const alert = document.createElement('div');
  alert.setAttribute('role', 'alert');
  alert.textContent = message;
  document.querySelector('.checkin-card')?.appendChild(alert);
}

function clickShows(message: string): void {
  vi.mocked(realClick).mockImplementation(async () => {
    appendCheckinMessage(message);
    return 'dom';
  });
}

describe('林夕 Sub2API 签到配置', () => {
  it('使用真实域名、/check-in 页面与美元原值额度', () => {
    const configured = linxiSite();

    expect(new URL(configured.loginUrl).hostname).toBe('k40.shengqainbang.cn');
    expect(configured.checkin).toMatchObject({
      method: 'button',
      url: '/check-in',
      buttonSelector: expect.stringContaining('立即签到'),
      alreadySelector: expect.stringContaining('今日已签到'),
    });
    expect(configured.adapter).toMatchObject({
      siteType: 'sub2api',
      family: 'sub2api',
      checkinPath: '/check-in',
      quotaPerUnit: 1,
    });
  });
});

describe('林夕 /check-in 按钮等待与终态', () => {
  it('登录后的当前页没有签到弹窗时，先进入固定的 /check-in 页面', async () => {
    window.history.replaceState({}, '', '/dashboard');
    document.body.innerHTML = '<main><h1>控制台</h1></main>';

    const outcome = await performCheckin(linxiSite(), log);

    expect(outcome).toEqual({ status: 'navigate', url: new URL('/check-in', location.href).href });
    expect(realClick).not.toHaveBeenCalled();
  });

  it('登录落地后按钮延迟渲染，仍等待并完成签到', async () => {
    clickShows('签到成功，获得 $0.86');
    let polls = 0;
    vi.mocked(sleep).mockImplementation(async () => {
      polls += 1;
      if (polls === 3) renderCheckinPage();
    });

    const outcome = await performCheckin(linxiSite(), log);

    expect(polls).toBeGreaterThanOrEqual(3);
    expect(realClick).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe('success');
  });

  it('按钮先禁用、站点状态加载后变为可点，仍完成签到', async () => {
    clickShows('签到成功，获得 $1.02');
    const button = renderCheckinPage({ disabled: true });
    let polls = 0;
    let clicked = false;
    Object.defineProperty(button, 'disabled', {
      configurable: true,
      get() {
        polls += 1;
        return !clicked && polls < 3;
      },
      set(value: boolean) {
        clicked = value;
      },
    });

    const outcome = await performCheckin(linxiSite(), log);

    expect(polls).toBeGreaterThanOrEqual(3);
    expect(realClick).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe('success');
  });

  it('禁用的「今日已签到」是完成态，不再点击', async () => {
    renderCheckinPage({ disabled: true, label: '今日已签到' });

    const outcome = await performCheckin(linxiSite(), log);

    expect(outcome.status).toBe('already');
    expect(realClick).not.toHaveBeenCalled();
  });

  it('「签到成功，获得 $...」是明确成功证据', async () => {
    renderCheckinPage();
    clickShows('签到成功，获得 $0.73');

    const outcome = await performCheckin(linxiSite(), log);

    expect(realClick).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ status: 'success', message: '页面出现签到成功提示' });
  });

  it('点击后出现「今天已经签过了」时按本轮成功收尾', async () => {
    renderCheckinPage();
    clickShows('今天已经签过了');

    const outcome = await performCheckin(linxiSite(), log);

    expect(realClick).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ status: 'success', message: '点击后页面提示今日已签到' });
  });

  it('Tailwind disabled 变体类名不把可点按钮误判为禁用', async () => {
    renderCheckinPage({ buttonClass: 'btn btn-primary disabled:opacity-50 disabled:pointer-events-none' });
    clickShows('签到成功，获得 $0.91');

    const outcome = await performCheckin(linxiSite(), log);

    expect(realClick).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe('success');
  });
});

describe('Turnstile 完成后的 DOM 重定位', () => {
  it('闸门导致签到卡重绘时，只点击验证完成后的新按钮', async () => {
    const staleButton = renderCheckinPage({ buttonVersion: 'before-turnstile' });
    let gateCalls = 0;
    const beforeCheckinClick = vi.fn(async () => {
      gateCalls += 1;
      // 第一次是初始挑战检查；第二次模拟 Turnstile 完成后 React 重绘签到卡。
      if (gateCalls === 2) {
        renderCheckinPage({ buttonVersion: 'after-turnstile' });
      }
      return true;
    });
    vi.mocked(realClick).mockImplementation(async () => {
      appendCheckinMessage('签到成功，获得 $0.68');
      return 'dom';
    });

    const outcome = await performCheckin(linxiSite(), log, { beforeCheckinClick });
    const clickedButton = vi.mocked(realClick).mock.calls[0]?.[0];

    expect(beforeCheckinClick).toHaveBeenCalledTimes(2);
    expect(document.contains(staleButton)).toBe(false);
    expect(clickedButton).not.toBe(staleButton);
    expect(clickedButton?.getAttribute('data-checkin-version')).toBe('after-turnstile');
    expect(outcome.status).toBe('success');
  });
});

describe('没有签到证据时不得伪造成功', () => {
  it('无按钮且无已签到文案时，等待结束后如实失败', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      now += 1_000;
      return now;
    });
    document.body.innerHTML = '<main><button>账户设置</button></main>';

    const outcome = await performCheckin(linxiSite(), log);

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.message).toContain('找不到签到按钮');
    expect(realClick).not.toHaveBeenCalled();
  });

  it('按钮一直禁用且没有已签到证据时如实失败', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      now += 1_000;
      return now;
    });
    renderCheckinPage({ disabled: true });

    const outcome = await performCheckin(linxiSite(), log);

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.message).toContain('已禁用');
    expect(realClick).not.toHaveBeenCalled();
  });
});
