import { describe, expect, it } from 'vitest';
import { assignProxies } from '@/lib/proxy/proxy-assign';
import type { Account } from '@/types';

type Target = Pick<Account, 'id' | 'proxyMode' | 'proxyId' | 'proxyPinned'>;

const acc = (id: string, over: Partial<Target> = {}): Target => ({ id, ...over });

describe('assignProxies', () => {
  it('账号与节点一样多时一对一绑定', () => {
    const result = assignProxies([acc('a1'), acc('a2'), acc('a3')], ['p1', 'p2', 'p3']);

    expect(result.assignments).toEqual([
      { accountId: 'a1', proxyId: 'p1' },
      { accountId: 'a2', proxyId: 'p2' },
      { accountId: 'a3', proxyId: 'p3' },
    ]);
    expect(result.unusedProxies).toBe(0);
  });

  it('节点少于账号时循环复用，把账号摊到所有出口上', () => {
    const result = assignProxies([acc('a1'), acc('a2'), acc('a3'), acc('a4'), acc('a5')], ['p1', 'p2']);

    expect(result.assignments.map((item) => item.proxyId)).toEqual(['p1', 'p2', 'p1', 'p2', 'p1']);
    expect(result.unusedProxies).toBe(0);
  });

  it('节点多于账号时余下节点不分配', () => {
    const result = assignProxies([acc('a1'), acc('a2')], ['p1', 'p2', 'p3', 'p4']);

    expect(result.assignments).toEqual([
      { accountId: 'a1', proxyId: 'p1' },
      { accountId: 'a2', proxyId: 'p2' },
    ]);
    expect(result.unusedProxies).toBe(2);
  });

  it('默认不覆盖用户已手配的账号', () => {
    const accounts = [
      acc('a1'),
      acc('a2', { proxyMode: 'custom' }),
      acc('a3', { proxyMode: 'pool', proxyId: 'px-existing', proxyPinned: true }),
      acc('a4', { proxyMode: 'none' }),
      acc('a5', { proxyMode: 'inherit' }),
    ];

    const result = assignProxies(accounts, ['p1', 'p2']);

    expect(result.assignments).toEqual([
      { accountId: 'a1', proxyId: 'p1' },
      { accountId: 'a5', proxyId: 'p2' },
    ]);
    expect(result.skipped).toBe(3);
  });

  /**
   * 上一轮自动填的绑定必须还能被重新分配：池子加了新节点后，
   * 若把它当成「用户手动配过」而跳过，新节点永远摊不下去。
   */
  it('上一轮自动分配的绑定可以被重新摊平', () => {
    const accounts = [
      acc('a1', { proxyMode: 'pool', proxyId: 'p1' }),
      acc('a2', { proxyMode: 'pool', proxyId: 'p1' }),
    ];

    const result = assignProxies(accounts, ['p1', 'p2']);

    expect(result.assignments).toEqual([
      { accountId: 'a1', proxyId: 'p1' },
      { accountId: 'a2', proxyId: 'p2' },
    ]);
    expect(result.skipped).toBe(0);
  });

  it('手动固定的绑定即使节点变多也不动', () => {
    const accounts = [
      acc('a1', { proxyMode: 'pool', proxyId: 'p9', proxyPinned: true }),
      acc('a2'),
    ];

    const result = assignProxies(accounts, ['p1', 'p2', 'p3']);

    expect(result.assignments).toEqual([{ accountId: 'a2', proxyId: 'p1' }]);
    expect(result.skipped).toBe(1);
  });

  it('pool 模式但没选节点属于坏配置，应被重新分配', () => {
    const result = assignProxies([acc('a1', { proxyMode: 'pool' })], ['p1']);

    expect(result.assignments).toEqual([{ accountId: 'a1', proxyId: 'p1' }]);
    expect(result.skipped).toBe(0);
  });

  it('all 模式覆盖全部账号，包括明确直连的', () => {
    const accounts = [
      acc('a1', { proxyMode: 'custom' }),
      acc('a2', { proxyMode: 'none' }),
      acc('a3', { proxyMode: 'pool', proxyId: 'px-old' }),
    ];

    const result = assignProxies(accounts, ['p1', 'p2', 'p3'], 'all');

    expect(result.assignments).toEqual([
      { accountId: 'a1', proxyId: 'p1' },
      { accountId: 'a2', proxyId: 'p2' },
      { accountId: 'a3', proxyId: 'p3' },
    ]);
    expect(result.skipped).toBe(0);
  });

  it('没有可用节点时不产生任何分配', () => {
    const result = assignProxies([acc('a1'), acc('a2')], []);

    expect(result).toEqual({ assignments: [], skipped: 0, unusedProxies: 0 });
  });
});
