import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SiteConfig } from '@/types';
import { authBootstrapHeaders, authBootstrapProbe } from '@/automation/shared/token-bootstrap';

/**
 * 轮换令牌站点的引导（authBootstrap）。
 *
 * 一梦五千年实测：新版前端用会话 cookie 调 `/api/user/auth/refresh` 换一枚短命
 * access_token，之后所有接口都带 Bearer；令牌只在页面内存里，扩展读不到 ——
 * 默认请求头在这类站点上一律 401。这里锁住三条：换得到、只换一次、绝不跨域。
 */
function siteWithBootstrap(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return {
    id: overrides.id ?? 'site-bootstrap',
    name: '一梦五千年',
    loginUrl: 'https://fapi.leileihog.top/login',
    selectors: { username: '#u', password: '#p', submit: '#s' },
    closeModalSelectors: [],
    authBootstrap: { endpoint: '/api/user/auth/refresh' },
    ...overrides,
  };
}

function jsonResponse(payload: unknown, ok = true, contentType = 'application/json') {
  return {
    ok,
    status: ok ? 200 : 401,
    headers: { get: () => contentType },
    json: async () => payload,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('authBootstrapProbe：同源解析', () => {
  it('相对路径解析成站点同源绝对地址', () => {
    const probe = authBootstrapProbe(siteWithBootstrap());
    expect(probe).toMatchObject({
      url: 'https://fapi.leileihog.top/api/user/auth/refresh',
      method: 'POST',
      header: 'Authorization',
      prefix: 'Bearer ',
    });
  });

  it('未配置时返回 null', () => {
    expect(authBootstrapProbe(siteWithBootstrap({ authBootstrap: undefined }))).toBeNull();
    expect(authBootstrapProbe(siteWithBootstrap({ authBootstrap: { endpoint: '   ' } }))).toBeNull();
  });

  it('跨域地址一律拒绝（引导请求带着会话 cookie，绝不能发出去）', () => {
    expect(authBootstrapProbe(siteWithBootstrap({
      authBootstrap: { endpoint: 'https://evil.example/api/refresh' },
    }))).toBeNull();
    expect(authBootstrapProbe(siteWithBootstrap({
      authBootstrap: { endpoint: '//evil.example/api/refresh' },
    }))).toBeNull();
  });
});

describe('authBootstrapHeaders：换令牌并用它拼请求头', () => {
  it('从 data.access_token 取令牌，拼成 Bearer 头', async () => {
    const token = 'rotated-access-token-abcdefghijklmn';
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: { access_token: token } }));
    vi.stubGlobal('fetch', fetchMock);

    const headers = await authBootstrapHeaders(siteWithBootstrap({ id: 'site-a' }));

    expect(headers).toEqual({ Authorization: `Bearer ${token}` });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://fapi.leileihog.top/api/user/auth/refresh');
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
  });

  it('平铺的 access_token 与自定义 tokenPath 都认', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({ access_token: 'flat-access-token-abcdefghijklmnop' }),
    ));
    expect(await authBootstrapHeaders(siteWithBootstrap({ id: 'site-flat' })))
      .toEqual({ Authorization: 'Bearer flat-access-token-abcdefghijklmnop' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({ result: { jwt: 'custom-path-token-abcdefghijklmnop' } }),
    ));
    expect(await authBootstrapHeaders(siteWithBootstrap({
      id: 'site-custom',
      authBootstrap: { endpoint: '/api/user/auth/refresh', tokenPath: ['result', 'jwt'] },
    }))).toEqual({ Authorization: 'Bearer custom-path-token-abcdefghijklmnop' });
  });

  it('60 秒内只换一次（轮换会让页面正在用的旧令牌失效，要少换）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ data: { access_token: 'cached-access-token-abcdefghijklmn' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const site = siteWithBootstrap({ id: 'site-cache' });

    await authBootstrapHeaders(site);
    await authBootstrapHeaders(site);

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('缓存过期后重新换（令牌 TTL 60 秒）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ data: { access_token: 'ttl-access-token-abcdefghijklmnop' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const site = siteWithBootstrap({ id: 'site-ttl' });
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    await authBootstrapHeaders(site);
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);

    await authBootstrapHeaders(site);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('失败也缓存一段：失败轮询不会连发轮换请求', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);
    const site = siteWithBootstrap({ id: 'site-fail-cache' });

    // 一轮签到里 before/after 会采样十几次，每次重发一遍 refresh 就是十几次轮换尝试
    await authBootstrapHeaders(site);
    await authBootstrapHeaders(site);
    await authBootstrapHeaders(site);

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('引导失败时返回空对象，调用方照旧降级', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ message: '未登录' }, false)));
    expect(await authBootstrapHeaders(siteWithBootstrap({ id: 'site-401' }))).toEqual({});

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse('<html></html>', true, 'text/html')));
    expect(await authBootstrapHeaders(siteWithBootstrap({ id: 'site-html' }))).toEqual({});

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    expect(await authBootstrapHeaders(siteWithBootstrap({ id: 'site-down' }))).toEqual({});

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: { access_token: 'short' } })));
    expect(await authBootstrapHeaders(siteWithBootstrap({ id: 'site-short' }))).toEqual({});
  });

  it('未配置或跨域时一个请求都不发', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await authBootstrapHeaders(siteWithBootstrap({ id: 'site-none', authBootstrap: undefined })))
      .toEqual({});
    expect(await authBootstrapHeaders(siteWithBootstrap({
      id: 'site-cross',
      authBootstrap: { endpoint: 'https://evil.example/x' },
    }))).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('引导失败会写进日志，且不重复刷屏（失败缓存生效）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: '未登录' }, false));
    vi.stubGlobal('fetch', fetchMock);

    const lines: string[] = [];
    const site = siteWithBootstrap({ id: 'site-log' });
    await authBootstrapHeaders(site, { push: (line) => lines.push(line) });
    await authBootstrapHeaders(site, { push: (line) => lines.push(line) });

    expect(lines.join('\n')).toContain('令牌引导未取到令牌');
    expect(lines.join('\n')).toContain('HTTP 401');
    // 第二次命中失败缓存：不重发请求，也不重复写日志
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(lines).toHaveLength(1);
  });
});
