/**
 * 出站 fetch 的 SSRF 闸门。
 *
 * background service worker 持有 `<all_urls>` host permission，能直接 fetch
 * 页面脚本因同源/CORS 碰不到的地址 —— 包括 loopback、RFC1918 内网、CGNAT，
 * 以及云厂商元数据服务（169.254.169.254）。凡是把「用户填的 URL」交给
 * background 去拉取、再把响应体回吐给管理页的接口（拉订阅、探测站点），都得
 * 先过这道闸门，否则页面能借扩展当跳板扫内网、读元数据。
 *
 * 判据是**主机字面量**：URL 解析层已把十六进制/八进制/整数写法的 IPv4
 * （0x7f000001、2130706433、127.1）和压缩写法的 IPv6 规整成标准形式，
 * 所以这里只需按标准形状匹配保留网段。
 *
 * ⚠️ 只能拦「IP 字面量 / 明显的本机域名」这类 SSRF，拦不住 DNS-rebinding
 * ——即一个公网域名解析到内网 IP 的情形：SW 的 fetch 不暴露解析后的地址，
 * 这里拿不到真正连上的 IP。要彻底防住得在网络层按解析结果二次校验。
 */

/** IPv6 定长 8 段，用元组让下标访问在 noUncheckedIndexedAccess 下仍是 number */
type Hextets = [number, number, number, number, number, number, number, number];

/** 32 位 IPv4 整数是否落在需要拦截的保留网段内 */
function isBlockedIpv4(ip: number): boolean {
  const a = Math.floor(ip / 0x1000000) % 256; // 首字节
  const b = Math.floor(ip / 0x10000) % 256;   // 次字节
  if (a === 0) return true;                          // 0.0.0.0/8「本网络」，含 0.0.0.0
  if (a === 127) return true;                        // 127.0.0.0/8   回环
  if (a === 10) return true;                         // 10.0.0.0/8    RFC1918 私网
  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12 RFC1918 私网
  if (a === 192 && b === 168) return true;           // 192.168.0.0/16 RFC1918 私网
  if (a === 169 && b === 254) return true;           // 169.254.0.0/16 链路本地（含云元数据）
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 运营商级 NAT
  return false;
}

/** 标准点分四段 IPv4 转 32 位整数；非此形状返回 null（URL 已把其它写法规整成这种） */
function parseIpv4(host: string): number | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) { // for..of 拿到 string 本身，不触发未检索引
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

/**
 * 解析 IPv6 为 8 段 16 位整数（传入前已去掉方括号）。
 *
 * 处理 `::` 零压缩，以及结尾内嵌的点分 IPv4（`::ffff:a.b.c.d`）—— 后者先
 * 折成两段十六进制再统一按段解析。非法形状返回 null。
 */
function parseIpv6(input: string): Hextets | null {
  if (!input.includes(':')) return null;

  let host = input;
  // 结尾的点分四段（IPv4-mapped / 兼容写法）：折成两个 16 位段
  const embedded = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (embedded) {
    const v4 = parseIpv4(embedded[1] ?? '');
    if (v4 === null) return null;
    const hi = (Math.floor(v4 / 0x10000) % 0x10000).toString(16); // 高 16 位
    const lo = (v4 % 0x10000).toString(16);                       // 低 16 位
    host = `${host.slice(0, embedded.index + 1)}${hi}:${lo}`;
  }

  const halves = host.split('::');
  if (halves.length > 2) return null; // `::` 至多出现一次

  const groupsOf = (segment: string): number[] | null => {
    if (segment === '') return [];
    const out: number[] = [];
    for (const part of segment.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      out.push(parseInt(part, 16));
    }
    return out;
  };

  if (halves.length === 2) {
    const head = groupsOf(halves[0] ?? '');
    const tail = groupsOf(halves[1] ?? '');
    if (!head || !tail) return null;
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null; // `::` 至少压掉一组零
    const all = [...head, ...Array.from({ length: missing }, () => 0), ...tail];
    return all.length === 8 ? (all as Hextets) : null;
  }

  const groups = groupsOf(host);
  return groups && groups.length === 8 ? (groups as Hextets) : null;
}

/** 8 段整数是否落在需要拦截的 IPv6 保留段内 */
function isBlockedIpv6(groups: Hextets): boolean {
  if (groups.every((g) => g === 0)) return true;                                // :: 未指定地址
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1 回环

  // ::ffff:a.b.c.d（mapped）/ ::a.b.c.d（compat）：取内嵌 IPv4 复用点分规则
  const head5Zero = groups.slice(0, 5).every((g) => g === 0);
  const mapped = head5Zero && groups[5] === 0xffff;
  const compat = head5Zero && groups[5] === 0 && (groups[6] !== 0 || groups[7] !== 0);
  if (mapped || compat) return isBlockedIpv4(groups[6] * 0x10000 + groups[7]);

  if (groups[0] >= 0xfc00 && groups[0] <= 0xfdff) return true; // fc00::/7 唯一本地地址
  if (groups[0] >= 0xfe80 && groups[0] <= 0xfebf) return true; // fe80::/10 链路本地
  return false;
}

/**
 * 主机是否指向本机 / 内网，需要拒绝出站。
 *
 * 既接受裸主机名，也接受 `URL.hostname` 给出的带方括号 IPv6（如 `[::1]`）。
 * 命中任一保留网段或本机/内网域名后缀即返回 true。
 */
export function isBlockedFetchHost(hostname: string): boolean {
  // 归一化：去空白、转小写、剥掉 IPv6 方括号、去掉 FQDN 末尾的点
  // （`localhost.` 会解析到本机，不去点就能绕过后缀判断）
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return true; // 空主机无从校验，一律拒绝

  const ipv4 = parseIpv4(host);
  if (ipv4 !== null) return isBlockedIpv4(ipv4); // 用 !== null：0.0.0.0 会解析成 0
  const ipv6 = parseIpv6(host);
  if (ipv6) return isBlockedIpv6(ipv6);

  // 非 IP 字面量：本机与内网的保留域名后缀
  if (host === 'localhost') return true;
  return host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal');
}
