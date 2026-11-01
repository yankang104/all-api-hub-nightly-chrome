/** 学习事件的读改写必须串行；不能与等待页面 flush 的网络锁共用，否则会死锁。 */
export function createLearningWriteQueue() {
  let pending: Promise<unknown> = Promise.resolve();
  return {
    run<T>(work: () => Promise<T>): Promise<T> {
      const result = pending.then(work, work);
      pending = result.catch(() => undefined);
      return result;
    },
  };
}
