import { describe, expect, it } from 'vitest';
import type { WorkflowLearningEvent } from '@/types';
import { buildLearningReport, hasCheckinResultEvidence, siteHasStoredLoginConfig } from '@/automation/learning/learning-report';

type ClickEvent = Extract<WorkflowLearningEvent, { type: 'click' }>;
type FillEvent = Extract<WorkflowLearningEvent, { type: 'fill' }>;

function nav(path: string, at = 1): WorkflowLearningEvent { return { type: 'navigation', path, at }; }
function fill(overrides: Partial<FillEvent> = {}): FillEvent {
  return { type: 'fill', selector: '#username', label: '用户名', path: '/login', hasValue: true, at: 2, ...overrides };
}
function click(overrides: Partial<ClickEvent> = {}): ClickEvent {
  return { type: 'click', selector: 'text=立即签到', label: '立即签到', path: '/checkin', at: 5, ...overrides };
}

const textOf = (events: WorkflowLearningEvent[]) => buildLearningReport(events, 'checkin').lines.map((line) => line.text).join('\n');

describe('结束学习时的完整性自检', () => {
  it('结论一 complete：先登录 → 进资料页 → 签到，且录到签到成功证据', () => {
    const events = [
      nav('/login'),
      fill(),
      fill({ selector: '#password', label: '密码', at: 3 }),
      click({ label: '登录', path: '/login', loginAction: 'submit', at: 4 }),
      nav('/console', 5),
      nav('/profile', 6),
      nav('/checkin', 7),
      click({ label: '签到', at: 8, evidence: { kind: 'success', words: ['签到成功'] } }),
    ];
    const report = buildLearningReport(events, 'checkin');
    expect(report.verdict).toBe('complete');
    expect(report.lines[0]!).toEqual({
      status: 'ok',
      text: '✅ 登录配置已学会（表单：在登录页录到了账号/密码输入，并成功进入站内页面）',
    });
    expect(report.lines[1]!.text).toBe('✅ 签到流程已学会（经过 4 个页面、4 个动作）');
    expect(report.lines[2]!.text).toBe('✅ 已录到「签到成功」证据（词：签到成功）');
    expect(report.warnings).toEqual([]);
    expect(report.summary).toContain('都已学会');
  });

  it('saveFailed=true：事件流完整也把结论下钳为 incomplete，并追加固定 missing 行', () => {
    const events = [
      nav('/login'),
      fill(),
      fill({ selector: '#password', label: '密码', at: 3 }),
      click({ label: '登录', path: '/login', loginAction: 'submit', at: 4 }),
      nav('/console', 5),
      nav('/profile', 6),
      nav('/checkin', 7),
      click({ label: '签到', at: 8, evidence: { kind: 'success', words: ['签到成功'] } }),
    ];
    // 同一份完整事件流：不传 saveFailed 仍是 complete（既有行为一字不动）。
    expect(buildLearningReport(events, 'checkin').verdict).toBe('complete');

    const report = buildLearningReport(events, 'checkin', { saveFailed: true });
    expect(report.verdict).toBe('incomplete');
    expect(report.lines).toContainEqual({
      status: 'missing',
      text: '❌ 有内容没能保存成功，本次结论按「还差内容」处理',
    });
    expect(report.warnings.join('\n')).toContain('有内容没能保存成功');
    expect(report.summary).toContain('还不够');
  });

  it('结论二 partial：签到流程学到了，但没录到「签到成功」证据', () => {
    const events = [
      nav('/login'),
      fill(),
      nav('/console', 3),
      nav('/profile', 4),
      nav('/checkin', 5),
      click({ label: '签到', at: 6 }),
    ];
    const report = buildLearningReport(events, 'checkin');
    expect(report.verdict).toBe('partial');
    const lines = report.lines.map((line) => line.text);
    expect(lines.some((line) => line.startsWith('✅ 签到流程已学会（经过 4 个页面、'))).toBe(true);
    expect(lines).toContain('⚠️ 没有录到「签到成功」证据 —— 可能是当天已签到，或你没点到真正的签到按钮');
    expect(report.warnings.some((line) => line.startsWith('没有录到「签到成功」证据'))).toBe(true);
    expect(report.summary).toContain('留意');
  });

  it('结论二 partial 的另一种成因：当天已签到（页面显示今日已完成）', () => {
    const events = [
      nav('/checkin'),
      click({ label: '签到', at: 3, evidence: { kind: 'already', words: ['已签到'] } }),
    ];
    const report = buildLearningReport(events, 'checkin');
    expect(report.verdict).toBe('partial');
    expect(report.lines.map((line) => line.text))
      .toContain('⚠️ 页面显示今天已经签到：这遍录到的流程按「已完成」处理');
  });

  it('结论三 incomplete：只点了导航项，没点到真正的签到按钮', () => {
    const events = [
      nav('/console'),
      click({ label: '个人资料', path: '/console', href: 'https://example.com/profile', at: 3 }),
      nav('/profile', 4),
    ];
    const report = buildLearningReport(events, 'checkin');
    expect(report.verdict).toBe('incomplete');
    expect(report.lines.map((line) => line.text)).toContain('❌ 没有录到签到动作（没有点到签到/领取按钮）');
    expect(report.summary).toContain('还不够');
  });

  it('融合学习普通结束仍缺少签到动作，并建议显式选择登录即签到', () => {
    const events = [nav('/login'), nav('/console', 2)];
    const report = buildLearningReport(events, 'both');

    expect(report.verdict).toBe('incomplete');
    expect(report.lines.some((line) => line.status === 'missing' && line.text.includes('没有录到签到动作'))).toBe(true);
    expect(report.lines.some((line) => line.text.includes('在账号行点「登录即签到」'))).toBe(true);
  });

  it('显式传入 loginAsCheckin，且录到登录配置并进入站内页面，才判为 complete', () => {
    const events = [nav('/login'), fill(), nav('/console', 3)];
    const report = buildLearningReport(events, 'both', { loginAsCheckin: true });

    expect(report.verdict).toBe('complete');
    expect(report.lines.some((line) => line.text === '✅ 已按「登录即签到」学会：本站登录成功后即算签到，不需要点签到按钮')).toBe(true);
    expect(report.lines.some((line) => line.status === 'missing')).toBe(false);
  });

  it('loginAsCheckin 缺少登录配置时不能无条件判为 complete', () => {
    const report = buildLearningReport([nav('/login'), nav('/console', 2)], 'both', { loginAsCheckin: true });

    expect(report.verdict).toBe('incomplete');
    expect(report.lines).toContainEqual({
      status: 'missing',
      text: '❌ 「登录即签到」未保存：没有录到登录配置',
    });
  });

  it('loginAsCheckin 有登录配置但没有进入站内页面时至少为 partial', () => {
    const report = buildLearningReport([nav('/login'), fill()], 'both', { loginAsCheckin: true });

    expect(report.verdict).toBe('partial');
    expect(report.lines).toContainEqual({
      status: 'warn',
      text: '⚠️ 「登录即签到」未保存：已录到登录配置，但没有确认成功进入站内页面',
    });
  });

  it('站点本来就是「登录即签到」（method=none）：录不到签到动作属于正常，不能判成还差内容', () => {
    // 用户现场：站点配置就是 method='none'（登录成功即算签到，页面上没有签到按钮）。
    // 用户完成登录并进入站内页面后结束学习，事件流里当然没有签到点击。旧实现只看
    // 事件流，于是给出「❌ 没有录到签到动作」，要求用户去做一件页面上不存在的事。
    const events = [
      nav('/login'),
      fill(),
      nav('/dashboard/overview', 3),
    ];

    const report = buildLearningReport(events, 'both', { siteCheckinMethod: 'none' });

    expect(report.verdict).toBe('complete');
    expect(report.lines.some((line) => line.status === 'ok'
      && line.text === '✅ 本站签到方式为「登录即签到」：登录成功即算完成，页面上没有签到按钮属于正常情况')).toBe(true);
    expect(report.lines.some((line) => line.status === 'missing')).toBe(false);
    // 不能再出现「没有录到签到动作」那条 —— 那正是用户投诉的文案。
    expect(report.lines.some((line) => line.text.includes('没有录到签到动作'))).toBe(false);
  });

  it('反向红线：站点不是登录即签到（method=auto/workflow）时，缺签到动作仍如实判还差内容', () => {
    const events = [nav('/login'), fill(), nav('/dashboard/overview', 3)];

    for (const method of ['auto', 'workflow', 'button', undefined]) {
      const report = buildLearningReport(events, 'both', { siteCheckinMethod: method });
      expect(report.verdict, String(method)).toBe('incomplete');
      expect(report.lines.some((line) => line.text.includes('没有录到签到动作')), String(method)).toBe(true);
    }
  });
  it('开始学习时已经登录（本次没录到登录动作）但站点已有登录配置：保存照旧，结论为 warn 且文案如实说明运行时表现', () => {
    // 现场形态：用户点「开始学习」时已经是登录态，演示里只有站内业务页导航
    // （/dashboard/overview 属于已知业务路径），因此 analysis.credentials 与
    // analysis.login 都为假、analysis.signedIn 为真。
    const events = [
      nav('/dashboard/overview', 1),
      click({ label: '个人资料', path: '/dashboard/overview', at: 2 }),
    ];

    // 站点上本来就有一份可用登录配置：产物照样落盘，不该被判成「还差内容」。
    const withStored = buildLearningReport(events, 'both', {
      loginAsCheckin: true,
      hasStoredLoginConfig: true,
    });
    // 保存照旧（站点有登录配置），但结论是 warn 而不是 complete：本场没有录到
    // 任何登录动作，运行时 `none` 只有在**本轮真的完成登录**时才把「没有签到
    // 控件」当成功；打开时已登录的那条路径**不会**强制重登，会返回「需处理」。
    // 报告说「可以放心使用」会与第二天的实际表现自相矛盾。
    expect(withStored.verdict).toBe('partial');
    // 锁住新文案：运行时不会先重登，只会在已是登录态时停下标「需处理」；
    // 想每轮强制重登只能改站点签到方式。旧文案承诺的「自动签到时会先重新
    // 登录再确认」是运行时不存在的行为，已删除。
    expect(withStored.lines).toContainEqual({
      status: 'warn',
      text: '⚠️ 已按「登录即签到」保存：本次没录到登录动作（可能打开时已登录）；运行时若已登录，无法证明本轮登录拿到奖励，会停在「需处理」而不记成功；要每轮强制退出重登，请把本站签到方式改成「退出再登录」',
    });
    // 反向红线：文案里不得再出现「先重新登录再确认」这种运行时不会发生的承诺。
    expect(withStored.lines.map((line) => line.text).join('\n')).not.toContain('先重新登录再确认');
    expect(withStored.lines.some((line) => line.status === 'missing')).toBe(false);

    // 站点上也没有可用登录配置时保持原判：如实说缺登录配置，绝不无条件放行。
    const withoutStored = buildLearningReport(events, 'both', {
      loginAsCheckin: true,
      hasStoredLoginConfig: false,
    });
    expect(withoutStored.verdict).toBe('incomplete');
    expect(withoutStored.lines).toContainEqual({
      status: 'missing',
      text: '❌ 「登录即签到」未保存：没有录到登录配置',
    });
  });

  it('siteHasStoredLoginConfig：非表单登录方式不依赖账密选择器，表单方式要求三个选择器齐全', () => {
    const blank = { username: '', password: '', submit: '' };
    expect(siteHasStoredLoginConfig({ loginMethod: 'oauth', selectors: blank })).toBe(true);
    expect(siteHasStoredLoginConfig({ loginMethod: 'token', selectors: blank })).toBe(true);
    // 账号级登录方式覆盖站点：账号是 OAuth/token 时，站点没有表单选择器也能登录。
    expect(siteHasStoredLoginConfig({ selectors: blank }, 'oauth')).toBe(true);
    expect(siteHasStoredLoginConfig({ selectors: blank }, 'token')).toBe(true);
    expect(siteHasStoredLoginConfig({ selectors: blank }, 'auto')).toBe(false);
    expect(siteHasStoredLoginConfig({ selectors: blank }, undefined)).toBe(false);
    expect(siteHasStoredLoginConfig({ selectors: { username: '#u', password: '#p', submit: '#s' } })).toBe(true);
    // 表单方式缺一不可：缺 submit、或某一项只有空白，都不算「已有登录配置」。
    expect(siteHasStoredLoginConfig({ selectors: { username: '#u', password: '#p', submit: '' } })).toBe(false);
    expect(siteHasStoredLoginConfig({ selectors: { username: '#u', password: '   ', submit: '#s' } })).toBe(false);
    expect(siteHasStoredLoginConfig({ selectors: blank })).toBe(false);
  });

  it('结论三 incomplete：点了「退出登录」，签到证据作废并如实提示', () => {
    const events = [
      nav('/checkin'),
      click({ label: '签到', at: 3, evidence: { kind: 'success', words: ['签到成功'] } }),
      click({ label: '退出登录', path: '/checkin', at: 6 }),
      nav('/login', 7),
    ];
    const report = buildLearningReport(events, 'checkin');
    expect(report.verdict).toBe('incomplete');
    expect(report.warnings.join('\n')).toContain('退出登录');
  });

  it('开始学习时已经登录：不谎报「登录配置已学会」，也不当成缺陷', () => {
    const events = [nav('/checkin'), click({ label: '签到', at: 3, evidence: { kind: 'success', words: ['签到成功'] } })];
    const report = buildLearningReport(events, 'checkin');
    expect(report.verdict).toBe('complete');
    expect(report.lines[0]!).toEqual({
      status: 'ok',
      text: 'ℹ️ 本次没有录到登录步骤（开始学习时可能已经是登录状态），只更新签到流程',
    });
  });

  it('学习登录：账密都识别 → complete；只识别一个字段 → partial；什么都没录 → incomplete', () => {
    const complete = buildLearningReport([
      nav('/login'),
      fill({ fieldRole: 'username' }),
      fill({ fieldRole: 'password', selector: '#password', label: '密码', at: 3 }),
      click({ label: '登录', path: '/login', loginAction: 'submit', at: 4 }),
    ], 'login');
    expect(complete.verdict).toBe('complete');
    expect(complete.lines[0]!.text).toBe('✅ 登录配置已学会（表单：用户名/密码已识别）');

    const partial = buildLearningReport([nav('/login'), fill({ fieldRole: 'username' })], 'login');
    expect(partial.verdict).toBe('partial');
    expect(partial.lines[0]!.text).toContain('只录到其中一个字段');

    const incomplete = buildLearningReport([nav('/login')], 'login');
    expect(incomplete.verdict).toBe('incomplete');
    expect(incomplete.lines[0]!.text).toContain('没有录到登录动作');
  });

  it('融合学习（both）：一次演示同时给出登录与签到两行结论', () => {
    const events = [
      nav('/login'),
      fill(),
      nav('/console', 3),
      nav('/profile', 4),
      nav('/checkin', 5),
      click({ label: '签到', at: 6, evidence: { kind: 'success', words: ['签到成功'] } }),
    ];
    const report = buildLearningReport(events, 'both');
    expect(report.verdict).toBe('complete');
    expect(report.lines[0]!.text).toBe('✅ 登录配置已学会（表单：在登录页录到了账号/密码输入，并成功进入站内页面）');
    expect(report.lines[1]!.text.startsWith('✅ 签到流程已学会（经过 4 个页面、')).toBe(true);
  });

  it('学习登录：第三方登录入口算学会（OAuth 场景）', () => {
    const report = buildLearningReport([
      nav('/login'),
      click({ label: '使用 GitHub 继续', path: '/login', loginAction: 'oauth', at: 3 }),
    ], 'login');
    expect(report.verdict).toBe('complete');
    expect(report.lines[0]!.text).toBe('✅ 登录配置已学会（第三方登录入口已识别）');
  });

  it('报告里不出现输入值、选择器或页面正文（隐私红线）', () => {
    const events = [
      nav('/login'),
      fill({ selector: '#username-sentinel', label: '用户名' }),
      fill({ selector: '#password-sentinel', label: '密码', at: 3 }),
      nav('/console', 4),
      nav('/checkin', 5),
      click({ selector: '#claim-sentinel', label: '立即签到', at: 6, evidence: { kind: 'success', words: ['签到成功'] } }),
    ];
    const report = buildLearningReport(events, 'checkin');
    const serialized = JSON.stringify(report);
    for (const forbidden of ['sentinel', '#username', '#password', '#claim', '{{']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('hasCheckinResultEvidence 只在真的命中固定词表时才为真', () => {
    expect(hasCheckinResultEvidence([click({ label: '签到' })])).toBe(false);
    expect(hasCheckinResultEvidence([click({ evidence: { kind: 'success', words: ['签到成功'] } })])).toBe(true);
    expect(hasCheckinResultEvidence([click({ evidence: { kind: 'already', words: ['今日已'] } })])).toBe(true);
  });
});
