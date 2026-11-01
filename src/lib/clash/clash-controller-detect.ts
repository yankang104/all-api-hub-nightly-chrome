import {
  buildClashControllerAuthHeaders,
  normalizeClashControllerAddress,
  type ClashControllerConnection,
} from './clash-controller';

export const CLASH_CONTROLLER_PORTS = [9097, 9090, 9095, 9096, 9091, 9092, 9093, 9094, 9098, 9099];
export const CLASH_CONTROLLER_NOT_FOUND = '未连接到本机 HTTP 控制接口，这不代表 Clash Verge / mihomo 未启动。'
  + 'Clash Verge 可能只启用了 Windows 命名管道；如需同步节点，请在 Clash Verge 设置中启用外部控制器（HTTP），'
  + '例如 127.0.0.1:9097，再填写地址和密钥。仅使用当前代理出口无需控制接口，可检测本机代理端口（Verge 默认 7897）。';

export type ClashControllerDetection =
  | { status: 'found'; address: string; needsSecret: boolean; verified: boolean }
  | { status: 'not-found'; message: string };

/** 只信 /version 的控制器 JSON，不把网页、404 或任意本机 HTTP 服务当作 Clash。 */
function isControllerVersion(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const version = (value as { version?: unknown }).version;
  return typeof version === 'string' && version.trim().length > 0 && version.length <= 128;
}

interface DetectOptions {
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

/**
 * 只读探测 HTTP 控制接口，不探测进程，也不修改内核/系统代理。
 * 用户填入的地址优先（支持自定义端口和 IPv6）；密钥只发给这个显式地址，
 * 不带到其它候选，不跟随重定向。并发候选仍按固定优先级选择，而非最快响应者。
 */
export async function discoverClashController(
  connection?: ClashControllerConnection,
  { fetcher = fetch, timeoutMs = 800 }: DetectOptions = {},
): Promise<ClashControllerDetection> {
  const explicit = connection ? normalizeClashControllerAddress(connection.address) : null;
  if (connection && !explicit) throw new Error('Clash controller 地址无效：只允许本机 HTTP(S) 地址');
  const candidates = [...new Set([
    ...(explicit ? [explicit] : []),
    ...CLASH_CONTROLLER_PORTS.map((port) => `http://127.0.0.1:${port}`),
    ...CLASH_CONTROLLER_PORTS.map((port) => `http://[::1]:${port}`),
  ])];

  const probe = async (address: string): Promise<Extract<ClashControllerDetection, { status: 'found' }> | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(`${address}/version`, {
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        headers: address === explicit ? buildClashControllerAuthHeaders(connection?.secret) : {},
      });
      if (response.status === 401 || response.status === 403) {
        // 认证响应只证明 HTTP 端口可达，尚不能确认它一定是 Clash。
        return { status: 'found', address, needsSecret: true, verified: false };
      }
      if (!response.ok) return null;
      const raw = await response.text();
      if (raw.length > 4_096 || !isControllerVersion(JSON.parse(raw))) return null;
      return { status: 'found', address, needsSecret: false, verified: true };
    } catch {
      // 连接拒绝、超时、非 JSON、重定向均不作为命中；失败不泄露密钥或响应体。
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  // 显式地址先验证，防止保存的自定义端口被另一个内核的默认端口替换。
  if (explicit) {
    const found = await probe(explicit);
    if (found) return found;
  }
  const results = await Promise.all(candidates.filter((address) => address !== explicit).map(probe));
  return results.find((result) => result?.verified)
    ?? results.find((result) => result?.needsSecret)
    ?? { status: 'not-found', message: CLASH_CONTROLLER_NOT_FOUND };
}
