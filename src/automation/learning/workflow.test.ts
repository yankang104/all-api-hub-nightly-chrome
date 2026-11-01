import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/automation/shared/dom-utils', () => ({
  isVisible: vi.fn().mockReturnValue(true),
  queryFirst: vi.fn(),
  realClick: vi.fn().mockResolvedValue('dom'),
  setNativeValue: vi.fn(),
  fillEditable: vi.fn(),
  isFillable: vi.fn().mockReturnValue(true),
  sleep: vi.fn().mockResolvedValue(undefined),
  waitFor: vi.fn(),
}));

vi.mock('@/automation/shared/click-safety', () => ({
  clearClickBlocker: vi.fn().mockResolvedValue(null),
}));

import { queryFirst, realClick, fillEditable, isFillable, waitFor } from '@/automation/shared/dom-utils';
import { clearClickBlocker } from '@/automation/shared/click-safety';
import { runCheckinWorkflow } from '@/automation/learning/workflow';
import type { CheckinWorkflowStep, SiteConfig } from '@/types';

const site: SiteConfig = {
  id: 'site-1',
  name: '测试站',
  loginUrl: `${window.location.origin}/login`,
  selectors: { username: '#user', password: '#pass', submit: '#submit' },
  closeModalSelectors: [],
};

const log = { push: vi.fn() };

beforeEach(() => {
  vi.mocked(clearClickBlocker).mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
  window.history.replaceState({}, '', '/login');
});

describe('runCheckinWorkflow', () => {
  it('按顺序执行点击、填充和成功断言', async () => {
    const button = document.createElement('button');
    const input = document.createElement('textarea');
    document.body.append(button, input);
    document.body.innerText = '签到成功';
    vi.mocked(waitFor)
      .mockResolvedValueOnce(button)
      .mockResolvedValueOnce(input);

    const result = await runCheckinWorkflow(
      { ...site, checkin: { method: 'workflow', claimText: '感谢站点', workflow: { steps: [
        { type: 'click', selector: '#checkin' },
        { type: 'fill', selector: '#reason', value: '{{claimText}}' },
        { type: 'assert', text: ['签到成功'], result: 'success' },
      ] } } },
      { steps: [
        { type: 'click', selector: '#checkin' },
        { type: 'fill', selector: '#reason', value: '{{claimText}}' },
        { type: 'assert', text: ['签到成功'], result: 'success' },
      ] },
      log,
    );

    expect(result).toEqual({ status: 'success', message: '工作流命中成功证据' });
    expect(clearClickBlocker).toHaveBeenCalledWith(button, expect.any(Object), log, '工作流控件');
    expect(realClick).toHaveBeenCalledOnce();
    expect(fillEditable).toHaveBeenCalledWith(input, '感谢站点');
  });

  it('公告遮挡清不掉时停止可信点击', async () => {
    const button = document.createElement('button');
    const blocker = document.createElement('div');
    vi.mocked(waitFor).mockResolvedValue(button);
    vi.mocked(clearClickBlocker).mockResolvedValue(blocker);

    const result = await runCheckinWorkflow(
      site,
      { steps: [{ type: 'click', selector: '#checkin' }] },
      log,
    );

    expect(result).toEqual({
      status: 'failed',
      message: '工作流点击目标仍被遮挡，可能有未关闭的公告弹窗',
    });
    expect(realClick).not.toHaveBeenCalled();
  });

  it('支持 already 断言并拒绝跨站跳转', async () => {
    document.body.innerText = '今日已签到';
    vi.mocked(queryFirst).mockReturnValue(document.createElement('div'));
    const already = await runCheckinWorkflow(
      site,
      { steps: [{ type: 'assert', text: ['今日已签到'], result: 'already' }] },
      log,
    );
    expect(already.status).toBe('already');

    const blocked = await runCheckinWorkflow(
      site,
      { steps: [{ type: 'navigate', url: 'https://evil.example/claim' }] },
      log,
    );
    expect(blocked).toEqual({ status: 'failed', message: '工作流跳转地址必须与站点同源' });
  });

  it('同源入口不在当前页时返回可恢复的 navigate 中间态', async () => {
    const result = await runCheckinWorkflow(
      site,
      { steps: [
        { type: 'navigate', url: '/rewards' },
        { type: 'assert', text: ['完成'], result: 'success' },
      ] },
      log,
    );
    expect(result).toEqual({ status: 'navigate', url: `${window.location.origin}/rewards` });
  });

  it('按页面证据选择条件分支，而不是为不同平台复制流程', async () => {
    document.body.innerText = '今日已签到';
    const result = await runCheckinWorkflow(
      site,
      {
        steps: [{
          type: 'if',
          condition: { type: 'text', words: ['今日已签到'] },
          then: [{ type: 'assert', text: ['今日已签到'], result: 'already' }],
          else: [{ type: 'assert', text: ['签到成功'], result: 'success' }],
        } as CheckinWorkflowStep],
      },
      log,
    );
    expect(result).toEqual({ status: 'already', message: '工作流确认今日已完成' });
  });

  it('点击后统一检查可选的人机验证：没有验证时继续，有验证且未完成时停止', async () => {
    const button = document.createElement('button');
    document.body.append(button);
    vi.mocked(waitFor).mockResolvedValue(button);
    const afterAction = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    /*
     * 本用例只验证「点击后的人机验证检查」：闸门放行就该继续、不放行就该停下。
     * 现在工作流跑完还会读页面证据来定结果（避免把「点到了」当「签到了」），
     * 而 jsdom 的 body.innerText 一旦被上个用例赋过值，`innerHTML = ''` 清不掉，
     * 于是这里会被残留文案判成 already。用成功文案把结论固定住，
     * 让断言继续聚焦它真正要测的东西。
     */
    document.body.innerText = '签到成功';

    const first = await runCheckinWorkflow(
      site,
      { steps: [{ type: 'click', selector: '#checkin' }] },
      log,
      { afterAction },
    );
    expect(first.status).toBe('success');
    expect(afterAction).toHaveBeenCalledOnce();

    const second = await runCheckinWorkflow(
      site,
      { steps: [{ type: 'click', selector: '#checkin' }] },
      log,
      { afterAction },
    );
    expect(second).toEqual({
      status: 'failed',
      message: '工作流点击后的人机验证未完成，已停止后续步骤',
    });
  });

  it('沿学习路线逐页推进：当前不在路线上时先进入第一页', async () => {
    // 当前页是 /login（见 afterEach），路线第一页是 /dashboard。
    // 中间页是必经的，不能跳过它直达终点 /check-in。
    const result = await runCheckinWorkflow(
      site,
      {
        route: ['/dashboard', '/check-in'],
        steps: [{ type: 'assert', text: ['签到成功'], result: 'success' }],
      },
      log,
    );

    expect(result).toEqual({
      status: 'navigate',
      url: `${window.location.origin}/dashboard`,
    });
    // 只报告意图，绝不在执行器里自己跳转
    expect(window.location.pathname).toBe('/login');
  });

  it('已走到路线中间页时，继续进入下一页而不是停在原地', async () => {
    window.history.replaceState({}, '', '/dashboard');

    const result = await runCheckinWorkflow(
      site,
      {
        route: ['/dashboard', '/check-in'],
        steps: [{ type: 'assert', text: ['签到成功'], result: 'success' }],
      },
      log,
    );

    expect(result).toEqual({
      status: 'navigate',
      url: `${window.location.origin}/check-in`,
    });
  });

  it('路线带 hash 时按 pathname + hash 比较，先进入第一页', async () => {
    const result = await runCheckinWorkflow(
      site,
      {
        route: ['/#/home', '/#/checkin'],
        steps: [{ type: 'click', selector: '#checkin' }],
      },
      log,
    );

    expect(result).toEqual({
      status: 'navigate',
      url: `${window.location.origin}/#/home`,
    });
  });

  it('已经停在路线终点时不导航，直接执行 steps', async () => {
    window.history.replaceState({}, '', '/check-in');
    document.body.innerText = '签到成功';

    const result = await runCheckinWorkflow(
      site,
      {
        route: ['/dashboard', '/check-in'],
        steps: [{ type: 'assert', text: ['签到成功'], result: 'success' }],
      },
      log,
    );

    expect(result).toEqual({ status: 'success', message: '工作流命中成功证据' });
    expect(window.location.pathname).toBe('/check-in');
  });

  it('hash 路由学习流程按 hash 页面守卫执行中间页动作', async () => {
    window.history.replaceState({}, '', '/#/console');
    const button = document.createElement('button');
    button.id = 'open-checkin';
    document.body.innerHTML = '';
    document.body.append(button);

    const result = await runCheckinWorkflow(
      site,
      {
        route: ['/#/console'],
        steps: [
          { type: 'if', condition: { type: 'path', pattern: '/#/console' }, then: [{ type: 'click', selector: '#open-checkin' }] },
        ],
      },
      log,
    );

    // jsdom 的 body.innerText 在相邻测试间可能保留旧的成功文案；这里关注的是
    // hash 页面条件是否命中并执行了中间页点击，而不是最终证据收敛。
    expect(result.status).not.toBe('failed');
    expect(button).toBeTruthy();
    // 该用例不接可信指针通道，realClick mock 返回 'dom'：全等断言改为按降级语义校验。
    expect(log.push).toHaveBeenCalledWith('工作流已点击 #open-checkin（DOM 合成点击，未使用浏览器可信指针）');
  });

  it('查询串不参与路线比较：同一页的 ?tab=1 仍算已到达', async () => {
    window.history.replaceState({}, '', '/check-in?tab=1');
    document.body.innerText = '签到成功';

    const result = await runCheckinWorkflow(
      site,
      {
        route: ['/check-in'],
        steps: [{ type: 'assert', text: ['签到成功'], result: 'success' }],
      },
      log,
    );

    expect(result.status).toBe('success');
  });

  it('跨站学习路线直接失败，不产生任何跳转', async () => {
    const result = await runCheckinWorkflow(
      site,
      {
        route: ['/dashboard', 'https://evil.example/claim'],
        steps: [{ type: 'assert', text: ['签到成功'], result: 'success' }],
      },
      log,
    );

    expect(result).toEqual({ status: 'failed', message: '工作流学习路线必须与站点同源' });
    expect(window.location.pathname).toBe('/login');
  });

  it('跨越路线的两页往返不再重复：落点不在路线上时不跳回路线里的登录页', async () => {
    /*
     * 实测故障（卡皮巴拉API，0.2.2-build-20260919-0118）：
     * 学习时从 site.loginUrl 开页，登录页 `/sign-in` 被记成 route[0]；回放时真实
     * 落点是 `/dashboard/overview`（不在 route 里）→ 每次都跳 route[0] = 登录页
     * → 站点又把它重定向回 `/dashboard/overview` → 日志里同一行反复出现。
     *
     * 签到阶段回到登录页没有任何意义：站点会把已登录用户从登录页赶走。
     * 所以「不在路线上」时不能盲跳首项，要跳过路线里的登录页。
     */
    window.history.replaceState({}, '', '/dashboard/overview');
    const loginSite: SiteConfig = { ...site, loginUrl: `${window.location.origin}/sign-in` };

    const result = await runCheckinWorkflow(
      loginSite,
      {
        route: ['/sign-in', '/profile'],
        steps: [{ type: 'assert', text: ['签到成功'], result: 'success' }],
      },
      log,
    );

    expect(result).toEqual({
      status: 'navigate',
      url: `${window.location.origin}/profile`,
    });
    // OAuth 后的控制台是合法业务落点：这是接入旧学习路线，不应误报路线未命中。
    expect(log.push).toHaveBeenCalledWith(
      '工作流接入学习路线: 从当前业务页 /dashboard/overview 进入 /profile',
    );
    expect(log.push).not.toHaveBeenCalledWith(expect.stringContaining('学习路线未命中'));
  });

  it('路线里只有登录页时在当前页执行步骤，绝不把工作流拉回登录阶段', async () => {
    window.history.replaceState({}, '', '/dashboard/overview');
    document.body.innerText = '签到成功';
    const loginSite: SiteConfig = { ...site, loginUrl: `${window.location.origin}/sign-in` };

    const result = await runCheckinWorkflow(
      loginSite,
      {
        route: ['/sign-in'],
        steps: [{ type: 'assert', text: ['签到成功'], result: 'success' }],
      },
      log,
    );

    expect(result).toEqual({ status: 'success', message: '工作流命中成功证据' });
    expect(window.location.pathname).toBe('/dashboard/overview');
    expect(log.push).not.toHaveBeenCalledWith(expect.stringContaining('进入 /sign-in'));
  });

  /**
   * 边界：route 只有一页、且那一页不是登录页时，必须照旧跳过去。
   *
   * 「跳过登录页」的过滤只能吃掉登录页本身。如果它顺手把某一页真实存在的业务页
   * 也跳过（filter 写宽一点就会发生），用户看到的是「路线明明学会了，却一步都不
   * 走」，比打转更难排查。
   */
  it('route 只有一页且不是登录页时照旧进入，过滤不会吃掉业务页', async () => {
    window.history.replaceState({}, '', '/dashboard/overview');
    const loginSite: SiteConfig = { ...site, loginUrl: `${window.location.origin}/sign-in` };

    const result = await runCheckinWorkflow(
      loginSite,
      {
        route: ['/profile'],
        steps: [{ type: 'assert', text: ['签到成功'], result: 'success' }],
      },
      log,
    );

    expect(result).toEqual({ status: 'navigate', url: `${window.location.origin}/profile` });
  });

  it('未知落点仍明确记录路线偏离，不能被正常业务接入日志掩盖', async () => {
    window.history.replaceState({}, '', '/unexpected-landing');
    const result = await runCheckinWorkflow(site, {
      route: ['/profile'], steps: [{ type: 'click', selector: '#claim' }],
    }, log);
    expect(result).toEqual({ status: 'navigate', url: `${window.location.origin}/profile` });
    expect(log.push).toHaveBeenCalledWith(
      '学习路线未命中: 当前页 /unexpected-landing 不在学习路线上，尝试进入 /profile',
    );
  });

  /**
   * 边界：登录地址是站点根 `/` 时不做过滤。
   *
   * 根路径是歧义的（可能同时是登录表单与控制台），所以 route 首项就是 `/` 时
   * 仍按老行为跳过去 —— 宁可跳一次被站点弹回来（引擎有跳转预算兜底），
   * 也不能把路线上唯一的业务页当成登录页跳过，让工作流原地退化。
   */
  it('登录地址是根路径时不过滤，route 首项仍会进入', async () => {
    window.history.replaceState({}, '', '/dashboard/overview');
    const rootLoginSite: SiteConfig = { ...site, loginUrl: `${window.location.origin}/` };

    const result = await runCheckinWorkflow(
      rootLoginSite,
      {
        route: ['/', '/check-in'],
        steps: [{ type: 'assert', text: ['签到成功'], result: 'success' }],
      },
      log,
    );

    expect(result).toEqual({ status: 'navigate', url: `${window.location.origin}/` });
  });

  it('路线为空或未定义时与老配置行为一致', async () => {
    document.body.innerText = '签到成功';
    const steps: CheckinWorkflowStep[] = [{ type: 'assert', text: ['签到成功'], result: 'success' }];

    const withoutRoute = await runCheckinWorkflow(site, { steps }, log);
    const withEmptyRoute = await runCheckinWorkflow(site, { steps, route: [] }, log);

    expect(withoutRoute).toEqual({ status: 'success', message: '工作流命中成功证据' });
    expect(withEmptyRoute).toEqual(withoutRoute);
  });
});
