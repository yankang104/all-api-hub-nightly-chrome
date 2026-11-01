import { describe, expect, it } from 'vitest';
import { isTopFrame, isTopFrameSender } from '@/lib/core/frame-scope';

/**
 * 防止「开启 allFrames 后 iframe 重复执行签到」这条真实事故的不变量测试。
 *
 * 两侧守卫各测一半：
 * - 页面侧：`isTopFrame()` 决定 content script 是否允许进入 GET_TASK → runTask；
 * - 后台侧：`isTopFrameSender()` 决定 GET_TASK 是否允许下发 task。
 * 任何一侧退化成「总是 true」，都必须在这里失败。
 */
describe('frame-scope 顶层框架判定', () => {
  it('主文档（top === self）判为顶层框架', () => {
    const main = {} as Window;
    expect(isTopFrame({ top: main, self: main } as unknown as Window)).toBe(true);
  });

  it('同源/跨域 iframe（top !== self）都判为子框架', () => {
    const top = {} as Window;
    const child = {} as Window;
    expect(isTopFrame({ top, self: child } as unknown as Window)).toBe(false);
    // 跨域 iframe 里 window.top 是受限的 WindowProxy，但身份比较依然可用
    expect(isTopFrame({ top, self: { name: 'child' } } as unknown as Window)).toBe(false);
  });

  it('后台只用 frameId === 0 认定主框架，缺失或非 0 一律按子框架处理', () => {
    expect(isTopFrameSender(0)).toBe(true);
    expect(isTopFrameSender(1)).toBe(false);
    expect(isTopFrameSender(7)).toBe(false);
    expect(isTopFrameSender(undefined)).toBe(false);
  });
});