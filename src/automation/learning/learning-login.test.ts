/**
 * 「学习登录」安全闭环接缝测试。
 *
 * 目标链路（全部使用虚构 sentinel，不接触任何真实站点、凭据或账号数据）：
 *
 *   LearningCapture 采集 → 事件落盘闸门（sanitizeLearningEvent）→
 *   buildLearnedLoginSettings → 持久化补丁（planLearnedLoginPatch）→
 *   读回校验（verifyLearnedLoginStored）→ 现有登录 steps 真实消费。
 *
 * 这条缝断掉时的表现最迷惑：配置保存成功、回放也「跑完了」，但点错控件、
 * 或把 OAuth 供应商页面的选择器当成了本站选择器。所以这里按真实链路逐步锁定。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SiteConfig, WorkflowLearningEvent } from '@/types';
import {
  buildLearnedLoginSettings,
  buildLearnedWorkflow,
  LearningCapture,
  sanitizeLearningEvent,
} from '@/automation/learning/learning';
import {
  isLearningSenderSameOrigin,
  learningSiteOrigin,
  planLearnedLoginAccountPatch,
  planLearnedLoginPatch,
  planSiblingLoginMethodPins,
  verifyLearnedLoginStored,
} from '@/automation/learning/learning-login';
import { queryFirst } from '@/automation/shared/dom-utils';

const site: SiteConfig = {
  id: 'site-login-1',
  name: '虚构登录站',
  loginUrl: 'https://login-fixture.test/sign-in',
  selectors: { username: '#user', password: '#pass', submit: '#submit' },
  closeModalSelectors: [],
};

describe('buildLearnedLoginSettings：学到安全 selector', () => {
  it('拒绝自动生成 id 的选择器（base-ui / radix / react-select / UUID 等不稳定标识）', () => {
    const forged: WorkflowLearningEvent[] = [
      { type: 'fill', selector: '#base-ui-_r_h_', label: '', path: '/sign-in', fieldRole: 'username', hasValue: true, at: 1 },
      { type: 'fill', selector: '#react-select-2-input', label: '', path: '/sign-in', fieldRole: 'password', hasValue: true, at: 2 },
      { type: 'click', selector: '#radix-_r_1_', label: '登录', path: '/sign-in', loginAction: 'submit', at: 3 },
    ];

    // 学出的配置会被写进站点、用于自动回放：任何一个不稳定 id 都不能被接受。
    expect(buildLearnedLoginSettings(site, forged)).toBeNull();
  });

  it('稳定手写 id 与结构化路径仍然可用 —— 安全闸门不得误伤', () => {
    const learned = buildLearnedLoginSettings(site, [
      { type: 'fill', selector: '#username', label: '', path: '/sign-in', fieldRole: 'username', hasValue: true, at: 1 },
      { type: 'fill', selector: '#stable-panel > input:nth-of-type(2)', label: '', path: '/sign-in', fieldRole: 'password', hasValue: true, at: 2 },
      { type: 'click', selector: '#sign-in', label: '登录', path: '/sign-in', loginAction: 'submit', at: 3 },
    ]);

    expect(learned).toEqual({
      loginMethod: 'form',
      selectors: { username: '#username', password: '#stable-panel > input:nth-of-type(2)', submit: '#sign-in' },
    });
  });
});

describe('buildLearnedLoginSettings：入口页与 OAuth 的组合', () => {
  it.each(['form', 'oauth'] as const)('%s 学习替换旧登录地址，并保存同页的完整前置点击顺序', (method) => {
    const events: WorkflowLearningEvent[] = [
      { type: 'click', selector: '#more', label: '更多登录方式', path: '/sign-in', loginAction: 'entry', at: 1 },
      { type: 'click', selector: '#expand', label: '展开登录', path: '/sign-in', loginAction: 'entry', at: 2 },
      // 采集器在界面变化后补报同一次点击，不再带 loginAction；不能把它当成另一步。
      { type: 'click', selector: '#more', label: '更多登录方式', path: '/sign-in', afterText: ['展开登录'], at: 1 },
      { type: 'click', selector: '#expand', label: '展开登录', path: '/sign-in', afterText: ['登录'], at: 2 },
      ...(method === 'form' ? [
        { type: 'fill' as const, selector: '#user', label: '', path: '/sign-in', fieldRole: 'username' as const, hasValue: true, at: 3 },
        { type: 'fill' as const, selector: '#pass', label: '', path: '/sign-in', fieldRole: 'password' as const, hasValue: true, at: 4 },
        { type: 'click' as const, selector: '#submit', label: '登录', path: '/sign-in', loginAction: 'submit' as const, at: 5 },
      ] : [
        { type: 'click' as const, selector: '#oauth', label: 'OAuth', path: '/sign-in', loginAction: 'oauth' as const, at: 3 },
      ]),
    ];
    const previous = { ...site, loginUrl: 'https://login-fixture.test/old-login', preLoginClickSelectors: ['#old'] };
    const learned = buildLearnedLoginSettings(previous, events)!;
    const stored = { ...previous, ...planLearnedLoginPatch(learned, previous) };
    expect(stored.loginUrl).toBe('https://login-fixture.test/sign-in');
    expect(stored.preLoginClickSelectors).toEqual(['#more', '#expand']);
    expect(verifyLearnedLoginStored(learned, stored)).toEqual({ ok: true });
    expect(verifyLearnedLoginStored(learned, { ...stored, loginUrl: previous.loginUrl }).ok).toBe(false);
    expect(verifyLearnedLoginStored(learned, { ...stored, preLoginClickSelectors: ['#old'] }).ok).toBe(false);
  });

  it('表单登录优先学「同一页、离凭据最近」的那次入口点击（入口页跳转退居兜底）', () => {
    const learned = buildLearnedLoginSettings(site, [
      // 首页的「登录」入口：跨页导航，回放时由 revealLoginForm 的登录链接兜底
      { type: 'click', selector: '#nav-login', label: '登录', path: '/', loginAction: 'entry', at: 1 },
      // 登录页上真正把账密表单展开的那一下
      { type: 'click', selector: '#reveal-form', label: '邮箱或用户名登录', path: '/sign-in', loginAction: 'entry', at: 2 },
      { type: 'fill', selector: '#user', label: '', path: '/sign-in', fieldRole: 'username', hasValue: true, at: 3 },
      { type: 'fill', selector: '#pass', label: '', path: '/sign-in', fieldRole: 'password', hasValue: true, at: 4 },
    ]);

    expect(learned?.preLoginClickSelector).toBe('#reveal-form');
    expect(learned?.loginMethod).toBe('form');
  });

  it('OAuth 演示把「同一页、就在 OAuth 点击之前」的入口点击学为前置入口', () => {
    const learned = buildLearnedLoginSettings(site, [
      { type: 'click', selector: '#misc', label: '随便看看', path: '/sign-in', at: 5 },
      { type: 'click', selector: '#more-oauth', label: '其他登录方式', path: '/sign-in', loginAction: 'entry', at: 10 },
      { type: 'click', selector: '#github-login', label: '使用 GitHub 登录', path: '/sign-in', loginAction: 'oauth', at: 20 },
    ]);

    expect(learned).toEqual({
      loginMethod: 'oauth',
      oauthButtonSelector: '#github-login',
      preLoginClickSelector: '#more-oauth',
    });
  });

  it('跨页导航的「登录」入口不会与 OAuth 按钮拼成一对（回放靠同源登录链接进入登录页）', () => {
    const learned = buildLearnedLoginSettings(site, [
      { type: 'click', selector: '#nav-login', label: '登录', path: '/', loginAction: 'entry', at: 1 },
      { type: 'click', selector: '#github-login', label: '使用 GitHub 登录', path: '/sign-in', loginAction: 'oauth', at: 5 },
    ]);

    expect(learned).toEqual({
      loginMethod: 'oauth',
      oauthButtonSelector: '#github-login',
    });
  });

  it('「Sign in with Google」图案按钮（href 指向 accounts.google.com）同样学成 OAuth 按钮', () => {
    // orevx.ai 实测形态：登录页只有一个「Sign in with Google」按钮，href 是外域的
    // OAuth 授权地址。OAuth 判据看的是**点击发生的页面**（本站），不是按钮指向的
    // 地址 —— 外链 href 不得把这条学习动作整条丢掉。
    const learned = buildLearnedLoginSettings(site, [
      { type: 'click', selector: 'text=Sign in with Google', label: 'Sign in with Google', path: '/sign-in', href: 'https://accounts.google.com/o/oauth2/v2/auth', loginAction: 'oauth', at: 1 },
    ]);

    expect(learned).toEqual({
      loginMethod: 'oauth',
      oauthButtonSelector: 'text=Sign in with Google',
    });
  });

  it('表单与 OAuth 混合演示：方式取 OAuth，表单中间的入口点击不会被当成 OAuth 入口', () => {
    const learned = buildLearnedLoginSettings(site, [
      { type: 'click', selector: '#nav-login', label: '登录', path: '/', loginAction: 'entry', at: 1 },
      { type: 'click', selector: '#reveal-form', label: '邮箱或用户名登录', path: '/sign-in', loginAction: 'entry', at: 2 },
      { type: 'fill', selector: '#user', label: '', path: '/sign-in', fieldRole: 'username', hasValue: true, at: 3 },
      { type: 'fill', selector: '#pass', label: '', path: '/sign-in', fieldRole: 'password', hasValue: true, at: 4 },
      { type: 'click', selector: '#github-login', label: '使用 GitHub 登录', path: '/sign-in', loginAction: 'oauth', at: 5 },
    ]);

    expect(learned?.loginMethod).toBe('oauth');
    expect(learned?.oauthButtonSelector).toBe('#github-login');
    // '#reveal-form' 与 OAuth 点击之间隔着账号/密码输入：它是表单动作，
    // 与 OAuth 按钮配成一对会在回放时把第三方登录区切走。
    expect(learned?.preLoginClickSelector).toBeUndefined();
  });

  it('外域页面（OAuth 供应商）的绝对地址事件不参与学习配置', () => {
    // 相对 path 的外域事件要靠 background 的发送方同源闸门挡在入口（见 learning-login.ts）；
    // 这里锁的是编译器这一层的兜底：绝对地址跨站一律丢弃。
    const learned = buildLearnedLoginSettings(site, [
      { type: 'fill', selector: '#login_field', label: '', path: 'https://github.com/session', fieldRole: 'username', hasValue: true, at: 1 },
      { type: 'fill', selector: '#password', label: '', path: 'https://github.com/session', fieldRole: 'password', hasValue: true, at: 2 },
      { type: 'click', selector: 'text=Sign in', label: 'Sign in', path: 'https://github.com/session', loginAction: 'submit', at: 3 },
    ]);

    expect(learned).toBeNull();
  });

  it('OAuth 点击之前直接演示的入口（中间没有任何输入）才配成前置入口', () => {
    const learned = buildLearnedLoginSettings(site, [
      { type: 'click', selector: '#more-oauth', label: '其他登录方式', path: '/sign-in', loginAction: 'entry', at: 10 },
      { type: 'click', selector: '#github-login', label: '使用 GitHub 登录', path: '/sign-in', loginAction: 'oauth', at: 20 },
    ]);

    expect(learned?.preLoginClickSelector).toBe('#more-oauth');
  });
});

describe('伪造事件不能把敏感内容带进学出的配置', () => {
  it('evidence 里的密钥形态词被丢弃，合法词保留', () => {
    const forgedKey = `ghp_${'A'.repeat(24)}`;
    const learned = buildLearnedWorkflow(site, [
      { type: 'navigation', path: '/checkin', at: 1 },
      {
        type: 'click',
        selector: '#claim',
        label: '签到',
        path: '/checkin',
        evidence: { kind: 'success', words: [forgedKey, '签到成功'] },
        at: 2,
      },
    ]);

    const json = JSON.stringify(learned?.workflow);
    expect(json).not.toContain('ghp_');
    expect(json).toContain('签到成功');
  });

  it('事件路径里带 token 的 hash 不会进路线（含其值的 URL 绝不落盘）', () => {
    const learned = buildLearnedWorkflow(site, [
      { type: 'navigation', path: '/console#access_token=SENTINEL-TOKEN-VALUE', at: 1 },
      { type: 'click', selector: '#claim', label: '签到', path: '/console#access_token=SENTINEL-TOKEN-VALUE', at: 2 },
    ]);

    expect(JSON.stringify(learned?.workflow)).not.toContain('SENTINEL-TOKEN-VALUE');
  });
});

describe('事件落盘闸门 sanitizeLearningEvent', () => {
  it('输入值与任何未知字段都不会进入录制记录', () => {
    const forged = {
      type: 'fill',
      selector: '#user',
      label: '账号',
      path: '/sign-in?redirect=%2Fconsole',
      hasValue: true,
      fieldRole: 'username',
      // 页面脚本可以塞进任何东西：输入值、cookie、token、整段正文……
      value: 'SENTINEL-USER-VALUE',
      password: 'SENTINEL-PASSWORD-VALUE',
      token: 'SENTINEL-TOKEN-VALUE',
      cookie: 'session=SENTINEL',
      at: 1,
    } as unknown as WorkflowLearningEvent;

    const safe = sanitizeLearningEvent(forged);
    expect(safe).toEqual({
      type: 'fill',
      selector: '#user',
      label: '账号',
      path: '/sign-in',
      hasValue: true,
      fieldRole: 'username',
      at: 1,
    });
    expect(JSON.stringify(safe)).not.toContain('SENTINEL');
  });

  it('导航路径丢掉查询串、凭据类 hash 整体丢弃', () => {
    expect(sanitizeLearningEvent({ type: 'navigation', path: '/sign-in?code=SENTINEL#/console', at: 1 }))
      .toEqual({ type: 'navigation', path: '/sign-in#/console', at: 1 });
    expect(sanitizeLearningEvent({ type: 'navigation', path: '/callback#access_token=SENTINEL', at: 1 }))
      .toEqual({ type: 'navigation', path: '/callback', at: 1 });
  });

  it('form 事件里的字段角色只接受 username / password', () => {
    const safe = sanitizeLearningEvent({
      type: 'fill', selector: '#a', label: '', path: '/sign-in', hasValue: true,
      fieldRole: 'otp' as never, at: 1,
    });
    expect(safe).not.toBeNull();
    expect(safe as { fieldRole?: string }).not.toHaveProperty('fieldRole');
  });

  it('afterText 的内容闸门：邮箱、六位验证码、密钥形态片段在入口就被丢弃', () => {
    const safe = sanitizeLearningEvent({
      type: 'click', selector: '#ok', label: '确定', path: '/console',
      afterText: ['user@example.test', '654321', '签到成功'],
      at: 1,
    }) as { afterText?: string[] } | null;

    expect(safe?.afterText).toEqual(['签到成功']);
  });

  it('越界/非法的滚动证据不落盘，合法值保留', () => {
    const bad = sanitizeLearningEvent({
      type: 'click', selector: '#a', label: '', path: '/console',
      scrollBeforeY: Number.POSITIVE_INFINITY, at: 1,
    }) as { scrollBeforeY?: number } | null;
    expect(bad?.scrollBeforeY).toBeUndefined();

    const good = sanitizeLearningEvent({
      type: 'click', selector: '#a', label: '', path: '/console',
      scrollBeforeY: 1234.6, scrollPageTop: true, at: 1,
    }) as { scrollBeforeY?: number; scrollPageTop?: boolean } | null;
    expect(good?.scrollBeforeY).toBe(1235);
    expect(good?.scrollPageTop).toBe(true);
  });
});

describe('planLearnedLoginPatch / verifyLearnedLoginStored：保存与读回', () => {
  const storedSite: SiteConfig = {
    ...site,
    loginMethod: 'form',
    preLoginClickSelector: '#old-reveal',
    oauthButtonSelector: '#old-oauth',
    selectors: { username: '#old-user', password: '#old-pass', submit: '#old-submit' },
  };

  it('form 学习：写回选择器与新入口，并清掉旧 OAuth 入口', () => {
    const learned = {
      loginMethod: 'form' as const,
      selectors: { username: '#user', password: '#pass', submit: '#submit' },
      preLoginClickSelector: '#reveal-form',
    };
    const patch = planLearnedLoginPatch(learned, storedSite);

    expect(patch.loginMethod).toBe('form');
    expect(patch.preLoginClickSelector).toBe('#reveal-form');
    expect(patch.oauthButtonSelector).toBe('');
    expect(patch.selectors).toEqual({ username: '#user', password: '#pass', submit: '#submit' });

    const stored = { ...storedSite, ...patch };
    expect(verifyLearnedLoginStored(learned, stored)).toEqual({ ok: true });
  });

  it('form 学习没演示入口时清空旧入口 —— 不留矛盾字段', () => {
    const learned = {
      loginMethod: 'form' as const,
      selectors: { username: '#user', password: '#pass' },
    };
    const patch = planLearnedLoginPatch(learned, { ...storedSite, preLoginClickSelectors: ['#old-more', '#old-form'] });
    expect(patch.preLoginClickSelector).toBe('');
    expect(patch.preLoginClickSelectors).toEqual([]);

    const stored = { ...storedSite, ...patch };
    expect(verifyLearnedLoginStored(learned, stored)).toEqual({ ok: true });
  });

  it('OAuth 学习：写回 OAuth 按钮与学到的入口，没演示入口时清掉旧表单入口', () => {
    const learnedWithEntry = {
      loginMethod: 'oauth' as const,
      oauthButtonSelector: '#github',
      preLoginClickSelector: '#more-oauth',
    };
    const patchWithEntry = planLearnedLoginPatch(learnedWithEntry, storedSite);
    expect(patchWithEntry.oauthButtonSelector).toBe('#github');
    expect(patchWithEntry.preLoginClickSelector).toBe('#more-oauth');
    expect(verifyLearnedLoginStored(learnedWithEntry, { ...storedSite, ...patchWithEntry })).toEqual({ ok: true });

    const learnedWithoutEntry = { loginMethod: 'oauth' as const, oauthButtonSelector: '#github' };
    const patchWithoutEntry = planLearnedLoginPatch(learnedWithoutEntry, storedSite);
    expect(patchWithoutEntry.oauthButtonSelector).toBe('#github');
    expect(patchWithoutEntry.preLoginClickSelector).toBe('');
    expect(verifyLearnedLoginStored(learnedWithoutEntry, { ...storedSite, ...patchWithoutEntry })).toEqual({ ok: true });
  });

  it('读回发现旧表单入口没清干净时拒绝保存', () => {
    const learned = { loginMethod: 'oauth' as const, oauthButtonSelector: '#github' };
    const stored = { ...storedSite, loginMethod: 'oauth' as const, oauthButtonSelector: '#github' };
    const verdict = verifyLearnedLoginStored(learned, stored);

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.error).toContain('OAuth 入口');
  });

  it('读回发现写入的选择器不一致 / 含自动生成 id 时拒绝', () => {
    const learned = {
      loginMethod: 'form' as const,
      selectors: { username: '#user', password: '#pass' },
    };
    const tampered = {
      ...storedSite,
      loginMethod: 'form' as const,
      preLoginClickSelector: '',
      oauthButtonSelector: '',
      selectors: { ...storedSite.selectors, username: '#other' },
    };
    const verdict = verifyLearnedLoginStored(learned, tampered);
    expect(verdict.ok).toBe(false);

    const unstable = {
      loginMethod: 'form' as const,
      selectors: { username: '#base-ui-_r_h_', password: '#pass' },
    };
    expect(verifyLearnedLoginStored(unstable, storedSite).ok).toBe(false);
  });
});

describe('planLearnedLoginAccountPatch：账号覆盖不再压过学到的登录方式', () => {
  it('账号级旧方式与学到的方式冲突时清掉覆盖，改为跟随站点', () => {
    expect(planLearnedLoginAccountPatch({ loginMethod: 'oauth' }, { loginMethod: 'form' }))
      .toEqual({ loginMethod: '' });
    expect(planLearnedLoginAccountPatch({ loginMethod: 'form' }, { loginMethod: 'auto' }))
      .toEqual({ loginMethod: '' });
  });

  it('未设置账号覆盖或方式一致时不写账号，保留用户原有配置', () => {
    expect(planLearnedLoginAccountPatch({ loginMethod: 'form' }, {})).toEqual({});
    expect(planLearnedLoginAccountPatch({ loginMethod: 'oauth' }, { loginMethod: 'oauth' })).toEqual({});
  });
});

describe('planSiblingLoginMethodPins：学习不替同站其它账号改登录方式', () => {
  const siblings = [
    { id: 'learner' },
    { id: 'follower-a' },
    { id: 'follower-b', loginMethod: undefined },
    { id: 'pinned-oauth', loginMethod: 'oauth' as const },
  ];

  it('站点默认从账密变成 OAuth：跟随站点的账号固定为账密，显式设置的不动', () => {
    expect(planSiblingLoginMethodPins({ loginMethod: 'oauth' }, { loginMethod: 'form' }, siblings, 'learner')).toEqual([
      { accountId: 'follower-a', patch: { loginMethod: 'form' } },
      { accountId: 'follower-b', patch: { loginMethod: 'form' } },
    ]);
  });

  it('站点原来没写登录方式时，按默认的账密固定', () => {
    expect(planSiblingLoginMethodPins({ loginMethod: 'oauth' }, {}, [{ id: 'x' }], 'learner'))
      .toEqual([{ accountId: 'x', patch: { loginMethod: 'form' } }]);
  });

  it('站点原来是自动检测：跟随站点的账号固定为 auto，仍按各自凭据选登录通道', () => {
    expect(planSiblingLoginMethodPins({ loginMethod: 'form' }, { loginMethod: 'auto' }, [{ id: 'x' }], 'learner'))
      .toEqual([{ accountId: 'x', patch: { loginMethod: 'auto' } }]);
  });

  it('登录方式没变、或这次没学到登录方式：一个账号都不写', () => {
    expect(planSiblingLoginMethodPins({ loginMethod: 'form' }, { loginMethod: 'form' }, siblings, 'learner')).toEqual([]);
    expect(planSiblingLoginMethodPins({ loginMethod: 'form' }, {}, siblings, 'learner')).toEqual([]);
    expect(planSiblingLoginMethodPins({}, { loginMethod: 'form' }, siblings, 'learner')).toEqual([]);
  });
});

describe('学习事件同源闸门', () => {
  const origin = learningSiteOrigin(site);

  it('站点源解析：合法 https 站点返回 origin，非法地址返回 null（一律拒绝）', () => {
    expect(origin).toBe('https://login-fixture.test');
    expect(learningSiteOrigin({ loginUrl: 'not-a-url' })).toBeNull();
    expect(learningSiteOrigin(undefined)).toBeNull();
  });

  it('只有站点自身源的消息通过；OAuth 供应商页面 / 未知来源一律拒绝', () => {
    expect(isLearningSenderSameOrigin('https://login-fixture.test/sign-in', origin)).toBe(true);
    expect(isLearningSenderSameOrigin('https://login-fixture.test/sign-in?x=1#y', origin)).toBe(true);
    // 学习标签页跳到 GitHub 授权页时，那边上报的事件绝不能被学成站点配置
    expect(isLearningSenderSameOrigin('https://github.com/login', origin)).toBe(false);
    expect(isLearningSenderSameOrigin('https://evil.example/sign-in', origin)).toBe(false);
    expect(isLearningSenderSameOrigin('https://login-fixture.test.evil.example/sign-in', origin)).toBe(false);
    expect(isLearningSenderSameOrigin(undefined, origin)).toBe(false);
    expect(isLearningSenderSameOrigin('https://login-fixture.test/sign-in', null)).toBe(false);
  });
});

/**
 * 整条接缝：真实 DOM 采集（虚构 sentinel 输入）→ 落盘闸门 → 学出配置 →
 * 保存补丁 → 读回校验 → 回放侧解析器（queryFirst）仍能命中当初的控件。
 */
describe('采集 → 序列化 → 持久化 → 读回 → 回放 全链路', () => {
  const captchaValue = 'SENTINEL-PW-0001';
  const accountValue = 'SENTINEL-USER-0001';

  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 100, height: 30, top: 0, left: 0, right: 100, bottom: 30, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    Object.defineProperty(HTMLElement.prototype, 'innerText', {
      configurable: true,
      get(this: HTMLElement) { return this.textContent ?? ''; },
    });
    window.history.replaceState({}, '', '/sign-in');
    document.body.innerHTML = [
      '<form id="login-form">',
      // React 19 / Base UI 生成的随机 id：必须被跳过，回落到 name
      '<input id="base-ui-_r_1_" name="username" autocomplete="username">',
      '<input id="password" name="password" type="password" autocomplete="current-password">',
      '<button id="submit" type="submit">登录</button>',
      '</form>',
    ].join('');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it.each(['使用账号密码登录', 'Use password'])('融合采集保留两级登录入口，%s 的脱敏不丢失动作角色', (entryLabel) => {
    document.body.insertAdjacentHTML('afterbegin',
      `<button id="more" type="button">更多登录方式</button><button id="choose-form" type="button">${entryLabel}</button>`);
    let at = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => at += 10);
    const events: WorkflowLearningEvent[] = [];
    const capture = new LearningCapture({ kind: 'both', settleMs: 0, onEvent: (event) => events.push(event) });
    capture.attach();
    try {
      document.querySelector<HTMLButtonElement>('#more')!.click();
      document.querySelector<HTMLButtonElement>('#choose-form')!.click();
      const username = document.querySelector<HTMLInputElement>('input[name="username"]')!;
      username.value = accountValue;
      username.dispatchEvent(new Event('input', { bubbles: true }));
      const password = document.querySelector<HTMLInputElement>('#password')!;
      password.value = captchaValue;
      password.dispatchEvent(new Event('input', { bubbles: true }));
      capture.flushPending();
    } finally {
      capture.detach();
    }

    const sanitized = events.map(sanitizeLearningEvent)
      .filter((event): event is WorkflowLearningEvent => event !== null);
    expect(sanitized).toContainEqual(expect.objectContaining({
      type: 'click', selector: '#choose-form', label: '', loginAction: 'entry',
    }));
    const learned = buildLearnedLoginSettings(site, sanitized)!;
    const stored = { ...site, ...planLearnedLoginPatch(learned, site) };
    expect(stored.preLoginClickSelectors).toEqual(['#more', '#choose-form']);
    expect(verifyLearnedLoginStored(learned, stored)).toEqual({ ok: true });
    for (const payload of [events, sanitized, stored]) {
      expect(JSON.stringify(payload)).not.toContain(accountValue);
      expect(JSON.stringify(payload)).not.toContain(captchaValue);
    }
  });

  it('sentinel 输入值不落盘，学出的选择器仍能在回放侧唯一命中', () => {
    const events: WorkflowLearningEvent[] = [];
    const capture = new LearningCapture({ kind: 'login', settleMs: 0, onEvent: (event) => events.push(event) });
    capture.attach();

    const username = document.querySelector<HTMLInputElement>('input[name="username"]')!;
    username.value = accountValue;
    username.dispatchEvent(new Event('input', { bubbles: true }));
    const password = document.querySelector<HTMLInputElement>('#password')!;
    password.value = captchaValue;
    password.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector<HTMLButtonElement>('#submit')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, composed: true }),
    );
    capture.flushPending();
    capture.detach();

    // 1. 采集侧就不含输入值
    expect(JSON.stringify(events)).not.toContain(accountValue);
    expect(JSON.stringify(events)).not.toContain(captchaValue);

    // 2. 落盘闸门逐条净化（不丢事件，也不多带任何输入值）
    const sanitized = events
      .map((event) => sanitizeLearningEvent(event))
      .filter((event): event is WorkflowLearningEvent => event !== null);
    expect(sanitized).toHaveLength(events.length);
    expect(JSON.stringify(sanitized)).not.toContain(accountValue);
    expect(JSON.stringify(sanitized)).not.toContain(captchaValue);

    // 3. 学出可回放的登录配置：随机 id 被跳过，回落到 name / 稳定 id
    const learned = buildLearnedLoginSettings(site, sanitized);
    expect(learned?.loginMethod).toBe('form');
    expect(learned?.selectors?.username).toBe('input[name="username"]');
    expect(learned?.selectors?.password).toBe('#password');
    expect(learned?.selectors?.submit).toBe('#submit');

    // 4. 保存补丁 + 读回校验（模拟 background 写入后读回）
    const patch = planLearnedLoginPatch(learned!, {
      ...site,
      selectors: { username: '#old', password: '#old', submit: '#old' },
    });
    const stored = { ...site, ...patch } as SiteConfig;
    expect(verifyLearnedLoginStored(learned!, stored)).toEqual({ ok: true });
    expect(JSON.stringify(patch)).not.toContain(accountValue);
    expect(JSON.stringify(patch)).not.toContain(captchaValue);

    // 5. 回放侧用同一个解析器仍能唯一命中当初那两个控件
    expect(queryFirst<HTMLInputElement>(learned!.selectors!.username!)).toBe(username);
    expect(queryFirst<HTMLInputElement>(learned!.selectors!.password!)).toBe(password);
    expect(queryFirst<HTMLButtonElement>(learned!.selectors!.submit!)).toBe(
      document.querySelector<HTMLButtonElement>('#submit')!,
    );
  });
});
