/**
 * 「登录即签到」的跨文档登录标记（FRESH_LOGIN_MARKER）。
 *
 * 用户报：登录即签到站点明明登录成功、余额也确实涨了，结果却是灰色的「未验证」。
 *
 * 根因是登录标记只做了一半的跨文档恢复。`loginCompletedThisRun` 是内存变量，
 * content script 每次整页跳转都会被销毁重建；`runCheckin` 已经用 steps 里的
 * `本轮已全新登录:` 标记把 `loginHappenedThisRun` 恢复了，却漏了同一份 hook 里的
 * `loginCheckinBalanceBefore` —— 而 `performCheckin` 要把 unverified 升级成
 * success，这两个条件必须同时成立（见 checkin.ts 里 `loginHappenedThisRun &&
 * loginCheckinBefore` 那一段）。基线本身一直存在任务信箱的 task.context 里，
 * 本来就活过了跳转，只是没取出来用。
 *
 * 另一半是**反向**风险：steps 会被整轮重试沿用，只做 startsWith 存在性判断的话，
 * 上一轮留下的标记会让「打开时本来就已登录」也被当成「本轮刚登录」，把历史余额
 * 变化误判成本轮奖励（假成功）。所以标记必须与身份核验标记一样，受会话重建事件
 * （重试重登 / 切号 / 退出重登）失效规则约束。
 *
 * mock 形状抄自 engine-button-navigation-balance.test.ts。
 */
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

/** 与 engine.ts 的 FRESH_LOGIN_MARKER 同一串；测试里写死，改名时这里会失败并提示同步。 */
const FRESH_LOGIN_MARKER = '本轮已全新登录:';
const PROFILE_IDENTITY_CONFIRMED_MARKER = '个人资料身份已核验:';

const before: BalanceSnapshot = {
  quota: 1476,
  usedQuota: 0,
  symbol: '积分',
  at: 1,
  fromVisibleText: true,
};

/**
 * 「登录即签到」任务的基线。
 *
 * 注意 stage 用 'checkin'：这正是跨文档之后的形态 —— 登录已完成、页面跳到了
 * 资料页或签到页，新注入的 content script 从 steps 接着跑，内存标记已经没了。
 */
function noneTask(extraSteps: string[]): LoginTask {
  return {
    tabId: 41,
    runId: 'run-fresh-login',
    accountId: 'account-none',
    siteId: 'builtin-none',
    username: 'fzy520',
    password: 'secret',
    effectiveLoginMethod: 'form',
    effectiveCheckinMethod: 'none',
    siteAccountCount: 1,
    identityConfirmed: true,
    site: {
      id: 'builtin-none',
      name: '登录即签到站',
      loginUrl: `${window.location.origin}/login`,
      loginMethod: 'form',
      selectors: { username: '#username', password: '#password', submit: 'button[type="submit"]' },
      closeModalSelectors: [],
      checkin: { method: 'none' },
      adapter: { family: 'new-api', checkinPath: '', quotaPerUnit: 500_000 },
    },
    createdAt: Date.now(),
    stage: 'checkin',
    context: { loginCheckinBalanceBefore: before },
    steps: ['扩展版本 0.2.2', ...extraSteps],
  };
}

const host = (): EngineHost => ({
  markStage: vi.fn().mockResolvedValue(undefined),
  navigate: vi.fn().mockResolvedValue(undefined),
  needsUser: vi.fn().mockResolvedValue(undefined),
  confirmIdentity: vi.fn().mockResolvedValue(undefined),
});

describe('登录即签到：跨文档恢复「本轮已登录」', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(performCheckin).mockReset();
    vi.mocked(detectAlreadyLoggedIn).mockResolvedValue(false);
    vi.mocked(verifyLogin).mockResolvedValue(true);
    vi.mocked(verifyIdentity).mockReturnValue({ match: 'unknown', detail: '读不到当前登录身份' });
  });

  it('跨文档后仍把登录前余额基线交给 none 流程（否则永远 unverified）', async () => {
    vi.mocked(performCheckin).mockImplementation(async (_site, _log, hooks) => {
      expect(hooks?.loginHappenedThisRun).toBe(true);
      // 这就是被漏掉的那一半：基线在 task.context 里、活过了跳转，必须取出来
      expect(hooks?.loginCheckinBalanceBefore).toEqual(before);
      return { status: 'success', message: '登录即签到' };
    });

    const result = await runTask(noneTask([`${FRESH_LOGIN_MARKER}fzy520`]), host());

    expect(result).toMatchObject({ ok: true, message: '登录即签到' });
    expect(performCheckin).toHaveBeenCalledOnce();
  });

  it('没有登录标记时不注入基线，也不声称本轮登录过', async () => {
    vi.mocked(performCheckin).mockImplementation(async (_site, _log, hooks) => {
      expect(hooks?.loginHappenedThisRun).toBe(false);
      expect(hooks?.loginCheckinBalanceBefore).toBeUndefined();
      return { status: 'success', message: '登录即签到' };
    });

    const result = await runTask(noneTask([]), host());

    expect(result).toMatchObject({ ok: true });
    expect(performCheckin).toHaveBeenCalledOnce();
  });

  /*
   * 反向风险：steps 被整轮重试沿用。上一轮的登录标记若不作废，「打开时本来
   * 就已登录」的历史会话会被当成「本轮刚登录」，把历史余额变化冒充成本轮奖励。
   */
  it('登录标记早于最近一次会话重建时失效（避免重试假成功）', async () => {
    vi.mocked(performCheckin).mockImplementation(async (_site, _log, hooks) => {
      expect(hooks?.loginHappenedThisRun).toBe(false);
      expect(hooks?.loginCheckinBalanceBefore).toBeUndefined();
      return { status: 'success', message: '登录即签到' };
    });

    const result = await runTask(noneTask([
      `${FRESH_LOGIN_MARKER}fzy520`,
      // 会话重建：重试重登。之后那个标记代表的登录已经结束。
      '自动重试: 登录未确认 → 3 秒后重试（第 1/3 次）',
    ]), host());

    expect(result).toMatchObject({ ok: true });
    expect(performCheckin).toHaveBeenCalledOnce();
  });

  it('登录标记晚于会话重建时仍然有效', async () => {
    vi.mocked(performCheckin).mockImplementation(async (_site, _log, hooks) => {
      expect(hooks?.loginHappenedThisRun).toBe(true);
      expect(hooks?.loginCheckinBalanceBefore).toEqual(before);
      return { status: 'success', message: '登录即签到' };
    });

    const result = await runTask(noneTask([
      '自动重试: 登录未确认 → 3 秒后重试（第 1/3 次）',
      `${FRESH_LOGIN_MARKER}fzy520`,
    ]), host());

    expect(result).toMatchObject({ ok: true });
    expect(performCheckin).toHaveBeenCalledOnce();
  });

  it('身份核验标记仍按既有规则独立判定', async () => {
    vi.mocked(performCheckin).mockImplementation(async () => (
      { status: 'success', message: '登录即签到' }
    ));

    // 只有 FRESH 标记、没有身份标记：核心点是两者不互相顶替，流程照常收尾。
    const result = await runTask(noneTask([`${FRESH_LOGIN_MARKER}fzy520`]), host());

    expect(result).toMatchObject({ ok: true });
    expect(performCheckin).toHaveBeenCalledOnce();
    expect(vi.mocked(performCheckin).mock.calls[0]?.[2]?.loginHappenedThisRun).toBe(true);
    // 防止标记字符串写错导致「测试通过但功能没生效」
    expect(PROFILE_IDENTITY_CONFIRMED_MARKER).not.toBe(FRESH_LOGIN_MARKER);
  });
});
