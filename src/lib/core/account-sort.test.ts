import { describe, expect, it } from 'vitest';
import type { Account } from '@/types';
import { normalizeAccountSortMode, sortAccounts, sortAccountsByDisplayName } from './account-sort';

const account = (id: string, username: string, label?: string): Account => ({
  id, username, label, siteId: 'site-1', password: '',
});

describe('账号显示名排序', () => {
  it('优先使用备注，没有备注或备注为空时使用用户名', () => {
    const accounts = [
      account('charlie', 'aaa@example.com', 'Charlie'),
      account('bob', 'bob@example.com', ''),
      account('alice', 'alice@example.com'),
      account('aaron', 'zzz@example.com', 'Aaron'),
    ];

    expect(sortAccountsByDisplayName(accounts).map((item) => item.id))
      .toEqual(['aaron', 'alice', 'bob', 'charlie']);
  });

  it('忽略大小写，并按名称中的数字自然排序', () => {
    const accounts = [
      account('z', 'Zebra'),
      account('a10', 'Alpha10'),
      account('b', 'beta'),
      account('a2', 'alpha2'),
      account('a1', 'ALPHA1'),
    ];

    expect(sortAccountsByDisplayName(accounts).map((item) => item.id))
      .toEqual(['a1', 'a2', 'a10', 'b', 'z']);
  });

  it('中文备注按拼音顺序排列', () => {
    const accounts = [
      account('zhang', 'a@example.com', '张三'),
      account('wang', 'b@example.com', '王五'),
      account('li', 'c@example.com', '李四'),
    ];

    expect(sortAccountsByDisplayName(accounts).map((item) => item.id))
      .toEqual(['li', 'wang', 'zhang']);
  });

  it('同名账号保留原顺序，排序不会修改输入数组或账号对象', () => {
    const z = Object.freeze(account('z', 'zebra'));
    const first = Object.freeze(account('first', 'z@example.com', 'Alice'));
    const second = Object.freeze(account('second', 'a@example.com', 'alice'));
    const accounts = Object.freeze([z, first, second]);

    const sorted = sortAccountsByDisplayName(accounts);

    expect(sorted.map((item) => item.id)).toEqual(['first', 'second', 'z']);
    expect(accounts.map((item) => item.id)).toEqual(['z', 'first', 'second']);
    expect(sorted[0]).toBe(first);
    expect(sorted[1]).toBe(second);
    expect(sorted[2]).toBe(z);
  });

  it('降序仍按账号名称和自然数字排序，同名账号保持原顺序', () => {
    const accounts = [
      account('first', 'a@example.com', 'Alpha2'),
      account('z', 'Zebra'),
      account('second', 'b@example.com', 'alpha2'),
      account('a10', 'Alpha10'),
    ];

    expect(sortAccounts(accounts, 'name-desc').map((item) => item.id))
      .toEqual(['z', 'a10', 'first', 'second']);
  });

  it('添加顺序直接采用存储顺序，切换名称排序不影响恢复', () => {
    const accounts = Object.freeze([account('z', 'Zebra'), account('a', 'Alpha')]);
    expect(sortAccounts(accounts).map((item) => item.id)).toEqual(['a', 'z']);
    const added = sortAccounts(accounts, 'added');
    expect(added.map((item) => item.id)).toEqual(['z', 'a']);
    expect(added).not.toBe(accounts);
  });

  it('缺失或无效的排序偏好回落到名称 A→Z', () => {
    for (const value of [undefined, null, '', 'invalid', 2, { mode: 'name-desc' }]) {
      expect(normalizeAccountSortMode(value)).toBe('name-asc');
    }
    expect(normalizeAccountSortMode('name-asc')).toBe('name-asc');
    expect(normalizeAccountSortMode('name-desc')).toBe('name-desc');
    expect(normalizeAccountSortMode('added')).toBe('added');
  });
});
