import { ADAPTER_FAMILIES, SITE_TYPES } from '@/types';
import { COMMON_CLOSE_SELECTORS, isRecord } from '../common-selectors';
import type { SiteTemplate } from '../template-types';

/**
 * new-api / one-api 系。
 *
 * 这一系有十几个分叉，共用同一套 API 协议和 semi-ui 皮肤，
 * 差异（签到端点、user-id 头名）由 compat-headers 的扇出兼容掉。
 */
export const NEW_API_TEMPLATE: SiteTemplate = {
  id: 'new-api',
  label: 'new-api / one-api 系',
  siteType: SITE_TYPES.NEW_API,
  fingerprints: {
    titleWords: ['new-api', 'one-api', 'veloera', 'voapi'],
    selectors: ['.semi-modal-close', '.semi-button', '#username'],
    /**
     * new-api 系的 `/api/user/self` 未登录时返回
     * `{success: false, message: "无权进行此操作，未登录且未提供 access token"}`。
     * 判据取 `success === false` 这个布尔字段 —— Sub2API 的信封没有它，
     * 所以两族不会互相误判。
     */
    endpoint: {
      path: '/api/user/self',
      match: (body) => isRecord(body) && body.success === false,
    },
  },
  preset: {
    selectors: {
      username: '#username',
      password: '#password',
      submit: 'button[type="submit"]',
    },
    loginMethod: 'auto',
    closeModalSelectors: COMMON_CLOSE_SELECTORS,
    /**
     * 经典控制台侧栏里的「令牌」「钱包」入口：只在登录后的 /console 布局里渲染，
     * 未登录的页头只有首页/控制台/定价/关于，登录页上不会出现（Agent Router 同款
     * 判据，见 agentrouter.ts）。不用 one-api 的 /token、/topup：它们在未登录页头里也有。
     * 新版前端换成 onClick 菜单后命中不到也无妨 —— 只是退回到其余判据。
     */
    successIndicator: 'a[href="/console/token"], a[href="/console/topup"]',
    checkin: {
      method: 'auto',
      url: '/console/personal',
      // new-api 系标准签到接口；headless 失败会自动回退页面自动化
      apiUrl: '/api/user/checkin',
    },
    adapter: {
      siteType: SITE_TYPES.NEW_API,
      family: ADAPTER_FAMILIES.NEW_API,
      checkinPath: '/console/personal',
      checkin: { pathPatterns: ['/console/personal*'], titleWords: ['每日签到', 'daily check-in'] },
      // new-api 默认 500000 quota 折合 1 美元
      quotaPerUnit: 500_000,
    },
  },
};
