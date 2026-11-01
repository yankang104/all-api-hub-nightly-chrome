import { describe, expect, it } from 'vitest';
import { diagnoseListenerFailures, type ListenerProbe } from './listener-diagnosis';

/**
 * 「44 个端口一起失败」是最难自诊的场景:界面上全是一模一样的「连不上」,
 * 但原因可能是「脚本没粘」(处置:去粘脚本)或「订阅激活错了」(处置:去切订阅)。
 * 这组测试锁住的就是「能不能把这两者说清楚」。
 */
const entry = (port: number, probe: ListenerProbe, ok: boolean) => ({
  port,
  probe,
  test: { ok, message: ok ? '连通' : '失败' },
});

describe('diagnoseListenerFailures', () => {
  it('全部通过时给出 ok', () => {
    const d = diagnoseListenerFailures([entry(7901, 'listening', true), entry(7902, 'listening', true)]);
    expect(d.kind).toBe('ok');
    expect(d.passed).toBe(2);
    expect(d.total).toBe(2);
  });

  it('池里没有本机端口条目', () => {
    const d = diagnoseListenerFailures([]);
    expect(d.kind).toBe('no-local-ports');
    expect(d.total).toBe(0);
  });

  it('失败端口全都没人监听 → 指向「脚本没生效」', () => {
    const d = diagnoseListenerFailures([entry(7901, 'closed', false), entry(7902, 'closed', false)]);
    expect(d.kind).toBe('listener-missing');
    expect(d.title).toContain('没有一个在监听');
    // 提示必须给出可执行的下一步,而不是只说「失败」
    expect(d.hint).toContain('Script');
    expect(d.hint).toContain('重载');
  });

  it('失败端口都在监听 → 指向「订阅/节点名对不上」', () => {
    const d = diagnoseListenerFailures([entry(7901, 'listening', false), entry(7902, 'listening', false)]);
    expect(d.kind).toBe('node-mismatch');
    expect(d.title).toContain('在监听');
    expect(d.hint).toContain('订阅');
  });

  it('混合情况如实归类为 partial,不硬套单一结论', () => {
    const d = diagnoseListenerFailures([
      entry(7901, 'listening', false),
      entry(7902, 'closed', false),
      entry(7903, 'listening', true),
    ]);
    expect(d.kind).toBe('partial');
    expect(d.passed).toBe(1);
    expect(d.total).toBe(3);
  });

  it('有通过项时不会误报为「脚本没生效」', () => {
    // 5 个里通了 1 个:说明脚本生效了,只是部分节点有问题
    const d = diagnoseListenerFailures([
      entry(7901, 'listening', true),
      entry(7902, 'closed', false),
      entry(7903, 'closed', false),
    ]);
    expect(d.kind).toBe('partial');
  });
});
