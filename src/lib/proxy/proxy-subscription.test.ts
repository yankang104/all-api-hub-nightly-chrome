import { describe, expect, it } from 'vitest';
import { parseSubscription } from '@/lib/proxy/proxy-subscription';

/** 把 URI 列表编成订阅最常见的整体 base64 形态 */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return btoa(String.fromCharCode(...bytes));
}

describe('parseSubscription', () => {
  it('解析明文 URI 列表，带认证与节点名', () => {
    const result = parseSubscription([
      'http://user:pass@1.2.3.4:8080#%E6%97%A5%E6%9C%AC01',
      'socks5://5.6.7.8:1080#香港A10',
    ].join('\n'));

    expect(result.format).toBe('uri-list');
    expect(result.nodes).toEqual([
      { name: '日本01', scheme: 'http', host: '1.2.3.4', port: 8080, username: 'user', password: 'pass' },
      { name: '香港A10', scheme: 'socks5', host: '5.6.7.8', port: 1080 },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it('解析整体 base64 的订阅载荷', () => {
    const result = parseSubscription(toBase64('socks5://9.9.9.9:1080#东京\nhttp://8.8.8.8:3128#新加坡'));

    expect(result.format).toBe('base64');
    expect(result.nodes.map((node) => node.host)).toEqual(['9.9.9.9', '8.8.8.8']);
    expect(result.nodes[0]!.name).toBe('东京');
  });

  /**
   * 这条是这个模块存在的主要理由：Chrome 的 proxy 接口用不了 vless/vmess，
   * 必须按协议统计回报，界面才能说清「为什么 50 个节点只导进来 2 个」。
   */
  it('Chrome 不支持的协议按协议名聚合到 skipped，而不是静默丢弃', () => {
    const result = parseSubscription([
      'vless://uuid@a.example.com:443?type=ws#日本01',
      'vless://uuid@b.example.com:443?type=ws#日本02',
      'vmess://eyJ2IjoiMiJ9',
      'trojan://pw@c.example.com:443#香港',
      'ss://YWVzLTI1Ni1nY206cHc@d.example.com:8388#美国',
      'socks5://1.1.1.1:1080#可用节点',
    ].join('\n'));

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.host).toBe('1.1.1.1');
    expect(result.skipped).toEqual([
      { reason: 'unsupported-scheme', scheme: 'vless', count: 2 },
      { reason: 'unsupported-scheme', scheme: 'ss', count: 1 },
      { reason: 'unsupported-scheme', scheme: 'trojan', count: 1 },
      { reason: 'unsupported-scheme', scheme: 'vmess', count: 1 },
    ]);
  });

  it('同一出口重复出现时去重，避免多个账号被绑到同一 IP', () => {
    const result = parseSubscription([
      'socks5://1.1.1.1:1080#分组A-东京',
      'socks5://1.1.1.1:1080#分组B-东京',
      'socks5://1.1.1.1:1081#东京备用',
    ].join('\n'));

    expect(result.nodes).toHaveLength(2);
    expect(result.duplicates).toBe(1);
    expect(result.nodes.map((node) => node.port)).toEqual([1080, 1081]);
  });

  it('缺少节点名时回落 host:port，socks 省略端口时用 1080', () => {
    const result = parseSubscription('socks5://7.7.7.7');

    expect(result.nodes).toEqual([
      { name: '7.7.7.7:1080', scheme: 'socks5', host: '7.7.7.7', port: 1080 },
    ]);
  });

  it('端口非法的条目计入 malformed', () => {
    const result = parseSubscription('http://1.2.3.4:99999#坏节点');

    expect(result.nodes).toEqual([]);
    expect(result.skipped).toEqual([{ reason: 'malformed', scheme: 'http', count: 1 }]);
  });

  it('本地 https 代理自动改用 http，与池内既有修正一致', () => {
    const result = parseSubscription('https://127.0.0.1:7890#本地');

    expect(result.nodes[0]!.scheme).toBe('http');
  });

  it('解析 Clash YAML 里的 http/socks5 节点，其余类型计入 skipped', () => {
    const result = parseSubscription([
      'proxies:',
      '  - name: "日本01"',
      '    type: http',
      '    server: 1.2.3.4',
      '    port: 8080',
      '    username: u1',
      '    password: p1',
      '  - name: 香港A10',
      '    type: socks5',
      '    server: 5.6.7.8',
      '    port: 1080',
      '  - name: 东京vless',
      '    type: vless',
      '    server: 9.9.9.9',
      '    port: 443',
      'proxy-groups:',
      '  - name: 自动选择',
      '    type: url-test',
    ].join('\n'));

    expect(result.format).toBe('clash-yaml');
    expect(result.nodes).toEqual([
      { name: '日本01', scheme: 'http', host: '1.2.3.4', port: 8080, username: 'u1', password: 'p1' },
      { name: '香港A10', scheme: 'socks5', host: '5.6.7.8', port: 1080 },
    ]);
    expect(result.skipped).toEqual([{ reason: 'unsupported-scheme', scheme: 'vless', count: 1 }]);
  });

  it('Clash 的 type: http + tls: true 视为 https', () => {
    const result = parseSubscription([
      'proxies:',
      '  - {name: 安全代理, type: http, server: a.example.com, port: 443, tls: true}',
    ].join('\n'));

    expect(result.nodes[0]).toEqual({
      name: '安全代理', scheme: 'https', host: 'a.example.com', port: 443,
    });
  });

  /**
   * 机场普遍往 proxies: 里塞假节点显示流量和到期日，它们带合法 server/port，
   * 协议判定上与真节点无异。混进仅名称清单会让用户误以为公告是节点。
   */
  it('机场公告行不进仅名称清单，但仍计入协议统计', () => {
    const result = parseSubscription([
      'proxies:',
      "    - { name: '剩余流量：370.58 GB', server: jp.example.com, port: 1443, type: hysteria2 }",
      '    - { name: 套餐到期：长期有效, server: jp.example.com, port: 1443, type: hysteria2 }',
      '    - { name: 过滤掉11条线路, server: jp.example.com, port: 1443, type: hysteria2 }',
      '    - { name: 日本JP-HY2, server: jp.example.com, port: 1443, type: hysteria2 }',
      '    - { name: 日本-优化, server: jp2.example.com, port: 443, type: vmess }',
    ].join('\n'));

    expect(result.unsupportedNames).toEqual(['日本JP-HY2', '日本-优化']);
    // 统计仍按订阅原样报告，不因为剔除公告行而少算
    expect(result.skipped).toEqual([
      { reason: 'unsupported-scheme', scheme: 'hysteria2', count: 4 },
      { reason: 'unsupported-scheme', scheme: 'vmess', count: 1 },
    ]);
  });

  it('hysteria2 等新协议的节点名照样取出', () => {
    const result = parseSubscription([
      'proxies:',
      '    - { name: 香港HK-HY2, server: hk.example.com, port: 1443, type: hysteria2 }',
      '    - { name: 新加坡SG-HY2, server: sg.example.com, port: 1443, type: hysteria2 }',
    ].join('\n'));

    expect(result.unsupportedNames).toEqual(['香港HK-HY2', '新加坡SG-HY2']);
  });

  it('空内容与无法识别的内容都不抛错', () => {
    const empty = { nodes: [], skipped: [], duplicates: 0, unsupportedNames: [], format: 'unknown' };
    expect(parseSubscription('')).toEqual(empty);
    expect(parseSubscription('这里没有任何节点')).toEqual(empty);
  });
});

/**
 * 这些名字是生成 Clash listener 配置的唯一依据：listener 的 `proxy:`
 * 必须与订阅里的节点名逐字一致，所以取名规则必须跟客户端对齐。
 */
describe('parseSubscription 保留不支持协议的节点名', () => {
  it('从 fragment 取 vless/trojan/ss 的节点名', () => {
    const result = parseSubscription([
      'vless://uuid@a.example.com:443#%E6%97%A5%E6%9C%AC01',
      'trojan://pw@b.example.com:443#香港A10',
      'ss://YWVzOnB3@c.example.com:8388#美国03',
    ].join('\n'));

    expect(result.unsupportedNames).toEqual(['日本01', '香港A10', '美国03']);
  });

  it('从 base64 JSON 的 ps 字段取 vmess 节点名', () => {
    const vmess = (ps: string, host: string) => `vmess://${btoa(
      String.fromCharCode(...new TextEncoder().encode(JSON.stringify({ v: '2', ps, add: host, port: '443', id: 'uuid' }))),
    )}`;
    const result = parseSubscription([vmess('日本01', 'a.example.com'), vmess('香港A10', 'b.example.com')].join('\n'));

    expect(result.nodes).toEqual([]);
    expect(result.unsupportedNames).toEqual(['日本01', '香港A10']);
  });

  it('同名节点只留一个：listener 按名字匹配，重名生成两个端口也指向同一节点', () => {
    const result = parseSubscription([
      'vless://uuid@a.example.com:443#日本01',
      'vless://uuid@b.example.com:443#日本01',
      'vless://uuid@c.example.com:443#日本02',
    ].join('\n'));

    expect(result.unsupportedNames).toEqual(['日本01', '日本02']);
  });

  it('格式坏掉的条目不进名单：本地内核也用不了它', () => {
    const result = parseSubscription([
      'vless://uuid@a.example.com:443#能用的节点',
      'http://1.2.3.4:99999#坏节点',
    ].join('\n'));

    expect(result.unsupportedNames).toEqual(['能用的节点']);
  });

  it('Clash YAML 里不支持类型的节点也保留名字', () => {
    const result = parseSubscription([
      'proxies:',
      '  - {name: 东京vmess, type: vmess, server: a.example.com, port: 443}',
      '  - {name: 首尔trojan, type: trojan, server: b.example.com, port: 443}',
    ].join('\n'));

    expect(result.unsupportedNames).toEqual(['东京vmess', '首尔trojan']);
  });
});

describe('机场推广行不进节点清单（真机实测回归）', () => {
  it('电报群/防失联这类带链接的推广行被识别为公告', () => {
    const result = parseSubscription([
      'proxies:',
      "  - { name: '新加坡01aws', server: sg.example.com, port: 8443, type: hysteria2, password: x }",
      "  - { name: '电报群https://t.me/example', server: sg.example.com, port: 8443, type: hysteria2, password: x }",
      "  - { name: '防失联页https://github.com/example', server: sg.example.com, port: 8443, type: hysteria2, password: x }",
      "  - { name: '有超过20多个节点，不够请到官网使用文档，下载最新的客户端', server: sg.example.com, port: 8443, type: hysteria2, password: x }",
    ].join('\n'));

    // 只有真实节点留下;三条推广行全部被剔掉
    expect(result.unsupportedNames).toEqual(['新加坡01aws']);
  });
});
