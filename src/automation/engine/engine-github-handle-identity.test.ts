import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginTask } from '@/types';
import type { EngineHost } from '@/automation/engine/engine';

/**
 * CottonAPI 实测形态：GitHub 登录的站点，资料页只显示 GitHub 句柄（demo-github）与
 * 站点用户 ID 940，从不显示扩展里填的账号名（demo104）。
 *
 * 旧行为：一律判「只读到第三方句柄」→ 停机要人工，日志还被诊断成「站点弹出了验证码」。
 * 新行为（只对**受管 GitHub**，即账号保存了 GitHub 用户名和密码）：
 *  - 本轮刚在 github.com 用保存的凭据亲自登录过 → 句柄就是本账号的，记住用户 ID 并签到；
 *  - 本轮沿用的是浏览器里已有的 GitHub 会话 → 退出 GitHub，用保存的凭据重新登录；
 *  - 用户 ID 与本站其它账号冲突 → 无论如何都不放行。
 */
vi.mock('@/automation/login/steps', () => ({
  closeAnnouncements: vi.fn().mockResolvedValue(undefined),
  fillCredentials: vi.fn(),
  submitLogin: vi.fn(),
  verifyLogin: vi.fn().mockResolvedValue(true),
  clickOAuthButton: vi.fn(),
  detectManualLoginStep: vi.fn(),
  detectAlreadyLoggedIn: vi.fn().mockResolvedValue(true),
  hasVisibleLoginPrompt: vi.fn().mockReturnValue(true),
  pageShowsSignedIn: vi.fn().mockReturnValue(true),
  revealExternalLogin: vi.fn(),
  revealLoginForm: vi.fn(),
  waitForExternalLoginNavigation: vi.fn(),
}));

vi.mock('@/automation/checkin/checkin', () => ({
  performCheckin: vi.fn().mockResolvedValue({ status: 'success', message: '签到完成' }),
  isCurrentCheckinPage: vi.fn().mockReturnValue(false),
}));
vi.mock('@/automation/checkin/checkin-entry', () => ({ prepareCheckinEntry: vi.fn() }));
vi.mock('@/automation/shared/dom-utils', () => ({ sleep: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/automation/challenge/challenge', () => ({
  waitForChallenge: vi.fn().mockResolvedValue({ detected: false, resolved: true }),
  waitForManagedChallenge: vi.fn().mockResolvedValue({ detected: false, resolved: true }),
}));
vi.mock('@/automation/challenge/checkin-challenge', () => ({
  waitForCheckinChallenge: vi.fn().mockResolvedValue({ detected: false, resolved: true }),
}));
vi.mock('@/automation/shared/page-health', () => ({ detectPageAvailabilityIssue: vi.fn().mockReturnValue(null) }));
vi.mock('@/automation/login/identity', () => ({
  findAccountOnPage: vi.fn().mockReturnValue(null),
  injectToken: vi.fn(),
  logoutSession: vi.fn().mockResolvedValue({ clearedKeys: 0, serverLogout: false, cookieMayRemain: false }),
  readPageIdentity: vi.fn(),
  readVisibleIdentity: vi.fn(),
  verifyIdentity: vi.fn(),
}));
vi.mock('@/automation/login/token-refresh', () => ({ ensureFreshToken: vi.fn() }));

import { performCheckin } from '@/automation/checkin/checkin';
import { logoutSession, readPageIdentity, readVisibleIdentity, verifyIdentity } from '@/automation/login/identity';
import { runTask } from '@/automation/engine/engine';

const ORIGIN = window.location.origin;
const HANDLE = { userId: '940', username: 'demo-github', source: 'visible' as const };
const HANDLE_VERDICT = { match: 'mismatch' as const, detail: '当前登录的是 demo-github（读自页面），本次要签到的是 demo104' };

function cottonTask(overrides: Partial<LoginTask> = {}): LoginTask {
  return {
    tabId: 1,
    runId: 'run-cotton',
    accountId: 'demo104',
    siteId: 'cotton',
    username: 'demo104',
    password: '',
    githubUsername: '330627052@qq.com',
    githubPassword: 'fixture-github-password',
    effectiveLoginMethod: 'github',
    effectiveCheckinMethod: 'workflow',
    siteAccountCount: 2,
    site: {
      id: 'cotton',
      name: 'CottonAPI',
      loginUrl: `${ORIGIN}/login`,
      loginMethod: 'github',
      selectors: { username: '#u', password: '#p', submit: '#s' },
      closeModalSelectors: [],
      checkin: {
        method: 'workflow',
        workflow: { steps: [{ type: 'click', selector: '#checkin' }], route: ['/profile'], identityPath: '/profile' },
      },
    },
    createdAt: Date.now(),
    stage: 'checkin',
    ...overrides,
  };
}

function host(): EngineHost & { startGithubLogout: ReturnType<typeof vi.fn> } {
  return {
    markStage: vi.fn().mockResolvedValue(undefined),
    navigate: vi.fn().mockResolvedValue(undefined),
    needsUser: vi.fn().mockResolvedValue(undefined),
    confirmIdentity: vi.fn().mockResolvedValue(undefined),
    saveIdentity: vi.fn().mockResolvedValue(undefined),
    clearSiteCookies: vi.fn().mockResolvedValue({ cleared: 1, clearedKeys: [], cookieMayRemain: false, domainCount: 1 }),
    startGithubLogout: vi.fn().mockResolvedValue(undefined),
  };
}

describe('GitHub 登录站点只显示第三方句柄（CottonAPI 形态）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    history.replaceState({}, '', '/profile');
    vi.mocked(performCheckin).mockResolvedValue({ status: 'success', message: '签到完成' });
    vi.mocked(readPageIdentity).mockResolvedValue(HANDLE);
    vi.mocked(readVisibleIdentity).mockReturnValue(HANDLE);
    vi.mocked(verifyIdentity).mockReturnValue(HANDLE_VERDICT);
    // sleep 是假的；推进时钟让资料页等待按真实超时收敛。
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => { now += 13_000; return now; });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    history.replaceState({}, '', '/');
  });

  it('本轮刚用保存的 GitHub 凭据登录过：页面句柄用于本轮核对并签到，不保存弱身份', async () => {
    const h = host();
    const result = await runTask(cottonTask({ githubCredentialsSubmitted: true }), h);

    expect(result).toMatchObject({ ok: true, message: '签到完成' });
    expect(h.saveIdentity).not.toHaveBeenCalled();
    expect(h.confirmIdentity).toHaveBeenCalled();
    expect(h.needsUser).not.toHaveBeenCalled();
    expect(h.startGithubLogout).not.toHaveBeenCalled();
    expect(performCheckin).toHaveBeenCalledOnce();
  });

  it('本轮沿用浏览器里已有的 GitHub 会话：退出 GitHub，用保存的凭据重新登录', async () => {
    const h = host();
    const result = await runTask(cottonTask(), h);

    expect(result).toBeNull();
    expect(logoutSession).toHaveBeenCalledOnce();
    expect(h.startGithubLogout).toHaveBeenCalledOnce();
    expect(h.needsUser).not.toHaveBeenCalled();
    expect(performCheckin).not.toHaveBeenCalled();
    expect(h.saveIdentity).not.toHaveBeenCalled();
  });

  it('已经换过一次号仍然确认不了：停下来交给用户，不再无限换号', async () => {
    const h = host();
    const result = await runTask(cottonTask({ steps: ['自动切换 GitHub 账号: 已退出站点账号，正在退出当前 GitHub 会话'] }), h);

    expect(result).toBeNull();
    expect(h.startGithubLogout).not.toHaveBeenCalled();
    expect(h.needsUser).toHaveBeenCalledOnce();
    expect(performCheckin).not.toHaveBeenCalled();
  });

  it('读到的用户 ID 属于本站另一个账号：即使本轮亲自登录过也绝不放行', async () => {
    const h = host();
    const result = await runTask(cottonTask({
      githubCredentialsSubmitted: true,
      siteAccountUserIds: { '940': 'other-account' },
    }), h);

    expect(result === null || result.ok === false).toBe(true);
    expect(performCheckin).not.toHaveBeenCalled();
    expect(h.saveIdentity).not.toHaveBeenCalled();
  });

  it('没有保存 GitHub 凭据（普通 OAuth）：无法自己核实，照旧交给用户', async () => {
    const h = host();
    const result = await runTask(cottonTask({
      effectiveLoginMethod: 'oauth',
      githubUsername: undefined,
      githubPassword: undefined,
      githubCredentialsSubmitted: true,
    }), h);

    expect(result).toBeNull();
    expect(h.needsUser).toHaveBeenCalledOnce();
    expect(performCheckin).not.toHaveBeenCalled();
    expect(h.saveIdentity).not.toHaveBeenCalled();
  });
});
