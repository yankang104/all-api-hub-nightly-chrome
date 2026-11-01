/**
 * 注入页面执行的余额读取脚本。
 *
 * ⚠️ 会被 chrome.scripting.executeScript 序列化后注入目标页面执行：
 *  - 函数体内**不能引用本文件的任何 import / 变量 / 常量** —— import 在注入后
 *    被摘除，函数里只剩自身的参数与页面全局；
 *  - 只能依赖页面上下文自带的 API（fetch / localStorage / document / btoa）。
 *
 * 两条读取线，互不阻塞：
 *  1. paths：站点同源兼容端点（new-api / sub2api），带页面自己的 cookie 读，
 *     只带回**未解析的响应文本**；
 *  2. crossOriginProbe：站点的真实跨域 API（identitySource.endpoint，如
 *     orevx.ai ↔ server.orevx.ai/api）：带 Bearer token、Accept 协商 cbor/json，
 *     响应字节**原样 base64 带回** —— 解码与解析统一留在 background（唯一实现，
 *     见 balance.ts 的 decodeCrossOriginPayload / extractBalance）。
 *
 * 为什么必须注入才能读：cookie 与 localStorage 只有页面上下文才有 ——
 * service worker 的 fetch 带不上 SameSite=Lax 的会话 cookie；new-api 要
 * user.id 拼 user-id 头、sub2api 与 orevx 都要从 localStorage 取 token。
 */
import type { CrossOriginBalanceProbe } from '@/automation/balance/balance';
import type { AuthBootstrapProbe } from '@/automation/shared/token-bootstrap';

/** 跨域响应被原样带回的形状（解码在 background 做） */
export interface PageCrossOriginRead {
  url: string;
  contentType: string;
  base64: string;
}

export interface PageBalanceRead {
  payloads: { path: string; text: string; json: boolean }[];
  crossOrigin: PageCrossOriginRead | null;
  bodyText: string;
}

export async function readBalancePayloadsInPage(
  paths: string[],
  userIdHeaderNames: string[],
  readHvoyMenu = false,
  crossOriginProbe: CrossOriginBalanceProbe | null = null,
  authBootstrap: AuthBootstrapProbe | null = null,
): Promise<PageBalanceRead> {
  const headers: Record<string, string> = { Accept: 'application/json' };

  try {
    const raw = localStorage.getItem('user');
    if (raw) {
      const parsed = JSON.parse(raw) as { id?: unknown };
      const id = typeof parsed?.id === 'number' || typeof parsed?.id === 'string'
        ? String(parsed.id).trim()
        : '';
      if (id) for (const name of userIdHeaderNames) headers[name] = id;
    }
  } catch {
    // 不是 JSON 或没有 id 字段，当作读不到
  }

  for (const key of ['auth_token', 'access_token', 'token']) {
    const token = localStorage.getItem(key)?.trim();
    if (token && token.length > 20 && !token.startsWith('{')) {
      headers.Authorization = `Bearer ${token}`;
      break;
    }
  }

  /**
   * 轮换令牌站点（authBootstrap）：页面自己的令牌只在内存里，读不到 ——
   * 按站点声明的引导接口，用会话 cookie 换一枚同类型的短命 Bearer。
   * 换来的令牌只用于本次注入的请求，不回传、不落盘。
   *
   * 注入函数不信任调用方传来的地址，自己再判一次同源：这一步带 cookie，
   * 配错（或将来有人重构掉调用方的校验）就等于把会话发去外域。
   */
  const bootstrapUrl = authBootstrap?.url ?? '';
  const sameOrigin = (() => {
    try {
      return !!bootstrapUrl && new URL(bootstrapUrl, location.href).origin === location.origin;
    } catch {
      return false;
    }
  })();
  if (authBootstrap && sameOrigin) {
    /** 隔离世界里的 window 与页面不共享全局，可以安全地跨注入缓存令牌。 */
    const cacheKey = '__aahBootstrapToken';
    const cached = (() => {
      try {
        const raw = (window as unknown as Record<string, unknown>)[cacheKey];
        if (!raw || typeof raw !== 'object') return null;
        const entry = raw as { at?: unknown; header?: unknown; value?: unknown };
        if (typeof entry.at !== 'number' || Date.now() - entry.at > 60_000) return null;
        return typeof entry.header === 'string' && typeof entry.value === 'string'
          ? { header: entry.header, value: entry.value }
          : null;
      } catch {
        return null;
      }
    })();
    if (cached && !headers[cached.header]) headers[cached.header] = cached.value;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    try {
      if (!cached) {
        const response = await fetch(authBootstrap.url, {
          method: authBootstrap.method,
          credentials: 'include',
          headers: { Accept: 'application/json' },
          // 与 token-bootstrap.ts 一致：同源开放重定向也不跟随，避免令牌替换/外域收 cookie
          redirect: 'error',
          signal: controller.signal,
        });
        if (response.ok) {
          const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
          const payload = contentType.includes('json')
            ? await response.json().catch(() => null)
            : null;
          // 响应包法在分叉之间不一致（`{data:{access_token}}` 与平铺都常见）；
          // 这里与 token-bootstrap.ts 的默认路径保持同一顺序，改动要一起改。
          const pathsToTry = authBootstrap.tokenPath?.length
            ? [authBootstrap.tokenPath]
            : [['data', 'access_token'], ['access_token'], ['data', 'accessToken'], ['accessToken']];
          let token: unknown;
          for (const keys of pathsToTry) {
            let node: unknown = payload;
            for (const key of keys) {
              if (node == null || typeof node !== 'object') { node = undefined; break; }
              node = (node as Record<string, unknown>)[key];
            }
            if (typeof node === 'string' && node.trim().length > 20) { token = node.trim(); break; }
          }
          // 与 token-bootstrap.ts 同一条优先级：localStorage 里已有的 token（tokenConfig
          // 那一份）优先，引导只在缺位时补 —— 新机制不覆盖本来就能用的凭据。
          if (typeof token === 'string' && !headers[authBootstrap.header]) {
            const value = `${authBootstrap.prefix}${token}`;
            headers[authBootstrap.header] = value;
            try {
              (window as unknown as Record<string, unknown>)[cacheKey] = {
                at: Date.now(), header: authBootstrap.header, value,
              };
            } catch {
              // 缓存只是节流手段，写不进去就每次换一枚，不影响正确性
            }
          }
        }
      }
    } catch {
      // 引导失败不阻塞：退回原来的请求头，读不到就照旧降级
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 跨域读取（只读 GET）：token 存储位置语义与身份读取保持一致 ——
   * 显式配置了 storageType 就只查那一个存储，缺省先 localStorage 后
   * sessionStorage（orevx 持久登录写 localStorage、会话登录写 sessionStorage）。
   * 任何失败都静默返回 null，绝不影响同源那条线。
   */
  const crossOriginPromise = (async (): Promise<PageCrossOriginRead | null> => {
    if (!crossOriginProbe) return null;

    const storageKinds: Array<'localStorage' | 'sessionStorage'> = crossOriginProbe.tokenStorageType
      ? [crossOriginProbe.tokenStorageType]
      : ['localStorage', 'sessionStorage'];
    let token: string | undefined;
    for (const kind of storageKinds) {
      try {
        const store = kind === 'localStorage' ? localStorage : sessionStorage;
        const value = store?.getItem(crossOriginProbe.tokenKey)?.trim();
        if (value) {
          token = value;
          break;
        }
      } catch {
        // 换下一个存储
      }
    }
    if (!token) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    try {
      const probeHeaders: Record<string, string> = { Accept: 'application/cbor, application/json' };
      probeHeaders[crossOriginProbe.tokenHeader ?? 'Authorization'] = `${crossOriginProbe.tokenPrefix ?? 'Bearer '}${token}`;
      const response = await fetch(crossOriginProbe.url, {
        method: 'GET',
        credentials: 'omit',
        headers: probeHeaders,
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (!contentType.includes('cbor') && !contentType.includes('json')) return null;
      const bytes = new Uint8Array(await response.arrayBuffer());
      // btoa 只吃二进制字符串；分块拼接避免大数组展开爆栈
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      return { url: crossOriginProbe.url, contentType, base64: btoa(binary) };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  })();

  const fetchOne = async (path: string) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    try {
      const response = await fetch(new URL(path, location.origin).href, {
        method: 'GET',
        credentials: 'include',
        headers,
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      const text = (await response.text()).slice(0, 4000);
      return { path, text, json: contentType.includes('json') };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const results = await Promise.all(paths.map(fetchOne));
  let bodyText = (document.body?.innerText ?? '').slice(0, 20_000);
  if (readHvoyMenu && !/(?:^|\n)\s*当前积分\s*[:：]?\s*-?\d/i.test(bodyText)) {
    // Hvoy renders the account points only after the top-right account menu is
    // opened. This helper is injected for the read-only balance refresh path;
    // business clicks still go through the trusted content-script pipeline.
    const body = () => document.body?.innerText ?? document.body?.textContent ?? '';
    const visible = (element: HTMLElement) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0;
    };
    const trigger = [...document.querySelectorAll<HTMLElement>(
      'button, [role="button"], a, [aria-haspopup], [aria-expanded], [tabindex="0"]',
    )]
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const label = `${element.innerText ?? ''} ${element.getAttribute('aria-label') ?? ''}`.trim();
        const semantic = `${element.id} ${element.className} ${element.getAttribute('data-testid') ?? ''}`;
        let score = 0;
        if (element.getAttribute('aria-haspopup')?.toLowerCase() === 'menu') score += 30;
        if (element.getAttribute('aria-expanded') === 'false') score += 8;
        if (/user|account|avatar|profile|dropdown|member|用户|账户|头像/i.test(semantic)) score += 12;
        if (rect.top <= 180 && rect.right >= window.innerWidth * 0.65) score += 10;
        if (label.length >= 1 && label.length <= 32) score += 4;
        if (/登录|注册|签到|语言|主题|切换|导航|退出|logout|sign[ -]?in/i.test(label)) score -= 30;
        return { element, score };
      })
      .filter((item) => item.score >= 10)
      .sort((left, right) => right.score - left.score)[0]?.element;
    if (trigger) {
      try {
        trigger.click();
        await new Promise((resolve) => setTimeout(resolve, 250));
        bodyText = body().slice(0, 20_000);
        if (/(?:^|\n)\s*当前积分\s*[:：]?\s*-?\d/i.test(bodyText) && trigger.isConnected) {
          trigger.click();
        }
      } catch {
        // A reactive menu can disappear while the hidden tab is settling;
        // retain the original body text and let the normal parser decide.
      }
    }
  }
  return {
    payloads: results.filter((item): item is { path: string; text: string; json: boolean } => !!item),
    // 跨域响应原样 base64 带回；解码在 background（balance.ts 的纯函数）
    crossOrigin: await crossOriginPromise,
    // 接口全都读不到时，正文里的「当前余额 $X」是最后的依据
    bodyText,
  };
}
