import {
  CLAIM_MIN_LENGTH_DEFAULT,
  type LoginTask,
  type SiteConfig,
  type SiteIdentitySourceConfig,
  type TaskStage,
} from '@/types';
import { validateCheckinWorkflow } from '@/lib/workflow/workflow-validation';
import { usesCheckinWorkflow } from '@/lib/checkin/learned-checkin';

export function siteOrigin(site: SiteConfig): string | null {
  const loginUrl = normalizeSecureLoginUrl(site.loginUrl);
  return loginUrl ? new URL(loginUrl).origin : null;
}

/** Parse and canonicalize an absolute HTTPS or loopback HTTP login URL. */
export function normalizeSecureLoginUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return isAllowedLoginUrl(url) ? url.href : null;
  } catch {
    return null;
  }
}

export function isSecureLoginUrl(value: string): boolean {
  return normalizeSecureLoginUrl(value) !== null;
}

function isAllowedLoginUrl(url: URL): boolean {
  const loopback = url.hostname === 'localhost'
    || url.hostname === '127.0.0.1'
    || url.hostname === '[::1]';
  return url.protocol === 'https:' || (url.protocol === 'http:' && loopback);
}

/** Credentials and authenticated API calls are only allowed on the site origin. */
export function isTaskUrlAllowed(task: LoginTask, currentUrl?: string): boolean {
  const expected = siteOrigin(task.site);
  if (!expected || !currentUrl) return false;
  try {
    return new URL(currentUrl).origin === expected;
  } catch {
    return false;
  }
}

export function isSameSiteUrl(site: SiteConfig, candidate?: string): boolean {
  if (!candidate) return true;
  const expected = siteOrigin(site);
  if (!expected) return false;
  try {
    return new URL(candidate, site.loginUrl).origin === expected;
  } catch {
    return false;
  }
}

/**
 * 站点级身份读取扩展（默认关闭）。
 *
 * 类型已并入 `@/types`，本模块只做转出，保持既有导入路径稳定。语义（两个
 * 来源都必须显式配置，任一未配置就不启用）：
 *  - storageKey：身份 JSON 的存储键（如 orevx 的 `auth-user`）。只读、不写；
 *  - endpoint：跨域身份接口（如 orevx 的 `https://server.orevx.ai/api/user/me`）。
 *    仅 https，主机必须是登录站点域名的自身/子域；调用只读 GET，用 tokenKey
 *    指向的存储值拼 Bearer 头（credentials:'omit'，理由见 identity.ts）。
 */
export type { SiteIdentitySourceConfig } from '@/types';

/**
 * 接收 identitySource 的站点形状。
 *
 * 字段类型是 unknown：该值来自用户可编辑的存储数据，运行时必须逐项校验，
 * 不能相信 TS 类型（也正因如此，测试里能喂任意坏形状）。
 */
export type SiteWithIdentitySource = (Omit<SiteConfig, 'id'> | SiteConfig) & { identitySource?: unknown };

function identitySourceStorageType(value: unknown): 'localStorage' | 'sessionStorage' | undefined {
  return value === 'localStorage' || value === 'sessionStorage' ? value : undefined;
}

function identitySourceText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * 读取并规范化站点上的 identitySource。
 *
 * 形状不对、或者没配 storageKey/endpoint 时返回 null（= 不启用），绝不猜。
 * 只读：本函数不写任何存储。
 */
export function siteIdentitySource(site: SiteWithIdentitySource): SiteIdentitySourceConfig | null {
  const raw = site.identitySource;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const source: SiteIdentitySourceConfig = {
    storageKey: identitySourceText(record.storageKey),
    storageType: identitySourceStorageType(record.storageType),
    endpoint: identitySourceText(record.endpoint),
    tokenKey: identitySourceText(record.tokenKey),
    tokenStorageType: identitySourceStorageType(record.tokenStorageType),
    tokenHeader: identitySourceText(record.tokenHeader),
    tokenPrefix: typeof record.tokenPrefix === 'string' ? record.tokenPrefix : undefined,
  };

  if (!source.storageKey && !source.endpoint) return null;
  return source;
}

/**
 * 跨域身份接口的准入判定（安全边界，validator 与运行时共用）。
 *
 * 规则（对齐 orevx：`orevx.ai` ↔ `server.orevx.ai`）：
 *  1. 必须 https 绝对地址；
 *  2. 主机名相同；或候选主机是登录主机名的子域（登录域 → 子域）；
 *  3. 或登录主机名是候选主机名的子域（登录子域 → 父域，即注册域自身）。
 *
 * 第 3 条覆盖「登录页在 www.orevx.ai、接口在 orevx.ai」这类真实部署。
 * 不引入公共后缀列表：`server.orevx.ai.evil.com`（后缀伪装）、`notorevx.ai`
 * （相似域名）、`evil.com`（第三方）都必须落在规则外，宁可对个别多段后缀
 * （如 co.uk）判得略保守，也不把用户的 token 发去无关主机。
 */
export function isIdentityEndpointAllowed(
  site: Omit<SiteConfig, 'id'> | SiteConfig,
  candidate?: string,
): boolean {
  if (!candidate) return false;
  const origin = siteOrigin(site as SiteConfig);
  if (!origin) return false;

  let url: URL;
  let loginHost: string;
  try {
    url = new URL(candidate);
    loginHost = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }

  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (!host.includes('.')) return false;

  return host === loginHost
    || host.endsWith(`.${loginHost}`)
    || loginHost.endsWith(`.${host}`);
}

/**
 * GitHub 账密只允许在登录流程页面使用。
 *
 * OAuth 跳转期间任务标签页会短暂离开本站，但不能因此把凭据派发给
 * github.com 的任意页面（例如用户手动切到仓库或设置页）。
 */
export function isGithubLoginUrl(candidate?: string): boolean {
  if (!candidate) return false;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:'
      && url.hostname === 'github.com'
      && url.pathname === '/login';
  } catch {
    return false;
  }
}

/** 只允许任务进入 GitHub 官方退出确认页，不把普通 GitHub 页面纳入自动化。 */
export function isGithubLogoutUrl(candidate?: string): boolean {
  if (!candidate) return false;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:'
      && url.hostname === 'github.com'
      && url.pathname === '/logout';
  } catch {
    return false;
  }
}

/** 访问退出页时若 GitHub 已无会话，可能落到登录页或站点根页。 */
export function isGithubLoggedOutUrl(candidate?: string): boolean {
  if (!candidate) return false;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:'
      && url.hostname === 'github.com'
      && (url.pathname === '/login' || url.pathname === '/');
  } catch {
    return false;
  }
}

/** GitHub OAuth 的中转页，会自动跳到 /login 或授权确认页，本身没有可填表单。 */
export function isGithubOAuthAuthorizeUrl(candidate?: string): boolean {
  if (!candidate) return false;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:'
      && url.hostname === 'github.com'
      && url.pathname.startsWith('/login/oauth/authorize');
  } catch {
    return false;
  }
}

/** GitHub 登录、授权和二次验证页面的有限白名单。 */
export function isGithubAuthUrl(candidate?: string): boolean {
  if (!candidate) return false;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') return false;
    return url.pathname === '/login'
      || url.pathname === '/logout'
      || url.pathname.startsWith('/login/')
      || url.pathname.startsWith('/sessions/')
      || url.pathname.startsWith('/account_verifications/');
  } catch {
    return false;
  }
}

/**
 * Google OAuth 的登录/授权页白名单。
 *
 * Google 会在同一套流程里轮换 `/o/oauth2/*`、`/signin/*`、
 * `/v3/signin/*` 和旧版 `/ServiceLogin`/`/AccountChooser` 路径；
 * 它们都位于 `accounts.google.com`，而回调页会回到任务站点自己的 origin。
 * 只认这个认证域，避免把普通 google.com 浏览页误当成任务授权页。
 */
export function isGoogleAuthUrl(candidate?: string): boolean {
  if (!candidate) return false;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com') return false;
    return url.pathname.startsWith('/o/oauth2/')
      || url.pathname.startsWith('/signin/')
      || url.pathname.startsWith('/v3/signin/')
      || url.pathname === '/ServiceLogin'
      || url.pathname === '/AccountChooser';
  } catch {
    return false;
  }
}

/*
 * 这是给代理租约生命周期用的宽松判定，不是凭据白名单。
 *
 * 用户可以导入任意 OAuth/OIDC 站点，提供商的域名无法预先列全。只要任务在
 * 登录阶段开出了一个外部授权窗口，代理就必须跟着窗口走；否则发起页一关，
 * popup 仍在认证时就会被全局代理释放。凭据派发仍只走上面的 GitHub 白名单。
 */
const AUTH_HOST_HINT = /(?:^|\.)accounts\.google\.com$|(?:^|\.)github\.com$|(?:^|\.)login\.microsoftonline\.com$|(?:^|\.)login\.live\.com$|(?:^|\.)appleid\.apple\.com$|(?:^|\.)discord(?:app)?\.com$|(?:^|\.)linux\.do$/i;
const AUTH_PATH_HINT = /(?:^|\/)(?:oauth2?|authorize|authorization|auth|sso|signin|sign-in|login|account|openid|connect|consent|identity|passkey|webauthn)(?:\/|$)/i;
const AUTH_QUERY_HINT = /(?:^|[?&])(?:client_id|redirect_uri|response_type|code_challenge|code_verifier|scope|state|oauth|openid|sso)=/i;

/**
 * 判断一个由签到页打开的 URL 是否像外部授权流程。
 *
 * 该函数只决定是否临时转移**浏览器级代理**，不允许据此向外域发送账号
 * 密码或 token。对未知提供商同时检查常见 OAuth/OIDC 路径和参数，保证自定义
 * 站点也能继承账号代理。
 */
export function isLikelyOAuthUrl(site: SiteConfig, candidate?: string): boolean {
  if (!candidate) return false;
  const expected = siteOrigin(site);
  if (!expected) return false;

  let url: URL;
  try {
    url = new URL(candidate, site.loginUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;

  const pathOrQuery = `${url.pathname}${url.search}`;
  if (url.origin === expected) {
    // 回调通常已经回到本站；只有明显的授权路由/参数才登记，避免把普通
    // 同源帮助页当成 popup 代理持有者。
    return AUTH_PATH_HINT.test(url.pathname) || AUTH_QUERY_HINT.test(url.search);
  }

  return AUTH_HOST_HINT.test(url.hostname) || AUTH_PATH_HINT.test(url.pathname) || AUTH_QUERY_HINT.test(url.search)
    || /(?:oauth|openid|sso|authorize|login|signin|passkey|webauthn)/i.test(pathOrQuery);
}

/** 只有登录生命周期内的阶段才可以把 GitHub 凭据交给外域认证页。 */
export function isGithubCredentialStage(stage: TaskStage): boolean {
  return stage === 'login'
    || stage === 'verify-oauth'
    || stage === 'relogin'
    || stage === 'relogin-verify';
}

export function validateSiteConfig(site: Omit<SiteConfig, 'id'> | SiteConfig): string[] {
  const errors: string[] = [];
  if (!siteOrigin(site as SiteConfig)) errors.push('登录页必须使用 HTTPS（本机测试可使用 localhost HTTP）');

  const loginMethod = site.loginMethod ?? 'form';
  if (loginMethod === 'token') {
    const token = site.tokenConfig;
    if (!token?.storageKey?.trim()) errors.push('Token 认证需要填写存储键名（如 auth_token）');
    if (!token?.headerName?.trim()) errors.push('Token 认证需要填写请求头名称（如 Authorization）');
    if (token?.identityEndpoint && !isSameSiteUrl(site as SiteConfig, token.identityEndpoint)) {
      errors.push('身份接口必须与登录站点同源');
    }
  }
  // oauth/github/passkey 点按钮、token 直接注入，都不碰账密表单
  if (loginMethod !== 'oauth' && loginMethod !== 'github' && loginMethod !== 'passkey' && loginMethod !== 'token') {
    if (!site.selectors?.username?.trim()) errors.push('缺少用户名输入框选择器');
    if (!site.selectors?.password?.trim()) errors.push('缺少密码输入框选择器');
    if (!site.selectors?.submit?.trim()) errors.push('缺少登录按钮选择器');
  }

  // 跨域身份读取（identitySource）默认关闭；显式配置 endpoint 时必须同时满足
  // 域名白名单与 token 来源要求。运行时会用同一个 isIdentityEndpointAllowed 再拦一道。
  const identitySource = siteIdentitySource(site);
  if (identitySource?.endpoint && !isIdentityEndpointAllowed(site, identitySource.endpoint)) {
    errors.push('跨域身份接口必须使用 HTTPS，且主机必须是登录站点域名的自身或子域');
  }
  if (identitySource?.endpoint && !identitySource.tokenKey) {
    errors.push('跨域身份接口需要同时填写 token 存储键（tokenKey）');
  }

  if (site.logoutApiUrl && !isSameSiteUrl(site as SiteConfig, site.logoutApiUrl)) {
    errors.push('退出接口必须与登录站点同源');
  }

  // 令牌引导（authBootstrap）：这一步会带着会话 cookie 发请求，所以**只许同源** ——
  // 配成外域等于把登录态送出去。运行时 authBootstrapProbe 会用同一判据再拦一道。
  const bootstrapEndpoint = (site as SiteConfig).authBootstrap?.endpoint?.trim();
  if (bootstrapEndpoint) {
    let bootstrapUrl: string | null = null;
    try {
      bootstrapUrl = new URL(bootstrapEndpoint, site.loginUrl).href;
    } catch {
      bootstrapUrl = null;
    }
    if (!bootstrapUrl || !isSameSiteUrl(site as SiteConfig, bootstrapUrl)) {
      errors.push('令牌引导接口必须是登录站点同源的地址');
    }
  }

  const checkin = site.checkin;
  // 旧手工工作流没有 route 时仍使用原 entry；新学习流程自行管理签到入口。
  const keepsLegacyEntry = checkin?.method === 'workflow' && !checkin.workflow?.route?.length;
  if (checkin?.entry && (!usesCheckinWorkflow(site) || keepsLegacyEntry)) {
    if (!checkin.entry.readySelector?.trim()) errors.push('签到入口需要填写页面就绪选择器');
    if (!Array.isArray(checkin.entry.steps) || checkin.entry.steps.length === 0) {
      errors.push('签到入口至少需要一个站内点击步骤');
    } else {
      for (const [index, step] of checkin.entry.steps.entries()) {
        if (!step?.selector?.trim()) errors.push(`签到入口第 ${index + 1} 步缺少点击选择器`);
      }
    }
  }
  if (checkin?.method === 'api') {
    if (!checkin.apiUrl?.trim()) errors.push('API 签到需要填写接口地址');
    else if (!isSameSiteUrl(site as SiteConfig, checkin.apiUrl)) errors.push('签到接口必须与登录站点同源');
  }
  if (checkin?.method === 'button') {
    if (!checkin.buttonSelector?.trim()) errors.push('按钮签到需要填写按钮选择器');
    if (checkin.url && !isSameSiteUrl(site as SiteConfig, checkin.url)) errors.push('签到页面必须与登录站点同源');
  }
  if (checkin?.method === 'claim') {
    if (!checkin.claimEntrySelector?.trim()) errors.push('领取签到需要填写领取入口选择器');
    if (!checkin.claimInputSelector?.trim()) errors.push('领取签到需要填写输入框选择器');
    if (!checkin.claimSubmitSelector?.trim()) errors.push('领取签到需要填写提交按钮选择器');
    // 字数在这里就拦下来：提交后被站点拒收的话，用户只能从日志里回推原因
    const minLength = checkin.claimMinLength ?? CLAIM_MIN_LENGTH_DEFAULT;
    const text = checkin.claimText?.trim();
    if (text && text.length < minLength) {
      errors.push(`领取文本至少需要 ${minLength} 字，当前 ${text.length} 字`);
    }
    if (checkin.url && !isSameSiteUrl(site as SiteConfig, checkin.url)) errors.push('领取页面必须与登录站点同源');
  }
  if (checkin?.method === 'relogin') {
    if (!checkin.logoutApiUrl?.trim() && !checkin.logoutSelector?.trim()) {
      errors.push('退出重登需要填写退出接口或退出按钮选择器');
    }
    if (checkin.logoutApiUrl && !isSameSiteUrl(site as SiteConfig, checkin.logoutApiUrl)) {
      errors.push('退出接口必须与登录站点同源');
    }
  }
  if (usesCheckinWorkflow(site)) {
    errors.push(...validateCheckinWorkflow(site as SiteConfig, checkin?.workflow));
  }
  return errors;
}

export function assertValidSiteConfig(site: Omit<SiteConfig, 'id'> | SiteConfig): void {
  const errors = validateSiteConfig(site);
  if (errors.length) throw new Error(errors[0]);
}


