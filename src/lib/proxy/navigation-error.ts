/**
 * 浏览器导航错误码 → 人话。
 *
 * 抽成独立模块是为了能单测：这段文案是用户唯一的线索来源。用户实测里最常见的误诊
 * 是「订阅节点全都不通 —— 其实本机根本没跑内核」：所有本地端口都没人监听，报出来
 * 却是一句笼统的「代理连接失败」。拿到当前生效的代理端点后，这里能直接点名端口。
 *
 * ⚠️ 判断「是谁的问题」而不是「是哪个错误码」：经本机回环代理出站时，
 * ERR_NAME_NOT_RESOLVED / ERR_CONNECTION_TIMED_OUT / ERR_TIMED_OUT /
 * ERR_CONNECTION_RESET 的**最常见成因不是站点**，而是本地内核端口没人监听、
 * 内核没起来，或内核里的节点已经断了 —— 这些错误码从头到尾都经过那个端口，
 * 浏览器没有任何机会告诉我们问题发生在链路的那一段。此时只报「站点域名解析
 * 失败」，用户会去改站点地址、换 DNS，而真正该做的是启动 Clash Verge / mihomo。
 *
 * 因此：回环端点 + 这几个错误码时，**先点名本地端口**，把原有站点侧文案作为补充
 * 保留在后面 —— 不是替代。用户两种可能都要能看到。
 */
import { loopbackListenerMissingMessage } from '@/lib/proxy/proxy';
import { isLoopbackProxyHost } from '@/lib/proxy/proxy-config';

/**
 * 经本地回环代理时，把「站点侧说法」改写成「先点名本地端口，再补站点说法」。
 *
 * - 没有走扩展代理时原文案不动：直连报域名解析失败就是域名解析失败；
 * - 端点不是回环时也不动：远程代理域名解析失败是代理服务器自己的问题，
 *   编造一个「本机端口没监听」是错的；
 * - `siteFallback` 是这段错误码原本的站点侧说法，始终保留在句尾。
 */
function withLoopbackHint(
  loopbackMissing: string | null,
  siteFallback: string,
): string {
  return loopbackMissing ? `${loopbackMissing}；也可能是${siteFallback}` : siteFallback;
}

export function navigationErrorMessage(
  error: string,
  usesExtensionProxy: boolean,
  endpoint?: { host: string; port: number } | null,
): string | null {
  const code = error.replace(/^net::/, '');
  if (code === 'ERR_ABORTED') return null;

  const proxyPrefix = usesExtensionProxy ? '扩展代理' : 'Chrome/系统网络';
  /**
   * 本地回环端点连不上 = 内核没在监听：节点没问题，只是本机没有 Clash Verge /
   * mihomo 把 vmess/vless 变成 `127.0.0.1:<端口>`。说清端口，用户才知道该去
   * 启动什么，而不是去怀疑节点或订阅。
   */
  const loopbackMissing = usesExtensionProxy && endpoint && isLoopbackProxyHost(endpoint.host)
    ? loopbackListenerMissingMessage(endpoint.host, endpoint.port)
    : null;

  if (code === 'ERR_PROXY_CONNECTION_FAILED') {
    return loopbackMissing ?? `${proxyPrefix}连接失败，请检查代理协议、主机和端口`;
  }
  if (code === 'ERR_TUNNEL_CONNECTION_FAILED') {
    return loopbackMissing ?? `${proxyPrefix}无法建立 HTTPS 隧道`;
  }
  if (code === 'ERR_NAME_NOT_RESOLVED') {
    return withLoopbackHint(loopbackMissing, '站点域名解析失败');
  }
  if (code === 'ERR_CONNECTION_TIMED_OUT' || code === 'ERR_TIMED_OUT') {
    return withLoopbackHint(loopbackMissing, '连接站点超时');
  }
  if (code === 'ERR_CONNECTION_REFUSED') return loopbackMissing ?? '站点或代理拒绝连接';
  /**
   * 端口后面没有任何东西接住连接时，Chrome 不一定报 ERR_PROXY_CONNECTION_FAILED：
   * HTTPS 经 HTTP 代理的新建连接被直接关闭，报的是 ERR_CONNECTION_CLOSED。
   *
   * 这个码以前没有对应文案，navigationErrorMessage 返回 null，后台便**什么都不写**
   * —— 任务停在 running，用户看到的是「一直转圈」，连失败原因都没有。本地内核
   * 没启动正是这个形状，所以这里必须给出同一句「本机端口没人监听」。
   */
  if (code === 'ERR_CONNECTION_CLOSED') return loopbackMissing ?? `${proxyPrefix}提前关闭了连接`;
  if (code === 'ERR_CONNECTION_RESET') {
    /**
     * 连接被重置 = 端口后面**有东西**，只是它断了。经本地代理时最常见的两种：
     * 内核端口还在、但内核里的节点已断（客户端连接被内核重置），或端口根本没人
     * 监听时内核替我们回了个 RST。两种都要用户先去点端口，所以同样带上提示，
     * 站点侧说法保留在句尾。
     */
    return withLoopbackHint(loopbackMissing, '连接被站点或代理重置');
  }
  if (code === 'ERR_ADDRESS_UNREACHABLE' || code === 'ERR_INTERNET_DISCONNECTED') return `${proxyPrefix}当前不可达`;
  if (code.startsWith('ERR_CERT_')) return `站点 TLS 证书错误（${code}）`;
  return null;
}

