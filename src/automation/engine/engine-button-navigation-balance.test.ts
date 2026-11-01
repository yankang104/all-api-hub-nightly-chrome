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
  readPageIdentity: vi.fn().mockResolvedValue(null),
  readVisibleIdentity: vi.fn().mockReturnValue(null),
  verifyIdentity: vi.fn().mockReturnValue({ match: 'unknown', detail: '读不到当前登录身份' }),
}));

vi.mock('@/automation/login/token-refresh', () => ({
  ensureFreshToken: vi.fn(),
}));

import { performCheckin } from '@/automation/checkin/checkin';
import { detectAlreadyLoggedIn, verifyLogin } from '@/automation/login/steps';
import { verifyIdentity } from '@/automation/login/identity';
import { runTask } from '@/automation/engine/engine';

const before: BalanceSnapshot = {
  quota: 1476,
  usedQuota: 0,
  symbol: '积分',
  at: 1,
  fromVisibleText: true,
};

function resumedButtonTask(): LoginTask {
  return {
    tabId: 23,
    runId: 'run-linux-sb-button',
    accountId: 'account-linux-sb',
    siteId: 'site-linux-sb',
    username: '袁天罡',
    password: 'secret',
    effectiveLoginMethod: 'form',
    effectiveCheckinMethod: 'button',
    siteAccountCount: 2,
    identityConfirmed: true,
    site: {
      id: 'site-linux-sb',
      name: 'Linux.SB',
      loginUrl: `${window.location.origin}/login`,
      loginMethod: 'form',
      selectors: { username: '#login', password: '#password', submit: 'button[type="submit"]' },
      closeModalSelectors: [],
      checkin: {
        method: 'button',
        url: '/daily_checkin',
        buttonSelector: '.daily-checkin-page-action button',
        alreadySelector: '.daily-checkin-done',
      },
    },
    createdAt: Date.now(),
    stage: 'checkin',
    context: { balanceBefore: before, buttonCheckinPending: true },
  };
}

describe('engine button 跨页余额上下文', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(performCheckin).mockReset();
    vi.mocked(detectAlreadyLoggedIn).mockResolvedValue(false);
    vi.mocked(verifyLogin).mockResolvedValue(true);
    vi.mocked(verifyIdentity).mockReturnValue({ match: 'unknown', detail: '读不到当前登录身份' });
  });

  it('把重载任务的旧基线交给 checkin，并把新点击保存钩子接回 host', async () => {
    const saveButtonBalanceBefore = vi.fn().mockResolvedValue(undefined);
    vi.mocked(performCheckin).mockImplementation(async (_site, _log, hooks) => {
      if (!hooks) throw new Error('缺少签到钩子');
      expect(hooks.buttonBalanceBefore).toEqual(before);
      await hooks.saveButtonBalanceBefore?.(before);
      return { status: 'success', message: '签到按钮提交后页面显示已完成' };
    });
    const host: EngineHost = {
      markStage: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
      needsUser: vi.fn().mockResolvedValue(undefined),
      saveButtonBalanceBefore,
    };

    const result = await runTask(resumedButtonTask(), host);

    expect(result).toMatchObject({ ok: true, message: '签到按钮提交后页面显示已完成' });
    expect(saveButtonBalanceBefore).toHaveBeenCalledOnce();
    expect(saveButtonBalanceBefore).toHaveBeenCalledWith(before);
  });

  it('没有 pending 标记时不向 checkin 暴露普通 balanceBefore', async () => {
    const task = resumedButtonTask();
    task.context = { balanceBefore: before };
    vi.mocked(performCheckin).mockImplementation(async (_site, _log, hooks) => {
      if (!hooks) throw new Error('缺少签到钩子');
      expect(hooks.buttonBalanceBefore).toBeUndefined();
      return { status: 'already', message: '页面显示今日已签到' };
    });
    const host: EngineHost = {
      markStage: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
      needsUser: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runTask(task, host);

    expect(result).toMatchObject({ ok: true, message: '页面显示今日已签到' });
  });
});

function loginCheckinTask(stage: 'login' | 'verify'): LoginTask {
  return {
    tabId: 31,
    runId: 'run-anyrouter-login-balance',
    accountId: 'account-anyrouter',
    siteId: 'builtin-anyrouter',
    username: 'fzy520',
    password: 'secret',
    effectiveLoginMethod: 'form',
    effectiveCheckinMethod: 'none',
    siteAccountCount: 1,
    site: {
      id: 'builtin-anyrouter',
      name: 'AnyRouter',
      loginUrl: `${window.location.origin}/login`,
      loginMethod: 'form',
      selectors: { username: '#username', password: '#password', submit: 'button[type="submit"]' },
      closeModalSelectors: [],
      checkin: { method: 'none' },
      adapter: { family: 'new-api', checkinPath: '', quotaPerUnit: 500_000 },
    },
    createdAt: Date.now(),
    stage,
    context: { loginCheckinBalanceBefore: before },
  };
}

describe('engine 登录即签到余额上下文', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(performCheckin).mockReset();
    vi.mocked(detectAlreadyLoggedIn).mockResolvedValue(false);
    vi.mocked(verifyLogin).mockResolvedValue(true);
    vi.mocked(verifyIdentity).mockReturnValue({ match: 'unknown', detail: '读不到当前登录身份' });
  });

  it('本轮表单登录回跳确认后才把历史账号余额交给 none 流程', async () => {
    vi.mocked(performCheckin).mockImplementation(async (_site, _log, hooks) => {
      expect(hooks?.loginCheckinBalanceBefore).toEqual(before);
      expect(hooks?.buttonBalanceBefore).toBeUndefined();
      return { status: 'success', message: '登录即签到' };
    });
    const host: EngineHost = {
      markStage: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
      needsUser: vi.fn().mockResolvedValue(undefined),
      confirmIdentity: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runTask(loginCheckinTask('verify'), host);

    expect(result).toMatchObject({ ok: true, message: '登录即签到' });
    expect(performCheckin).toHaveBeenCalledOnce();
  });

  it('打开时已有登录态不会把历史变化冒充成本轮登录奖励', async () => {
    vi.mocked(detectAlreadyLoggedIn).mockResolvedValue(true);
    vi.mocked(verifyIdentity).mockReturnValue({ match: 'confirmed', detail: '账号一致' });
    vi.mocked(performCheckin).mockImplementation(async (_site, _log, hooks) => {
      expect(hooks?.loginCheckinBalanceBefore).toBeUndefined();
      // runCheckin() 无参：本轮没登录，标记必须是 false，不能靠页面登录态推断
      expect(hooks?.loginHappenedThisRun).toBe(false);
      // 本轮有真按钮时仍照常点按并成功；这条只锁「无登录动作」时的注入面
      return { status: 'success', message: '登录即签到' };
    });
    const host: EngineHost = {
      markStage: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
      needsUser: vi.fn().mockResolvedValue(undefined),
      confirmIdentity: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runTask(loginCheckinTask('login'), host);

    expect(result).toMatchObject({ ok: true, message: '登录即签到' });
    expect(performCheckin).toHaveBeenCalledOnce();
  });

  it('本轮登录成功后进入 none 时注入真实登录标记', async () => {
    vi.mocked(performCheckin).mockImplementation(async (_site, _log, hooks) => {
      expect(hooks?.loginHappenedThisRun).toBe(true);
      expect(hooks?.loginCheckinBalanceBefore).toEqual(before);
      return { status: 'success', message: '登录即签到' };
    });
    const host: EngineHost = {
      markStage: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
      needsUser: vi.fn().mockResolvedValue(undefined),
      confirmIdentity: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runTask(loginCheckinTask('verify'), host);

    expect(result).toMatchObject({ ok: true, message: '登录即签到' });
  });

  it('打开时已登录导致 none 无法确认时，措辞点名「本轮没有重新登录」并转「需处理」', async () => {
    vi.mocked(detectAlreadyLoggedIn).mockResolvedValue(true);
    vi.mocked(verifyIdentity).mockReturnValue({ match: 'confirmed', detail: '账号一致' });
    vi.mocked(performCheckin).mockImplementation(async (_site, _log, hooks) => {
      expect(hooks?.loginHappenedThisRun).toBe(false);
      return {
        status: 'unverified',
        message: '当前页没有签到控件，且本轮没有发生登录动作：无法确认「登录即签到」已完成',
      };
    });
    const needsUser = vi.fn().mockResolvedValue(undefined);
    const host: EngineHost = {
      markStage: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
      needsUser,
      confirmIdentity: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runTask(loginCheckinTask('login'), host);

    // 不返回 ok:true 的 TaskResult，而是把结论交给用户确认
    expect(result).toBeNull();
    expect(needsUser).toHaveBeenCalledOnce();
    const [message] = needsUser.mock.calls[0]!;
    expect(message).toContain('打开时已登录');
    expect(message).toContain('本轮没有重新登录');
    expect(message).toContain('本轮没有发生登录动作');
    expect(message).toContain('若确认今天的额度已经到账，可在账号行手动标记完成');
    // 不能把「本轮登录过」的措辞套到「打开时已登录」这一支
    expect(message).not.toContain('本轮已登录');
  });

  it('本轮已登录但没有签到证据时，措辞说明本轮确实登录过并给出去查余额的下一步', async () => {
    // 走 verify 阶段：本轮表单登录回跳确认后 runCheckin(true)
    vi.mocked(performCheckin).mockImplementation(async (_site, _log, hooks) => {
      expect(hooks?.loginHappenedThisRun).toBe(true);
      return {
        status: 'unverified',
        message: '当前页没有签到控件，且没有余额入账或页面证据可确认「登录即签到」，无法确认本次签到',
      };
    });
    const needsUser = vi.fn().mockResolvedValue(undefined);
    const host: EngineHost = {
      markStage: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
      needsUser,
      confirmIdentity: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runTask(loginCheckinTask('verify'), host);

    expect(result).toBeNull();
    expect(needsUser).toHaveBeenCalledOnce();
    const [message] = needsUser.mock.calls[0]!;
    expect(message).toContain('本轮已登录');
    expect(message).toContain('没有签到动作可确认');
    expect(message).toContain('可确认「登录即签到」');
    expect(message).toContain('无法确认本次签到');
    expect(message).toContain('请打开该站点标签页确认余额是否已经增加');
    // 不能把「打开时已登录」的措辞套到本轮确实登录过这一支
    expect(message).not.toContain('打开时已登录');
  });
});
