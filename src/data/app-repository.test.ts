import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, AccountBalance, LoginMethod, ProxyConfig, SiteConfig } from '@/types';
import { resolveEffectiveMethods } from '@/lib/checkin/effective-method';
import { KEYS } from '@/lib/core/storage';
import { appRepository, mergeAccountUpdate, migrateLegacySiteDefaults, restoreHiddenSitesWithAccounts } from './app-repository';

const account: Account = {
  id: 'account-1',
  siteId: 'site-1',
  username: 'user@example.com',
  password: 'secret',
  loginMethod: 'token',
  apiToken: 'old-token',
  proxyMode: 'custom',
  proxyId: 'stale-pool',
  customProxy: {
    scheme: 'http',
    host: '127.0.0.1',
    port: 7890,
  },
};

describe('mergeAccountUpdate', () => {
  it('clears the account-level login override when the editor selects follow-site', () => {
    const updated = mergeAccountUpdate(account, {
      loginMethod: '' as LoginMethod,
    });

    expect(updated).not.toHaveProperty('loginMethod');
    expect(updated.apiToken).toBe('old-token');
  });

  it('removes proxy fields that are not valid for the selected mode', () => {
    const inherited = mergeAccountUpdate(account, { proxyMode: 'inherit' });
    expect(inherited).not.toHaveProperty('proxyId');
    expect(inherited).not.toHaveProperty('customProxy');

    const pooled = mergeAccountUpdate(account, { proxyMode: 'pool', proxyId: 'pool-2' });
    expect(pooled.proxyId).toBe('pool-2');
    expect(pooled).not.toHaveProperty('customProxy');
  });

  it('never permits a patch to replace the account id', () => {
    const updated = mergeAccountUpdate(account, { id: 'different-id', label: 'new label' });
    expect(updated.id).toBe('account-1');
    expect(updated.label).toBe('new label');
  });
});

describe('migrateLegacySiteDefaults', () => {
  const legacySite = {
    id: 'legacy-futurehub',
    name: 'Future Hub',
    loginUrl: 'https://api.futureppo.top/console/personal',
    loginMethod: 'auto' as const,
    selectors: { username: '#username', password: '#password', submit: 'button[type="submit"]' },
    closeModalSelectors: [],
    checkin: { method: 'auto' as const, url: '/console/personal' },
  };

  it('upgrades an old generic Future Hub record to the verified button flow', () => {
    const [site] = migrateLegacySiteDefaults([legacySite]);
    expect(site).toMatchObject({
      loginUrl: 'https://api.futureppo.top/login',
      checkin: {
        method: 'button',
        url: '/console/personal',
        buttonSelector: 'button >> text=立即签到',
        alreadySelector: 'button >> text=今日已签到',
      },
      adapter: { family: 'new-api', quotaPerUnit: 500_000 },
    });
  });

  it('keeps a Future Hub record with a user-defined selector unchanged', () => {
    const custom = {
      ...legacySite,
      checkin: { method: 'button' as const, url: '/custom', buttonSelector: '#my-checkin' },
    };
    const [site] = migrateLegacySiteDefaults([custom]);
    expect(site).toBe(custom);
  });

  it('does not alter unrelated sites', () => {
    const other = { ...legacySite, id: 'other', loginUrl: 'https://example.com/login' };
    const [site] = migrateLegacySiteDefaults([other]);
    expect(site).toBe(other);
  });

  it('upgrades an existing Agent Router root import to the current login and dashboard evidence', () => {
    const [site] = migrateLegacySiteDefaults([{
      id: 'agent-router',
      name: 'Agent Router',
      loginUrl: 'https://agentrouter.org/',
      loginMethod: 'github',
      selectors: { username: '#username', password: '#password', submit: 'button[type="submit"]' },
      closeModalSelectors: [],
      successIndicator: 'a[href="/console/token"], a[href="/console/topup"]',
      checkin: { method: 'relogin', logoutApiUrl: '/api/user/logout' },
    }]);

    expect(site).toMatchObject({
      loginUrl: 'https://agentrouter.org/login',
      successIndicator: expect.stringContaining('text=账户数据'),
      closeModalSelectors: expect.arrayContaining([
        'button >> text=关闭公告',
        'button >> text=今日关闭',
      ]),
      checkin: {
        method: 'relogin',
        logoutApiUrl: '/api/user/logout',
        logoutStorageKeys: ['user', 'token', 'access_token'],
      },
    });
  });

  describe('Linux.SB legacy custom-site defaults', () => {
    const legacyLinuxSb: SiteConfig = {
      id: 'user-linux-sb',
      name: 'My Linux.SB',
      loginUrl: 'https://linux.sb/daily?from=old#checkin',
      loginMethod: 'form',
      pointerMode: 'trusted',
      selectors: {
        username: '#username',
        password: '#password',
        submit: 'button[type="submit"]',
      },
      closeModalSelectors: [],
      checkin: { method: 'auto' },
      proxyId: 'proxy-kept',
    };

    it('upgrades the untouched auto shape while preserving identity and proxy fields', () => {
      const [site] = migrateLegacySiteDefaults([legacyLinuxSb]);

      expect(site).toMatchObject({
        id: 'user-linux-sb',
        name: 'My Linux.SB',
        loginUrl: 'https://linux.sb/login',
        loginMethod: 'form',
        pointerMode: 'trusted',
        proxyId: 'proxy-kept',
        checkin: {
          method: 'auto',
          url: '/daily_checkin',
          buttonSelector: expect.stringContaining('立即签到'),
          alreadySelector: expect.stringContaining('已完成'),
          alreadyText: expect.arrayContaining(['今天已签到', '已完成']),
        },
        adapter: {
          family: 'unsupported',
          checkinPath: '/daily_checkin',
          checkin: { pathPatterns: ['/daily_checkin*'], titleWords: ['每日签到'] },
        },
      });
      expect(site).not.toBe(legacyLinuxSb);
    });

    it('also upgrades a record whose old check-in block is missing', () => {
      const { checkin: _omitted, ...withoutCheckin } = legacyLinuxSb;
      const [site] = migrateLegacySiteDefaults([withoutCheckin]);
      expect(site?.checkin).toMatchObject({ method: 'button', url: '/daily_checkin' });
      expect(site?.checkin?.buttonSelector).toContain('立即签到');
    });

    it.each([
      { method: 'button' as const, url: '/daily', buttonSelector: '#custom-checkin' },
      { method: 'api' as const, apiUrl: '/custom/checkin' },
      { method: 'auto' as const, url: '/daily' },
      { method: 'workflow' as const, workflow: { steps: [{ type: 'assert' as const, text: ['done'] }] } },
    ])('does not overwrite an explicit user check-in flow %#', (checkin) => {
      const custom: SiteConfig = { ...legacyLinuxSb, checkin };
      expect(migrateLegacySiteDefaults([custom])[0]).toBe(custom);
    });

    it.each(['auto', 'button'] as const)(
      'adds /daily_checkin to a URL-less %s flow without replacing explicit selectors',
      (method) => {
        const checkin = {
          method,
          buttonSelector: '#custom-checkin',
          alreadySelector: '#custom-complete',
          successSelector: '#custom-success',
          successText: ['自定义成功'],
          alreadyText: ['自定义已签'],
        };
        const custom: SiteConfig = {
          ...legacyLinuxSb,
          loginMethod: method === 'button' ? 'passkey' : 'github',
          checkin,
        };

        const [site] = migrateLegacySiteDefaults([custom]);

        expect(site?.checkin).toEqual({
          ...checkin,
          url: '/daily_checkin',
        });
        expect(site?.loginMethod).toBe(custom.loginMethod);
        expect(site?.proxyId).toBe(custom.proxyId);
        expect(migrateLegacySiteDefaults([site!])[0]).toBe(site);
      },
    );

    it.each([
      { method: 'auto' as const, apiUrl: '/custom/checkin' },
      {
        method: 'button' as const,
        entry: { readySelector: '#ready', steps: [{ selector: '#daily-entry' }] },
      },
    ])('does not replace an explicit URL-less navigation/API flow %#', (checkin) => {
      const custom: SiteConfig = { ...legacyLinuxSb, checkin };
      expect(migrateLegacySiteDefaults([custom])[0]).toBe(custom);
    });

    it('migrates a legacy root login URL for an explicit button flow without changing user fields', () => {
      const checkin = {
        method: 'button' as const,
        url: '/daily',
        buttonSelector: '#custom-checkin',
        alreadySelector: '#already-checked-in',
        successText: ['签到成功'],
      };
      const custom: SiteConfig = {
        ...legacyLinuxSb,
        loginUrl: 'https://linux.sb/?from=legacy#login',
        checkin,
      };

      const [site] = migrateLegacySiteDefaults([custom]);

      expect(site).not.toBe(custom);
      expect(site).toEqual({
        ...custom,
        loginUrl: 'https://linux.sb/login',
      });
      expect(site?.checkin).toBe(checkin);
      expect(site?.selectors).toBe(custom.selectors);
    });

    it('does not migrate a non-root custom login path', () => {
      const custom: SiteConfig = {
        ...legacyLinuxSb,
        loginUrl: 'https://linux.sb/custom-login?from=legacy#login',
        checkin: {
          method: 'button',
          url: '/daily',
          buttonSelector: '#custom-checkin',
        },
      };

      expect(migrateLegacySiteDefaults([custom])[0]).toBe(custom);
    });

    it('does not migrate another hostname merely because its display name says Linux.SB', () => {
      const other: SiteConfig = {
        ...legacyLinuxSb,
        name: 'Linux.SB',
        loginUrl: 'https://linux-sb.example/',
      };
      expect(migrateLegacySiteDefaults([other])[0]).toBe(other);
    });

    it('is idempotent after the dedicated preset has been applied', () => {
      const [first] = migrateLegacySiteDefaults([legacyLinuxSb]);
      expect(migrateLegacySiteDefaults([first!])[0]).toBe(first);
    });

    it('keeps an explicit button migration idempotent', () => {
      const custom: SiteConfig = {
        ...legacyLinuxSb,
        loginUrl: 'https://linux.sb/',
        checkin: {
          method: 'button',
          url: '/daily',
          buttonSelector: '#custom-checkin',
        },
      };
      const [first] = migrateLegacySiteDefaults([custom]);
      const [second] = migrateLegacySiteDefaults([first!]);

      expect(first?.loginUrl).toBe('https://linux.sb/login');
      expect(second).toBe(first);
    });
  });

  describe('林夕旧站点配置', () => {
    const legacyLinxi: SiteConfig = {
      id: 'site-linxi',
      name: '林夕',
      loginUrl: 'https://k40.shengqainbang.cn/login',
      loginMethod: 'form',
      selectors: { username: '#email', password: '#password', submit: 'button[type="submit"]' },
      closeModalSelectors: [],
      checkin: { method: 'none' },
      adapter: { family: 'new-api', checkinPath: '/console/personal', quotaPerUnit: 500_000 },
    };

    it('把 none 假成功升级为真实 /check-in 按钮流程，同时保留站点 ID 与登录入口', () => {
      const [site] = migrateLegacySiteDefaults([legacyLinxi]);
      expect(site).toMatchObject({
        id: 'site-linxi',
        name: '林夕',
        loginUrl: 'https://k40.shengqainbang.cn/login',
        loginMethod: 'form',
        tokenConfig: {
          storageKey: 'auth_token',
          identityEndpoint: '/api/v1/auth/me',
        },
        checkin: {
          method: 'button',
          url: '/check-in',
          buttonSelector: 'button >> text=立即签到, button >> text=Check in',
          alreadySelector: 'button >> text=今日已签到, button >> text=Already checked in today',
          successText: ['签到成功', 'Checked in — got'],
          alreadyText: ['今日已签到', '今天已经签过了', 'Already checked in today'],
        },
        adapter: {
          siteType: 'sub2api',
          family: 'sub2api',
          checkinPath: '/check-in',
          checkin: { pathPatterns: ['/check-in*'] },
          quotaPerUnit: 1,
        },
      });
    });

    it('只升级完整匹配旧通用模板的 auto + /console/personal + API', () => {
      const [site] = migrateLegacySiteDefaults([{
        ...legacyLinxi,
        checkin: {
          method: 'auto',
          url: '/console/personal',
          apiUrl: '/api/user/checkin',
        },
      }]);
      expect(site?.checkin).toMatchObject({
        method: 'button',
        url: '/check-in',
        buttonSelector: 'button >> text=立即签到, button >> text=Check in',
      });
    });

    it('把错误的 /sign-in、token 站点默认和通用选择器归一到真实登录策略', () => {
      const [site] = migrateLegacySiteDefaults([{
        ...legacyLinxi,
        loginUrl: 'https://k40.shengqainbang.cn/sign-in?redirect=%2Fcheck-in#old',
        loginMethod: 'token',
        selectors: {
          username: 'input[name="username"]',
          password: 'input[name="password"]',
          submit: 'button.semi-button-primary',
        },
        tokenConfig: {
          storageKey: 'wrong_token',
          headerName: 'X-Token',
          headerPrefix: '',
        },
        proxyId: 'proxy-kept',
      }]);

      expect(site).toMatchObject({
        loginUrl: 'https://k40.shengqainbang.cn/login',
        loginMethod: 'form',
        selectors: {
          username: '#email',
          password: '#password',
          submit: 'button[type="submit"], .btn.btn-primary',
        },
        tokenConfig: {
          storageKey: 'auth_token',
          headerName: 'Authorization',
          headerPrefix: 'Bearer ',
          identityEndpoint: '/api/v1/auth/me',
        },
        proxyId: 'proxy-kept',
      });
    });

    it('升级 Sub2API 通用模板留下的 auto + /check-in', () => {
      const [site] = migrateLegacySiteDefaults([{
        ...legacyLinxi,
        checkin: { method: 'auto', url: '/check-in' },
        adapter: { family: 'sub2api', checkinPath: '/check-in', quotaPerUnit: 1 },
      }]);
      expect(site?.checkin?.method).toBe('button');
      expect(site?.checkin?.url).toBe('/check-in');
    });

    it.each([
      { method: 'auto' as const },
      { method: 'auto' as const, url: '/profile' },
      { method: 'auto' as const, url: '/console/personal' },
      { method: 'auto' as const, url: '/check-in', apiMethod: 'POST' as const },
    ])('不覆盖不完整或自定义的 auto 配置 %#', (checkin) => {
      const custom: SiteConfig = { ...legacyLinxi, checkin };
      expect(migrateLegacySiteDefaults([custom])[0]).toBe(custom);
    });

    it('不按显示名跨域迁移其它站点', () => {
      const other: SiteConfig = {
        ...legacyLinxi,
        loginUrl: 'https://legacy-linxi.example/login',
      };
      expect(migrateLegacySiteDefaults([other])[0]).toBe(other);
    });

    it('gy.leyanshi.me 即使显示名为林夕也不会被误迁移成林夕，而是按它真实的新版 new-api 界面升级', () => {
      const zynk: SiteConfig = {
        ...legacyLinxi,
        loginUrl: 'https://gy.leyanshi.me/login',
      };
      const [site] = migrateLegacySiteDefaults([zynk]);
      // 不是林夕（Sub2API /check-in + Bearer）……
      expect(site?.adapter?.family).not.toBe('sub2api');
      expect(site?.tokenConfig).toBeUndefined();
      expect(site?.checkin?.url).not.toBe('/check-in');
      // ……而是它真实的新版 new-api 界面：/sign-in 登录、/profile 签到、有登录成功标志。
      expect(site).toMatchObject({
        id: 'site-linxi',
        loginUrl: 'https://gy.leyanshi.me/sign-in',
        successIndicator: 'a[href="/keys"], a[href="/wallet"]',
        checkin: { method: 'button', url: '/profile' },
        adapter: { family: 'new-api', checkinPath: '/profile' },
      });
    });

    it('新版 new-api 模板名单里的每个域名都会被迁移（迁移名单与模板名单同源）', () => {
      for (const host of ['gy.leyanshi.me', 'kapibala.asia', 'nova.vcrauo.com', 'api.gemai.cc', 'seekai.cc', 'htai91.com']) {
        const [site] = migrateLegacySiteDefaults([{
          id: `site-${host}`,
          name: host,
          loginUrl: `https://${host}/login`,
          loginMethod: 'auto',
          selectors: { username: '#username', password: '#password', submit: 'button[type="submit"]' },
          closeModalSelectors: [],
          checkin: { method: 'auto', url: '/console/personal' },
          adapter: { family: 'new-api', checkinPath: '/console/personal' },
        }]);
        expect(site?.loginUrl, host).toBe(`https://${host}/sign-in`);
        expect(site?.successIndicator, host).toBeTruthy();
      }
    });

    it('不覆盖用户已经明确配置的自定义按钮流程', () => {
      const custom: SiteConfig = {
        ...legacyLinxi,
        checkin: { method: 'button', url: '/custom', buttonSelector: '#custom-checkin' },
      };
      expect(migrateLegacySiteDefaults([custom])[0]).toBe(custom);
    });

    it('纠正上一轮错误生成的 /profile + new-api 预设', () => {
      const [site] = migrateLegacySiteDefaults([{
        ...legacyLinxi,
        checkin: {
          method: 'button',
          url: '/profile',
          buttonSelector: 'button >> text=立即签到, button >> text=立即簽到, button >> text=Check in now',
          alreadySelector: 'button >> text=已签到, button >> text=已簽到, button >> text=Checked in',
          successText: ['签到成功', '簽到成功', 'Check-in successful'],
          alreadyText: ['已签到', '今日已签到', '已簽到', '今日已簽到', 'Checked in'],
        },
        adapter: { family: 'new-api', checkinPath: '/profile', quotaPerUnit: 500_000 },
      }]);
      expect(site?.checkin?.url).toBe('/check-in');
      expect(site?.adapter).toMatchObject({ family: 'sub2api', quotaPerUnit: 1 });
    });

    it('账号可以使用不同登录类型，但全部读取同一份站点签到策略', () => {
      const [site] = migrateLegacySiteDefaults([legacyLinxi]);
      const methods = (['form', 'oauth', 'token'] as const).map((loginMethod) => (
        resolveEffectiveMethods({ loginMethod }, site!)
      ));

      expect(methods.map((item) => item.loginMethod)).toEqual(['form', 'oauth', 'token']);
      expect(methods.map((item) => item.checkinMethod)).toEqual(['button', 'button', 'button']);
    });
  });

  describe('Hvoy 旧通用 new-api 记录', () => {
    const legacyHvoy: SiteConfig = {
      id: 'user-hvoy',
      name: 'Hvoy AI',
      loginUrl: 'https://www.hvoy.ai/console/personal?from=old#daily',
      loginMethod: 'auto',
      selectors: { username: '#email', password: '#password', submit: 'button[type="submit"]' },
      closeModalSelectors: [],
      checkin: {
        method: 'auto',
        url: '/console/personal',
        apiUrl: '/api/user/checkin',
      },
      proxyId: 'proxy-kept',
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

    it('升级为表单登录与首页每日签到，并保留站点字段', () => {
      const [site] = migrateLegacySiteDefaults([legacyHvoy]);
      expect(site).toMatchObject({
        id: 'user-hvoy',
        name: 'Hvoy AI',
        loginUrl: 'https://www.hvoy.ai/',
        loginMethod: 'form',
        pointerMode: 'trusted',
        preLoginClickSelector: expect.stringContaining('header a[href="/login"]'),
        proxyId: 'proxy-kept',
        checkin: {
          method: 'button',
          url: '/',
          buttonSelector: 'button >> text=每日签到, a >> text=每日签到',
          successText: ['签到成功', '恭喜获取', '恭喜获得'],
        },
        adapter: {
          siteType: 'unknown',
          family: 'unsupported',
          checkinPath: '/',
          quotaPerUnit: 1,
        },
      });
    });

    it('升级现场的首页 auto 记录，并保留首页登录入口', () => {
      const rootLegacy: SiteConfig = {
        ...legacyHvoy,
        loginUrl: 'https://www.hvoy.ai/',
        checkin: { method: 'auto', url: '/' },
        adapter: undefined,
      };
      const [site] = migrateLegacySiteDefaults([rootLegacy]);
      expect(site).toMatchObject({
        loginUrl: 'https://www.hvoy.ai/',
        loginMethod: 'form',
        preLoginClickSelector: expect.stringContaining('header a[href="/login"]'),
        checkin: { method: 'button', url: '/' },
      });
    });

    it('保留用户自定义流程、非默认换算和其它域名，并保持迁移幂等', () => {
      const customCheckin: SiteConfig = {
        ...legacyHvoy,
        checkin: { method: 'button', url: '/custom', buttonSelector: '#custom-checkin' },
      };
      const customAdapter: SiteConfig = {
        ...legacyHvoy,
        adapter: { ...legacyHvoy.adapter, quotaPerUnit: 1 },
      };
      const otherHost: SiteConfig = {
        ...legacyHvoy,
        loginUrl: 'https://api.hvoy.ai/console/personal',
      };
      expect(migrateLegacySiteDefaults([customCheckin])[0]).toBe(customCheckin);
      expect(migrateLegacySiteDefaults([customAdapter])[0]).toBe(customAdapter);
      expect(migrateLegacySiteDefaults([otherHost])[0]).toBe(otherHost);

      const [first] = migrateLegacySiteDefaults([legacyHvoy]);
      expect(migrateLegacySiteDefaults([first!])[0]).toBe(first);
    });
  });

  describe('VSLLM 旧通用 new-api 记录', () => {
    const legacyVsllm: SiteConfig = {
      id: 'user-vsllm',
      name: 'VSLLM',
      loginUrl: 'https://vsllm.com/console/personal?from=old#daily',
      loginMethod: 'form',
      selectors: { username: '#username', password: '#password', submit: 'button[type="submit"]' },
      closeModalSelectors: [],
      checkin: {
        method: 'auto',
        url: '/console/personal',
        apiUrl: '/api/user/checkin',
      },
      proxyId: 'proxy-kept',
      adapter: { family: 'new-api', checkinPath: '/console/personal', quotaPerUnit: 500_000 },
    };

    it('升级为普通按钮签到并保留账号站点字段', () => {
      const [site] = migrateLegacySiteDefaults([legacyVsllm]);
      expect(site).toMatchObject({
        id: 'user-vsllm',
        name: 'VSLLM',
        loginUrl: 'https://vsllm.com/login',
        loginMethod: 'form',
        proxyId: 'proxy-kept',
        pointerMode: 'trusted',
        // 专用执行器已删除，折叠面板由通用扫描展开。
        checkin: { method: 'button', url: '/console/personal' },
        adapter: { family: 'new-api', checkinPath: '/console/personal', quotaPerUnit: 500_000 },
      });
    });

    it('把仍带 vsllm-daily 步骤的旧记录转成按钮流程，避免校验直接报错', () => {
      // 类型已删除，用 as never 模拟历史存储里的残留步骤。
      const [site] = migrateLegacySiteDefaults([{
        ...legacyVsllm,
        checkin: {
          method: 'workflow',
          workflow: { steps: [{ type: 'vsllm-daily', maxDraws: 12 }] as never },
        },
      }]);
      expect(site?.checkin?.method).toBe('button');
      expect(JSON.stringify(site?.checkin)).not.toContain('vsllm-daily');
    });

    it('保留明确的用户工作流或按钮配置，并保持迁移幂等', () => {
      const custom: SiteConfig = {
        ...legacyVsllm,
        checkin: { method: 'button', url: '/custom', buttonSelector: '#custom-checkin' },
      };
      expect(migrateLegacySiteDefaults([custom])[0]).toBe(custom);

      const [first] = migrateLegacySiteDefaults([legacyVsllm]);
      expect(migrateLegacySiteDefaults([first!])[0]).toBe(first);
    });

    it('同名站点和 VSLLM 子域名不触发专用迁移', () => {
      const otherHost = { ...legacyVsllm, loginUrl: 'https://vsllm.example/console/personal' };
      const subdomain = { ...legacyVsllm, loginUrl: 'https://api.vsllm.com/console/personal' };
      expect(migrateLegacySiteDefaults([otherHost])[0]).toBe(otherHost);
      expect(migrateLegacySiteDefaults([subdomain])[0]).toBe(subdomain);
    });
  });

  describe('百倍旧登录即签到记录', () => {
    const legacyBaibei: SiteConfig = {
      id: 'user-baibei',
      name: '百倍',
      loginUrl: 'https://sub.100xlabs.space/login',
      loginMethod: 'form',
      selectors: { username: '#email', password: '#password', submit: 'button[type="submit"]' },
      closeModalSelectors: [],
      checkin: { method: 'none' },
      proxyId: 'proxy-kept',
      adapter: { family: 'sub2api', checkinPath: '/check-in', quotaPerUnit: 1 },
    };

    it('升级为与林夕相同的 /check-in 按钮流程并保留账号站点字段', () => {
      const [site] = migrateLegacySiteDefaults([legacyBaibei]);
      expect(site).toMatchObject({
        id: 'user-baibei',
        name: '百倍',
        loginUrl: 'https://sub.100xlabs.space/login',
        loginMethod: 'form',
        proxyId: 'proxy-kept',
        checkin: {
          method: 'button',
          url: '/check-in',
          buttonSelector: 'button >> text=立即签到, button >> text=Check in',
          alreadySelector: 'button >> text=今日已签到, button >> text=Already checked in today',
        },
        adapter: { family: 'sub2api', checkinPath: '/check-in', quotaPerUnit: 1 },
      });
    });

    it.each([
      { method: 'button' as const, url: '/custom', buttonSelector: '#custom-checkin' },
      { method: 'api' as const, apiUrl: '/custom/checkin' },
      { method: 'workflow' as const, workflow: { steps: [{ type: 'assert' as const, text: ['完成'] }] } },
      { method: 'relogin' as const, logoutApiUrl: '/api/logout' },
    ])('保留用户明确配置的签到流程 %#', (checkin) => {
      const custom: SiteConfig = { ...legacyBaibei, checkin };
      expect(migrateLegacySiteDefaults([custom])[0]).toBe(custom);
    });

    it('迁移只按精确域名执行，并且迁移后保持幂等', () => {
      const sameNameOtherHost: SiteConfig = {
        ...legacyBaibei,
        loginUrl: 'https://baibei.example/login',
      };
      expect(migrateLegacySiteDefaults([sameNameOtherHost])[0]).toBe(sameNameOtherHost);

      const [first] = migrateLegacySiteDefaults([legacyBaibei]);
      expect(migrateLegacySiteDefaults([first!])[0]).toBe(first);
    });
  });

  describe('登仙公益站旧默认记录', () => {
    const legacyDenxio: SiteConfig = {
      id: 'user-denxio',
      name: '登仙公益站',
      loginUrl: 'https://api.denxio.top/checkin?from=old#reward',
      loginMethod: 'form',
      selectors: { username: '#email', password: '#password', submit: 'button[type="submit"]' },
      closeModalSelectors: [],
      checkin: { method: 'none' },
      adapter: { family: 'new-api', checkinPath: '/console/personal', quotaPerUnit: 500_000 },
    };

    it('把 none 假成功迁移为 /checkin 的真实签到流程', () => {
      const [site] = migrateLegacySiteDefaults([legacyDenxio]);
      expect(site).toMatchObject({
        id: 'user-denxio',
        loginUrl: 'https://api.denxio.top/login',
        loginMethod: 'form',
        checkin: {
          method: 'auto',
          url: '/checkin',
          buttonSelector: 'button >> text=立即签到',
          alreadySelector: 'button >> text=今日已签到, button >> text=今天已签到, button >> text=已签到',
          claimConfirmSelector: 'button >> text=领取奖励',
          successText: ['签到成功', '领取成功', '领取完成'],
          alreadyText: ['今日已签到', '今天已签到', '已签到'],
        },
        adapter: {
          family: 'sub2api',
          checkinPath: '/checkin',
          checkin: { pathPatterns: ['/checkin*'] },
          quotaPerUnit: 1,
        },
      });
    });

    it('缺失 checkin 的历史记录同样补齐真实签到页', () => {
      const { checkin: _omitted, ...withoutCheckin } = legacyDenxio;
      const [site] = migrateLegacySiteDefaults([withoutCheckin]);
      expect(site?.checkin).toMatchObject({ method: 'auto', url: '/checkin' });
      expect(site?.adapter?.checkinPath).toBe('/checkin');
    });

    it('已经是 /checkin 但缺少二次领取策略的旧记录也会升级', () => {
      const configured: SiteConfig = {
        ...legacyDenxio,
        loginUrl: 'https://api.denxio.top/login',
        checkin: { method: 'auto', url: '/checkin' },
        adapter: { family: 'sub2api', checkinPath: '/checkin', quotaPerUnit: 1 },
      };
      const [site] = migrateLegacySiteDefaults([configured]);
      expect(site?.checkin).toMatchObject({
        method: 'auto',
        url: '/checkin',
        buttonSelector: 'button >> text=立即签到',
        claimConfirmSelector: 'button >> text=领取奖励',
      });
      expect(site).not.toBe(configured);
    });

    it('完整的新登仙策略保持原对象，迁移不会反复覆盖', () => {
      const configured: SiteConfig = {
        ...legacyDenxio,
        loginUrl: 'https://api.denxio.top/login',
        checkin: {
          method: 'auto',
          url: '/checkin',
          buttonSelector: 'button >> text=立即签到',
          alreadySelector: 'button >> text=今日已签到',
          claimConfirmSelector: 'button >> text=领取奖励',
        },
        adapter: { family: 'sub2api', checkinPath: '/checkin', quotaPerUnit: 1 },
      };
      expect(migrateLegacySiteDefaults([configured])[0]).toBe(configured);
    });

    it('用户明确配置的按钮流程保持原样', () => {
      const custom: SiteConfig = {
        ...legacyDenxio,
        checkin: { method: 'button', url: '/custom', buttonSelector: '#custom-checkin' },
      };
      expect(migrateLegacySiteDefaults([custom])[0]).toBe(custom);
    });
  });

  describe('TaBiAI 头像入口迁移', () => {
    const legacyTabiai: SiteConfig = {
      id: 'user-tabiai',
      name: 'TaBiAI',
      loginUrl: 'https://tabitoken.com/sign-in?redirect=%2Fwallet',
      loginMethod: 'github',
      selectors: { username: 'input[name="username"]', password: 'input[name="password"]', submit: 'button[type="submit"]' },
      closeModalSelectors: [],
      checkin: {
        method: 'button',
        url: '/profile',
        buttonSelector: 'button >> text=立即签到, button >> text=签到',
        alreadySelector: 'button >> text=已签到',
      },
      proxyId: 'proxy-kept',
    };

    it('给上一版 /profile 默认记录补入口，但保留 GitHub、代理和按钮配置', () => {
      const [site] = migrateLegacySiteDefaults([legacyTabiai]);
      expect(site).not.toBe(legacyTabiai);
      expect(site).toMatchObject({
        loginMethod: 'github',
        proxyId: 'proxy-kept',
        checkin: {
          method: 'button',
          url: '/profile',
          buttonSelector: 'button >> text=立即签到, button >> text=签到',
          entry: { steps: expect.any(Array), readySelector: expect.stringContaining('立即签到') },
        },
      });
    });

    it('已有入口或自定义签到按钮时不重复覆盖', () => {
      const custom: SiteConfig = {
        ...legacyTabiai,
        checkin: { method: 'button', url: '/custom', buttonSelector: '#custom', alreadySelector: '#done' },
      };
      expect(migrateLegacySiteDefaults([custom])[0]).toBe(custom);
    });

    it('只有旧 /login 路径但用户自定义了签到流程时保持原样', () => {
      const custom: SiteConfig = {
        ...legacyTabiai,
        loginUrl: 'https://tabitoken.com/login',
        checkin: { method: 'workflow', workflow: { steps: [{ type: 'assert', text: ['完成'] }] } },
      };
      expect(migrateLegacySiteDefaults([custom])[0]).toBe(custom);
    });
  });

  /**
   * AnyRouter 登录即签到，站点上没有签到按钮。旧记录带着 auto + /console/personal，
   * 每轮都会跳过去等满 12 秒再报「签到页未找到明确按钮」。
   */
  describe('AnyRouter 旧默认记录', () => {
    const legacyAnyRouter = {
      id: 'user-anyrouter',
      name: 'AnyRouter',
      loginUrl: 'https://anyrouter.top/login',
      loginMethod: 'auto' as const,
      selectors: { username: '#username', password: '#password', submit: 'button[type="submit"]' },
      closeModalSelectors: [],
      checkin: { method: 'auto' as const, url: '/console/personal' },
      adapter: { family: 'new-api' as const, checkinPath: '/console/personal', quotaPerUnit: 500_000 },
    };

    it('改成登录即签到，并且不再保留任何签到页地址', () => {
      const [site] = migrateLegacySiteDefaults([legacyAnyRouter]);
      expect(site?.checkin).toEqual({ method: 'none' });
      // 留着 url 的话 none 方式仍会先跳过去白跑一趟
      expect(site?.checkin).not.toHaveProperty('url');
    });

    it('关掉 new-api 家族默认的 /console/personal 兜底跳转', () => {
      const [site] = migrateLegacySiteDefaults([legacyAnyRouter]);
      expect(site?.adapter?.checkinPath).toBe('');
      expect(site?.adapter?.checkin).toEqual({ pathPatterns: [], titleWords: [] });
      // 余额读取与美元换算仍靠 new-api 这一族
      expect(site?.adapter).toMatchObject({ family: 'new-api', quotaPerUnit: 500_000 });
    });

    it('用户明确配过的流程不动 —— relogin 比登录即签到更强，不能降级', () => {
      const custom = {
        ...legacyAnyRouter,
        checkin: { method: 'relogin' as const, logoutApiUrl: '/api/user/logout' },
      };
      expect(migrateLegacySiteDefaults([custom])[0]).toBe(custom);
    });

    it('用户写过按钮选择器的记录保持原样', () => {
      const custom = {
        ...legacyAnyRouter,
        checkin: { method: 'auto' as const, buttonSelector: '#my-checkin' },
      };
      expect(migrateLegacySiteDefaults([custom])[0]).toBe(custom);
    });

    it('压根没有 checkin 配置的旧记录同样升级', () => {
      const { checkin: _omitted, ...withoutCheckin } = legacyAnyRouter;
      expect(migrateLegacySiteDefaults([withoutCheckin])[0]?.checkin).toEqual({ method: 'none' });
    });
  });
});

describe('restoreHiddenSitesWithAccounts', () => {
  const accountOn = (siteId: string): Account => ({ ...account, id: `acc-${siteId}`, siteId });

  it('清除仍有账号的内置站点删除标记', () => {
    const kept = restoreHiddenSitesWithAccounts(
      ['builtin-anyrouter', 'builtin-futurehub'],
      [accountOn('builtin-anyrouter')],
    );
    expect(kept).toEqual(['builtin-futurehub']);
  });

  it('没有账号的删除标记保持不变', () => {
    const kept = restoreHiddenSitesWithAccounts(['builtin-anyrouter'], [accountOn('site-other')]);
    expect(kept).toEqual(['builtin-anyrouter']);
  });

  it('没有删除标记时返回空列表', () => {
    expect(restoreHiddenSitesWithAccounts([], [accountOn('builtin-anyrouter')])).toEqual([]);
  });
});

describe('proxy assignment persistence', () => {
  let storage: Record<string, unknown>;

  beforeEach(() => {
    const unboundAccount = (id: string): Account => ({
      id,
      siteId: account.siteId,
      username: `${id}@example.com`,
      password: account.password,
      proxyMode: 'inherit',
    });
    const accounts = [
      unboundAccount('account-name-only'),
      unboundAccount('account-real'),
    ];
    const proxies: ProxyConfig[] = [
      { id: 'proxy-name-only', name: '日本01', scheme: 'http', host: '-', port: 0, nameOnly: true },
      { id: 'proxy-real', name: '本机出口', scheme: 'http', host: '127.0.0.1', port: 7897 },
    ];
    storage = { [KEYS.accounts]: accounts, [KEYS.proxies]: proxies };
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storage[key] })),
          set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(storage, values); }),
          remove: vi.fn(async (key: string) => { delete storage[key]; }),
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects name-only ids while accepting a real proxy in the same batch', async () => {
    const result = await appRepository.assignAccountProxies([
      { accountId: 'account-name-only', proxyId: 'proxy-name-only', pinned: true },
      { accountId: 'account-real', proxyId: 'proxy-real', pinned: true },
    ]);

    expect(result).toEqual({ assigned: 1 });
    const saved = storage[KEYS.accounts] as Account[];
    expect(saved.find((item) => item.id === 'account-name-only')).not.toHaveProperty('proxyId');
    expect(saved.find((item) => item.id === 'account-real')).toMatchObject({
      proxyMode: 'pool', proxyId: 'proxy-real', proxyPinned: true,
    });
  });

  it('rejects a new account or a new editor selection that targets name-only', async () => {
    const input: Omit<Account, 'id'> = {
      siteId: account.siteId,
      username: 'new@example.com',
      password: 'secret',
      proxyMode: 'pool',
      proxyId: 'proxy-name-only',
    };

    await expect(appRepository.addAccount(input)).rejects.toThrow('仅名称条目不能分配');
    await expect(appRepository.updateAccount('account-real', {
      proxyMode: 'pool',
      proxyId: 'proxy-name-only',
    })).rejects.toThrow('仅名称条目不能分配');
  });

  it('allows unrelated edits on a historical name-only binding', async () => {
    const accounts = storage[KEYS.accounts] as Account[];
    storage[KEYS.accounts] = accounts.map((item) => item.id === 'account-name-only'
      ? { ...item, proxyMode: 'pool', proxyId: 'proxy-name-only', proxyPinned: true }
      : item);

    await appRepository.updateAccount('account-name-only', {
      label: '历史记录仍可维护',
      proxyMode: 'pool',
      proxyId: 'proxy-name-only',
    });

    expect((storage[KEYS.accounts] as Account[]).find((item) => item.id === 'account-name-only')).toMatchObject({
      label: '历史记录仍可维护',
      proxyId: 'proxy-name-only',
    });
  });
});

describe('Clash listener proxy merge persistence', () => {
  let storage: Record<string, unknown>;
  let storageSet: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const proxies: ProxyConfig[] = [
      {
        id: 'proxy-name-only',
        name: '日本-优化',
        scheme: 'http',
        host: '-',
        port: 0,
        nameOnly: true,
      },
      {
        id: 'proxy-name-only-duplicate',
        name: '[JP] 日本-优化',
        scheme: 'http',
        host: '-',
        port: 0,
        nameOnly: true,
      },
      {
        id: 'proxy-real-socks',
        name: '旧扫描 SOCKS',
        scheme: 'socks5',
        host: 'localhost',
        port: 11001,
      },
      {
        id: 'proxy-real-http',
        name: '旧扫描 HTTP',
        scheme: 'http',
        host: '::1',
        port: 11001,
      },
    ];
    const accounts: Account[] = [
      {
        id: 'account-name-only',
        siteId: 'site-listener',
        username: 'name-only@example.com',
        password: 'secret',
        proxyMode: 'pool',
        proxyId: 'proxy-name-only',
        proxyPinned: true,
      },
      {
        id: 'account-real',
        siteId: 'site-listener',
        username: 'real@example.com',
        password: 'secret',
        proxyMode: 'pool',
        proxyId: 'proxy-real-socks',
        proxyPinned: true,
      },
      {
        id: 'account-name-only-duplicate',
        siteId: 'site-listener',
        username: 'duplicate-name-only@example.com',
        password: 'secret',
        proxyMode: 'pool',
        proxyId: 'proxy-name-only-duplicate',
        proxyPinned: true,
      },
    ];
    const sites: SiteConfig[] = [{
      id: 'site-listener',
      name: 'Listener Site',
      loginUrl: 'https://listener.example.com/login',
      selectors: { username: '#username', password: '#password', submit: '#submit' },
      closeModalSelectors: [],
      proxyId: 'proxy-real-http',
    }];
    storage = {
      [KEYS.proxies]: proxies,
      [KEYS.accounts]: accounts,
      [KEYS.sites]: sites,
    };
    storageSet = vi.fn(async (values: Record<string, unknown>) => {
      Object.assign(storage, values);
    });
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storage[key] })),
          set: storageSet,
          remove: vi.fn(async (key: string) => { delete storage[key]; }),
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the name-only id, migrates all references, removes duplicates, and is idempotent', async () => {
    const listener: Omit<ProxyConfig, 'id'> = {
      name: '[JP] 日本-优化',
      scheme: 'http',
      host: '127.0.0.1',
      port: 11001,
      sourceLabel: 'Clash Verge',
    };

    await expect(appRepository.addProxies([listener])).resolves.toEqual({
      added: 0,
      skipped: 0,
      upgraded: 1,
    });

    expect(storage[KEYS.proxies]).toEqual([{
      id: 'proxy-name-only',
      name: '[JP] 日本-优化',
      scheme: 'http',
      host: '127.0.0.1',
      port: 11001,
      sourceLabel: 'Clash Verge',
    }]);
    expect(storage[KEYS.accounts]).toEqual([
      expect.objectContaining({ id: 'account-name-only', proxyId: 'proxy-name-only', proxyPinned: true }),
      expect.objectContaining({ id: 'account-real', proxyId: 'proxy-name-only', proxyPinned: true }),
      expect.objectContaining({ id: 'account-name-only-duplicate', proxyId: 'proxy-name-only', proxyPinned: true }),
    ]);
    expect(storage[KEYS.sites]).toEqual([
      expect.objectContaining({ id: 'site-listener', proxyId: 'proxy-name-only' }),
    ]);

    const writesAfterMerge = storageSet.mock.calls.length;
    await expect(appRepository.addProxies([listener])).resolves.toEqual({
      added: 0,
      skipped: 1,
      upgraded: 0,
    });
    expect(storageSet).toHaveBeenCalledTimes(writesAfterMerge);
  });

  it('keeps Clash exits that are still bound instead of silently going direct', async () => {
    storage[KEYS.proxies] = [
      {
        id: 'proxy-fixed',
        name: '旧节点名',
        scheme: 'http',
        host: '127.0.0.1',
        port: 10001,
        sourceLabel: 'Clash Verge',
      },
      {
        id: 'proxy-group',
        name: '自动选择',
        scheme: 'http',
        host: '127.0.0.1',
        port: 11001,
        sourceLabel: 'Clash Verge',
      },
      {
        id: 'proxy-stale',
        name: '已删除节点',
        scheme: 'http',
        host: '127.0.0.1',
        port: 12001,
        sourceLabel: 'Clash Verge',
      },
      {
        id: 'proxy-manual',
        name: '手工代理',
        scheme: 'http',
        host: 'proxy.example.com',
        port: 8080,
      },
    ];
    storage[KEYS.accounts] = [
      {
        id: 'account-fixed',
        siteId: 'site-listener',
        username: 'fixed@example.com',
        password: 'secret',
        proxyMode: 'pool',
        proxyId: 'proxy-fixed',
        proxyPinned: true,
      },
      {
        id: 'account-group',
        siteId: 'site-listener',
        username: 'group@example.com',
        password: 'secret',
        proxyMode: 'pool',
        proxyId: 'proxy-group',
        proxyPinned: true,
      },
    ];
    storage[KEYS.sites] = [{
      id: 'site-listener',
      name: 'Listener Site',
      loginUrl: 'https://listener.example.com/login',
      selectors: { username: '#username', password: '#password', submit: '#submit' },
      closeModalSelectors: [],
      proxyId: 'proxy-stale',
    }];

    await expect(appRepository.syncClashProxies([
      {
        name: '新加坡01aws',
        scheme: 'http',
        host: '127.0.0.1',
        port: 10001,
        sourceLabel: 'Clash Verge',
      },
      {
        name: '日本01aws',
        scheme: 'http',
        host: '127.0.0.1',
        port: 10002,
        sourceLabel: 'Clash Verge',
      },
      {
        name: '日本02aws',
        scheme: 'http',
        host: '-',
        port: 0,
        nameOnly: true,
        sourceLabel: 'Clash Verge',
      },
    ])).resolves.toEqual({ added: 2, skipped: 0, upgraded: 1, removed: 0, keptInUse: 2 });

    expect(storage[KEYS.proxies]).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'proxy-fixed', name: '新加坡01aws', port: 10001 }),
      expect.objectContaining({ name: '日本01aws', port: 10002 }),
      expect.objectContaining({ name: '日本02aws', nameOnly: true, sourceLabel: 'Clash Verge' }),
      expect.objectContaining({ id: 'proxy-manual' }),
      // 仍被账号/站点绑定的旧出口必须留着：剪掉它们等于把账号静默改成直连
      expect.objectContaining({ id: 'proxy-group', port: 11001 }),
      expect.objectContaining({ id: 'proxy-stale', port: 12001 }),
    ]));
    expect(storage[KEYS.proxies]).toHaveLength(6);
    const syncedAccounts = storage[KEYS.accounts] as Account[];
    expect(syncedAccounts).toEqual([
      expect.objectContaining({ id: 'account-fixed', proxyId: 'proxy-fixed', proxyPinned: true, proxyMode: 'pool' }),
      expect.objectContaining({ id: 'account-group', proxyId: 'proxy-group', proxyPinned: true, proxyMode: 'pool' }),
    ]);
    const syncedSites = storage[KEYS.sites] as SiteConfig[];
    expect(syncedSites).toEqual([expect.objectContaining({ id: 'site-listener', proxyId: 'proxy-stale' })]);
  });

  it('still prunes stale Clash exits that no account or site binds', async () => {
    storage[KEYS.proxies] = [
      {
        id: 'proxy-unused',
        name: '没人绑的旧出口',
        scheme: 'http',
        host: '127.0.0.1',
        port: 13001,
        sourceLabel: 'Clash Verge',
      },
    ];

    await expect(appRepository.syncClashProxies([
      {
        name: '新加坡01aws',
        scheme: 'http',
        host: '127.0.0.1',
        port: 10001,
        sourceLabel: 'Clash Verge',
      },
    ])).resolves.toEqual({ added: 1, skipped: 0, upgraded: 0, removed: 1, keptInUse: 0 });

    expect(storage[KEYS.proxies]).toEqual([
      expect.objectContaining({ name: '新加坡01aws', port: 10001 }),
    ]);
  });
});

describe('balance history persistence', () => {
  let storage: Record<string, unknown>;

  beforeEach(() => {
    storage = {};
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storage[key] })),
          set: vi.fn(async (values: Record<string, unknown>) => {
            Object.assign(storage, values);
          }),
          remove: vi.fn(async (key: string) => {
            delete storage[key];
          }),
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('saveBalance keeps the first and latest successful samples for a local date', async () => {
    const firstAt = new Date(2026, 7, 21, 9, 0).getTime();
    const latestAt = new Date(2026, 7, 21, 18, 30).getTime();

    await appRepository.saveBalance(account.id, {
      quota: 100,
      usedQuota: 20,
      at: firstAt,
      source: 'api',
    });
    await appRepository.saveBalance(account.id, {
      quota: 108,
      usedQuota: 22,
      at: latestAt,
      source: 'visible',
    });

    const saved = (storage[KEYS.balances] as Record<string, AccountBalance>)[account.id]!;
    expect(saved).toMatchObject({ quota: 108, usedQuota: 22, at: latestAt, source: 'visible' });
    expect(saved.daily?.['2026-08-21']).toEqual({
      first: { quota: 100, usedQuota: 20, at: firstAt, source: 'api' },
      latest: { quota: 108, usedQuota: 22, at: latestAt, source: 'visible' },
    });
  });

  it('saveBalance persists a visible currency and retains it across an API refresh', async () => {
    const visibleAt = new Date(2026, 7, 21, 9, 0).getTime();
    const apiAt = new Date(2026, 7, 21, 9, 5).getTime();

    await appRepository.saveBalance(account.id, {
      quota: 319.63,
      usedQuota: 0,
      symbol: '¥',
      at: visibleAt,
      source: 'visible',
    });
    await appRepository.saveBalance(account.id, {
      quota: 325.63,
      usedQuota: 0,
      at: apiAt,
      source: 'api',
    });

    const saved = (storage[KEYS.balances] as Record<string, AccountBalance>)[account.id]!;
    expect(saved).toMatchObject({
      quota: 325.63,
      symbol: '¥',
      at: apiAt,
      source: 'api',
    });
    expect(saved.daily?.['2026-08-21']).toEqual({
      first: { quota: 319.63, usedQuota: 0, symbol: '¥', at: visibleAt, source: 'visible' },
      latest: { quota: 325.63, usedQuota: 0, symbol: '¥', at: apiAt, source: 'api' },
    });
  });

  it('saveCheckinReward records the reward on the matching date without losing balance samples', async () => {
    const balanceAt = new Date(2026, 7, 21, 9, 0).getTime();
    const rewardAt = new Date(2026, 7, 21, 9, 5).getTime();
    await appRepository.saveBalance(account.id, {
      quota: 100,
      usedQuota: 20,
      at: balanceAt,
      source: 'api',
    });

    await appRepository.saveCheckinReward(account.id, 5, '2026-08-21', rewardAt);

    const saved = (storage[KEYS.balances] as Record<string, AccountBalance>)[account.id]!;
    expect(saved).toMatchObject({
      checkinReward: 5,
      checkinRewardDay: '2026-08-21',
      checkinRewardAt: rewardAt,
    });
    expect(saved.daily?.['2026-08-21']).toMatchObject({
      first: { quota: 100, usedQuota: 20, at: balanceAt, source: 'api' },
      latest: { quota: 100, usedQuota: 20, at: balanceAt, source: 'api' },
      checkinReward: 5,
      checkinRewardAt: rewardAt,
    });
  });

  it('saveCheckinReward keeps an explicit page currency when a same-value API refresh has no symbol', async () => {
    const firstAt = new Date(2026, 7, 21, 9, 5).getTime();
    const refreshAt = new Date(2026, 7, 21, 9, 6).getTime();

    await appRepository.saveCheckinReward(account.id, 10.31, '2026-08-21', firstAt, '¥');
    await appRepository.saveCheckinReward(account.id, 10.31, '2026-08-21', refreshAt);

    const saved = (storage[KEYS.balances] as Record<string, AccountBalance>)[account.id]!;
    expect(saved).toMatchObject({
      checkinReward: 10.31,
      checkinRewardSymbol: '¥',
      checkinRewardDay: '2026-08-21',
      checkinRewardAt: refreshAt,
    });
    expect(saved.daily?.['2026-08-21']).toMatchObject({
      checkinReward: 10.31,
      checkinRewardSymbol: '¥',
      checkinRewardAt: refreshAt,
    });
  });
});

describe('SharedChat 旧登录成功标志收紧', () => {
  const sharedchat = (successIndicator: string): SiteConfig => ({
    id: 'builtin-chatai-codex',
    name: 'ChatAI',
    loginUrl: 'https://new.sharedchat.cc/list/#/login',
    selectors: { username: 'input[placeholder*="用户名"]', password: 'input[type="password"]', submit: 'button.submit-btn' },
    closeModalSelectors: [],
    successIndicator,
    checkin: { method: 'claim', claimEntrySelector: '#e', claimInputSelector: 'textarea', claimSubmitSelector: '#s' },
  });

  it('原样的旧默认值去掉会在登录页误命中的通用按钮类组合', () => {
    const [site] = migrateLegacySiteDefaults([sharedchat('button.refresh-btn, button.invite-entry-button, button.el-button--primary.el-button--large')]);
    expect(site?.successIndicator).toBe('button.refresh-btn, button.invite-entry-button');
  });

  it('用户改过的登录成功标志不动', () => {
    const custom = sharedchat('#my-dashboard');
    expect(migrateLegacySiteDefaults([custom])[0]).toBe(custom);
  });
});
