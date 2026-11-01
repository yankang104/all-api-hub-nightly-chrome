/**
 * 通知相关的消息。
 *
 * ⚠️ **实现已移除**（原 `src/background/notifier.ts`），这里只剩契约。
 * background 对 `TEST_NOTIFY` 有一条显式拒绝分支 —— 不能让它落到
 * `default: { ok: true }`，那会让管理页以为通知已送达。
 *
 * 重建时需要：数据模型、渠道抽象（桌面通知 / Webhook）、三个触发点
 * （终态 / 需人工 / 定时批次结束）和 UI。届时把下面的类型扩开即可。
 *
 * 由通知任务独占。
 */

export type NotifyMessage =
  /** 管理页 → background：发一条测试通知，验证渠道配置是否可用 */
  { type: 'TEST_NOTIFY'; channelId: string };

export interface NotifyResponse {
  /** 测试通知是否送达 */
  delivered?: boolean;
  /** 失败原因 */
  reason?: string;
}
