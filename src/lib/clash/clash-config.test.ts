import { describe, expect, it } from 'vitest';
import { parseClashListenerConfig } from '@/lib/clash/clash-config';

describe('parseClashListenerConfig', () => {
  it('imports fixed mixed/http/socks listeners and stops at the next top-level key', () => {
    const result = parseClashListenerConfig(`
mixed-port: 7897
proxies:
- name: JP-日本
  type: vmess
- name: "新加坡01 # AWS"
  type: hysteria2
- name: 美国 LA
  type: vless
listeners:
- name: region-7901
  type: mixed
  port: 7901
  listen: 127.0.0.1
  proxy: JP-日本
- name: fly-10001
  type: socks
  port: 10001
  listen: 0.0.0.0
  proxy: "新加坡01 # AWS"
- name: web-12001
  type: http
  port: 12001
  proxy: '美国 LA'
rules:
- MATCH,DIRECT
`);
    expect(result).toEqual({
      nodes: [
        { name: 'JP-日本', scheme: 'http', host: '127.0.0.1', port: 7901, sourceLabel: 'Clash Verge' },
        { name: '新加坡01 # AWS', scheme: 'socks5', host: '127.0.0.1', port: 10001, sourceLabel: 'Clash Verge' },
        { name: '美国 LA', scheme: 'http', host: '127.0.0.1', port: 12001, sourceLabel: 'Clash Verge' },
      ],
      skipped: 0,
      catalog: {
        detected: true,
        totalEntries: 3,
        realNodes: 3,
        noticeEntries: 0,
        fixedNodes: 3,
        missingListenerNames: [],
        groupListeners: 0,
        staleListeners: 0,
      },
    });
  });

  it('ignores malformed listeners and duplicate endpoints', () => {
    const result = parseClashListenerConfig(`
listeners:
  - name: unsupported
    type: tunnel
    port: 9000
    proxy: 节点甲
  - name: valid
    type: mixed
    port: 7901
    proxy: 节点乙
  - name: duplicate
    type: mixed
    port: 7901
    proxy: 节点丙
`);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]?.name).toBe('节点乙');
    expect(result.skipped).toBe(2);
    expect(result.catalog.detected).toBe(false);
    expect(result.catalog.fixedNodes).toBe(1);
  });

  it('handles more than the old 64-port scan limit', () => {
    const listeners = Array.from({ length: 97 }, (_, index) => [
      `- name: listener-${index + 1}`,
      '  type: mixed',
      `  port: ${10001 + index}`,
      `  proxy: 节点${index + 1}`,
    ].join('\n')).join('\n');
    const result = parseClashListenerConfig(`listeners:\n${listeners}\nrules:\n- MATCH,DIRECT`);
    expect(result.nodes).toHaveLength(97);
    expect(result.nodes[96]?.port).toBe(10097);
    expect(result.catalog.fixedNodes).toBe(97);
  });

  it('separates real nodes from notices, groups, stale listeners, and missing listeners', () => {
    const result = parseClashListenerConfig(`
proxies:
- name: 剩余流量：37.5 GB
  type: hysteria2
- name: 新加坡01aws
  type: hysteria2
- name: 新加坡02aws
  type: hysteria2
- name: 日本01aws
  type: vmess
proxy-groups:
- name: 自动选择
  type: url-test
  proxies:
  - 新加坡01aws
listeners:
- name: sg-1
  type: mixed
  port: 10001
  proxy: 新加坡01aws
- name: sg-2
  type: socks
  port: 10002
  proxy: 新加坡02aws
- name: auto
  type: mixed
  port: 11001
  proxy: 自动选择
- name: removed
  type: mixed
  port: 12001
  proxy: 已删除节点
`);

    expect(result.nodes.map((node) => node.name)).toEqual(['新加坡01aws', '新加坡02aws']);
    expect(result.skipped).toBe(2);
    expect(result.catalog).toEqual({
      detected: true,
      totalEntries: 4,
      realNodes: 3,
      noticeEntries: 1,
      fixedNodes: 2,
      missingListenerNames: ['日本01aws'],
      groupListeners: 1,
      staleListeners: 1,
    });
  });

  it('reads inline proxy and group mappings used by Clash Verge profile files', () => {
    const result = parseClashListenerConfig(`
mixed-port: 7897
proxies:
  - { name: '节点甲', type: vmess, server: a.example, port: 443 }
  - { name: "节点乙 | GPT", type: vless, server: b.example, port: 8443, reality-opts: { public-key: abc, short-id: 01 } }
  - { name: '剩余流量：10 GB', type: hysteria2, server: c.example, port: 443 }
proxy-groups:
  - { name: 自动选择, type: url-test, proxies: [节点甲, 节点乙 | GPT] }
listeners:
  - { name: node-a, type: mixed, port: 12001, listen: 127.0.0.1, proxy: 节点甲 }
  - { name: group, type: mixed, port: 12002, listen: 127.0.0.1, proxy: 自动选择 }
`);

    expect(result.nodes).toEqual([
      { name: '节点甲', scheme: 'http', host: '127.0.0.1', port: 12001, sourceLabel: 'Clash Verge' },
    ]);
    expect(result.catalog).toEqual({
      detected: true,
      totalEntries: 3,
      realNodes: 2,
      noticeEntries: 1,
      fixedNodes: 1,
      missingListenerNames: ['节点乙 | GPT'],
      groupListeners: 1,
      staleListeners: 0,
    });
  });
});
