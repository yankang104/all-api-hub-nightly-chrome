/**
 * 「账号该走哪条出口」与「浏览器此刻实际在走哪条出口」是否一致。
 *
 * 为什么需要这个判断：chrome.proxy 是**浏览器级**设置，而余额刷新有一条历史
 * 捷径 —— 站点上已经开着标签页就直接借它读余额、不动代理。那条捷径会让余额
 * 走用户当前标签页的网络路径（通常直连），与签到任务走的账号代理**出口不一致**。
 * 风控站点看到同一账号从两个来源来，表现是「余额刷不出来（401/404），但签到
 * 正常」——用户完全想不到是网络路径的问题，因为扩展这边只是安静地失败。
 *
 * 抽成纯函数是因为这条判断错一次的代价是「静默地用错误的出口读数据」：它必须
 * 被单测锁住，而 background entrypoint 里做不到。
 */
import type { ProxyConfig } from '@/types';
import { effectiveProxyConfig } from '@/lib/proxy/proxy-config';

/**
 * 浏览器此刻实际生效的扩展代理端点。
 *
 * `null` 表示「本扩展此刻没有在接管代理」 —— 既包括用户本来就直连，也包括
 * 设置被别的扩展或系统策略接管（后者的专门报错在 proxy.ts 里，不在这里编造）。
 */
export type AppliedProxyEndpoint = { host: string; port: number } | null;

/**
 * 账号解析出来的出口，与浏览器实际生效的出口是否一致。
 *
 * - 账号**不需要**代理：只有实际也没走任何扩展代理时才算一致。否则（例如上一个
 *   任务刚把全局代理设成某条线路、还没释放）借这个标签页读余额就是在用别人的出口。
 * - 账号需要一个具体代理：主机与端口都要对得上。只比端口不够 —— 两个不同主机上
 *   的同号端口是两条完全不同的线路。
 */
export function appliedProxyMatchesAccount(
  desired: ProxyConfig | undefined,
  applied: AppliedProxyEndpoint,
): boolean {
  if (!desired) return applied == null;
  const effective = effectiveProxyConfig(desired);
  return applied != null
    && applied.host === effective.host
    && applied.port === effective.port;
}

/**
 * 启动一段**会真正出网**的会话（学习 / 签到任务）之前，核对浏览器此刻的出口。
 *
 * 与 `appliedProxyMatchesAccount` 的分工：那个函数回答「已经开着的标签页能不能
 * 复用」，只给布尔；启动路径需要的是一句能直接给用户看的原因，而且必须把
 * 「账号该直连、浏览器却正被别的代理接管」这条单独点出来 —— 那是最隐蔽的一类
 * 串号：签到队列 / 另一条学习会话持有全局代理时，直连账号开出的页面会从**别人的
 * 出口**出站，学到的流程与之后直连回放的样子不一致，站点侧看到的则是「同一个
 * 账号一会儿这个 IP、一会儿那个 IP」。
 *
 * 返回 null 表示出口一致、可以开始；否则返回如实说明原因的文案。拿不准时一律
 * 给原因：静默用错出口比直接失败更难排查，这与代理链路上其它判定同一口径。
 */
export function egressMismatchReason(
  desired: ProxyConfig | undefined,
  applied: AppliedProxyEndpoint,
): string | null {
  if (!desired) {
    return applied == null
      ? null
      : `这个账号按配置应该直连，但浏览器此刻仍被 ${applied.host}:${applied.port} 这条代理接管（通常是另一个签到任务或学习会话还没结束）；已放弃开始，避免在别人的出口上演示或签到`;
  }

  const effective = effectiveProxyConfig(desired);
  const expected = `${effective.host}:${effective.port}`;
  if (applied == null) {
    return `账号配置的代理 ${expected} 没有生效（浏览器此刻未走本扩展代理）；已放弃开始，避免直连泄露`;
  }
  if (applied.host === effective.host && applied.port === effective.port) return null;
  return `浏览器此刻走的是 ${applied.host}:${applied.port}，不是这个账号配置的 ${expected}；已放弃在错误的出口上开始，避免学习与回放走的不是同一条线路`;
}
