import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureFreshToken } from '@/automation/login/token-refresh';
import { SUB2API_KEYS } from '@/automation/login/session-capture';
import { SITE_TYPES, type SiteConfig } from '@/types';

const site = (overrides: Partial<SiteConfig> = {}): SiteConfig => ({
  id: 's',
  name: '百倍',
  loginUrl: 'https://sub.example.com/login',
  selectors: { username: '#email', password: '#password', submit: '.btn' },
  closeModalSelectors: [],
  adapter: { siteType: SITE_TYPES.SUB2API },
  ...overrides,
});

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

function stubEnv() {
  const store = memoryStorage();
  vi.stubGlobal('location', new URL('https://sub.example.com/dashboard'));
  vi.stubGlobal('localStorage', store);
  return store;
}

const collectLog = () => {
  const lines: string[] = [];
  return { log: { push: (m: string) => lines.push(m) }, lines };
};

const okResponse = (expiresIn = 3600) => ({
  json: async () => ({
    code: 0,
    data: { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: expiresIn },
  }),
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ensureFreshToken 到期判断', () => {
  it('离到期还远时不换 —— 换早了会白白轮换 refresh token', () => {
    stubEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { log } = collectLog();

    return ensureFreshToken(
      site(),
      { accessToken: 'a', refreshToken: 'r', tokenExpiresAt: Date.now() + 3_600_000 },
      log,
    ).then((outcome) => {
      expect(outcome.status).toBe('still-valid');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('进入 buffer（到期前 2 分钟内）就换', async () => {
    stubEnv();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse()));
    const { log, lines } = collectLog();

    const outcome = await ensureFreshToken(
      site(),
      { accessToken: 'a', refreshToken: 'r', tokenExpiresAt: Date.now() + 60_000 },
      log,
    );

    expect(outcome.status).toBe('refreshed');
    if (outcome.status === 'refreshed') {
      expect(outcome.tokens.accessToken).toBe('new-access');
      expect(outcome.tokens.refreshToken).toBe('new-refresh');
    }
    expect(lines.join('\n')).toContain('换到新的访问令牌');
  });

  it('到期时间未知时不主动换，让请求自己去撞 401', async () => {
    stubEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { log } = collectLog();

    const outcome = await ensureFreshToken(site(), { accessToken: 'a', refreshToken: 'r' }, log);
    expect(outcome.status).toBe('still-valid');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('ensureFreshToken 写回页面存储', () => {
  it('换到新 token 后同时写回 localStorage —— 否则页面自己还在用旧的', async () => {
    const store = stubEnv();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse()));
    const { log } = collectLog();

    await ensureFreshToken(
      site(),
      { accessToken: 'a', refreshToken: 'r', tokenExpiresAt: Date.now() + 1_000 },
      log,
    );

    expect(store.getItem(SUB2API_KEYS.accessToken)).toBe('new-access');
    expect(store.getItem(SUB2API_KEYS.refreshToken)).toBe('new-refresh');
    expect(Number(store.getItem(SUB2API_KEYS.expiresAt))).toBeGreaterThan(Date.now());
  });
});

describe('ensureFreshToken 失败路径', () => {
  it('已过期且没有 refresh token → 要求重新抓取', async () => {
    stubEnv();
    const { log } = collectLog();

    const outcome = await ensureFreshToken(
      site(),
      { accessToken: 'a', tokenExpiresAt: Date.now() - 1_000 },
      log,
    );

    expect(outcome.status).toBe('expired');
    if (outcome.status === 'expired') expect(outcome.reason).toContain('重新抓取');
  });

  it('未过期但换失败时继续用旧的，不打断签到', async () => {
    stubEnv();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const { log } = collectLog();

    const outcome = await ensureFreshToken(
      site(),
      { accessToken: 'a', refreshToken: 'r', tokenExpiresAt: Date.now() + 60_000 },
      log,
    );

    expect(outcome.status).toBe('still-valid');
  });

  it('已过期且换失败 → 明确报过期，而不是继续跑到找不到密码框', async () => {
    stubEnv();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ code: 401, data: null }) }));
    const { log } = collectLog();

    const outcome = await ensureFreshToken(
      site(),
      { accessToken: 'a', refreshToken: 'r', tokenExpiresAt: Date.now() - 1_000 },
      log,
    );

    expect(outcome.status).toBe('expired');
  });

  it('cookie 认证的站点不走这套流程', async () => {
    stubEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { log } = collectLog();

    const outcome = await ensureFreshToken(
      site({ adapter: { siteType: SITE_TYPES.NEW_API } }),
      { accessToken: 'a', refreshToken: 'r', tokenExpiresAt: Date.now() + 1_000 },
      log,
    );

    expect(outcome.status).toBe('unsupported');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('响应缺字段时按失败处理，不写入半个会话', async () => {
    const store = stubEnv();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ code: 0, data: { access_token: 'only-access' } }),
    }));
    const { log } = collectLog();

    const outcome = await ensureFreshToken(
      site(),
      { accessToken: 'a', refreshToken: 'r', tokenExpiresAt: Date.now() + 60_000 },
      log,
    );

    expect(outcome.status).toBe('still-valid');
    expect(store.getItem(SUB2API_KEYS.accessToken)).toBeNull();
  });
});
