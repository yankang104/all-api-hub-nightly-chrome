import {
  hasObjectiveChallengeEvidence,
  waitForChallenge,
  type ChallengeResolution,
} from '@/automation/challenge/challenge';
import {
  findChallengeRevealCandidates,
  revealOffscreenChallengeCandidates,
} from '@/automation/challenge/challenge-click';
import { getActiveClickRunId, isVisible, sleep } from '@/automation/shared/dom-utils';
import type { StepLog } from '@/automation/shared/log';

const CONTROL_READY_WAIT_MS = 30_000;
const CONTROL_READY_POLL_MS = 1_000;
const SNAPSHOT_POLL_MS = 250;
/**
 * 快照窗口的上限。
 *
 * 调用方按场景传入（点击后 2.5 秒，结果轮询 0 秒），这里只封顶：误传一个大值
 * 就会把快照重新变回「无条件长等待」，而那正是本文件要修掉的问题。
 */
const SNAPSHOT_MAX_WAIT_MS = 2_500;
const SLIDER_FAILURE_PREFIX = '滑块自动求解未通过页面确认：';

/**
 * 快照里「先滚再判」能花掉的时间上限：1 秒量级。
 *
 * 必须远小于快照窗口本身：滚动只是为了让懒渲染的验证控件真正渲染出来，
 * 不是为了等它。给多了就等于把刚修好的「有界快照」又变回「长时间不动」。
 */
const SNAPSHOT_REVEAL_BUDGET_MS = 1_000;

// 兼容现有求解器的控件采集结果。只接受这些明确的未就绪原因；取图、匹配、
// 拖动、页面拒绝和未知错误均不能据此重试，更不能重新获得一轮拖动机会。
const CONTROL_NOT_READY_ERRORS = new Set([
  '当前验证码文档未找到可接收拖动的滑块把手（可能仍在加载或被遮挡）',
  '已找到滑块把手，但尚未找到它所属的验证码面板',
  '已找到验证码面板和把手，但没有匹配的滑动轨道',
  '已找到滑块把手和轨道，但验证码背景图片尚未就绪',
  '验证码组件仍在重绘，尚未取得同一挑战的完整滑块控件',
  '验证码图片还没有加载完成，未执行拖动',
  '验证码布局在等待时间内没有稳定，未使用动画中的坐标拖动',
  '没有找到同时满足把手、轨道和背景几何关系的滑块控件',
  '检测到滑动挑战，但页面没有暴露可安全拖动的 DOM 控件',
]);

function isControlReadinessLog(message: string): boolean {
  const reason = message.startsWith(SLIDER_FAILURE_PREFIX)
    ? message.slice(SLIDER_FAILURE_PREFIX.length)
    : message;
  return CONTROL_NOT_READY_ERRORS.has(reason);
}

/**
 * 签到点击后的**有界快照**：这次点击到底有没有触发验证？
 *
 * 只有出现客观验证证据或可见的验证输入框才返回 true。通用验证判据与
 * `waitForChallenge` 共用，额外识别的输入框由本调度器持续观察。窗口内持续
 * 观察，所以「验证码外壳已挂载、内部控件还在加载」的中间态
 * 也能在这一窗口里等到控件出现；窗口一到就返回 false，把「没有验证」如实还给
 * 业务层。
 *
 * 为什么必须有这一步：原实现点击后无条件打印「开始等待本次签到触发的安全验证」
 * 并直接进长流程，只要页面上有任何一个可见的 captcha 命名元素（说明性文案、预挂
 * 载空壳、上一轮留下的外壳）就会被判成正在验证，任务白等到统一超时、甚至先弹一个
 * 「请手动完成验证」—— 用户报告的原话就是「这个有的没有认证，就会一直等待」。
 * 漏判的代价是稍后结果轮询还会再快照一次（轮询一直在跑），误判的代价是整轮白等。
 *
 * **先滚再判（本轮修复）**：快照之前先确认验证码控件是不是挂在**当前视口下方**，
 * 是就先温和地滚一次再重新判定。
 *   - 用户原话：「这个不应该滑动页面再快照吗？」—— 站点常把验证控件放在首屏之下，
 *     靠 `content-visibility: auto` 或 IntersectionObserver 懒挂载；没滚到之前它
 *     宽高为 0，任何基于尺寸的可见性判据都会如实报「看不见」，于是**真实存在的**
 *     验证码被漏判成「本次点击没有触发验证」，任务带着未完成的验证继续往下跑。
 *   - 反向错误同样必须避免：把「视口外」直接当成「不可见」会漏掉懒渲染的验证码，
 *     所以这里的行为是「滚一下再重新判定」，**不是**「不在视口就返回 null」。
 *   - 有界且可回退：滚动最多 2 次、总耗时 1 秒量级（`challenge-click.ts` 的
 *     `revealOffscreenChallengeCandidates` 里的具名常量），一次都不越过本轮快照
 *     窗口；页面滚不动时立即放弃。没有视口外候选时是零开销的一次扫描。
 *
 * 为什么不会漏放真验证码：滚动本身不产生「有/没有验证」的结论 —— 结论仍然只由
 * `hasObjectiveChallengeEvidence`（唯一判据）在滚动**之后**重新采样得出。因此
 * 「滚动没成功」只会退回修复前的行为（保守地继续看窗口/留给结果轮询），
 * 而「滚动成功」只可能把原本看不到的真实验证码**补判**进来。
 */
/**
 * 读取输入控件附近文案。只做布尔匹配，不把任何页面文字带回调用方。
 */
function closestText(element: Element, pattern: RegExp): boolean {
  let current: Element | null = element;
  while (current) {
    const text = [
      current.getAttribute?.('aria-label') ?? '',
      current.textContent ?? '',
    ].join(' ');
    if (pattern.test(text)) return true;
    current = current.parentElement;
  }
  return false;
}

/**
 * 是否存在验证码 / OTP / 二次验证输入控件；识别结果不决定任务是否转人工。
 *
 * 与 `login/steps.ts` 的 `MANUAL_LOGIN_SELECTORS` 同源，但这里只保留必要且
 * 保守的最小副本；改一处要同步另一处。刻意不直接 import：login 属于登录流程，
 * challenge 是签到兜底层，反向依赖会让登录实现耦合进签到验证。只回布尔，不读值、
 * 不返回选择器或页面文字。
 *   1) 明确的一次性验证码控件；
 *   2) OTP/TOTP/MFA/2FA 命名控件；
 *   3) code 控件 + 验证码文案，或数字输入 + 发送验证码/邮箱验证动作。
 */
export function detectCheckinManualChallenge(): boolean {
  const current = document;
  const manualSelectors = [
    'input[autocomplete="one-time-code"]',
    'input[name*="otp" i]',
    'input[id*="otp" i]',
    'input[name*="totp" i]',
    'input[id*="totp" i]',
    'input[name*="mfa" i]',
    'input[id*="mfa" i]',
    'input[name*="2fa" i]',
    'input[id*="2fa" i]',
  ];

  // jsdom 不会把 display:none 级联到子元素；生产浏览器会。为保持跨环境保守一致，
  // 对普通输入树额外要求每个元素自身也不是 display:none。
  const hasInlineHidden = (element: Element): boolean => {
    let current: Element | null = element;
    while (current) {
      const display = window.getComputedStyle(current as HTMLElement).display;
      if (display === 'none') return true;
      current = current.parentElement;
    }
    return false;
  };

  const isVisibleInput = (element: Element): boolean => !hasInlineHidden(element) && isVisible(element);
  if (manualSelectors.some((selector) =>
    [...current.querySelectorAll<HTMLInputElement>(selector)].some(isVisibleInput))) return true;

  const verificationText = /(?:验证码|校验码|动态码|verification code|二次验证)/i;
  const sendCodeText = /(?:发送验证码|邮箱验证)/i;

  for (const input of current.querySelectorAll('input[name*="code" i]')) {
    if (input instanceof HTMLInputElement && isVisibleInput(input) && closestText(input, verificationText)) return true;
  }
  for (const input of current.querySelectorAll('input[inputmode="numeric" i]')) {
    if (input instanceof HTMLInputElement && isVisibleInput(input) && closestText(input, sendCodeText)) return true;
  }
  return false;
}

async function waitForCheckinEvidence(windowMs: number): Promise<boolean> {
  const deadline = Date.now() + windowMs;
  const revealBudgetMs = Math.min(SNAPSHOT_REVEAL_BUDGET_MS, windowMs);

  // 视口外候选只滚一次；滚完重新判定前再采一次，避免在滚动后的新布局上重复滚动。
  let revealDone = false;
  while (true) {
    if (hasObjectiveChallengeEvidence(false) || detectCheckinManualChallenge()) return true;

    if (!revealDone) {
      revealDone = true;
      if (revealBudgetMs > 0) {
        await revealOffscreenChallengeCandidates(findChallengeRevealCandidates(), {
          budgetMs: Math.min(revealBudgetMs, Math.max(0, deadline - Date.now())),
        });
        // 滚动只是让页面把懒渲染的验证控件画出来，判据仍交给下一轮循环里的
        // `hasObjectiveChallengeEvidence` —— 这里不下任何「有没有验证」的结论。
        if (hasObjectiveChallengeEvidence(false) || detectCheckinManualChallenge()) return true;
      }
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await sleep(Math.min(SNAPSHOT_POLL_MS, remaining));
  }
}

/** 签到专用的就绪阶段：控件没挂载完时保留本次点击，不改现有滑块求解逻辑。 */
export async function waitForCheckinChallenge(
  log: StepLog,
  onNeedsUser: (message: string) => Promise<void>,
  timeoutMs: number,
  appearanceWaitMs = 0,
): Promise<ChallengeResolution> {
  const runId = getActiveClickRunId();
  const snapshotWindowMs = Math.min(Math.max(0, appearanceWaitMs), SNAPSHOT_MAX_WAIT_MS);

  // 先快照，再决定要不要进长流程。没有客观证据就立即按「本次点击没有触发验证」
  // 返回，业务层继续核对签到结果；真验证出现时后面的轮询还会再快照一次。
  if (!await waitForCheckinEvidence(snapshotWindowMs)) {
    if (getActiveClickRunId() !== runId) {
      return { detected: false, resolved: false, error: '签到任务已停止' };
    }
    // 只在点击后那次带窗口的调用里记录：结果轮询每 400ms 调一次，逐次打印会把
    // 日志刷满。
    //
    // 措辞注意：这是在报告**否定结论**（没有验证要求）。诊断分类器对这类
    // 句子有专门的排除规则（diagnostics.ts 的 NON_SYMPTOM_PATTERNS），
    // 否则「安全验证」四个字会把站点偶发 5xx 染成「需要人工处理」——
    // 那一类不可重试，站点抖一下就成了当天永久失败。
    if (snapshotWindowMs > 0) {
      log.push('签到点击后未发现安全验证证据，继续核对本次签到结果');
    }
    return { detected: false, resolved: true };
  }
  if (snapshotWindowMs > 0) {
    // 只在**真的**探测到验证证据时写这行。措辞要让诊断分类器把它读成
    // 「需要人工处理」的症状（MANUAL_REQUIRED 的「安全验证」触发词），
    // 与上一段那句否定结论成对：一句是「要验证」，一句是「没验证」。
    log.push('签到点击后检测到安全验证，开始等待本次签到触发的安全验证');
  }

  let readyDeadline = 0;
  const verificationDeadline = Date.now() + timeoutMs;
  let waitingForControls = false;
  let waitingForVerificationInput = false;
  let lastPending: ChallengeResolution | undefined;

  while (true) {
    if (getActiveClickRunId() !== runId) {
      return { detected: !!lastPending || waitingForVerificationInput, resolved: false, kind: lastPending?.kind, error: '签到任务已停止' };
    }
    if (lastPending && Date.now() >= readyDeadline) {
      return {
        ...lastPending,
        error: `签到滑块控件就绪等待期结束，尚未开始拖动：${lastPending.error}。控件可能未加载、被遮挡或不受当前识别器支持`,
      };
    }

    const readinessLogs: string[] = [];
    // 暂存“未找到把手”这类过渡日志。真实求解日志仍实时转发，不把控件加载中
    // 连续打印成多次验证失败；只有确实不能继续时才向业务层返回失败。
    const dispatchLog: StepLog = {
      push(message) {
        if (isControlReadinessLog(message)) readinessLogs.push(message);
        else log.push(message);
      },
    };
    const challenge = await waitForChallenge(dispatchLog, onNeedsUser, timeoutMs, {
      includePendingResponse: false,
      appearanceWaitMs: waitingForControls || waitingForVerificationInput ? 0 : appearanceWaitMs,
    });
    if (getActiveClickRunId() !== runId) {
      return { detected: challenge.detected || !!lastPending, resolved: false, kind: challenge.kind, error: '签到任务已停止' };
    }

    const controlsPending = challenge.kind === 'Slider' && !challenge.resolved
      && challenge.sliderAttemptStarted === false
      && CONTROL_NOT_READY_ERRORS.has(challenge.error ?? '');
    if (!controlsPending) {
      lastPending = undefined;
      // 验证输入框可能晚于快照、或在其它验证结束后出现。保留本次调用继续观察，
      // 不发送新增的人工接管信号，也不能把求解器未识别的输入框当成已验证。
      if (challenge.resolved && detectCheckinManualChallenge()) {
        if (!waitingForVerificationInput) log.push('签到流程检测到验证码/二次验证控件，继续观察当前验证状态');
        waitingForVerificationInput = true;
        const remaining = verificationDeadline - Date.now();
        if (remaining <= 0) {
          return { detected: true, resolved: false, kind: 'VerificationCode', error: '签到验证码/二次验证未在等待时间内结束' };
        }
        await sleep(Math.min(SNAPSHOT_POLL_MS, remaining));
        continue;
      }
      // 调度器可能先检查外壳，再成功接入后挂载的 iframe。最终已处理完成时，
      // 不再补打旧文档的临时“未找到把手”，以免在成功日志后制造一次假失败。
      if (!challenge.resolved) {
        for (const message of readinessLogs) log.push(message);
      }
      // 重绘期间控件暂时消失只能交回业务结果轮询，不能宣称滑块或签到成功。
      if (waitingForControls && !challenge.detected) {
        log.push('签到验证码控件暂时不可见，继续核对签到结果并观察后续验证');
      }
      return {
        ...challenge,
        detected: challenge.detected || waitingForControls || waitingForVerificationInput,
        ...(waitingForVerificationInput && !challenge.kind ? { kind: 'VerificationCode' } : {}),
      };
    }

    lastPending = challenge;
    if (!waitingForControls) {
      readyDeadline = Date.now() + CONTROL_READY_WAIT_MS;
      log.push('签到滑块控件尚未就绪，尚未开始拖动；保留本次签到，给控件约 30 秒加载时间');
      waitingForControls = true;
    }
    // 每次重新调度都重新选择当前可见的验证码文档；外壳先出现、iframe 后挂载
    // 或文档被替换时，不继续使用上一轮的节点/会话。只等待，不重复点击签到。
    await sleep(Math.min(CONTROL_READY_POLL_MS, Math.max(0, readyDeadline - Date.now())));
  }
}
