import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginTask } from '@/types';
import type { EngineHost } from '@/automation/engine/engine';

vi.mock('@/automation/login/steps', () => ({
  closeAnnouncements: vi.fn().mockResolvedValue(undefined),
  fillCredentials: vi.fn(),
  submitLogin: vi.fn(),
  verifyLogin: vi.fn(),
  clickOAuthButton: vi.fn(),
  detectManualLoginStep: vi.fn(),
  detectAlreadyLoggedIn: vi.fn(),
  hasVisibleLoginPrompt: vi.fn().mockReturnValue(true),
  pageShowsSignedIn: vi.fn().mockReturnValue(true),
  revealExternalLogin: vi.fn(),
  revealLoginForm: vi.fn(),
  waitForExternalLoginNavigation: vi.fn(),
}));

vi.mock('@/automation/checkin/checkin', () => ({
  performCheckin: vi.fn().mockResolvedValue({ status: 'success', message: '签到完成' }),
  // engine 用 `checkinPageElsewhere()`（依赖这个纯函数）判断「还有没有别的签到页可去」。
  isCurrentCheckinPage: vi.fn().mockReturnValue(false),
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
  logoutSession: vi.fn().mockResolvedValue({
    clearedKeys: 0,
    serverLogout: false,
    cookieMayRemain: false,
  }),
  readPageIdentity: vi.fn().mockResolvedValue(null),
  readVisibleIdentity: vi.fn().mockReturnValue(null),
  verifyIdentity: vi.fn().mockReturnValue({ match: 'unknown', detail: '读不到当前登录身份' }),
}));

vi.mock('@/automation/login/token-refresh', () => ({
  ensureFreshToken: vi.fn(),
}));

import { performCheckin } from '@/automation/checkin/checkin';
import { logoutSession, readPageIdentity, verifyIdentity } from '@/automation/login/identity';
import { detectAlreadyLoggedIn, fillCredentials, hasVisibleLoginPrompt, revealLoginForm } from '@/automation/login/steps';
import { runTask } from '@/automation/engine/engine';

/**
 * 跨页身份的配套验证（代理 C 的 defer 策略落地链路）。
 *
 * 背景：`identity-policy.ts` 的 `unknown` 分支现在优先返回
 * `defer-to-checkin-page`，而且对 form/auto/token 也生效 —— 也就是说
 * 「读不到身份就先跳到签到页核对」成了多数站点的默认路径。这条路径能不能
 * 真的核对到身份，取决于**跳转后那个页面落在哪个 stage**：
 *
 *  - `settle()` 与 defer 分支都用 `host.navigate(target, steps, 'checkin')`，
 *    下一份文档的任务快照 stage = 'checkin'，于是 `runCheckin()` 的
 *    `requiresCheckinGate` 成立，`passCheckinIdentityGate()` 会跑；
 *  - 万一 stage 落在 verify/login，那道闸门会被静默跳过 —— 变成「跳过去
 *    就直接签到」，身份永远没被核对过。这正是本次修复要防的事。
 *
 * 所以这两个用例断言的是：**defer 之后第一个动作是带 'checkin' 的 setStage，
 * 目的地就是签到页，未发生任何签到动作**。
 */
function deferTask(overrides: Partial<LoginTask> = {}): LoginTask {
  return {
    tabId: 1,
    runId: 'run-defer-to-checkin',
    accountId: 'account-1',
    siteId: 'site-1',
    username: 'alice',
    password: 'secret',
    effectiveLoginMethod: 'form',
    effectiveCheckinMethod: 'auto',
    siteAccountCount: 2,
    site: {
      id: 'site-1',
      name: 'Fixture',
      loginUrl: `${window.location.origin}/sign-in`,
      loginMethod: 'form',
      selectors: { username: '#u', password: '#p', submit: '#s' },
      closeModalSelectors: [],
      checkin: { method: 'auto', url: `${window.location.origin}/profile` },
    },
    createdAt: Date.now(),
    stage: 'login',
    ...overrides,
  };
}

describe('读不到身份时的 defer 跳转带上 checkin 阶段', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks 不清实现：上一个用例设的 navigate 返回值会漏到下一个用例
    // （表现为「签到页沿用」那条用例莫名返回 null）。必须显式重置。
    vi.mocked(performCheckin).mockReset();
    vi.mocked(performCheckin).mockResolvedValue({ status: 'success', message: '签到完成' });
    vi.mocked(detectAlreadyLoggedIn).mockResolvedValue(true);
    vi.mocked(readPageIdentity).mockResolvedValue(null);
    vi.mocked(verifyIdentity).mockReturnValue({ match: 'unknown', detail: '读不到当前登录身份' });
    history.replaceState({}, '', '/dashboard/overview');
  });

  // 本文件后面的用例没有自己的 beforeEach，会继承这里的实现 —— 用完必须还原，
  // 否则「签到页沿用本轮身份确认」会读到本轮设的 navigate 返回值而变成 null。
  afterEach(() => {
    vi.mocked(performCheckin).mockReset();
    vi.mocked(performCheckin).mockResolvedValue({ status: 'success', message: '签到完成' });
    vi.mocked(detectAlreadyLoggedIn).mockReset();
  });

  it('form 站读不到身份时跳到签到页，并把下一份文档的 stage 落成 checkin', async () => {
    const host: EngineHost = {
      markStage: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
      needsUser: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runTask(deferTask(), host);

    // 页面即将跳转，由新文档接着跑
    expect(result).toBeNull();
    expect(host.navigate).toHaveBeenCalledOnce();
    expect(host.navigate).toHaveBeenCalledWith(
      `${window.location.origin}/profile`,
      expect.anything(),
      // 关键：stage 必须是 checkin，否则签到页重新注入后不会走身份闸门
      'checkin',
    );
    // 没有清 Cookie、没有停机要人工确认、也没有执行签到
    expect(performCheckin).not.toHaveBeenCalled();
    expect(host.needsUser).not.toHaveBeenCalled();
  });

  it('签到页读不到身份、多账号时不会在 defer 上打转（闸门层的保守行为保持不变）', async () => {
    /*
     * 闸门（`passCheckinIdentityGate`）里 `checkinPageAvailable` 是**写死 false**
     * 的：那时我们已经站在签到页上，再 defer 就是原地打转。所以这里不会有
     * 「跳到 /profile 又跳回来」的循环 —— 断言它不会被 defer 牵成跳转。
     *
     * 读不到身份 + 多账号 + form 时闸门仍按保守策略处理（清会话重登），
     * 这条上限没有因为 C 的策略重排而放松。它属于身份策略层，engine 只负责
     * 不产生额外跳转。
     */
    const host: EngineHost = {
      markStage: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
      needsUser: vi.fn().mockResolvedValue(undefined),
      clearSiteCookies: vi.fn().mockResolvedValue({
        cleared: 0, clearedKeys: [], cookieMayRemain: false, domainCount: 1,
      }),
    };
    vi.mocked(performCheckin).mockResolvedValue({
      status: 'navigate',
      url: `${window.location.origin}/profile`,
    });

    const result = await runTask(deferTask({ stage: 'checkin' }), host);

    // 没有因为「还有别的签到页」而在闸门处再跳一次
    expect(result).toBeNull();
    for (const call of vi.mocked(host.navigate).mock.calls) {
      expect(call[0]).not.toBe(`${window.location.origin}/profile`);
    }
  });
});

describe('签到页沿用本轮身份确认', () => {
  it('跨页任务已确认身份时，即使签到页读不到身份也继续签到', async () => {
    const task: LoginTask = {
      tabId: 1,
      runId: 'run-1',
      accountId: 'account-1',
      siteId: 'site-1',
      username: 'alice',
      password: 'secret',
      site: {
        id: 'site-1',
        name: 'Fixture',
        loginUrl: `${window.location.origin}/login`,
        loginMethod: 'form',
        selectors: {
          username: '#username',
          password: '#password',
          submit: 'button[type="submit"]',
        },
        closeModalSelectors: [],
        checkin: { method: 'none', url: `${window.location.origin}/checkin` },
      },
      siteAccountCount: 2,
      identityConfirmed: true,
      createdAt: Date.now(),
      stage: 'checkin',
    };
    const host: EngineHost = {
      markStage: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
      needsUser: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runTask(task, host);

    expect(performCheckin).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true, message: '签到完成' });
    expect(host.navigate).not.toHaveBeenCalled();
    expect(host.needsUser).not.toHaveBeenCalled();
  });

  function loginAsCheckinTask(overrides: Partial<LoginTask> = {}): LoginTask {
    return {
      tabId: 1,
      runId: 'run-none-with-stale-entry',
      accountId: 'account-1',
      siteId: 'site-1',
      username: 'alice',
      password: 'secret',
      effectiveCheckinMethod: 'none',
      site: {
        id: 'site-1',
        name: 'Fixture',
        loginUrl: `${window.location.origin}/login`,
        loginMethod: 'form',
        selectors: {
          username: '#username',
          password: '#password',
          submit: 'button[type="submit"]',
        },
        closeModalSelectors: [],
        checkin: {
          method: 'none',
          url: `${window.location.origin}/checkin`,
          entry: { readySelector: '#ready', steps: [{ selector: '#daily-entry' }] },
          workflow: {
            steps: [{ type: 'click', selector: '#old' }],
            route: [`${window.location.origin}/checkin`],
          },
        },
      },
      siteAccountCount: 2,
      createdAt: Date.now(),
      stage: 'checkin',
      ...overrides,
    };
  }

  it('登录即签到清掉旧入口/签到页地址，但保留学习到的身份核验路线，本轮身份已确认时直接收尾', async () => {
    vi.mocked(performCheckin).mockClear();
    vi.mocked(readPageIdentity).mockClear();
    history.replaceState({}, '', '/dashboard');
    vi.mocked(readPageIdentity).mockResolvedValue(null);
    vi.mocked(verifyIdentity).mockReturnValue({ match: 'unknown', detail: '读不到当前登录身份' });
    vi.mocked(performCheckin).mockImplementation(async (site) => {
      expect(site.checkin?.method).toBe('none');
      expect(site.checkin?.entry).toBeUndefined();
      expect(site.checkin?.url).toBeUndefined();
      // 学习到的 route/identityPath 保留：none 不回放签到步骤，但运行时仍按
      // 学到的资料页核对身份；丢掉它会让 OAuth 类站点「登录后什么都不核对」。
      expect(site.checkin?.workflow).toBeDefined();
      expect(site.checkin?.workflow?.steps ?? []).toHaveLength(0);
      expect(site.checkin?.workflow?.route?.length ?? 0).toBeGreaterThan(0);
      return { status: 'success', message: '登录即签到' };
    });

    const task = loginAsCheckinTask({ identityConfirmed: true });
    const host: EngineHost = {
      markStage: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
      needsUser: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runTask(task, host);

    expect(result).toMatchObject({ ok: true, message: '登录即签到' });
    expect(performCheckin).toHaveBeenCalledOnce();
    // 普通当前页身份闸门仍然执行；持久化的本轮确认让它安全放行。
    expect(readPageIdentity).toHaveBeenCalled();
    expect(host.navigate).not.toHaveBeenCalled();
    expect(host.needsUser).not.toHaveBeenCalled();
  });

  it('登录即签到在多账号且身份未确认时不会盲签', async () => {
    vi.mocked(performCheckin).mockClear();
    vi.mocked(readPageIdentity).mockClear();
    history.replaceState({}, '', '/dashboard');
    vi.mocked(readPageIdentity).mockResolvedValue(null);
    vi.mocked(verifyIdentity).mockReturnValue({ match: 'unknown', detail: '读不到当前登录身份' });

    const task = loginAsCheckinTask();
    const host: EngineHost = {
      markStage: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
      needsUser: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runTask(task, host);

    expect(result).toBeNull();
    // 普通当前页身份闸门读了一遍身份，随后才按多账号 unknown 处理，未盲签。
    expect(readPageIdentity).toHaveBeenCalled();
    expect(performCheckin).not.toHaveBeenCalled();
    // form 站点会先清掉会话并重开登录页，而不是给未知账号记一次「已签到」。
    expect(host.navigate).toHaveBeenCalledWith(task.site.loginUrl, expect.any(Array), 'login');
  });
});

describe('已登录但页面没有登录表单：先问站点「当前是谁」，再决定直接签到还是切号', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(performCheckin).mockReset();
    vi.mocked(performCheckin).mockResolvedValue({ status: 'success', message: '签到完成' });
    // 用户现场：SPA 外壳还没渲染，既看不到站内证据，也看不到登录表单。
    vi.mocked(detectAlreadyLoggedIn).mockResolvedValue(false);
    vi.mocked(hasVisibleLoginPrompt).mockReturnValue(false);
    history.replaceState({}, '', '/dashboard/overview');
  });

  afterEach(() => {
    vi.mocked(hasVisibleLoginPrompt).mockReturnValue(true);
    vi.mocked(detectAlreadyLoggedIn).mockReset();
    vi.mocked(readPageIdentity).mockResolvedValue(null);
  });

  it('身份接口确认是本账号：不找登录表单，直接签到', async () => {
    vi.mocked(readPageIdentity).mockResolvedValue({ userId: '42', username: 'alice', source: 'api' });
    vi.mocked(verifyIdentity).mockReturnValue({ match: 'confirmed', detail: '用户 ID 42 一致' });
    const host: EngineHost = {
      markStage: vi.fn(), navigate: vi.fn(), needsUser: vi.fn(), confirmIdentity: vi.fn(), saveIdentity: vi.fn(),
    };

    const result = await runTask(deferTask({ accountIdentityUserId: '42' }), host);

    expect(result).toMatchObject({ ok: true, message: '签到完成' });
    expect(fillCredentials).not.toHaveBeenCalled();
    expect(revealLoginForm).not.toHaveBeenCalled();
    expect(performCheckin).toHaveBeenCalledOnce();
    expect(result?.steps.some((step) => step.includes('按已登录处理并核对账号'))).toBe(true);
  });

  it('身份接口说是同站另一个账号：先退出，再回登录页用本账号登录', async () => {
    vi.mocked(readPageIdentity).mockResolvedValue({ userId: '99', username: 'bob', source: 'api' });
    vi.mocked(verifyIdentity).mockReturnValue({ match: 'mismatch', detail: '当前登录的是 bob' });
    const host: EngineHost = {
      markStage: vi.fn(), navigate: vi.fn().mockResolvedValue(undefined), needsUser: vi.fn(),
      clearSiteCookies: vi.fn().mockResolvedValue({ cleared: 1, clearedKeys: [], cookieMayRemain: false, domainCount: 1 }),
    };
    const task = deferTask({ accountIdentityUserId: '42' });

    const result = await runTask(task, host);

    expect(result).toBeNull();
    expect(performCheckin).not.toHaveBeenCalled();
    expect(fillCredentials).not.toHaveBeenCalled();
    expect(logoutSession).toHaveBeenCalledOnce();
    expect(host.navigate).toHaveBeenCalledWith(task.site.loginUrl, expect.any(Array), 'login');
  });

  it.each(['storage', 'visible'] as const)('只有%s来源的身份（过期副本 / 页脚文字）：不当成已登录，照常去找登录表单', async (source) => {
    vi.mocked(readPageIdentity).mockResolvedValue({ userId: '42', username: 'alice', source });
    vi.mocked(fillCredentials).mockResolvedValue(false);
    const host: EngineHost = { markStage: vi.fn(), navigate: vi.fn(), needsUser: vi.fn() };

    await runTask(deferTask(), host);

    expect(fillCredentials).toHaveBeenCalledOnce();
    expect(performCheckin).not.toHaveBeenCalled();
  });

  it('读不到任何身份：按未登录处理，照常去找登录表单', async () => {
    vi.mocked(readPageIdentity).mockResolvedValue(null);
    vi.mocked(fillCredentials).mockResolvedValue(false);
    const host: EngineHost = { markStage: vi.fn(), navigate: vi.fn(), needsUser: vi.fn() };

    const result = await runTask(deferTask(), host);

    expect(revealLoginForm).toHaveBeenCalledOnce();
    expect(fillCredentials).toHaveBeenCalledOnce();
    expect(performCheckin).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false });
  });

  it('页面上已经有登录表单时不额外请求身份接口', async () => {
    vi.mocked(hasVisibleLoginPrompt).mockReturnValue(true);
    vi.mocked(fillCredentials).mockResolvedValue(false);
    const host: EngineHost = { markStage: vi.fn(), navigate: vi.fn(), needsUser: vi.fn() };

    await runTask(deferTask(), host);

    expect(readPageIdentity).not.toHaveBeenCalled();
    expect(fillCredentials).toHaveBeenCalledOnce();
  });
});

describe('已登录探测的等待时长', () => {
  it('首次登录前给 SPA 6 秒下结论，而不是固定 2 秒只看一眼', async () => {
    // 现场：一梦五千年已登录，/sign-in 的路由与站内内容晚于 2 秒才就绪。
    // 旧实现 sleep(2s) 时 deadline 已到期，循环只检查一次 → 判成未登录，
    // 随后在已登录页面上硬找输入框。
    // 本文件前面的用例已经在 fillCredentials 上留下调用记录，先清计数。
    vi.clearAllMocks();
    vi.mocked(detectAlreadyLoggedIn).mockResolvedValue(false);
    vi.mocked(hasVisibleLoginPrompt).mockReturnValue(true);
    vi.mocked(fillCredentials).mockResolvedValue(false);
    const host: EngineHost = { markStage: vi.fn(), navigate: vi.fn(), needsUser: vi.fn() };

    await runTask(deferTask(), host);

    expect(detectAlreadyLoggedIn).toHaveBeenCalledWith(expect.anything(), expect.anything(), 6_000);
    expect(fillCredentials).toHaveBeenCalledOnce();
  });
});
