import { describe, expect, it, vi } from 'vitest';
import { ADAPTER_FAMILIES, SITE_TYPES, type Account, type SiteConfig } from '@/types';
import {
  buildHeadlessHeaders,
  eligibilitySignalOf,
  isCapturedTokenExpired,
  isHeadlessBrowserFallbackSafe,
  isHeadlessSuccess,
  tryHeadlessCheckin,
  type HeadlessDeps,
} from '@/background/checkin/headless-checkin';

const site: SiteConfig = {
  id: 'new-api-site',
  name: 'Test New API',
  loginUrl: 'https://relay.example.com/login',
  selectors: {} as SiteConfig['selectors'],
  closeModalSelectors: [],
  adapter: { siteType: SITE_TYPES.NEW_API, family: ADAPTER_FAMILIES.NEW_API },
  checkin: { method: 'api' },
};

const account = (overrides: Partial<Account> = {}): Account => ({
  id: 'account-1',
  siteId: site.id,
  username: 'user@example.com',
  password: 'password',
  identity: { userId: '42', session: { capturedAt: 1 } },
  ...overrides,
});

function response(status: number, body: unknown, contentType = 'application/json'): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': contentType },
  });
}

function depsFor(routes: Record<string, Response | (() => Response | Promise<Response>)>): HeadlessDeps {
  const now = vi.fn(() => 1_700_000_000_000);
  return {
    now,
    sleep: vi.fn(async () => undefined),
    fetch: vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const { pathname, search } = new URL(url);
      // 以 '?' 开头的键按查询串前缀匹配（台账探测带 ?month=），其余按路径匹配
      // 且要求没有查询串 —— 否则 '/api/user/checkin' 会把台账请求一并吃掉。
      const route = Object.entries(routes).find(([key]) => (key.startsWith('?')
        ? search.startsWith(key)
        : pathname.endsWith(key) && !search))?.[1];
      if (!route) throw new Error(`unmocked URL: ${url}`);
      return typeof route === 'function' ? route() : route.clone();
    }) as typeof fetch,
  };
}

function balance(quota: number, usedQuota = 0) {
  return { success: true, data: { quota, used_quota: usedQuota } };
}

/**
 * 台账响应。`depsFor` 按 endsWith 匹配，而台账请求带 `?month=`，
 * 所以它天然落到 '?month=' 这条路由上，与签到 POST 互不干扰。
 */
function statsBody(records: Array<[string, number]>, checkedInToday: boolean, enabled = true) {
  return {
    success: true,
    data: {
      enabled,
      stats: {
        checked_in_today: checkedInToday,
        records: records.map(([checkin_date, quota_awarded]) => ({ checkin_date, quota_awarded })),
      },
    },
  };
}

describe('isHeadlessSuccess / eligibilitySignalOf', () => {
  it.each(['workflow'] as const)('显式 %s 签到流程不发接口请求，交给登录后的浏览器回放', async (method) => {
    const deps = depsFor({});
    const result = await tryHeadlessCheckin(account(), {
      ...site,
      checkin: { method, workflow: { steps: [{ type: 'click', selector: '#checkin' }] } },
    }, deps);

    expect(result.verdict).toBe('inconclusive');
    expect(isHeadlessBrowserFallbackSafe(result.verdict)).toBe(true);
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it('自动识别中残留的学习记录不禁用原有只读接口探测', async () => {
    const deps = depsFor({});
    await tryHeadlessCheckin(account(), {
      ...site, checkin: { method: 'auto', workflow: { steps: [], route: ['/obsolete'] } },
    }, deps);
    expect(deps.fetch).toHaveBeenCalled();
    expect(vi.mocked(deps.fetch).mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });

  it('只有 confirmed 和 already 能跳过浏览器', () => {
    expect(isHeadlessSuccess('confirmed')).toBe(true);
    expect(isHeadlessSuccess('already')).toBe(true);
    expect(isHeadlessSuccess('inconclusive')).toBe(false);
    expect(isHeadlessSuccess('error')).toBe(false);
  });

  it('写请求无法验证时禁止浏览器重复提交', () => {
    expect(isHeadlessBrowserFallbackSafe('inconclusive')).toBe(true);
    expect(isHeadlessBrowserFallbackSafe('error')).toBe(true);
    expect(isHeadlessBrowserFallbackSafe('write-unverified')).toBe(false);
  });

  it('判定映射到熔断信号', () => {
    expect(eligibilitySignalOf('confirmed')).toBe('success');
    expect(eligibilitySignalOf('already')).toBe('success');
    expect(eligibilitySignalOf('unsupported')).toBe('unsupported');
    expect(eligibilitySignalOf('auth-expired')).toBe('auth-expired');
    expect(eligibilitySignalOf('inconclusive')).toBe('inconclusive');
    expect(eligibilitySignalOf('write-unverified')).toBe('inconclusive');
    expect(eligibilitySignalOf('error')).toBe('error');
  });
});

describe('buildHeadlessHeaders', () => {
  it('new-api 同时构造兼容的 user-id 请求头', () => {
    const headers = buildHeadlessHeaders(account(), site, 'userIdHeaders');
    expect(headers['New-API-User']).toBe('42');
    expect(headers['Veloera-User']).toBe('42');
    expect(headers.Accept).toBe('application/json');
  });

  it('Sub2API 使用抓取的 accessToken，并优先于手贴 token', () => {
    const headers = buildHeadlessHeaders(
      account({ apiToken: 'manual-token', identity: { userId: '1', session: { accessToken: 'captured-token', capturedAt: 1 } } }),
      { ...site, tokenConfig: { storageKey: 'auth_token', headerName: 'Authorization', headerPrefix: 'Bearer ' } },
      'bearer',
    );
    expect(headers.Authorization).toBe('Bearer captured-token');
  });

  it('没有 Bearer 时打内部标记，调用方不发必然失败的请求', () => {
    const headers = buildHeadlessHeaders(account({ identity: { userId: '42', session: { capturedAt: 1 } } }), site, 'bearer');
    expect(headers.__missingBearer).toBe('1');
  });
});

describe('isCapturedTokenExpired', () => {
  it('到期前 30 秒就认为不可用了', () => {
    const now = 1_700_000_000_000;
    const a = account({ identity: { session: { tokenExpiresAt: now + 29_999, capturedAt: 1 } } });
    expect(isCapturedTokenExpired(a, now)).toBe(true);
  });

  it('没有过期时间不擅自判过期', () => {
    expect(isCapturedTokenExpired(account(), 1_700_000_000_000)).toBe(false);
  });
});

describe('tryHeadlessCheckin 判定矩阵', () => {
  it('成功 + 余额增加 → confirmed，不应回退浏览器', async () => {
    let balanceCalls = 0;
    const deps = depsFor({
      '/api/user/self': () => response(200, balance(balanceCalls++ === 0 ? 100 : 150)),
      '/api/user/checkin': response(200, { success: true, message: '签到成功' }),
    });
    const result = await tryHeadlessCheckin(account(), site, deps);
    expect(result.verdict).toBe('confirmed');
    expect(result.metrics?.verdict).toBe('rewarded');
    expect(result.steps.some((step) => step.includes('额度差分'))).toBe(true);
  });

  it('已签到响应 + 余额不变 → already，不应回退浏览器', async () => {
    const deps = depsFor({
      '/api/user/self': response(200, balance(100)),
      '/api/user/checkin': response(200, { success: false, message: '今日已签到' }),
    });
    const result = await tryHeadlessCheckin(account(), site, deps);
    expect(result.verdict).toBe('already');
    expect(result.message).toContain('今日已签到');
  });

  it('成功但余额不变 → write-unverified，既不谎报成功也不允许重复提交', async () => {
    const deps = depsFor({
      '/api/user/self': response(200, balance(100)),
      '/api/user/checkin': response(200, { success: true, message: '签到成功' }),
    });
    const result = await tryHeadlessCheckin(account(), site, deps);
    expect(result.verdict).toBe('write-unverified');
    expect(result.message).toContain('额度未增加');
    expect(isHeadlessBrowserFallbackSafe(result.verdict)).toBe(false);
  });

  it('没有只读验证通道时在写请求前退出', async () => {
    const deps = depsFor({
      '/api/user/self': response(404, 'Not Found', 'text/plain'),
      '/api/user/checkin': response(200, { success: true, message: '签到成功' }),
    });
    const result = await tryHeadlessCheckin(account(), site, deps);
    expect(result.verdict).toBe('inconclusive');
    expect(result.message).toContain('只读验证通道');
    const methods = (deps.fetch as ReturnType<typeof vi.fn>).mock.calls.map(([, init]) => init?.method);
    expect(methods).not.toContain('POST');
  });

  it('401 → auth-expired，交给浏览器完整流程', async () => {
    const deps = depsFor({
      '/api/user/self': response(200, balance(100)),
      '/api/user/checkin': response(401, { message: 'unauthorized' }),
    });
    const result = await tryHeadlessCheckin(account(), site, deps);
    expect(result.verdict).toBe('auth-expired');
  });

  /**
   * 家族兜底表现在有多个候选端点（各分叉的签到路径命名不统一）。
   *
   * 「站点不支持」的判据是**所有候选都 404**，不是第一个 404 —— 只要还有候选
   * 就继续试，那正是补齐这张表要解决的问题：漏掉一条会让本可直连的站点
   * 被判不支持，连续三次后熔断 24 小时，之后每天被迫开标签页过验证码。
   *
   * 所以这里把全部候选都映射成 404。只映射一个的话，第二个候选会走进
   * `depsFor` 的 `unmocked URL` 抛错分支，被正确地判成 write-unverified
   * （请求可能已到达站点），那是另一条路径的行为。
   */
  it('所有候选端点都 404 → unsupported，供熔断计数', async () => {
    const notFound = () => response(404, 'Not Found', 'text/plain');
    const deps = depsFor({
      '/api/user/self': response(200, balance(100)),
      '/api/user/checkin': notFound,
      '/api/user/check_in': notFound,
      '/api/user/clock_in': notFound,
      '/api/user/daily_checkin': notFound,
      '/api/user/sign_in': notFound,
    });
    const result = await tryHeadlessCheckin(account(), site, deps);
    expect(result.verdict).toBe('unsupported');
  });

  it('第一个候选 404、后续命中 → 不误判为不支持', async () => {
    const deps = depsFor({
      '/api/user/self': response(200, balance(100)),
      '/api/user/checkin': response(404, 'Not Found', 'text/plain'),
      // 第二个候选返回明确的已签到 —— 这正是禾维那类站点的形态
      '/api/user/check_in': response(200, { success: true, message: '今日已签到' }),
    });
    const result = await tryHeadlessCheckin(account(), site, deps);

    expect(result.verdict).not.toBe('unsupported');
    expect(['already', 'confirmed', 'inconclusive']).toContain(result.verdict);
  });

  it('预检阶段网络错误且没有验证通道 → inconclusive，并且不发写请求', async () => {
    const deps = depsFor({});
    const result = await tryHeadlessCheckin(account(), site, deps);
    expect(result.verdict).toBe('inconclusive');
    const methods = (deps.fetch as ReturnType<typeof vi.fn>).mock.calls.map(([, init]) => init?.method);
    expect(methods).not.toContain('POST');
  });

  it('写请求发出后响应丢失 → write-unverified，不允许浏览器重试', async () => {
    const deps = depsFor({
      '/api/user/self': response(200, balance(100)),
      '/api/user/checkin': () => { throw new Error('response lost'); },
    });
    const result = await tryHeadlessCheckin(account(), site, deps);
    expect(result.verdict).toBe('write-unverified');
    expect(result.message).toContain('未再自动重试');
    expect(isHeadlessBrowserFallbackSafe(result.verdict)).toBe(false);
  });

  it('未知站点无 apiUrl → unsupported 且零网络请求', async () => {
    const unknown: SiteConfig = { ...site, id: 'unknown', adapter: { siteType: SITE_TYPES.UNKNOWN, family: ADAPTER_FAMILIES.UNSUPPORTED } };
    const deps = depsFor({});
    const result = await tryHeadlessCheckin(account(), unknown, deps);
    expect(result.verdict).toBe('unsupported');
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it('外部显式 apiUrl 被同源闸拒绝，最终 unsupported', async () => {
    const external = { ...site, checkin: { method: 'api' as const, apiUrl: 'https://evil.example/checkin' } };
    const deps = depsFor({});
    const result = await tryHeadlessCheckin(account(), external, deps);
    expect(result.verdict).toBe('unsupported');
  });

  it('过期 token 不发请求，直接 auth-expired', async () => {
    const now = 1_700_000_000_000;
    const expired = account({ identity: { session: { accessToken: 'old', tokenExpiresAt: now - 1, capturedAt: 1 } } });
    const deps = depsFor({});
    deps.now = vi.fn(() => now);
    const result = await tryHeadlessCheckin(expired, { ...site, adapter: { siteType: SITE_TYPES.SUB2API, family: ADAPTER_FAMILIES.SUB2API } }, deps);
    expect(result.verdict).toBe('auth-expired');
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it('显式 GET 签到接口遵守方法且不带 body', async () => {
    const custom = { ...site, checkin: { method: 'api' as const, apiUrl: '/api/custom', apiMethod: 'GET' as const } };
    const deps = depsFor({
      '/api/user/self': response(200, balance(100)),
      '/api/custom': response(200, { success: true }),
    });
    const result = await tryHeadlessCheckin(account(), custom, deps);
    expect(result.verdict).toBe('write-unverified');
    expect((deps.fetch as ReturnType<typeof vi.fn>).mock.calls.some(([, init]) => init?.method === 'GET')).toBe(true);
  });

  it('自定义 POST 端点不冒充标准台账做 GET 预检', async () => {
    let balanceCalls = 0;
    const custom = { ...site, checkin: { method: 'api' as const, apiUrl: '/api/custom', apiMethod: 'POST' as const } };
    const deps = depsFor({
      '/api/user/self': () => response(200, balance(balanceCalls++ === 0 ? 100 : 150)),
      '/api/custom': response(200, { success: true, message: '签到成功' }),
    });
    const result = await tryHeadlessCheckin(account(), custom, deps);
    expect(result.verdict).toBe('confirmed');
    const urls = (deps.fetch as ReturnType<typeof vi.fn>).mock.calls.map(([input]) => String(input));
    expect(urls.some((url) => url.includes('/api/custom?month='))).toBe(false);
  });

  it('未知家族的自定义端点缺少验证通道时完全不触碰签到地址', async () => {
    const custom = {
      ...site,
      adapter: { siteType: SITE_TYPES.UNKNOWN, family: ADAPTER_FAMILIES.UNSUPPORTED },
      checkin: { method: 'api' as const, apiUrl: '/api/checkin', apiMethod: 'POST' as const },
    };
    const deps = depsFor({
      '/api/user/self': response(404, 'Not Found', 'text/plain'),
      '/api/user/info': response(404, 'Not Found', 'text/plain'),
      '/api/v1/check-in/status': response(404, 'Not Found', 'text/plain'),
      '/api/v1/auth/me': response(404, 'Not Found', 'text/plain'),
    });
    const result = await tryHeadlessCheckin(account(), custom, deps);
    expect(result.verdict).toBe('inconclusive');
    const urls = (deps.fetch as ReturnType<typeof vi.fn>).mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(urls).not.toContain('/api/checkin');
  });
});

describe('tryHeadlessCheckin 台账优先', () => {
  it('台账记下本次奖励 → confirmed，金额取 quota_awarded 而非余额差分', async () => {
    let probe = 0;
    const deps = depsFor({
      '?month=': () => response(200, probe++ === 0
        ? statsBody([['2026-08-18', 2_973_248]], false)
        : statsBody([['2026-08-18', 2_973_248], ['2026-08-19', 3_100_000]], true)),
      '/api/user/self': response(200, balance(100)),
      '/api/user/checkin': response(200, { success: true, message: '签到成功' }),
    });
    const result = await tryHeadlessCheckin(account(), site, deps);
    expect(result.verdict).toBe('confirmed');
    expect(result.metrics?.verdict).toBe('rewarded');
    // 余额两次都读到 100，差分本来会判 unchanged 然后 inconclusive。
    // 台账给出 3100000，这才是站点自己记的账。
    expect(result.metrics?.reward).toBe(3_100_000);
    expect(result.steps.some((step) => step.includes('台账已记入本次奖励'))).toBe(true);
  });

  it('台账说今日已签 → already，不发签到请求', async () => {
    const deps = depsFor({
      '?month=': response(200, statsBody([['2026-08-19', 2_973_248]], true)),
      '/api/user/self': response(200, balance(100)),
    });
    const result = await tryHeadlessCheckin(account(), site, deps);
    expect(result.verdict).toBe('already');
    const methods = (deps.fetch as ReturnType<typeof vi.fn>).mock.calls.map(([, init]) => init?.method);
    expect(methods).not.toContain('POST');
  });

  it('台账说今日已签也要交出余额 —— 这条路不开标签页，界面只能靠它', async () => {
    const deps = depsFor({
      '?month=': response(200, statsBody([['2026-08-19', 2_973_248]], true)),
      '/api/user/self': response(200, balance(227_850_000, 12_000)),
    });
    const result = await tryHeadlessCheckin(account(), site, deps);
    expect(result.balance).toEqual({ quota: 227_850_000, usedQuota: 12_000, at: 1_700_000_000_000 });
  });
});

/**
 * 直连成功必须交出余额，否则站点卡片显示「本站余额 未获取」。
 *
 * 站点卡片和顶部合计走 sumBalances、只认 KEYS.balances 这个独立存储；
 * 而直连路径不开标签页，浏览器流程里的 saveBalance 钩子不会跑。
 * outcome.balance 是这条路唯一的余额出口，每条成功出口都得有。
 */
describe('tryHeadlessCheckin 交出余额供落库', () => {
  it('台账确认奖励时交出余额', async () => {
    let probe = 0;
    const deps = depsFor({
      '?month=': () => response(200, probe++ === 0
        ? statsBody([], false)
        : statsBody([['2026-08-19', 3_100_000]], true)),
      '/api/user/self': response(200, balance(227_850_000)),
      '/api/user/checkin': response(200, { success: true, message: '签到成功' }),
    });
    const result = await tryHeadlessCheckin(account(), site, deps);
    expect(result.verdict).toBe('confirmed');
    expect(result.balance?.quota).toBe(227_850_000);
  });

  it('余额差分确认时交出余额', async () => {
    let balanceCalls = 0;
    const deps = depsFor({
      '?month=': response(404, 'Not Found', 'text/plain'),
      '/api/user/self': () => response(200, balance(balanceCalls++ === 0 ? 100 : 150)),
      '/api/user/checkin': response(200, { success: true, message: '签到成功' }),
    });
    const result = await tryHeadlessCheckin(account(), site, deps);
    expect(result.verdict).toBe('confirmed');
    expect(result.balance?.quota).toBe(150);
  });

  it('接口回已签到时交出余额', async () => {
    const deps = depsFor({
      '?month=': response(404, 'Not Found', 'text/plain'),
      '/api/user/self': response(200, balance(999)),
      '/api/user/checkin': response(200, { success: false, message: '今日已签到' }),
    });
    const result = await tryHeadlessCheckin(account(), site, deps);
    expect(result.verdict).toBe('already');
    expect(result.balance?.quota).toBe(999);
  });

  it('读不到余额时不编数字，balance 留空', async () => {
    const deps = depsFor({
      // 台账提供写前只读证据，因此可以安全请求并识别“已签到”；余额仍不可读。
      '?month=': response(200, statsBody([], false)),
      '/api/user/self': response(404, 'Not Found', 'text/plain'),
      '/api/user/checkin': response(200, { success: false, message: '今日已签到' }),
    });
    const result = await tryHeadlessCheckin(account(), site, deps);
    expect(result.verdict).toBe('already');
    expect(result.balance).toBeUndefined();
  });

  it('站点关闭签到 → unsupported，不发签到请求', async () => {
    const deps = depsFor({
      '?month=': response(200, statsBody([], false, false)),
      '/api/user/self': response(200, balance(100)),
    });
    const result = await tryHeadlessCheckin(account(), site, deps);
    expect(result.verdict).toBe('unsupported');
    expect(result.message).toContain('关闭签到');
  });

  it('台账翻牌但没给金额 → 仍判 confirmed，金额留空', async () => {
    let probe = 0;
    const deps = depsFor({
      '?month=': () => response(200, probe++ === 0 ? statsBody([], false) : statsBody([], true)),
      '/api/user/self': response(200, balance(100)),
      '/api/user/checkin': response(200, { success: true, message: '签到成功' }),
    });
    const result = await tryHeadlessCheckin(account(), site, deps);
    expect(result.verdict).toBe('confirmed');
    // 金额未知就记 unknown，不能是 0 —— 那会显示成「签到获得 $0.00」
    expect(result.metrics?.reward).toBeUndefined();
    expect(result.metrics?.verdict).toBe('unknown');
    expect(result.metrics?.quotaAfter).toBe(100);
    expect(result.steps.some((step) => step.includes('翻为已签到'))).toBe(true);
  });

  it('台账读不到时退回余额差分，行为与从前一致', async () => {
    let balanceCalls = 0;
    const deps = depsFor({
      '?month=': response(404, 'Not Found', 'text/plain'),
      '/api/user/self': () => response(200, balance(balanceCalls++ === 0 ? 100 : 150)),
      '/api/user/checkin': response(200, { success: true, message: '签到成功' }),
    });
    const result = await tryHeadlessCheckin(account(), site, deps);
    expect(result.verdict).toBe('confirmed');
    expect(result.metrics?.reward).toBe(50);
  });

  it('台账端点返回 SPA 兜底 HTML 时不影响签到本身', async () => {
    let balanceCalls = 0;
    const deps = depsFor({
      '?month=': response(200, '<!doctype html><html><body>app</body></html>', 'text/html'),
      '/api/user/self': () => response(200, balance(balanceCalls++ === 0 ? 100 : 150)),
      '/api/user/checkin': response(200, { success: true, message: '签到成功' }),
    });
    const result = await tryHeadlessCheckin(account(), site, deps);
    expect(result.verdict).toBe('confirmed');
    expect(result.metrics?.reward).toBe(50);
  });

  it('台账没变而余额也没变 → write-unverified，不谎报成功也不重复提交', async () => {
    const deps = depsFor({
      '?month=': response(200, statsBody([['2026-08-18', 2_973_248]], false)),
      '/api/user/self': response(200, balance(100)),
      '/api/user/checkin': response(200, { success: true, message: '签到成功' }),
    });
    const result = await tryHeadlessCheckin(account(), site, deps);
    expect(result.verdict).toBe('write-unverified');
    expect(isHeadlessBrowserFallbackSafe(result.verdict)).toBe(false);
  });

  it('GET 签到的站点不探台账 —— 那一发本身就会签到', async () => {
    const custom = { ...site, checkin: { method: 'api' as const, apiUrl: '/api/custom', apiMethod: 'GET' as const } };
    const deps = depsFor({
      '/api/user/self': response(200, balance(100)),
      '/api/custom': response(200, { success: true }),
    });
    await tryHeadlessCheckin(account(), custom, deps);
    const urls = (deps.fetch as ReturnType<typeof vi.fn>).mock.calls.map(([input]) => String(input));
    expect(urls.some((url) => url.includes('month='))).toBe(false);
  });

  it('台账查询带上本月月份参数', async () => {
    const deps = depsFor({
      '?month=': response(200, statsBody([], true)),
      '/api/user/self': response(200, balance(100)),
    });
    await tryHeadlessCheckin(account(), site, deps);
    const probe = (deps.fetch as ReturnType<typeof vi.fn>).mock.calls
      .map(([input]) => String(input))
      .find((url) => url.includes('month='));
    expect(probe).toMatch(/\/api\/user\/checkin\?month=\d{4}-\d{2}$/);
  });
});
