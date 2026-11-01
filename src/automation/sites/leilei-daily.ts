import type { SiteConfig } from '@/types';
import { clearClickBlocker } from '@/automation/shared/click-safety';
import { controlDisabled, controlText, checkinControls } from '@/automation/checkin/checkin-vocab';
import { isVisible, realClick, sleep } from '@/automation/shared/dom-utils';
import type { StepLog } from '@/automation/shared/log';

/** 一梦五千年是唯一允许执行这个复合流程的精确主机名。 */
const LEILEI_HOSTNAME = 'fapi.leileihog.top';
const PROFILE_PATH = '/profile';
const LOTTERY_PATH = '/lottery';
const ACTION_TIMEOUT_MS = 12_000;
const RESULT_TIMEOUT_MS = 15_000;
/**
 * 每日签到控件的等待时长。
 *
 * 比 ACTION_TIMEOUT_MS 短得多，因为**签到已经不是必经步骤**（2026-08-26
 * 用户确认：站点现在只有抽奖，个人页没有签到入口）。这一步现在是「有就顺手
 * 点一下」，等满 12 秒只是白占每个账号的时间；真正必须成功的是抽奖。
 */
const OPTIONAL_DAILY_WAIT_MS = 2_500;
const LOTTERY_SCAN_CACHE_MS = 220;
const MAX_LOTTERY_CANDIDATES = 800;
const LOTTERY_DONE_TEXT = /(?:今日|今天|本日)已抽(?:奖)?|(?:今日|今天)抽奖次数已用完|\bdraw completed\b|\bno draws left today\b/i;

export type LeileiDailyResult =
  | { status: 'success'; message: string }
  | { status: 'already'; message: string }
  | { status: 'failed'; message: string }
  | { status: 'navigate'; url: string };

export interface LeileiDailyHooks {
  beforeAction?: () => Promise<boolean>;
  /** 验证与公告处理完成后，实际派发每次点击前的会话闸门。 */
  beforeDispatch?: () => Promise<boolean>;
  afterAction?: () => Promise<boolean>;
}

class LeileiFlowError extends Error {}

function normalizedPath(pathname: string): string {
  const value = pathname.replace(/\/+$/, '');
  return value || '/';
}

function pageText(): string {
  return document.body?.innerText ?? document.body?.textContent ?? '';
}

function hasText(pattern: RegExp): boolean {
  return pattern.test(pageText());
}

function normalizedControlText(element: HTMLElement): string {
  return controlText(element).replace(/\s+/g, ' ').trim();
}

function findDailyDone(): HTMLElement | null {
  const control = checkinControls().find((element) => {
    const text = normalizedControlText(element);
    return /(?:今日|今天)?(?:已签到|已经签到|已签)/.test(text);
  });
  return control ?? (hasText(/(?:今日|今天)已签到|已经签到|签到成功/) ? document.body : null);
}

function findDailyAction(): HTMLElement | null {
  return checkinControls()
    .filter((element) => !controlDisabled(element))
    .filter((element) => {
      const text = normalizedControlText(element);
      return /^(?:立即签到|签到|check[ -]?in now|sign[ -]?in)$/i.test(text)
        || (/立即签到/.test(text) && text.length <= 24)
        || (/签到/.test(text) && !/(?:已|今日|今天|历史|记录)/.test(text) && text.length <= 20);
    })
    .sort((a, b) => normalizedControlText(a).length - normalizedControlText(b).length)[0] ?? null;
}

/**
 * 找「浮梦引光」入口。
 *
 * 实测（用户截图）这个入口在**顶部导航栏**，与「主页 / 控制台 / 模型广场」并列，
 * 不在页面主体里。原来只认「href 解析到 /lottery 的锚点」外加一条
 * `checkinControls()` 兜底 —— 而 `checkinControls()` 收集的是签到类控件，
 * 导航栏链接不在其中，于是两条都扑空。
 *
 * 现在按文字直接扫可点元素：导航项无论是 `<a>`、`<button>` 还是带路由的 `<div>`
 * 都能命中。找不到也不再是致命错误 —— 调用方会直接导航到固定的 `/lottery`。
 */
function findDreamLink(): HTMLElement | null {
  const byRoute = [...document.querySelectorAll<HTMLAnchorElement>('a[href]')]
    .filter((element) => isVisible(element))
    .filter((element) => {
      try {
        const target = new URL(element.href, location.href);
        return target.origin === location.origin && normalizedPath(target.pathname) === LOTTERY_PATH;
      } catch {
        return false;
      }
    });
  const routed = byRoute.find((element) => /浮梦引光/.test(normalizedControlText(element)))
    ?? byRoute[0];
  if (routed) return routed;

  // 按文字扫：导航栏项可能是任意元素。限制文字长度，避免命中包含这四个字的
  // 大容器（整个 nav、甚至 body）—— 点大容器不会触发路由。
  const byLabel = [...document.querySelectorAll<HTMLElement>(
    'a, button, [role="button"], [role="menuitem"], [role="link"], [onclick], [class*="cursor-pointer" i], li, span, div',
  )]
    .filter((element) => {
      const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
      return /浮梦引光/.test(text) && text.length <= 24;
    })
    .filter((element) => isVisible(element))
    .filter((element) => !controlDisabled(element))
    .map((element) => {
      const text = normalizedControlText(element);
      const rect = element.getBoundingClientRect();
      let score = text === '浮梦引光' ? 100 : 40;
      if (element.matches('a, button, [role="button"], [role="menuitem"], [role="link"]')) score += 25;
      if (element.matches('[onclick], [class*="cursor-pointer" i]')) score += 12;
      // 导航项通常是个小控件；过大的多半是容器
      if (rect.width <= 240 && rect.height <= 80) score += 15;
      return { element, score, area: Math.max(1, rect.width * rect.height), length: text.length };
    })
    // 同分取最小的：祖先容器会重复子节点的文字，必须让最内层的胜出
    .sort((a, b) => b.score - a.score || a.area - b.area || a.length - b.length);
  return byLabel[0]?.element ?? null;
}

function findLotteryPage(): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>('.lottery-page')].find(isVisible) ?? null;
}

function findLotteryCenter(): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>('button.lottery-board-center')].find(isVisible) ?? null;
}

function lotteryCenterLabel(center: HTMLElement): string {
  // 主标签和下方剩余次数在 textContent 中可能直接拼接，英文也必须分别读取。
  return normalizedControlText(center.querySelector<HTMLElement>(':scope > span') ?? center);
}

function lotteryDone(): boolean {
  const page = findLotteryPage();
  const center = findLotteryCenter();
  // 保留旧版页面的文案兼容；新版不能用整页的规则/历史文字判本账号已抽。
  if (!page && !center) return hasText(LOTTERY_DONE_TEXT);

  const root = page ?? document;
  const notice = root.querySelector<HTMLElement>('.lottery-notice');
  if (
    notice && isVisible(notice)
    && /今日梦火抽签次数已耗尽|\bThis draw is complete\b|\bYou have already drawn today\b/i
      .test(normalizedControlText(notice))
  ) return true;

  if (!center || !controlDisabled(center) || !LOTTERY_DONE_TEXT.test(lotteryCenterLabel(center))) return false;
  // 当前站点在 /api/lottery/status 返回前使用 remaining ?? 0，禁用按钮也会
  // 暂时显示「今日已抽」。只有标题区已展示 my_draw 对应的「抽中 / Won」奖项，才是
  // 本账号的已抽证据；单独的禁用态、0 次数或右侧他人中奖记录都不够。
  const heading = root.querySelector<HTMLElement>('.lottery-page-heading');
  return !!heading && isVisible(heading)
    && /(?:\bWon\s+|抽中\s*[:：]\s*)\S/i.test(normalizedControlText(heading));
}

function lotteryActionText(text: string): boolean {
  return text.length <= 80
    && /抽奖|\b(?:start\s+)?draw\b/i.test(text)
    && !LOTTERY_DONE_TEXT.test(text)
    && !/已抽奖|次数已用完|历史|记录|说明|规则|\b(?:drawing|history|records?|rules?)\b/i.test(text);
}

let lotteryScanAt = 0;
let lotteryScanResult: HTMLElement | null = null;

function findLotteryAction(): HTMLElement | null {
  // 这是站点实际绑定 onDraw 的按钮。不要让精确写着「抽奖」的装饰文字或
  // 方形祖先容器在打分中胜过它，也不能绕过它的禁用态去点子节点。
  const center = findLotteryCenter();
  if (center || findLotteryPage()) {
    lotteryScanResult = null;
    return center && !controlDisabled(center) && lotteryActionText(lotteryCenterLabel(center))
      ? center
      : null;
  }

  const now = Date.now();
  if (
    now - lotteryScanAt < LOTTERY_SCAN_CACHE_MS
    && lotteryScanResult?.isConnected
    && isVisible(lotteryScanResult)
    && !controlDisabled(lotteryScanResult)
    && lotteryActionText(normalizedControlText(lotteryScanResult))
  ) {
    return lotteryScanResult;
  }
  lotteryScanAt = now;
  const marked = checkinControls();
  // The center tile is occasionally a plain div with only a cursor style, so
  // the shared button collector can miss it. Scan a bounded set of likely
  // clickable/card elements as a site-specific fallback, then rank by exact
  // label and square/card geometry. This prevents the right-hand records or
  // help text from becoming the draw target.
  const broad = [...document.querySelectorAll<HTMLElement>(
    'button, [role="button"], a, [onclick], [class*="cursor-pointer" i], [class*="card" i], div, span',
  )]
    // Read textContent first: it avoids forcing layout for the entire page on
    // every poll. The final candidate filter below performs the visibility and
    // geometry checks only for the small, text-matching set.
    .filter((element) => {
      const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
      return lotteryActionText(text);
    })
    .slice(0, MAX_LOTTERY_CANDIDATES)
    .filter((element) => isVisible(element));
  const elements = [...new Set([...marked, ...broad])]
    .filter((element) => !controlDisabled(element))
    .map((element) => ({ element, text: normalizedControlText(element) }))
    .filter(({ element, text }) => {
      if (!lotteryActionText(text)) return false;
      const rect = element.getBoundingClientRect();
      return rect.width >= 42 && rect.height >= 42 && rect.width <= 520 && rect.height <= 520;
    })
    .map(({ element, text }) => {
      const rect = element.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      const ratio = width / height;
      const centerX = rect.left + width / 2;
      const centerY = rect.top + height / 2;
      const viewportCenterX = window.innerWidth / 2;
      const viewportCenterY = window.innerHeight / 2;
      let score = text === '抽奖' ? 140 : 70;
      if (ratio >= 0.72 && ratio <= 1.4) score += 30;
      else if (ratio < 0.45 || ratio > 2.2) score -= 35;
      if (element.matches('button, [role="button"], [onclick], [class*="cursor-pointer" i]')) score += 18;
      score -= Math.hypot(centerX - viewportCenterX, centerY - viewportCenterY) / 80;
      return { element, text, score, area: width * height };
    })
    // Prefer the smallest matching control on a score tie. Large ancestors
    // often repeat the child's text and would otherwise beat the center tile.
    .sort((a, b) => b.score - a.score || a.area - b.area || a.text.length - b.text.length);
  lotteryScanResult = elements[0]?.element ?? null;
  return lotteryScanResult;
}

async function waitUntil(check: () => boolean, timeoutMs: number, intervalMs = 150): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (check()) return true;
    await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
  }
  return false;
}

async function clickAction(
  site: SiteConfig,
  log: StepLog,
  label: string,
  resolve: () => HTMLElement | null,
  hooks: LeileiDailyHooks,
  mayNavigate = false,
): Promise<void> {
  if (!resolve()) throw new LeileiFlowError(`一梦五千年未找到${label}`);
  if (hooks.beforeAction && !await hooks.beforeAction()) {
    throw new LeileiFlowError(`一梦五千年点击${label}前的人机验证未完成`);
  }

  // 统一验证可能导致 React 重绘；完成后必须重新取当前节点。
  let element = resolve();
  if (!element) throw new LeileiFlowError(`一梦五千年完成人机验证后未找到${label}`);
  // 公告关闭也可能重建按钮。只在尚未发出点击前有限重定位，每个新节点都
  // 重新检查遮挡；realClick 发出后不重试，避免消耗第二次抽奖机会。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const blocker = await clearClickBlocker(element, site, log, `一梦五千年 ${label}`);
    const current = resolve();
    if (element.isConnected && current === element) {
      if (blocker) throw new LeileiFlowError(`一梦五千年${label}仍被弹窗遮挡`);
      break;
    }
    if (attempt === 2) throw new LeileiFlowError(`一梦五千年页面持续重绘，无法稳定定位${label}，未点击`);
    log.push(`一梦五千年公告处理后重新定位${label}`);
    await waitUntil(() => !!resolve(), 1_000);
    element = resolve();
    if (!element) throw new LeileiFlowError(`一梦五千年页面重绘后未找到可用的${label}，未点击`);
  }

  /**
   * 会跳转的点击必须**先写日志再点**。
   *
   * README「日志的写入顺序有讲究」写的就是这条：整页跳转会瞬间销毁 content
   * script，动作之后 push 的日志永远进不了信箱。原来这里把
   * `log.push('已点击浮梦引光')` 放在 `realClick` 之后，于是点击一旦真的跳转，
   * 用户看到的日志就停在「继续进入浮梦引光」，后面什么都没有 —— 完全看不出
   * 点击到底发生了没有，也分不清是没找到入口、点了没反应，还是点完跳走了。
   */
  if (mayNavigate) log.push(`一梦五千年即将点击${label}`);

  try {
    if (hooks.beforeDispatch && !await hooks.beforeDispatch()) {
      throw new LeileiFlowError('一梦五千年当前会话已变化，停止后续点击');
    }
    await realClick(element, { mayNavigate });
  } catch (error) {
    throw new LeileiFlowError(
      `一梦五千年点击${label}失败: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!mayNavigate) {
    log.push(`一梦五千年已点击${label}`);
    if (hooks.afterAction && !await hooks.afterAction()) {
      throw new LeileiFlowError(`一梦五千年点击${label}后的人机验证未完成`);
    }
  }
}

/**
 * 找不到控件时把页面上实际存在的可点元素列出来。
 *
 * 只说「未找到浮梦引光入口」帮不上忙 —— 用户没法判断是站点改了文案、
 * 入口挪了位置，还是这一页压根没有那个东西。列出候选才能看出差在哪。
 */
function describeVisibleControls(): string {
  const labels = [...new Set(
    checkinControls()
      .map((element) => normalizedControlText(element))
      .filter((text) => text && text.length <= 20),
  )].slice(0, 10);
  const routes = [...new Set(
    [...document.querySelectorAll<HTMLAnchorElement>('a[href]')]
      .filter((element) => isVisible(element))
      .map((element) => {
        try {
          const target = new URL(element.href, location.href);
          return target.origin === location.origin ? normalizedPath(target.pathname) : '';
        } catch {
          return '';
        }
      })
      .filter(Boolean),
  )].slice(0, 10);
  const parts: string[] = [];
  if (labels.length) parts.push(`可点元素：${labels.join(' / ')}`);
  if (routes.length) parts.push(`同源链接：${routes.join(' / ')}`);
  return parts.join('；') || '页面上没有可见的可点元素或同源链接';
}

/**
 * 个人资料页那一段：**签到有就点，没有就走**。
 *
 * 2026-08-26 用户确认站点改版：现在只有抽奖，个人页已经没有签到入口。
 * 原来这一步是必经的 —— 找不到签到按钮就 `throw`，于是整个流程死在
 * 「未找到可用的每日签到按钮」，抽奖压根跑不到。
 *
 * 改成机会性执行而不是直接删掉这一段：站点把签到加回来时不需要再改代码，
 * 而且老配置里 `checkinPath` 还指着 `/profile` 的用户仍会先落在这一页。
 */
async function runProfile(
  site: SiteConfig,
  log: StepLog,
  hooks: LeileiDailyHooks,
): Promise<LeileiDailyResult> {
  if (findDailyDone()) {
    log.push('一梦五千年页面显示今日已签到，继续进入浮梦引光');
  } else if (await waitUntil(() => !!findDailyAction(), OPTIONAL_DAILY_WAIT_MS)) {
    await clickAction(site, log, '每日签到', findDailyAction, hooks);
    // 点了就该出现已签到态；没出现只记一句，不因此判整轮失败 ——
    // 本轮真正要拿的是抽奖结果
    if (await waitUntil(() => !!findDailyDone(), RESULT_TIMEOUT_MS)) {
      log.push('一梦五千年每日签到已确认完成');
    } else {
      log.push('一梦五千年点击每日签到后未出现已签到状态，继续进入浮梦引光');
    }
  } else {
    log.push('一梦五千年个人页没有签到入口（站点已改为只有抽奖），直接进入浮梦引光');
  }

  /**
   * 进抽奖页**不依赖找到入口元素**。
   *
   * `/lottery` 是固定的同源地址，直接导航必定到得了。而「浮梦引光」入口在
   * 顶部导航栏里（用户截图确认），它可能是路由按钮、可能是 `<a>` 但 href 不是
   * `/lottery`、也可能随站点改版挪走 —— 非要先找到它才肯走，等于给一条本来
   * 不会失败的路凭空加一个失败点。实测就卡在这里：日志停在「继续进入浮梦引光」，
   * 后面什么都没有。
   *
   * 找得到入口时仍优先点它：SPA 路由不重载文档，签到前后的额度差分能一次
   * 覆盖「每日签到 + 抽奖」两步。找不到就直接导航，交给新文档接着跑。
   */
  const target = new URL(LOTTERY_PATH, location.href).href;
  const entry = findDreamLink();
  if (!entry) {
    log.push(`一梦五千年未在页面上找到「浮梦引光」入口，直接进入 ${LOTTERY_PATH}（${describeVisibleControls()}）`);
    return { status: 'navigate', url: target };
  }

  await clickAction(site, log, '浮梦引光', findDreamLink, hooks, true);
  /*
   * SPA 路由：文档还活着就在同一轮把抽奖做完。
   *
   * 1.2 秒足够：SPA 换路由是同步改 history，一两帧内 pathname 就变了。
   * 整页跳转则会直接销毁脚本，等更久也等不到结果 —— 那条路由新文档接手。
   * 原来等 4 秒，白占的是「点击没生效」这种情形下的时间。
   */
  if (await waitUntil(() => normalizedPath(location.pathname) === LOTTERY_PATH, 1_200)) {
    return await runLottery(site, log, hooks);
  }
  // 点了但路径没变（按钮不是路由、或点击被站点忽略）—— 仍然直接导航过去，
  // 不把「点击没生效」变成整个流程的失败。
  log.push(`一梦五千年点击「浮梦引光」后路径未变，改为直接进入 ${LOTTERY_PATH}`);
  return { status: 'navigate', url: target };
}

async function runLottery(
  site: SiteConfig,
  log: StepLog,
  hooks: LeileiDailyHooks,
): Promise<LeileiDailyResult> {
  if (lotteryDone()) {
    log.push('一梦五千年页面显示今日已抽，本次不重复抽奖');
    return { status: 'already', message: '一梦五千年今日已抽' };
  }

  log.push('一梦五千年等待本账号抽奖状态和中央按钮就绪');
  const ready = await waitUntil(() => lotteryDone() || !!findLotteryAction(), ACTION_TIMEOUT_MS);
  if (lotteryDone()) {
    log.push('一梦五千年已确认本账号今日已抽，本次不重复抽奖');
    return { status: 'already', message: '一梦五千年今日已抽' };
  }
  if (!ready) {
    if (findLotteryPage() || findLotteryCenter()) {
      const center = findLotteryCenter();
      const text = center ? normalizedControlText(center) : '尚未出现';
      throw new LeileiFlowError(`一梦五千年抽奖状态尚未就绪：中央按钮「${text}」，没有本账号今日已抽的确认，未点击也未标记已抽`);
    }
    // 列出页面上实际有什么，否则用户没法判断是站点改版还是词表没覆盖
    throw new LeileiFlowError(`一梦五千年抽奖页未找到中央抽奖方块（${describeVisibleControls()}）`);
  }
  await clickAction(site, log, '中央抽奖方块', findLotteryAction, hooks);
  if (!await waitUntil(lotteryDone, RESULT_TIMEOUT_MS)) {
    throw new LeileiFlowError('一梦五千年抽奖后未出现“今日已抽”状态');
  }
  log.push('一梦五千年抽奖已确认完成');
  return { status: 'success', message: '一梦五千年抽奖已完成' };
}

export async function runLeileiDaily(
  site: SiteConfig,
  log: StepLog,
  hooks: LeileiDailyHooks = {},
): Promise<LeileiDailyResult> {
  let configured: URL;
  try {
    configured = new URL(site.loginUrl);
  } catch {
    return { status: 'failed', message: '一梦五千年专用流程的登录地址无效' };
  }
  if (
    configured.protocol !== 'https:'
    || configured.hostname.toLowerCase() !== LEILEI_HOSTNAME
    || configured.port !== ''
    || location.hostname.toLowerCase() !== LEILEI_HOSTNAME
    || location.origin !== configured.origin
  ) {
    return { status: 'failed', message: 'leilei-daily 仅允许在 fapi.leileihog.top 同源页面执行' };
  }

  try {
    const path = normalizedPath(location.pathname);
    // 落在 /profile 上仍会顺手处理签到（老配置、或站点日后把签到加回来）
    if (path === PROFILE_PATH) return await runProfile(site, log, hooks);
    if (path === LOTTERY_PATH) return await runLottery(site, log, hooks);

    /*
     * 直接去 /lottery，不再绕 /profile。
     *
     * 站点现在只有抽奖（2026-08-26 用户确认）。先去个人页等一轮签到控件
     * 再跳过来，白花的是每个账号的时间，还多一个「个人页渲染慢」的失败点。
     */
    const target = new URL(LOTTERY_PATH, location.href).href;
    log.push('一梦五千年流程直接进入浮梦引光抽奖页');
    return { status: 'navigate', url: target };
  } catch (error) {
    return {
      status: 'failed',
      message: error instanceof LeileiFlowError
        ? error.message
        : `一梦五千年流程异常: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
