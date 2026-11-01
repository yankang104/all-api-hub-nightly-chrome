import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeSite } from '@/lib/site/site-probe';
import { validateSiteConfig } from '@/lib/site/site-security';
import { SITE_TYPES } from '@/types';

/** 造一个假 Response；探测只看 content-type 和 body */
function jsonResponse(payload: unknown, ok = true) {
  return {
    ok,
    headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function htmlResponse(html: string) {
  return {
    ok: true,
    headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
    json: async () => {
      throw new Error('not json');
    },
    text: async () => html,
  };
}

/** 按 URL 路由到不同响应，模拟真实站点只有某些端点存在 */
function routedFetch(routes: Record<string, unknown>) {
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    void init;
    const url = String(input);
    for (const [fragment, response] of Object.entries(routes)) {
      if (url.includes(fragment)) return response;
    }
    throw new Error(`no route for ${url}`);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('probeSite 端点指纹（主力判据）', () => {
  it('白标 Sub2API：域名和标题都不含关键词也能认出来', async () => {
    // 未登记域名的白标站仍要能靠接口信封识别，不能只支持已知站点。
    vi.stubGlobal('fetch', routedFetch({
      '/api/v1/auth/me': jsonResponse({ code: 'UNAUTHORIZED', message: '未登录' }),
    }));

    const result = await probeSite('https://white-label.example/login');
    expect(result.siteType).toBe(SITE_TYPES.SUB2API);
    expect(result.evidence).toContain('/api/v1/auth/me');
    // 预设必须跟着回来，否则用户还是得手填选择器
    expect(result.preset?.selectors.username).toBe('#email');
  });

  it('new-api 系：靠 success:false 认出，不与 Sub2API 混淆', async () => {
    vi.stubGlobal('fetch', routedFetch({
      '/api/v1/auth/me': jsonResponse({ error: 'not found' }, false),
      '/api/user/self': jsonResponse({ success: false, message: '无权进行此操作，未登录' }),
    }));

    const result = await probeSite('https://api.example.com/login');
    expect(result.siteType).toBe(SITE_TYPES.NEW_API);
    expect(result.preset?.selectors.username).toBe('#username');
  });

  it('code 是数字时不算 Sub2API —— 别把别家的信封认成它', async () => {
    // Sub2API 的判据是 code 为**字符串**。数字 code 是 VoAPI 那一类，
    // 认错会给出一套错的选择器，比认不出更糟。
    vi.stubGlobal('fetch', routedFetch({
      '/api/v1/auth/me': jsonResponse({ code: 401, data: null }),
      '/api/user/self': jsonResponse({ code: 401, data: null }),
    }));

    const result = await probeSite('https://vo.example.com/login');
    expect(result.siteType).toBe(SITE_TYPES.UNKNOWN);
  });

  it('SPA 把 404 兜底成 HTML 时不当作命中', async () => {
    // 状态 200 但内容是 index.html，不看 content-type 就会误判
    vi.stubGlobal('fetch', routedFetch({
      '/api/v1/auth/me': htmlResponse('<html><title>Dashboard</title></html>'),
      '/api/user/self': htmlResponse('<html><title>Dashboard</title></html>'),
      'https://spa.example.com/': htmlResponse('<html><title>Dashboard</title></html>'),
    }));

    const result = await probeSite('https://spa.example.com/login');
    expect(result.siteType).toBe(SITE_TYPES.UNKNOWN);
  });
});

describe('探测结果可直接保存', () => {
  it('Sub2API 预设自带完整 token 配置，用户不用手填', async () => {
    // 探测填好的配置必须能过 validateSiteConfig，否则用户点保存就报错，
    // 「自动识别」等于白做
    vi.stubGlobal('fetch', routedFetch({
      '/api/v1/auth/me': jsonResponse({ code: 'UNAUTHORIZED' }),
    }));

    const result = await probeSite('https://white-label.example/login');
    const errors = validateSiteConfig({
      ...result.preset!,
      name: '白标 Sub2API',
      loginUrl: 'https://white-label.example/login',
    });

    expect(errors).toEqual([]);
    expect(result.preset?.loginMethod).toBe('token');
    expect(result.preset?.tokenConfig?.storageKey).toBe('auth_token');
    expect(result.preset?.tokenConfig?.headerPrefix).toBe('Bearer ');
  });

  it('百倍按精确域名直接得到表单登录与 /check-in 按钮流程', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await probeSite('https://sub.100xlabs.space/check-in');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.templateLabel).toBe('百倍');
    expect(result.evidence).toContain('sub.100xlabs.space');
    expect(result.preset).toMatchObject({
      loginMethod: 'form',
      checkin: { method: 'button', url: '/check-in' },
    });
  });

  it('new-api 预设仍然是账密表单，选择器齐全', async () => {
    vi.stubGlobal('fetch', routedFetch({
      '/api/v1/auth/me': jsonResponse({ nope: true }),
      '/api/user/self': jsonResponse({ success: false, message: '未登录' }),
    }));

    const result = await probeSite('https://api.example.com/login');
    const errors = validateSiteConfig({
      ...result.preset!,
      name: 'x',
      loginUrl: 'https://api.example.com/login',
    });

    expect(errors).toEqual([]);
  });
});

describe('probeSite 标题兜底', () => {
  it('端点都不中时退到首页标题', async () => {
    vi.stubGlobal('fetch', routedFetch({
      '/api/v1/auth/me': jsonResponse({ nothing: true }),
      '/api/user/self': jsonResponse({ nothing: true }),
      'https://x.example.com/': htmlResponse('<html><head><title>登录 - Sub2API</title></head></html>'),
    }));

    const result = await probeSite('https://x.example.com/login');
    expect(result.siteType).toBe(SITE_TYPES.SUB2API);
    expect(result.evidence).toContain('标题');
  });
});

describe('probeSite 探测请求本身', () => {
  it('不带凭据 —— 带了会拿到已登录的 200 让指纹失效', async () => {
    const fetchMock = routedFetch({
      '/api/v1/auth/me': jsonResponse({ code: 'UNAUTHORIZED' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await probeSite('https://sub.example.com/login');
    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.credentials).toBe('omit');
    expect(init.cache).toBe('no-store');
  });

  it('网络全挂时安静降级，不抛异常', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ERR_CONNECTION_REFUSED');
    }));

    const result = await probeSite('https://down.example.com/login');
    expect(result.siteType).toBe(SITE_TYPES.UNKNOWN);
  });

  it('地址为空或非法时不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect((await probeSite('   ')).siteType).toBe(SITE_TYPES.UNKNOWN);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('拒绝指向本机/内网的地址，在发请求前就拦下', async () => {
    // SSRF 闸门：探测在 background 带 <all_urls>，内网地址不能借扩展发出去
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    for (const url of [
      'http://127.0.0.1/login',
      'http://169.254.169.254/latest/meta-data',
      'https://foo.local/',
    ]) {
      const result = await probeSite(url);
      expect(result.siteType).toBe(SITE_TYPES.UNKNOWN);
      expect(result.evidence).toBe('目标地址指向本机或内网，已拒绝');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('probeSite 区分新旧两代 new-api 前端', () => {
  /** 带状态码的 HTML 响应（routedFetch 的 htmlResponse 只有 200）。 */
  function page(html: string, status = 200) {
    return { ...htmlResponse(html), ok: status >= 200 && status < 300, status };
  }

  it('未知域名的新版 React 界面：/sign-in 有登录页、/login 是 404 → 套新版预设', async () => {
    vi.stubGlobal('fetch', routedFetch({
      '/api/v1/auth/me': jsonResponse({ error: 'not found' }, false),
      '/api/user/self': jsonResponse({ success: false, message: '无权进行此操作，未登录' }),
      '/sign-in': page('<html><body><div id="root"></div></body></html>'),
      '/login': page('<html><body><h1>404</h1><a href="/">返回主页</a></body></html>', 404),
    }));

    const result = await probeSite('https://new-white-label.example/');
    expect(result.templateLabel).toContain('新版界面');
    expect(result.preset?.checkin?.url).toBe('/profile');
    expect(result.preset?.successIndicator).toBeTruthy();
  });

  it('旧版界面：/login 正常、/sign-in 不存在 → 维持旧版预设（行为与以前一致）', async () => {
    vi.stubGlobal('fetch', routedFetch({
      '/api/v1/auth/me': jsonResponse({ error: 'not found' }, false),
      '/api/user/self': jsonResponse({ success: false, message: '无权进行此操作，未登录' }),
      '/sign-in': page('<html><body><h1>404 Not Found</h1></body></html>', 404),
      '/login': page('<html><body><form><input name="username"><input type="password"></form></body></html>'),
    }));

    const result = await probeSite('https://old-white-label.example/login');
    expect(result.templateLabel).not.toContain('新版界面');
    expect(result.preset?.checkin?.url).toBe('/console/personal');
  });

  it('两条路由都拿不准（都是 SPA 外壳 200）：维持旧版判断，不瞎猜', async () => {
    vi.stubGlobal('fetch', routedFetch({
      '/api/v1/auth/me': jsonResponse({ error: 'not found' }, false),
      '/api/user/self': jsonResponse({ success: false, message: '无权进行此操作，未登录' }),
      '/sign-in': page('<html><body><div id="app"></div></body></html>'),
      '/login': page('<html><body><div id="app"></div></body></html>'),
    }));

    const result = await probeSite('https://ambiguous.example/');
    expect(result.templateLabel).not.toContain('新版界面');
  });
});
