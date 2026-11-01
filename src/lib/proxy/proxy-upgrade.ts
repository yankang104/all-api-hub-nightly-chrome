import type { ProxyConfig } from '@/types';

/**
 * 把「只有名字」的池内条目升级成真实出口。
 *
 * 为什么需要这一步：订阅里 vmess/vless/trojan/hysteria2 这些协议 Chrome 用不了，
 * 导入时只能存下节点名（nameOnly）。旧版本可能已拿这些条目给账号做过绑定。
 * 后来用户又导入了一份带真实出口的清单（Clash/Mihomo 的 listeners 会把每个节点
 * 映射成一个本机端口，如 `127.0.0.1:11001` 对应「日本-优化」），
 * 这两批条目指的是同一个节点，只是一个有端口一个没有。
 *
 * 如果只是并排新增，账号仍然绑在没有出口的那条上，签到会一直失败在
 * 「只是订阅里的节点名」。要求用户手动逐个改绑不现实 —— 几十个账号，
 * 而且他根本看不出哪两条是同一个节点。
 *
 * 所以按名字配对，**原地补上 host/port 并清掉 nameOnly，id 保持不变**。
 * id 不变也能让旧账号/站点引用在升级后自动恢复可用。
 */

/**
 * 名字归一化，用于判断两条是不是同一个节点。
 *
 * 会剥掉的东西：
 *  - 前缀国家标签 `[US] ` / `[JP] `（导入清单为了让扩展的按国家分组能识别而加的）
 *  - 端口后缀 ` (11001)` 之类的括号补充
 *  - 各种空白与常见分隔符差异
 *
 * 大小写与全角半角括号一并统一，否则「日本-优化」和「日本－优化」会被当成两个。
 */
export function normalizeProxyName(name: string): string {
  return name
    .replace(/^\s*[[［(（]\s*[A-Za-z]{2}\s*[\]］)）]\s*/u, '')
    .replace(/[(（]\s*\d{2,5}\s*[)）]\s*$/u, '')
    .replace(/[\s_\-—－]+/gu, '')
    .toLowerCase()
    .trim();
}

/**
 * 导入时使用的出口身份键。
 *
 * 本机 listener 的协议只是 Chrome 连接同一 Mihomo mixed listener 的方式；
 * 旧扫描可能记成 socks5，新配置同步会记成 http。localhost、IPv4/IPv6 loopback
 * 也只是同一个监听地址的不同写法，所以本机出口按端口归一，避免重复入池。
 */
export function proxyEndpointKey(proxy: Pick<ProxyConfig, 'scheme' | 'host' | 'port'>): string {
  const rawHost = proxy.host.trim().toLowerCase();
  const host = rawHost.startsWith('[') && rawHost.endsWith(']')
    ? rawHost.slice(1, -1)
    : rawHost;
  const loopback = host === 'localhost'
    || host === '127.0.0.1'
    || host === '::1'
    || host === '0:0:0:0:0:0:0:1';
  return loopback
    ? `local-listener:${proxy.port}`
    : `${proxy.scheme}://${host}:${proxy.port}`;
}

type ProxyUpgradePatch = Partial<Pick<
  ProxyConfig,
  'name' | 'scheme' | 'host' | 'port' | 'sourceLabel'
>>;

export interface ProxyUpgradePlan {
  /** 原地升级或更新既有真实出口的显示信息 */
  upgrades: { id: string; patch: ProxyUpgradePatch }[];
  /** 删除重复出口前，把 fromId 的账号/站点引用迁到 toId */
  merges: { fromId: string; toId: string }[];
  /** 没有对应名称条目的，按新增处理 */
  additions: Omit<ProxyConfig, 'id'>[];
}

/**
 * 算出「哪些既有条目该升级、哪些输入该新增」。
 *
 * 纯函数，不碰存储 —— 配对规则是这个功能里唯一容易出错的地方，
 * 必须能单独测。
 *
 * @param existing 池内现有条目
 * @param inputs   本次要导入的条目（通常来自订阅解析结果）
 */
export function planProxyUpgrade(
  existing: readonly ProxyConfig[],
  inputs: readonly Omit<ProxyConfig, 'id'>[],
): ProxyUpgradePlan {
  // 只有名称条目值得升级；已经有真实出口的不动，避免把用户手填的地址覆盖掉。
  const nameOnlyByKey = new Map<string, ProxyConfig[]>();
  for (const proxy of existing) {
    if (proxy.nameOnly !== true) continue;
    const key = normalizeProxyName(proxy.name);
    if (!key) continue;
    const matches = nameOnlyByKey.get(key) ?? [];
    matches.push(proxy);
    nameOnlyByKey.set(key, matches);
  }

  // 一个历史 listener 可能被扫描为 localhost + socks5，后来又从配置同步为
  // 127.0.0.1 + http。它们都指向同一个本机端口，必须放进同一组。
  const realByEndpoint = new Map<string, ProxyConfig[]>();
  for (const proxy of existing) {
    if (proxy.nameOnly === true) continue;
    const endpoint = proxyEndpointKey(proxy);
    const matches = realByEndpoint.get(endpoint) ?? [];
    matches.push(proxy);
    realByEndpoint.set(endpoint, matches);
  }

  const upgrades: ProxyUpgradePlan['upgrades'] = [];
  const merges: ProxyUpgradePlan['merges'] = [];
  const additions: Omit<ProxyConfig, 'id'>[] = [];
  const usedKeys = new Set<string>();
  const seenEndpoints = new Set<string>();

  for (const input of inputs) {
    // 名称条目本身不参与升级，也不该把真实出口降级回名称
    if (input.nameOnly === true) {
      additions.push(input);
      continue;
    }

    const endpoint = proxyEndpointKey(input);
    if (seenEndpoints.has(endpoint)) continue;
    seenEndpoints.add(endpoint);
    const key = normalizeProxyName(input.name);
    const nameMatches = key ? nameOnlyByKey.get(key) ?? [] : [];
    const match = key && !usedKeys.has(key) ? nameMatches[0] : undefined;
    const endpointMatches = realByEndpoint.get(endpoint) ?? [];

    if (endpointMatches.length) {
      // 普通订阅/手工导入仍沿用“已有出口即跳过”的保守规则。只有 Clash
      // 配置同步能确认“这个本地端口现在对应哪个节点”，因此才允许改名和合并。
      if (input.sourceLabel !== 'Clash Verge') continue;

      if (match) {
        usedKeys.add(key);
        upgrades.push({
          id: match.id,
          patch: {
            name: input.name,
            scheme: input.scheme,
            host: input.host,
            port: input.port,
            sourceLabel: input.sourceLabel,
          },
        });
        for (const duplicate of nameMatches) {
          if (duplicate.id !== match.id) merges.push({ fromId: duplicate.id, toId: match.id });
        }
        for (const duplicate of endpointMatches) {
          if (duplicate.id !== match.id) merges.push({ fromId: duplicate.id, toId: match.id });
        }
        continue;
      }

      const canonical = endpointMatches[0]!;
      const duplicateIds = endpointMatches.slice(1);
      if (canonical.name !== input.name
        || canonical.sourceLabel !== input.sourceLabel
        || duplicateIds.length) {
        upgrades.push({
          id: canonical.id,
          patch: { name: input.name, sourceLabel: input.sourceLabel },
        });
      }
      for (const duplicate of duplicateIds) {
        merges.push({ fromId: duplicate.id, toId: canonical.id });
      }
      continue;
    }

    if (match) {
      usedKeys.add(key);
      upgrades.push({
        id: match.id,
        patch: {
          // 用导入清单的名字：它带国家标签，扩展的按国家分组要靠它识别
          name: input.name,
          scheme: input.scheme,
          host: input.host,
          port: input.port,
          ...(input.sourceLabel !== undefined ? { sourceLabel: input.sourceLabel } : {}),
        },
      });
      for (const duplicate of nameMatches) {
        if (duplicate.id !== match.id) merges.push({ fromId: duplicate.id, toId: match.id });
      }
      continue;
    }

    additions.push(input);
  }

  return { upgrades, merges, additions };
}
