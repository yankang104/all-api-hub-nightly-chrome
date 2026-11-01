/** URL-bearing part of a configured site, sufficient for bookmark matching. */
export interface SiteUrlCandidate {
  loginUrl: string;
}

export type BookmarkSiteUrlMatch<T extends SiteUrlCandidate> =
  | { kind: 'none' }
  | { kind: 'exact' | 'normalized'; site: T }
  | { kind: 'ambiguous'; matchKind: 'exact' | 'normalized'; sites: T[] };

/**
 * Return a site's stable host key, or null when the value is not an HTTP(S) URL.
 * The scheme is omitted from the key, while its default port is still used as
 * the effective port when no explicit port is present.
 */
export function normalizeBookmarkSiteUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

    const effectivePort = url.port || (url.protocol === 'https:' ? '443' : '80');
    return `${url.hostname.toLowerCase()}:${effectivePort}`;
  } catch {
    return null;
  }
}

/**
 * Find the existing site for a bookmark URL by hostname and effective port.
 * Scheme, path, query, fragment, and credentials do not affect the site key.
 * Multiple sites with the same key are ambiguous, even when one URL is an
 * exact string match, so callers can avoid overwriting the wrong site.
 */
export function matchBookmarkSiteUrl<T extends SiteUrlCandidate>(
  importedUrl: string,
  sites: readonly T[],
): BookmarkSiteUrlMatch<T> {
  const importedKey = normalizeBookmarkSiteUrl(importedUrl);
  if (importedKey === null) return { kind: 'none' };

  const matches = sites.filter((site) => normalizeBookmarkSiteUrl(site.loginUrl) === importedKey);
  if (matches.length === 1) {
    return matches[0]!.loginUrl === importedUrl
      ? { kind: 'exact', site: matches[0]! }
      : { kind: 'normalized', site: matches[0]! };
  }
  if (matches.length > 1) {
    const matchKind = matches.every((site) => site.loginUrl === importedUrl) ? 'exact' : 'normalized';
    return { kind: 'ambiguous', matchKind, sites: matches };
  }
  return { kind: 'none' };
}
