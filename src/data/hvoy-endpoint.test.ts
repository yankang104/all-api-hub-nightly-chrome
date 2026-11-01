/**
 * 禾维签到端点的迁移。
 *
 * 禾维的签到接口是 `/api/user/clock_in`，**不是** new-api 系通用的
 * `/api/user/checkin`。这一个字段决定了会不会碰到验证码：
 *
 *  - 配对了：扩展在 service worker 里带 cookie 直连完成签到，不开标签页，
 *    也就遇不到登录页的 Turnstile 和签到点击后的滑块；
 *  - 配错了：直连 404 → 判定「站点不支持」→ 连续三次熔断 24 小时 →
 *    之后每天都被迫走浏览器过两道验证。
 *
 * 前几轮一直在调滑块的图像识别，方向是错的：识别率不可能做到 100%，
 * 而这个站点本来就有一条不需要识别的路。
 */

import { describe, expect, it } from 'vitest';
import type { SiteConfig } from '@/types';
import { migrateLegacySiteDefaults } from './app-repository';
import { HVOY_SITE_PRESET } from '@/sites';
import { resolveCheckinEndpoints } from '@/lib/checkin/checkin-endpoints';

/** 误套通用 new-api 模板保存下来的旧记录 */
function legacyHvoyRecord(): SiteConfig {
  return {
    id: 'site_hvoy_legacy',
    name: '禾维',
    loginUrl: 'https://www.hvoy.ai/login',
    selectors: {
      username: '#username',
      password: '#password',
      submit: 'button[type="submit"]',
    },
    closeModalSelectors: ['.semi-modal-close'],
    loginMethod: 'auto',
    checkin: {
      method: 'auto',
      url: '/console/personal',
      // 通用 new-api 的端点 —— 禾维用它必然 404
      apiUrl: '/api/user/checkin',
    },
    adapter: {
      siteType: 'new-api',
      family: 'new-api',
      checkinPath: '/console/personal',
      checkin: {
        pathPatterns: ['/console/personal*', '/dashboard*'],
        titleWords: ['每日签到', 'daily check-in'],
      },
      quotaPerUnit: 500_000,
    },
  };
}

describe('禾维签到端点', () => {
  it('模板里配的是 clock_in，不是通用 checkin', () => {
    expect(HVOY_SITE_PRESET.checkin?.apiUrl).toBe('/api/user/clock_in');
  });

  it('旧记录的错误端点被迁移纠正', () => {
    const [migrated] = migrateLegacySiteDefaults([legacyHvoyRecord()]);

    expect(migrated!.checkin?.apiUrl).toBe('/api/user/clock_in');
  });

  it('迁移后登录地址回到首页（页头「登录」入口才有账密表单）', () => {
    const [migrated] = migrateLegacySiteDefaults([legacyHvoyRecord()]);

    expect(new URL(migrated!.loginUrl).pathname).toBe('/');
  });

  it('迁移是幂等的', () => {
    const once = migrateLegacySiteDefaults([legacyHvoyRecord()]);
    const twice = migrateLegacySiteDefaults(once);

    expect(twice[0]).toEqual(once[0]);
  });

  it('用户手填过别的端点时不覆盖', () => {
    const custom = legacyHvoyRecord();
    custom.checkin = { method: 'auto', url: '/', apiUrl: '/api/my/custom-checkin' };

    const [migrated] = migrateLegacySiteDefaults([custom]);

    expect(migrated!.checkin?.apiUrl).toBe('/api/my/custom-checkin');
  });

  it('同域名以外的站点不受影响', () => {
    const other: SiteConfig = {
      ...legacyHvoyRecord(),
      id: 'site_other',
      loginUrl: 'https://api.example.com/login',
    };

    const [migrated] = migrateLegacySiteDefaults([other]);

    expect(migrated!.checkin?.apiUrl).toBe('/api/user/checkin');
  });

  it('显式配置的 apiUrl 优先于家族兜底表', () => {
    const [migrated] = migrateLegacySiteDefaults([legacyHvoyRecord()]);
    const resolved = resolveCheckinEndpoints(
      migrated!.adapter?.family ?? 'unsupported',
      migrated!.checkin?.apiUrl,
      migrated!.checkin?.apiMethod,
    );

    // 站点配了具体端点时，直连只打它，不再试家族兜底
    expect(resolved).not.toBeNull();
    expect(resolved!.explicit).toBe(true);
    expect(resolved!.checkin).toEqual(['/api/user/clock_in']);
  });
});

describe('new-api 家族兜底端点表', () => {
  it('包含各分叉已实测的签到命名，漏一条就会熔断', () => {
    // 不配 explicitApiUrl，走家族兜底
    const resolved = resolveCheckinEndpoints('new-api');

    expect(resolved).not.toBeNull();
    expect(resolved!.explicit).toBe(false);
    expect(resolved!.checkin).toContain('/api/user/checkin');
    expect(resolved!.checkin).toContain('/api/user/clock_in');
    expect(resolved!.checkin).toContain('/api/user/daily_checkin');
  });

  it('通用端点排在最前 —— 绝大多数站点一次命中，不白发请求', () => {
    const resolved = resolveCheckinEndpoints('new-api');

    expect(resolved!.checkin[0]).toBe('/api/user/checkin');
  });

  it('家族不认识且没有显式地址时返回 null，不盲试', () => {
    expect(resolveCheckinEndpoints('unsupported')).toBeNull();
  });
});
