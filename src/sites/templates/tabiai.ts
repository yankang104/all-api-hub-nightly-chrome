import { SITE_TYPES } from '@/types';
import { NEW_API_NEXT_TEMPLATE } from './new-api-next';
import type { SiteTemplate } from '../template-types';

/**
 * TaBiAI 的 `/profile` 是 SPA 内的受保护资料页。
 *
 * 登录后的稳定路径是「右上角头像 → 个人资料」，直接整页请求 `/profile` 可能
 * 先进入 Cloudflare managed challenge。入口动作放在配置里，由通用执行器在
 * 身份闸门之前调用；引擎本身不按域名写分支。
 */
export const TABIAI_SITE_PRESET: SiteTemplate['preset'] = {
  ...NEW_API_NEXT_TEMPLATE.preset,
  selectors: { ...NEW_API_NEXT_TEMPLATE.preset.selectors },
  closeModalSelectors: [...NEW_API_NEXT_TEMPLATE.preset.closeModalSelectors],
  oauthButtonSelector: 'text=GitHub',
  checkin: {
    ...NEW_API_NEXT_TEMPLATE.preset.checkin!,
    entry: {
      readySelector: [
        'button >> text=立即签到',
        'button >> text=已签到',
        'button >> text=Check in now',
        'button >> text=Checked in',
      ].join(', '),
      readyTimeoutMs: 15_000,
      // 该站受保护资料页必须从站内菜单进入；直接请求 /profile 会绕回旧故障路径。
      fallbackToUrl: false,
      steps: [
        {
          selector: [
            'button[aria-haspopup="menu"][data-testid*="avatar" i]',
            'header button[aria-haspopup="menu"]:has([class*="avatar" i])',
            'header button[aria-haspopup="menu"]:has(img)',
            'button[aria-haspopup="menu"]:has([class*="avatar" i])',
            '[role="button"][aria-haspopup="menu"]:has([class*="avatar" i])',
            'button[aria-haspopup="menu"]:has(img)',
            'button[aria-label*="account" i][aria-haspopup="menu"]',
            'button[aria-label*="profile" i][aria-haspopup="menu"]',
            'button[aria-label*="用户"][aria-haspopup="menu"]',
            'button[aria-label*="账号"][aria-haspopup="menu"]',
            'button[aria-haspopup="menu"]:has([data-slot="avatar"])',
            'button[aria-haspopup="menu"]:has([class*="rounded-full" i])',
            'button[aria-haspopup="menu"]:has([class*="user-avatar" i])',
            'header button[data-slot="dropdown-menu-trigger"]:has(img)',
            'header button[data-slot="dropdown-menu-trigger"]:has([data-slot="avatar"])',
            'header button[data-slot="dropdown-menu-trigger"]:has([class*="avatar" i])',
            'header button[data-slot="dropdown-menu-trigger"]:has([class*="rounded-full" i])',
            'header [data-radix-dropdown-menu-trigger]:has(img)',
            'header [data-radix-dropdown-menu-trigger]:has([data-slot="avatar"])',
            'header [data-radix-dropdown-menu-trigger]:has([class*="avatar" i])',
            'header [data-radix-dropdown-menu-trigger]:has([class*="rounded-full" i])',
          ].join(', '),
          waitFor: [
            '[role="menuitem"] >> text=个人资料',
            '[role="menuitem"] >> text=个人中心',
            '[role="menuitem"] >> text=Profile',
            '[role="menuitem"] >> text=My profile',
            'a[href="/profile"]',
            'a[href^="/profile?"]',
            'a >> text=个人资料',
            'a >> text=个人中心',
            'a >> text=Profile',
          ].join(', '),
          timeoutMs: 12_000,
        },
        {
          selector: [
            'a[href="/profile"]',
            'a[href^="/profile?"]',
            '[role="menuitem"] >> text=个人资料',
            '[role="menuitem"] >> text=个人中心',
            '[role="menuitem"] >> text=Profile',
            '[role="menuitem"] >> text=My profile',
            'a >> text=个人资料',
            'a >> text=个人中心',
            'a >> text=Profile',
            'button >> text=个人资料',
            'button >> text=个人中心',
            'button >> text=Profile',
          ].join(', '),
          waitFor: [
            'button >> text=立即签到',
            'button >> text=已签到',
            'button >> text=Check in now',
            'button >> text=Checked in',
          ].join(', '),
          timeoutMs: 15_000,
          mayNavigate: true,
        },
      ],
    },
  },
  adapter: {
    ...NEW_API_NEXT_TEMPLATE.preset.adapter,
    checkin: {
      ...NEW_API_NEXT_TEMPLATE.preset.adapter?.checkin,
      pathPatterns: [...(NEW_API_NEXT_TEMPLATE.preset.adapter?.checkin?.pathPatterns ?? [])],
      titleWords: [...(NEW_API_NEXT_TEMPLATE.preset.adapter?.checkin?.titleWords ?? [])],
    },
  },
};

export const TABIAI_TEMPLATE: SiteTemplate = {
  id: 'tabiai',
  label: 'TaBiAI',
  siteType: SITE_TYPES.NEW_API,
  fingerprints: {
    hostnames: ['tabitoken.com'],
    titleWords: ['tabiai', 'tabitoken'],
  },
  preset: TABIAI_SITE_PRESET,
};
