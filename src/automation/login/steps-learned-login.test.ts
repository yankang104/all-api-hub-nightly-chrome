/**
 * 「学习登录」回放侧接缝测试：现有登录 steps 必须真实消费学出来的配置。
 *
 * 与 `learning-login.test.ts` 的关系：那边验证「采集 → 学出配置 → 保存/读回」，
 * 这边验证「学到的配置交给现有回放执行器后确实能用」—— 包括入口页、多步登录、
 * Enter 提交、以及 OAuth 入口不被旧表单选择器干扰。全部使用虚构 sentinel。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SiteConfig } from '@/types';
import type { StepLog } from '@/automation/shared/log';
import { pressEnter } from '@/automation/shared/dom-utils';
import { fillCredentials, revealExternalLogin, revealLoginForm, submitLogin } from '@/automation/login/steps';
import { buildLearnedLoginSettings } from '@/automation/learning/learning';
import { planLearnedLoginPatch } from '@/automation/learning/learning-login';

/** sleep 里推进的虚拟时间：让「等 5 秒超时」的循环瞬间走完，测试不真等。 */
const clock = vi.hoisted(() => ({ aheadMs: 0 }));

vi.mock('@/automation/shared/dom-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/automation/shared/dom-utils')>();
  return {
    ...actual,
    // 回放点击不经过可信指针（单测没有后台 CDP），但事件必须真的派发，
    // 站点脚本的展开/切页逻辑才会发生。
    realClick: vi.fn(async (el: HTMLElement) => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
      return 'dom' as const;
    }),
    sleep: vi.fn(async (ms: number) => {
      clock.aheadMs += ms;
    }),
    waitFor: vi.fn(async (selector: string) => actual.queryFirst(selector)),
    pressEnter: vi.fn(),
  };
});

vi.mock('@/automation/shared/announcements', () => ({
  dismissAnnouncements: vi.fn(async () => ({ closed: 0, gone: true })),
}));

vi.mock('@/automation/shared/click-safety', () => ({
  clearClickBlocker: vi.fn(async () => null),
}));

const learnedSite: SiteConfig = {
  id: 'site-learned',
  name: '虚构登录站',
  loginUrl: 'https://login-fixture.test/sign-in',
  loginMethod: 'form',
  selectors: { username: '#user', password: '#pass', submit: '#sign-in' },
  closeModalSelectors: [],
};

const oauthSite: SiteConfig = {
  ...learnedSite,
  loginMethod: 'oauth',
  oauthButtonSelector: '#github',
  preLoginClickSelector: '#reveal-oauth',
  selectors: { username: '', password: '', submit: '' },
};

function makeLog(): StepLog {
  return { push: vi.fn() };
}

const realDateNow = Date.now.bind(Date);

beforeEach(() => {
  clock.aheadMs = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => realDateNow() + clock.aheadMs);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 100, height: 30, top: 0, left: 0, right: 100, bottom: 30, x: 0, y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true,
    get(this: HTMLElement) { return this.textContent ?? ''; },
  });
  window.history.replaceState({}, '', '/sign-in');
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('学出的表单配置被现有登录 steps 消费', () => {
  it.each(['form', 'oauth'] as const)('%s 完整执行学到的两个前置动作，不使用旧入口', async (method) => {
    document.body.innerHTML = '<button id="more">更多方式</button><button id="old">旧流程</button>';
    const clicked: string[] = [];
    document.querySelector<HTMLElement>('#old')!.onclick = () => { clicked.push('old'); };
    document.querySelector<HTMLElement>('#more')!.onclick = () => {
      clicked.push('more');
      const expand = document.createElement('button');
      expand.id = 'expand';
      expand.textContent = '展开';
      expand.onclick = () => {
        clicked.push('expand');
        document.body.insertAdjacentHTML('beforeend', method === 'form'
          ? '<input id="user"><input id="pass" type="password"><button id="sign-in">登录</button>'
          : '<button id="github">使用 GitHub 登录</button>');
      };
      document.body.append(expand);
    };
    const learned = buildLearnedLoginSettings(learnedSite, [
      { type: 'click', selector: '#more', label: '更多方式', path: '/sign-in', loginAction: 'entry', at: 1 },
      { type: 'click', selector: '#expand', label: '展开', path: '/sign-in', loginAction: 'entry', at: 2 },
      ...(method === 'form' ? [
        { type: 'fill' as const, selector: '#user', label: '', path: '/sign-in', fieldRole: 'username' as const, hasValue: true, at: 3 },
        { type: 'fill' as const, selector: '#pass', label: '', path: '/sign-in', fieldRole: 'password' as const, hasValue: true, at: 4 },
      ] : [{ type: 'click' as const, selector: '#github', label: 'GitHub', path: '/sign-in', loginAction: 'oauth' as const, at: 3 }]),
    ])!;
    const previous = { ...learnedSite, preLoginClickSelector: '#old', preLoginClickSelectors: ['#old'] };
    const saved = { ...previous, ...planLearnedLoginPatch(learned, previous) };
    if (method === 'form') await revealLoginForm(saved, makeLog());
    else await revealExternalLogin(saved, makeLog(), 'oauth');
    expect(clicked).toEqual(['more', 'expand']);
    expect(document.querySelector(method === 'form' ? '#pass' : '#github')).not.toBeNull();
  });

  it('fillCredentials / submitLogin 按学到的选择器填写与提交', async () => {
    document.body.innerHTML = [
      '<form id="form">',
      '<input id="user" autocomplete="username">',
      '<input id="pass" type="password" autocomplete="current-password">',
      '<button id="sign-in" type="submit">登录</button>',
      '</form>',
    ].join('');
    const log = makeLog();

    const filled = await fillCredentials(learnedSite, 'SENTINEL-USER-0001', 'SENTINEL-PW-0001', log);
    expect(filled).toBe(true);
    expect(document.querySelector<HTMLInputElement>('#user')!.value).toBe('SENTINEL-USER-0001');
    expect(document.querySelector<HTMLInputElement>('#pass')!.value).toBe('SENTINEL-PW-0001');

    const submitted = await submitLogin(learnedSite, log);
    expect(submitted).toBe(true);
    expect(pressEnter).not.toHaveBeenCalled();
    expect(log.push).toHaveBeenCalledWith('已点击登录按钮');
  });

  it('多步登录：用户名 → 学到的选择器 + 语义继续按钮 → 密码步骤', async () => {
    document.body.innerHTML = [
      '<form id="step-1">',
      '<input id="user" autocomplete="username">',
      '<button id="continue" type="submit">下一步</button>',
      '</form>',
    ].join('');
    // 站点自身的「下一步」逻辑：点击后切到密码步骤（首屏样式与真实站点一致）。
    document.querySelector<HTMLElement>('#continue')!.addEventListener('click', () => {
      document.body.innerHTML = [
        '<form id="step-2">',
        '<input id="pass" type="password" autocomplete="current-password">',
        '<button id="sign-in" type="submit">登录</button>',
        '</form>',
      ].join('');
    });
    const log = makeLog();

    const filled = await fillCredentials(learnedSite, 'SENTINEL-USER-0001', 'SENTINEL-PW-0001', log);
    expect(filled).toBe(true);
    expect(document.querySelector<HTMLInputElement>('#pass')!.value).toBe('SENTINEL-PW-0001');

    const submitted = await submitLogin(learnedSite, log);
    expect(submitted).toBe(true);
    expect(log.push).toHaveBeenCalledWith('已点击登录按钮');
  });

  it('回车提交：没学到提交按钮时在密码框回车（Enter 演示可用）', async () => {
    document.body.innerHTML = [
      '<form id="form">',
      '<input id="user" autocomplete="username">',
      '<input id="pass" type="password" autocomplete="current-password">',
      '<button id="cancel">取消</button>',
      '</form>',
    ].join('');
    const log = makeLog();
    const siteWithoutSubmit: SiteConfig = {
      ...learnedSite,
      selectors: { ...learnedSite.selectors, submit: '' },
    };

    expect(await fillCredentials(siteWithoutSubmit, 'SENTINEL-USER-0001', 'SENTINEL-PW-0001', log)).toBe(true);
    expect(await submitLogin(siteWithoutSubmit, log)).toBe(true);

    expect(pressEnter).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pressEnter).mock.calls[0]![0]).toBe(document.querySelector('#pass'));
    expect(log.push).toHaveBeenCalledWith(expect.stringContaining('已在密码框回车提交'));
  });
});

describe('OAuth 入口：学到的前置点击只在需要时使用', () => {
  it('OAuth 按钮已可见时绝不点击旧表单入口（不被旧表单 selector 干扰）', async () => {
    document.body.innerHTML = [
      '<div id="reveal-form">邮箱或用户名登录</div>',
      '<button id="github">使用 GitHub 登录</button>',
    ].join('');
    let formRevealClicked = false;
    document.querySelector<HTMLElement>('#reveal-form')!.addEventListener('click', () => {
      formRevealClicked = true;
    });
    const log = makeLog();
    const site: SiteConfig = {
      ...oauthSite,
      // 模拟旧表单学习留下的入口，与本次 OAuth 学习无关
      preLoginClickSelector: '#reveal-form',
    };

    await revealExternalLogin(site, log, 'github');

    expect(formRevealClicked).toBe(false);
    expect(log.push).toHaveBeenCalledWith('第三方登录入口已可见，无需展开账密表单');
  });

  it('OAuth 按钮隐藏时点击学到的同页入口把它展开', async () => {
    document.body.innerHTML = [
      '<div id="reveal-oauth">其他登录方式</div>',
      '<button id="github" style="display: none">使用 GitHub 登录</button>',
    ].join('');
    // 站点逻辑：点击「其他登录方式」后第三方按钮出现
    document.querySelector<HTMLElement>('#reveal-oauth')!.addEventListener('click', () => {
      document.querySelector<HTMLElement>('#github')!.style.display = '';
    });
    const log = makeLog();

    await revealExternalLogin(oauthSite, log, 'github');

    expect(document.querySelector<HTMLElement>('#github')!.style.display).not.toBe('none');
    expect(log.push).toHaveBeenCalledWith(expect.stringContaining('展开第三方登录入口'));
  });

  it('没有学到的入口时退回同源登录链接（原有能力不回退）', async () => {
    document.body.innerHTML = '<a id="to-login" href="/sign-in">登录</a>';
    window.history.replaceState({}, '', '/');
    const log = makeLog();
    const site: SiteConfig = {
      ...oauthSite,
      oauthButtonSelector: '',
      preLoginClickSelector: '',
    };

    await revealExternalLogin(site, log, 'github');

    expect(log.push).toHaveBeenCalledWith(expect.stringContaining('已进入登录页'));
  });
});
