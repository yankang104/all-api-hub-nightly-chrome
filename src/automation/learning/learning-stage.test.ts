import { describe, expect, it } from 'vitest';
import type { LearningKind, WorkflowLearningEvent } from '@/types';
import { analyzeLearningEvents, canSaveLoginAsCheckin, guideViewOf, checkinEvidenceOf, isLogoutLearningEvent } from '@/automation/learning/learning-stage';

type ClickEvent = Extract<WorkflowLearningEvent, { type: 'click' }>;
type FillEvent = Extract<WorkflowLearningEvent, { type: 'fill' }>;
type NavEvent = Extract<WorkflowLearningEvent, { type: 'navigation' }>;

function nav(path: string, at = 1): NavEvent { return { type: 'navigation', path, at }; }
function fill(overrides: Partial<FillEvent> = {}): FillEvent {
  return { type: 'fill', selector: '#username', label: '用户名', path: '/login', hasValue: true, at: 2, ...overrides };
}
function click(overrides: Partial<ClickEvent> = {}): ClickEvent {
  return { type: 'click', selector: 'text=立即签到', label: '立即签到', path: '/checkin', at: 3, ...overrides };
}

const stageOf = (events: WorkflowLearningEvent[], kind: LearningKind = 'checkin') => analyzeLearningEvents(events, kind);
const titleOf = (events: WorkflowLearningEvent[], kind: LearningKind = 'checkin') => guideViewOf(stageOf(events, kind)).title;

describe('analyzeLearningEvents 阶段判定', () => {
  it('① 刚打开登录页：停在「请登录」', () => {
    expect(titleOf([nav('/login')])).toBe('① 请登录');
    expect(titleOf([nav('/login'), fill(), click({ label: '登录', path: '/login', loginAction: 'submit' })])).toBe('① 请登录');
    expect(stageOf([nav('/login')]).stage).toBe('login');
  });

  it('② 登录成功进到控制台、但还没到资料页', () => {
    const events = [nav('/login'), nav('/console', 4)];
    expect(stageOf(events).stage).toBe('profile');
    expect(stageOf(events).signedIn).toBe(true);
    expect(titleOf(events)).toBe('② 已检测到登录成功，请前往能显示当前账号的页面');
  });

  it('③ 到了能显示当前账号的资料页、但还没签到', () => {
    const events = [nav('/login'), nav('/console', 4), nav('/profile', 6)];
    expect(stageOf(events).stage).toBe('checkin');
    expect(titleOf(events)).toBe('③ 请完成一次签到');
  });

  it('③ 卡片式站点：签到按钮就在 /checkin 页上也算「能显示当前账号的页面」', () => {
    expect(stageOf([nav('/login'), nav('/checkin', 4)]).stage).toBe('checkin');
  });

  it('打开时已登录、学习页直接落在配置的签到页 /lottery：认成站内业务页', () => {
    // 一梦五千年的签到落地页是 /lottery（抽奖代替每日签到），通用词表里没有
    // lottery，于是「开始学习时已经登录」的演示一直停在「请登录」。
    const events = [nav('/sign-in'), nav('/lottery', 4)];
    expect(stageOf(events).signedIn).toBe(true);
    expect(stageOf(events).stage).toBe('checkin');
    expect(guideViewOf(stageOf(events)).title).not.toBe('① 请登录');
  });

  it('已登录后从登录页被站点带回任意站内页：不再停在「请登录」', () => {
    // 现场：打开 /sign-in 时浏览器已有会话，站点直接把页面带回站内。
    // 认证页上的事件本身不算登录证据，但「先见过认证页、又落到非认证页」
    // 说明会话已经不在登录表单上。
    const events = [nav('/sign-in'), nav('/some-private-page', 4)];
    expect(stageOf(events).signedIn).toBe(true);
    expect(stageOf(events).stage).not.toBe('login');
  });

  it('从未出现认证页时，单个陌生页面不足以判定已登录（不误判公开首页）', () => {
    const events = [nav('/some-private-page')];
    expect(stageOf(events).signedIn).toBe(false);
    expect(stageOf(events).stage).toBe('login');
  });

  it('退出登录会清掉「曾离开认证页」的证据，必须重新登录', () => {
    const events = [
      nav('/sign-in'),
      nav('/lottery', 3),
      click({ label: '退出登录', path: '/lottery', at: 5 }),
    ];
    const analysis = stageOf(events);
    expect(analysis.signedIn).toBe(false);
    expect(analysis.logout).toBe(true);
    expect(analysis.stage).toBe('login');
  });
  it('④ 录到签到动作：提示可以结束学习了', () => {
    const events = [nav('/login'), nav('/console', 4), nav('/profile', 6), nav('/checkin', 8), click()];
    expect(stageOf(events).stage).toBe('done');
    expect(stageOf(events).checkin).toBe('action');
    expect(titleOf(events)).toBe('④ 已录到签到动作，可以点「结束学习」了');
  });

  it('④ 页面出现签到成功证据时标记为 confirmed', () => {
    const events = [nav('/checkin'), click({ evidence: { kind: 'success', words: ['签到成功'] } })];
    expect(checkinEvidenceOf(events.at(-1)!)).toBe('confirmed');
    expect(stageOf(events).checkin).toBe('confirmed');
  });

  it('④ 页面显示今日已签到时按 already 处理（不谎报成功）', () => {
    const events = [nav('/checkin'), click({ evidence: { kind: 'already', words: ['已签到'] } })];
    expect(stageOf(events).checkin).toBe('already');
  });

  it('导航项点击不算签到动作：点「个人资料」「去签到」都不推进到④', () => {
    const events = [
      nav('/console'),
      click({ label: '个人资料', path: '/console', href: 'https://example.com/profile' }),
      nav('/profile', 5),
      click({ label: '去签到', path: '/profile', href: 'https://example.com/checkin' }),
      nav('/checkin', 7),
    ];
    expect(stageOf(events).stage).toBe('checkin');
  });

  it('导航点击即使被补报了「今日已签到」文案，也不算签到证据', () => {
    // 现场形态：侧栏常写着「今日已签到」的记录/说明，用户点「个人资料」时采集侧
    // 会把整页文本挂到这一笔点击上。若让证据先判定，这条导航会被当成签到动作，
    // `learnedRoute` 还可能把它选成路线终点页 —— 学出的流程会跑到资料页去点一个
    // 与签到无关的入口。标签判定必须先于证据判定。
    const navigationClick = click({
      label: '个人资料',
      path: '/console',
      href: 'https://example.com/profile',
      evidence: { kind: 'already', words: ['已签到'] },
    });
    expect(checkinEvidenceOf(navigationClick)).toBe('none');
    expect(stageOf([nav('/console'), navigationClick]).checkin).toBe('none');
  });

  it('反向红线：SPA 就地接管的签到链接仍算签到动作（标签不含导航词）', () => {
    // 站点把签到做成 <a href="/checkin">立即签到</a>、由前端拦截并就地完成后，
    // 地址不会真的变化，补报的「签到成功」正是这一笔点击的结果 —— 不能因为
    // href 指向别处就把它一起拦掉。
    const spaCheckin = click({
      label: '立即签到',
      path: '/console',
      href: 'https://example.com/checkin',
      evidence: { kind: 'success', words: ['签到成功'] },
    });
    expect(checkinEvidenceOf(spaCheckin)).toBe('confirmed');
  });

  it('走了「退出登录」：退回①并给出醒目提醒，之前的签到证据作废', () => {
    const events = [
      nav('/console'),
      nav('/checkin', 4),
      click({ evidence: { kind: 'success', words: ['签到成功'] } }),
      click({ label: '退出登录', path: '/checkin', at: 9 }),
      nav('/login', 10),
    ];
    const analysis = stageOf(events);
    expect(analysis.stage).toBe('login');
    expect(analysis.checkin).toBe('none');
    expect(analysis.logout).toBe(true);
    const view = guideViewOf(analysis);
    expect(view.title).toBe('① 请登录');
    expect(view.warning ?? '').toContain('退出登录');
    expect(isLogoutLearningEvent(click({ label: '退出登录' }))).toBe(true);
    expect(isLogoutLearningEvent(click({ label: '立即签到' }))).toBe(false);
  });

  it('先退出别的账号、再用本账号登录成功：撤下「会话已断开」提醒，继续推进', () => {
    // 用户实测：浏览器登着同站另一个账号，必须先退出再用本账号登录。
    // 旧逻辑一旦看到退出就永久挂着「这段演示不建议保存」，与之后的成功登录矛盾。
    const events = [
      nav('/console'),
      click({ label: '退出登录', path: '/console', at: 2 }),
      nav('/login', 3),
      fill({ fieldRole: 'username', at: 4 }),
      fill({ selector: '#password', label: '密码', fieldRole: 'password', at: 5 }),
      click({ label: '登录', path: '/login', loginAction: 'submit', at: 6 }),
      nav('/dashboard/overview', 7),
    ];
    const analysis = stageOf(events);
    expect(analysis.logout).toBe(false);
    expect(analysis.signedIn).toBe(true);
    expect(analysis.stage).toBe('profile');
    expect(guideViewOf(analysis).warning).toBeUndefined();
  });

  it('退出后填了账密、登录按钮没被标成提交，进入站内页也算重新登录', () => {
    const events = [
      nav('/console'),
      click({ label: '退出登录', path: '/console', at: 2 }),
      nav('/login', 3),
      fill({ fieldRole: 'username', at: 4 }),
      fill({ selector: '#password', label: '密码', fieldRole: 'password', at: 5 }),
      click({ label: '登录', path: '/login', at: 6 }),
      nav('/dashboard/overview', 7),
    ];
    expect(stageOf(events).logout).toBe(false);
    expect(guideViewOf(stageOf(events)).warning).toBeUndefined();
  });

  it('退出后只回到登录页、还没重新登录：提醒仍在', () => {
    const events = [
      nav('/console'),
      click({ label: '退出登录', path: '/console', at: 2 }),
      nav('/login', 3),
      fill({ fieldRole: 'username', at: 4 }),
    ];
    expect(stageOf(events).logout).toBe(true);
    expect(guideViewOf(stageOf(events)).warning ?? '').toContain('退出登录');
  });

  it('重新登录后，退出前录到的签到证据仍然作废', () => {
    const events = [
      nav('/checkin'),
      click({ evidence: { kind: 'success', words: ['签到成功'] }, at: 2 }),
      click({ label: '退出登录', path: '/checkin', at: 3 }),
      nav('/login', 4),
      click({ label: '登录', path: '/login', loginAction: 'submit', at: 5 }),
      nav('/console', 6),
    ];
    const analysis = stageOf(events);
    expect(analysis.logout).toBe(false);
    expect(analysis.checkin).toBe('none');
  });

  it('退出登录页上的导航也算走错路', () => {
    expect(stageOf([nav('/console'), nav('/logout', 4)]).stage).toBe('login');
  });

  it('不看账号的设置页不会把阶段推进到③', () => {
    expect(stageOf([nav('/login'), nav('/console', 4), nav('/console/settings', 6)]).stage).toBe('profile');
  });

  it('哈希路由站点同样识别认证页与资料页', () => {
    expect(stageOf([nav('/#/login')]).stage).toBe('login');
    expect(stageOf([nav('/#/login'), nav('/#/console', 4)]).stage).toBe('profile');
    expect(stageOf([nav('/#/login'), nav('/#/console', 4), nav('/#/profile', 6)]).stage).toBe('checkin');
  });

  it('学习登录：账密都录到并提交后提示可以结束', () => {
    const events = [
      nav('/login'),
      fill({ fieldRole: 'username' }),
      fill({ selector: '#password', label: '密码', fieldRole: 'password', at: 3 }),
      click({ label: '登录', path: '/login', loginAction: 'submit', at: 4 }),
    ];
    expect(stageOf(events, 'login').stage).toBe('done');
    expect(titleOf(events, 'login')).toBe('② 已录到登录动作，可以点「结束学习」了');
  });

  it('学习登录：只填了用户名不算录到登录动作', () => {
    const events = [nav('/login'), fill({ fieldRole: 'username' })];
    expect(stageOf(events, 'login').stage).toBe('login');
    expect(titleOf(events, 'login')).toBe('① 请登录');
  });

  it('融合学习（both）与签到学习同一套四步：登录 → 资料页 → 签到 → 结束', () => {
    const events = [
      { type: 'navigation', path: '/login', at: 1 },
      { type: 'fill', selector: '#username', label: '用户名', path: '/login', hasValue: true, at: 2 },
      { type: 'navigation', path: '/console', at: 3 },
    ] as WorkflowLearningEvent[];
    expect(stageOf(events, 'both').stage).toBe('profile');
    expect(guideViewOf(stageOf(events, 'both')).total).toBe(4);
    expect(titleOf(events, 'both')).toBe('② 已检测到登录成功，请前往能显示当前账号的页面');
    expect(stageOf([...events, nav('/profile', 4), nav('/checkin', 5), click()], 'both').stage).toBe('done');
  });

  it('融合学习里点了退出登录同样退回①', () => {
    const events = [
      { type: 'navigation', path: '/checkin', at: 1 },
      { type: 'click', selector: 'text=签到', label: '签到', path: '/checkin', at: 2, evidence: { kind: 'success', words: ['签到成功'] } },
      { type: 'click', selector: 'text=退出登录', label: '退出登录', path: '/checkin', at: 3 },
    ] as WorkflowLearningEvent[];
    expect(stageOf(events, 'both').stage).toBe('login');
    expect(guideViewOf(stageOf(events, 'both')).warning).toContain('退出登录');
  });

  it('学习登录：第三方登录按钮点过即可结束', () => {
    const events = [nav('/login'), click({ label: '使用 GitHub 继续', path: '/login', loginAction: 'oauth', at: 3 })];
    expect(stageOf(events, 'login').stage).toBe('done');
  });

  it('登录学习登录成功后停在站内页：仍然提示可以结束（不会退回①）', () => {
    const events = [
      nav('/login'),
      fill({ fieldRole: 'username' }),
      fill({ fieldRole: 'password', at: 3 }),
      click({ label: '登录', path: '/login', loginAction: 'submit', at: 4 }),
      nav('/console', 5),
    ];
    expect(titleOf(events, 'login')).toBe('② 已录到登录动作，可以点「结束学习」了');
  });
});

describe('guideViewOf 文案', () => {
  it('四步文案与序号一一对应（签到学习）', () => {
    const cases: Array<[WorkflowLearningEvent[], number, string]> = [
      [[nav('/login')], 1, '① 请登录'],
      [[nav('/login'), nav('/console', 2)], 2, '② 已检测到登录成功，请前往能显示当前账号的页面'],
      [[nav('/login'), nav('/console', 2), nav('/profile', 3)], 3, '③ 请完成一次签到'],
      [[nav('/login'), nav('/console', 2), nav('/profile', 3), nav('/checkin', 4), click()], 4, '④ 已录到签到动作，可以点「结束学习」了'],
    ];
    for (const [events, step, title] of cases) {
      const view = guideViewOf(stageOf(events));
      expect(view.step).toBe(step);
      expect(view.title).toBe(title);
      expect(view.total).toBe(4);
      expect(view.hint.length).toBeGreaterThan(0);
    }
  });

  it('登录学习的步骤是两步', () => {
    expect(guideViewOf(stageOf([nav('/login')], 'login')).total).toBe(2);
    expect(guideViewOf(stageOf([nav('/login')], 'login')).step).toBe(1);
  });

  it('没有问题时不给 warning', () => {
    expect(guideViewOf(stageOf([nav('/login')])).warning).toBeUndefined();
  });

  it('融合学习步骤条随阶段推进，并在登录即签到候选时仍停留在签到步骤', () => {
    const login = guideViewOf(stageOf([nav('/login')], 'both'));
    expect(login.steps).toEqual([
      { label: '登录', state: 'current' },
      { label: '账号页', state: 'todo' },
      { label: '签到', state: 'todo' },
      { label: '结束', state: 'todo' },
    ]);

    const profile = guideViewOf(stageOf([nav('/login'), nav('/console', 2)], 'both'));
    expect(profile.steps).toEqual([
      { label: '登录', state: 'done' },
      { label: '账号页', state: 'current' },
      { label: '签到', state: 'todo' },
      { label: '结束', state: 'todo' },
    ]);

    const eligible = guideViewOf(stageOf([nav('/login'), nav('/console', 2)], 'both'));
    expect(eligible.steps.map((step) => step.state)).toEqual(['done', 'current', 'todo', 'todo']);
    expect(eligible.hint).toContain('登录即签到');

    const done = guideViewOf(stageOf([
      nav('/login'), nav('/console', 2), nav('/profile', 3), nav('/checkin', 4), click({ at: 5 }),
    ], 'both'));
    expect(done.steps).toEqual([
      { label: '登录', state: 'done' },
      { label: '账号页', state: 'done' },
      { label: '签到', state: 'done' },
      { label: '结束', state: 'current' },
    ]);
  });
});

describe('登录即签到可保存判定', () => {
  it('仅学习登录时不可用，即使已经进入站内业务页', () => {
    const events = [nav('/login'), nav('/console', 2)];
    expect(stageOf(events, 'login').loginAsCheckinAvailable).toBe(false);
    expect(canSaveLoginAsCheckin(events, 'login')).toBe(false);
  });

  it('尚未登录成功、演示中退出登录或已经录到签到动作时不可用', () => {
    const notSignedIn = [nav('/login')];
    const loggedOut = [nav('/login'), nav('/console', 2), click({ label: '退出登录', path: '/console', at: 3 })];
    const alreadyHasAction = [nav('/login'), nav('/console', 2), nav('/checkin', 3), click({ label: '签到', at: 4 })];

    for (const events of [notSignedIn, loggedOut, alreadyHasAction]) {
      expect(stageOf(events, 'both').loginAsCheckinAvailable).toBe(false);
      expect(canSaveLoginAsCheckin(events, 'both')).toBe(false);
    }
  });

  it('融合学习登录后到达业务页、未退出且没有签到动作时可用', () => {
    const events = [nav('/login'), nav('/console', 2)];
    expect(stageOf(events, 'both').loginAsCheckinAvailable).toBe(true);
    expect(canSaveLoginAsCheckin(events, 'both')).toBe(true);
  });
});

describe('页面计数与动作计数', () => {
  it('连续重复页只算一次，动作数不含 navigation', () => {
    const events = [
      nav('/console'),
      nav('/console', 2),
      fill({ path: '/console', selector: '#keyword', label: '关键词', at: 3 }),
      nav('/checkin', 4),
      click(),
    ];
    const analysis = stageOf(events);
    expect(analysis.pages).toBe(2);
    expect(analysis.actions).toBe(2);
  });
});
