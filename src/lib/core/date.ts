/** 本地时区的今日键，格式 YYYY-MM-DD。用于按天索引签到状态。 */
export function todayKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 状态存储的复合键 */
export function statusKey(accountId: string, day: string = todayKey()): string {
  return `${accountId}:${day}`;
}

/** 生成短 id */
export function uid(prefix = ''): string {
  const s = Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  return prefix ? `${prefix}-${s}` : s;
}

/** 从登录 URL 推断站点原生 favicon。保留 origin 的 scheme/port，兼容 localhost HTTP。 */
export function faviconOf(url: string): string {
  try {
    const u = new URL(url);
    const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return '';
    return new URL('/favicon.ico', u.origin).href;
  } catch {
    return '';
  }
}

/** 从 url 取域名，用于展示 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
