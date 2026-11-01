import type { SiteConfig, SiteType } from '@/types';

/**
 * 站点模板。
 *
 * 用户导入站点时按域名/页面特征匹配，自动填好选择器和签到方式，
 * 省掉手填一堆 CSS 选择器。匹配不上就退回手动配置，不影响原有流程。
 */
export interface SiteTemplate {
  /** 模板标识 */
  id: string;
  /** 显示名 */
  label: string;
  /** 这一族站点的系统类型 */
  siteType: SiteType;
  /**
   * 站点特征：命中任一即认为是这一族。
   *
   * 顺序即成本，探测按 hostnames → endpoint → titleWords 依次尝试
   * （见 lib/site-probe.ts）。`endpoint` 是关键的一条 ——
   * 白标站点域名和标题都可能改掉，但后端的响应形状改不了，
   * 所以「域名里没有 sub2api」的站也能认出来。
   */
  fingerprints: {
    /** 登录页标题含这些词 */
    titleWords?: string[];
    /** 页面上存在这些选择器 */
    selectors?: string[];
    /** 已知域名，完全匹配（最省事的一条，命中就不用发请求） */
    hostnames?: string[];
    /**
     * 免鉴权端点指纹。
     *
     * 不带任何凭据地 GET 一个受保护端点，只看它**拒绝**的方式 ——
     * 各家后端的错误信封形状是稳定的，不随品牌文案变。
     */
    endpoint?: {
      /** 相对路径，如 '/api/v1/auth/me' */
      path: string;
      /** 拿到 JSON 后判断是不是这一族 */
      match: (body: unknown) => boolean;
    };
  };
  /** 命中后套用的配置（不含 id / name / loginUrl，那三项来自用户输入） */
  preset: Omit<SiteConfig, 'id' | 'name' | 'loginUrl'>;
}
