/**
 * 站点探测的消息域。
 *
 * 探测必须在 background 执行：它有 `<all_urls>` host permission，
 * 而管理页（options/sidepanel）发跨源请求会被 CORS 拦掉。
 */

import type { ProbeResult } from '@/lib/site/site-probe';

export type ProbeMessage =
  /** 管理页 → background：探测这个地址跑的是什么站点系统 */
  | { type: 'PROBE_SITE'; url: string };

export interface ProbeResponse {
  probe?: ProbeResult;
}
