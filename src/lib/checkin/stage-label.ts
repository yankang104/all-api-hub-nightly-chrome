import type { CheckinMethod, TaskStage } from '@/types';
import { stageLabelFor } from '@/lib/checkin/action-label';

/**
 * 任务阶段在管理页上的人类可读文案。
 *
 * @param method 本次实际执行的方式。claim 必须显示「正在领取权益」，不能统一叫签到。
 */
export function stageLabel(stage: TaskStage, method?: CheckinMethod): string {
  return stageLabelFor(stage, method);
}

/** 把毫秒时长格式化成人话：不足一分钟显示秒，否则分+秒。 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m <= 0) return `${s} 秒`;
  return `${m} 分 ${s} 秒`;
}