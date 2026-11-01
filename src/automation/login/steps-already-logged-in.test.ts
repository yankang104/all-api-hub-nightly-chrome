/**
 * 「打开时是否已经登录」的探测要等到**有结论**，不能固定瞄一眼。
 *
 * 用户现场：浏览器里已登录，站点 SPA 过了几秒才渲染出站内页面。旧实现固定等 2 秒
 * 就下结论，看到的是空白外壳 →「未发现足够的登录成功证据」→ 去找账号输入框 →
 * 报「页面上找不到要操作的控件」，要求用户重新学习一个本来没坏的流程。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SiteConfig } from '@/types';
import type { StepLog } from '@/automation/shared/log';
import { detectAlreadyLoggedIn, hasVisibleLoginPrompt } from '@/automation/login/steps';

/** sleep 里推进的虚拟时间，并在指定时刻把页面「渲染」出来。 */
const clock = vi.hoisted(() => ({ aheadMs: 0, onAdvance: undefined as ((ms: number) => void) | undefined }));

vi.mock('@/automation/shared/dom-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/automation/shared/dom-utils')>();
  return {
    ...actual,
    // jsdom 没有布局：可见性只按 display/visibility 判断，元素一律当作有尺寸。
    isVisible: (el: Element) => {
      const style = window.getComputedStyle(el as HTMLElement);
      return style.display !== 'none' && style.visibility !== 'hidden';
    },
    queryFirst: <T extends Element = HTMLElement>(selectors: string): T | null => {
      for (const selector of selectors.split(',').map((item) => item.trim()).filter(Boolean)) {
        const element = document.querySelector<T>(selector);
        if (element) return element;
      }
      return null;
    },
    sleep: vi.fn(async (ms: number) => {
      clock.aheadMs += ms;
      clock.onAdvance?.(clock.aheadMs);
    }),
  };
});

vi.mock('@/automation/shared/announcements', () => ({
  dismissAnnouncements: vi.fn(async () => ({ closed: 0, gone: true })),
}));

const site: SiteConfig = {
  id: 'site-fixture',
  name: '虚构站点',
  loginUrl: `${window.location.origin}/login`,
  loginMethod: 'form',
  selectors: { username: '#user', password: '#pass', submit: '#sign-in' },
  closeModalSelectors: [],
  successIndicator: '#console-nav',
};

function collectLog(): StepLog & { lines: string[] } {
  const lines: string[] = [];
  return { lines, push: (line: string) => { lines.push(line); } };
}

describe('detectAlreadyLoggedIn 等到有结论为止', () => {
  beforeEach(() => {
    clock.aheadMs = 0;
    clock.onAdvance = undefined;
    document.body.innerHTML = '<div id="app"></div>';
    // 虚拟时钟：Date.now 跟着 sleep 前进，超时循环不真等。
    const start = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => start + clock.aheadMs);
    history.replaceState({}, '', '/login');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    history.replaceState({}, '', '/');
  });

  it('站内页面晚于 2 秒才渲染：仍判为已登录', async () => {
    clock.onAdvance = (ms) => {
      if (ms >= 3_500 && !document.querySelector('#console-nav')) {
        document.body.innerHTML = '<nav id="console-nav">控制台</nav>';
      }
    };
    const log = collectLog();

    expect(await detectAlreadyLoggedIn(site, log)).toBe(true);
    expect(log.lines).toContain('命中登录成功证据，已处于登录状态');
  });

  it('登录表单一出现就判为需要登录，不白等到超时', async () => {
    clock.onAdvance = (ms) => {
      if (ms >= 2_500 && !document.querySelector('#pass')) {
        document.body.innerHTML = '<form><input id="user"><input id="pass" type="password"><button id="sign-in">登录</button></form>';
      }
    };
    const log = collectLog();

    expect(await detectAlreadyLoggedIn(site, log)).toBe(false);
    expect(log.lines).toContain('发现登录表单，需要重新登录');
    expect(clock.aheadMs).toBeLessThan(3_500);
  });

  it('打开时表单已在：等满 2 秒再判，给已登录 SPA 跳走的时间', async () => {
    document.body.innerHTML = '<form><input id="user"><input id="pass" type="password"></form>';
    const log = collectLog();

    expect(await detectAlreadyLoggedIn(site, log)).toBe(false);
    expect(clock.aheadMs).toBe(2_000);
  });

  it('只有页头「登录」链接时不算要求登录（交给站点身份接口去判）', () => {
    document.body.innerHTML = '<header><a href="/login">登录</a></header>';
    history.replaceState({}, '', '/');
    expect(hasVisibleLoginPrompt(site)).toBe(false);
  });

  it('已登录控制台上孤零零的兑换码文本框不算登录表单', () => {
    document.body.innerHTML = '<nav id="console-nav">控制台</nav><input type="text" placeholder="兑换码">';
    expect(hasVisibleLoginPrompt(site)).toBe(false);
  });

  it('站点配了裸 input[type=text] 当用户名选择器（Linux.SB）：已登录页的发帖框不算登录表单', async () => {
    const linuxSb: SiteConfig = { ...site, successIndicator: undefined, selectors: { ...site.selectors, username: 'input[name="username"], input[type="text"]' } };
    document.body.innerHTML = '<a href="/daily_checkin">每日签到</a><input type="text" placeholder="说点什么">';
    history.replaceState({}, '', '/');
    expect(hasVisibleLoginPrompt(linuxSb)).toBe(false);
    expect(await detectAlreadyLoggedIn(linuxSb, collectLog())).toBe(true);
  });

  it('站内证据与页头登录链接同时存在：按已登录处理', async () => {
    const plain: SiteConfig = { ...site, successIndicator: undefined };
    document.body.innerHTML = '<header><a href="/login">登录</a></header><a href="/check-in">签到</a>';
    history.replaceState({}, '', '/');
    expect(await detectAlreadyLoggedIn(plain, collectLog())).toBe(true);
  });

  it('密码框永远优先：成功标志过宽（登录页上也能匹配）时仍判为需要登录', async () => {
    const wide: SiteConfig = { ...site, successIndicator: 'button.primary' };
    document.body.innerHTML = '<form><input id="user" autocomplete="username"><input id="pass" type="password"><button class="primary">登录</button></form>';
    expect(await detectAlreadyLoggedIn(wide, collectLog())).toBe(false);
  });

  it('有账号语义的输入框（autocomplete=username）没有密码框时（多步登录）：页面判为需要登录，但仍去问一次站点身份接口', async () => {
    document.body.innerHTML = '<input id="user" autocomplete="username">';
    const log = collectLog();
    expect(await detectAlreadyLoggedIn(site, log)).toBe(false);
    expect(log.lines).toContain('发现登录表单，需要重新登录');
    // 不跳过身份接口：已登录页上也会有账号/邮箱框，接口说没会话再照常登录。
    expect(hasVisibleLoginPrompt(site)).toBe(false);
  });

  it('已登录页上的「绑定邮箱」输入框不会挡住身份接口探测', () => {
    document.body.innerHTML = '<div role="dialog"><input type="email" placeholder="请绑定邮箱"></div>';
    history.replaceState({}, '', '/');
    expect(hasVisibleLoginPrompt(site)).toBe(false);
  });

  it('二次验证框仍算摆着登录表单，不去问身份接口', () => {
    document.body.innerHTML = '<input autocomplete="one-time-code">';
    expect(hasVisibleLoginPrompt(site)).toBe(true);
  });

  it('只剩页头登录链接、没有任何站内证据：仍判为需要登录（不会把登录页当成已登录）', async () => {
    const plain: SiteConfig = { ...site, successIndicator: undefined };
    document.body.innerHTML = '<header><a href="/login">登录</a></header><main>欢迎</main>';
    history.replaceState({}, '', '/login-landing');
    history.replaceState({}, '', '/');
    expect(await detectAlreadyLoggedIn({ ...plain, loginUrl: `${window.location.origin}/` }, collectLog(), 2_000)).toBe(false);
  });

  it('始终没有任何证据：超时后如实说明，不谎报已登录', async () => {
    const log = collectLog();

    expect(await detectAlreadyLoggedIn(site, log, 2_000)).toBe(false);
    expect(log.lines).toContain('未发现足够的登录成功证据');
  });

  /**
   * 卡皮巴拉（new-api 新版界面）的真实故障：
   *
   * 已登录的 `/profile` 资料页上同时摆着「当前密码 / 新密码 / 确认新密码」的
   * 修改密码卡片。旧判据只要看到**任意**可见密码框就判「这是登录表单」，
   * 于是资料页被判成未登录 → 学习流程每次检查都触发「登录失效」→ 跳回登录页
   * → 再跳回来 → 自动恢复 2 次后仍失败。
   *
   * 现场日志（扩展 0.2.2-build-20261031-1715）：
   *   工作流沿学习路线进入 /profile（第 2/2 页）
   *   学习流程恢复登录: 1/2，返回登录页重新认证
   *   学习流程恢复登录: 2/2，返回登录页重新认证
   *   学习流程中登录状态已失效，需要重新登录；自动恢复 2 次仍未保持会话
   */
  it('已登录资料页上的「修改密码」表单不算登录表单（卡皮巴拉 /profile 现场）', () => {
    document.body.innerHTML = `
      <nav id="console-nav">控制台</nav>
      <section>
        <h2>修改密码</h2>
        <input id="current-password" type="password" placeholder="当前密码">
        <input id="new-password" type="password" placeholder="新密码">
        <input id="confirm-password" type="password" placeholder="确认新密码">
        <button>保存</button>
      </section>`;
    history.replaceState({}, '', '/profile');

    // 资料页不是登录页：不应触发「登录失效 → 回登录页」的恢复循环。
    expect(hasVisibleLoginPrompt(site)).toBe(false);
  });

  it('只有「新密码」语义的单个密码框也不算登录表单（设置密码卡片）', () => {
    document.body.innerHTML = '<section><h2>设置密码</h2><input type="password" autocomplete="new-password" placeholder="新密码"></section>';
    history.replaceState({}, '', '/profile');
    expect(hasVisibleLoginPrompt(site)).toBe(false);
  });

  it('单个登录密码框仍判为登录表单，不因上面的修复放宽', () => {
    document.body.innerHTML = '<form><input id="user" autocomplete="username"><input id="pass" type="password" autocomplete="current-password"><button>登录</button></form>';
    history.replaceState({}, '', '/sign-in');
    expect(hasVisibleLoginPrompt(site)).toBe(true);
  });

  it('两个密码框但都没有新密码语义时仍判为登录表单（不按数量猜）', () => {
    document.body.innerHTML = '<form><input type="password" name="password"><input type="password" name="password2"></form>';
    history.replaceState({}, '', '/sign-in');
    expect(hasVisibleLoginPrompt(site)).toBe(true);
  });

  it('hasVisibleLoginPrompt 只读当前页的输入框，不点击也不等待', () => {
    expect(hasVisibleLoginPrompt(site)).toBe(false);
    document.body.innerHTML = '<input id="pass" type="password">';
    expect(hasVisibleLoginPrompt(site)).toBe(true);
  });
});
