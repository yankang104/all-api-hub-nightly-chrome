import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckinWorkflowConfig, CheckinWorkflowStep, SiteConfig, WorkflowLearningEvent, WorkflowLearningSession } from '@/types';
import {
  appendLearningEvent,
  buildLearnedArtifacts,
  buildLearnedLoginSettings,
  buildLearnedWorkflow,
  shouldAutoSaveLoginAsCheckin,
  needsLoginAsCheckinChoice,
  needsCheckinEvidenceChoice,
  LOGIN_AS_CHECKIN_CHOICE_MESSAGE,
  evidenceFromText,
  type LearningEventWithChange,
  LEARNING_TTL_MS,
  LearningCapture,
  learningSelector,
  isSafeSnippet,
  isUnstableGeneratedId,
  partitionLearningSessions,
  verifyLearnedLoginAsCheckinStored,
  verifyLearnedWorkflowStored,
  findConflictingLearningSession,
  decideLearningStart,
} from '@/automation/learning/learning';
import { queryFirst } from '@/automation/shared/dom-utils';
import { validateCheckinWorkflow } from '@/lib/workflow/workflow-validation';
import { analyzeLearningEvents, canSaveLoginAsCheckin } from '@/automation/learning/learning-stage';

type ClickEvent = Extract<WorkflowLearningEvent, { type: 'click' }>;
type FillEvent = Extract<WorkflowLearningEvent, { type: 'fill' }>;

function nav(path: string, at = 1): WorkflowLearningEvent {
  return { type: 'navigation', path, at };
}

function click(overrides: Partial<ClickEvent> = {}): ClickEvent {
  return { type: 'click', selector: '#checkin', label: '立即签到', path: '/profile', at: 2, ...overrides };
}

function fill(overrides: Partial<FillEvent> = {}): FillEvent {
  return { type: 'fill', selector: '#username', label: '用户名', path: '/login', hasValue: true, at: 2, ...overrides };
}

const site: SiteConfig = {
  id: 'site-1',
  name: '测试站',
  loginUrl: 'https://example.com/login',
  selectors: { username: '#user', password: '#pass', submit: '#submit' },
  closeModalSelectors: [],
};

/** 把「页面守卫」拆开，只为按真实顺序断言动作本身。 */
function flattenSteps(steps: CheckinWorkflowStep[]): CheckinWorkflowStep[] {
  return steps.flatMap((step) => (
    step.type === 'if' && step.condition.type === 'path' ? flattenSteps(step.then) : [step]
  ));
}

/** 步骤的可读形状，用来断言「逐一步骤对应且顺序一致」。 */
function stepShape(step: CheckinWorkflowStep): string {
  switch (step.type) {
    case 'click': return `click ${step.selector}`;
    case 'fill': return `fill ${step.selector} ${step.value}`;
    case 'assert': return `assert ${(step.text ?? []).join('|')}`;
    case 'navigate': return `navigate ${step.url}`;
    case 'if': return `if ${step.condition.type}`;
    default: return step.type;
  }
}

describe('buildLearnedWorkflow', () => {
  it('签到按钮就在资料页上时，签到终点页本身成为身份核验页', () => {
    const learned = buildLearnedWorkflow(site, [
      { type: 'navigation', path: '/profile', at: 1 },
      { type: 'click', selector: '#checkin', label: '立即签到', path: '/profile', at: 2 },
    ]);

    expect(learned?.workflow.route).toEqual(['/profile']);
    expect(learned?.workflow.identityPath).toBe('/profile');
    expect(validateCheckinWorkflow(site, learned!.workflow)).toEqual([]);
  });

  it('推断不出独立资料页时兜底用签到终点，且不在路线里重复插入同一页', () => {
    const learned = buildLearnedWorkflow(site, [
      { type: 'navigation', path: '/dashboard', at: 1 },
      { type: 'navigation', path: '/check-in', at: 2 },
      { type: 'click', selector: '#checkin', label: '签到', path: '/check-in', at: 3 },
    ]);

    // 路线里只出现一次终点页：身份页与签到目标同址，不能再插一份
    expect(learned?.workflow.route).toEqual(['/dashboard', '/check-in']);
    expect(learned?.workflow.identityPath).toBe('/check-in');
    expect(validateCheckinWorkflow(site, learned!.workflow)).toEqual([]);
  });

  it('records a distinct profile page before the check-in target as identityPath', () => {
    const learned = buildLearnedWorkflow(site, [
      { type: 'navigation', path: '/dashboard', at: 1 },
      {
        type: 'click', selector: '#profile', label: '个人资料', path: '/dashboard',
        href: 'https://example.com/profile', at: 2,
      },
      { type: 'navigation', path: '/profile', at: 3 },
      { type: 'navigation', path: '/daily', at: 4 },
      { type: 'click', selector: '#checkin', label: '签到', path: '/daily', at: 5 },
    ]);

    expect(learned?.workflow.route).toEqual(['/dashboard', '/profile', '/daily']);
    expect(learned?.workflow.identityPath).toBe('/profile');
  });

  it('route reaches its cap without dropping the profile identity page or the check-in target', () => {
    const events: WorkflowLearningEvent[] = [
      { type: 'navigation', path: '/page-1', at: 1 },
      {
        type: 'click', selector: '#profile', label: '个人资料', path: '/page-1',
        href: 'https://example.com/profile', at: 2,
      },
    ];
    for (let index = 2; index <= 11; index += 1) {
      events.push({ type: 'navigation', path: `/page-${index}`, at: index + 1 });
    }
    events.push(
      { type: 'navigation', path: '/daily', at: 12 },
      { type: 'click', selector: '#checkin', label: '签到', path: '/daily', at: 13 },
    );

    const learned = buildLearnedWorkflow(site, events);

    expect(learned?.workflow.route).toHaveLength(12);
    expect(learned?.workflow.route).toContain('/profile');
    expect(learned?.workflow.route?.at(-1)).toBe('/daily');
    expect(learned?.workflow.identityPath).toBe('/profile');
    expect(validateCheckinWorkflow(site, learned!.workflow)).toEqual([]);
  });

  it('把 SPA 签到页导航事件学习成同源页面路线', () => {
    const events: WorkflowLearningEvent[] = [
      { type: 'navigation', path: '/check-in', at: 1 },
      { type: 'click', selector: 'button.checkin', label: '立即签到', path: '/check-in', at: 2 },
      {
        type: 'click',
        selector: 'button.checkin',
        label: '已签到',
        path: '/check-in',
        evidence: { kind: 'already', words: ['已签到'] },
        at: 3,
      },
    ];

    const result = buildLearnedWorkflow(site, events);

    expect(result?.workflow.route).toEqual(['/check-in']);
    expect(result?.workflow.steps).not.toContainEqual({ type: 'navigate', url: '/check-in' });
    expect(result?.workflow.steps).toContainEqual({ type: 'click', selector: 'button.checkin' });
  });

  it('不把登录按钮或敏感页面文字编译进签到流程', () => {
    const result = buildLearnedWorkflow(site, [
      { type: 'click', selector: '#login', label: '登录', path: '/login', at: 1 },
      { type: 'click', selector: 'button.checkin', label: '立即签到', path: '/check-in', at: 2 },
    ]);

    expect(result?.workflow.steps).not.toContainEqual({ type: 'click', selector: '#login' });
    expect(JSON.stringify(result)).not.toContain('password');
  });

  it('登录页面上的普通用户名框和“继续”动作也不进入登录后的签到流程', () => {
    const result = buildLearnedWorkflow(site, [
      { type: 'fill', selector: '#user', label: '用户名', hasValue: true, path: '/login', at: 1 },
      { type: 'click', selector: '#continue', label: '继续', path: '/login', at: 2 },
      { type: 'click', selector: '#daily', label: '签到', path: '/check-in', at: 3 },
    ]);

    expect(result?.workflow.route).toEqual(['/check-in']);
    expect(JSON.stringify(result?.workflow)).not.toContain('#user');
    expect(JSON.stringify(result?.workflow)).not.toContain('#continue');
    expect(result?.workflow.steps).toContainEqual({ type: 'click', selector: '#daily' });
  });

  it('只演示登录而未演示签到时不能保存成可回放流程', () => {
    expect(buildLearnedWorkflow(site, [
      { type: 'fill', selector: '#user', label: '用户名', hasValue: true, path: '/login', at: 1 },
      { type: 'click', selector: '#continue', label: '继续', path: '/login', at: 2 },
    ])).toBeNull();
  });

  it('哈希路由中的认证页动作被过滤，登录后的签到页正常保留', () => {
    const result = buildLearnedWorkflow({ ...site, loginUrl: 'https://example.com/' }, [
      { type: 'fill', selector: '#user', label: '用户名', hasValue: true, path: '/#/login', at: 1 },
      { type: 'click', selector: '#continue', label: '继续', path: '/#/oauth/authorize', at: 2 },
      { type: 'click', selector: '#daily', label: '签到', path: '/#/daily', at: 3 },
    ]);

    expect(result?.workflow.route).toEqual(['/#/daily']);
    expect(JSON.stringify(result?.workflow)).not.toContain('#user');
    expect(JSON.stringify(result?.workflow)).not.toContain('#continue');
  });
});

describe('evidenceFromText', () => {
  it('只返回有限的成功/已完成词，不返回原始页面内容', () => {
    expect(evidenceFromText('用户邮箱 someone@example.com，今日已签到')).toMatchObject({
      kind: 'already',
      words: expect.arrayContaining(['今日已']),
    });
    expect(JSON.stringify(evidenceFromText('用户邮箱 someone@example.com，今日已签到'))).not.toContain('someone@example.com');
  });
});

/**
 * 用户风险：签到后弹层里回显的中转密钥（`sk-`、`ghp_`、`xoxb-` 这类）会被采集进
 * 「界面出现了什么」，进而作为 `assert.text` 明文写进站点配置（chrome storage，明文）。
 * `isSafeSnippet` 是拦住它的唯一内容闸门 —— 旧实现只拦邮箱、六位连号与明文凭据词，
 * 漏掉了既没有六位连号、也不含 `password`/`token`/`secret` 字样的 API 密钥形态。
 */
describe('片段脱敏拦截 API 密钥形态的高熵串', () => {
  it('密钥/高熵串一律拒绝（即便没有六位连续数字、也不含 token/secret 字样）', () => {
    for (const secret of [
      'sk-Ab3xY9mKQwT1p0Zr7Ln2Vc',        // OpenAI 风格：数字字母混排、无六位连号
      'sk-proj-Ab3xY9mKQwT1p0Zr7Ln',      // OpenAI 项目密钥（前缀命中，长度不足 20 也拦）
      'ghp_16CharsOrMoreAlnumXyz012345',   // GitHub PAT
      'gho_Ab3xY9mKQwT1p0Zr7Ln2Vc',       // GitHub OAuth token
      'glpat-Ab3xY9mKQwT1p0Zr7',          // GitLab PAT
      'xoxb-Ab3xY9mKQwT1p0Zr7Ln',         // Slack bot token
      'Ab3xY9mKQwT1p0Zr7Ln2VcQw',         // 无前缀、数字字母混排的 20+ 位高熵串
    ]) {
      expect(isSafeSnippet(secret), `${secret} 应被拒绝`).toBe(false);
    }
  });

  it('普通中英文短标签与句子一律放行 —— 修复不得误伤正常界面文字', () => {
    for (const ok of [
      '签到成功', '立即签到', '今日已签到', '领取成功', '每日签到', '领取理由', '奖励已发放',
      'Dashboard', 'Check in', 'Sign in success',
      'internationalization',   // 20 位纯字母长单词：无数字，不算密钥
      'task-list', 'disk-usage', // `sk` 嵌在普通词里、不在词首，不算密钥前缀
    ]) {
      expect(isSafeSnippet(ok), `${ok} 应放行`).toBe(true);
    }
  });

  it('afterText 里混入的密钥不会被编译进 assert 步骤（读回侧同样兜住脱敏）', () => {
    const learned = buildLearnedWorkflow(site, [
      {
        type: 'click',
        selector: '#claim',
        label: '签到',
        path: '/check-in',
        // 签到后弹层同时出现「奖励已发放」和一串中转密钥：只有前者该被学成断言
        afterText: ['奖励已发放', 'sk-Ab3xY9mKQwT1p0Zr7Ln2Vc'],
        at: 1,
      } as WorkflowLearningEvent,
    ]);

    const json = JSON.stringify(learned!.workflow);
    // 密钥绝不能出现在写进站点配置的步骤里
    expect(json).not.toContain('sk-Ab3xY9mKQwT1p0Zr7Ln2Vc');
    // 正常的变化文案仍被保留为断言（证明不是把整条 afterText 一并丢掉）
    expect(json).toContain('奖励已发放');
  });
});

describe('学习网址路线', () => {
  it('未知站点的签到页也能学会，不依赖固定关键词', () => {
    const result = buildLearnedWorkflow(site, [
      { type: 'navigation', path: '/dashboard', at: 1 },
      { type: 'navigation', path: '/daily-reward', at: 2 },
      { type: 'click', selector: 'button.claim', label: '领取', path: '/daily-reward', at: 3 },
    ]);

    expect(result?.workflow.route).toEqual(['/dashboard', '/daily-reward']);
    expect(result?.workflow.steps).toContainEqual({ type: 'click', selector: 'button.claim' });
  });

  it('保留哈希路由与查询无关的路径，并按访问顺序去重', () => {
    const result = buildLearnedWorkflow(site, [
      { type: 'navigation', path: '/#/home', at: 1 },
      { type: 'navigation', path: '/#/checkin', at: 2 },
      { type: 'navigation', path: '/#/checkin', at: 3 },
      { type: 'click', selector: '#claim-btn', label: '签到', path: '/#/checkin', at: 4 },
    ]);

    expect(result?.workflow.route).toEqual(['/#/home', '/#/checkin']);
  });

  it('外域页面不进路线', () => {
    const result = buildLearnedWorkflow(site, [
      { type: 'navigation', path: 'https://evil.example/steal', at: 1 },
      { type: 'navigation', path: '/check-in', at: 2 },
      { type: 'click', selector: 'button.checkin', label: '立即签到', path: '/check-in', at: 3 },
    ]);

    expect(result?.workflow.route).toEqual(['/check-in']);
    expect(JSON.stringify(result)).not.toContain('evil.example');
  });

  /**
   * 现场故障（CottonAPI）：用户当天已签到、页面上没有「立即签到」按钮，演示时最后
   * 点的是导航项「个人资料」。旧实现把最后一个动作兜底当成签到动作，学出的流程以
   * 「点击个人资料」收尾 —— 回放自然找不到签到按钮，用户看到的就是「根本没学到我的操作」。
   *
   * 正确的处置是当场拒结保存（保存侧没收到 identityPath 会报「没录到签到动作」），
   * 而不是保存一份回放必然失败的流程。
   */
  it('最后点的是导航项时不当签到动作：不产出路线，让保存侧拒结', () => {
    const learned = buildLearnedWorkflow(site, [
      { type: 'navigation', path: '/dashboard', at: 1 },
      { type: 'navigation', path: '/profile', at: 2 },
      { type: 'click', selector: 'text=个人资料', label: '个人资料', path: '/profile', at: 3 },
    ]);

    // 那次点击仍作为步骤留着（用户确实点过），但整条流程不能自称「学会了签到」。
    expect(learned?.workflow.steps).toContainEqual({ type: 'click', selector: 'text=个人资料' });
    expect(learned?.workflow.route).toBeUndefined();
    expect(learned?.workflow.identityPath).toBeUndefined();
  });

  it('菜单里的「签到」导航项（链接指向别的页面）也不能当终点动作', () => {
    const learned = buildLearnedWorkflow(site, [
      { type: 'navigation', path: '/dashboard', at: 1 },
      {
        type: 'click', selector: '#nav-checkin', label: '签到', path: '/dashboard',
        href: 'https://example.com/checkin', at: 2,
      },
    ]);

    expect(learned?.workflow.route).toBeUndefined();
    expect(learned?.workflow.identityPath).toBeUndefined();
  });

  it('无链接的签到按钮不受导航闸门影响（aria-label=签到的图标按钮）', () => {
    const learned = buildLearnedWorkflow(site, [
      { type: 'navigation', path: '/checkin', at: 1 },
      { type: 'click', selector: '#claim', label: '签到', path: '/checkin', at: 2 },
    ]);

    expect(learned?.workflow.route).toEqual(['/checkin']);
    expect(learned?.workflow.identityPath).toBe('/checkin');
  });
});

/**
 * 用户报的 bug：「你这学习到了个蛋，不仅流程重复，逻辑不对，什么也没学习到」。
 *
 * 学习时用 `site.loginUrl` 开页，而该站 loginUrl 的 pathname 就是 `/sign-in`；
 * `LearningCapture` 首次加载即上报一个 navigation 事件，于是**登录页成了路线第一页**。
 * 回放时用户的真实签到页是 `/dashboard/overview`（站点把 `/sign-in` 重定向过去），
 * 它不在 route 里 → `resolveRoute` 每次从 route[0] 重新跳 → 跳回登录页 → 站点又重定向回来
 * → 日志三行完全一样地重复。下面这些用例锁定 route 生成侧的修复。
 */
describe('路线不得把登录页录进去', () => {
  /** 复刻真实故障站点：`loginUrl` 指向 `/sign-in`（用户日志里的签到站正是这个形状）。 */
  const authSite: SiteConfig = { ...site, loginUrl: 'https://example.com/sign-in' };

  it('与 site.loginUrl 同路径的登录页不进路线，路线从真实落地页开始', () => {
    const learned = buildLearnedWorkflow(authSite, [
      { type: 'navigation', path: '/sign-in', at: 1 },
      { type: 'navigation', path: '/dashboard/overview', at: 2 },
      { type: 'navigation', path: '/profile', at: 3 },
      { type: 'click', selector: '#claim', label: '签到', path: '/profile', at: 4 },
    ]);

    expect(learned!.workflow.route).toEqual(['/dashboard/overview', '/profile']);
    // 路线首项绝不能是登录页（回放时它就是那个把用户拉回去的落点）
    expect(learned!.workflow.route?.[0]).not.toBe('/sign-in');
    expect(learned!.workflow.route).not.toContain('/sign-in');
    // 末项仍然是签到页
    expect(learned!.workflow.route?.at(-1)).toBe('/profile');
  });

  it('路径本身就是登录/注册语义的页面也被排除（/login、/auth/callback、/register）', () => {
    const learned = buildLearnedWorkflow(site, [
      { type: 'navigation', path: '/login', at: 1 },
      { type: 'navigation', path: '/auth/callback', at: 2 },
      { type: 'navigation', path: '/register', at: 3 },
      { type: 'navigation', path: '/check-in', at: 4 },
      { type: 'click', selector: '#claim', label: '签到', path: '/check-in', at: 5 },
    ]);

    expect(learned!.workflow.route).toEqual(['/check-in']);
  });

  it('只按路径判、不扫页面文字：/login-history 这种正常业务页不被误伤', () => {
    const events: LearningEventWithChange[] = [
      { type: 'navigation', path: '/dashboard', at: 1 },
      { type: 'navigation', path: '/login-history', at: 2 },
      {
        type: 'click',
        selector: '#claim',
        label: '签到',
        path: '/login-history',
        // 正常业务页上也会出现「请先登录」这类提示文字，它不该让页面被判成登录页
        afterText: ['请先登录'],
        at: 3,
      },
    ];
    const learned = buildLearnedWorkflow(site, events);

    expect(learned!.workflow.route).toEqual(['/dashboard', '/login-history']);
  });

  it('用户真实走过的页面逐页对应：动作发生过的页面不因缺 navigation 事件而被丢掉', () => {
    const learned = buildLearnedWorkflow(authSite, [
      { type: 'navigation', path: '/sign-in', at: 1 },
      // 登录页上的动作：页面属于登录页，不进路线
      { type: 'click', selector: '#entry', label: '每日签到', path: '/sign-in', at: 2 },
      // 整页跳转后中途落在的页面（这一次没有 navigation 事件，但用户确实在这一页点过）
      { type: 'click', selector: '#to-profile', label: '个人中心', path: '/dashboard', at: 3 },
      { type: 'navigation', path: '/profile', at: 4 },
      {
        type: 'click',
        selector: '#claim',
        label: '签到',
        path: '/profile',
        evidence: { kind: 'success', words: ['签到成功'] },
        at: 5,
      },
    ]);

    expect(learned!.workflow.route).toEqual(['/dashboard', '/profile']);
  });

  it('路线里全是登录页时不保存，避免登录动作混入签到阶段', () => {
    const learned = buildLearnedWorkflow(authSite, [
      { type: 'navigation', path: '/sign-in', at: 1 },
      { type: 'click', selector: '#claim', label: '签到', path: '/sign-in', at: 2 },
    ]);

    expect(learned).toBeNull();
  });

  it('签到动作本身落在登录语义页面时也不硬造路线（route 末项必须是签到页）', () => {
    const learned = buildLearnedWorkflow(authSite, [
      { type: 'navigation', path: '/dashboard', at: 1 },
      { type: 'navigation', path: '/sign-in', at: 2 },
      { type: 'click', selector: '#claim', label: '签到', path: '/sign-in', at: 3 },
    ]);

    // 签到标签不能覆盖认证页面这个事实，用户必须先登录再演示签到。
    expect(learned).toBeNull();
  });

  it('loginUrl 带哈希时按完整项比对，不把整条哈希路线判成登录页', () => {
    // 哈希路由站点：pathname 恒为 `/`，只有 hash 能区分页面。
    const hashSite: SiteConfig = { ...site, loginUrl: 'https://example.com/#/sign-in' };
    const learned = buildLearnedWorkflow(hashSite, [
      { type: 'navigation', path: '/#/sign-in', at: 1 },
      { type: 'navigation', path: '/#/dashboard', at: 2 },
      { type: 'click', selector: '#claim', label: '签到', path: '/#/check-in', at: 3 },
    ]);

    expect(learned!.workflow.route).toEqual(['/#/dashboard', '/#/check-in']);
    expect(learned!.workflow.route).not.toContain('/#/sign-in');

    // 反过来：loginUrl 是根路径（`https://x.com/`）时不能把 `/` 判成登录页，
    // 否则哈希路由站点的路线会被整条清空。
    const rootSite: SiteConfig = { ...site, loginUrl: 'https://example.com/' };
    const rootLearned = buildLearnedWorkflow(rootSite, [
      { type: 'navigation', path: '/#/home', at: 1 },
      { type: 'navigation', path: '/#/check-in', at: 2 },
      { type: 'click', selector: '#claim', label: '签到', path: '/#/check-in', at: 3 },
    ]);

    expect(rootLearned!.workflow.route).toEqual(['/#/home', '/#/check-in']);
  });

  it('哈希路由的不同页面动作分别保留页面守卫', () => {
    const hashSite: SiteConfig = { ...site, loginUrl: 'https://example.com/#/sign-in' };
    const learned = buildLearnedWorkflow(hashSite, [
      { type: 'navigation', path: '/#/console', at: 1 },
      { type: 'click', selector: '#entry', label: '打开签到', path: '/#/console', at: 2 },
      { type: 'navigation', path: '/#/check-in', at: 3 },
      { type: 'click', selector: '#claim', label: '立即签到', path: '/#/check-in', at: 4 },
    ]);

    expect(learned).not.toBeNull();
    expect(learned!.workflow.route).toEqual(['/#/console', '/#/check-in']);
    expect(learned!.workflow.steps[0]).toMatchObject({
      type: 'if',
      condition: { type: 'path', pattern: '/#/console' },
      then: [{ type: 'click', selector: '#entry' }],
    });
    expect(learned!.workflow.steps[1]).toEqual({ type: 'click', selector: '#claim' });
  });
});

/**
 * 用户报的 bug：「你学习的很垃圾，没有学到真实的每一步」。
 *
 * 旧实现先用标签里的「登录/注册」把点击整段丢掉，再只保留 firstRelevant-4 之后的部分，
 * 于是用户真实做过的一串动作被压成几乎为空；输入的文字更是从来没被采集过。
 * 用户要求每一步都要回答三件事：我点击/输入了什么、界面出现了什么、我跳到了哪个网站。
 * 下面这些用例就是这次修复的回归点。
 */
describe('学习真实的每一步', () => {
  const siteWithClaim: SiteConfig = { ...site, checkin: { method: 'workflow', claimText: '每日签到' } };

  /** 用户真实走过的一遍：进控制台 → 点签到入口 → 跳签到页 → 填理由 → 提交 → 出现成功。 */
  function realSession(): LearningEventWithChange[] {
    return [
      { type: 'navigation', path: '/console', at: 1 },
      {
        type: 'click',
        selector: '#checkin-entry',
        label: '每日签到',
        path: '/console',
        afterText: ['签到'],
        at: 2,
      },
      { type: 'navigation', path: '/checkin', at: 3 },
      {
        type: 'fill',
        selector: '#reason',
        label: '领取理由',
        path: '/checkin',
        hasValue: true,
        at: 4,
      },
      {
        type: 'click',
        selector: '#submit',
        label: '提交',
        path: '/checkin',
        afterText: ['领取成功'],
        evidence: { kind: 'success', words: ['领取成功'] },
        at: 5,
      },
    ];
  }

  it('点击/输入/页面变化逐一对应，且顺序与录制完全一致', () => {
    const learned = buildLearnedWorkflow(siteWithClaim, realSession());
    expect(learned).not.toBeNull();

    // 每个动作后面紧跟着当时学到的「界面出现了什么」，未命中不致命（站点改文案仍可回放）
    expect(flattenSteps(learned!.workflow.steps).map(stepShape)).toEqual([
      'click #checkin-entry',
      'assert 签到',
      'fill #reason {{claimText}}',
      'click #submit',
      'assert 领取成功',
      'if text',
    ]);
  });

  it('每个动作都带在哪个页面发生的标记：先进入该页面再执行该页动作', () => {
    const learned = buildLearnedWorkflow(siteWithClaim, realSession());
    const steps = learned!.workflow.steps;

    // 控制台里的入口点击被页面守卫包住：回放到签到页时不会去点一个不存在的入口
    expect(steps[0]).toMatchObject({
      type: 'if',
      condition: { type: 'path', pattern: '/console' },
    });
    // 签到页上的动作直接执行，不再需要守卫
    expect(steps.at(-1)).toMatchObject({ type: 'if', condition: { type: 'text' } });
    expect(flattenSteps(steps).filter((step) => step.type === 'click').map(stepShape))
      .toEqual(['click #checkin-entry', 'click #submit']);
  });

  /**
   * 现场故障：签到完成后页面同时出现「签到成功」提示与「今日已签到」按钮，
   * 终局 if 先判 already 就会把本轮真实签到降级成「之前就签过了」，奖励归因错误。
   * 终局分支必须与 workflow-outcome.ts 一致：**先判成功、再判已签到**。
   */
  it('终局分支先判 success 再判 already，页面同时出现两类文案时判成功', async () => {
    const learned = buildLearnedWorkflow(siteWithClaim, [
      { type: 'click', selector: '#claim', label: '签到', path: '/check-in', at: 1 },
      {
        type: 'click', selector: '#submit', label: '提交', path: '/check-in',
        evidence: { kind: 'success', words: ['签到成功'] }, at: 2,
      },
    ]);
    expect(learned).not.toBeNull();

    const last = learned!.workflow.steps.at(-1);
    expect(last).toMatchObject({
      type: 'if',
      condition: { type: 'text', words: ['签到成功'] },
      then: [{ type: 'assert', text: ['签到成功'], result: 'success', timeoutMs: 5_000 }],
      else: [{ type: 'assert', text: expect.arrayContaining(['今日已']), result: 'already', timeoutMs: 5_000 }],
    });

    // 真回放这一条终局 if：页面同时有成功与已签到证据时必须判 success。
    document.body.innerText = '签到成功 今日已签到';
    try {
      const { runCheckinWorkflow } = await import('@/automation/learning/workflow');
      const result = await runCheckinWorkflow(siteWithClaim, { steps: [last!] }, { push: vi.fn() });
      expect(result).toEqual({ status: 'success', message: '工作流命中成功证据' });
    } finally {
      // jsdom 的 innerText 不会被 beforeEach 里的 innerHTML='' 清掉，显式还原避免串场。
      document.body.innerText = '';
    }
  });

  it('fill 编译成 {{claimText}} 占位符，不留下用户输入的任何文字', () => {
    // 模拟旧实现会犯的错：把用户输入值一起上报。
    const withRawValue = realSession().map((event) => (
      event.type === 'fill'
        ? { ...event, value: '我的领取理由-勿泄露' } as unknown as WorkflowLearningEvent
        : event
    ));

    const learned = buildLearnedWorkflow(siteWithClaim, withRawValue);

    expect(learned!.workflow.steps).toContainEqual({
      type: 'fill',
      selector: '#reason',
      value: '{{claimText}}',
    });
    expect(JSON.stringify(learned)).not.toContain('我的领取理由');
  });

  it('动作后没有可识别的页面变化时，不硬塞断言', () => {
    const learned = buildLearnedWorkflow(siteWithClaim, [
      { type: 'click', selector: '#claim', label: '签到', path: '/check-in', at: 1 },
    ]);

    expect(learned!.workflow.steps.map(stepShape)).toEqual(['click #claim', 'if text']);
  });

  it('动作很多时优先保留全部动作，超出保存上限的只裁掉页面变化检查', () => {
    const events: LearningEventWithChange[] = [];
    for (let index = 1; index <= 26; index += 1) {
      events.push({
        type: 'click',
        selector: `#step-${index}`,
        label: `步骤${index}`,
        path: '/check-in',
        afterText: ['完成'],
        at: index,
      });
    }

    const learned = buildLearnedWorkflow(siteWithClaim, events);
    const steps = learned!.workflow.steps;

    // 26 个真实动作一个都不能少
    expect(steps.filter((step) => step.type === 'click')).toHaveLength(26);
    // 总步数必须落在校验器允许的范围内，否则用户认真录一遍却存不下
    expect(steps.length).toBeLessThanOrEqual(30);

    // 全部动作必须能过保存前校验（route/steps 上限）
    expect(validateCheckinWorkflow(siteWithClaim, learned!.workflow)).toEqual([]);
  });

  it('保留了被「登录」字样误伤的普通站点步骤（内嵌 href 与独立选择器都算）', () => {
    const learned = buildLearnedWorkflow(siteWithClaim, [
      { type: 'navigation', path: '/console', at: 1 },
      // 老实现看到 label 含「登录」就整条丢，但这是站点里真实的入口按钮
      { type: 'click', selector: '#open-entry', label: '登录后进入控制台', path: '/console', at: 2 },
      { type: 'click', selector: 'button.claim', label: '立即签到', path: '/check-in', at: 3 },
    ]);

    expect(learned!.workflow.steps).toContainEqual({ type: 'click', selector: 'button.claim' });
    expect(flattenSteps(learned!.workflow.steps).map(stepShape)).toEqual([
      'click #open-entry',
      'click button.claim',
      'if text',
    ]);

    // 真正指向认证页的点击仍然不学
    const withAuth = buildLearnedWorkflow(siteWithClaim, [
      { type: 'click', selector: 'a', label: '去登录', path: '/login', href: 'https://example.com/login', at: 1 },
      { type: 'click', selector: 'button.claim', label: '立即签到', path: '/check-in', at: 2 },
    ]);
    expect(flattenSteps(withAuth!.workflow.steps).map(stepShape)).toEqual([
      'click button.claim',
      'if text',
    ]);
  });
});

describe('buildLearnedLoginSettings', () => {
  it('把同源登录演示转换为字段选择器与受限按钮选择器', async () => {
    const module = await import('@/automation/learning/learning') as unknown as {
      buildLearnedLoginSettings?: (target: SiteConfig, events: WorkflowLearningEvent[]) => unknown;
    };
    const build = module.buildLearnedLoginSettings;
    expect(build).toBeTypeOf('function');
    if (!build) return;

    const events: WorkflowLearningEvent[] = [
      { type: 'click', selector: '#open-login', label: '使用账号密码登录', path: '/login', loginAction: 'entry', at: 1 },
      { type: 'fill', selector: '#account-field', label: '账号', path: '/login', fieldRole: 'username', hasValue: true, at: 2 },
      { type: 'fill', selector: '#password-field', label: '', path: '/login', fieldRole: 'password', hasValue: true, at: 3 },
      { type: 'click', selector: '#sign-in', label: '登录', path: '/login', loginAction: 'submit', at: 4 },
    ];

    expect(build(site, events)).toEqual({
      loginMethod: 'form',
      selectors: { username: '#account-field', password: '#password-field', submit: '#sign-in' },
      preLoginClickSelector: '#open-login',
    });
  });

  it('把仅 OAuth 的演示转换为 OAuth 登录方式和同源按钮选择器', async () => {
    const module = await import('@/automation/learning/learning') as unknown as {
      buildLearnedLoginSettings?: (target: SiteConfig, events: WorkflowLearningEvent[]) => unknown;
    };
    const build = module.buildLearnedLoginSettings;
    expect(build).toBeTypeOf('function');
    if (!build) return;

    expect(build(site, [
      { type: 'click', selector: '#github-login', label: '使用 GitHub 登录', path: '/login', loginAction: 'oauth', at: 1 },
    ])).toEqual({
      loginMethod: 'oauth',
      oauthButtonSelector: '#github-login',
    });
  });

  it('不接受跨站凭据字段、不完整表单或 OTP 按钮作为登录配置', async () => {
    const module = await import('@/automation/learning/learning') as unknown as {
      buildLearnedLoginSettings?: (target: SiteConfig, events: WorkflowLearningEvent[]) => unknown;
    };
    const build = module.buildLearnedLoginSettings;
    expect(build).toBeTypeOf('function');
    if (!build) return;

    const events: WorkflowLearningEvent[] = [
      { type: 'fill', selector: '#user', label: '', path: 'https://attacker.invalid/login', fieldRole: 'username', hasValue: true, at: 1 },
      { type: 'fill', selector: '#otp', label: '', path: '/login', hasValue: true, at: 2 },
      { type: 'click', selector: '#verify', label: '验证', path: '/login', loginAction: 'submit', at: 3 },
    ];

    expect(build(site, events)).toBeNull();
  });
});

/**
 * 采集层回归：用户要求「我要学习每一步，包括我点击什么、界面出现了什么、我跳到了哪个网站」。
 * 这里直接驱动真实 DOM 事件，断言采集对象本身（而不是编译结果）。
 */
describe('录制采集输入与页面变化', () => {
  /** 让 jsdom 里所有元素都算可见 —— 否则采集会把控件全跳过。 */
  function stubLayout(): void {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 100, height: 30, top: 0, left: 0, right: 100, bottom: 30, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    Object.defineProperty(HTMLElement.prototype, 'innerText', {
      configurable: true,
      get(this: HTMLElement) { return this.textContent ?? ''; },
    });
  }

  beforeEach(() => {
    stubLayout();
    document.body.innerHTML = '';
    window.history.replaceState({}, '', '/checkin');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  /** 用受控的 settleMs / scrollStopMs 替代真实等待，并手动结算挂起的检查。 */
  function startCapture(settleMs = 0, scrollStopMs = 0) {
    const events: WorkflowLearningEvent[] = [];
    const capture = new LearningCapture({ settleMs, scrollStopMs, onEvent: (event) => events.push(event) });
    return { events, capture };
  }

  it('上报输入步骤，且上报对象里不含任何输入文本', () => {
    document.body.innerHTML = '<input id="reason" name="reason" aria-label="领取理由">';
    const { events, capture } = startCapture();
    capture.attach();

    const input = document.querySelector<HTMLInputElement>('#reason')!;
    input.value = '我的领取理由-勿泄露';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    capture.flushPending();

    const fills = events.filter((event) => event.type === 'fill');
    expect(fills.length).toBeGreaterThan(0);
    expect(fills[0]).toMatchObject({
      selector: '#reason',
      label: '领取理由',
      path: '/checkin',
      hasValue: true,
    });

    // 脱敏硬断言：录制产出的 JSON 里不能出现输入值本身
    const json = JSON.stringify(events);
    expect(json).not.toContain('我的领取理由');
    expect(json).not.toContain('勿泄露');
    // 输入步骤最终只编译成一步（即时上报 + 结算上报是同一个动作）
    const learned = buildLearnedWorkflow(site, events);
    expect(learned!.workflow.steps.filter((step) => step.type === 'fill')).toHaveLength(1);
    capture.detach();
  });

  it('登录学习可记录用户名和密码选择器，但不采集任何输入值', () => {
    document.body.innerHTML = [
      '<input id="username" name="username" autocomplete="username">',
      '<input id="password" name="password" type="password" autocomplete="current-password">',
      '<button id="submit" type="submit">登录</button>',
    ].join('');
    const events: WorkflowLearningEvent[] = [];
    const capture = new LearningCapture({
      settleMs: 0,
      onEvent: (event) => events.push(event),
      kind: 'login',
    } as ConstructorParameters<typeof LearningCapture>[0] & { kind: 'login' });
    capture.attach();

    const username = document.querySelector<HTMLInputElement>('#username')!;
    username.value = 'login-user-sentinel@example.test';
    username.dispatchEvent(new Event('input', { bubbles: true }));
    const password = document.querySelector<HTMLInputElement>('#password')!;
    password.value = 'login-password-sentinel';
    password.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector<HTMLButtonElement>('#submit')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, composed: true }),
    );
    capture.flushPending();

    const fills = events.filter((event) => event.type === 'fill');
    expect(fills).toEqual(expect.arrayContaining([
      expect.objectContaining({ selector: '#username', fieldRole: 'username', hasValue: true }),
      expect.objectContaining({ selector: '#password', fieldRole: 'password', hasValue: true }),
    ]));
    expect(events).toContainEqual(expect.objectContaining({ selector: '#submit', loginAction: 'submit' }));
    expect(JSON.stringify(events)).not.toContain('login-user-sentinel');
    expect(JSON.stringify(events)).not.toContain('login-password-sentinel');
    capture.detach();
  });

  it('登录学习不会把验证码或一次性验证码当成凭据字段', () => {
    document.body.innerHTML = '<input id="otp" name="otp" autocomplete="one-time-code">';
    const events: WorkflowLearningEvent[] = [];
    const capture = new LearningCapture({
      settleMs: 0,
      onEvent: (event) => events.push(event),
      kind: 'login',
    } as ConstructorParameters<typeof LearningCapture>[0] & { kind: 'login' });
    capture.attach();

    const otp = document.querySelector<HTMLInputElement>('#otp')!;
    otp.value = '123456';
    otp.dispatchEvent(new Event('input', { bubbles: true }));
    capture.flushPending();

    expect(events.filter((event) => event.type === 'fill')).toEqual([]);
    expect(JSON.stringify(events)).not.toContain('123456');
    capture.detach();
  });

  it('密码字段只留凭据语义、验证码字段完全不采集，且都进不了签到流程', () => {
    document.body.innerHTML = [
      '<input id="pass" type="password" name="password">',
      '<input id="code" name="code" autocomplete="one-time-code">',
      '<textarea id="content" name="content"></textarea>',
    ].join('');
    const { events, capture } = startCapture();
    capture.attach();

    for (const selector of ['#pass', '#code']) {
      const field = document.querySelector<HTMLInputElement>(selector)!;
      field.value = 'p@ssw0rd-123456';
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const area = document.querySelector<HTMLTextAreaElement>('#content')!;
    area.value = '正常理由';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    capture.flushPending();

    const fills = events.filter((event) => event.type === 'fill');
    expect(fills.length).toBeGreaterThan(0);
    /**
     * 融合学习（默认档位）的契约：
     * - 验证码字段一个事件都不产生（连"出现过"的布尔都不在这里暴露）；
     * - 密码字段只留下 fieldRole 语义（登录编译器要用），**没有任何输入值**；
     * - 普通 textarea 照旧进完整动作流。
     */
    expect(fills.some((event) => (event as { selector?: string }).selector === '#code')).toBe(false);
    expect(fills).toContainEqual(expect.objectContaining({
      selector: '#pass',
      fieldRole: 'password',
      hasValue: true,
    }));
    expect(fills.every((event) => (
      (event as { selector: string }).selector === '#content'
      || (event as { fieldRole?: string }).fieldRole === 'password'
    ))).toBe(true);
    expect(JSON.stringify(events)).not.toContain('p@ssw0rd');
    // 输入值绝不落盘；选择器与角色是允许的（登录配置要用）
    expect(JSON.stringify(events)).not.toContain('p@ssw0rd-123456');
    // 只有普通 textarea 被编译成签到步骤；密码语义不进签到流程
    const steps = buildLearnedWorkflow(site, events)!.workflow.steps.filter((step) => step.type === 'fill');
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ selector: '#content' });
    capture.detach();
  });

  it('动作之后新出现的文字被采集成界面变化证据，且限长限量', () => {
    document.body.innerHTML = '<button id="claim">立即签到</button>';
    const { events, capture } = startCapture();
    capture.attach();

    // 用户点击后页面异步渲染出结果（含一条超长的假正文，必须被丢掉）
    document.querySelector<HTMLButtonElement>('#claim')!.addEventListener('click', () => {
      const box = document.createElement('div');
      box.innerHTML = `<span>签到成功</span><span>${'很长的页面正文'.repeat(30)}</span>`;
      document.body.appendChild(box);
    });
    document.querySelector<HTMLButtonElement>('#claim')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, composed: true }),
    );
    capture.flushPending();

    const withChange = events.filter((event) => (
      (event as { afterText?: string[] }).afterText?.length
    )) as Array<{ afterText?: string[] }>;
    expect(withChange).toHaveLength(1);
    const after = withChange[0]!.afterText!;
    expect(after).toContain('签到成功');
    expect(after.every((item) => item.length <= 60)).toBe(true);
    expect(after.length).toBeLessThanOrEqual(6);
    // 普通正文（不含关键词、超长）不该被写成证据
    expect(JSON.stringify(after)).not.toContain('很长的页面正文很长的页面正文很长的页面正文很长的页面正文');
    capture.detach();
  });

  it('两种上报合并成一个动作：点击补报的界面变化不会变成第二步', () => {
    document.body.innerHTML = '<button id="claim">立即签到</button>';
    const { events, capture } = startCapture();
    capture.attach();
    // 点击后页面出现新文字，采集器会补报一次「界面出现了什么」
    document.querySelector<HTMLButtonElement>('#claim')!.addEventListener('click', () => {
      const box = document.createElement('div');
      box.innerHTML = '<span>签到成功</span>';
      document.body.appendChild(box);
    });
    document.querySelector<HTMLButtonElement>('#claim')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, composed: true }),
    );
    capture.flushPending();
    capture.detach();

    const clicks = events.filter((event) => event.type === 'click');
    expect(clicks.length).toBeGreaterThan(1);
    expect((clicks[1] as { afterText?: string[] }).afterText).toContain('签到成功');
    // 上报里有重复，但编译后必须只有一步
    const learned = buildLearnedWorkflow(site, events);
    expect(learned!.workflow.steps.filter((step) => step.type === 'click')).toHaveLength(1);
  });

  it('停止录制后不再上报，晚到的定时器也不会补充进已结束的会话', async () => {
    document.body.innerHTML = '<button id="claim">立即签到</button>';
    const { events, capture } = startCapture(5);
    capture.attach();
    document.querySelector<HTMLButtonElement>('#claim')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, composed: true }),
    );
    capture.detach();
    const afterStop = events.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events.length).toBe(afterStop);
  });

  it('完整一遍真实操作：点击 → 界面出现文字 → 跳转，全部按顺序采到', () => {
    document.body.innerHTML = '<button id="checkin-entry">每日签到</button>';
    window.history.replaceState({}, '', '/console');
    const { events, capture } = startCapture();
    capture.attach();

    // 1. 点入口
    document.querySelector<HTMLButtonElement>('#checkin-entry')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, composed: true }),
    );
    capture.flushPending();
    // 2. SPA 跳到签到页
    window.history.pushState({}, '', '/checkin');
    // 3. 填理由
    document.body.innerHTML = '<textarea id="reason" name="reason" aria-label="领取理由"></textarea><button id="submit">提交</button>';
    const area = document.querySelector<HTMLTextAreaElement>('#reason')!;
    area.value = '每日签到';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    capture.flushPending();
    // 4. 提交后出现成功提示
    document.querySelector<HTMLButtonElement>('#submit')!.addEventListener('click', () => {
      const box = document.createElement('div');
      box.innerHTML = '<span>领取成功</span>';
      document.body.appendChild(box);
    });
    document.querySelector<HTMLButtonElement>('#submit')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, composed: true }),
    );
    capture.flushPending();
    capture.detach();

    // 三问齐备：点击/输入了什么、界面出现了什么、跳到了哪个网站
    expect(events.filter((event) => event.type === 'click').length).toBeGreaterThan(0);
    expect(events.filter((event) => event.type === 'fill').length).toBeGreaterThan(0);
    expect(events.filter((event) => event.type === 'navigation').map((event) => event.path))
      .toEqual(['/console', '/checkin']);
    expect(JSON.stringify(events)).toContain('领取成功');

    // 端到端编译：动作、变化检查、路线顺序一致
    const learned = buildLearnedWorkflow(site, events)!;
    expect(learned.workflow.route?.at(-1)).toBe('/checkin');
    expect(learned.workflow.steps.length).toBeLessThanOrEqual(30);
    expect(validateCheckinWorkflow(site, learned.workflow)).toEqual([]);
  });

  it('div/span 自定义按钮（onClick、交互 role、tabindex）也会被采集，不再整段丢失', () => {
    document.body.innerHTML = [
      '<div id="by-onclick" onclick="void 0">签到</div>',
      '<span id="by-role" role="menuitem">领取</span>',
      '<div id="by-tabindex" tabindex="0">打卡</div>',
    ].join('');
    window.history.replaceState({}, '', '/checkin');
    const { events, capture } = startCapture();
    capture.attach();
    for (const id of ['by-onclick', 'by-role', 'by-tabindex']) {
      document.getElementById(id)!.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    }
    capture.flushPending();
    capture.detach();
    const clickSelectors = events.filter((event) => event.type === 'click').map((event) => (event as { selector: string }).selector);
    expect(clickSelectors).toContain('#by-onclick');
    expect(clickSelectors).toContain('#by-role');
    expect(clickSelectors).toContain('#by-tabindex');
  });

  it('点击自定义按钮内部的子元素时，选择器仍指向可点击的祖先', () => {
    document.body.innerHTML = '<div id="card" onclick="void 0"><span id="icon">✓</span><span>立即签到</span></div>';
    window.history.replaceState({}, '', '/checkin');
    const { events, capture } = startCapture();
    capture.attach();
    document.getElementById('icon')!.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    capture.flushPending();
    capture.detach();
    const click = events.find((event) => event.type === 'click') as { selector: string } | undefined;
    expect(click).toBeDefined();
    // 子 span 没有交互标记，向上取到带 onclick 的 #card。
    expect(queryFirst(click!.selector)?.id).toBe('card');
  });

  it('语义可点控件优先于带 onClick 的父容器', () => {
    document.body.innerHTML = '<div id="wrap" onclick="void 0"><button id="real">签到</button></div>';
    window.history.replaceState({}, '', '/checkin');
    const { events, capture } = startCapture();
    capture.attach();
    document.getElementById('real')!.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    capture.flushPending();
    capture.detach();
    const click = events.find((event) => event.type === 'click') as { selector: string } | undefined;
    expect(click!.selector).toBe('#real');
  });

  it('纯展示元素（无任何交互标记）点击仍不采集，避免噪声', () => {
    document.body.innerHTML = '<p id="plain">这是一段说明文字</p>';
    window.history.replaceState({}, '', '/checkin');
    const { events, capture } = startCapture();
    capture.attach();
    document.getElementById('plain')!.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    capture.flushPending();
    capture.detach();
    expect(events.filter((event) => event.type === 'click')).toHaveLength(0);
  });

  it('contenteditable 富文本框按 fill 采集，且绝不保存输入内容', () => {
    document.body.innerHTML = '<div id="editor" contenteditable="true" aria-label="领取理由"></div>';
    window.history.replaceState({}, '', '/checkin');
    const { events, capture } = startCapture();
    capture.attach();
    const editor = document.getElementById('editor')!;
    editor.textContent = '我的私密理由-勿泄露';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    capture.flushPending();
    capture.detach();
    const fills = events.filter((event) => event.type === 'fill');
    expect(fills.length).toBeGreaterThan(0);
    expect((fills[0] as { hasValue: boolean }).hasValue).toBe(true);
    // 脱敏硬断言：contenteditable 的正文同样不能出现在录制里。
    expect(JSON.stringify(events)).not.toContain('私密理由');
    expect(JSON.stringify(events)).not.toContain('勿泄露');
    // 编译成 fill 步骤，占位符仍是 {{claimText}}，由站点配置提供实际文本。
    const learned = buildLearnedWorkflow(site, events)!;
    const fillStep = learned.workflow.steps.find((step) => step.type === 'fill');
    expect(fillStep && fillStep.type === 'fill' ? fillStep.value : '').toBe('{{claimText}}');
  });
});

/**
 * 拖拽（滑块验证的核心手势）在松手时会由浏览器补发一次 click：
 * 按下与松开落在同一元素（或其后代）上时，click 会落在两者的公共祖先上。
 * 那不是用户的「点击」，录进工作流只会在回放时报「找不到可点击元素」。
 */
describe('学习录制不把拖拽尾巴当成点击', () => {
  /** 让 jsdom 里所有元素都算可见 —— 否则采集会把控件全跳过。 */
  function stubLayout(): void {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 100, height: 30, top: 0, left: 0, right: 100, bottom: 30, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    Object.defineProperty(HTMLElement.prototype, 'innerText', {
      configurable: true,
      get(this: HTMLElement) { return this.textContent ?? ''; },
    });
  }

  beforeEach(() => {
    stubLayout();
    document.body.innerHTML = '';
    window.history.replaceState({}, '', '/checkin');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  function startCapture() {
    const events: WorkflowLearningEvent[] = [];
    const capture = new LearningCapture({ settleMs: 0, scrollStopMs: 0, onEvent: (event) => events.push(event) });
    return { events, capture };
  }

  /** 一次完整的拖拽：按下 → 大幅移动 → 松开 → 浏览器补发 click。 */
  function dragHandle(handle: Element): void {
    handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true, clientX: 20, clientY: 40 }));
    handle.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, composed: true, clientX: 140, clientY: 40 }));
    handle.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true, clientX: 140, clientY: 40 }));
    handle.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, clientX: 140, clientY: 40 }));
  }

  /**
   * 真实浏览器（桌面 Chrome 实测）的一整条指针序列：pointer 族与 mouse 族**成对**派发，
   * 松手后浏览器再补发一次 click。与只用 mouse 族的 `dragHandle` 不同，这里复现了
   * 「pointerup 与 mouseup 都会到达监听器」的真实组合 —— 双 up 事件覆盖裁定的缺陷
   * 恰好只在这种组合下暴露。位移达到阈值即拖拽，否则是一次普通点击。
   */
  function dispatchBrowserGesture(target: Element, from: { x: number; y: number }, to: { x: number; y: number }): void {
    const init = { bubbles: true, composed: true };
    target.dispatchEvent(new PointerEvent('pointerdown', { ...init, clientX: from.x, clientY: from.y }));
    target.dispatchEvent(new MouseEvent('mousedown', { ...init, clientX: from.x, clientY: from.y }));
    target.dispatchEvent(new PointerEvent('pointermove', { ...init, clientX: to.x, clientY: to.y }));
    target.dispatchEvent(new MouseEvent('mousemove', { ...init, clientX: to.x, clientY: to.y }));
    target.dispatchEvent(new PointerEvent('pointerup', { ...init, clientX: to.x, clientY: to.y }));
    target.dispatchEvent(new MouseEvent('mouseup', { ...init, clientX: to.x, clientY: to.y }));
    target.dispatchEvent(new MouseEvent('click', { ...init, clientX: to.x, clientY: to.y }));
  }

  it('拖完把手松手补发的合成 click 被整条过滤（不录成步骤）', () => {
    document.body.innerHTML = '<div id="knob" role="slider" tabindex="0">→</div>';
    const { events, capture } = startCapture();
    capture.attach();

    dragHandle(document.getElementById('knob')!);
    capture.flushPending();
    capture.detach();

    /*
     * 期望是「一步都不录」，而不是「录成拖拽一步」。
     *
     * 依据项目既有契约（tests/e2e/learned-flow.mjs 的 fixture 断言）：拖拽把手是**噪声**，
     * 真实拖拽松手后浏览器补发的合成 click 落点仍在把手上，把它录成任何步骤都会让回放
     * 去操作把手本身，而把手通常不是签到控件 —— 实测产物里出现 `#pull-knob` 步骤、
     * 真正的签到按钮反被挤掉，签到卡住。宁可少录一步，也不把噪声写进流程。
     */
    const clicks = events.filter((event) => event.type === 'click');
    expect(clicks).toHaveLength(0);
  });

  it('拖拽之后紧接着的真实点击不受影响（尾巴被消费掉，不误伤下一次点击）', () => {
    document.body.innerHTML = [
      '<div id="knob" role="slider" tabindex="0">→</div>',
      '<button id="claim" type="button">立即签到</button>',
    ].join('');
    const { events, capture } = startCapture();
    capture.attach();

    dragHandle(document.getElementById('knob')!);
    const claim = document.getElementById('claim')!;
    claim.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true, clientX: 20, clientY: 80 }));
    claim.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true, clientX: 20, clientY: 80 }));
    claim.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, clientX: 20, clientY: 80 }));
    capture.flushPending();
    capture.detach();

    // 只剩一条 click：拖拽尾巴被整条过滤，随后的**真实点击**照常记录。
    // 这条同时锁定「过滤没有误伤下一次点击」——那是过滤逻辑最容易写坏的地方。
    const clicks = events.filter((event) => event.type === 'click') as Array<Record<string, unknown>>;
    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toMatchObject({ type: 'click', selector: '#claim' });
    expect(clicks[0]).not.toHaveProperty('dragToSelector');
  });

  it('小幅抖动的正常点击（没拖起来）仍然会被采集', () => {
    document.body.innerHTML = '<div id="knob" role="slider" tabindex="0">→</div>';
    const { events, capture } = startCapture();
    capture.attach();

    const knob = document.getElementById('knob')!;
    knob.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true, clientX: 20, clientY: 40 }));
    knob.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true, clientX: 24, clientY: 43 }));
    knob.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, clientX: 24, clientY: 43 }));
    capture.flushPending();
    capture.detach();

    expect(events.filter((event) => event.type === 'click')).toHaveLength(1);
  });

  it('真实双族序列的拖拽（pointerup 与 mouseup 成对到达）尾巴 click 被过滤', () => {
    document.body.innerHTML = '<div id="knob" role="slider" tabindex="0">→</div>';
    const { events, capture } = startCapture();
    capture.attach();

    /*
     * 真实浏览器顺序：pointerdown→mousedown→pointermove→mousemove→pointerup→mouseup→click。
     *
     * pointerup 与 mouseup 是**两族**事件，两族都会到达监听器。旧实现两族共用一个
     * 按下点槽位：pointerup 先消费并清空，mouseup 到达时拿到 null 直接返回，于是
     * 「这次是拖拽」的裁定丢失/被后续覆盖 —— 松手补发的 click 被当成普通点击录进流程。
     * 本用例锁定修复后的行为：两族各自的按下点分别保存，任一族判定为拖拽即过滤。
     */
    dispatchBrowserGesture(document.getElementById('knob')!, { x: 20, y: 40 }, { x: 140, y: 40 });
    capture.flushPending();
    capture.detach();

    const clicks = events.filter((event) => event.type === 'click');
    expect(clicks).toHaveLength(0);
  });

  it('真实双族序列的普通点击（无位移）恰好采集一条，命中 #claim', () => {
    document.body.innerHTML = '<button id="claim" type="button">立即签到</button>';
    const { events, capture } = startCapture();
    capture.attach();

    // 同样的双族序列、坐标不变：这是一次真实点击，修复不得误伤它。
    dispatchBrowserGesture(document.getElementById('claim')!, { x: 20, y: 40 }, { x: 20, y: 40 });
    capture.flushPending();
    capture.detach();

    const clicks = events.filter((event) => event.type === 'click');
    expect(clicks).toHaveLength(1);
    expect((clicks[0] as { selector: string }).selector).toBe('#claim');
  });

  it('纯 pointer 族的拖拽（触摸环境无 mouse 兼容事件）尾巴 click 也被过滤', () => {
    document.body.innerHTML = '<div id="knob" role="slider" tabindex="0">→</div>';
    const { events, capture } = startCapture();
    capture.attach();

    // 触摸场景：只有 pointer 族事件，click 始终是 MouseEvent（浏览器规范如此）。
    const knob = document.getElementById('knob')!;
    const init = { bubbles: true, composed: true };
    knob.dispatchEvent(new PointerEvent('pointerdown', { ...init, clientX: 20, clientY: 40 }));
    knob.dispatchEvent(new PointerEvent('pointermove', { ...init, clientX: 140, clientY: 40 }));
    knob.dispatchEvent(new PointerEvent('pointerup', { ...init, clientX: 140, clientY: 40 }));
    knob.dispatchEvent(new MouseEvent('click', { ...init, clientX: 140, clientY: 40 }));
    capture.flushPending();
    capture.detach();

    // 触摸环境的拖拽同样整条过滤：不能因为「没有 mouse 族」就漏掉这条噪声。
    const clicks = events.filter((event) => event.type === 'click');
    expect(clicks).toHaveLength(0);
  });
});

/**
 * 「怎么点的」契约字段：落点、手势、键盘、长按、拖拽终点、指纹。
 *
 * 用户反馈「学习没有真实学到我的每一步操作，比如我滑动到哪里、点击了哪里，
 * 太死板了」。这组测试把「点击不只是 selector」固化成断言：落点是元素内相对
 * 比例（不是坐标原文）、手势分双击/右键/长按、键盘只记非打印功能键、指纹只含
 * 稳定的可见/语义特征。
 */
describe('学习采集点击的落点、手势、键盘与指纹', () => {
  function stubLayout(): void {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 200, height: 40, top: 100, left: 50, right: 250, bottom: 140, x: 50, y: 100,
      toJSON: () => ({}),
    } as DOMRect);
    Object.defineProperty(HTMLElement.prototype, 'innerText', {
      configurable: true,
      get(this: HTMLElement) { return this.textContent ?? ''; },
    });
  }

  beforeEach(() => {
    stubLayout();
    document.body.innerHTML = '';
    window.history.replaceState({}, '', '/checkin');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  function startCapture() {
    const events: WorkflowLearningEvent[] = [];
    const capture = new LearningCapture({ settleMs: 0, scrollStopMs: 0, onEvent: (event) => events.push(event) });
    return { events, capture };
  }

  it('点击落点被记录成元素内相对比例（不是 clientX/clientY）', () => {
    document.body.innerHTML = '<button id="claim">立即签到</button>';
    const { events, capture } = startCapture();
    capture.attach();

    const button = document.querySelector<HTMLButtonElement>('#claim')!;
    // rect: left=50, top=100, width=200, height=40；点在 (230, 130) → rx=0.9, ry=0.75
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true, clientX: 230, clientY: 130 }));
    button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true, clientX: 230, clientY: 130 }));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, clientX: 230, clientY: 130 }));
    capture.flushPending();
    capture.detach();

    const click = events.find((event) => event.type === 'click') as Record<string, unknown> | undefined;
    expect(click).toBeDefined();
    expect(click!.anchor).toEqual({ rx: 0.9, ry: 0.75 });
    // 隐私红线：不落任何原始坐标
    expect(click).not.toHaveProperty('clientX');
    expect(click).not.toHaveProperty('clientY');
    expect(click).not.toHaveProperty('screenX');
    expect(click).not.toHaveProperty('screenY');
  });

  it('双击被识别为 gesture: double（不再只是两次单击）', () => {
    document.body.innerHTML = '<button id="claim">立即签到</button>';
    const { events, capture } = startCapture();
    capture.attach();

    const button = document.querySelector<HTMLButtonElement>('#claim')!;
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, detail: 2 }));
    capture.flushPending();
    capture.detach();

    const click = events.find((event) => event.type === 'click') as Record<string, unknown> | undefined;
    expect(click).toMatchObject({ gesture: 'double' });
  });

  it('右键通过 contextmenu 录成 gesture: right（浏览器不派发 click）', () => {
    document.body.innerHTML = '<button id="claim">立即签到</button>';
    const { events, capture } = startCapture();
    capture.attach();

    const button = document.querySelector<HTMLButtonElement>('#claim')!;
    button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, clientX: 150, clientY: 120 }));
    capture.flushPending();
    capture.detach();

    const click = events.find((event) => event.type === 'click') as Record<string, unknown> | undefined;
    expect(click).toMatchObject({ gesture: 'right', selector: '#claim' });
  });

  it('键盘 Enter 触发按钮时 key 被挂到 click 上', () => {
    document.body.innerHTML = '<button id="claim">立即签到</button>';
    const { events, capture } = startCapture();
    capture.attach();

    const button = document.querySelector<HTMLButtonElement>('#claim')!;
    // 浏览器在 button 上按 Enter 会派发合成 click：key 挂回那一下
    button.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, composed: true, key: 'Enter' }));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    capture.flushPending();
    capture.detach();

    const click = events.find((event) => event.type === 'click') as Record<string, unknown> | undefined;
    expect(click).toMatchObject({ key: 'Enter' });
  });

  it('可打印字符绝不记成按键（隐私红线）', () => {
    document.body.innerHTML = '<input id="reason" name="reason" aria-label="理由">';
    const { events, capture } = startCapture();
    capture.attach();

    const input = document.querySelector<HTMLInputElement>('#reason')!;
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, composed: true, key: 'a' }));
    input.value = 'sensitive_input_zz99';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    capture.flushPending();
    capture.detach();

    const json = JSON.stringify(events);
    expect(json).not.toContain('"key":"a"');
    expect(json).not.toContain('sensitive_input_zz99');
  });

  it('输入框里按 Enter 提交时 key 挂到 fill 上（不产生 click）', () => {
    document.body.innerHTML = '<input id="reason" name="reason" aria-label="理由">';
    const { events, capture } = startCapture();
    capture.attach();

    const input = document.querySelector<HTMLInputElement>('#reason')!;
    input.value = '每日签到';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, composed: true, key: 'Enter' }));
    capture.flushPending();
    capture.detach();

    // 结算补报（含最终 key）与即时上报是同一个动作；find 到的是第一份，用 some 断言
    const fills = events.filter((event) => event.type === 'fill') as Array<Record<string, unknown>>;
    expect(fills.some((event) => event.key === 'Enter')).toBe(true);
    // 输入值本身仍然不落盘
    expect(JSON.stringify(events)).not.toContain('每日签到');
  });

  it('指纹只含稳定的可见/语义特征；contenteditable 宿主不读正文', () => {
    document.body.innerHTML = '<div id="editor" contenteditable="true" aria-label="领取理由"></div>';
    const { events, capture } = startCapture();
    capture.attach();

    const editor = document.querySelector<HTMLElement>('#editor')!;
    editor.textContent = '用户正在输入的正文-勿泄露';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    capture.flushPending();
    capture.detach();

    const fill = events.find((event) => event.type === 'fill') as Record<string, unknown> | undefined;
    const fingerprint = fill?.fingerprint as Record<string, unknown> | undefined;
    expect(fingerprint).toBeDefined();
    expect(fingerprint).toMatchObject({ tag: 'div', aria: '领取理由' });
    // 隐私红线：contenteditable 正文绝不进指纹
    expect(JSON.stringify(fingerprint)).not.toContain('勿泄露');
    expect(fingerprint).not.toHaveProperty('text');
  });
});

/**
 * 人机验证控件（滑块 / Turnstile 等）的交互由回放侧的自动破解管线接管，
/**
 * 人机验证控件（滑块 / Turnstile 等）的交互由回放侧的自动破解管线接管，
 * 不是用户工作流的一部分：录成步骤后，回放时验证多已被自动处理、控件消失，
 * 那一步只会报「找不到可点击元素」。录制侧要「认识并跳过」它们。
 */
describe('学习录制不把人机验证控件的交互当成步骤', () => {
  /** 让 jsdom 里所有元素都算可见 —— 否则采集会把控件全跳过。 */
  function stubLayout(): void {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 100, height: 30, top: 0, left: 0, right: 100, bottom: 30, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    Object.defineProperty(HTMLElement.prototype, 'innerText', {
      configurable: true,
      get(this: HTMLElement) { return this.textContent ?? ''; },
    });
  }

  beforeEach(() => {
    stubLayout();
    document.body.innerHTML = '';
    window.history.replaceState({}, '', '/checkin');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  function startCapture() {
    const events: WorkflowLearningEvent[] = [];
    const capture = new LearningCapture({ settleMs: 0, scrollStopMs: 0, onEvent: (event) => events.push(event) });
    return { events, capture };
  }

  /** 原地点击（按下与松开位移为零）：验证过滤单独生效，不与拖拽过滤混淆。 */
  function plainClick(element: Element): void {
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true, clientX: 20, clientY: 40 }));
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true, clientX: 20, clientY: 40 }));
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, clientX: 20, clientY: 40 }));
  }

  it('点击滑块验证控件（极验面板里的把手）不会被采集', () => {
    document.body.innerHTML = [
      '<div class="geetest_panel">',
      '  <div id="gt-handle" class="geetest_slider_button" tabindex="0">→</div>',
      '</div>',
    ].join('');
    const { events, capture } = startCapture();
    capture.attach();

    plainClick(document.getElementById('gt-handle')!);
    capture.flushPending();
    capture.detach();

    expect(events.filter((event) => event.type === 'click')).toHaveLength(0);
  });

  it('点击 Turnstile 验证框（含内部按钮）不会被采集', () => {
    document.body.innerHTML = '<div class="cf-turnstile"><button id="ts" type="button">Verify</button></div>';
    const { events, capture } = startCapture();
    capture.attach();

    plainClick(document.getElementById('ts')!);
    capture.flushPending();
    capture.detach();

    expect(events.filter((event) => event.type === 'click')).toHaveLength(0);
  });

  it('普通签到按钮不受人机验证过滤影响', () => {
    document.body.innerHTML = '<button id="checkin" type="button">立即签到</button>';
    const { events, capture } = startCapture();
    capture.attach();

    plainClick(document.getElementById('checkin')!);
    capture.flushPending();
    capture.detach();

    const clicks = events.filter((event) => event.type === 'click');
    expect(clicks).toHaveLength(1);
    expect((clicks[0] as { selector: string }).selector).toBe('#checkin');
  });
});

describe('学习会话的生命周期', () => {
  /** 构造一个 storage 条目形状的会话。 */
  function entry(overrides: Partial<Record<string, unknown>> = {}): [string, unknown] {
    const session = {
      runId: 'learn-1',
      accountId: 'acc-1',
      siteId: 'site-1',
      tabId: 7,
      createdAt: 1_000,
      events: [{ type: 'navigation', path: '/check-in', at: 1 }],
      ...overrides,
    };
    return [`learn:${session.tabId}`, session];
  }

  it('超过 TTL 的会话被判定为过期，且不再出现在在录列表里', () => {
    const now = 1_000 + LEARNING_TTL_MS + 1;
    const { active, expired } = partitionLearningSessions([entry()], now);

    expect(active).toEqual([]);
    expect(expired).toHaveLength(1);
    expect(expired[0]!.tabId).toBe(7);
  });

  it('TTL 之内的会话行为完全不变（仍在录）', () => {
    const notYet = 1_000 + LEARNING_TTL_MS - 1;
    expect(partitionLearningSessions([entry()], notYet).active).toHaveLength(1);
    expect(partitionLearningSessions([entry()], notYet).expired).toEqual([]);
    // 边界：刚好等于 TTL 时不算过期
    expect(partitionLearningSessions([entry()], 1_000 + LEARNING_TTL_MS).active).toHaveLength(1);
  });

  it('过期会话不再累积任何事件', () => {
    const learning = {
      runId: 'learn-1',
      accountId: 'acc-1',
      siteId: 'site-1',
      tabId: 7,
      createdAt: 1_000,
      events: [],
    };
    const stale = appendLearningEvent(
      learning,
      { type: 'click', selector: '#x', label: '签到', path: '/check-in', at: 1 },
      1_000 + LEARNING_TTL_MS + 1,
    );
    expect(stale.ok).toBe(false);
    expect(stale).toMatchObject({ expired: true });

    // 未过期的会话照常累积
    const fresh = appendLearningEvent(
      learning,
      { type: 'click', selector: '#x', label: '签到', path: '/check-in', at: 1 },
      1_000 + 60_000,
    );
    expect(fresh.ok).toBe(true);
    expect(fresh.ok && fresh.learning.events).toHaveLength(1);
  });

  it('清理是幂等的：没有会话、会话已过期、会话正常三种情况都不会互相污染', () => {
    expect(partitionLearningSessions([], 1_000)).toEqual({ active: [], expired: [] });
    // 损坏条目（缺 createdAt / 非对象）直接跳过，不报错也不进任何一侧
    expect(partitionLearningSessions([
      ['learn:1', { runId: 'x', accountId: 'y' }],
      ['learn:2', null],
      ['other:3', entry()[1]],
    ], 1_000)).toEqual({ active: [], expired: [] });
    // 重复调用结果一致
    const first = partitionLearningSessions([entry()], 1_000 + LEARNING_TTL_MS + 1);
    const second = partitionLearningSessions([entry()], 1_000 + LEARNING_TTL_MS + 1);
    expect(second).toEqual(first);
  });
});

/**
 * 融合学习：一次演示同时产出两份产物。
 *
 * 这里锁的是「一次学习 = 登录配置 + 签到流程」的编译合同：
 * 同一份事件流既含凭据语义（fieldRole / loginAction），也含登录之后的真实动作；
 * 两个编译器各自只挑自己的语义，谁也不吞掉谁。
 */
describe('buildLearnedArtifacts：一次演示、两份产物', () => {
  const fusionSite: SiteConfig = {
    id: 'fusion',
    name: '融合学习站',
    loginUrl: 'https://example.com/login',
    selectors: { username: '#u', password: '#p', submit: '#s' },
    closeModalSelectors: [],
  };

  /** 一遍完整的融合演示：登录页填账密提交 → 控制台 → 资料页 → 签到页点签到。 */
  const fusedEvents: WorkflowLearningEvent[] = [
    { type: 'navigation', path: '/login', at: 1 },
    { type: 'fill', selector: '#username', label: '用户名', path: '/login', fieldRole: 'username', hasValue: true, at: 2 },
    { type: 'fill', selector: '#password', label: '密码', path: '/login', fieldRole: 'password', hasValue: true, at: 3 },
    { type: 'click', selector: '#login-submit', label: '登录', path: '/login', loginAction: 'submit', at: 4 },
    { type: 'navigation', path: '/console', at: 5 },
    { type: 'navigation', path: '/profile', at: 6 },
    { type: 'click', selector: '#nav-checkin', label: '去签到', path: '/profile', href: 'https://example.com/checkin', at: 7 },
    { type: 'navigation', path: '/checkin', at: 8 },
    { type: 'click', selector: '#claim', label: '立即签到', path: '/checkin', at: 9, evidence: { kind: 'success', words: ['签到成功'] } },
  ];

  it('完整演示之后同时产出登录配置与签到流程', () => {
    const artifacts = buildLearnedArtifacts(fusionSite, fusedEvents, 'both');

    expect(artifacts.login).toEqual({
      loginMethod: 'form',
      selectors: { username: '#username', password: '#password', submit: '#login-submit' },
    });
    expect(artifacts.checkin).not.toBeNull();
    expect(artifacts.checkin!.kind).toBe('workflow');
    const workflow = artifacts.checkin!.kind === 'workflow' ? artifacts.checkin!.workflow : null;
    expect(workflow?.route).toEqual(['/console', '/profile', '/checkin']);
    expect(workflow?.identityPath).toBe('/profile');
    expect(artifacts.eventCount).toBe(fusedEvents.length);
    expect(artifacts.notices).toEqual([]);
  });

  it('签到流程不含任何账密字段或登录提交动作（两份产物互不污染）', () => {
    const artifacts = buildLearnedArtifacts(fusionSite, fusedEvents, 'both');
    const serialized = JSON.stringify(artifacts.checkin);
    expect(serialized).not.toContain('#username');
    expect(serialized).not.toContain('#password');
    expect(serialized).not.toContain('#login-submit');
  });

  it('只完成登录时如实只给登录配置，并提示重新演示签到', () => {
    const loginOnly = fusedEvents.filter((event) => event.at <= 4);
    const artifacts = buildLearnedArtifacts(fusionSite, loginOnly, 'both');

    expect(artifacts.login?.loginMethod).toBe('form');
    expect(artifacts.checkin).toBeNull();
    expect(artifacts.notices.join('\n')).toContain('只保存登录配置');
    expect(artifacts.notices.join('\n')).toContain('重新演示');
  });

  it('只录到签到（本来就在登录态）时只给签到流程，并提示没有登录配置', () => {
    const checkinOnly = fusedEvents.filter((event) => event.at >= 5);
    const artifacts = buildLearnedArtifacts(fusionSite, checkinOnly, 'both');

    expect(artifacts.login).toBeNull();
    expect(artifacts.checkin).not.toBeNull();
    expect(artifacts.notices.join('\n')).toContain('只保存签到流程');
  });

  it('旧的 login 意图保持原样：只产出登录配置、不写签到流程', () => {
    const artifacts = buildLearnedArtifacts(fusionSite, fusedEvents, 'login');
    expect(artifacts.login?.loginMethod).toBe('form');
    expect(artifacts.checkin).toBeNull();
    // login 意图不该被「没录到签到」打扰
    expect(artifacts.notices).toEqual([]);
  });

  it('旧调用方只发 checkin 时同样拿到两份产物（向后兼容的关键）', () => {
    const artifacts = buildLearnedArtifacts(fusionSite, fusedEvents, 'checkin');
    expect(artifacts.login?.loginMethod).toBe('form');
    expect(artifacts.checkin).not.toBeNull();
  });

  /**
   * 真实缺陷（2026-10-08）：点「开始学习」后什么都没做就点「结束学习」。
   * 当时两份产物都是 null，而提示是按「缺了哪一半」拼的 —— 它会说
   * 「……这次只保存签到流程」，可签到流程同样没录到，句子自相矛盾；
   * 接着还会拿空的登录补丁去写站点配置，站点校验器抛出
   * 「缺少用户名输入框选择器」，成了用户看到的失败原因。
   */
  it('空演示（一份都没录到）给出的提示必须描述本次观测结果，且不含站点校验器的措辞', () => {
    const artifacts = buildLearnedArtifacts(fusionSite, [], 'both');

    expect(artifacts.login).toBeNull();
    expect(artifacts.checkin).toBeNull();
    const text = artifacts.notices.join('\n');
    expect(text).toContain('还没有录到');
    expect(text).toContain('任何登录或签到动作');
    // 不能撒谎说「只保存签到流程」（那份也没录到），也不能泄漏实现细节。
    expect(text).not.toContain('只保存签到流程');
    expect(text).not.toContain('只保存登录配置');
    expect(text).not.toContain('选择器');
  });

  it('空演示只带导航事件（页面自己跳转）时仍判为空演示', () => {
    const artifacts = buildLearnedArtifacts(fusionSite, [
      { type: 'navigation', path: '/login', at: 1 },
    ], 'both');

    expect(artifacts.login).toBeNull();
    expect(artifacts.checkin).toBeNull();
    expect(artifacts.notices.join('\n')).toContain('还没有录到');
  });

  it('开始学习时已在站内页、没有签到动作时，提示登录即签到的保存出口', () => {
    const artifacts = buildLearnedArtifacts(fusionSite, [
      { type: 'navigation', path: '/dashboard/overview', at: 1 },
      {
        type: 'click',
        selector: 'text=个人资料',
        label: '个人资料',
        path: '/dashboard/overview',
        at: 2,
      },
    ], 'both');

    expect(artifacts.login).toBeNull();
    expect(artifacts.checkin).toBeNull();
    const text = artifacts.notices.join('\n');
    expect(text).toContain('登录即签到');
    expect(text).toContain('不需要重新开始');
    expect(text).not.toContain('只保存签到流程');
  });
});

describe('同一站点同一时刻只能有一条签到学习会话', () => {
  const session = (overrides: Partial<WorkflowLearningSession> = {}): WorkflowLearningSession => ({
    runId: 'learn-a',
    accountId: 'acc-1',
    siteId: 'site-x',
    tabId: 7,
    createdAt: 1_000,
    events: [],
    ...overrides,
  });

  it('同站已有另一账号在学习签到：第二个账号必须被拒绝', () => {
    const existing = session({ runId: 'learn-a', accountId: 'acc-1', siteId: 'site-x' });
    const conflict = findConflictingLearningSession([existing], {
      accountId: 'acc-2',
      siteId: 'site-x',
      kind: 'checkin',
    });

    expect(conflict).toEqual(existing);
  });

  it('同账号继续/结束学习、不同站点不冲突', () => {
    const existing = session({
      runId: 'learn-a',
      accountId: 'acc-1',
      siteId: 'site-x',
      kind: 'checkin',
    });

    expect(findConflictingLearningSession([existing], {
      accountId: 'acc-1',
      siteId: 'site-x',
      kind: 'checkin',
    })).toBeNull();
    expect(findConflictingLearningSession([existing], {
      accountId: 'acc-2',
      siteId: 'site-y',
      kind: 'checkin',
    })).toBeNull();
  });

  it('融合学习之后同站不再按 kind 区分：* 异账号、不同 kind 也一样冲突', () => {
    /**
     * 一次演示同时产出登录配置与签到流程，两者都是站点级唯一事实。
     * 若还按 kind 放行，A 账号演示登录时 B 账号可以同时演示签到，两条录制互相污染
     * 登录态，最终两条产物与谁演示的都对不上。
     */
    const existing = session({
      runId: 'learn-a',
      accountId: 'acc-1',
      siteId: 'site-x',
      kind: 'checkin',
    });

    expect(findConflictingLearningSession([existing], {
      accountId: 'acc-2',
      siteId: 'site-x',
      kind: 'login',
    })).toEqual(existing);
    expect(findConflictingLearningSession([existing], {
      accountId: 'acc-2',
      siteId: 'site-x',
      kind: 'both',
    })).toEqual(existing);
    expect(findConflictingLearningSession([session({ kind: 'login' })], {
      accountId: 'acc-2',
      siteId: 'site-x',
      kind: 'checkin',
    })).toEqual(session({ kind: 'login' }));
  });

  it('允许开工与拒绝开工都由同一个决策返回，调用方不能先读后写绕过', () => {
    const existing = session({ runId: 'learn-a', accountId: 'acc-1', siteId: 'site-x' });

    expect(decideLearningStart([existing], {
      accountId: 'acc-2',
      siteId: 'site-x',
      kind: 'checkin',
    })).toEqual({ allowed: false, conflict: existing });

    expect(decideLearningStart([existing], {
      accountId: 'acc-2',
      siteId: 'site-y',
      kind: 'checkin',
    })).toEqual({ allowed: true });
  });
  it('旧会话缺 kind 时按 checkin 处理', () => {
    const legacy = session({ runId: 'learn-legacy', accountId: 'acc-1', siteId: 'site-x' });
    const conflict = findConflictingLearningSession([legacy], {
      accountId: 'acc-2',
      siteId: 'site-x',
    });
    expect(conflict).toEqual(legacy);
  });
});
describe('学到的流程必须完整落盘才算保存成功', () => {
  const steps: CheckinWorkflowStep[] = [
    { type: 'click', selector: '#entry' },
    { type: 'assert', text: ['签到成功'], result: 'success' },
  ];
  const route = ['/console', '/check-in'];
  const learned: CheckinWorkflowConfig = { steps, route };

  it('route 没落盘时不算成功 —— 只比 steps.length 会漏掉这种情况', () => {
    // 步骤数相同、route 丢了：老实现（只比长度）会误报「已保存」，
    // 用户下次自动签到再也找不到签到页。
    const result = verifyLearnedWorkflowStored(learned, {
      method: 'workflow',
      workflow: { steps: [...learned.steps] },
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('路线');
  });

  it('route 被改成一个更短的路线也不算成功', () => {
    expect(verifyLearnedWorkflowStored(learned, {
      method: 'workflow',
      workflow: { steps: [...learned.steps], route: ['/check-in'] },
    }).ok).toBe(false);
    expect(verifyLearnedWorkflowStored(learned, {
      method: 'workflow',
      workflow: { steps: [...learned.steps], route: ['/console', '/other'] },
    }).ok).toBe(false);
  });

  it('签到方式没有启用流程回放时不算成功', () => {
    const result = verifyLearnedWorkflowStored(learned, {
      method: 'button',
      workflow: { steps: [...learned.steps], route: [...route] },
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('签到方式');
  });

  it('自动识别不等于启用学习回放，保存后必须读回显式 workflow 方式', () => {
    for (const method of ['auto', undefined] as const) {
      expect(verifyLearnedWorkflowStored(learned, {
        method,
        workflow: { steps: [...learned.steps], route: [...route] },
      }).ok).toBe(false);
    }
  });

  it('步骤或路线对不上都返回可读的错误', () => {
    expect(verifyLearnedWorkflowStored(learned, {
      method: 'workflow',
      workflow: { steps: [steps[0]!], route: [...route] },
    })).toMatchObject({ ok: false, error: expect.stringContaining('步骤数') });
  });

  it('完整落盘才算成功（含只学到一个页面、无 route 的老形态）', () => {
    expect(verifyLearnedWorkflowStored(learned, {
      method: 'workflow',
      workflow: { steps: [...learned.steps], route: [...route] },
    })).toEqual({ ok: true });

    // 学习产出无 route 时（route 为空）不要求读回里有 route
    expect(verifyLearnedWorkflowStored(
      { steps: [{ type: 'click', selector: '#entry' }] },
      { method: 'workflow', workflow: { steps: [{ type: 'click', selector: '#entry' }] } },
    )).toEqual({ ok: true });
    // 读回完全缺失时不能回报成功
    expect(verifyLearnedWorkflowStored(learned, undefined).ok).toBe(false);
  });
});

describe('学习选择器', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 100, height: 30, top: 0, left: 0, right: 100, bottom: 30, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    Object.defineProperty(HTMLElement.prototype, 'innerText', {
      configurable: true,
      get(this: HTMLElement) { return this.textContent ?? ''; },
    });
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('优先用稳定属性，而不是会变的文字', () => {
    document.body.innerHTML = '<button data-testid="claim-btn" id="claim" name="claim" aria-label="领取">立即签到</button>';
    const element = document.querySelector<HTMLElement>('button')!;
    expect(learningSelector(element)).toBe('[data-testid="claim-btn"]');
  });

  it('role="menuitem" 的个人资料菜单项统一生成 text=选择器并能被回放解析', () => {
    document.body.innerHTML = '<div role="menuitem">个人资料</div>';
    const element = document.querySelector<HTMLElement>('[role="menuitem"]')!;
    const selector = learningSelector(element);

    expect(selector).toBe('text=个人资料');
    expect(queryFirst<HTMLElement>(selector)).toBe(element);
  });

  it('控件文字含逗号时仍是**一个**整体选择器，并能定位到该控件', () => {
    // 不带 id/name/aria-label，逼出文字兜底；控件文字里带逗号（真实站点很常见）
    document.body.innerHTML = '<button class="claim">签到, 领取</button><button class="other">领取</button>';
    const element = document.querySelector<HTMLElement>('.claim')!;
    const selector = learningSelector(element);

    // 只有一个选择器：不含逗号，不会被 splitSelectors 劈成两段
    expect(selector).toBe('text=签到');
    expect(selector).not.toContain(',');
    expect(queryFirst<HTMLElement>(selector)?.classList.contains('claim')).toBe(true);
  });

  it('不加长容器文字，只用控件自身的短文字', () => {
    document.body.innerHTML = [
      '<section>',
      `<p>${'很长的页面正文'.repeat(20)}</p>`,
      '<button><span>立即签到</span><em>第 3 天</em></button>',
      '</section>',
    ].join('');
    const element = document.querySelector<HTMLElement>('button')!;
    const selector = learningSelector(element);

    expect(selector.length).toBeLessThanOrEqual('text='.length + 24);
    expect(selector).not.toContain('很长的页面正文');
    expect(queryFirst<HTMLElement>(selector)?.tagName).toBe('BUTTON');
  });

  /**
   * 用户报的 bug：「很多时候识别不到的做的操作」。
   *
   * 真实站点大量用没有 id/name/aria-label、文字又是纯图标的 <button> / <div role=button>
   * 当签到控件。旧实现走到最后一档直接 `return element.tagName.toLowerCase()`，学出的
   * 选择器就是 `button`——回放时 `queryFirst('button')` 命中的是全页第一个按钮，必然点错。
   * 这一档必须换成**唯一指向录制元素**的结构化路径。
   */
  it('无任何稳定语义的控件回落到结构化路径，而不是会点错的裸标签名', () => {
    document.body.innerHTML = [
      '<div id="panel">',
      '<button><svg></svg></button>',
      '<button><svg></svg></button>',
      '</div>',
    ].join('');
    const target = document.querySelectorAll<HTMLElement>('#panel button')[1]!;
    const selector = learningSelector(target);

    // 不再是「命中全页第一个按钮」的裸标签名
    expect(selector).not.toBe('button');
    // 锚定到最近的稳定 id 祖先，路径短且不易受无关区域改动影响
    expect(selector).toContain('#panel');
    // 回放时必须唯一命中录制的那个控件（第二个按钮），而不是第一个
    expect(queryFirst<HTMLElement>(selector)).toBe(target);
  });

  it('name 命中多个时不采用它，改用唯一命中的结构化路径', () => {
    document.body.innerHTML = [
      '<form id="f1"><input name="claim"></form>',
      '<form id="f2"><input name="claim"></form>',
    ].join('');
    const target = document.querySelector<HTMLInputElement>('#f2 input')!;
    const selector = learningSelector(target);

    // input[name="claim"] 命中两个表单里的两个输入框，用它回放会点错
    expect(selector).not.toBe('input[name="claim"]');
    expect(queryFirst<HTMLElement>(selector)).toBe(target);
  });

  it('结构化路径锚定到最近的稳定祖先，跳过不稳定 id 祖先', () => {
    document.body.innerHTML = [
      '<div id="stable">',
      '<div id="base-ui-_r_h_">',
      '<button></button>',
      '</div></div>',
    ].join('');
    const target = document.querySelector<HTMLElement>('button')!;
    const selector = learningSelector(target);

    expect(selector).not.toContain('_r_h_');
    expect(selector).toContain('#stable');
    expect(queryFirst<HTMLElement>(selector)).toBe(target);
  });
});

/**
 * 用户报的 bug：「**你难道不需要学习滑动页面的动作吗**」「这个不应该滑动页面再快照吗？」。
 *
 * 真实场景：签到按钮/入口在视口下方（首屏看不到），用户**先把页面滚下去**，再点击。
 * 旧采集器只监听 click/input/change 与 SPA 导航，滚动一步都没学 —— 回放时执行器
 * 在首屏找控件，找不到就报「工作流找不到可点击元素」，用户看着自己明明点过。
 *
 * 契约（顶层事件类型不新增）：「点击前页面已经滚到哪里」作为 `click` 上的可选字段承载：
 * - `scrollBeforeY?: number` —— 页面里最靠上的滚动条停下的位置（像素，0~1e6），
 *   表示「这个点击发生前页面已经滚到这个位置」；
 * - `scrollPageTop?: boolean` —— 滚动发生在锚在文档上的滚动容器里（另有偏移且既不是
 *   0 也不是到底）时，像素不再是可信证据，只标记「点击前页面被滚过」。
 *
 * 记录的是**最终位置**（去抖合并后的一个值），不是轨迹、时间序列或鼠标坐标。
 */
describe('学习滑动页面（滚动到视口下方再点击）', () => {
  /** 复刻「签到入口在首屏下方」的站点。 */
  const scrollSite: SiteConfig = { ...site, checkin: { method: 'workflow', claimText: '每日签到' } };

  function stubLayout(): void {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 100, height: 30, top: 0, left: 0, right: 100, bottom: 30, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    Object.defineProperty(HTMLElement.prototype, 'innerText', {
      configurable: true,
      get(this: HTMLElement) { return this.textContent ?? ''; },
    });
  }

  /**
   * jsdom 没有滚动条，`window.scrollY` 恒为 0。这里把滚动位置写到 window 上再派发
   * `scroll`，模拟用户真实滚了一次：真实浏览器里每滚一下都会派发几十个 scroll 事件，
   * 所以「连续滚动」用同步连续派发 N 次来复刻。
   */
  function scrollTo(top: number): void {
    Object.defineProperty(window, 'scrollY', { configurable: true, value: top });
    Object.defineProperty(window, 'pageYOffset', { configurable: true, value: top });
    window.dispatchEvent(new Event('scroll'));
  }

  /** 模拟一次真实滚动：位置逐个逼近最终值，中间派发几十个 scroll 事件。 */
  function scrollTo_2400InSteps(): void {
    for (const top of [120, 380, 640, 900, 1160, 1420, 1680, 1940, 2200, 2400]) scrollTo(top);
  }

  let stopCapture: (() => void) | null = null;

  beforeEach(() => {
    stubLayout();
    document.body.innerHTML = '';
    window.history.replaceState({}, '', '/checkin');
  });

  afterEach(() => {
    stopCapture?.();
    stopCapture = null;
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    delete (window as unknown as Record<string, unknown>).scrollY;
    delete (window as unknown as Record<string, unknown>).pageYOffset;
  });

  function startCapture(settleMs = 0, scrollStopMs = 0) {
    const events: WorkflowLearningEvent[] = [];
    const capture = new LearningCapture({ settleMs, scrollStopMs, onEvent: (event) => events.push(event) });
    stopCapture = () => capture.detach();
    return { events, capture };
  }

  it('滚一下不会把每个 scroll 事件学成一步：去抖合并成一个最终位置', () => {
    document.body.innerHTML = '<button id="claim">立即签到</button>';
    const { events, capture } = startCapture(0, 0);
    capture.attach();

    // 用户往下滚：浏览器会派发几十个 scroll，录制侧必须自己合并
    for (let index = 0; index < 40; index += 1) scrollTo(60 * (index + 1));
    capture.flushPending();

    // 纯滚动去抖合并成**恰好一条** scroll 事件（不再是几十个、也不是 0 条）：
    // 用户「滚下去看内容」是真实做过的一步，不该整段丢失。
    expect(events.map((event) => event.type)).toEqual(['navigation', 'scroll']);

    document.querySelector<HTMLButtonElement>('#claim')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, composed: true }),
    );
    capture.flushPending();

    const clicks = events.filter((event) => event.type === 'click') as Array<Record<string, unknown>>;
    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toMatchObject({
      type: 'click',
      selector: '#claim',
      path: '/checkin',
      // 只记最终位置：2400px（不是轨迹、不是时间序列）
      scrollBeforeY: 2400,
    });
    // 顶层事件类型包含 scroll（纯滚动是真实一步），其余不变
    expect([...new Set(events.map((event) => event.type))].sort()).toEqual(['click', 'navigation', 'scroll']);
    // 学到的字段就是这些：没有轨迹、没有鼠标坐标、没有时间序列。
    // anchor/fingerprint 是「怎么点的」契约字段（落点比例与控件身份），不含坐标原文。
    expect(Object.keys(clicks[0]!).sort()).toEqual(['anchor', 'at', 'fingerprint', 'label', 'path', 'scrollBeforeY', 'selector', 'type']);
  });

  it('滚完立刻点、还没到去抖时间：这一次滚动照样挂到点击上（走 pendingScroll，不靠去抖结算）', () => {
    // 本 describe 里其它用例都在滚动后 flushPending() 才点击，唯独没覆盖最典型的一次
    // 「先滚再点」：用户滚到按钮看得见就马上点，scroll 与 click 之间没到去抖窗口。此时
    // scrollState 仍为空，位置只存在于 pendingScroll 里 —— takeScroll 必须能从 pendingScroll
    // 取到它，否则这一步就把滚动整段丢掉。
    //
    // 注意：采集器把 `scroll` 监听挂在 **document 的捕获阶段**（真实浏览器里滚动容器不冒泡，
    // 只有捕获能收到）。jsdom 里向 window 派发的 scroll 到不了 document 的捕获监听，必须直接
    // 向 document 派发才真正驱动 onScroll → pendingScroll 这条路径。
    document.body.innerHTML = '<button id="claim">立即签到</button>';
    // scrollStopMs 特意设得很大：去抖回调在本用例里根本没机会跑（scrollState 恒为空）。
    const { events, capture } = startCapture(0, 10_000);
    capture.attach();

    // 用户滚到 1800：onScroll 读 window.scrollY 存进 pendingScroll。
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 1_800 });
    document.dispatchEvent(new Event('scroll'));
    // 关键：**不 flush**，紧接着点击；再把 window.scrollY 归零，证明记录到的位置来自
    // 「滚动那一刻」的 pendingScroll，而不是点击时现读 DOM（现读只会得到 0）。
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
    document.querySelector<HTMLButtonElement>('#claim')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, composed: true }),
    );

    const clicks = events.filter((event) => event.type === 'click') as Array<Record<string, unknown>>;
    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toMatchObject({ selector: '#claim', scrollBeforeY: 1_800 });

    // 端到端：仍编译成「点击前先把目标滚进视口」，且不把绝对像素写进步骤
    const learned = buildLearnedWorkflow(scrollSite, events)!;
    expect(flattenSteps(learned.workflow.steps).filter((step) => step.type === 'click'))
      .toEqual([{ type: 'click', selector: '#claim', scrollIntoView: true, anchor: { rx: 0, ry: 0 }, fingerprint: { tag: 'button', text: '立即签到' } }]);
    expect(JSON.stringify(learned.workflow.steps)).not.toContain('1800');
    capture.detach();
  });

  it('整页滚动只派发给 window 时，也能把滚动挂到签到点击上', () => {
    document.body.innerHTML = '<button id="claim">立即签到</button>';
    const { events, capture } = startCapture(0, 10_000);
    capture.attach();

    Object.defineProperty(window, 'scrollY', { configurable: true, value: 2_400 });
    // Chrome 的整页滚动事件目标是 window；这个事件不会经过 document 的监听器。
    window.dispatchEvent(new Event('scroll'));
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
    document.querySelector<HTMLButtonElement>('#claim')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, composed: true }),
    );

    const click = events.find((event) => event.type === 'click') as Record<string, unknown> | undefined;
    expect(click).toMatchObject({ selector: '#claim', scrollBeforeY: 2_400 });
    capture.detach();
  });

  it('编译成回放步骤：点击前先把目标滚进视口（scrollIntoView），不新增步骤', () => {
    document.body.innerHTML = '<button id="claim">立即签到</button>';
    window.history.replaceState({}, '', '/checkout');
    const { events, capture } = startCapture(0, 0);
    capture.attach();
    scrollTo_2400InSteps();
    capture.flushPending();
    document.querySelector<HTMLButtonElement>('#claim')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, composed: true }),
    );
    capture.flushPending();
    capture.detach();

    const learned = buildLearnedWorkflow(scrollSite, events)!;
    const clicks = flattenSteps(learned.workflow.steps).filter((step) => step.type === 'click');
    // 相对量而非绝对像素：回放时只要求「点击前把目标滚进视口」，页面高度变了也能用
    expect(clicks).toEqual([{ type: 'click', selector: '#claim', scrollIntoView: true, anchor: { rx: 0, ry: 0 }, fingerprint: { tag: 'button', text: '立即签到' } }]);
    expect(JSON.stringify(learned.workflow.steps)).not.toContain('2400');
    // 步数只多了这个**可选属性**，没有多一步
    expect(learned.workflow.steps.filter((step) => step.type === 'click')).toHaveLength(1);
    expect(validateCheckinWorkflow(scrollSite, learned.workflow)).toEqual([]);
  });

  it('没滚动就点击时不硬塞滚动字段（本来就在视口里的按钮）', () => {
    document.body.innerHTML = '<button id="claim">立即签到</button>';
    const { events, capture } = startCapture(0, 0);
    capture.attach();
    document.querySelector<HTMLButtonElement>('#claim')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, composed: true }),
    );
    capture.flushPending();
    capture.detach();

    const clicks = events.filter((event) => event.type === 'click');
    expect(clicks).toHaveLength(1);
    expect(clicks[0]).not.toHaveProperty('scrollBeforeY');
    expect(clicks[0]).not.toHaveProperty('scrollPageTop');
    expect(buildLearnedWorkflow(scrollSite, events)!.workflow.steps)
      .toContainEqual({ type: 'click', selector: '#claim', anchor: { rx: 0, ry: 0 }, fingerprint: { tag: 'button', text: '立即签到' } });
  });

  it('页面停在滚动位置时动作如实带上当时的位置，滚回顶部后不再带（滚动不占步骤额度）', () => {
    document.body.innerHTML = [
      '<button id="claim">立即签到</button>',
      '<button id="submit">提交</button>',
      '<button id="third">再点一次</button>',
    ].join('');
    const { events, capture } = startCapture(0, 0);
    capture.attach();
    scrollTo(1200);
    capture.flushPending();
    document.querySelector<HTMLButtonElement>('#claim')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, composed: true }),
    );
    capture.flushPending();
    // 用户接着点第二个按钮，页面**还停在 1200**：两个动作发生时的位置都是 1200，如实记录
    document.querySelector<HTMLButtonElement>('#submit')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, composed: true }),
    );
    capture.flushPending();
    // 用户又滚回顶部后再点：这时页面和没滚过一样，不该再带滚动信息
    scrollTo(0);
    capture.flushPending();
    document.querySelector<HTMLButtonElement>('#third')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, composed: true }),
    );
    capture.flushPending();
    capture.detach();

    const clicks = events.filter((event) => event.type === 'click') as Array<Record<string, unknown>>;
    expect(clicks.map((event) => event.scrollBeforeY)).toEqual([1200, 1200, undefined]);

    // 回放侧：滚动只让「点击前先滚进视口」，**没有多出一步**
    const steps = flattenSteps(buildLearnedWorkflow(scrollSite, events)!.workflow.steps)
      .filter((step) => step.type === 'click');
    expect(steps).toEqual([
      { type: 'click', selector: '#claim', scrollIntoView: true, anchor: { rx: 0, ry: 0 }, fingerprint: { tag: 'button', text: '立即签到' } },
      { type: 'click', selector: '#submit', scrollIntoView: true, anchor: { rx: 0, ry: 0 }, fingerprint: { tag: 'button', text: '提交' } },
      { type: 'click', selector: '#third', anchor: { rx: 0, ry: 0 }, fingerprint: { tag: 'button', text: '再点一次' } },
    ]);
  });

  it('只滚动、没点击时滚动被忠实录成一步（不再整段丢失），但不伪造点击', () => {
    const { events, capture } = startCapture(0, 0);
    capture.attach();
    scrollTo_2400InSteps();
    // 用户滚下去、看了一眼就结束了学习：这次滚动是真实做过的一步，不能凭空消失。
    capture.detach();

    expect(events.some((event) => event.type === 'click')).toBe(false);
    // 去抖合并成恰好一条 scroll 事件，带 0..1 的落点比例
    const scrolls = events.filter((event) => event.type === 'scroll');
    expect(scrolls).toHaveLength(1);
    expect((scrolls[0] as { ratio: number }).ratio).toBeGreaterThan(0);
    expect((scrolls[0] as { ratio: number }).ratio).toBeLessThanOrEqual(1);

    // 编译成一条 scroll 步骤：回放时按比例还原真实像素
    const learned = buildLearnedWorkflow(scrollSite, events)!;
    const steps = flattenSteps(learned.workflow.steps).filter((step) => step.type === 'scroll');
    expect(steps).toHaveLength(1);
  });

  it('输入框在视口下方时，滚动信息同样挂在填充步骤上', () => {
    document.body.innerHTML = '<textarea id="reason" name="reason" aria-label="领取理由"></textarea>';
    const { events, capture } = startCapture(0, 0);
    capture.attach();
    scrollTo(900);
    capture.flushPending();
    const area = document.querySelector<HTMLTextAreaElement>('#reason')!;
    area.value = '每日签到';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    capture.flushPending();
    capture.detach();

    const learned = buildLearnedWorkflow(scrollSite, events)!;
    const fills = flattenSteps(learned.workflow.steps).filter((step) => step.type === 'fill');
    expect(fills).toEqual([{ type: 'fill', selector: '#reason', value: '{{claimText}}', scrollIntoView: true, fingerprint: { tag: 'textarea', name: 'reason', aria: '领取理由', inputType: 'textarea' } }]);
    // 脱敏不变：输入值本身仍然一个字都不回放
    expect(JSON.stringify(learned)).not.toContain('每日签到');
  });

  it('滚动位置被钉死在长度上限内（长页面也不会写进超大值）', () => {
    document.body.innerHTML = '<button id="claim">立即签到</button>';
    const { events, capture } = startCapture(0, 0);
    capture.attach();
    scrollTo(12_345_678_901);
    capture.flushPending();
    document.querySelector<HTMLButtonElement>('#claim')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, composed: true }),
    );
    capture.flushPending();
    capture.detach();

    const clicks = events.filter((event) => event.type === 'click') as Array<Record<string, unknown>>;
    const y = clicks[0]!.scrollBeforeY;
    expect(typeof y === 'number' && y >= 0 && y <= 1_000_000).toBe(true);
  });
});

/**
 * 滚动信息 → 回放步骤 的编译侧回归（不依赖 DOM）。
 *
 * 学出来的步骤里，「先滚到那个位置」只能落在**点击步骤的可选属性**上：
 * 不新增步骤（步骤上限只有 30）、不写绝对像素（页面高度会变）。
 */
describe('滚动信息编译成可回放的步骤', () => {
  const claimSite: SiteConfig = { ...site, checkin: { method: 'workflow', claimText: '每日签到' } };

  it('带滚动信息的点击编译成 scrollIntoView，步骤数一个都不多', () => {
    const learned = buildLearnedWorkflow(claimSite, [
      { type: 'navigation', path: '/dashboard', at: 1 },
      { type: 'navigation', path: '/check-in', at: 2 },
      {
        type: 'click',
        selector: '#claim',
        label: '签到',
        path: '/check-in',
        scrollBeforeY: 2_400,
        at: 3,
      } as WorkflowLearningEvent,
    ]);

    const steps = flattenSteps(learned!.workflow.steps);
    expect(steps.filter((step) => step.type === 'click'))
      .toEqual([{ type: 'click', selector: '#claim', scrollIntoView: true }]);
    // 没有多出 wait/assert 之类的步骤，也没有把像素写进步骤里
    expect(JSON.stringify(learned!.workflow.steps)).not.toContain('2400');
    // 新字段必须能过保存前校验（校验器不认识它，但也不能因此拒掉用户的录制）
    expect(validateCheckinWorkflow(claimSite, learned!.workflow)).toEqual([]);
  });

  it('只标记滚过（锚在文档的滚动容器另有偏移）时不写像素，同样编译成 scrollIntoView', () => {
    const learned = buildLearnedWorkflow(claimSite, [
      {
        type: 'click',
        selector: '#claim',
        label: '签到',
        path: '/check-in',
        scrollPageTop: true,
        at: 1,
      } as WorkflowLearningEvent,
    ]);

    expect(flattenSteps(learned!.workflow.steps).filter((step) => step.type === 'click'))
      .toEqual([{ type: 'click', selector: '#claim', scrollIntoView: true }]);
  });

  it('没滚过的点击不带 scrollIntoView（不硬塞）', () => {
    const learned = buildLearnedWorkflow(claimSite, [
      { type: 'click', selector: '#claim', label: '签到', path: '/check-in', at: 1 },
    ]);

    expect(flattenSteps(learned!.workflow.steps).filter((step) => step.type === 'click'))
      .toEqual([{ type: 'click', selector: '#claim' }]);
    expect(JSON.stringify(learned!.workflow.steps)).not.toContain('scrollIntoView');
  });

  it('滚动值非法或超上限时按「没滚过」处理，绝不写出不可回放的绝对像素', () => {
    const learned = buildLearnedWorkflow(claimSite, [
      {
        type: 'click',
        selector: '#claim',
        label: '签到',
        path: '/check-in',
        scrollBeforeY: 1e9,
        at: 1,
      } as WorkflowLearningEvent,
      { type: 'click', selector: '#submit', label: '提交', path: '/check-in', at: 2 },
    ]);

    expect(flattenSteps(learned!.workflow.steps)
      .filter((step) => step.type === 'click')
      .map(stepShape)).toEqual(['click #claim', 'click #submit']);
    expect(JSON.stringify(learned!.workflow.steps)).not.toContain('1000000000');
  });

  it('动作很多时滚动信息不会拖垮步骤上限：每个动作仍只有一步', () => {
    const events: WorkflowLearningEvent[] = [];
    for (let index = 1; index <= 26; index += 1) {
      events.push({
        type: 'click',
        selector: `#step-${index}`,
        label: `步骤${index}`,
        path: '/check-in',
        ...(index === 1 ? { scrollBeforeY: 1_800 } : {}),
        at: index,
      } as WorkflowLearningEvent);
    }

    const learned = buildLearnedWorkflow(claimSite, events);
    const clicks = flattenSteps(learned!.workflow.steps).filter((step) => step.type === 'click');
    expect(clicks).toHaveLength(26);
    expect(learned!.workflow.steps.length).toBeLessThanOrEqual(30);
    expect(validateCheckinWorkflow(claimSite, learned!.workflow)).toEqual([]);
  });
});

/**
 * 「学习把自动生成的不稳定 ID 当成选择器」的回归。
 *
 * 站点「卡皮巴拉API」的现场日志里，学出的选择器是 `#base-ui-_r_h_` —— 这是
 * React `useId` / Base UI 的产物（`_r_h_`），**每次渲染都可能变，不同元素还会共用同一个**。
 * 回放时它指向的是别的元素，于是点错元素、反复点同一个选择器，用户看到的就是「一直卡在核对」。
 *
 * 这里锁三件事：
 * 1. 不稳定 id 不出现在采集事件与最终步骤里，而是回落到控件文字（比随机 id 稳得多）；
 * 2. 稳定手写 id（`#checkin-btn`、`#login-form`）**仍然**优先于文字 —— 修复不能误伤它们；
 * 3. `data-testid` 仍然优先级最高。
 */
describe('学习不把自动生成的不稳定 id 学成选择器', () => {
  function stubLayout(): void {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 100, height: 30, top: 0, left: 0, right: 100, bottom: 30, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    Object.defineProperty(HTMLElement.prototype, 'innerText', {
      configurable: true,
      get(this: HTMLElement) { return this.textContent ?? ''; },
    });
  }

  beforeEach(() => {
    stubLayout();
    document.body.innerHTML = '';
    // 真实签到页：/profile（与故障站点一致）
    window.history.replaceState({}, '', '/profile');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('useId 形态的 id 不作为选择器，回落到控件文字且仍能定位到原控件', () => {
    document.body.innerHTML = '<button id="base-ui-_r_h_">立即签到</button>';
    const element = document.querySelector<HTMLElement>('button')!;
    const selector = learningSelector(element);

    expect(selector).not.toContain('_r_h_');
    expect(selector).toBe('text=立即签到');
    // 回落出来的选择器必须真的能选到原来那个控件，否则等于换了个点错的方式
    expect(queryFirst<HTMLElement>(selector)?.tagName).toBe('BUTTON');
  });

  it('role=menuitem 的菜单项生成文字选择器后，回放仍能选回同一个元素', () => {
    document.body.innerHTML = '<div role="menuitem">个人资料</div>';
    const element = document.querySelector<HTMLElement>('[role="menuitem"]')!;
    const selector = learningSelector(element);

    expect(selector).toBe('text=个人资料');
    expect(queryFirst<HTMLElement>(selector)).toBe(element);
  });

  it('采集 + 编译全链路里都不出现自动生成 id（原来学出的正是 #base-ui-_r_h_）', () => {
    document.body.innerHTML = '<button id="base-ui-_r_h_">立即签到</button>';
    const events: WorkflowLearningEvent[] = [];
    const capture = new LearningCapture({ settleMs: 0, onEvent: (event) => events.push(event) });
    capture.attach();
    document.querySelector<HTMLButtonElement>('button')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, composed: true }),
    );
    capture.flushPending();
    capture.detach();

    // 采集事件里就不该出现随机 id（选择器是采集那一刻定下来的）
    expect(JSON.stringify(events)).not.toContain('_r_h_');

    const learned = buildLearnedWorkflow(site, events)!;
    expect(JSON.stringify(learned.workflow)).not.toContain('_r_h_');
    // 学出的步骤用文字选择器，回放不再点错元素
    expect(learned.workflow.steps).toContainEqual({ type: 'click', selector: 'text=立即签到', anchor: { rx: 0, ry: 0 }, fingerprint: { tag: 'button', text: '立即签到' } });
  });

  it('同样形态的 id 在输入框上也不学成选择器（回落 name / aria-label）', () => {
    document.body.innerHTML = [
      '<input id="base-ui-_r_1_" name="reason" aria-label="领取理由">',
      '<input id="base-ui-_r_2_" aria-label="备注">',
    ].join('');
    const named = document.querySelector<HTMLElement>('input[name="reason"]')!;
    const ariaOnly = document.querySelector<HTMLElement>('input[aria-label="备注"]')!;

    // 回落顺序：不稳定 id 被踢掉后继续往下走（name → aria-label → 文字）
    expect(learningSelector(named)).toBe('input[name="reason"]');
    expect(learningSelector(ariaOnly)).toBe('text=备注');
  });

  it('稳定手写 id 仍然被优先使用 —— 本次修复不得误伤', () => {
    document.body.innerHTML = '<button id="checkin-btn" name="claim">立即签到</button>';
    // 有稳定 id 就用 id（优先于 name），行为与修复前完全一致
    expect(learningSelector(document.querySelector<HTMLElement>('button')!)).toBe('#checkin-btn');

    // 站点模板里真实存在的稳定 id 同样一个都不能被判成不稳定
    document.body.innerHTML = [
      '<form id="login-form">',
      '<input id="user" name="username">',
      '<input id="pass" name="password" type="password">',
      '<button id="submit">登录</button>',
      '</form>',
      '<button id="open-entry">登录后进入控制台</button>',
      '<textarea id="reason" name="reason"></textarea>',
      '<div id="checkin-entry"></div>',
    ].join('');
    for (const selector of ['#login-form', '#user', '#pass', '#submit', '#open-entry', '#reason', '#checkin-entry']) {
      const element = document.querySelector<HTMLElement>(selector)!;
      expect(element).not.toBeNull();
      expect(learningSelector(element)).toBe(selector);
    }
  });

  it('data-testid 仍然优先级最高（连不稳定 id 也压不过它）', () => {
    document.body.innerHTML = '<button data-testid="claim-btn" id="base-ui-_r_h_">立即签到</button>';
    expect(learningSelector(document.querySelector<HTMLElement>('button')!))
      .toBe('[data-testid="claim-btn"]');
  });

  it('判据逐条：自动生成 id 一律判为不稳定，稳定手写 id 一律判为稳定', () => {
    // React 19 / Base UI 的下划线形态（下划线包着短串，常带库前缀/组件后缀）
    for (const id of [
      '_r_h_', '_r_1_', '_r_0_', '_r_10_', 'base-ui-_r_h_', 'base-ui-_r_1_',
      'radix-_r_1_', '_r_2_-form-item', 'base-ui-_r_1_-form-item',
      // React 18 的冒号形态
      ':r1:', ':r0:', ':R2ab:', 'radix-:r1:',
      // 纯哈希 / UUID / 语义随机串
      'radix-1a2b3c', 'base-ui-9f8e7d6c', 'el-3f2a91b4',
      '0f9a3c1e-5b2d-4c7a-8e1f-2d3b4c5a6e7f', 'a1b2c3d4e5f6',
      // react-select / downshift 等库按序号生成的 id
      'react-select-2-input', 'downshift-1-input',
    ]) {
      expect(isUnstableGeneratedId(id), `${id} 应判为不稳定`).toBe(true);
    }

    // 稳定手写 id（站点模板与既有测试里真实使用的）一条都不能被误判
    for (const id of [
      'checkin-btn', 'login-form', 'checkin-entry', 'open-entry', 'claim', 'claim-btn',
      'submit', 'user', 'pass', 'user_email', 'reason', 'content', 'to-console',
      'step-1', 'login-history', 'dashboard-2026', 'a', 'x',
    ]) {
      expect(isUnstableGeneratedId(id), `${id} 应判为稳定`).toBe(false);
    }

    // 字符集/长度本来就不合格的 id 不进这条路（由既有判据继续拒绝）
    for (const id of ['', '1abc', '-abc', 'a b']) {
      expect(isUnstableGeneratedId(id), `${id} 应判为不稳定`).toBe(true);
    }
  });

  it('不稳定 id 旁边还有 name 时，步骤改用 name 而不是随机 id', () => {
    const learned = buildLearnedWorkflow(site, [
      { type: 'navigation', path: '/profile', at: 1 },
      {
        type: 'click',
        selector: 'input[name="claim"]',
        label: '领取',
        path: '/profile',
        at: 2,
      },
      {
        type: 'click',
        selector: 'text=签到',
        label: '签到',
        path: '/profile',
        evidence: { kind: 'success', words: ['签到成功'] },
        at: 3,
      },
    ]);

    expect(JSON.stringify(learned!.workflow)).not.toContain('_r_');
    expect(validateCheckinWorkflow(site, learned!.workflow)).toEqual([]);
  });
});

describe('身份核验页推断的安全性', () => {
  /**
   * 偏好/财务/安全类页面常常长得像资料页（`/settings`、`/account/billing`），
   * 但它们并不显示当前登录账号。被**优先**推成 identityPath 后回放会在那里死等身份、
   * 每次签到都停机，而 identityPath 没有直接修正入口 —— 所以这些页面只作排除，
   * 不参与推断；没有更好的候选时兜底回落到签到终点页自己（它至少与签到动作同页，
   * 读不到账号就停机，不会推错到别处）。
   */
  it('偏好/财务页不会被推断成身份核验页，兜底落到签到终点页', () => {
    const learned = buildLearnedWorkflow(site, [
      { type: 'navigation', path: '/dashboard', at: 1 },
      { type: 'navigation', path: '/settings', at: 2 },
      { type: 'navigation', path: '/account/billing', at: 3 },
      { type: 'click', selector: '#checkin', label: '立即签到', path: '/check-in', at: 4 },
    ]);

    expect(learned?.workflow.route).toEqual(['/dashboard', '/settings', '/account/billing', '/check-in']);
    // 偏好/财务页被排除；兜底用签到终点页，而不是把 /settings 或 /account/billing 推成身份页
    expect(learned?.workflow.identityPath).toBe('/check-in');
  });

  it('真正的资料页（含 new-api 的 /console/personal）仍会被采纳', () => {
    const learned = buildLearnedWorkflow(site, [
      { type: 'navigation', path: '/dashboard', at: 1 },
      { type: 'navigation', path: '/console/personal', at: 2 },
      { type: 'click', selector: '#checkin', label: '签到', path: '/check-in', at: 3 },
    ]);

    expect(learned?.workflow.identityPath).toBe('/console/personal');
  });

  it('标签命中资料词、地址却是设置/账单页的链接入口不会被钉成身份核验页', () => {
    // 「账户信息」这类标签经常指向 /account/settings —— 排除表明确列出的页面。
    // 链接分支若只看标签就取址，回放每次都会在那一页等身份、永远停机。
    const learned = buildLearnedWorkflow(site, [
      { type: 'navigation', path: '/dashboard', at: 1 },
      {
        type: 'click', selector: '#account-menu', label: '账户信息', path: '/dashboard',
        href: 'https://example.com/account/settings', at: 2,
      },
      { type: 'navigation', path: '/account/settings', at: 3 },
      { type: 'navigation', path: '/check-in', at: 4 },
      { type: 'click', selector: '#checkin', label: '签到', path: '/check-in', at: 5 },
    ]);

    expect(learned?.workflow.identityPath).toBe('/check-in');
    expect(learned?.workflow.identityPath).not.toBe('/account/settings');
  });

  it('链接分支仍接受站点自定义的资料地址（路径不命中资料词，但用户确实点过）', () => {
    const learned = buildLearnedWorkflow(site, [
      { type: 'navigation', path: '/dashboard', at: 1 },
      {
        type: 'click', selector: '#me', label: '个人资料', path: '/dashboard',
        href: 'https://example.com/u/12345', at: 2,
      },
      { type: 'navigation', path: '/u/12345', at: 3 },
      { type: 'navigation', path: '/check-in', at: 4 },
      { type: 'click', selector: '#checkin', label: '签到', path: '/check-in', at: 5 },
    ]);

    expect(learned?.workflow.identityPath).toBe('/u/12345');
  });

  it('更早的业务页（/user/dashboard）不会抢走后面的真资料页（/user/profile）', () => {
    const learned = buildLearnedWorkflow(site, [
      { type: 'navigation', path: '/user/dashboard', at: 1 },
      { type: 'navigation', path: '/user/profile', at: 2 },
      { type: 'navigation', path: '/check-in', at: 3 },
      { type: 'click', selector: '#checkin', label: '签到', path: '/check-in', at: 4 },
    ]);

    expect(learned?.workflow.identityPath).toBe('/user/profile');
    expect(learned?.workflow.route).toEqual(['/user/dashboard', '/user/profile', '/check-in']);
  });

  it('菜单锚点（<a href="#">个人资料</a>）解析成点击所在页时不会被当成身份核验页', () => {
    const learned = buildLearnedWorkflow(site, [
      { type: 'navigation', path: '/dashboard', at: 1 },
      {
        type: 'click', selector: '#menu-profile', label: '个人资料', path: '/dashboard',
        // href="#" 的锚点会解析成当前页地址
        href: 'https://example.com/dashboard', at: 2,
      },
      { type: 'navigation', path: '/check-in', at: 3 },
      { type: 'click', selector: '#checkin', label: '签到', path: '/check-in', at: 4 },
    ]);

    expect(learned?.workflow.identityPath).toBe('/check-in');
  });

  it('第一个资料入口指向被排除页时，继续找后面真正的资料入口', () => {
    const learned = buildLearnedWorkflow(site, [
      { type: 'navigation', path: '/dashboard', at: 1 },
      {
        type: 'click', selector: '#account', label: '账户信息', path: '/dashboard',
        href: 'https://example.com/account/settings', at: 2,
      },
      {
        type: 'click', selector: '#me', label: '个人资料', path: '/dashboard',
        href: 'https://example.com/u/12345', at: 3,
      },
      { type: 'navigation', path: '/u/12345', at: 4 },
      { type: 'navigation', path: '/check-in', at: 5 },
      { type: 'click', selector: '#checkin', label: '签到', path: '/check-in', at: 6 },
    ]);

    expect(learned?.workflow.identityPath).toBe('/u/12345');
  });

  it('设置区里的资料页（/settings/profile）仍被采纳，纯设置页不被采纳', () => {
    // 先被排除词命中、最后落在资料页上：GitHub 式 /settings/profile 是真实形态
    const withProfileTab = buildLearnedWorkflow(site, [
      { type: 'navigation', path: '/dashboard', at: 1 },
      { type: 'navigation', path: '/settings/profile', at: 2 },
      { type: 'navigation', path: '/check-in', at: 3 },
      { type: 'click', selector: '#checkin', label: '签到', path: '/check-in', at: 4 },
    ]);
    expect(withProfileTab?.workflow.identityPath).toBe('/settings/profile');

    const settingsOnly = buildLearnedWorkflow(site, [
      { type: 'navigation', path: '/settings', at: 1 },
      { type: 'navigation', path: '/check-in', at: 2 },
      { type: 'click', selector: '#checkin', label: '签到', path: '/check-in', at: 3 },
    ]);
    expect(settingsOnly?.workflow.identityPath).toBe('/check-in');
  });

  it('hash 路由的身份核验页仍能被学出来、写进路线并通过保存校验', () => {
    const learned = buildLearnedWorkflow(site, [
      { type: 'navigation', path: '/#/home', at: 1 },
      { type: 'navigation', path: '/#/profile', at: 2 },
      { type: 'navigation', path: '/#/check-in', at: 3 },
      { type: 'click', selector: '#checkin', label: '签到', path: '/#/check-in', at: 4 },
    ]);

    expect(learned?.workflow.identityPath).toBe('/#/profile');
    expect(validateCheckinWorkflow(site, learned!.workflow)).toEqual([]);
  });
});

describe('登录即签到必须完整落盘才算保存成功', () => {
  it('只认显式 none，且不允许保留任何会抢方向的旧签到入口配置', () => {
    expect(verifyLearnedLoginAsCheckinStored({ method: 'none' })).toEqual({ ok: true });

    for (const stale of [
      { method: 'none', entry: { steps: [{ selector: '#entry' }] } },
      { method: 'none', url: '/checkin' },
      { method: 'none', workflow: { steps: [{ type: 'click', selector: '#old' }] } },
      { method: 'none', buttonSelector: '#checkin' },
    ]) {
      const result = verifyLearnedLoginAsCheckinStored(stale);
      expect(result.ok, JSON.stringify(stale)).toBe(false);
    }
  });

  it('none 携带学习路线（route + identityPath + 空 steps）合法：它是运行时身份核对的依据', () => {
    // 卡皮巴拉/JustDoWork 那类 OAuth 站点登录后停在身份不暴露的落地页；
    // 保存学习到的 route/identityPath 才能让运行时按资料页核对当前账号。
    expect(verifyLearnedLoginAsCheckinStored({
      method: 'none',
      workflow: {
        steps: [],
        route: ['/dashboard/overview', '/profile'],
        identityPath: '/profile',
      },
    })).toEqual({ ok: true });

    // identityPath 是可选项（路线末页本身可核对时可不写）。
    expect(verifyLearnedLoginAsCheckinStored({
      method: 'none',
      workflow: {
        steps: [],
        route: ['/profile'],
      },
    })).toEqual({ ok: true });
  });

  it('没写进去或方式不对时不回报成功', () => {
    expect(verifyLearnedLoginAsCheckinStored(undefined).ok).toBe(false);
    expect(verifyLearnedLoginAsCheckinStored({ method: 'auto' }).ok).toBe(false);
    expect(verifyLearnedLoginAsCheckinStored({ method: 'workflow', workflow: { steps: [] } }).ok).toBe(false);
  });
});

describe('学习时没发现签到按钮 → 自动按登录即签到保存', () => {
  const loginThenProfile = (): WorkflowLearningEvent[] => [
    nav('/login', 1),
    fill({ path: '/login', at: 2 }),
    click({ selector: '#submit', label: '登录', path: '/login', loginAction: 'submit', at: 3 }),
    nav('/profile', 4),
  ];

  it('已登录进资料页、没有签到动作，且页面没有签到控件时为真', () => {
    expect(shouldAutoSaveLoginAsCheckin(loginThenProfile(), 'both', false)).toBe(true);
  });

  it('页面上有签到控件但用户忘了点时为假', () => {
    expect(shouldAutoSaveLoginAsCheckin(loginThenProfile(), 'both', true)).toBe(false);
  });

  it('控件扫描结果未知时为假', () => {
    expect(shouldAutoSaveLoginAsCheckin(loginThenProfile(), 'both', undefined)).toBe(false);
  });

  it('只停在登录页、还没进入站内业务页时为假', () => {
    const events = [
      nav('/login', 1),
      fill({ path: '/login', at: 2 }),
      click({ selector: '#submit', label: '登录', path: '/login', loginAction: 'submit', at: 3 }),
    ];

    expect(shouldAutoSaveLoginAsCheckin(events, 'both', false)).toBe(false);
  });

  it('录到签到动作时为假', () => {
    const events = [
      ...loginThenProfile(),
      click({ selector: '#claim', label: '立即签到', path: '/profile', at: 5 }),
    ];

    expect(shouldAutoSaveLoginAsCheckin(events, 'both', false)).toBe(false);
  });

  it('点过退出登录时为假', () => {
    const events = [
      ...loginThenProfile(),
      click({ selector: '#logout', label: '退出登录', path: '/profile', at: 5 }),
      nav('/logout', 6),
    ];

    expect(shouldAutoSaveLoginAsCheckin(events, 'both', false)).toBe(false);
  });

  it('停在帮助页或设置页时为假', () => {
    const onHelp = [...loginThenProfile(), nav('/help', 5)];
    const onSettings = [...loginThenProfile(), nav('/settings', 6)];

    expect(shouldAutoSaveLoginAsCheckin(onHelp, 'both', false)).toBe(false);
    expect(shouldAutoSaveLoginAsCheckin(onSettings, 'both', false)).toBe(false);
  });

  it('停在 /dashboard/overview 这类已知业务页且没有控件时为真', () => {
    const events = [
      nav('/login', 1),
      fill({ path: '/login', at: 2 }),
      click({ selector: '#submit', label: '登录', path: '/login', loginAction: 'submit', at: 3 }),
      nav('/dashboard/overview', 4),
    ];

    expect(shouldAutoSaveLoginAsCheckin(events, 'both', false)).toBe(true);
  });

  /**
   * 三态红线（审计发现的真实风险）：观测结果有 true / false / undefined 三种，
   * 只有 **false**（确认扫过且页面上没有可点签到控件）才允许自动落 method:'none'。
   *
   * undefined 表示**未观测**（采集器不在、跨页新文档、消息失败），把它当成
   * 「确认没有」会把「用户只是忘了点」误判成「本站登录即签到」，永久废掉该站
   * 原有的签到入口与流程。这里同时断言三种取值，未来任何把三态压成布尔的改动
   * 都会让本用例变红。
   */
  it('未观测（undefined）绝不能触发自动保存，只有「确认没有控件」才行', () => {
    const events = [
      nav('/login', 1),
      fill({ path: '/login', at: 2 }),
      click({ selector: '#submit', label: '登录', path: '/login', loginAction: 'submit', at: 3 }),
      nav('/dashboard/overview', 4),
    ];

    expect(shouldAutoSaveLoginAsCheckin(events, 'both', false)).toBe(true);
    expect(shouldAutoSaveLoginAsCheckin(events, 'both', undefined)).toBe(false);
    expect(shouldAutoSaveLoginAsCheckin(events, 'both', true)).toBe(false);
  });
});

describe('登录成功但没录到签到 → 结束前先让用户选择', () => {
  /** 完整的表单登录演示，登录后停在首页，全程没有签到动作。 */
  const loginOnly = (): WorkflowLearningEvent[] => [
    nav('/login', 1),
    fill({ selector: '#user', path: '/login', fieldRole: 'username', at: 2 }),
    fill({ selector: '#pass', label: '', path: '/login', fieldRole: 'password', at: 3 }),
    click({ selector: '#submit', label: '登录', path: '/login', loginAction: 'submit', at: 4 }),
    nav('/', 5),
  ];
  const choiceFor = (
    events: WorkflowLearningEvent[],
    overrides: Partial<Parameters<typeof needsLoginAsCheckinChoice>[0]> = {},
  ) => needsLoginAsCheckinChoice({
    intent: 'both',
    loginAsCheckinRequested: false,
    artifacts: buildLearnedArtifacts(site, events, 'both'),
    loginAsCheckinPossible: canSaveLoginAsCheckin(events, 'both'),
    alreadyPrompted: false,
    ...overrides,
  });

  it('只学到登录配置时先提示，不直接结束会话', () => {
    const artifacts = buildLearnedArtifacts(site, loginOnly(), 'both');
    expect(artifacts.login).not.toBeNull();
    expect(artifacts.checkin).toBeNull();
    expect(choiceFor(loginOnly())).toBe(true);
    expect(LOGIN_AS_CHECKIN_CHOICE_MESSAGE).toContain('登录即签到（没有签到按钮）');
  });

  it('同一场学习只问一次', () => {
    expect(choiceFor(loginOnly(), { alreadyPrompted: true })).toBe(false);
  });

  it('用户已选登录即签到、或只学登录时不问', () => {
    expect(choiceFor(loginOnly(), { loginAsCheckinRequested: true })).toBe(false);
    expect(choiceFor(loginOnly(), { intent: 'login' })).toBe(false);
  });

  it('录到签到动作时不问', () => {
    const events = [
      ...loginOnly(),
      nav('/profile', 6),
      click({ selector: '#daily', label: '立即签到', path: '/profile', at: 7 }),
    ];
    expect(choiceFor(events)).toBe(false);
  });

  it('点过退出登录时不问（演示不满足登录即签到判据）', () => {
    const events = [
      ...loginOnly(),
      click({ selector: '#logout', label: '退出登录', path: '/', at: 6 }),
      nav('/logout', 7),
    ];
    expect(choiceFor(events)).toBe(false);
  });
});

describe('回放流程里没有签到证据 → 保存前先问', () => {
  const evidenceChoiceFor = (events: WorkflowLearningEvent[], alreadyPrompted = false) => needsCheckinEvidenceChoice({
    intent: 'both',
    artifacts: buildLearnedArtifacts(site, events, 'both'),
    checkinEvidence: analyzeLearningEvents(events, 'both').checkin,
    alreadyPrompted,
  });

  /**
   * 用户实测的形状：登录即签到站点，开始学习时已登录，只在站内点了几下菜单。
   * 旧逻辑把这些点击编成 method:'workflow' 并启用，报告却写着「没有录到签到动作」。
   */
  const alreadyLoggedInNavOnly = (): WorkflowLearningEvent[] => [
    nav('/console', 1),
    click({ selector: '#notice', label: '公告', path: '/console', at: 2 }),
    nav('/profile', 3),
    click({ selector: '#tab-usage', label: '用量', path: '/profile', at: 4 }),
  ];

  it('已登录开始、只点了与签到无关的控件：编出了流程，但保存前要问', () => {
    const artifacts = buildLearnedArtifacts(site, alreadyLoggedInNavOnly(), 'both');
    expect(artifacts.login).toBeNull();
    expect(artifacts.checkin?.kind).toBe('workflow');
    expect(evidenceChoiceFor(alreadyLoggedInNavOnly())).toBe(true);
  });

  it('问过一次后照常保存', () => {
    expect(evidenceChoiceFor(alreadyLoggedInNavOnly(), true)).toBe(false);
  });

  it('点到签到按钮（有签到证据）时不问', () => {
    const events = [
      ...alreadyLoggedInNavOnly(),
      click({ selector: '#daily', label: '立即签到', path: '/profile', at: 5 }),
    ];
    expect(evidenceChoiceFor(events)).toBe(false);
  });

  it('没有编出回放流程时不问（交给其他出口处理）', () => {
    expect(evidenceChoiceFor([nav('/console', 1)])).toBe(false);
  });

  it('只学登录时不问', () => {
    expect(needsCheckinEvidenceChoice({
      intent: 'login',
      artifacts: buildLearnedArtifacts(site, alreadyLoggedInNavOnly(), 'both'),
      checkinEvidence: 'none',
      alreadyPrompted: false,
    })).toBe(false);
  });
});

describe('先退出别的账号再演示：只编译最后一次退出之后的流程', () => {
  it('退出前在旧会话里走过的页面和点击不进路线和步骤', () => {
    const events: WorkflowLearningEvent[] = [
      nav('/console', 1),
      click({ selector: '#other-menu', label: '公告', path: '/console', at: 2 }),
      click({ selector: '#logout', label: '退出登录', path: '/console', at: 3 }),
      nav('/login', 4),
      fill({ selector: '#user', path: '/login', fieldRole: 'username', at: 5 }),
      fill({ selector: '#pass', label: '', path: '/login', fieldRole: 'password', at: 6 }),
      click({ selector: '#submit', label: '登录', path: '/login', loginAction: 'submit', at: 7 }),
      nav('/profile', 8),
      click({ selector: '#checkin', label: '立即签到', path: '/profile', at: 9, evidence: { kind: 'success', words: ['签到成功'] } }),
    ];

    const learned = buildLearnedWorkflow(site, events);

    expect(learned).not.toBeNull();
    expect(learned!.workflow.route).toEqual(['/profile']);
    const selectors = flattenSteps(learned!.workflow.steps)
      .filter((step): step is Extract<CheckinWorkflowStep, { type: 'click' }> => step.type === 'click')
      .map((step) => step.selector);
    expect(selectors).toEqual(['#checkin']);
    expect(learned!.eventCount).toBe(events.length);
  });
});

describe('演示账号自己的名字不进站点流程（别的账号也能回放）', () => {
  const loginThenMenu = (menu: Partial<ClickEvent>): WorkflowLearningEvent[] => [
    nav('/console', 1),
    click({ path: '/console', at: 2, ...menu }),
    nav('/profile', 3),
    click({ selector: '#checkin', label: '立即签到', path: '/profile', at: 4, evidence: { kind: 'success', words: ['签到成功'] } }),
  ];
  const clickSteps = (workflow: CheckinWorkflowConfig) => flattenSteps(workflow.steps)
    .filter((step): step is Extract<CheckinWorkflowStep, { type: 'click' }> => step.type === 'click');

  it('采集侧：头像菜单上印着自己的名字时，不用名字当选择器', () => {
    // jsdom 没有布局：给元素一个尺寸，`text=` 选择器才能被判为可见、唯一。
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ width: 40, height: 20, top: 0, left: 0, right: 40, bottom: 20, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    try {
      document.body.innerHTML = '<header><nav><button aria-label="alice">A</button></nav></header><main><button>签到</button></main>';
      const menu = document.querySelector('button')!;
      expect(learningSelector(menu)).toBe('text=alice');
      const shared = learningSelector(menu, (value) => value?.trim() === 'alice');
      expect(shared).not.toContain('alice');
      expect(queryFirst<HTMLElement>(shared)).toBe(menu);
    } finally {
      rect.mockRestore();
    }
  });

  it('编译侧：指纹里的名字删掉，步骤和选择器原样保留（菜单可能是下一步的开关）', () => {
    const events = loginThenMenu({
      selector: '#avatar',
      label: 'alice',
      fingerprint: { tag: 'button', text: 'alice', role: 'button' },
    });

    const menu = clickSteps(buildLearnedWorkflow(site, events, { personalTexts: ['alice@example.com'] })!.workflow)[0]!;

    expect(menu.selector).toBe('#avatar');
    expect(menu.fingerprint).toEqual({ tag: 'button', role: 'button' });
  });

  it('签到动作本身一个字都不碰：用户名恰好是常见词也不误删签到按钮的指纹', () => {
    const events: WorkflowLearningEvent[] = [
      nav('/profile', 1),
      click({ selector: '#daily', label: 'Daily Check-in', path: '/profile', at: 2,
        fingerprint: { tag: 'button', text: 'Daily Check-in' },
        evidence: { kind: 'success', words: ['签到成功'] } }),
    ];

    const step = clickSteps(buildLearnedWorkflow(site, events, { personalTexts: ['daily'] })!.workflow)[0]!;

    expect(step.fingerprint).toEqual({ tag: 'button', text: 'Daily Check-in' });
  });

  it('只按完整词匹配：名字是更长单词的一部分时不误伤', () => {
    const events = loginThenMenu({
      selector: '#notice',
      label: 'Alicesoft 公告',
      fingerprint: { tag: 'a', text: 'Alicesoft 公告' },
    });

    const menu = clickSteps(buildLearnedWorkflow(site, events, { personalTexts: ['alice'] })!.workflow)[0]!;

    expect(menu.fingerprint).toEqual({ tag: 'a', text: 'Alicesoft 公告' });
  });

  it('没给名字时行为与以前完全一样', () => {
    const events = loginThenMenu({ selector: '#avatar', label: 'alice', fingerprint: { tag: 'button', text: 'alice' } });
    expect(clickSteps(buildLearnedWorkflow(site, events)!.workflow)[0]!.fingerprint).toEqual({ tag: 'button', text: 'alice' });
  });
});
