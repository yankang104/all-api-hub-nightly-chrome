/**
 * 站点类型探测。
 *
 * 解决的问题：`matchTemplateByName()` 只在 URL 字符串里找关键词，
 * 而白标站点的域名跟它跑的是什么系统毫无关系 —— 百倍
 * (`sub.100xlabs.space`) 跑的是 Sub2API，域名里一个字都没提，
 * 于是永远匹配不上模板，用户面对一堆要手填的 CSS 选择器。
 *
 * 这里改成按**后端行为**判断：不带凭据地 GET 一个受保护端点，
 * 只看它拒绝的方式。品牌文案能改，域名能换，但错误信封的形状改不了。
 *
 * 级联顺序即成本从低到高：
 *   1. hostname 白名单   —— 不发请求
 *   2. 免鉴权端点指纹     —— 每族一个 GET
 *   3. 首页 <title> 正则  —— 一个 GET，且要下整页 HTML
 *
 * ⚠️ 探测必须在 background 跑：content script 在别的源上会被 CORS 拦，
 * background 有 `<all_urls>` host permission 才能直接 fetch。
 */

import { SITE_TEMPLATES, type SiteTemplate } from '@/sites';
import { SITE_TYPES, type SiteConfig, type SiteType } from '@/types';
import { isBlockedFetchHost } from '@/lib/site/url-guard';

/** 单个端点探测的超时：站点没响应就跳到下一条判据，不能拖住添加站点的流程 */
const PROBE_TIMEOUT_MS = 6_000;

export interface ProbeResult {
  siteType: SiteType;
  /** 命中哪一步。给用户看「凭什么这么判」，判错时也便于排查 */
  evidence: string;
  /** 匹配到的模板预设，可直接套进站点表单 */
  preset?: Omit<SiteConfig, 'id' | 'name' | 'loginUrl'>;
  /** 模板显示名，如「Sub2API 系」 */
  templateLabel?: string;
  /** 命中的模板 id：管理页据此把登录地址归一到模板的真实登录页（如新版的 /sign-in）。 */
  templateId?: string;
}

const UNKNOWN_RESULT: ProbeResult = {
  siteType: SITE_TYPES.UNKNOWN,
  evidence: '未能识别站点系统，请手动确认选择器',
};

function resultFor(template: SiteTemplate, evidence: string): ProbeResult {
  return {
    siteType: template.siteType,
    evidence,
    preset: template.preset,
    templateLabel: template.label,
    templateId: template.id,
  };
}

/** 带超时的 GET。探测一律不带凭据 —— 判据是「它怎么拒绝匿名请求」 */
async function probeFetch(url: string): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'GET',
      // 关键：不带 cookie。带了就可能拿到已登录的 200，指纹全失效，
      // 而且等于替用户往站点发了一次带身份的请求。
      credentials: 'omit',
      cache: 'no-store',
      headers: { Accept: 'application/json, text/html' },
      signal: controller.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 第一步：域名白名单。命中就不用发任何请求 */
function byHostname(url: string): ProbeResult | null {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }

  for (const template of SITE_TEMPLATES) {
    const known = template.fingerprints.hostnames ?? [];
    if (known.some((candidate) => candidate.toLowerCase() === hostname)) {
      return resultFor(template, `域名 ${hostname} 是已知的${template.label}站点`);
    }
  }
  return null;
}

/**
 * 第二步：免鉴权端点指纹 —— 主力判据。
 *
 * 每族探一个受保护端点。只认 JSON：SPA 常把未命中的路径兜底成 index.html
 * （状态 200 但内容是 HTML），不看 content-type 就会把任何站点的 404 页
 * 当成 JSON 去解析。
 */
async function byEndpoint(url: string): Promise<ProbeResult | null> {
  for (const template of SITE_TEMPLATES) {
    const fingerprint = template.fingerprints.endpoint;
    if (!fingerprint) continue;

    let target: string;
    try {
      target = new URL(fingerprint.path, url).href;
    } catch {
      continue;
    }

    const response = await probeFetch(target);
    if (!response) continue;

    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.includes('json')) continue;

    const body = await response.json().catch(() => null);
    if (body === null) continue;

    if (fingerprint.match(body)) {
      // 后端都是 new-api：再分一次前端是哪一代，两代的登录页与签到页地址完全不同。
      if (template.id === 'new-api') {
        const next = await newApiNextByRoutes(url);
        if (next) return next;
      }
      return resultFor(template, `${fingerprint.path} 的响应形状符合${template.label}`);
    }
  }
  return null;
}

/** 页面 HTML 里是否带着账密输入框（只看静态 HTML，不执行脚本）。 */
function htmlHasLoginInputs(html: string): boolean {
  return /<input[^>]+type=["']?password/i.test(html) || /<input[^>]+name=["']?(?:username|email)\b/i.test(html);
}

/**
 * 新旧两代 new-api 前端的区分：后端接口一样，**路由**不一样。
 *
 * 新版 React 界面没有 `/login` 这条路由（SPA 兜底成 404 页），登录页是 `/sign-in`、
 * 签到在 `/profile`；旧版（semi-ui）登录页是 `/login`、签到在 `/console/personal`。
 * 套错预设的后果是两步全断：登录页找不到输入框，登录后又被带到 404 页。
 *
 * 判据只用**静态 HTML**与「哪条路由被服务端认」：
 * - `/sign-in` 的 HTML 能拿到、且不像 404 → 新版的强信号；
 * - `/login` 正好是 404（新版没有这条路由）→ 进一步确认。
 * 两条都要成立才判新版；拿不准就维持旧版判断（行为与以前一致）。
 */
async function newApiNextByRoutes(url: string): Promise<ProbeResult | null> {
  const nextTemplate = SITE_TEMPLATES.find((item) => item.id === 'new-api-next');
  if (!nextTemplate) return null;
  let signIn: string;
  let login: string;
  try {
    signIn = new URL('/sign-in', url).href;
    login = new URL('/login', url).href;
  } catch {
    return null;
  }
  const [signInResponse, loginResponse] = await Promise.all([probeFetch(signIn), probeFetch(login)]);
  if (!signInResponse?.ok) return null;
  const signInHtml = await signInResponse.text().catch(() => '');
  const looksMissing = (html: string) => /\b404\b|not\s*found|页面不存在|找不到页面/i.test(html.slice(0, 20_000));
  if (looksMissing(signInHtml)) return null;
  const loginMissing = !loginResponse
    || loginResponse.status === 404
    || (loginResponse.ok && looksMissing(await loginResponse.text().catch(() => '')) && !htmlHasLoginInputs(signInHtml));
  if (!loginMissing) return null;
  return resultFor(nextTemplate, `/api/user/self 符合 new-api 系，且站点使用 /sign-in 登录、没有 /login 路由（新版界面）`);
}

/**
 * 第三步：首页标题。
 *
 * 读原始 HTML 里的 `<title>` 而不是渲染后的 document.title ——
 * SPA 挂载后常把标题改成当前路由名，原始标题才带品牌。
 * 这条最弱（改个标题就失效），所以垫在最后。
 */
async function byTitle(url: string): Promise<ProbeResult | null> {
  let root: string;
  try {
    root = new URL('/', url).href;
  } catch {
    return null;
  }

  const response = await probeFetch(root);
  if (!response || !response.ok) return null;

  const html = await response.text().catch(() => '');
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim().toLowerCase();
  if (!title) return null;

  for (const template of SITE_TEMPLATES) {
    for (const word of template.fingerprints.titleWords ?? []) {
      if (title.includes(word.toLowerCase())) {
        return resultFor(template, `首页标题「${title.slice(0, 40)}」含「${word}」`);
      }
    }
  }
  return null;
}

/**
 * 探测站点跑的是什么系统。
 *
 * 全部判据都不中时返回 UNKNOWN 而不是瞎猜 —— 猜错的代价是用户拿到一套
 * 错的选择器，比让他手填更糟（他会以为配好了）。
 *
 * @param url 站点的任意页面地址（通常是用户填的登录页）
 */
export async function probeSite(url: string): Promise<ProbeResult> {
  if (!url.trim()) return UNKNOWN_RESULT;

  // SSRF 闸门：探测跑在 background（带 <all_urls>），会向用户填的任意地址发 GET。
  // 能解析出 http(s) 主机且指向本机/内网时直接拒绝，别让页面借扩展扫内网、读云
  // 元数据；拦不住 DNS-rebinding（见 url-guard）。非法/非 http(s) 地址仍走下面的
  // 判据兜到 UNKNOWN，行为不变。
  try {
    const parsed = new URL(url.trim());
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && isBlockedFetchHost(parsed.hostname)) {
      return { siteType: SITE_TYPES.UNKNOWN, evidence: '目标地址指向本机或内网，已拒绝' };
    }
  } catch {
    // 解析失败交给下面的判据，各步各自 new URL 会再报错并安静兜到 UNKNOWN
  }

  const cheap = byHostname(url);
  if (cheap) return cheap;

  const byShape = await byEndpoint(url);
  if (byShape) return byShape;

  const byBrand = await byTitle(url);
  if (byBrand) return byBrand;

  return UNKNOWN_RESULT;
}
