import { ADAPTER_FAMILIES, SITE_TYPES } from '@/types';
import { COMMON_CLOSE_SELECTORS, COMMON_USERNAME_SELECTORS, COMMON_PASSWORD_SELECTORS } from '../common-selectors';
import type { SiteTemplate } from '../template-types';

/**
 * VSLLM 的「每日签到」是折叠面板；通用扫描已经会先展开折叠面板再找按钮
 * （见 checkin.ts 的 expandCollapsedCheckinPanels），所以这里用普通的
 * button 流程即可，不再需要宿主限定的专用执行器。
 */
export const VSLLM_SITE_PRESET: SiteTemplate['preset'] = {
  selectors: {
    username: COMMON_USERNAME_SELECTORS.join(', '),
    password: COMMON_PASSWORD_SELECTORS.join(', '),
    submit: 'button[type="submit"], button.semi-button-primary',
  },
  pointerMode: 'trusted',
  loginMethod: 'auto',
  closeModalSelectors: COMMON_CLOSE_SELECTORS,
  checkin: {
    method: 'button',
    url: '/console/personal',
    buttonSelector: 'button >> text=立即签到',
    alreadySelector: 'button >> text=今日已签到, button >> text=已签到',
    successText: ['签到成功', '今日已签到'],
    alreadyText: ['今日已签到', '已签到'],
  },
  adapter: {
    siteType: SITE_TYPES.NEW_API,
    family: ADAPTER_FAMILIES.NEW_API,
    checkinPath: '/console/personal',
    checkin: { pathPatterns: ['/console/personal*'], titleWords: ['每日签到', '试试手气'] },
    quotaPerUnit: 500_000,
  },
};

export const VSLLM_TEMPLATE: SiteTemplate = {
  id: 'vsllm',
  label: 'VSLLM',
  siteType: SITE_TYPES.NEW_API,
  fingerprints: { hostnames: ['vsllm.com'] },
  preset: VSLLM_SITE_PRESET,
};
