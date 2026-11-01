import { describe, expect, it } from 'vitest';
import { ADAPTER_FAMILIES, SITE_TYPES, type SiteConfig } from '@/types';
import {
  adapterCheckinFallback,
  adapterFamilyForSiteType,
  isAdapterCheckinPage,
  resolveSiteAdapter,
} from '@/automation/sites/site-adapters';

function site(adapter?: SiteConfig['adapter']): Pick<SiteConfig, 'adapter'> {
  return { adapter };
}

describe('运行时 SiteAdapter 能力', () => {
  it('兼容历史 new-api siteType，并提供个人设置签到页', () => {
    const resolved = resolveSiteAdapter(site({ siteType: SITE_TYPES.NEW_API }));

    expect(resolved.family).toBe(ADAPTER_FAMILIES.NEW_API);
    expect(resolved.checkinPath).toBe('/console/personal');
    expect(adapterCheckinFallback(site({ siteType: SITE_TYPES.NEW_API }))).toBe('/console/personal');
  });

  it('归并同族分叉，Sub2API 保留自己的常规签到页', () => {
    expect(adapterFamilyForSiteType(SITE_TYPES.VELOERA)).toBe(ADAPTER_FAMILIES.NEW_API);
    expect(adapterFamilyForSiteType(SITE_TYPES.SUB2API)).toBe(ADAPTER_FAMILIES.SUB2API);
    expect(adapterCheckinFallback(site({ family: ADAPTER_FAMILIES.SUB2API }))).toBe('/check-in');
  });

  it('显式路径覆盖默认路径，空路径可关闭默认兜底', () => {
    expect(adapterCheckinFallback(site({
      siteType: SITE_TYPES.NEW_API,
      checkinPath: 'rewards/daily',
    }))).toBe('/rewards/daily');
    expect(adapterCheckinFallback(site({
      siteType: SITE_TYPES.NEW_API,
      checkinPath: '',
    }))).toBeUndefined();
  });

  it('按适配器路径和明确标题识别签到页面', () => {
    const newApi = site({ siteType: SITE_TYPES.NEW_API });

    expect(isAdapterCheckinPage(newApi, '/console/personal')).toBe(true);
    expect(isAdapterCheckinPage(newApi, '/console/personal/history')).toBe(true);
    expect(isAdapterCheckinPage(newApi, '/console/token')).toBe(false);
    expect(isAdapterCheckinPage(site(), '/dashboard', 'Daily check-in rewards')).toBe(true);
  });

  it('支持白标站点追加自己的路径和标题能力', () => {
    const custom = site({
      family: ADAPTER_FAMILIES.NEW_API,
      checkin: {
        pathPatterns: ['/rewards/daily*'],
        titleWords: ['每日福利'],
      },
    });
    const resolved = resolveSiteAdapter(custom);

    expect(resolved.checkinPathPatterns).toEqual(['/rewards/daily']);
    expect(resolved.checkinTitleWords).toEqual(['每日福利']);
    expect(isAdapterCheckinPage(custom, '/rewards/daily/claim')).toBe(true);
    expect(isAdapterCheckinPage(custom, '/dashboard', '每日福利中心')).toBe(true);
    // 显式 titleWords 覆盖默认词表，避免站点误把普通“每日签到”标题当成目标页。
    expect(isAdapterCheckinPage(custom, '/dashboard', '每日签到说明')).toBe(false);
  });
});
