import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverClashController, CLASH_CONTROLLER_NOT_FOUND } from './clash-controller-detect';

const version = () => Response.json({ meta: true, version: 'v1.19.0' });
const unavailable = () => Promise.reject(new TypeError('Failed to fetch'));

afterEach(() => vi.useRealTimers());

describe('HTTP 控制接口检测（不是内核进程检测）', () => {
  it('控制器关闭/仅命名管道时返回准确诊断，不断言内核未启动', async () => {
    const fetcher = vi.fn<typeof fetch>(unavailable);
    expect(await discoverClashController(undefined, { fetcher })).toEqual({
      status: 'not-found', message: CLASH_CONTROLLER_NOT_FOUND,
    });
    expect(CLASH_CONTROLLER_NOT_FOUND).toContain('这不代表');
    expect(CLASH_CONTROLLER_NOT_FOUND).toContain('命名管道');
    expect(CLASH_CONTROLLER_NOT_FOUND).toContain('7897');
  });

  it('优先检查用户填写的自定义端口，不只扫 909x', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => version());
    expect(await discoverClashController({ address: '127.0.0.1:19097' }, { fetcher })).toEqual({
      status: 'found', address: 'http://127.0.0.1:19097', needsSecret: false, verified: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('跳过 200 HTML、404、空 JSON，不把其它本机服务误认成 Clash', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      switch (String(url)) {
        case 'http://127.0.0.1:9097/version': return new Response('<html>Local app</html>');
        case 'http://127.0.0.1:9090/version': return new Response('not found', { status: 404 });
        case 'http://127.0.0.1:9095/version': return Response.json({ message: 'ok' });
        case 'http://127.0.0.1:9096/version': return version();
        default: return unavailable();
      }
    });
    expect(await discoverClashController(undefined, { fetcher })).toMatchObject({
      status: 'found', address: 'http://127.0.0.1:9096', verified: true,
    });
  });

  it('IPv4 未监听时仍能找到 IPv6 回环控制器', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => String(url) === 'http://[::1]:9097/version' ? version() : unavailable());
    expect(await discoverClashController(undefined, { fetcher })).toMatchObject({ address: 'http://[::1]:9097' });
  });

  it('认证接口标为待确认，不把 401 当成不可用或已验证的 Clash', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('', { status: 401 }));
    expect(await discoverClashController({ address: '9097' }, { fetcher })).toEqual({
      status: 'found', address: 'http://127.0.0.1:9097', needsSecret: true, verified: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('自动候选里的认证接口不能盖过另一个已验证的控制器', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url) === 'http://127.0.0.1:9097/version') return new Response('', { status: 403 });
      if (String(url) === 'http://127.0.0.1:9090/version') return version();
      return unavailable();
    });
    expect(await discoverClashController(undefined, { fetcher })).toMatchObject({ address: 'http://127.0.0.1:9090', verified: true });
  });

  it('密钥仅发送到显式地址，失败后的其它候选不带密钥，不跟随重定向', async () => {
    const fetcher = vi.fn<typeof fetch>(unavailable);
    await discoverClashController({ address: '19097', secret: 'sentinel-secret' }, { fetcher });
    const authenticated = fetcher.mock.calls.filter(([, init]) => new Headers(init?.headers).has('Authorization'));
    expect(authenticated).toHaveLength(1);
    expect(authenticated[0]?.[0]).toBe('http://127.0.0.1:19097/version');
    expect(new Headers(authenticated[0]?.[1]?.headers).get('Authorization')).toBe('Bearer sentinel-secret');
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ redirect: 'error', credentials: 'omit', cache: 'no-store' });
    }
  });

  it('自动发现不发送任何已保存的密钥或浏览器 Cookie', async () => {
    const fetcher = vi.fn<typeof fetch>(unavailable);
    await discoverClashController(undefined, { fetcher });
    for (const [, init] of fetcher.mock.calls) {
      expect(new Headers(init?.headers).get('Authorization')).toBeNull();
      expect(init?.credentials).toBe('omit');
    }
  });

  it('拒绝远端、凭据嵌入及命名管道地址，不把探测当任意 URL 请求器', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const address of ['https://remote.test:9097', 'http://user:pw@127.0.0.1:9097', 'file:///pipe/mihomo']) {
      await expect(discoverClashController({ address }, { fetcher })).rejects.toThrow('只允许本机');
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('所有端口无响应时并行探测、有界超时', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const pending = discoverClashController(undefined, { fetcher, timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(51);
    expect(await pending).toMatchObject({ status: 'not-found' });
    expect(vi.getTimerCount()).toBe(0);
  });
});
