import { describe, expect, it } from 'vitest';
import { normalizeProxyName, planProxyUpgrade, proxyEndpointKey } from '@/lib/proxy/proxy-upgrade';
import type { ProxyConfig } from '@/types';

const nameOnly = (id: string, name: string): ProxyConfig => ({
  id, name, scheme: 'http', host: '0.0.0.0', port: 1, nameOnly: true,
});
const real = (id: string, name: string, port: number): ProxyConfig => ({
  id, name, scheme: 'http', host: '127.0.0.1', port,
});
const input = (name: string, port: number): Omit<ProxyConfig, 'id'> => ({
  name, scheme: 'http', host: '127.0.0.1', port,
});
const clashInput = (name: string, port: number): Omit<ProxyConfig, 'id'> => ({
  ...input(name, port),
  sourceLabel: 'Clash Verge',
});

describe('normalizeProxyName', () => {
  it('剥掉导入清单加的国家前缀', () => {
    expect(normalizeProxyName('[JP] 日本-优化')).toBe(normalizeProxyName('日本-优化'));
    expect(normalizeProxyName('［US］美国02aws')).toBe(normalizeProxyName('美国02aws'));
  });

  it('忽略连字符与空白差异', () => {
    expect(normalizeProxyName('日本 - 优化')).toBe(normalizeProxyName('日本-优化'));
    expect(normalizeProxyName('日本－优化')).toBe(normalizeProxyName('日本-优化'));
  });

  it('剥掉末尾的端口括号', () => {
    expect(normalizeProxyName('日本-优化 (11001)')).toBe(normalizeProxyName('日本-优化'));
  });

  it('不同节点不会被压成同一个', () => {
    expect(normalizeProxyName('日本-优化')).not.toBe(normalizeProxyName('日本-优化2'));
    expect(normalizeProxyName('[US] 美国02aws')).not.toBe(normalizeProxyName('[US] 美国03aws'));
  });
});

describe('planProxyUpgrade', () => {
  it('同名的名称条目被原地升级，id 不变（账号绑定不断）', () => {
    const plan = planProxyUpgrade([nameOnly('px1', '日本-优化')], [input('[JP] 日本-优化', 11001)]);

    expect(plan.upgrades).toEqual([
      { id: 'px1', patch: { name: '[JP] 日本-优化', scheme: 'http', host: '127.0.0.1', port: 11001 } },
    ]);
    expect(plan.additions).toEqual([]);
  });

  it('没有对应名称条目的按新增处理', () => {
    const plan = planProxyUpgrade([nameOnly('px1', '日本-优化')], [input('[US] 美国02aws', 10016)]);

    expect(plan.upgrades).toEqual([]);
    expect(plan.additions).toHaveLength(1);
    expect(plan.additions[0]!.port).toBe(10016);
  });

  it('已有真实出口的同名条目不被覆盖', () => {
    // 用户手填过一条，不能被导入清单改掉 —— 那是他自己配的地址
    const plan = planProxyUpgrade([real('px1', '日本-优化', 7890)], [input('[JP] 日本-优化', 11001)]);

    expect(plan.upgrades).toEqual([]);
    expect(plan.additions).toHaveLength(1);
  });

  it('端口已在池中时整条跳过，不新增也不升级', () => {
    const plan = planProxyUpgrade([real('px1', '随便叫什么', 11001)], [input('[JP] 日本-优化', 11001)]);

    expect(plan.upgrades).toEqual([]);
    expect(plan.additions).toEqual([]);
  });

  it('Clash 同步时保留同名 nameOnly ID，并合并同一 loopback 端口的历史出口', () => {
    const oldSocks: ProxyConfig = {
      id: 'px-real',
      name: '旧扫描名称',
      scheme: 'socks5',
      host: 'localhost',
      port: 11001,
    };
    const plan = planProxyUpgrade(
      [nameOnly('px-name', '日本-优化'), oldSocks],
      [clashInput('[JP] 日本-优化', 11001)],
    );

    expect(plan.upgrades).toEqual([{
      id: 'px-name',
      patch: {
        name: '[JP] 日本-优化',
        scheme: 'http',
        host: '127.0.0.1',
        port: 11001,
        sourceLabel: 'Clash Verge',
      },
    }]);
    expect(plan.merges).toEqual([{ fromId: 'px-real', toId: 'px-name' }]);
    expect(plan.additions).toEqual([]);
  });

  it('Clash 同步会把重复的同名 nameOnly 全部合并到第一个 ID', () => {
    const plan = planProxyUpgrade(
      [nameOnly('px-first', '日本-优化'), nameOnly('px-duplicate', '[JP] 日本-优化')],
      [clashInput('[JP] 日本-优化', 11001)],
    );

    expect(plan.upgrades).toEqual([{
      id: 'px-first',
      patch: {
        name: '[JP] 日本-优化',
        scheme: 'http',
        host: '127.0.0.1',
        port: 11001,
        sourceLabel: 'Clash Verge',
      },
    }]);
    expect(plan.merges).toEqual([{ fromId: 'px-duplicate', toId: 'px-first' }]);
    expect(plan.additions).toEqual([]);
  });

  it('Clash 同步只有真实出口时更新名称和来源，不改写历史可用连接方式', () => {
    const existing: ProxyConfig = {
      id: 'px-real',
      name: '旧扫描名称',
      scheme: 'socks5',
      host: '::1',
      port: 11001,
    };
    const plan = planProxyUpgrade([existing], [clashInput('[JP] 日本-优化', 11001)]);

    expect(proxyEndpointKey(existing)).toBe(proxyEndpointKey(clashInput('任意名称', 11001)));
    expect(plan.upgrades).toEqual([{
      id: 'px-real',
      patch: { name: '[JP] 日本-优化', sourceLabel: 'Clash Verge' },
    }]);
    expect(plan.merges).toEqual([]);
    expect(plan.additions).toEqual([]);
  });

  it('一条名称条目只被升级一次，不会被多个输入抢', () => {
    const plan = planProxyUpgrade(
      [nameOnly('px1', '日本-优化')],
      [input('[JP] 日本-优化', 11001), input('[JP] 日本-优化', 11002)],
    );

    expect(plan.upgrades).toHaveLength(1);
    expect(plan.upgrades[0]!.patch.port).toBe(11001);
    // 第二个同名的没有可配对的条目了，按新增走，不能凭空丢掉
    expect(plan.additions).toHaveLength(1);
    expect(plan.additions[0]!.port).toBe(11002);
  });

  it('输入本身是名称条目时不参与升级', () => {
    const plan = planProxyUpgrade(
      [nameOnly('px1', '日本-优化')],
      [{ name: '日本-优化', scheme: 'http', host: '0.0.0.0', port: 1, nameOnly: true }],
    );

    expect(plan.upgrades).toEqual([]);
    expect(plan.additions).toHaveLength(1);
  });

  it('输入里重复的出口只保留一条', () => {
    const plan = planProxyUpgrade([], [input('甲', 11001), input('乙', 11001)]);
    expect(plan.additions).toHaveLength(1);
  });

  it('整批混合场景：该升的升、该加的加、该跳的跳', () => {
    const existing = [
      nameOnly('px1', '日本-优化'),
      nameOnly('px2', 'vmess香港01'),
      real('px3', '已有出口', 7897),
    ];
    const inputs = [
      input('[JP] 日本-优化', 11001),   // 升级 px1
      input('[US] 美国02aws', 10016),   // 新增
      input('已有出口', 7897),           // 端口已存在，跳过
    ];

    const plan = planProxyUpgrade(existing, inputs);

    expect(plan.upgrades.map((u) => u.id)).toEqual(['px1']);
    expect(plan.additions.map((a) => a.port)).toEqual([10016]);
    // px2 没有匹配的输入，保持名称条目状态
    expect(plan.upgrades.some((u) => u.id === 'px2')).toBe(false);
  });
});
