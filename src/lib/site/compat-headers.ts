/**
 * new-api / one-api 系的用户 ID 请求头兼容。
 *
 * 这一系有大量分叉（改个名换套皮），每个分叉读的请求头名都不一样：
 * new-api 读 `New-API-User`，Veloera 读 `Veloera-User`，V-API 读
 * `X-Api-User`……值都是同一个数字用户 ID。
 *
 * 与其判断站点类型再决定发哪个头，不如把同一个值同时塞进所有已知头名。
 * 服务端只认自己那个，其余的忽略掉，一次调用兼容全家。
 *
 * 同一张表反过来还能用于站点探测：未登录请求 `/api/user/self` 时，
 * 401 的错误文案里往往会点名缺哪个头，据此反查站点类型。
 */

import { SITE_TYPES, type SiteType } from '@/types';

/**
 * 请求头名 → 站点类型。
 *
 * `User-id` 太通用（Super-API 用它），只发不用于反查，
 * 否则任何返回这个词的站点都会被误判成 Super-API。
 */
const HEADER_TO_SITE: Record<string, SiteType> = {
  'New-API-User': SITE_TYPES.NEW_API,
  'Veloera-User': SITE_TYPES.VELOERA,
  'X-Api-User': SITE_TYPES.V_API,
  'voapi-user': SITE_TYPES.VO_API,
  'User-id': SITE_TYPES.SUPER_API,
  'Rix-Api-User': SITE_TYPES.RIX_API,
  'neo-api-user': SITE_TYPES.NEO_API,
};

/** 太通用、不能用于反查站点类型的头名 */
const AMBIGUOUS_HEADERS = new Set(['User-id']);

const HEADER_NAMES = Object.keys(HEADER_TO_SITE);

/**
 * 用户 ID 兼容头的名字列表。
 *
 * 导出给 background 的余额刷新用：它注入页面时要把名字当参数传进去
 * （注入函数引用不到 import），值则由页面自己从 localStorage 读。
 */
export const USER_ID_HEADER_NAMES: readonly string[] = HEADER_NAMES;

/**
 * 把同一个用户 ID 扇出到所有已知的兼容头名。
 * userId 缺失或为空时返回空对象，调用方不必额外判空。
 */
export function buildUserIdHeaders(userId: string | number | null | undefined): Record<string, string> {
  if (userId == null || userId === '') return {};

  const value = String(userId);
  const headers: Record<string, string> = {};
  for (const name of HEADER_NAMES) headers[name] = value;
  return headers;
}

/**
 * 从错误文案里反查站点类型。
 *
 * 未登录时 new-api 系会回类似「无权进行此操作，未提供 New-API-User」的消息，
 * 据此判断这是哪个分叉。歧义头名不参与匹配。
 */
export function siteTypeFromErrorText(text: string): SiteType | null {
  if (!text) return null;

  const lower = text.toLowerCase();
  for (const [header, siteType] of Object.entries(HEADER_TO_SITE)) {
    if (AMBIGUOUS_HEADERS.has(header)) continue;
    if (lower.includes(header.toLowerCase())) return siteType;
  }
  return null;
}
