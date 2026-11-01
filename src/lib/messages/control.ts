/**
 * 任务控制的消息域：停止正在执行的签到。
 *
 * 为什么必须有这条：队列把「正在跑」的账号记在 storage.session 里，
 * enqueue 会跳过已在队列中的账号。于是任务一旦卡住（站点卡在验证页、
 * 标签页假死、OAuth 弹窗没回调），界面上那行就永远停在「签到中」——
 * 执行按钮不出现，改状态也没用（队列还占着这个账号，再点执行会被静默
 * 跳过），只能等 10 分钟的后台超时或跨天。用户看到的就是「一直在执行、
 * 不支持重试」。
 *
 * 停止走这条消息而不是 set-status：状态只是台账，真正要清的是队列占用、
 * 任务信箱、标签页和代理租约 —— 这些只有 background 能做。
 */

export type ControlMessage =
  /** 管理页 → background：停止这些账号的签到（含排队中的），并把状态改回待签到 */
  | { type: 'CANCEL_CHECKIN'; accountIds: string[] };

export interface ControlResponse {
  /** 实际被停下来的账号数（队列里移除的 + 状态复位的，去重后） */
  stopped?: number;
}
