import { ADAPTER_FAMILIES, SITE_TYPES } from '@/types';
import { COMMON_CLOSE_SELECTORS } from '../common-selectors';
import type { SiteTemplate } from '../template-types';

export const KID1412_TEMPLATE: SiteTemplate = {
  id: 'kid1412',
  label: "1412's API",
  siteType: SITE_TYPES.NEW_API,
  fingerprints: {
    hostnames: ['napi.kid1412.qzz.io'],
    titleWords: ["1412's api", 'kid1412'],
  },
  preset: {
    pointerMode: 'trusted',
    /**
     * 用 github 而不是 oauth：两者都点「使用 GitHub 继续」，区别在于
     * oauth 只依赖浏览器里已有的 GitHub 登录态，而 github 会在跳转到
     * github.com 的登录页时自动填写账号里保存的 GitHub 账密。
     *
     * 该站没有独立注册入口可用，用户的账号就是 GitHub 账号，所以默认走
     * 能自动登录的那条；浏览器已登录 GitHub 时会直接授权返回，不会多填一次。
     */
    loginMethod: 'github',
    oauthButtonSelector: 'text=GitHub',
    /**
     * 实测（2026-08-18，只读探测登录页）：输入框 id 由 React 运行时生成，
     * 形如 `#_r_2_-form-item`，每次渲染都可能变，写死 id 必然选不中。
     * 只有 name 是稳定特征。账密表单在登录页直接可见，无需前置展开点击。
     */
    selectors: {
      username: 'input[name="username"]',
      password: 'input[name="password"]',
      submit: 'button[type="submit"]',
    },
    closeModalSelectors: COMMON_CLOSE_SELECTORS,
    // 登录页的公共导航没有这些账户功能入口；命中后才算真正回到已登录控制台。
    successIndicator: 'a[href="/keys"], a[href="/wallet"]',
    /**
     * 实测（2026-08-19，登录后的 /profile 页）：右侧「每日签到」卡片。
     * 动作按钮文案是**「立即签到」**（不是「签到」），已签到后变为禁用的
     * 「已签到」，卡片下方显示当日奖励（如「今天 +$5.95」）。
     *
     * ⚠️ buttonSelector 必须把「立即签到」放在前面。卡片标题「每日签到」本身
     * 是个可折叠 button，它和「立即签到」都含「签到」、都是 4 个字 ——
     * 只写 `text=签到` 时 queryByText 按长度排序会打平，落回文档顺序就点到
     * 标题上：卡片折叠起来，签到没发生，最后报「点击签到后未检测到明确结果」。
     * 「签到」保留作兜底，防站点改文案（依赖 splitSelectors 支持 text= 回退列表）。
     *
     * `/profile` 是受保护路由：未登录时会重定向到 sign-in?redirect=%2Fprofile，
     * 由此确认它就是个人资料页，而非 SPA 兜底路径。
     */
    checkin: {
      method: 'button',
      url: '/profile',
      buttonSelector: 'button >> text=立即签到, button >> text=签到',
      alreadySelector: 'button >> text=已签到',
      successText: ['签到成功', '今天 +'],
      alreadyText: ['已签到', '今日已签到'],
    },
    adapter: {
      siteType: SITE_TYPES.NEW_API,
      family: ADAPTER_FAMILIES.NEW_API,
      checkinPath: '/profile',
      checkin: { pathPatterns: ['/profile*'], titleWords: ['每日签到'] },
      quotaPerUnit: 500_000,
    },
  },
};
