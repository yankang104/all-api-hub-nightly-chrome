import { sendMessage } from '@/lib/core/messaging';
import type { SliderCrackResult } from '@/lib/messages/slider';
import type { SliderSolveResult } from '@/types/slider';
import { getActiveClickRunId, getActiveSliderFrameSessionId, sleep } from '@/automation/shared/dom-utils';
import type { StepLog } from '@/automation/login/steps';
import {
  collectSliderChallenge,
  getSliderCollectionFailure,
  readSliderDomState,
  type SliderDomMode,
} from '@/automation/slider/slider-dom';
import {
  nextSliderCorrection,
  requestSliderRefresh,
  waitForSliderAttemptOutcome,
  waitForSliderRefresh,
  type SliderAttemptOutcome,
} from '@/automation/slider/slider-feedback';

export type { SliderSolveResult } from '@/types/slider';

interface SliderSolveOptions {
  frameSessionId?: string;
  deadline?: number;
  /** 主页面只选择控件适配器；iframe 专用策略必须由真实会话入口启用。 */
  domMode?: Exclude<SliderDomMode, 'tencent-frame'>;
}

const MAX_ATTEMPTS = 5;
const SOLVE_DEADLINE_MS = 55_000;
let activeSliderSolve: Promise<SliderSolveResult> | null = null;

function outcomeLabel(outcome: SliderAttemptOutcome): string {
  switch (outcome.kind) {
    case 'too-short': return '页面反馈拖动偏短';
    case 'too-far': return '页面反馈拖动偏长';
    case 'failed': return outcome.evidence === 'geometry'
      ? '滑块把手持续停在起点，等待结束后仍未收到通过确认'
      : '页面显示本轮验证失败提示';
    case 'refreshed': return '页面已刷新为新挑战';
    case 'unchanged': return '页面没有给出通过或刷新反馈';
    case 'success': return outcome.evidence === 'disappearance'
      ? '滑块面板已稳定关闭'
      : '页面确认验证通过';
  }
}

const SOURCE_LABELS: Record<string, string> = {
  'raw-image': '原图',
  'viewport-screenshot': 'CDP 截图',
};

/** 匹配方法的中文说明，让日志能看出这次是靠什么定位的。 */
const METHOD_LABELS: Record<string, string> = {
  measured: '实测碎片',
  'hole-silhouette': '形状吻合',
  'outline-profile': '轮廓剖面',
  'background-delta': '双图差分',
  'contour-alpha': '轮廓(带形状)',
  'contour-edge': '轮廓(矩形)',
  opencv: 'OpenCV 模板',
  ncc: 'JS 模板',
  silhouette: '形状吻合',
};

function describeMethod(method?: string): string {
  if (!method) return 'unknown';
  // method 形如 "viewport-screenshot:hole-silhouette+ncc"
  const [, ...rest] = method.split(':');
  const core = rest.join(':') || method;
  const labelled = core.split('+').map((part) => METHOD_LABELS[part] ?? part).join('+');
  return labelled;
}

function resultLog(result: SliderCrackResult): string {
  const d = result.diagnostics;
  // 取图路径决定精度：原图是真实像素比，截图受 devicePixelRatio 影响。
  // 不写出来的话用户看不出该不该把浏览器缩放调回 100%。
  const details = d
    ? `，取图=${SOURCE_LABELS[d.source] ?? d.source}`
      + `，图像距离=${d.imageDistance}px`
      // 实测行程比与几何推算不一致时，说明几何推算不可信 —— 两个都写出来才能对比
      + (d.measuredRatio != null
        ? `，实测行程比=${d.measuredRatio.toFixed(3)}`
        : `，行程比=${d.conversionRatio.toFixed(3)}`)
      + (d.probeDistance != null ? `，探测位移=${d.probeDistance}px` : '')
      + `，修正=${d.correctionPx}px`
      + (d.cropOffsetX ? `，亚像素补偿=${d.cropOffsetX}px` : '')
      + (d.rivalCount ? `，另有 ${d.rivalCount} 个疑似缺口` : '')
    : '';
  return `方法=${describeMethod(result.method)}，缺口=${result.gapX ?? 'N/A'}px，拖动=${result.distance ?? 'N/A'}px，置信度=${result.confidence?.toFixed(3) ?? 'N/A'}${details}`;
}

async function solveSlider(log: StepLog, options: SliderSolveOptions): Promise<SliderSolveResult> {
  const runId = getActiveClickRunId();
  if (!runId) {
    log.push('滑块求解：没有活跃签到任务，停止自动拖动');
    return { solved: false, error: '没有活跃签到任务' };
  }

  // 腾讯页面只扩展控件定位，保留主页面图片输入与求解策略。
  // iframe 专用的容器加权和仅截图输入只由真实 iframe 会话启用。
  const frameSessionId = options.frameSessionId;
  const mode = frameSessionId ? 'tencent-frame' : (options.domMode ?? 'page');
  const deadline = Math.min(options.deadline ?? Infinity, Date.now() + SOLVE_DEADLINE_MS);
  const isActive = () => getActiveClickRunId() === runId
    && (!frameSessionId || getActiveSliderFrameSessionId() === frameSessionId);
  let correctionPx = 0;
  let correctionChallengeKey: string | undefined;
  let lastError = '滑块没有返回可确认的结果';
  let loggedGeometryFallback = false;
  /**
   * 已经拖过且被站点判失败的缺口位置，按挑战分组。
   *
   * 实测日志里第 1 次和第 5 次都算出「缺口=32.8px」，而第 1 次已经明确失败。
   * 刷新换图后旧位置不再有意义，所以要按 challengeKey 清空。
   */
  let failedGapX: number[] = [];
  let failedGapChallengeKey: string | undefined;
  /**
   * 因「图上多个疑似缺口」被拒的**累计**次数：两次就该交人工，别把机会耗光。
   *
   * 不能按「连续」计数：后台交替使用边拖边测和静态图像路径，
   * 而 `match-ambiguous` 只可能由静态路径产生（边拖边测的错误码只有
   * image-unavailable / match-not-found / distance-out-of-range / drag-failed）。
   * 按连续算的话，中间那次奇数轮无论成败都会清零，计数永远到不了 2 ——
   * 早停分支不可达，每次都把 5 次机会耗尽，还给站点累计 3 次真实失败尝试。
   */
  let ambiguousCount = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (!isActive() || Date.now() >= deadline) {
      lastError = isActive() ? '滑块求解超过总时限' : '本轮滑块任务已停止';
      break;
    }

    const collected = await (frameSessionId ? collectSliderChallenge({
      mode,
      mountTimeoutMs: 6_000,
      deadline,
      isActive,
    }) : collectSliderChallenge({ mode }));
    if (!collected) {
      const state = readSliderDomState(undefined, mode);
      if (isActive() && state.success) {
        log.push('页面已显示滑块通过状态');
        return { solved: true, method: 'dom-feedback' };
      }
      lastError = getSliderCollectionFailure() ?? (state.visible
        ? '没有找到同时满足把手、轨道和背景几何关系的滑块控件'
        : '检测到滑动挑战，但页面没有暴露可安全拖动的 DOM 控件');
      log.push(lastError);
      break;
    }

    const { info, match, releaseHandleMarker } = collected;
    if (!isActive() || (frameSessionId && Date.now() >= deadline)) {
      releaseHandleMarker();
      lastError = '本轮滑块任务已停止或超过时限';
      break;
    }
    if (match.detectionMethod === 'panel-geometry' && !loggedGeometryFallback) {
      log.push('标准滑块控件匹配未命中，已通过当前验证码弹窗内的图片、轨道和把手布局定位，继续截图识别');
      loggedGeometryFallback = true;
    }
    const before = readSliderDomState(match.panel, mode);
    if (frameSessionId && before.success) {
      releaseHandleMarker();
      log.push('当前验证码面板已显示通过状态，未重复拖动');
      return { solved: true, method: 'dom-feedback' };
    }
    if (
      correctionPx !== 0
      && correctionChallengeKey
      && before.challengeKey
      && before.challengeKey !== correctionChallengeKey
    ) {
      correctionPx = 0;
      correctionChallengeKey = undefined;
    }
    // 换了新挑战就丢掉旧的失败位置：新图的缺口在别处。
    if (
      failedGapX.length
      && failedGapChallengeKey
      && before.challengeKey
      && before.challengeKey !== failedGapChallengeKey
    ) {
      failedGapX = [];
      failedGapChallengeKey = undefined;
    }
    const pieceSize = info.pieceRect
      ? `${info.pieceRect.width}×${info.pieceRect.height}`
      : '未直接暴露';
    log.push(
      `滑块第 ${attempt}/${MAX_ATTEMPTS} 次：背景 ${info.backgroundRect.width}×${info.backgroundRect.height}，`
      + `拼图块 ${pieceSize}，轨道行程 ${(info.trackRect.width - info.handleRect.width).toFixed(1)}px`,
    );

    let result: SliderCrackResult | undefined;
    let transportError: string | undefined;
    try {
      const response = await sendMessage({
        type: 'SLIDER_CRACK',
        runId,
        ...(frameSessionId ? { frameSessionId } : {}),
        slider: info,
        options: {
          attempt,
          correctionPx,
          ...(failedGapX.length ? { excludedGapX: [...failedGapX] } : {}),
        },
      });
      if (!response.ok) transportError = response.error;
      else result = response.feature?.slider;
    } finally {
      releaseHandleMarker();
    }

    if (!isActive()) {
      lastError = '本轮滑块任务已停止';
      break;
    }

    if (transportError) {
      lastError = transportError;
      log.push(`滑块后台调用失败：${transportError}`);
    } else if (!result) {
      lastError = '后台没有返回滑块处理结果';
      log.push(lastError);
    } else if (!result.solved) {
      lastError = result.error ?? '滑块图像识别或拖动失败';
      log.push(`滑块本次未执行：${lastError}${result.method ? `（${resultLog(result)}）` : ''}`);
      /**
       * 图上有多个分数接近的候选缺口 —— 多缺口验证码的特征。
       *
       * 继续换图重试没有意义：同一站点的下一张图仍然是多缺口，而每次失败都在
       * 累积站点的可疑计数。累计两次就停下来交人工，用户能在 15 秒后接手，
       * 而不是等 5 次尝试 + 超时共约 40 秒。
       *
       * 计数只增不清零：静态路径与边拖边测隔轮交替，只有静态路径会报歧义，
       * 按「连续」算则中间那轮必然清零，早停永远触发不了。
       */
      if (result.errorCode === 'match-ambiguous') {
        ambiguousCount += 1;
        if (ambiguousCount >= 2) {
          lastError = '这个滑块在同一张图上有多个疑似缺口，自动识别无法确定唯一目标';
          log.push(`${lastError}，已停止自动尝试并交由人工完成`);
          break;
        }
      }
    } else {
      log.push(`可信拖动已执行，等待页面验收：${resultLog(result)}`);
      const outcome = await waitForSliderAttemptOutcome(
        before,
        frameSessionId ? Math.max(0, Math.min(5_500, deadline - Date.now())) : 5_500,
        mode,
      );
      log.push(outcomeLabel(outcome));
      if (outcome.kind === 'success') {
        // 主页面恢复原有的关闭即完成语义；iframe 关闭交给外层业务确认。
        const dismissed = Boolean(frameSessionId) && outcome.evidence === 'disappearance';
        return {
          solved: !dismissed,
          ...(dismissed ? { dismissed: true } : {}),
          method: result.method,
          gapX: result.gapX,
          distance: result.distance,
        };
      }
      lastError = outcomeLabel(outcome);
      /**
       * 只在本轮出现明确失败提示时记录位置；没有反馈或仅把手复位都不足以
       * 证明缺口错误，不能因此排除。
       *
       * `too-short` / `too-far` 是例外 —— 那是「位置对但距离差一点」，
       * 应该微调重试而不是把这个位置排除掉。
       */
      if (
        outcome.kind === 'failed'
        && outcome.evidence === 'status'
        && result.gapX != null
        && !failedGapX.some((x) => Math.abs(x - result.gapX!) < 3)
      ) {
        failedGapX.push(result.gapX);
        failedGapChallengeKey = outcome.state.challengeKey ?? before.challengeKey;
      }
      correctionPx = nextSliderCorrection(
        correctionPx,
        outcome.kind,
        result.diagnostics?.handleRange ?? (info.trackRect.width - info.handleRect.width),
      );
      if (outcome.kind === 'too-short' || outcome.kind === 'too-far') {
        // Directional feedback is useful only while retrying the same image.
        correctionChallengeKey = outcome.state.challengeKey ?? before.challengeKey;
        await sleep(350);
        continue;
      }
      if (outcome.kind === 'refreshed') {
        correctionPx = 0;
        correctionChallengeKey = undefined;
        // 换了新图，旧的失败位置不再有意义。
        failedGapX = [];
        failedGapChallengeKey = undefined;
        await sleep(350);
        continue;
      }
    }

    if (attempt >= MAX_ATTEMPTS || !isActive() || (frameSessionId && Date.now() >= deadline)) break;

    correctionPx = 0;
    correctionChallengeKey = undefined;
    /**
     * 主动请求刷新之后无条件清掉失败位置，不依赖 challengeKey 是否变化。
     *
     * `challengeKey` 在图片源取不到时（canvas 被跨域污染 → `toDataURL` 抛错、
     * 或图只挂在 CSS `background-image` 上而拿不到 URL）会退化成
     * 「semanticText + 矩形尺寸」——这两项在刷新前后完全一样，于是新旧挑战
     * 算出**同一个 key**。上面那条按 key 比对的清理就不会触发，旧图的失败位置
     * 被带到新图上继续排除，可能把新图里真正的缺口挡掉。
     *
     * 而这里的语义是确定的：我们刚刚**主动要求**换一张图，无论 key 变没变，
     * 旧位置都已经无关。
     */
    failedGapX = [];
    failedGapChallengeKey = undefined;
    const refreshedByControl = await requestSliderRefresh(mode);
    if (refreshedByControl) {
      log.push('已通过验证控件自身的刷新按钮请求新挑战');
      await waitForSliderRefresh(before.challengeKey, 3_500, mode);
    } else {
      await waitForSliderRefresh(before.challengeKey, 1_600, mode);
    }
    await sleep(300);
  }

  log.push(`滑块自动求解未通过页面确认：${lastError}`);
  return { solved: false, error: lastError };
}

/** Keep all callers in one content frame on the same bounded solve loop. */
function startSliderSolve(log: StepLog, options: SliderSolveOptions): Promise<SliderSolveResult> {
  if (activeSliderSolve) {
    log.push('滑块求解已经在执行，复用当前任务');
    return activeSliderSolve;
  }
  const promise = solveSlider(log, options).finally(() => {
    if (activeSliderSolve === promise) activeSliderSolve = null;
  });
  activeSliderSolve = promise;
  return promise;
}

/** 原有主页面入口：默认识别、取图和结果判定不启用任何 iframe 策略。 */
export function trySolveSlider(log: StepLog): Promise<SliderSolveResult> {
  return startSliderSolve(log, {});
}

/** 复用腾讯控件选择器，不继承 iframe 的裁剪和仅截图策略。 */
export function trySolveTencentSliderInPage(log: StepLog): Promise<SliderSolveResult> {
  log.push('检测到页面内腾讯滑块，使用腾讯控件定位，保留主页面取图与求解策略');
  return startSliderSolve(log, { domMode: 'tencent-page' });
}

/** 仅由独立注入的腾讯验证码 iframe 助手调用。 */
export function trySolveSliderInCurrentFrame(
  log: StepLog,
  frameSessionId: string,
  deadline: number,
): Promise<SliderSolveResult> {
  return startSliderSolve(log, { frameSessionId, deadline });
}
