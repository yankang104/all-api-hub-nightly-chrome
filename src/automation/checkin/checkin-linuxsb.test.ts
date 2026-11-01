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
  };
});

vi.mock('@/automation/shared/click-safety', () => ({
  clearClickBlocker: vi.fn().mockResolvedValue(null),
}));

import { LINUX_SB_SITE_PRESET } from '@/sites';
import type { SiteConfig } from '@/types';
import { performCheckin } from '@/automation/checkin/checkin';
import { realClick } from '@/automation/shared/dom-utils';

const log = { push: vi.fn() };

function linuxSbSite(): SiteConfig {
  return {
    id: 'site-linux-sb',
    name: 'Linux.SB',
    loginUrl: 'https://linux.sb/login',
    ...LINUX_SB_SITE_PRESET,
    selectors: { ...LINUX_SB_SITE_PRESET.selectors },
    closeModalSelectors: [...LINUX_SB_SITE_PRESET.closeModalSelectors],
    checkin: { ...LINUX_SB_SITE_PRESET.checkin! },
    adapter: { ...LINUX_SB_SITE_PRESET.adapter! },
  };
}

beforeEach(() => {
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
  window.history.replaceState({}, '', '/daily_checkin');
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('Linux.SB /daily_checkin 真实 DOM', () => {
  it('直接识别 .daily-checkin-done 完成态，不重复点击', async () => {
    document.body.innerHTML = `
      <main>
        <div class="daily-checkin-action daily-checkin-page-action">
          <div class="daily-checkin-done">已完成</div>
        </div>
      </main>
    `;

    await expect(performCheckin(linuxSbSite(), log)).resolves.toMatchObject({
      status: 'already',
    });
    expect(realClick).not.toHaveBeenCalled();
  });

  it('通过页面动作容器找到立即签到按钮，并识别点击后的已完成状态', async () => {
    document.body.innerHTML = `
      <main>
        <div class="daily-checkin-action daily-checkin-page-action">
          <form method="post"><button type="submit">立即签到</button></form>
        </div>
      </main>
    `;
    vi.mocked(realClick).mockImplementation(async () => {
      document.querySelector('.daily-checkin-page-action')!.innerHTML =
        '<div class="daily-checkin-done">已完成</div>';
      return 'dom';
    });

    await expect(performCheckin(linuxSbSite(), log)).resolves.toMatchObject({
      status: 'success',
    });
    expect(realClick).toHaveBeenCalledTimes(1);
  });
});
