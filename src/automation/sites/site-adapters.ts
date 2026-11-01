/**
 * 站点适配器的运行时能力注册表。
 *
 * SiteConfig 保留每个站点的选择器和覆写项；这里集中维护“同一套后端/前端
 * 家族通常如何进入签到页”这一类可共享行为。这样执行器不需要知道某个
 * siteType 的具体路径，新增家族也不必往 checkin.ts 继续堆分支。
 */
import {
  ADAPTER_FAMILIES,
  SITE_TYPES,
  type AdapterFamily,
  type SiteConfig,
  type SiteType,
} from '@/types';

export interface ResolvedSiteAdapter {
  /** 实际使用的运行时能力家族。 */
  family: AdapterFamily;
  /** 当前配置或推导出的系统类型，仅用于诊断与展示。 */
  siteType?: SiteType;
  /** 自动签到找不到入口时可使用的家族兜底路径。 */
  checkinPath?: string;
  /** 站点额外声明的签到页路径模式，末尾 `*` 表示前缀匹配。 */
  checkinPathPatterns: readonly string[];
  /** 站点额外声明的签到页标题词。 */
  checkinTitleWords: readonly string[];
}

interface AdapterCapabilities {
  checkinPath?: string;
}

const FAMILY_CAPABILITIES: Readonly<Record<AdapterFamily, AdapterCapabilities>> = {
  [ADAPTER_FAMILIES.NEW_API]: { checkinPath: '/console/personal' },
  [ADAPTER_FAMILIES.SUB2API]: { checkinPath: '/check-in' },
  [ADAPTER_FAMILIES.VO_API_V2]: {},
  [ADAPTER_FAMILIES.UNSUPPORTED]: {},
};

const NEW_API_SITE_TYPES = new Set<SiteType>([
  SITE_TYPES.NEW_API,
  SITE_TYPES.ONE_API,
  SITE_TYPES.VELOERA,
  SITE_TYPES.ONE_HUB,
  SITE_TYPES.DONE_HUB,
  SITE_TYPES.V_API,
  SITE_TYPES.VO_API,
  SITE_TYPES.SUPER_API,
  SITE_TYPES.RIX_API,
  SITE_TYPES.NEO_API,
  SITE_TYPES.ANYROUTER,
]);

function isAdapterFamily(value: unknown): value is AdapterFamily {
  return typeof value === 'string'
    && Object.values(ADAPTER_FAMILIES).includes(value as AdapterFamily);
}

/** 将细粒度 siteType 归并到可复用的运行时实现。 */
export function adapterFamilyForSiteType(siteType?: SiteType): AdapterFamily {
  if (siteType === SITE_TYPES.SUB2API) return ADAPTER_FAMILIES.SUB2API;
  if (siteType === SITE_TYPES.VO_API_V2) return ADAPTER_FAMILIES.VO_API_V2;
  if (siteType && NEW_API_SITE_TYPES.has(siteType)) return ADAPTER_FAMILIES.NEW_API;
  return ADAPTER_FAMILIES.UNSUPPORTED;
}

function normalizePath(path: string | undefined): string | undefined {
  const value = path?.trim();
  if (!value) return undefined;
  if (!value.startsWith('/')) return `/${value}`;
  return value;
}

/**
 * 解析某站点当前可用的能力。
 *
 * 显式 family 优先于旧 siteType；显式 checkinPath 优先于家族默认。对历史
 * 配置保留 siteType -> family -> 默认路径的推导，因而不会要求一次性迁移。
 */
export function resolveSiteAdapter(site: Pick<SiteConfig, 'adapter'>): ResolvedSiteAdapter {
  const ref = site.adapter;
  const family = isAdapterFamily(ref?.family)
    ? ref.family
    : adapterFamilyForSiteType(ref?.siteType);
  const hasCheckinPathOverride = !!ref
    && Object.prototype.hasOwnProperty.call(ref, 'checkinPath');
  const checkinPath = hasCheckinPathOverride
    ? normalizePath(ref?.checkinPath)
    : FAMILY_CAPABILITIES[family].checkinPath;
  const checkinPathPatterns = (ref?.checkin?.pathPatterns ?? [])
    .map((path) => normalizePath(path.replace(/\*$/, '')))
    .filter((path): path is string => !!path);
  const checkinTitleWords = (ref?.checkin?.titleWords ?? [])
    .map((word) => word.trim())
    .filter(Boolean);

  return {
    family,
    ...(ref?.siteType ? { siteType: ref.siteType } : {}),
    ...(checkinPath ? { checkinPath } : {}),
    checkinPathPatterns,
    checkinTitleWords,
  };
}

/** 签到自动发现失败时，返回该适配器允许尝试的同源入口路径。 */
export function adapterCheckinFallback(site: Pick<SiteConfig, 'adapter'>): string | undefined {
  return resolveSiteAdapter(site).checkinPath;
}

/**
 * 判断当前页是否是适配器约定的签到页。
 *
 * title 是一个无路径站点的温和兜底：只有明确写出每日签到时才认为它是签到页；
 * 路径比较同时接受末尾斜杠和同一签到页下的子路由。
 */
export function isAdapterCheckinPage(
  site: Pick<SiteConfig, 'adapter'>,
  pathname: string,
  title = '',
): boolean {
  const resolved = resolveSiteAdapter(site);
  const paths = [
    ...(resolved.checkinPath ? [resolved.checkinPath] : []),
    ...resolved.checkinPathPatterns,
  ];
  for (const checkinPath of paths) {
    const current = normalizePath(pathname)?.replace(/\/+$/, '') || '/';
    const expected = checkinPath.replace(/\/+$/, '') || '/';
    if (current === expected || current.startsWith(`${expected}/`)) return true;
  }
  const titleWords = resolved.checkinTitleWords.length
    ? resolved.checkinTitleWords
    : ['每日签到', 'daily check-in'];
  const normalizedTitle = title.toLocaleLowerCase();
  return titleWords.some((word) => normalizedTitle.includes(word.toLocaleLowerCase()));
}
