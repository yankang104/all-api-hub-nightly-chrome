import { afterEach, describe, expect, it, vi } from 'vitest';
import { readBalancePayloadsInPage } from '@/background/checkin/balance-page-script';

/**
 * 页面注入脚本的单测（vitest 是 node 环境，用内存 Storage 与假 Response 打桩；
 * 真实页面行为由 tests/ 下的浏览器脚本覆盖）。全部使用虚构 sentinel 值。
 */

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  } as Storage;
}

function stubPage(url = 'https://orevx.ai/user', bodyText = '') {
  const local = memoryStorage();
  const session = memoryStorage();
  vi.stubGlobal('location', new URL(url));
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('sessionStorage', session);
  vi.stubGlobal('document', { body: { innerText: bodyText } });
  return { local, session };
}

/** 假文本 Response（fetchOne 只读 text()） */
function textResponse(body: string, contentType: string) {
  return {
    ok: true,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
  };
}

/** 假二进制 Response（跨域读取只读 arrayBuffer()） */
function binaryResponse(bytes: Uint8Array, contentType: string) {
  return {
    ok: true,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

/** map{1: "points": 456} 的最小 CBOR 字节（注入脚本只原样带回，编码细节无关） */
const CBOR_POINTS_456 = Uint8Array.from([0xa1, 0x66, 0x70, 0x6f, 0x69, 0x6e, 0x74, 0x73, 0x19, 0x01, 0xc8]);

const OREVX_PROBE = {
  url: 'https://server.orevx.ai/api/user/me',
  tokenKey: 'auth-token',
};

describe('readBalancePayloadsInPage 注入页面的余额读取', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    // 引导令牌缓存在隔离世界的 window 上，跨用例会互相串：每个用例都从干净状态开始
    delete (window as unknown as Record<string, unknown>).__aahBootstrapToken;
  });

  it('同源端点带页面 cookie 读回原始文本，跨域未配置时交叉项为 null', async () => {
    stubPage();
    const fetchMock = vi.fn().mockResolvedValue(textResponse('{"success":true,"data":{"quota":1}}', 'application/json'));
    vi.stubGlobal('fetch', fetchMock);

    const read = await readBalancePayloadsInPage(['/api/user/self'], ['New-API-User'], false, null);

    expect(read.payloads).toHaveLength(1);
    expect(read.payloads[0]).toMatchObject({ path: '/api/user/self', json: true });
    expect(read.crossOrigin).toBeNull();
    const [url, init] = fetchMock.mock.calls[0] as [string, { credentials: string; headers: Record<string, string> }];
    expect(String(url)).toBe('https://orevx.ai/api/user/self');
    expect(init.credentials).toBe('include');
  });

  it('跨域读取：token 从存储读出，带 Bearer 与 cbor 协商，响应字节原样 base64 带回', async () => {
    const { local } = stubPage();
    local.setItem('auth-token', 'sentinel-token-abc');
    const fetchMock = vi.fn().mockImplementation((url: unknown) => (
      String(url).includes('server.orevx.ai')
        ? Promise.resolve(binaryResponse(CBOR_POINTS_456, 'application/cbor'))
        : Promise.resolve({ ok: false, headers: { get: () => null } })
    ));
    vi.stubGlobal('fetch', fetchMock);

    const read = await readBalancePayloadsInPage([], [], false, OREVX_PROBE);

    expect(read.crossOrigin).toMatchObject({
      url: 'https://server.orevx.ai/api/user/me',
      contentType: 'application/cbor',
    });
    expect([...Buffer.from(read.crossOrigin!.base64, 'base64')]).toEqual([...CBOR_POINTS_456]);
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes('server.orevx.ai'));
    expect(call).toBeTruthy();
    const init = call![1] as { method: string; credentials: string; headers: Record<string, string> };
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('omit');
    expect(init.headers.Authorization).toBe('Bearer sentinel-token-abc');
    expect(String(init.headers.Accept)).toContain('application/cbor');
  });

  it('token 缺省依次查 localStorage、sessionStorage —— 只在 session 里也能读到', async () => {
    const { session } = stubPage();
    session.setItem('auth-token', 'sentinel-session-token');
    const fetchMock = vi.fn().mockResolvedValue(binaryResponse(CBOR_POINTS_456, 'application/cbor'));
    vi.stubGlobal('fetch', fetchMock);

    await readBalancePayloadsInPage([], [], false, OREVX_PROBE);

    const call = fetchMock.mock.calls.find(([url]) => String(url).includes('server.orevx.ai'));
    expect(call![1].headers.Authorization).toBe('Bearer sentinel-session-token');
  });

  it('显式配置 sessionStorage 时只查 sessionStorage（与身份读取同一约定）', async () => {
    const { local } = stubPage();
    local.setItem('auth-token', 'sentinel-local-token');
    const fetchMock = vi.fn().mockResolvedValue(binaryResponse(CBOR_POINTS_456, 'application/cbor'));
    vi.stubGlobal('fetch', fetchMock);

    const read = await readBalancePayloadsInPage([], [], false, { ...OREVX_PROBE, tokenStorageType: 'sessionStorage' });

    expect(read.crossOrigin).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('server.orevx.ai'))).toBe(false);
  });

  it('token 头部与前缀覆盖生效', async () => {
    const { local } = stubPage();
    local.setItem('auth-token', 'sentinel-token');
    const fetchMock = vi.fn().mockResolvedValue(binaryResponse(CBOR_POINTS_456, 'application/cbor'));
    vi.stubGlobal('fetch', fetchMock);

    await readBalancePayloadsInPage([], [], false, {
      ...OREVX_PROBE,
      tokenHeader: 'X-API-Token',
      tokenPrefix: 'Token ',
    });

    const call = fetchMock.mock.calls.find(([url]) => String(url).includes('server.orevx.ai'));
    const headers = (call![1] as { headers: Record<string, string> }).headers;
    expect(headers['X-API-Token']).toBe('Token sentinel-token');
    expect(headers.Authorization).toBeUndefined();
  });

  it('没有 token 时不发跨域请求', async () => {
    stubPage();
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve({ ok: false, headers: { get: () => null } }));
    vi.stubGlobal('fetch', fetchMock);

    const read = await readBalancePayloadsInPage([], [], false, OREVX_PROBE);

    expect(read.crossOrigin).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('server.orevx.ai'))).toBe(false);
  });

  it('跨域请求失败不抛：crossOrigin 为 null，同源结果照常返回', async () => {
    const { local } = stubPage();
    local.setItem('auth-token', 'sentinel-token');
    const fetchMock = vi.fn().mockImplementation((url: unknown) => {
      if (String(url).includes('server.orevx.ai')) return Promise.reject(new TypeError('network down'));
      return Promise.resolve(textResponse('{"ok":true}', 'application/json'));
    });
    vi.stubGlobal('fetch', fetchMock);

    const read = await readBalancePayloadsInPage(['/api/user/self'], [], false, OREVX_PROBE);

    expect(read.crossOrigin).toBeNull();
    expect(read.payloads).toHaveLength(1);
  });

  it('非 cbor/json 的跨域响应不接（SPA 兜底 HTML 不算数）', async () => {
    const { local } = stubPage();
    local.setItem('auth-token', 'sentinel-token');
    const fetchMock = vi.fn().mockResolvedValue(binaryResponse(Uint8Array.from([0x3c]), 'text/html'));
    vi.stubGlobal('fetch', fetchMock);

    const read = await readBalancePayloadsInPage([], [], false, OREVX_PROBE);

    expect(read.crossOrigin).toBeNull();
  });

  /** 轮换令牌引导：一梦五千年那类「会话 cookie 换短命 Bearer」的站点。 */
  const LEILEI_BOOTSTRAP = {
    url: 'https://fapi.leileihog.top/api/user/auth/refresh',
    method: 'POST' as const,
    header: 'Authorization',
    prefix: 'Bearer ',
  };

  it('引导换到令牌后再读额度接口，且带 cookie 发 POST', async () => {
    stubPage('https://fapi.leileihog.top/lottery');
    const fetchMock = vi.fn().mockImplementation((url: unknown) => {
      if (String(url).includes('/api/user/auth/refresh')) {
        return Promise.resolve({
          ok: true,
          headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
          json: async () => ({ data: { access_token: 'sentinel-rotated-token-abcdefghij' } }),
        });
      }
      return Promise.resolve(textResponse('{"data":{"quota":42}}', 'application/json'));
    });
    vi.stubGlobal('fetch', fetchMock);

    const read = await readBalancePayloadsInPage(['/api/user/self'], [], false, null, LEILEI_BOOTSTRAP);

    expect(read.payloads[0]?.path).toBe('/api/user/self');
    const refreshCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/user/auth/refresh'));
    expect((refreshCall![1] as { method: string; credentials: string })).toMatchObject({
      method: 'POST',
      credentials: 'include',
    });
    const selfCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/user/self'));
    expect((selfCall![1] as { headers: Record<string, string> }).headers.Authorization)
      .toBe('Bearer sentinel-rotated-token-abcdefghij');
  });

  it('localStorage 里已有 token 时优先，引导不覆盖它', async () => {
    const { local } = stubPage('https://fapi.leileihog.top/lottery');
    local.setItem('auth_token', 'sentinel-stored-token-abcdefghijkl');
    const fetchMock = vi.fn().mockImplementation((url: unknown) => {
      if (String(url).includes('/api/user/auth/refresh')) {
        return Promise.resolve({
          ok: true,
          headers: { get: () => 'application/json' },
          json: async () => ({ data: { access_token: 'sentinel-rotated-token-abcdefghij' } }),
        });
      }
      return Promise.resolve(textResponse('{"data":{"quota":42}}', 'application/json'));
    });
    vi.stubGlobal('fetch', fetchMock);

    await readBalancePayloadsInPage(['/api/user/self'], [], false, null, LEILEI_BOOTSTRAP);

    const selfCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/user/self'));
    expect((selfCall![1] as { headers: Record<string, string> }).headers.Authorization)
      .toBe('Bearer sentinel-stored-token-abcdefghijkl');
  });

  it('引导失败（401/超时）不抛异常，同源读取照常降级', async () => {
    stubPage('https://fapi.leileihog.top/lottery');
    const fetchMock = vi.fn().mockImplementation((url: unknown) => {
      if (String(url).includes('/api/user/auth/refresh')) return Promise.reject(new TypeError('network down'));
      return Promise.resolve({ ok: false, headers: { get: () => null } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const read = await readBalancePayloadsInPage(['/api/user/self'], [], false, null, LEILEI_BOOTSTRAP);

    expect(read.payloads).toEqual([]);
    expect(read.bodyText).toBe('');
  });

  it('跨域引导地址被注入脚本自己拒绝（不信任调用方，带 cookie 的请求绝不发出去）', async () => {
    stubPage('https://fapi.leileihog.top/lottery');
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, headers: { get: () => null } });
    vi.stubGlobal('fetch', fetchMock);

    await readBalancePayloadsInPage(['/api/user/self'], [], false, null, {
      ...LEILEI_BOOTSTRAP,
      url: 'https://evil.example/api/refresh',
    });

    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('evil.example'))).toBe(false);
  });

  it('换到的令牌在隔离世界里缓存 60 秒：连续两次注入只换一次', async () => {
    stubPage('https://fapi.leileihog.top/lottery');
    const fetchMock = vi.fn().mockImplementation((url: unknown) => {
      if (String(url).includes('/api/user/auth/refresh')) {
        return Promise.resolve({
          ok: true,
          headers: { get: () => 'application/json' },
          json: async () => ({ data: { access_token: 'sentinel-rotated-token-abcdefghij' } }),
        });
      }
      return Promise.resolve(textResponse('{"data":{"quota":42}}', 'application/json'));
    });
    vi.stubGlobal('fetch', fetchMock);

    await readBalancePayloadsInPage(['/api/user/self'], [], false, null, LEILEI_BOOTSTRAP);
    await readBalancePayloadsInPage(['/api/user/self'], [], false, null, LEILEI_BOOTSTRAP);

    const refreshCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/user/auth/refresh'));
    expect(refreshCalls).toHaveLength(1);
    const selfCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/user/self'));
    expect((selfCalls[1]![1] as { headers: Record<string, string> }).headers.Authorization)
      .toBe('Bearer sentinel-rotated-token-abcdefghij');
  });
});
