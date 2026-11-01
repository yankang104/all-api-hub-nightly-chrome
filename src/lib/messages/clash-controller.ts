/** Read-only access to a Clash/Mihomo external controller. */

import type { ClashControllerConnection } from '@/lib/clash/clash-controller';
import type { ClashControllerDetection } from '@/lib/clash/clash-controller-detect';
import type { ClashListenerExit } from '@/lib/clash/clash-listeners';

export type ClashControllerMessage =
  | {
      type: 'READ_CLASH_PROXIES';
      controller: ClashControllerConnection;
    }
  /** 管理页 → background：自动探测本机内核的 external-controller 端口（只读 GET /version）。 */
  | { type: 'DETECT_CLASH_CONTROLLER'; controller?: ClashControllerConnection }
  /** 管理页 → background：读取内核里已配置的本地出口 listeners（只读 GET /listeners）。 */
  | {
      type: 'READ_CLASH_LISTENER_EXITS';
      controller: ClashControllerConnection;
    };

/** HTTP 控制接口检测结果；不能用于断言本机内核进程是否运行。 */
export type ClashControllerDetect = ClashControllerDetection;

/** 内核 listeners 里的一条本地出口（形状与解析器一致，复用其类型避免两处口径分叉）。 */
export type { ClashListenerExit };

export interface ClashControllerResponse {
  clashController?: {
    /** Normalized controller origin used for the request. */
    origin: string;
    /** Leaf proxy names from GET /proxies; policy groups and built-ins are excluded. */
    names: string[];
  };
  /** 未命中时仍返回 not-found 诊断，不能把仅使用命名管道的内核说成未启动。 */
  clashControllerDetect?: ClashControllerDetect;
  /** READ_CLASH_LISTENER_EXITS 读取到的内核本地出口。 */
  clashListenerExits?: {
    origin: string;
    exits: ClashListenerExit[];
  };
}
