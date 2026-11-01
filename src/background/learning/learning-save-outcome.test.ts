/**
 * 「结束学习」保存结果的成因分类与文案映射。
 *
 * 真实缺陷（2026-10-08 修，验收智能体在真实浏览器里复现）：用户点「开始学习」
 * 之后**立刻**（还没来得及在站点上动任何东西）就点「结束学习」，屏幕上出现
 * 「缺少用户名输入框选择器」—— 这是 `validateSiteConfig` 校验**站点既有配置**
 * 时的措辞，被原样抛成了「学习失败」的原因。用户既无法从中知道自己没演示
 * 过任何东西，也不知道下一步该做什么。
 *
 * 下面的用例把三种情形逐一钉死：
 * - 什么都没录到 → 必须说「还没有录到任何登录或签到动作」，且**绝不**泄漏
 *   站点校验器的实现措辞；会话保留（由调用方保证，这里锁的是响应语义）；
 * - 只录到一半 → 保持既有的「部分保存」语义，不被这次修改影响；
 * - 站点既有配置不完整挡住落盘 → 如实说是**站点自己的配置**不完整。
 */
import { describe, expect, it } from 'vitest';
import type { CheckinWorkflowConfig, SiteConfig } from '@/types';
import { planLearnedLoginPatch } from '@/automation/learning/learning-login';
import { validateSiteConfig } from '@/lib/site/site-security';
import { describeSiteConfigBlocker, learningSaveOutcome } from './learning-save-outcome';

/** 空演示：没有事件能编译出产物，于是 notices 里只有这句。 */
const EMPTY_DEMO_NOTICE = '这次演示还没有录到任何登录或签到动作。请先在打开的站点页面里完成一遍登录、'
  + '并点到签到按钮，再点「结束学习」；本次学习还在继续，不需要重新开始';

describe('learningSaveOutcome：什么都没录到', () => {
  it('空演示返回「还没有录到」而不是站点校验器的措辞', () => {
    const outcome = learningSaveOutcome({
      saved: [],
      notices: [EMPTY_DEMO_NOTICE],
      failures: [],
      siteConfigBlockers: [],
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.error).toContain('还没有录到');
    expect(outcome.error).toContain('任何登录或签到动作');
    // 实现细节绝不泄漏：这是这次修复的核心断言。
    expect(outcome.error).not.toContain('缺少用户名输入框选择器');
    expect(outcome.error).not.toContain('缺少密码输入框选择器');
    expect(outcome.error).not.toContain('选择器');
    // 必须给出可执行的下一步，并说明会话还在（用户不必重新点开始）。
    expect(outcome.error).toContain('结束学习');
    expect(outcome.error).toContain('不需要重新开始');
  });

  it('站点配置不完整挡住落盘时，点名是站点自己的配置问题（含翻译后的字段说明）', () => {
    const outcome = learningSaveOutcome({
      saved: [],
      notices: ['没有录到完整的登录动作（账号/密码字段或第三方登录入口），这次只保存签到流程'],
      failures: [],
      siteConfigBlockers: ['缺少用户名输入框选择器'],
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.error).toContain('这次学到的内容没有写入站点');
    expect(outcome.error).toContain('站点自己的配置还不完整');
    expect(outcome.error).toContain('账号（用户名）输入框选择器');
    expect(outcome.error).toContain('不需要重新开始');
  });

  it('没有任何线索时给一句兜底文案，不至于把 undefined 说给用户', () => {
    const outcome = learningSaveOutcome({ saved: [], notices: [], failures: [], siteConfigBlockers: [] });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.error.length).toBeGreaterThan(0);
  });
});

describe('learningSaveOutcome：只录到一半（部分保存语义不变）', () => {
  it('存下登录、缺签到时保持成功并把缺失提示原样带出', () => {
    const notice = '没有录到登录之后的签到动作，这次只保存登录配置；请在按钮可点时重新演示一次签到';
    const outcome = learningSaveOutcome({
      saved: ['login'],
      notices: [notice],
      failures: [],
      siteConfigBlockers: [],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.notices).toEqual([notice]);
    // 部分保存不能因为这次修改被改成失败。
    expect(outcome.notices.join('\n')).toContain('只保存登录配置');
  });

  it('存下签到、缺登录时同样保持成功（本来就在登录态的场景）', () => {
    const notice = '没有录到完整的登录动作（账号/密码字段或第三方登录入口），这次只保存签到流程';
    const outcome = learningSaveOutcome({
      saved: ['checkin'],
      notices: [notice],
      failures: [],
      siteConfigBlockers: [],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.notices).toEqual([notice]);
  });

  it('另一半写入失败时如实说「没保存完整」：已保存的有效，失败那半需重新学习', () => {
    const outcome = learningSaveOutcome({
      saved: ['login'],
      notices: ['没有录到登录之后的签到动作'],
      failures: ['学到的流程未通过校验：路线超过 12 项'],
      siteConfigBlockers: [],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    const text = outcome.notices.join('\n');
    expect(text).toContain('这次没有保存完整');
    expect(text).toContain('路线超过 12 项');
    // (a) 已保存的那部分必须仍然有效；
    expect(text).toContain('已保存的部分不受影响');
    // (b) 失败的那半必须重新学习 —— 会话已结束，绝不说「还在继续」。
    expect(text).toContain('需要重新学习才能补上');
    expect(text).not.toContain('本次学习还在继续');
  });

  it('站点配置挡住其中一份时如实说明，不谎报两份都存下', () => {
    const outcome = learningSaveOutcome({
      saved: ['checkin'],
      notices: [],
      failures: [],
      siteConfigBlockers: ['缺少登录按钮选择器'],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.notices.join('\n')).toContain('有内容没能保存');
    expect(outcome.notices.join('\n')).toContain('登录按钮选择器');
  });
});

describe('learningSaveOutcome：两份都录到', () => {
  it('两份都落盘时不产生任何提示', () => {
    const outcome = learningSaveOutcome({
      saved: ['login', 'checkin'],
      notices: [],
      failures: [],
      siteConfigBlockers: [],
    });

    expect(outcome).toEqual({ ok: true, notices: [] });
  });
});

describe('学习保存与站点校验的接缝：两份产物的落盘顺序', () => {
  /**
   * 真实次序问题（由 e2e learned-unified.mjs 在真实浏览器里抓到）：
   *
   * 种子站点刻意**没有** `loginMethod` 与字段选择器 ——「还没配登录表单」正是
   * 需要靠学习补上的状态。第一份产物（登录配置）落盘后站点才第一次变得合法。
   * 若判定第二份产物时仍拿**写入之前**的旧快照去跑 `validateSiteConfig`，
   * 它必然报「缺少用户名输入框选择器」，于是「一次演示学完登录 + 签到」会被
   * 自己拦下，签到流程永远存不进去。
   *
   * 这里用**真实的两个校验器**把这条次序钉死：站点校验器本身一个字没放宽，
   * 差别只在于「判定第二份产物时用的是哪一份站点快照」。
   */
  /**
   * 「还没配登录表单」的站点，**没有** `selectors` 字段。
   *
   * `SiteConfig` 类型上这是必填，但 storage 是没校验过的 JSON，e2e 与真实用户
   * 数据里都可能只落着旧记录 —— `validateSiteConfig` 也是按可能缺席写的
   * （`site.selectors?.username?.trim()`）。这里用与运行时一致的形状如实建模，
   * 而不是补一份假的空选择器把问题掩盖掉。
   */
  const bareSite = {
    id: 'site-1',
    name: '还没配登录表单的站',
    loginUrl: 'https://example.com/login',
    closeModalSelectors: [],
  } as unknown as SiteConfig;
  const learnedLogin = {
    loginMethod: 'form' as const,
    selectors: { username: '#username', password: '#password', submit: '#login-submit' },
    preLoginClickSelector: '',
  };
  const learnedWorkflow: CheckinWorkflowConfig = {
    route: ['/profile', '/checkin'],
    identityPath: '/profile',
    steps: [{ type: 'click', selector: '#claim' }],
  };

  it('旧快照会误拦第二份产物（这就是必须刷新基线的证据）', () => {
    const checkinCandidate = {
      ...bareSite,
      checkin: { method: 'workflow' as const, workflow: learnedWorkflow },
    } as SiteConfig;
    // 学习开始时的站点还没配登录表单：校验器如实报错。
    expect(validateSiteConfig(checkinCandidate)).toContain('缺少用户名输入框选择器');
    // 这正是当时被当成「学习失败」抛给用户的那句话。
    const outcome = learningSaveOutcome({
      saved: ['login'],
      notices: [],
      failures: [],
      siteConfigBlockers: validateSiteConfig(checkinCandidate),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.notices.join('\n')).toContain('站点自己的配置还不完整');
  });

  it('登录产物落盘后站点合法：第二份产物必须能通过校验、也不再有任何阻塞提示', () => {
    const loginPatch = planLearnedLoginPatch(learnedLogin, bareSite);
    const afterLogin: SiteConfig = { ...bareSite, ...loginPatch };
    // 登录补丁确实补齐了站点：这条证明了「刷新基线」不是绕过校验。
    expect(validateSiteConfig(afterLogin)).toEqual([]);

    const checkinPatch: Partial<SiteConfig> = {
      checkin: { method: 'workflow', workflow: learnedWorkflow },
    };
    const candidate = { ...afterLogin, ...checkinPatch } as SiteConfig;
    expect(validateSiteConfig(candidate)).toEqual([]);

    const outcome = learningSaveOutcome({
      saved: ['login', 'checkin'],
      notices: [],
      failures: [],
      siteConfigBlockers: validateSiteConfig(candidate),
    });
    expect(outcome).toEqual({ ok: true, notices: [] });
  });

  it('站点确实拦不住的那一类错误仍会如实上报（防线不放宽）', () => {
    const broken: SiteConfig = {
      ...bareSite,
      loginMethod: 'form',
      // 有账号框、密码框是空串：学习补丁不含这一项时依然应当被拒。
      selectors: { username: '#username', password: '', submit: '#login-submit' },
    };
    expect(validateSiteConfig(broken)).toContain('缺少密码输入框选择器');
  });
});

describe('describeSiteConfigBlocker', () => {
  it('把表单字段的三条校验错误翻译成用户能照着改的说法', () => {
    expect(describeSiteConfigBlocker('缺少用户名输入框选择器')).toContain('账号（用户名）输入框选择器');
    expect(describeSiteConfigBlocker('缺少密码输入框选择器')).toContain('密码输入框选择器');
    expect(describeSiteConfigBlocker('缺少登录按钮选择器')).toContain('登录按钮选择器');
  });

  it('其它校验错误原样保留（它们描述的确实是这次学到的内容本身）', () => {
    expect(describeSiteConfigBlocker('工作流没有配置任何步骤')).toBe('工作流没有配置任何步骤');
    // 不翻译 ≠ 放宽：调用方照旧把这句带给用户，只是不重新措辞。
    expect(describeSiteConfigBlocker('学到的流程未通过校验：路线超过 12 项'))
      .toBe('学到的流程未通过校验：路线超过 12 项');
  });
});
