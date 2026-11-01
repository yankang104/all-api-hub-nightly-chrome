import { describe, expect, it } from 'vitest';
import { matchBookmarkSiteUrl, normalizeBookmarkSiteUrl } from './bookmark-url-match';

describe('normalizeBookmarkSiteUrl', () => {
  it('uses a case-insensitive hostname and effective port as the site key', () => {
    expect(normalizeBookmarkSiteUrl('HTTPS://Example.COM:443/login/#section'))
      .toBe('example.com:443');
    expect(normalizeBookmarkSiteUrl('http://Example.COM:80/'))
      .toBe('example.com:80');
    expect(normalizeBookmarkSiteUrl('HTTP://example.com'))
      .toBe(normalizeBookmarkSiteUrl('http://EXAMPLE.COM:80/elsewhere?x=1'));
  });

  it('ignores scheme, path, query, fragment, and credentials but keeps effective port significant', () => {
    const key = normalizeBookmarkSiteUrl('https://user:pass@example.com:8443/login?next=%2Fhome#top');
    expect(key).toBe('example.com:8443');
    expect(normalizeBookmarkSiteUrl('http://example.com:8443/other?x=1#bottom')).toBe(key);
    expect(normalizeBookmarkSiteUrl('https://example.com:9443/login')).not.toBe(key);
    expect(normalizeBookmarkSiteUrl('http://example.com/login')).not.toBe(key);
  });

  it('rejects invalid and non-HTTP(S) URLs', () => {
    expect(normalizeBookmarkSiteUrl('not a URL')).toBeNull();
    expect(normalizeBookmarkSiteUrl('ftp://example.com/login')).toBeNull();
    expect(normalizeBookmarkSiteUrl('javascript:alert(1)')).toBeNull();
  });
});

describe('matchBookmarkSiteUrl', () => {
  const sites = [
    { id: 'one', loginUrl: 'https://example.com/login' },
    { id: 'two', loginUrl: 'https://other.example/login' },
  ];

  it('reports a literal URL match as exact', () => {
    expect(matchBookmarkSiteUrl('https://example.com/login', sites))
      .toEqual({ kind: 'exact', site: sites[0] });
  });

  it('reports a host-key match with different scheme, path, query, or fragment as normalized', () => {
    const candidate = { id: 'one', loginUrl: 'http://example.com/login' };
    expect(matchBookmarkSiteUrl('HTTP://EXAMPLE.COM:80/other?next=%2Fhome#section', [
      candidate,
    ]))
      .toEqual({ kind: 'normalized', site: candidate });
  });

  it('keeps effective ports significant even though scheme is ignored', () => {
    expect(matchBookmarkSiteUrl('https://example.com/login', [
      { id: 'http', loginUrl: 'http://example.com/login' },
    ])).toEqual({ kind: 'none' });
    expect(matchBookmarkSiteUrl('https://example.com:8080/login', [
      { id: 'http', loginUrl: 'http://example.com:8080/other' },
    ])).toEqual({ kind: 'normalized', site: { id: 'http', loginUrl: 'http://example.com:8080/other' } });
  });

  it('returns ambiguous when several candidates share the host key, even if one is exact', () => {
    const candidates = [
      { id: 'one', loginUrl: 'https://example.com/login' },
      { id: 'two', loginUrl: 'http://EXAMPLE.com:443/other/#x' },
    ];
    expect(matchBookmarkSiteUrl('https://example.com/login', candidates))
      .toEqual({ kind: 'ambiguous', matchKind: 'normalized', sites: candidates });
  });

  it('returns none when no candidate is safe to match', () => {
    expect(matchBookmarkSiteUrl('https://example.com:8443/login', sites)).toEqual({ kind: 'none' });
    expect(matchBookmarkSiteUrl('file:///tmp/bookmark', sites)).toEqual({ kind: 'none' });
    expect(matchBookmarkSiteUrl('javascript:alert(1)', [{ id: 'unsafe', loginUrl: 'javascript:alert(1)' }]))
      .toEqual({ kind: 'none' });
  });
});
