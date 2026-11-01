import type { ProxyConfig } from '@/types';

export interface ClashListenerConfigResult {
  nodes: Omit<ProxyConfig, 'id'>[];
  skipped: number;
  catalog: ClashProxyCatalog;
}

export interface ClashProxyCatalog {
  /** Whether the YAML contains an inline `proxies:` catalog we can reconcile against. */
  detected: boolean;
  /** Unique protocol entries, including obvious traffic/notice placeholders. */
  totalEntries: number;
  /** Actual proxy nodes after removing traffic and subscription notice placeholders. */
  realNodes: number;
  noticeEntries: number;
  /** Real nodes that have at least one fixed local listener. */
  fixedNodes: number;
  /** Real nodes Chrome cannot bind individually because no listener targets them. */
  missingListenerNames: string[];
  /** Valid listeners targeting a selector/url-test/fallback group instead of one node. */
  groupListeners: number;
  /** Valid listeners whose target no longer exists in the proxy or group catalog. */
  staleListeners: number;
}

/**
 * Clash Verge 配置文件的 Windows 默认位置。
 *
 * 界面上要把它显示出来：文件选择对话框里可以直接把这一行粘到地址栏，
 * 不用先在资源管理器里翻。`%APPDATA%` 让它对任何用户名都成立 ——
 * 写死 `C:\Users\<用户名>` 的话，用户往往会把尖括号一起粘进去。
 */
export const CLASH_VERGE_CONFIG_PATH =
  '%APPDATA%\\io.github.clash-verge-rev.clash-verge-rev\\clash-verge.yaml';

type ListenerFields = Record<string, string>;

const SUPPORTED_TYPES: Record<string, ProxyConfig['scheme']> = {
  mixed: 'http',
  http: 'http',
  socks: 'socks5',
  socks5: 'socks5',
  socks4: 'socks4',
};

/** Read fixed Clash/Mihomo listeners from a local configuration file. */
export function parseClashListenerConfig(raw: string): ClashListenerConfigResult {
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/);
  const entries = readTopLevelMappingList(lines, 'listeners');
  const proxyEntries = readTopLevelMappingList(lines, 'proxies');
  const groupEntries = readTopLevelMappingList(lines, 'proxy-groups');

  const proxyNames = new Set(proxyEntries.map((entry) => entry.name?.trim()).filter(Boolean) as string[]);
  const noticeNames = new Set([...proxyNames].filter(isClashNoticeName));
  const realProxyNames = new Set([...proxyNames].filter((name) => !noticeNames.has(name)));
  const groupNames = new Set(groupEntries.map((entry) => entry.name?.trim()).filter(Boolean) as string[]);
  const catalogDetected = proxyEntries.length > 0;

  const nodes: Omit<ProxyConfig, 'id'>[] = [];
  const fixedNames = new Set<string>();
  const seen = new Set<string>();
  let skipped = 0;
  let groupListeners = 0;
  let staleListeners = 0;
  for (const entry of entries) {
    const scheme = SUPPORTED_TYPES[entry.type?.toLowerCase() ?? ''];
    const port = Number(entry.port);
    const name = entry.proxy?.trim();
    if (!scheme || !name || !Number.isInteger(port) || port <= 0 || port > 65535) {
      skipped += 1;
      continue;
    }
    const endpoint = `${scheme}:${port}`;
    if (seen.has(endpoint)) {
      skipped += 1;
      continue;
    }
    seen.add(endpoint);

    if (catalogDetected) {
      if (noticeNames.has(name)) {
        skipped += 1;
        continue;
      }
      if (groupNames.has(name)) {
        groupListeners += 1;
        skipped += 1;
        continue;
      }
      if (!realProxyNames.has(name)) {
        staleListeners += 1;
        skipped += 1;
        continue;
      }
      if (fixedNames.has(name)) {
        skipped += 1;
        continue;
      }
      fixedNames.add(name);
    }
    nodes.push({ name, scheme, host: '127.0.0.1', port, sourceLabel: 'Clash Verge' });
  }

  return {
    nodes,
    skipped,
    catalog: {
      detected: catalogDetected,
      totalEntries: proxyNames.size,
      realNodes: realProxyNames.size,
      noticeEntries: noticeNames.size,
      fixedNodes: catalogDetected ? fixedNames.size : nodes.length,
      missingListenerNames: catalogDetected
        ? [...realProxyNames].filter((name) => !fixedNames.has(name))
        : [],
      groupListeners,
      staleListeners,
    },
  };
}

function readTopLevelMappingList(lines: readonly string[], key: string): ListenerFields[] {
  const entries: ListenerFields[] = [];
  let current: ListenerFields | null = null;
  let inSection = false;
  const header = new RegExp(`^${escapeRegExp(key)}\\s*:\\s*(?:#.*)?$`);

  const flush = () => {
    if (current) entries.push(current);
    current = null;
  };

  for (const line of lines) {
    if (!inSection) {
      if (header.test(line)) inSection = true;
      continue;
    }
    if (/^[^\s#-][^:]*\s*:/.test(line)) {
      flush();
      break;
    }
    const sequence = /^\s*-\s*(.*?)\s*$/.exec(line);
    if (sequence) {
      flush();
      const content = sequence[1]!.trim();
      const item = /^([\w-]+)\s*:\s*(.*?)\s*$/.exec(content);
      if (item) {
        current = {};
        current[item[1]!] = yamlScalar(item[2]!);
      } else if (content.startsWith('{') && content.endsWith('}')) {
        current = readFlowMapping(content);
      } else {
        current = null;
      }
      continue;
    }
    const field = /^\s+([\w-]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (current && field) current[field[1]!] = yamlScalar(field[2]!);
  }
  if (inSection) flush();
  return entries;
}

/**
 * 读取 Clash 配置里常见的 flow mapping：
 * `- { name: 节点, type: vmess, server: example.com, port: 443 }`。
 *
 * 不引入完整 YAML 解析器，只拆最外层逗号；引号、数组和嵌套对象里的逗号
 * 都必须原样保留，否则机场配置中的 `ws-opts` 等字段会把后面的 name/type
 * 错切开。这里实际只消费 name/type/port/proxy 等少数字段，但完整保留其余
 * 标量不会增加复杂度，也让这个列表读取器对两种写法行为一致。
 */
function readFlowMapping(raw: string): ListenerFields {
  const body = raw.trim().slice(1, -1);
  const result: ListenerFields = {};
  for (const field of splitFlowFields(body)) {
    const colon = indexOfFlowColon(field);
    if (colon < 0) continue;
    const key = field.slice(0, colon).trim();
    if (!/^[\w-]+$/.test(key)) continue;
    result[key] = yamlScalar(field.slice(colon + 1));
  }
  return result;
}

function splitFlowFields(value: string): string[] {
  const fields: string[] = [];
  let start = 0;
  let quote = '';
  let escaped = false;
  let depth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quote) {
      if (quote === '"' && char === '\\' && !escaped) {
        escaped = true;
        continue;
      }
      if (char === quote && !escaped) quote = '';
      escaped = false;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '{' || char === '[') {
      depth += 1;
      continue;
    }
    if (char === '}' || char === ']') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (char === ',' && depth === 0) {
      fields.push(value.slice(start, index));
      start = index + 1;
    }
  }
  fields.push(value.slice(start));
  return fields;
}

function indexOfFlowColon(value: string): number {
  let quote = '';
  let escaped = false;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quote) {
      if (quote === '"' && char === '\\' && !escaped) {
        escaped = true;
        continue;
      }
      if (char === quote && !escaped) quote = '';
      escaped = false;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '{' || char === '[') {
      depth += 1;
      continue;
    }
    if (char === '}' || char === ']') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (char === ':' && depth === 0) return index;
  }
  return -1;
}

function isClashNoticeName(name: string): boolean {
  const value = name.trim();
  return /^(?:剩余流量|距离下次重置|套餐到期|有超过.*节点|每次使用前更新订阅|电报群|防失联)/u.test(value)
    || /^(?:remaining\s+traffic|traffic\s+remaining|reset\s+in|expires?\s+(?:in|at|on))/iu.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function yamlScalar(raw: string): string {
  const withoutComment = stripYamlComment(raw.trim()).trim();
  const quoted = /^(['"])([\s\S]*)\1$/.exec(withoutComment);
  if (!quoted) return withoutComment;
  if (quoted[1] === "'") return quoted[2]!.replace(/''/g, "'");
  return quoted[2]!.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function stripYamlComment(value: string): string {
  let quote = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if ((char === '"' || char === "'") && value[index - 1] !== '\\') {
      quote = quote === char ? '' : quote || char;
      continue;
    }
    if (char === '#' && !quote && (index === 0 || /\s/.test(value[index - 1]!))) return value.slice(0, index);
  }
  return value;
}
