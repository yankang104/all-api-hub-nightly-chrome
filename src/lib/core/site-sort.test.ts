import { describe, expect, it } from 'vitest';
import type { SiteConfig } from '@/types';
import { moveSiteIdInOrder, normalizeSiteSortMode, sortSites } from './site-sort';

const site = (id: string, name: string, sortOrder = 0): SiteConfig => ({
  id, name, sortOrder, loginUrl: `https://${id}.example.invalid/login`,
  selectors: { username: '#user', password: '#pass', submit: '#submit' },
  closeModalSelectors: [],
});

describe('站点显示排序', () => {
  it('名称升降序忽略手动权重、大小写和首尾空白，数字自然排序', () => {
    const sites = [site('z', 'Zulu', 0), site('a10', 'Alpha10', 1), site('a2', ' alpha2 ', 2)];
    expect(sortSites(sites).map((item) => item.id)).toEqual(['a2', 'a10', 'z']);
    expect(sortSites(sites, 'name-desc').map((item) => item.id)).toEqual(['z', 'a10', 'a2']);
  });

  it('中文数字按拼音与英文字母混排，只有阿拉伯数字按数值排', () => {
    const names = ['一梦五千年', 'Zulu', '10号站', '贰号站', 'Alpha', '壹号站', '2号站', '二号站', '1号站', '三号站', '十号站'];
    const sites = names.map((name, index) => site(`mixed-${index}`, name, index));
    expect(sortSites(sites).map((item) => item.name)).toEqual([
      '1号站', '2号站', '10号站', 'Alpha', '贰号站', '二号站', '三号站', '十号站', '壹号站', '一梦五千年', 'Zulu',
    ]);
  });

  it('中文站点按拼音排序', () => {
    const sites = [site('zhang', '张三'), site('wang', '王五'), site('li', '李四')];
    expect(sortSites(sites).map((item) => item.id)).toEqual(['li', 'wang', 'zhang']);
  });

  it('同名保持原顺序，不修改站点对象或存储的手动顺序', () => {
    const sites = Object.freeze([
      Object.freeze(site('z', 'Zulu', 0)),
      Object.freeze(site('first', 'Alpha', 1)),
      Object.freeze(site('second', 'alpha', 2)),
    ]);
    expect(sortSites(sites).map((item) => item.id)).toEqual(['first', 'second', 'z']);
    expect(sortSites(sites, 'name-desc').map((item) => item.id)).toEqual(['z', 'first', 'second']);
    const manual = sortSites(sites, 'manual');
    expect(manual).toEqual(sites);
    expect(manual).not.toBe(sites);
    expect(manual[0]).toBe(sites[0]);
    expect(sites.map((item) => item.sortOrder)).toEqual([0, 1, 2]);
  });

  it('缺失、账号专属模式和无效偏好回落 A→Z；空列表可排序', () => {
    for (const value of [undefined, null, '', 'added', 'invalid', 2, { mode: 'manual' }]) {
      expect(normalizeSiteSortMode(value)).toBe('name-asc');
    }
    for (const mode of ['name-asc', 'name-desc', 'manual'] as const) {
      expect(normalizeSiteSortMode(mode)).toBe(mode);
      expect(sortSites([], mode)).toEqual([]);
    }
  });
});

describe('站点顺序手动微调', () => {
  const order = ['a', 'b', 'c', 'd'];

  it('相邻上下移动，返回新数组且不修改入参', () => {
    expect(moveSiteIdInOrder(order, 'b', 'up')).toEqual(['b', 'a', 'c', 'd']);
    expect(moveSiteIdInOrder(order, 'b', 'down')).toEqual(['a', 'c', 'b', 'd']);
    expect(order).toEqual(['a', 'b', 'c', 'd']);
  });

  it('到顶、到底或找不到站点时保持原顺序', () => {
    expect(moveSiteIdInOrder(order, 'a', 'up')).toEqual(order);
    expect(moveSiteIdInOrder(order, 'd', 'down')).toEqual(order);
    expect(moveSiteIdInOrder(order, 'missing', 'down')).toEqual(order);
  });

  it('搜索过滤时跨过不可见站点，落到下一个可见邻居旁边', () => {
    const visible = new Set(['a', 'd']);
    expect(moveSiteIdInOrder(order, 'a', 'down', visible)).toEqual(['b', 'c', 'd', 'a']);
    expect(moveSiteIdInOrder(order, 'd', 'up', visible)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveSiteIdInOrder(order, 'a', 'up', visible)).toEqual(order);
  });

  it('可见集合与全量一致时等同于相邻移动', () => {
    const all = new Set(order);
    expect(moveSiteIdInOrder(order, 'c', 'up', all)).toEqual(['a', 'c', 'b', 'd']);
  });
});
