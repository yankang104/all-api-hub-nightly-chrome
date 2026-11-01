import { ADAPTER_FAMILIES, SITE_TYPES } from '@/types';
import { COMMON_CLOSE_SELECTORS } from '../common-selectors';
import type { SiteTemplate } from '../template-types';

/**
 * 林夕（k40.shengqainbang.cn）的站点级策略。
 *
 * 公开前端确认它属于 Sub2API：登录态保存在 `auth_token`，余额以美元返回，
 * 每日签到固定在 `/check-in`。同站账号只共享这份页面动作；账号自己的登录
 * 方式、凭据、代理、身份和奖励记录仍分别保存。
 */
export const LINXI_SITE_PRESET: SiteTemplate['preset'] = {
  selectors: {
    username: '#email',
    password: '#password',
    submit: 'button[type="submit"], .btn.btn-primary',
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
    method: 'button',
    url: '/check-in',
    buttonSelector: 'button >> text=立即签到, button >> text=Check in',
    alreadySelector: 'button >> text=今日已签到, button >> text=Already checked in today',
    successText: ['签到成功', 'Checked in — got'],
    alreadyText: ['今日已签到', '今天已经签过了', 'Already checked in today'],
  },
  adapter: {
    siteType: SITE_TYPES.SUB2API,
    family: ADAPTER_FAMILIES.SUB2API,
    checkinPath: '/check-in',
    checkin: { pathPatterns: ['/check-in*'], titleWords: ['每日签到', 'daily check-in'] },
    quotaPerUnit: 1,
  },
};

export const LINXI_TEMPLATE: SiteTemplate = {
  id: 'linxi',
  label: '林夕',
  siteType: SITE_TYPES.SUB2API,
  fingerprints: {
    hostnames: ['k40.shengqainbang.cn'],
    titleWords: ['林夕'],
  },
  preset: LINXI_SITE_PRESET,
};
