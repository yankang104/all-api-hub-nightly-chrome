import { describe, expect, it } from 'vitest';
import { STORAGE_LOCKS, withStorageWriteLock } from '@/lib/core/storage-lock';

describe('withStorageWriteLock', () => {
  it('把并发的读改写串行化，不丢更新', async () => {
    // 模拟存储：读和写之间插一个 await，制造经典的读改写竞态窗口
    let stored = 0;
    const readModifyWrite = async () => {
      const current = stored;
      await new Promise((resolve) => setTimeout(resolve, 1));
      stored = current + 1;
    };

    // 不加锁时这 5 次会互相覆盖，结果远小于 5
    await Promise.all(
      Array.from({ length: 5 }, () => withStorageWriteLock(STORAGE_LOCKS.APP_DATA, readModifyWrite)),
    );

    expect(stored).toBe(5);
  });

  it('不同锁名互不阻塞', async () => {
    const order: string[] = [];
    await Promise.all([
      withStorageWriteLock(STORAGE_LOCKS.APP_DATA, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push('app');
      }),
      withStorageWriteLock(STORAGE_LOCKS.BALANCE, async () => {
        order.push('balance');
      }),
    ]);

    // balance 不必等 app 的 5ms 结束
    expect(order).toEqual(['balance', 'app']);
  });

  it('抛错不会卡死后续任务', async () => {
    await expect(
      withStorageWriteLock(STORAGE_LOCKS.APP_DATA, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // 前一个失败后，队列必须继续可用
    const result = await withStorageWriteLock(STORAGE_LOCKS.APP_DATA, async () => 'ok');
    expect(result).toBe('ok');
  });
});
