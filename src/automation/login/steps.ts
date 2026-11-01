import type { LoginMethod, SiteConfig } from '@/types';
import { COMMON_PASSWORD_SELECTORS, COMMON_USERNAME_SELECTORS } from '@/sites';
import { describeElement, domClick, isVisible, queryFirst, realClick, setNativeValue, sleep, waitFor, pressEnter } from '@/automation/shared/dom-utils';
import { dismissAnnouncements } from '@/automation/shared/announcements';
import { clearClickBlocker } from '@/automation/shared/click-safety';

// StepLog 定义在 log.ts（避免与 announcements.ts 循环依赖），
// 这里再导出一次，既有 import 不用改
import type { StepLog } from '@/automation/shared/log';
export type { StepLog };

const MANUAL_LOGIN_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input[name*="otp" i]',
  'input[id*="otp" i]',
  'input[name*="totp" i]',
  'input[id*="totp" i]',
  'input[name*="mfa" i]',
  'input[id*="mfa" i]',
  'input[name*="2fa" i]',
  'input[id*="2fa" i]',
].join(', ');

const UNSAFE_RESULT_PATH = /(?:^|[/_-])(login|sign-?in|auth|verify|verification|challenge|captcha|2fa|mfa|otp|error|forbidden|suspended?|banned?)(?:[/_.-]|$)/i;

interface InputMatch {
  element: HTMLInputElement;
  selector: string;
  fallback: boolean;
}

interface SubmitMatch {
  element: HTMLElement;
  fallback: boolean;
}

interface OAuthButtonMatch {
  element: HTMLElement;
  automatic: boolean;
}

/**
 * 会触发提交或导航的页面动作钩子。
 *
 * beforeClick 用于统一处理动态验证码；处理过程可能重绘 DOM，所以调用方必须
 * 在它返回后重新定位目标。beforeNavigate 则只负责在页面销毁前落地任务阶段。
 */
export interface PageActionHooks {
  beforeClick?: () => Promise<boolean>;
  /** 点击后由页面动态挂载验证控件时，重新进入同一套验证处理链。 */
  afterClick?: () => Promise<boolean>;
  beforeAuxiliaryClick?: () => Promise<boolean>;
  beforeNavigate?: () => Promise<void>;
}

export type LoginResubmitOutcome = 'submitted' | 'not-needed' | 'blocked';

async function requirePageAction(hooks: PageActionHooks, label: string): Promise<void> {
  if (hooks.beforeClick && !await hooks.beforeClick()) {
    throw new Error(`${label}前的人机验证未完成，已停止页面操作`);
  }
}

const USERNAME_HINT = /(?:用户名|用户|账号|账户|邮箱|邮件|user\s*name|account|e-?mail|login)/i;
const NON_USERNAME_HINT = /(?:验证码|校验码|动态码|搜索|手机号|captcha|verify|verification|otp|totp|mfa|2fa|search)/i;
// 页面上的 API 调试/代理工具经常使用 text 类型，但绝不是登录账号。
// 这些字段必须在语义兜底中硬排除，否则首页只剩一个输入框时会被
// `唯一候选 +50` 误判成用户名输入框，阻止后续点击真正的登录入口。
const NON_CREDENTIAL_FIELD_HINT = /(?:api[-_\s]*(?:endpoint|url)|endpoint[-_\s]*(?:url)?|base[-_\s]*url|proxy[-_\s]*(?:url|address)|request[-_\s]*url|api\s*地址|接口(?:地址|配置)|请求地址|中转地址|代理地址|常用工具)/i;
const PASSWORD_HINT = /(?:密码|口令|pass\s*word|passwd|passcode)/i;
const NEW_PASSWORD_HINT = /(?:新密码|确认密码|重复密码|设置密码|new\s*password|confirm\s*password|repeat\s*password|create\s*password)/i;
const LOGIN_CONTEXT_HINT = /(?:登录|登陆|sign\s*in|log\s*in)/i;
const REGISTRATION_CONTEXT_HINT = /(?:注册|创建账号|加入|sign\s*up|register|create\s*(?:an?\s*)?account|join)/i;
const LOGIN_ACTION_HINT = /^(?:登录|登陆|立即登录|继续登录|登\s*录|log\s*in|sign\s*in|continue)$/i;
const CONTINUE_ACTION_HINT = /(?:继续|下一步|下一页|确认|提交|continue|next|proceed|submit)/i;
const NON_LOGIN_ACTION_HINT = /(?:注册|忘记|找回|验证码|github|google|linuxdo|oauth|sso|passkey|register|sign\s*up|forgot|captcha)/i;
const CONSENT_HINT = /(?:同意|接受|agree|accept).*(?:协议|条款|隐私|terms?|privacy)|(?:协议|条款|隐私|terms?|privacy).*(?:同意|接受|agree|accept)/i;
const CHALLENGE_CHECKBOX_HINT = /(?:captcha|turnstile|recaptcha|hcaptcha|人机|真人|验证码|安全验证)/i;
const GITHUB_OAUTH_HINT = /(?:github|git\s*hub)/i;
const STRONG_OAUTH_PROVIDER_HINT = /(?:linuxdo|linux\s*do|google|discord|telegram|microsoft|github|git\s*hub)/i;
const PASSKEY_HINT = /(?:passkey|webauthn|security\s*key|通行密钥|安全密钥|生物识别)/i;
const OAUTH_ACTION_HINT = /(?:oauth|sso|openid|oidc|passkey|webauthn|通行密钥|安全密钥|生物识别|第三方|授权|使用.{0,16}(?:继续|登录|登陆)|通过.{0,16}(?:继续|登录|登陆)|用.{0,16}(?:继续|登录|登陆)|continue.{0,16}with|sign\s*in.{0,16}with|log\s*in.{0,16}with)/i;
const NON_OAUTH_ACTION_HINT = /(?:注册|忘记|找回|重置|验证码|校验码|动态码|搜索|刷新|发送|获取|register|sign\s*up|forgot|reset|captcha|verify|verification|otp|totp|mfa|2fa|search|send)/i;

function matchesSelector(element: Element, selector?: string): boolean {
  if (!selector?.trim() || selector.includes('text=')) return false;
  try {
    return element.matches(selector);
  } catch {
    return false;
  }
}

function matchesAnySelector(element: Element, selectors: readonly string[]): boolean {
  return selectors.some((selector) => matchesSelector(element, selector));
}

function inputSurfaceText(element: HTMLInputElement): string {
  const surface = element.closest('form, [role="dialog"], main, section');
  return (surface?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 1_000);
}

function inputSemanticText(element: HTMLInputElement): string {
  const labels = [...(element.labels ?? [])].map((label) => label.textContent ?? '');
  return [
    element.id,
    element.name,
    element.placeholder,
    element.autocomplete,
    element.getAttribute('aria-label'),
    ...labels,
  ].filter(Boolean).join(' ');
}

function findSemanticUsernameInput(
  configuredSelector: string,
  scope: ParentNode,
  exclude?: HTMLInputElement,
): InputMatch | null {
  const candidates = [...scope.querySelectorAll<HTMLInputElement>('input')].filter((element) => (
    element !== exclude
    && !element.disabled
    && !element.readOnly
    && ['text', 'email', 'tel', ''].includes(element.type.toLowerCase())
    && isVisible(element)
  ));

  const ranked = candidates.map((element) => {
    const semanticText = inputSemanticText(element);
    const surfaceText = inputSurfaceText(element);
    const explicitlyConfigured = matchesSelector(element, configuredSelector);
    let score = 0;
    if (explicitlyConfigured) score += 220;
    if (NON_CREDENTIAL_FIELD_HINT.test(semanticText) && !explicitlyConfigured) {
      return { element, score: Number.NEGATIVE_INFINITY };
    }
    if (matchesAnySelector(element, COMMON_USERNAME_SELECTORS)) score += 70;
    if (/^(?:username|email)$/i.test(element.autocomplete)) score += 120;
    if (element.type.toLowerCase() === 'email') score += 90;
    if (USERNAME_HINT.test(semanticText)) score += 70;
    if (element.type.toLowerCase() === 'text') score += 10;
    if (candidates.length === 1) score += 50;
    if (LOGIN_CONTEXT_HINT.test(surfaceText)) score += 30;
    if (REGISTRATION_CONTEXT_HINT.test(surfaceText) && !LOGIN_CONTEXT_HINT.test(surfaceText)) score -= 180;
    if (NON_USERNAME_HINT.test(semanticText)) score -= 200;
    return { element, score };
  }).sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best || best.score < 60) return null;
  return {
    element: best.element,
    selector: '页面表单语义',
    fallback: !matchesSelector(best.element, configuredSelector),
  };
}

function findUsernameInput(
  configuredSelector: string,
  scope: ParentNode,
  exclude?: HTMLInputElement,
): InputMatch | null {
  return findSemanticUsernameInput(configuredSelector, scope, exclude);
}

function findPasswordInput(configuredSelector: string, scope: ParentNode): InputMatch | null {
  const candidates = [...scope.querySelectorAll<HTMLInputElement>('input')].filter((element) => (
    !element.disabled
    && !element.readOnly
    && element.type !== 'hidden'
    && isVisible(element)
  ));

  const ranked = candidates.map((element) => {
    const semanticText = inputSemanticText(element);
    const surfaceText = inputSurfaceText(element);
    const autocomplete = element.autocomplete.toLowerCase();
    let score = 0;
    if (matchesSelector(element, configuredSelector)) score += 220;
    if (matchesAnySelector(element, COMMON_PASSWORD_SELECTORS)) score += 70;
    if (element.type.toLowerCase() === 'password') score += 180;
    if (autocomplete === 'current-password') score += 180;
    if (PASSWORD_HINT.test(semanticText)) score += 90;
    if (candidates.length === 1 && element.type.toLowerCase() === 'password') score += 50;
    if (LOGIN_CONTEXT_HINT.test(surfaceText)) score += 30;
    if (REGISTRATION_CONTEXT_HINT.test(surfaceText) && !LOGIN_CONTEXT_HINT.test(surfaceText)) score -= 600;
    if (autocomplete === 'new-password' || NEW_PASSWORD_HINT.test(semanticText)) score -= 600;
    if (NON_USERNAME_HINT.test(semanticText)) score -= 220;
    return { element, score };
  }).sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best || best.score < 100) return null;
  return {
    element: best.element,
    selector: '页面密码语义',
    fallback: !matchesSelector(best.element, configuredSelector),
  };
}

async function waitForPasswordInput(
  configuredSelector: string,
  timeout: number,
  scope: ParentNode = document,
): Promise<InputMatch | null> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const match = findPasswordInput(configuredSelector, scope);
    if (match) return match;
    await sleep(200);
  }
  return null;
}

function findLoginCredentialInput(site: SiteConfig): InputMatch | null {
  return findPasswordInput(site.selectors.password, document)
    ?? findUsernameInput(site.selectors.username, document);
}

/**
 * 「这一页确实摆着登录表单」的**强证据**：密码框，或一个确有账号语义的输入框。
 *
 * 与 `findLoginCredentialInput` 的区别：那个用于「在登录页上找要填的框」，宁可宽一点；
 * 这个用于「判断当前是不是没登录」，必须窄 —— 已登录的控制台上常有一个孤零零的
 * 文本框（兑换码、搜索、Linux.SB 的发帖框），宽判据会把它当成用户名框，于是已登录
 * 被判成「要求登录」，随后去找根本不存在的登录表单。
 *
 * 只认：**登录用的**密码框；或带账号语义（autocomplete=username/email、type=email、
 * 标签/name/placeholder 含用户名/邮箱/账号词）的输入框。站点配置里的裸
 * `input[type="text"]` 不算证据。
 *
 * 密码框还要排除「改密码 / 设置密码」表单：卡皮巴拉（new-api 新版界面）的
 * `/profile` 资料页上就摆着「当前密码 + 新密码 + 确认新密码」的修改密码卡片。
 * 旧判据只要看到任意可见密码框就判「这是登录表单」，于是已登录的资料页被判成
 * 未登录，工作流每次检查都触发「登录失效」，跳回登录页再回来，无限循环。
 * 登录密码框通常是**唯一**一个密码框；改密码表单必然带新密码/确认密码语义。
 */
function hasStrongLoginFormEvidence(site: SiteConfig): boolean {
  const password = findPasswordInput(site.selectors.password, document);
  if (password && isLoginPasswordForm()) return true;
  const username = findUsernameInput(site.selectors.username, document);
  if (!username) return false;
  const element = username.element;
  if (/^(?:username|email)$/i.test(element.autocomplete) || element.type.toLowerCase() === 'email') return true;
  const semanticText = inputSemanticText(element);
  return USERNAME_HINT.test(semanticText) && !NON_USERNAME_HINT.test(semanticText);
}

/**
 * 页面上的密码框是不是**登录用的**，而不是「修改密码 / 设置密码 / 注册」表单里的。
 *
 * 判据分两层，都在**页面级**判断，不看被选中的那一个框：
 * 1. 任一可见密码框带新密码语义（新密码 / 确认密码 / 重复密码 /
 *    `autocomplete=new-password`）→ 这是改密码或注册表单，不是登录；
 * 2. 否则按登录表单处理。
 *
 * 第 1 条来自真实故障：卡皮巴拉的 `/profile` 资料页摆着「当前密码 / 新密码 /
 * 确认新密码」的修改密码卡片。旧判据只要看到**任意**可见密码框就判「这是登录
 * 表单」，于是已登录的资料页被判成未登录 → 学习流程每次检查都触发「登录失效」
 * → 跳回登录页 → 再跳回来 → 自动恢复 2 次后仍失败。
 *
 * 为什么必须看整页而不是看打分选中的那个框：`findPasswordInput` 会优先选
 * 「当前密码」这类语义最像登录框的输入（它确实匹配 `input[type=password]`），
 * 只看它就会漏掉同一张卡片里的「新密码」，于是照样误判成登录页。
 *
 * ⚠️ 刻意**不**按「密码框数量」判断：双框登录（密码 + 确认密码的旧式注册页）
 * 与改密码表单在数量上无法区分，按数量判会把真登录页误判成已登录。只认语义，
 * 宁可多问一次身份接口，也不放过真的登录表单。
 */
function isLoginPasswordForm(): boolean {
  const visiblePasswords = [...document.querySelectorAll<HTMLInputElement>('input[type="password"]')]
    .filter((element) => !element.disabled && !element.readOnly && isVisible(element));
  return !visiblePasswords.some((element) => (
    NEW_PASSWORD_HINT.test(inputSemanticText(element))
    || element.autocomplete.toLowerCase() === 'new-password'
  ));
}

/**
 * 当前页是否**确实摆着登录表单**：登录用的密码框，或二次验证框。
 *
 * 只读，不点击、不等待。回答的是「要不要去问站点身份接口」这一个问题：
 * 摆着登录表单时不必问；页头的「登录」链接、一个孤零零的文本框都不足以下结论 ——
 * 站点接口说当前有会话，就证明会话此刻有效，一个链接推翻不了它。
 *
 * ⚠️ 它**故意比 `hasStrongLoginFormEvidence` 窄**，不要合并两者：
 * 这里只认密码框与二次验证框，**不认账号输入框**。已有登录页上也可能有账号
 * 语义的输入框（强制绑定邮箱弹窗、账号设置里的邮箱框），算进来会跳过身份接口、
 * 在站内去填一个根本不存在的登录表单。多步登录（先只出账号框）照样问一次接口，
 * 接口说没会话就照常登录 —— 多花一次只读请求，不会误判。
 *
 * 密码框同样要排除改密码表单（见 `isLoginPasswordField`）：否则已登录的资料页
 * 会被当成登录页，触发不必要的身份探测与「登录失效」误报。
 *
 * 命名上刻意带 `Prompt`：它的输出是「要不要继续探测」，不是「是否有登录表单」。
 */
export function hasVisibleLoginPrompt(site: SiteConfig): boolean {
  const password = findPasswordInput(site.selectors.password, document);
  return (password !== null && isLoginPasswordForm()) || detectManualLoginStep() !== null;
}

async function waitForLoginCredentialInput(site: SiteConfig, timeout: number): Promise<InputMatch | null> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const match = findLoginCredentialInput(site);
    if (match) return match;
    await sleep(200);
  }
  return null;
}

function inputIdentity(match: InputMatch): string {
  const { element } = match;
  if (element.id) return `#${element.id}`;
  if (element.name) return `input[name="${element.name}"]`;
  if (element.autocomplete) return `input[autocomplete="${element.autocomplete}"]`;
  return match.selector;
}

function findSameOriginLoginLink(): HTMLAnchorElement | null {
  let current: URL;
  try {
    current = new URL(location.href);
  } catch {
    return null;
  }

  for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (!isVisible(anchor)) continue;
    try {
      const target = new URL(anchor.href, current.href);
      const samePage = target.pathname === current.pathname && target.search === current.search;
      if (
        target.origin === current.origin
        && !samePage
        && /(?:^|\/)(?:login|sign-?in)(?:\/|$)/i.test(target.pathname)
      ) {
        return anchor;
      }
    } catch {
      // 忽略无效 href。
    }
  }
  return null;
}

/** 展开账密表单的按钮文案：new-api 新版默认藏账密表单，先点这类按钮才显示 */
const REVEAL_FORM_WORDS = ['邮箱或用户名', '账号密码', '密码登录', '邮箱登录', '账号登录', '用户名登录'];
/** 第三方/OAuth 登录按钮的特征词，绝不能被当成「展开账密表单」误点 */
const OAUTH_BUTTON_WORDS = ['github', 'linuxdo', 'linux do', 'google', 'passkey', 'apple', 'wechat', '微信', 'qq', 'telegram', 'oauth'];

/**
 * 找「展开账密表单」的按钮（如 new-api 新版的「使用 邮箱或用户名 登录」）。
 *
 * 这类站点登录页默认只显示 OAuth 按钮，账密表单要点这个按钮才出现。没配
 * preLoginClickSelector 时靠它兜底：正向匹配账密相关词，并显式排除 OAuth 按钮
 *（否则会把「使用 GitHub 继续」也点了，跳去第三方授权页）。
 */
function findRevealPasswordFormButton(): HTMLElement | null {
  for (const btn of document.querySelectorAll<HTMLElement>('button, [role="button"]')) {
    if (!isVisible(btn)) continue;
    const text = (btn.innerText || btn.textContent || '').replace(/\s+/g, '').toLowerCase();
    if (!text) continue;
    if (OAUTH_BUTTON_WORDS.some((word) => text.includes(word.replace(/\s+/g, '')))) continue;
    if (REVEAL_FORM_WORDS.some((word) => text.includes(word))) return btn;
  }
  return null;
}

function hasSameOriginCheckinLink(): boolean {
  let current: URL;
  try {
    current = new URL(location.href);
  } catch {
    return false;
  }

  return [...document.querySelectorAll<HTMLAnchorElement>('a[href]')].some((anchor) => {
    if (!isVisible(anchor)) return false;
    try {
      const target = new URL(anchor.href, current.href);
      return target.origin === current.origin
        && /(?:^|\/)(?:check-?in|daily-check-?in)(?:\/|$)/i.test(target.pathname);
    } catch {
      return false;
    }
  });
}

function actionText(element: HTMLElement): string {
  return [
    element.textContent,
    element.getAttribute('value'),
    element.getAttribute('aria-label'),
    element.getAttribute('title'),
  ].filter(Boolean).join(' ').trim();
}

function oauthText(element: HTMLElement): string {
  const className = typeof element.className === 'string' ? element.className : '';
  const href = element instanceof HTMLAnchorElement ? element.href : '';
  return [
    actionText(element),
    element.id,
    className,
    href,
  ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function buttonLabel(element: HTMLElement): string {
  return actionText(element).replace(/\s+/g, ' ').trim() || oauthText(element) || element.tagName.toLowerCase();
}

function visibleLoginFeedback(): string | null {
  const selectors = [
    '[role="alert"]',
    '.semi-toast-content',
    '.semi-notification-content',
    '.ant-message-notice-content',
    '.ant-notification-notice-message',
  ];
  for (const selector of selectors) {
    const match = [...document.querySelectorAll<HTMLElement>(selector)].find((element) => isVisible(element));
    const text = match?.innerText?.replace(/\s+/g, ' ').trim();
    if (text) return text.slice(0, 160);
  }
  return null;
}

const LOGIN_FAILURE_FEEDBACK = /(?:登录|账号|账户|用户名|邮箱|密码|凭据).{0,24}(?:失败|错误|无效|不正确|不存在|已锁定|已过期|被拒绝)|(?:failed|error|invalid|incorrect|wrong|denied|expired|locked).{0,24}(?:login|account|user|email|password|credential)/i;

function visibleLoginFailureFeedback(): string | null {
  const feedback = visibleLoginFeedback();
  return feedback && LOGIN_FAILURE_FEEDBACK.test(feedback) ? feedback : null;
}

function loginRequestObserved(): boolean {
  return performance.getEntriesByType('resource').some((entry) => {
    try {
      return /\/api\/user\/login(?:[/?#]|$)/i.test(new URL(entry.name, location.href).pathname);
    } catch {
      return false;
    }
  });
}

function oauthScore(element: HTMLElement): number {
  const text = oauthText(element);
  const authLikeTarget = /\/(?:oauth|auth|sso)(?:\/|$)|github\.com\/login\/oauth/i.test(text);
  const actionLike = OAUTH_ACTION_HINT.test(text);
  const githubProvider = GITHUB_OAUTH_HINT.test(text);
  const passkeyProvider = PASSKEY_HINT.test(text);
  const otherProvider = STRONG_OAUTH_PROVIDER_HINT.test(text);
  const plainLink = element instanceof HTMLAnchorElement && !authLikeTarget;
  let score = 0;

  if (githubProvider && (!plainLink || actionLike)) score += 180;
  else if (passkeyProvider && (!plainLink || actionLike)) score += 180;
  else if (otherProvider && (!plainLink || actionLike)) score += 140;
  else if (githubProvider || passkeyProvider || otherProvider) score += 40;
  if (actionLike) score += 90;
  if (authLikeTarget) score += 80;
  if (element instanceof HTMLAnchorElement) score += 10;
  if (element instanceof HTMLInputElement && element.type === 'submit') score -= 80;
  if (LOGIN_ACTION_HINT.test(actionText(element))) score -= 120;
  if (NON_OAUTH_ACTION_HINT.test(text)) score -= 180;

  return score;
}

type ExternalLoginMethod = Extract<LoginMethod, 'oauth' | 'github' | 'passkey'>;

function isDisabledAction(element: HTMLElement): boolean {
  return element.getAttribute('aria-disabled') === 'true'
    || (element instanceof HTMLButtonElement && element.disabled)
    || (element instanceof HTMLInputElement && element.disabled);
}

export function findAutomaticOAuthButton(method: ExternalLoginMethod): HTMLElement | null {
  const candidates = [...document.querySelectorAll<HTMLElement>(
    'button, a[href], [role="button"], input[type="button"], input[type="submit"]',
  )].filter((element) => isVisible(element));

  const providerCandidates = candidates.filter((element) => {
    const text = oauthText(element);
    if (method === 'github') return GITHUB_OAUTH_HINT.test(text);
    if (method === 'passkey') return PASSKEY_HINT.test(text);
    return true;
  });

  const ranked = providerCandidates
    .map((element) => ({
      element,
      score: oauthScore(element),
      label: buttonLabel(element),
      disabled: isDisabledAction(element),
    }))
    .filter(({ score }) => score >= 100)
    // 同一提供商有多个入口时优先可点击的；若全部禁用，仍返回语义最明确的
    // 那个，供上层先处理协议并给出准确诊断，而不是误报「没有 GitHub 按钮」。
    .sort((a, b) => Number(a.disabled) - Number(b.disabled)
      || b.score - a.score
      || a.label.length - b.label.length);

  return ranked[0]?.element ?? null;
}

async function waitForOAuthButton(
  site: SiteConfig,
  timeout: number,
  method: ExternalLoginMethod,
): Promise<OAuthButtonMatch | null> {
  const deadline = Date.now() + timeout;
  let disabledMatch: OAuthButtonMatch | null = null;
  while (Date.now() < deadline) {
    const configuredSelector = site.oauthButtonSelector?.trim();
    const element = configuredSelector
      ? queryFirst<HTMLElement>(configuredSelector)
      : findAutomaticOAuthButton(method);
    if (element && isVisible(element)) {
      const match = { element, automatic: !configuredSelector };
      if (!isDisabledAction(element)) return match;
      disabledMatch = match;
    }
    await sleep(200);
  }
  return disabledMatch;
}

function checkboxSemanticText(element: HTMLInputElement): string {
  const labels = [...(element.labels ?? [])].map((label) => label.textContent ?? '');
  const labelledBy = (element.getAttribute('aria-labelledby') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '');
  return [
    element.id,
    element.name,
    element.getAttribute('aria-label'),
    element.closest('label')?.textContent,
    element.closest('.semi-checkbox')?.textContent,
    element.parentElement?.textContent,
    ...labels,
    ...labelledBy,
  ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Semi UI 等组件会把原生 checkbox 设为透明，只展示外层控件。
 * input 本身不可见不代表用户看不到该选项；但外层也不可见时仍拒绝操作。
 */
function visibleCheckboxShell(element: HTMLInputElement): HTMLElement | null {
  if (isVisible(element)) return element;

  const candidates = [
    element.closest<HTMLElement>('label'),
    element.closest<HTMLElement>('[role="checkbox"]'),
    element.closest<HTMLElement>('.semi-checkbox'),
    element.parentElement,
  ];
  return candidates.find((candidate): candidate is HTMLElement => !!candidate && isVisible(candidate)) ?? null;
}

function isChallengeCheckbox(element: HTMLInputElement): boolean {
  return CHALLENGE_CHECKBOX_HINT.test(checkboxSemanticText(element));
}

function roleCheckboxSemanticText(element: HTMLElement): string {
  return [
    actionText(element),
    element.id,
    element.closest('label')?.textContent,
    element.parentElement?.textContent,
  ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function hasPendingLoginConsent(scope: ParentNode): boolean {
  const nativeConsent = [...scope.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    .some((element) => (
      !element.disabled
      && !element.checked
      && Boolean(visibleCheckboxShell(element))
      && CONSENT_HINT.test(checkboxSemanticText(element))
      && !isChallengeCheckbox(element)
    ));
  if (nativeConsent) return true;

  return [...scope.querySelectorAll<HTMLElement>('[role="checkbox"]')].some((element) => (
    isVisible(element)
    && element.getAttribute('aria-checked') !== 'true'
    && !isDisabledAction(element)
    && CONSENT_HINT.test(roleCheckboxSemanticText(element))
    && !CHALLENGE_CHECKBOX_HINT.test(roleCheckboxSemanticText(element))
  ));
}

/** 只勾选语义明确的登录协议框，绝不碰 CAPTCHA / Turnstile。 */
async function acceptLoginConsent(scope: ParentNode, log: StepLog): Promise<boolean> {
  const checkbox = [...scope.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((element) => {
    if (element.disabled || element.checked || !visibleCheckboxShell(element)) return false;
    const text = checkboxSemanticText(element);
    return CONSENT_HINT.test(text) && !CHALLENGE_CHECKBOX_HINT.test(text);
  });
  if (!checkbox) {
    const roleCheckbox = [...scope.querySelectorAll<HTMLElement>('[role="checkbox"]')].find((element) => {
      if (!isVisible(element) || element.getAttribute('aria-checked') === 'true' || isDisabledAction(element)) {
        return false;
      }
      const text = roleCheckboxSemanticText(element);
      return CONSENT_HINT.test(text) && !CHALLENGE_CHECKBOX_HINT.test(text);
    });
    if (!roleCheckbox) return false;

    await realClick(roleCheckbox);
    await sleep(100);
    const checked = roleCheckbox.getAttribute('aria-checked') === 'true'
      || !!roleCheckbox.querySelector<HTMLInputElement>('input[type="checkbox"]:checked');
    if (!checked) return false;
    log.push('已勾选登录协议与隐私政策');
    return true;
  }

  // 直接点击原生 input 最可靠：即使它被组件设为 opacity:0，浏览器仍会按
  // checkbox 的原生语义切换 checked 并派发 change，React/Semi UI 能收到。
  domClick(checkbox);
  if (!checkbox.checked) {
    // 少数组件拦截 input，只把处理器绑在可见壳上；仅在首次点击没有切换时
    // 才点击壳，避免双击把已经勾上的协议又取消。
    const shell = visibleCheckboxShell(checkbox);
    if (shell && shell !== checkbox) await realClick(shell);
  }
  if (!checkbox.checked && checkbox.getAttribute('aria-checked') !== 'true') return false;
  log.push('已勾选登录协议与隐私政策');
  return true;
}

function findSubmit(configuredSelector: string, scope: ParentNode): SubmitMatch | null {
  const configured = queryFirst<HTMLElement>(configuredSelector);
  const candidates = [...scope.querySelectorAll<HTMLElement>('button, input[type="submit"], [role="button"]')]
    .filter((element) => isVisible(element));
  const ranked = candidates.map((element) => {
    const text = actionText(element);
    const type = element.getAttribute('type')?.toLowerCase();
    let score = 0;
    if (element === configured || matchesSelector(element, configuredSelector)) score += 180;
    if (type === 'submit') score += 90;
    if (LOGIN_ACTION_HINT.test(text)) score += 90;
    if (CONTINUE_ACTION_HINT.test(text)) score += 60;
    if (NON_LOGIN_ACTION_HINT.test(text)) score -= 200;
    if (REGISTRATION_CONTEXT_HINT.test(text)) score -= 120;
    if (element.hasAttribute('aria-expanded')) score -= 100;
    return { element, score, fallback: element !== configured && !matchesSelector(element, configuredSelector) };
  }).sort((a, b) => b.score - a.score);

  const best = ranked[0];
  return best && best.score >= 80 ? { element: best.element, fallback: best.fallback } : null;
}

async function waitForSubmit(configuredSelector: string, scope: ParentNode, timeout: number): Promise<SubmitMatch | null> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const match = findSubmit(configuredSelector, scope);
    if (match) return match;
    await sleep(200);
  }
  return null;
}

export function detectManualLoginStep(): string | null {
  return queryFirst(MANUAL_LOGIN_SELECTORS) ? '二次验证验证码' : null;
}

function leftLoginPath(site: SiteConfig): boolean {
  try {
    const login = new URL(site.loginUrl);
    const current = new URL(location.href);
    const normalize = (path: string) => path.replace(/\/+$/, '') || '/';
    if (current.origin !== login.origin) return false;

    const currentRoute = `${current.pathname}${current.hash}`;
    if (UNSAFE_RESULT_PATH.test(currentRoute)) return false;
    if (normalize(current.pathname) !== normalize(login.pathname)) return true;

    // hash SPA 的文档路径不会变化，例如 `/app/#/login` → `/app/#/dashboard`。
    // 登录地址本身带 hash 时，比较 hash 路由即可覆盖所有这类框架，不需要按域名特判。
    const loginHash = normalize(login.hash.replace(/^#/, ''));
    const currentHash = normalize(current.hash.replace(/^#/, ''));
    return loginHash !== '/' && currentHash !== '/' && currentHash !== loginHash;
  } catch {
    return false;
  }
}

/**
 * 当前页**此刻**是否显示着已登录的站内证据（只读，不等待、不点击）。
 *
 * 判据与 `detectAlreadyLoggedIn` 的单次判断相同。给只想交叉核对一眼的调用方用，
 * 例如「退出后站点接口仍报有会话」时确认页面是不是真的还停在站内。
 */
export function pageShowsSignedIn(site: SiteConfig): boolean {
  return hasAuthenticatedPageEvidence(site);
}

function hasAuthenticatedPageEvidence(site: SiteConfig): boolean {
  /**
   * 判据分三档，顺序就是可信度：
   * 1. 登录表单的**强证据**（密码框 / 有账号语义的输入框 / 二次验证框）→ 没登录。
   *    排在 successIndicator 之前：站点配的成功标志可能过宽（Element Plus 的通用按钮
   *    类名在登录页上也有），页面上摆着密码框时任何「成功标志」都不可信；
   * 2. 站内正证据（成功标志、站点配置的签到按钮、同源签到链接、已离开登录路径）→ 已登录；
   * 3. 只剩一个同源「登录」链接 → 没登录。它是**弱**证据：已登录的页头、页脚也常留着
   *    /login 链接，所以只在没有任何站内正证据时才作数。
   */
  if (hasStrongLoginFormEvidence(site) || detectManualLoginStep()) return false;
  if (site.successIndicator && queryFirst(site.successIndicator)) return true;
  const checkin = site.checkin;
  if (checkin?.method === 'button' && (
    (checkin.buttonSelector && queryFirst(checkin.buttonSelector))
    || (checkin.alreadySelector && queryFirst(checkin.alreadySelector))
  )) return true;
  if (hasSameOriginCheckinLink()) return true;
  if (leftLoginPath(site)) return true;
  // 孤零零的文本框（站点配了裸 input[type=text] 时也会命中）同样只是弱证据。
  if (findLoginCredentialInput(site)) return false;
  if (findSameOriginLoginLink()) return false;
  if (checkin?.method === 'api') return true;
  return false;
}

/**
 * 步骤一：关闭站点弹出的公告 / 弹窗。
 *
 * 实现在 announcements.ts，因为公告不是「登录前点一下」这么简单：
 * 它在登录后、进签到页时都会再次出现，而且是 SPA 拉完接口才渲染的，
 * 需要真的等而不是扫一次就走。
 *
 * @param waitForAppear 登录成功后、进入签到页后传 true（公告此刻还没渲染出来）
 */
export async function closeAnnouncements(
  site: SiteConfig,
  log: StepLog,
  options?: { waitForAppear?: boolean },
): Promise<void> {
  await dismissAnnouncements(site, log, options);
}

/** 同意必需条款用的词表：命中同意词 + 页面有条款语境 + 排除拒绝，才点 */
const CONSENT_ACCEPT_WORDS = ['同意并继续', '同意并登录', '同意并进入', '我已阅读并同意', '接受并继续', 'agree and continue', 'accept and continue'];
const CONSENT_CONTEXT_WORDS = /条款|协议|服务条款|条款更新|terms|agreement|policy|隐私/i;
const CONSENT_REJECT_WORDS = /拒绝|不同意|取消|decline|cancel|reject/i;

/**
 * 处理「必须先同意条款才能登录」的前置弹窗（如登仙公益站的条款更新通知）。
 *
 * 这类弹窗在同意前会禁用账密输入框和快捷登录，扩展不点「同意并继续」就会
 * 卡在「找不到密码框」。为避免误点，要求：页面确有条款语境、按钮文案是明确
 * 的「同意…」而非「拒绝/取消」。只点一次。
 */
async function acceptRequiredConsent(log: StepLog): Promise<boolean> {
  const bodyText = document.body?.innerText ?? '';
  if (!CONSENT_CONTEXT_WORDS.test(bodyText)) return false;
  for (const btn of document.querySelectorAll<HTMLElement>('button, [role="button"]')) {
    if (!isVisible(btn)) continue;
    const raw = (btn.innerText || btn.textContent || '').trim();
    const text = raw.replace(/\s+/g, '').toLowerCase();
    if (!text || CONSENT_REJECT_WORDS.test(text)) continue;
    if (CONSENT_ACCEPT_WORDS.some((word) => text.includes(word.replace(/\s+/g, '').toLowerCase()))) {
      // 条款弹窗常盖着半透明遮罩层，realClick 的坐标遮挡检测会把它误判成「被遮挡」。
      // 遮挡时兜底直接对按钮派发点击：绕过坐标命中，照样触发它的 onClick。
      try {
        await realClick(btn);
      } catch {
        domClick(btn);
      }
      log.push(`已点击「${raw.slice(0, 20)}」同意必需条款以解锁登录`);
      await sleep(800);
      return true;
    }
  }
  return false;
}

/**
 * 解锁登录页所需的条款弹窗与协议复选框。
 *
 * 表单提交和第三方登录入口共用这一步，避免一个能登录、另一个因为按钮禁用而
 * 被误判为不存在。复选框匹配仍由 acceptLoginConsent 的严格语义与验证码排除
 * 规则负责，不会点击 Turnstile / CAPTCHA。
 */
export async function ensureLoginConsent(
  log: StepLog,
  scope: ParentNode = document,
  hooks: PageActionHooks = {},
): Promise<boolean> {
  const hasRequiredConsent = CONSENT_CONTEXT_WORDS.test(document.body?.innerText ?? '')
    && [...document.querySelectorAll<HTMLElement>('button, [role="button"]')].some((btn) => {
      if (!isVisible(btn)) return false;
      const text = (btn.innerText || btn.textContent || '').trim().replace(/\s+/g, '').toLowerCase();
      return Boolean(text)
        && !CONSENT_REJECT_WORDS.test(text)
        && CONSENT_ACCEPT_WORDS.some((word) => text.includes(word.replace(/\s+/g, '').toLowerCase()));
    });
  if (hasRequiredConsent) {
    const auxiliary = hooks.beforeAuxiliaryClick ?? hooks.beforeClick;
    if (auxiliary && !await auxiliary()) {
      throw new Error('处理登录协议前的人机验证未完成，已停止页面操作');
    }
  }
  const acceptedRequired = await acceptRequiredConsent(log);
  const hasConsentCheckbox = hasPendingLoginConsent(scope)
    || (scope !== document && hasPendingLoginConsent(document));
  if (hasConsentCheckbox) {
    const auxiliary = hooks.beforeAuxiliaryClick ?? hooks.beforeClick;
    if (auxiliary && !await auxiliary()) {
      throw new Error('勾选登录协议前的人机验证未完成，已停止页面操作');
    }
  }
  const accepted = await acceptLoginConsent(scope, log)
    || (scope !== document && await acceptLoginConsent(document, log));
  if (accepted) await sleep(200);
  return acceptedRequired || accepted;
}

/**
 * 登录表单前置点击。
 *
 * new-api 新版和 Agent Router 的登录页默认只显示 OAuth 按钮，
 * 账密表单藏在「使用 邮箱或用户名 登录」后面。找不到就跳过 ——
 * 老版本站点本来就直接显示表单。
 */
/**
 * 点开「展开账密表单」这类前置按钮。
 *
 * 这些按钮常被站点公告的半透明遮罩或紧邻的说明段落盖住中心点，
 * realClick 的坐标命中检测会直接抛「目标控件被 p 遮挡」，登录还没开始就中断。
 * 先尝试清掉遮挡；仍被挡时兜底派发 DOM 点击 —— 它不经过坐标命中，
 * 依然能触发按钮自己的 onClick，只是拿不到可信指针语义。
 *
 * 只用于「展开表单 / 展开第三方登录入口」这类纯界面切换，不用于提交登录或
 * 签到动作，那些仍要求可信指针，避免产生站点收不到交互的假成功。
 */
async function clickRevealControl(
  element: HTMLElement,
  site: SiteConfig,
  log: StepLog,
  label = '账密表单入口',
): Promise<void> {
  const blocker = await clearClickBlocker(element, site, log, label);
  if (!blocker) {
    try {
      await realClick(element);
      return;
    } catch (error) {
      log.push(`可信点击${label}失败（${error instanceof Error ? error.message : String(error)}），改用 DOM 点击`);
    }
  } else {
    log.push(`${label}仍被 ${describeElement(blocker)} 遮挡，改用 DOM 点击`);
  }
  domClick(element);
}

function loginRevealSelectors(site: SiteConfig): string[] {
  const selectors = (site.preLoginClickSelectors ?? []).map((selector) => selector.trim()).filter(Boolean);
  const legacy = site.preLoginClickSelector?.trim();
  if (legacy && selectors.at(-1) !== legacy) selectors.push(legacy);
  return selectors;
}

export async function revealLoginForm(
  site: SiteConfig,
  log: StepLog,
  hooks: PageActionHooks = {},
): Promise<void> {
  // 有的站（登仙公益站）登录页先弹「条款更新」弹窗，未点「同意并继续」前账密
  // 输入框保持禁用，后续会卡在「找不到密码框」。先处理这个前置同意。
  await ensureLoginConsent(log, document, hooks);

  // 表单已经在了就不用点
  if (findLoginCredentialInput(site)) {
    log.push('账密表单已可见，无需前置点击');
    return;
  }

  const revealSelectors = loginRevealSelectors(site);
  for (const [index, selector] of revealSelectors.entries()) {
    let btn = await waitFor<HTMLElement>(selector, 6_000);
    if (btn) {
      await requirePageAction(hooks, '展开账密表单');
      btn = await waitFor<HTMLElement>(selector, 6_000);
      if (!btn) throw new Error('完成人机验证后账密表单入口已不存在');
      await clickRevealControl(btn, site, log);
      log.push(`已点击「${btn.textContent?.trim().slice(0, 20)}」展开账密表单`);
      const revealed = index === revealSelectors.length - 1
        ? await waitForLoginCredentialInput(site, 5_000)
        : findLoginCredentialInput(site);
      if (revealed) return;
    } else {
      log.push(`未找到前置按钮(${selector})，继续查找登录页入口`);
    }
  }

  // 没配前置按钮、或配了没点开：自动识别 new-api 新版那类「使用 邮箱或用户名 登录」
  // 按钮 —— 这类站点登录页默认只显示 OAuth，账密表单藏在它后面，不点开就永远
  // 「找不到密码输入框」。
  let revealBtn = findRevealPasswordFormButton();
  if (revealBtn) {
    await requirePageAction(hooks, '展开账密表单');
    revealBtn = findRevealPasswordFormButton();
  }
  if (revealBtn) {
    const label = (revealBtn.innerText || revealBtn.textContent || '').trim().slice(0, 20);
    await clickRevealControl(revealBtn, site, log);
    log.push(`已点击「${label}」展开账密表单`);
    if (await waitForLoginCredentialInput(site, 5_000)) return;
  }

  // 书签通常保存站点首页。若表单不在首页，进入同源的明确登录链接。
  let loginLink = findSameOriginLoginLink();
  if (!loginLink) return;

  await requirePageAction(hooks, '进入登录页');
  loginLink = findSameOriginLoginLink();
  if (!loginLink) throw new Error('完成人机验证后登录页入口已不存在');

  const target = new URL(loginLink.href, location.href);
  log.push(`当前页没有账密表单，已进入登录页: ${target.pathname}`);
  const blocker = await clearClickBlocker(loginLink, site, log, '登录页入口');
  if (blocker) {
    throw new Error(`登录页入口被${describeElement(blocker)}遮挡，可能有未关闭的公告弹窗`);
  }
  loginLink = findSameOriginLoginLink();
  if (!loginLink) throw new Error('关闭遮挡后登录页入口已不存在');
  await realClick(loginLink, { mayNavigate: true });
  await waitForLoginCredentialInput(site, 5_000);
}

/**
 * 进入第三方登录入口所在页面，但绝不展开或切换到账密表单。
 *
 * GitHub/OAuth 与 form 的账号意图已经在任务启动时确定。第三方路径若复用
 * revealLoginForm，遇到默认同时展示 OAuth 与“邮箱登录”入口的页面，会先点后者
 * 并把 OAuth 区域隐藏，随后自然找不到用户指定的 GitHub 按钮。
 *
 * 唯一允许的前置点击是**学习时演示过的「OAuth 入口前置动作」**（存在
 * `preLoginClickSelector` 且与 OAuth 按钮配套写入）：切换「其他登录方式」标签页
 * 这类动作会让 OAuth 按钮出现，缺了它按钮永远是隐藏的。限制两条：
 * 只在该按钮当前不可见时才点；点击后按钮仍不出现就继续走原有的登录链接逻辑。
 */
export async function revealExternalLogin(
  site: SiteConfig,
  log: StepLog,
  method: ExternalLoginMethod,
  hooks: PageActionHooks = {},
): Promise<void> {
  await ensureLoginConsent(log, document, hooks);

  const configuredSelector = site.oauthButtonSelector?.trim();
  const findOAuthEntry = () => (configuredSelector
    ? queryFirst<HTMLElement>(configuredSelector)
    : findAutomaticOAuthButton(method));
  const existing = findOAuthEntry();
  if (existing && isVisible(existing)) {
    log.push('第三方登录入口已可见，无需展开账密表单');
    return;
  }

  // 学过的入口前置点击：只在 OAuth 按钮不可见时尝试，绝不主动切换已经显示的区域。
  const revealSelectors = loginRevealSelectors(site);
  for (const preLogin of configuredSelector ? revealSelectors : []) {
    let control = await waitFor<HTMLElement>(preLogin, 6_000);
    if (control && isVisible(control)) {
      await requirePageAction(hooks, '展开第三方登录入口');
      control = await waitFor<HTMLElement>(preLogin, 6_000);
      if (!control) throw new Error('完成人机验证后第三方登录入口已不存在');
      const label = (control.innerText || control.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 20);
      await clickRevealControl(control, site, log, '第三方登录入口');
      log.push(`已点击「${label}」展开第三方登录入口`);
      const revealed = findOAuthEntry();
      if (revealed && isVisible(revealed)) return;
      log.push('点击第三方登录入口后 OAuth 按钮仍未出现，继续查找登录页入口');
    }
  }

  let loginLink = findSameOriginLoginLink();
  if (!loginLink) return;

  await requirePageAction(hooks, '进入第三方登录页');
  loginLink = findSameOriginLoginLink();
  if (!loginLink) throw new Error('完成人机验证后第三方登录页入口已不存在');

  const target = new URL(loginLink.href, location.href);
  log.push(`当前页没有第三方登录入口，已进入登录页: ${target.pathname}`);
  const blocker = await clearClickBlocker(loginLink, site, log, '第三方登录页入口');
  if (blocker) {
    throw new Error(`第三方登录页入口被${describeElement(blocker)}遮挡，可能有未关闭的公告弹窗`);
  }
  loginLink = findSameOriginLoginLink();
  if (!loginLink) throw new Error('关闭遮挡后第三方登录页入口已不存在');
  await realClick(loginLink, { mayNavigate: true });
}

/**
 * 步骤二：填写用户名和密码。
 * 用 native setter + 派发事件，确保 React/Vue 受控组件能收到值。
 */
export async function fillCredentials(
  site: SiteConfig,
  username: string,
  password: string,
  log: StepLog,
  beforeAction?: () => Promise<boolean>,
  beforeAuxiliaryAction?: () => Promise<boolean>,
): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  let passwordMatch: InputMatch | null = null;
  let usernameMatch: InputMatch | null = null;

  while (Date.now() < deadline) {
    passwordMatch = findPasswordInput(site.selectors.password, document);
    if (passwordMatch) break;
    usernameMatch = findUsernameInput(site.selectors.username, document);
    if (usernameMatch) break;
    await sleep(200);
  }

  // Field assignment is passive. Challenge handling is reserved for the next
  // committing page action (multi-step continue or final submit), so a hidden
  // response field cannot block an otherwise usable login form.
  passwordMatch = findPasswordInput(site.selectors.password, document);
  usernameMatch = passwordMatch
    ? findUsernameInput(site.selectors.username, passwordMatch.element.form ?? document, passwordMatch.element)
    : findUsernameInput(site.selectors.username, document);

  if (passwordMatch) {
    const formScope = passwordMatch.element.form ?? document;
    if (usernameMatch) {
      if (usernameMatch.fallback) {
        log.push(`已通过页面语义识别用户名输入框: ${inputIdentity(usernameMatch)}`);
      }
      setNativeValue(usernameMatch.element, username);
      log.push('已填写用户名');
      await sleep(120);

      passwordMatch = findPasswordInput(site.selectors.password, document);
      if (!passwordMatch) {
        log.push('填写用户名后密码输入框已不存在');
        return false;
      }
    } else {
      log.push('当前是密码步骤，页面未要求再次填写用户名');
    }

    if (passwordMatch.fallback) {
      log.push(`已通过页面语义识别密码输入框: ${inputIdentity(passwordMatch)}`);
    }
    setNativeValue(passwordMatch.element, password);
    log.push('已填写密码');
    return true;
  }

  if (!usernameMatch) {
    log.push('页面能力扫描未找到可用的用户名或密码输入框');
    return false;
  }

  if (usernameMatch.fallback) {
    log.push(`已通过页面语义识别用户名输入框: ${inputIdentity(usernameMatch)}`);
  }
  setNativeValue(usernameMatch.element, username);
  log.push('已填写用户名，等待页面显示密码步骤');
  await sleep(250);

  passwordMatch = findPasswordInput(site.selectors.password, document);
  if (!passwordMatch) {
    const formScope = usernameMatch.element.form ?? document;
    let advance = await waitForSubmit(site.selectors.submit, formScope, 5_000);
    if (!advance) {
      log.push('用户名步骤后未找到语义明确的「继续/下一步」控件');
      return false;
    }
    await ensureLoginConsent(log, formScope, {
      beforeClick: beforeAuxiliaryAction ?? beforeAction,
    });
    if (await beforeAction?.() === false) {
      log.push('用户名步骤前的安全验证未完成');
      return false;
    }

    // 验证完成可能替换整张表单；重新找用户名步骤的动作控件，不能点击旧引用。
    const currentUsername = findUsernameInput(site.selectors.username, document);
    const refreshedScope = currentUsername?.element.form ?? document;
    const refreshedAdvance = await waitForSubmit(site.selectors.submit, refreshedScope, 5_000);
    if (!refreshedAdvance) {
      log.push('安全验证完成后用户名步骤的继续按钮已不存在');
      return false;
    }
    advance = refreshedAdvance;

    const enableDeadline = Date.now() + 3_000;
    while (isDisabledAction(advance.element) && Date.now() < enableDeadline) {
      await sleep(150);
      advance = findSubmit(site.selectors.submit, refreshedScope) ?? advance;
    }
    if (isDisabledAction(advance.element)) {
      log.push('用户名步骤的继续按钮仍处于禁用状态');
      return false;
    }

    const blocker = await clearClickBlocker(advance.element, site, log, '用户名步骤控件');
    if (blocker) {
      log.push(`用户名步骤控件被${describeElement(blocker)}遮挡，已停止继续操作`);
      return false;
    }
    const liveUsername = findUsernameInput(site.selectors.username, document);
    const liveAdvance = findSubmit(site.selectors.submit, liveUsername?.element.form ?? document);
    if (!liveAdvance || isDisabledAction(liveAdvance.element)) {
      log.push('关闭遮挡后用户名步骤的继续按钮已不存在或不可用');
      return false;
    }
    advance = liveAdvance;
    log.push(`已识别并点击用户名步骤控件: ${buttonLabel(advance.element).slice(0, 30)}`);
    await realClick(advance.element, { mayNavigate: true });
    passwordMatch = await waitForPasswordInput(site.selectors.password, 8_000);
  }

  if (!passwordMatch) {
    log.push('完成用户名步骤后仍未出现可识别的密码输入框');
    return false;
  }
  passwordMatch = findPasswordInput(site.selectors.password, document);
  if (!passwordMatch) {
    log.push('密码输入框已不存在');
    return false;
  }
  if (passwordMatch.fallback) {
    log.push(`已通过页面语义识别密码输入框: ${inputIdentity(passwordMatch)}`);
  }
  setNativeValue(passwordMatch.element, password);
  log.push('已填写密码');
  return true;
}

/**
 * 步骤三：提交登录。
 * 优先点提交按钮；找不到按钮则在密码框内回车兜底。
 */
export async function submitLogin(
  site: SiteConfig,
  log: StepLog,
  hooks: PageActionHooks = {},
): Promise<boolean> {
  await sleep(200);

  let passwordMatch = findPasswordInput(site.selectors.password, document);
  let formScope: ParentNode = passwordMatch?.element.form ?? document;
  let submitMatch = await waitForSubmit(site.selectors.submit, formScope, 5_000);
  if (submitMatch) {
    // Agreement controls are a real prerequisite even on sites that leave the
    // submit button enabled and reject unchecked consent only after submission.
    // The helper is inert when no consent UI exists and uses visible-only
    // challenge handling for the auxiliary agreement click.
    await ensureLoginConsent(log, formScope, hooks);

    if (hooks.beforeClick && !await hooks.beforeClick()) {
      log.push('登录提交前的安全验证未完成，已停止点击');
      return false;
    }

    // 验证控件完成后表单可能整体重绘，旧按钮引用不可继续使用。
    passwordMatch = findPasswordInput(site.selectors.password, document);
    formScope = passwordMatch?.element.form ?? document;
    submitMatch = await waitForSubmit(site.selectors.submit, formScope, 5_000);
    if (!submitMatch) {
      log.push('安全验证完成后找不到登录按钮');
      return false;
    }

    let control = submitMatch.element as HTMLButtonElement | HTMLInputElement;
    // 按钮可能因校验未通过而 disabled，等它启用
    const deadline = Date.now() + 3_000;
    while (isDisabledAction(control) && Date.now() < deadline) {
      await sleep(150);
      submitMatch = findSubmit(site.selectors.submit, formScope) ?? submitMatch;
      control = submitMatch.element as HTMLButtonElement | HTMLInputElement;
    }
    if (isDisabledAction(control)) {
      log.push('登录按钮仍处于禁用状态，页面可能还有未满足的校验项');
      return false;
    }

    const blocker = await clearClickBlocker(submitMatch.element, site, log, '登录按钮');
    if (blocker) {
      log.push(`登录按钮被${describeElement(blocker)}遮挡，停止本次提交`);
      return false;
    }

    // 关闭公告可能触发登录区域重绘；点击前重新取一次当前按钮，避免把
    // 遮挡清理前的旧节点交给可信指针。
    passwordMatch = findPasswordInput(site.selectors.password, document);
    formScope = passwordMatch?.element.form ?? document;
    submitMatch = await waitForSubmit(site.selectors.submit, formScope, 1_500);
    if (!submitMatch) {
      log.push('关闭遮挡后找不到登录按钮');
      return false;
    }
    control = submitMatch.element as HTMLButtonElement | HTMLInputElement;
    if (isDisabledAction(control)) {
      log.push('关闭遮挡后登录按钮变为禁用状态，未执行提交');
      return false;
    }

    const lateBlocker = await clearClickBlocker(submitMatch.element, site, log, '登录按钮');
    if (lateBlocker) {
      log.push(`登录按钮被${describeElement(lateBlocker)}遮挡，停止本次提交`);
      return false;
    }

    passwordMatch = findPasswordInput(site.selectors.password, document);
    formScope = passwordMatch?.element.form ?? document;
    submitMatch = await waitForSubmit(site.selectors.submit, formScope, 1_500);
    if (!submitMatch) {
      log.push('最终点击前找不到登录按钮');
      return false;
    }
    control = submitMatch.element as HTMLButtonElement | HTMLInputElement;
    if (isDisabledAction(control)) {
      log.push('最终点击前登录按钮变为禁用状态，未执行提交');
      return false;
    }

    // 顺序很关键：先写日志 → 再落地信箱（含这行日志）→ 最后才点击。
    // 整页跳转会立刻销毁本脚本，任何在点击之后的 push 都进不了信箱。
    if (submitMatch.fallback) log.push('配置的登录按钮选择器未命中，已通过表单语义识别');
    log.push('已点击登录按钮');
    await hooks.beforeNavigate?.();
    const clickMode = await realClick(submitMatch.element, { mayNavigate: true });
    log.push(clickMode === 'trusted'
      ? '登录按钮已收到浏览器可信点击'
      : '登录按钮已通过 DOM 点击（未使用浏览器可信指针）');
    if (hooks.afterClick && !await hooks.afterClick()) {
      log.push('登录提交后的安全验证未完成');
      return false;
    }
    // 若 SPA 没有离开登录页，立即记录页面自己的反馈。这样能区分
    // “点击没到达”“React 表单状态为空”和“服务端拒绝登录”，且不输出凭据。
    await sleep(450);
    const feedback = visibleLoginFeedback();
    if (feedback) log.push(`登录页面反馈：${feedback}`);
    log.push(loginRequestObserved() ? '页面已发起登录接口请求' : '页面未发起登录接口请求');
    return true;
  }

  if (passwordMatch) {
    await ensureLoginConsent(log, passwordMatch.element.form ?? document, hooks);
    if (hooks.beforeClick && !await hooks.beforeClick()) {
      log.push('回车提交前的安全验证未完成，已停止提交');
      return false;
    }
    passwordMatch = findPasswordInput(site.selectors.password, document);
    if (!passwordMatch) {
      log.push('安全验证完成后密码输入框已不存在，未执行回车提交');
      return false;
    }
    const blocker = await clearClickBlocker(passwordMatch.element, site, log, '密码输入框');
    if (blocker) {
      log.push(`密码输入框被${describeElement(blocker)}遮挡，未执行回车提交`);
      return false;
    }
    log.push('未找到登录按钮，已在密码框回车提交');
    await hooks.beforeNavigate?.();
    pressEnter(passwordMatch.element);
    if (hooks.afterClick && !await hooks.afterClick()) {
      log.push('回车提交后的安全验证未完成');
      return false;
    }
    return true;
  }

  log.push(`找不到登录按钮: ${site.selectors.submit}`);
  return false;
}

/**
 * Some challenge-first forms use the first submit click only to mount a
 * slider. After the slider is accepted, the application leaves the completed
 * form in place and requires one fresh click to send the login request.
 *
 * The engine owns the strict site/challenge/one-shot guards. This helper only
 * revalidates the live form and emits that single trusted click; it never loops.
 */
export async function resubmitLoginAfterResolvedChallenge(
  site: SiteConfig,
  log: StepLog,
  hooks: PageActionHooks = {},
): Promise<LoginResubmitOutcome> {
  // Give the challenge success callback time to auto-submit before considering
  // a second click. Resource Timing entries can appear slightly after release.
  await sleep(900);
  if (loginRequestObserved()) {
    log.push('滑块通过后已观察到登录请求，无需再次点击登录按钮');
    return 'not-needed';
  }

  const failure = visibleLoginFailureFeedback();
  if (failure) {
    log.push(`登录页面已明确返回失败，不重复提交：${failure}`);
    return 'blocked';
  }

  let passwordMatch = findPasswordInput(site.selectors.password, document);
  if (!passwordMatch) {
    log.push('滑块通过后账密表单已离开，无需再次点击登录按钮');
    return 'not-needed';
  }
  if (!passwordMatch.element.value) {
    log.push('滑块通过后密码输入框已被页面清空，已停止重复提交');
    return 'blocked';
  }

  let formScope: ParentNode = passwordMatch.element.form ?? document;
  let submitMatch = await waitForSubmit(site.selectors.submit, formScope, 2_000);
  if (!submitMatch) {
    log.push('滑块通过后登录按钮已不存在，无需再次点击');
    return 'not-needed';
  }

  const enableDeadline = Date.now() + 2_000;
  while (isDisabledAction(submitMatch.element) && Date.now() < enableDeadline) {
    await sleep(150);
    passwordMatch = findPasswordInput(site.selectors.password, document);
    if (!passwordMatch) return 'not-needed';
    formScope = passwordMatch.element.form ?? document;
    submitMatch = findSubmit(site.selectors.submit, formScope) ?? submitMatch;
  }
  if (isDisabledAction(submitMatch.element)) {
    log.push('滑块通过后登录按钮仍未恢复可用，未执行重复点击');
    return 'blocked';
  }

  // Recheck immediately before the click. The challenge callback may have
  // submitted while the form/button was being reacquired.
  if (loginRequestObserved()) {
    log.push('重新定位登录按钮期间页面已发起登录请求，无需再次点击');
    return 'not-needed';
  }
  const lateFailure = visibleLoginFailureFeedback();
  if (lateFailure) {
    log.push(`重新点击前页面已明确返回登录失败：${lateFailure}`);
    return 'blocked';
  }

  // The challenge may have replaced the form a second time. Never reuse the
  // element captured above without one final live lookup.
  passwordMatch = findPasswordInput(site.selectors.password, document);
  if (!passwordMatch?.element.value) return passwordMatch ? 'blocked' : 'not-needed';
  formScope = passwordMatch.element.form ?? document;
  submitMatch = findSubmit(site.selectors.submit, formScope);
  if (!submitMatch || isDisabledAction(submitMatch.element)) return 'blocked';

  const blocker = await clearClickBlocker(submitMatch.element, site, log, '滑块通过后的登录按钮');
  if (blocker) {
    log.push(`滑块通过后的登录按钮被${describeElement(blocker)}遮挡，未重复提交`);
    return 'blocked';
  }

  // 公告关闭后页面可能重绘表单，最后一次取活按钮再点击。
  passwordMatch = findPasswordInput(site.selectors.password, document);
  if (!passwordMatch?.element.value) return passwordMatch ? 'blocked' : 'not-needed';
  formScope = passwordMatch.element.form ?? document;
  submitMatch = findSubmit(site.selectors.submit, formScope);
  if (!submitMatch || isDisabledAction(submitMatch.element)) return 'blocked';

  const lateBlocker = await clearClickBlocker(submitMatch.element, site, log, '滑块通过后的登录按钮');
  if (lateBlocker) {
    log.push(`滑块通过后的登录按钮被${describeElement(lateBlocker)}遮挡，未重复提交`);
    return 'blocked';
  }

  passwordMatch = findPasswordInput(site.selectors.password, document);
  if (!passwordMatch?.element.value) return passwordMatch ? 'blocked' : 'not-needed';
  formScope = passwordMatch.element.form ?? document;
  submitMatch = findSubmit(site.selectors.submit, formScope);
  if (!submitMatch || isDisabledAction(submitMatch.element)) return 'blocked';

  log.push('滑块已确认通过但登录表单仍在，重新点击登录按钮（仅一次）');
  await hooks.beforeNavigate?.();
  const clickMode = await realClick(submitMatch.element, { mayNavigate: true });
  log.push(clickMode === 'trusted'
    ? '滑块通过后的登录按钮已收到浏览器可信点击'
    : '滑块通过后的登录按钮已通过 DOM 点击（未使用浏览器可信指针）');
  if (hooks.afterClick && !await hooks.afterClick()) {
    log.push('重新提交登录后的安全验证未完成');
    return 'blocked';
  }

  await sleep(450);
  const feedback = visibleLoginFeedback();
  if (feedback) log.push(`重新提交后的登录页面反馈：${feedback}`);
  log.push(loginRequestObserved()
    ? '重新提交后页面已发起登录接口请求'
    : '重新提交后暂未观察到登录接口请求，继续核对登录结果');
  return 'submitted';
}

/**
 * OAuth/SSO 登录：点授权按钮，等跳回本站（URL 离开登录页）。
 *
 * 适用于 GitHub / LinuxDO / Passkey 等场景。
 * 前提：浏览器 profile 里已经登录过对应的 OAuth 提供商，不需要手动输账密。
 */
export async function clickOAuthButton(
  site: SiteConfig,
  log: StepLog,
  hooks: PageActionHooks = {},
  method: ExternalLoginMethod = 'oauth',
): Promise<boolean> {
  await closeAnnouncements(site, log);
  await ensureLoginConsent(log, document, hooks);

  let match = await waitForOAuthButton(site, 12_000, method);
  if (!match) {
    log.push(site.oauthButtonSelector?.trim()
      ? `找不到${method === 'passkey' ? ' Passkey' : method === 'github' ? ' GitHub' : ' OAuth'} 按钮: ${site.oauthButtonSelector}`
      : `未能自动识别${method === 'passkey' ? ' Passkey' : method === 'github' ? ' GitHub OAuth' : ' OAuth'} 登录按钮，请填写按钮选择器`);
    return false;
  }

  if (hooks.beforeClick && !await hooks.beforeClick()) {
    log.push(`${method === 'passkey' ? 'Passkey' : method === 'github' ? 'GitHub' : 'OAuth'} 点击前的安全验证未完成`);
    return false;
  }

  // 验证完成可能替换整个登录区域，重新按配置/页面语义识别当前按钮。
  match = await waitForOAuthButton(site, 12_000, method);
  if (!match) {
    log.push('安全验证完成后第三方登录按钮已不存在');
    return false;
  }

  if (isDisabledAction(match.element)) {
    log.push(`${method === 'passkey' ? 'Passkey' : method === 'github' ? 'GitHub' : 'OAuth'} 登录按钮仍处于禁用状态，页面还有未满足的登录条件`);
    return false;
  }

  const blocker = await clearClickBlocker(match.element, site, log, '第三方登录按钮');
  if (blocker) {
    log.push(`第三方登录按钮被${describeElement(blocker)}遮挡，已停止点击`);
    return false;
  }
  match = await waitForOAuthButton(site, 2_000, method);
  if (!match) {
    log.push('关闭遮挡后第三方登录按钮已不存在');
    return false;
  }
  if (isDisabledAction(match.element)) {
    log.push(`${method === 'passkey' ? 'Passkey' : method === 'github' ? 'GitHub' : 'OAuth'} 登录按钮在关闭遮挡后变为禁用状态`);
    return false;
  }

  // 日志必须在落地 stage 之前写：OAuth 点击会立刻跳走并销毁本脚本，
  // 之后 push 的内容永远进不了信箱。
  const btn = match.element;
  const label = buttonLabel(btn).slice(0, 30);
  log.push(match.automatic ? `已自动识别并点击 OAuth 按钮: ${label}` : `已点击 OAuth 按钮: ${label}`);
  await hooks.beforeNavigate?.();

  await realClick(btn, { mayNavigate: true });
  if (hooks.afterClick && !await hooks.afterClick()) {
    log.push(`${method === 'passkey' ? 'Passkey' : method === 'github' ? 'GitHub' : 'OAuth'} 点击后的安全验证未完成`);
    return false;
  }
  return true;
}

/**
 * 点完第三方登录按钮后，等这一跳真的开始。
 *
 * 这修的是一个把成功判成失败的竞态：OAuth 按钮点下去后，浏览器要先跟站点
 * 换一次授权地址才会跳去 GitHub，整页卸载往往在几百毫秒之后。而引擎点完
 * 立刻同步跑 verifyLogin —— 此刻文档还是那张登录页，8 秒内当然找不到任何
 * 登录成功证据，于是写下「登录后缺少明确成功证据」并把任务判为 failed。
 * 用户看到的却是浏览器已经好好停在 GitHub 登录页上，日志和现场对不上。
 *
 * 所以先给导航一点时间，只在**确认没有离开当前文档**时才回去做同步校验 ——
 * SPA 内完成登录（不整页刷新）的站点仍然走原来那条路，不受影响。
 *
 * @returns true 表示已经离开本页（或已拿到登录成功证据），调用方应结束本次
 *   执行，把后续判定交给新页面重新注入的脚本。
 */
export async function waitForExternalLoginNavigation(
  site: SiteConfig,
  log: StepLog,
  timeoutMs = 10_000,
): Promise<boolean> {
  const startedUrl = location.href;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    // 整页跳转会销毁本脚本，这个循环自然中断；能读到值说明还在原页面
    if (location.href !== startedUrl) {
      log.push(`已离开登录页，等待授权流程返回本站(${location.pathname})`);
      return true;
    }
    if (hasAuthenticatedPageEvidence(site)) return true;
    await sleep(250);
  }

  return false;
}

/**
 * 检测当前是否已登录（站点自动重定向到了仪表盘）。
 * 用于 loginMethod='auto' 的跳过逻辑。
 */
export async function detectAlreadyLoggedIn(
  site: SiteConfig,
  log: StepLog,
  timeoutMs = 6_000,
): Promise<boolean> {
  /**
   * 先等 2 秒（旧行为原样保留：已登录的 SPA 常先渲染登录路由再跳走，太早看到
   * 那一闪而过的表单会白白重登一次），之后轮询到**有结论**为止。
   *
   * 浏览器已有会话时，SPA 可能要更久才把登录页重定向进站内；那一刻看到的是空白壳，
   * 既不像登录页也不像站内页，旧实现据此判「没登录」，随后硬找输入框直到报
   * 「找不到控件」。站内证据 → 已登录；登录表单 → 需要登录；两样都没有才继续等。
   */
  const settleMs = Math.min(2_000, timeoutMs);
  await sleep(settleMs);
  const deadline = Date.now() + Math.max(0, timeoutMs - settleMs);
  for (;;) {
    if (hasAuthenticatedPageEvidence(site)) {
      log.push('命中登录成功证据，已处于登录状态');
      return true;
    }
    // 只有强证据（密码框 / 有账号语义的输入框 / 二次验证框）才是明确结论；页头的
    // 「登录」链接或一个孤零零的文本框不算 —— 交给后面的身份接口探测去问站点。
    if (hasStrongLoginFormEvidence(site)) {
      log.push('发现登录表单，需要重新登录');
      return false;
    }
    if (detectManualLoginStep()) {
      log.push('发现二次验证输入框，需要登录');
      return false;
    }
    if (Date.now() >= deadline) break;
    await sleep(300);
  }
  log.push('未发现足够的登录成功证据');
  return false;
}

export async function verifyLogin(site: SiteConfig, log: StepLog): Promise<boolean> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (hasAuthenticatedPageEvidence(site)) {
      log.push(site.successIndicator
        ? '命中登录成功标志'
        : '登录页已离开，并找到可验证的登录后状态');
      return true;
    }
    if (detectManualLoginStep()) break;
    await sleep(300);
  }
  log.push(detectManualLoginStep()
    ? '登录后进入二次验证步骤'
    : '登录后缺少明确成功证据，可能凭据错误或站点需要补充成功标志');
  return false;
}
