import type { SiteConfig } from '@/types';
import { COMMON_CLOSE_SELECTORS, COMMON_USERNAME_SELECTORS, COMMON_PASSWORD_SELECTORS } from './common-selectors';
import type { SiteTemplate } from './template-types';
import { SITE_TEMPLATES } from './registry';
import { isLearnedLoginAsCheckin } from '@/lib/checkin/learned-checkin';

export function normalizedLoginUrl(value: string, template: SiteTemplate | null = matchTemplateByName(value)): string {
  try {
    const url = new URL(value);
    // 这些站点粘贴落地页时必须归一到真正的账密入口。
    if (template?.id === 'hvoy') {
      // 禾维的首页同时提供登录入口和每日签到入口；必须从首页开始，
      // 让 revealLoginForm 先发出页头「登录」的可信点击。
      url.pathname = '/';
      url.search = '';
      url.hash = '';
    } else if (
      template?.id === 'vsllm'
      || template?.id === 'monkeycode'
      || template?.id === 'anyrouter'
      || template?.id === 'denxio'
      || template?.id === 'agentrouter'
    ) {
      url.pathname = '/login';
      url.search = '';
      url.hash = '';
    }
    // 新版 new-api 界面没有 /login 这条路由，粘贴落地页时必须归一到 /sign-in，
    // 否则存下来的登录地址是站点 404 页，自动登录第一步就找不到输入框。
    if (template?.id === 'new-api-next' || template?.id === 'tabiai' || template?.id === 'leilei') {
      url.pathname = '/sign-in';
      url.search = '';
      url.hash = '';
    }
    // 百倍的签到页不是登录入口；导入 `/check-in` 时仍从固定 `/login` 开始。
    if (template?.id === 'baibei') {
      url.pathname = '/login';
      url.search = '';
      url.hash = '';
    }
    // 林夕的公开 SPA 登录入口是 /login；用户即使粘贴 /check-in 也要回到表单页。
    if (template?.id === 'linxi') {
      url.pathname = '/login';
      url.search = '';
      url.hash = '';
    }
    // Linux.SB 的账密页是 /login；不能把根页或签到页当成登录地址保存。
    if (template?.id === 'linux-sb') {
      url.pathname = '/login';
      url.search = '';
      url.hash = '';
    }
    return url.href;
  } catch {
    return value;
  }
}

/**
 * 按域名猜站点模板。
 *
 * 只做最保守的判断：域名或站点名里出现过模板的关键词才算命中。
 * 猜错的代价是用户得手动改选择器，所以宁可不猜。
 */
export function matchTemplateByName(nameOrUrl: string): SiteTemplate | null {
  let hostname = '';
  try {
    hostname = new URL(nameOrUrl).hostname.toLowerCase();
  } catch {
    // 输入可能是站点名称，继续走标题关键词匹配
  }

  if (hostname) {
    for (const template of SITE_TEMPLATES) {
      if ((template.fingerprints.hostnames ?? []).some((candidate) => candidate.toLowerCase() === hostname)) {
        return template;
      }
    }
  }

  const haystack = nameOrUrl.toLowerCase();
  for (const template of SITE_TEMPLATES) {
    for (const word of template.fingerprints.titleWords ?? []) {
      if (haystack.includes(word.toLowerCase())) return template;
    }
  }
  return null;
}

/**
 * 把内置站点与用户落盘的覆盖记录合并。
 *
 * 必须逐层合并 checkin / adapter / selectors，不能整块替换：早期版本
 * （或改过配置的用户）落盘的覆盖里可能没有 logoutApiUrl、logoutSelector
 * 这类后来补进模板的字段。整块替换会把它们抹成 undefined，于是启动时
 * 校验直接报「退出重登需要填写退出接口或退出按钮选择器」，而界面上
 * 看起来配置是好的 —— 用户只能删站重建。
 *
 * 覆盖优先级仍然是用户配置优先；只有用户没写的字段才回落到内置默认。
 */
/**
 * Future Hub 过去继承了通用 new-api 的 auto 配置。这不是用户手工选择的按钮
 * 策略，而是旧版预设；保守识别这一种精确形态并迁移到已验证的显式点击流程。
 *
 * 已配置不同 URL、按钮选择器或终态选择器的记录一律视为用户自定义，继续优先。
 */
function hasLegacyFutureHubCheckin(builtin: SiteConfig, override: SiteConfig): boolean {
  const checkin = override.checkin;
  return builtin.id === 'builtin-futurehub'
    && checkin?.method === 'auto'
    && checkin.workflow === undefined
    && (!checkin.url || checkin.url === '/console/personal')
    && !checkin.buttonSelector
    && !checkin.alreadySelector
    && !checkin.successSelector;
}

/**
 * AnyRouter 同理：编辑过这张卡片的用户，storage 里躺着一条
 * `{method:'auto', url:'/console/personal'}` 的覆盖记录 —— 那不是用户选的策略，
 * 而是它当年继承通用 new-api 模板留下的旧预设。逐层合并时覆盖优先，于是
 * 即使内置默认已改成「登录即签到」，这些用户仍会跳去 /console/personal
 * 等满 12 秒再报「签到页未找到明确按钮」。
 *
 * 只认这一种精确形态。改过按钮选择器、换过签到页、或选了别的方式（button /
 * api / relogin / claim / workflow）一律视为用户自定义，继续优先。
 */
function hasLegacyAnyRouterCheckin(builtin: SiteConfig, override: SiteConfig): boolean {
  const checkin = override.checkin;
  return builtin.id === 'builtin-anyrouter'
    && checkin?.method === 'auto'
    && checkin.workflow === undefined
    && (!checkin.url || checkin.url === '/console/personal')
    && !checkin.buttonSelector
    && !checkin.alreadySelector
    && !checkin.successSelector;
}

export function mergeBuiltinSite(builtin: SiteConfig, override: SiteConfig | undefined): SiteConfig {
  if (!override) return { ...builtin, builtin: true };
  /**
   * 这两种旧预设要**整块换成**内置默认，不能逐字段合并：AnyRouter 的旧记录
   * 带着 `url:'/console/personal'`，而新默认刻意不填 url（填了 none 方式仍会
   * 先跳过去白跑一趟）。逐字段合并保不住「没有这个字段」这个语义。
   */
  const legacyFutureHubCheckin = hasLegacyFutureHubCheckin(builtin, override);
  const legacyAnyRouterCheckin = hasLegacyAnyRouterCheckin(builtin, override);
  const useBuiltinCheckin = legacyFutureHubCheckin || legacyAnyRouterCheckin;
  /**
   * 学到的「登录即签到」是完整的签到策略，同样**整块**取用户记录。
   *
   * 逐字段合并会把内置模板的 url / buttonSelector 带回来（1412、Future Hub
   * 的模板都是按钮签到）：保存时的读回核对因此判定「仍保留旧签到入口」而失败，
   * 运行时也会继续按模板去找签到按钮 —— 学完了却还在走旧流程。
   */
  const useLearnedCheckin = !!override.checkin && isLearnedLoginAsCheckin(override);
  return {
    ...builtin,
    ...override,
    selectors: { ...builtin.selectors, ...override.selectors },
    closeModalSelectors: override.closeModalSelectors?.length
      ? override.closeModalSelectors
      : builtin.closeModalSelectors,
    ...(builtin.checkin || override.checkin
      ? {
          checkin: useLearnedCheckin
            ? { ...override.checkin!, method: 'none' as const }
            : useBuiltinCheckin
            ? {
                ...builtin.checkin,
                method: builtin.checkin?.method ?? 'auto',
              }
            : {
                ...builtin.checkin,
                ...override.checkin,
                // 两边都可能没写 method；缺失时扫描页面，不能凭空解释成登录即签到。
                method: override.checkin?.method ?? builtin.checkin?.method ?? 'auto',
              },
        }
      : {}),
    ...(builtin.adapter || override.adapter
      ? { adapter: { ...builtin.adapter, ...override.adapter } }
      : {}),
    ...(builtin.tokenConfig || override.tokenConfig
      ? { tokenConfig: { ...builtin.tokenConfig, ...override.tokenConfig } as SiteConfig['tokenConfig'] }
      : {}),
    builtin: true,
  };
}

/** 新建站点时的默认模板，供「导入站点」表单预填 */
export function blankSite(): Omit<SiteConfig, 'id'> {
  return {
    name: '',
    loginUrl: '',
    loginMethod: 'form',
    selectors: {
      username: COMMON_USERNAME_SELECTORS.join(', '),
      password: COMMON_PASSWORD_SELECTORS.join(', '),
      submit: 'button[type="submit"]',
    },
    closeModalSelectors: [...COMMON_CLOSE_SELECTORS],
    checkin: { method: 'auto' },
  };
}
