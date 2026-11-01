import { ADAPTER_FAMILIES, SITE_TYPES } from '@/types';
import { COMMON_CLOSE_SELECTORS } from '../common-selectors';
import type { SiteTemplate } from '../template-types';

/**
 * Hvoy AI 使用首页上的“每日签到”入口，并在登录提交、签到点击后分别弹出拼图滑块。
 *
 * 这里仍复用通用引擎的人机验证钩子：业务按钮点击后给滑块留出挂载窗口，
 * 检测到后交给现有图片识别与可信指针拖动模块。站点配置只声明真实路由、
 * 按钮和完成证据，不复制任何滑块实现。
 */
export const HVOY_SITE_PRESET: SiteTemplate['preset'] = {
  pointerMode: 'trusted',
  loginMethod: 'form',
  selectors: {
    // 首页还有一个 API 调试输入框（api-endpoint-url），不能把它当成账号框。
    username: 'input[type="email"], input[name="email"], input[id="email"], input[autocomplete="email"], input[autocomplete="username"]',
    password: 'input[type="password"], input[name="password"], input[autocomplete="current-password"], #password',
    submit: 'button[type="submit"], input[type="submit"], button >> text=登录',
  },
  // 禾维首页先点页头「登录」才会渲染真正的邮箱/密码表单。
  preLoginClickSelector: [
    'header a[href="/login"]',
    'nav a[href="/login"]',
    'a[href="/login"]',
    'header button >> text=登录',
    'nav button >> text=登录',
    'header a >> text=登录',
    'nav a >> text=登录',
  ].join(', '),
  closeModalSelectors: COMMON_CLOSE_SELECTORS,
  checkin: {
    method: 'button',
    url: '/',
    /**
     * 禾维的签到端点是 `/api/user/clock_in`，**不是** new-api 系通用的
     * `/api/user/checkin`。
     *
     * 这一行决定了会不会碰到验证码：配对了端点，扩展的 API 直连路径就能在
     * service worker 里带 cookie 完成签到，根本不开标签页，也就遇不到登录页的
     * Turnstile 和签到点击后的滑块。配错则直连 404 →判定「站点不支持」→
     * 连续三次后熔断 24 小时 → 之后每天都被迫走浏览器过两道验证。
     *
     * 前几轮一直在调滑块图像识别，方向错了：识别率不可能做到 100%，而这个
     * 站点本来就有一条不需要识别的路。
     */
    apiUrl: '/api/user/clock_in',
    buttonSelector: 'button >> text=每日签到, a >> text=每日签到',
    alreadySelector: 'button >> text=今日已签到, button >> text=今天已签到, button >> text=已签到',
    successText: ['签到成功', '恭喜获取', '恭喜获得'],
    alreadyText: ['今日已签到', '今天已签到', '已经签到', '已签到'],
  },
  adapter: {
    siteType: SITE_TYPES.UNKNOWN,
    family: ADAPTER_FAMILIES.UNSUPPORTED,
    checkinPath: '/',
    checkin: { pathPatterns: ['/'], titleWords: ['每日签到'] },
    // Hvoy 的奖励单位是积分，不使用 new-api 的 500000/$ 换算。
    quotaPerUnit: 1,
  },
};

export const HVOY_TEMPLATE: SiteTemplate = {
  id: 'hvoy',
  label: 'Hvoy AI',
  siteType: SITE_TYPES.UNKNOWN,
  fingerprints: {
    // 只认用户提供并截图确认的精确主机名，不按“hvoy”模糊猜测其它域名。
    hostnames: ['www.hvoy.ai'],
  },
  preset: HVOY_SITE_PRESET,
};
