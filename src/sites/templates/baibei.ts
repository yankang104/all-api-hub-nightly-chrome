import { SITE_TYPES } from '@/types';
import { LINXI_SITE_PRESET } from './linxi';
import type { SiteTemplate } from '../template-types';

/** 百倍与林夕是同一套已确认的 Sub2API `/check-in` 页面，直接复用同一预设。 */
export const BAIBEI_TEMPLATE: SiteTemplate = {
  id: 'baibei',
  label: '百倍',
  siteType: SITE_TYPES.SUB2API,
  fingerprints: { hostnames: ['sub.100xlabs.space'] },
  preset: LINXI_SITE_PRESET,
};
