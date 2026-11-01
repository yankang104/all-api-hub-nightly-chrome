import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginTask } from '@/types';
import type { EngineHost } from './engine';

vi.mock('@/automation/login/steps', () => ({
  closeAnnouncements: vi.fn().mockResolvedValue(undefined),
  fillCredentials: vi.fn(), submitLogin: vi.fn(), verifyLogin: vi.fn(), clickOAuthButton: vi.fn(),
  detectManualLoginStep: vi.fn(), detectAlreadyLoggedIn: vi.fn().mockResolvedValue(true),
  hasVisibleLoginPrompt: vi.fn().mockReturnValue(false), pageShowsSignedIn: vi.fn().mockReturnValue(true),
  revealExternalLogin: vi.fn(), revealLoginForm: vi.fn(), waitForExternalLoginNavigation: vi.fn(),
}));
vi.mock('@/automation/checkin/checkin', () => ({ performCheckin: vi.fn(), isCurrentCheckinPage: vi.fn() }));
vi.mock('@/automation/shared/dom-utils', () => ({ sleep: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/automation/challenge/challenge', () => ({
  waitForChallenge: vi.fn().mockResolvedValue({ detected: false, resolved: true }),
  waitForManagedChallenge: vi.fn().mockResolvedValue({ detected: false, resolved: true }),
}));
vi.mock('@/automation/challenge/checkin-challenge', () => ({
  waitForCheckinChallenge: vi.fn().mockResolvedValue({ detected: false, resolved: true }),
}));
vi.mock('@/automation/login/identity', async () => {
  const actual = await vi.importActual<typeof import('@/automation/login/identity')>('@/automation/login/identity');
  return { ...actual, readPageIdentity: vi.fn(), readVisibleIdentity: vi.fn().mockReturnValue(null),
    findAccountOnPage: vi.fn().mockReturnValue(null),
    logoutSession: vi.fn().mockResolvedValue({ clearedKeys: 1, serverLogout: true, cookieMayRemain: false }) };
});
vi.mock('@/automation/shared/page-health', () => ({ detectPageAvailabilityIssue: vi.fn().mockReturnValue(null) }));

import { performCheckin } from '@/automation/checkin/checkin';
import { readPageIdentity, logoutSession } from '@/automation/login/identity';
import { hasVisibleLoginPrompt, pageShowsSignedIn } from '@/automation/login/steps';
import { waitForCheckinChallenge } from '@/automation/challenge/checkin-challenge';
import { waitForChallenge } from '@/automation/challenge/challenge';
import { runTask } from './engine';

const origin = location.origin;
function task(overrides: Partial<LoginTask> = {}): LoginTask {
  return {
    tabId: 1, runId: 'workflow-run', accountId: 'alice', siteId: 'runtime', username: 'alice', password: 'sentinel',
    effectiveLoginMethod: 'form', effectiveCheckinMethod: 'workflow', accountIdentityUserId: '101',
    siteAccountCount: 2, identityConfirmed: true,
    site: { id: 'runtime', name: '运行时验收', loginUrl: `${origin}/login`, loginMethod: 'form',
      selectors: { username: '#username', password: '#password', submit: '#submit' }, closeModalSelectors: [],
      checkin: { method: 'workflow', workflow: { route: ['/profile', '/checkin'], identityPath: '/profile',
        steps: [{ type: 'click', selector: '#checkin' }] } } },
    createdAt: Date.now(), stage: 'checkin', steps: ['个人资料身份已核验:'], ...overrides,
  };
}
function host(): EngineHost {
  return { markStage: vi.fn(), navigate: vi.fn(), needsUser: vi.fn(), confirmIdentity: vi.fn(), saveIdentity: vi.fn(),
    clearSiteCookies: vi.fn().mockResolvedValue({ cleared: 1, clearedKeys: [], cookieMayRemain: false, domainCount: 1 }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  history.replaceState({}, '', '/checkin');
  vi.mocked(hasVisibleLoginPrompt).mockReturnValue(false);
  vi.mocked(pageShowsSignedIn).mockReturnValue(true);
  vi.mocked(readPageIdentity).mockResolvedValue({ userId: '101', username: 'alice', source: 'api' });
  vi.mocked(waitForCheckinChallenge).mockReset().mockResolvedValue({ detected: false, resolved: true });
  vi.mocked(waitForChallenge).mockReset().mockResolvedValue({ detected: false, resolved: true });
  vi.mocked(performCheckin).mockImplementation(async (_site, _log, hooks) => {
    const interrupted = await hooks?.workflowCheckpoint?.({ phase: 'action', step: { type: 'click', selector: '#checkin' } });
    return interrupted ?? { status: 'success', message: '目标账号签到成功' };
  });
});
afterEach(() => { vi.restoreAllMocks(); history.replaceState({}, '', '/'); });

describe('学习签到运行时的会话检查', () => {
  it.each(['before', 'waiting', 'after', 'result'] as const)('%s 检查保留签到验证就绪调度，通过后直接接续，不新增转人工', async (phase) => {
    vi.mocked(waitForCheckinChallenge).mockResolvedValue({ detected: true, resolved: true, kind: 'Arithmetic' });
    vi.mocked(performCheckin).mockImplementation(async (_site, _log, hooks) =>
      await hooks?.workflowCheckpoint?.({ phase, step: { type: 'click', selector: '#checkin' } })
        ?? { status: 'success', message: '自动验证通过后继续签到' });
    const h = host();
    expect(await runTask(task(), h)).toMatchObject({ ok: true, message: '自动验证通过后继续签到' });
    expect(waitForCheckinChallenge).toHaveBeenCalledWith(expect.any(Object), expect.any(Function), expect.any(Number), 0);
    expect(waitForChallenge).not.toHaveBeenCalled();
    expect(h.needsUser).not.toHaveBeenCalled();
    expect(logoutSession).not.toHaveBeenCalled();
  });

  it('原验证处理器尚未完成时保留当前调用，完成后自动继续，不要求重新发起', async () => {
    let finish!: () => void;
    let started!: () => void;
    const verificationStarted = new Promise<void>((resolve) => { started = resolve; });
    const verificationFinished = new Promise<void>((resolve) => { finish = resolve; });
    vi.mocked(waitForCheckinChallenge).mockImplementation(async () => {
      started();
      await verificationFinished;
      return { detected: true, resolved: true, kind: 'Turnstile' };
    });
    vi.mocked(performCheckin).mockImplementation(async (_site, _log, hooks) =>
      await hooks?.workflowCheckpoint?.({ phase: 'waiting' })
        ?? { status: 'success', message: '同一任务继续签到' });
    const h = host();
    const pending = runTask(task(), h);
    await verificationStarted;
    expect(h.needsUser).not.toHaveBeenCalled();
    expect(h.navigate).not.toHaveBeenCalled();
    finish();
    expect(await pending).toMatchObject({ ok: true, message: '同一任务继续签到' });
    expect(performCheckin).toHaveBeenCalledOnce();
  });

  it('新增环境检查不能把原验证器的失败擅自改成转人工状态', async () => {
    vi.mocked(waitForCheckinChallenge).mockResolvedValue({ detected: true, resolved: false, kind: 'Slider', error: '原自动验证未通过' });
    vi.mocked(performCheckin).mockImplementation(async (_site, _log, hooks) => {
      const result = await hooks?.workflowCheckpoint?.({ phase: 'before' });
      expect(result).toEqual({ status: 'interrupted', message: '原自动验证未通过', terminal: true });
      return result ?? { status: 'success', message: '不应执行' };
    });
    const h = host();
    expect(await runTask(task(), h)).toMatchObject({ ok: false, message: '原自动验证未通过' });
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.needsUser).not.toHaveBeenCalled();
  });

  it('账号一致时直接执行，不退出、不重复登录', async () => {
    const h = host();
    expect(await runTask(task(), h)).toMatchObject({ ok: true });
    expect(logoutSession).not.toHaveBeenCalled();
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.needsUser).not.toHaveBeenCalled();
    expect(readPageIdentity).toHaveBeenCalledWith(expect.anything(), undefined,
      expect.objectContaining({ serverOnly: true }));
  });

  /**
   * 身份接口 401 **不能**触发重登。
   *
   * 实测 8 个 new-api 分叉：身份接口只认 Authorization: Bearer，用 cookie 问必然
   * 401，而页面可能正停在已登录的资料页上。早先按响应体措辞逐站补正则追不完，
   * 这条证据已整体移除。掉线只认页面形态（登录表单 / 登录路由）。
   */
  it('身份接口读不到（401）不算掉线，不触发重登', async () => {
    vi.mocked(readPageIdentity).mockResolvedValue(null);
    const h = host();
    expect(await runTask(task(), h)).toMatchObject({ ok: true });
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it('页面确实回到登录表单时才重登（这是唯一可靠的掉线证据）', async () => {
    vi.mocked(hasVisibleLoginPrompt).mockReturnValue(true);
    vi.mocked(pageShowsSignedIn).mockReturnValue(false);
    vi.mocked(readPageIdentity).mockResolvedValue(null);
    const h = host();
    expect(await runTask(task(), h)).toBeNull();
    expect(h.navigate).toHaveBeenCalledWith(expect.stringContaining('/login'),
      expect.arrayContaining([expect.stringMatching(/^学习流程恢复登录: 1\/2/)]), 'login');
  });

  it('接口暂时不可用但没有明确未认证证据时，不凭空清会话', async () => {
    vi.mocked(readPageIdentity).mockResolvedValue(null);
    const h = host();
    expect(await runTask(task(), h)).toMatchObject({ ok: true });
    expect(logoutSession).not.toHaveBeenCalled();
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it('旧身份标记存在但服务端已换号时，退出并返回目标账号登录', async () => {
    vi.mocked(readPageIdentity).mockResolvedValue({ userId: '202', username: 'bob', source: 'api' });
    const h = host();
    expect(await runTask(task(), h)).toBeNull();
    expect(logoutSession).toHaveBeenCalledOnce();
    expect(h.navigate).toHaveBeenCalledWith(`${origin}/login`, expect.any(Array), 'login');
    expect(h.saveIdentity).not.toHaveBeenCalled();
  });

  it('跨文档被送回登录页时恢复登录，不再沿旧路线反复跳签到页', async () => {
    history.replaceState({}, '', '/login');
    vi.mocked(hasVisibleLoginPrompt).mockReturnValue(true);
    vi.mocked(pageShowsSignedIn).mockReturnValue(false);
    vi.mocked(readPageIdentity).mockResolvedValue(null);
    const h = host();
    expect(await runTask(task(), h)).toBeNull();
    expect(performCheckin).not.toHaveBeenCalled();
    expect(h.navigate).toHaveBeenCalledWith(`${origin}/login`, expect.arrayContaining([
      expect.stringMatching(/^学习流程恢复登录: 1\/2/),
    ]), 'login');
  });

  it('会话恢复次数跨页面累计，到上限停止循环并说明原因', async () => {
    history.replaceState({}, '', '/login');
    vi.mocked(pageShowsSignedIn).mockReturnValue(false);
    vi.mocked(readPageIdentity).mockResolvedValue(null);
    const h = host();
    expect(await runTask(task({ steps: ['学习流程恢复登录: 1/2', '学习流程恢复登录: 2/2'] }), h))
      .toMatchObject({ ok: false, message: expect.stringContaining('自动恢复 2 次') });
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.needsUser).not.toHaveBeenCalled();
  });

  it('普通 OAuth 无可用切号凭据时保留会话并等待确认，绝不盲签', async () => {
    vi.mocked(readPageIdentity).mockResolvedValue({ userId: '202', username: 'bob', source: 'api' });
    const h = host();
    expect(await runTask(task({ effectiveLoginMethod: 'oauth' }), h)).toBeNull();
    expect(logoutSession).not.toHaveBeenCalled();
    expect(h.needsUser).toHaveBeenCalledWith(expect.stringContaining('当前登录的不是账号 alice'), expect.any(Array));
  });
});
