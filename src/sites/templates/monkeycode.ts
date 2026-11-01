import { ADAPTER_FAMILIES, SITE_TYPES } from '@/types';
import { COMMON_CLOSE_SELECTORS, COMMON_USERNAME_SELECTORS, COMMON_PASSWORD_SELECTORS } from '../common-selectors';
import type { SiteTemplate } from '../template-types';

/** MonkeyCode 非 new-api，保守使用账密登录并在任务页自动识别动作。 */
export const MONKEYCODE_TEMPLATE: SiteTemplate = {
  id: 'monkeycode',
  label: 'MonkeyCode',
  siteType: SITE_TYPES.NEW_API,
  fingerprints: { hostnames: ['monkeycode-ai.com'] },
  preset: {
    selectors: {
      username: COMMON_USERNAME_SELECTORS.join(', '),
      password: COMMON_PASSWORD_SELECTORS.join(', '),
      submit: 'button[type="submit"]',
    },
    loginMethod: 'auto',
    closeModalSelectors: COMMON_CLOSE_SELECTORS,
    checkin: { method: 'auto', url: '/console/tasks' },
    adapter: {
      siteType: SITE_TYPES.NEW_API,
      family: ADAPTER_FAMILIES.NEW_API,
      checkinPath: '/console/tasks',
      checkin: { pathPatterns: ['/console/tasks*'], titleWords: ['签到', '任务', 'task'] },
      quotaPerUnit: 500_000,
    },
  },
};
