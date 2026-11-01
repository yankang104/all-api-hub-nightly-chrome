import { describe, expect, it } from 'vitest';
import type { Account, ProxyConfig, SiteConfig } from '@/types';
import { describeAccountProxy } from '@/lib/proxy/proxy-config';

const POOL: ProxyConfig[] = [
  { id: 'p1', name: '香港节点', scheme: 'http', host: '1.2.3.4', port: 8080 },
  { id: 'p2', name: '', scheme: 'socks5', host: '5.6.7.8', port: 1080 },
];

function account(patch: Partial<Account> = {}): Pick<Account, 'proxyMode' | 'proxyId' | 'customProxy'> {
  return { ...patch };
}

const siteWithProxy: Pick<SiteConfig, 'proxyId'> = { proxyId: 'p1' };
const siteDirect: Pick<SiteConfig, 'proxyId'> = {};

describe('账号生效代理的界面标签', () => {
  it('默认继承站点代理，并标记为继承来的', () => {
    expect(describeAccountProxy(account(), siteWithProxy, POOL)).toEqual({
      kind: 'proxy',
      label: '香港节点',
      inherited: true,
    });
  });

  it('继承模式下站点也没配代理就是直连', () => {
    expect(describeAccountProxy(account(), siteDirect, POOL)).toEqual({ kind: 'direct' });
  });

  it('账号显式选 none 时，即使站点配了代理也直连', () => {
    // 这条是「账号设置优先于站点」的关键：写错会让用户以为自己关掉了代理，实际还在走
    expect(describeAccountProxy(account({ proxyMode: 'none' }), siteWithProxy, POOL)).toEqual({
      kind: 'direct',
    });
  });

  it('代理池节点没有名字时退回 host:port', () => {
    expect(describeAccountProxy(account({ proxyMode: 'pool', proxyId: 'p2' }), siteDirect, POOL)).toEqual({
      kind: 'proxy',
      label: '5.6.7.8:1080',
      inherited: false,
    });
  });

  it('自定义代理显示地址端口', () => {
    const custom = account({
      proxyMode: 'custom',
      customProxy: { scheme: 'http', host: '127.0.0.1', port: 7890 },
    });
    expect(describeAccountProxy(custom, siteWithProxy, POOL)).toEqual({
      kind: 'proxy',
      label: '127.0.0.1:7890',
      inherited: false,
    });
  });

  it('配置没填完时标为无效，而不是假装直连', () => {
    // background 这几种情况会直接报错拒跑，界面必须提前显示出来
    expect(describeAccountProxy(account({ proxyMode: 'pool' }), siteWithProxy, POOL)).toEqual({
      kind: 'invalid',
      label: '未选择代理池节点',
    });
    expect(describeAccountProxy(account({ proxyMode: 'custom' }), siteDirect, POOL)).toEqual({
      kind: 'invalid',
      label: '自定义代理未填完',
    });
    expect(describeAccountProxy(account({ proxyMode: 'pool', proxyId: 'gone' }), siteDirect, POOL)).toEqual({
      kind: 'invalid',
      label: '代理已被删除',
    });
  });
});
