/**
 * 签到成功后「今日奖励」能落到余额记录。
 *
 * 用户报：日志写着「今日签到记录奖励 $0.28」，但余额记录那天还是 $0.00。
 * 根因：落盘 `daily.checkinReward` 的唯一通道是 `REFRESH_BALANCE`，而 workflow
 * 签到成功后从没触发它。新增的 `saveCheckinReward` 钩子在 `engine.ts::settle`
 * 里、成功/已签到时 fire-and-forget 调用 —— 这里验证那调起了。
 *
 * mock 形状抄自 engine-button-navigation-balance.test.ts（那是已有的、过的 engine
 * test），不重复发明一套。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineHost } from '@/automation/engine/engine';
import type { LoginTask } from '@/types';
import { runTask } from '@/automation/engine/engine';

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
  logoutSession: vi.fn().mockResolvedValue({ cookieMayRemain: false, cleared: 0 }),
  readPageIdentity: vi.fn().mockResolvedValue(null),
  readVisibleIdentity: vi.fn().mockReturnValue(null),
  verifyIdentity: vi.fn().mockReturnValue({ match: 'unknown', detail: '读不到当前登录身份' }),
}));

vi.mock('@/automation/login/token-refresh', () => ({
  ensureFreshToken: vi.fn(),
}));

vi.mock('@/automation/shared/announcements', () => ({
  closeAnnouncements: vi.fn().mockResolvedValue({ closed: 0, blocked: false }),
}));

import { performCheckin } from '@/automation/checkin/checkin';
import { detectAlreadyLoggedIn, verifyLogin } from '@/automation/login/steps';

const SITE = {
  id: 'st-reward',
  name: '奖励落盘站',
  url: 'https://example.com',
  loginUrl: 'https://example.com/login',
  loginMethod: 'form',
  checkin: { method: 'button' as const, url: '/profile' },
  selectors: { username: '#u', password: '#p', submit: '#s' },
  closeModalSelectors: [],
  adapter: { family: 'new-api', checkinPath: '/profile', quotaPerUnit: 500_000 },
} as const as LoginTask['site'];

function taskWith(stage: LoginTask['stage']): LoginTask {
  return {
    accountId: 'acc-1',
    siteId: SITE.id,
    site: SITE,
    username: 'tester',
    stage,
    createdAt: Date.now(),
    runId: 'run-reward',
    tabId: 23,
    password: 'secret',
    effectiveLoginMethod: 'form',
    effectiveCheckinMethod: 'button',
    siteAccountCount: 1,
    identityConfirmed: true,
  };
}

describe('engine 签到成功后落盘今日奖励', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(performCheckin).mockReset();
    vi.mocked(detectAlreadyLoggedIn).mockResolvedValue(false);
    vi.mocked(verifyLogin).mockResolvedValue(true);
  });

  it('签到成功时调 saveCheckinReward，把页面正文交上落盘', async () => {
    vi.mocked(performCheckin).mockResolvedValue({
      status: 'success',
      message: '签到成功',
      metrics: { verdict: 'rewarded', source: 'visible-reward', reward: 0.28, rewardSymbol: '$', quotaAfter: 4.77, balanceSymbol: '$' },
    });
    const saveCheckinReward = vi.fn().mockResolvedValue(undefined);
    const host: EngineHost = {
      markStage: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
      needsUser: vi.fn().mockResolvedValue(undefined),
      saveCheckinReward,
    };

    const result = await runTask(taskWith('checkin'), host);

    expect(result).toMatchObject({ ok: true });
    expect(saveCheckinReward).toHaveBeenCalledTimes(1);
    const bodyText = saveCheckinReward.mock.calls[0]?.[0];
    expect(typeof bodyText).toBe('string');
  });

  it('签到失败（没到签到页）时不落盘奖励', async () => {
    vi.mocked(performCheckin).mockResolvedValue({ status: 'failed', message: '没到签到页' });
    const saveCheckinReward = vi.fn().mockResolvedValue(undefined);
    const host: EngineHost = {
      markStage: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
      needsUser: vi.fn().mockResolvedValue(undefined),
      saveCheckinReward,
    };

    await runTask(taskWith('checkin'), host);

    expect(saveCheckinReward).not.toHaveBeenCalled();
  });
});
