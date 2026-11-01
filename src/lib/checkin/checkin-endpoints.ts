/**
 * 签到与余额端点目录，以及签到响应的结构化解读。
 *
 * 为什么需要这份目录：后台 API 直连没有页面可以点，必须**事先知道**往哪个
 * 地址发请求。而内置站点里无一填了 `checkin.apiUrl`（实测：auto×5、button×2、
 * relogin×1、none×1、claim×1，apiUrl 全空），所以只能按家族给出候选端点。
 *
 * 这与 `balance.ts` 里已有的 `NEW_API_ENDPOINTS` / `SUB2API_ENDPOINTS` 同源，
 * 区别是那份只服务余额、且写死在 content script 里。这里把签到端点一起纳入，
 * 并做成纯数据 + 纯函数，让 background 也能用、也能单测。
 *
 * ⚠️ 本模块只做「选地址」和「读响应」，不发请求 —— 保持可测性。
 */

import { ADAPTER_FAMILIES, type AdapterFamily } from '@/types';

/** 一个家族在协议层怎么认证 */
export type HeadlessAuthKind =
  /** new-api 系：user-id 兼容头 + 浏览器 cookie */
  | 'userIdHeaders'
  /** Sub2API 系：Authorization: Bearer <抓来的 accessToken> */
  | 'bearer';

export interface FamilyEndpoints {
  /** 候选签到端点，按可能性排序 */
  checkin: readonly string[];
  /** 候选余额端点，用于守恒差分 */
  balance: readonly string[];
  auth: HeadlessAuthKind;
  /** 签到请求方法，默认 POST */
  method?: 'GET' | 'POST';
}

/**
 * new-api 系（含 Veloera / V-API / VoAPI / Super-API / Rix / Neo 等分叉）。
 *
 * 端点来自 `identity.ts` 与 `balance.ts` 已实测可用的路径。签到统一是
 * `POST /api/user/checkin`；余额沿用余额模块的顺序。
 */
const NEW_API_ENDPOINTS: FamilyEndpoints = {
  /*
   * 分叉之间签到端点并不统一，按已实测的命名依次尝试。
   *
   * 多列几条的代价只是「不支持的站点多发两个 404」，而漏掉一条的代价大得多：
   * 直连必然失败 → 判定「站点不支持」→ 连续三次熔断 24 小时 → 之后每天都被迫
   * 开标签页走浏览器，撞上登录页的 Turnstile 和签到后的滑块。
   *
   * 站点配置里显式写了 `checkin.apiUrl` 时优先用它，这张表只是家族兜底。
   */
  checkin: [
    '/api/user/checkin',
    '/api/user/check_in',
    '/api/user/clock_in',
    '/api/user/daily_checkin',
    '/api/user/sign_in',
  ],
  balance: ['/api/user/self', '/api/user/info'],
  auth: 'userIdHeaders',
  method: 'POST',
};

/**
 * Sub2API 系。
 *
 * `/api/v1/check-in` 是单步签到。赞助签到（`tbe-sponsor-checkin` 的
 * begin → 等 wait_seconds → claim）**刻意不列入**：在后台睡十几秒还要处理
 * 409 重试，收益不抵复杂度，那条路让它回退浏览器。
 */
const SUB2API_ENDPOINTS: FamilyEndpoints = {
  checkin: ['/api/v1/check-in'],
  balance: ['/api/v1/check-in/status', '/api/v1/auth/me'],
  auth: 'bearer',
  method: 'POST',
};

const FAMILY_ENDPOINTS: Record<AdapterFamily, FamilyEndpoints | null> = {
  [ADAPTER_FAMILIES.NEW_API]: NEW_API_ENDPOINTS,
  [ADAPTER_FAMILIES.SUB2API]: SUB2API_ENDPOINTS,
  // VoAPI v2 的会话在 localStorage 的 userStore.auth.token 里，协议上属
  // new-api 系（同样是 /api/user/checkin），但认证走 Bearer。
  [ADAPTER_FAMILIES.VO_API_V2]: {
    checkin: ['/api/user/checkin'],
    balance: ['/api/user/self', '/api/user/info'],
    auth: 'bearer',
    method: 'POST',
  },
  [ADAPTER_FAMILIES.UNSUPPORTED]: null,
};

export interface ResolvedEndpoints {
  checkin: readonly string[];
  balance: readonly string[];
  auth: HeadlessAuthKind;
  method: 'GET' | 'POST';
  /** 站点显式配了 apiUrl 时为 true，此时 checkin 只有那一个地址 */
  explicit: boolean;
}

/**
 * 决定这次直连要打哪些地址。
 *
 * 站点显式配的 `checkin.apiUrl` 优先于家族目录 —— 用户或预设明确指定了，
 * 就不该再拿一堆猜测的路径去试。家族未知时两族端点都试一遍（都是幂等的
 * GET 加一个签到 POST，多试一次的代价可接受），与 `balance.ts` 里
 * `endpointsFor` 对未知家族的处理保持一致。
 */
export function resolveCheckinEndpoints(
  family: AdapterFamily,
  explicitApiUrl?: string,
  explicitMethod?: 'GET' | 'POST',
): ResolvedEndpoints | null {
  const known = FAMILY_ENDPOINTS[family];

  if (explicitApiUrl?.trim()) {
    // 认证方式仍按家族判断：地址是用户给的，认证协议不是。
    // 家族未知时默认两套头都带（bearer 与 user-id 头互不冲突，
    // 服务端只认自己那套），所以退到 userIdHeaders 并由调用方一并附上 Bearer。
    return {
      checkin: [explicitApiUrl.trim()],
      balance: known?.balance ?? [...NEW_API_ENDPOINTS.balance, ...SUB2API_ENDPOINTS.balance],
      auth: known?.auth ?? 'userIdHeaders',
      method: explicitMethod ?? known?.method ?? 'POST',
      explicit: true,
    };
  }

  if (known) {
    return {
      checkin: known.checkin,
      balance: known.balance,
      auth: known.auth,
      method: known.method ?? 'POST',
      explicit: false,
    };
  }

  // 家族不认识且没有显式地址 —— 不猜。直接判不支持，回退浏览器自动化，
  // 那条路有页面可看、有按钮可点，比在这里盲试更可能成功。
  return null;
}

/** 签到响应读出来的语义。刻意不含 'success' —— 见 readCheckinResponse。 */
export type ResponseVerdict =
  /** 响应明确说签到成功 */
  | 'claims-success'
  /** 响应明确说今天已经签过 */
  | 'claims-already'
  /** 响应明确说失败（success:false 等） */
  | 'claims-failure'
  /** 端点不存在或返回 HTML —— 这个站点没有这个接口 */
  | 'unsupported'
  /** 登录态无效 */
  | 'auth-expired'
  /** 有响应但读不出语义 */
  | 'unreadable';

export interface CheckinResponseReading {
  verdict: ResponseVerdict;
  /** 站点返回的文案，用于写进日志和结果 */
  message: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 站点把文案放在 message / msg / data.message / data.msg 里的都见过 */
function responseMessage(json: Record<string, unknown>): string {
  const data = asRecord(json.data);
  const value = json.message ?? json.msg ?? data?.message ?? data?.msg;
  return typeof value === 'string' ? value : '';
}

/** SPA 站点常把未命中的路径兜底返回 index.html，status 仍是 200 */
export function looksLikeHtml(contentType: string, body: string): boolean {
  const type = contentType.toLowerCase();
  const prefix = body.trimStart().slice(0, 512).toLowerCase();
  return type.includes('text/html')
    || type.includes('application/xhtml+xml')
    || /^<!doctype\s+html\b/.test(prefix)
    || /^<html\b/.test(prefix)
    || /<(?:head|body|form)\b/.test(prefix);
}

/**
 * 读一次签到响应，只回答「站点声称发生了什么」。
 *
 * ⚠️ 命名刻意用 `claims-success` 而不是 `success`：这个函数的输出**不是**
 * 最终判定。站点返回 200 + "签到成功" 却没有真的发额度是实际存在的情况
 * （见 checkin.ts 里守恒差分兜底那段注释）。最终判定必须由调用方结合
 * 余额差分给出，本函数只提供其中一半证据。
 *
 * 判断顺序遵循「结构优先于文案」：先看 success/code 这类结构字段，
 * 再看文案关键词。否则 `{"success":false,"message":"今日已签到"}`
 * 会被文案匹配抢先判成已签，而它其实是一次失败。
 */
export function readCheckinResponse(
  status: number,
  contentType: string,
  body: string,
  words: { success: string[]; already: string[] },
): CheckinResponseReading {
  if (status === 401 || status === 403) {
    return { verdict: 'auth-expired', message: `登录态无效（HTTP ${status}）` };
  }
  if (status === 404 || status === 405) {
    return { verdict: 'unsupported', message: `站点没有这个签到接口（HTTP ${status}）` };
  }

  if (looksLikeHtml(contentType, body)) {
    // 返回 HTML 有两种可能：路径不存在被 SPA 兜底，或被重定向到登录页。
    // 都不该在后台继续猜，交给浏览器流程看真实页面。
    return { verdict: 'unsupported', message: '接口返回 HTML 页面而非 JSON' };
  }

  let json: Record<string, unknown> | null = null;
  try {
    json = asRecord(JSON.parse(body));
  } catch {
    json = null;
  }

  if (!json) {
    if (status >= 400) return { verdict: 'unsupported', message: `接口返回 HTTP ${status}` };
    // 非 JSON 的纯文本响应，只能靠文案
    if (hitWords(body, words.already)) return { verdict: 'claims-already', message: '接口提示今日已签到' };
    if (hitWords(body, words.success)) return { verdict: 'claims-success', message: '接口返回签到成功' };
    return { verdict: 'unreadable', message: '响应不是 JSON 且无可识别文案' };
  }

  const data = asRecord(json.data);
  const message = responseMessage(json);

  // 结构化的失败信号最优先。HTTP 状态码也算结构信号。
  if (status >= 400 || json.success === false || data?.success === false) {
    // 失败文案里说「已签到」的，实质是已签而非故障（New API 就这么返回）
    if (hitWords(message, words.already)) {
      return { verdict: 'claims-already', message: message || '接口提示今日已签到' };
    }
    return { verdict: 'claims-failure', message: message || `接口返回失败（HTTP ${status}）` };
  }

  if (json.already === true || data?.already === true) {
    return { verdict: 'claims-already', message: message || '接口提示今日已签到' };
  }
  // 成功的结构信号里也可能带「已签到」文案，此时应判已签：
  // 它没有发新额度，若判成功会让守恒差分的 unchanged 被误解成假成功。
  if (hitWords(message, words.already)) {
    return { verdict: 'claims-already', message };
  }
  if (json.success === true || data?.success === true || json.code === 0 || json.ret === 1) {
    return { verdict: 'claims-success', message: message || '接口返回成功标志' };
  }
  if (hitWords(message, words.success)) {
    return { verdict: 'claims-success', message };
  }

  return { verdict: 'unreadable', message: message || '响应缺少可识别的成功或已签到标志' };
}

/** 与 checkin-vocab 的 hit 同语义。这里自带一份以免为一个函数拖进 DOM 模块。 */
function hitWords(text: string, words: string[]): boolean {
  const lower = text.toLowerCase();
  return words.some((word) => lower.includes(word.toLowerCase()));
}

/* ── 签到台账 ─────────────────────────────────────────────────────────────
 *
 * new-api 系的签到端点用 GET 带 `?month=YYYY-MM` 查的是**站点自己记的账**：
 * 哪天签过、那天发了多少。这比余额差分强一个量级 ——
 *
 *  - 差分只能算「总额度变多了多少」，签到期间的调用消耗要靠 usedQuota 抵掉，
 *    而 usedQuota 自己也在动，两次采样之间永远有一道缝；
 *  - 台账是服务端落库的结果，签到请求一返回就是终值，不受采样时机影响。
 *
 * 那道缝正是「页面提示签到成功」后面紧跟「额度无变化」的来源：采样窗口
 * 追不上 SPA 刷新。台账读到 quota_awarded 就没有窗口可追。
 *
 * ⚠️ 仍然保留差分：不是所有站点都开了这个接口（`enabled:false` 或压根没有
 * 这个端点），台账读不到时差分是唯一的成功证据。
 */

/** 台账里的一天 */
export interface CheckinRecord {
  /** 站点给的日期字符串，原样保留 —— 只用于比对，不做时区解释 */
  date: string;
  /** 那天实得额度，站点原始 quota 单位 */
  quotaAwarded: number;
}

export interface CheckinStatsReading {
  /** 站点是否开启了签到。false 时不必再 POST。 */
  enabled: boolean;
  /** 站点认为今天已经签过了 */
  checkedInToday: boolean;
  records: CheckinRecord[];
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * 查询用的月份参数。
 *
 * 用**本地时间**而不是 UTC：站点的「今天」按它自己的时区算，而用户的时区
 * 通常和站点一致（都在 +08）。UTC 会在每月最后一天的晚上偏到上个月去。
 *
 * 前后两次探测必须传同一个月份，否则台账没法直接比对 —— 由调用方算一次、
 * 两次都用同一个值来保证。
 */
export function checkinStatusMonth(now: number): string {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * 读一次签到台账。
 *
 * 返回 null 表示**这不是一个兼容的 new-api 签到站点** —— 判据是 `data.stats`
 * 在不在。这个判据来自站点侧的实际行为：开了签到的站点一定给 stats，
 * 没开的会返回 404 或 SPA 兜底的 HTML。
 *
 * ⚠️ 只在签到方法是 POST 时才可以调用。方法是 GET 的站点，这一次探测本身
 * 就会把签到做掉，那就不是探测而是副作用了。
 */
export function readCheckinStats(
  status: number,
  contentType: string,
  body: string,
): CheckinStatsReading | null {
  if (status !== 200) return null;
  if (looksLikeHtml(contentType, body)) return null;

  let json: Record<string, unknown> | null = null;
  try {
    json = asRecord(JSON.parse(body));
  } catch {
    return null;
  }
  if (!json) return null;

  const data = asRecord(json.data);
  const stats = asRecord(data?.stats);
  // 判据就在这里：没有 stats 就不是这个协议，别猜。
  if (!data || !stats) return null;

  const records: CheckinRecord[] = [];
  if (Array.isArray(stats.records)) {
    for (const entry of stats.records) {
      const record = asRecord(entry);
      if (!record) continue;
      const date = record.checkin_date ?? record.date;
      const quota = asNumber(record.quota_awarded ?? record.quota);
      if (typeof date !== 'string' || quota == null) continue;
      records.push({ date, quotaAwarded: quota });
    }
  }

  return {
    // 缺这个字段按「开着」处理：能返回 stats 说明接口是活的，
    // 而少数分叉不吐 enabled。判成关闭会白白回退浏览器。
    enabled: data.enabled !== false,
    checkedInToday: stats.checked_in_today === true,
    records,
  };
}

/**
 * 从签到前后的台账里取出**本次**实得额度。
 *
 * 靠「多出来的那条记录」认本次，而不是拿本地日期去匹配 `checkin_date` ——
 * 站点的日界线未必是本地的日界线，跨时区匹配会在午夜前后错一天。
 * 前后差集不依赖任何时区解释。
 *
 * 返回 null 表示台账没能给出答案（没有新记录、或者读不到台账），
 * 此时调用方必须回到余额差分。
 */
export function rewardFromStats(
  before: CheckinStatsReading | null,
  after: CheckinStatsReading | null,
): number | null {
  // 两份都得有。缺了 before 就无从判断哪条记录是新的 —— 整月的记录都会被
  // 算成本次所得，那是个虚高一个量级的数字，比读不到更糟。
  if (!before || !after) return null;

  const seen = new Set(before.records.map((record) => record.date));
  const fresh = after.records.filter((record) => !seen.has(record.date));
  if (fresh.length === 0) return null;

  // 正常只会多一条。多于一条时取总和 —— 站点补发历史记录的情况下，
  // 「这次调用导致台账多了多少」仍然是诚实的答案。
  const reward = fresh.reduce((sum, record) => sum + record.quotaAwarded, 0);
  return reward > 0 ? reward : null;
}
