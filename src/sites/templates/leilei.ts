import { ADAPTER_FAMILIES, SITE_TYPES } from '@/types';
import { COMMON_CLOSE_SELECTORS } from '../common-selectors';
import type { SiteTemplate } from '../template-types';

/**
 * 一梦五千年（fapi.leileihog.top）：每日额度靠 `/lottery` 的「浮梦引光」抽奖。
 *
 * 站点改版后**已经没有每日签到**（2026-08-26 用户确认：个人页只剩抽奖入口）。
 * 所以 `checkinPath` 直接指向 `/lottery`，不再绕 `/profile` —— 绕一趟白花时间，
 * 还多一个「个人页渲染慢」的失败点。
 *
 * 专用工作流仍保留对 `/profile` 的处理：落在那一页时会**机会性**点一下签到
 * （有就点，没有就走），这样站点把签到加回来时不用改代码。
 * 模板必须在通用新版模板之前命中，否则会被那份泛化配置盖掉。
 */
export const LEILEI_SITE_PRESET: SiteTemplate['preset'] = {
  pointerMode: 'trusted',
  loginMethod: 'auto',
  selectors: {
    username: 'input[name="username"]',
    password: 'input[name="password"]',
    submit: 'button[type="submit"], button >> text=登录, button >> text=Sign in',
  },
  /**
   * 登录成功证据。
   *
   * 新版前端把控制台入口收进头像菜单，/keys、/wallet 这类锚点不再稳定存在；
   * 站内导航栏的「浮梦引光」则是登录后才渲染的固定入口。两者并存：
   * 老页面仍命中旧锚点，新页面命中导航文字，避免「已登录却认不出来」。
   */
  successIndicator: 'a[href="/keys"], a[href="/wallet"], text=浮梦引光, a[href="/lottery"]',
  closeModalSelectors: COMMON_CLOSE_SELECTORS,
  checkin: {
    method: 'workflow',
    workflow: {
      steps: [{ type: 'leilei-daily' }],
    },
  },
  adapter: {
    siteType: SITE_TYPES.NEW_API,
    family: ADAPTER_FAMILIES.NEW_API,
    // 站点只有抽奖了，落地页就是抽奖页
    checkinPath: '/lottery',
    // `/profile*` 仍留在名单里：老配置会先落在那一页，它也要算「已在签到页」，
    // 否则引擎会认为还没到位而反复跳转
    checkin: {
      pathPatterns: ['/lottery*', '/profile*'],
      titleWords: ['浮梦引光', '抽奖', '每日签到'],
    },
    quotaPerUnit: 500_000,
  },
  /**
   * 新版前端把登录态改成**轮换令牌**：页面用会话 cookie `POST /api/user/auth/refresh`
   * 换一枚短命 access_token，之后所有接口都带 `Authorization: Bearer`；令牌只在
   * 页面内存里，不落 localStorage（实测前端包里就是这么发的）。
   *
   * 扩展默认的「cookie + user-id 兼容头」在这站读不到任何接口 —— 余额、签到前后
   * 的快照、身份全部 401。这里显式声明引导方式：先换令牌，再读。
   */
  authBootstrap: {
    endpoint: '/api/user/auth/refresh',
  },
};

export const LEILEI_TEMPLATE: SiteTemplate = {
  id: 'leilei',
  label: '一梦五千年',
  siteType: SITE_TYPES.NEW_API,
  fingerprints: {
    hostnames: ['fapi.leileihog.top'],
  },
  preset: LEILEI_SITE_PRESET,
};
