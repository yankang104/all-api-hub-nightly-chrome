import { ADAPTER_FAMILIES, SITE_TYPES } from '@/types';
import { COMMON_CLOSE_SELECTORS, COMMON_USERNAME_SELECTORS, COMMON_PASSWORD_SELECTORS } from '../common-selectors';
import type { SiteTemplate } from '../template-types';

/**
 * AnyRouter（anyrouter.top）：**登录即签到**，站点上没有签到按钮可点。
 *
 * 实测（2026-08-18，用户执行日志）：账密登录成功后跳到 `/console`，
 * 整个控制台的可点元素只有 `Any Router / 首页 / 控制台 / 定价 / 使用指南 /
 * 切换主题 / 切换语言 / 头像`—— 没有任何签到控件。
 *
 * 所以这个站不能用通用 new-api 的 `auto`：auto 会去 `/console/personal`
 * 等满 12 秒渲染，然后报「签到页未找到明确按钮或已签到状态」，把一次本来
 * 成功的签到判成失败，还把用户引去核对根本不存在的按钮选择器。
 *
 * `checkin.url` 也刻意不填：填了 none 方式仍会先跳过去，白跑一趟。
 * 专用模板必须排在通用 new-api 白标模板之前，否则会被那份泛化配置盖掉。
 *
 * ⚠️ 前提是本轮**真的重新登录了一次**。浏览器里已经登着本账号时，扩展会
 * 确认身份后直接跳过登录 —— 那一轮不会触发站点发奖励，额度守恒差分会显示
 * 「读到了前后额度但没有变化」。要每轮都强制拿奖励，把签到方式改成
 * 「退出再登录」（relogin，配 /api/user/logout）。
 */
export const ANYROUTER_TEMPLATE: SiteTemplate = {
  id: 'anyrouter',
  label: 'AnyRouter（登录即签到）',
  siteType: SITE_TYPES.ANYROUTER,
  fingerprints: {
    hostnames: ['anyrouter.top'],
    titleWords: ['any router', 'anyrouter'],
  },
  preset: {
    selectors: {
      username: COMMON_USERNAME_SELECTORS.join(', '),
      password: COMMON_PASSWORD_SELECTORS.join(', '),
      submit: 'button[type="submit"], button.semi-button-primary',
    },
    loginMethod: 'auto',
    /**
     * 不配 preLoginClickSelector。
     *
     * 这个站的账密表单藏在「使用 邮箱或用户名 登录」后面，但通用识别
     * （steps.ts 的 findRevealPasswordFormButton）已经稳定命中它了 ——
     * 实测日志第 17 步就是靠它展开的。写死文案反而多一条会过期的配置：
     * 站点改词后要先白等 6 秒超时，才回落到通用识别。
     */
    closeModalSelectors: COMMON_CLOSE_SELECTORS,
    checkin: { method: 'none' },
    adapter: {
      siteType: SITE_TYPES.ANYROUTER,
      family: ADAPTER_FAMILIES.NEW_API,
      /**
       * 空串 → resolveSiteAdapter 把 checkinPath 解析成 undefined，
       * 从而关掉 new-api 家族默认的 `/console/personal` 兜底跳转。
       * 余额端点与 quota 换算仍走 new-api 家族，不受影响。
       */
      checkinPath: '',
      quotaPerUnit: 500_000,
    },
  },
};
