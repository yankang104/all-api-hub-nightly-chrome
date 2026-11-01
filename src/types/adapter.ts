/**
 * 站点适配层的类型（`SiteConfig.adapter` 槽位）。
 *
 * 这里放的是「这个站点是什么系统、按什么规则跟它打交道」，
 * 与 `SiteConfig` 里用户手填的选择器互补：
 * 选择器描述页面长什么样，适配描述协议长什么样。
 *
 * 阶段二起由站点适配任务独占，`types/index.ts` 不再改动。
 */

/**
 * 站点系统类型。
 *
 * new-api / one-api 有大量同源分叉（改个名换套皮），
 * 它们共用同一套 API 协议，所以只在这里区分身份，
 * 真正的实现由下面的 adapterFamily 归并。
 */
export const SITE_TYPES = {
  NEW_API: 'new-api',
  ONE_API: 'one-api',
  VELOERA: 'veloera',
  ONE_HUB: 'one-hub',
  DONE_HUB: 'done-hub',
  V_API: 'v-api',
  VO_API: 'voapi',
  VO_API_V2: 'voapi-v2',
  SUPER_API: 'super-api',
  RIX_API: 'rix-api',
  NEO_API: 'neo-api',
  SUB2API: 'sub2api',
  ANYROUTER: 'anyrouter',
  UNKNOWN: 'unknown',
} as const;

export type SiteType = (typeof SITE_TYPES)[keyof typeof SITE_TYPES];

/**
 * 适配器家族：一份实现服务多个站点类型。
 *
 * 14 个 new-api 分叉共用 `new-api` 这一份实现，
 * 差异（不同的签到端点、不同的 user-id 头名）由站点定义表描述，
 * 不需要为每个分叉写代码。
 */
export const ADAPTER_FAMILIES = {
  NEW_API: 'new-api',
  SUB2API: 'sub2api',
  VO_API_V2: 'voapi-v2',
  UNSUPPORTED: 'unsupported',
} as const;

export type AdapterFamily = (typeof ADAPTER_FAMILIES)[keyof typeof ADAPTER_FAMILIES];

/**
 * 站点适配器对通用签到引擎暴露的路由能力。
 *
 * 路径使用简单 glob：末尾的 `*` 表示前缀匹配，其余情况按 pathname 精确匹配。
 * 这种声明可以安全地落进 storage JSON，不需要序列化 RegExp 或函数。
 */
export interface SiteCheckinCapability {
  /** 能被识别为签到页的 pathname 模式 */
  pathPatterns?: string[];
  /** 页面标题里出现任一词时视为签到页 */
  titleWords?: string[];
}

/**
 * 站点适配引用，挂在 `SiteConfig.adapter` 下。
 *
 * 全部可选：没有这个字段的老站点配置继续按现有逻辑跑，
 * 探测到类型后再回填，用户数据零迁移。
 */
export interface SiteAdapterRef {
  /** 站点系统类型，探测得出或用户手选 */
  siteType?: SiteType;
  /**
   * 运行时能力家族。
   *
   * `siteType` 用于展示和探测结果，`family` 用于选择一份可复用的运行时行为。
   * 留空时由运行时根据已知的 siteType 推导，因此已有站点配置无需迁移。
   */
  family?: AdapterFamily;
  /**
   * 该家族的签到页路径覆盖。
   *
   * 未填写时使用 family 的默认能力；明确保存空字符串可关闭该默认兜底，
   * 仅依赖 checkin.url 或页面自动发现入口。
   */
  checkinPath?: string;
  /** 额外的签到页路径/标题能力，供白标站点覆盖家族默认值 */
  checkin?: SiteCheckinCapability;
  /** 探测时间戳，用于判断是否需要重新探测 */
  detectedAt?: number;
  /**
   * 额度换算率：多少 quota 折合 1 美元。
   *
   * new-api 默认 500000，但站点可改。留空时按
   * `/api/status` 探测 → 缓存 → 降级 500000 的顺序取值。
   * 显式填写则覆盖探测结果。
   */
  quotaPerUnit?: number;
  /**
   * 上游用户 ID，用于 new-api 系的 user-id 请求头。
   *
   * 这是早期单账号站点的兼容字段。多账号身份必须存进
   * Account.identity.userId，不能在共享的站点配置里复用此值。
   */
  userId?: string;
}
