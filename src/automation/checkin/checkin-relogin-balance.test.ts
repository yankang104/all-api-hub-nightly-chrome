import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BalanceSnapshot, SiteConfig } from '@/types';

vi.mock('@/automation/balance/balance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/automation/balance/balance')>();
  return { ...actual, captureBalance: vi.fn() };
});

import { captureBalance } from '@/automation/balance/balance';
import { performCheckin } from '@/automation/checkin/checkin';

const site = (): SiteConfig => ({
  id: 'site-agentrouter',
  name: 'Agent Router',
  loginUrl: `${window.location.origin}/login`,
  loginMethod: 'github',
  selectors: { username: '#username', password: '#password', submit: 'button[type="submit"]' },
  closeModalSelectors: [],
  checkin: { method: 'relogin', logoutApiUrl: '/api/user/logout' },
});

describe('relogin pre-logout balance capture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('persists the authenticated baseline before calling the logout endpoint', async () => {
    const before: BalanceSnapshot = { quota: 100, usedQuota: 50, at: 1 };
    vi.mocked(captureBalance).mockResolvedValue(before);
    const saveReloginBalanceBefore = vi.fn().mockResolvedValue(undefined);
    const saveBalance = vi.fn().mockResolvedValue(undefined);
    const fetchLogout = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue('{"success":true}'),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchLogout);

    const result = await performCheckin(site(), { push: vi.fn() }, {
      saveReloginBalanceBefore,
      saveBalance,
    });

    expect(result).toMatchObject({ status: 'relogin', message: '已退出，准备重新登录' });
    expect(captureBalance).toHaveBeenCalledOnce();
    expect(saveReloginBalanceBefore).toHaveBeenCalledWith(before);
    expect(saveBalance).not.toHaveBeenCalled();
    expect(saveReloginBalanceBefore.mock.invocationCallOrder[0]).toBeLessThan(
      fetchLogout.mock.invocationCallOrder[0]!,
    );
  });
});
