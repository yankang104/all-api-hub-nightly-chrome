import type { SiteConfig } from '@/types';
import type { SiteTemplate } from './template-types';
import { AGENTROUTER_TEMPLATE } from './templates/agentrouter';
import { KID1412_TEMPLATE } from './templates/kid1412';
import { SHAREDCHAT_TEMPLATE } from './templates/sharedchat';
import { MONKEYCODE_TEMPLATE } from './templates/monkeycode';
import { FUTUREHUB_TEMPLATE } from './templates/futurehub';
import { ANYROUTER_TEMPLATE } from './templates/anyrouter';
import { LINXI_TEMPLATE } from './templates/linxi';
import { BAIBEI_TEMPLATE } from './templates/baibei';
import { DENXIO_TEMPLATE } from './templates/denxio';
import { LINUX_SB_TEMPLATE } from './templates/linux-sb';
import { TABIAI_TEMPLATE } from './templates/tabiai';
import { LEILEI_TEMPLATE } from './templates/leilei';
import { NEW_API_NEXT_TEMPLATE } from './templates/new-api-next';
import { VSLLM_TEMPLATE } from './templates/vsllm';
import { HVOY_TEMPLATE } from './templates/hvoy';
import { SUB2API_TEMPLATE } from './templates/sub2api';
import { NEW_API_TEMPLATE } from './templates/new-api';

/**
 * 内置站点模板注册表。
 *
 * 顺序即匹配优先级：专用模板必须排在它所属通用协议模板之前，
 * 否则会被更泛化的配置提前命中并覆盖。每条排序理由见各模板文件顶部注释，
 * 这里只保留跨模板的相对顺序依赖说明。
 */
export const SITE_TEMPLATES: SiteTemplate[] = [
  AGENTROUTER_TEMPLATE,
  KID1412_TEMPLATE,
  SHAREDCHAT_TEMPLATE,
  MONKEYCODE_TEMPLATE,
  FUTUREHUB_TEMPLATE,
  // 专用模板必须排在通用协议模板之前。
  ANYROUTER_TEMPLATE,
  // 林夕属于 Sub2API，但需要比通用家族更严格的 /check-in 按钮证据。
  LINXI_TEMPLATE,
  // 百倍同样固定走 /check-in；精确模板必须排在通用 Sub2API 之前。
  BAIBEI_TEMPLATE,
  // 登仙的路由是 /checkin，并带赞助领取二次确认，不能落入通用 /check-in。
  DENXIO_TEMPLATE,
  // Linux.SB 使用 /login 与 /daily_checkin，不属于已支持的 API 面板家族。
  LINUX_SB_TEMPLATE,
  // TaBiAI 要先从头像菜单进入个人资料，必须排在新版通用模板之前。
  TABIAI_TEMPLATE,
  // 一梦五千年在每日签到后还要进入 /lottery 抽奖，必须排在通用新版模板之前。
  LEILEI_TEMPLATE,
  // 新版界面路由与旧版不同，同样要排在通用 new-api 模板之前
  NEW_API_NEXT_TEMPLATE,
  // VSLLM 还要答题并循环翻牌，不能落入只做一次签到的通用模板。
  VSLLM_TEMPLATE,
  // Hvoy 的登录和签到都会在业务点击后弹出拼图滑块。
  HVOY_TEMPLATE,
  SUB2API_TEMPLATE,
  NEW_API_TEMPLATE,
];

/**
 * 内置站点。
 *
 * 这些是用户明确要求在首页直接显示的站点，不需要先导入书签。账号始终由
 * 用户单独添加；内置项只提供已验证/保守的登录、公告和签到流程默认值。
 */
function builtinSite(
  id: string,
  name: string,
  loginUrl: string,
  preset: SiteTemplate['preset'],
): SiteConfig {
  return {
    id,
    name,
    loginUrl,
    favicon: new URL('/favicon.ico', loginUrl).href,
    builtin: true,
    ...preset,
    selectors: { ...preset.selectors },
    closeModalSelectors: [...preset.closeModalSelectors],
    checkin: preset.checkin ? { ...preset.checkin } : undefined,
    adapter: preset.adapter ? { ...preset.adapter } : undefined,
  };
}

export const BUILTIN_SITES: SiteConfig[] = [
  builtinSite('builtin-anyrouter', 'AnyRouter', 'https://anyrouter.top/login', ANYROUTER_TEMPLATE.preset),
  builtinSite('builtin-futurehub', 'Future Hub', 'https://api.futureppo.top/login', FUTUREHUB_TEMPLATE.preset),
  builtinSite('builtin-kid1412', "1412's API", 'https://napi.kid1412.qzz.io/sign-in', KID1412_TEMPLATE.preset),
];
