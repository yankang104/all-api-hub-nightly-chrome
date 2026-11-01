/**
 * 实时进度查询的消息域。
 *
 * 任务信箱（storage.session 的 task:* 键）只存在于 background 与 content
 * script 之间，管理页读不到。界面要显示「正在签到中」的具体阶段和步骤，
 * 就得由 background 投影一份只读快照回来。
 */

import type { CheckinMethod, TaskStage } from '@/types';

/** 界面只读的实时进度。刻意不包含 password / token / session 等敏感字段。 */
export interface LiveTask {
  accountId: string;
  siteId: string;
  tabId: number;
  runId: string;
  stage: TaskStage;
  /**
   * 本次实际执行的方式（账号级覆盖 ?? 站点默认）。
   * 界面据此决定说「签到」还是「领取权益」—— 缺了它领取站会被显示成签到。
   */
  method?: CheckinMethod;
  /** 任务信箱里逐步累积的安全执行日志 */
  steps: string[];
  /** 任务创建时间（毫秒），用于估算已运行时长 */
  startedAt: number;
}

/** 批量队列的快照：谁在排队、谁正在跑。 */
export interface LiveQueue {
  /** 正在执行的账号（队列串行，同时最多一个） */
  active?: { accountId: string; tabId: number; startedAt: number };
  /** 排队中的账号 id（按入队顺序） */
  pending: string[];
}

export type LiveMessage =
  /** 管理页 → background：拉取当前所有正在签到的账号实时进度 */
  | { type: 'GET_LIVE_TASKS' }
  /** content → background：逐步同步安全执行日志，不改变当前任务阶段 */
  | { type: 'SYNC_PROGRESS'; runId: string; steps: string[] };

export interface LiveResponse {
  live?: LiveTask[];
  queue?: LiveQueue;
}
