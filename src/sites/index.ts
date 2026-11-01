/**
 * 内置站点注册表 —— 兼容性 barrel。
 *
 * 新增一个站点只需在 `templates/` 下加一个文件并注册进 `registry.ts` ——
 * 通用自动化引擎 (src/automation/engine.ts) 会读取配置执行
 * 「关公告 → 填账密 → 登录 → 签到」，无需改动引擎代码。用户也可在界面上
 * 「导入站点」，配置会落到 storage。
 *
 * 目录结构：
 *   common-selectors.ts   跨站点复用的选择器常量
 *   template-types.ts     SiteTemplate 类型定义
 *   templates/<id>.ts      每个站点/站点族一个模板文件
 *   registry.ts            SITE_TEMPLATES 排序聚合 + BUILTIN_SITES
 *   merge.ts               matchTemplateByName / mergeBuiltinSite / blankSite 等合并逻辑
 *
 * 这个文件只做统一的类型/值再导出，保持调用方 `from '@/sites'` 不受影响。
 */
export * from './common-selectors';
export type { SiteTemplate } from './template-types';
export { SITE_TEMPLATES, BUILTIN_SITES } from './registry';
export { normalizedLoginUrl, matchTemplateByName, mergeBuiltinSite, blankSite } from './merge';

// 各模板与预设的具名再导出：供迁移逻辑与测试直接引用
// （如 LINXI_SITE_PRESET、DENXIO_SITE_PRESET、HVOY_SITE_PRESET 等）。
export { SUB2API_TEMPLATE } from './templates/sub2api';
export { NEW_API_TEMPLATE } from './templates/new-api';
export { FUTUREHUB_TEMPLATE } from './templates/futurehub';
export { ANYROUTER_TEMPLATE } from './templates/anyrouter';
export { LINXI_TEMPLATE, LINXI_SITE_PRESET } from './templates/linxi';
export { BAIBEI_TEMPLATE } from './templates/baibei';
export { DENXIO_TEMPLATE, DENXIO_SITE_PRESET } from './templates/denxio';
export { LINUX_SB_TEMPLATE, LINUX_SB_SITE_PRESET } from './templates/linux-sb';
export { VSLLM_TEMPLATE, VSLLM_SITE_PRESET } from './templates/vsllm';
export { HVOY_TEMPLATE, HVOY_SITE_PRESET } from './templates/hvoy';
export { NEW_API_NEXT_TEMPLATE, NEW_API_NEXT_SITE_PRESET } from './templates/new-api-next';
export { LEILEI_TEMPLATE, LEILEI_SITE_PRESET } from './templates/leilei';
export { TABIAI_TEMPLATE, TABIAI_SITE_PRESET } from './templates/tabiai';
export { MONKEYCODE_TEMPLATE } from './templates/monkeycode';
export { KID1412_TEMPLATE } from './templates/kid1412';
export { SHAREDCHAT_TEMPLATE } from './templates/sharedchat';
export { AGENTROUTER_TEMPLATE, AGENTROUTER_SITE_PRESET } from './templates/agentrouter';
