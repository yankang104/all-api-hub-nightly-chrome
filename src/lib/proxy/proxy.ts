import type { ProxyConfig } from '@/types';
import { effectiveProxyConfig, isLoopbackProxyHost, isNameOnlyProxy } from '@/lib/proxy/proxy-config';

/**
 * 代理管理。
 *
 * ⚠️ 关键限制：`chrome.proxy` 是**浏览器全局**设置，无法按标签页隔离。
 * 所以代理只在签到任务执行期间生效，任务结束（含失败、标签页关闭）立即还原，
 * 且 background 会串行执行需要代理的任务，避免两个任务抢同一个全局设置。
 *
 * 代理认证走 `chrome.webRequest.onAuthRequired`，凭据只在内存里，不落盘。
 */

/** 当前生效的代理认证凭据，仅存内存 */
let activeAuth: { username: string; password: string } | null = null;
let authListenerBound = false;

/** 名称条目误入网络路径时的统一说法 */
export const NAME_ONLY_PROXY_ERROR = '这是订阅节点名称，没有可用的浏览器代理出口';

/** 应用代理设置 */
export async function applyProxy(proxy: ProxyConfig): Promise<void> {
  // 名称条目没有真实出口，设下去会把浏览器全局代理指到一个不存在的地址
  if (isNameOnlyProxy(proxy)) throw new Error(NAME_ONLY_PROXY_ERROR);

  const effective = effectiveProxyConfig(proxy);
  if (!effective.host || !Number.isInteger(effective.port) || effective.port < 1 || effective.port > 65535) {
    throw new Error('代理地址不完整，请重新导入或填写正确的主机和端口');
  }
  const single = {
    scheme: effective.scheme,
    host: effective.host,
    port: effective.port,
  };

  await chrome.proxy.settings.set({
    value: {
      mode: 'fixed_servers',
      rules: {
        singleProxy: single,
        // 本地地址不走代理，否则扩展页自身请求也会被绕进去
        bypassList: ['localhost', '127.0.0.1', '<local>'],
      },
    },
    scope: 'regular',
  });

  /*
   * 必须回读确认。`settings.set` 在设置被别的扩展占用时**照样 resolve**，
   * 不抛错也不返回失败 —— 代理根本没生效，任务却以为成功了，浏览器直接
   * 明文出站。用户看到的是站点报 ERR_SSL_VERSION_OR_CIPHER_MISMATCH
   * （直连握不上手的站点尤其明显），完全看不出是代理没套上。
   * 这是 chrome.proxy 唯一能发现失败的途径，不能省。
   */
  await assertProxyEffective(single);

  /*
   * 认证凭据只要有一项非空就登记。
   *
   * 旧实现要求用户名和密码**同时**非空，于是「只填用户名」「密码留空」这类
   * 代理一个凭据都不应答，请求直接吃 407 —— 用户看到的是「代理连不通」，
   * 而节点本身完全正常。空串本身是合法凭据值（有些内核允许用户名或密码为空），
   * 该不该放行由代理服务器判断，不由这里替它决定。
   */
  const username = proxy.username ?? '';
  const password = proxy.password ?? '';
  if (username || password) {
    activeAuth = { username, password };
    bindAuthListener();
  } else {
    activeAuth = null;
  }
}

/**
 * 回读浏览器实际生效的代理，和刚设下去的值比对。
 *
 * `levelOfControl` 不是 `controlled_by_this_extension` 就说明没轮到我们：
 * 另一个扩展（SwitchyOmega、各类加速器插件）优先级更高，或者策略锁定了设置。
 * 这种情况必须抛错，让上层把任务标记为失败，而不是静默直连。
 */
async function assertProxyEffective(
  expected: { scheme: string; host: string; port: number },
): Promise<void> {
  const current = await chrome.proxy.settings.get({ incognito: false }).catch(() => null);
  if (!current) throw new Error('无法读取浏览器代理设置，代理未生效');

  const control = current.levelOfControl;
  if (control !== 'controlled_by_this_extension') {
    throw new Error(
      control === 'controlled_by_other_extensions'
        ? '浏览器代理设置被其他扩展占用，本扩展改不动。请先停用那个扩展（常见的是 SwitchyOmega、各类加速器插件）'
        : control === 'not_controllable'
          ? '浏览器代理设置被系统策略锁定，扩展无权修改'
          : `浏览器代理设置未被本扩展接管（${control}），代理未生效`,
    );
  }

  const single = (current.value as chrome.proxy.ProxyConfig | undefined)?.rules?.singleProxy;
  if (!single || single.host !== expected.host || single.port !== expected.port) {
    throw new Error(
      `代理设置回读不一致：期望 ${expected.host}:${expected.port}，实际 ${single ? `${single.host}:${single.port}` : '空'}`,
    );
  }
}

/** 还原为系统默认，务必在任务结束时调用 */

export async function clearProxy(): Promise<void> {
  activeAuth = null;
  await chrome.proxy.settings.clear({ scope: 'regular' });
}

/**
 * 读回浏览器当前生效的扩展代理端点。
 *
 * 用途只有一个：**把失败说清楚**。本地内核（Clash Verge 等）没启动时，所有本地端口
 * 都没人监听，测活只会报「超时（8s）」、导航只会报「代理连接失败」—— 用户会以为节点
 * 坏了或配置错了，实际是少了一个必须的前提。拿到 host:port 才能直接说出来。
 *
 * 不是本扩展接管时返回 null：那种情况另有专门报错（别的扩展占用/策略锁定），
 * 不能在这里编造一个端口。
 */
export async function readAppliedProxyEndpoint(): Promise<{ host: string; port: number } | null> {
  const current = await chrome.proxy.settings.get({ incognito: false }).catch(() => null);
  if (!current || current.levelOfControl !== 'controlled_by_this_extension') return null;
  const single = (current.value as chrome.proxy.ProxyConfig | undefined)?.rules?.singleProxy;
  if (!single?.host || !Number.isInteger(single.port)) return null;
  return { host: String(single.host), port: Number(single.port) };
}

/**
 * 本地端口没人监听时的统一说法。
 *
 * 这是「订阅节点全都不通」最常见、也最容易被误诊的成因：节点本身没问题，
 * 只是本机没有内核把 vmess/vless 变成 `127.0.0.1:<端口>`。
 */
export function loopbackListenerMissingMessage(host: string, port: number): string {
  return `本机 ${host}:${port} 上没有程序在监听 —— 内核（Clash Verge / mihomo 等）没启动，或该节点的本地端口还没生效`;
}

/**
 * 导航停在空白页时的最终说法。
 *
 * 「标签页导航后仍未离开空白页」本身不解释原因。本地内核没起来时，浏览器就是
 * 这个形状：请求发给了 127.0.0.1:<端口>，那里没人接，navigation 既不成功也不
 * 报错，页面永远停在空白页。用户按原话只能去查站点或网络，而真正该做的是启动
 * 本机内核（Clash Verge / mihomo）—— 这正是最常见的误诊。
 *
 * 因此拿到当前生效的扩展代理端点后：只有它**确实是回环地址**才换成点名端口的
 * 说法；远程代理、直连、或读不到端点时一律保留原文，绝不杜撰本机端口。
 *
 * 抽成纯函数是为了能单测 —— 它是用户排查死端口代理时唯一的线索来源。
 */
export function loopbackNavigationFailureMessage(
  fallback: string,
  endpoint: { host: string; port: number } | null | undefined,
): string {
  if (!endpoint) return fallback;
  return isLoopbackProxyHost(endpoint.host)
    ? loopbackListenerMissingMessage(endpoint.host, endpoint.port)
    : fallback;
}

/** 代理要求认证时自动应答 */
function bindAuthListener(): void {
  if (authListenerBound) return;
  authListenerBound = true;

  chrome.webRequest.onAuthRequired.addListener(
    (details, callback) => {
      // 只应答代理的认证挑战，网站自身的 401 不管
      if (!details.isProxy || !activeAuth) {
        callback?.({});
        return undefined;
      }
      callback?.({ authCredentials: { ...activeAuth } });
      return undefined;
    },
    { urls: ['<all_urls>'] },
    ['asyncBlocking'],
  );
}

export interface ProxyTestResult {
  ok: boolean;
  ms: number;
  message: string;
  /** 出口 IP，查不到就留空 */
  ip?: string;
  /** 出口国家/地区中文名，查不到就留空 */
  country?: string;
  /**
   * 本机端口有没有程序在监听。**只在失败时才有意义**(成功自然说明在监听)。
   *
   * 这是把「脚本没生效」和「节点连不通」分开的唯一可靠信号 —— 两者在浏览器
   * 里的表现都是「连不上」,但前者连 TCP 都握不上,后者能连上端口却出不去。
   * 只对本机地址做这个探测,公网代理没有这个语义。
   */
  listenerProbe?: 'listening' | 'closed';
}

/**
 * 回查出口的接口。
 *
 * 用两个候选：第一个挂了或被用户的规则拦了还能落到第二个。
 * 都失败不影响连通性判定 —— 端口能通就是能通，只是不知道通向哪。
 */
const EXIT_PROBES = [
  { url: 'https://ipapi.co/json/', ip: 'ip', country: 'country_name' },
  { url: 'https://ipwho.is/', ip: 'ip', country: 'country' },
] as const;

/**
 * 查当前代理的出口 IP 与国家。
 *
 * 必须在 applyProxy 之后、clearProxy 之前调用 —— 它靠的就是当前生效的
 * 浏览器全局代理。查询失败一律返回空对象，绝不抛出：地理服务不可用
 * 不能让「端口是通的」这个结论被推翻。
 */
async function probeExit(): Promise<{ ip?: string; country?: string }> {
  for (const probe of EXIT_PROBES) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const resp = await fetch(probe.url, { signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(timer);
      if (!resp.ok) continue;

      const payload = await resp.json() as Record<string, unknown>;
      const ip = payload[probe.ip];
      const country = payload[probe.country];
      if (typeof ip === 'string' && ip.trim()) {
        return {
          ip: ip.trim(),
          ...(typeof country === 'string' && country.trim() ? { country: country.trim() } : {}),
        };
      }
    } catch {
      // 换下一个候选
    }
  }
  return {};
}

/**
 * 探测本机端口有没有程序在监听。
 *
 * 不发代理请求、不改全局代理:只对这个 127.0.0.1 端口发一个最普通的 HTTP
 * 请求,看传输层是否握手成功。真机实测:
 *  - 有监听(即使节点名对不上) → 返回 HTTP 响应(常见 400),算 listening;
 *  - 没监听 → fetch 立刻 reject,算 closed。
 *
 * 超时返回 **undefined（未知）**，不能当成 listening。
 * fetch 超时有两种成因，在浏览器侧观察不到区分手段：
 *  - TCP 已握上、只是没回 HTTP（内核不认这个请求）—— 端口确实在监听；
 *  - TCP SYN 被防火墙丢弃（DROP）—— 端口**没有**回任何东西。
 * 早先这里把超时一律当成「在监听」，而随后给用户的结论是「端口正常，多半是
 * 节点名对不上」—— 在 DROP 场景下把用户引去排查完全错误的方向。
 * 「不知道」就如实说不知道。
 *
 * 只对回环地址有意义,其他地址一律返回 undefined。
 */
async function probeListener(
  host: string,
  port: number,
): Promise<'listening' | 'closed' | undefined> {
  if (!isLoopbackProxyHost(host)) return undefined;
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, 2_500);
  try {
    // 内核的 mixed/http 入口对裸 HTTP 请求会回 400/200 之类,拿到任何响应即算在监听
    const response = await fetch(`http://${host}:${port}/`, {
      signal: ctrl.signal,
      cache: 'no-store',
      redirect: 'manual',
    });
    // 拿到了 HTTP 响应（任意状态码）就证明这个端口上确实有程序在应答。
    if (response) return 'listening';
    return undefined;
  } catch {
    /*
     * 超时：握手可能成、也可能被 DROP 丢包，浏览器不给区分手段 → 未知。
     * 其余错误（ECONNREFUSED 等）才是明确的「没人监听」。
     */
    if (timedOut) return undefined;
    return 'closed';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 连通性测试：通过代理请求一个轻量地址，并回查出口。
 *
 * @param withExit 是否顺带查出口 IP/国家。扫描默认关闭以保持快速；需要确认
 *   不同端口是否真的分流时再打开，单个节点点测试时也不用。
 * @param timeoutMs 代理连通性请求的最长等待时间；扫描快速模式会使用更短的上限。
 */
export async function testProxy(
  proxy: ProxyConfig,
  testUrl = 'https://www.gstatic.com/generate_204',
  withExit = false,
  timeoutMs = 12_000,
): Promise<ProxyTestResult> {
  // 名称条目不测活：它本来就没有出口，测出「不通」只会让用户以为节点坏了
  if (isNameOnlyProxy(proxy)) return { ok: false, ms: 0, message: NAME_ONLY_PROXY_ERROR };

  const started = Date.now();
  const effective = effectiveProxyConfig(proxy);
  let proxyApplied = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await applyProxy(proxy);
    proxyApplied = true;
    // 给设置生效留一点时间
    await new Promise((r) => setTimeout(r, 400));

    const ctrl = new AbortController();
    timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const resp = await fetch(testUrl, { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(timer);

    const ms = Date.now() - started;
    // generate_204 正常返回 204；其他 2xx/3xx 也算通
    const ok = resp.status === 204 || (resp.status >= 200 && resp.status < 400);
    if (!ok) return { ok, ms, message: `返回 ${resp.status}` };

    const exit = withExit ? await probeExit() : {};
    const correction = effective.scheme !== proxy.scheme ? '本地代理已自动改用 http，' : '';
    const where = exit.country ? `${exit.country} · ` : '';
    return { ok, ms, message: `${correction}${where}连通，${ms}ms`, ...exit };
  } catch (err) {
    const ms = Date.now() - started;
    const msg = err instanceof Error ? err.message : String(err);
    const timeoutSeconds = Math.max(1, Math.round(timeoutMs / 1000));
    if (!proxyApplied) return { ok: false, ms, message: msg };
    if (msg.includes('abort')) return { ok: false, ms, message: `超时（${timeoutSeconds}s）` };
    /*
     * 本机端口失败时补一次 TCP 级探测,把「脚本没生效」和「节点连不通」分开。
     * 两者在浏览器里的表现都是「连不上」,但处置办法完全不同 —— 不区分的话,
     * 用户会照着往错误的方向排查(去换来换去地测节点,而其实是脚本没粘)。
     */
    if (isLoopbackProxyHost(effective.host)) {
      const listenerProbe = await probeListener(effective.host, effective.port);
      /*
       * 三种结论分开写：
       *  - closed    → 确定没人监听，指向「脚本没粘」；
       *  - listening → 确定有程序在应答，指向「节点名/订阅对不上」；
       *  - undefined → 探测没结论（多为超时）。**绝不能编造一个原因**，
       *    只说「无法判断」，否则用户会照着错误方向排查。
       */
      const reason = listenerProbe === 'closed'
        ? `${effective.host}:${effective.port} 上没有任何程序在监听 —— Clash Verge 还没用上这份 listeners 配置(脚本没粘 / 粘错订阅 / 没重载)`
        : listenerProbe === 'listening'
          ? `${effective.host}:${effective.port} 端口正常在监听,但流量出不去 —— 多半是当前激活的订阅与脚本里的节点名对不上,或该节点已失效`
          : `探测 ${effective.host}:${effective.port} 是否有程序监听时超时,无法判断是端口没生效还是节点连不通；请先在 Clash Verge 里确认该端口处于监听状态`;
      return {
        ok: false, ms,
        message: `无法通过本机代理 ${effective.host}:${effective.port} 连接测试地址。${reason}`,
        ...(listenerProbe ? { listenerProbe } : {}),
      };
    }
    return { ok: false, ms, message: msg };
  } finally {
    if (timer) clearTimeout(timer);
    await clearProxy();
  }
}
