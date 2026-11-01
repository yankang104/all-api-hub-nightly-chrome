/**
 * 本机端口扫描的消息域。
 *
 * 为什么需要：机场订阅里的 vmess/vless 协议浏览器用不了，但本地内核
 * （Clash Verge 等）通常已经为不同节点各开了一个本地监听端口。那些端口
 * 说的是普通 HTTP/SOCKS，浏览器能直接用 —— 这是「每个账号走自己的出口」
 * 在不改动内核配置的前提下唯一可行的路。
 *
 * 扫描会连一下端口，并尝试只读 Clash listeners 获取端口对应名称。
 * 出口 IP 查询是可选的慢速诊断项；不修改、不切换本地内核的任何配置或当前节点。
 */

import type { ClashControllerConnection } from '@/lib/clash/clash-controller';

export type PortScanMessage =
  /** 管理页 → background：逐个试这些本机端口；默认只做快速连通性检查 */
  | {
      type: 'SCAN_LOCAL_PORTS';
      host: string;
      ports: number[];
      scheme: 'http' | 'socks5';
      /** Optional controller used to read the port-to-node mapping from /listeners. */
      controller?: ClashControllerConnection;
      /** 是否为每个端口额外查询出口 IP/国家（明显更慢） */
      withExit?: boolean;
    };

export interface PortScanEntry {
  port: number;
  ok: boolean;
  ms: number;
  message: string;
  /** Clash/Mihomo listener 映射出的原始节点名 */
  name?: string;
  /** 出口 IP，查不到留空 */
  ip?: string;
  /** 出口国家/地区，查不到留空 */
  country?: string;
}

export interface PortScanResponse {
  portScan?: {
    entries: PortScanEntry[];
    /** 能连通的端口数 */
    live: number;
    /** 出口 IP 各不相同的端口数；未开启出口查询时为空 */
    distinctExits?: number;
    /** 是否执行了出口 IP/国家查询 */
    exitChecked?: boolean;
    /** 成功从 Clash listeners 读取到名称的端口数 */
    named?: number;
    /** 使用的 Clash external-controller 端口，未发现时为空 */
    controllerPort?: number;
    /** 实际访问的 Clash controller origin。 */
    controllerOrigin?: string;
    /** /listeners 的结果；不影响端口本身的连通性扫描。 */
    listenerStatus?: 'mapped' | 'unsupported' | 'unauthorized' | 'empty' | 'unavailable' | 'invalid';
  };
}
