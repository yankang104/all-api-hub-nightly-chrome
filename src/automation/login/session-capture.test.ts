import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureSession, SUB2API_KEYS } from '@/automation/login/session-capture';
import { SITE_TYPES } from '@/types';

/** 内存版 Storage —— 被测代码只用 getItem/setItem/length/key */
function memoryStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed));
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

function stubStorage(seed: Record<string, string> = {}) {
  vi.stubGlobal('localStorage', memoryStorage(seed));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Sub2API 会话抓取', () => {
  const seed = {
    [SUB2API_KEYS.accessToken]: 'access-abc',
    [SUB2API_KEYS.refreshToken]: 'refresh-xyz',
    [SUB2API_KEYS.expiresAt]: '1893456000000',
    [SUB2API_KEYS.user]: JSON.stringify({ id: 42, username: 'alice', email: 'a@b.com', balance: 3.5 }),
  };

  it('抓到 refresh token —— 这才是能长期用的那个', () => {
    // access token 是短命的，只存它的话用户抓完过几分钟就失效
    stubStorage(seed);
    const session = captureSession(SITE_TYPES.SUB2API);

    expect(session?.refreshToken).toBe('refresh-xyz');
    expect(session?.accessToken).toBe('access-abc');
    expect(session?.tokenExpiresAt).toBe(1893456000000);
  });

  it('身份直接从 auth_user 读，不需要调接口', () => {
    // 「读不到身份」正是触发清登录态重登的原因，本地有就别问网络
    stubStorage(seed);
    const session = captureSession(SITE_TYPES.SUB2API);

    expect(session?.identity).toEqual({ userId: '42', username: 'alice', email: 'a@b.com' });
    expect(session?.siteType).toBe(SITE_TYPES.SUB2API);
  });

  it('只有 access token 也能抓，但如实说明没有 refresh', () => {
    stubStorage({ [SUB2API_KEYS.accessToken]: 'access-only' });
    const session = captureSession(SITE_TYPES.SUB2API);

    expect(session?.accessToken).toBe('access-only');
    expect(session?.refreshToken).toBeUndefined();
    expect(session?.evidence).toContain('无 refresh_token');
  });

  it('token 是空字符串时当作没抓到', () => {
    stubStorage({ [SUB2API_KEYS.accessToken]: '   ' });
    expect(captureSession(SITE_TYPES.SUB2API)).toBeNull();
  });

  it('auth_user 是坏 JSON 时仍返回 token，只是身份为空', () => {
    stubStorage({ [SUB2API_KEYS.accessToken]: 'tok', [SUB2API_KEYS.user]: '{坏的' });
    const session = captureSession(SITE_TYPES.SUB2API);

    expect(session?.accessToken).toBe('tok');
    expect(session?.identity.userId).toBeUndefined();
  });
});

describe('VoAPI v2 会话抓取', () => {
  /** payload = {"userId":7}，手工拼一个结构合法的 JWT */
  const jwt = `h.${btoa(JSON.stringify({ userId: 7 })).replace(/=/g, '')}.sig`;

  it('token 从 userStore.auth.token 取，userId 从 JWT 解', () => {
    stubStorage({ userStore: JSON.stringify({ auth: { token: jwt } }) });
    const session = captureSession(SITE_TYPES.VO_API_V2);

    expect(session?.accessToken).toBe(jwt);
    expect(session?.identity.userId).toBe('7');
    expect(session?.siteType).toBe(SITE_TYPES.VO_API_V2);
  });

  it('user 键存在时优先用它的 id', () => {
    stubStorage({
      userStore: JSON.stringify({ auth: { token: jwt } }),
      user: JSON.stringify({ id: 99, username: 'bob' }),
    });
    const session = captureSession(SITE_TYPES.VO_API_V2);

    expect(session?.identity.userId).toBe('99');
    expect(session?.identity.username).toBe('bob');
  });

  it('userStore 里没有 token 时当作没抓到', () => {
    stubStorage({ userStore: JSON.stringify({ auth: {} }) });
    expect(captureSession(SITE_TYPES.VO_API_V2)).toBeNull();
  });
});

describe('new-api 系会话抓取', () => {
  it('只抓身份，不假装抓到了 token', () => {
    // 这一族凭据在 HttpOnly cookie 里，脚本读不到也不需要读
    stubStorage({ user: JSON.stringify({ id: 5, username: 'carol' }) });
    const session = captureSession(SITE_TYPES.NEW_API);

    expect(session?.identity.userId).toBe('5');
    expect(session?.accessToken).toBeUndefined();
    expect(session?.evidence).toContain('cookie');
  });

  it('user 里没有 id 时当作没抓到', () => {
    stubStorage({ user: JSON.stringify({ username: 'noid' }) });
    expect(captureSession(SITE_TYPES.NEW_API)).toBeNull();
  });
});

describe('提取器选择', () => {
  it('Sub2API 页面上同时有 user 键时，不被 new-api 兜底提取器抢走', () => {
    // 关键：兜底提取器抓不到 token，抢先命中就等于丢了会话
    stubStorage({
      [SUB2API_KEYS.accessToken]: 'access-abc',
      [SUB2API_KEYS.refreshToken]: 'refresh-xyz',
      user: JSON.stringify({ id: 1, username: 'shadow' }),
    });

    const session = captureSession(SITE_TYPES.SUB2API);
    expect(session?.siteType).toBe(SITE_TYPES.SUB2API);
    expect(session?.refreshToken).toBe('refresh-xyz');
  });

  it('站点类型认错时仍能靠存在的键抓到会话', () => {
    // 探测把 Sub2API 认成了 new-api，但页面上只有 Sub2API 的键
    stubStorage({ [SUB2API_KEYS.accessToken]: 'access-abc' });
    const session = captureSession(SITE_TYPES.NEW_API);

    expect(session?.siteType).toBe(SITE_TYPES.SUB2API);
  });

  it('没有任何已知键时返回 null', () => {
    stubStorage({ unrelated: 'value' });
    expect(captureSession()).toBeNull();
  });
});
