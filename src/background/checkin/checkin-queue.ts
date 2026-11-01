import { session } from '@/lib/core/storage';

export const QUEUE_KEY = 'checkinQueue';

export interface ActiveCheckin {
  accountId: string;
  tabId: number;
  startedAt: number;
  /**
   * 还在「拿到标签页之前」的启动窗口里（此时 tabId 为 0）。
   *
   * 队列先把 active 落盘、再去建标签页/申请代理租约，最后才由 bindTab 回填
   * 真实 tabId。这段时间里 Service Worker 完全可能被看门狗闹钟或冷启动唤醒，
   * 而 isAlive 对 tabId<=0 一律返回 false —— 没有这个标记，刚启动的任务会被
   * 当成「浏览器后台重启」判失败，紧接着代理租约恢复还会把刚设好的全局代理
   * 清掉：任务改走直连，日志里却写着「已启用扩展代理」。
   */
  launching?: boolean;
}

export interface QueueState {
  pendingAccountIds: string[];
  active?: ActiveCheckin;
}

export interface QueueLaunchResult {
  ok: boolean;
  tabId?: number;
  /** 不开标签页就已完成的后台结果 */
  completedResult?: import('@/types').TaskResult;
  error?: string;
}

export interface CheckinQueue {
  enqueue(accountIds: string[]): Promise<{ queued: number; skipped: number }>;
  finish(tabId: number): Promise<void>;
  cancel(accountIds: string[]): Promise<number>;
  recover(): Promise<void>;
  /** 将活动任务从 OAuth 发起页移交给新开的授权标签页。 */
  rebindActiveTab(fromTabId: number, toTabId: number): Promise<boolean>;
  /** 是否有任务正处在「还没拿到标签页」的启动窗口里。 */
  launchInFlight(): Promise<boolean>;
  /** 将活动任务从 OAuth 发起页移交给新开的授权标签页。 */
  rebindActiveTab(fromTabId: number, toTabId: number): Promise<boolean>;
  active(): Promise<ActiveCheckin | undefined>;
  /**
   * 一次读出的完整队列快照（active + pending）。
   *
   * 关页判定必须同时看两边：分两次读会在中间撞上 drain「把 pending 提升为
   * active」的临界区，那个账号从两边都查不到，站点就会被误判成跑完了。
   */
  snapshot(): Promise<QueueState>;
  busy(): Promise<boolean>;
}

interface QueueDependencies {
  launch(accountId: string, bindTab: (tabId: number) => Promise<void>): Promise<QueueLaunchResult>;
  /** headless 已完成时落库并广播，队列继续下一个账号 */
  complete?(accountId: string, result: import('@/types').TaskResult): Promise<void>;
  fail(accountId: string, message: string): Promise<void>;
  isAlive(active: ActiveCheckin): Promise<boolean>;
  abandon(active: ActiveCheckin): Promise<void>;
  changed(): void;
}

const emptyState = (): QueueState => ({ pendingAccountIds: [] });

/**
 * 启动窗口的最长容忍时间。
 *
 * 真的在建标签页就放过它；卡死超过这个时长仍按死任务处理，队列不会永久堵住
 * （看门狗的 expireStaleTask 用的上限比它大得多，这里只负责不误杀）。
 */
const LAUNCH_GRACE_MS = 60_000;

function isLaunchInFlight(active: ActiveCheckin): boolean {
  return active.tabId <= 0
    && active.launching === true
    && Date.now() - active.startedAt < LAUNCH_GRACE_MS;
}

/**
 * Serial background queue for check-in jobs.
 *
 * State lives in storage.session so closing the options page or side panel does
 * not stop a batch. Only one tab is active at a time, which also makes global
 * proxy ownership deterministic.
 */
export function createCheckinQueue(deps: QueueDependencies): CheckinQueue {
  let lock: Promise<void> = Promise.resolve();
  let draining: Promise<void> | null = null;
  let drainRequested = false;

  function locked<T>(work: () => Promise<T>): Promise<T> {
    const result = lock.then(work, work);
    lock = result.then(() => undefined, () => undefined);
    return result;
  }

  async function read(): Promise<QueueState> {
    return session.get<QueueState>(QUEUE_KEY, emptyState());
  }

  async function write(state: QueueState): Promise<void> {
    await session.set(QUEUE_KEY, state);
  }

  function requestDrain(): Promise<void> {
    drainRequested = true;
    if (!draining) {
      draining = (async () => {
        while (drainRequested) {
          drainRequested = false;
          await drain();
        }
      })().finally(() => {
        draining = null;
        if (drainRequested) void requestDrain();
      });
    }
    return draining;
  }

  async function drain(): Promise<void> {
    while (true) {
      const accountId = await locked(async () => {
        const state = await read();
        if (state.active || state.pendingAccountIds.length === 0) return null;

        const next = state.pendingAccountIds.shift()!;
        state.active = { accountId: next, tabId: 0, startedAt: Date.now(), launching: true };
        await write(state);
        return next;
      });

      if (!accountId) return;

      const bindTab = (tabId: number) => locked(async () => {
        const state = await read();
        if (state.active?.accountId !== accountId) {
          throw new Error('签到任务已被取消');
        }
        state.active = { accountId, tabId, startedAt: Date.now() };
        await write(state);
      });
      const launched: QueueLaunchResult = await deps.launch(accountId, bindTab).catch((error): QueueLaunchResult => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));

      if (launched.ok && launched.completedResult) {
        const completedResult = launched.completedResult;
        // headless API 直连已完成，不占用 active tab。“仍持有 active”
        // 的判定、移除占用和结果落库必须在同一个队列临界区内：
        // cancel 若已经抢先撤销了 active，这个迟到结果就不得再写回账号。
        const settled = await locked(async () => {
          const state = await read();
          if (state.active?.accountId !== accountId) return { kind: 'stolen' as const };
          delete state.active;
          await write(state);
          try {
            await deps.complete?.(accountId, completedResult);
            return { kind: 'done' as const };
          } catch (error) {
            // 落库失败时占用已在上面释放：不再恢复 active 死等 10 分钟超时
            // 看门狗，否则这一个写库异常会连累后面所有 pending 账号空等。
            // 比照 launch 失败的收尾把本账号判负、让 drain 立即放行队列，
            // 异常信息一并带出临界区，避免既丢结果又静默跳过下一账号。
            return { kind: 'failed' as const, message: error instanceof Error ? error.message : String(error) };
          }
        });
        if (settled.kind === 'stolen') return;
        if (settled.kind === 'failed') {
          await deps.fail(accountId, `签到结果落库失败：${settled.message}`);
          deps.changed();
        }
        continue;
      }

      if (launched.ok && launched.tabId != null) {
        const accepted = await locked(async () => {
          const state = await read();
          if (state.active?.accountId !== accountId) return false;
          state.active = { accountId, tabId: launched.tabId!, startedAt: Date.now() };
          await write(state);
          return true;
        });
        if (!accepted) {
          await deps.abandon({ accountId, tabId: launched.tabId, startedAt: Date.now() });
          return;
        }
        deps.changed();
        return;
      }

      const stillOwned = await locked(async () => {
        const state = await read();
        if (state.active?.accountId !== accountId) return false;
        delete state.active;
        await write(state);
        return true;
      });
      if (stillOwned) {
        await deps.fail(accountId, launched.error || '无法启动签到任务');
        deps.changed();
      } else {
        return;
      }
    }
  }

  return {
    async enqueue(accountIds) {
      const result = await locked(async () => {
        const state = await read();
        const existing = new Set(state.pendingAccountIds);
        if (state.active) existing.add(state.active.accountId);

        let queued = 0;
        for (const accountId of accountIds) {
          if (!accountId || existing.has(accountId)) continue;
          existing.add(accountId);
          state.pendingAccountIds.push(accountId);
          queued += 1;
        }
        await write(state);
        return { queued, skipped: accountIds.length - queued };
      });

      deps.changed();
      void requestDrain();
      return result;
    },

    async finish(tabId) {
      const didFinish = await locked(async () => {
        const state = await read();
        if (!state.active || state.active.tabId !== tabId) return false;
        delete state.active;
        await write(state);
        return true;
      });
      if (!didFinish) return;
      deps.changed();
      void requestDrain();
    },

    async cancel(accountIds) {
      const targets = new Set(accountIds);
      if (targets.size === 0) return 0;
      const inFlightDrain = draining;

      const { active, removed } = await locked(async () => {
        const state = await read();
        const before = state.pendingAccountIds.length;
        state.pendingAccountIds = state.pendingAccountIds.filter((accountId) => !targets.has(accountId));
        const pendingRemoved = before - state.pendingAccountIds.length;
        const active = state.active && targets.has(state.active.accountId) ? state.active : undefined;
        if (active) delete state.active;
        await write(state);
        return { active, removed: pendingRemoved + (active ? 1 : 0) };
      });

      if (active) await deps.abandon(active);
      if (removed) {
        deps.changed();
      }
      // 只有取消了正在 launch 的目标才需要等旧 drain 退出；单纯移除
      // pending 不应被一个无关账号的耗时 headless 请求拖住。
      if (active && inFlightDrain) await inFlightDrain.catch(() => {});
      if (removed) void requestDrain();
      return removed;
    },

    async recover() {
      const current = await read();
      if (current.active && !isLaunchInFlight(current.active) && !(await deps.isAlive(current.active))) {
        const abandoned = current.active;
        await deps.abandon(abandoned);

        // `abandon` may recover a cross-window OAuth task by rebinding the
        // active tab to a still-live popup. Do not delete that newly rebound
        // entry or report a false background-restart failure.
        const afterAbandon = await read();
        if (
          afterAbandon.active
          && afterAbandon.active.accountId === abandoned.accountId
          && afterAbandon.active.tabId !== abandoned.tabId
        ) {
          deps.changed();
          return;
        }

        await locked(async () => {
          const state = await read();
          if (state.active?.accountId === abandoned.accountId) delete state.active;
          await write(state);
        });
        await deps.fail(abandoned.accountId, '浏览器后台重启，原签到页面已失效');
      }
      deps.changed();
      await requestDrain();
    },

    async rebindActiveTab(fromTabId, toTabId) {
      return locked(async () => {
        const state = await read();
        if (!state.active || state.active.tabId !== fromTabId) return false;
        state.active = { ...state.active, tabId: toTabId, startedAt: Date.now() };
        await write(state);
        deps.changed();
        return true;
      });
    },

    async active() {
      return (await read()).active;
    },

    async snapshot() {
      return read();
    },

    async launchInFlight() {
      const current = await read();
      return current.active ? isLaunchInFlight(current.active) : false;
    },

    async busy() {
      const state = await read();
      return !!state.active || state.pendingAccountIds.length > 0;
    },
  };
}
