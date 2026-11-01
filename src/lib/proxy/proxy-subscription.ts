/**
 * 订阅链接解析：把一份订阅内容变成可导入代理池的节点列表。
 *
 * ⚠️ 关键限制，也是这个模块存在的主要理由：
 * `chrome.proxy` 只接受 http / https / socks4 / socks5（见 types 里的 ProxyConfig
 * 与 lib/proxy.ts 的 applyProxy）。而机场订阅里绝大多数是 vless / vmess /
 * trojan / ss —— 这些协议浏览器**根本无法直接使用**。
 *
 * 所以不能「解析失败就静默丢掉」：用户订阅里 50 个节点导进来 0 个，
 * 界面上不说原因，只会被当成导入功能坏了。这里把跳过的条目按原因聚合
 * 回报，让面板能明确写出「这 48 个是 Chrome 不支持的协议，需要本地内核转换」。
 */

import { effectiveProxyScheme } from '@/lib/proxy/proxy-config';
import type { ProxyConfig } from '@/types';

/** 解析出来的可用节点，形状与 ProxyConfig 对齐（缺 id，导入时才生成） */
export type ParsedProxyNode = Omit<ProxyConfig, 'id'>;

/** 跳过某条目的原因 */
export type SkipReason =
  /** 协议本身 Chrome 用不了（vless/vmess/trojan/ss...） */
  | 'unsupported-scheme'
  /** 协议对但字段缺失或格式坏了 */
  | 'malformed';

/** 按原因聚合的跳过统计。scheme 仅 unsupported-scheme 有意义 */
export interface SkippedGroup {
  reason: SkipReason;
  /** 原始协议名，小写，不含 `://` */
  scheme?: string;
  count: number;
}

export interface SubscriptionParseResult {
  nodes: ParsedProxyNode[];
  skipped: SkippedGroup[];
  /** 去重掉的重复节点数（同 scheme://host:port） */
  duplicates: number;
  /**
   * Chrome 用不了、但本地内核能用的节点名，按订阅顺序。
   *
   * 只计数不留名字的话，「帮你生成 Clash listeners 配置」就无从下手 ——
   * listener 的 `proxy:` 字段必须填节点在订阅里的原名，一个字都不能差。
   */
  unsupportedNames: string[];
  /** 识别出的载荷格式，用于界面提示 */
  format: 'base64' | 'uri-list' | 'clash-yaml' | 'unknown';
}

const SUPPORTED_SCHEMES = new Set<ProxyConfig['scheme']>(['http', 'https', 'socks4', 'socks5']);

/**
 * 机场公告行的特征词。
 *
 * 机场普遍往 `proxies:` 里塞几条假节点来显示流量和到期日 —— 实测某订阅头三条
 * 就是「剩余流量：370.58 GB」「套餐到期：长期有效」「过滤掉11条线路」，
 * 它们带着合法的 server/port，协议判定上与真节点没有区别。
 *
 * 不剔掉的话它们会进仅名称清单，用户看到「剩余流量：370.58 GB」被当成节点
 * 只会以为导入逻辑坏了。
 */
const AIRPORT_NOTICE_WORDS = [
  '剩余流量', '套餐到期', '过滤掉', '距离下次', '重置', '官网', '订阅', '有效期',
  '到期时间', '剩余时间', '流量重置', '请勿', '群组', '客服', 'telegram', '教程',
  // 真机实测补充:机场常把「拉群/防失联」也塞进节点列表,名字里带域名或社交链接。
  // 这类条目不是节点,但带合法 server/port,只有按关键词才能识别。
  '电报群', '防失联', 't.me', 'github.com', '客户端', '官网使用文档', '发布页', '频道',
];

function isAirportNotice(name: string): boolean {
  const text = name.trim().toLowerCase();
  if (!text) return true;
  return AIRPORT_NOTICE_WORDS.some((word) => text.includes(word.toLowerCase()));
}

/** socks:// 不带版本号时按 socks5 处理，与主流客户端一致 */
const SCHEME_ALIASES: Record<string, ProxyConfig['scheme']> = {
  http: 'http',
  https: 'https',
  socks: 'socks5',
  socks4: 'socks4',
  socks5: 'socks5',
  socks5h: 'socks5',
};

const DEFAULT_PORTS: Record<ProxyConfig['scheme'], number> = {
  http: 80,
  https: 443,
  socks4: 1080,
  socks5: 1080,
};

/** 解析一份订阅内容 */
export function parseSubscription(raw: string): SubscriptionParseResult {
  const text = raw.trim();
  if (!text) return { nodes: [], skipped: [], duplicates: 0, unsupportedNames: [], format: 'unknown' };

  if (looksLikeClashYaml(text)) return finalize(parseClashYaml(text), 'clash-yaml');

  const decoded = decodeBase64Payload(text);
  if (decoded !== null) return finalize(parseUriList(decoded), 'base64');

  const direct = parseUriList(text);
  const sawAnything = direct.nodes.length > 0 || direct.skips.length > 0;
  return finalize(direct, sawAnything ? 'uri-list' : 'unknown');
}

interface RawParse {
  nodes: ParsedProxyNode[];
  skips: { reason: SkipReason; scheme?: string; name?: string }[];
}

/**
 * 去重 + 聚合统计。
 *
 * 去重按 scheme://host:port —— 同一出口在订阅里出现多次（不同分组、不同备注）
 * 很常见，全导进去会让「一账号一节点」的轮转分配把多个账号绑到同一个出口，
 * 等于没做隔离。
 */
function finalize(parse: RawParse, format: SubscriptionParseResult['format']): SubscriptionParseResult {
  const seen = new Set<string>();
  const nodes: ParsedProxyNode[] = [];
  let duplicates = 0;

  for (const node of parse.nodes) {
    const key = `${node.scheme}://${node.host.toLowerCase()}:${node.port}`;
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    nodes.push(node);
  }

  const groups = new Map<string, SkippedGroup>();
  const unsupportedNames: string[] = [];
  const seenNames = new Set<string>();
  for (const skip of parse.skips) {
    const key = `${skip.reason}:${skip.scheme ?? ''}`;
    const existing = groups.get(key);
    if (existing) existing.count += 1;
    else groups.set(key, { reason: skip.reason, ...(skip.scheme ? { scheme: skip.scheme } : {}), count: 1 });

    // 只留「协议不支持」的名字：格式坏掉的条目本地内核也用不了。
    // 同名去重；机场塞的公告行也要剔掉，它们不是节点。
    if (
      skip.reason === 'unsupported-scheme'
      && skip.name
      && !seenNames.has(skip.name)
      && !isAirportNotice(skip.name)
    ) {
      seenNames.add(skip.name);
      unsupportedNames.push(skip.name);
    }
  }

  const skipped = [...groups.values()].sort((a, b) => b.count - a.count || (a.scheme ?? '').localeCompare(b.scheme ?? ''));
  return { nodes, skipped, duplicates, unsupportedNames, format };
}

/**
 * 整体 base64 解码。
 *
 * 机场订阅最常见的形态就是「把 URI 列表整块 base64」。解不出或解出来
 * 不像 URI 列表就返回 null，让调用方按明文再试一次 —— 不能只看能否
 * base64 解码，因为明文 URI 列表本身也可能碰巧是合法 base64 字符集。
 */
function decodeBase64Payload(text: string): string | null {
  const compact = text.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) return null;

  try {
    // 订阅常用 URL-safe 变体
    const normalized = compact.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const decoded = decodeUtf8(atob(padded));
    // 解出来必须含 `://`，否则说明这不是订阅载荷（比如一串纯 token）
    return decoded.includes('://') ? decoded : null;
  } catch {
    return null;
  }
}

/** atob 得到的是字节串，节点名多为中文，必须按 UTF-8 再解一次 */
function decodeUtf8(binary: string): string {
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** 按行解析 URI 列表 */
function parseUriList(text: string): RawParse {
  const result: RawParse = { nodes: [], skips: [] };

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^[-*]\s+/, '');
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(trimmed);
    if (!match) {
      const bare = parseBareEndpoint(trimmed);
      if (bare) result.nodes.push(bare);
      continue;
    }

    const scheme = match[1]!.toLowerCase();
    const mapped = SCHEME_ALIASES[scheme];
    if (!mapped || !SUPPORTED_SCHEMES.has(mapped)) {
      const name = nodeNameOf(scheme, match[2]!);
      result.skips.push({ reason: 'unsupported-scheme', scheme, ...(name ? { name } : {}) });
      continue;
    }

    const node = parseProxyUri(mapped, match[2]!);
    if (node) result.nodes.push(node);
    else result.skips.push({ reason: 'malformed', scheme });
  }

  return result;
}

/** `host:port`、`host port` 与 `socks5 host:port` 的简写。 */
function parseBareEndpoint(text: string): ParsedProxyNode | null {
  const match = /^(?:(https?|socks4|socks5|socks)\s+)?(\[[^\]]+\]|[^\s:@]+)(?::|\s+)(\d{1,5})$/i.exec(text);
  if (!match) return null;
  const scheme = SCHEME_ALIASES[(match[1] ?? 'http').toLowerCase()];
  const host = match[2];
  const port = Number(match[3]);
  if (!scheme || !host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    name: `${host.replace(/^\[|\]$/g, '')}:${port}`,
    scheme: effectiveProxyScheme({ scheme, host }),
    host: host.replace(/^\[|\]$/g, ''),
    port,
    sourceLabel: '手动导入',
  };
}

/**
 * 取一个「Chrome 用不了」节点在订阅里的显示名。
 *
 * 生成 Clash listener 时 `proxy:` 必须填这个名字，所以取名规则要跟客户端一致：
 *  - vmess 把整个配置 base64 成 JSON，名字在 `ps` 字段里，URI 上没有 fragment
 *  - vless / trojan / ss 等沿用 `#名字` fragment
 */
function nodeNameOf(scheme: string, body: string): string | null {
  if (scheme === 'vmess') {
    const decoded = tryBase64(body.split(/[?#]/)[0] ?? '');
    if (!decoded) return null;
    try {
      const config = JSON.parse(decoded) as Record<string, unknown>;
      const ps = config.ps ?? config.remarks;
      return typeof ps === 'string' && ps.trim() ? ps.trim() : null;
    } catch {
      return null;
    }
  }

  const hashAt = body.indexOf('#');
  if (hashAt < 0) return null;
  const label = safeDecode(body.slice(hashAt + 1)).trim();
  return label || null;
}

/**
 * 解析 `[user:pass@]host:port[#name]` 主体。
 *
 * 不用 `new URL()`：socks5:// 在部分实现里不是 special scheme，
 * URL 解析对 host/port 的处理不一致，自己切更可控。
 */
function parseProxyUri(scheme: ProxyConfig['scheme'], body: string): ParsedProxyNode | null {
  const hashAt = body.indexOf('#');
  const label = hashAt >= 0 ? safeDecode(body.slice(hashAt + 1)).trim() : '';
  let authority = hashAt >= 0 ? body.slice(0, hashAt) : body;

  // 去掉路径与查询：代理 URI 里没有意义
  authority = authority.split(/[/?]/)[0] ?? '';
  if (!authority) return null;

  let credentials = '';
  const atAt = authority.lastIndexOf('@');
  if (atAt >= 0) {
    credentials = authority.slice(0, atAt);
    authority = authority.slice(atAt + 1);
  }

  const endpoint = splitHostPort(authority);
  if (!endpoint) return null;

  const port = endpoint.port ?? DEFAULT_PORTS[scheme];
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;

  const { username, password } = splitCredentials(credentials);

  return {
    name: label || `${endpoint.host}:${port}`,
    // 本地 https 代理握不了手，沿用池内既有的修正规则
    scheme: effectiveProxyScheme({ scheme, host: endpoint.host }),
    host: endpoint.host,
    port,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
  };
}

/** 拆 host 与 port，兼容 IPv6 的 `[::1]:1080` 写法 */
function splitHostPort(authority: string): { host: string; port?: number } | null {
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close < 0) return null;
    const host = authority.slice(0, close + 1);
    const rest = authority.slice(close + 1);
    if (!rest) return { host };
    if (!rest.startsWith(':')) return null;
    return { host, port: toPort(rest.slice(1)) ?? undefined };
  }

  const colon = authority.lastIndexOf(':');
  if (colon < 0) return authority ? { host: authority } : null;

  const host = authority.slice(0, colon);
  const port = toPort(authority.slice(colon + 1));
  if (!host || port == null) return null;
  return { host, port };
}

function toPort(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const port = Number(raw);
  return port > 0 && port <= 65535 ? port : null;
}

/**
 * 拆认证信息。
 *
 * 有些订阅把 `user:pass` 整段 base64 后放在 userinfo 位（ss:// 的习惯，
 * 偶尔也出现在 http://），所以先试着解一次。
 */
function splitCredentials(raw: string): { username?: string; password?: string } {
  if (!raw) return {};

  let text = safeDecode(raw);
  if (!text.includes(':')) {
    const decoded = tryBase64(text);
    if (decoded?.includes(':')) text = decoded;
  }

  const colon = text.indexOf(':');
  if (colon < 0) return text ? { username: text } : {};
  const username = text.slice(0, colon);
  const password = text.slice(colon + 1);
  return {
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
  };
}

function tryBase64(text: string): string | null {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) return null;
  try {
    const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
    return decodeUtf8(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')));
  } catch {
    return null;
  }
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Clash/mihomo 配置的判定：有 proxies: 段就按 YAML 走 */
function looksLikeClashYaml(text: string): boolean {
  return /^\s*proxies\s*:/m.test(text);
}

/**
 * 极简 Clash YAML 提取。
 *
 * 不引 YAML 依赖：这里只需要 proxies 段里 type 为 http/socks5 的条目，
 * 面向行扫描足够，且不会因为一个依赖把扩展体积推上去。
 * 解析不出的条目一律计入跳过并带上 type，界面照样能说清原因。
 */
function parseClashYaml(text: string): RawParse {
  const result: RawParse = { nodes: [], skips: [] };
  const lines = text.split(/\r?\n/);

  let inProxies = false;
  let entry: string[] = [];

  const flush = () => {
    if (!entry.length) return;
    const node = parseClashEntry(entry.join('\n'), result);
    if (node) result.nodes.push(node);
    entry = [];
  };

  for (const line of lines) {
    if (/^\s*proxies\s*:/.test(line)) {
      inProxies = true;
      continue;
    }
    if (!inProxies) continue;

    // 顶格的新键（proxy-groups: / rules: 之类）意味着 proxies 段结束
    if (/^[^\s#-]/.test(line)) {
      flush();
      inProxies = false;
      continue;
    }

    if (/^\s*-\s/.test(line)) {
      flush();
      entry.push(line.replace(/^\s*-\s/, ''));
      continue;
    }
    if (entry.length && line.trim()) entry.push(line.trim());
  }
  flush();

  return result;
}

function parseClashEntry(chunk: string, result: RawParse): ParsedProxyNode | null {
  const type = readYamlValue(chunk, 'type')?.toLowerCase();
  if (!type) return null;

  const mapped = SCHEME_ALIASES[type];
  if (!mapped || !SUPPORTED_SCHEMES.has(mapped)) {
    const label = readYamlValue(chunk, 'name');
    result.skips.push({ reason: 'unsupported-scheme', scheme: type, ...(label ? { name: label } : {}) });
    return null;
  }

  const host = readYamlValue(chunk, 'server');
  const port = toPort(readYamlValue(chunk, 'port') ?? '');
  if (!host || port == null) {
    result.skips.push({ reason: 'malformed', scheme: type });
    return null;
  }

  // Clash 用 `type: http` + `tls: true` 表达 https 代理
  const tls = readYamlValue(chunk, 'tls')?.toLowerCase() === 'true';
  const scheme: ProxyConfig['scheme'] = mapped === 'http' && tls ? 'https' : mapped;
  const username = readYamlValue(chunk, 'username');
  const password = readYamlValue(chunk, 'password');
  const name = readYamlValue(chunk, 'name');

  return {
    name: name || `${host}:${port}`,
    scheme: effectiveProxyScheme({ scheme, host }),
    host,
    port,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
  };
}

/** 读一个 YAML 标量，兼容 `{a: 1, b: 2}` 流式写法与引号 */
function readYamlValue(chunk: string, key: string): string | null {
  const match = new RegExp(`(?:^|[\\s{,])${key}\\s*:\\s*([^,}\\n]+)`, 'i').exec(chunk);
  if (!match) return null;
  const value = match[1]!.trim().replace(/\s+#.*$/, '').trim();
  const unquoted = /^(['"])(.*)\1$/.exec(value);
  return (unquoted ? unquoted[2]! : value).trim() || null;
}
