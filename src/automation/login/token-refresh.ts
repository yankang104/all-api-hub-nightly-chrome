/**
 * 用 refresh token 换新的 access token。
 *
 * 为什么必须有这一步：Sub2API 的 access token 是短命的，站点前端自己
 * 在到期前约 2 分钟就用 refresh token 换新。所以「让用户抓一次会话，
 * 之后一直用」这个方案，如果只存 access token，用户抓完过几分钟就失效了。
 *
 * 真正要长期保存的是 refresh token；签到开始时先看 access token 快不快到期，
 * 快到了就现换一个。
 *
 * buffer 取 120 秒与上游前端一致 —— 换早了会白白轮换 refresh token
 * （见下面的并发说明），换晚了请求会带着已过期的 token 出门。
 */

import { ADAPTER_FAMILIES, type SiteConfig } from '@/types';
import type { StepLog } from '@/automation/shared/log';
import { isSameSiteUrl } from '@/lib/site/site-security';
import { SUB2API_KEYS } from '@/automation/login/session-capture';
import { resolveSiteAdapter } from '@/automation/sites/site-adapters';

/** 到期前多久就该换 —— 与站点前端同策略，避免两边抢着轮换 */
const REFRESH_BUFFER_MS = 120_000;

/** Sub2API 的换 token 端点 */
const SUB2API_REFRESH_PATH = '/api/v1/auth/refresh';

export interface RefreshedTokens {
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: number;
}

export interface RefreshInput {
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
}

export type RefreshOutcome =
  /** 换到新的了，调用方要把它写回账号 */
  | { status: 'refreshed'; tokens: RefreshedTokens }
  /** 还没到需要换的时候，继续用现有的 */
  | { status: 'still-valid' }
  /** 换不了且已经过期，必须让用户重新抓一次会话 */
  | { status: 'expired'; reason: string }
  /** 这个站点不支持换 token（比如 cookie 认证的 new-api 系） */
  | { status: 'unsupported' };

/** access token 到期时间未知时，无法判断该不该换 —— 当作还能用，让请求自己去撞 401 */
function needsRefresh(tokenExpiresAt?: number): boolean {
  if (typeof tokenExpiresAt !== 'number' || !Number.isFinite(tokenExpiresAt)) return false;
  return tokenExpiresAt - Date.now() <= REFRESH_BUFFER_MS;
}

function isExpired(tokenExpiresAt?: number): boolean {
  if (typeof tokenExpiresAt !== 'number' || !Number.isFinite(tokenExpiresAt)) return false;
  return tokenExpiresAt <= Date.now();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 确保手上的 access token 还能用，必要时换新。
 *
 * 换成功后会**同时写回页面的 localStorage** —— 站点前端读的是那里，
 * 不写回去的话页面自己还在用旧 token，两边不一致。
 *
 * @param site 站点配置，用于同源校验
 * @param input 账号里存的会话
 */
export async function ensureFreshToken(
  site: SiteConfig,
  input: RefreshInput,
  log: StepLog,
): Promise<RefreshOutcome> {
  // 只有 Sub2API 族有这套 refresh 流程
  if (resolveSiteAdapter(site).family !== ADAPTER_FAMILIES.SUB2API) return { status: 'unsupported' };

  if (!needsRefresh(input.tokenExpiresAt)) {
    // 到期时间未知也走这里：让签到请求自己去试，撞 401 再报登录态失效
    return { status: 'still-valid' };
  }

  if (!input.refreshToken) {
    return isExpired(input.tokenExpiresAt)
      ? { status: 'expired', reason: '登录态已过期且没有 refresh token，需要重新抓取' }
      : { status: 'still-valid' };
  }

  const url = new URL(SUB2API_REFRESH_PATH, location.origin).href;
  // 安全边界：这个请求带着 refresh token，绝不能发到站外
  if (!isSameSiteUrl(site, url)) {
    return { status: 'expired', reason: '换 token 的地址不在本站，已拒绝' };
  }

  log.push('访问令牌即将到期，正在用 refresh token 换新');

  let payload: unknown = null;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(input.accessToken ? { Authorization: `Bearer ${input.accessToken}` } : {}),
      },
      body: JSON.stringify({ refresh_token: input.refreshToken }),
    });
    payload = await response.json().catch(() => null);
  } catch {
    // 网络失败：还没过期就继续用旧的，过期了才算死
    return isExpired(input.tokenExpiresAt)
      ? { status: 'expired', reason: '换 token 的请求失败，且当前令牌已过期' }
      : { status: 'still-valid' };
  }

  const tokens = parseRefreshResponse(payload);
  if (!tokens) {
    return isExpired(input.tokenExpiresAt)
      ? { status: 'expired', reason: '站点拒绝了换 token 请求，需要重新抓取登录态' }
      : { status: 'still-valid' };
  }

  // 写回页面存储，让站点前端和我们用的是同一个 token
  localStorage.setItem(SUB2API_KEYS.accessToken, tokens.accessToken);
  localStorage.setItem(SUB2API_KEYS.refreshToken, tokens.refreshToken);
  localStorage.setItem(SUB2API_KEYS.expiresAt, String(tokens.tokenExpiresAt));

  log.push('已换到新的访问令牌');
  return { status: 'refreshed', tokens };
}

/** 解析 `{code: 0, data: {access_token, refresh_token, expires_in}}` 信封 */
function parseRefreshResponse(payload: unknown): RefreshedTokens | null {
  if (!isRecord(payload) || payload.code !== 0 || !isRecord(payload.data)) return null;

  const { access_token: access, refresh_token: refresh, expires_in: expiresIn } = payload.data;
  if (typeof access !== 'string' || !access.trim()) return null;
  if (typeof refresh !== 'string' || !refresh.trim()) return null;
  if (typeof expiresIn !== 'number' || expiresIn <= 0) return null;

  return {
    accessToken: access.trim(),
    refreshToken: refresh.trim(),
    tokenExpiresAt: Date.now() + expiresIn * 1000,
  };
}
