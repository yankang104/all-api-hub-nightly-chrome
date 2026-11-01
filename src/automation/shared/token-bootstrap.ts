/**
 * 「会话 cookie → 短命 Bearer 令牌」的引导（新版 new-api 分叉的轮换鉴权）。
 *
 * 背景（一梦五千年 fapi.leileihog.top 实测）：新版前端把登录态做成轮换令牌 ——
 * 页面用会话 cookie `POST /api/user/auth/refresh` 换回 `access_token`，随后所有
 * 接口请求都带 `Authorization: Bearer <token>`；令牌只在内存里，不落 localStorage。
 *
 * 扩展默认的请求头（cookie + user-id 兼容头 + 只在固定几个 localStorage 键里找
 * Bearer）在这类站点上一律 401：余额、签到前后的快照、身份读全部落空。这里按
 * 站点显式配置去换一枚同类令牌，让那三条路恢复。
 *
 * 三条硬约束：
 * 1. **只发同源** —— 配置被改成外域时直接放弃，绝不把会话 cookie 带去别处；
 * 2. **少换、复用** —— 同一个站点 60 秒内最多换一次（并发的调用共享同一个在途请求）：
 *    轮换会让页面正在用的旧令牌失效，换得越勤越容易把用户正在浏览的页面顶掉；
 * 3. **不落盘** —— 令牌只留在内存缓存里，任务结束即失效。
 */
import type { SiteAuthBootstrapConfig, SiteConfig } from '@/types';
import type { StepLog } from '@/automation/shared/log';
import { isSameSiteUrl } from '@/lib/site/site-security';

/** 令牌缓存的存活时间：够覆盖一轮签到，又短到不会拿一个快过期的令牌去请求。 */
const TOKEN_CACHE_TTL_MS = 60_000;
/**
 * 失败也缓存一段（更短）。
 *
 * 不回缓存的话，一轮签到里 before + after 十几次采样、加上若干次身份读取，会对
 * 引导端点连发十几次 POST —— 每次都是一次轮换尝试，正是「别把页面正在用的令牌顶掉」
 * 要避免的。短 TTL 让瞬时网络抖动仍能自愈。
 */
const FAILURE_CACHE_TTL_MS = 20_000;
/** 引导请求的超时：与余额端点同一个量级，绝不拖住签到。 */
const BOOTSTRAP_TIMEOUT_MS = 4_000;

interface CachedHeaders {
  headers: Record<string, string>;
  at: number;
}

const cached = new Map<string, CachedHeaders>();
const inFlight = new Map<string, Promise<Record<string, string>>>();

/** 注入脚本要的**纯数据**形状（函数被序列化后引用不到模块，只能当参数传）。 */
export interface AuthBootstrapProbe {
  url: string;
  method: 'POST';
  tokenPath?: string[];
  header: string;
  prefix: string;
}

/**
 * 把站点配置解析成可注入的探测描述；没配置或不是同源时返回 null。
 *
 * 跨域配置一律在这里被拦掉：后面的引导请求会带上会话 cookie，发去外域等于泄漏。
 */
export function authBootstrapProbe(site: SiteConfig): AuthBootstrapProbe | null {
  const config = site.authBootstrap;
  const endpoint = config?.endpoint?.trim();
  if (!config || !endpoint) return null;
  let url: string;
  try {
    url = new URL(endpoint, site.loginUrl).href;
  } catch {
    return null;
  }
  if (!isSameSiteUrl(site, url)) return null;
  return {
    url,
    method: 'POST',
    ...(config.tokenPath?.length ? { tokenPath: config.tokenPath } : {}),
    header: config.header?.trim() || 'Authorization',
    prefix: config.prefix ?? 'Bearer ',
  };
}

/**
 * 默认的令牌字段路径。
 *
 * 这类响应在分叉之间两种包法都常见（new-api 惯例是 `{data:{...}}`，也有直接平铺的），
 * 所以按顺序都试一遍；配了 `tokenPath` 就只认配置的那条。
 */
const DEFAULT_TOKEN_PATHS: string[][] = [
  ['data', 'access_token'],
  ['access_token'],
  ['data', 'accessToken'],
  ['accessToken'],
];

function readToken(payload: unknown, tokenPath?: string[]): string | null {
  const candidates = tokenPath?.length ? [tokenPath] : DEFAULT_TOKEN_PATHS;
  for (const keys of candidates) {
    let node: unknown = payload;
    for (const key of keys) {
      if (node == null || typeof node !== 'object') {
        node = undefined;
        break;
      }
      node = (node as Record<string, unknown>)[key];
    }
    if (typeof node === 'string' && node.trim().length > 20) return node.trim();
  }
  return null;
}

/** 引导请求得到的请求头（未配置/失败时为空对象，调用方直接 Object.assign 即可）。 */
export async function authBootstrapHeaders(site: SiteConfig, log?: StepLog): Promise<Record<string, string>> {
  const probe = authBootstrapProbe(site);
  if (!probe) return {};
  const key = `${site.id}|${probe.url}`;

  const hit = cached.get(key);
  if (hit) {
    const ttl = Object.keys(hit.headers).length ? TOKEN_CACHE_TTL_MS : FAILURE_CACHE_TTL_MS;
    if (Date.now() - hit.at < ttl) return { ...hit.headers };
  }
  const running = inFlight.get(key);
  if (running) return running;

  const task = requestBootstrapHeaders(probe, log)
    .then((headers) => {
      // 空对象也缓存（失败缓存），否则失败轮询会连发轮换请求。
      cached.set(key, { headers, at: Date.now() });
      return headers;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, task);
  return task;
}

/**
 * 清空缓存。**账号切换 / 清会话后必须调用**：缓存键只有站点，不区分账号 ——
 * 同站 A→B 切换若没发生整页导航，B 会命中 A 的令牌（身份闸门会把 B 读成 A）。
 */
export function clearAuthBootstrapCache(): void {
  cached.clear();
  inFlight.clear();
}

async function requestBootstrapHeaders(
  probe: AuthBootstrapProbe,
  log?: StepLog,
): Promise<Record<string, string>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BOOTSTRAP_TIMEOUT_MS);
  /** 失败要能查：静默降级会让「引导没换成」和「站点本来就没有额度」看起来一模一样。 */
  const fail = (reason: string): Record<string, string> => {
    log?.push(`令牌引导未取到令牌（${reason}），接口按原有凭据继续读`);
    return {};
  };
  try {
    const response = await fetch(probe.url, {
      method: probe.method,
      // 会话 cookie 是这套鉴权的凭据本体，必须带上；同源已在 authBootstrapProbe 里保证。
      credentials: 'include',
      headers: { Accept: 'application/json' },
      // 同源开放重定向也可能把请求弹到别的域：跟随时会把「被重定向目标返回的令牌」
      // 当成本站令牌用（令牌替换），目标若是父域下的兄弟子域还能收到 Domain 作用域
      // 的会话 cookie。这里直接拒绝跟随 —— 引导失败只是降级，不值得冒这个险。
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) return fail(`HTTP ${response.status}`);
    // SPA 常把未命中路径兜底成 index.html（200 + HTML），解析 JSON 只会白费一次往返。
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.includes('json')) return fail('响应不是 JSON');
    const payload = await response.json().catch(() => null);
    const token = readToken(payload, probe.tokenPath);
    if (!token) return fail('响应里没有可用的 access_token');
    return { [probe.header]: `${probe.prefix}${token}` };
  } catch (error) {
    // 引导失败不抛异常：调用方退回原来的请求头（读不到就照旧降级）。
    return fail(error instanceof Error && error.name === 'AbortError' ? '请求超时' : '请求失败');
  } finally {
    clearTimeout(timer);
  }
}
