/**
 * 数据同步相关的消息（阶段四使用）。
 *
 * 由 WebDAV 同步任务独占。
 */

export type SyncMessage =
  /** 管理页 → background：测试 WebDAV 连通性 */
  | { type: 'TEST_WEBDAV' }
  /** 管理页 → background：立即执行一次同步 */
  | { type: 'RUN_SYNC'; direction: 'upload' | 'download' };

export interface SyncResponse {
  /** 同步是否成功 */
  synced?: boolean;
  /** 同步了多少条记录 */
  count?: number;
  /** 失败原因 */
  reason?: string;
}
