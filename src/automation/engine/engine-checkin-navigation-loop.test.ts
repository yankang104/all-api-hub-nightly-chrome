/**
 * 签到页跳转的循环护栏。
 *
 * 修的是一个实测死循环（一梦五千年）：站点配置的签到页是
 * `/console/personal`，而站点把它**重定向**到 `/profile`。于是：
 *
 *   跳转 /console/personal → 站点转到 /profile → 脚本重新注入
 *   → stage 仍是 checkin → 判定"还没到签到页" → 再跳 → ……
 *
 * 日志里同一段反复出现，直到 10 分钟看门狗把任务杀掉，界面上一直显示
 * 「正在签到」。用户完全看不出发生了什么。
 *
 * 计数写在步骤日志里而不是内存变量：整页跳转会销毁 content script，
 * 只有落进信箱的日志能跨跳转存活。与 PAGE_RETRY_MARKER 同一套办法。
 *
 * 这条护栏对**任何**把签到页重定向的站点都生效，不是给某个站点打的补丁。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  // 模拟"站点把签到页重定向了"：签到模块每次都说"去 /console/personal"
  performCheckin: vi.fn(),
}));

vi.mock('@/automation/shared/dom-utils', () => ({ sleep: vi.fn().mockResolvedValue(undefined) }));

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
    clearedKeys: 0, serverLogout: false, cookieMayRemain: false,
  }),
  readPageIdentity: vi.fn().mockResolvedValue({ userId: '338', source: 'visible' }),
  verifyIdentity: vi.fn().mockReturnValue({ match: 'confirmed', detail: '用户 ID 338 一致' }),
}));

vi.mock('@/automation/login/token-refresh', () => ({ ensureFreshToken: vi.fn() }));

import { performCheckin } from '@/automation/checkin/checkin';
import { runTask } from '@/automation/engine/engine';

const CHECKIN_URL = `${window.location.origin}/console/personal`;

function taskWith(steps: string[]): LoginTask {
  return {
    tabId: 1,
    runId: 'run-loop',
    accountId: 'account-1',
    siteId: 'site-1',
    username: 'qq3306',
    password: 'secret',
    site: {
      id: 'site-1',
      name: '一梦五千年',
      loginUrl: `${window.location.origin}/sign-in`,
      loginMethod: 'form',
      selectors: { username: '#username', password: '#password', submit: 'button[type="submit"]' },
      closeModalSelectors: [],
      checkin: { method: 'auto', url: CHECKIN_URL },
    },
    siteAccountCount: 1,
    identityConfirmed: true,
    createdAt: Date.now(),
    stage: 'checkin',
    steps,
  };
}

describe('签到页跳转循环护栏', () => {
  // mock 的调用记录会跨用例累积；不清的话 toHaveBeenCalledTimes 和
  // mock.calls[n] 都会读到上一个用例的调用，断言看着像实现问题。
  beforeEach(() => {
    vi.mocked(performCheckin).mockReset();
  });

  it('第一次跳转正常放行，并写入可跨页计数的标记', async () => {
    vi.mocked(performCheckin).mockResolvedValue({ status: 'navigate', url: CHECKIN_URL });
    const steps: string[] = [];
    const host: EngineHost = {
      markStage: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
      needsUser: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runTask(taskWith(steps), host);

    // 返回 null 表示"页面即将跳转，由新页面接着跑"
    expect(result).toBeNull();
    expect(host.navigate).toHaveBeenCalledOnce();
    // 标记必须落进 steps，否则下一个文档数不出已经跳过几次
    expect(host.navigate).toHaveBeenCalledWith(
      CHECKIN_URL,
      expect.arrayContaining([expect.stringContaining('/console/personal')]),
      'checkin',
    );
  });

  it('第二次仍放行（容许一次瞬时失败）', async () => {
    vi.mocked(performCheckin).mockResolvedValue({ status: 'navigate', url: CHECKIN_URL });
    const steps = ['进入签到页: /console/personal'];
    const host: EngineHost = {
      markStage: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
      needsUser: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runTask(taskWith(steps), host);

    expect(result).toBeNull();
    expect(host.navigate).toHaveBeenCalledOnce();
  });

  it('第三次不再跳转，改为在当前页尝试签到', async () => {
    /*
     * 关键行为：跳不过去时**在当前落地页找签到入口**，而不是直接失败。
     *
     * 站点把配置地址重定向掉，说明那个地址在这个站上不存在；但当前页往往
     * 就是站点自己的控制台，签到入口很可能就在上面。直接 fail 等于「因为
     * 配置写错了地址，就放弃这一页上明摆着的签到按钮」。
     */
    const steps = [
      '进入签到页: /console/personal',
      '进入签到页: /console/personal',
    ];
    const host: EngineHost = {
      markStage: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
      needsUser: vi.fn().mockResolvedValue(undefined),
    };
    // 第一次（带 checkin.url 的站点配置）要求跳转；第二次（清掉 url 之后）
    // 在当前页找到了签到入口并成功。
    vi.mocked(performCheckin)
      .mockResolvedValueOnce({ status: 'navigate', url: CHECKIN_URL })
      .mockResolvedValueOnce({ status: 'success', message: '当前页签到完成' });

    const result = await runTask(taskWith(steps), host);

    // 不再跳转 —— 死循环被切断
    expect(host.navigate).not.toHaveBeenCalled();
    // 而且真的在当前页签成了，不是放弃
    expect(result).toMatchObject({ ok: true, message: '当前页签到完成' });
    expect(performCheckin).toHaveBeenCalledTimes(2);
  });

  it('降级扫描时清掉 checkin.url 与家族兜底路径，否则又会要求跳转', async () => {
    const steps = [
      '进入签到页: /console/personal',
      '进入签到页: /console/personal',
    ];
    const host: EngineHost = {
      markStage: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
      needsUser: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(performCheckin)
      .mockResolvedValueOnce({ status: 'navigate', url: CHECKIN_URL })
      .mockResolvedValueOnce({ status: 'already', message: '页面显示今日已签到' });

    await runTask(taskWith(steps), host);

    const secondCallSite = vi.mocked(performCheckin).mock.calls[1]![0];
    // 到不了的地址要清掉 —— 留着会让扫描再次返回 navigate
    expect(secondCallSite.checkin?.url).toBeUndefined();
    expect(secondCallSite.adapter?.checkinPath).toBe('');
    /*
     * 但 pathPatterns 必须包含**当前路径**，不能清空。
     *
     * `checkin.ts` 用 `onCheckinPage` 决定等多久：在签到页等 12 秒（给 SPA
     * 拉接口、渲染面板），不在签到页只等 3 秒。清空 pathPatterns 会让当前页
     * 被判成"不是签到页"，只等 3 秒就扫描 —— SPA 还没渲染出「每日签到」面板，
     * 日志里只列出导航栏和侧栏（海獭 AI 实测）。
     */
    expect(secondCallSite.adapter?.checkin?.pathPatterns).toContain(window.location.pathname);
  });

  it('当前页也没有入口时，改试还没去过的常见签到路由', async () => {
    /*
     * 实测海獭 AI：配置 `/console/personal` 被站点转到 `/profile`，而 `/profile`
     * 上只有页面骨架（侧栏 / 搜索 / 通知 / 主题），签到入口在别的路由上。
     * 只扫一页就放弃，等于把「配置地址写错了」变成「这站不支持签到」。
     */
    const steps = [
      '进入签到页: /console/personal',
      '进入签到页: /console/personal',
    ];
    const host: EngineHost = {
      markStage: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
      needsUser: vi.fn().mockResolvedValue(undefined),
    };
    // 两次都要求跳转 —— 当前页确实没有可执行的入口
    vi.mocked(performCheckin).mockResolvedValue({ status: 'navigate', url: CHECKIN_URL });

    const result = await runTask(taskWith(steps), host);

    // 不再失败，而是去试下一个候选路由
    expect(result).toBeNull();
    expect(host.navigate).toHaveBeenCalledOnce();
    const [navigatedTo] = vi.mocked(host.navigate!).mock.calls[0]!;
    // /console/personal 已经试过，必须换一个
    expect(navigatedTo).not.toContain('/console/personal');
    expect(navigatedTo).toMatch(/\/profile|\/dashboard/);
  });

  it('所有候选路由都试过后才失败，并列出试过哪些', async () => {
    // 把全部候选路由都标成已访问
    const steps = [
      '进入签到页: /console/personal',
      '进入签到页: /console/personal',
      '进入签到页: /profile',
      '进入签到页: /dashboard/overview',
      '进入签到页: /dashboard',
      '进入签到页: /console',
      '进入签到页: /check-in',
      '进入签到页: /checkin',
    ];
    const host: EngineHost = {
      markStage: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
      needsUser: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(performCheckin).mockResolvedValue({ status: 'navigate', url: CHECKIN_URL });

    const result = await runTask(taskWith(steps), host);

    expect(host.navigate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false });
    // 失败原因要说清试过哪些、该改什么
    expect(result!.message).toContain('/console/personal');
    expect(result!.message).toContain('已试过');
    expect(result!.message).toContain('站点编辑');
  });

  /**
   * 这条锁住的是一个真实的漏修。
   *
   * 降级扫描找不到入口时，`performCheckin` 返回的是 **`failed`**
   * （checkin.ts 末尾「签到页未找到明确按钮或已签到状态」），不是 `navigate`。
   * 上一版只对 `navigate` 触发候选路由，于是 `failed` 直接被 settle 判成终态，
   * 候选表**一次都没跑到** —— 用户日志停在「页面可点元素：跳到主内容 /
   * Toggle Sidebar / …」，看起来像修复完全没生效。
   */
  it('降级扫描返回 failed 时也继续试候选路由（不是直接判失败）', async () => {
    const steps = [
      '进入签到页: /console/personal',
      '进入签到页: /console/personal',
    ];
    const host: EngineHost = {
      markStage: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
      needsUser: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(performCheckin)
      .mockResolvedValueOnce({ status: 'navigate', url: CHECKIN_URL })
      // 这正是实际返回值：扫描没找到按钮
      .mockResolvedValueOnce({ status: 'failed', message: '签到页未找到明确按钮或已签到状态' });

    const result = await runTask(taskWith(steps), host);

    // 必须去试别的路由，而不是就此失败
    expect(result).toBeNull();
    expect(host.navigate).toHaveBeenCalledOnce();
    const [navigatedTo] = vi.mocked(host.navigate!).mock.calls[0]!;
    expect(navigatedTo).not.toContain('/console/personal');
  });

  it('降级扫描返回 skipped 时也继续试候选路由', async () => {
    const steps = [
      '进入签到页: /console/personal',
      '进入签到页: /console/personal',
    ];
    const host: EngineHost = {
      markStage: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
      needsUser: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(performCheckin)
      .mockResolvedValueOnce({ status: 'navigate', url: CHECKIN_URL })
      .mockResolvedValueOnce({ status: 'skipped', message: '这一页没有签到入口' });

    const result = await runTask(taskWith(steps), host);

    expect(result).toBeNull();
    expect(host.navigate).toHaveBeenCalledOnce();
  });

  it('降级扫描签到成功时立刻收尾，不再换页', async () => {
    const steps = [
      '进入签到页: /console/personal',
      '进入签到页: /console/personal',
    ];
    const host: EngineHost = {
      markStage: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
      needsUser: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(performCheckin)
      .mockResolvedValueOnce({ status: 'navigate', url: CHECKIN_URL })
      .mockResolvedValueOnce({
        status: 'success',
        message: '签到完成',
        metrics: { verdict: 'rewarded' },
      });

    const result = await runTask(taskWith(steps), host);

    expect(host.navigate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, message: '签到完成' });
    // 差分结果要传回界面，不能被降级路径吞掉
    expect(result!.metrics).toEqual({ verdict: 'rewarded' });
  });

  it('降级扫描判定「今日已签到」时立刻收尾', async () => {
    const steps = [
      '进入签到页: /console/personal',
      '进入签到页: /console/personal',
    ];
    const host: EngineHost = {
      markStage: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
      needsUser: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(performCheckin)
      .mockResolvedValueOnce({ status: 'navigate', url: CHECKIN_URL })
      .mockResolvedValueOnce({ status: 'already', message: '页面显示今日已签到' });

    const result = await runTask(taskWith(steps), host);

    expect(host.navigate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, message: '页面显示今日已签到' });
  });

  it('不同签到页各自独立计数，不互相干扰', async () => {
    const otherUrl = `${window.location.origin}/other-checkin`;
    vi.mocked(performCheckin).mockResolvedValue({ status: 'navigate', url: otherUrl });
    // 已经为 /console/personal 跳满 2 次，但目标换成别的地址
    const steps = [
      '进入签到页: /console/personal',
      '进入签到页: /console/personal',
    ];
    const host: EngineHost = {
      markStage: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
      needsUser: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runTask(taskWith(steps), host);

    expect(result).toBeNull();
    expect(host.navigate).toHaveBeenCalledOnce();
  });

  it('计数只看 pathname + search，hash 变化不算换页（SPA 路由）', async () => {
    const hashUrl = `${window.location.origin}/console/personal#/daily`;
    vi.mocked(performCheckin).mockResolvedValue({ status: 'navigate', url: hashUrl });
    const steps = [
      '进入签到页: /console/personal',
      '进入签到页: /console/personal',
    ];
    const host: EngineHost = {
      markStage: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
      needsUser: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runTask(taskWith(steps), host);

    /*
     * 同一个 pathname 仍然计入 —— 否则带 hash 的地址能绕过护栏无限跳。
     *
     * 计数命中后进入降级：当前页扫不到入口，于是改试**别的**候选路由。
     * 要断言的是「不再跳同一个 pathname」，而不是「完全不跳」。
     */
    expect(result).toBeNull();
    expect(host.navigate).toHaveBeenCalledOnce();
    const [navigatedTo] = vi.mocked(host.navigate!).mock.calls[0]!;
    expect(navigatedTo).not.toContain('/console/personal');
  });

  it('签到成功时不受护栏影响', async () => {
    vi.mocked(performCheckin).mockResolvedValue({ status: 'success', message: '签到完成' });
    const steps = [
      '进入签到页: /console/personal',
      '进入签到页: /console/personal',
    ];
    const host: EngineHost = {
      markStage: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
      needsUser: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runTask(taskWith(steps), host);

    expect(result).toMatchObject({ ok: true, message: '签到完成' });
  });

  it('relogin 跳转不受签到页护栏限制（它有自己的流程）', async () => {
    vi.mocked(performCheckin).mockResolvedValue({
      status: 'relogin',
      url: `${window.location.origin}/sign-in`,
      message: '退出后重新登录',
    });
    const steps = [
      '进入签到页: /console/personal',
      '进入签到页: /console/personal',
    ];
    const host: EngineHost = {
      markStage: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
      needsUser: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runTask(taskWith(steps), host);

    expect(result).toBeNull();
    expect(host.navigate).toHaveBeenCalledOnce();
  });

  /**
   * 两页往返震荡。
   *
   * 用户的真实日志：「工作流沿学习路线进入 /sign-in」重复四次，中间站点把
   * `/sign-in` 重定向回 `/dashboard/overview` —— 也就是说，**同一个地址的计数
   * 挡不住「登录页 ↔ 落地页」这种两页来回**：A 跳一次、B 跳一次、再回 A。
   * 这里用最近几次导航的地址序列识别 A→B→A，立刻停止路线推进。
   */
  it('两页往返震荡（A→B→A）时停止跳转，改为在当前页签到', async () => {
    const steps = [
      '进入签到页: /console/personal',
      '进入签到页: /profile',
      '进入签到页: /console/personal',
    ];
    const host: EngineHost = {
      markStage: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
      needsUser: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(performCheckin)
      .mockResolvedValueOnce({ status: 'navigate', url: `${window.location.origin}/profile` })
      .mockResolvedValueOnce({ status: 'already', message: '页面显示今日已签到' });

    const result = await runTask(taskWith(steps), host);

    // 不再跳第 4 次（/profile）—— 往返被切断
    expect(host.navigate).not.toHaveBeenCalled();
    // 仍然把当前页扫完，给出真结论
    expect(result).toMatchObject({ ok: true, message: '页面显示今日已签到' });
    // 日志必须说清是「往返」而不是某一次跳转失败
    expect(result!.steps.some((step) => step.includes('往返'))).toBe(true);
  });

  /**
   * 落点不在学习路线上时的有界收敛（工作流侧）。
   *
   * resolveRoute 在「当前页不在 route 里」时会尝试跳回路线（并写下
   * 「学习路线未命中: …」）。但如果站点每次都把当前页重定向回同一个落地页，
   * 这个尝试本身就会变成死循环 —— 所以给它单独的、跨页面计数的预算：
   * 缺少独立资料页的学习配置不能借预算降级绕过身份核验。
   */
  it('学习路线缺少独立资料页时，预算用尽也不能降级盲签', async () => {
    const steps = [
      // 上一页已经因为「落点不在路线上」跳过一次 /profile（见 workflow.ts 的标记）
      '工作流接入学习路线: 从当前业务页 /dashboard/overview 进入 /profile',
      '工作流沿学习路线进入 /profile（第 2/2 页）',
      '进入签到页: /profile',
    ];
    const host: EngineHost = {
      markStage: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
      needsUser: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(performCheckin)
      .mockResolvedValueOnce({ status: 'navigate', url: `${window.location.origin}/profile` })
      .mockResolvedValueOnce({ status: 'success', message: '当前页签到完成' });
    const task: LoginTask = {
      ...taskWith(steps),
      site: {
        ...taskWith(steps).site,
        checkin: {
          method: 'workflow',
          workflow: {
            steps: [{ type: 'click', selector: '#checkin' }],
            route: ['/sign-in', '/profile'],
          },
        },
      },
    };

    const result = await runTask(task, host);

    expect(host.navigate).not.toHaveBeenCalled();
    expect(result).toBeNull();
    expect(host.needsUser).toHaveBeenCalledWith(expect.stringContaining('没有记录到可核验账号的身份页'), expect.any(Array));
    expect(performCheckin).not.toHaveBeenCalled();
    expect(task.site.checkin?.workflow?.route).toEqual(['/sign-in', '/profile']);
    expect(task.site.checkin?.workflow?.steps).toEqual([{ type: 'click', selector: '#checkin' }]);
  });
});
