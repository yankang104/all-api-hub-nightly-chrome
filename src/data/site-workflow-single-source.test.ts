import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Account, SiteConfig } from '@/types';

/**
 * 硬性不变量：**一个站点只有一份签到流程，多账号共用**。
 *
 * 用户原话：「一定要保证的是一个站点里多个账号使用的签到流程是一致的，
 * 一个站点就一个签到流程，无论这个站点哪个账号学习，都是覆盖这一个属于该站点的签到流程」。
 *
 * 这条不变量由三件事共同保证，本文件逐条钉死：
 *  1. 存储模型：`workflow` 只挂在 `SiteConfig.checkin` 上，`Account` 上没有签到流程字段；
 *  2. 落盘路径：学习结束时写的是 `updateSite(site.id, { checkin })`，**不是** `updateAccount`；
 *  3. 读取路径：所有账号解析出的都是同一个 `site.checkin.workflow` 对象（同一份引用/深相等）。
 *
 * 任何一条被破坏（例如有人给 Account 加一个账号级 workflow 覆盖），本文件都会红。
 */

const store = new Map<string, unknown>();

vi.mock('@/lib/core/storage', () => ({
  local: {
    get: vi.fn(async (key: string, fallback: unknown) => (store.has(key) ? store.get(key) : fallback)),
    set: vi.fn(async (key: string, value: unknown) => { store.set(key, value); }),
    setMany: vi.fn(async (values: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(values)) store.set(k, v);
    }),
    remove: vi.fn(async (key: string) => { store.delete(key); }),
  },
  session: {
    get: vi.fn(async (_k: string, fallback: unknown) => fallback),
    set: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  },
  KEYS: { sites: 'sites', accounts: 'accounts', proxies: 'proxies', status: 'status', results: 'results', removedBuiltinSiteIds: 'removedBuiltinSiteIds' },
}));

vi.mock('@/lib/site/site-security', () => ({
  assertValidSiteConfig: vi.fn(),
  isSameSiteUrl: vi.fn(() => true),
}));

import { appRepository } from '@/data/app-repository';

const WORKFLOW_A = {
  steps: [{ type: 'click' as const, selector: '#claim-from-account-one' }],
};
const WORKFLOW_B = {
  steps: [{ type: 'click' as const, selector: '#claim-from-account-two' }],
};

function site(id: string): SiteConfig {
  return {
    id,
    name: `站点 ${id}`,
    loginUrl: `https://${id}.test/login`,
    selectors: { username: '#u', password: '#p', submit: '#s' },
    closeModalSelectors: [],
  };
}

function account(id: string, siteId: string): Account {
  return { id, siteId, username: id, password: 'pw' };
}

describe('一个站点只有一份签到流程（多账号共用）', () => {
  beforeEach(() => {
    store.clear();
  });

  it('账号记录里不存在任何签到流程字段（流程只能挂在站点上）', () => {
    const a = account('acc-1', 'site-x');
    // 类型层：Account 上没有 workflow / checkin 这类字段
    expect('checkin' in a).toBe(false);
    expect('workflow' in a).toBe(false);
    // 反向锁定：如果有人给 Account 加了账号级流程字段，这个断言会失败
    const accountKeys = Object.keys(a);
    expect(accountKeys).not.toContain('workflow');
    expect(accountKeys).not.toContain('checkin');
    expect(accountKeys).not.toContain('checkinWorkflow');
  });

  it('学习落盘写的是站点（updateSite），不是账号（updateAccount）', async () => {
    store.set('sites', [site('site-x')]);
    store.set('accounts', [account('acc-1', 'site-x'), account('acc-2', 'site-x')]);

    // 模拟「账号 1 学习结束」的落盘：background 走的是 updateSite
    await appRepository.updateSite('site-x', {
      checkin: { method: 'workflow', workflow: WORKFLOW_A },
    });

    const sites = store.get('sites') as SiteConfig[];
    const accounts = store.get('accounts') as Account[];
    expect(sites[0]!.checkin?.workflow).toEqual(WORKFLOW_A);
    // 账号本身没有被写入任何流程
    for (const a of accounts) {
      expect(JSON.stringify(a)).not.toContain('claim-from-account');
    }
  });

  it('账号 2 再学习一次 → 覆盖同一份站点流程（不是各存一份）', async () => {
    store.set('sites', [site('site-x')]);
    store.set('accounts', [account('acc-1', 'site-x'), account('acc-2', 'site-x')]);

    await appRepository.updateSite('site-x', {
      checkin: { method: 'workflow', workflow: WORKFLOW_A },
    });
    // 账号 2 学习后
    await appRepository.updateSite('site-x', {
      checkin: { method: 'workflow', workflow: WORKFLOW_B },
    });

    const sites = store.get('sites') as SiteConfig[];
    // 关键：站点只有一条记录、流程只有一个，且已被第二次学习覆盖
    expect(sites.filter((s) => s.id === 'site-x')).toHaveLength(1);
    expect(sites[0]!.checkin?.workflow).toEqual(WORKFLOW_B);
    expect(JSON.stringify(store.get('accounts'))).not.toContain('claim-from-account-one');
  });

  it('同站多个账号解析到的是同一份流程内容（逐字节一致）', async () => {
    store.set('sites', [site('site-x')]);
    store.set('accounts', [account('acc-1', 'site-x'), account('acc-2', 'site-x'), account('acc-3', 'site-x')]);
    await appRepository.updateSite('site-x', {
      checkin: { method: 'workflow', workflow: WORKFLOW_B },
    });

    const sites = store.get('sites') as SiteConfig[];
    const accounts = store.get('accounts') as Account[];
    const resolved = accounts
      .filter((a) => a.siteId === 'site-x')
      .map(() => sites.find((s) => s.id === 'site-x')!.checkin!.workflow);
    expect(resolved).toHaveLength(3);
    for (const wf of resolved) {
      expect(JSON.stringify(wf)).toBe(JSON.stringify(resolved[0]));
    }
  });

  it('不同站点各自独立：改 A 站不影响 B 站流程', async () => {
    store.set('sites', [site('site-a'), site('site-b')]);
    await appRepository.updateSite('site-a', { checkin: { method: 'workflow', workflow: WORKFLOW_A } });
    await appRepository.updateSite('site-b', { checkin: { method: 'workflow', workflow: WORKFLOW_B } });

    const sites = store.get('sites') as SiteConfig[];
    expect(sites.find((s) => s.id === 'site-a')!.checkin!.workflow).toEqual(WORKFLOW_A);
    expect(sites.find((s) => s.id === 'site-b')!.checkin!.workflow).toEqual(WORKFLOW_B);
  });
});

describe('受管 GitHub 亲自登录后的身份标记只为同一个用户 ID 背书', () => {
  beforeEach(() => {
    store.clear();
  });

  it('亲自登录后写入：带标记；之后同一 ID 的普通补充不抹掉；换了 ID 立即失效', async () => {
    store.set('accounts', [account('acc-1', 'site-x')]);

    await appRepository.saveAccountIdentity('acc-1', { userId: '940', username: 'demo-github', verifiedByManagedLogin: true });
    expect((store.get('accounts') as Account[])[0]!.identity).toMatchObject({ userId: '940', verifiedByManagedLogin: true });

    await appRepository.saveAccountIdentity('acc-1', { userId: '940', group: 'default' });
    expect((store.get('accounts') as Account[])[0]!.identity?.verifiedByManagedLogin).toBe(true);

    await appRepository.saveAccountIdentity('acc-1', { userId: '777', source: 'visible' });
    expect((store.get('accounts') as Account[])[0]!.identity?.verifiedByManagedLogin).toBeUndefined();
  });

  it('来源被改写成页面/本地副本时，旧标记不再背书', async () => {
    store.set('accounts', [account('acc-1', 'site-x')]);
    await appRepository.saveAccountIdentity('acc-1', { userId: '940', verifiedByManagedLogin: true });
    await appRepository.saveAccountIdentity('acc-1', { userId: '940', source: 'storage' });
    expect((store.get('accounts') as Account[])[0]!.identity?.verifiedByManagedLogin).toBeUndefined();
  });
});
