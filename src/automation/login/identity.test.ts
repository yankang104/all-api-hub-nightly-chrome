import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SiteConfig } from '@/types';
import { findAccountOnPage, injectToken, logoutSession, readPageIdentity, readVisibleIdentity, verifyIdentity } from '@/automation/login/identity';

const identity = (partial: { userId?: string; username?: string; email?: string }) => partial;

const tokenSite = (overrides: Partial<SiteConfig> = {}): SiteConfig => ({
  id: 'sub2api',
  name: '百倍',
  loginUrl: 'https://sub.example.com/login',
  loginMethod: 'token',
  selectors: { username: '#email', password: 'input[type="password"]', submit: '.btn-primary' },
  closeModalSelectors: [],
  tokenConfig: {
    storageKey: 'auth_token',
    headerName: 'Authorization',
    headerPrefix: 'Bearer ',
    identityEndpoint: '/api/v1/auth/me',
  },
  ...overrides,
});

const newApiSite = (overrides: Partial<SiteConfig> = {}): SiteConfig => ({
  id: 'newapi',
  name: '可萌',
  loginUrl: 'https://api.example.com/login',
  loginMethod: 'oauth',
  selectors: { username: '#username', password: '#password', submit: 'button[type="submit"]' },
  closeModalSelectors: [],
  adapter: { siteType: 'new-api' },
  ...overrides,
});

const collectLog = () => {
  const lines: string[] = [];
  return { log: { push: (m: string) => lines.push(m) }, lines };
};

/**
 * 内存版 Storage。
 *
 * 这里不引 jsdom：vitest.config.ts 刻意用 node 环境，DOM 交互交给
 * tests/ 下的真实浏览器脚本。被测的这几个函数只用到 Storage 的
 * getItem/setItem/removeItem/key/length，打一个桩比装 jsdom 划算。
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

/** 每个用例开一套干净的 location + storage */
function stubPageEnv(url = 'https://sub.example.com/dashboard') {
  const local = memoryStorage();
  const sessionStore = memoryStorage();
  vi.stubGlobal('location', new URL(url));
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('sessionStorage', sessionStore);
  return { local, session: sessionStore };
}

/**
 * 假 Response。必须带 content-type ——
 * readPageIdentity 会先看它，SPA 把未命中的路径兜底成 index.html 时
 * 状态也是 200，只有 content-type 能区分出那不是接口响应。
 */
function jsonResponse(payload: unknown, ok = true) {
  return {
    ok,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => payload,
  };
}

describe('verifyIdentity 身份核对', () => {
  /**
   * 多账号安全的核心回归点（2026-10-08 由 g2 场景的最小复现转正）。
   *
   * 场景：本地账号存了 userId=00000，而浏览器里实际登着别人。
   * 站点接口返回的是**权威身份**，ID 冲突必须判 mismatch —— 一旦这里退化成
   * unknown，单账号站点会当作「读不到身份」放行，结果就是给错账号签到。
   */
  describe('API 身份冲突必须判误配（g2 回归）', () => {
    it('存的 ID 与站点 API 返回的 ID 不一致 → mismatch，而不是 unknown', () => {
      const v = verifyIdentity(
        { source: 'api', userId: '99999', username: 'sentinel_mismatch' },
        'sentinel_mismatch',
        '00000',
      );
      expect(v.match).toBe('mismatch');
      expect(v.detail).toContain('99999');
      expect(v.detail).toContain('00000');
    });

    it('完全读不到身份 → unknown（由调用方按站点账号数决定是否放行）', () => {
      expect(verifyIdentity(null, 'sentinel_mismatch', '00000').match).toBe('unknown');
    });
  });

  describe('用户 ID 比对（最可靠）', () => {
    it('ID 一致即确认', () => {
      const v = verifyIdentity(identity({ userId: '42' }), 'user@example.com', '42');
      expect(v.match).toBe('confirmed');
    });

    it('ID 不符即误配', () => {
      const v = verifyIdentity(identity({ userId: '99' }), 'user@example.com', '42');
      expect(v.match).toBe('mismatch');
      expect(v.detail).toContain('99');
      expect(v.detail).toContain('42');
    });

    it('ID 缺失时退到用户名比对', () => {
      // identity 里没有 userId，storedUserId 有也没用
      const v = verifyIdentity(identity({ username: 'alice' }), 'alice', '42');
      expect(v.match).toBe('confirmed');
    });
  });

  describe('用户名 / 邮箱比对', () => {
    it('用户名精确匹配', () => {
      expect(verifyIdentity(identity({ username: 'alice' }), 'alice').match).toBe('confirmed');
    });

    it('邮箱精确匹配', () => {
      expect(verifyIdentity(identity({ email: 'alice@example.com' }), 'alice@example.com').match).toBe('confirmed');
    });

    it('大小写不敏感', () => {
      expect(verifyIdentity(identity({ username: 'Alice' }), 'alice').match).toBe('confirmed');
    });

    it('邮箱登录名对站点用户名前缀：一致', () => {
      // 用邮箱登录，站点只展示用户名（不含域名）
      expect(verifyIdentity(identity({ username: 'alice' }), 'alice@example.com').match).toBe('confirmed');
    });

    it('不同域名的邮箱不算一致', () => {
      // alice@x.com 与 alice@y.com 前缀相同，但不是同一个账号
      const v = verifyIdentity(identity({ email: 'alice@x.com' }), 'alice@y.com');
      expect(v.match).toBe('mismatch');
    });

    it('明确不同的用户名判为误配', () => {
      const v = verifyIdentity(identity({ username: 'bob', email: 'bob@example.com' }), 'alice');
      expect(v.match).toBe('mismatch');
      expect(v.detail).toContain('bob');
    });

    it('Future Hub 可用账号明确保存的 GitHub 用户名核对站点接口身份', () => {
      const v = verifyIdentity(
        { username: 'demo104', source: 'api' },
        'demo_104',
        undefined,
        { expectedAliases: ['demo104'] },
      );
      expect(v.match).toBe('confirmed');
      expect(v.detail).toContain('demo104');
      expect(v.detail).toContain('demo_104');
    });

    it('未显式提供身份别名时不删除下划线做模糊匹配', () => {
      expect(verifyIdentity(
        { username: 'demo104', source: 'api' },
        'demo_104',
      ).match).toBe('mismatch');
    });

    it('站点接口 userId 与已保存值冲突时，GitHub 别名不能覆盖强冲突', () => {
      expect(verifyIdentity(
        { userId: '99', username: 'demo104', source: 'api' },
        'demo_104',
        '42',
        { expectedAliases: ['demo104'] },
      ).match).toBe('mismatch');
    });

    it('userId 已属于本站另一账号时，即使当前账号没有保存 ID 也不能被别名覆盖', () => {
      const v = verifyIdentity(
        { userId: '99', username: 'demo104', source: 'api' },
        'demo_104',
        undefined,
        { knownUsers: { 99: 'other-account' }, expectedAliases: ['demo104'] },
      );
      expect(v.match).toBe('mismatch');
      expect(v.detail).toContain('other-account');
    });

    it('GitHub 邮箱别名不能用邮箱前缀匹配 username', () => {
      expect(verifyIdentity(
        { username: 'alice', source: 'api' },
        'site-account',
        undefined,
        { expectedAliases: ['alice@corp.example'] },
      ).match).toBe('mismatch');
    });

    it('GitHub handle 别名不能用 displayName 匹配', () => {
      expect(verifyIdentity(
        { username: 'other-user', displayName: 'demo104', source: 'api' },
        'demo_104',
        undefined,
        { expectedAliases: ['demo104'] },
      ).match).toBe('mismatch');
    });

    it('已保存的站点用户名可以核对 GitHub OAuth 返回的站点身份', () => {
      const v = verifyIdentity(
        { username: 'demo104', source: 'api' },
        'demo_104',
        undefined,
        { expectedIdentity: { username: 'demo104' } },
      );
      expect(v.match).toBe('confirmed');
      expect(v.detail).toContain('已保存的站点身份');
    });

    it('1412 页面同时显示站点账号和 GitHub 句柄时，以严格命中的站点账号作旁证', () => {
      const v = verifyIdentity(
        { userId: '436', username: 'demo-github', source: 'visible' },
        'demo-user',
        undefined,
        { pageAccountMatch: 'demo-user' },
      );
      expect(v.match).toBe('confirmed');
      expect(v.detail).toContain('demo-user');
    });

    it('页面没有出现本账号名时，不能把另一个 GitHub 句柄绑定给当前账号', () => {
      const v = verifyIdentity(
        { userId: '436', username: 'demo-github', source: 'visible' },
        'qqkang',
      );
      expect(v.match).toBe('mismatch');
      expect(v.detail).toContain('demo-github');
    });

    it('页面文字旁证不能覆盖身份接口明确返回的其他账号', () => {
      const v = verifyIdentity(
        { userId: '99', username: 'bob', source: 'api' },
        'alice',
        undefined,
        { pageAccountMatch: 'alice' },
      );
      expect(v.match).toBe('mismatch');
    });

    it('站点没返回任何可比字段时判未知', () => {
      expect(verifyIdentity(identity({}), 'alice').match).toBe('unknown');
    });
  });

  describe('读不到身份时', () => {
    it('null 身份返回 unknown', () => {
      expect(verifyIdentity(null, 'alice').match).toBe('unknown');
    });
  });
});

describe('readVisibleIdentity 读页面上可见的身份', () => {
  afterEach(() => vi.unstubAllGlobals());

  const withBodyText = (innerText: string) => {
    vi.stubGlobal('document', { body: { innerText } });
  };

  it('读出「用户 ID」标签和 @ 句柄 —— 1412 的 /profile 就长这样', () => {
    withBodyText('demo-user 用户 用户 ID 436\n@demo-github · SVIP\n当前余额 $456.75');
    expect(readVisibleIdentity()).toMatchObject({ userId: '436', username: 'demo-github' });
  });

  it('支持中文冒号与 User ID 写法', () => {
    withBodyText('用户ID：8899');
    expect(readVisibleIdentity()?.userId).toBe('8899');
    withBodyText('User ID 77');
    expect(readVisibleIdentity()?.userId).toBe('77');
  });

  it('读出邮箱', () => {
    withBodyText('邮箱 alice@example.com 已绑定');
    expect(readVisibleIdentity()?.email).toBe('alice@example.com');
  });

  it('没有明确身份标签时返回 null，不从随机文本里编造身份', () => {
    withBodyText('每日签到 今天 +$5.95 累计签到 38 天');
    expect(readVisibleIdentity()).toBeNull();
  });

  it('页面无正文时返回 null', () => {
    vi.stubGlobal('document', { body: null });
    expect(readVisibleIdentity()).toBeNull();
  });

  it('接口全部读不到时回退到页面可见身份', async () => {
    const { local } = stubPageEnv();
    local.clear();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, headers: { get: () => null } }));
    vi.stubGlobal('document', { body: { innerText: 'demo-user 用户 ID 436' } });
    const result = await readPageIdentity(newApiSite());
    expect(result).toMatchObject({ userId: '436' });
  });
});

describe('Token 认证站点的身份读取', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('带上 Authorization 头 —— 不带就永远 401，身份永远读不到', async () => {
    // 这是「已登录却说读不到身份，于是清掉登录态重新登录」的根因：
    // Sub2API 的凭据在 localStorage 而不是 cookie，credentials:'include'
    // 带不上，必须手动拼 Bearer 头。
    const { local } = stubPageEnv();
    local.setItem('auth_token', 'tok-abc');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: { id: 7, email: 'a@b.com' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await readPageIdentity(tokenSite());
    expect(result).toMatchObject({ userId: '7', email: 'a@b.com' });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers.Authorization).toBe('Bearer tok-abc');
  });

  it('显式传入的 token 优先于存储里的旧值', async () => {
    const { local } = stubPageEnv();
    local.setItem('auth_token', 'stale');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: { id: 1 } }));
    vi.stubGlobal('fetch', fetchMock);

    await readPageIdentity(tokenSite(), 'fresh');
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe('Bearer fresh');
  });

  it('配了专属端点就只查它', async () => {
    const { local } = stubPageEnv();
    local.setItem('auth_token', 'tok');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: { id: 1 } }));
    vi.stubGlobal('fetch', fetchMock);

    await readPageIdentity(tokenSite());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/api/v1/auth/me');
  });
});

describe('new-api 系身份读取（补 user-id 兼容头）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('从 localStorage.user.id 构造 New-API-User 头，才能读到 /api/user/self', async () => {
    // new-api 系 cookie/OAuth 登录、没有 tokenConfig，身份接口要 New-API-User 头，
    // 值是当前登录用户的数字 id（存在 localStorage["user"].id）。不带就 401、读不到，
    // 一致性判断退化成「读不到 → 保守重登」。这是 1412 站点死循环的根因。
    const { local } = stubPageEnv('https://api.example.com/console');
    local.setItem('user', JSON.stringify({ id: 42, username: 'kang' }));
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ success: true, data: { id: 42, username: 'kang', email: 'k@e.com' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await readPageIdentity(newApiSite());
    expect(result).toMatchObject({ userId: '42', username: 'kang' });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers['New-API-User']).toBe('42');
  });

  it('localStorage 没有登录用户时不硬造 user-id 头', async () => {
    stubPageEnv('https://api.example.com/console');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: { id: 1 } }));
    vi.stubGlobal('fetch', fetchMock);

    await readPageIdentity(newApiSite());
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers['New-API-User']).toBeUndefined();
  });
});

describe('injectToken 注入账号自己的 token', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('写入配置的键', () => {
    const { local } = stubPageEnv();
    const { log, lines } = collectLog();
    expect(injectToken(tokenSite(), 'tok-1', log)).toBe(true);
    expect(local.getItem('auth_token')).toBe('tok-1');
    expect(lines.join('\n')).toContain('localStorage.auth_token');
  });

  it('同站换账号时后一个 token 覆盖前一个', () => {
    const { local } = stubPageEnv();
    const { log } = collectLog();
    injectToken(tokenSite(), 'account-A', log);
    injectToken(tokenSite(), 'account-B', log);
    // 两个账号的凭据不能同时存在，否则站点按哪个算全凭运气
    expect(local.getItem('auth_token')).toBe('account-B');
  });

  it('sessionStorage 站点写到 sessionStorage', () => {
    const { local, session } = stubPageEnv();
    const { log } = collectLog();
    const site = tokenSite({
      tokenConfig: { ...tokenSite().tokenConfig!, storageType: 'sessionStorage' },
    });
    injectToken(site, 'tok-2', log);
    expect(session.getItem('auth_token')).toBe('tok-2');
    expect(local.getItem('auth_token')).toBeNull();
  });

  it('站点没配 tokenConfig 时明确失败', () => {
    stubPageEnv();
    const { log, lines } = collectLog();
    expect(injectToken(tokenSite({ tokenConfig: undefined }), 'tok', log)).toBe(false);
    expect(lines.join('\n')).toContain('tokenConfig');
  });
});

describe('logoutSession 切换账号前真正退出', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('没有退出接口时报告 cookie 可能还在', async () => {
    // 关键回归：以前只清 localStorage 就直接填表单，cookie 里旧账号的会话还在，
    // 站点于是认旧账号 —— 表现为「点账号 B 却给 A 签到」或直接登录失败。
    const { local } = stubPageEnv();
    local.setItem('auth_token', 'old');
    const { log } = collectLog();

    const outcome = await logoutSession(tokenSite({ logoutApiUrl: undefined }), log);
    expect(outcome.clearedKeys).toBeGreaterThan(0);
    expect(outcome.serverLogout).toBe(false);
    expect(outcome.cookieMayRemain).toBe(true);
  });

  it('调通退出接口后认为 cookie 已失效', async () => {
    const { local } = stubPageEnv();
    local.setItem('auth_token', 'old');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const { log, lines } = collectLog();

    const outcome = await logoutSession(tokenSite({ logoutApiUrl: '/api/user/logout' }), log);
    expect(outcome.serverLogout).toBe(true);
    expect(outcome.cookieMayRemain).toBe(false);
    expect(lines.join('\n')).toContain('退出接口');
  });

  it('POST 不通就退回 GET', async () => {
    stubPageEnv();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const { log } = collectLog();

    const outcome = await logoutSession(tokenSite({ logoutApiUrl: '/api/user/logout' }), log);
    expect(outcome.serverLogout).toBe(true);
    expect(fetchMock.mock.calls.map((c) => c[1].method)).toEqual(['POST', 'GET']);
  });

  it('token 站点清掉本地键就算退出 —— 它没有 cookie 会话', async () => {
    // 这一族凭据全在 localStorage。cookieMayRemain 仍然是 true（我们确实
    // 没调退出接口），但引擎会据 loginMethod==='token' 跳过重载页面那一步，
    // 因为对它们重载纯属多跑一趟。这里锁住「键真的被清掉了」这个前提。
    const { local } = stubPageEnv();
    local.setItem('auth_token', 'account-A');
    local.setItem('refresh_token', 'refresh-A');
    const { log } = collectLog();

    const outcome = await logoutSession(tokenSite({ logoutApiUrl: undefined }), log);

    expect(outcome.clearedKeys).toBeGreaterThanOrEqual(2);
    expect(local.getItem('auth_token')).toBeNull();
    expect(local.getItem('refresh_token')).toBeNull();
  });

  it('退出接口不在本站时拒绝调用', async () => {
    stubPageEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { log, lines } = collectLog();

    // 安全边界：退出请求带 cookie，绝不能发到站外
    const outcome = await logoutSession(tokenSite({ logoutApiUrl: 'https://evil.example/steal' }), log);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(outcome.serverLogout).toBe(false);
    expect(lines.join('\n')).toContain('不在本站');
  });
});

/**
 * 这一组锁的是「误判成登着别人」这类事故。
 *
 * 现场日志：落地页判「当前登录的是用户 ID 5544，本次要签到的是 5543」，
 * 于是清登录态重登；两步之后签到页却读到 5543 一致。日志没说 5544 是从哪
 * 读来的，用户没法判断这是误判还是真登着另一个账号 —— 而两者该做的事相反。
 */
describe('身份来源可追溯', () => {
  afterEach(() => vi.unstubAllGlobals());

  const withBodyText = (innerText: string) => {
    vi.stubGlobal('document', { body: { innerText } });
  };

  it('页面文本读到的身份标记来源为 visible', () => {
    withBodyText('用户 ID 5543');
    expect(readVisibleIdentity()).toMatchObject({ userId: '5543', source: 'visible' });
  });

  it('接口读到的身份标记来源为 api', async () => {
    // 同站校验按 site.loginUrl 走，location 必须落在同一个域上
    stubPageEnv('https://api.example.com/console');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: { id: 5543, username: 'fzk520' } })));
    await expect(readPageIdentity(newApiSite())).resolves.toMatchObject({ userId: '5543', source: 'api' });
  });

  it('mismatch 一定说清身份是从哪读来的 —— 否则日志无法证伪', () => {
    const v = verifyIdentity({ userId: '5544', source: 'api' }, 'fzk520', '5543');
    expect(v.match).toBe('mismatch');
    expect(v.detail).toContain('读自站点接口');
  });

  it('对得上时也带来源，方便回看是谁给的结论', () => {
    const v = verifyIdentity({ userId: '5543', source: 'api' }, 'fzk520', '5543');
    expect(v.match).toBe('confirmed');
    expect(v.detail).toContain('读自站点接口');
  });

  it('登着的是本站另一个账号时点名它 —— 这时退出重登是对的', () => {
    const v = verifyIdentity({ userId: '5544', source: 'api' }, 'fzk520', '5543', {
      knownUsers: { 5544: 'fzk521' },
    });
    expect(v.match).toBe('mismatch');
    expect(v.detail).toContain('本站账号 fzk521');
  });
});

describe('页面文本里的数字不许冒充当前用户', () => {
  afterEach(() => vi.unstubAllGlobals());

  const withBodyText = (innerText: string) => {
    vi.stubGlobal('document', { body: { innerText } });
  };

  it('邀请人 UID 不是当前用户', () => {
    withBodyText('邀请人 UID: 5544\n累计签到 38 天');
    expect(readVisibleIdentity()).toBeNull();
  });

  it('自己的 ID 与邀请人 ID 同时出现时，只取自己的', () => {
    withBodyText('用户 ID 5543\n邀请人 UID 5544');
    expect(readVisibleIdentity()?.userId).toBe('5543');
  });

  it('正文里有多个互相矛盾的 ID 时一个都不认', () => {
    // 公告、排行榜都可能印别人的 ID；挑错一个的代价是清掉有效会话
    withBodyText('用户 ID 5543\n用户 ID 5544');
    expect(readVisibleIdentity()?.userId).toBeUndefined();
  });

  it('同一个 ID 出现多次仍然算读到', () => {
    withBodyText('用户 ID 5543\n用户ID：5543');
    expect(readVisibleIdentity()?.userId).toBe('5543');
  });

  it('GUID 这类词里的 UID 不算用户 ID', () => {
    withBodyText('请求 GUID: 123456');
    expect(readVisibleIdentity()?.userId).toBeUndefined();
  });

  it('页面文本的 ID 与记录不符、但用户名对得上时按用户名为准，不清会话', () => {
    const v = verifyIdentity(
      { userId: '5544', username: 'fzk520', source: 'visible' },
      'fzk520',
      '5543',
    );
    expect(v.match).toBe('confirmed');
    expect(v.detail).toContain('按用户名为准');
  });

  it('同样的旁证不能让接口读到的不符被放过 —— 接口才是权威答案', () => {
    const v = verifyIdentity(
      { userId: '5544', username: 'fzk520', source: 'api' },
      'fzk520',
      '5543',
    );
    expect(v.match).toBe('mismatch');
  });
});

/**
 * 「读不到身份 → 退出重登」是最招人烦的一条路：站点其实把账号印在页面上了，
 * 只是没有「用户 ID」标签、不是 @句柄、邮箱还被打了码，正则挖不出来。
 * 换个问法（这一页上有没有我要签的这个人）就能答上来。
 */
describe('findAccountOnPage 反向核对本账号', () => {
  it('页面上原样印着邮箱时命中', () => {
    expect(findAccountOnPage('gykplus@outlook.com', '账户 gykplus@outlook.com 余额 $2470.00'))
      .toMatchObject({ masked: false });
  });

  it('纯用户名也能命中 —— 这类站点不显示邮箱也没有 ID 标签', () => {
    expect(findAccountOnPage('fzk520', '欢迎回来，fzk520')).toMatchObject({ matched: 'fzk520' });
  });

  it('打码邮箱按可见部分严格比对', () => {
    expect(findAccountOnPage('gykplus@outlook.com', '当前账号 gyk***@outlook.com'))
      .toMatchObject({ masked: true });
  });

  it('打码邮箱前缀对不上就不算命中', () => {
    expect(findAccountOnPage('gykplus@outlook.com', '当前账号 abc***@outlook.com')).toBeNull();
  });

  it('同域但可见部分全被打掉时不算命中 —— 同域任何人都能对上', () => {
    expect(findAccountOnPage('gykplus@outlook.com', '当前账号 ***@outlook.com')).toBeNull();
  });

  it('域名不同不算命中', () => {
    expect(findAccountOnPage('gykplus@outlook.com', '当前账号 gyk***@gmail.com')).toBeNull();
  });

  it('只是更长一串里的一段不算命中', () => {
    expect(findAccountOnPage('fzk520', 'fzk5201314 的邀请码')).toBeNull();
  });

  it('太短的名字不参与比对，避免在正文里撞车', () => {
    expect(findAccountOnPage('abc', 'abc 出现在任意文字里')).toBeNull();
  });

  it('页面上没有本账号时返回 null —— 没命中不等于登着别人，上层仍走保守路径', () => {
    expect(findAccountOnPage('gykplus@outlook.com', '每日签到 累计 38 天')).toBeNull();
  });
});

describe('sub2api 验证特定凭据时不认本地残留', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const sub2apiSite = () => tokenSite({ adapter: { siteType: 'sub2api' } });

  it('不带 token 时照旧先读 auth_user，省一次请求', async () => {
    const { local } = stubPageEnv();
    local.setItem('auth_user', JSON.stringify({ id: 7, email: 'a@b.com' }));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(readPageIdentity(sub2apiSite())).resolves.toMatchObject({ userId: '7', source: 'storage' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('带 token 验证凭据归属时以接口为准，上一个账号的残留不许抢答', async () => {
    // 注入本账号 token 后立刻核对那一步：auth_user 还是上个账号的，
    // 让它抢答会把一份有效凭据判成「不是本账号」
    const { local } = stubPageEnv();
    local.setItem('auth_user', JSON.stringify({ id: 7, email: 'stale@b.com' }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: { id: 9, email: 'fresh@b.com' } })));

    await expect(readPageIdentity(sub2apiSite(), 'fresh-token'))
      .resolves.toMatchObject({ userId: '9', source: 'api' });
  });

  it('接口完全不通时才回落到本地副本，来源标成 storage', async () => {
    const { local } = stubPageEnv();
    local.setItem('auth_user', JSON.stringify({ id: 7, email: 'a@b.com' }));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    await expect(readPageIdentity(sub2apiSite(), 'tok'))
      .resolves.toMatchObject({ userId: '7', source: 'storage' });
  });

  it('serverOnly：只要服务端回答，本地副本再新也不抢答', async () => {
    const { local } = stubPageEnv();
    local.setItem('auth_user', JSON.stringify({ id: 7, email: 'stale@b.com' }));
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: { id: 9, email: 'fresh@b.com' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(readPageIdentity(sub2apiSite(), undefined, { serverOnly: true }))
      .resolves.toMatchObject({ userId: '9', source: 'api' });
    expect(fetchMock).toHaveBeenCalled();
  });

  /**
   * 身份接口的 401 **不能**用来判断「用户掉线」。
   *
   * 实测 8 个 new-api 分叉（2026-11-01）：它们的身份接口只认
   * `Authorization: Bearer`，用 cookie 去问必然 401；补上所有已知 user-id 兼容头
   * 也照样 401。而页面可能正停在已登录的资料页上。
   *
   * 早先的实现按响应体措辞区分「要 token」和「会话真失效」，逐个站点补正则。
   * 结果是新增站点换一种说法就再坏一次 —— 判据绑在服务端文案上，注定追不完。
   * 现在这条证据被整体移除：401 只表示「读不到身份」，不代表掉线。
   * 掉线由页面形态（登录表单 / 登录路由）与导航行为判定。
   */
  it.each([
    ['kapibala / htai91 / kid1412 / leilei', '{"code":"AUTH_UNAUTHORIZED","message":"Unauthorized, invalid access token","success":false}'],
    ['api.gemai.cc / api.futureppo.top / vsllm', '{"message":"Unauthorized, not logged in and no access token provided","success":false}'],
    ['agentrouter.org', '{"message":"无权进行此操作，未登录且未提供 access token","success":false}'],
    ['sub.100xlabs.space / k40.shengqainbang.cn', '{"code":"UNAUTHORIZED","message":"Authorization header is required"}'],
    ['session expired', '{"message":"session expired, please log in again","success":false}'],
    ['裸 Unauthorized', '{"message":"Unauthorized","success":false}'],
    ['未来任何新措辞', '{"message":"whatever a brand new fork decides to say","success":false}'],
  ])('serverOnly：%s 的 401 一律只当「读不到身份」，不判掉线', async (_label, body) => {
    stubPageEnv();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ...jsonResponse({}, false),
      status: 401,
      text: async () => body,
    }));
    // 读不到身份 → null；调用方不得据此认为会话失效。
    await expect(readPageIdentity(sub2apiSite(), undefined, { serverOnly: true })).resolves.toBeNull();
  });

  it('serverOnly：401 与 403/404/500 一视同仁 —— 都只是读不到身份', async () => {
    for (const status of [401, 403, 404, 500]) {
      stubPageEnv();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ...jsonResponse({}, false), status }));
      await expect(readPageIdentity(sub2apiSite(), undefined, { serverOnly: true }), String(status)).resolves.toBeNull();
    }
  });

  it('serverOnly：前一个端点 401 不影响后续端点读到真实身份', async () => {
    stubPageEnv('https://api.example.com/profile');
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ...jsonResponse({}, false), status: 401 })
      .mockResolvedValue(jsonResponse({ data: { id: 9, email: 'fresh@b.com' } })));
    await expect(readPageIdentity(newApiSite(), undefined, { serverOnly: true }))
      .resolves.toMatchObject({ userId: '9', source: 'api' });
  });

  it('serverOnly：接口读不到时返回 null，不回落到本地副本或页面文字', async () => {
    const { local } = stubPageEnv();
    local.setItem('auth_user', JSON.stringify({ id: 7, email: 'stale@b.com' }));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    await expect(readPageIdentity(sub2apiSite(), undefined, { serverOnly: true })).resolves.toBeNull();
  });
});

/*
 * orevx 实测形态（父方 22:40 侦察 + 本工作方 22:5x 复核）：
 *  - 前端 SPA 在 https://orevx.ai，真实 API 在跨域 https://server.orevx.ai/api
 *    （config.js 的 API_URL）；身份接口 GET /api/user/me 只接受
 *    `Accept: application/cbor`（JSON 协商回 406 CBOR_RESPONSE_REQUIRED），
 *    认证是 `Authorization: Bearer <token>`，响应是 CBOR map；
 *  - 登录态持久化在 localStorage（auth-token / auth-user / auth-session-id /
 *    api-key），仅本次会话登录时写 sessionStorage，键名相同；
 *  - 全部使用虚构 sentinel 值，不碰任何真实账号。
 */

/** orevx 形态的 identitySource（桥接字段，待并入共享类型；见 orevx-identity-report.md） */
const OREVX_IDENTITY_SOURCE = {
  storageKey: 'auth-user',
  endpoint: 'https://server.orevx.ai/api/user/me',
  tokenKey: 'auth-token',
};

const orevxSite = (identitySource: unknown = OREVX_IDENTITY_SOURCE, overrides: Partial<SiteConfig> = {}): SiteConfig => ({
  id: 'orevx',
  name: 'Orevx',
  loginUrl: 'https://orevx.ai/login',
  loginMethod: 'oauth' as const,
  selectors: { username: '', password: '', submit: '' },
  closeModalSelectors: [],
  identitySource,
  ...overrides,
} as SiteConfig);

/** 测试内独立的最小 CBOR 编码器（map/短文本/小整数；不复用被测解码器） */
function cborUserFixture(value: Record<string, string | number>): Uint8Array {
  const head = (major: number, n: number): number[] => {
    if (n < 24) return [(major << 5) | n];
    if (n < 0x100) return [(major << 5) | 24, n];
    return [(major << 5) | 25, (n >> 8) & 0xff, n & 0xff];
  };
  const text = (item: string): number[] => {
    const utf8 = Array.from(new TextEncoder().encode(item));
    return [...head(3, utf8.length), ...utf8];
  };
  const entries = Object.entries(value);
  const out: number[] = [...head(5, entries.length)];
  for (const [key, item] of entries) {
    out.push(...text(key));
    out.push(...(typeof item === 'number' ? head(0, item) : text(item)));
  }
  return Uint8Array.from(out);
}

/** 假 CBOR Response：arrayBuffer 返回给定字节 */
function cborResponse(bytes: Uint8Array) {
  return {
    ok: true,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/cbor' : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

describe('跨域身份接口（identitySource.endpoint，默认关闭）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('orevx 形态：带 Bearer token + cbor 协商请求跨域接口，解出身份', async () => {
    const { local } = stubPageEnv('https://orevx.ai/user');
    local.setItem('auth-token', 'sentinel-token-abc');
    const fetchMock = vi.fn().mockResolvedValue(cborResponse(cborUserFixture({
      id: 4242,
      username: 'sentinel-user',
      email: 'sentinel@example.com',
    })));
    vi.stubGlobal('fetch', fetchMock);

    const result = await readPageIdentity(orevxSite());

    expect(result).toMatchObject({
      userId: '4242',
      username: 'sentinel-user',
      email: 'sentinel@example.com',
      source: 'api',
    });
    // 只打配置的跨域接口一次；没有先轮询同源默认列表
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://server.orevx.ai/api/user/me');
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('omit');
    expect(init.headers.Authorization).toBe('Bearer sentinel-token-abc');
    expect(String(init.headers.Accept)).toContain('application/cbor');
  });

  it('session-only 登录：token 在 sessionStorage 同样能读到', async () => {
    const { session } = stubPageEnv('https://orevx.ai/user');
    session.setItem('auth-token', 'sentinel-token-session');
    const fetchMock = vi.fn().mockResolvedValue(cborResponse(cborUserFixture({ id: 7 })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(readPageIdentity(orevxSite())).resolves.toMatchObject({ userId: '7', source: 'api' });
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe('Bearer sentinel-token-session');
  });

  it('接口返回 JSON 也能解析（按 content-type 判定，不写死 cbor）', async () => {
    const { local } = stubPageEnv('https://orevx.ai/user');
    local.setItem('auth-token', 'sentinel-token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: { id: 11, email: 'sentinel@example.com' } })));

    await expect(readPageIdentity(orevxSite())).resolves.toMatchObject({ userId: '11', source: 'api' });
  });

  it('跨域接口 401 时退回配置的本地副本（来源标 storage）', async () => {
    const { local } = stubPageEnv('https://orevx.ai/user');
    local.setItem('auth-token', 'sentinel-token');
    local.setItem('auth-user', JSON.stringify({ id: 9, username: 'sentinel-cached' }));
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, headers: { get: () => null } });
    vi.stubGlobal('fetch', fetchMock);

    await expect(readPageIdentity(orevxSite())).resolves.toMatchObject({ userId: '9', source: 'storage' });
    // 本地副本命中后不再轮询同源接口
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('CBOR 响应损坏时按读不到处理，不抛异常、不影响回退', async () => {
    const { local } = stubPageEnv('https://orevx.ai/user');
    local.setItem('auth-token', 'sentinel-token');
    local.setItem('auth-user', JSON.stringify({ id: 8, username: 'sentinel-fallback' }));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/cbor' : null) },
      arrayBuffer: async () => Uint8Array.from([0x9f, 0xff]).buffer, // 不定长度数组：解码必失败
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(readPageIdentity(orevxSite())).resolves.toMatchObject({ userId: '8', source: 'storage' });
  });

  it('没有 token 时不发跨域请求，直接读本地副本', async () => {
    const { local } = stubPageEnv('https://orevx.ai/user');
    local.setItem('auth-user', JSON.stringify({ id: 5 }));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(readPageIdentity(orevxSite())).resolves.toMatchObject({ userId: '5', source: 'storage' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('配置的接口不在登录域（evil.com）时绝不发跨域请求，只轮询同源接口', async () => {
    const { local } = stubPageEnv('https://orevx.ai/user');
    local.setItem('auth-token', 'sentinel-token');
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, headers: { get: () => null } });
    vi.stubGlobal('fetch', fetchMock);

    await readPageIdentity(orevxSite({ endpoint: 'https://evil.com/api/user/me', tokenKey: 'auth-token' }));

    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('evil.com'))).toBe(false);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.every(([url]) => String(url).startsWith('https://orevx.ai/'))).toBe(true);
  });

  it('http 接口不发请求（仅 https）', async () => {
    const { local } = stubPageEnv('https://orevx.ai/user');
    local.setItem('auth-token', 'sentinel-token');
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, headers: { get: () => null } });
    vi.stubGlobal('fetch', fetchMock);

    await readPageIdentity(orevxSite({ endpoint: 'http://server.orevx.ai/api/user/me', tokenKey: 'auth-token' }));

    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('server.orevx.ai'))).toBe(false);
  });

  it('未配置 identitySource 的站点只打同源（默认关，行为不变）', async () => {
    stubPageEnv('https://api.example.com/console');
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, headers: { get: () => null } });
    vi.stubGlobal('fetch', fetchMock);

    await readPageIdentity(newApiSite());

    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.every(([url]) => String(url).startsWith('https://api.example.com/'))).toBe(true);
  });

  it('带 token 校验凭据归属时，接口调用使用传入的 token 而不是本地残留', async () => {
    const { local } = stubPageEnv('https://orevx.ai/user');
    local.setItem('auth-token', 'stale-token');
    local.setItem('auth-user', JSON.stringify({ id: 7, email: 'stale@example.com' }));
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: { id: 9, email: 'fresh@example.com' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(readPageIdentity(orevxSite(), 'fresh-token')).resolves.toMatchObject({ userId: '9', source: 'api' });
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe('Bearer fresh-token');
  });
});

describe('站点可配置身份存储键（identitySource.storageKey）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const storedSite = (identitySource: unknown): SiteConfig => orevxSite(identitySource);

  it('只读本地 JSON，不发任何请求', async () => {
    const { local } = stubPageEnv('https://orevx.ai/user');
    local.setItem('auth-user', JSON.stringify({ id: 3, email: 'sentinel@example.com' }));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(readPageIdentity(storedSite({ storageKey: 'auth-user' })))
      .resolves.toMatchObject({ userId: '3', email: 'sentinel@example.com', source: 'storage' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('localStorage 没有时读 sessionStorage（与 orevx 前端回读顺序一致）', async () => {
    const { session } = stubPageEnv('https://orevx.ai/user');
    session.setItem('auth-user', JSON.stringify({ id: 4 }));
    vi.stubGlobal('fetch', vi.fn());

    await expect(readPageIdentity(storedSite({ storageKey: 'auth-user' })))
      .resolves.toMatchObject({ userId: '4', source: 'storage' });
  });

  it('storageType 显式限定后不读另一个存储', async () => {
    const { local, session } = stubPageEnv('https://orevx.ai/user');
    local.setItem('auth-user', JSON.stringify({ id: 1 }));
    session.setItem('auth-user', JSON.stringify({ id: 2 }));
    vi.stubGlobal('fetch', vi.fn());

    await expect(readPageIdentity(storedSite({ storageKey: 'auth-user', storageType: 'sessionStorage' })))
      .resolves.toMatchObject({ userId: '2', source: 'storage' });
  });

  it('JSON 损坏时安静回退（不抛异常），继续走接口与页面文本流程', async () => {
    const { local } = stubPageEnv('https://orevx.ai/user');
    local.setItem('auth-user', '{ not json');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, headers: { get: () => null } }));
    vi.stubGlobal('document', { body: { innerText: '用户 ID 55' } });

    await expect(readPageIdentity(storedSite({ storageKey: 'auth-user' })))
      .resolves.toMatchObject({ userId: '55', source: 'visible' });
  });

  it('只读：读取前后存储值原样保留', async () => {
    const { local } = stubPageEnv('https://orevx.ai/user');
    const raw = JSON.stringify({ id: 6, username: 'sentinel-readonly' });
    local.setItem('auth-user', raw);
    vi.stubGlobal('fetch', vi.fn());

    await readPageIdentity(storedSite({ storageKey: 'auth-user' }));
    expect(local.getItem('auth-user')).toBe(raw);
  });
});
