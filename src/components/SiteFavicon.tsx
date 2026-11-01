import { useState } from 'react';
import type { SiteConfig } from '@/types';
import { siteFaviconCandidates } from '@/lib/site/site-favicon';

/** Site icon used by both the site cards and the live activity panel. */
export function SiteFavicon({
  site,
  className,
  fallback,
}: {
  site: Pick<SiteConfig, 'loginUrl' | 'favicon'> & Partial<Pick<SiteConfig, 'name'>>;
  className: string;
  fallback: React.ReactNode;
}) {
  const candidates = siteFaviconCandidates(site);
  const candidatesKey = candidates.join('\0');
  const [attempt, setAttempt] = useState<{ key: string; index: number } | null>(null);
  const index = attempt?.key === candidatesKey ? attempt.index : 0;
  const src = candidates[index];
  const advance = () => setAttempt((current) => {
    const currentIndex = current?.key === candidatesKey ? current.index : 0;
    return currentIndex === index ? { key: candidatesKey, index: index + 1 } : current;
  });

  return src
    ? <img
      src={src}
      alt=""
      className={className}
      onError={advance}
      // Chromium may return an empty default favicon as a zero-byte image;
      // some image decoders report that as a successful load with zero width.
      // Advance in both cases so the site's own /favicon.ico is still tried.
      onLoad={(event) => { if (event.currentTarget.naturalWidth === 0) advance(); }}
    />
    : <span
      role="img"
      aria-label={`${site.name || '站点'}暂无可用的原生图标`}
      title="站点未提供可读取的原生图标"
    >{fallback}</span>;
}
