import type { SiteConfig } from '@/types';
import { blankSite, matchTemplateByName, normalizedLoginUrl } from '@/sites';
import { hostOf } from '@/lib/core/date';
import { normalizeSecureLoginUrl } from '@/lib/site/site-security';
import { matchBookmarkSiteUrl, normalizeBookmarkSiteUrl } from '@/lib/site/bookmark-url-match';
import type { BookmarkLink } from './bookmarks';

export interface BookmarkSiteImportPlan {
  additions: Array<Omit<SiteConfig, 'id'>>;
  updates: Array<{ siteId: string; patch: Pick<SiteConfig, 'name' | 'loginUrl'> }>;
  ambiguous: number;
  duplicates: number;
  invalid: number;
  alreadyExists: number;
}

export interface BookmarkSiteImportResult {
  added: number;
  updated: number;
  skipped: number;
}

/** Convert a bookmark to an importable site, rechecking and canonicalizing its URL. */
export function siteFromBookmark(bookmark: BookmarkLink): Omit<SiteConfig, 'id'> | null {
  const loginUrl = normalizeSecureLoginUrl(bookmark.url);
  if (!loginUrl) return null;

  const site = blankSite();
  /**
   * 认得出的站点直接套模板预设（只按域名 / 书签标题，不发任何请求）。
   *
   * 旧行为一律用空白预设：已知站点（新版 new-api、Sub2API 白标等）导入后既没有
   * 站点类型、也没有登录成功标志与 token 配置，已登录时认不出登录态、身份接口也
   * 拼不出认证头。认不出的站点仍是空白预设，行为与以前一致。
   */
  const template = matchTemplateByName(loginUrl) ?? matchTemplateByName(bookmark.name);
  if (template) {
    return {
      ...site,
      ...template.preset,
      name: bookmark.name.trim() || hostOf(loginUrl),
      loginUrl: normalizedLoginUrl(loginUrl, template),
    };
  }
  return {
    ...site,
    name: bookmark.name.trim() || hostOf(loginUrl),
    loginUrl,
  };
}

/**
 * Match selected bookmark sites to current sites, dedupe same-host bookmarks,
 * and only plan name/loginUrl updates so existing site configuration survives.
 */
export function planBookmarkSiteImport(
  inputs: readonly Omit<SiteConfig, 'id'>[],
  existingSites: readonly Pick<SiteConfig, 'id' | 'loginUrl'>[],
  options: { overwriteExisting?: boolean } = {},
): BookmarkSiteImportPlan {
  const plan: BookmarkSiteImportPlan = {
    additions: [],
    updates: [],
    ambiguous: 0,
    duplicates: 0,
    invalid: 0,
    alreadyExists: 0,
  };
  const seenSiteKeys = new Set<string>();
  const updatesById = new Map<string, Pick<SiteConfig, 'name' | 'loginUrl'>>();

  for (const input of inputs) {
    const key = normalizeBookmarkSiteUrl(input.loginUrl);
    if (!key) {
      plan.invalid += 1;
      continue;
    }
    if (seenSiteKeys.has(key)) {
      plan.duplicates += 1;
      continue;
    }
    seenSiteKeys.add(key);

    const match = matchBookmarkSiteUrl(input.loginUrl, existingSites);
    if (match.kind === 'ambiguous') {
      plan.ambiguous += 1;
    } else if (match.kind === 'none') {
      plan.additions.push(input);
    } else if (options.overwriteExisting) {
      updatesById.set(match.site.id, { name: input.name, loginUrl: input.loginUrl });
    } else {
      plan.alreadyExists += 1;
    }
  }

  plan.updates = [...updatesById].map(([siteId, patch]) => ({ siteId, patch }));
  return plan;
}
