import { ADAPTER_FAMILIES, SITE_TYPES } from '@/types';
import { COMMON_CLOSE_SELECTORS, isRecord } from '../common-selectors';
import type { SiteTemplate } from '../template-types';

/**
 * Sub2API 系。
 *
 * 实测特征（sub.100xlabs.space，2026-08-11）：
 *  - 登录框 id 是 `email`（不是 new-api 的 username）
 *  - 提交按钮 `.btn.btn-primary`（Tailwind，不是 semi-ui）
 *  - 标题「登录 - Sub2API」
 *  - 认证走 localStorage 的 auth_token，请求头 `Authorization: Bearer <token>`
 *  - 余额在 `/api/v1/auth/me` 的 data.balance（美元，没有 used_quota）
 *
 * 参考项目 all-api-hub 明确不支持这一族签到（providers 目录下没有 sub2api），
 * 但百倍实际有 /check-in，所以这里自己实现。
 */
export const SUB2API_TEMPLATE: SiteTemplate = {
  id: 'sub2api',
  label: 'Sub2API 系',
  siteType: SITE_TYPES.SUB2API,
  fingerprints: {
    titleWords: ['sub2api'],
    selectors: ['#email + *, input#email'],
    /**
     * `/api/v1/auth/me` 受 JWT 中间件保护，不带 Authorization 时
     * 返回的信封里 `code` 是**字符串**（其它族都是数字或没有 code）。
     * 这一条足以认出其它白标 Sub2API。
     */
    endpoint: {
      path: '/api/v1/auth/me',
      match: (body) => isRecord(body) && typeof body.code === 'string',
    },
  },
  preset: {
    selectors: {
      username: '#email',
      password: '#password',
      submit: 'button[type="submit"], .btn.btn-primary',
    },
    /**
     * 默认走 token 认证而不是填表单。
     *
     * 这一族的登录页带 Cloudflare Turnstile，自动填表单过不了；
     * 而它的凭据是 localStorage 里的 JWT，注入就能用。所以正确路径是
     * 「用户手动登录一次 → 抓取登录态 → 之后自动注入」。
     */
    loginMethod: 'token',
    tokenConfig: {
      storageKey: 'auth_token',
      headerName: 'Authorization',
      headerPrefix: 'Bearer ',
      identityEndpoint: '/api/v1/auth/me',
    },
    closeModalSelectors: COMMON_CLOSE_SELECTORS,
    checkin: {
      method: 'auto',
      url: '/check-in',
    },
    adapter: {
      siteType: SITE_TYPES.SUB2API,
      family: ADAPTER_FAMILIES.SUB2API,
      checkinPath: '/check-in',
      checkin: { pathPatterns: ['/check-in*'], titleWords: ['每日签到', 'daily check-in'] },
      // balance 本来就是美元，不需要换算
      quotaPerUnit: 1,
    },
  },
};
