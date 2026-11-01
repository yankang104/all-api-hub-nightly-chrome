import { ADAPTER_FAMILIES, SITE_TYPES } from '@/types';
import { COMMON_CLOSE_SELECTORS } from '../common-selectors';
import type { SiteTemplate } from '../template-types';

/**
 * Linux.SB 的账密入口与每日签到页都是固定路由。登录成功后直接进入
 * `/daily_checkin`，点击「立即签到」；已签到时页面显示「今天已签到」或
 * 「已完成」。不再依赖首页快捷入口的文案发现，避免登录确认后停在首页。
 */
export const LINUX_SB_SITE_PRESET: SiteTemplate['preset'] = {
  pointerMode: 'trusted',
  loginMethod: 'form',
  selectors: {
    username: [
      'input[name="username"]',
      'input[name="email"]',
      'input[autocomplete="username"]',
      'input[autocomplete="email"]',
      'input[type="email"]',
      'input[type="text"]',
    ].join(', '),
    password: 'input[name="password"], input[autocomplete="current-password"], input[type="password"]',
    submit: 'button[type="submit"], input[type="submit"], button >> text=登录',
  },
  closeModalSelectors: COMMON_CLOSE_SELECTORS,
  checkin: {
    method: 'button',
    url: '/daily_checkin',
    buttonSelector: [
      '.daily-checkin-page-action button:not([disabled])',
      '.daily-checkin-action button:not([disabled])',
      'button >> text=立即签到',
      'button >> text=签到',
      'input[type="submit"][value*="签到"]',
      'input[type="button"][value*="签到"]',
    ].join(', '),
    alreadySelector: [
      '.daily-checkin-page-action .daily-checkin-done',
      '.daily-checkin-done',
      'button >> text=今天已签到',
      'button >> text=今日已签到',
      'button >> text=已完成',
      'input[value="今天已签到"]',
      'input[value="今日已签到"]',
      'input[value="已完成"]',
    ].join(', '),
    successText: ['签到成功', '签到完成', '今天已签到', '今日已签到', '已完成'],
    alreadyText: ['今天已签到', '今日已签到', '已完成'],
  },
  adapter: {
    siteType: SITE_TYPES.UNKNOWN,
    family: ADAPTER_FAMILIES.UNSUPPORTED,
    checkinPath: '/daily_checkin',
    checkin: { pathPatterns: ['/daily_checkin*'], titleWords: ['每日签到'] },
  },
};

export const LINUX_SB_TEMPLATE: SiteTemplate = {
  id: 'linux-sb',
  label: 'Linux.SB',
  siteType: SITE_TYPES.UNKNOWN,
  fingerprints: {
    // 只认精确主机名；不按含有 "linux.sb" 的其它域名或显示名模糊命中。
    hostnames: ['linux.sb'],
  },
  preset: LINUX_SB_SITE_PRESET,
};
