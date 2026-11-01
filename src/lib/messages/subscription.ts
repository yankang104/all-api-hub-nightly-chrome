/**
 * 代理订阅拉取的消息域。
 *
 * 与站点探测同理，必须在 background 执行：管理页发跨源请求会被订阅站的
 * CORS 拦掉，而 background 有 `<all_urls>` host permission。
 *
 * 只拉原文、不在后台解析 —— 解析是纯函数（lib/proxy-subscription.ts），
 * 放在管理页跑便于把预览结果直接呈现给用户，也省去把解析结构过一遍消息通道。
 */

export type SubscriptionMessage =
  /** 管理页 → background：拉取订阅链接的原始内容 */
  | { type: 'FETCH_SUBSCRIPTION'; url: string }
  /** 管理页 → background:按已存 listenerPlan/订阅源做一次漂移检查(手动「立即检查」与闹钟共用) */
  | { type: 'CHECK_LISTENER_DRIFT' };

export interface ListenerDriftReport {
  ok: true;
  /** 本次新入库的端口数 */
  added: number;
  /** 订阅里已消失、映射里留下的节点数(端口留空洞不复用) */
  removed: number;
  /** 当前映射总条目 */
  total: number;
  checkedAt: number;
  /** 需要「重新复制 Script」时为 true:本次有新增节点,Script 里的映射已变化 */
  needsResync: boolean;
}

export interface SubscriptionFetchResult {
  /** 订阅原文（可能是 base64、URI 列表或 Clash YAML） */
  text: string;
  /** 字节数，用于在界面上说明拉到了多少内容 */
  bytes: number;
}

export interface SubscriptionResponse {
  subscription?: SubscriptionFetchResult;
  /** CHECK_LISTENER_DRIFT 的结果 */
  listenerDrift?: ListenerDriftReport;
}
