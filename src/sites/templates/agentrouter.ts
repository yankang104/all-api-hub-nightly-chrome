import { ADAPTER_FAMILIES, SITE_TYPES } from '@/types';
import { COMMON_CLOSE_SELECTORS } from '../common-selectors';
import type { SiteTemplate } from '../template-types';

/**
 * Agent Router（agentrouter.org）。
 *
 * 实测（2026-08-15，未登录探测 /api/status 与 /api/user/*）：
 *  - new-api 系：`/api/user/self` 未登录返回 `{success:false}`，semi-ui 皮肤
 *  - `github_oauth: true`、`linuxdo_oauth: true`，其余登录方式全关；
 *    `turnstile_check: false`，没有人机验证挡自动化
 *  - `quota_per_unit: 500000`，与 new-api 默认一致
 *  - 奖励靠「退出再登录」发放，不是点签到按钮，所以 method 用 relogin
 *  - `GET /api/user/logout` 未登录也返回 `{"success":true}`，走接口退出
 *    比点头像下拉里的「退出」稳：菜单点完立即跳转，容易在落地进度前销毁脚本
 */
export const AGENTROUTER_SITE_PRESET: SiteTemplate['preset'] = {
  /**
   * 必须用可信指针。
   *
   * 这个站点的第三方登录是 `window.open(...)` 打开 GitHub 授权页的，
   * 而浏览器只把**真实用户手势**触发的 window.open 放行。DOM 合成点击
   * （isTrusted=false）会被静默拦截：window.open 有返回值、看着成功，
   * 但弹窗根本没开，页面也不跳转 —— 表现为「已点击 OAuth 按钮」之后
   * 卡在登录页，最后被判成「授权后未能确认登录成功」。
   */
  pointerMode: 'trusted',
  loginMethod: 'github',
  oauthButtonSelector: 'text=GitHub',
  selectors: {
    username: '#username, input[name="username"]',
    password: '#password, input[name="password"]',
    submit: 'button[type="submit"]',
  },
  closeModalSelectors: [
    'button >> text=今日关闭',
    'button >> text=关闭公告',
    ...COMMON_CLOSE_SELECTORS,
  ],
  /**
   * 2026-08-21 的新版仪表盘把 API 令牌/钱包改成 Semi UI 的 onClick 菜单，
   * 不再生成旧版 `<a href>`。账户数据卡只在登录后控制台出现；英文界面
   * 同时覆盖 Account Data。旧链接保留给尚未升级前端的备用域名。
   */
  successIndicator: 'div >> text=账户数据, div >> text=Account Data, a[href="/console/token"], a[href="/console/topup"]',
  checkin: {
    method: 'relogin',
    url: '/console',
    logoutApiUrl: '/api/user/logout',
    // 直接请求退出接口不会执行前端 logout handler，必须显式清掉旧用户副本。
    logoutStorageKeys: ['user', 'token', 'access_token'],
    /**
     * 接口退出失败时的兜底：退出藏在右上角头像下拉里
     * （个人设置 / API令牌 / 钱包 / 退出）。
     */
    logoutMenuSelector: '.semi-navigation-footer .semi-avatar, .semi-navigation-footer .semi-dropdown',
    logoutSelector: 'text=退出',
  },
  adapter: {
    siteType: SITE_TYPES.NEW_API,
    family: ADAPTER_FAMILIES.NEW_API,
    checkinPath: '/console',
    checkin: { pathPatterns: ['/console*'], titleWords: ['每日签到', 'daily check-in'] },
    quotaPerUnit: 500_000,
  },
};

export const AGENTROUTER_TEMPLATE: SiteTemplate = {
  id: 'agentrouter',
  label: 'Agent Router',
  siteType: SITE_TYPES.NEW_API,
  fingerprints: {
    hostnames: ['agentrouter.org', 'ps.air-outer.com'],
    titleWords: ['agent router', 'agentrouter'],
  },
  preset: AGENTROUTER_SITE_PRESET,
};
