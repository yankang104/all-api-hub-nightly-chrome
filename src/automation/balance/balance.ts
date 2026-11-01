/**
 * 额度快照采集与守恒差分。
 *
 * 核心公式（取自 anyrouter-autolog 的 checkin.py:377-388）：
 *
 *   reward = (after.quota + after.usedQuota) - (before.quota + before.usedQuota)
 *
 * 为什么要加上已用额度：签到期间账号可能正在被 API 调用消耗。
 * 只看剩余额度会把「领了 5 块又花了 5 块」误判成没领到。
 * 总额度（剩余+已用）只有签到能让它变大，消耗对它没有影响。
 *
 * 这个判据不依赖站点返回什么文案 —— 对 button / relogin 这两种拿不到
 * 结构化响应的方式尤其重要，那是唯一可靠的成功证据。
 */
import { ADAPTER_FAMILIES, type AdapterFamily, type BalanceSnapshot, type CheckinEvidenceSource, type CheckinMetrics, type CheckinVerdict, type RewardSymbol, type SiteConfig } from '@/types';
import type { StepLog } from '@/automation/shared/log';
import { isIdentityEndpointAllowed, isSameSiteUrl, siteIdentitySource, type SiteIdentitySourceConfig } from '@/lib/site/site-security';
import { buildUserIdHeaders } from '@/lib/site/compat-headers';
import { formatQuota, formatQuotaChange } from '@/lib/balance/balance-format';
import { resolveSiteAdapter } from '@/automation/sites/site-adapters';
import { fetchIdentitySourcePayload } from '@/automation/login/identity';
import { decodeLimitedCbor } from '@/automation/login/identity-cbor';
import { isVisible, realClick, sleep } from '@/automation/shared/dom-utils';
import { authBootstrapHeaders } from '@/automation/shared/token-bootstrap';

/**
 * 构造请求站点自有接口要用的认证头，一次覆盖 new-api 与 sub2api 两族。
 *
 * 余额采集和「直接请求签到接口」共用它 —— 两者要的认证完全一样，
 * 各写一份必然走偏（其中一份漏掉某个分叉的头名，那个站点就永远 401）：
 * - new-api 变体：New-API-User 等用户 ID 头（值来自 localStorage["user"].id），
 *   cookie/OAuth 登录不带它会 401。
 * - sub2api 变体（如登仙公益站）：Authorization: Bearer，token 在 localStorage
 *   的 auth_token / access_token / token 里，走的是 /api/v1/... 端点。
 * 服务端只认自己那套，多带的忽略，一次调用兼容全家、让差分通用。
 */
export function siteApiAuthHeaders(fallbackUserId?: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };

  // new-api：用户 ID 头
  let id: string | undefined;
  try {
    const raw = localStorage.getItem('user');
    if (raw) {
      const parsed = JSON.parse(raw) as { id?: unknown };
      if (typeof parsed?.id === 'number' && Number.isFinite(parsed.id)) id = String(parsed.id);
      else if (typeof parsed?.id === 'string' && parsed.id.trim()) id = parsed.id.trim();
    }
  } catch {
    // 不是 JSON 或无 id 字段，当作读不到
  }
  Object.assign(headers, buildUserIdHeaders(id ?? fallbackUserId));

  // sub2api：Bearer token（排除看着像 JSON 对象的值，只取像 token 的长字符串）
  for (const key of ['auth_token', 'access_token', 'token']) {
    const token = localStorage.getItem(key)?.trim();
    if (token && token.length > 20 && !token.startsWith('{')) {
      headers.Authorization = `Bearer ${token}`;
      break;
    }
  }
  return headers;
}

/**
 * 页面上可见的余额文案。
 *
 * 为什么需要它：个人资料页往往**直接印着余额**（1412's API 的 /profile 上
 * 写着「当前余额 $456.75」），而余额接口要 user-id 兼容头才不 401 —— OAuth
 * 首次签到时那个 id 还没有回填过，于是所有端点都读不到，守恒差分退化成
 * unknown，界面只能说「读不到额度变化，成功仅来自站点提示」。
 *
 * 明明看得见，只是没去读。这与 identity.ts 的 readVisibleIdentity 同源。
 *
 * 只认带标签的写法（「当前余额 $X」/「余额：$X」/「Balance $X」），
 * 不从页面上任意一个美元数字里挑 —— 签到卡片上的「今天 +$5.95」、
 * 价格表里的数字都不是账户余额，猜错比读不到更糟。
 */
const VISIBLE_BALANCE_PATTERNS: readonly RegExp[] = [
  /(?:当前余额|账户余额|剩余额度|可用余额|余额)\s*[:：]?\s*(?:([$＄¥￥])|(USD|CNY|RMB))?\s*(-?\d[\d,]*(?:\.\d+)?)/i,
  /\bbalance\b\s*[:：]?\s*(?:([$＄¥￥])|(USD|CNY|RMB))?\s*(-?\d[\d,]*(?:\.\d+)?)/i,
];

/** Linux.SB 侧栏给出的明确账户积分，不把帖子里的任意“积分 N”当成余额。 */
const VISIBLE_POINTS_BALANCE_PATTERN = /(?:^|\n)\s*饼友\s*[·•・]\s*积分\s*[:：]?\s*(-?\d[\d,]*(?:\.\d+)?)/im;

/**
 * 禾维用户菜单中的当前积分。
 *
 * 这里故意要求完整的「当前积分」标签，而不是泛化为「积分 N」：
 * 积分明细、帖子正文和签到卡都会出现其它积分数字，把它们当余额会
 * 污染签到前后的差分。`\s*` 允许菜单把标签和值拆成相邻两行。
 */
const VISIBLE_CURRENT_POINTS_BALANCE_PATTERN = /(?:^|\n)\s*当前积分\s*[:：]?\s*(-?\d[\d,]*(?:\.\d+)?)/im;

/** 禾维积分明细中一条签到记录的标题。 */
const HVOY_DAILY_POINTS_ENTRY_PATTERN = /每日签到奖励/g;
/** A ledger row is not a currency balance, even though it contains「余额 N」. */
const HVOY_DAILY_POINTS_LEDGER_ROW_PATTERN = /每日签到奖励\s*[+＋]\s*\d[\d,]*(?:\.\d+)?/;

/**
 * 积分明细常见日期格式：2026/8/22、2026-08-22、2026年8月22日。
 * 年份必须完整出现，避免把余额或时间中的两个数字拼成日期。
 */
const HVOY_DATE_PATTERN = /((?:19|20)\d{2})\s*[\/\-.年]\s*(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})\s*日?/;
const HVOY_HOSTNAME = 'www.hvoy.ai';

export interface DailyPointsRewardObservation {
  /** 当天签到增加的原始积分（积分本身就是 quota 单位）。 */
  reward: number;
  symbol: '积分';
}

function localDateParts(value: Date): { year: number; month: number; day: number } | null {
  if (Number.isNaN(value.getTime())) return null;
  return {
    year: value.getFullYear(),
    month: value.getMonth() + 1,
    day: value.getDate(),
  };
}

function parseHvoyDate(raw: string): { year: number; month: number; day: number } | null {
  // Normalize Chinese date separators before parsing so the same strict
  // pattern covers both `2026/8/22` and `2026年8月22日`.
  const normalized = raw.replace(/[年月日]/g, '/').replace(/[.\-]/g, '/');
  const match = normalized.match(/((?:19|20)\d{2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{1,2})/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  const candidate = new Date(year, month - 1, day);
  if (
    candidate.getFullYear() !== year
    || candidate.getMonth() + 1 !== month
    || candidate.getDate() !== day
  ) return null;
  return { year, month, day };
}

/**
 * Read today's first 「每日签到奖励 +N」 entry from Hvoy's points ledger.
 *
 * The ledger is newest-first in the current UI. We intentionally return the
 * first matching entry for today's local date, and never fall back to an older
 * `+N` row. `now` is injectable for deterministic callers and remains local
 * time so the date boundary matches the browser's displayed day.
 */
export function readVisibleDailyPointsRewardObservation(
  text: string | undefined,
  now: Date = new Date(),
): DailyPointsRewardObservation | null {
  if (!text) return null;
  const today = localDateParts(now);
  if (!today) return null;

  const entries = [...text.matchAll(HVOY_DAILY_POINTS_ENTRY_PATTERN)];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const start = entry.index ?? 0;
    const nextStart = entries[index + 1]?.index ?? text.length;
    const entryText = text.slice(start, nextStart);

    // Require an explicit positive sign. The row also contains the resulting
    // balance (for example `余额 60`), which must never be mistaken for reward.
    const amountMatch = entryText.match(/[+＋]\s*(\d[\d,]*(?:\.\d+)?)/);
    if (!amountMatch?.[1]) continue;
    const amount = parseDisplayedAmount(amountMatch[1]);
    if (amount == null || amount <= 0) continue;

    const dateMatch = entryText.match(HVOY_DATE_PATTERN);
    if (!dateMatch) continue;
    const date = parseHvoyDate(dateMatch[0]);
    if (!date || date.year !== today.year || date.month !== today.month || date.day !== today.day) {
      continue;
    }
    return { reward: amount, symbol: '积分' };
  }
  return null;
}

/** Same as `readVisibleDailyPointsRewardObservation`, returning only the amount. */
export function readVisibleDailyPointsReward(
  text: string | undefined,
  now: Date = new Date(),
): number | null {
  return readVisibleDailyPointsRewardObservation(text, now)?.reward ?? null;
}

function isHvoySite(site: Pick<SiteConfig, 'loginUrl'>): boolean {
  try {
    return new URL(site.loginUrl).hostname.toLowerCase() === HVOY_HOSTNAME;
  } catch {
    return false;
  }
}

/**
 * Hvoy 的「当前积分」只在右上角用户菜单展开后出现在可见正文中。
 * 余额采集本身不应把其它站点的菜单当成通用逻辑，所以这里只在精确主机名
 * 上尝试一次菜单按钮；读取完成后立即收起，避免遮住后续签到控件。
 */
/**
 * 当前页面路径，作为正文余额快照的来源标记。
 *
 * 只取 pathname：query/hash 变化不改变"这是哪一页"，而带上它们会让同一页的
 * 两次采样被当成跨页而白白丢掉差分。
 */
function visiblePathOf(): string {
  try {
    return new URL(location.href).pathname || '/';
  } catch {
    return '/';
  }
}

async function readHvoyMenuText(log?: StepLog): Promise<string> {
  if (typeof document === 'undefined' || typeof window === 'undefined') return '';
  const body = () => document.body?.innerText ?? document.body?.textContent ?? '';
  let text = body();
  if (VISIBLE_CURRENT_POINTS_BALANCE_PATTERN.test(text)) return text;
  const candidates = [...document.querySelectorAll<HTMLElement>(
    'button, [role="button"], a, [aria-haspopup], [aria-expanded], [tabindex="0"]',
  )].filter((element) => isVisible(element));
  const excluded = /登录|注册|每日签到|签到|语言|主题|切换|菜单|导航|退出|logout|sign[ -]?in/i;
  const ranked = candidates
    .map((element) => {
      const rect = element.getBoundingClientRect();
      const label = (element.innerText || element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      const semantic = `${element.id} ${element.className} ${element.getAttribute('data-testid') ?? ''} ${element.getAttribute('aria-haspopup') ?? ''}`;
      let score = 0;
      if (element.getAttribute('aria-haspopup')?.toLowerCase() === 'menu') score += 30;
      if (element.getAttribute('aria-expanded') === 'false') score += 8;
      if (/user|account|avatar|profile|dropdown|member|用户|账户|头像/i.test(semantic)) score += 12;
      if (rect.top <= 180 && rect.right >= window.innerWidth * 0.65) score += 10;
      if (label.length >= 1 && label.length <= 32) score += 4;
      if (excluded.test(label)) score -= 30;
      return { element, score, label };
    })
    .filter((item) => item.score >= 10)
    .sort((left, right) => right.score - left.score || left.label.length - right.label.length);
  const trigger = ranked[0]?.element;
  if (!trigger) return text;

  let opened = false;
  try {
    await realClick(trigger, { mayNavigate: false });
    opened = true;
  } catch {
    // A transient overlay or a DOM-only test double can make the trusted click
    // unavailable. The original page text remains a valid fallback.
    return text;
  }

  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    text = body();
    if (VISIBLE_CURRENT_POINTS_BALANCE_PATTERN.test(text)) break;
    await sleep(80);
  }

  if (VISIBLE_CURRENT_POINTS_BALANCE_PATTERN.test(text)) {
    log?.push('已展开禾维用户菜单并读取当前积分');
  }

  // Keep the menu from covering the daily-sign-in card. If the trigger was
  // replaced by a reactive render, simply leave it alone; the next capture can
  // re-discover the current trigger safely.
  if (opened && trigger.isConnected) {
    try { await realClick(trigger, { mayNavigate: false }); } catch { /* best effort */ }
  }
  return text;
}

/**
 * 页面上「今天 +$X」这类签到奖励文案。
 *
 * 1412 的 /profile 会把奖励单独显示在签到卡里，而账户余额数字要等
 * SPA 下一次拉取用户资料后才刷新。这个文案是签到结果的一部分，不能和
 * `readVisibleBalance` 混在一起：把它当当前余额会把前后快照一起污染。
 */
const VISIBLE_CHECKIN_REWARD_PATTERNS: readonly {
  pattern: RegExp;
  requiresCheckedIn?: boolean;
}[] = [
  { pattern: /(?:今天|今日|today)[^\n]{0,24}?\+\s*((?:(?:[$＄¥￥]|(?:usd|cny|rmb)\s*)\s*)?\d[\d,]*(?:\.\d+)?)/i },
  { pattern: /(?:签到|check[\s-]?in)[^\n]{0,24}?\+\s*((?:(?:[$＄¥￥]|(?:usd|cny|rmb)\s*)\s*)?\d[\d,]*(?:\.\d+)?)/i },
  // 百倍把当天奖励写成两行「今日可得\n$1.00」。未签到前这张预览卡
  // 也可能存在，所以必须同时看到明确的「今日已签到」才能把它当台账。
  {
    pattern: /(?:今天|今日)\s*可得\s*[:：]?\s*((?:(?:[$＄¥￥]|(?:usd|cny|rmb)\s*)\s*)?\d[\d,]*(?:\.\d+)?)/i,
    requiresCheckedIn: true,
  },
  // Hvoy 的完成弹窗写作「恭喜获取10积分 / 签到成功，已获得 10 积分」。
  // 要求明确完成语义，避免把登录页“每日签到 +10”之类的奖励预览当成已到账。
  {
    pattern: /(?:恭喜(?:获取|获得)|签到成功[^\n]{0,24}?(?:已)?获得)\s*(\d[\d,]*(?:\.\d+)?\s*积分)/i,
  },
];

/**
 * 被价格语义污染的金额片段（全局匹配，用于屏蔽后再解析奖励）。
 *
 * 匹配「价格词 + 就近金额」这一小段，而不是整页：同类站点（new-api / sub2api）
 * 的控制台常常同一屏里既有签到奖励又有套餐价格表，因为别处有价格就放弃解析，
 * 会把真实奖励一起丢掉。
 *
 * 例：`标准套餐 +$5.95`、`订阅价格 ¥30/月`、`套餐 price $5.95`、`档位：$10`。
 */
const PRICE_ADJACENT_AMOUNT_G = /(?:套餐|价格|售价|订阅|档位|plan|price|pricing)[^\n]{0,12}?\+?\s*[$＄¥￥]?\s*\d[\d,]*(?:\.\d+)?(?:\s*\/\s*(?:月|年|mo|mo\.|month|year))?/gi;

const VISIBLE_CHECKED_IN_PATTERN = /(?:今天|今日)\s*已签到|已签到\s*(?:今天|今日)|\bchecked\s+in\s+today\b/i;
const VISIBLE_CHECKIN_CONTEXT_PATTERN = /(?:每日签到|签到|check[\s-]?in|today\s+reward|(?:今天|今日)\s*\+)/i;

/**
 * 正文扫描上限。
 *
 * 只读奖励字段（「今天 +$X」这类贴近标签的数字），但正文可能是几万字的公告、
 * 文档或积分明细。限长把正则的回溯成本和「随便哪个数字被当成奖励」的命中面
 * 一起压住 —— 奖励卡片总在正文前部，20k 足够覆盖。
 */
const VISIBLE_REWARD_SCAN_LIMIT = 20_000;

/**
 * 「现在处于已签到状态」的状态断言。
 *
 * 为什么单独写一条：`VISIBLE_CHECKED_IN_PATTERN`（上面那条）是给「今日可得」
 * 预览卡做门槛用的，只认「今天/今日 + 已签到」的连写；而站点更常见的写法是
 * 一个绿标签「已签到」，旁边才是「今天 +$0.3449」。两者必须都能认出。
 */
const VISIBLE_CHECKED_IN_STATE_PATTERN = /已签到|已簽到|\bchecked\s*in\b/i;

/**
 * 「本月已签到 29 天」是**统计量**，不是「现在已签到」。
 * 判定状态前先把这种写法从文本里删掉，避免拿累计天数当状态断言。
 */
const VISIBLE_CHECKED_IN_COUNT_PATTERN_G = /已签到\s*\d+\s*(?:天|日|次)|已簽到\s*\d+\s*(?:天|日|次)/gi;

/**
 * 站点自己宣告「本次签到已发放」的完成语。
 *
 * 「恭喜获取/获得」这一支与 `VISIBLE_CHECKIN_REWARD_PATTERNS` 里 Hvoy 的措辞
 * **必须成对**：奖励正则认「恭喜获取10积分」，状态断言却只认「签到成功…获得」，
 * 就会出现「读得到奖励、却过不了状态门」的死角 —— 这类站点会一直是
 * 「额度无变化」。
 */
const VISIBLE_CHECKIN_COMPLETED_PATTERN = /(?:签到成功|簽到成功)[^\n]{0,24}?(?:已)?获得|恭喜(?:获取|获得)/i;

function declaresTodayCheckinGranted(text: string): boolean {
  if (VISIBLE_CHECKIN_COMPLETED_PATTERN.test(text)) return true;
  return VISIBLE_CHECKED_IN_STATE_PATTERN.test(
    text.replace(VISIBLE_CHECKED_IN_COUNT_PATTERN_G, ''),
  );
}

function parseDisplayedAmount(raw: string): number | null {
  if (raw.includes(',')) {
    // Only accept conventional thousands separators. Treating `1,5` as 15
    // would turn a malformed label into a false reward.
    if (!/^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(raw)) return null;
    raw = raw.replace(/,/g, '');
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export interface CheckinRewardObservation {
  /** 站点原始 quota 单位，已按 quotaPerUnit 还原。 */
  reward: number;
  /** 页面金额原本使用的显示符号。 */
  symbol?: RewardSymbol;
}

/**
 * 合并同一次页面读取与结构化接口读取到的签到奖励。
 *
 * 接口里的 `today_reward` 常是纯 number，不带币种；它不能把页面明确显示的
 * `¥` 擦掉。只有奖励金额真的变化、且新观测也没有符号时，才丢弃旧符号，
 * 避免把上一笔奖励的币种误带到另一笔金额上。
 */
export function mergeCheckinRewardObservations(
  current: CheckinRewardObservation | null,
  incoming: CheckinRewardObservation | null,
): CheckinRewardObservation | null {
  if (!incoming) return current;
  const sameReward = current != null && Math.abs(incoming.reward - current.reward) <= EPSILON;
  const symbol = incoming.symbol ?? (sameReward ? current?.symbol : undefined);
  return {
    reward: incoming.reward,
    ...(symbol ? { symbol } : {}),
  };
}

function normalizeDisplayedSymbol(token: string | undefined): RewardSymbol | undefined {
  if (!token) return undefined;
  if (token === '¥' || token === '￥') return token;
  if (/^(?:cny|rmb)$/i.test(token)) return '¥';
  return '$';
}

function parseDisplayedReward(raw: string): { amount: number; symbol?: RewardSymbol } | null {
  const pointsMatch = raw.trim().match(/^(\d[\d,]*(?:\.\d+)?)\s*积分$/i);
  if (pointsMatch?.[1]) {
    const amount = parseDisplayedAmount(pointsMatch[1]);
    return amount == null ? null : { amount, symbol: '积分' };
  }

  const match = raw.trim().match(/^(?:([$＄¥￥])|(?:usd|cny|rmb))?\s*(\d[\d,]*(?:\.\d+)?)$/i);
  if (!match?.[2]) return null;
  const amount = parseDisplayedAmount(match[2]);
  if (amount == null) return null;
  const token = match[1] || raw.trim().match(/^(usd|cny|rmb)/i)?.[1] || '';
  const symbol = normalizeDisplayedSymbol(token);
  return { amount, ...(symbol ? { symbol } : {}) };
}

/**
 * Read a check-in reward from visible page text, in the same raw unit as a
 * balance snapshot. `null` means the page did not expose an explicit reward.
 */
export function readVisibleCheckinReward(text: string | undefined, quotaPerUnit?: number): number | null {
  return readVisibleCheckinRewardObservation(text, quotaPerUnit)?.reward ?? null;
}

/** 同 readVisibleCheckinReward，但同时保留页面币种符号供结果展示。 */
export function readVisibleCheckinRewardObservation(
  text: string | undefined,
  quotaPerUnit?: number,
): CheckinRewardObservation | null {
  if (!text) return null;

  // Hvoy 的积分明细是多行表格（标题、+奖励、余额、完整日期），不适合用
  // 通用的“签到 ... +N”单行正则；先走限定为今天日期的专用解析，避免把历史
  // 的 +10 当成今天的增加量。
  const dailyPoints = readVisibleDailyPointsRewardObservation(text);
  if (dailyPoints) return dailyPoints;
  // When a dated ledger is present but has no row for today, do not fall
  // through to the generic 「签到 ... +N」 matcher: that would reuse a
  // historical reward as if it had just appeared.
  if (HVOY_DAILY_POINTS_LEDGER_ROW_PATTERN.test(text) && HVOY_DATE_PATTERN.test(text)) return null;
  if (!VISIBLE_CHECKIN_CONTEXT_PATTERN.test(text)) return null;

  for (const { pattern, requiresCheckedIn } of VISIBLE_CHECKIN_REWARD_PATTERNS) {
    if (requiresCheckedIn && !VISIBLE_CHECKED_IN_PATTERN.test(text)) continue;
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    for (const match of text.matchAll(new RegExp(pattern.source, flags))) {
      const raw = match[1];
      if (!raw) continue;
      const parsed = parseDisplayedReward(raw);
      // A zero award is not independent evidence that a reward was issued; keep
      // searching because the same page can contain a zero preview before the
      // actual completed reward card.
      if (!parsed || parsed.amount <= 0) continue;
      const divisor = parsed.symbol === '积分'
        ? 1
        : quotaPerUnit && quotaPerUnit > 0 ? quotaPerUnit : 1;
      return {
        reward: parsed.amount * divisor,
        ...(parsed.symbol ? { symbol: parsed.symbol } : {}),
      };
    }
  }
  return null;
}

/**
 * Return a reward only when it is newly visible after the click. A stale
 * 「今天 +$X」 from an already-completed check-in must not turn a repeat click
 * into another click-confirmed result. The already-signed path intentionally
 * uses `readVisibleCheckinReward` separately as a daily-ledger record.
 */
export function readNewVisibleCheckinReward(
  beforeText: string | undefined,
  afterText: string | undefined,
  quotaPerUnit?: number,
): number | null {
  return readNewVisibleCheckinRewardObservation(beforeText, afterText, quotaPerUnit)?.reward ?? null;
}

/** 同 readNewVisibleCheckinReward，但保留点击后页面金额的显示符号。 */
export function readNewVisibleCheckinRewardObservation(
  beforeText: string | undefined,
  afterText: string | undefined,
  quotaPerUnit?: number,
): CheckinRewardObservation | null {
  const after = readVisibleCheckinRewardObservation(afterText, quotaPerUnit);
  if (after == null) return null;
  const before = readVisibleCheckinRewardObservation(beforeText, quotaPerUnit);
  const unchanged = before != null
    && Math.abs(after.reward - before.reward) <= EPSILON
    && after.symbol === before.symbol;
  return unchanged ? null : after;
}

/** 页面正文里读取奖励字段时只看前 VISIBLE_REWARD_SCAN_LIMIT 个字符。 */
function scanVisibleRewardText(text: string | undefined): string | undefined {
  if (text == null) return undefined;
  return text.length > VISIBLE_REWARD_SCAN_LIMIT ? text.slice(0, VISIBLE_REWARD_SCAN_LIMIT) : text;
}

/**
 * 解析页面宣告的今日奖励，但**排除价格表**。
 *
 * 直接复用 `readVisibleCheckinRewardObservation`，它覆盖了各站点的真实措辞
 * （「今天 +$0.3449」「今日可得 $1.00」「签到成功，已获得 10 积分」「恭喜获取10积分」）。
 *
 * 但它的第二条通用模式是 `(?:签到|check-in)[^\n]{0,24}?\+N`，那 24 字符余量会把
 * **价格**读成奖励：实测同一张卡片上的「每日签到 已签到 标准套餐 +$5.95 余额 $4.30」
 * 会被解析成 5.95 —— 拿它提升签到结论，就会把「点了没签成」说成「已到账 5.95」，
 * 比不提升更糟。
 *
 * 因此这里只做一次**价格语义的剔除**：金额附近出现价格/套餐/订阅一类词时放弃整个解析。
 * 不改共享函数本身 —— 它还被余额读取等路径使用，放宽或收紧都要单独评估。
 */
function readTodayRewardExcludingPrices(text: string, quotaPerUnit?: number): CheckinRewardObservation | null {
  /*
   * 剔除价格时**只屏蔽被价格语义污染的那些金额**，不能因为页面上别处有价格表
   * 就放弃整个解析。
   *
   * 反例（我自己踩到的）：卡片上既有「已签到 / 今天 +$0.3449」又有套餐价格表，
   * 一句 `if (PRICE_CONTEXT.test(text)) return null` 会把真实奖励一起丢掉 ——
   * 于是用户看到的还是「额度无变化」，修复等于没做。而「同页有价格表」
   * 在真实的 new-api / sub2api 控制台上恰恰是常态。
   *
   * 屏蔽成空白而不是删掉：保留换行与字符位置，避免把前后两行粘成一行后
   * 被跨行正则误配。
   */
  const masked = text.replace(
    PRICE_ADJACENT_AMOUNT_G,
    (matched) => matched.replace(/[^\n]/g, ' '),
  );
  return readVisibleCheckinRewardObservation(masked, quotaPerUnit);
}

/**
 * 把「页面明确宣告的今日签到奖励」提升为一等成功证据。
 *
 * 修的是用户报的真故障（卡皮巴拉API，账号 jiejie）：**「我签到了，你显示没有变化」**。
 *
 * 该站的额度接口读不到，只能读页面正文里的余额；而页面把余额显示到一位小数。
 * 本次奖励 $0.3449 在显示精度上根本看不出来 —— 前后两次采样字符串完全一样，
 * 守恒差分（`diffBalance`）只能判 `unchanged`，界面回报「额度无变化」。
 * 可同一张卡片上，站点自己写着「已签到」「今天 +$0.3449」「累计签到 29」。
 *
 * 站点明说发了多少，比一个被四舍五入掉的余额差分**更直接、也更精确**。
 * 守恒差分有个前提（余额的变化量必须大于页面能显示的精度），而这个前提在不
 * 少站点上不成立；页面宣告的奖励没有这个前提。
 *
 * 只在**后置正文**明确宣告「今天已签到/今日到账」且能读出今天的奖励金额时才
 * 提高结论等级；读不到就原样返回（保持 unknown / unchanged）。
 * 两者的取舍：宁可漏报一次（用户仍能看到「额度无变化 + 余额」并自行看页面），
 * 也不能把没签成说成签成了 —— 假成功会写进收益台账，错的数字与对的看起来一样。
 *
 * `before` / `after` 是动作前后的页面正文快照（与 `readNewVisibleCheckinRewardObservation`
 * 同一份输入）：
 *  - 金额是动作后才出现的 → `visible-reward`（本次点击的证据，界面标「已报告」）；
 *  - 金额在动作前就在页面上（SPA 提前画好的奖励卡）→ `checkin-ledger`
 *    （可信的今日台账，但**不是**本轮新增的证据，界面据此说明「未确认本轮增加」）。
 */
export function withVisibleTodayRewardEvidence(
  metrics: CheckinMetrics,
  text: { before?: string; after?: string },
  quotaPerUnit?: number,
): CheckinMetrics {
  // 守恒差分已经看到总额度增长时不改写：那是比页面文案更硬的证据，
  // 它的金额与来源（balance-diff）都要原样保留。
  if (metrics.verdict === 'rewarded') return metrics;
  // 只处理「差分没看出增长」的三种结论。其余值（老数据/异常值）不猜。
  if (
    metrics.verdict !== 'unchanged'
    && metrics.verdict !== 'already-used'
    && metrics.verdict !== 'unknown'
  ) {
    return metrics;
  }

  const afterText = scanVisibleRewardText(text.after);
  // 状态断言必须在**动作之后**的正文里，且是站点自己写的完成语
  //（「已签到」/「今日已签到」/「签到成功，已获得…」）。动作之前就显示已签到，
  // 说明本轮没签成、今天之前就签过了 —— 不能算本次证据。
  if (!afterText || !declaresTodayCheckinGranted(afterText)) return metrics;

  const reward = readTodayRewardExcludingPrices(afterText, quotaPerUnit);
  if (!reward) return metrics;

  // 金额在动作前就已存在时只能记台账：它是「今天到账了」的证据，
  // 不是「这一下点击到账了」的证据。
  const freshlyRendered = readNewVisibleCheckinRewardObservation(
    scanVisibleRewardText(text.before),
    afterText,
    quotaPerUnit,
  );
  const source: CheckinEvidenceSource = freshlyRendered ? 'visible-reward' : 'checkin-ledger';

  return {
    ...metrics,
    reward: reward.reward,
    ...(reward.symbol ? { rewardSymbol: reward.symbol } : {}),
    verdict: 'rewarded',
    source,
  };
}

/**
 * Read today's completed reward from a structured check-in status response.
 *
 * Sub2API sites such as 百倍 expose `checked_in_today` and `today_reward` in
 * `/api/v1/check-in/status`. Manual balance refresh already fetches that
 * endpoint, so using its JSON is more reliable than waiting for the SPA card
 * to render. The checked flag is mandatory because `today_reward` can also be
 * a prospective amount before the user signs in.
 */
export function extractTodayCheckinReward(payload: unknown, quotaPerUnit?: number): number | null {
  return extractTodayCheckinRewardObservation(payload, quotaPerUnit)?.reward ?? null;
}

/** 读取结构化当日奖励，并保留字符串金额携带的显示符号。 */
export function extractTodayCheckinRewardObservation(
  payload: unknown,
  quotaPerUnit?: number,
): CheckinRewardObservation | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;
  if (root.success === false) return null;

  const asRecord = (value: unknown): Record<string, unknown> | null => (
    value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
  );
  const data = asRecord(root.data);
  const stats = asRecord(data?.stats);
  const candidates = [root, data, stats].filter((value): value is Record<string, unknown> => !!value);
  const checkedIn = candidates.some((value) => (
    value.checked_in_today === true || value.checkedInToday === true
  ));
  if (!checkedIn) return null;

  for (const value of candidates) {
    const raw = value.today_reward ?? value.todayReward;
    const parsed = typeof raw === 'number'
      ? { amount: raw }
      : typeof raw === 'string'
        ? parseDisplayedReward(raw)
        : null;
    if (!parsed || !Number.isFinite(parsed.amount) || parsed.amount <= 0) continue;
    const multiplier = quotaPerUnit && quotaPerUnit > 0 ? quotaPerUnit : 1;
    return {
      reward: parsed.amount * multiplier,
      ...(parsed.symbol ? { symbol: parsed.symbol } : {}),
    };
  }
  return null;
}

/**
 * 从页面正文读一次余额，换算成站点原始 quota 单位。
 *
 * 页面显示的是美元，而快照统一用原始 quota（new-api 是 500000/美元），
 * 所以这里乘回去 —— 不然 diffBalance 会把 $456.75 和接口读到的
 * 228,375,000 当成两个世界的数字。
 *
 * `usedQuota` 只能填 0：页面不显示累计消耗。这让守恒公式退化成
 * 「余额有没有变多」，与 Sub2API 一样是已知的能力退化，不是 bug ——
 * 如实返回 0，让上层知道差分不那么强，而不是编一个数字出来。
 */
export function readVisibleBalance(text: string | undefined, quotaPerUnit?: number): RawBalance | null {
  if (!text) return null;

  // Hvoy exposes the account total only after its user menu is expanded. Keep
  // this branch before generic currency labels and do not apply quotaPerUnit:
  // points are already the site's raw unit, not new-api micro-dollars.
  const currentPointsMatch = text.match(VISIBLE_CURRENT_POINTS_BALANCE_PATTERN);
  if (currentPointsMatch?.[1]) {
    const points = parseDisplayedAmount(currentPointsMatch[1]);
    if (points != null) return { quota: points, usedQuota: 0, symbol: '积分' };
  }

  const pointsMatch = text.match(VISIBLE_POINTS_BALANCE_PATTERN);
  if (pointsMatch?.[1]) {
    const points = parseDisplayedAmount(pointsMatch[1]);
    if (points != null) return { quota: points, usedQuota: 0, symbol: '积分' };
  }

  // Hvoy's points detail rows contain「余额 60」for the post-reward balance.
  // That number is points, not a dollar balance; without this guard the generic
  // currency matcher below would silently turn a detail page into `$60`.
  if (HVOY_DAILY_POINTS_LEDGER_ROW_PATTERN.test(text)) return null;

  // Sub2API 页面会把两个余额池写在同一段：
  // 「当前余额：免费 $1866.75 · 付费 $-0.13」。先按两个明确标签相加，
  // 否则通用的「余额 $X」规则只会读到其中一个池，签到奖励进免费池后
  // 扩展看到的付费余额自然永远不变。
  const balanceSection = text.match(
    /(?:当前余额|账户余额|剩余额度|可用余额)\s*[:：]?\s*([\s\S]{0,120})/i,
  )?.[1];
  if (balanceSection) {
    const freeMatch = balanceSection.match(
      /(?:免费余额|免费)\s*[:：]?\s*(?:([$＄¥￥])|(USD|CNY|RMB))?\s*(-?\d[\d,]*(?:\.\d+)?)/i,
    );
    const paidMatch = balanceSection.match(
      /(?:付费余额|付费)\s*[:：]?\s*(?:([$＄¥￥])|(USD|CNY|RMB))?\s*(-?\d[\d,]*(?:\.\d+)?)/i,
    );
    const free = freeMatch?.[3] ? parseDisplayedAmount(freeMatch[3]) : null;
    const paid = paidMatch?.[3] ? parseDisplayedAmount(paidMatch[3]) : null;
    if (free != null || paid != null) {
      const multiplier = quotaPerUnit && quotaPerUnit > 0 ? quotaPerUnit : 1;
      const symbol = normalizeDisplayedSymbol(
        freeMatch?.[1] ?? freeMatch?.[2] ?? paidMatch?.[1] ?? paidMatch?.[2],
      );
      return {
        quota: ((free ?? 0) + (paid ?? 0)) * multiplier,
        usedQuota: 0,
        ...(symbol ? { symbol } : {}),
      };
    }
  }

  for (const pattern of VISIBLE_BALANCE_PATTERNS) {
    const match = text.match(pattern);
    const raw = match?.[3];
    if (!raw) continue;
    // 「1,234.56」这类千位分隔符：去掉逗号再解析。但逗号不在千位上时
    // （「1,5」这种把逗号当小数点的写法）解析成 15 会凭空放大 10 倍，
    // 宁可跳过也不能报一个错的余额。
    let normalized = raw;
    if (raw.includes(',')) {
      if (!/^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(raw)) continue;
      normalized = raw.replace(/,/g, '');
    }
    const value = Number(normalized);
    if (!Number.isFinite(value)) continue;
    const divisor = quotaPerUnit && quotaPerUnit > 0 ? quotaPerUnit : 1;
    const symbol = normalizeDisplayedSymbol(match?.[1] ?? match?.[2]);
    return {
      quota: value * divisor,
      usedQuota: 0,
      ...(symbol ? { symbol } : {}),
    };
  }
  return null;
}

/** new-api 系的余额端点，按常见程度排序 */
const NEW_API_ENDPOINTS = ['/api/user/self', '/api/user/info'];
/**
 * Sub2API 的额度端点。
 *
 * 签到状态接口同时给出 free_balance / paid_balance，且通常比用户资料接口
 * 更早反映刚发放的奖励，放在首位可直接形成签到前后的守恒差分。
 */
const SUB2API_ENDPOINTS = ['/api/v1/check-in/status', '/api/v1/auth/me'];

interface RawBalance {
  quota: number;
  usedQuota: number;
  symbol?: RewardSymbol;
}

/** 数字或数字字符串 → number；其余（含空串、非有限数）返回 null。 */
function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/**
 * 从各家 API 的响应里挖出额度。
 *
 * new-api 系：{ success: true, data: { quota, used_quota } }
 * Sub2API：  { data: { balance } }（美元，且没有 used_quota）
 *
 * Sub2API 缺 used_quota 是个已知的能力退化：守恒公式退化成「余额有没有变」，
 * 判不出「今日已签到」。这里如实返回 usedQuota=0，让上层知道差分不可靠，
 * 而不是编一个数字出来。
 */

export function extractBalance(payload: unknown): RawBalance | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;

  // success:false 是明确的失败，不要去猜里面的数字
  if (root.success === false) return null;

  const data = (root.data ?? root) as Record<string, unknown>;
  if (!data || typeof data !== 'object') return null;

  const num = finiteNumber;

  // new-api 系：整数 quota
  const quota = num(data.quota);
  if (quota != null) {
    return { quota, usedQuota: num(data.used_quota) ?? num(data.usedQuota) ?? 0 };
  }

  // Sub2API 新版把免费与付费余额拆开返回。百倍状态接口的付费池仍叫
  // `balance`，同时另带 `free_balance`；若先返回 balance，就只会显示截图中
  // 的 -$0.13，签到发进免费池的 $1.00 永远进不了差分。
  const freeBalance = num(data.free_balance) ?? num(data.freeBalance);
  const paidBalance = num(data.paid_balance)
    ?? num(data.paidBalance)
    ?? (freeBalance != null ? num(data.balance) : null);
  if (freeBalance != null || paidBalance != null) {
    return { quota: (freeBalance ?? 0) + (paidBalance ?? 0), usedQuota: 0 };
  }

  // 旧版 Sub2API 用户资料接口只返回单一 balance（美元）。
  const balance = num(data.balance);
  if (balance != null) return { quota: balance, usedQuota: 0 };

  return null;
}

/**
 * 从站点显式配置的跨域接口响应里挖余额（identitySource.endpoint）。
 *
 * 适用形态：SPA 在登录域、真实 API 在另一台主机（orevx.ai ↔
 * server.orevx.ai/api）。这类接口（如 orevx 的 /user/me）同时返回身份字段
 * 和用户总积分 `points`；站点前端把积分显示为「积分」（locale 的
 * wallet.currency_name），据此给快照带上同款符号。
 *
 * 只认 points 一个字段，读不到就返回 null —— 这是显式配置的只读路径，
 * 宁可没有余额，也不能把别的数字当余额。
 *
 * usedQuota 记 0（接口没有累计消耗字段）：守恒公式在这条路径上退化为
 * 「积分有没有变多」，与 Sub2API 缺 used_quota 时同样如实缺省、不编数字。
 */
export function extractCrossOriginBalance(payload: unknown): RawBalance | null {
  if (!payload || typeof payload !== 'object') return null;
  const data = payload as Record<string, unknown>;
  const points = finiteNumber(data.points);
  if (points == null) return null;
  return { quota: points, usedQuota: 0, symbol: '积分' };
}

/**
 * 注入带回的跨域响应（base64 + content-type）→ 解码后的 payload。
 *
 * 手动刷新余额时，页面注入只负责把响应字节原样 base64 带回，解码统一在
 * background 做（余额解析的唯一实现在这里）；CBOR 走有限解码器（identity-cbor.ts），
 * JSON 走 JSON.parse，其余类型与任何损坏都返回 null，绝不抛。
 */
export function decodeCrossOriginPayload(contentType: string, base64: string): unknown | null {
  try {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    if (contentType.includes('cbor')) return decodeLimitedCbor(bytes);
    if (contentType.includes('json')) return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return null;
  } catch {
    return null;
  }
}

/**
 * 手动刷新余额时注入页面用的跨域读取描述（可序列化，注入函数只认这种普通对象）。
 *
 * 与 captureBalance 的跨域读取同一份配置、同一道安全门
 * （isIdentityEndpointAllowed）；返回 null 表示该站点没有可用的跨域读取。
 * 形状被页面注入脚本 readBalancePayloadsInPage 以参数接收 —— 那边独立声明
 * 同样的字段（注入函数不能引用 import，跨文件只能靠结构化约定，注释互认）。
 */
export interface CrossOriginBalanceProbe {
  url: string;
  tokenKey: string;
  tokenStorageType?: 'localStorage' | 'sessionStorage';
  tokenHeader?: string;
  tokenPrefix?: string;
}

export function crossOriginBalanceProbe(site: SiteConfig): CrossOriginBalanceProbe | null {
  const source = siteIdentitySource(site);
  if (!source?.endpoint || !source.tokenKey) return null;
  if (!isIdentityEndpointAllowed(site, source.endpoint)) return null;
  return {
    url: source.endpoint,
    tokenKey: source.tokenKey,
    ...(source.tokenStorageType ? { tokenStorageType: source.tokenStorageType } : {}),
    ...(source.tokenHeader ? { tokenHeader: source.tokenHeader } : {}),
    ...(source.tokenPrefix !== undefined ? { tokenPrefix: source.tokenPrefix } : {}),
  };
}

/**
 * 按站点类型挑要试的端点。
 *
 * 导出给 background 的手动刷新用：它注入页面时要把路径列表当参数传进去
 * （注入函数引用不到 import）。两条路共用同一份列表，加新端点只改这里。
 */
export function balanceEndpointsFor(site: Pick<SiteConfig, 'adapter'>): string[] {
  return endpointsFor(site);
}

/** 按站点类型挑要试的端点 */
function endpointsFor(site: Pick<SiteConfig, 'adapter'>): string[] {
  const family = resolveSiteAdapter(site).family;
  if (family === ADAPTER_FAMILIES.SUB2API) return SUB2API_ENDPOINTS;
  if (family === ADAPTER_FAMILIES.NEW_API) return NEW_API_ENDPOINTS;
  // 类型未知时两族都试一遍，反正只是 GET
  return [...NEW_API_ENDPOINTS, ...SUB2API_ENDPOINTS];
}

/**
 * 采集一次额度快照。
 *
 * 用页面自己的 fetch（credentials: 'include'），所以带着页面的 cookie
 * 和同源身份 —— 不需要单独处理 token。失败返回 null，绝不抛异常：
 * 余额只是辅助判据，读不到不该让签到失败。
 */
export async function captureBalance(site: SiteConfig, log?: StepLog): Promise<BalanceSnapshot | null> {
  const hvoy = isHvoySite(site);
  // new-api 变体要用户 ID 头、sub2api 变体要 Bearer token 才不 401；一次构造两族都带上。
  // 轮换令牌的站点（authBootstrap）再补一枚用会话 cookie 换来的 Bearer —— 这类站点的
  // 令牌只在页面内存里，扩展拿不到，缺了它 /api/user/self 一律 401。
  // 已有的 Authorization（tokenConfig / localStorage 里的 token）优先，引导只在缺位时补 ——
  // 新机制不许覆盖一份本来就能用的凭据。
  const headers = siteApiAuthHeaders(site.adapter?.userId);
  const bootstrapHeaders = await authBootstrapHeaders(site, log);
  for (const [name, value] of Object.entries(bootstrapHeaders)) {
    if (!headers[name]) headers[name] = value;
  }
  // Hvoy 是积分站，不提供可用的 new-api/sub2api 额度端点。不要为它串行
  // 探测四个必然 404/HTML 的接口（每个最多 4 秒），直接走用户菜单积分。
  const endpointPaths = hvoy ? [] : endpointsFor(site);
  for (const path of endpointPaths) {
    const url = new URL(path, location.origin).href;
    // 安全边界：只查同站，防止配置被改成往外部地址发带 cookie 的请求
    if (!isSameSiteUrl(site, url)) continue;

    try {
      // 超时保护：余额只是辅助判据，绝不能让它拖住整个签到。
      // 站点接口挂起时（或 SPA 把未知路径全兜底成 HTML 时）不设超时
      // 会让任务一直停在「签到中」，用户看不到任何结果。
      const response = await fetchWithTimeout(url, BALANCE_FETCH_TIMEOUT_MS, headers);
      if (!response?.ok) continue;

      // SPA 站点常把未命中的路径兜底返回 index.html。此时 status 是 200
      // 但内容是 HTML，解析 JSON 只会白费一次往返 —— 直接跳过。
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (!contentType.includes('json')) continue;

      const payload = await response.json().catch(() => null);
      const raw = extractBalance(payload);
      if (!raw) continue;

      const family = resolveSiteAdapter(site).family;
      const quotaPerUnit = site.adapter?.quotaPerUnit;
      // 走共用 formatQuota，避免这里单独 toFixed 出一套精度：
      // 日志里的余额与卡片上的余额必须是同一位数，否则用户对不上账。
      const scale = { quotaPerUnit, family };
      const formatRaw = (value: number) => formatQuota(value, scale);
      log?.push(`已读取额度快照（剩余 ${formatRaw(raw.quota)}，累计已用 ${formatRaw(raw.usedQuota)}）`);
      return { quota: raw.quota, usedQuota: raw.usedQuota, at: Date.now() };
    } catch {
      // 端点不存在或网络失败，试下一个
    }
  }

  // 站点显式配置的跨域身份接口（identitySource.endpoint）：SPA 站点的真实
  // API 在另一台主机（orevx.ai ↔ server.orevx.ai/api），同源兼容端点一个都
  // 不存在。这条路径与身份核对共用同一份配置和同一道安全门（只读 + token），
  // 响应的 points 就是本站积分余额；任何失败都静默滑到正文兜底。
  const identitySource = siteIdentitySource(site);
  if (identitySource?.endpoint) {
    const crossOrigin = await readCrossOriginBalance(site, identitySource);
    if (crossOrigin) {
      const scale = { family: resolveSiteAdapter(site).family, quotaPerUnit: site.adapter?.quotaPerUnit };
      log?.push(`已通过跨域接口读取额度快照（剩余 ${formatQuota(crossOrigin.quota, scale, crossOrigin.symbol)}）`);
      return crossOrigin;
    }
  }

  // 接口全都读不到（最常见的原因是缺 user-id 兼容头而 401）时，退回页面正文。
  // 这不是猜测：资料页本来就把余额印在页面上，只是此前没去读。
  const visibleText = hvoy
    ? await readHvoyMenuText(log)
    : document.body?.innerText;
  const visible = readVisibleBalance(visibleText, site.adapter?.quotaPerUnit);
  if (visible) {
    log?.push(hvoy
      ? '已读取禾维当前积分（无累计消耗，差分只看积分增减）'
      : '额度接口读不到，改用页面上显示的余额（无累计消耗，差分只看余额增减）');
    // 标记来源：正文里的数字要等 SPA 重新拉接口才会变，签到后必须比接口路径
    // 多等几轮才读得到新值（见 BalanceSnapshot.fromVisibleText 的注释）。
    return {
      quota: visible.quota,
      usedQuota: visible.usedQuota,
      at: Date.now(),
      ...(visible.symbol ? { symbol: visible.symbol } : {}),
      fromVisibleText: true,
      // 记下来源路径：跨页面的正文数字口径不同，相减会造出假奖励。
      // 见 BalanceSnapshot.visiblePath 的注释（海獭 AI 实测事故）。
      visiblePath: visiblePathOf(),
    };
  }

  // 读不到必须说出来。以前这里静默返回 null，于是守恒差分退化成 unknown，
  // 界面只写「扩展无法确认」而不说为什么 —— 用户无从判断是站点没这个接口、
  // 登录态不对，还是缺请求头。
  log?.push('未能读到额度快照（接口与页面都没有可用余额），本次无法用守恒差分确认结果');
  return null;
}

/**
 * 用站点配置的跨域接口采一次余额快照。
 *
 * 复用身份读取的请求实现（fetchIdentitySourcePayload）—— 同一个接口、
 * 同一道安全门、同一套 CBOR/JSON 解码；这里只负责把 payload 里的 points
 * 抽成快照。读不到返回 null，由调用方继续走正文兜底。
 */
async function readCrossOriginBalance(
  site: SiteConfig,
  source: SiteIdentitySourceConfig,
): Promise<BalanceSnapshot | null> {
  const payload = await fetchIdentitySourcePayload(site, source);
  if (payload == null) return null;
  const raw = extractCrossOriginBalance(payload);
  if (!raw) return null;
  return {
    quota: raw.quota,
    usedQuota: raw.usedQuota,
    ...(raw.symbol ? { symbol: raw.symbol } : {}),
    at: Date.now(),
  };
}

/** 单个余额端点的超时。三个端点串行试，总耗时上限约 3 倍。 */
const BALANCE_FETCH_TIMEOUT_MS = 4_000;

/** 带超时的 GET，超时或失败都返回 null 而不抛 */
async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  headers: Record<string, string> = { Accept: 'application/json' },
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers,
      signal: controller.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 浮点余额（Sub2API 的美元）需要容差，不能用 !== 0 判断 */
const EPSILON = 1e-9;

/**
 * 守恒差分：比较前后快照，得出本次签到到底成没成。
 *
 * 三态判定沿用 anyrouter 的分支（format_check_in_notification）：
 *   总额度变多            → rewarded（确实领到了）
 *   总额度没变但有消耗    → already-used（今天签过，期间在用）
 *   完全没变              → unchanged（今天签过，或没领到）
 */
export function diffBalance(
  before: BalanceSnapshot | undefined,
  after: BalanceSnapshot | undefined,
): CheckinMetrics {
  if (!before || !after) return { verdict: 'unknown' };

  /**
   * 两个正文快照必须来自同一页面，否则不相减。
   *
   * 实测事故（海獭 AI）：候选路由降级让流程在 `/dashboard/overview` 与
   * `/profile` 之间跳，两页正文印的数字不是同一个口径（$3.00 vs $52.58）。
   * 基线取前者、终值取后者，差分算出「签到获得 $49.58」并写进记录 ——
   * 而站点实际只发了 $3.06。
   *
   * 这比签到失败严重：错的收益数字与对的看起来完全一样，用户发现不了。
   * 判 unknown 是诚实的结果 —— 我们确实没有可比的基线。
   *
   * 只约束 `fromVisibleText`：接口读数是账号级的，与在哪一页请求无关。
   */
  const crossPageVisible = before.fromVisibleText
    && after.fromVisibleText
    && !!before.visiblePath
    && !!after.visiblePath
    && before.visiblePath !== after.visiblePath;
  if (crossPageVisible) return { verdict: 'unknown' };

  const totalBefore = before.quota + before.usedQuota;
  const totalAfter = after.quota + after.usedQuota;

  const reward = totalAfter - totalBefore;
  const usageDelta = after.usedQuota - before.usedQuota;
  const balanceDelta = after.quota - before.quota;

  let verdict: CheckinVerdict;
  if (reward > EPSILON) verdict = 'rewarded';
  else if (usageDelta > EPSILON) verdict = 'already-used';
  else verdict = 'unchanged';

  return {
    reward,
    usageDelta,
    balanceDelta,
    verdict,
    quotaAfter: after.quota,
    ...(after.symbol ? { balanceSymbol: after.symbol } : {}),
  };
}

/** 把差分结论写成用户能看懂的一句话 */
export function describeMetrics(
  metrics: CheckinMetrics,
  quotaPerUnit?: number,
  family?: AdapterFamily,
): string | null {
  if (!metrics.verdict || metrics.verdict === 'unknown') return null;

  // new-api 的 quota 是整数；旧配置漏了 metadata 时按该家族标准 500000 折算。
  // Sub2API 的 balance 本身就是美元，不能套用 new-api 换算。
  const effectiveQuotaPerUnit = quotaPerUnit && quotaPerUnit > 0
    ? quotaPerUnit
    : family === ADAPTER_FAMILIES.NEW_API ? 500_000 : 1;
  const money = (raw: number, symbol?: RewardSymbol) => formatQuota(
    raw,
    { quotaPerUnit: effectiveQuotaPerUnit },
    symbol,
  );
  const change = (raw: number, symbol?: RewardSymbol) => formatQuotaChange(
    raw,
    { quotaPerUnit: effectiveQuotaPerUnit },
    symbol,
  );

  if (metrics.verdict === 'rewarded' && metrics.source === 'checkin-ledger') {
    const reward = `今日签到记录奖励 ${change(metrics.reward ?? 0, metrics.rewardSymbol ?? metrics.balanceSymbol)}`;
    return metrics.quotaAfter == null ? reward : `${reward}，当前余额 ${money(metrics.quotaAfter, metrics.balanceSymbol)}`;
  }
  /**
   * 奖励来自由页面明确显示的今日奖励、而余额差分没看出增长。
   *
   * 说清「为什么差分是错的」而不是只报一个「额度无变化」—— 用户报的真故障
   *（卡皮巴拉API）就是这一条：页面写着「已签到」「今天 +$0.3449」，而站点把
   * 余额只显示到一位小数（$4.3），差分读到的前后正文一字不差，只能判 unchanged。
   * 只说「额度无变化」会让人以为签到没成。
   *
   * 不用「页面显示本次签到奖励 …」开头：`checkin.ts` 已经在
   * `visible-reward` 路径上推过一模一样的一句，紧接着再说一遍就是结巴。
   *
   * 也**不**断言单一原因：差分看不到增长，可能是显示精度吃掉了一个小数
   *（$0.3449 < 显示步长），也可能是 SPA 还没重新拉账户接口。两个都写上，
   * 不挑一个听起来最顺的当结论。
   */
  if (metrics.verdict === 'rewarded' && metrics.source === 'visible-reward') {
    const reward = `页面证据判定奖励 ${change(metrics.reward ?? 0, metrics.rewardSymbol ?? metrics.balanceSymbol)} 已到账`;
    const why = metrics.balanceDelta == null
      ? '（未取得守恒差分基线）'
      : '（余额差分未体现增长，可能因显示精度或页面刷新滞后）';
    return metrics.quotaAfter == null
      ? `${reward}${why}`
      : `${reward}${why}，当前余额 ${money(metrics.quotaAfter, metrics.balanceSymbol)}`;
  }
  if (metrics.verdict === 'rewarded') {
    const reward = `签到获得 ${change(metrics.reward ?? 0, metrics.rewardSymbol ?? metrics.balanceSymbol)}`;
    return metrics.quotaAfter == null ? reward : `${reward}，当前余额 ${money(metrics.quotaAfter, metrics.balanceSymbol)}`;
  }
  if (metrics.verdict === 'already-used') {
    const used = `今日已签到（期间消耗 ${change(metrics.usageDelta ?? 0, metrics.balanceSymbol)}）`;
    return metrics.quotaAfter == null ? used : `${used}，当前余额 ${money(metrics.quotaAfter, metrics.balanceSymbol)}`;
  }
  if (metrics.source === 'checkin-ledger') {
    return metrics.quotaAfter == null
      ? '今日已签到，额度未变化'
      : `今日已签到，额度未变化，当前余额 ${money(metrics.quotaAfter, metrics.balanceSymbol)}`;
  }
  return metrics.quotaAfter == null ? '额度无变化' : `额度无变化，当前余额 ${money(metrics.quotaAfter, metrics.balanceSymbol)}`;
}
