/**
 * 由订阅里的节点名生成 mihomo / Clash.Meta 的 listeners 配置（YAML 与 ES5 Script）。
 *
 * 为什么需要这一步：chrome.proxy 只认 http/https/socks4/socks5，而机场订阅
 * 几乎全是 vmess/vless/trojan/ss —— 浏览器根本无法直连。让本地内核为每个
 * 节点各开一个监听端口，浏览器就只跟 127.0.0.1:<port> 说普通 HTTP，加密
 * 那一段交给内核，而且「每个账号一个出口」的隔离才能成立。
 *
 * 端口必须按**节点名**锁定而不是按订阅顺序：机场每 10 分钟自动更新、节点
 * 顺序会变。按下标分配端口会让「新加坡01aws」在上次同步后从 :7901 漂到
 * :7902，绑在 7901 上的账号就悄悄换了个出口 —— 站点按异地登录风控。所以
 * 这里的一切都围绕一份持久化的「名字 → 端口」映射展开：老节点保留老端口，
 * 新节点拿最小空闲端口，被删节点的端口保留为空洞不复用。
 *
 * 零干扰约束：本模块只产出**文本**（YAML / Script），绝不写任何 Clash/Verge
 * 文件或设置。真正的落地是用户本人把文本粘进「扩展配置」并重载。
 */

import type { ProxyConfig } from '@/types';

/** 兼容旧调用方的导出名：新节点默认从 7901 起搜。 */
export const DEFAULT_LISTENER_START_PORT = 7901;

/**
 * 保护区端口。Clash Verge 默认占用 7897(mixed) 7898(socks) 7899(http)；
 * 1053 常被内核 DNS 监听；9090-9099 是 external-controller 惯用区间。
 * 端口分配永远跳过这些值，避免「生成完就冲突」。
 */
export const RESERVED_PORTS = [
  1053, 7890, 7891, 7897, 7898, 7899,
  ...Array.from({ length: 10 }, (_, i) => 9090 + i),
];

const DEFAULT_START = DEFAULT_LISTENER_START_PORT;
const LOOPBACK = '127.0.0.1';
const MAX_PORT = 65535;

export interface ListenerPlanEntry {
  /** 订阅里的节点原名，也是 listener 的 proxy: 值 */
  nodeName: string;
  /** 分配到的本地端口 */
  port: number;
  /** listener 的 name:，内核要求唯一；按端口命名保证重启后可复现 */
  listenerName: string;
}

export interface ListenerPlan {
  entries: ListenerPlanEntry[];
  /** 可直接粘进配置文件的 YAML 兼容片段（静态模式） */
  yaml: string;
  /** 可粘进「扩展配置 → Script」的 ES5 脚本（自动模式，重载自动重建） */
  script: string;
  /** 与 entries 一一对应的代理池条目 */
  poolEntries: Omit<ProxyConfig, 'id'>[];
  /** 因端口越界而没能分配的节点数 */
  dropped: number;
}

/**
 * 计算一个「下标无关」的下一个可用端口。
 *
 * 保护端口、已用端口、并发数一起传进来；返回 ≥ start 的最小空闲值。
 * 纯函数，供 buildListenerPlan / drift 追加共用，保证两端算法一致。
 */
export function nextFreePort(
  start: number,
  used: ReadonlySet<number>,
  reserved: readonly number[],
): number {
  const blocked = new Set([...used, ...reserved]);
  for (let port = Math.max(1, start); port <= MAX_PORT; port++) {
    if (!blocked.has(port)) return port;
  }
  return NaN;
}

/**
 * 按映射生成 listeners 计划。
 *
 * @param nodeNames   本次订阅里的节点名（顺序无关紧要，映射才是权威）
 * @param startPort   新节点的起始搜索位置（默认 7901）
 * @param reserved    保护区端口（默认 RESERVED_PORTS，需要自定义时传入）
 * @param existing    已持久化的名字→端口映射；缺省视为空（首次生成）
 */
export function buildListenerPlan(
  nodeNames: readonly string[],
  startPort: number = DEFAULT_START,
  reserved: readonly number[] = RESERVED_PORTS,
  existing: readonly ListenerPlanEntry[] = [],
): ListenerPlan {
  const base = Number.isInteger(startPort) && startPort > 0 && startPort <= MAX_PORT
    ? startPort
    : DEFAULT_START;

  // 去掉名字里的首尾空白；订阅偶尔在名字首尾塞空格，trim 后才是内核看到的名字
  const wanted: string[] = [];
  for (const raw of nodeNames) {
    const name = String(raw ?? '').trim();
    if (name && !wanted.includes(name)) wanted.push(name);
  }
  if (!wanted.length) {
    return { entries: [], yaml: '', script: '', poolEntries: [], dropped: 0 };
  }

  // 老映射按名字索引（中去重），端口占用按老条目先占坑
  const oldByName = new Map<string, number>();
  const used = new Set<number>(reserved);
  for (const entry of existing) {
    const name = String(entry?.nodeName ?? '').trim();
    const port = Number(entry?.port);
    if (!name || !Number.isInteger(port) || port < 1 || port > MAX_PORT) continue;
    if (!oldByName.has(name)) oldByName.set(name, port);
    used.add(port);
  }

  const reservedSet = new Set(reserved);
  const entries: ListenerPlanEntry[] = [];
  let dropped = 0;

  for (const name of wanted) {
    const prior = oldByName.get(name);
    if (prior != null && !reservedSet.has(prior)) {
      // 老节点保留老端口 —— 这是「账号不换出口」的全部意义所在
      entries.push({ nodeName: name, port: prior, listenerName: `hub-${prior}` });
      continue;
    }
    const port = nextFreePort(base, used, reserved);
    if (!Number.isInteger(port) || port > MAX_PORT) {
      dropped += 1;
      continue;
    }
    used.add(port);
      entries.push({ nodeName: name, port, listenerName: `hub-${port}` });
  }

  // 输出按端口排序:与订阅里的顺序解耦,同一份映射在任何机器上呈现一致
  entries.sort((a, b) => a.port - b.port);

  const yaml = renderYaml(entries);
  return {
    entries,
    yaml,
    script: renderScript(entries),
    poolEntries: entries.map((entry) => ({
      name: entry.nodeName,
      scheme: 'http' as const,
      host: LOOPBACK,
      port: entry.port,
    })),
    dropped,
  };
}

/**
 * 与订阅同步计算漂移：老映射里哪些名字还活着、订阅里来了哪些新名字。
 * 用于 UI 横幅与「需要重粘 Script」提示。纯函数。
 */
export interface ListenerDrift {
  /** 老映射中、订阅里仍然存在的条目（端口不变） */
  kept: ListenerPlanEntry[];
  /** 订阅里新增、老映射没有的名字 */
  addedNames: string[];
  /** 老映射里、订阅里已经消失的名字 */
  removed: ListenerPlanEntry[];
}

export function diffListenerPlan(
  nodeNames: readonly string[],
  existing: readonly ListenerPlanEntry[],
): ListenerDrift {
  const current = new Set<string>();
  for (const raw of nodeNames) {
    const name = String(raw ?? '').trim();
    if (name) current.add(name);
  }
  const kept: ListenerPlanEntry[] = [];
  const removed: ListenerPlanEntry[] = [];
  const seen = new Set<string>();
  for (const entry of existing) {
    const name = String(entry?.nodeName ?? '').trim();
    const port = Number(entry?.port);
    if (!name || !Number.isInteger(port)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    (current.has(name) ? kept : removed).push({
      nodeName: name,
      port,
      listenerName: `hub-${port}`,
    });
  }
  const addedNames: string[] = [];
  for (const name of current) {
    if (!seen.has(name)) addedNames.push(name);
  }
  return { kept, addedNames, removed };
}

function renderYaml(entries: readonly ListenerPlanEntry[]): string {
  if (!entries.length) return '';
  const lines = ['listeners:'];
  for (const entry of entries) {
    lines.push(
      `  - name: ${entry.listenerName}`,
      '    type: mixed',
      `    port: ${entry.port}`,
      `    listen: ${LOOPBACK}`,
      `    proxy: ${quote(entry.nodeName)}`,
    );
  }
  return lines.join('\n');
}

/**
 * 生成 Clash Verge「扩展配置 → Script」的 ES5 脚本。
 *
 * 为什么是 Script 而不是静态 YAML：订阅每 10 分钟自动更新，静态块会被
 * 冲掉；Script 在**每次**订阅更新/重载时由 Verge 重新执行，拿当前配置里的
 * 节点列表按映射重建 listeners —— 用户粘一次就长期有效。
 *
 * 为什么内嵌映射而不是现场分配：扩展是端口的权威记录者，内嵌固定映射
 * 保证「同一节点同一端口」在任何机器、任何时刻都成立（备份恢复也一样）。
 * 脚本只负责执行，不做任何决策。
 *
 * ES5：Verge 的脚本环境是老 quickjs/boa 兼容形态，不用箭头函数、模板串、
 * let/const、展开运算符 —— 这些在部分内核上会直接抛语法错误。
 */
function renderScript(entries: readonly ListenerPlanEntry[]): string {
  if (!entries.length) return '';
  const lines: string[] = [
    '// 由「自助签到中转站」扩展生成 —— 一节点一本地端口，按名字锁定端口不漂移。',
    '// 粘到 Clash Verge 对应订阅的「扩展配置 → Script」里；想完全回滚就清空这个文件再重载。',
    'function main(config) {',
    '  if (!config) return config;',
    '  var map = {',
  ];
  for (const entry of entries) {
    lines.push(`    ${jsQuote(entry.nodeName)}: ${entry.port},`);
  }
  lines.push(
    '  };',
    '  var listeners = [];',
    '  for (var key in map) {',
    '    if (!Object.prototype.hasOwnProperty.call(map, key)) continue;',
    '    listeners.push({',
    "      name: 'hub-' + map[key],",
    "      type: 'mixed',",
    '      port: map[key],',
    "      listen: '127.0.0.1',",
    '      proxy: key,',
    '    });',
    '  }',
    '  config.listeners = listeners;',
    '  return config;',
    '}',
  );
  return lines.join('\n');
}
/**
 * 需要按码位转义的危险字符：除 \t\n\r 外的 C0 控制符（U+0000–U+001F）、DEL（U+007F）、
 * NEL（U+0085），以及 Unicode 行/段分隔符 U+2028/U+2029。后两者是 JS 的行终止符，
 * 直接写进正则字面量会触发语法错误，故用 fromCharCode 拼进字符类，运行期才成型。
 */
const CONTROL_CHAR_PATTERN = new RegExp(
  `[\\u0000-\\u001f\\u007f\\u0085${String.fromCharCode(0x2028, 0x2029)}]`,
  'g',
);

/**
 * 节点名一律加双引号。
 *
 * 机场节点名里常见 `|`、`:`、`#`、emoji、前导空格 —— 这些在 YAML 里都有
 * 特殊含义或会被裁掉，裸写会让内核解析失败或把名字读错，而名字读错就等于
 * `proxy:` 匹配不上任何节点。
 *
 * 更要命的是名字完全不可信：它来自订阅（vmess 的 ps/remarks、URI 的 #fragment），
 * 只做过 trim，内部的换行等控制字符原样留着。仅转义 `\` 和 `"` 挡不住换行 ——
 * 带换行的名字能从引号标量里逃逸出去，凭空注入 YAML 键甚至整条 listener（比如
 * 把某端口绑到 `proxy: DIRECT`），悄悄废掉每账号一出口的隔离。所以这里把
 * 换行/回车/制表转成 `\n`/`\r`/`\t`，其余 C0 控制符（U+0000–U+001F）、DEL（U+007F）
 * 以及 Unicode 行/段分隔符 U+0085/U+2028/U+2029 一律转成 `\xHH`/`\uHHHH`，
 * 保证产出永远是单行、可原样还原的双引号标量，杜绝不可信节点名的 YAML 注入。
 */
function quote(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    // 到这里换行/回车/制表已转义，剩下的控制符与行/段分隔符按码位转成 \xHH/\uHHHH
    .replace(CONTROL_CHAR_PATTERN, (ch) => {
      const code = ch.charCodeAt(0);
      return code <= 0xff
        ? `\\x${code.toString(16).toUpperCase().padStart(2, '0')}`
        : `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
    });
  return `"${escaped}"`;
}

/** 从 Mihomo /listeners 的数组或对象响应中提取端口到节点名的映射。 */
export function parseClashListenerResponse(body: unknown, wanted: ReadonlySet<number>): Map<number, string> {
  const result = new Map<number, string>();
  const candidates: unknown[] = Array.isArray(body)
    ? body
    : body && typeof body === 'object' && Array.isArray((body as { listeners?: unknown }).listeners)
      ? (body as { listeners: unknown[] }).listeners
      : body && typeof body === 'object' && (body as { listeners?: unknown }).listeners && typeof (body as { listeners?: unknown }).listeners === 'object'
        ? Object.values((body as { listeners: Record<string, unknown> }).listeners)
        : [];

  for (const item of candidates) {
    if (!item || typeof item !== 'object') continue;
    const record = item as { port?: unknown; proxy?: unknown; name?: unknown };
    const port = typeof record.port === 'number' ? record.port : Number(record.port);
    const name = typeof record.proxy === 'string' && record.proxy.trim()
      ? record.proxy.trim()
      : typeof record.name === 'string' && record.name.trim() ? record.name.trim() : '';
    if (Number.isInteger(port) && wanted.has(port) && name) result.set(port, name);
  }
  return result;
}

const MIN_PORT = 1;
const MAX_PORT_LIMIT = 65535;
const MAX_EXTERNAL_NAME_LENGTH = 200;

const RESERVED_EXIT_NAMES = new Set([
  'COMPATIBLE', 'DIRECT', 'GLOBAL', 'PASS', 'REJECT', 'REJECT-DROP',
]);

const BUILTIN_LISTENER_TYPES = new Set([
  'compatible', 'direct', 'pass', 'reject', 'rejectdrop',
]);

/**
 * 从 /listeners 响应里筛出「绑定到具体节点、端口合法」的本地出口。
 * 丢弃规则与原实现一致：坏形状 / 端口不合法或重复 / 保留名 / 内建类型全跳过。
 */
export function parseClashListenerExits(body: unknown): ClashListenerExit[] {
  const exits: ClashListenerExit[] = [];
  const seenPorts = new Set<number>();

  for (const item of extractListenerCandidates(body)) {
    if (!isRecord(item)) continue;
    const port = parseListenerPort(item.port);
    if (port === null || seenPorts.has(port)) continue;
    const listenerName = normalizeExternalName(item.name);
    const nodeName = normalizeExternalName(item.proxy);
    if (!listenerName || !nodeName) continue;
    const listenerType = normalizeType(item.type);
    if (BUILTIN_LISTENER_TYPES.has(listenerType)) continue;
    if (RESERVED_EXIT_NAMES.has(nodeName.toUpperCase())) continue;

    seenPorts.add(port);
    exits.push({ listenerName, nodeName, port, listenerType });
  }
  return exits;
}

export interface ClashListenerExit {
  listenerName: string;
  nodeName: string;
  port: number;
  listenerType: string;
}

/** 转成代理池条目；mixed/http 说 HTTP，只有明确 socks 才用 socks5。 */
export function listenerExitToPoolEntry(exit: ClashListenerExit): Omit<ProxyConfig, 'id'> {
  return {
    name: exit.nodeName,
    scheme: exit.listenerType === 'socks' ? 'socks5' : 'http',
    host: LOOPBACK,
    port: exit.port,
    sourceLabel: 'Clash Verge',
  };
}

function extractListenerCandidates(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (!isRecord(body)) return [];
  const listeners = body.listeners;
  if (Array.isArray(listeners)) return listeners;
  if (isRecord(listeners)) return Object.values(listeners);
  return [];
}

function parseListenerPort(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < MIN_PORT || value > MAX_PORT_LIMIT) return null;
  return value;
}

function normalizeExternalName(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_EXTERNAL_NAME_LENGTH) return '';
  return trimmed;
}

function normalizeType(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[\s_-]+/g, '')
    : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * JS 字符串字面量转义（内嵌进 Script 的节点名键）。
 * 单引号/双引号/反引号/反斜杠都转；控制符与 YAML quote 一致按码位剥离。
 */
function jsQuote(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'")
    .replace(/`/g, '\\`')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(CONTROL_CHAR_PATTERN, '');
  return '"' + escaped + '"';
}
