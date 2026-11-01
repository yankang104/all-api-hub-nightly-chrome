import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BalanceSnapshot, LoginTask } from '@/types';
import type { EngineHost } from '@/automation/engine/engine';

vi.mock('@/automation/login/steps', () => ({
  closeAnnouncements: vi.fn().mockResolvedValue(undefined),
  fillCredentials: vi.fn(),
  submitLogin: vi.fn(),
  verifyLogin: vi.fn(),
  clickOAuthButton: vi.fn(),
  detectManualLoginStep: vi.fn().mockReturnValue(null),
  detectAlreadyLoggedIn: vi.fn(),
  hasVisibleLoginPrompt: vi.fn().mockReturnValue(true),
  pageShowsSignedIn: vi.fn().mockReturnValue(true),
  revealExternalLogin: vi.fn(),
  revealLoginForm: vi.fn(),
  waitForExternalLoginNavigation: vi.fn(),
}));

vi.mock('@/automation/checkin/checkin', () => ({
  performCheckin: vi.fn(),
}));

vi.mock('@/automation/shared/dom-utils', () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/automation/challenge/challenge', () => ({
  waitForChallenge: vi.fn().mockResolvedValue({ detected: false, resolved: true }),
  waitForManagedChallenge: vi.fn().mockResolvedValue({ detected: false, resolved: true }),
}));

vi.mock('@/automation/shared/page-health', () => ({
  detectPageAvailabilityIssue: vi.fn().mockReturnValue(null),
}));

vi.mock('@/automation/login/identity', () => ({
  findAccountOnPage: vi.fn().mockReturnValue(null),
  injectToken: vi.fn(),
  logoutSession: vi.fn(),
  readPageIdentity: vi.fn(),
  verifyIdentity: vi.fn(),
}));

vi.mock('@/automation/login/token-refresh', () => ({
  ensureFreshToken: vi.fn(),
}));

vi.mock('@/automation/balance/balance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/automation/balance/balance')>();
  return { ...actual, captureBalance: vi.fn() };
});

import { captureBalance } from '@/automation/balance/balance';
import { readPageIdentity } from '@/automation/login/identity';
import { closeAnnouncements, fillCredentials, hasVisibleLoginPrompt, pageShowsSignedIn, verifyLogin } from '@/automation/login/steps';
import { runTask } from '@/automation/engine/engine';

function reloginVerifyTask(before: BalanceSnapshot): LoginTask {
  return {
    tabId: 17,
    runId: 'run-relogin-verify',
    accountId: 'account-agentrouter',
    siteId: 'site-agentrouter',
    username: 'github_191247',
    password: '',
    effectiveLoginMethod: 'form',
    effectiveCheckinMethod: 'relogin',
    siteAccountCount: 1,
    site: {
      id: 'site-agentrouter',
      name: 'Agent Router',
      loginUrl: `${window.location.origin}/login`,
      loginMethod: 'github',
      selectors: { username: '#username', password: '#password', submit: 'button[type="submit"]' },
      closeModalSelectors: ['button >> text=今日关闭', 'button >> text=关闭公告'],
      checkin: { method: 'relogin', logoutApiUrl: '/api/user/logout' },
      adapter: { family: 'new-api', quotaPerUnit: 1 },
    },
    createdAt: Date.now(),
    stage: 'relogin-verify',
    context: { balanceBefore: before },
  };
}

describe('relogin post-login balance verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(closeAnnouncements).mockResolvedValue(undefined);
    vi.mocked(readPageIdentity).mockResolvedValue({
      userId: '191247',
      username: 'github_191247',
      source: 'api',
    });
  });

  it('closes the announcement, persists the new snapshot, and confirms a positive total-quota delta', async () => {
    const before: BalanceSnapshot = { quota: 100, usedQuota: 50, at: 1 };
    const after: BalanceSnapshot = { quota: 120, usedQuota: 60, at: 2 };
    vi.mocked(captureBalance).mockResolvedValue(after);
    const saveBalance = vi.fn().mockResolvedValue(undefined);
    const host: EngineHost = {
      markStage: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
      needsUser: vi.fn().mockResolvedValue(undefined),
      saveBalance,
    };
    const task = reloginVerifyTask(before);

    const result = await runTask(task, host);

    expect(result).toMatchObject({
      ok: true,
      message: expect.stringContaining('余额差额确认签到奖励已到账'),
      metrics: {
        reward: 30,
        usageDelta: 10,
        balanceDelta: 20,
        quotaAfter: 120,
        verdict: 'rewarded',
        source: 'balance-diff',
      },
    });
    expect(saveBalance).toHaveBeenCalledOnce();
    expect(saveBalance).toHaveBeenCalledWith(after);
    expect(closeAnnouncements).toHaveBeenCalledWith(
      task.site,
      expect.anything(),
      { waitForAppear: true },
    );
    expect(vi.mocked(closeAnnouncements).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(readPageIdentity).mock.invocationCallOrder[0]!,
    );
    expect(verifyLogin).not.toHaveBeenCalled();
  });
});


describe('relogin：退出没生效时如实说明，不去找不存在的登录按钮', () => {
  const reloginTask = (): LoginTask => ({
    ...reloginVerifyTask({ quota: 100, usedQuota: 50, at: 1 }),
    stage: 'relogin',
    effectiveLoginMethod: 'form',
    password: 'pw',
  });
  const makeHost = (): EngineHost => ({
    markStage: vi.fn().mockResolvedValue(undefined),
    navigate: vi.fn().mockResolvedValue(undefined),
    needsUser: vi.fn().mockResolvedValue(undefined),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(closeAnnouncements).mockResolvedValue(undefined);
    vi.mocked(pageShowsSignedIn).mockReturnValue(true);
  });

  it('第二次登录前站点接口和页面都说还在站内：停下说明退出没生效，不去填表单', async () => {
    vi.mocked(hasVisibleLoginPrompt).mockReturnValue(false);
    vi.mocked(readPageIdentity).mockResolvedValueOnce({ userId: '7', username: 'alice', source: 'api' });
    const host = makeHost();

    const result = await runTask(reloginTask(), host);

    expect(result).toBeNull();
    expect(host.needsUser).toHaveBeenCalledWith(expect.stringContaining('退出操作没有真正结束会话'), expect.any(Array));
    expect(fillCredentials).not.toHaveBeenCalled();
    expect(readPageIdentity).toHaveBeenCalledWith(expect.anything(), undefined, { serverOnly: true });
  });

  it('接口仍报有会话、页面却已没有站内证据（残留的旧令牌）：不拦下，照常第二次登录', async () => {
    vi.mocked(hasVisibleLoginPrompt).mockReturnValue(false);
    vi.mocked(pageShowsSignedIn).mockReturnValue(false);
    vi.mocked(readPageIdentity).mockResolvedValueOnce({ userId: '7', username: 'alice', source: 'api' });
    vi.mocked(fillCredentials).mockResolvedValue(false);
    const host = makeHost();

    await runTask(reloginTask(), host);

    expect(host.needsUser).not.toHaveBeenCalledWith(expect.stringContaining('退出操作没有真正结束会话'), expect.anything());
    expect(fillCredentials).toHaveBeenCalled();
  });

  it('登录页已摆出表单：不额外问身份接口，照常第二次登录', async () => {
    vi.mocked(hasVisibleLoginPrompt).mockReturnValue(true);
    vi.mocked(fillCredentials).mockResolvedValue(false);
    const host = makeHost();

    await runTask(reloginTask(), host);

    expect(readPageIdentity).not.toHaveBeenCalled();
    expect(fillCredentials).toHaveBeenCalled();
  });
});
