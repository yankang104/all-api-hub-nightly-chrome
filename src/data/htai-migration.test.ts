/**
 * 海獭 AI（htai91.com）归入新版 new-api 模板。
 *
 * 用户截图确认 `/profile` 上的「每日签到」卡片与 NEW_API_NEXT 模板逐项对应：
 *
 *   模板 buttonSelector: 'button >> text=立即签到'  ← 截图里的蓝色按钮
 *   模板 alreadySelector: 'button >> text=已签到'   ← 签到后变灰的状态
 *   模板 successText: ['签到成功', '今天 +']         ← 截图里的「今天 +$3.06」
 *
 * 此前它不在 hostname 名单里，旧记录套的是通用 new-api 预设的
 * `/console/personal`；站点把那个地址重定向到 `/profile`，于是反复跳转后
 * 报「签到页未找到明确按钮」。这是第五个同类站点，修法与前四个相同：
 * 让专用配置生效，而不是继续调通用扫描。
 */

import { describe, expect, it } from 'vitest';
import type { SiteConfig } from '@/types';
import { migrateLegacySiteDefaults } from './app-repository';

function htaiRecord(checkin?: SiteConfig['checkin']): SiteConfig {
  return {
    id: 'site_htai',
    name: '海獭AI',
    loginUrl: 'https://htai91.com/login',
    selectors: {
      username: '#username',
      password: '#password',
      submit: 'button[type="submit"]',
    },
    closeModalSelectors: ['.semi-modal-close'],
    loginMethod: 'github',
    ...(checkin ? { checkin } : {}),
    adapter: {
      siteType: 'new-api',
      family: 'new-api',
      checkinPath: '/console/personal',
      quotaPerUnit: 500_000,
    },
  };
}

describe('海獭 AI 旧记录迁移', () => {
  it('通用 new-api 形态迁到 /profile 按钮流程', () => {
    const [migrated] = migrateLegacySiteDefaults([
      htaiRecord({ method: 'auto', url: '/console/personal', apiUrl: '/api/user/checkin' }),
    ]);

    expect(migrated!.checkin?.method).toBe('button');
    expect(migrated!.checkin?.url).toBe('/profile');
    expect(migrated!.adapter?.checkinPath).toBe('/profile');
  });

  it('签到按钮与已签到判据来自模板（对应截图上的控件）', () => {
    const [migrated] = migrateLegacySiteDefaults([
      htaiRecord({ method: 'auto', url: '/console/personal' }),
    ]);

    expect(migrated!.checkin?.buttonSelector).toContain('立即签到');
    expect(migrated!.checkin?.alreadySelector).toContain('已签到');
    // 「今天 +$3.06」这类奖励文案是成功判据
    expect(migrated!.checkin?.successText).toContain('今天 +');
  });

  it('裸 {method:auto} 记录也迁移', () => {
    const [migrated] = migrateLegacySiteDefaults([htaiRecord({ method: 'auto' })]);

    expect(migrated!.checkin?.method).toBe('button');
    expect(migrated!.checkin?.url).toBe('/profile');
  });

  it('登录地址归一到 /sign-in（新版界面没有 /login 路由）', () => {
    const [migrated] = migrateLegacySiteDefaults([htaiRecord({ method: 'auto' })]);

    expect(new URL(migrated!.loginUrl).pathname).toBe('/sign-in');
  });

  it('账号级登录方式（github）被保留', () => {
    const [migrated] = migrateLegacySiteDefaults([htaiRecord({ method: 'auto' })]);

    expect(migrated!.loginMethod).toBe('github');
  });

  it('用户自定义签到方式时不覆盖', () => {
    const custom = htaiRecord({ method: 'api', apiUrl: '/api/my/checkin', apiMethod: 'POST' });

    expect(migrateLegacySiteDefaults([custom])[0]?.checkin?.method).toBe('api');
  });

  it('迁移是幂等的', () => {
    const once = migrateLegacySiteDefaults([htaiRecord({ method: 'auto' })]);
    const twice = migrateLegacySiteDefaults(once);

    expect(twice[0]).toEqual(once[0]);
  });

  it('同域名以外的站点不受影响', () => {
    const other: SiteConfig = {
      ...htaiRecord({ method: 'auto', url: '/console/personal' }),
      loginUrl: 'https://not-htai.example.com/login',
    };

    expect(migrateLegacySiteDefaults([other])[0]?.checkin?.method).toBe('auto');
  });
});
