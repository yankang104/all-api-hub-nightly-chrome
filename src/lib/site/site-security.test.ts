import { describe, expect, it } from 'vitest';
import type { SiteAuthBootstrapConfig, SiteConfig } from '@/types';
import {
  isGithubAuthUrl,
  isGithubCredentialStage,
  isGithubLoginUrl,
  isGithubLoggedOutUrl,
  isGithubLogoutUrl,
  isIdentityEndpointAllowed,
  isLikelyOAuthUrl,
  isGoogleAuthUrl,
  isSecureLoginUrl,
  siteIdentitySource,
  validateSiteConfig,
} from '@/lib/site/site-security';

describe('登录地址 HTTPS 约束', () => {
  it('允许 HTTPS 与本机回环 HTTP，拒绝公网 HTTP', () => {
    expect(isSecureLoginUrl('https://example.com/login')).toBe(true);
    expect(isSecureLoginUrl('http://localhost:3000/login')).toBe(true);
    expect(isSecureLoginUrl('http://127.0.0.1:3000/login')).toBe(true);
    expect(isSecureLoginUrl('http://[::1]:3000/login')).toBe(true);
    expect(isSecureLoginUrl('http://example.com/login')).toBe(false);
    expect(isSecureLoginUrl('http://dev.localhost/login')).toBe(false);
    expect(isSecureLoginUrl('file:///tmp/login.html')).toBe(false);
  });
});

describe('GitHub authentication URL allowlist', () => {
  it('allows only HTTPS GitHub authentication paths', () => {
    expect(isGithubAuthUrl('https://github.com/login')).toBe(true);
    expect(isGithubAuthUrl('https://github.com/logout')).toBe(true);
    expect(isGithubAuthUrl('https://github.com/login/oauth/authorize?client_id=1')).toBe(true);
    expect(isGithubAuthUrl('https://github.com/sessions/two-factor')).toBe(true);
    expect(isGithubAuthUrl('https://github.com/account_verifications/confirm')).toBe(true);

    expect(isGithubAuthUrl('https://github.com/settings/profile')).toBe(false);
    expect(isGithubAuthUrl('https://github.com/org/repository')).toBe(false);
    expect(isGithubAuthUrl('http://github.com/login')).toBe(false);
    expect(isGithubAuthUrl('https://github.com.evil.example/login')).toBe(false);
  });

  it('allows trusted automatic clicks only on the login path', () => {
    expect(isGithubLoginUrl('https://github.com/login')).toBe(true);
    expect(isGithubLoginUrl('https://github.com/login/oauth/authorize')).toBe(false);
    expect(isGithubLoginUrl('https://github.com/sessions/two-factor')).toBe(false);
    expect(isGithubLoginUrl('https://github.com/settings/profile')).toBe(false);
  });

  it('keeps account switching on exact GitHub logout routes', () => {
    expect(isGithubLogoutUrl('https://github.com/logout')).toBe(true);
    expect(isGithubLogoutUrl('https://github.com/logout/extra')).toBe(false);
    expect(isGithubLogoutUrl('https://github.com.evil.example/logout')).toBe(false);
    expect(isGithubLoggedOutUrl('https://github.com/login')).toBe(true);
    expect(isGithubLoggedOutUrl('https://github.com/')).toBe(true);
    expect(isGithubLoggedOutUrl('https://github.com/settings/profile')).toBe(false);
  });

  it('allows credentials only during login lifecycle stages', () => {
    expect(isGithubCredentialStage('login')).toBe(true);
    expect(isGithubCredentialStage('verify-oauth')).toBe(true);
    expect(isGithubCredentialStage('relogin')).toBe(true);
    expect(isGithubCredentialStage('relogin-verify')).toBe(true);

    expect(isGithubCredentialStage('verify')).toBe(false);
    expect(isGithubCredentialStage('checkin')).toBe(false);
  });
});

describe('Google OAuth authentication URL allowlist', () => {
  it('allows the Google sign-in and OAuth paths used by popup flows', () => {
    expect(isGoogleAuthUrl('https://accounts.google.com/o/oauth2/v2/auth?client_id=1')).toBe(true);
    expect(isGoogleAuthUrl('https://accounts.google.com/signin/v2/identifier')).toBe(true);
    expect(isGoogleAuthUrl('https://accounts.google.com/v3/signin/challenge/pwd')).toBe(true);
    expect(isGoogleAuthUrl('https://accounts.google.com/ServiceLogin?continue=x')).toBe(true);
    expect(isGoogleAuthUrl('https://accounts.google.com/AccountChooser')).toBe(true);

    expect(isGoogleAuthUrl('https://www.google.com/search?q=proxy')).toBe(false);
    expect(isGoogleAuthUrl('https://accounts.google.com.evil.example/signin')).toBe(false);
    expect(isGoogleAuthUrl('http://accounts.google.com/signin/v2/identifier')).toBe(false);
  });
});

describe('通用 OAuth 弹窗 URL 判定', () => {
  const site = {
    id: 'demo',
    name: 'Demo',
    loginUrl: 'https://demo.example/login',
    selectors: { username: '#u', password: '#p', submit: '#submit' },
    closeModalSelectors: [],
  };

  it('recognizes known providers and custom OAuth/OIDC endpoints', () => {
    expect(isLikelyOAuthUrl(site, 'https://accounts.google.com/signin/v2/identifier')).toBe(true);
    expect(isLikelyOAuthUrl(site, 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x')).toBe(true);
    expect(isLikelyOAuthUrl(site, 'https://id.example.test/authorize?client_id=x&redirect_uri=https%3A%2F%2Fdemo.example')).toBe(true);
    expect(isLikelyOAuthUrl(site, 'https://id.example.test/sso/start')).toBe(true);
  });

  it('does not classify ordinary external pages or unsafe schemes as OAuth', () => {
    expect(isLikelyOAuthUrl(site, 'https://news.example.test/article')).toBe(false);
    expect(isLikelyOAuthUrl(site, 'https://www.google.com/search?q=proxy')).toBe(false);
    expect(isLikelyOAuthUrl(site, 'javascript:window.open(1)')).toBe(false);
    expect(isLikelyOAuthUrl(site, 'about:blank')).toBe(false);
  });

  it('recognizes an explicit same-site authorization callback', () => {
    expect(isLikelyOAuthUrl(site, 'https://demo.example/oauth/callback?code=abc&state=xyz')).toBe(true);
    expect(isLikelyOAuthUrl(site, 'https://demo.example/help')).toBe(false);
  });
});

describe('工作流站点校验', () => {
  it('保存前拒绝无法恢复的多页工作流', () => {
    const errors = validateSiteConfig({
      id: 'workflow-site',
      name: 'Workflow',
      loginUrl: 'https://example.com/login',
      selectors: { username: '#username', password: '#password', submit: '#submit' },
      closeModalSelectors: [],
      checkin: {
        method: 'workflow',
        workflow: {
          steps: [
            { type: 'navigate', url: '/console' },
            { type: 'navigate', url: '/checkin' },
          ],
        },
      },
    });

    expect(errors.some((error) => error.includes('navigate'))).toBe(true);
  });
});

describe('跨域身份接口准入（identitySource.endpoint）', () => {
  const site = (loginUrl: string) => ({
    id: 'orevx',
    name: 'Orevx',
    loginUrl,
    loginMethod: 'oauth' as const,
    selectors: { username: '', password: '', submit: '' },
    closeModalSelectors: [],
  });

  it('orevx 形态：登录域自身/子域允许', () => {
    const orevx = site('https://orevx.ai/login');
    expect(isIdentityEndpointAllowed(orevx, 'https://server.orevx.ai/api/user/me')).toBe(true);
    expect(isIdentityEndpointAllowed(orevx, 'https://orevx.ai/api/user/me')).toBe(true);
    expect(isIdentityEndpointAllowed(orevx, 'https://deep.server.orevx.ai/api/user/me')).toBe(true);
  });

  it('登录页在子域时允许父域（注册域自身）', () => {
    const sub = site('https://www.orevx.ai/login');
    expect(isIdentityEndpointAllowed(sub, 'https://orevx.ai/api/user/me')).toBe(true);
  });

  it('第三方域与后缀伪装一律拒绝', () => {
    const orevx = site('https://orevx.ai/login');
    expect(isIdentityEndpointAllowed(orevx, 'https://evil.com/api/user/me')).toBe(false);
    expect(isIdentityEndpointAllowed(orevx, 'https://server.orevx.ai.evil.com/api')).toBe(false);
    expect(isIdentityEndpointAllowed(orevx, 'https://orevx.ai.evil.com/api')).toBe(false);
    expect(isIdentityEndpointAllowed(orevx, 'https://notorevx.ai/api')).toBe(false);
  });

  it('仅接受 https 绝对地址', () => {
    const orevx = site('https://orevx.ai/login');
    expect(isIdentityEndpointAllowed(orevx, 'http://server.orevx.ai/api/user/me')).toBe(false);
    expect(isIdentityEndpointAllowed(orevx, '//server.orevx.ai/api/user/me')).toBe(false);
    expect(isIdentityEndpointAllowed(orevx, '/api/user/me')).toBe(false);
    expect(isIdentityEndpointAllowed(orevx, '')).toBe(false);
  });

  it('登录地址不合法（HTTP 非本机）时拒绝', () => {
    expect(isIdentityEndpointAllowed(site('http://orevx.ai/login'), 'https://server.orevx.ai/api')).toBe(false);
  });
});

describe('siteIdentitySource 读取与规范化', () => {
  const base = () => ({
    id: 'orevx',
    name: 'Orevx',
    loginUrl: 'https://orevx.ai/login',
    selectors: { username: '', password: '', submit: '' },
    closeModalSelectors: [],
  });

  it('不配 identitySource 时为 null —— 默认关闭，行为完全不变', () => {
    expect(siteIdentitySource(base())).toBeNull();
  });

  it('读取并 trim 合法字段（orevx 形态）', () => {
    const source = siteIdentitySource({
      ...base(),
      identitySource: {
        storageKey: ' auth-user ',
        endpoint: 'https://server.orevx.ai/api/user/me',
        tokenKey: 'auth-token',
      },
    });
    expect(source).toMatchObject({
      storageKey: 'auth-user',
      endpoint: 'https://server.orevx.ai/api/user/me',
      tokenKey: 'auth-token',
    });
  });

  it('非法的存储类型归一化为缺省（依次查两个存储）', () => {
    // 运行时数据来自用户可编辑的存储：故意喂一个非法 storageType（类型上不可能），
    // 验证 siteIdentitySource 的运行时规范化把它丢掉，而不是信任 TS 类型。
    const source = siteIdentitySource({
      ...base(),
      identitySource: {
        storageKey: 'auth-user',
        storageType: 'cookieJar',
      } as unknown as SiteConfig['identitySource'],
    });
    expect(source?.storageType).toBeUndefined();
  });

  it('只配置无关字段不算启用', () => {
    expect(siteIdentitySource({ ...base(), identitySource: {} })).toBeNull();
    expect(siteIdentitySource({ ...base(), identitySource: { tokenKey: 'x' } })).toBeNull();
  });

  it('显式空前缀保留为空字符串（供非 Bearer 的自定义头）', () => {
    const source = siteIdentitySource({
      ...base(),
      identitySource: { endpoint: 'https://server.orevx.ai/api/user/me', tokenKey: 'auth-token', tokenPrefix: '' },
    });
    expect(source?.tokenPrefix).toBe('');
  });
});

describe('validateSiteConfig 校验 identitySource', () => {
  const base = (identitySource?: Record<string, unknown>) => ({
    id: 'orevx',
    name: 'Orevx',
    loginUrl: 'https://orevx.ai/login',
    selectors: { username: '#u', password: '#p', submit: '#s' },
    closeModalSelectors: [] as string[],
    ...(identitySource ? { identitySource } : {}),
  });

  it('合法的 orevx 配置不产生错误', () => {
    const errors = validateSiteConfig(base({
      storageKey: 'auth-user',
      endpoint: 'https://server.orevx.ai/api/user/me',
      tokenKey: 'auth-token',
    }));
    expect(errors).toEqual([]);
  });

  it('跨域身份接口必须在登录站点域名自身或子域', () => {
    const errors = validateSiteConfig(base({
      endpoint: 'https://evil.com/api/user/me',
      tokenKey: 'auth-token',
    }));
    expect(errors.some((error) => error.includes('跨域身份接口'))).toBe(true);
  });

  it('跨域身份接口必须使用 HTTPS', () => {
    const errors = validateSiteConfig(base({ endpoint: 'http://server.orevx.ai/api/user/me', tokenKey: 'k' }));
    expect(errors.some((error) => error.includes('跨域身份接口'))).toBe(true);
  });

  it('配置跨域接口必须同时配置 token 存储键', () => {
    const errors = validateSiteConfig(base({ endpoint: 'https://server.orevx.ai/api/user/me' }));
    expect(errors.some((error) => error.includes('tokenKey'))).toBe(true);
  });

  it('只配存储键、不跨域时不新增错误', () => {
    expect(validateSiteConfig(base({ storageKey: 'auth-user' }))).toEqual([]);
  });
});

describe('validateSiteConfig 校验令牌引导（authBootstrap）', () => {
  const base = (authBootstrap?: SiteAuthBootstrapConfig) => ({
    id: 'leilei',
    name: '一梦五千年',
    loginUrl: 'https://fapi.leileihog.top/login',
    selectors: { username: '#u', password: '#p', submit: '#s' },
    closeModalSelectors: [] as string[],
    ...(authBootstrap ? { authBootstrap } : {}),
  });

  it('同源相对路径合法', () => {
    expect(validateSiteConfig(base({ endpoint: '/api/user/auth/refresh' }))).toEqual([]);
  });

  it('同源绝对地址也合法', () => {
    expect(validateSiteConfig(base({ endpoint: 'https://fapi.leileihog.top/api/user/auth/refresh' }))).toEqual([]);
  });

  it('跨域地址被拒绝 —— 引导请求带着会话 cookie，绝不能发出去', () => {
    const errors = validateSiteConfig(base({ endpoint: 'https://evil.example/api/refresh' }));
    expect(errors.some((error) => error.includes('令牌引导接口'))).toBe(true);
  });

  it('协议相对地址（//evil.example）与非 http 协议都被拒绝', () => {
    const protocolRelative = validateSiteConfig(base({ endpoint: '//evil.example/api/refresh' }));
    expect(protocolRelative.some((error) => error.includes('令牌引导接口'))).toBe(true);

    const nonHttp = validateSiteConfig(base({ endpoint: 'javascript:alert(1)' }));
    expect(nonHttp.some((error) => error.includes('令牌引导接口'))).toBe(true);
  });

  it('未配置时不产生错误', () => {
    expect(validateSiteConfig(base())).toEqual([]);
  });
});
