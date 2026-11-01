/**
 * 登录身份核对。
 *
 * 解决的问题：多账号共用一个浏览器时，站点的 cookie 是**按域名**存的，
 * 不区分你想签到哪个账号。所以点账号 B 签到时，浏览器里可能还留着
 * 账号 A 的登录态 —— 旧逻辑只判断「有没有人登录」，看到已登录就跳过
 * 填账密，结果给 A 签了到、记在 B 的账上。
 *
 * 这种错误比签到失败严重得多：界面显示 B 已签到（绿色对勾），
 * B 实际一天都没签，而且用户没有任何线索能发现。
 *
 * 所以「已登录」这个判断必须升级成「登录的是不是本次要签的那个人」。
 */
import { ADAPTER_FAMILIES, SITE_TYPES, type SiteConfig } from '@/types';
import type { StepLog } from '@/automation/shared/log';
import {
  isIdentityEndpointAllowed,
  isSameSiteUrl,
  siteIdentitySource,
  type SiteIdentitySourceConfig,
} from '@/lib/site/site-security';
import { buildUserIdHeaders } from '@/lib/site/compat-headers';
import type { SiteCookieClearResult } from '@/lib/messages/site-cookies';
import { resolveSiteAdapter } from '@/automation/sites/site-adapters';
import { authBootstrapHeaders, clearAuthBootstrapCache } from '@/automation/shared/token-bootstrap';
import { decodeLimitedCbor } from './identity-cbor';

/** 身份端点，与余额端点相同 —— 这些接口同时返回用户信息和额度 */
const IDENTITY_ENDPOINTS = ['/api/user/self', '/api/user/info', '/api/v1/auth/me'];

/** 单个身份端点的超时，与余额采集同理：不能让它拖住签到 */
const IDENTITY_FETCH_TIMEOUT_MS = 4_000;

const LOGOUT_FETCH_TIMEOUT_MS = 4_000;

export interface PageIdentity {
  /** 见 AccountIdentity.verifiedByManagedLogin：本轮受管 GitHub 亲自登录后读到的身份。 */
  verifiedByManagedLogin?: boolean;
  /** 站点侧的用户 ID */
  userId?: string;
  /** 登录名 */
  username?: string;
  /** 邮箱 */
  email?: string;
  /** 显示名 */
  displayName?: string;
  /**
   * 这份身份是从哪读来的。
   *
   * 三个来源的可信度差得很远：接口是带 cookie 问服务端「我现在是谁」，那是
   * 权威答案；本地存储是前端上次登录留下的，可能已经过期；页面文本是正则
   * 从正文里捞的，而公告、邀请人、排行榜里的数字全都长成「用户 ID 5544」。
   *
   * 不记来源的后果是日志没法证伪：「当前登录的是用户 ID 5544」既可能是真的
   * 登着别人，也可能是把公告里的数字当成了当前用户 —— 两者该做的事完全相反
   * （一个必须退出重登，一个是误判、绝不能动会话），日志里却看不出是哪种。
   */
  source?: 'api' | 'storage' | 'visible';
}

/** 来源的中文说法，写进日志给用户看 */
export function identitySourceLabel(source?: PageIdentity['source']): string {
  if (source === 'api') return '站点接口';
  if (source === 'storage') return '本地登录态';
  if (source === 'visible') return '页面文本';
  return '未知来源';
}

/** 从各家 API 响应里挖出身份字段 */
export function extractIdentityFromPayload(payload: unknown): PageIdentity | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;
  if (root.success === false) return null;

  const data = (root.data ?? root) as Record<string, unknown>;
  if (!data || typeof data !== 'object') return null;

  const text = (value: unknown): string | undefined => {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return undefined;
  };

  const identity: PageIdentity = {
    userId: text(data.id) ?? text(data.user_id) ?? text(data.userId),
    username: text(data.username) ?? text(data.user_name) ?? text(data.name),
    email: text(data.email),
    displayName: text(data.display_name) ?? text(data.displayName) ?? text(data.nickname),
  };

  // 一个可用字段都没有就当读不到，别返回一个空壳让调用方误以为读到了
  return Object.values(identity).some(Boolean) ? identity : null;
}

/**
 * 从 localStorage 读取当前登录用户的数字 ID。
 *
 * new-api 系前端登录后把用户信息存在 localStorage["user"]（JSON，含 id）。
 * 这个 id 正是 `New-API-User` 等请求头要的值 —— cookie/OAuth 登录的站点没有
 * tokenConfig、请求身份接口时不带这个头，new-api 后端就回 401「未提供 New-Api-User」，
 * 于是身份永远读不到、一致性判断退化成「读不到 → 保守重登」。读它来补头。
 *
 * 读不到（非 new-api 系、未登录、或结构不符）返回 undefined。
 */
function readLocalUserId(): string | undefined {
  try {
    const raw = localStorage.getItem('user');
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { id?: unknown };
    const id = parsed?.id;
    if (typeof id === 'number' && Number.isFinite(id)) return String(id);
    if (typeof id === 'string' && id.trim()) return id.trim();
  } catch {
    // 不是 JSON 或没有 id 字段，当作读不到
  }
  return undefined;
}

/**
 * 从指定存储键读取一段文本（token / 身份 JSON 共用）。
 *
 * 显式配置了 storageType 就只查那一个存储；缺省先 localStorage 后
 * sessionStorage —— orevx 前端本身按这个顺序回读登录态（持久登录写
 * localStorage、仅本次会话登录写 sessionStorage），两边保持一致。
 * 存储被浏览器策略禁用或读取抛错时安静跳过，返回 undefined。
 */
/**
 * 未知类型站点（family=UNSUPPORTED）的身份端点。
 *
 * 用户新增的站点常常没有认出类型，但其中大多数就是 new-api / Sub2API 白标：两族的
 * 端点都问一遍（只是 GET，SPA 兜底的 HTML 会按 content-type 跳过）。
 *
 * 明确**不是**这两族的站点（模板显式声明了 UNSUPPORTED 且带 siteType=unknown，例如
 * 禾维、Linux.SB）不问：这些端点在它们上面必然 404/HTML，余额采集早已对它们跳过同一组
 * 请求（balance.ts 的 hvoy 例外）。白打三个请求只会拖慢「已登录」的判断。
 */
function unsupportedFamilyIdentityEndpoints(site: SiteConfig): readonly string[] {
  if (site.adapter?.family === ADAPTER_FAMILIES.UNSUPPORTED && site.adapter?.siteType === SITE_TYPES.UNKNOWN) return [];
  return IDENTITY_ENDPOINTS;
}

function readStorageText(key: string, storageType?: 'localStorage' | 'sessionStorage'): string | undefined {
  const kinds: Array<'localStorage' | 'sessionStorage'> = storageType
    ? [storageType]
    : ['localStorage', 'sessionStorage'];

  for (const kind of kinds) {
    try {
      const storage = kind === 'localStorage'
        ? (typeof localStorage === 'undefined' ? undefined : localStorage)
        : (typeof sessionStorage === 'undefined' ? undefined : sessionStorage);
      const value = storage?.getItem(key)?.trim();
      if (value) return value;
    } catch {
      // 换下一个存储
    }
  }
  return undefined;
}

/** 从站点配置的存储键读取身份 JSON（只读、不写；结构交给 extractIdentityFromPayload）。 */
function readIdentityFromStorage(key: string, storageType?: 'localStorage' | 'sessionStorage'): PageIdentity | null {
  const raw = readStorageText(key, storageType);
  if (!raw) return null;
  try {
    const stored = extractIdentityFromPayload(JSON.parse(raw));
    return stored ? { ...stored, source: 'storage' } : null;
  } catch {
    // 非 JSON 或结构不符：当作读不到，绝不影响后续来源
    return null;
  }
}

/**
 * 请求站点显式配置的跨域接口（identitySource.endpoint）并解码响应。
 *
 * 适用形态：SPA 部署在登录域、真实 API 在另一台主机（orevx.ai ↔
 * server.orevx.ai/api，来自 config.js 的 API_URL）；服务端要求
 * `Accept: application/cbor`，认证是 Bearer 头（值取自 storage 里 tokenKey 指向的 token）。
 *
 * 身份核对与余额采集**共用这一处**：这类接口（如 orevx 的 /user/me）本来
 * 就同时返回身份字段和 points 余额，与其各发一次请求、各写一道安全门，
 * 不如共用同一个实现（余额侧见 balance.ts 的 readCrossOriginBalance）。
 *
 * 安全约束（与 lib/site/site-security.ts 的校验同源，运行时再拦一道）：
 *  - 仅 https、主机必须是登录站点域名的自身/子域，否则一个请求都不发；
 *  - 只读 GET，绝不写任何东西；
 *  - 用显式 Bearer token（credentials:'omit'）而不是 cookie。理由：这类跨域
 *    API 的 CORS 是 `Access-Control-Allow-Origin: *` 且不带 Allow-Credentials，
 *    带 cookie 的跨域请求会被浏览器直接拦掉；站点自身也是用登录时写入
 *    storage 的 token 拼 Authorization 头访问它。'omit' 还保证不会把本站
 *    cookie 泄露给目标域。
 *  - 响应按 content-type 判定：cbor → 有限解码器（identity-cbor.ts），
 *    json → JSON.parse；其余（SPA 兜底 HTML 等）不解析。
 *
 * 任何失败（网络、超时、401、CBOR 结构非法）都返回 null，不抛给调用方 ——
 * 这条来源读不到只影响各自的结论（身份核对 / 余额差分），绝不拖垮签到本身。
 *
 * @param injectToken 显式传入的 token（校验凭据归属那一步）：接口必须用它，
 *                    绝不能用 storage 里的旧值，否则会把新凭据判成别人的。
 */
export async function fetchIdentitySourcePayload(
  site: SiteConfig,
  source: SiteIdentitySourceConfig,
  injectToken?: string,
): Promise<unknown | null> {
  if (!source.endpoint || !source.tokenKey) return null;
  if (!isIdentityEndpointAllowed(site, source.endpoint)) return null;

  const token = injectToken ?? readStorageText(source.tokenKey, source.tokenStorageType);
  if (!token) return null;

  const headers: Record<string, string> = { Accept: 'application/cbor, application/json' };
  headers[source.tokenHeader ?? 'Authorization'] = `${source.tokenPrefix ?? 'Bearer '}${token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IDENTITY_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(source.endpoint, {
      method: 'GET',
      credentials: 'omit',
      headers,
      signal: controller.signal,
    });
    if (!response.ok) return null;

    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (contentType.includes('cbor')) {
      return decodeLimitedCbor(new Uint8Array(await response.arrayBuffer()));
    }
    if (contentType.includes('json')) {
      return await response.json().catch(() => null);
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 跨域接口读到 payload 后提取身份字段；读不到返回 null。 */
async function readCrossOriginIdentity(
  site: SiteConfig,
  source: SiteIdentitySourceConfig,
  injectToken?: string,
): Promise<PageIdentity | null> {
  const payload = await fetchIdentitySourcePayload(site, source, injectToken);
  if (payload == null) return null;
  const identity = extractIdentityFromPayload(payload);
  return identity ? { ...identity, source: 'api' } : null;
}

/**
 * 从页面上可见的文本读取当前登录身份。
 *
 * 为什么需要它：身份接口不是唯一来源，很多站点把用户名和 ID **直接印在个人
 * 资料页上**（1412's API 的 /profile 就写着「demo-user 用户 ID 436」）。
 * 而接口路径、鉴权头各家不同，读不到就退化成 unknown —— 此时若信任当前登录态，
 * 等于放弃核对，可能给错账号签到；若保守重登，又会毁掉有效的第三方登录态。
 * 两条路都错，因为前提就错了：身份其实看得见，只是没去读。
 *
 * 纯文本没有 DOM 归属，只接受账号标签和个人资料上下文；不能把正文中第一个
 * 邮箱认成当前用户。一梦五千年的中奖名单就会显示其他用户的完整邮箱。
 */
export function readVisibleIdentityFromText(text?: string | null): PageIdentity | null {
  return parseVisibleIdentity(currentIdentityText(text));
}

/** 「邀请人 UID 5544」、中奖用户、公告联系人等都不是当前登录的这个人。 */
const OTHER_PERSON_CONTEXT = /(邀请|受邀|推荐|推广|上级|下级|下线|团队|排行|榜|赞助|作者|客服|管理员|中奖|获奖|公告|invit|referr|sponsor|winner|leaderboard|announcement)/i;
const PUBLIC_IDENTITY_SECTION = /中奖(?:名单|记录|用户)|获奖(?:名单|记录)|排行榜|排名榜|用户列表|成员列表|历史记录|公告|\b(?:winners?|leaderboard|rankings?|draw history|announcements?)\b/i;
const PERSONAL_IDENTITY_SECTION = /^(?:个人资料|个人信息|账户信息|账号信息|我的账户|我的账号|我的资料|profile|my account|account (?:info(?:rmation)?|details))\s*[:：]?$/i;
const EXPLICIT_CURRENT_ACCOUNT = /^(?:当前(?:登录)?(?:账号|账户|用户)|我的(?:账号|账户|邮箱))\s*[:：]?/;
const VISIBLE_IDENTITY_LABEL = /(?<![A-Za-z])(?:用户\s*ID|User\s*ID|UID)\s*[:：#]?\s*\d|当前(?:登录)?(?:账号|账户|用户)|用户名|登录名|账[号户]|邮箱|电子邮件|\b(?:e-?mail|username|account)\b|欢迎回来|welcome back/i;
const ACCOUNT_MENU_ACTION = /退出登录|退出账号|注销登录|个人资料|账户设置|账号设置|\b(?:log\s*out|sign\s*out|my account|account settings|profile)\b/i;

/**
 * 从正文中挑选身份相关的行，而不是给整页套邮箱正则。
 * 公共名单的表头也可能写「邮箱 / 用户 ID」，因此遇到公共区块后必须等到
 * 明确的个人资料/当前账号标题才恢复读取。资料标签下一行的值兼容两行布局。
 * accountScope 只用于已确认属于用户菜单的 DOM，不用于整页正文。
 */
function currentIdentityText(text?: string | null, accountScope = false): string {
  if (!text) return '';
  const selected: string[] = [];
  let publicSection = false;
  let afterIdentityLabel = false;

  for (const line of text.split(/[\r\n]+/).map((value) => value.trim()).filter(Boolean)) {
    if (PUBLIC_IDENTITY_SECTION.test(line)) {
      publicSection = true;
      afterIdentityLabel = false;
      continue;
    }
    const personalSection = PERSONAL_IDENTITY_SECTION.test(line);
    if (personalSection || EXPLICIT_CURRENT_ACCOUNT.test(line)) publicSection = false;
    if (publicSection || OTHER_PERSON_CONTEXT.test(line)) {
      afterIdentityLabel = false;
      continue;
    }

    const labeled = personalSection || VISIBLE_IDENTITY_LABEL.test(line);
    const adjacentValue = afterIdentityLabel
      && /^[^\s<>]{2,80}(?:\s*[·|]\s*[^\r\n]{1,40})?$/.test(line);
    if (accountScope || labeled || adjacentValue) selected.push(line);
    afterIdentityLabel = labeled;
  }
  return selected.join('\n');
}

function visibleIdentityElement(element: HTMLElement): boolean {
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current.hidden || current.getAttribute('aria-hidden') === 'true' || current.hasAttribute('inert')) return false;
    const style = getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  }
  return true;
}

/** 用户菜单中的裸邮箱/账号名可以读取；普通列表中的相同文本不可以。 */
function readIdentityTextFromPage(): string {
  const texts = [currentIdentityText(document.body?.innerText)];
  // 纯文本调用方/旧测试没有 DOM 查询能力，只保留有明确标签的部分。
  if (typeof document.querySelectorAll !== 'function') return texts[0]!;

  for (const element of document.querySelectorAll<HTMLElement>(
    '[role="menu"], [aria-haspopup="menu"], [aria-haspopup="true"]',
  )) {
    if (!visibleIdentityElement(element)) continue;
    if (element.closest('table, [role="table"], [role="grid"], .lottery-sidebar')) continue;
    const text = element.innerText ?? element.textContent ?? '';
    if (!text.trim() || text.length > 2_000) continue;

    const isAccountMenu = element.getAttribute('role') === 'menu'
      && ACCOUNT_MENU_ACTION.test(text);
    const isAccountTrigger = element.hasAttribute('aria-haspopup') && (
      !!element.closest('header, nav, [role="banner"]')
      || /user|account|profile|avatar|用户|账号|账户|个人|头像/i.test(
        `${element.getAttribute('aria-label') ?? ''} ${element.getAttribute('title') ?? ''}`,
      )
    );
    if (isAccountMenu || isAccountTrigger) texts.push(currentIdentityText(text, true));
  }
  return texts.filter(Boolean).join('\n');
}

function uniqueIdentityValue(values: string[]): string | undefined {
  const distinct = new Map(values.map((value) => [value.toLowerCase(), value]));
  return distinct.size === 1 ? distinct.values().next().value : undefined;
}

/** 只解析已经限定到当前账号上下文的文本，各字段有歧义时不任取第一个。 */
function parseVisibleIdentity(text: string): PageIdentity | null {
  if (!text) return null;

  const identity: PageIdentity = { source: 'visible' };

  const visibleId = readVisibleUserId(text);
  if (visibleId) identity.userId = visibleId;

  // @句柄必须有左边界，不能把先出现的邮箱域名当成句柄并漏掉真正的用户名。
  const handles = [...text.matchAll(/(?<![\w.+@*-])@([A-Za-z0-9][A-Za-z0-9._-]{1,38})\b/g)]
    .map((match) => match[1]!)
    .filter((value) => !value.includes('.'));
  const labeledNames = [...text.matchAll(/(?:^|\s)(?:用户名|登录名|当前(?:登录)?(?:账号|账户)|username|login name)(?:\s*[:：]\s*|\s+)([\p{L}\p{N}][\p{L}\p{N}._+@-]{1,79})/giu)]
    .map((match) => match[1]!)
    .filter((value) => !value.includes('@'));
  // 个人资料可能另列 GitHub @句柄；明确的站点登录名优先于第三方句柄。
  const username = uniqueIdentityValue(labeledNames.length ? labeledNames : handles);
  if (username) identity.username = username;

  const emails = [...text.matchAll(/(?<![\w.+*-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g)]
    .map((match) => match[0]);
  const email = uniqueIdentityValue(emails);
  if (email) identity.email = email;

  return identity.userId || identity.username || identity.email ? identity : null;
}

export function readVisibleIdentity(): PageIdentity | null {
  return parseVisibleIdentity(readIdentityTextFromPage());
}

/**
 * 从正文里读「当前登录用户」的数字 ID。
 *
 * 三条收紧，每条都对应一种会读出别人 ID 的真实页面：
 *
 *  1. 左边必须不是字母。原来的 /UID/ 没有左边界，`GUID: 123`、`SUID 88`
 *     一律命中，抓回来的是个跟用户无关的数字。
 *  2. 邀请/推荐/排行榜上下文里的 ID 跳过。new-api 系个人页普遍印着
 *     「邀请人 UID」，控制台公告里也常出现别人的 ID。
 *  3. 正文里出现**多个不同**的 ID 时一个都不认。分不清哪个是自己时，宁可
 *     回答「读不到」让上层去查接口，也不能随手挑第一个 —— 挑错的代价是把
 *     一个正常的登录态判成「登着别人」，清掉会话重登一遍。
 */
function readVisibleUserId(text: string): string | undefined {
  const pattern = /(?<![A-Za-z])(?:用户\s*ID|User\s*ID|UID)\s*[:：#]?\s*(\d{1,12})\b/gi;
  const found = new Set<string>();

  for (const match of text.matchAll(pattern)) {
    const id = match[1];
    if (!id) continue;
    const before = text.slice(Math.max(0, (match.index ?? 0) - 14), match.index ?? 0);
    if (OTHER_PERSON_CONTEXT.test(before)) continue;
    found.add(id);
  }

  return found.size === 1 ? [...found][0] : undefined;
}

/** 太短的名字容易在正文里撞车（`abc` 随便一段文字里都有），不参与比对 */
const MIN_ACCOUNT_NAME_LENGTH = 4;

/** 判断命中的是不是一个完整的名字，而不是更长一串里的一段 */
const NAME_CHAR = /[A-Za-z0-9._+@-]/;

/** 打码邮箱：`f***@gmail.com`、`fzk**520@qq.com` */
const MASKED_EMAIL = /(?<![\w.+-])([\w.+-]*)\*+([\w.+-]*)@([\w-]+\.[\w.-]+)/g;

export interface AccountOnPage {
  /** 页面上实际印着的那串文本，可能是打码形式 */
  matched: string;
  /** 是否靠打码邮箱对上的 */
  masked: boolean;
}

/**
 * 反向核对：当前账号区域有没有印着**本账号**的用户名/邮箱。
 *
 * 为什么需要这一招：`readPageIdentity` 是「先问站点你是谁，再和记录比」，
 * 三个来源全空时就只剩 unknown，而 unknown 对 form/token 站点等于退出重登 ——
 * 日志里那句「无法确认当前登录身份（读不到当前登录身份），按切换账号处理」
 * 就是这么来的。但站点其实常常把当前账号印在页头或个人页上，只是格式五花八门
 * （没有「用户 ID」标签、不是 @句柄、邮箱还被打了码），正则挖不出来。
 *
 * 换个问法就能答上来：不问「你是谁」，问「账号区域有没有我要签的这个人」。
 * 中奖名单、历史或公告里即使命中本账号，也不能证明当前浏览器登录的是本人。
 * 没命中不代表登着别人，仍然回到保守路径。
 *
 * 判据收得很紧：完整 token 匹配（左右不能再接名字字符），或打码邮箱的
 * 可见部分与本账号严格对得上（前缀是前缀、后缀是后缀、域名完全相同）。
 */
export function findAccountOnPage(expected: string, pageText?: string | null): AccountOnPage | null {
  const target = expected.trim().toLowerCase();
  const text = pageText == null ? readIdentityTextFromPage() : currentIdentityText(pageText);
  if (!text || target.length < MIN_ACCOUNT_NAME_LENGTH) return null;

  if (containsWholeToken(text.toLowerCase(), target)) return { matched: expected.trim(), masked: false };

  // 打码邮箱只在本账号本身是邮箱时才有比对基础
  const at = target.lastIndexOf('@');
  if (at <= 0) return null;
  const localPart = target.slice(0, at);
  const domain = target.slice(at + 1);
  if (!domain) return null;

  for (const match of text.matchAll(MASKED_EMAIL)) {
    const prefix = (match[1] ?? '').toLowerCase();
    const suffix = (match[2] ?? '').toLowerCase();
    // 没有任何可见字符时（`***@gmail.com`）只剩域名，同域的任意账号都能对上，不算
    if (!prefix && !suffix) continue;
    if ((match[3] ?? '').toLowerCase() !== domain) continue;
    if (prefix && !localPart.startsWith(prefix)) continue;
    if (suffix && !localPart.endsWith(suffix)) continue;
    return { matched: match[0], masked: true };
  }

  return null;
}

function containsWholeToken(haystack: string, needle: string): boolean {
  for (let from = 0; from <= haystack.length; ) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    const before = haystack[at - 1] ?? ' ';
    const after = haystack[at + needle.length] ?? ' ';
    if (!NAME_CHAR.test(before) && !NAME_CHAR.test(after)) return true;
    from = at + 1;
  }
  return false;
}

/**
 * 读取当前页面的登录身份。读不到返回 null，不抛异常。
 *
 * @param site 站点配置
 * @param injectToken 显式传入的 token，优先级高于从存储读取。
 *                    token 认证流程注入后立即验证时用它，避免读到旧值。
 */
export async function readPageIdentity(
  site: SiteConfig,
  injectToken?: string,
  /**
   * `serverOnly`：只要**站点服务端**的回答（身份接口 / 显式配置的身份接口）。
   *
   * 「当前到底有没有登录」只有服务端说了算：本地登录态副本（Sub2API 的 auth_user）
   * 可能是过期会话的残留，页面文字可能只是页脚的联系邮箱。登录前的快速探测用它，
   * 读不到就返回 null，绝不回落到本地副本或页面文字。
   */
  options: { serverOnly?: boolean } = {},
): Promise<PageIdentity | null> {
  const serverOnly = options.serverOnly === true;
  const family = resolveSiteAdapter(site).family;
  // 站点显式配置的身份读取扩展（默认 null = 行为完全不变，见 site-security.ts）
  const identitySource = siteIdentitySource(site);

  /**
   * sub2api 系登录后把用户信息存在 localStorage["auth_user"]（JSON，含 id/email）。
   *
   * 平时先读它：这类站点身份接口要 Bearer token，不先读本地就会永远「读不到
   * 身份」而反复保守重登（还可能在重登时撞上登录页遮罩）。读到就用，顺带省一
   * 次请求。
   *
   * ⚠️ 但它只是前端上次登录留下的副本，不是服务端的回答。
   */
  const readStoredIdentity = (): PageIdentity | null => {
    // 站点显式配置的存储键（如 orevx 的 auth-user）：与适配家族无关，只读。
    // 没有这个配置时这一分支不执行，所有旧站点的行为保持不变。
    if (identitySource?.storageKey) {
      const configured = readIdentityFromStorage(identitySource.storageKey, identitySource.storageType);
      if (configured) return configured;
    }

    if (family !== ADAPTER_FAMILIES.SUB2API) return null;
    try {
      const rawAuthUser = localStorage.getItem('auth_user');
      if (!rawAuthUser) return null;
      const stored = extractIdentityFromPayload(JSON.parse(rawAuthUser));
      return stored ? { ...stored, source: 'storage' } : null;
    } catch {
      // 非 JSON 或结构不符，当作读不到
      return null;
    }
  };

  /**
   * 显式传了 token 说明调用方在验证「这份凭据属于谁」（注入后立刻核对那一步）。
   *
   * 这时绝不能让 localStorage 里的残留先回答：上一个账号的 auth_user 还在，而
   * 注入的是本账号的 token，读到的就是上个账号 —— 一个本来有效的凭据被判成
   * 「凭据对应的不是本账号」。反过来更糟：残留恰好是本账号、而 token 是别人的，
   * 核对会放行，等于把签到记到错账号头上。所以带 token 时先问接口，
   * 只在接口完全不通时才回落到本地副本（见下方）。
   *
   * 站点显式配置了跨域身份接口（identitySource.endpoint）时，本地的残留副本
   * 同样不许抢答：接口是权威答案，本地副本只在接口读不到时兜底（见下方）。
   */
  if (!injectToken && !identitySource?.endpoint && !serverOnly) {
    const stored = readStoredIdentity();
    if (stored) return stored;
  }

  const headers: Record<string, string> = { Accept: 'application/json' };

  // Token 认证站点：cookie 里没有凭据，必须手动拼 Authorization 头。
  // 不加这个头，接口一律返回 401，身份永远读不到，
  // 于是每次都走「读不到身份 → 清登录态 → 重新登录」的破坏性路径。
  if (site.tokenConfig) {
    const { storageKey, storageType, headerName, headerPrefix } = site.tokenConfig;
    // 缺省两个存储都试、读取抛错安静跳过（与 readStorageText 同一口径）。
    const token = injectToken ?? readStorageText(storageKey, storageType);
    if (token) headers[headerName] = `${headerPrefix}${token}`;
  } else if (!injectToken) {
    /**
     * 没配 tokenConfig 的站点（书签导入 / 新增时没认出类型）：按 Sub2API 系的约定键名
     * 找一枚 Bearer，与余额采集（balance.ts 的 siteApiAuthHeaders）同一套兜底。
     * 只补缺位，不覆盖任何显式配置；不是 token 的值（JSON 对象、短串）一律不用。
     */
    for (const key of ['auth_token', 'access_token', 'token']) {
      const token = readStorageText(key)?.trim();
      if (token && token.length > 20 && !token.startsWith('{')) {
        headers.Authorization = `Bearer ${token}`;
        break;
      }
    }
  }

  // new-api 系身份接口要 user-id 头（New-API-User / Veloera-User / …），值是当前
  // 登录用户的数字 id。要读的是「当前浏览器登录的是谁」，所以优先用 localStorage 里
  // 当前登录用户的 id；站点/账号存过的 adapter.userId 只作兜底。buildUserIdHeaders 把值
  // 扇到所有已知兼容头名，服务端只认自己那个；读不到 userId 时返回空对象，不影响其它站点。
  Object.assign(headers, buildUserIdHeaders(readLocalUserId() ?? site.adapter?.userId));

  // 轮换令牌站点（authBootstrap）：先拿会话 cookie 换一枚短命 Bearer。
  // 这类站的令牌只在页面内存里，没有它身份接口同样一律 401 —— 而身份读不到会
  // 触发「清登录态 → 重新登录」的破坏性路径，比余额读不到严重得多。
  // 已有的 Authorization（tokenConfig 里那份）优先，引导只补缺位，不覆盖。
  const bootstrapHeaders = await authBootstrapHeaders(site);
  for (const [name, value] of Object.entries(bootstrapHeaders)) {
    if (!headers[name]) headers[name] = value;
  }

  // 配了专属端点就只查它（轮询默认列表会在 404 上浪费时间）
  const endpoints = site.tokenConfig?.identityEndpoint
    ? [site.tokenConfig.identityEndpoint]
    : family === ADAPTER_FAMILIES.SUB2API
      ? ['/api/v1/auth/me', '/api/user/self', '/api/user/info']
      : family === ADAPTER_FAMILIES.NEW_API
        ? ['/api/user/self', '/api/user/info', '/api/v1/auth/me']
        : identitySource?.endpoint
          ? IDENTITY_ENDPOINTS
          : unsupportedFamilyIdentityEndpoints(site);

  // 站点显式配置的跨域身份接口（identitySource.endpoint）：排在同源轮询与本地
  // 副本之前 —— 带 token 问服务端「我现在是谁」是权威答案，本地副本可能过期。
  // 默认不配置 = 一个请求都不发；配置了也要先过 https + 域名白名单，运行时再拦一道。
  if (identitySource?.endpoint) {
    const crossOrigin = await readCrossOriginIdentity(site, identitySource, injectToken);
    if (crossOrigin) return crossOrigin;

    // 接口读不到（离线/未登录/超时/解析失败）才退回本地副本：比没有强，
    // 且来源标成 storage，日志里能看出这条结论的证据有多硬。
    if (!injectToken && !serverOnly) {
      const stored = readStoredIdentity();
      if (stored) return stored;
    }
  }

  /**
   * 身份接口的 401 **不是**「用户掉线」的证据，一条都不用。
   *
   * 这是踩过的坑：早先按响应体措辞区分「要 token」和「会话真失效」，逐个站点
   * 补正则（invalid access token / not logged in and no access token provided /
   * Authorization header is required / 无权进行此操作…）。结果是**新加一个站点
   * 换一种说法就再坏一次** —— 判据绑在服务端文案上，注定追不完。
   *
   * 实测（2026-11-01，8 个 new-api 分叉）：这些站点的身份接口只认
   * `Authorization: Bearer`，用 cookie 去问必然 401；补上所有已知的 user-id 兼容头
   * 也照样 401。换句话说，**只要浏览器拿不到页面内存里的 token，这个 401 就必然出现**，
   * 而它与「会话是否有效」完全无关 —— 页面可能正停在已登录的资料页上。
   *
   * 所以这里只记「读到 / 没读到身份」，不再上报「未认证」。判断用户是否掉线交给
   * 页面形态（登录表单、登录路由）与导航行为（被踢回登录页），那些才是通用的、
   * 与站点措辞无关的证据。
   */
  let endpointResponded = false;
  for (const path of endpoints) {
    const url = new URL(path, location.origin).href;
    // 安全边界：只查同站，避免配置被改成往外部地址发带 cookie 的请求
    if (!isSameSiteUrl(site, url)) continue;

    // 超时保护：身份核对绝不能拖住签到。站点接口挂起时不设超时会让
    // 任务一直停在「签到中」，用户看不到任何结果。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IDENTITY_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers,
        signal: controller.signal,
      });
      if (!response.ok) continue;

      // SPA 常把未命中的路径兜底返回 index.html：状态是 200 但内容是 HTML，
      // 解析 JSON 只会白费一次往返。
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (!contentType.includes('json')) continue;
      endpointResponded = true;

      const identity = extractIdentityFromPayload(await response.json().catch(() => null));
      if (identity) return { ...identity, source: 'api' };
    } catch {
      // 端点不存在、超时或网络失败，试下一个
    } finally {
      clearTimeout(timer);
    }
  }

  if (serverOnly) {
    // 读不到身份就返回 null；**不上报「未认证」**。
    // 401 只说明「拿不到 token」，与页面是否登录无关（见上方长注释）。
    return null;
  }
  // 带 token 的验证路径把本地副本降级到这里：接口彻底不通时它比什么都没有好，
  // 而 source 标成 storage，日志里能看出这个结论的证据有多硬。
  if (injectToken) {
    const stored = readStoredIdentity();
    if (stored) return stored;
  }

  // 所有接口都读不到时，回退到页面上可见的用户名/ID。
  // 这不是猜测：个人资料页本来就把身份印在页面上，只是此前没去读。
  return readVisibleIdentity();
}

/** 把邮箱和用户名归一化后比较：站点可能大小写不一致 */
function sameText(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export type IdentityVerdict =
  /** 确认是本次要签到的账号 */
  | { match: 'confirmed'; detail: string }
  /** 确认是**别的**账号，绝不能继续 */
  | { match: 'mismatch'; detail: string }
  /** 读不到身份，无法判断 */
  | { match: 'unknown'; detail: string };

/**
 * 比对读到的身份是不是 expected 这个账号，命中就返回对上的那个字段值。
 *
 * 抽出来是因为两处要用：没有 userId 时的主判据，以及「页面文本读到的 ID
 * 与记录不一致」时的旁证 —— 后者决定要不要为一个弱证据清掉有效会话。
 */
function matchedName(identity: PageIdentity, expected: string): string | null {
  const candidates = [identity.username, identity.email, identity.displayName].filter(Boolean) as string[];
  const hit = candidates.find((candidate) => sameText(candidate, expected));
  if (hit) return hit;

  // 邮箱登录名 vs 站点只返回用户名前缀：a@b.com 对 a 视为一致。
  // 这个宽松匹配只在一侧含 @ 而另一侧不含时启用，避免把
  // 两个不同的邮箱前缀（a@x.com 与 a@y.com）当成同一个人。
  const localPart = expected.includes('@') ? expected.split('@')[0] : null;
  if (!localPart) return null;
  return candidates.find((candidate) => !candidate.includes('@') && sameText(candidate, localPart)) ?? null;
}

interface IdentityNameMatch {
  /** 站点实际返回并命中的身份字段。 */
  value: string;
  /** 本地账号用于核对的主标识或受控别名。 */
  expected: string;
  source: 'primary' | 'stored' | 'alias';
}

/**
 * 依次尝试账号主标识与明确保存的身份别名。
 *
 * 别名必须由调用方按当前登录方式显式传入。这里不删除 `_`、`-` 等字符做
 * 模糊归一化，否则 `demo_104` 和 `demo104` 之外的真实不同账号也会被合并。
 */
function matchedExpectedName(
  identity: PageIdentity,
  expected: string,
  aliases: readonly string[] = [],
  stored?: { username?: string; email?: string },
): IdentityNameMatch | null {
  const primary = matchedName(identity, expected);
  if (primary) return { value: primary, expected, source: 'primary' };

  if (stored?.username && sameText(identity.username, stored.username)) {
    return { value: identity.username!, expected: stored.username, source: 'stored' };
  }
  if (stored?.email && sameText(identity.email, stored.email)) {
    return { value: identity.email!, expected: stored.email, source: 'stored' };
  }

  const seen = new Set<string>([expected.trim().toLowerCase()]);
  const strictAliases = aliases
    .map((value) => value.trim())
    .filter((value) => {
      if (!value) return false;
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  for (const alias of strictAliases) {
    // GitHub 登录字段可以填 handle 或邮箱。handle 只与明确的 username 精确
    // 比较；邮箱只与完整 email 精确比较。不能沿用主账号的邮箱前缀兼容，也
    // 不能拿 displayName 当第三方身份，否则同名用户会被误认成同一账号。
    const value = alias.includes('@')
      ? (sameText(identity.email, alias) ? identity.email : undefined)
      : (sameText(identity.username, alias) ? identity.username : undefined);
    if (value) return { value, expected: alias, source: 'alias' };
  }
  return null;
}

export interface VerifyIdentityOptions {
  /**
   * 本站其它账号的 userId → 账号名。
   *
   * 只为把日志说清楚：「当前登录的是用户 ID 5544」用户看不出这是误判还是
   * 真的登着别人；写成「当前登录的是用户 ID 5544（本站账号 fzk521）」就一目
   * 了然 —— 那确实是自己的另一个账号，退出重登是对的。
   */
  knownUsers?: Record<string, string>;
  /**
   * 页面正文中用严格完整词匹配命中的本账号名。
   *
   * 1412 的资料页会同时显示站点账号 `demo-user` 和 GitHub 句柄
   * `@demo-github`。可见身份解析会把后者读成 username，因此需要把前者作为
   * 旁证传进来。只有 visible/无接口身份时使用，绝不能覆盖 API 的明确结论。
   */
  pageAccountMatch?: string;
  /**
   * 当前账号明确保存的第三方身份标识。
   *
   * 例如 Future Hub 本地账号是 `demo_104`，GitHub 用户名是 `demo104`，而
   * 站点身份接口返回后者。调用方只能在本轮确实使用 GitHub 登录时传入它；
   * 普通表单/OAuth 登录不得借用该字段放宽身份核对。
   */
  expectedAliases?: readonly string[];
  /** 上次已通过核对并保存的站点身份；只做对应字段的完整精确匹配。 */
  expectedIdentity?: { username?: string; email?: string };
}

/**
 * 核对页面上登录的是不是指定账号。
 *
 * 判定策略偏保守：只有明确对不上才算 mismatch。读不到身份时返回 unknown，
 * 由调用方决定怎么处理 —— 对于「已登录就跳过登录」这种优化，unknown
 * 必须当成不可信（走完整登录流程），否则漏判的代价是给错账号签到。
 *
 * detail 一律带上身份的来源。mismatch 会触发退出重登，是唯一有破坏性的
 * 结论，用户必须能从日志里判断这个结论站不站得住脚。
 *
 * @param expected 本次任务要签到的账号标识（用户名或邮箱）
 */
export function verifyIdentity(
  identity: PageIdentity | null,
  expected: string,
  storedUserId?: string,
  options?: VerifyIdentityOptions,
): IdentityVerdict {
  const pageAccountMatch = options?.pageAccountMatch;
  const visiblePageMatch = pageAccountMatch && (!identity || identity.source === 'visible')
    && sameText(pageAccountMatch, expected)
      ? pageAccountMatch
      : null;

  if (!identity) {
    return visiblePageMatch
      ? { match: 'confirmed', detail: `页面显示账号 ${visiblePageMatch} 一致（读自页面文本）` }
      : { match: 'unknown', detail: '读不到当前登录身份' };
  }

  const from = `读自${identitySourceLabel(identity.source)}`;
  const nameMatch = matchedExpectedName(
    identity,
    expected,
    options?.expectedAliases,
    options?.expectedIdentity,
  );

  // knownUsers 只包含本站其它本地账号。这个 userId 归属是强冲突证据，必须在
  // stored ID、用户名和第三方别名的所有成功出口之前判定，任何名称都不能覆盖。
  const knownOwner = identity.userId ? options?.knownUsers?.[identity.userId] : undefined;
  if (identity.userId && knownOwner) {
    return {
      match: 'mismatch',
      detail: storedUserId
        ? `当前登录的是用户 ID ${identity.userId}（本站账号 ${knownOwner}，${from}），本次要签到的是 ${storedUserId}`
        : `当前登录的是用户 ID ${identity.userId}（本站账号 ${knownOwner}，${from}），不是本次账号 ${expected}`,
    };
  }

  // 有存过的 userId 就用它比对，这是最可靠的判据 ——
  // 用户名可能被站点改写（大小写、去掉域名后缀），ID 不会。
  if (storedUserId && identity.userId) {
    if (identity.userId === storedUserId) {
      return { match: 'confirmed', detail: `用户 ID ${identity.userId} 一致（${from}）` };
    }

    /**
     * 页面文本读来的 ID 是弱证据。
     *
     * 正文里的数字未必属于当前用户，而这条分支的结论会清掉登录态重登。
     * 所以当页面上同时印着用户名、且正是本账号时，按用户名为准 ——
     * 那个数字八成来自公告或别人的资料，不该为它毁掉一个有效会话。
     */
    const corroboration = identity.source === 'visible'
      ? nameMatch?.value ?? visiblePageMatch
      : null;
    if (corroboration) {
      return {
        match: 'confirmed',
        detail: `账号 ${expected} 一致（页面上的用户 ID ${identity.userId} 与记录的 ${storedUserId} 不符，但用户名 ${corroboration} 对得上，按用户名为准）`,
      };
    }

    return {
      match: 'mismatch',
      detail: `当前登录的是用户 ID ${identity.userId}（${from}），本次要签到的是 ${storedUserId}`,
    };
  }

  // 没存过 ID 就比对用户名/邮箱。expected 是用户填的登录名，
  // 可能是邮箱也可能是用户名，所以两个字段都试。
  const candidates = [identity.username, identity.email, identity.displayName].filter(Boolean) as string[];
  if (candidates.length === 0) return { match: 'unknown', detail: `站点未返回可比对的用户名（${from}）` };

  const matched = nameMatch?.value ?? visiblePageMatch;
  if (matched) {
    return {
      match: 'confirmed',
      detail: nameMatch?.source === 'stored'
        ? `账号 ${expected} 已保存的站点身份 ${nameMatch.expected} 与当前身份一致（${from}）`
        : nameMatch?.source === 'alias'
          ? `账号 ${expected} 保存的身份别名 ${nameMatch.expected} 与当前身份 ${matched} 一致（${from}）`
          : sameText(matched, expected)
          ? `账号 ${expected} 一致（${from}）`
          : `账号 ${expected} 与站点用户名 ${matched} 一致（${from}）`,
    };
  }

  return {
    match: 'mismatch',
    detail: `当前登录的是 ${candidates[0]}（${from}），本次要签到的是 ${expected}`,
  };
}

/**
 * 清掉站点的本地登录态，为切换账号做准备。
 *
 * 只清 localStorage / sessionStorage 里与登录相关的键，不动 cookie ——
 * content script 碰不到 HttpOnly cookie，那部分靠 `logoutSession` 调
 * 站点的退出接口来清。
 *
 * ⚠️ 单独调这个函数**不足以**切换账号：cookie 还在，站点会认旧账号，
 * 表单提交要么被忽略要么撞 CSRF。切换账号请用 `logoutSession`。
 */
export function clearKnownLoginState(site: SiteConfig, log: StepLog): number {
  const patterns = [/token/i, /auth/i, /session/i, /user/i, /login/i];
  const configured = site.checkin?.logoutStorageKeys ?? [];

  let cleared = 0;
  for (const storage of [localStorage, sessionStorage]) {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key) keys.push(key);
    }
    for (const key of keys) {
      const shouldClear = configured.includes(key) || patterns.some((pattern) => pattern.test(key));
      if (!shouldClear) continue;
      storage.removeItem(key);
      cleared += 1;
    }
  }

  if (cleared) log.push(`已清除 ${cleared} 项本地登录态`);
  return cleared;
}

/** 退出结果，调用方据此决定要不要继续往下走登录流程 */
export interface LogoutOutcome {
  /** 本地存储清掉了几项 */
  clearedKeys: number;
  /** 是否成功调用了站点的退出接口（cookie 才可能被清） */
  serverLogout: boolean;
  /** 后台浏览器 API 对本站 Cookie 的实际清理结果。 */
  browserCookies?: SiteCookieClearResult;
  /** cookie 是否可能还在（true 表示不能信任表单登录，得重载页面） */
  cookieMayRemain: boolean;
}

export type ClearSiteCookies = () => Promise<SiteCookieClearResult>;

/**
 * 退出当前会话，为切换到另一个账号做准备。
 *
 * 为什么必须有这一步：站点的登录态由**两部分**组成 ——
 * localStorage 里的 token（脚本能删）和 HttpOnly cookie（脚本删不掉）。
 * 只删前者的话，站点后端仍然按 cookie 认出旧账号：
 *
 *   - 有的站点直接忽略新的表单提交，返回「已登录」，于是给旧账号签到；
 *   - 有的站点校验 CSRF token 与会话是否配对，不配对就报登录失败。
 *
 * 两种表现都是「点账号 B 却签了 A，或者干脆登录失败」，正是这个 bug。
 *
 * 所以退出要按能拿到的手段依次尝试：
 *   1. 站点声明的退出接口（logoutApiUrl / checkin.logoutApiUrl）—— 唯一能让
 *      后端主动 Set-Cookie 过期的办法；
 *   2. 清本地存储 —— token 认证站点靠这个就够；
 *   3. 都不行就告诉调用方 cookie 可能还在，让它重载登录页而不是直接填表单。
 */
export async function logoutSession(
  site: SiteConfig,
  log: StepLog,
  clearSiteCookies?: ClearSiteCookies,
): Promise<LogoutOutcome> {
  // 换账号之后旧令牌必须作废：引导缓存只按站点键控，不清掉会让下一个账号
  // 命中上一个账号的令牌（身份闸门会把 B 读成 A）。
  clearAuthBootstrapCache();
  const clearedKeys = clearKnownLoginState(site, log);

  // 两处都允许配，优先用站点级的（checkin.logoutApiUrl 原本是 relogin 签到方式专用）
  const logoutUrl = site.logoutApiUrl ?? site.checkin?.logoutApiUrl;
  let serverLogout = false;

  // 正常扩展运行时由 background 的 Cookie API 直接删除本站 Cookie，并在删除后
  // 再枚举一次作为证据。这条路径不依赖各白标站点是否真的实现了所谓退出接口。
  // 只有旧 host / 单元调用方没有 Cookie 能力时，才把配置接口作为兼容兜底。
  if (logoutUrl && !clearSiteCookies) {
    const url = new URL(logoutUrl, location.origin).href;
    // 安全边界：退出请求带 cookie，绝不能发到站外
    if (isSameSiteUrl(site, url)) {
      // 站点可能只认 POST 或只认 GET，两个都试
      for (const method of ['POST', 'GET'] as const) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), LOGOUT_FETCH_TIMEOUT_MS);
        try {
          const response = await fetch(url, {
            method,
            credentials: 'include',
            headers: { Accept: 'application/json' },
            signal: controller.signal,
          });
          if (response.ok) {
            serverLogout = true;
            log.push(`已调用站点退出接口(${method} ${new URL(url).pathname})，服务端会话已失效`);
            break;
          }
        } catch {
          // 换下一个方法
        } finally {
          clearTimeout(timeout);
        }
      }
      if (!serverLogout) log.push(`退出接口无响应(${new URL(url).pathname})，改用重载登录页的方式切换账号`);
    } else {
      log.push('配置的退出接口不在本站，已忽略');
    }
  }

  let browserCookies: SiteCookieClearResult | undefined;
  let browserCookieClearFailed = false;
  if (clearSiteCookies) {
    try {
      browserCookies = await clearSiteCookies();
      if (browserCookies.failed > 0 || browserCookies.removed < browserCookies.matched) {
        browserCookieClearFailed = true;
        log.push(
          `本站浏览器 Cookie 清理后仍残留 ${browserCookies.failed
            || browserCookies.matched - browserCookies.removed} 项`
          + `（清理前发现 ${browserCookies.matched} 项）`,
        );
      } else if (browserCookies.removed > 0) {
        log.push(`已清除本站浏览器 Cookie ${browserCookies.removed} 项（含 HttpOnly）`);
      } else {
        log.push('已确认本站浏览器没有残留 Cookie');
      }
    } catch (error) {
      browserCookieClearFailed = true;
      log.push(`清除本站浏览器 Cookie 失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    clearedKeys,
    serverLogout,
    ...(browserCookies ? { browserCookies } : {}),
    // 运行时提供了浏览器清理能力，就以真实删除结果为准；测试/旧调用方没有
    // 提供时才回退到站点退出接口的结果。
    cookieMayRemain: clearSiteCookies
      ? browserCookieClearFailed || !browserCookies
      : !serverLogout,
  };
}

/**
 * 注入 API Token，用于 token 认证的站点。
 *
 * 同站多账号靠这个隔离：注入前先清掉上一个账号残留的键，
 * 否则两个账号的 token 会同时存在，站点按哪个算全凭运气。
 */
export function injectToken(site: SiteConfig, token: string, log: StepLog): boolean {
  const config = site.tokenConfig;
  if (!config) {
    log.push('站点未配置 Token 认证参数（tokenConfig）');
    return false;
  }

  const storage = config.storageType === 'sessionStorage' ? sessionStorage : localStorage;
  try {
    storage.setItem(config.storageKey, token);
    const place = config.storageType === 'sessionStorage' ? 'sessionStorage' : 'localStorage';
    log.push(`已注入 Token 到 ${place}.${config.storageKey}`);
    return true;
  } catch (error) {
    log.push(`Token 注入失败: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
