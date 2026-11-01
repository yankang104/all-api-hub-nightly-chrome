import { describe, expect, it } from 'vitest';
import { normalizeSubscriptionUrl, planListenerDrift } from './listener-auto';
import { buildListenerPlan } from '@/lib/clash/clash-listeners';

/** 构造一份最小可解析的 Clash 订阅（节点全是浏览器用不了的协议） */
function subscription(...names: string[]): string {
  const lines = ['proxies:'];
  for (const [index, name] of names.entries()) {
    lines.push(`  - { name: ${name}, server: n${index}.example.com, port: 8443, type: hysteria2, password: x }`);
  }
  return lines.join('\n');
}

describe('normalizeSubscriptionUrl', () => {
  it('只放行公网 http(s)', () => {
    expect(normalizeSubscriptionUrl('https://example.com/sub?token=1')).toBe('https://example.com/sub?token=1');
    // SSRF 闸门:本机/内网/云元数据/非 http 一律拒绝
    expect(normalizeSubscriptionUrl('http://127.0.0.1:8080/x')).toBeNull();
    expect(normalizeSubscriptionUrl('http://localhost/x')).toBeNull();
    expect(normalizeSubscriptionUrl('http://192.168.1.1/x')).toBeNull();
    expect(normalizeSubscriptionUrl('http://169.254.169.254/latest')).toBeNull();
    expect(normalizeSubscriptionUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeSubscriptionUrl('')).toBeNull();
  });
});

describe('planListenerDrift', () => {
  it('订阅无变化时:不新增池条目、端口保持', () => {
    const text = subscription('日本01', '香港01');
    const seeded = buildListenerPlan(['日本01', '香港01']).entries;
    const drift = planListenerDrift(text, seeded);
    expect(drift.addedEntries).toEqual([]);
    expect(drift.poolEntries).toEqual([]);
    expect(drift.entries).toEqual(seeded);
  });

  it('订阅新增节点时:只把新端口的池条目交出来,老端口不动', () => {
    const seeded = buildListenerPlan(['日本01', '香港01']).entries;
    const drift = planListenerDrift(subscription('日本01', '香港01', '美国09'), seeded);
    expect(drift.poolEntries.map((e) => e.name)).toEqual(['美国09']);
    // 新节点拿 7903(跳过已被占用的 7901/7902)
    expect(drift.poolEntries[0]!.port).toBe(7903);
    // 老节点的端口一字不变
    for (const old of seeded) {
      expect(drift.entries.find((e) => e.nodeName === old.nodeName)!.port).toBe(old.port);
    }
    // 映射里保留被删节点?此处无删除,长度应为 3
    expect(drift.entries).toHaveLength(3);
  });

  it('节点被删除时:端口作为空洞保留,不被新节点复用', () => {
    const seeded = buildListenerPlan(['日本01', '香港01', '美国09']).entries;
    // 香港01 消失,新增美国10
    const drift = planListenerDrift(subscription('日本01', '美国09', '美国10'), seeded);
    expect(drift.removedNames).toEqual(['香港01']);
    // 美国10 不能拿 7902(香港01 的空洞),必须往后排
    expect(drift.poolEntries.map((e) => e.name)).toEqual(['美国10']);
    expect(drift.poolEntries[0]!.port).not.toBe(7902);
  });
});

describe('历史映射里的公告行自愈', () => {
  it('已污染映射里的推广行被剔除,端口不再被它占着', () => {
    // 早期版本把公告行当节点分配了 7902
    const polluted = [
      { nodeName: '日本01', port: 7901, listenerName: 'hub-7901' },
      { nodeName: '电报群https://t.me/example', port: 7902, listenerName: 'hub-7902' },
    ];
    const drift = planListenerDrift(subscription('日本01', '美国09'), polluted);
    // 公告行被清掉,新节点可以拿到 7902
    expect(drift.entries.map((e) => e.nodeName)).toEqual(['日本01', '美国09']);
    expect(drift.entries.find((e) => e.nodeName === '美国09')!.port).toBe(7902);
    expect(drift.poolEntries.map((e) => e.name)).toEqual(['美国09']);
  });
});
