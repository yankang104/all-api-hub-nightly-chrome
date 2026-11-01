/**
 * 一梦五千年旧记录的迁移。
 *
 * 修的是一个实测死循环：用户在专用模板加入**之前**导入这个站点，套用的是
 * 通用 new-api 预设（`auto` + `/console/personal`）。而站点会把
 * `/console/personal` 重定向到 `/profile`，于是签到流程判定「还没到签到页」
 * → 跳转 → 站点又重定向 → 脚本重新注入、stage 仍是 checkin → 再跳……
 * 日志里同一段反复出现，直到 10 分钟看门狗把任务杀掉，界面上一直显示「正在签到」。
 *
 * 原来的迁移白名单只认 `/profile*` 系的 adapter 形态，通用 new-api 留下的
 * `/console/personal*` + `['每日签到','daily check-in']` 两条都不匹配，
 * 于是迁移一次都不触发。
 */

import { describe, expect, it } from 'vitest';
import type { SiteConfig } from '@/types';
import { migrateLegacySiteDefaults } from './app-repository';

function legacyGenericNewApiRecord(): SiteConfig {
  return {
    id: 'site_leilei_legacy',
    name: '一梦五千年',
    loginUrl: 'https://fapi.leileihog.top/login',
    selectors: {
      username: '#username',
      password: '#password',
      submit: 'button[type="submit"]',
    },
    closeModalSelectors: ['.semi-modal-close'],
    loginMethod: 'auto',
    // 通用 new-api 模板留下的形态 —— 正是死循环的来源
    checkin: {
      method: 'auto',
      url: '/console/personal',
      apiUrl: '/api/user/checkin',
    },
    adapter: {
      siteType: 'new-api',
      family: 'new-api',
      checkinPath: '/console/personal',
      checkin: {
        pathPatterns: ['/console/personal*'],
        titleWords: ['每日签到', 'daily check-in'],
      },
      quotaPerUnit: 500_000,
    },
  };
}

describe('一梦五千年旧记录迁移', () => {
  it('误学成 none 且指向抽奖页时恢复现有抽奖执行器，保留登录和用户设置', () => {
    const stale: SiteConfig = {
      ...legacyGenericNewApiRecord(),
      loginUrl: 'https://fapi.leileihog.top/sign-in?custom=1',
      loginMethod: 'form',
      checkin: {
        method: 'none', learnedLoginAsCheckin: true,
        workflow: { steps: [], route: ['/lottery'], identityPath: '/lottery' },
      },
      adapter: { family: 'new-api', quotaPerUnit: 1_000_000, checkinPath: '/lottery' },
      authBootstrap: { endpoint: '/api/custom/refresh' },
    };
    const [migrated] = migrateLegacySiteDefaults([stale]);
    expect(migrated!.checkin).toEqual({ method: 'workflow', workflow: { steps: [{ type: 'leilei-daily' }] } });
    expect(migrated!.loginUrl).toBe(stale.loginUrl);
    expect(migrated!.selectors).toEqual(stale.selectors);
    expect(migrated!.loginMethod).toBe('form');
    expect(migrated!.adapter?.quotaPerUnit).toBe(1_000_000);
    expect(migrated!.authBootstrap).toEqual(stale.authBootstrap);
    expect(migrateLegacySiteDefaults([migrated!])[0]).toBe(migrated);
  });

  it('自动误判的 none 即使没有残留路线也恢复，补上身份和余额令牌引导', () => {
    const stale: SiteConfig = {
      ...legacyGenericNewApiRecord(),
      checkin: { method: 'none', learnedLoginAsCheckin: true, learnedLoginAsCheckinSource: 'auto' },
    };
    const [migrated] = migrateLegacySiteDefaults([stale]);
    expect(migrated!.checkin?.method).toBe('workflow');
    expect(migrated!.adapter?.checkinPath).toBe('/lottery');
    expect(migrated!.authBootstrap).toEqual({ endpoint: '/api/user/auth/refresh' });
  });

  it('旧版只录到导航、没有留下 route 或来源标记的错误 none 也能恢复', () => {
    const stale: SiteConfig = {
      ...legacyGenericNewApiRecord(),
      checkin: { method: 'none', learnedLoginAsCheckin: true },
    };
    expect(migrateLegacySiteDefaults([stale])[0]!.checkin?.workflow?.steps).toEqual([{ type: 'leilei-daily' }]);
  });

  it('明确选的 none 不被恢复规则覆盖', () => {
    const stale: SiteConfig = {
      ...legacyGenericNewApiRecord(),
      checkin: {
        method: 'none', learnedLoginAsCheckin: true,
        learnedLoginAsCheckinSource: 'explicit', workflow: { steps: [], route: ['/lottery'] },
      },
    };
    expect(migrateLegacySiteDefaults([stale])[0]!.checkin).toEqual(stale.checkin);
  });

  it('未标记为学习产物的 none 不被恢复规则覆盖', () => {
    const stale: SiteConfig = { ...legacyGenericNewApiRecord(), checkin: { method: 'none' } };
    expect(migrateLegacySiteDefaults([stale])[0]!.checkin).toEqual(stale.checkin);
  });

  it('真实学到的抽奖工作流保留原步骤，也能补齐身份令牌引导', () => {
    const current: SiteConfig = {
      ...legacyGenericNewApiRecord(),
      checkin: { method: 'workflow', workflow: { steps: [{ type: 'click', selector: '#draw' }], route: ['/lottery'], identityPath: '/lottery' } },
    };
    const [migrated] = migrateLegacySiteDefaults([current]);
    expect(migrated!.checkin).toEqual(current.checkin);
    expect(migrated!.authBootstrap).toEqual({ endpoint: '/api/user/auth/refresh' });
  });

  it('只修复精确 HTTPS 主机上的误判记录', () => {
    for (const url of ['https://fapi.leileihog.top.example.com/login', 'http://fapi.leileihog.top/login', 'https://other.example.com/login']) {
      const stale: SiteConfig = {
        ...legacyGenericNewApiRecord(), loginUrl: url,
        checkin: { method: 'none', learnedLoginAsCheckin: true, learnedLoginAsCheckinSource: 'auto' },
      };
      expect(migrateLegacySiteDefaults([stale])[0]!.checkin).toEqual(stale.checkin);
    }
  });

  it('通用 new-api 形态被迁移到专用工作流（死循环的直接修复）', () => {
    const [migrated] = migrateLegacySiteDefaults([legacyGenericNewApiRecord()]);

    expect(migrated!.checkin?.method).toBe('workflow');
    expect(migrated!.checkin?.workflow?.steps).toEqual([{ type: 'leilei-daily' }]);
    // 旧的 /console/personal 必须彻底消失，否则仍会跳转
    expect(migrated!.checkin?.url).toBeUndefined();
    // 站点改版后只有抽奖，落地页就是抽奖页
    expect(migrated!.adapter?.checkinPath).toBe('/lottery');
    // /profile* 仍要留着：老配置会先落在那一页，它也得算「已在签到页」
    expect(migrated!.adapter?.checkin?.pathPatterns).toEqual(['/lottery*', '/profile*']);
  });

  it('登录地址归一到 /sign-in（新版界面没有 /login 路由）', () => {
    const [migrated] = migrateLegacySiteDefaults([legacyGenericNewApiRecord()]);

    expect(new URL(migrated!.loginUrl).pathname).toBe('/sign-in');
  });

  it('已经是工作流的记录不被覆盖', () => {
    const current: SiteConfig = {
      ...legacyGenericNewApiRecord(),
      checkin: { method: 'workflow', workflow: { steps: [{ type: 'leilei-daily' }] } },
    };

    const [migrated] = migrateLegacySiteDefaults([current]);

    expect(migrated!.checkin?.method).toBe('workflow');
  });

  /**
   * 站点改版：现在只有抽奖，个人页已经没有签到入口（2026-08-26 用户确认）。
   *
   * 这批记录已经迁到工作流了，所以上面那条迁移碰不到它们（见
   * isLegacyLeileiSite 对 workflow 的处理）—— 落地页会一直停在 /profile，
   * 每轮先白跑一趟个人页才转去抽奖。
   */
  it('已迁到工作流但落地页还是 /profile 的记录被挪到 /lottery', () => {
    const stale: SiteConfig = {
      ...legacyGenericNewApiRecord(),
      loginUrl: 'https://fapi.leileihog.top/sign-in',
      checkin: { method: 'workflow', workflow: { steps: [{ type: 'leilei-daily' }] } },
      adapter: {
        siteType: 'new-api',
        family: 'new-api',
        checkinPath: '/profile',
        checkin: { pathPatterns: ['/profile*', '/lottery*'], titleWords: ['每日签到', '浮梦引光', '抽奖'] },
        quotaPerUnit: 500_000,
      },
    };

    const [migrated] = migrateLegacySiteDefaults([stale]);

    expect(migrated!.adapter?.checkinPath).toBe('/lottery');
    expect(migrated!.adapter?.checkin?.pathPatterns).toEqual(['/lottery*', '/profile*']);
    // 工作流本身不该被这条迁移动到
    expect(migrated!.checkin?.workflow?.steps).toEqual([{ type: 'leilei-daily' }]);
  });

  it('落地页已是 /lottery 时迁移不再改动记录（幂等）', () => {
    const current: SiteConfig = {
      ...legacyGenericNewApiRecord(),
      loginUrl: 'https://fapi.leileihog.top/sign-in',
      checkin: { method: 'workflow', workflow: { steps: [{ type: 'leilei-daily' }] } },
      adapter: {
        siteType: 'new-api',
        family: 'new-api',
        checkinPath: '/lottery',
        checkin: { pathPatterns: ['/lottery*', '/profile*'], titleWords: ['浮梦引光', '抽奖', '每日签到'] },
        quotaPerUnit: 500_000,
      },
      authBootstrap: { endpoint: '/api/user/auth/refresh' },
    };

    const [migrated] = migrateLegacySiteDefaults([current]);

    // 同一个对象引用 = 没重写存储
    expect(migrated).toBe(current);
  });

  it('已迁过落地页但缺令牌引导的记录补上 authBootstrap（余额/身份 401 的修复）', () => {
    // 用户实测：站点改版后前端把令牌放进内存，扩展默认请求头读不到 /api/user/self ——
    // 余额、签到快照、身份全部落空。老记录必须补上引导配置。
    const stale: SiteConfig = {
      ...legacyGenericNewApiRecord(),
      loginUrl: 'https://fapi.leileihog.top/sign-in',
      checkin: { method: 'workflow', workflow: { steps: [{ type: 'leilei-daily' }] } },
      adapter: {
        siteType: 'new-api',
        family: 'new-api',
        checkinPath: '/lottery',
        checkin: { pathPatterns: ['/lottery*', '/profile*'], titleWords: ['浮梦引光', '抽奖', '每日签到'] },
        quotaPerUnit: 500_000,
      },
    };

    const [migrated] = migrateLegacySiteDefaults([stale]);

    expect(migrated!.authBootstrap).toEqual({ endpoint: '/api/user/auth/refresh' });
    // 只补这一个字段：落地页与工作流原样保留
    expect(migrated!.adapter?.checkinPath).toBe('/lottery');
    expect(migrated!.checkin?.workflow?.steps).toEqual([{ type: 'leilei-daily' }]);
    // 再跑一遍不再改动（幂等）
    expect(migrateLegacySiteDefaults([migrated!])[0]).toBe(migrated);
  });

  it('用户自己填过令牌引导地址时不被覆盖', () => {
    const custom: SiteConfig = {
      ...legacyGenericNewApiRecord(),
      loginUrl: 'https://fapi.leileihog.top/sign-in',
      checkin: { method: 'workflow', workflow: { steps: [{ type: 'leilei-daily' }] } },
      adapter: {
        siteType: 'new-api',
        family: 'new-api',
        checkinPath: '/lottery',
        checkin: { pathPatterns: ['/lottery*', '/profile*'], titleWords: ['浮梦引光', '抽奖', '每日签到'] },
        quotaPerUnit: 500_000,
      },
      authBootstrap: { endpoint: '/api/my/refresh' },
    };

    const [migrated] = migrateLegacySiteDefaults([custom]);

    expect(migrated).toBe(custom);
  });

  it('自定义了落地页的用户不被这条迁移覆盖', () => {
    const custom: SiteConfig = {
      ...legacyGenericNewApiRecord(),
      loginUrl: 'https://fapi.leileihog.top/sign-in',
      checkin: { method: 'workflow', workflow: { steps: [{ type: 'leilei-daily' }] } },
      adapter: {
        siteType: 'new-api',
        family: 'new-api',
        checkinPath: '/lottery',
        checkin: { pathPatterns: ['/lottery*', '/my-page*'], titleWords: ['抽奖'] },
        quotaPerUnit: 500_000,
      },
    };

    const [migrated] = migrateLegacySiteDefaults([custom]);

    expect(migrated!.adapter?.checkin?.pathPatterns).toEqual(['/lottery*', '/my-page*']);
  });

  it('用户明确选了别的签到方式时不被覆盖', () => {
    const custom: SiteConfig = {
      ...legacyGenericNewApiRecord(),
      checkin: { method: 'api', apiUrl: '/api/user/checkin', apiMethod: 'POST' },
    };

    const [migrated] = migrateLegacySiteDefaults([custom]);

    expect(migrated!.checkin?.method).toBe('api');
  });

  it('用户自定义了签到页路径时不被覆盖', () => {
    const custom = legacyGenericNewApiRecord();
    custom.checkin = { method: 'auto', url: '/my-custom-checkin' };

    const [migrated] = migrateLegacySiteDefaults([custom]);

    expect(migrated!.checkin?.method).toBe('auto');
    expect(migrated!.checkin?.url).toBe('/my-custom-checkin');
  });

  it('自定义额度换算率被保留', () => {
    const custom = legacyGenericNewApiRecord();
    custom.adapter = { ...custom.adapter, quotaPerUnit: 1_000_000 };

    const [migrated] = migrateLegacySiteDefaults([custom]);

    expect(migrated!.checkin?.method).toBe('workflow');
    expect(migrated!.adapter?.quotaPerUnit).toBe(1_000_000);
  });

  it('同域名但别的站点不受影响', () => {
    const other: SiteConfig = {
      ...legacyGenericNewApiRecord(),
      id: 'site_other',
      name: '别的站点',
      loginUrl: 'https://api.example.com/login',
    };

    const [migrated] = migrateLegacySiteDefaults([other]);

    expect(migrated!.checkin?.method).toBe('auto');
    expect(migrated!.checkin?.url).toBe('/console/personal');
  });

  it('迁移是幂等的（重复 load 不会反复改写）', () => {
    const once = migrateLegacySiteDefaults([legacyGenericNewApiRecord()]);
    const twice = migrateLegacySiteDefaults(once);

    expect(twice[0]).toEqual(once[0]);
  });
});
