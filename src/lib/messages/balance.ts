/**
 * 余额相关的消息（阶段二、三使用）。
 *
 * 由余额任务独占。新增变体只改本文件，不动 lib/messaging.ts。
 */

import type { BalanceSnapshot } from '@/types';

export type BalanceMessage =
  /** content → background：上报页面内读到的额度快照 */
  | {
      type: 'BALANCE_SNAPSHOT';
      runId: string;
      snapshot: BalanceSnapshot;
      /**
       * 可能触发整页导航的动作前快照还要写进跨页任务上下文。
       * `button-before` 只允许已进入 button 签到阶段的任务发送。
       */
      phase?: 'current' | 'relogin-before' | 'button-before';
    }
  /** 管理页 → background：刷新指定账号的余额 */
  | { type: 'REFRESH_BALANCE'; accountIds: string[] }
  /**
   * content → background：签到已确认成功，把签到页正文交上来落盘今日奖励台账。
   *
   * 落进 `daily.checkinReward` 的那条路（`refreshOneBalance`）平时只由手动刷新触发，
   * 于是 workflow 签到成功后余额记录里那天一直是 $0.00，只有日志显示奖励。
   * 账号 ID 由 background 取自信箱（sender.tab.id → 任务），不从这里传。
   */
  | {
      type: 'CHECKIN_REWARD_OBSERVATION';
      runId: string;
      siteId: string;
      bodyText: string;
    };

export interface BalanceResponse {
  /** 刷新成功的账号数 */
  refreshed?: number;
  /** 刷新失败的账号数 */
  failed?: number;
}
