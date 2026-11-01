/**
 * 从站点页面抓取登录会话。
 *
 * 解决的问题：有些站点没有能自动填的账密表单 —— 只能 GitHub 登录，
 * 或者登录要过 Cloudflare Turnstile。这些站点上「自动填表单登录」这条路
 * 走不通，用户每次都得手动来一遍。
 *
 * 换个思路：让用户手动登录**一次**，把浏览器里已经存在的会话抓下来，
 * 之后签到直接注入，不再走登录流程。
 *
 * 各家把会话存在哪儿不一样，所以一族一个提取器（照参考项目
 * all-api-hub 的 contentSession/ 结构），按优先级排队，
 * 各自声明「我能不能抓」和「怎么抓」。
 *
 * ⚠️ 这个模块只在 content script 里跑 —— 它读的是页面的 localStorage，
 * background 没有那个上下文。
 */

import { ADAPTER_FAMILIES, SITE_TYPES, type SiteType } from '@/types';
import { adapterFamilyForSiteType } from '@/automation/sites/site-adapters';

export interface CapturedSession {
  /** 站点侧的身份，用于核对抓到的是不是目标账号 */
  identity: { userId?: string; username?: string; email?: string };
  /** 短命的访问令牌 */
  accessToken?: string;
  /** 长命的刷新令牌，Sub2API 系才有 */
  refreshToken?: string;
  /** accessToken 到期时间戳（毫秒） */
  tokenExpiresAt?: number;
  /** 抓到的是哪一族的会话 */
  siteType: SiteType;
  /** 抓取方式说明，写进日志给用户看 */
  evidence: string;
}

interface SessionExtractor {
  id: string;
  /** 这一族的会话在不在？便宜的存在性检查，不做解析 */
  canExtract(): boolean;
  /** 真正抓取。抓不到返回 null（不抛异常） */
  extract(): CapturedSession | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 读并解析一个 JSON 形式的 localStorage 键 */
function readJson(key: string): Record<string, unknown> | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 把可能是数字或字符串的字段统一成非空字符串 */
function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * Sub2API 系（百倍等）。
 *
 * 键名来自参考项目 all-api-hub 的实测：
 *   auth_token / refresh_token / token_expires_at / auth_user
 *
 * `auth_user` 是 JSON，含 id/username/email/balance —— 身份读本地就有，
 * **不用调接口**。这一点很关键：以前靠 `/api/v1/auth/me` 读身份，
 * 而那个请求没带 Authorization 头必然 401，于是判成「读不到身份」，
 * 触发「清登录态 → 重新登录 → 找不到密码框」的连环失败。
 */
export const SUB2API_KEYS = {
  accessToken: 'auth_token',
  refreshToken: 'refresh_token',
  expiresAt: 'token_expires_at',
  user: 'auth_user',
} as const;

const sub2apiExtractor: SessionExtractor = {
  id: 'sub2api',
  canExtract: () => localStorage.getItem(SUB2API_KEYS.accessToken) !== null,

  extract() {
    const accessToken = localStorage.getItem(SUB2API_KEYS.accessToken)?.trim();
    if (!accessToken) return null;

    const user = readJson(SUB2API_KEYS.user);
    const expiresRaw = localStorage.getItem(SUB2API_KEYS.expiresAt);
    const parsedExpires = expiresRaw ? Number.parseInt(expiresRaw, 10) : Number.NaN;

    return {
      identity: {
        userId: text(user?.id),
        username: text(user?.username),
        email: text(user?.email),
      },
      accessToken,
      // 没有 refresh token 也算抓到了，只是活不长 —— 界面会提示需要重新抓
      refreshToken: localStorage.getItem(SUB2API_KEYS.refreshToken)?.trim() || undefined,
      ...(Number.isFinite(parsedExpires) ? { tokenExpiresAt: parsedExpires } : {}),
      siteType: SITE_TYPES.SUB2API,
      evidence: `已从 localStorage 读到 ${SUB2API_KEYS.accessToken}${
        localStorage.getItem(SUB2API_KEYS.refreshToken) ? ' 与 refresh_token' : '（无 refresh_token）'
      }`,
    };
  },
};

/** 解 JWT 的 payload 段。只为读 userId，不做签名校验（我们不是验证方） */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const segment = token.split('.')[1];
  if (!segment) return null;
  try {
    const padded = segment.padEnd(segment.length + ((4 - (segment.length % 4)) % 4), '=');
    const json = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
    const parsed: unknown = JSON.parse(json);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * VoAPI v2。
 *
 * token 埋在 `userStore` 这个 JSON 的 `.auth.token` 里，
 * 身份可能只在 JWT payload 里（`user` 键不一定有），所以两处都试。
 */
const voapiV2Extractor: SessionExtractor = {
  id: 'voapi-v2',
  canExtract: () => localStorage.getItem('userStore') !== null,

  extract() {
    const store = readJson('userStore');
    const auth = isRecord(store?.auth) ? store.auth : null;
    const accessToken = text(auth?.token);
    if (!accessToken) return null;

    const user = readJson('user');
    const claims = decodeJwtPayload(accessToken);

    return {
      identity: {
        userId: text(user?.id) ?? text(claims?.userId) ?? text(claims?.id),
        username: text(user?.username),
        email: text(user?.email),
      },
      accessToken,
      siteType: SITE_TYPES.VO_API_V2,
      evidence: '已从 localStorage 的 userStore.auth.token 读到会话',
    };
  },
};

/**
 * new-api / one-api 系兜底。
 *
 * 这一族的凭据是 HttpOnly cookie，脚本读不到也不需要读 —— 签到请求
 * 自带 cookie 就行。这里只抓身份（`user` 这个 JSON 里的 id），
 * 因为 new-api 的接口要求把它作为 `New-API-User` 头发出去。
 */
const newApiUserExtractor: SessionExtractor = {
  id: 'new-api-user',
  canExtract: () => localStorage.getItem('user') !== null,

  extract() {
    const user = readJson('user');
    const userId = text(user?.id);
    if (!userId) return null;

    return {
      identity: {
        userId,
        username: text(user?.username),
        email: text(user?.email),
      },
      // 故意不返回 token：这一族靠 cookie，抓 token 没有意义
      siteType: SITE_TYPES.NEW_API,
      evidence: '已从 localStorage 的 user 读到身份（登录态在 cookie 里）',
    };
  },
};

/**
 * 提取器优先级。
 *
 * 专用的排前面、兜底的排后面：Sub2API 和 VoAPI 都有自己的专属键，
 * 而 `user` 这个键名太常见（new-api 系用它，别家也可能用），
 * 所以放最后，只在前面都不认时才轮到它。
 */
const EXTRACTORS: readonly SessionExtractor[] = [
  sub2apiExtractor,
  voapiV2Extractor,
  newApiUserExtractor,
];

/**
 * 抓取当前页面的登录会话。
 *
 * @param siteTypeHint 探测出的站点类型。有提示时优先用对应的提取器 ——
 *                     否则按顺序试，可能被兜底提取器抢先抓到一份没有 token 的。
 */
export function captureSession(siteTypeHint?: SiteType): CapturedSession | null {
  const preferred = siteTypeHint
    ? EXTRACTORS.filter((extractor) => matchesSiteType(extractor.id, siteTypeHint))
    : [];
  // 提示对应的提取器先试；不中再走完整顺序（站点可能被认错了）
  for (const extractor of [...preferred, ...EXTRACTORS]) {
    if (!extractor.canExtract()) continue;
    const session = extractor.extract();
    if (session) return session;
  }
  return null;
}

function matchesSiteType(extractorId: string, siteType: SiteType): boolean {
  const family = adapterFamilyForSiteType(siteType);
  if (extractorId === 'sub2api') return family === ADAPTER_FAMILIES.SUB2API;
  if (extractorId === 'voapi-v2') return family === ADAPTER_FAMILIES.VO_API_V2;
  // new-api 系有十几个分叉，共用同一个提取器；未知类型也保留兜底行为。
  return family === ADAPTER_FAMILIES.NEW_API || family === ADAPTER_FAMILIES.UNSUPPORTED;
}

/**
 * 抓取规格 —— 上面那些提取器的**数据形式**。
 *
 * 为什么要有这份东西：「抓取登录态」按钮走的是
 * `chrome.scripting.executeScript`，注入的函数在页面上下文里执行，
 * 被序列化时会丢掉所有闭包和 import —— 它引用不到上面任何一个提取器。
 *
 * 如果在注入函数里重写一遍读取逻辑，键名就有两份，改一处忘一处就会
 * 「抓不到但不报错」。所以把「读哪些键」抽成纯数据当参数传进去，
 * 键名仍然只在这个文件里定义一次。
 */
export interface CaptureSpec {
  siteType: SiteType;
  /** 直接存裸 token 的键 */
  tokenKey?: string;
  /** token 藏在某个 JSON 里时：键名 + 到 token 的路径 */
  nestedToken?: { key: string; path: string[] };
  refreshKey?: string;
  expiresKey?: string;
  /** 含身份信息的 JSON 键 */
  userKey?: string;
  /** 抓到后写进日志的说明 */
  evidence: string;
}

export const CAPTURE_SPECS: readonly CaptureSpec[] = [
  {
    siteType: SITE_TYPES.SUB2API,
    tokenKey: SUB2API_KEYS.accessToken,
    refreshKey: SUB2API_KEYS.refreshToken,
    expiresKey: SUB2API_KEYS.expiresAt,
    userKey: SUB2API_KEYS.user,
    evidence: 'Sub2API：localStorage 的 auth_token / refresh_token',
  },
  {
    siteType: SITE_TYPES.VO_API_V2,
    nestedToken: { key: 'userStore', path: ['auth', 'token'] },
    userKey: 'user',
    evidence: 'VoAPI v2：localStorage 的 userStore.auth.token',
  },
  {
    // 兜底：这一族凭据在 cookie 里，只抓身份
    siteType: SITE_TYPES.NEW_API,
    userKey: 'user',
    evidence: 'new-api 系：localStorage 的 user（登录态在 cookie 里）',
  },
];
