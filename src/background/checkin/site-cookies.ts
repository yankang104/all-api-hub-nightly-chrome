import type { SiteCookieClearResult } from '@/lib/messages/site-cookies';

function parentDomainCandidates(hostname: string): string[] {
  const normalized = hostname.toLowerCase();
  if (normalized === 'localhost' || normalized.includes(':') || /^\d+(?:\.\d+){3}$/.test(normalized)) {
    return [normalized];
  }

  const labels = normalized.split('.').filter(Boolean);
  const candidates: string[] = [];
  // 查询当前主机及其所有可能的父域；最后一个裸 TLD 不参与查询。
  for (let index = 0; index < Math.max(1, labels.length - 1); index += 1) {
    candidates.push(labels.slice(index).join('.'));
  }
  return candidates;
}

function cookieAppliesToHost(cookie: chrome.cookies.Cookie, hostname: string): boolean {
  const domain = cookie.domain.replace(/^\./, '').toLowerCase();
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function cookieIdentity(cookie: chrome.cookies.Cookie): string {
  return [
    cookie.storeId,
    cookie.domain,
    cookie.path,
    cookie.name,
    JSON.stringify(cookie.partitionKey ?? null),
  ].join('\u0000');
}

function removalUrl(cookie: chrome.cookies.Cookie, siteUrl: URL): string {
  const protocol = cookie.secure ? 'https:' : siteUrl.protocol;
  const domain = cookie.domain.replace(/^\./, '');
  const path = cookie.path.startsWith('/') ? cookie.path : `/${cookie.path}`;
  return `${protocol}//${domain}${path || '/'}`;
}

async function collectSiteCookies(
  hostname: string,
  storeId?: string,
): Promise<Map<string, chrome.cookies.Cookie>> {
  const collected = new Map<string, chrome.cookies.Cookie>();
  for (const domain of parentDomainCandidates(hostname)) {
    const cookies = await chrome.cookies.getAll({
      domain,
      ...(storeId ? { storeId } : {}),
    });
    for (const cookie of cookies) {
      if (!cookieAppliesToHost(cookie, hostname)) continue;
      collected.set(cookieIdentity(cookie), cookie);
    }
  }
  return collected;
}

/**
 * 清除当前任务标签页所属 Cookie store 中、会作用于本站主机的全部 Cookie。
 *
 * 用 domain 分层查询而不是读取整个 Cookie 仓库，避免接触无关站点。最终再按
 * RFC 域匹配关系过滤，因此父域查询返回的兄弟子域 Cookie 不会被删除。
 */
export async function clearSiteCookiesForTab(
  tabId: number,
  rawSiteUrl: string,
): Promise<SiteCookieClearResult> {
  const siteUrl = new URL(rawSiteUrl);
  const hostname = siteUrl.hostname.toLowerCase();
  if (siteUrl.protocol !== 'https:' && siteUrl.protocol !== 'http:') {
    throw new Error('站点地址不是 HTTP(S)，不能清理 Cookie');
  }

  const stores = await chrome.cookies.getAllCookieStores();
  const storeId = stores.find((store) => store.tabIds.includes(tabId))?.id;
  const collected = await collectSiteCookies(hostname, storeId);

  for (const cookie of collected.values()) {
    try {
      await chrome.cookies.remove({
        url: removalUrl(cookie, siteUrl),
        name: cookie.name,
        storeId: cookie.storeId,
        ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
      });
    } catch {
      // 统一由下面的二次枚举判断：调用报错时 Cookie 也可能已经过期或被服务端清掉。
    }
  }

  // 不信任 remove() 的瞬时返回值，重新枚举本站 Cookie 作为最终证据。这样服务端
  // 退出与浏览器删除并发时，即使 remove 返回 null，也不会把“已经不存在”误报失败。
  const remaining = await collectSiteCookies(hostname, storeId);
  const initialRemaining = [...collected.keys()].filter((key) => remaining.has(key)).length;
  return {
    matched: collected.size,
    removed: collected.size - initialRemaining,
    // 清理期间若站点又写入新 Cookie，也算残留并阻止继续切号。
    failed: remaining.size,
  };
}
