/**
 * 后台 API 直连签到 —— 不开标签页就把签到做完。
 *
 * 为什么可行：Chrome 官方文档（Storage and cookies）明确说
 *
 *   "Requests from an extension to a third-party are treated as same-site
 *    if the extension has host permissions for the third-party."
 *
 * 本扩展的 manifest 有 `host_permissions: ['<all_urls>']`，所以 service worker
 * 里的 `fetch(url, {credentials:'include'})` 会带上站点 cookie，连
 * `SameSite=Strict` 的也带。这是整条快路径的地基。
 *
 * 文档同时给了两条限制，都已处理：
 *  1. 只对网络请求生效，`document.cookie` 不适用 —— 我们只发请求。
 *  2. **用户禁用第三方 cookie 时失效** —— 表现为 401，走 auth-expired 回退。
 *
 * ⚠️ 这个模块是一次**机会主义尝试**，不是新的签到方式。写请求发出前的
 * 不确定会让位给浏览器自动化；写请求发出后的不确定必须停止自动重试并如实
 * 报错。这样既不会产生假成功记录，也不会把一次签到重复提交。
 */

import { ADAPTER_FAMILIES, type Account, type AdapterFamily, type BalanceSnapshot, type CheckinMetrics, type SiteConfig } from '@/types';
import { diffBalance, extractBalance } from '@/automation/balance/balance';
import { ALREADY_WORDS, SUCCESS_WORDS } from '@/automation/checkin/checkin-vocab';
import { buildUserIdHeaders } from '@/lib/site/compat-headers';
import { isSameSiteUrl } from '@/lib/site/site-security';
import { resolveSiteAdapter } from '@/automation/sites/site-adapters';
import { isLearnedLoginAsCheckin, usesCheckinWorkflow } from '@/lib/checkin/learned-checkin';
import {
  type CheckinStatsReading,
  type ResolvedEndpoints,
  checkinStatusMonth,
  readCheckinResponse,
  readCheckinStats,
  resolveCheckinEndpoints,
  rewardFromStats,
} from '@/lib/checkin/checkin-endpoints';
import type { EligibilitySignal } from '@/lib/checkin/headless-eligibility';

/** 单个请求的超时。比 balance.ts 的 4 秒宽一点：签到接口可能要写库。 */
const REQUEST_TIMEOUT_MS = 8_000;
/** 整条直连的总上限。超了就让位浏览器，别让用户干等。 */
const TOTAL_BUDGET_MS = 25_000;
/** 签到后等到账再查余额。站点写库和发额度可能有延迟。 */
const SETTLE_DELAY_MS = 1_200;

export type HeadlessVerdict =
  /** 签到成功，且余额差分确认额度到账 */
  | 'confirmed'
  /** 今日已签到 */
  | 'already'
  /** 响应与余额对不上，不敢下结论 */
  | 'inconclusive'
  /** 签到请求可能已生效，但只读证据无法确认；禁止再用浏览器提交 */
  | 'write-unverified'
  /** 登录态失效 */
  | 'auth-expired'
  /** 站点没有可用的签到接口 */
  | 'unsupported'
  /** 网络错误或超时 */
  | 'error';

export interface HeadlessOutcome {
  verdict: HeadlessVerdict;
  message: string;
  /** 过程日志，会并入 TaskResult.steps 让用户看到直连做了什么 */
  steps: string[];
  metrics?: CheckinMetrics;
  /**
   * 直连读到的最新余额，供调用方落进 `KEYS.balances`。
   *
   * 必须单独交出来，不能让调用方从 `metrics.quotaAfter` 里凑：那是签到的
   * **过程量**，只在一次签到内有意义，而界面上的余额是**账号状态**、
   * 跨签到存活（见 types/balance.ts）。少了这一路，直连成功的账号会在
   * 站点卡片上显示「本站余额 未获取」—— 因为 sumBalances 只认独立存储。
   */
  balance?: BalanceSnapshot;
}

/** 只有这两种结局可以跳过浏览器 */
export function isHeadlessSuccess(verdict: HeadlessVerdict): boolean {
  return verdict === 'confirmed' || verdict === 'already';
}

/** 写请求可能已经生效时，浏览器不得再次执行签到动作。 */
export function isHeadlessBrowserFallbackSafe(verdict: HeadlessVerdict): boolean {
  return verdict !== 'write-unverified';
}

/** 判定 → 熔断信号 */
export function eligibilitySignalOf(verdict: HeadlessVerdict): EligibilitySignal {
  if (isHeadlessSuccess(verdict)) return 'success';
  if (verdict === 'unsupported') return 'unsupported';
  if (verdict === 'auth-expired') return 'auth-expired';
  if (verdict === 'inconclusive' || verdict === 'write-unverified') return 'inconclusive';
  return 'error';
}

/** 便于测试替换的依赖 */
export interface HeadlessDeps {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: HeadlessDeps = {
  fetch: (...args) => fetch(...args),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * 构造认证头。
 *
 * 两族的认证方式同时带上，与 `balance.ts` 的 `balanceAuthHeaders` 同一思路：
 * 服务端只认自己那套，多带的会被忽略，一次调用兼容全家。区别是这里的值
 * 不能从 localStorage 读（service worker 没有那个上下文），只能来自
 * `account.identity` —— 这正是「先在浏览器里登录一次」的价值所在。
 */
export function buildHeadlessHeaders(
  account: Pick<Account, 'identity' | 'apiToken'>,
  site: Pick<SiteConfig, 'adapter' | 'tokenConfig'>,
  auth: ResolvedEndpoints['auth'],
): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };

  // new-api 系：user-id 兼容头。账号身份优先于站点级配置 ——
  // 同站多账号时站点上那个 id 只可能对其中一个账号是对的。
  const userId = account.identity?.userId ?? site.adapter?.userId;
  Object.assign(headers, buildUserIdHeaders(userId));

  // Sub2API / VoAPI v2：Bearer token。手贴的 apiToken 作为兜底 ——
  // 抓来的会话更可靠（会随刷新更新），手贴的容易过期。
  const token = account.identity?.session?.accessToken?.trim() || account.apiToken?.trim();
  if (token) {
    const prefix = site.tokenConfig?.headerPrefix ?? 'Bearer ';
    const name = site.tokenConfig?.headerName ?? 'Authorization';
    headers[name] = `${prefix}${token}`;
  } else if (auth === 'bearer') {
    // 这一族只认 Bearer，而我们没有 token —— 调用方据此直接判 auth-expired，
    // 不必白发一个必然 401 的请求。
    headers.__missingBearer = '1';
  }

  return headers;
}

/** accessToken 已过期时不必尝试：必然 401，白跑一趟 */
export function isCapturedTokenExpired(
  account: Pick<Account, 'identity'>,
  now: number,
): boolean {
  const expiresAt = account.identity?.session?.tokenExpiresAt;
  if (!expiresAt) return false;
  // 留 30 秒余量：正好卡在到期边缘的 token 发出去也是 401
  return now >= expiresAt - 30_000;
}

/** 带超时的请求。失败与超时都返回 null 而不抛，由调用方按判定矩阵处理。 */
async function request(
  deps: HeadlessDeps,
  url: string,
  init: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<{ status: number; contentType: string; body: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await deps.fetch(url, {
      ...init,
      credentials: 'include',
      // 重定向往往意味着被踢去登录页。跟过去只会拿到 HTML，
      // 不如直接失败，让判定逻辑看到真相。
      redirect: 'error',
      signal: controller.signal,
    });
    const body = (await response.text()).slice(0, 4_000);
    return {
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      body,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 采一次余额快照。
 *
 * 与 content script 里的 `captureBalance` 同语义，但不能复用它 ——
 * 那个函数用 `location.origin` 拼地址、失败时回退读 `document.body`。
 * 这里按 `site.loginUrl` 拼，且没有页面可回退。
 */
async function snapshot(
  deps: HeadlessDeps,
  site: SiteConfig,
  endpoints: readonly string[],
  headers: Record<string, string>,
): Promise<BalanceSnapshot | null> {
  for (const path of endpoints) {
    const url = absoluteUrl(site, path);
    if (!url) continue;

    const response = await request(deps, url, { method: 'GET', headers }, 4_000);
    if (!response || response.status !== 200) continue;
    // SPA 把未命中路径兜底成 index.html 时，status 是 200 但内容是 HTML
    if (!response.contentType.toLowerCase().includes('json')) continue;

    let payload: unknown;
    try {
      payload = JSON.parse(response.body);
    } catch {
      continue;
    }
    const raw = extractBalance(payload);
    if (raw) {
      return {
        quota: raw.quota,
        usedQuota: raw.usedQuota,
        ...(raw.symbol ? { symbol: raw.symbol } : {}),
        at: deps.now(),
      };
    }
  }
  return null;
}

/**
 * 把端点路径解析成绝对地址，并卡同源。
 *
 * 这道闸与现有 `checkinByApi` 同一处考虑：配置可能被改成往外部地址发
 * 带 cookie 的请求，那等于把站点登录态泄露给第三方。
 */
function absoluteUrl(site: SiteConfig, path: string): string | null {
  try {
    const url = new URL(path, site.loginUrl).href;
    return isSameSiteUrl(site, url) ? url : null;
  } catch {
    return null;
  }
}

/**
 * new-api 的标准 `/api/user/checkin` 明确定义了 GET + month 台账查询。
 * 显式配置的其它 POST 地址不能照搬这条约定：有些服务端不区分方法，GET
 * 同样会执行签到，把所谓“预检”变成第一次写入。
 */
function supportsStatsProbe(
  family: AdapterFamily,
  site: SiteConfig,
  endpoints: ResolvedEndpoints,
  path: string,
): boolean {
  if (endpoints.method !== 'POST') return false;
  if (family !== ADAPTER_FAMILIES.NEW_API && family !== ADAPTER_FAMILIES.VO_API_V2) return false;

  const url = absoluteUrl(site, path);
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.pathname.replace(/\/+$/, '') === '/api/user/checkin'
      && parsed.search === '';
  } catch {
    return false;
  }
}

/**
 * 探一次签到台账（`GET {签到端点}?month=YYYY-MM`）。
 *
 * 读不到就返回 null，绝不致命 —— 台账是加分项，缺了就退回余额差分那条老路。
 *
 * ⚠️ 只对 POST 签到的站点调用。GET 签到的站点上这一发就把签到做了，
 * 由调用方用 `endpoints.method !== 'GET'` 卡住。
 */
async function probeStats(
  deps: HeadlessDeps,
  site: SiteConfig,
  path: string,
  headers: Record<string, string>,
  month: string,
): Promise<CheckinStatsReading | null> {
  const base = absoluteUrl(site, path);
  if (!base) return null;

  let url: string;
  try {
    const parsed = new URL(base);
    parsed.searchParams.set('month', month);
    url = parsed.href;
  } catch {
    return null;
  }

  const response = await request(deps, url, { method: 'GET', headers }, 4_000);
  if (!response) return null;
  return readCheckinStats(response.status, response.contentType, response.body);
}

function vocab(site: SiteConfig): { success: string[]; already: string[] } {
  return {
    success: site.checkin?.successText?.length ? site.checkin.successText : SUCCESS_WORDS,
    already: site.checkin?.alreadyText?.length ? site.checkin.alreadyText : ALREADY_WORDS,
  };
}

/**
 * 尝试直连签到。
 *
 * 判定矩阵（见 .claude/plans/headless-api-checkin.md）：
 *
 * | 响应 | 余额差分 | 判定 |
 * |---|---|---|
 * | 声称成功 | rewarded | confirmed —— 跳过浏览器 |
 * | 声称已签 | unchanged/already-used | already —— 跳过浏览器 |
 * | 声称成功 | unchanged | write-unverified —— 不重试（可能已生效） |
 * | 声称成功 | unknown（读不到） | 写前跳过；写后失败则 write-unverified |
 * | 401/403 | — | auth-expired —— 回退 |
 * | 404/HTML | — | unsupported —— 回退并计熔断 |
 * | 写前网络错误 | — | inconclusive —— 回退，不计熔断 |
 * | 写请求响应丢失 | — | write-unverified —— 不重试 |
 */
export async function tryHeadlessCheckin(
  account: Account,
  site: SiteConfig,
  deps: HeadlessDeps = defaultDeps,
): Promise<HeadlessOutcome> {
  const steps: string[] = [];
  if (usesCheckinWorkflow(site)) {
    return {
      verdict: 'inconclusive',
      message: '本站已保存签到流程，完成登录后由浏览器回放，不使用接口签到替代',
      steps,
    };
  }
  // 学到的登录即签到：奖励由登录动作触发，签到接口无论成败都不能代表它。
  if (isLearnedLoginAsCheckin(site)) {
    return {
      verdict: 'inconclusive',
      message: '本站已学会「登录即签到」，由浏览器完成登录后确认，不使用接口签到替代',
      steps,
    };
  }
  const deadline = deps.now() + TOTAL_BUDGET_MS;
  const family: AdapterFamily = resolveSiteAdapter(site).family;

  const endpoints = resolveCheckinEndpoints(
    family,
    site.checkin?.apiUrl,
    site.checkin?.apiMethod,
  );
  if (!endpoints) {
    return {
      verdict: 'unsupported',
      message: '站点类型未知且未配置签到接口地址，无法直连',
      steps,
    };
  }

  if (!endpoints.checkin.some((path) => absoluteUrl(site, path))) {
    return {
      verdict: 'unsupported',
      message: '站点没有可安全访问的同源签到接口',
      steps,
    };
  }

  const headers = buildHeadlessHeaders(account, site, endpoints.auth);
  if (headers.__missingBearer) {
    delete headers.__missingBearer;
    return {
      verdict: 'auth-expired',
      message: '该站点需要 Bearer 令牌，但账号还没有抓取过登录态',
      steps,
    };
  }
  if (isCapturedTokenExpired(account, deps.now())) {
    return {
      verdict: 'auth-expired',
      message: '抓取的访问令牌已过期，需要重新登录',
      steps,
    };
  }

  steps.push(`尝试 API 直连签到（${endpoints.explicit ? '站点配置的接口' : `${family} 家族默认接口`}）`);

  // 台账探测只限协议明确保证 GET 为只读查询的标准端点。任意自定义 POST
  // 地址都不能通过“换成 GET”来探测，否则预检本身就可能完成一次签到。
  const month = checkinStatusMonth(deps.now());
  const primary = endpoints.checkin[0];
  const canProbe = !!primary && supportsStatsProbe(family, site, endpoints, primary);
  const statsBefore = canProbe && primary
    ? await probeStats(deps, site, primary, headers, month)
    : null;

  if (statsBefore) {
    steps.push(`已读到站点签到台账（本月 ${statsBefore.records.length} 条记录）`);
    if (!statsBefore.enabled) {
      // 站点自己说签到关着。POST 过去只会被拒，页面上也不会有按钮。
      return { verdict: 'unsupported', message: '站点已关闭签到功能', steps };
    }
    if (statsBefore.checkedInToday) {
      // 台账说今天签过了。这是比任何文案都硬的证据，不必再发写请求 ——
      // 也不会因为「已签」响应的措辞差异判错。
      steps.push('台账显示今日已签到，无需再发签到请求');
      // 但余额还是要读：这条路直接收工、不开标签页，界面上的余额只能靠
      // 这一次采集。省掉它就会出现「今日已签到」配「本站余额 未获取」。
      const current = await snapshot(deps, site, endpoints.balance, headers);
      if (current) steps.push('已采集当前额度');
      return {
        verdict: 'already',
        message: '站点台账显示今日已签到',
        steps,
        ...(current ? { balance: current } : {}),
      };
    }
  }

  // 签到前的余额。读不到不致命 —— 台账能给出实得额度时它就是多余的，
  // 台账也读不到时差分退化成 unknown，响应即使声称成功也判 inconclusive 回退。
  const before = await snapshot(deps, site, endpoints.balance, headers);
  if (before) {
    steps.push('已采集签到前额度快照');
  } else {
    steps.push('读不到签到前额度，本次无法用守恒差分确认结果');
  }

  // 没有任一份写前只读证据，就不可能在写后证明“这次请求确实生效”。
  // 必须在这里让位；先写再回退浏览器会把同一次签到提交两遍。
  if (!statsBefore && !before) {
    steps.push('缺少可用的只读验证通道，已在发送签到请求前停止直连');
    return {
      verdict: 'inconclusive',
      message: '直连缺少可用的只读验证通道，改用浏览器签到',
      steps,
    };
  }

  const postHeaders = { ...headers };
  const body = site.checkin?.apiBody;
  if (body && endpoints.method !== 'GET') postHeaders['Content-Type'] = 'application/json';

  let lastReading: { verdict: string; message: string } | null = null;

  for (const path of endpoints.checkin) {
    if (deps.now() > deadline) {
      return { verdict: 'error', message: '直连超出时间预算，改用浏览器签到', steps, ...(before ? {} : {}) };
    }
    const url = absoluteUrl(site, path);
    if (!url) {
      steps.push(`跳过非本站签到地址 ${path}`);
      continue;
    }

    const response = await request(deps, url, {
      method: endpoints.method,
      headers: postHeaders,
      body: endpoints.method === 'GET' ? undefined : (body ?? undefined),
    });

    if (!response) {
      // fetch 抛错或超时时无法判断请求是在发送前失败，还是服务端写入后响应
      // 丢失。按后者保守处理，绝不能再让浏览器提交一次。
      steps.push('签到接口请求失败或超时');
      steps.push('写请求可能已到达站点，为避免重复签到不再自动重试');
      return {
        verdict: 'write-unverified',
        message: '签到请求已发出但未收到可验证响应；为避免重复签到，未再自动重试',
        steps,
      };
    }

    const reading = readCheckinResponse(
      response.status,
      response.contentType,
      response.body,
      vocab(site),
    );
    lastReading = reading;
    steps.push(`签到接口返回 HTTP ${response.status}：${reading.message}`);

    if (reading.verdict === 'auth-expired') {
      return { verdict: 'auth-expired', message: reading.message, steps };
    }
    if (reading.verdict === 'unsupported') {
      // 还有别的候选端点就继续试
      continue;
    }
    if (reading.verdict === 'claims-failure') {
      // 站点明确拒绝。这不是「接口不存在」，交给浏览器流程看看页面上
      // 是否有别的入口，但不计熔断。
      return { verdict: 'inconclusive', message: reading.message, steps };
    }

    // 到这里响应声称成功或已签，用台账和余额差分验证。
    // 台账只在探到过 before 的那个端点上复查 —— 拿别的端点的台账去比对没有意义。
    const recheck = canProbe && statsBefore && path === primary
      ? () => probeStats(deps, site, primary, headers, month)
      : null;
    return verify(deps, account, site, endpoints, headers, before, statsBefore, recheck, reading, steps);
  }

  return {
    verdict: 'unsupported',
    message: lastReading?.message ?? '站点没有可用的签到接口',
    steps,
  };
}

/** 对声称成功的响应补做台账复查与余额差分 */
async function verify(
  deps: HeadlessDeps,
  _account: Account,
  site: SiteConfig,
  endpoints: ResolvedEndpoints,
  headers: Record<string, string>,
  before: { quota: number; usedQuota: number; at: number } | null,
  statsBefore: CheckinStatsReading | null,
  recheckStats: (() => Promise<CheckinStatsReading | null>) | null,
  reading: { verdict: string; message: string },
  steps: string[],
): Promise<HeadlessOutcome> {
  // 响应说「已签」本来就没有新奖励，差分只需要确认它没有异常。
  // 仍采 after：如果 after 里发现总额度增加，说明站点实际发了奖励，
  // 也可以记作 confirmed；如果不变则是正常的 already。
  await deps.sleep(SETTLE_DELAY_MS);

  // 台账优先。它给的是站点落库的实得额度，不受采样时机影响。
  const statsAfter = recheckStats ? await recheckStats() : null;
  const statsReward = rewardFromStats(statsBefore, statsAfter);
  if (statsReward != null) {
    steps.push('签到台账已记入本次奖励');
  }

  const after = await snapshot(deps, site, endpoints.balance, headers);
  if (after) steps.push('已采集签到后额度快照');
  else steps.push('读不到签到后额度快照');

  /**
   * 给每条出口都挂上这次读到的余额。
   *
   * 统一在这里挂而不是逐个 return 里写：下面有六条出口，漏一条就是一个
   * 「签到成功但余额未获取」的洞，而这种洞在界面上要等用户截图才看得见。
   */
  const withBalance = (outcome: HeadlessOutcome): HeadlessOutcome => (
    after ? { ...outcome, balance: after } : outcome
  );

  // 台账认账就是终局，不必再让差分表决 —— 差分说「无变化」时它是错的那一方：
  // 签到期间的消耗和 SPA 刷新滞后都会让它读不出增量，而台账已经落库。
  if (statsReward != null) {
    const metrics: CheckinMetrics = {
      ...diffBalance(before ?? undefined, after ?? undefined),
      reward: statsReward,
      verdict: 'rewarded',
      ...(after ? { quotaAfter: after.quota } : {}),
      ...(after?.symbol ? { balanceSymbol: after.symbol } : {}),
    };
    return withBalance({ verdict: 'confirmed', message: reading.message, steps, metrics });
  }

  if (reading.verdict === 'claims-already') {
    if (before && after) {
      const metrics = diffBalance(before, after);
      steps.push(`额度差分：${metrics.verdict}`);
      return withBalance({
        verdict: metrics.verdict === 'rewarded' ? 'confirmed' : 'already',
        message: reading.message,
        steps,
        metrics,
      });
    }
    // 已签响应本身就是足够强的「今天不需要再签」证据。
    // 这里没有余额不是假成功风险：它没有声称新奖励。
    return withBalance({ verdict: 'already', message: reading.message, steps });
  }

  // 台账没给出金额，但翻牌了：签到前它说没签、签到后说签了。
  // 能走到这里说明 statsBefore 存在且 checkedInToday 为假（否则前面已经收工），
  // 所以这个翻牌只可能是本次造成的 —— 这比余额差分硬，足以判 confirmed。
  // 台账没吐出新记录的站点（records 为空但翻了牌）就走这条。
  if (statsAfter?.checkedInToday && !statsBefore?.checkedInToday) {
    steps.push('台账已从未签到翻为已签到');
    // 差分自己就能看出增量时用它的完整结论；否则只留余额，
    // 金额记成 unknown 而不是 0 —— 「不知道发了多少」和「发了 0」是两件事，
    // 后者会让界面显示「签到获得 $0.00」。
    const diff = before && after ? diffBalance(before, after) : null;
    const metrics: CheckinMetrics | null = diff?.verdict === 'rewarded'
      ? diff
      : after
        ? {
            verdict: 'unknown',
            quotaAfter: after.quota,
            ...(after.symbol ? { balanceSymbol: after.symbol } : {}),
          }
        : null;
    return withBalance({
      verdict: 'confirmed',
      message: reading.message,
      steps,
      ...(metrics ? { metrics } : {}),
    });
  }

  // 声称成功必须有两份证据：没有 before 或 after 都不通过。此时写请求
  // 已经发出，不能再回退浏览器执行第二次签到。
  if (!before || !after) {
    steps.push('写请求已发出但验证证据不完整，为避免重复签到不再自动重试');
    return withBalance({
      verdict: 'write-unverified',
      message: '接口声称成功但无法取得完整额度差分；为避免重复签到，未再自动重试',
      steps,
    });
  }

  const metrics = diffBalance(before, after);
  steps.push(`额度差分：${metrics.verdict}`);
  if (metrics.verdict === 'rewarded') {
    return withBalance({ verdict: 'confirmed', message: reading.message, steps, metrics });
  }

  // unchanged / already-used 都不够证明这次接口确实发了奖励：
  // already-used 可能来自期间消耗，也可能是站点接口的假成功。
  steps.push('写请求已发出但额度未增加，为避免重复签到不再自动重试');
  return withBalance({
    verdict: 'write-unverified',
    message: '接口声称成功但额度未增加；为避免重复签到，未再自动重试',
    steps,
    metrics,
  });
}
