import { afterEach, describe, expect, it, vi } from 'vitest';
import { faviconOf } from '@/lib/core/date';
import { chromeFaviconOf, siteFaviconCandidates } from './site-favicon';

afterEach(() => vi.unstubAllGlobals());

describe('site favicon resolution', () => {
  it('uses the login site origin instead of a generic favicon service', () => {
    expect(faviconOf('https://agentrouter.org/login?next=%2Fconsole'))
      .toBe('https://agentrouter.org/favicon.ico');
    expect(siteFaviconCandidates({ loginUrl: 'https://agentrouter.org/login' }))
      .toEqual(['https://agentrouter.org/favicon.ico']);
  });

  it('uses Chrome’s cached rel=icon first without allowing a generic fallback', () => {
    vi.stubGlobal('chrome', {
      runtime: { getURL: (path: string) => `chrome-extension://extension-id${path}` },
    });

    const candidates = siteFaviconCandidates({ loginUrl: 'https://agentrouter.org/login' });
    const browserIcon = new URL(candidates[0]!);
    // Node's WHATWG URL reports a `null` origin for the non-web
    // `chrome-extension:` scheme; verify the actual scheme/host instead.
    expect(browserIcon.protocol).toBe('chrome-extension:');
    expect(browserIcon.hostname).toBe('extension-id');
    expect(browserIcon.pathname).toBe('/_favicon/');
    expect(browserIcon.searchParams.get('pageUrl')).toBe('https://agentrouter.org/login');
    expect(browserIcon.searchParams.get('size')).toBe('32');
    expect(browserIcon.searchParams.get('forceEmptyDefaultFavicon')).toBe('1');
    expect(browserIcon.searchParams.get('allowGoogleServerFallback')).toBe('0');
    expect(candidates[1]).toBe('https://agentrouter.org/favicon.ico');
  });

  it('does not require Chrome globals in unit tests or non-Chrome runtimes', () => {
    expect(chromeFaviconOf('https://agentrouter.org/login')).toBe('');
  });

  it('preserves localhost HTTP and its port for local development sites', () => {
    expect(faviconOf('http://localhost:4173/login')).toBe('http://localhost:4173/favicon.ico');
    expect(siteFaviconCandidates({ loginUrl: 'http://127.0.0.1:8080/login' }))
      .toEqual(['http://127.0.0.1:8080/favicon.ico']);
  });

  it('prefers Chrome’s native rel=icon cache, then a saved icon and the root favicon', () => {
    vi.stubGlobal('chrome', {
      runtime: { getURL: (path: string) => `chrome-extension://extension-id${path}` },
    });

    const candidates = siteFaviconCandidates({
      loginUrl: 'https://example.com/login',
      favicon: '/assets/brand-icon.svg',
    });
    expect(candidates[0]).toContain('chrome-extension://extension-id/_favicon/');
    expect(candidates.slice(1)).toEqual([
      'https://example.com/assets/brand-icon.svg',
      'https://example.com/favicon.ico',
    ]);
  });

  it('does not treat an auto-inferred root favicon as an explicit icon override', () => {
    const native = 'https://example.com/favicon.ico';
    vi.stubGlobal('chrome', {
      runtime: { getURL: (path: string) => `chrome-extension://extension-id${path}` },
    });
    expect(siteFaviconCandidates({ loginUrl: 'https://example.com/login', favicon: native })[0])
      .toContain('chrome-extension://extension-id/_favicon/');
  });

  it('ignores the Google S2 generic icon and tries the native favicon first', () => {
    expect(siteFaviconCandidates({
      loginUrl: 'https://napi.kid1412.qzz.io/sign-in',
      favicon: 'https://www.google.com/s2/favicons?domain=napi.kid1412.qzz.io&sz=64',
    })).toEqual(['https://napi.kid1412.qzz.io/favicon.ico']);
  });

  it('prioritizes an explicit HTTPS CDN icon, but rejects unsafe or public HTTP URLs', () => {
    expect(siteFaviconCandidates({
      loginUrl: 'https://example.com/login',
      favicon: 'https://cdn.example.net/site.svg',
    })).toEqual([
      'https://cdn.example.net/site.svg',
      'https://example.com/favicon.ico',
    ]);
    expect(siteFaviconCandidates({
      loginUrl: 'https://example.com/login',
      favicon: 'http://cdn.example.net/site.ico',
    })).toEqual(['https://example.com/favicon.ico']);
    expect(siteFaviconCandidates({ loginUrl: 'http://example.com/login' })).toEqual([]);
    expect(faviconOf('javascript:alert(1)')).toBe('');
  });
});
