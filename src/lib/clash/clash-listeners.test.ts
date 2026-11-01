import { describe, expect, it } from 'vitest';
import {
  buildListenerPlan,
  DEFAULT_LISTENER_START_PORT,
  diffListenerPlan,
  RESERVED_PORTS,
  listenerExitToPoolEntry,
  parseClashListenerExits,
  parseClashListenerResponse,
} from '@/lib/clash/clash-listeners';

describe('buildListenerPlan', () => {
  it('每个节点一个端口，端口依次递增', () => {
    const plan = buildListenerPlan(['日本01', '香港A10', '美国03']);

    expect(plan.entries).toEqual([
      { nodeName: '日本01', port: 7901, listenerName: 'hub-7901' },
      { nodeName: '香港A10', port: 7902, listenerName: 'hub-7902' },
      { nodeName: '美国03', port: 7903, listenerName: 'hub-7903' },
    ]);
  });

  it('默认起始端口避开内核自己的 7890/7891', () => {
    expect(DEFAULT_LISTENER_START_PORT).toBe(7901);
    expect(buildListenerPlan(['甲']).entries[0]!.port).toBe(7901);
  });

  it('生成可直接粘贴的 listeners 片段', () => {
    const plan = buildListenerPlan(['日本01', '香港A10']);

    expect(plan.yaml).toBe([
      'listeners:',
      '  - name: hub-7901',
      '    type: mixed',
      '    port: 7901',
      '    listen: 127.0.0.1',
      '    proxy: "日本01"',
      '  - name: hub-7902',
      '    type: mixed',
      '    port: 7902',
      '    listen: 127.0.0.1',
      '    proxy: "香港A10"',
    ].join('\n'));
  });

  /**
   * 机场节点名里 `|`、`:`、emoji 很常见。裸写会让 YAML 解析失败或把名字读错，
   * 而名字读错就等于 proxy: 匹配不上任何节点 —— 端口开起来但连不通。
   */
  it('节点名加引号，含特殊字符也不破坏 YAML', () => {
    const plan = buildListenerPlan(['PKM-18 🇯🇵【亚洲】日本01 | Vless 2x', '含"引号"的节点']);

    expect(plan.yaml).toContain('    proxy: "PKM-18 🇯🇵【亚洲】日本01 | Vless 2x"');
    expect(plan.yaml).toContain('    proxy: "含\\"引号\\"的节点"');
  });

  /**
   * 节点名来自订阅、完全不可信：只做过 trim，内部换行原样留着。若引号标量不转义
   * 换行，带换行的名字就能从标量里逃逸，凭空注入额外的 YAML 键甚至整条 listener
   * （比如把某端口绑到 DIRECT），悄悄废掉每账号一出口的隔离。换行必须转成 `\n`
   * 留在同一行里，不能真的另起一行。
   */
  it('节点名里的换行被转义，不会注入额外的 YAML 键', () => {
    const plan = buildListenerPlan(['JP\n  port: 65001\n  proxy: DIRECT']);
    const lines = plan.yaml.split('\n');

    // 恶意名字里的 port:/proxy: 全被引号包在同一行内，真正的 YAML 里每个 entry
    // 只该有一行 port:、一行 proxy:；若换行逃逸成功，这两个计数就会变成 2
    expect(lines.filter((line) => /^\s*port:/.test(line))).toHaveLength(1);
    expect(lines.filter((line) => /^\s*proxy:/.test(line))).toHaveLength(1);
    expect(plan.yaml).toContain('    proxy: "JP\\n  port: 65001\\n  proxy: DIRECT"');
    // 单个节点仍只产出 listeners: 头 + 5 行模板，换行没让 YAML 多出任何行
    expect(lines).toHaveLength(6);
  });

  it('池条目与端口一一对应，均为本地 http', () => {
    const plan = buildListenerPlan(['日本01', '香港A10'], 8100);

    expect(plan.poolEntries).toEqual([
      { name: '日本01', scheme: 'http', host: '127.0.0.1', port: 8100 },
      { name: '香港A10', scheme: 'http', host: '127.0.0.1', port: 8101 },
    ]);
  });

  it('自定义起始端口生效，非法值回落默认', () => {
    expect(buildListenerPlan(['甲'], 9000).entries[0]!.port).toBe(9000);
    expect(buildListenerPlan(['甲'], 0).entries[0]!.port).toBe(DEFAULT_LISTENER_START_PORT);
    expect(buildListenerPlan(['甲'], 70000).entries[0]!.port).toBe(DEFAULT_LISTENER_START_PORT);
  });

  it('端口超出上限时截断并报告丢弃数量', () => {
    const plan = buildListenerPlan(['甲', '乙', '丙'], 65534);

    expect(plan.entries.map((entry) => entry.port)).toEqual([65534, 65535]);
    expect(plan.dropped).toBe(1);
  });

  it('跳过空名字，不产生占位端口', () => {
    const plan = buildListenerPlan(['日本01', '  ', '香港A10']);

    expect(plan.entries.map((entry) => entry.nodeName)).toEqual(['日本01', '香港A10']);
    expect(plan.entries.map((entry) => entry.port)).toEqual([7901, 7902]);
  });

  it('没有节点时不产出 YAML', () => {
    const plan = buildListenerPlan([]);

    expect(plan).toEqual({ entries: [], yaml: '', script: '', poolEntries: [], dropped: 0 });
  });
});

describe('parseClashListenerResponse', () => {
  it('reads the port to proxy mapping from the array response', () => {
    expect(parseClashListenerResponse([
      { port: 7901, proxy: 'JP-日本' },
      { port: 7902, proxy: 'US-美国' },
      { port: 7903, proxy: '' },
    ], new Set([7901, 7902]))).toEqual(new Map([[7901, 'JP-日本'], [7902, 'US-美国']]));
  });

  it('accepts object-shaped listeners and ignores ports outside the scan', () => {
    expect(parseClashListenerResponse({ listeners: {
      'region-7904': { port: '7904', name: 'TW-中国台湾' },
      'region-7999': { port: 7999, proxy: 'unused' },
    } }, new Set([7904]))).toEqual(new Map([[7904, 'TW-中国台湾']]));
  });
});

describe('parseClashListenerExits', () => {
  it('解析出绑定到具体节点的本地出口', () => {
    const body = {
      listeners: [
        { name: '新加坡01aws', type: 'mixed', port: 7901, listen: '127.0.0.1', proxy: '新加坡01aws' },
        { name: '香港A10', type: 'mixed', port: 7902, listen: '127.0.0.1', proxy: '香港A10' },
      ],
    };

    expect(parseClashListenerExits(body)).toEqual([
      { listenerName: '新加坡01aws', nodeName: '新加坡01aws', port: 7901, listenerType: 'mixed' },
      { listenerName: '香港A10', nodeName: '香港A10', port: 7902, listenerType: 'mixed' },
    ]);
  });

  it('兼容裸数组与以 name 为键的对象形状', () => {
    const entry = { name: '东京', port: 7901, proxy: '东京' };

    expect(parseClashListenerExits([entry])).toEqual([
      { listenerName: '东京', nodeName: '东京', port: 7901, listenerType: '' },
    ]);
    expect(parseClashListenerExits({ listeners: { '东京': entry } })).toEqual([
      { listenerName: '东京', nodeName: '东京', port: 7901, listenerType: '' },
    ]);
  });

  it('CJK 与 emoji 节点名原样保留', () => {
    expect(parseClashListenerExits({
      listeners: [{ name: '东京-测试', port: 7901, proxy: '东京-测试 🇯🇵【亚洲】' }],
    })).toEqual([
      { listenerName: '东京-测试', nodeName: '东京-测试 🇯🇵【亚洲】', port: 7901, listenerType: '' },
    ]);
  });

  it('保留 listener 的 type，socks 端口不能被当成 http', () => {
    expect(parseClashListenerExits({
      listeners: [
        { name: 's1', type: 'socks', port: 7901, proxy: 'JP-01' },
        { name: 's2', type: 'SOCKS', port: 7902, proxy: 'JP-02' },
        { name: 's3', type: 'mixed', port: 7903, proxy: 'JP-03' },
      ],
    })).toEqual([
      { listenerName: 's1', nodeName: 'JP-01', port: 7901, listenerType: 'socks' },
      { listenerName: 's2', nodeName: 'JP-02', port: 7902, listenerType: 'socks' },
      { listenerName: 's3', nodeName: 'JP-03', port: 7903, listenerType: 'mixed' },
    ]);
  });

  it('跳过内建目标、内建 listener 类型、缺字段与坏端口', () => {
    const body = {
      listeners: [
        { name: 'l1', port: 7901, proxy: 'DIRECT' },
        { name: 'l2', port: 7902, proxy: 'reject' },
        { name: 'l3', port: 7903, proxy: 'PASS' },
        { name: 'l4', port: 7904, proxy: 'COMPATIBLE' },
        { name: 'l5', type: 'direct', port: 7905, proxy: 'JP-01' }, // listener 自身是内建类型
        { name: 'l6', port: 7906 }, // 无 proxy
        { port: 7907, proxy: 'JP-02' }, // 无 name
        { name: 'l8', port: 7908, proxy: '   ' }, // proxy 空串
        { name: 'l9', port: 0, proxy: 'JP-03' }, // 端口越界
        { name: 'l10', port: 65536, proxy: 'JP-04' }, // 端口越界
        { name: 'l11', port: -1, proxy: 'JP-05' }, // 端口越界
        { name: 'l12', port: 7909.5, proxy: 'JP-06' }, // 非整数
        { name: 'l13', port: '7910', proxy: 'JP-07' }, // 字符串端口
        { name: 'l14', port: 7911, proxy: 'JP-08' }, // 唯一合法项
      ],
    };

    expect(parseClashListenerExits(body)).toEqual([
      { listenerName: 'l14', nodeName: 'JP-08', port: 7911, listenerType: '' },
    ]);
  });

  it('同一端口只保留第一条', () => {
    const body = {
      listeners: [
        { name: 'first', port: 7901, proxy: 'JP-01' },
        { name: 'second', port: 7901, proxy: 'US-02' },
      ],
    };

    expect(parseClashListenerExits(body)).toEqual([
      { listenerName: 'first', nodeName: 'JP-01', port: 7901, listenerType: '' },
    ]);
  });

  it('名字为空或超长时丢弃（外部输入不可信）', () => {
    const long = 'x'.repeat(201);

    expect(parseClashListenerExits({
      listeners: [
        { name: long, port: 7901, proxy: 'JP' },
        { name: 'l', port: 7902, proxy: long },
        { name: 'l', port: 7903, proxy: 'ok' },
      ],
    })).toEqual([
      { listenerName: 'l', nodeName: 'ok', port: 7903, listenerType: '' },
    ]);
  });

  it('非对象/畸形输入一律返回空数组', () => {
    expect(parseClashListenerExits(null)).toEqual([]);
    expect(parseClashListenerExits(undefined)).toEqual([]);
    expect(parseClashListenerExits('nope')).toEqual([]);
    expect(parseClashListenerExits(42)).toEqual([]);
    expect(parseClashListenerExits({})).toEqual([]);
    expect(parseClashListenerExits({ listeners: 'x' })).toEqual([]);
    expect(parseClashListenerExits({ listeners: null })).toEqual([]);
    expect(parseClashListenerExits([null, 'x', 1, []])).toEqual([]);
  });
});

describe('listenerExitToPoolEntry', () => {
  it('转成本地 http 代理池条目并标记来源', () => {
    expect(listenerExitToPoolEntry({ listenerName: 'hub-7901', nodeName: '日本01', port: 7901, listenerType: 'mixed' }))
      .toEqual({
        name: '日本01',
        scheme: 'http',
        host: '127.0.0.1',
        port: 7901,
        sourceLabel: 'Clash Verge',
      });
  });

  it('socks listener 用 socks5，否则 Chrome 会对它发 HTTP CONNECT', () => {
    expect(listenerExitToPoolEntry({ listenerName: 'hub-7901', nodeName: '日本01', port: 7901, listenerType: 'socks' }))
      .toEqual({
        name: '日本01',
        scheme: 'socks5',
        host: '127.0.0.1',
        port: 7901,
        sourceLabel: 'Clash Verge',
      });
  });

  it('type 缺失时按 http 处理（内核对缺省 type 就是 http/mixed）', () => {
    expect(listenerExitToPoolEntry({ listenerName: 'hub-7901', nodeName: '日本01', port: 7901, listenerType: '' }))
      .toEqual(expect.objectContaining({ scheme: 'http' }));
  });
});


describe('buildListenerPlan · 名字锁定端口', () => {
  it('同一份映射：乱序输入不改变端口分配，老节点保留老端口', () => {
    const first = buildListenerPlan(['日本01', '香港A10', '美国03']);
    // 完全乱序再来一次(真实场景：订阅更新后顺序变化)
    const second = buildListenerPlan(['美国03', '日本01', '香港A10'], 7901, [], first.entries);
    // 输出按端口排序 → 乱序输入得到完全一致的 entries
    expect(second.entries).toEqual(first.entries);
    expect(second.yaml).toBe(first.yaml);
    expect(second.script).toBe(first.script);
  });

  it('新节点拿 ≥ 起点的最小空闲端口，被删节点的端口保留为空洞不复用', () => {
    const first = buildListenerPlan(['A', 'B', 'C']);
    // B 被机场删掉,只来 A 和 D
    const next = buildListenerPlan(['A', 'D'], 7901, [], first.entries);
    const aPort = first.entries.find((e) => e.nodeName === 'A')!.port;
    const dPort = next.entries.find((e) => e.nodeName === 'D')!.port;
    expect(next.entries.find((e) => e.nodeName === 'A')!.port).toBe(aPort);
    // D 拿 7904(7901 归 A;B 被删后 7902 空洞永不复用;7903 也不给 D —— 先到先得)
    expect(dPort).toBe(7904);
  });

  it('保护区端口永不分配：7897/9090 被跳过', () => {
    // 直接让起点落在保护区前一位,验证 nextFreePort 的跳过行为
    const plan = buildListenerPlan(['X', 'Y'], 7896);
    expect(plan.entries.map((e) => e.port)).toEqual([7896, 7900]);
  });

  it('内置保护区常量包含 7897-7899、1053 与 9090-9099', () => {
    expect(RESERVED_PORTS).toContain(7897);
    expect(RESERVED_PORTS).toContain(7898);
    expect(RESERVED_PORTS).toContain(7899);
    expect(RESERVED_PORTS).toContain(1053);
    expect(RESERVED_PORTS).toContain(9090);
    expect(RESERVED_PORTS).toContain(9099);
  });
});

describe('diffListenerPlan', () => {
  it('kept/added/removed 三分类', () => {
    const plan = buildListenerPlan(['A', 'B', 'C']);
    const drift = diffListenerPlan(['A', 'C', 'NEW'], plan.entries);
    expect(drift.kept.map((e) => e.nodeName).sort()).toEqual(['A', 'C']);
    expect(drift.addedNames).toEqual(['NEW']);
    expect(drift.removed.map((e) => e.nodeName)).toEqual(['B']);
});
});
