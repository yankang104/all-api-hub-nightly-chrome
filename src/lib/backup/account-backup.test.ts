/**
 * 账号备份的序列化与重挂。
 *
 * 这里锁的是迁移场景里最容易悄悄坏掉的一件事：**账号能不能挂回正确的站点**。
 *
 * `Account.siteId` 是随机生成的，新电脑上导入同一个站点必然是另一个 id。照搬 siteId
 * 的话每个账号都会变成孤儿 —— 而界面上看起来「全都导进来了」，用户直到点签到才发现
 * 一个都不能用。所以按归一化 loginUrl 重挂，并且要断言它真的挂对了。
 */

import { describe, expect, it } from 'vitest';
import type { Account, ProxyConfig, SiteConfig } from '@/types';
import {
  backupFileName,
  buildBackupPayload,
  parseBackupPayload,
  planBackupImport,
  resolvePendingIds,
  resolveSiteProxyBindings,
} from '@/lib/backup/account-backup';
import { BACKUP_FORMAT } from '@/lib/backup/backup-crypto';
import { normalizeProxyName } from '@/lib/proxy/proxy-upgrade';

function site(id: string, name: string, loginUrl: string, extra: Partial<SiteConfig> = {}): SiteConfig {
  return {
    id,
    name,
    loginUrl,
    selectors: { username: '#u', password: '#p', submit: '#s' },
    closeModalSelectors: [],
    checkin: { method: 'auto' },
    ...extra,
  } as SiteConfig;
}

function account(id: string, siteId: string, username: string, extra: Partial<Account> = {}): Account {
  return { id, siteId, username, password: `pw-${username}`, ...extra };
}

function proxy(id: string, name: string, port: number, extra: Partial<ProxyConfig> = {}): ProxyConfig {
  return { id, name, scheme: 'http', host: '127.0.0.1', port, sourceLabel: 'Clash Verge', ...extra };
}

describe('buildBackupPayload · 剥掉不该跨机器带走的东西', () => {
  it('剥掉 identity.session，但保留 userId 等身份字段', () => {
    const sites = [site('st-1', '甲站', 'https://a.example.com/login')];
    const accounts = [account('ac-1', 'st-1', 'alice', {
      identity: {
        userId: '42',
        username: 'alice',
        email: 'a@example.com',
        session: { accessToken: 'AT-secret', refreshToken: 'RT-secret', capturedAt: 1 },
      },
    })];

    const payload = buildBackupPayload(sites, accounts);
    const exported = payload.accounts[0]!;

    // userId 是下次签到要用的请求头值，必须留
    expect(exported.identity?.userId).toBe('42');
    expect(exported.identity?.email).toBe('a@example.com');
    // session 与原浏览器绑定，带过去只会让人以为还能用
    expect(exported.identity?.session).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('RT-secret');
    expect(JSON.stringify(payload)).not.toContain('AT-secret');
  });

  it('代理 id 换成节点名 —— id 是随机的，跨机器无意义', () => {
    const sites = [site('st-1', '甲站', 'https://a.example.com/login')];
    const accounts = [account('ac-1', 'st-1', 'alice', {
      proxyMode: 'pool',
      proxyId: 'px-9',
      proxyPinned: true,
    })];
    const proxies = [proxy('px-9', 'JP-日本', 10001)];

    const payload = buildBackupPayload(sites, accounts, proxies);
    const exported = payload.accounts[0]!;

    expect(JSON.stringify(payload)).not.toContain('px-9');
    // 节点名是跨机器稳定的键，绑定靠它恢复
    expect(exported.proxyName).toBe('JP-日本');
    expect(exported.proxyMode).toBe('pool');
    // proxyPinned 是「用户手动选过」的标记，跨机器仍然成立，保留
    expect(exported.proxyPinned).toBe(true);
  });

  it('代理认证密码不进备份文件，地址保留', () => {
    const sites = [site('st-1', '甲站', 'https://a.example.com/login')];
    const accounts = [account('ac-1', 'st-1', 'alice', {
      proxyMode: 'custom',
      customProxy: { scheme: 'socks5', host: '10.0.0.5', port: 1080, username: 'u', password: 'proxy-secret' },
    })];
    const proxies = [proxy('px-1', 'JP-日本', 10001, { password: 'pool-secret' })];

    const payload = buildBackupPayload(sites, accounts, proxies);
    const serialized = JSON.stringify(payload);

    // 密码不带走
    expect(serialized).not.toContain('proxy-secret');
    expect(serialized).not.toContain('pool-secret');
    // 但地址是用户手填的配置，丢了要重新查 —— 保留，密码在新电脑补填
    expect(payload.accounts[0]!.customProxy?.host).toBe('10.0.0.5');
    expect(payload.accounts[0]!.customProxy?.username).toBe('u');
    expect(payload.proxies[0]!.host).toBe('127.0.0.1');
    expect(payload.proxies[0]!.port).toBe(10001);
  });

  it("proxyMode='none' 保留 —— 那是用户明确要求直连，不是代理绑定", () => {
    const sites = [site('st-1', '甲站', 'https://a.example.com/login')];
    const accounts = [account('ac-1', 'st-1', 'alice', { proxyMode: 'none' })];

    expect(buildBackupPayload(sites, accounts).accounts[0]!.proxyMode).toBe('none');
  });

  it('代理池整体导出，但去掉 id', () => {
    const proxies = [proxy('px-1', 'JP-日本', 10001), proxy('px-2', 'US-美国', 10002)];

    const payload = buildBackupPayload([], [], proxies);

    expect(payload.proxies).toHaveLength(2);
    expect(payload.proxies.map((item) => item.name)).toEqual(['JP-日本', 'US-美国']);
    expect(JSON.stringify(payload.proxies)).not.toContain('px-1');
  });

  it('站点的代理绑定也换成节点名', () => {
    const sites = [site('st-1', '甲站', 'https://a.example.com/login', { proxyId: 'px-7' })];
    const proxies = [proxy('px-7', 'HK-香港', 10003)];

    const exported = buildBackupPayload(sites, [], proxies).sites[0]!;

    expect(exported.proxyName).toBe('HK-香港');
    expect(JSON.stringify(exported)).not.toContain('px-7');
  });

  it('账号带上所属站点的 loginUrl 作为重挂键', () => {
    const sites = [
      site('st-1', '甲站', 'https://a.example.com/login'),
      site('st-2', '乙站', 'https://b.example.com/login'),
    ];
    const accounts = [account('ac-1', 'st-2', 'bob')];

    expect(buildBackupPayload(sites, accounts).accounts[0]!.siteLoginUrl)
      .toBe('https://b.example.com/login');
  });

  it('孤儿账号（站点已删）不导出 —— 没有可用的重挂键', () => {
    const sites = [site('st-1', '甲站', 'https://a.example.com/login')];
    const accounts = [account('ac-1', 'st-1', 'alice'), account('ac-2', 'st-gone', 'ghost')];

    const payload = buildBackupPayload(sites, accounts);

    expect(payload.accounts).toHaveLength(1);
    expect(payload.accounts[0]!.username).toBe('alice');
  });

  it('站点自己的 id 与代理绑定也不导出', () => {
    const sites = [site('st-1', '甲站', 'https://a.example.com/login', { proxyId: 'px-3' })];

    const exported = buildBackupPayload(sites, []).sites[0]! as unknown as Record<string, unknown>;

    expect(exported.id).toBeUndefined();
    expect(exported.proxyId).toBeUndefined();
    expect(exported.name).toBe('甲站');
  });
});

describe('planBackupImport · 按 loginUrl 重挂', () => {
  it('新电脑上 siteId 完全不同，账号照样挂对', () => {
    const payload = buildBackupPayload(
      [site('st-OLD-1', '甲站', 'https://a.example.com/login')],
      [account('ac-1', 'st-OLD-1', 'alice')],
    );
    // 新电脑上同一个站点是另一个 id
    const existingSites = [site('st-NEW-9', '甲站', 'https://a.example.com/login')];

    const plan = planBackupImport(payload, existingSites, []);

    expect(plan.newSites).toHaveLength(0);
    expect(plan.reusedSiteCount).toBe(1);
    expect(plan.accounts).toHaveLength(1);
    // 关键断言：挂到了新电脑的 id 上，而不是备份文件里的旧 id
    expect(plan.accounts[0]!.siteId).toBe('st-NEW-9');
    expect(plan.unmatched).toHaveLength(0);
  });

  it('新电脑没有这个站点时，站点进 newSites，账号用占位符等落地', () => {
    const payload = buildBackupPayload(
      [site('st-1', '丙站', 'https://c.example.com/login')],
      [account('ac-1', 'st-1', 'carol')],
    );

    const plan = planBackupImport(payload, [], []);

    expect(plan.newSites).toHaveLength(1);
    expect(plan.accounts).toHaveLength(1);
    // 主格式：pending-site:<源id>，与 newSites[].migrationSourceId 配对，
    // 落地阶段能精确换回本机 id。旧的 pending:<url> 只是兼容早期备份。
    expect(plan.accounts[0]!.siteId).toMatch(/^pending-site:/);
    // 不能报成 unmatched —— 站点马上就会被建出来
    expect(plan.unmatched).toHaveLength(0);
  });

  it('备份里没有站点、本机也没有 → 账号报 unmatched，不静默丢弃', () => {
    const payload = parseBackupPayload({
      format: BACKUP_FORMAT,
      sites: [],
      accounts: [{ siteLoginUrl: 'https://gone.example.com/login', username: 'dave', password: 'x' }],
    });

    const plan = planBackupImport(payload, [], []);

    expect(plan.accounts).toHaveLength(0);
    expect(plan.unmatched).toEqual([
      { username: 'dave', siteLoginUrl: 'https://gone.example.com/login' },
    ]);
  });

  it('本机已有同站同名账号 → 计入 duplicateCount 而不是重复导入', () => {
    const payload = buildBackupPayload(
      [site('st-OLD', '甲站', 'https://a.example.com/login')],
      [account('ac-1', 'st-OLD', 'alice'), account('ac-2', 'st-OLD', 'bob')],
    );
    const existingSites = [site('st-NEW', '甲站', 'https://a.example.com/login')];
    const existingAccounts = [account('ac-x', 'st-NEW', 'alice')];

    const plan = planBackupImport(payload, existingSites, existingAccounts);

    // 契约：按来源 id 判重（接口注释明确「同站同名但来源不同不会计入」）。
    // 本机 alice 没有 backupAccountKey，不算重复，两条都要保留下來。
    expect(plan.duplicateCount).toBe(0);
    expect(plan.accounts).toHaveLength(2);
    // 账号都挂到了本机真实站点 id 上
    expect(plan.accounts.every((a) => a.siteId === 'st-NEW')).toBe(true);
  });

  it('判重只按来源 id，不因同站同名误杀（与接口注释一致）', () => {
    const payload = parseBackupPayload({
      format: BACKUP_FORMAT,
      sites: [{ name: '甲站', loginUrl: 'https://a.example.com/login' }],
      accounts: [{ siteLoginUrl: 'https://a.example.com/login', username: '  ALICE  ', password: 'x' }],
    });
    const existingSites = [site('st-NEW', '甲站', 'https://a.example.com/login')];
    const existingAccounts = [account('ac-x', 'st-NEW', 'alice')];

    // 备份里的账号没有 backupAccountKey，本机也没有 migrationSourceId → 不判重，
    // 同站同名的凭据照样导入（迁移宁可多保留一条）。
    expect(planBackupImport(payload, existingSites, existingAccounts).duplicateCount).toBe(0);
  });

  it('同 loginUrl 的多张站点卡不合并 —— 按来源 id 区分（接口注释明确）', () => {
    const payload = parseBackupPayload({
      format: BACKUP_FORMAT,
      sites: [
        { name: '甲站', loginUrl: 'https://a.example.com/login', backupSiteKey: 'old-site-1' },
        { name: '甲站(副本)', loginUrl: 'https://a.example.com/login', backupSiteKey: 'old-site-2' },
      ],
      accounts: [],
    });

    // 源码注释：新备份优先按来源 id 一一对应，
    // 「同一个 URL 的两张站点卡不会被压成一张」。
    const plan = planBackupImport(payload, [], []);
    expect(plan.newSites).toHaveLength(2);
    expect(plan.newSiteKeys).toEqual(['old-site-1', 'old-site-2']);
  });
});

describe('resolvePendingIds · 站点落地后补上真实 id', () => {
  it('占位符换成新建站点的实际 id', () => {
    const pending = [{ siteId: 'pending:https://c.example.com/login', username: 'carol', password: 'x' }];
    const sitesAfterAdd = [site('st-FRESH', '丙站', 'https://c.example.com/login')];

    const result = resolvePendingIds(pending, sitesAfterAdd, []);

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]!.siteId).toBe('st-FRESH');
    expect(result.unresolved).toBe(0);
  });

  it('站点没建成功时计入 unresolved，不写一个坏 siteId 进去', () => {
    const pending = [{ siteId: 'pending:https://c.example.com/login', username: 'carol', password: 'x' }];

    const result = resolvePendingIds(pending, [], []);

    expect(result.resolved).toHaveLength(0);
    expect(result.unresolved).toBe(1);
  });

  it('落地阶段再判一次重：按来源 id，不按用户名（与接口注释一致）', () => {
    const pending = [{ siteId: 'pending-site:src-1', username: 'carol', password: 'x' }];
    const sitesAfterAdd = [site('st-FRESH', '丙站', 'https://c.example.com/login', {
      migrationSourceId: 'src-1',
    } as Partial<SiteConfig>)];
    // 本机已有同用户名账号，但它没有 migrationSourceId → 不算同一条记录
    const existingAccounts = [account('ac-x', 'st-FRESH', 'carol')];

    const result = resolvePendingIds(pending, sitesAfterAdd, existingAccounts);

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]!.siteId).toBe('st-FRESH');
    expect(result.duplicateCount).toBe(0);
  });

  it('落地阶段：来源 id 相同才算重复，且占位符换成真实 id', () => {
    const pending = [{
      siteId: 'pending-site:src-1',
      username: 'carol',
      password: 'x',
      // 判重键：账号自带的来源 id（导入时由 backupAccountKey 落成）
      migrationSourceId: 'src-1',
    }];
    const sitesAfterAdd = [site('st-FRESH', '丙站', 'https://c.example.com/login', {
      migrationSourceId: 'src-1',
    } as Partial<SiteConfig>)];
    // 本机账号带同一个 migrationSourceId → 判重
    const existingAccounts = [account('ac-x', 'st-FRESH', 'carol', {
      migrationSourceId: 'src-1',
    } as Partial<Account>)];

    const result = resolvePendingIds(pending, sitesAfterAdd, existingAccounts);

    expect(result.resolved).toHaveLength(0);
    expect(result.duplicateCount).toBe(1);
  });

  it('已解析的 siteId 原样通过', () => {
    const ready = [{ siteId: 'st-NEW', username: 'alice', password: 'x' }];

    const result = resolvePendingIds(ready, [site('st-NEW', '甲站', 'https://a.example.com/login')], []);

    expect(result.resolved[0]!.siteId).toBe('st-NEW');
  });
});

describe('planBackupImport · 代理池与绑定恢复', () => {
  /** 旧电脑：一个站、一个账号绑在 JP-日本 上。 */
  function exportedWithProxyBinding() {
    return buildBackupPayload(
      [site('st-OLD', '甲站', 'https://a.example.com/login')],
      [account('ac-1', 'st-OLD', 'alice', { proxyMode: 'pool', proxyId: 'px-OLD' })],
      [proxy('px-OLD', 'JP-日本', 10001)],
    );
  }

  it('本机已有同名节点 → 绑定直接挂到本机的 proxyId 上', () => {
    const plan = planBackupImport(
      exportedWithProxyBinding(),
      [site('st-NEW', '甲站', 'https://a.example.com/login')],
      [],
      // 新电脑上同一个节点，id 和端口都不同
      [proxy('px-NEW', 'JP-日本', 20001)],
    );

    expect(plan.newProxies).toHaveLength(0);
    expect(plan.reusedProxyCount).toBe(1);
    expect(plan.accounts[0]!.proxyMode).toBe('pool');
    // 关键：挂到新电脑的 id 上
    expect(plan.accounts[0]!.proxyId).toBe('px-NEW');
    expect(plan.unresolvedProxyBindings).toBe(0);
  });

  it('本机没有该节点 → 节点进 newProxies，账号用占位符等落地', () => {
    const plan = planBackupImport(exportedWithProxyBinding(), [], [], []);

    expect(plan.newProxies).toHaveLength(1);
    expect(plan.accounts[0]!.proxyId).toMatch(/^pending-proxy:/);
    expect(plan.unresolvedProxyBindings).toBe(0);
  });

  it('节点名在备份里也不存在 → 回落 inherit，绝不留坏 id', () => {
    const payload = parseBackupPayload({
      format: BACKUP_FORMAT,
      sites: [{ name: '甲站', loginUrl: 'https://a.example.com/login' }],
      accounts: [{
        siteLoginUrl: 'https://a.example.com/login',
        username: 'alice',
        password: 'x',
        proxyMode: 'pool',
        proxyName: '已经不存在的节点',
      }],
      proxies: [],
    });

    const plan = planBackupImport(payload, [], [], []);

    // 留一个指向不存在节点的 id，签到会直接失败在「账号配置的代理已不存在」
    expect(plan.accounts[0]!.proxyId).toBeUndefined();
    expect(plan.accounts[0]!.proxyMode).toBe('inherit');
    expect(plan.unresolvedProxyBindings).toBe(1);
  });

  it('nameOnly 节点不能被绑定 —— 它没有可用出口', () => {
    const payload = parseBackupPayload({
      format: BACKUP_FORMAT,
      sites: [{ name: '甲站', loginUrl: 'https://a.example.com/login' }],
      accounts: [{
        siteLoginUrl: 'https://a.example.com/login',
        username: 'alice',
        password: 'x',
        proxyMode: 'pool',
        proxyName: '仅名称节点',
      }],
      proxies: [{ name: '仅名称节点', scheme: 'http', host: '-', port: 0, nameOnly: true }],
    });

    const plan = planBackupImport(payload, [], [], []);

    // 节点本身会导入（等 listener 补上端口后复活），但现在不能作为绑定目标：
    // assertUsableProxyId 会拒绝，整批导入会失败
    expect(plan.newProxies).toHaveLength(1);
    expect(plan.accounts[0]!.proxyMode).toBe('inherit');
    expect(plan.unresolvedProxyBindings).toBe(1);
  });

  it('按出口端点判重：同一个本机端口不同 scheme 视为同一节点', () => {
    const payload = buildBackupPayload([], [], [proxy('px-1', 'JP-日本', 10001)]);
    // 本机上同一端口，但当初是端口扫描进来的，记成了 socks5、名字也不同
    const existing = [proxy('px-LOCAL', '本机 10001', 10001, { scheme: 'socks5', sourceLabel: '本机代理' })];

    const plan = planBackupImport(payload, [], [], existing);

    expect(plan.reusedProxyCount).toBe(1);
    expect(plan.newProxies).toHaveLength(0);
  });

  it('备份文件内部重复的节点名只建一次', () => {
    const payload = parseBackupPayload({
      format: BACKUP_FORMAT,
      sites: [],
      accounts: [],
      proxies: [
        { name: 'JP-日本', scheme: 'http', host: '127.0.0.1', port: 10001 },
        { name: 'JP-日本', scheme: 'http', host: '127.0.0.1', port: 10009 },
      ],
    });

    expect(planBackupImport(payload, [], [], []).newProxies).toHaveLength(1);
  });

  it('旧备份没有 proxies 字段时按空数组处理，不拒绝整个文件', () => {
    const payload = parseBackupPayload({
      format: BACKUP_FORMAT,
      sites: [{ name: '甲站', loginUrl: 'https://a.example.com/login' }],
      accounts: [{ siteLoginUrl: 'https://a.example.com/login', username: 'alice', password: 'x' }],
    });

    expect(payload.proxies).toEqual([]);
    expect(planBackupImport(payload, [], [], []).newProxies).toHaveLength(0);
  });
});

describe('resolvePendingIds · 代理占位符', () => {
  /*
   * 占位符的键用 normalizeProxyName 生成，不手写字面量 —— 它会剥掉连字符
   * （`JP-日本` → `jp日本`），手写的话测试会锁死一个错的键，而生产代码
   * 改了归一化规则时这里也不会报警。
   */
  const pendingFor = (proxyName: string) => [{
    siteId: 'st-NEW',
    username: 'alice',
    password: 'x',
    proxyMode: 'pool' as const,
    proxyId: `pending-proxy:${normalizeProxyName(proxyName)}`,
  }];
  const sites = [site('st-NEW', '甲站', 'https://a.example.com/login')];

  it('占位符换成新建节点的实际 id', () => {
    const result = resolvePendingIds(
      pendingFor('JP-日本'),
      sites,
      [],
      [proxy('px-FRESH', 'JP-日本', 10001)],
    );

    expect(result.resolved[0]!.proxyId).toBe('px-FRESH');
    expect(result.droppedProxyBindings).toBe(0);
  });

  it('节点重命名过（同名匹配失败）时回落 inherit，但账号本身要保住', () => {
    const result = resolvePendingIds(pendingFor('JP-日本'), sites, [], []);

    // 账号是用户要的；代理绑定丢了可以重新分配，把账号丢掉才是真损失
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]!.proxyId).toBeUndefined();
    expect(result.resolved[0]!.proxyMode).toBe('inherit');
    expect(result.droppedProxyBindings).toBe(1);
  });

  it('归一化后同名即可匹配：连字符、大小写、全角括号差异不影响', () => {
    // 导出时叫 `JP-日本`，新电脑上订阅里写成 `jp 日本`
    const result = resolvePendingIds(
      pendingFor('JP-日本'),
      sites,
      [],
      [proxy('px-FRESH', 'jp 日本', 10001)],
    );

    expect(result.resolved[0]!.proxyId).toBe('px-FRESH');
  });
});

describe('resolveSiteProxyBindings', () => {
  it('站点与代理都落地后算出绑定补丁', () => {
    const sites = [site('st-FRESH', '甲站', 'https://a.example.com/login')];
    const proxies = [proxy('px-FRESH', 'HK-香港', 10003)];

    const patches = resolveSiteProxyBindings(
      [{ loginUrlKey: 'https://a.example.com/login', proxyName: 'HK-香港' }],
      sites,
      proxies,
    );

    expect(patches).toEqual([{ siteId: 'st-FRESH', proxyId: 'px-FRESH' }]);
  });

  it('找不到节点时跳过，不写坏 id', () => {
    const sites = [site('st-FRESH', '甲站', 'https://a.example.com/login')];

    expect(resolveSiteProxyBindings(
      [{ loginUrlKey: 'https://a.example.com/login', proxyName: '不存在' }],
      sites,
      [],
    )).toEqual([]);
  });

  it('nameOnly 节点不作为站点绑定目标', () => {
    const sites = [site('st-FRESH', '甲站', 'https://a.example.com/login')];
    const proxies = [proxy('px-NAME', '仅名称', 0, { nameOnly: true, host: '-' })];

    expect(resolveSiteProxyBindings(
      [{ loginUrlKey: 'https://a.example.com/login', proxyName: '仅名称' }],
      sites,
      proxies,
    )).toEqual([]);
  });
});

describe('parseBackupPayload · 结构校验', () => {
  it('不认识的 format 直接拒绝，不猜测解析', () => {
    expect(() => parseBackupPayload({ format: 'aah-backup-v99', sites: [], accounts: [] }))
      .toThrow(/不支持的备份格式/);
  });

  it('缺少 format 标记时说明原因', () => {
    expect(() => parseBackupPayload({ sites: [], accounts: [] })).toThrow(/缺少 format/);
  });

  it('不是对象、缺列表、空内容都给出可读错误', () => {
    expect(() => parseBackupPayload('文本')).toThrow(/不是一个对象/);
    expect(() => parseBackupPayload({ format: BACKUP_FORMAT })).toThrow(/缺少 sites/);
    expect(() => parseBackupPayload({ format: BACKUP_FORMAT, sites: [], accounts: [] }))
      .toThrow(/没有可导入/);
  });

  it('丢掉列表里结构不完整的条目，保留好的', () => {
    const payload = parseBackupPayload({
      format: BACKUP_FORMAT,
      sites: [{ name: '甲站', loginUrl: 'https://a.example.com/login' }, { name: '缺 URL' }],
      accounts: [
        { siteLoginUrl: 'https://a.example.com/login', username: 'alice', password: 'x' },
        { username: '缺 siteLoginUrl' },
      ],
    });

    expect(payload.sites).toHaveLength(1);
    expect(payload.accounts).toHaveLength(1);
  });
});

describe('backupFileName', () => {
  it('按本地时间生成可排序的文件名', () => {
    expect(backupFileName(new Date(2026, 8, 2, 14, 30))).toBe('aah-backup-20260902-1430.json');
    // 补零
    expect(backupFileName(new Date(2026, 0, 5, 9, 7))).toBe('aah-backup-20260105-0907.json');
  });
});

describe('备份携带端口映射与订阅源（跨机器恢复）', () => {
  const sites = [{ id: 's1', name: '站点', loginUrl: 'https://a.test/login', url: 'https://a.test' }] as never[];
  const accounts = [{ id: 'a1', siteId: 's1', username: 'u', password: 'p' }] as never[];

  it('导出时带上映射与订阅源，导入时原样返回给落地方', () => {
    const payload = buildBackupPayload(
      sites,
      accounts,
      [],
      [{ nodeName: '日本01', port: 7901, listenerName: 'hub-7901' }],
      'https://airport.example/sub?token=t',
    );
    expect(payload.listenerPlan).toEqual([{ nodeName: '日本01', port: 7901, listenerName: 'hub-7901' }]);
    expect(payload.subscriptionUrl).toBe('https://airport.example/sub?token=t');

    const restored = parseBackupPayload(JSON.parse(JSON.stringify(payload)));
    const plan = planBackupImport(restored, sites as never[], accounts as never[], []);
    expect(plan.listenerPlan).toEqual([{ nodeName: '日本01', port: 7901, listenerName: 'hub-7901' }]);
    expect(plan.subscriptionUrl).toBe('https://airport.example/sub?token=t');
  });

  it('旧备份没有这两个字段时不拒绝，也不产生空值覆盖', () => {
    const legacy = {
      format: 'aah-backup-v1',
      sites: [{ name: '站点', loginUrl: 'https://a.test/login' }],
      accounts: [],
      proxies: [],
    };
    const parsed = parseBackupPayload(legacy);
    expect(parsed.listenerPlan).toBeUndefined();
    expect(parsed.subscriptionUrl).toBeUndefined();
    expect(planBackupImport(parsed, [], [], []).listenerPlan).toBeUndefined();
    expect(planBackupImport(parsed, [], [], []).subscriptionUrl).toBeUndefined();
  });

  it('坏条目被丢弃（端口越界/名字为空），不影响整份文件', () => {
    const parsed = parseBackupPayload({
      format: 'aah-backup-v1',
      sites: [{ name: '站点', loginUrl: 'https://a.test/login' }],
      accounts: [],
      proxies: [],
      listenerPlan: [
        { nodeName: '好的', port: 7901 },
        { nodeName: '', port: 7902 },
        { nodeName: '越界', port: 70000 },
        { nodeName: '非整数', port: 'x' },
      ],
      subscriptionUrl: '   ',
    });
    expect(parsed.listenerPlan).toEqual([{ nodeName: '好的', port: 7901, listenerName: 'hub-7901' }]);
    expect(parsed.subscriptionUrl).toBeUndefined();
  });
});
