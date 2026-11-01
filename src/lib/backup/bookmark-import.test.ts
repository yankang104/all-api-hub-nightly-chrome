import { describe, expect, it } from 'vitest';
import type { SiteConfig } from '@/types';
import { blankSite } from '@/sites';
import { parseBookmarkFile } from '@/lib/backup/bookmarks';
import { validateSiteConfig } from '@/lib/site/site-security';
import { planBookmarkSiteImport, siteFromBookmark } from './bookmark-import';

describe('bookmark site import URL validation', () => {
  it('keeps parsed localhost HTTP URLs canonical and valid through site validation', () => {
    const { links } = parseBookmarkFile(`<!DOCTYPE NETSCAPE-Bookmark-file-1>
      <DL><p><A HREF="http://localhost:3000/login#top"> Local dev </A></DL>`);
    const site = siteFromBookmark(links[0]!);

    expect(site?.loginUrl).toBe('http://localhost:3000/login');
    expect(validateSiteConfig(site!)).not.toContain('登录页必须使用 HTTPS（本机测试可使用 localhost HTTP）');
  });

  it('drops non-loopback HTTP URLs again at the final import mapping boundary', () => {
    const { links } = parseBookmarkFile(`<!DOCTYPE NETSCAPE-Bookmark-file-1>
      <DL><p><A HREF="http://example.com/login"> Insecure </A></DL>`);

    expect(siteFromBookmark(links[0]!)).toBeNull();
  });

  it('canonicalizes allowed HTTPS bookmarks before validation', () => {
    const { links } = parseBookmarkFile(`<!DOCTYPE NETSCAPE-Bookmark-file-1>
      <DL><p><A HREF="HTTPS://Example.com:443/login#top"> Example </A></DL>`);
    const site = siteFromBookmark(links[0]!);

    expect(site?.loginUrl).toBe('https://example.com/login');
    expect(validateSiteConfig(site!)).toEqual([]);
  });
});

describe('bookmark site import planning', () => {
  const site = (name: string, loginUrl: string): Omit<SiteConfig, 'id'> => ({
    ...blankSite(),
    name,
    loginUrl,
  });

  it('deduplicates a batch by host and adds only one site', () => {
    const first = site('First bookmark', 'https://example.com/login');
    const duplicate = site('Second bookmark', 'https://example.com/other');
    const plan = planBookmarkSiteImport([first, duplicate], []);
    expect(plan.additions).toHaveLength(1);
    expect(plan.additions[0]?.name).toBe('First bookmark');
    expect(plan.duplicates).toBe(1);
  });

  it('updates an existing site by changing only its name and login URL', () => {
    const imported = site('Renamed', 'https://example.com/sign-in');
    const plan = planBookmarkSiteImport([imported], [
      { id: 'site-1', loginUrl: 'https://example.com/login' },
    ], { overwriteExisting: true });
    expect(plan.additions).toEqual([]);
    expect(plan.updates).toEqual([{
      siteId: 'site-1',
      patch: { name: 'Renamed', loginUrl: 'https://example.com/sign-in' },
    }]);
  });

  it('skips existing and ambiguous sites when overwrite cannot safely target one site', () => {
    const imported = site('Imported', 'https://example.com/login');
    const existing = [
      { id: 'one', loginUrl: 'https://example.com/login' },
      { id: 'two', loginUrl: 'https://example.com/other' },
    ];

    const skipPlan = planBookmarkSiteImport([imported], [existing[0]!]);
    expect(skipPlan.alreadyExists).toBe(1);
    const overwritePlan = planBookmarkSiteImport([imported], existing, { overwriteExisting: true });
    expect(overwritePlan.ambiguous).toBe(1);
    expect(overwritePlan.updates).toEqual([]);
  });
});

describe('书签导入认得出的站点直接套模板', () => {
  it('新版 new-api 已知域名：带上 /sign-in、登录成功标志与 /profile 签到', () => {
    const site = siteFromBookmark({ name: '卡皮巴拉', url: 'https://kapibala.asia/console' } as never);
    expect(site).toMatchObject({
      loginUrl: 'https://kapibala.asia/sign-in',
      successIndicator: 'a[href="/keys"], a[href="/wallet"]',
      checkin: { method: 'button', url: '/profile' },
      adapter: { family: 'new-api' },
    });
  });

  it('认不出的站点仍是空白预设（行为与以前一致）', () => {
    const site = siteFromBookmark({ name: '随便一个站', url: 'https://unknown-site.example/dashboard' } as never);
    expect(site?.adapter).toBeUndefined();
    expect(site?.loginUrl).toBe('https://unknown-site.example/dashboard');
    expect(site?.checkin).toEqual({ method: 'auto' });
  });
});
