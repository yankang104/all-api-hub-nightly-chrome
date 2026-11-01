import { beforeEach, describe, expect, it, vi } from 'vitest';

const { store } = vi.hoisted(() => ({ store: new Map<string, unknown>() }));

vi.mock('@/lib/core/storage', () => ({
  session: {
    async get<T>(key: string, fallback: T): Promise<T> {
      return (store.has(key) ? structuredClone(store.get(key)) : fallback) as T;
    },
    async set(key: string, value: unknown): Promise<void> {
      store.set(key, structuredClone(value));
    },
    async remove(key: string): Promise<void> {
      store.delete(key);
    },
  },
}));

import { keepSiteTab, takeKeptSiteTabs } from '@/background/checkin/site-kept-tabs';

describe('站点未跑完时留下的任务页登记', () => {
  beforeEach(() => {
    store.clear();
  });

  it('登记后取走：返回全部标签页并清空，第二次取走为空', async () => {
    await keepSiteTab('s1', 11);
    await keepSiteTab('s1', 12);

    expect(await takeKeptSiteTabs('s1')).toEqual([11, 12]);
    expect(await takeKeptSiteTabs('s1')).toEqual([]);
  });

  it('同一页重复登记不会写两份', async () => {
    await keepSiteTab('s1', 11);
    await keepSiteTab('s1', 11);

    expect(await takeKeptSiteTabs('s1')).toEqual([11]);
  });

  it('不同站点互不干扰', async () => {
    await keepSiteTab('s1', 11);
    await keepSiteTab('s2', 21);

    expect(await takeKeptSiteTabs('s2')).toEqual([21]);
    expect(await takeKeptSiteTabs('s1')).toEqual([11]);
  });

  it('非法站点或标签页 ID 直接忽略，不写记录', async () => {
    await keepSiteTab('', 11);
    await keepSiteTab('s1', 0);
    await keepSiteTab('s1', -3);

    expect(await takeKeptSiteTabs('s1')).toEqual([]);
    expect(store.size).toBe(0);
  });

  it('取走后登记键被删除，不留下空数组', async () => {
    await keepSiteTab('s1', 11);
    await takeKeptSiteTabs('s1');

    expect(store.has('keptSiteTabs:s1')).toBe(false);
  });
});