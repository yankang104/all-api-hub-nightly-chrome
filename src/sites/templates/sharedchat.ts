import { ADAPTER_FAMILIES, SITE_TYPES } from '@/types';
import { COMMON_CLOSE_SELECTORS } from '../common-selectors';
import type { SiteTemplate } from '../template-types';

/**
 * SharedChat / ChatAI 系（new.sharedchat.cc）。
 *
 * 与其他站的关键差别：**不是签到，而是「领取权益」**，且流程有三步 ——
 * 点「领取 Codex 权益」→ 弹窗要求填不少于 10 字的领取原因 → 点「领取」。
 * 站点还要求原因**不能与之前重复**，所以 claimUniqueText 必须开，
 * 否则固定文本第二次就被拒（见 checkin.ts 的 CLAIM_REASON_POOL）。
 *
 * 页面用 hash 路由（#/vibe-code/dashboard），service 参数决定领哪种权益。
 */
export const SHAREDCHAT_TEMPLATE: SiteTemplate = {
  id: 'sharedchat',
  label: 'SharedChat 权益领取',
  siteType: SITE_TYPES.NEW_API,
  fingerprints: {
    hostnames: ['new.sharedchat.cc'],
    titleWords: ['sharedchat', 'chatai'],
  },
  preset: {
    pointerMode: 'trusted',
    loginMethod: 'auto',
    /**
     * 实测（2026-08-14）：登录框既没有 id、也没有 name 和 class，
     * 唯一可用的特征是 placeholder；提交按钮是 `type="button"` 而非 submit，
     * 所以通用的 `button[type="submit"]` 选不中，必须靠 class 或文字。
     */
    selectors: {
      username: 'input[placeholder*="用户名"], input[placeholder*="邮箱"]',
      password: 'input[type="password"]',
      submit: 'button.submit-btn, button >> text=用户登录',
    },
    closeModalSelectors: COMMON_CLOSE_SELECTORS,
    // 登录页没有这些控制台专属控件；命中任一即可确认已进入 Vibe Code 控制台
    // 只认控制台专有的按钮。Element Plus 的通用类组合（el-button--primary + --large）
    // 登录页的提交按钮上也有，会把登录页误判成已登录。
    successIndicator: 'button.refresh-btn, button.invite-entry-button',
    checkin: {
      method: 'claim',
      url: '/list/#/vibe-code/dashboard?activeMenu=dashboard&service=codex',
      /**
       * 入口按钮文案是「领取 Codex 权益」。**不能**再加 `text=领取` 兜底 ——
       * queryByText 取文字最短的命中项，弹窗未开时那条会选到入口自己，
       * 造成重复点击把刚弹出的窗口又关掉。
       */
      claimEntrySelector: 'button >> text=领取 Codex 权益',
      claimInputSelector: 'textarea, .modal textarea, [role="dialog"] textarea',
      /**
       * 弹窗里的提交按钮就叫「领取」（2 字），背景入口叫「领取 Codex 权益」（13 字）。
       * queryByText 按文字长度升序取第一个，所以这里会正确选中弹窗里那个。
       */
      claimSubmitSelector: 'button >> text=领取',
      claimMinLength: 10,
      claimUniqueText: true,
      /**
       * 实测（2026-08-14）：领取成功后套餐卡片的「已过期」变为「生效中」，
       * 且「领取 Codex 权益」按钮消失。「生效中」是这个站点最可靠的成功证据 ——
       * 站点不弹 toast，只更新卡片状态。
       */
      successText: ['领取成功', '权益已领取', '已生效', '生效中'],
      alreadyText: ['已领取', '今日已领取'],
    },
    adapter: {
      siteType: SITE_TYPES.NEW_API,
      family: ADAPTER_FAMILIES.NEW_API,
      checkinPath: '/list/',
      checkin: { pathPatterns: ['/list*'], titleWords: ['权益', 'benefit'] },
    },
  },
};
