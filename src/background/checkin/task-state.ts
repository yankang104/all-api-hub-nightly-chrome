import type { BalanceSnapshot, LoginTask, TaskResult, TaskStage } from '@/types';
import { statusKey } from '@/lib/core/date';
import { TASK_KEY } from '@/lib/core/messaging';
import { session } from '@/lib/core/storage';
import { appRepository } from '@/data/app-repository';

let taskWriteQueue: Promise<void> = Promise.resolve();

function writeLocked<T>(work: () => Promise<T>): Promise<T> {
  const result = taskWriteQueue.then(work, work);
  taskWriteQueue = result.then(() => undefined, () => undefined);
  return result;
}

export const taskState = {
  get(tabId: number): Promise<LoginTask | null> {
    return session.get<LoginTask | null>(TASK_KEY(tabId), null);
  },

  /** 将跨窗口 OAuth 任务从旧标签页迁移到新标签页。 */
  async rebind(fromTabId: number, toTabId: number, runId: string): Promise<LoginTask | null> {
    return writeLocked(async () => {
      const task = await session.get<LoginTask | null>(TASK_KEY(fromTabId), null);
      if (!task || task.runId !== runId) return null;
      await session.set(TASK_KEY(toTabId), { ...task, tabId: toTabId });
      await session.remove(TASK_KEY(fromTabId));
      return { ...task, tabId: toTabId };
    });
  },

  put(tabId: number, task: LoginTask): Promise<void> {
    return writeLocked(() => session.set(TASK_KEY(tabId), task));
  },

  /** 在同一把任务锁内读取并更新，避免标签页关闭时把已删除的任务重新写回。 */
  update(tabId: number, updater: (task: LoginTask) => LoginTask): Promise<LoginTask | null> {
    return writeLocked(async () => {
      const task = await session.get<LoginTask | null>(TASK_KEY(tabId), null);
      if (!task) return null;
      const next = updater(task);
      if (next === task) return task;
      await session.set(TASK_KEY(tabId), next);
      return next;
    });
  },

  start(tabId: number, task: LoginTask): Promise<void> {
    return writeLocked(async () => {
      await session.set(TASK_KEY(tabId), task);
      await appRepository.setStatus(statusKey(task.accountId), 'running');
    });
  },

  remove(tabId: number): Promise<void> {
    return writeLocked(() => session.remove(TASK_KEY(tabId)));
  },

  take(tabId: number, runId?: string, accountId?: string): Promise<LoginTask | null> {
    return writeLocked(async () => {
      const task = await session.get<LoginTask | null>(TASK_KEY(tabId), null);
      if (!task || (runId && task.runId !== runId) || (accountId && task.accountId !== accountId)) {
        return null;
      }
      await session.remove(TASK_KEY(tabId));
      return task;
    });
  },

  updateStage(tabId: number, runId: string, stage: TaskStage, steps: string[]): Promise<LoginTask | null> {
    return writeLocked(async () => {
      const task = await session.get<LoginTask | null>(TASK_KEY(tabId), null);
      if (!task || task.runId !== runId) return null;
      const next: LoginTask = { ...task, stage, steps };
      // 登录恢复或切号会建立新会话，旧会话的身份确认不能跨认证沿用。
      if (stage === 'login' || stage === 'github-logout' || stage === 'relogin') {
        next.identityConfirmed = false;
        if (stage !== 'relogin') next.githubCredentialsSubmitted = false;
      }
      await session.set(TASK_KEY(tabId), next);

      // 只在任务还在进行时才写 running。
      //
      // 无条件写会覆盖已经落定的终态：签到成功后若页面又触发一次 stage
      // 更新（公告处理、SPA 路由变化都会），done 就被改回 running ——
      // 结果 results 里有成功记录，状态却永远停在「签到中」，
      // 界面上是转圈的进度条，用户以为卡住了。
      //
      // ⚠️ 这个判断必须和写入在同一把存储写锁里完成。此前是
      // getStatus() 后再 setStatus()，两步之间 complete() 落下的 done
      // 会被随后的 running 覆盖 —— 就是上面那串用户可见症状的真实来源。
      // setStatusUnlessTerminal 把 compare-and-set 下沉到仓库层。
      await appRepository.setStatusUnlessTerminal(statusKey(task.accountId), 'running');
      return next;
    });
  },

  updateProgress(tabId: number, runId: string, steps: string[]): Promise<LoginTask | null> {
    return writeLocked(async () => {
      const task = await session.get<LoginTask | null>(TASK_KEY(tabId), null);
      if (!task || task.runId !== runId) return null;

      // 只接受不短于当前快照的日志，防止较早的异步消息覆盖刚落地的新阶段。
      if (steps.length < (task.steps?.length ?? 0)) return task;
      const next = { ...task, steps };
      await session.set(TASK_KEY(tabId), next);
      return next;
    });
  },

  /** 在退出登录前保存余额；任务跨 OAuth/整页跳转后仍能读取这份基线。 */
  saveReloginBalanceBefore(
    tabId: number,
    runId: string,
    balanceBefore: BalanceSnapshot,
  ): Promise<LoginTask | null> {
    return writeLocked(async () => {
      const task = await session.get<LoginTask | null>(TASK_KEY(tabId), null);
      if (!task || task.runId !== runId) return null;
      const next: LoginTask = {
        ...task,
        context: { ...task.context, balanceBefore },
      };
      await session.set(TASK_KEY(tabId), next);
      return next;
    });
  },

  /**
   * 在普通 button 签到的真实点击前保存基线。
   *
   * 条件在写锁内重新核对，避免 background 读完任务后，SET_STAGE 或任务替换
   * 恰好插入并把过期快照写进另一阶段。多账号任务必须已经确认本轮身份。
   */
  saveButtonBalanceBefore(
    tabId: number,
    runId: string,
    balanceBefore: BalanceSnapshot,
  ): Promise<LoginTask | null> {
    return writeLocked(async () => {
      const task = await session.get<LoginTask | null>(TASK_KEY(tabId), null);
      const method = task?.effectiveCheckinMethod ?? task?.site.checkin?.method;
      if (
        !task
        || task.runId !== runId
        || task.stage !== 'checkin'
        || method !== 'button'
        || ((task.siteAccountCount ?? 0) > 1 && !task.identityConfirmed)
      ) {
        return null;
      }
      const next: LoginTask = {
        ...task,
        context: { ...task.context, balanceBefore, buttonCheckinPending: true },
      };
      await session.set(TASK_KEY(tabId), next);
      return next;
    });
  },

  /** 本轮任务亲自登录成功，跨页面记住身份已确认。 */
  confirmIdentity(tabId: number, runId: string): Promise<LoginTask | null> {
    return writeLocked(async () => {
      const task = await session.get<LoginTask | null>(TASK_KEY(tabId), null);
      if (!task || task.runId !== runId) return null;
      const next = { ...task, identityConfirmed: true };
      await session.set(TASK_KEY(tabId), next);
      return next;
    });
  },

  /** 记录 GitHub 官方登录页已精确核对字段，并实际派发可信点击提交本账号凭据。 */
  setGithubCredentialsSubmitted(
    tabId: number,
    runId: string,
    submitted: boolean,
  ): Promise<LoginTask | null> {
    return writeLocked(async () => {
      const task = await session.get<LoginTask | null>(TASK_KEY(tabId), null);
      if (!task || task.runId !== runId || task.effectiveLoginMethod !== 'github') return null;
      const next = { ...task, githubCredentialsSubmitted: submitted };
      await session.set(TASK_KEY(tabId), next);
      return next;
    });
  },

  /** 登录身份落盘后同步更新跨页任务，后续页面立即使用新 ID，而不是旧冲突数据。 */
  updateIdentity(
    tabId: number,
    runId: string,
    identity: { userId?: string; username?: string; email?: string },
  ): Promise<LoginTask | null> {
    return writeLocked(async () => {
      const task = await session.get<LoginTask | null>(TASK_KEY(tabId), null);
      if (!task || task.runId !== runId) return null;
      const otherUsers = { ...(task.siteAccountUserIds ?? {}) };
      if (identity.userId) delete otherUsers[identity.userId];
      const next: LoginTask = {
        ...task,
        ...(identity.userId ? { accountIdentityUserId: identity.userId } : {}),
        ...(identity.username ? { accountIdentityUsername: identity.username } : {}),
        ...(identity.email ? { accountIdentityEmail: identity.email } : {}),
        siteAccountUserIds: otherUsers,
        ...(identity.userId
          ? {
              site: {
                ...task.site,
                adapter: { ...task.site.adapter, userId: identity.userId },
              },
            }
          : {}),
      };
      await session.set(TASK_KEY(tabId), next);
      return next;
    });
  },

  /**
   * 把处于 attention 的任务恢复成 running，返回是否真的恢复了。
   *
   * 「读出来是 attention」和「写入 running」必须原子：调用方在锁外先读到
   * attention，两步之间任务可能刚好完成，无条件写入会把 done 覆盖回 running。
   * compare-and-set 下沉到仓库层的同一把存储写锁里。
   */
  resumeAttention(tabId: number, runId: string): Promise<boolean> {
    return writeLocked(async () => {
      const task = await session.get<LoginTask | null>(TASK_KEY(tabId), null);
      if (!task || task.runId !== runId) return false;
      return appRepository.setStatusIfExpected(statusKey(task.accountId), 'attention', 'running');
    });
  },

  markAttention(tabId: number, runId: string, message: string, steps: string[]): Promise<LoginTask | null> {
    return writeLocked(async () => {
      const task = await session.get<LoginTask | null>(TASK_KEY(tabId), null);
      if (!task || task.runId !== runId) return null;
      const next = { ...task, steps };
      await session.set(TASK_KEY(tabId), next);
      await appRepository.setStatusAndResult('attention', {
        accountId: task.accountId,
        ok: false,
        message,
        steps,
      });
      return next;
    });
  },

  async setStatus(accountId: string, value: string): Promise<void> {
    await appRepository.setStatus(statusKey(accountId), value);
  },

  /**
   * 用户手动标记这个账号今天已经签到了。
   *
   * 和 tab / runId 无关 —— 这是管理页发起的，账号此刻可能压根没有在跑的任务。
   * 状态和结果一起写（`setStatusAndResult`），否则上次失败的结果会留在
   * 界面上配着绿色「已签到」显示。
   */
  async markDone(accountId: string): Promise<void> {
    await appRepository.markDone(accountId);
  },

  /**
   * 把「签到中 / 需人工处理」清回待签到，已落定的状态不动。
   *
   * 停止任务和 watchdog 捞孤儿共用这一条，两处都必须是「仅当还没落定」——
   * 见 appRepository.clearInFlightStatus 里的原因。
   */
  async clearInFlight(accountId: string): Promise<boolean> {
    return appRepository.clearInFlightStatus(statusKey(accountId));
  },

  async statusOf(accountId: string): Promise<string | undefined> {
    return appRepository.getStatus(statusKey(accountId));
  },

  /**
   * 落定成功的终态。
   *
   * 必须走 taskState 自己的写队列：updateStage 也在同一把锁里改状态，
   * 两边互斥后，「先读后写」的 stage 更新才不会把刚落定的 done 覆盖回
   * running。仓库层另有终态保护兜底，即使中途页面仍上报 stage 也不会翻车。
   */
  complete(result: TaskResult): Promise<void> {
    return writeLocked(() => appRepository.setOutcome(result));
  },

  fail(accountId: string, message: string, steps: string[] = []): Promise<void> {
    return writeLocked(() => appRepository.setOutcome({ accountId, ok: false, message, steps }));
  },
};
