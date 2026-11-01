import { ADAPTER_FAMILIES, SITE_TYPES } from '@/types';
import { COMMON_CLOSE_SELECTORS } from '../common-selectors';
import type { SiteTemplate } from '../template-types';

/**
 * 登仙公益站：Sub2API 登录态，但签到页是不带连字符的 `/checkin`。
 *
 * 页面流程由用户现场截图确认：先点「立即签到」，随后在「赞助人鸣谢」弹窗中
 * 等倒计时结束并领取奖励。模板明确声明主按钮与必需的二次领取按钮；通用签到器
 * 负责等待解锁、发出可信点击并验证领取后的新终态。
 */
export const DENXIO_SITE_PRESET: SiteTemplate['preset'] = {
  selectors: {
    username: 'input[type="email"], #email, input[name="email"]',
    password: '#password, input[type="password"]',
    submit: 'button[type="submit"]',
  },
  loginMethod: 'form',
  tokenConfig: {
    storageKey: 'auth_token',
    headerName: 'Authorization',
    headerPrefix: 'Bearer ',
    identityEndpoint: '/api/v1/auth/me',
  },
  closeModalSelectors: COMMON_CLOSE_SELECTORS,
  checkin: {
    method: 'auto',
    url: '/checkin',
    // 同页还有“加成签到”，必须先锁定普通的“立即签到”。
    buttonSelector: 'button >> text=立即签到',
    alreadySelector: 'button >> text=今日已签到, button >> text=今天已签到, button >> text=已签到',
    // 点主按钮后弹出赞助鸣谢窗口；按钮约 3 秒后才解锁，这是必经步骤。
    claimConfirmSelector: 'button >> text=领取奖励',
    successText: ['签到成功', '领取成功', '领取完成'],
    alreadyText: ['今日已签到', '今天已签到', '已签到'],
  },
  adapter: {
    siteType: SITE_TYPES.SUB2API,
    family: ADAPTER_FAMILIES.SUB2API,
    checkinPath: '/checkin',
    checkin: { pathPatterns: ['/checkin*'], titleWords: ['每日签到', 'daily check-in'] },
    quotaPerUnit: 1,
  },
};

export const DENXIO_TEMPLATE: SiteTemplate = {
  id: 'denxio',
  label: '登仙公益站',
  siteType: SITE_TYPES.SUB2API,
  fingerprints: {
    hostnames: ['api.denxio.top'],
    titleWords: ['登仙公益站', '登仙', 'denxio'],
  },
  preset: DENXIO_SITE_PRESET,
};
