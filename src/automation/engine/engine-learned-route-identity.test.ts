import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginTask } from '@/types';
import type { EngineHost } from '@/automation/engine/engine';

/**
 * P1-A：把「已登录 → 进资料页核对账号 → 不符退出重登」这段内含逻辑接到
 * **学习出来的工作流站点**上。
 *
 * 学习产物是 `method:'workflow'` + `route`，没有 `entry`。独立的资料页身份路径
 * 与签到终点分开。修复前，引擎在已登录分支只对「有 entry」的站点跳过落地页决策，
 * 工作流站点会在落地页（多半是仪表盘、读不到身份）就地跑 decideIdentityAction，
 * 于是 unknown + 多账号被误判成重登或停机要人工 —— 而其实沿 route 跳一页就能核对。
 *
 * 用例锁住：非身份页不提前决策；资料页必须先通过身份核验；直达签到终点时
 * 回到资料页；没有独立资料页时安全停机。
 */
vi.mock('@/automation/login/steps', () => ({
  closeAnnouncements: vi.fn().mockResolvedValue(undefined),
  fillCredentials: vi.fn(),
  submitLogin: vi.fn(),
  verifyLogin: vi.fn(),
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

vi.mock('@/automation/checkin/checkin-entry', () => ({
  prepareCheckinEntry: vi.fn(),
}));

vi.mock('@/automation/shared/dom-utils', () => ({ sleep: vi.fn().mockResolvedValue(undefined) }));

vi.mock('@/automation/challenge/challenge', () => ({
  waitForChallenge: vi.fn().mockResolvedValue({ detected: false, resolved: true }),
  waitForManagedChallenge: vi.fn().mockResolvedValue({ detected: false, resolved: true }),
}));

vi.mock('@/automation/challenge/checkin-challenge', () => ({
  waitForCheckinChallenge: vi.fn().mockResolvedValue({ detected: false, resolved: true }),
}));

vi.mock('@/automation/shared/page-health', () => ({
  detectPageAvailabilityIssue: vi.fn().mockReturnValue(null),
}));

vi.mock('@/automation/login/identity', () => ({
  findAccountOnPage: vi.fn().mockReturnValue(null),
  injectToken: vi.fn(),
  logoutSession: vi.fn().mockResolvedValue({ clearedKeys: 0, serverLogout: false, cookieMayRemain: false }),
  readPageIdentity: vi.fn().mockResolvedValue(null),
  readVisibleIdentity: vi.fn().mockReturnValue(null),
  verifyIdentity: vi.fn().mockReturnValue({ match: 'unknown', detail: '读不到当前登录身份' }),
}));

vi.mock('@/automation/login/token-refresh', () => ({ ensureFreshToken: vi.fn() }));

import { performCheckin } from '@/automation/checkin/checkin';
import { prepareCheckinEntry } from '@/automation/checkin/checkin-entry';
import { verifyLogin } from '@/automation/login/steps';
import { logoutSession, readPageIdentity, verifyIdentity } from '@/automation/login/identity';
import { runCheckinWorkflow } from '@/automation/learning/workflow';
import { runTask } from '@/automation/engine/engine';

const ORIGIN = window.location.origin;

function learnedTask(overrides: Partial<LoginTask> = {}, method: 'workflow' | 'auto' = 'workflow'): LoginTask {
  return {
    tabId: 1,
    runId: 'run-learned',
    accountId: 'account-1',
    siteId: 'site-1',
    username: 'alice',
    password: 'secret',
    effectiveLoginMethod: 'form',
    effectiveCheckinMethod: method,
    // 多账号：这正是修复前会在落地页误触发重登/停机的条件
    siteAccountCount: 2,
    site: {
      id: 'site-1',
      name: 'Learned Fixture',
      loginUrl: `${ORIGIN}/sign-in`,
      loginMethod: 'form',
      selectors: { username: '#u', password: '#p', submit: '#s' },
      closeModalSelectors: [],
      checkin: {
        method,
        workflow: {
          steps: [{ type: 'click', selector: '#checkin' }],
          route: ['/sign-in', '/profile', '/check-in'],
          identityPath: '/profile',
        },
      },
    },
    createdAt: Date.now(),
    stage: 'login',
    ...overrides,
  };
}

describe.each(['workflow'] as const)('%s 学习站点：沿 route 进资料页核对账号', (method) => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerText = '';
    vi.mocked(performCheckin).mockReset();
    vi.mocked(performCheckin).mockResolvedValue({ status: 'success', message: '签到完成' });
    vi.mocked(readPageIdentity).mockResolvedValue(null);
    vi.mocked(verifyIdentity).mockReturnValue({ match: 'unknown', detail: '读不到当前登录身份' });
    vi.mocked(verifyLogin).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    history.replaceState({}, '', '/');
  });

  it('auto 带旧 route 但无 identityPath：表单登录成功后自主签到，不强制进入学习身份页', async () => {
    history.replaceState({}, '', '/dashboard/overview');
    vi.mocked(readPageIdentity).mockResolvedValue({ userId: '42', username: 'alice', source: 'api' });
    vi.mocked(verifyIdentity).mockReturnValue({ match: 'confirmed', detail: '账号一致' });
    const task = learnedTask({ stage: 'verify' }, 'auto');
    delete task.site.checkin!.workflow!.identityPath;
    const host: EngineHost = {
      markStage: vi.fn(), navigate: vi.fn(), needsUser: vi.fn(), confirmIdentity: vi.fn(), saveIdentity: vi.fn(),
    };
    const result = await runTask(task, host);
    expect(result).toMatchObject({ ok: true });
    expect(host.needsUser).not.toHaveBeenCalled();
    expect(host.navigate).not.toHaveBeenCalled();
    expect(performCheckin).toHaveBeenCalledOnce();
    expect(vi.mocked(performCheckin).mock.calls[0]?.[0].checkin?.method).toBe('auto');
    expect(result?.steps).not.toContain('学习签到路线缺少身份核验页');
  });

  it('落在非终点页（仪表盘）时不清 Cookie、不停机要人工，直接交给 runCheckin 走 route', async () => {
    history.replaceState({}, '', '/dashboard/overview');
    const host: EngineHost = {
      markStage: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
      needsUser: vi.fn().mockResolvedValue(undefined),
      clearSiteCookies: vi.fn().mockResolvedValue({
        cleared: 0, clearedKeys: [], cookieMayRemain: false, domainCount: 1,
      }),
    };

    const result = await runTask(learnedTask({}, method), host);

    // 关键：修复前这里会因 unknown + 多账号在落地页做出重登/停机决策
    expect(host.needsUser).not.toHaveBeenCalled();
    expect(host.clearSiteCookies).not.toHaveBeenCalled();
    // 交给了 runCheckin：非终点页不过身份闸门，直接进入签到执行（由它沿 route 推进）
    expect(performCheckin).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true, message: '签到完成' });
  });

  it.each(['verify', 'verify-oauth'] as const)('%s 返回仪表盘时不读取或保存身份，先导航个人资料页', async (stage) => {
    history.replaceState({}, '', '/dashboard/overview');
    vi.mocked(readPageIdentity).mockResolvedValue({ userId: '99', username: 'bob', source: 'api' });
    vi.mocked(verifyIdentity).mockReturnValue({ match: 'mismatch', detail: '用户 ID 不符' });
    vi.mocked(performCheckin).mockResolvedValue({ status: 'navigate', url: `${ORIGIN}/profile` });
    const task = learnedTask({
      stage,
      effectiveLoginMethod: stage === 'verify-oauth' ? 'oauth' : 'form',
      accountIdentityUserId: '42',
    }, method);
    const host: EngineHost = {
      markStage: vi.fn(), navigate: vi.fn(), needsUser: vi.fn(),
      confirmIdentity: vi.fn(), saveIdentity: vi.fn(),
    };

    expect(await runTask(task, host)).toBeNull();

    expect(readPageIdentity).not.toHaveBeenCalled();
    expect(verifyIdentity).not.toHaveBeenCalled();
    expect(host.saveIdentity).not.toHaveBeenCalled();
    expect(host.confirmIdentity).not.toHaveBeenCalled();
    expect(host.needsUser).not.toHaveBeenCalled();
    expect(logoutSession).not.toHaveBeenCalled();
    expect(host.navigate).toHaveBeenCalledWith(`${ORIGIN}/profile`, expect.any(Array), 'checkin');
  });

  it('落在独立资料页时会经过身份闸门后再进入签到路线', async () => {
    history.replaceState({}, '', '/profile');
    // 资料页会等待并核对身份：给一个匹配的身份，闸门 confirmed 放行后签到。
    // （不给的话 waitForCheckinIdentity 会走满 12s 稳定性等待，拖垮用例。）
    vi.mocked(readPageIdentity).mockResolvedValue({ userId: '42', username: 'alice', source: 'api' });
    vi.mocked(verifyIdentity).mockReturnValue({ match: 'confirmed', detail: '用户 ID 42 一致' });
    const host: EngineHost = {
      markStage: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
      needsUser: vi.fn().mockResolvedValue(undefined),
      confirmIdentity: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runTask(learnedTask({ siteAccountCount: 2 }, method), host);

    // 多账号也能签成功：因为资料页把账号核对成 confirmed，而不是靠 single-account 放水
    expect(host.confirmIdentity).toHaveBeenCalled();
    expect(performCheckin).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true, message: '签到完成' });
    expect(host.needsUser).not.toHaveBeenCalled();
  });

  it('同址形态：签到页本身就是身份核验页时，先核验账号再就地签到，不在页面之间来回跳', async () => {
    // 站点把「每日签到」卡片直接放在个人资料页上（1412 / 新版 new-api 家族）：
    // 资料页与签到页同址，学习产物是 route:['/check-in'] + identityPath:'/check-in'。
    history.replaceState({}, '', '/check-in');
    vi.mocked(readPageIdentity).mockResolvedValue({ userId: '42', username: 'alice', source: 'api' });
    vi.mocked(verifyIdentity).mockReturnValue({ match: 'confirmed', detail: '用户 ID 42 一致' });
    const task = learnedTask({ stage: 'checkin', siteAccountCount: 2 }, method);
    task.site.checkin!.workflow!.route = ['/check-in'];
    task.site.checkin!.workflow!.identityPath = '/check-in';
    const host: EngineHost = {
      markStage: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
      needsUser: vi.fn().mockResolvedValue(undefined),
      confirmIdentity: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runTask(task, host);

    expect(host.navigate).not.toHaveBeenCalled();
    expect(host.needsUser).not.toHaveBeenCalled();
    expect(host.confirmIdentity).toHaveBeenCalled();
    expect(performCheckin).toHaveBeenCalledOnce();
    // 关键顺序：读账号必须早于签到点击，否则同址形态就成了盲签
    expect(vi.mocked(readPageIdentity).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(performCheckin).mock.invocationCallOrder[0]!);
    expect(result).toMatchObject({ ok: true, message: '签到完成' });
  });

  it('同址形态：签到页读不到账号身份时停机，绝不在身份未知时就地签到', async () => {
    history.replaceState({}, '', '/check-in');
    const task = learnedTask({ stage: 'checkin', siteAccountCount: 2 }, method);
    task.site.checkin!.workflow!.route = ['/check-in'];
    task.site.checkin!.workflow!.identityPath = '/check-in';
    // sleep 已被替换为立即返回，推进时钟可让身份等待按实际超时出口收敛。
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => { now += 13_000; return now; });
    const host: EngineHost = {
      markStage: vi.fn(), navigate: vi.fn(), needsUser: vi.fn().mockResolvedValue(undefined),
      confirmIdentity: vi.fn(), clearSiteCookies: vi.fn().mockResolvedValue({
        cleared: 0, clearedKeys: [], cookieMayRemain: false, domainCount: 1,
      }),
    };

    const result = await runTask(task, host);

    // verifyIdentity 默认 unknown；同址核验页同样适用"读不到就停机"的硬前提
    expect(result).toBeNull();
    expect(host.needsUser).toHaveBeenCalledWith(expect.stringContaining('仍未显示可核对的账号身份'), expect.any(Array));
    expect(host.confirmIdentity).not.toHaveBeenCalled();
    expect(performCheckin).not.toHaveBeenCalled();
  });

  it('在独立的个人资料页核验身份后才交给签到路线继续推进', async () => {
    history.replaceState({}, '', '/profile');
    vi.mocked(readPageIdentity).mockResolvedValue({ userId: '42', username: 'alice', source: 'api' });
    vi.mocked(verifyIdentity).mockReturnValue({ match: 'confirmed', detail: '用户 ID 42 一致' });
    const task = learnedTask({ stage: 'checkin' }, method);
    task.site.checkin!.workflow!.route = ['/sign-in', '/profile', '/check-in'];
    task.site.checkin!.workflow!.identityPath = '/profile';
    const host: EngineHost = {
      markStage: vi.fn(), navigate: vi.fn(), needsUser: vi.fn(), confirmIdentity: vi.fn(),
    };

    await runTask(task, host);

    expect(readPageIdentity).toHaveBeenCalled();
    expect(host.confirmIdentity).toHaveBeenCalled();
    expect(performCheckin).toHaveBeenCalledOnce();
    expect(vi.mocked(readPageIdentity).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(performCheckin).mock.invocationCallOrder[0]!);
  });

  it('再次回到资料页时重新核验，旧确认不能覆盖新的明确错号', async () => {
    history.replaceState({}, '', '/profile');
    vi.mocked(readPageIdentity).mockResolvedValue({ userId: '42', username: 'alice', source: 'api' });
    vi.mocked(verifyIdentity).mockReturnValue({ match: 'confirmed', detail: '用户 ID 一致' });
    vi.mocked(performCheckin).mockResolvedValue({ status: 'navigate', url: `${ORIGIN}/check-in` });
    const task = learnedTask({ stage: 'checkin', accountIdentityUserId: '42' }, method);
    const host: EngineHost = {
      markStage: vi.fn(), navigate: vi.fn(), needsUser: vi.fn(), confirmIdentity: vi.fn(),
    };
    expect(await runTask(task, host)).toBeNull();
    const [, previousSteps] = vi.mocked(host.navigate).mock.calls[0]!;
    vi.mocked(host.navigate).mockClear();
    vi.mocked(performCheckin).mockClear();
    vi.mocked(readPageIdentity).mockResolvedValue({ userId: '99', username: 'bob', source: 'api' });
    vi.mocked(verifyIdentity).mockReturnValue({ match: 'mismatch', detail: '用户 ID 不符' });

    await runTask({ ...task, steps: previousSteps, identityConfirmed: true }, host);

    expect(logoutSession).toHaveBeenCalledOnce();
    expect(host.navigate).toHaveBeenCalledWith(`${ORIGIN}/sign-in`, expect.any(Array), 'login');
    expect(performCheckin).not.toHaveBeenCalled();
  });

  it('直接落在签到终点而尚未核验个人资料时，先导航到 identityPath', async () => {
    history.replaceState({}, '', '/check-in');
    const task = learnedTask({ stage: 'checkin' }, method);
    task.site.checkin!.workflow!.route = ['/sign-in', '/profile', '/check-in'];
    task.site.checkin!.workflow!.identityPath = '/profile';
    const host: EngineHost = {
      markStage: vi.fn(), navigate: vi.fn().mockResolvedValue(undefined), needsUser: vi.fn(),
    };

    const result = await runTask(task, host);

    expect(host.navigate).toHaveBeenCalledWith(`${ORIGIN}/profile`, expect.any(Array), 'checkin');
    expect(readPageIdentity).not.toHaveBeenCalled();
    expect(performCheckin).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('签到终点反复被重定向回来时，回资料页同样受跳转预算限制', async () => {
    history.replaceState({}, '', '/check-in');
    const task = learnedTask({
      stage: 'checkin',
      steps: ['进入签到页: /profile', '进入签到页: /profile'],
    }, method);
    const host: EngineHost = {
      markStage: vi.fn(), navigate: vi.fn(), needsUser: vi.fn(),
    };

    expect(await runTask(task, host)).toBeNull();

    expect(host.navigate).not.toHaveBeenCalled();
    expect(host.needsUser).toHaveBeenCalledWith(expect.stringContaining('身份核验页未能到达'), expect.any(Array));
    expect(readPageIdentity).not.toHaveBeenCalled();
    expect(performCheckin).not.toHaveBeenCalled();
  });

  it('切换账号后旧的身份核验标记失效，重登后仍先回资料页核验', async () => {
    history.replaceState({}, '', '/check-in');
    const task = learnedTask({
      stage: 'login',
      steps: [
        '个人资料身份已核验:',
        '切换账号: 本站浏览器 Cookie 已清除，重新打开登录页',
        '进入签到页: /profile',
      ],
    }, method);
    const host: EngineHost = {
      markStage: vi.fn(), navigate: vi.fn().mockResolvedValue(undefined), needsUser: vi.fn(), confirmIdentity: vi.fn(),
    };

    const result = await runTask(task, host);

    expect(host.navigate).toHaveBeenCalledWith(`${ORIGIN}/profile`, expect.any(Array), 'checkin');
    expect(performCheckin).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('学习路线跳转失败后保留原流程，不在错误页面回放或改试通用地址', async () => {
    history.replaceState({}, '', '/dashboard/overview');
    const task = learnedTask({
      stage: 'checkin',
      steps: ['个人资料身份已核验:', '进入签到页: /check-in', '进入签到页: /check-in'],
    });
    vi.mocked(performCheckin)
      .mockResolvedValueOnce({ status: 'navigate', url: `${ORIGIN}/check-in` })
      .mockResolvedValue({ status: 'failed', message: '错误页面上没有学习目标' });
    const host: EngineHost = {
      markStage: vi.fn(), navigate: vi.fn(), needsUser: vi.fn(),
    };

    expect(await runTask(task, host)).toBeNull();
    expect(performCheckin).toHaveBeenCalledOnce();
    expect(host.navigate).not.toHaveBeenCalled();
    expect(host.needsUser).toHaveBeenCalledWith(expect.stringContaining('学习路线无法继续'), expect.any(Array));
    expect(task.site.checkin?.workflow?.route).toEqual(['/sign-in', '/profile', '/check-in']);
  });

  it('登录即签到保留的身份页必须实际访问，不能在落地页忽略学习结果', async () => {
    history.replaceState({}, '', '/dashboard/overview');
    const task = learnedTask({ stage: 'verify-oauth', effectiveLoginMethod: 'oauth', effectiveCheckinMethod: 'none' });
    task.site.checkin = {
      method: 'none',
      workflow: { steps: [], route: ['/dashboard/overview', '/profile'], identityPath: '/profile' },
    };
    const host: EngineHost = {
      markStage: vi.fn(), navigate: vi.fn(), needsUser: vi.fn(), confirmIdentity: vi.fn(),
    };

    expect(await runTask(task, host)).toBeNull();
    expect(host.navigate).toHaveBeenCalledExactlyOnceWith(`${ORIGIN}/profile`, expect.any(Array), 'checkin');
    expect(performCheckin).not.toHaveBeenCalled();
    expect(readPageIdentity).not.toHaveBeenCalled();
    expect(host.needsUser).not.toHaveBeenCalled();
  });

  it('hash 路由站点：路线推进到第 4 页不会被误判成重复跳转', async () => {
    // 审计 C1：跳转计数键只取 pathname 时，`/#/profile`、`/#/check-in` 全折叠成
    // `/`，整条 hash 路线共用一个计数，第三跳就撞上 MAX_CHECKIN_NAVIGATIONS
    // 而被误判成「签到页重定向」，尚未核验时直接停机。
    history.replaceState({}, '', '/#/profile');
    const task = learnedTask({ stage: 'checkin' }, method);
    task.site.checkin!.workflow!.route = ['/#/home', '/#/console', '/#/profile', '/#/check-in'];
    task.site.checkin!.workflow!.identityPath = '/#/profile';
    task.site.checkin!.workflow!.steps = [{ type: 'click', selector: '#checkin' }];
    task.steps = ['进入签到页: /#/console', '进入签到页: /#/profile', '个人资料身份已核验:'];
    vi.mocked(readPageIdentity).mockResolvedValue({ userId: '42', username: 'alice', source: 'api' });
    vi.mocked(verifyIdentity).mockReturnValue({ match: 'confirmed', detail: '用户 ID 一致' });
    vi.mocked(performCheckin).mockResolvedValue({ status: 'navigate', url: `${ORIGIN}/#/check-in` });
    const host: EngineHost = {
      markStage: vi.fn(), navigate: vi.fn(), needsUser: vi.fn(), confirmIdentity: vi.fn(),
    };

    const result = await runTask(task, host);

    expect(host.needsUser).not.toHaveBeenCalled();
    expect(host.navigate).toHaveBeenCalledExactlyOnceWith(`${ORIGIN}/#/check-in`, expect.any(Array), 'checkin');
    expect(result).toBeNull();
  });

  it.each([
    '自动重试: 签到页打不开 → 稍后重试',
    '已清除 2 项本地登录态',
    '开始第二次登录以完成签到',
  ])('会话重建后（%s）旧的身份核验标记失效，先回资料页', async (sessionLine) => {
    // 审计 C3：标记必须晚于最近一次「主动结束 / 重建会话」。重试重登、token
    // 清号、退出后重登之后还认旧的核验标记，等于跳过本轮资料页核验直接签到。
    history.replaceState({}, '', '/check-in');
    const task = learnedTask({ stage: 'checkin', steps: ['个人资料身份已核验:', sessionLine] }, method);
    const host: EngineHost = {
      markStage: vi.fn(), navigate: vi.fn(), needsUser: vi.fn(),
    };

    const result = await runTask(task, host);

    expect(host.navigate).toHaveBeenCalledWith(`${ORIGIN}/profile`, expect.any(Array), 'checkin');
    expect(performCheckin).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('从路外成功进入资料页后仍可前进到签到页，不把已用的路外预算误当导航循环', async () => {
    history.replaceState({}, '', '/dashboard/overview');
    vi.mocked(performCheckin).mockImplementation(async (site, log) => {
      const result = await runCheckinWorkflow(site, site.checkin?.workflow, log);
      return result.status === 'unknown' ? { status: 'failed', message: result.message } : result;
    });
    const task = learnedTask({ stage: 'checkin' }, method);
    task.site.checkin!.workflow!.steps = [{ type: 'assert', text: ['签到成功'], result: 'success' }];
    const host: EngineHost = {
      markStage: vi.fn(), navigate: vi.fn(), needsUser: vi.fn(), confirmIdentity: vi.fn(),
    };

    expect(await runTask(task, host)).toBeNull();
    expect(host.navigate).toHaveBeenCalledWith(`${ORIGIN}/profile`, expect.any(Array), 'checkin');
    const [, previousSteps] = vi.mocked(host.navigate).mock.calls[0]!;
    vi.mocked(host.navigate).mockClear();
    history.replaceState({}, '', '/profile');
    document.body.innerText = '签到成功'; // 即使资料页也有历史成功提示，仍不能当成本轮已签到。
    vi.mocked(readPageIdentity).mockResolvedValue({ userId: '42', username: 'alice', source: 'api' });
    vi.mocked(verifyIdentity).mockReturnValue({ match: 'confirmed', detail: '用户 ID 一致' });

    const result = await runTask({ ...task, steps: previousSteps }, host);

    expect(host.navigate).toHaveBeenCalledWith(`${ORIGIN}/check-in`, expect.any(Array), 'checkin');
    expect(host.needsUser).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('拒绝携带查询参数的 identityPath，避免把参数带进跨页导航', async () => {
    history.replaceState({}, '', '/check-in');
    const task = learnedTask({ stage: 'checkin' }, method);
    task.site.checkin!.workflow!.identityPath = '/profile?fixture=1';
    const host: EngineHost = {
      markStage: vi.fn(), navigate: vi.fn(), needsUser: vi.fn(),
    };

    const result = await runTask(task, host);

    expect(result).toBeNull();
    expect(host.navigate).not.toHaveBeenCalled();
    expect(host.needsUser).toHaveBeenCalledWith(expect.stringContaining('没有记录到可核验账号的身份页'), expect.any(Array));
    expect(performCheckin).not.toHaveBeenCalled();
  });

  it.each([
    '学习路线未命中: 当前页 /dashboard/overview 不在学习路线上，尝试进入 /profile',
    '工作流接入学习路线: 从当前业务页 /dashboard/overview 进入 /profile',
  ])('个人资料页无法到达时，新旧接入标记均限制为一次跳转（%s）', async (marker) => {
    history.replaceState({}, '', '/dashboard/overview');
    vi.mocked(performCheckin)
      .mockResolvedValueOnce({ status: 'navigate', url: `${ORIGIN}/profile` })
      .mockResolvedValueOnce({ status: 'success', message: '不应执行到这里' });
    const task = learnedTask({
      stage: 'checkin',
      steps: [marker, '工作流沿学习路线进入 /profile（第 2/3 页）', '进入签到页: /profile'],
    }, method);
    const host: EngineHost = {
      markStage: vi.fn(), navigate: vi.fn(), needsUser: vi.fn(),
    };

    const result = await runTask(task, host);

    expect(result).toBeNull();
    expect(host.navigate).not.toHaveBeenCalled();
    expect(host.needsUser).toHaveBeenCalledWith(expect.stringContaining('身份核验页未能到达'), expect.any(Array));
    expect(performCheckin).toHaveBeenCalledOnce();
    expect(readPageIdentity).not.toHaveBeenCalled();
  });

  it('已有学习路线时忽略旧入口和签到地址，保持原站点配置不变', async () => {
    history.replaceState({}, '', '/profile');
    vi.mocked(readPageIdentity).mockResolvedValue({ userId: '42', username: 'alice', source: 'api' });
    vi.mocked(verifyIdentity).mockReturnValue({ match: 'confirmed', detail: '用户 ID 42 一致' });
    const task = learnedTask({}, method);
    task.site.checkin!.entry = { steps: [{ selector: '#stale-entry' }], readySelector: '#stale-ready' };
    task.site.checkin!.url = '/stale-checkin';
    const host: EngineHost = {
      markStage: vi.fn(), navigate: vi.fn(), needsUser: vi.fn(), confirmIdentity: vi.fn(),
    };

    await runTask(task, host);

    expect(prepareCheckinEntry).not.toHaveBeenCalled();
    expect(performCheckin).toHaveBeenCalledOnce();
    const runtimeSite = vi.mocked(performCheckin).mock.calls[0]![0];
    expect(runtimeSite.checkin?.entry).toBeUndefined();
    expect(runtimeSite.checkin?.url).toBeUndefined();
    expect(runtimeSite.checkin?.workflow?.route).toEqual(['/sign-in', '/profile', '/check-in']);
    expect(task.site.checkin!.entry).toBeDefined();
    expect(task.site.checkin!.url).toBe('/stale-checkin');
  });

  it('OAuth 直接落到个人资料页且身份未知时停止，不因只有一个账号而签到', async () => {
    history.replaceState({}, '', '/profile');
    const task = learnedTask({ stage: 'verify-oauth', effectiveLoginMethod: 'oauth', siteAccountCount: 1 }, method);
    // sleep 已被替换为立即返回，推进时钟可让身份等待按实际超时出口收敛。
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => { now += 13_000; return now; });
    const host: EngineHost = {
      markStage: vi.fn(), navigate: vi.fn(), needsUser: vi.fn(), confirmIdentity: vi.fn(),
      clearSiteCookies: vi.fn().mockResolvedValue({
        cleared: 0, clearedKeys: [], cookieMayRemain: false, domainCount: 1,
      }),
    };

    const result = await runTask(task, host);

    expect(result).toBeNull();
    expect(host.needsUser).toHaveBeenCalledWith(expect.stringContaining('仍未显示可核对的账号身份'), expect.any(Array));
    expect(host.confirmIdentity).not.toHaveBeenCalled();
    expect(host.clearSiteCookies).not.toHaveBeenCalled();
    expect(performCheckin).not.toHaveBeenCalled();
  });

  it('学习终点返回另一个账号时不得执行学习动作', async () => {
    history.replaceState({}, '', '/profile');
    vi.mocked(readPageIdentity).mockResolvedValue({ userId: '99', username: 'bob', source: 'api' });
    vi.mocked(verifyIdentity).mockReturnValue({ match: 'mismatch', detail: '用户 ID 99 与 42 不符' });
    const host: EngineHost = {
      markStage: vi.fn(), navigate: vi.fn(), needsUser: vi.fn(), confirmIdentity: vi.fn(),
      clearSiteCookies: vi.fn().mockResolvedValue({ cleared: 0, clearedKeys: [], cookieMayRemain: false, domainCount: 1 }),
    };

    const task = learnedTask({ accountIdentityUserId: '42' }, method);
    await runTask(task, host);

    expect(performCheckin).not.toHaveBeenCalled();
    expect(host.confirmIdentity).not.toHaveBeenCalled();
    expect(logoutSession).toHaveBeenCalledWith(task.site, expect.anything(), host.clearSiteCookies);
    expect(host.navigate).toHaveBeenCalledWith(
      `${ORIGIN}/sign-in`,
      expect.any(Array),
      'login',
    );
  });

  it('学习路线缺少身份核验页时停止（旧配置没有记录身份页），不在签到目标页核验或执行动作', async () => {
    history.replaceState({}, '', '/dashboard/overview');
    const task = learnedTask();
    delete task.site.checkin!.workflow!.identityPath;
    const host: EngineHost = {
      markStage: vi.fn(), navigate: vi.fn(), needsUser: vi.fn(),
    };

    const result = await runTask(task, host);

    expect(result).toBeNull();
    expect(host.needsUser).toHaveBeenCalledWith(expect.stringContaining('没有记录到可核验账号的身份页'), expect.any(Array));
    expect(readPageIdentity).not.toHaveBeenCalled();
    expect(performCheckin).not.toHaveBeenCalled();
  });

  it('旧版学出的配置（停在签到页、未记录身份页）直接要求重学，不在签到页临时核验身份', async () => {
    // 用户实测 orevx.ai：旧构建的产物是「业务页 + /user/checkins」且没有
    // identityPath；当时的实现在签到页跑身份闸门。当前契约：**没有身份页**的配置
    // 一律停机要求重学 —— 运行日志里不允许出现任何在签到页等待/诊断身份的痕迹。
    //
    // 注意与同址形态的区别：重新学习后 identityPath 会等于签到终点页（见本文件
    // 上面的同址用例），那时才允许在签到页核验 —— 依据是"学习时明确记录了这一页
    // 就是身份核验页"，而不是运行时凭页面地址临时推断。
    history.replaceState({}, '', '/user/checkins');
    const task = learnedTask({ stage: 'checkin' }, method);
    task.site.checkin!.workflow!.route = ['/user/dashboard', '/user/checkins'];
    delete task.site.checkin!.workflow!.identityPath;
    const host: EngineHost = {
      markStage: vi.fn(), navigate: vi.fn(), needsUser: vi.fn(), confirmIdentity: vi.fn(),
    };

    const result = await runTask(task, host);

    expect(result).toBeNull();
    expect(host.needsUser).toHaveBeenCalledWith(expect.stringContaining('没有记录到可核验账号的身份页'), expect.any(Array));
    expect(readPageIdentity).not.toHaveBeenCalled();
    expect(verifyIdentity).not.toHaveBeenCalled();
    expect(performCheckin).not.toHaveBeenCalled();
    expect(host.navigate).not.toHaveBeenCalled();
    const [, reportedSteps] = vi.mocked(host.needsUser).mock.calls[0]!;
    expect(reportedSteps.some((line) => line.includes('身份信息尚未稳定') || line.includes('身份诊断'))).toBe(false);
  });
});

it('旧 workflow 未单列 route 时仍先执行手工 entry，并保留入口的回退 url', async () => {
  vi.clearAllMocks();
  history.replaceState({}, '', '/profile');
  vi.mocked(readPageIdentity).mockResolvedValue({ userId: '42', username: 'alice', source: 'api' });
  vi.mocked(verifyIdentity).mockReturnValue({ match: 'confirmed', detail: '用户 ID 42 一致' });
  vi.mocked(prepareCheckinEntry).mockResolvedValue({ status: 'ready' });
  vi.mocked(performCheckin).mockResolvedValue({ status: 'success', message: '签到完成' });
  const task = learnedTask();
  delete task.site.checkin!.workflow!.route;
  const entry = { steps: [{ selector: '#profile-menu' }], readySelector: '#profile-card' };
  task.site.checkin!.entry = entry;
  task.site.checkin!.url = '/profile';
  const host: EngineHost = {
    markStage: vi.fn(), navigate: vi.fn(), needsUser: vi.fn(), confirmIdentity: vi.fn(),
  };

  const result = await runTask(task, host);

  expect(result).toMatchObject({ ok: true });
  expect(prepareCheckinEntry).toHaveBeenCalledOnce();
  expect(performCheckin).toHaveBeenCalledOnce();
  const runtimeSite = vi.mocked(performCheckin).mock.calls[0]![0];
  expect(runtimeSite.checkin?.entry).toEqual(entry);
  expect(runtimeSite.checkin?.url).toBe('/profile');
  expect(vi.mocked(prepareCheckinEntry).mock.invocationCallOrder[0])
    .toBeLessThan(vi.mocked(performCheckin).mock.invocationCallOrder[0]!);
  history.replaceState({}, '', '/');
});
