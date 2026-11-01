import { describe, expect, it } from 'vitest';
import type { Account, ProxyConfig } from '@/types';
import { nameOnlyBoundAccounts, planNameOnlyRepair } from '@/lib/proxy/proxy-repair';

const nameOnly = (id: string, name: string): ProxyConfig => ({
  id, name, scheme: 'http', host: '0.0.0.0', port: 0, nameOnly: true,
});
const real = (id: string, name: string, port: number): ProxyConfig => ({
  id, name, scheme: 'http', host: '127.0.0.1', port,
});
const account = (id: string, proxyId?: string, extra: Partial<Account> = {}): Account => ({
  id,
  siteId: 'site',
  username: `${id}@example.com`,
  password: 'x',
  ...(proxyId ? { proxyMode: 'pool' as const, proxyId } : {}),
  ...extra,
} as Account);

describe('name-only binding detection', () => {
  const proxies = [nameOnly('n1', '香港-优化2'), real('r1', '香港WAP-优化2-Gemini', 11018)];

  it('flags accounts bound to a subscription name with no exit', () => {
    const stuck = nameOnlyBoundAccounts([account('a', 'n1'), account('b', 'r1')], proxies);
    expect(stuck.map((item) => item.id)).toEqual(['a']);
  });

  it('leaves direct and custom accounts alone', () => {
    const accounts = [
      account('a', 'n1', { proxyMode: 'none' }),
      account('b', 'n1', { proxyMode: 'custom' }),
      account('c'),
    ];
    expect(nameOnlyBoundAccounts(accounts, proxies)).toEqual([]);
  });

  it('ignores a proxyId that is no longer in the pool', () => {
    expect(nameOnlyBoundAccounts([account('a', 'gone')], proxies)).toEqual([]);
  });
});

describe('name-only binding repair', () => {
  /*
   * 这条是用户实际踩到的形状：订阅节点叫「香港-优化2」「新加坡-优化-GPT」，
   * 本机端口清单里的同地区节点叫「香港WAP-优化2-Gemini」「新加坡-优化-Gemini-GPT」，
   * 名字配不上对所以升级救不了，只能按地区换绑。
   */
  const proxies = [
    nameOnly('n-hk', '香港-优化2'),
    nameOnly('n-sg', '新加坡-优化-GPT'),
    real('r-hk1', '[HK] 香港WAP-优化2-Gemini', 11018),
    real('r-hk2', '[HK] 香港HK-HY2', 11013),
    real('r-sg1', '[SG] 新加坡-优化-Gemini-GPT', 11008),
  ];

  it('rebinds to a real exit in the same region', () => {
    const plan = planNameOnlyRepair([account('a', 'n-hk'), account('b', 'n-sg')], proxies);

    expect(plan.assignments).toEqual([
      { accountId: 'a', proxyId: 'r-hk1' },
      { accountId: 'b', proxyId: 'r-sg1' },
    ]);
    expect(plan.crossRegion).toBe(0);
    expect(plan.unresolved).toEqual([]);
  });

  it('spreads several stuck accounts across the region instead of stacking one IP', () => {
    const plan = planNameOnlyRepair(
      [account('a', 'n-hk'), account('b', 'n-hk'), account('c', 'n-hk')],
      proxies,
    );

    expect(plan.assignments.map((item) => item.proxyId)).toEqual(['r-hk1', 'r-hk2', 'r-hk1']);
  });

  it('starts from exits that healthy accounts already occupy', () => {
    // r-hk1 已被一个正常账号占用，待救账号应该先落到 r-hk2
    const plan = planNameOnlyRepair([account('healthy', 'r-hk1'), account('a', 'n-hk')], proxies);

    expect(plan.assignments).toEqual([{ accountId: 'a', proxyId: 'r-hk2' }]);
  });

  it('falls back across regions and reports how many', () => {
    const plan = planNameOnlyRepair([account('a', 'n-hk')], [nameOnly('n-hk', '香港-优化2'), real('r-jp', '[JP] 日本-优化', 11001)]);

    expect(plan.assignments).toEqual([{ accountId: 'a', proxyId: 'r-jp' }]);
    expect(plan.crossRegion).toBe(1);
  });

  it('refuses to cross regions when told not to', () => {
    const plan = planNameOnlyRepair(
      [account('a', 'n-hk')],
      [nameOnly('n-hk', '香港-优化2'), real('r-jp', '[JP] 日本-优化', 11001)],
      false,
    );

    expect(plan.assignments).toEqual([]);
    expect(plan.unresolved).toEqual([{ accountId: 'a', proxyName: '香港-优化2' }]);
  });

  it('reports the stuck accounts when the pool has no real exit at all', () => {
    const plan = planNameOnlyRepair([account('a', 'n-hk')], [nameOnly('n-hk', '香港-优化2')]);

    expect(plan.assignments).toEqual([]);
    expect(plan.unresolved).toEqual([{ accountId: 'a', proxyName: '香港-优化2' }]);
  });

  it('does nothing when no account is stuck', () => {
    expect(planNameOnlyRepair([account('a', 'r-hk1')], proxies)).toEqual({
      assignments: [], crossRegion: 0, unresolved: [],
    });
  });

  /** 换绑不打图钉：日后池里补进真正同名的出口时还应该能被重新摊平 */
  it('does not pin the replacement binding', () => {
    const plan = planNameOnlyRepair([account('a', 'n-hk')], proxies);
    expect(plan.assignments[0]).not.toHaveProperty('pinned');
  });
});
