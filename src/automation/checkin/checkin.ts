import {
  CLAIM_MIN_LENGTH_DEFAULT,
  ADAPTER_FAMILIES,
  type CheckinConfig,
  type CheckinMethod,
  type CheckinMetrics,
  type SiteConfig,
} from '@/types';
import {
  describeElement,
  isVisible,
  queryFirst,
  realClick,
  setNativeValue,
  sleep,
  waitFor,
} from '@/automation/shared/dom-utils';
import type { StepLog } from '@/automation/shared/log';
import { pickUnusedClaimText } from '@/automation/checkin/claim-text';
import {
  captureBalance,
  describeMetrics,
  diffBalance,
  readNewVisibleCheckinRewardObservation,
  readVisibleCheckinRewardObservation,
  withVisibleTodayRewardEvidence,
} from '@/automation/balance/balance';
import { isSameSiteUrl } from '@/lib/site/site-security';
import { formatQuota } from '@/lib/balance/balance-format';
import { adapterCheckinFallback, isAdapterCheckinPage, resolveSiteAdapter } from '@/automation/sites/site-adapters';
import { runCheckinWorkflow, type WorkflowRunHooks } from '@/automation/learning/workflow';
import { clearClickBlocker } from '@/automation/shared/click-safety';
import {
  ALREADY_WORDS,
  CHECKIN_ACTION,
  CHECKIN_PATH,
  NON_ACTION_WORDS,
  SUCCESS_WORDS,
  failureReasonIn,
  checkinControls,
  controlDisabled,
  controlText,
  hit,
  isVisibleElement,
} from '@/automation/checkin/checkin-vocab';
import { ownerModal } from '@/automation/shared/modal-scope';

/** auto 模式等待签到控件出现的时长：已在签到页给足 SPA 渲染时间，否则快速失败去找入口 */
const CHECKIN_WAIT_ON_PAGE_MS = 12_000;
const CHECKIN_WAIT_OFF_PAGE_MS = 3_000;
/** 展开折叠面板后再等控件挂载：只是一次 React 重渲染，不需要整轮 12 秒。 */
const CHECKIN_WAIT_AFTER_EXPAND_MS = 4_000;
/** 折叠面板标题必须含这些词才会被展开 —— 不碰「号池状态」这类无关区域。 */
const COLLAPSED_PANEL_WORDS = ['签到', '打卡', '每日', '福利', '奖励', 'check-in', 'checkin', 'daily'];
/** 一页上最多展开几个面板，防御性上限。 */
const MAX_PANELS_TO_EXPAND = 4;
const CHECKIN_POLL_INTERVAL_MS = 400;
const CHECKIN_METHODS: readonly CheckinMethod[] = ['auto', 'none', 'button', 'api', 'relogin', 'claim', 'workflow'];

function isCheckinMethod(value: unknown): value is CheckinMethod {
  return typeof value === 'string' && CHECKIN_METHODS.includes(value as CheckinMethod);
}

function normalizedRoutePath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

/**
 * 判断当前地址是否就是配置的签到页。
 *
 * OAuth 回跳常附带查询参数，路由器也可能补一个尾随斜杠；两者都不应让身份
 * 闸门与按钮执行器得出不同结论。配置本身带查询参数时仍要求精确匹配。
 */
export function isCurrentCheckinPage(
  site: SiteConfig,
  cfg: CheckinConfig,
  currentHref = location.href,
): boolean {
  if (!cfg.url || !isSameSiteUrl(site, cfg.url)) return !cfg.url;
  try {
    const target = new URL(cfg.url, currentHref);
    const current = new URL(currentHref);
    return current.origin === target.origin
      && normalizedRoutePath(current.pathname) === normalizedRoutePath(target.pathname)
      && (!target.search || current.search === target.search);
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function responseMessage(json: Record<string, unknown>): string {
  const data = asRecord(json.data);
  const value = json.message ?? json.msg ?? data?.message ?? data?.msg;
  return typeof value === 'string' ? value : '';
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

function isHtmlResponse(response: Response, text: string): boolean {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  const prefix = text.trimStart().slice(0, 512).toLowerCase();
  return contentType.includes('text/html') ||
    contentType.includes('application/xhtml+xml') ||
    /^<!doctype\s+html\b/.test(prefix) ||
    /^<html\b/.test(prefix) ||
    /<(?:head|body|form)\b/.test(prefix);
}

/** 守恒差分的结果附在终态上，随 TaskResult 一起回传给界面 */
type WithMetrics = {
  metrics?: CheckinMetrics;
  /**
   * 本次提交成功的领取理由，需要持久化到站点配置的 claimUsedTexts，
   * 否则下次仍会挑到同一条而被站点判为重复。
   */
  claimTextUsed?: string;
  /** 同一轮里被站点判重复的多条理由，均需落盘避免下次再试。 */
  claimTextsUsed?: string[];
};

export type CheckinOutcome =
  | ({ status: 'success'; message: string } & WithMetrics)
  | ({ status: 'already'; message: string } & WithMetrics)
  /** 需要跳转到别的页面才能签到，由 content script 触发导航 */
  | { status: 'navigate'; url: string }
  /** 运行环境中断不结算余额；terminal 表示结束本轮，其余等待会话恢复。 */
  | { status: 'interrupted'; message: string; terminal?: true }
  /** 需要退出登录后重新登录一次（relogin 方式） */
  | { status: 'relogin'; url: string; message: string }
  | ({ status: 'skipped'; message: string } & WithMetrics)
  /**
   * 页面没有可点的签到动作，且本轮没有真实的登录动作可以归因。
   *
   * 不并入 skipped：skipped 在引擎里的语义是「这一页没有签到入口」，会触发
   * 换页/换路由继续找；而这里缺的是「本轮登录」这个前提，换页无法让它成立。
   * 也不并入 failed：failed 会被余额差分兜底改判成功，而本轮登录既没发生也
   * 没有登录前基线，额度变化不能归因于本次任务。
   */
  | ({ status: 'unverified'; message: string } & WithMetrics)
  | ({ status: 'failed'; message: string } & WithMetrics);

/** 引擎注入的钩子，用于在页面可能自行跳转前落地进度 */
export interface CheckinHooks {
  /** 学习流程逐步核对会话、身份和页面状态。 */
  workflowCheckpoint?: WorkflowRunHooks['checkpoint'];
  /**
   * 真正触发签到请求的 DOM 点击前调用。
   *
   * 引擎在这里识别人机验证并复用统一的可信点击/滑块处理；返回 false 时，
   * 签到策略必须停止点击。验证过程可能重绘页面，所以调用后必须重新定位控件。
   */
  beforeCheckinClick?: () => Promise<boolean>;
  /** 学习流程的页面入口可能触发整页导航，点击前保存任务阶段。 */
  beforeWorkflowNavigate?: () => Promise<void>;
  /**
   * 业务按钮点击后再次检查验证。部分站点只有在点击「立即签到」后才挂载
   * Turnstile 对话框；返回 false 时不能继续把超时误报成普通签到失败。
   */
  afterCheckinClick?: () => Promise<boolean>;
  /** 等待签到结果时接管晚出现的验证；未发现验证时应立即返回，不等待挂载。 */
  whileWaitingForCheckinResult?: () => Promise<{ detected: boolean; resolved: boolean }>;
  /** 点退出按钮前调用：站点自己的退出会立刻跳转并销毁本脚本 */
  saveReloginStage?: () => Promise<void>;
  /** 签到后把独立余额状态写回账号，不影响签到结果 */
  saveBalance?: (snapshot: Awaited<ReturnType<typeof captureBalance>>) => Promise<void>;
  /** relogin 退出前把余额同时写入跨页任务上下文。 */
  saveReloginBalanceBefore?: (snapshot: NonNullable<Awaited<ReturnType<typeof captureBalance>>>) => Promise<void>;
  /** button 点击前把余额写入跨页任务上下文；必须完成后才能真实点击。 */
  saveButtonBalanceBefore?: (snapshot: NonNullable<Awaited<ReturnType<typeof captureBalance>>>) => Promise<void>;
  /** 上一份文档已真实点击 button 时保存的基线。 */
  buttonBalanceBefore?: NonNullable<Awaited<ReturnType<typeof captureBalance>>>;
  /** 本轮登录前由目标账号历史余额保存的基线；仅供登录即签到使用。 */
  loginCheckinBalanceBefore?: NonNullable<Awaited<ReturnType<typeof captureBalance>>>;
  /**
   * 本轮任务是否真的发生过登录动作（表单/OAuth/token 认证成功）。
   *
   * 必须由引擎用 loginCompletedThisRun 显式注入，不能从「已有登录态」或
   * 余额基线反推：打开时本来就登录的页面同样有登录态，但那是上一轮的历史，
   * 不能拿来证明本轮「登录即签到」已经发生。
   */
  loginHappenedThisRun?: boolean;
}

/**
 * 执行签到动作。
 *
 * 六种方式：
 *  - auto     自动寻找签到页和按钮
 *  - none     登录即算签到
 *  - button   找按钮点一下（必要时先跳到签到页）
 *  - api      直接请求签到接口，借用页面的登录 cookie
 *  - relogin  退出再登录一次才发奖励
 *  - claim    点入口开弹窗、填一段文本再提交（如 chaiai 的领取权益）
 */
export async function performCheckin(
  site: SiteConfig,
  log: StepLog,
  hooks: CheckinHooks = {},
): Promise<CheckinOutcome> {
  const cfg = site.checkin;
  // 缺失配置必须走通用扫描；只有站点明确写了 none 才能宣称“登录即签到”。
  const rawMethod: unknown = cfg?.method ?? 'auto';
  if (!isCheckinMethod(rawMethod)) {
    const message = `未知签到方式: ${String(rawMethod)}`;
    log.push(message);
    return { status: 'failed', message };
  }
  const method = rawMethod;

  // 签到前后各采一次额度，用守恒差分给出不依赖站点文案的成功证据。
  //
  // relogin 方式不在这里采样：它会退出登录，退出后再查必然是 401 或 0，
  // 差值会算成负数把成功的签到判成失败。那条路要在点退出之前采，
  // 由 checkinByRelogin 自己处理。
  const wantsBalance = method !== 'relogin';
  const resumedButtonClick = method === 'button' && !!hooks.buttonBalanceBefore;
  const loginCheckinBefore = method === 'none'
    ? hooks.loginCheckinBalanceBefore
    : undefined;
  const hasActionBaseline = resumedButtonClick || !!loginCheckinBefore;
  // 重载后的按钮页面或刚登录完成的 none 页面已经是动作后状态，不能再先采
  // 一遍冒充 before，也无需为一份马上会被丢弃的快照重复请求余额接口。
  const capturedBefore = wantsBalance && !hasActionBaseline
    ? await captureBalance(site, log)
    : null;
  // 两类动作基线用途严格隔离：button 必须有点击 pending，none 必须由引擎确认
  // 本轮刚完成登录。其它方式仍只使用当前页面即时采样。
  const before = resumedButtonClick
    ? hooks.buttonBalanceBefore!
    : loginCheckinBefore ?? capturedBefore;
  if (resumedButtonClick) log.push('已恢复签到按钮点击前的余额基线，继续核对页面终态');
  if (loginCheckinBefore) log.push('已恢复本轮登录前的账号余额基线，开始核对今日总额度增加量');
  // Keep the pre-click page text as a baseline. Some SPA pages expose the
  // reward card before the account-balance number catches up; only a reward
  // that appears after this point can be evidence for the current click.
  const pageTextBefore = wantsBalance ? document.body?.innerText ?? '' : '';

  const rawOutcome = await runCheckinMethod(site, cfg, method, log, hooks, before);
  // button 的普通 POST 会让上一份文档来不及返回 success。新文档只有同时拿到
  // “点击前已持久化”的标记和明确完成态，才能把 already 解释为本轮动作成功。
  // 没有标记的普通已签到页面仍保持 already，不参与本轮奖励差分。
  const outcome: CheckinOutcome = resumedButtonClick && rawOutcome.status === 'already'
    ? { status: 'success', message: '签到按钮提交后页面显示已完成' }
    : rawOutcome;
  if (resumedButtonClick && rawOutcome.status === 'already') {
    log.push('签到按钮提交后的新页面已显示完成状态');
  }

  // navigate / relogin 是中间态：页面即将跳走，本轮的后置快照没有意义，
  // 下一阶段会重新采一次。只给真正的终态附差分结果。
  const terminal = outcome.status !== 'navigate' && outcome.status !== 'relogin'
    && outcome.status !== 'interrupted';

  /**
   * 签到后补采余额。
   *
   * ⚠️ 这一段**不能**用 `before` 当门槛。签到前读不到余额是常事（落地页上
   * 没有余额、接口还缺 user-id 头而 401），但签到页上往往读得到 ——
   * 把整段跳过就等于「签到成功了，界面上余额永远是未获取」。差分需要
   * before，落库不需要：那是两个目的。
   */
  if (wantsBalance && terminal) {
    /**
     * 签到到账可能晚于按钮状态，所以要多读几轮。轮数取决于**快照来自哪里**：
     *
     *  - 接口（3 轮，约 2.8 秒）：签到请求一返回服务端就是新数，够了。
     *  - 页面正文（10 轮，约 9.8 秒）：那个数字要等 SPA 重新拉一次账户接口
     *    才会变，3 轮内几乎必然还是旧值 —— 于是差分判成「额度无变化」，
     *    而奖励其实已经到账。这是 1412 上实测到的：日志写着「页面出现签到
     *    成功提示」，紧跟着却是「额度无变化，当前余额 $455.70」。
     *
     * 明确失败时一律多等：若总额度增加了，守恒差分是比迟到/缺失的页面文案
     * 更强的成功证据。
     *
     * 签到前没读到时按接口轮数走：没有 before 就没有差分可等，只要拿到
     * 一次能落库的值就够。
     */
    // 已经明确显示「今日已签到」时没有本次奖励需要等待；读一轮当前余额
    // 只为刷新独立余额存储。继续等 10 轮既浪费时间，也会把外部余额变化
    // 错归因成这次签到的奖励。
    const historicalAlready = outcome.status === 'already' && !hasActionBaseline;
    const attempts = historicalAlready
      ? 1
      : !before
        ? 3
        : outcome.status === 'failed'
          ? (before.fromVisibleText ? 12 : 8)
          : (before.fromVisibleText ? 10 : 3);
    /**
     * 保留**最后一次读到**的快照，而不是最后一次尝试的结果。
     *
     * 原先直接 `after = await captureBalance(site)`，后一轮失败会把前一轮
     * 读到的值覆盖成 null —— 于是明明读到过 $455.70，落库那一步却因为
     * `if (after)` 不成立而整个跳过。页面正在跳转或 SPA 重渲染时读一次失败
     * 很常见，这个覆盖是「余额一直未获取」最隐蔽的一条来源。
     */
    let after: Awaited<ReturnType<typeof captureBalance>> = null;
    let metrics: CheckinMetrics = { verdict: 'unknown' };
    let visibleReward: ReturnType<typeof readVisibleCheckinRewardObservation> = null;
    const rewardQuotaPerUnit = site.adapter?.quotaPerUnit
      ?? (resolveSiteAdapter(site).family === ADAPTER_FAMILIES.NEW_API ? 500_000 : 1);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await sleep(attempt === 0 ? 800 : 1_000);
      const sample = await captureBalance(site);
      if (sample) after = sample;

      // 1412 renders the exact award as「今天 +$X」while its displayed balance
      // can still be the pre-click value. Prefer this explicit, newly rendered
      // reward over an unchanged balance snapshot.
      const reward = readNewVisibleCheckinRewardObservation(
        pageTextBefore,
        document.body?.innerText ?? '',
        rewardQuotaPerUnit,
      );
      if (reward != null) visibleReward = reward;

      if (!before) {
        // 没有 before 就无从差分，读到一次即可收工，不白等剩下几轮
        if (after) break;
        continue;
      }
      metrics = diffBalance(before, after ?? undefined);
      if (metrics.verdict === 'rewarded') break;
    }

    if (historicalAlready) {
      // 这轮没有发生点击。页面签到卡若明确记录了「今天 +$X」，这是当天
      // 奖励的可见台账，应当展示给用户；但它不是本轮点击后的余额差分证据。
      const recordedReward = readVisibleCheckinRewardObservation(
        document.body?.innerText ?? '',
        rewardQuotaPerUnit,
      );
      if (recordedReward != null) {
        metrics = {
          ...metrics,
          reward: recordedReward.reward,
          ...(recordedReward.symbol ? { rewardSymbol: recordedReward.symbol } : {}),
          verdict: 'rewarded',
          source: 'checkin-ledger',
          ...(after ? { quotaAfter: after.quota } : {}),
          ...(after?.symbol ? { balanceSymbol: after.symbol } : {}),
        };
        log.push(`页面记录今日签到奖励 ${formatQuota(
          recordedReward.reward,
          { quotaPerUnit: rewardQuotaPerUnit },
          recordedReward.symbol,
        )}（本轮未重复点击）`);
      } else {
        // 没有奖励金额时，即使快照之间恰好变多，也不能把外部变化冒充成
        // 本次签到奖励；页面/接口的已签到台账才是本轮结论。
        const verdict = metrics.verdict === 'unknown'
          ? 'unknown'
          : (metrics.usageDelta ?? 0) > 0 ? 'already-used' : 'unchanged';
        metrics = {
          ...metrics,
          reward: 0,
          verdict,
          source: 'checkin-ledger',
        };
      }
    }

    // 配置了必需二次领取时，主卡片在领取前显示的“今天 +$X”可能只是待领取
    // 金额，不能把状态机的 failed 反向覆盖成成功。领取流程失败时只接受真实
    // 余额差分；若状态机已拿到领取成功终态，则仍可记录这笔页面奖励。
    const visibleRewardCanConfirm = outcome.status === 'success'
      || (outcome.status === 'failed' && !cfg?.claimConfirmSelector);
    if (visibleReward != null && visibleRewardCanConfirm) {
      metrics = {
        ...metrics,
        reward: visibleReward.reward,
        ...(visibleReward.symbol ? { rewardSymbol: visibleReward.symbol } : {}),
        verdict: 'rewarded',
        source: 'visible-reward',
        ...(after ? { quotaAfter: after.quota } : {}),
        ...(after?.symbol ? { balanceSymbol: after.symbol } : {}),
      };
      log.push(`页面显示本次签到奖励 ${formatQuota(
        visibleReward.reward,
        { quotaPerUnit: rewardQuotaPerUnit },
        visibleReward.symbol,
      )}`);
    }
    /**
     * 页面已明确宣告今天的奖励时，余额差分读不到增长不代表没签成。
     *
     * 实测站点（卡皮巴拉API）把余额显示到**一位小数**，而奖励是 $0.3449 ——
     * 小于显示步长，前后两次正文一字不差，差分只能判「额度无变化」，
     * 而同一张卡片明明写着「已签到」「今天 +$0.3449」。
     *
     * 用 `visibleRewardCanConfirm` 收紧：配置了必需二次领取、且领取流程失败时，
     * 卡片上的金额可能只是**待领取**金额，不能拿它把失败改成成功。
     */
    if (visibleRewardCanConfirm) {
      metrics = withVisibleTodayRewardEvidence(
        metrics,
        { before: pageTextBefore, after: document.body?.innerText ?? '' },
        rewardQuotaPerUnit,
      );
    }

    const summary = describeMetrics(metrics, site.adapter?.quotaPerUnit, resolveSiteAdapter(site).family);
    if (summary) log.push(summary);

    if (after) {
      await hooks.saveBalance?.(after);
    } else {
      // 读不到也要说一声。只留一个光秃秃的「未获取」，用户没法判断是站点
      // 没有余额接口、登录态失效，还是扩展坏了。
      log.push('未能读到余额，界面上这个账号的余额会显示为未获取');
    }

    if (outcome.status === 'failed' && metrics.verdict === 'rewarded') {
      // visibleReward 可能已经读到，但必需领取失败时它被刻意排除为成功证据。
      // 必须看最终 metrics 的来源，否则真实余额增加也会被错误描述成页面文案确认。
      const fromVisibleReward = metrics.source === 'visible-reward';
      log.push(fromVisibleReward
        ? '页面结果提示未及时出现，但签到卡奖励文案确认已到账'
        : '页面结果提示未及时出现，但额度守恒差分确认奖励已到账');
      return {
        status: 'success',
        message: fromVisibleReward ? '页面奖励文案确认签到奖励已到账' : '额度差分确认签到奖励已到账',
        metrics,
      };
    }

    /**
     * none 的「无控件 → unverified」只有在**登录前基线**确认 reward 时才升回
     * success。不能用捕获的临时 before 冒充基线：那种采样发生在登录动作之后，
     * 它的增长不能归因于本次登录/签到，否则就是换一种说法的假成功。
     */
    if (
      outcome.status === 'unverified'
      && method === 'none'
      && hooks.loginHappenedThisRun
      && loginCheckinBefore
      && metrics.verdict === 'rewarded'
    ) {
      log.push('页面没有签到控件也没有完成文案，但登录前余额差分确认奖励已到账');
      return {
        status: 'success',
        message: '额度差分确认登录即签到已到账',
        metrics,
      };
    }
    // 没有 before 时 metrics 是 unknown，附上去只会让界面显示「额度无变化」。
    // 差分没跑就不要假装跑过了。
    // 已签到页面上的奖励可能在点击前就已存在：这时它属于当天台账，
    // 不会被 readNewVisibleCheckinRewardObservation 认作“点击后新出现”。
    // 只要 metrics 已明确标成 checkin-ledger，也必须把它带回引擎，不能
    // 因为缺少余额 before 而把页面明确给出的奖励丢掉。
    return before || visibleReward != null || metrics.source === 'checkin-ledger'
      ? { ...outcome, metrics }
      : outcome;
  }

  return outcome;
}

/** 六种签到方式的分派，与余额采集解耦 */
async function runCheckinMethod(
  site: SiteConfig,
  cfg: CheckinConfig | undefined,
  method: CheckinMethod,
  log: StepLog,
  hooks: CheckinHooks,
  balanceBefore: NonNullable<Awaited<ReturnType<typeof captureBalance>>> | null,
): Promise<CheckinOutcome> {
  const strategy = CHECKIN_STRATEGIES[method];
  if (!strategy) return { status: 'failed', message: `未知签到方式: ${method}` };
  return strategy(site, cfg, log, hooks, balanceBefore);
}

type CheckinStrategy = (
  site: SiteConfig,
  cfg: CheckinConfig | undefined,
  log: StepLog,
  hooks: CheckinHooks,
  balanceBefore: NonNullable<Awaited<ReturnType<typeof captureBalance>>> | null,
) => Promise<CheckinOutcome>;

function missingCheckinConfig(method: CheckinMethod): CheckinOutcome {
  return { status: 'failed', message: `${method} 签到方式缺少配置` };
}

/**
 * 签到策略注册表。
 *
 * 方法差异集中在这里，执行主流程只负责余额快照、错误归类和终态收敛。
 * 新增一种可复用签到方式时，先注册策略并补配置校验，不再继续扩大 if 链。
 */
const CHECKIN_STRATEGIES: Record<CheckinMethod, CheckinStrategy> = {
  auto: (site, cfg, log, hooks) => {
    log.push(cfg?.workflow !== undefined
      ? '当前为自动识别签到：不回放旧学习记录，按本站适配与当前页面寻找签到入口'
      : '当前为自动识别签到：按本站适配与当前页面寻找签到入口');
    return checkinAutomatically(site, cfg, log, false, hooks.loginHappenedThisRun ?? false, hooks);
  },
  // allowLoginFallback=true：只处理当前页，不去别处找签到入口（见 checkinAutomatically）。
  none: (site, cfg, log, hooks) => checkinAutomatically(
    site, cfg, log, true, hooks.loginHappenedThisRun ?? false, hooks,
  ),
  api: (site, cfg, log) => cfg ? checkinByApi(site, cfg, log) : Promise.resolve(missingCheckinConfig('api')),
  button: (site, cfg, log, hooks, balanceBefore) => cfg
    ? checkinByButton(site, cfg, log, hooks, balanceBefore)
    : Promise.resolve(missingCheckinConfig('button')),
  claim: (site, cfg, log, hooks) => cfg
    ? checkinByClaim(site, cfg, log, hooks)
    : Promise.resolve(missingCheckinConfig('claim')),
  /**
   * 工作流的 `unknown`（步骤跑完但读不到签到证据）映射成 `failed`，不是 `skipped`。
   *
   * 两者都能表示「工作流没拿到结论」，但后续处置完全不同：
   *  - `skipped` 在 engine 里是**直接判死**（「这个站点没有签到入口」属于配置事实）；
   *  - `failed` 会继续走 checkin.ts 末尾的兜底：若余额守恒差分判为 `rewarded`，
   *    会**改判成功**（「页面结果提示未及时出现，但额度差分确认奖励已到账」）。
   *
   * 用户实测的站点（卡皮巴拉API）正是这种形状：签到确实成功（页面写着「已签到」
   * 「今天 +$0.3449」），但文案没能匹配上、显示精度又不够差分看得出来。
   * 映射成 skipped 会把这类真实成功直接判死，所以选 failed 保留被差分救回的机会。
   */
  workflow: checkinWithWorkflow,
  relogin: (site, cfg, log, hooks) => cfg
    ? checkinByRelogin(site, cfg, log, hooks)
    : Promise.resolve(missingCheckinConfig('relogin')),
};

/** 明确选择 workflow 才进入回放，失败后不再改用扫描器重复点击。 */
async function checkinWithWorkflow(
  site: SiteConfig,
  cfg: CheckinConfig | undefined,
  log: StepLog,
  hooks: CheckinHooks,
): Promise<CheckinOutcome> {
  log.push('当前为学习流程回放：执行本站明确启用的已保存步骤');
  const result = await runCheckinWorkflow(site, cfg?.workflow, log, {
    checkpoint: hooks.workflowCheckpoint,
    beforeAction: hooks.beforeCheckinClick,
    afterAction: hooks.afterCheckinClick,
    beforeNavigate: hooks.beforeWorkflowNavigate,
    whileWaitingForResult: hooks.whileWaitingForCheckinResult,
  });
  return result.status === 'unknown'
    ? { status: 'failed', message: result.message }
    : result;
}

const CHECKIN_CHALLENGE_MESSAGE = '签到流程的人机验证未完成，已停止当前页面操作';

/**
 * 签到模块只知道“点击前必须获准”，不依赖验证码实现。
 * 具体识别、可信指针点击、滑块处理及人工兜底均由引擎注入的钩子负责。
 */
async function passCheckinClickGate(hooks: CheckinHooks, log: StepLog): Promise<boolean> {
  if (!hooks.beforeCheckinClick) return true;
  const resolved = await hooks.beforeCheckinClick();
  if (!resolved) log.push(CHECKIN_CHALLENGE_MESSAGE);
  return resolved;
}

/** 验证耗时不占用签到结果等待时间；失败直接交回业务流程，不重复点击签到。 */
async function waitForPendingCheckinChallenge(
  hooks: CheckinHooks,
): Promise<{ resolved: boolean; pauseMs: number }> {
  if (!hooks.whileWaitingForCheckinResult) return { resolved: true, pauseMs: 0 };
  const startedAt = Date.now();
  const challenge = await hooks.whileWaitingForCheckinResult();
  return {
    resolved: challenge.resolved,
    pauseMs: challenge.detected ? Date.now() - startedAt : 0,
  };
}

/**
 * 找出页面上所有可点的签到按钮，最可能的排在最前。
 *
 * 排序有两级，**弹窗内优先**必须排在文字长度之前：
 * 有的站签到弹窗弹出来时，背景侧栏还留着一个「签到」导航链接。
 * 只按文字长度排会平手（都是 2 个字），然后按文档顺序取到背景那个 ——
 * 点它只会跳页面，弹窗里真正的按钮反而没被点。
 * 弹窗是当前的交互焦点，里面的签到控件几乎必然是真按钮。
 */
function findCheckinCandidates(
  alreadyWords: string[],
  cfg?: CheckinConfig,
): HTMLElement[] {
  const configured = cfg?.buttonSelector
    ? queryFirst<HTMLElement>(cfg.buttonSelector)
    : null;
  const discovered = checkinControls()
    .filter((element) => {
      const text = controlText(element);
      return !controlDisabled(element)
        && isLikelyCheckinActionControl(element)
        && !isNavigationAnchor(element)
        && CHECKIN_ACTION.test(text)
        && !NON_ACTION_WORDS.test(text)
        && !hit(text, alreadyWords);
    })
    .sort((a, b) => {
      const aInModal = ownerModal(a) ? 0 : 1;
      const bInModal = ownerModal(b) ? 0 : 1;
      return aInModal - bInModal
        || actionControlRank(a) - actionControlRank(b)
        || controlText(a).length - controlText(b).length;
    });

  // 模板选择器比通用词表更精确。例如登仙同页同时有“加成签到”和“立即签到”，
  // 通用排序无法判断哪一个是普通签到；配置命中项必须排在最前，并在 DOM
  // 重绘后每次重新查询。
  const preferred = configured
    && !controlDisabled(configured)
    && !hit(controlText(configured), alreadyWords)
    ? [configured]
    : [];
  return [...new Set([...preferred, ...discovered])];
}

function findDisabledAlreadyControl(alreadyWords: string[]): HTMLElement | null {
  return checkinControls().find((element) => (
    controlDisabled(element) && hit(controlText(element), alreadyWords)
  )) ?? null;
}

/**
 * 导航/菜单里的「签到」通常只是入口，不是当前页上的提交动作。
 *
 * 入口链接由 findSameOriginCheckinLink() 负责处理；这里若把侧栏或菜单项
 * 当按钮点掉，真实的「今日已签到」状态还没来得及渲染就会被误判成失败。
 */
function isLikelyCheckinActionControl(element: HTMLElement): boolean {
  if (ownerModal(element)) return true;

  const navigationContext = element.closest([
    'nav',
    'aside',
    '[role="navigation"]',
    '[role="menu"]',
    '[role="menubar"]',
    '[class*="sidebar" i]',
    '[class*="side-bar" i]',
    '[class*="sider" i]',
    '[class*="menu" i]',
  ].join(', '));
  if (navigationContext) return false;

  if (element.matches('button, input[type="button"], input[type="submit"], [role="button"]')) return true;
  if (element instanceof HTMLAnchorElement) return true;

  const nestedControl = element.querySelector([
    'button',
    '[role="button"]',
    'input[type="button"]',
    'input[type="submit"]',
    'a[href]',
    '[onclick]',
  ].join(', '));
  if (nestedControl) return false;

  return element.children.length <= 2 && controlText(element).replace(/\s+/g, ' ').length <= 40;
}

/**
 * 普通 href 链接负责换页，不是当前页上的签到动作。
 *
 * `<a role="button">`、`href="#"` 和 javascript: 链接仍可能是站点用 anchor
 * 实现的按钮；只排除会实际导航到 HTTP(S) 地址的普通链接。它们会在后面的
 * findSameOriginCheckinLink() 中作为签到入口处理。
 */
function isNavigationAnchor(element: HTMLElement): boolean {
  if (!(element instanceof HTMLAnchorElement)) return false;
  if (element.getAttribute('role')?.toLowerCase() === 'button') return false;

  const href = element.getAttribute('href')?.trim() ?? '';
  if (!href || href === '#' || /^javascript:/i.test(href)) return false;

  try {
    const target = new URL(href, location.href);
    return target.protocol === 'http:' || target.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 同一交互层级内优先使用原生按钮语义，再考虑 anchor/自定义控件。 */
function actionControlRank(element: HTMLElement): number {
  if (element.matches('button, input[type="button"], input[type="submit"], [role="button"]')) return 0;
  if (element instanceof HTMLAnchorElement) return 1;
  return 2;
}

function samePageUrl(a: string, b: string): boolean {
  try {
    const left = new URL(a, location.href);
    const right = new URL(b, location.href);
    return left.origin === right.origin
      && left.pathname === right.pathname
      && left.search === right.search;
  } catch {
    return false;
  }
}

function pathWithSearch(url: string): string {
  const parsed = new URL(url, location.href);
  return `${parsed.pathname}${parsed.search}`;
}

/**
 * 轮询等待签到控件出现。
 *
 * 这些站点大多是 SPA，跳到签到页时页面骨架已经在了，但签到组件还在
 * 等接口返回。同步查一次必然扑空，看起来就像「站点没有签到按钮」。
 *
 * 等待期间同时盯着「已签到」文案：有些站点数据回来后直接渲染成
 * 已签到状态，此时不该再傻等按钮。
 */
/**
 * 展开折叠着的签到面板。
 *
 * 新版界面（维云、海獭 AI 实测）把「每日签到」做成手风琴：折叠状态下
 * `立即签到` 按钮不在 DOM 里，通用扫描等满超时也只能列出导航栏和侧栏。
 * 用户看到「签到页未找到明确按钮」，而页面上明明有个蓝色的签到按钮。
 *
 * 三条约束让它足够保守：
 *  - 只展开**标题含签到相关词**的面板（`COLLAPSED_PANEL_WORDS`）；
 *  - 只点 `aria-expanded="false"` 的，已展开的不动 —— 再点会把它收起来；
 *  - 候选互为祖先时取最外层，避免点内层标题让作用域缩小（维云有两层同名标题）。
 *
 * 返回是否点开过任何面板，供调用方决定要不要再等一轮控件挂载。
 */
async function expandCollapsedCheckinPanels(site: SiteConfig, log: StepLog): Promise<boolean> {
  const collapsed = [...document.querySelectorAll<HTMLElement>('[aria-expanded="false"]')]
    .filter((element) => isVisible(element))
    .filter((element) => {
      const text = controlText(element).replace(/\s+/g, ' ').trim();
      if (!text || text.length > 40) return false;
      const lowered = text.toLowerCase();
      return COLLAPSED_PANEL_WORDS.some((word) => lowered.includes(word.toLowerCase()));
    });
  if (!collapsed.length) return false;

  /*
   * 同名标题只展开一个。
   *
   * 维云实测：「每日签到」有两层同名标题 —— 外层折叠面板标题，展开后面板正文
   * 里的卡片还有一个同名标题。两者是**兄弟**关系（内层在正文里，不在外层标题
   * 内部），所以按祖先关系过滤不掉。
   *
   * 按标题文字去重、保留文档顺序第一个：外层标题总是先出现在 DOM 里。
   * 点内层会让后续的作用域解析缩到子卡片，而签到按钮往往在卡片外面。
   */
  const seen = new Set<string>();
  const unique = collapsed.filter((element) => {
    const label = controlText(element).replace(/\s+/g, ' ').trim();
    if (seen.has(label)) return false;
    seen.add(label);
    return true;
  });

  let opened = 0;
  for (const header of unique.slice(0, MAX_PANELS_TO_EXPAND)) {
    if (header.getAttribute('aria-expanded') !== 'false') continue;
    const label = controlText(header).replace(/\s+/g, ' ').trim();
    const blocker = await clearClickBlocker(header, site, log, `折叠面板「${label}」`);
    if (blocker) continue;
    try {
      await realClick(header);
    } catch {
      continue;
    }
    log.push(`已展开折叠的签到面板「${label}」`);
    opened += 1;
    // 给 React 一帧时间挂载面板内容，再看下一个。
    await sleep(400);
  }
  return opened > 0;
}

async function waitForCheckinControl(
  alreadyWords: string[],
  cfg: CheckinConfig | undefined,
  timeoutMs: number,
): Promise<{ buttons: HTMLElement[] } | { already: true } | { claim: true } | null> {
  const deadline = Date.now() + timeoutMs;
  const requiresClaim = !!cfg?.claimConfirmSelector?.trim();

  for (;;) {
    // 恢复执行时主按钮可能已经变成“今日已签到”，但上一次页面仍留着待领取
    // 弹窗。必需领取必须排在 already 快捷出口之前。
    if (requiresClaim && findClaimConfirmControl(cfg)) return { claim: true };

    const disabledAlready = findDisabledAlreadyControl(alreadyWords);
    if (disabledAlready && (!requiresClaim || Date.now() >= deadline)) return { already: true };

    // 有精确 selector 时它是约束，不只是排序提示。登仙同页的“加成签到”可能
    // 比“立即签到”更早渲染；在精确按钮出现前绝不能回退点击泛化候选。
    const buttons = findCheckinCandidates(alreadyWords, cfg);
    if (cfg?.buttonSelector) {
      const configured = queryFirst<HTMLElement>(cfg.buttonSelector);
      if (configured && !controlDisabled(configured) && !hit(controlText(configured), alreadyWords)) {
        // 精确 selector 是硬约束。即使配置按钮随后被遮挡，也不能把同页的
        // “加成签到”等泛化候选交给调用方继续尝试。
        return { buttons: [configured] };
      }
    } else if (buttons.length) {
      // 无精确配置的白标站仍返回全部候选：最优项若被遮挡，调用方可以换下一个。
      return { buttons };
    }

    if (Date.now() >= deadline) return disabledAlready ? { already: true } : null;
    await sleep(CHECKIN_POLL_INTERVAL_MS);
  }
}

function findSameOriginCheckinLink(site: SiteConfig): HTMLAnchorElement | null {
  const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href]')]
    .filter((anchor) => isVisibleElement(anchor))
    .map((anchor) => {
      try {
        return { anchor, target: new URL(anchor.href, location.href) };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { anchor: HTMLAnchorElement; target: URL } => !!entry)
    .filter(({ anchor, target }) => (
      isSameSiteUrl(site, target.href)
      && (CHECKIN_PATH.test(target.pathname) || CHECKIN_ACTION.test(anchor.innerText.trim()))
    ));

  return links.sort((a, b) => {
    const aPath = CHECKIN_PATH.test(a.target.pathname) ? 0 : 1;
    const bPath = CHECKIN_PATH.test(b.target.pathname) ? 0 : 1;
    return aPath - bPath || a.anchor.innerText.length - b.anchor.innerText.length;
  })[0]?.anchor ?? null;
}

/**
 * 依次尝试候选签到按钮，直到有一个点得动。
 *
 * 为什么要逐个试：最优候选可能被遮罩盖住，而遮挡不代表这个站点签不了 ——
 * 可能只是排序把背景里的某个元素排前面了。旧实现只点最优的那一个，
 * 遇到遮挡就整体失败，等于放弃了其它候选。
 */
async function clickCheckinCandidates(
  site: SiteConfig,
  cfg: CheckinConfig | undefined,
  log: StepLog,
  hooks: CheckinHooks,
): Promise<CheckinOutcome> {
  if (!await passCheckinClickGate(hooks, log)) {
    return { status: 'failed', message: CHECKIN_CHALLENGE_MESSAGE };
  }

  const alreadyWords = cfg?.alreadyText?.length ? cfg.alreadyText : ALREADY_WORDS;
  const alreadyControl = findDisabledAlreadyControl(alreadyWords);
  if (alreadyControl) {
    if (cfg?.claimConfirmSelector) {
      const recovery = await waitForCheckinControl(alreadyWords, cfg, CLAIM_APPEAR_GRACE_MS);
      if (recovery && 'claim' in recovery) {
        return clickAndVerifyAutomaticCheckin(null, site, cfg, log, hooks, true);
      }
    }
    return { status: 'already', message: '完成人机验证后页面显示今日已签到' };
  }

  // 验证控件消失时 React/Vue 可能替换整块签到卡，旧 HTMLElement 已经失效。
  // 精确选择器还要再等一轮，确保重绘后不会回退误点其它签到动作。
  const refreshed = cfg?.buttonSelector
    ? await waitForCheckinControl(alreadyWords, cfg, CHECKIN_WAIT_OFF_PAGE_MS)
    : null;
  if (refreshed && 'claim' in refreshed) {
    return clickAndVerifyAutomaticCheckin(null, site, cfg, log, hooks, true);
  }
  if (refreshed && 'already' in refreshed) {
    return { status: 'already', message: '完成人机验证后页面显示今日已签到' };
  }
  const buttons = refreshed && 'buttons' in refreshed
    ? refreshed.buttons
    : cfg?.buttonSelector
      ? []
      : findCheckinCandidates(alreadyWords, cfg);
  if (buttons.length === 0) {
    return {
      status: 'failed',
      message: cfg?.buttonSelector
        ? `完成人机验证后未找到配置的签到按钮: ${cfg.buttonSelector}`
        : '完成人机验证后未找到可点击的签到按钮',
    };
  }

  let lastBlocked: string | null = null;

  for (const button of buttons.slice(0, 3)) {
    const outcome = await clickAndVerifyAutomaticCheckin(button, site, cfg, log, hooks);
    if (outcome.status !== 'blocked') return outcome;
    lastBlocked = outcome.message;
  }

  return {
    status: 'failed',
    message: lastBlocked ?? '签到按钮被遮挡，可能有未关闭的公告弹窗',
  };
}

/** 内部用的中间态：被遮挡，调用方可以换下一个候选 */
type ClickOutcome = CheckinOutcome | { status: 'blocked'; message: string };

/** 签到后二次确认弹窗（如「赞助人鸣谢 → 领取奖励」）的按钮词 */
const CLAIM_CONFIRM_WORDS = ['领取奖励', '立即领取', '确认领取', '领取签到', '继续签到'];
const CLAIM_SUCCESS_WORDS = ['领取成功', '领取完成', '奖励已到账', '奖励到账', 'reward claimed', 'claimed successfully'];
const CLAIM_DIALOG_CONTEXT = /赞助|鸣谢|公益|sponsor|donat/i;
const CLAIM_DIALOG_ACTION = /领取|claim|collect|redeem/i;
/** 未声明强制二次领取的白标站，也给延迟弹窗一个短暂出现窗口。 */
const CLAIM_APPEAR_GRACE_MS = 4_500;

interface ClaimConfirmControl {
  control: HTMLElement;
  pending: boolean;
}

/**
 * 倒计时按钮不一定使用原生 disabled；覆盖常见无障碍、Radix 与纯 CSS 禁用态。
 */
function claimControlPending(control: HTMLElement): boolean {
  const dataDisabled = control.getAttribute('data-disabled');
  const dataState = control.getAttribute('data-state');
  return controlDisabled(control)
    || (dataDisabled != null && dataDisabled !== 'false')
    || dataState === 'disabled'
    || control.getAttribute('aria-busy') === 'true'
    || window.getComputedStyle(control).pointerEvents === 'none';
}

function looksLikeClaimConfirm(control: HTMLElement): boolean {
  const text = controlText(control).replace(/\s+/g, '');
  if (CLAIM_CONFIRM_WORDS.some((word) => text.includes(word))) return true;

  // 白标站点常把按钮写成倒计时文案（如「2秒后领取」）。单独匹配「领取」
  // 过宽，只在赞助/鸣谢弹窗语境内把它认作二次确认动作。
  const dialog = ownerModal(control);
  const context = dialog?.innerText ?? dialog?.textContent ?? '';
  return !!dialog && CLAIM_DIALOG_CONTEXT.test(context) && CLAIM_DIALOG_ACTION.test(text);
}

/**
 * 找签到后的二次确认按钮（「领取奖励」这类）。有的站点点签到后会弹一个需要
 * 再点一次才真正到账的弹窗。禁用按钮也必须返回：它正是“弹窗已经出现、还在
 * 倒计时”的 pending 证据，不能因为主卡片先显示已签到就提前结束。
 */
function findClaimConfirmControl(
  cfg: CheckinConfig | undefined,
  primary?: { text: string; modal: Element | null },
): ClaimConfirmControl | null {
  const configured = cfg?.claimConfirmSelector
    ? queryFirst<HTMLElement>(cfg.claimConfirmSelector)
    : null;
  // 显式 selector 表示站点已知的必经动作，缺失时宁可继续等待，也不能回退去点
  // 页面上另一个“领取/加成”按钮。未配置的白标站才使用语义扫描。
  const controls = cfg?.claimConfirmSelector
    ? (configured ? [configured] : [])
    : checkinControls();

  for (const control of controls) {
    if (!isVisibleElement(control)) continue;
    if (control !== configured && !looksLikeClaimConfirm(control)) continue;
    // 主签到按钮本身可能就叫“领取奖励”。同一面板中未变的主动作不是新确认步骤，
    // 包括 React 用新 DOM 节点重绘但文案/面板没变的情况。显式站点配置仍优先。
    if (control !== configured && primary
      && controlText(control) === primary.text && ownerModal(control) === primary.modal) continue;
    return {
      control,
      pending: claimControlPending(control),
    };
  }
  return null;
}

function newlyContains(text: string, baseline: string, words: string[]): boolean {
  return hit(text, words) && !hit(baseline, words);
}

function clickAndVerifyAutomaticCheckin(
  button: HTMLElement | null,
  site: SiteConfig,
  cfg: CheckinConfig | undefined,
  log: StepLog,
  hooks: CheckinHooks,
  resumeClaim: true,
): Promise<CheckinOutcome>;
function clickAndVerifyAutomaticCheckin(
  button: HTMLElement,
  site: SiteConfig,
  cfg: CheckinConfig | undefined,
  log: StepLog,
  hooks: CheckinHooks,
  resumeClaim?: false,
): Promise<ClickOutcome>;
async function clickAndVerifyAutomaticCheckin(
  button: HTMLElement | null,
  site: SiteConfig,
  cfg: CheckinConfig | undefined,
  log: StepLog,
  hooks: CheckinHooks,
  resumeClaim = false,
): Promise<ClickOutcome> {
  const alreadyWords = cfg?.alreadyText?.length ? cfg.alreadyText : ALREADY_WORDS;
  const successWords = cfg?.successText?.length ? cfg.successText : SUCCESS_WORDS;
  const before = document.body?.innerText ?? '';
  const hadSuccessText = hit(before, successWords);
  const hadAlreadyText = hit(before, alreadyWords);
  const primary = !resumeClaim && button ? { text: controlText(button), modal: ownerModal(button) } : undefined;

  if (!resumeClaim) {
    if (!button) return { status: 'failed', message: '未找到可点击的主签到按钮' };
    // 点之前先看按钮是不是被公告遮罩盖着。realClick 用的是 el.click()，
    // 遮罩挡不住它 —— 于是"点成功"了、日志也写了，但站点收不到真实交互，
    // 签到静默失败。被遮挡时先主动关一次公告再点，仍挡才判失败。
    const stillBlocking = await clearClickBlocker(button, site, log);
    if (stillBlocking) {
      return {
        status: 'blocked',
        message: `签到按钮被${describeElement(stillBlocking)}遮挡，可能有未关闭的公告弹窗`,
      };
    }

    // DOM 点击可能同步触发 React/Vue 更新按钮文案；先保存用户实际点下时看到的标签。
    const buttonLabel = controlText(button).slice(0, 30);
    await realClick(button, { mayNavigate: true });
    log.push(`已点击自动识别的签到按钮「${buttonLabel}」`);

    // 登录验证与签到验证是两次独立操作。先处理本次点击后的验证；尚未挂载的
    // 控件交给下面的结果轮询继续等待，仍复用引擎注入的现有验证功能。
    if (hooks.afterCheckinClick && !await hooks.afterCheckinClick()) {
      return { status: 'failed', message: '签到点击后的人机验证未完成' };
    }
  } else {
    log.push('检测到上次主签到后尚待领取奖励，恢复二次确认流程');
  }

  // 有的站点点签到后会先把主卡片改成“今日已签到”，随后才渲染赞助领取弹窗。
  // 主卡片终态必须先暂存，等过弹窗出现窗口；一旦看见领取控件，就必须完成
  // 领取流程，不能被前面的“签到成功”提示提前短路。
  let claimConfirms = 0;
  const MAX_CLAIM_CONFIRMS = 5;
  const startedAt = Date.now();
  let deadline = startedAt + 22_000;
  let claimDiscoveryDeadline = startedAt + CLAIM_APPEAR_GRACE_MS;
  const claimRequired = !!cfg?.claimConfirmSelector?.trim();
  const clickedClaimControls = new WeakSet<HTMLElement>();
  let claimFlowSeen = resumeClaim;
  let claimPendingLogged = false;
  /**
   * 站点在页面上写出的失败原因。
   *
   * 为什么必须收集它：只看成功词表时，站点写「签到失败：服务暂不可用」，扩展
   * 读不到成功就报「点击后缺少明确结果」——真正的原因被丢掉，diagnostics 归类
   * 不到「站点暂时不可用」，一次偶发 5xx 就成了当天永久失败，永不重试。
   *
   * 只记录、不据此提前收工：站点可能先说「稍后重试」再自己成功。
   * 它只用来在**最终没有成功证据**时替换掉那句没有信息量的默认失败文案。
   */
  let declaredFailure: string | null = null;
  let claimClickBaseline = before;
  let claimHadDisabledAlready = false;
  let claimHadExplicitAlready = false;
  let deferredPrimaryOutcome: CheckinOutcome | null = null;

  while (Date.now() < deadline) {
    await sleep(400);
    const challenge = await waitForPendingCheckinChallenge(hooks);
    if (!challenge.resolved) {
      return { status: 'failed', message: '签到点击后的人机验证未完成' };
    }
    deadline += challenge.pauseMs;
    claimDiscoveryDeadline += challenge.pauseMs;
    const now = document.body?.innerText ?? '';
    declaredFailure = failureReasonIn(now) ?? declaredFailure;

    // 必须先看二次领取，包括禁用倒计时态。主卡片可能在弹窗解锁前就显示成功。
    const claim = findClaimConfirmControl(cfg, primary);
    if (claim) {
      claimFlowSeen = true;

      const canSubmit = !clickedClaimControls.has(claim.control)
        && claimConfirms < MAX_CLAIM_CONFIRMS
        && (!claimRequired || claimConfirms === 0);
      if (canSubmit) {
        if (claim.pending) {
          if (!claimPendingLogged) {
            log.push('已出现二次确认按钮，等待「领取奖励」解锁');
            claimPendingLogged = true;
          }
          continue;
        }

        if (!await passCheckinClickGate(hooks, log)) {
          return { status: 'failed', message: CHECKIN_CHALLENGE_MESSAGE };
        }

        // 验证过程和倒计时都可能触发 React 重绘；闸门之后必须再定位一次。
        const refreshed = findClaimConfirmControl(cfg, primary);
        if (!refreshed || refreshed.pending || clickedClaimControls.has(refreshed.control)) continue;
        if (claimRequired && claimConfirms > 0) continue;
        const label = controlText(refreshed.control).slice(0, 20);
        claimClickBaseline = document.body?.innerText ?? '';
        claimHadDisabledAlready = !!findDisabledAlreadyControl(alreadyWords);
        claimHadExplicitAlready = !!(cfg?.alreadySelector && queryFirst(cfg.alreadySelector));
        const claimBlocker = await clearClickBlocker(refreshed.control, site, log, '二次确认按钮');
        if (claimBlocker) {
          log.push(`二次确认按钮被${describeElement(claimBlocker)}遮挡，稍后重新定位`);
          continue;
        }
        try {
          // 奖励按钮不会导航；要求后台明确确认鼠标事件抵达目标控件。
          await realClick(refreshed.control);
        } catch (error) {
          log.push(`二次确认按钮点击未获浏览器确认，将重新定位后重试：${error instanceof Error ? error.message : String(error)}`);
          continue;
        }

        clickedClaimControls.add(refreshed.control);
        claimConfirms += 1;
        log.push(`已点击二次确认按钮「${label}」（第 ${claimConfirms} 次）`);
        const challengeStartedAt = Date.now();
        if (hooks.afterCheckinClick && !await hooks.afterCheckinClick()) {
          return { status: 'failed', message: '领取奖励点击后的人机验证未完成' };
        }
        const challengePauseMs = Date.now() - challengeStartedAt;
        deadline += challengePauseMs;
        claimDiscoveryDeadline += challengePauseMs;
        await sleep(3200);
        continue;
      }
    }

    // 点过领取以后，只接受新出现的领取成功或领取后新出现的权威已签控件。
    // 弹窗关闭本身不是成功证据；若页面没给出新终态，返回 failed，再由外层真实
    // 余额差分把已经到账的结果升级为成功。
    const replacementAlready = findDisabledAlreadyControl(alreadyWords);
    const explicitAlready = cfg?.alreadySelector
      ? queryFirst<HTMLElement>(cfg.alreadySelector)
      : null;
    if (claimConfirms > 0) {
      if (newlyContains(now, claimClickBaseline, CLAIM_SUCCESS_WORDS)) {
        return { status: 'success', message: '页面出现领取奖励成功提示' };
      }
      if (
        (!claimHadDisabledAlready && replacementAlready)
        || (!claimHadExplicitAlready && explicitAlready)
      ) {
        return { status: 'success', message: '领取后页面新出现今日已签到状态' };
      }
      continue;
    }

    // 看见过领取流程却还没有成功点击时，不允许主卡片状态结束本轮。
    if (claimFlowSeen) continue;

    let primaryOutcome: CheckinOutcome | null = null;
    if (!hadSuccessText && hit(now, successWords)) {
      primaryOutcome = { status: 'success', message: '页面出现签到成功提示' };
    } else if (!hadAlreadyText && hit(now, alreadyWords)) {
      primaryOutcome = { status: 'success', message: '点击后页面显示今日已签到' };
    } else if (button && document.contains(button) && controlDisabled(button) && hit(controlText(button), alreadyWords)) {
      primaryOutcome = { status: 'success', message: '签到按钮已变为今日已签到' };
    } else if (replacementAlready) {
      primaryOutcome = { status: 'success', message: '签到按钮已替换为今日已签到状态' };
    } else if (cfg?.successSelector && queryFirst(cfg.successSelector)) {
      primaryOutcome = { status: 'success', message: '命中签到成功标志' };
    } else if (explicitAlready) {
      primaryOutcome = { status: 'success', message: '点击后命中今日已签到标志' };
    }

    if (primaryOutcome) {
      deferredPrimaryOutcome = primaryOutcome;
      if (!claimRequired && Date.now() >= claimDiscoveryDeadline) return primaryOutcome;
      continue;
    }
    if (!claimRequired && deferredPrimaryOutcome && Date.now() >= claimDiscoveryDeadline) {
      return deferredPrimaryOutcome;
    }
  }

  if (claimConfirms > 0) {
    return { status: 'failed', message: `已点击 ${claimConfirms} 次「领取奖励」，待余额差分确认结果` };
  }
  if (claimFlowSeen) {
    return { status: 'failed', message: '已发现「领取奖励」，但等待期内始终未完成有效点击' };
  }
  if (claimRequired) {
    return { status: 'failed', message: '未等到站点必需的「领取奖励」二次确认' };
  }
  if (deferredPrimaryOutcome) return deferredPrimaryOutcome;
  if (declaredFailure) {
    return { status: 'failed', message: `站点确认签到失败：${declaredFailure}` };
  }
  return { status: 'failed', message: '点击自动识别的签到按钮后缺少明确结果' };
}

/**
 * auto 与 none 共用的当前页签到识别。
 *
 * @param allowLoginFallback
 *   'none' 传 true：当前页没有签到动作时按「登录即签到」收尾，**不做**
 *   入口探测和跳转。'auto' 传 false：当前页找不到就继续找同源入口、配置的
 *   签到页和适配器兜底路径，全都没有才失败。
 * @param loginHappenedThisRun
 *   本轮是否真的完成过登录动作，由 CheckinHooks 显式传入。只有它为 true 时
 *   「登录即签到」才有归因前提；打开时已有登录态但本轮没登录时，没有可归因
 *   的登录动作，必须如实返回 unverified。
 */
async function checkinAutomatically(
  site: SiteConfig,
  cfg: CheckinConfig | undefined,
  log: StepLog,
  allowLoginFallback: boolean,
  loginHappenedThisRun: boolean,
  hooks: CheckinHooks,
): Promise<CheckinOutcome> {
  const alreadyWords = cfg?.alreadyText?.length ? cfg.alreadyText : ALREADY_WORDS;
  const successWords = cfg?.successText?.length ? cfg.successText : SUCCESS_WORDS;
  const alreadyControl = findDisabledAlreadyControl(alreadyWords);
  if (alreadyControl) {
    if (cfg?.claimConfirmSelector) {
      log.push('页面已显示主签到完成，短暂检查是否还有待领取奖励');
      const recovery = await waitForCheckinControl(alreadyWords, cfg, CLAIM_APPEAR_GRACE_MS);
      if (recovery && 'claim' in recovery) {
        return clickAndVerifyAutomaticCheckin(null, site, cfg, log, hooks, true);
      }
    }
    log.push(`自动识别到已签到状态「${controlText(alreadyControl).slice(0, 30)}」`);
    return { status: 'already', message: '页面显示今日已签到' };
  }

  const currentPath = location.pathname;
  // 站点家族/白标变体的签到路径由 SiteAdapter 能力声明提供，核心引擎不再
  // 直接判断某个 siteType。未声明的站点仍使用通用路径和标题探测。
  const onAdapterCheckinPage = isAdapterCheckinPage(site, currentPath, document.title);
  const onCheckinPage = CHECKIN_PATH.test(currentPath)
    || /每日签到|daily\s+check[\s-]?in/i.test(document.title)
    || onAdapterCheckinPage;

  // ⚠️ 正文里的「已签到」文案**不能**在这里短路。
  //
  // 签到页正文常有「已签到 3 天，连续签到可得更多额度」这类说明，
  // 它在任何点击之前就把整条流程判成 already —— 用户看到「今日已签到」，
  // 实际一次都没签。所以正文文案降级为兜底：先等控件、能点就点，
  // 等不到控件时才回头看正文（见下面 bodyClaimsAlready）。
  //
  // 已在签到页就多等一会儿让 SPA 把组件渲染出来；还在别处则快速失败，
  // 把时间留给「找签到入口再跳过去」这条路。
  // 在签到页要等满 CHECKIN_WAIT_ON_PAGE_MS 让 SPA 把签到组件渲染出来，这段
  // 等待期间没有其它日志，真实使用时看着像卡死。补一条让等待可见、可预期。
  if (onCheckinPage) {
    log.push(`已在签到页 ${currentPath}，等待签到组件渲染（最多 ${CHECKIN_WAIT_ON_PAGE_MS / 1000} 秒）…`);
  }

  // 验证可能挡住或延迟签到组件本身的渲染，不能先等按钮、等不到才检查验证。
  // 点击候选前 clickCheckinCandidates 还会再检查一次并重新扫描 DOM。
  if (!await passCheckinClickGate(hooks, log)) {
    return { status: 'failed', message: CHECKIN_CHALLENGE_MESSAGE };
  }
  let waited = await waitForCheckinControl(
    alreadyWords,
    cfg,
    onCheckinPage ? CHECKIN_WAIT_ON_PAGE_MS : CHECKIN_WAIT_OFF_PAGE_MS,
  );

  /**
   * 等不到控件时，先看看签到面板是不是**折叠**着的。
   *
   * 越来越多的新版界面把「每日签到」做成手风琴面板，折叠状态下按钮根本不在
   * DOM 里 —— 通用扫描等满 12 秒也只能列出导航栏和侧栏（实测维云、海獭 AI）。
   * 用户看到的是「签到页未找到明确按钮」，而页面上明明有个蓝色的「立即签到」。
   *
   * 展开是幂等的：已展开的面板 `aria-expanded` 已是 true，不会被再点一次。
   * 只展开**标题含签到相关词**的面板，不碰「号池状态」这类无关区域。
   */
  if (!waited && await expandCollapsedCheckinPanels(site, log)) {
    waited = await waitForCheckinControl(alreadyWords, cfg, CHECKIN_WAIT_AFTER_EXPAND_MS);
  }

  if (waited && 'already' in waited) {
    log.push('等待期间出现已签到状态');
    return { status: 'already', message: '页面显示今日已签到' };
  }
  if (waited && 'claim' in waited) {
    return clickAndVerifyAutomaticCheckin(null, site, cfg, log, hooks, true);
  }
  if (waited) return clickCheckinCandidates(site, cfg, log, hooks);

  // 没等到可点控件，这时正文文案才作为已签到的证据
  if (onCheckinPage && hit(document.body?.innerText ?? '', alreadyWords)) {
    log.push('未找到可点签到控件，页面正文显示今日已签到');
    return { status: 'already', message: '页面显示今日已签到' };
  }

  /**
   * none 只看当前页：上面已经给过控件出现的机会（有按钮就点了）、也认过
   * 已签到文案。
   * 历史 none 记录可能残留 checkin.url；只有 auto 才会使用它去寻找签到页。
   *
   * 「这一页没有签到动作」只有在**本轮真的登录过**时才等于「登录即签到」：
   * 打开时已经登录的会话是上一轮留下的，本轮既没有登录动作，也没有登录前
   * 余额基线，直接报成功会让用户看到一个无法核实的绿色对勾。
   */
  if (allowLoginFallback) {
    if (!loginHappenedThisRun) {
      const message = '当前页没有签到控件，且本轮没有发生登录动作：无法确认「登录即签到」已完成';
      log.push(message);
      return { status: 'unverified', message };
    }

    /**
     * 「登录即签到」不能只看登录动作本身：站点可能登录后仍需点一次按钮。
     *
     * 这一层先认页面给出的完成证据（SUCCESS_WORDS / ALREADY_WORDS）。页面没有
     * 证据时先收成 unverified，绝不凭「登录过」直接发成功；随后 performCheckin
     * 的余额差分阶段若读到登录前基线并确认 rewarded，会把这里升回 success ——
     * 这样「有基线且 reward 到账」与「无基线的假成功」两条路严格分开。
     */
    const bodyText = document.body?.innerText ?? '';
    if (hit(bodyText, successWords) || hit(bodyText, alreadyWords)) {
      log.push('当前页没有签到控件，但页面正文明确显示签到完成，按「登录即签到」确认成功');
      return { status: 'success', message: '登录即签到' };
    }

    const message = '当前页没有签到控件，且没有余额入账或页面证据可确认「登录即签到」，无法确认本次签到';
    log.push(message);
    return { status: 'unverified', message };
  }

  // 页面上没有可点的签到控件，去找同源签到入口。
  // 这一步对「已在签到页」同样要做 —— 所谓签到页可能只是个入口列表，
  // 真正的签到按钮在更深一层。
  const link = findSameOriginCheckinLink(site);
  if (link) {
    const target = new URL(link.href, location.href).href;
    // 已经在这个地址上就别再跳了，否则会原地打转
    if (!samePageUrl(target, location.href)) {
      log.push(`自动发现签到页 ${pathWithSearch(target)}，准备跳转`);
      return { status: 'navigate', url: target };
    }
  }

  // 页面上没有签到入口链接，但站点配置里写了签到页地址 —— 用它。
  // 之前 method:'auto' 全程不读 cfg.url（只有 checkinByButton 读），
  // 于是 Sub2API 预设里的 '/check-in' 是个死配置：明明知道地址却不去。
  if (cfg?.url && isSameSiteUrl(site, cfg.url)) {
    const target = new URL(cfg.url, location.href).href;
    if (!samePageUrl(target, location.href)) {
      log.push(`按站点配置的签到页 ${pathWithSearch(target)} 跳转`);
      return { status: 'navigate', url: target };
    }
  }

  // 适配器可以提供一个默认签到入口。显式 checkin.url 和页面自动发现优先，
  // 这里只有前两者都没有命中时才使用家族兜底。
  const adapterFallback = adapterCheckinFallback(site);
  if (adapterFallback && !onCheckinPage && isSameSiteUrl(site, adapterFallback)) {
    const target = new URL(adapterFallback, location.href).href;
    if (new URL(target).pathname !== currentPath) {
      log.push(`按站点适配器进入默认签到页 ${pathWithSearch(target)}`);
      return { status: 'navigate', url: target };
    }
  }

  // 走到这里说明既没有可点的控件、也没有别处的签到入口。
  // 把页面上实际存在的可点元素列出来 —— 光说「没找到」帮不上忙，
  // 列出候选才能看出是词表没覆盖，还是这站真的没有签到功能。
  const candidates = checkinControls()
    .map((element) => controlText(element).replace(/\s+/g, ' ').trim())
    .filter((text) => text && text.length <= 20);
  const preview = [...new Set(candidates)].slice(0, 8);
  if (preview.length) {
    log.push(`页面可点元素：${preview.join(' / ')}`);
  } else {
    log.push('页面上没有可点元素，可能仍在加载或需要先展开某个面板');
  }

  return {
    status: 'failed',
    message: onCheckinPage ? '签到页未找到明确按钮或已签到状态' : '未自动发现同源签到入口',
  };
}

/**
 * 退出再登录式签到（如 Agent Router）。
 *
 * 本函数只负责「退出」这一步，退出成功后返回 relogin 状态，
 * 由引擎把 stage 推到 'relogin'，回到登录页重新走一遍登录流程。
 */
async function checkinByRelogin(
  site: SiteConfig,
  cfg: CheckinConfig,
  log: StepLog,
  hooks: CheckinHooks,
): Promise<CheckinOutcome> {
  // 这份快照必须在仍处于登录态时采。退出之后余额接口会变成 401；把 0 或 null
  // 当基线会让第二次登录后的任意余额都像一笔巨额签到奖励。
  const before = await captureBalance(site, log);
  if (before) {
    if (hooks.saveReloginBalanceBefore) await hooks.saveReloginBalanceBefore(before);
    else await hooks.saveBalance?.(before);
    log.push('已记录退出前余额，第二次登录后将按差额核对奖励');
  } else {
    log.push('退出前未能读取余额，第二次登录仍会刷新余额，但无法计算本次差额');
  }

  // 优先用退出接口，比点菜单稳
  if (cfg.logoutApiUrl) {
    if (!isSameSiteUrl(site, cfg.logoutApiUrl)) {
      return { status: 'failed', message: '退出接口不是本站地址，已拒绝请求' };
    }
    const url = new URL(cfg.logoutApiUrl, location.href).href;
    log.push(`请求退出接口 ${url}`);
    try {
      const headers: Record<string, string> = {};
      if (cfg.localStorageToken) Object.assign(headers, readLocalStorageToken(cfg.localStorageToken));
      const response = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers,
        redirect: 'error',
      });
      const text = (await response.text()).slice(0, 2000);
      const json = parseJsonRecord(text);
      const data = json ? asRecord(json.data) : null;
      const message = json ? responseMessage(json) : '';
      if (!response.ok) return { status: 'failed', message: `退出接口返回 HTTP ${response.status}` };
      if (json?.success === false || data?.success === false) {
        return { status: 'failed', message: message || '退出接口明确返回失败' };
      }
      log.push('退出接口调用成功');
    } catch (err) {
      return { status: 'failed', message: `退出接口失败: ${err instanceof Error ? err.message : String(err)}` };
    }
    clearLoginStorage(cfg, log);
    return { status: 'relogin', url: site.loginUrl, message: '已退出，准备重新登录' };
  }

  // 没有退出接口就点菜单
  if (cfg.logoutMenuSelector) {
    const initialMenu = await waitFor<HTMLElement>(cfg.logoutMenuSelector, 8_000);
    if (initialMenu) {
      if (!await passCheckinClickGate(hooks, log)) {
        return { status: 'failed', message: CHECKIN_CHALLENGE_MESSAGE };
      }
      const menu = await waitFor<HTMLElement>(cfg.logoutMenuSelector, 8_000);
      if (!menu) return { status: 'failed', message: '完成人机验证后找不到用户菜单' };
      const menuBlocker = await clearClickBlocker(menu, site, log, '用户菜单');
      if (menuBlocker) {
        return { status: 'failed', message: `用户菜单被${describeElement(menuBlocker)}遮挡，无法切换账号` };
      }
      await realClick(menu);
      log.push('已展开用户菜单');
      await sleep(600);
    } else {
      log.push(`未找到用户菜单: ${cfg.logoutMenuSelector}`);
    }
  }

  if (!cfg.logoutSelector) {
    return { status: 'failed', message: 'relogin 方式需要配置退出按钮选择器或退出接口' };
  }

  const initialButton = await waitFor<HTMLElement>(cfg.logoutSelector, 8_000);
  if (!initialButton) return { status: 'failed', message: `找不到退出按钮: ${cfg.logoutSelector}` };

  if (!await passCheckinClickGate(hooks, log)) {
    return { status: 'failed', message: CHECKIN_CHALLENGE_MESSAGE };
  }
  const btn = await waitFor<HTMLElement>(cfg.logoutSelector, 8_000);
  if (!btn) return { status: 'failed', message: `完成人机验证后找不到退出按钮: ${cfg.logoutSelector}` };

  const logoutBlocker = await clearClickBlocker(btn, site, log, '退出登录按钮');
  if (logoutBlocker) {
    return { status: 'failed', message: `退出登录按钮被${describeElement(logoutBlocker)}遮挡，无法切换账号` };
  }

  // 站点自己的退出按钮往往立刻跳转，会在我们落地进度之前销毁本脚本。
  // 所以先把「跳转后要重新登录」写进信箱，再点。
  log.push('准备点击退出登录（站点可能立即跳转）');
  await hooks.saveReloginStage?.();

  await realClick(btn, { mayNavigate: true });
  log.push('已点击退出登录');
  await sleep(1200);
  clearLoginStorage(cfg, log);

  return { status: 'relogin', url: site.loginUrl, message: '已退出，准备重新登录' };
}

/** 只清理站点配置明确指定的登录态，避免误删同源应用的其他数据。 */
function clearLoginStorage(cfg: CheckinConfig, log: StepLog): void {
  const keys = new Set(cfg.logoutStorageKeys ?? []);
  if (cfg.localStorageToken) {
    const eq = cfg.localStorageToken.indexOf('=');
    let keyPath = eq >= 0 ? cfg.localStorageToken.slice(eq + 1).trim() : '';
    // 「Authorization=Bearer auth_token」这种写法里，第一段是请求头前缀
    // 而不是 storage key —— 不剥掉就会去删一个叫 "Bearer" 的键，
    // 真正的 token 反而留在原地，导致退出后仍是登录态。
    const space = keyPath.search(/\s/);
    if (space > 0) keyPath = keyPath.slice(space + 1).trim();

    const storageKey = keyPath.split('.')[0]?.trim();
    if (storageKey) keys.add(storageKey);
  }

  let cleared = 0;
  for (const k of keys) {
    if (localStorage.getItem(k) != null) {
      localStorage.removeItem(k);
      cleared++;
    }
  }
  if (cleared) log.push(`已清除 ${cleared} 项本地登录态`);
}

/**
 * 从 localStorage 读取 token 拼成请求头。
 *
 * 支持三种写法：
 *   New-API-User=user.id            → 读 user 这个 JSON 的 id 字段
 *   Authorization=auth_token        → 直接读裸值
 *   Authorization=Bearer auth_token → 读裸值并加 "Bearer " 前缀
 *
 * 第三种是 Sub2API 系必需的：它的认证头是 `Authorization: Bearer <token>`，
 * 而 token 在 localStorage 里存的是不带前缀的裸值。之前只能产裸值，
 * 拼不出这个头，导致 Sub2API 的接口签到必然 401。
 */
function readLocalStorageToken(spec: string): Record<string, string> {
  try {
    const eq = spec.indexOf('=');
    if (eq <= 0) return {};
    const header = spec.slice(0, eq).trim();
    let keyPath = spec.slice(eq + 1).trim();
    if (!header || !keyPath) return {};

    // "Bearer xxx" / "Token xxx"：第一段是要加在值前面的前缀。
    //
    // 注意 keyPath 已经 trim 过，所以「Authorization=Bearer 」这种漏填
    // storage key 的写法在这里看起来就是单个词 "Bearer" —— 必须靠原始
    // spec 是否以空白结尾来识别，否则会把 "Bearer" 当成 storage key 去读。
    let prefix = '';
    const space = keyPath.search(/\s/);
    if (space > 0) {
      prefix = `${keyPath.slice(0, space).trim()} `;
      keyPath = keyPath.slice(space + 1).trim();
      if (!keyPath) return {};
    } else if (/\s$/.test(spec)) {
      // 只有前缀、没有 storage key
      return {};
    }

    const dot = keyPath.indexOf('.');
    const storageKey = dot === -1 ? keyPath : keyPath.slice(0, dot);
    const field = dot === -1 ? '' : keyPath.slice(dot + 1);

    const raw = localStorage.getItem(storageKey);
    if (!raw) return {};

    const value = field ? (JSON.parse(raw) as Record<string, unknown>)[field] : raw;
    if (value == null || value === '') return {};
    return { [header]: `${prefix}${String(value)}` };
  } catch {
    return {};
  }
}

/** 请求签到接口。同源请求会自动带上登录后的 cookie；new-api 系还需从 localStorage 读 token 加进头部。 */
async function checkinByApi(site: SiteConfig, cfg: CheckinConfig, log: StepLog): Promise<CheckinOutcome> {
  if (!cfg.apiUrl) return { status: 'failed', message: '签到方式为 api 但未填接口地址' };
  if (!isSameSiteUrl(site, cfg.apiUrl)) return { status: 'failed', message: '签到接口不是本站地址，已拒绝请求' };

  const url = new URL(cfg.apiUrl, location.href).href;
  const method = cfg.apiMethod ?? 'POST';
  log.push(`请求签到接口 ${method} ${url}`);

  const headers: Record<string, string> = cfg.apiBody ? { 'Content-Type': 'application/json' } : {};
  if (cfg.localStorageToken) {
    const extra = readLocalStorageToken(cfg.localStorageToken);
    Object.assign(headers, extra);
    const names = Object.keys(extra);
    log.push(names.length ? `已附加请求头 ${names.join(', ')}` : `未能从 localStorage 读到 token（${cfg.localStorageToken}）`);
  }

  try {
    const resp = await fetch(url, {
      method,
      credentials: 'include',
      headers,
      body: method === 'GET' ? undefined : (cfg.apiBody ?? undefined),
      redirect: 'error',
    });
    const text = (await resp.text()).slice(0, 2000);
    log.push(`签到接口返回 HTTP ${resp.status}`);

    // JSON must be interpreted structurally before text matching. Otherwise
    // {"success":false} and {"already":false} are false positives.
    const json = parseJsonRecord(text);
    if (json) {
      const data = asRecord(json.data);
      const message = responseMessage(json);

      if (!resp.ok) {
        return { status: 'failed', message: message || `签到接口返回 ${resp.status}` };
      }
      if (json.success === false || data?.success === false) {
        return { status: 'failed', message: message || '签到接口明确返回失败' };
      }
      if (json.already === true || data?.already === true || hit(message, cfg.alreadyText?.length ? cfg.alreadyText : ALREADY_WORDS)) {
        return { status: 'already', message: message || '接口提示今日已签到' };
      }
      if (json.success === true || data?.success === true || json.code === 0 || json.ret === 1) {
        return { status: 'success', message: '接口返回成功标志' };
      }
      if (hit(message, cfg.successText?.length ? cfg.successText : SUCCESS_WORDS)) {
        return { status: 'success', message };
      }
    } else if (!resp.ok) {
      return { status: 'failed', message: `签到接口返回 ${resp.status}` };
    }

    if (isHtmlResponse(resp, text)) {
      return { status: 'failed', message: '签到接口返回 HTML 页面，可能登录状态已失效' };
    }
    if (!json && hit(text, cfg.alreadyText?.length ? cfg.alreadyText : ALREADY_WORDS)) {
      return { status: 'already', message: '接口提示今日已签到' };
    }
    if (!json && hit(text, cfg.successText?.length ? cfg.successText : SUCCESS_WORDS)) {
      return { status: 'success', message: '接口返回签到成功' };
    }
    return { status: 'failed', message: '接口响应缺少可识别的成功或已签到标志' };
  } catch (err) {
    return { status: 'failed', message: `签到请求失败: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * 等签到按钮出现**并且可点**。
 *
 * 为什么不能直接用 waitFor：它返回第一个匹配选择器的元素，不看是否可点。
 * SPA 常先把按钮渲染成禁用（还在拉签到状态），几百毫秒后接口回来才放开。
 * waitFor 在 200ms 的第一轮就把那个禁用实例拿走了，于是禁用判据立刻命中，
 * 报「签到按钮已禁用，但没有明确的已签到标志」—— 而其实再等一会儿就能点。
 *
 * 中途出现「已签到」文案就提前收工：那说明今天确实签过，不必等满。
 */
async function waitForEnabledButton(
  selector: string,
  alreadyWords: string[],
  log: StepLog,
): Promise<{ button: HTMLElement | null }> {
  const deadline = Date.now() + CHECKIN_WAIT_ON_PAGE_MS;
  let lastSeen: HTMLElement | null = null;
  let loggedWait = false;

  for (;;) {
    const button = queryFirst<HTMLElement>(selector);
    if (button) {
      lastSeen = button;
      if (!controlDisabled(button)) return { button };

      // 禁用且已经写着「已签到」，就是终态，不用再等
      if (hit((button.innerText || button.textContent || '').trim(), alreadyWords)) {
        return { button };
      }
      if (!loggedWait) {
        log.push('签到按钮当前不可点，等待站点加载签到状态…');
        loggedWait = true;
      }
    }
    if (Date.now() >= deadline) return { button: lastSeen };
    await sleep(CHECKIN_POLL_INTERVAL_MS);
  }
}

/** 在页面上点签到按钮 */
async function checkinByButton(
  site: SiteConfig,
  cfg: CheckinConfig,
  log: StepLog,
  hooks: CheckinHooks,
  balanceBefore: NonNullable<Awaited<ReturnType<typeof captureBalance>>> | null,
): Promise<CheckinOutcome> {
  if (!cfg.buttonSelector) return { status: 'failed', message: '签到方式为 button 但未填按钮选择器' };

  // 签到按钮不在当前页 → 先让 content script 导航过去
  if (cfg.url) {
    if (!isSameSiteUrl(site, cfg.url)) return { status: 'failed', message: '签到页面不是本站地址，已停止跳转' };
    const target = new URL(cfg.url, location.href).href;
    const entryReady = cfg.entry?.readySelector
      ? !!queryFirst(cfg.entry.readySelector)
      : false;
    if (!entryReady && !isCurrentCheckinPage(site, cfg)) {
      log.push(`签到页在 ${target}，准备跳转`);
      return { status: 'navigate', url: target };
    }
  }

  // 先看是不是已经签过了
  const alreadySel = cfg.alreadySelector;
  if (alreadySel && queryFirst(alreadySel)) {
    log.push('命中「已签到」标志，本次不重复点击');
    return { status: 'already', message: '页面显示今日已签到' };
  }

  const alreadyWords = cfg.alreadyText?.length ? cfg.alreadyText : ALREADY_WORDS;
  const successWords = cfg.successText?.length ? cfg.successText : SUCCESS_WORDS;

  // Turnstile/复选框/滑块可能阻止签到按钮出现或变为可用，所以初次等待控件前
  // 先走统一挑战模块；找到按钮后仍保留下面的点击前二次检查与 DOM 重定位。
  if (!await passCheckinClickGate(hooks, log)) {
    return { status: 'failed', message: CHECKIN_CHALLENGE_MESSAGE };
  }

  const found = await waitForEnabledButton(cfg.buttonSelector, alreadyWords, log);
  if (!found.button) {
    // 按钮找不到时，若页面文本已含「已签到」也算过了
    const bodyText = document.body?.innerText ?? '';
    if (hit(bodyText, alreadyWords)) {
      log.push('未找到签到按钮，但页面文本显示已签到');
      return { status: 'already', message: '页面文本显示今日已签到' };
    }
    return { status: 'failed', message: `找不到签到按钮: ${cfg.buttonSelector}` };
  }

  if (!await passCheckinClickGate(hooks, log)) {
    return { status: 'failed', message: CHECKIN_CHALLENGE_MESSAGE };
  }

  // 验证完成可能触发整张签到卡重绘；不能继续点击验证前保存的节点。
  const refreshed = hooks.beforeCheckinClick
    ? await waitForEnabledButton(cfg.buttonSelector, alreadyWords, log)
    : found;
  if (!refreshed.button) {
    if ((alreadySel && queryFirst(alreadySel)) || hit(document.body?.innerText ?? '', alreadyWords)) {
      return { status: 'already', message: '完成人机验证后页面显示今日已签到' };
    }
    return { status: 'failed', message: `完成人机验证后找不到签到按钮: ${cfg.buttonSelector}` };
  }

  const btn = refreshed.button;
  // 正文快照必须在等按钮可点**之后**再取：这段等待里 SPA 可能刚把签到卡渲染完，
  // 用等待前的旧正文当基线，会把卡片自带的文案误当成「点击后新出现的」。
  const before = document.body?.innerText ?? '';

  // 禁用态本身不是已签到证据，登录失效或页面初始化失败也可能禁用按钮。
  //
  // ⚠️ 判据必须用 controlDisabled，不能写 className.includes('disabled')：
  // 新版界面用 Tailwind，签到按钮身上常挂着 `disabled:opacity-50`
  // 这类**变体**类名 —— 它描述的是「禁用时长什么样」，不是当前就禁用了。
  // 字符串包含判断会把可点的按钮判成禁用，于是一次能签的签到被报成
  // 「签到按钮已禁用，但没有明确的已签到标志」。controlDisabled 会剔掉
  // 带 `:` 的变体类名，这也是 auto 模式一直没踩到这个坑的原因。
  if (controlDisabled(btn)) {
    const buttonText = (btn.innerText || btn.textContent || '').trim();
    if (hit(buttonText, alreadyWords) || hit(before, alreadyWords)) {
      log.push('签到按钮处于禁用态，且页面有明确已签到文案');
      return { status: 'already', message: '页面显示今日已签到' };
    }
    return { status: 'failed', message: '签到按钮已禁用，但没有明确的已签到标志' };
  }

  const hadSuccessText = hit(before, successWords);
  const hadAlreadyText = hit(before, alreadyWords);
  const hadSuccessSelector = cfg.successSelector ? Boolean(queryFirst(cfg.successSelector)) : false;

  // 同 auto 模式：遮罩挡不住 el.click()，不检查就会产生假的成功记录。
  // 被遮挡时先主动关一次公告（多半是延迟弹出、没被登录后那次关掉的）再点。
  const stillBlocking = await clearClickBlocker(btn, site, log);
  if (stillBlocking) {
    return {
      status: 'failed',
      message: `签到按钮被${describeElement(stillBlocking)}遮挡，可能有未关闭的公告弹窗`,
    };
  }

  // 普通 POST 表单会在点击后立刻卸载 content script。必须等后台确认基线已经
  // 写入 task context，再允许真实点击；否则新文档只能读到签到后的余额。
  if (balanceBefore && hooks.saveButtonBalanceBefore) {
    await hooks.saveButtonBalanceBefore(balanceBefore);
    log.push('已保存签到按钮点击前的余额基线');
  }
  await realClick(btn, { mayNavigate: true, reconcileAfterLostResponse: true });
  log.push('已点击签到按钮');

  if (hooks.afterCheckinClick && !await hooks.afterCheckinClick()) {
    return { status: 'failed', message: '签到点击后的安全验证未完成' };
  }

  // 等明确的成功或已签到标志。按钮消失本身不是成功证据：导航、重渲染、
  // 弹窗关闭都会让节点消失，但这些动作未必向服务端提交了签到请求。
  // 将原本单独等待成功选择器的 10 秒也纳入轮询，避免这段时间漏掉新验证码。
  const waitForSuccessSelector = !!cfg.successSelector && !hadSuccessSelector;
  let deadline = Date.now() + (waitForSuccessSelector ? 18_000 : 8_000);
  // 与 auto 模式同一判据：站点写出的失败原因要带到结论里，否则一次偶发
  // 5xx 无法被归类成「值得重试」，用户看到的是当天永久失败。
  let declaredFailure: string | null = null;
  while (Date.now() < deadline) {
    await sleep(400);
    const challenge = await waitForPendingCheckinChallenge(hooks);
    if (!challenge.resolved) {
      return { status: 'failed', message: '签到点击后的安全验证未完成' };
    }
    deadline += challenge.pauseMs;
    const now = document.body?.innerText ?? '';
    declaredFailure = failureReasonIn(now) ?? declaredFailure;
    if (waitForSuccessSelector && cfg.successSelector && queryFirst(cfg.successSelector)) {
      return { status: 'success', message: '命中签到成功标志' };
    }
    if (!hadSuccessText && hit(now, successWords)) {
      return { status: 'success', message: '页面出现签到成功提示' };
    }
    if (!hadAlreadyText && hit(now, alreadyWords)) {
      // 这段在 realClick 之后；新出现的已签到文案是本轮动作的终态，不能
      // 返回 already 再被外层按“本轮没有点击”清掉余额差分。
      return { status: 'success', message: '点击后页面提示今日已签到' };
    }
    if (alreadySel && queryFirst(alreadySel)) {
      return { status: 'success', message: '点击后出现已签到状态' };
    }
  }

  return declaredFailure
    ? { status: 'failed', message: `站点确认签到失败：${declaredFailure}` }
    : { status: 'failed', message: '点击签到后未检测到明确结果，请手动确认' };
}

/**
 * claim 方式默认填的文本。
 *
 * 站点要求写一段话（≥10 字）才发权益，但用户往往只想「点一下就领到」，
 * 不会去填 claimText。给一句语义中性、不冒充用户观点的默认值：
 * 它只是满足字数门槛，不替用户表达任何评价。
 */
const CLAIM_DEFAULT_TEXT = '感谢提供服务，日常使用体验良好，继续保持。';

// 「理由不能与历史重复」的候选池与选取逻辑见 claim-text.ts（纯函数，单独单测）


/**
 * 多步领取式签到（如 chaiai 的「领取权益」）。
 *
 * 流程是 点入口 → 弹出输入框 → 填一段不少于 N 字的文本 → 点提交。
 * 与 button 方式的区别在于中间那一步必须填内容，站点会拒收空值或太短的文本。
 *
 * ⚠️ 用户最初的诉求是「取坐标、模拟鼠标点」。这里刻意不那么做：
 * realClick 走的是 el.click()，事件直接派发到目标元素上，不经过坐标命中，
 * 因此不受滚动位置、窗口大小、页面缩放影响；而按屏幕坐标点击需要 CDP 或
 * 系统级注入，扩展权限根本拿不到。用选择器表达同一个流程更稳也更可移植。
 */
async function checkinByClaim(
  site: SiteConfig,
  cfg: CheckinConfig,
  log: StepLog,
  hooks: CheckinHooks,
): Promise<CheckinOutcome> {
  if (!cfg.claimEntrySelector) return { status: 'failed', message: '签到方式为 claim 但未填领取入口选择器' };
  if (!cfg.claimInputSelector) return { status: 'failed', message: '签到方式为 claim 但未填输入框选择器' };
  if (!cfg.claimSubmitSelector) return { status: 'failed', message: '签到方式为 claim 但未填提交按钮选择器' };

  // 领取入口通常在控制台而不是登录后的落地页 → 先导航过去
  if (cfg.url) {
    if (!isSameSiteUrl(site, cfg.url)) return { status: 'failed', message: '领取页面不是本站地址，已停止跳转' };
    const target = new URL(cfg.url, location.href).href;
    const currentUrl = new URL(location.href);
    const targetUrl = new URL(target);
    /**
     * hash 路由必须比较 hash：sharedchat 的登录页是 `/list/#/login`，
     * 权益页是 `/list/#/vibe-code/dashboard?...`，两者 pathname 都是 `/list/`。
     * 旧代码先把 `#...` 截掉再 startsWith，导致它们被误判为同一页，
     * 自动化留在登录页上找「领取权益」按钮，当然永远找不到。
     */
    const alreadyAtTarget = targetUrl.hash
      ? currentUrl.origin === targetUrl.origin
        && currentUrl.pathname === targetUrl.pathname
        && currentUrl.search === targetUrl.search
        && currentUrl.hash === targetUrl.hash
      : currentUrl.href.replace(/#.*$/, '').startsWith(targetUrl.href.replace(/#.*$/, ''));
    if (!alreadyAtTarget) {
      log.push(`领取入口在 ${target}，准备跳转`);
      return { status: 'navigate', url: target };
    }
  }

  const alreadyWords = cfg.alreadyText?.length ? cfg.alreadyText : ALREADY_WORDS;
  const successWords = cfg.successText?.length ? cfg.successText : SUCCESS_WORDS;
  const claimsExpired = (text: string) => /已过期|expired/i.test(text);

  // 已经领过就别再走一遍：重复提交会让站点回「今日已领取」，
  // 把干净的 already 变成一次多余的写操作。
  if (cfg.alreadySelector && queryFirst(cfg.alreadySelector)) {
    log.push('命中「已领取」标志');
    return { status: 'already', message: '页面显示权益已领取' };
  }
  const initialBodyText = document.body?.innerText ?? '';
  if (hit(initialBodyText, alreadyWords)) {
    log.push('页面正文显示权益已领取');
    return { status: 'already', message: '页面显示权益已领取' };
  }
  /**
   * 有些站点不会显示「已领取」，而是把套餐状态改成「生效中」（SharedChat）。
   * 这是比按钮消失更强的成功证据：领取成功后入口按钮本来就会消失，若不先判
   * 这条，后面必然报「找不到领取入口」并触发无意义重试。
   */
  if (!claimsExpired(initialBodyText) && hit(initialBodyText, successWords)) {
    log.push('页面正文显示权益已生效，无需重复领取');
    return { status: 'already', message: '页面显示权益已生效' };
  }
  if (claimsExpired(initialBodyText)) {
    log.push('套餐仍显示已过期，不能按“已领取”文案判定成功');
  }

  // 弹窗可能本来就开着（站点自动弹出，或上一轮导航后仍在）。
  // 这时再点入口会把它切回关闭态，输入框反而消失。
  let input = queryFirst<HTMLInputElement | HTMLTextAreaElement>(cfg.claimInputSelector);
  if (input) {
    log.push('领取弹窗已经打开，跳过点击入口');
  } else {
    const initialEntry = await waitFor<HTMLElement>(cfg.claimEntrySelector, 12_000);
    if (!initialEntry) return { status: 'failed', message: `找不到领取入口: ${cfg.claimEntrySelector}` };

    if (!await passCheckinClickGate(hooks, log)) {
      return { status: 'failed', message: CHECKIN_CHALLENGE_MESSAGE };
    }
    const entry = await waitFor<HTMLElement>(cfg.claimEntrySelector, 12_000);
    if (!entry) return { status: 'failed', message: `完成人机验证后找不到领取入口: ${cfg.claimEntrySelector}` };

    // 同 button 方式：遮罩挡不住 el.click()，不查就会「点开了」但弹窗没弹出来。
    // 被遮挡时先主动关一次公告再点。
    const entryStillBlocking = await clearClickBlocker(entry, site, log);
    if (entryStillBlocking) {
      return {
        status: 'failed',
        message: `领取入口被${describeElement(entryStillBlocking)}遮挡，可能有未关闭的公告弹窗`,
      };
    }

    await realClick(entry);
    log.push('已点击领取入口，等待弹窗');

    input = await waitFor<HTMLInputElement | HTMLTextAreaElement>(cfg.claimInputSelector, 10_000);
    if (!input) return { status: 'failed', message: `领取弹窗未出现输入框: ${cfg.claimInputSelector}` };
  }

  const minLength = cfg.claimMinLength ?? CLAIM_MIN_LENGTH_DEFAULT;

  // 站点要求理由不能与历史重复时，用户填的固定 claimText 只能用一次，
  // 第二次必然被拒 —— 所以这类站点从候选池里挑没用过的那条。
  let text: string;
  if (cfg.claimUniqueText && !cfg.claimText?.trim()) {
    const picked = pickUnusedClaimText(cfg.claimUsedTexts, minLength);
    text = picked.text;
    if (picked.exhausted) {
      log.push(`预置领取理由已全部用过（${cfg.claimUsedTexts?.length ?? 0} 条），本次可能因重复被拒`);
    }
  } else {
    text = cfg.claimText?.trim() || CLAIM_DEFAULT_TEXT;
  }

  // 字数不够直接失败，**不自动补齐**：凑长度等于替用户往站点提交
  // 一段他没写过的话，而这段话会公开显示在站点上。
  if (text.length < minLength) {
    return {
      status: 'failed',
      message: `领取文本太短：站点要求至少 ${minLength} 字，当前 ${text.length} 字`,
    };
  }

  if (!await passCheckinClickGate(hooks, log)) {
    return { status: 'failed', message: CHECKIN_CHALLENGE_MESSAGE };
  }
  input = await waitFor<HTMLInputElement | HTMLTextAreaElement>(cfg.claimInputSelector, 8_000);
  if (!input) {
    return { status: 'failed', message: `完成人机验证后找不到领取输入框: ${cfg.claimInputSelector}` };
  }

  // 必须走 setNativeValue：直接赋 .value 改不动 React 的内部 state，
  // 提交时站点收到的是空值（见 dom-utils.ts 里那段注释）
  setNativeValue(input, text);
  // 只记字数不记内容：claimText 由用户填写，可能含隐私
  log.push(`已填入领取文本（${text.length} 字）`);
  await sleep(300);

  const initialSubmit = await waitFor<HTMLElement>(cfg.claimSubmitSelector, 8_000);
  if (!initialSubmit) return { status: 'failed', message: `找不到领取提交按钮: ${cfg.claimSubmitSelector}` };

  if (!await passCheckinClickGate(hooks, log)) {
    return { status: 'failed', message: CHECKIN_CHALLENGE_MESSAGE };
  }

  const submit = hooks.beforeCheckinClick
    ? await waitFor<HTMLElement>(cfg.claimSubmitSelector, 8_000)
    : initialSubmit;
  if (!submit) {
    return { status: 'failed', message: `完成人机验证后找不到领取提交按钮: ${cfg.claimSubmitSelector}` };
  }
  if (controlDisabled(submit)) {
    return { status: 'failed', message: '完成人机验证后领取提交按钮仍不可点击' };
  }

  const before = document.body?.innerText ?? '';
  const hadSuccessText = hit(before, successWords);
  const hadAlreadyText = hit(before, alreadyWords);
  const hadSuccessSelector = cfg.successSelector ? Boolean(queryFirst(cfg.successSelector)) : false;

  const submitStillBlocking = await clearClickBlocker(submit, site, log);
  if (submitStillBlocking) {
    return {
      status: 'failed',
      message: `领取按钮被${describeElement(submitStillBlocking)}遮挡，可能有未关闭的公告弹窗`,
    };
  }

  await realClick(submit, { mayNavigate: true });
  log.push('已点击领取按钮');

  // 只有用了候选池才需要回传，用户自填的固定文本不必记录
  const usedText = cfg.claimUniqueText && !cfg.claimText?.trim() ? text : undefined;

  if (cfg.successSelector && !hadSuccessSelector) {
    const ok = await waitFor(cfg.successSelector, 10_000);
    if (ok) return { status: 'success', message: '命中领取成功标志', claimTextUsed: usedText };
  }

  const deadline = Date.now() + 10_000;
  let dialogClosedAt: number | null = null;
  while (Date.now() < deadline) {
    await sleep(400);
    const now = document.body?.innerText ?? '';
    if (!claimsExpired(now) && !hadSuccessText && hit(now, successWords)) {
      return { status: 'success', message: '页面出现领取成功提示', claimTextUsed: usedText };
    }
    if (!claimsExpired(now) && !hadAlreadyText && hit(now, alreadyWords)) {
      return { status: 'already', message: '页面提示权益已领取或已生效', claimTextUsed: usedText };
    }
    if (claimsExpired(now)) {
      // 已过期套餐不能通过“弹窗关闭”这类弱证据变成功，继续等明确状态或最终失败。
      dialogClosedAt = null;
    }
    // 站点明确拒绝重复理由时立刻停手，并把这条记为已用过，
    // 免得下一轮又挑到它。
    if (/重复|已使用过|不能和之前/.test(now) && now !== before) {
      return {
        status: 'failed',
        message: '站点提示领取理由与历史重复，已记录该理由避免重用',
        claimTextUsed: usedText,
      };
    }

    /**
     * 输入框消失只说明弹窗关了，不足以证明服务端接受：取消、报错后自动关窗
     * 都会满足。先记时间，再给 SPA 2 秒刷新套餐卡片，优先等「生效中/已领取」
     * 这类强证据。2 秒后页面确实变化了才降级为成功。
     */
    if (!queryFirst(cfg.claimInputSelector)) {
      dialogClosedAt ??= Date.now();
      if (Date.now() - dialogClosedAt >= 2_000 && now !== before) {
        return { status: 'success', message: '领取弹窗关闭，且套餐页面已更新', claimTextUsed: usedText };
      }
    } else {
      dialogClosedAt = null;
    }
  }

  return { status: 'failed', message: '提交领取后未检测到明确结果，请手动确认' };
}

