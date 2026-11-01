import type { LoginTask, TaskStage } from '@/types';
import type { LiveTask } from '@/lib/messages/live';

const TASK_PREFIX = 'task:';

/**
 * 把 storage.session 的全部条目投影成界面可读的实时进度。
 *
 * 纯函数（不碰 chrome API），方便单测：只挑任务信箱键、只保留安全字段、
 * 按创建时间排序。
 */
export function collectLiveTasks(entries: Record<string, unknown>): LiveTask[] {
  const live: LiveTask[] = [];
  for (const [key, value] of Object.entries(entries)) {
    if (!key.startsWith(TASK_PREFIX)) continue;
    if (!value || typeof value !== 'object') continue;
    const task = value as Partial<LoginTask>;
    if (!task.runId || !task.accountId) continue;
    live.push({
      accountId: task.accountId,
      siteId: task.siteId ?? '',
      tabId: typeof task.tabId === 'number' ? task.tabId : 0,
      runId: task.runId,
      stage: (task.stage ?? 'login') as TaskStage,
      method: task.effectiveCheckinMethod ?? task.site?.checkin?.method,
      steps: Array.isArray(task.steps) ? task.steps.map((s) => String(s)) : [],
      startedAt: typeof task.createdAt === 'number' ? task.createdAt : Date.now(),
    });
  }
  return live.sort((a, b) => a.startedAt - b.startedAt);
}
