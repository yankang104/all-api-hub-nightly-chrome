import { ADAPTER_FAMILIES, SITE_TYPES } from '@/types';
import { COMMON_CLOSE_SELECTORS } from '../common-selectors';
import type { SiteTemplate } from '../template-types';

/**
 * new-api **新版 React 界面**的白标站点。
 *
 * 为什么必须单独建模板：新版把路由整个换了，旧版模板指向的
 * 两个地址在这些站上**根本不存在**。实测（2026-08-19，未登录只读探测四条路径）：
 *
 *   kapibala.asia / nova.vcrauo.com / api.gemai.cc / seekai.cc
 *     /login            → 站点 404 页（正文只有「返回 / 返回主页」，0 个 input）
 *     /console/personal → 同样是 404 页
 *     /sign-in          → 真正的登录页，有 username + password 输入框
 *     /profile          → 受保护路由，未登录时重定向到 /sign-in
 *
 * 后果是自动化两步全断：登录页找不到用户名框（「找不到用户名输入框」），
 * 即便登录成功也会被带到 /console/personal 的 404 页，报「签到页未找到明确
 * 按钮或已签到状态」。这正是用户报的「这个站点没有实现自动签到」。
 *
 * gy.leyanshi.me 当前品牌为 Zynk 公益，并不是林夕；其公开前端包明确把 `/console/personal` 映射到
 * `/profile`，未登录请求会转到 `/sign-in`。TaBiAI 虽然也使用这套页面，
 * 但进入资料页必须走头像菜单，因此在下方使用独立的声明式入口模板。
 *
 * 与 1412 的区别只有登录方式：1412 没有可用的账密入口（只有 GitHub / Passkey），
 * 这几个站的 /sign-in 上账密表单直接可见，所以用 auto。签到页结构相同，
 * 选择器沿用 1412 那份已在真实页面上验证过的。
 */
export const NEW_API_NEXT_TEMPLATE: SiteTemplate = {
  id: 'new-api-next',
  label: '已识别 new-api 中转站（新版界面）',
  siteType: SITE_TYPES.NEW_API,
  fingerprints: {
    /*
     * htai91.com（海獭 AI）：实测就是这一代界面。
     *
     * 用户截图确认 `/profile` 上的「每日签到」卡片与本模板逐项对应 ——
     * 「立即签到」按钮、签到后变灰的「已签到」、奖励文案「今天 +$3.06」。
     * 它此前不在名单里，于是套用通用 new-api 预设的 `/console/personal`，
     * 而站点把那个地址重定向到 `/profile`，通用扫描又只等 3 秒、
     * 在 SPA 渲染出卡片之前就放弃 —— 表现为反复跳转后报「未找到签到按钮」。
     */
    hostnames: [
      'gy.leyanshi.me', 'kapibala.asia', 'nova.vcrauo.com', 'api.gemai.cc', 'seekai.cc',
      'htai91.com',
    ],
  },
  preset: {
    pointerMode: 'trusted',
    loginMethod: 'auto',
    /**
     * 实测：输入框 id 由 React 运行时生成（`#_r_1_-form-item`），每次渲染都可能
     * 变，写死 id 必然选不中；只有 name 是稳定特征。这与 1412 同源。
     */
    selectors: {
      username: 'input[name="username"]',
      password: 'input[name="password"]',
      submit: 'button[type="submit"], button >> text=登录, button >> text=Sign in',
    },
    closeModalSelectors: COMMON_CLOSE_SELECTORS,
    // 登录页的公共导航没有这些账户功能入口；命中后才算真正回到已登录控制台
    successIndicator: 'a[href="/keys"], a[href="/wallet"]',
    /**
     * 新版把「每日签到」卡片放在个人资料页。动作按钮文案是「立即签到」，
     * 签到后变成禁用的「已签到」。文案与 1412 一致，沿用同一套判据。
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

/** 供历史导入记录迁移复用；运行时仍只使用上面的统一模板。 */
export const NEW_API_NEXT_SITE_PRESET: SiteTemplate['preset'] = NEW_API_NEXT_TEMPLATE.preset;
