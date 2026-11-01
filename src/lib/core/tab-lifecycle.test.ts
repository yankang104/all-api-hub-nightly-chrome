import { describe, expect, it, vi } from 'vitest';
import { removeTabUnlessLast, type TabRemovalDeps } from '@/lib/core/tab-lifecycle';

/**
 * 「关标签页」这道闸门锁的是用户报过的真实故障：签到跑完，扩展把任务页关掉，
 * 而那个页面恰好是窗口里唯一的一个 —— Chrome 连窗口一起关，只剩一个窗口时
 * 浏览器直接退出，用户「还有下一个站点要签」就做不成了。
 */
function deps(overrides: Partial<TabRemovalDeps> = {}): TabRemovalDeps {
  return {
    get: vi.fn().mockResolvedValue({ windowId: 1 }),
    queryWindow: vi.fn().mockResolvedValue([{ id: 7 }, { id: 8 }]),
    remove: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('removeTabUnlessLast', () => {
  it('窗口里还有别的标签页：正常关闭', async () => {
    const d = deps();
    await expect(removeTabUnlessLast(7, d)).resolves.toBe('removed');
    expect(d.remove).toHaveBeenCalledWith(7);
  });

  it('它是窗口里最后一个标签页：不关，保住窗口和浏览器', async () => {
    const d = deps({ queryWindow: vi.fn().mockResolvedValue([{ id: 7 }]) });
    await expect(removeTabUnlessLast(7, d)).resolves.toBe('kept');
    expect(d.remove).not.toHaveBeenCalled();
  });

  it('标签页本来就不在了：报告 gone，也不去点删除', async () => {
    const d = deps({ get: vi.fn().mockResolvedValue(undefined) });
    await expect(removeTabUnlessLast(7, d)).resolves.toBe('gone');
    expect(d.remove).not.toHaveBeenCalled();
  });

  it('读不到 windowId 时保守不关 —— 宁可留一页，也不赌用户的浏览器', async () => {
    const d = deps({ get: vi.fn().mockResolvedValue({}) });
    await expect(removeTabUnlessLast(7, d)).resolves.toBe('kept');
    expect(d.remove).not.toHaveBeenCalled();
  });

  it('非法 tabId 直接当已消失，不调用任何浏览器 API', async () => {
    const d = deps();
    await expect(removeTabUnlessLast(0, d)).resolves.toBe('gone');
    await expect(removeTabUnlessLast(-1, d)).resolves.toBe('gone');
    expect(d.get).not.toHaveBeenCalled();
    expect(d.remove).not.toHaveBeenCalled();
  });
});
