import type { SiteConfig } from '@/types';
import { faviconOf } from '@/lib/core/date';

type SiteIconSource = Pick<SiteConfig, 'loginUrl' | 'favicon'>;

/**
 * Return image URLs to try for a site, preferring its own saved/native icon.
 * The old Google S2 URL is intentionally ignored: when a site has no indexed
 * icon, that service returns its generic placeholder, which looks like a real
 * but incorrect site logo.
 */
export function siteFaviconCandidates(site: SiteIconSource): string[] {
  const loginUrl = parseSiteUrl(site.loginUrl);
  if (!loginUrl) return [];

  const saved = safeSavedIcon(site.favicon, loginUrl);
  const browser = chromeFaviconOf(loginUrl.href);
  const native = faviconOf(loginUrl.href);
  const candidates: string[] = [];

  // Prefer Chrome's native favicon cache: it resolves the site's declared
  // rel=icon URL without relying on Google or assuming the icon is at the root.
  if (browser) candidates.push(browser);

  // A deliberately saved icon is a useful fallback for sites whose browser
  // cache has not been populated. The conventional root path is the last try.
  // Ignore a saved value equal to the generated root URL here: built-in sites
  // store that default path, but Chrome may know a more accurate rel=icon URL.
  if (saved && saved !== native) {
    candidates.push(saved);
  }
  if (native) candidates.push(native);

  return [...new Set(candidates)];
}

/** Chrome's favicon permission resolves rel=icon from the browser favicon DB. */
export function chromeFaviconOf(pageUrl: string): string {
  try {
    const runtime = globalThis.chrome?.runtime;
    if (!runtime?.getURL) return '';

    const url = new URL(runtime.getURL('/_favicon/'));
    url.searchParams.set('pageUrl', pageUrl);
    url.searchParams.set('size', '32');
    // Don't accept Chromium's generic globe when this profile has no cached icon.
    url.searchParams.set('forceEmptyDefaultFavicon', '1');
    url.searchParams.set('allowGoogleServerFallback', '0');
    return url.href;
  } catch {
    return '';
  }
}

function parseSiteUrl(value: string): URL | null {
  try {
    const url = new URL(value.trim());
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
    return url;
  } catch {
    return null;
  }
}

function safeSavedIcon(value: string | undefined, loginUrl: URL): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;

  // Preserve a deliberate embedded image while rejecting arbitrary data URLs.
  if (/^data:image\/(?:png|gif|jpe?g|webp|svg\+xml|x-icon|vnd\.microsoft\.icon);/i.test(raw)) return raw;

  try {
    const icon = new URL(raw, loginUrl);
    if (icon.protocol !== 'https:' && !(icon.protocol === 'http:' && isLoopback(icon.hostname))) return null;
    if (loginUrl.protocol === 'https:' && icon.protocol !== 'https:') return null;
    if (isGoogleFaviconProxy(icon)) return null;
    return icon.href;
  } catch {
    return null;
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function isGoogleFaviconProxy(url: URL): boolean {
  return (url.hostname === 'google.com' || url.hostname.endsWith('.google.com'))
    && url.pathname === '/s2/favicons';
}
