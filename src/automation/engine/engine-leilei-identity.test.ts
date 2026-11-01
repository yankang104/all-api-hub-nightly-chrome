import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginTask } from '@/types';
import type { EngineHost } from '@/automation/engine/engine';

vi.mock('@/automation/login/steps', () => ({
  closeAnnouncements: vi.fn().mockResolvedValue(undefined),
  fillCredentials: vi.fn().mockResolvedValue(true),
  submitLogin: vi.fn().mockResolvedValue(true),
  verifyLogin: vi.fn().mockResolvedValue(true),
  clickOAuthButton: vi.fn(),
  detectManualLoginStep: vi.fn().mockReturnValue(null),
  detectAlreadyLoggedIn: vi.fn().mockResolvedValue(false),
  hasVisibleLoginPrompt: vi.fn().mockReturnValue(true),
  pageShowsSignedIn: vi.fn().mockReturnValue(true),
  revealExternalLogin: vi.fn(),
  revealLoginForm: vi.fn().mockResolvedValue(undefined),
  resubmitLoginAfterResolvedChallenge: vi.fn(),
  waitForExternalLoginNavigation: vi.fn(),
}));

vi.mock('@/automation/challenge/challenge', () => ({
  hasObjectiveChallengeEvidence: vi.fn().mockReturnValue(false),
  waitForChallenge: vi.fn().mockResolvedValue({ detected: false, resolved: true }),
  waitForManagedChallenge: vi.fn().mockResolvedValue({ detected: false, resolved: true }),
}));
vi.mock('@/automation/shared/page-health', () => ({ detectPageAvailabilityIssue: vi.fn().mockReturnValue(null) }));
vi.mock('@/automation/shared/click-safety', () => ({ clearClickBlocker: vi.fn().mockResolvedValue(null) }));
vi.mock('@/automation/shared/dom-utils', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/automation/shared/dom-utils')>(),
  realClick: vi.fn(async (element: HTMLElement) => { element.click(); return 'trusted'; }),
}));

// 身份读取/核对与专用抽奖流程均使用真实实现，只隔离退出副作用和无关的余额采集。
vi.mock('@/automation/login/identity', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/automation/login/identity')>(),
  logoutSession: vi.fn().mockResolvedValue({ clearedKeys: 0, serverLogout: false, cookieMayRemain: false }),
}));
vi.mock('@/automation/checkin/checkin', () => ({ performCheckin: vi.fn(), isCurrentCheckinPage: vi.fn() }));

import { performCheckin } from '@/automation/checkin/checkin';
import { realClick } from '@/automation/shared/dom-utils';
import { logoutSession } from '@/automation/login/identity';
import { runLeileiDaily } from '@/automation/sites/leilei-daily';
import { runTask } from '@/automation/engine/engine';

const ORIGIN = 'https://fapi.leileihog.top';

function task(overrides: Partial<LoginTask> = {}): LoginTask {
  return {
    tabId: 1,
    runId: 'run-leilei-identity',
    accountId: 'account-qq3306',
    siteId: 'leilei',
    username: 'qq3306',
    password: 'fixture-only',
    siteAccountCount: 2,
    identityConfirmed: true,
    effectiveLoginMethod: 'form',
    createdAt: Date.now(),
    stage: 'checkin',
    site: {
      id: 'leilei',
      name: '一梦五千年',
      loginUrl: `${ORIGIN}/sign-in`,
      loginMethod: 'form',
      selectors: { username: '#username', password: '#password', submit: 'button' },
      closeModalSelectors: [],
      checkin: { method: 'workflow', workflow: { steps: [{ type: 'leilei-daily' }] } },
    },
    ...overrides,
  };
}

function host(): EngineHost {
  return {
    markStage: vi.fn().mockResolvedValue(undefined),
    navigate: vi.fn().mockResolvedValue(undefined),
    needsUser: vi.fn().mockResolvedValue(undefined),
    confirmIdentity: vi.fn().mockResolvedValue(undefined),
    clearSiteCookies: vi.fn(),
    saveIdentity: vi.fn().mockResolvedValue(undefined),
  };
}

function renderLottery(options: { account?: string; winner?: string; done?: boolean } = {}) {
  document.body.innerHTML = `
    <header><button aria-haspopup="menu">${options.account ?? 'Q'}</button></header>
    <main class="lottery-page">
      <div class="lottery-page-heading">浮梦引光
        <span>${options.done ? '抽中：晚舟裁月 +$2' : '等待开奖'}</span>
      </div>
      <button class="lottery-board-center" ${options.done ? 'disabled' : ''}>
        <span>${options.done ? '今日已抽' : '开始抽奖'}</span>
        <small>剩余次数：${options.done ? 0 : 1}</small>
      </button>
      <p class="lottery-notice">签筒已备，且看今日梦火花落谁家。</p>
      <aside class="lottery-sidebar">
        <h2>所有中奖名单</h2>
        <div>${options.winner ?? 'sx5731@qq.com'} +$2</div>
      </aside>
    </main>`;
  const center = document.querySelector<HTMLButtonElement>('.lottery-board-center')!;
  center.addEventListener('click', () => {
    center.disabled = true;
    center.querySelector('span')!.textContent = '今日已抽';
    document.querySelector('.lottery-notice')!.textContent = '今日梦火抽签次数已耗尽';
  });
  return center;
}

async function run(input: LoginTask, targetHost: EngineHost) {
  const pending = runTask(input, targetHost);
  await vi.runAllTimersAsync();
  return pending;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal('location', new URL(`${ORIGIN}/lottery`));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
  localStorage.clear();
  sessionStorage.clear();
  Object.defineProperty(document.body, 'innerText', {
    configurable: true,
    get: () => document.body.textContent ?? '',
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.isConnected && !this.hidden ? new DOMRect(100, 100, 134, 134) : new DOMRect();
  });
  vi.mocked(performCheckin).mockImplementation((site, log) => runLeileiDaily(site, log));
});

afterEach(() => {
  document.body.innerHTML = '';
  Reflect.deleteProperty(document.body, 'innerText');
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('一梦五千年登录到抽奖的身份衔接', () => {
  it('本轮表单登录成功后跨页进入抽奖，名单邮箱不再触发退出且只点一次抽奖', async () => {
    vi.stubGlobal('location', new URL(`${ORIGIN}/sign-in`));
    const targetHost = host();
    let confirmed = false;
    vi.mocked(targetHost.confirmIdentity!).mockImplementation(async () => { confirmed = true; });

    expect(await run(task({ stage: 'login', identityConfirmed: false }), targetHost)).toBeNull();
    expect(confirmed).toBe(true);
    expect(targetHost.navigate).toHaveBeenCalledWith(`${ORIGIN}/lottery`, expect.any(Array), 'checkin');

    const [, previousSteps] = vi.mocked(targetHost.navigate).mock.calls[0]!;
    vi.mocked(targetHost.navigate).mockClear();
    vi.stubGlobal('location', new URL(`${ORIGIN}/lottery`));
    const center = renderLottery();
    const result = await run(task({ identityConfirmed: confirmed, steps: previousSteps }), targetHost);

    expect(result).toMatchObject({ ok: true, message: '一梦五千年抽奖已完成' });
    expect(result?.steps).toContain('本轮登录账号已经确认，签到页暂未返回额外身份字段，继续签到');
    expect(realClick).toHaveBeenCalledExactlyOnceWith(center, { mayNavigate: false });
    expect(logoutSession).not.toHaveBeenCalled();
    expect(targetHost.clearSiteCookies).not.toHaveBeenCalled();
    expect(targetHost.navigate).not.toHaveBeenCalled();
    expect(targetHost.saveIdentity).not.toHaveBeenCalled();
  });

  it('截图已经显示本账号今日已抽时直接完成，不退出也不重复抽奖', async () => {
    renderLottery({ done: true });
    const targetHost = host();

    expect(await run(task(), targetHost)).toMatchObject({ ok: true, message: '一梦五千年今日已抽' });
    expect(realClick).not.toHaveBeenCalled();
    expect(logoutSession).not.toHaveBeenCalled();
    expect(targetHost.navigate).not.toHaveBeenCalled();
  });

  it('真实账号菜单显示其他账号时，本轮登录标记不能覆盖冲突', async () => {
    renderLottery({ account: 'other@example.com', winner: 'qq3306' });
    const targetHost = host();

    expect(await run(task(), targetHost)).toBeNull();
    expect(logoutSession).toHaveBeenCalledOnce();
    expect(targetHost.navigate).toHaveBeenCalledWith(`${ORIGIN}/sign-in`, expect.any(Array), 'login');
    expect(realClick).not.toHaveBeenCalled();
  });

  it('权威接口返回另一个用户 ID 时仍阻断抽奖', async () => {
    renderLottery({ winner: 'qq3306' });
    vi.mocked(fetch).mockImplementation(async () => new Response(
      JSON.stringify({ data: { id: 777, username: 'another-user' } }),
      { headers: { 'content-type': 'application/json' } },
    ));

    await run(task({ accountIdentityUserId: '3306' }), host());
    expect(logoutSession).toHaveBeenCalledOnce();
    expect(realClick).not.toHaveBeenCalled();
  });

  it('没有本轮登录确认时，名单中出现目标账号也不能跳过身份核对', async () => {
    renderLottery({ winner: 'qq3306' });

    await run(task({ identityConfirmed: false }), host());
    expect(logoutSession).toHaveBeenCalledOnce();
    expect(realClick).not.toHaveBeenCalled();
  });

  it('用户菜单明确显示目标账号时，仍可确认身份并正常抽奖', async () => {
    const center = renderLottery({ account: 'qq3306' });
    const targetHost = host();

    expect(await run(task({ identityConfirmed: false }), targetHost)).toMatchObject({ ok: true });
    expect(targetHost.confirmIdentity).toHaveBeenCalledOnce();
    expect(targetHost.saveIdentity).not.toHaveBeenCalled();
    expect(realClick).toHaveBeenCalledExactlyOnceWith(center, { mayNavigate: false });
    expect(logoutSession).not.toHaveBeenCalled();
  });
});
