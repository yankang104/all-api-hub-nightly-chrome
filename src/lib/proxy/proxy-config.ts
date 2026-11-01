import type { Account, ProxyConfig, SiteConfig } from '@/types';

/**
 * 这条代理是不是「只有名字」的条目。
 *
 * 名称条目来自订阅或 Clash controller 里 Chrome 用不了的协议（vmess/vless/trojan/ss），
 * 保存它只为了在界面上显示，并等待将来由同名 listener 补上真实端口。它没有可用出口，
 * 任何网络路径都必须先挡掉：
 * 一旦交给 applyProxy，浏览器全局代理会被设成一个不存在的地址，
 * 所有签到都会连不上，而失败原因看起来还像站点的问题。
 */
export function isNameOnlyProxy(proxy: Pick<ProxyConfig, 'nameOnly'>): boolean {
  return proxy.nameOnly === true;
}

export function isLoopbackProxyHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '[::1]';
}

/** Clash/Mihomo 本地 mixed/http 端口不接受 TLS 代理握手。 */
export function effectiveProxyScheme(
  proxy: Pick<ProxyConfig, 'host' | 'scheme'>,
): ProxyConfig['scheme'] {
  const raw = String(proxy.scheme).trim().toLowerCase();
  const scheme: ProxyConfig['scheme'] = raw === 'socks'
    ? 'socks5'
    : raw === 'mixed'
      ? 'http'
      : raw === 'https' || raw === 'socks4' || raw === 'socks5'
        ? raw
        : 'http';
  return scheme === 'https' && isLoopbackProxyHost(proxy.host) ? 'http' : scheme;
}

export function effectiveProxyConfig(proxy: ProxyConfig): ProxyConfig {
  const scheme = effectiveProxyScheme(proxy);
  const host = String(proxy.host).trim().replace(/^\[|\]$/g, '');
  const port = Number(proxy.port);
  return scheme === proxy.scheme && host === proxy.host && port === proxy.port
    ? proxy
    : { ...proxy, scheme, host, port };
}

/** 界面上要显示的「这个账号实际走哪个出口」。 */
export type AccountProxyLabel =
  /** 不经代理 */
  | { kind: 'direct' }
  /** 经代理，label 是节点名或 host:port */
  | { kind: 'proxy'; label: string; inherited: boolean }
  /** 历史遗留的订阅节点名绑定：没有实际出口，运行时必须报错 */
  | { kind: 'name-only'; label: string }
  /** 配置没填完，跑起来会失败 —— 提前在卡片上标出来 */
  | { kind: 'invalid'; label: string };

/**
 * 算出账号实际生效的代理，用于界面展示。
 *
 * 判定必须与 background 的 resolveProxyForAccount 一致：
 * 优先级是账号设置 > 站点设置 > 直连。两边分开写迟早会不一致 ——
 * 界面显示「直连」而实际走了站点代理，用户排查网络问题时会被误导。
 */
export function describeAccountProxy(
  account: Pick<Account, 'proxyMode' | 'proxyId' | 'customProxy'>,
  site: Pick<SiteConfig, 'proxyId'>,
  proxies: readonly ProxyConfig[],
): AccountProxyLabel {
  const mode = account.proxyMode ?? 'inherit';

  if (mode === 'none') return { kind: 'direct' };

  if (mode === 'custom') {
    const custom = account.customProxy;
    if (!custom?.host || !custom.port) return { kind: 'invalid', label: '自定义代理未填完' };
    return { kind: 'proxy', label: `${custom.host}:${custom.port}`, inherited: false };
  }

  const proxyId = mode === 'pool' ? account.proxyId : site.proxyId;
  if (!proxyId) {
    return mode === 'pool'
      ? { kind: 'invalid', label: '未选择代理池节点' }
      : { kind: 'direct' };
  }

  const proxy = proxies.find((item) => item.id === proxyId);
  if (!proxy) return { kind: 'invalid', label: '代理已被删除' };

  // 历史绑定要明说「没有出口」：标成普通代理会让用户以为这个账号真的走了
  // 那个国家的线路，排查网络问题时被误导。
  if (isNameOnlyProxy(proxy)) {
    return { kind: 'name-only', label: proxy.name };
  }

  return {
    kind: 'proxy',
    label: proxy.name || `${proxy.host}:${proxy.port}`,
    // inherit 模式用的是站点代理，界面上要能区分「这是站点给的」还是「账号自己选的」
    inherited: mode === 'inherit',
  };
}

/** 返回账号本次实际会使用的代理地址，供账号列表做可见详情展示。 */
export function describeAccountProxyEndpoint(
  account: Pick<Account, 'proxyMode' | 'proxyId' | 'customProxy'>,
  site: Pick<SiteConfig, 'proxyId'>,
  proxies: readonly ProxyConfig[],
): string | undefined {
  const mode = account.proxyMode ?? 'inherit';
  if (mode === 'none') return undefined;

  if (mode === 'custom') {
    const custom = account.customProxy;
    return custom?.host && custom.port
      ? `${effectiveProxyScheme(custom)}://${custom.host}:${custom.port}`
      : undefined;
  }

  const proxyId = mode === 'pool' ? account.proxyId : site.proxyId;
  if (!proxyId) return undefined;
  const proxy = proxies.find((item) => item.id === proxyId);
  if (!proxy || isNameOnlyProxy(proxy)) return undefined;
  return `${effectiveProxyScheme(proxy)}://${proxy.host}:${proxy.port}`;
}
