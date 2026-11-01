import { ADAPTER_FAMILIES, SITE_TYPES } from '@/types';
import { COMMON_CLOSE_SELECTORS, COMMON_USERNAME_SELECTORS, COMMON_PASSWORD_SELECTORS } from '../common-selectors';
import type { SiteTemplate } from '../template-types';

/**
 * Future Hub：个人设置页的每日签到卡片需要显式点击，不能按「登录即签到」处理。
 *
 * 流程：进入 `/console/personal` → 点击卡片右侧「每日签到」按钮 → 按钮变为
 * 「今日已签到」。专用模板必须排在通用 new-api 白标模板之前，避免被泛化配置覆盖。
 */
export const FUTUREHUB_TEMPLATE: SiteTemplate = {
  id: 'futurehub',
  label: 'Future Hub',
  siteType: SITE_TYPES.NEW_API,
  fingerprints: {
    hostnames: ['api.futureppo.top'],
  },
  preset: {
    selectors: {
      username: COMMON_USERNAME_SELECTORS.join(', '),
      password: COMMON_PASSWORD_SELECTORS.join(', '),
      submit: 'button[type="submit"], button.semi-button-primary',
    },
    loginMethod: 'auto',
    closeModalSelectors: COMMON_CLOSE_SELECTORS,
    checkin: {
      method: 'button',
      url: '/console/personal',
      buttonSelector: 'button >> text=立即签到',
      alreadySelector: 'button >> text=今日已签到',
      alreadyText: ['今日已签到'],
    },
    adapter: {
      siteType: SITE_TYPES.NEW_API,
      family: ADAPTER_FAMILIES.NEW_API,
      checkinPath: '/console/personal',
      checkin: { pathPatterns: ['/console/personal*'], titleWords: ['每日签到'] },
      quotaPerUnit: 500_000,
    },
  },
};
