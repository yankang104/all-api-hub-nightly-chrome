import { realClick, sleep } from '@/automation/shared/dom-utils';
import {
  findSliderDomMatch,
  isVisibleSliderElement,
  readSliderDomState,
  type SliderDomMode,
  type SliderDomState,
} from '@/automation/slider/slider-dom';
import { TENCENT_SLIDER_SELECTORS } from '@/automation/slider/slider-frame-dom';

const SUCCESS_TEXT = /\b(?:verified|verification successful|success|passed)\b|验证\s*成功|校验\s*成功|验证\s*通过|已\s*通过/i;
const TOO_SHORT_TEXT = /too short|not far enough|move (?:a little )?further|偏左|距离过短|滑动不足|还差一点|未拖到位/i;
const TOO_FAR_TEXT = /too far|overshoot|move (?:a little )?back|偏右|距离过长|滑过头|拖过头/i;
const FAILURE_TEXT = /failed|failure|incorrect|try again|retry|error|验证失败|校验失败|请重试|重新尝试|再试一次/i;
const REFRESH_TEXT = /refresh|reload|retry|try again|change image|next image|刷新|换一张|重试|重新加载/i;
const CLOSE_TEXT = /close|cancel|关闭|取消/i;
const NEGATIVE_SETTLE_MS = 900;
const DISAPPEARANCE_SETTLE_MS = 1_200;

const NEGATIVE_TEXT = {
  'too-short': TOO_SHORT_TEXT,
  'too-far': TOO_FAR_TEXT,
  failed: FAILURE_TEXT,
} as const;

type NegativeOutcomeKind = keyof typeof NEGATIVE_TEXT;

export type SliderAttemptOutcomeKind =
  | 'success'
  | 'too-short'
  | 'too-far'
  | 'failed'
  | 'refreshed'
  | 'unchanged';

export interface SliderAttemptOutcome {
  kind: SliderAttemptOutcomeKind;
  state: SliderDomState;
  evidence?: 'status' | 'geometry' | 'disappearance' | 'refresh';
}

/**
 * 几何判据：拖完之后把手在哪。
 *
 * 站点改文案、换语言、或只用图标时，上面那套正则全部失效，判读退化成
 * `unchanged` —— 于是剩下几次尝试全靠校准序列盲试。把手位置不依赖文案。
 *
 * 把手停在终点不能判成成功，回到起点也不能立即判失败：部分组件在成功
 * 收尾时先复位再关闭。这里只提供候选信号，由等待器在超时后保守使用。
 */
function classifyByGeometry(
  before: SliderDomState,
  current: SliderDomState,
): SliderAttemptOutcomeKind | null {
  const from = before.handleOffsetX;
  const to = current.handleOffsetX;
  if (from == null || to == null) return null;
  const range = current.handleRange ?? before.handleRange;
  // 行程太短时噪声大于信号，不用几何判据。
  if (!range || range < 20) return null;
  // 拖动已经派发过，把手却仍在起点附近 —— 站点把它弹回去了。
  return Math.abs(to - from) < range * 0.05 ? 'failed' : null;
}

function statusPhrases(pattern: RegExp, text: string): string[] {
  return (text.match(new RegExp(pattern.source, 'gi')) ?? []).map((value) => value.toLowerCase());
}

function newStatusPhrases(pattern: RegExp, before: string, current: string): string[] {
  const previous = new Set(statusPhrases(pattern, before));
  return statusPhrases(pattern, current).filter((value) => !previous.has(value));
}

function classifyState(
  before: SliderDomState,
  current: SliderDomState,
  previousStatusText: string,
): SliderAttemptOutcomeKind | null {
  if (current.success) return 'success';
  if (newStatusPhrases(SUCCESS_TEXT, previousStatusText, current.statusText).length > 0) return 'success';
  // 换题优先于旧失败提示；但本轮新出现的成功信号仍优先于换题。
  if (before.challengeKey && current.challengeKey && before.challengeKey !== current.challengeKey) return 'refreshed';
  // 对比具体提示词，而非整段面板文案；常驻的 Retry 按钮不能掩盖新出现的
  // "验证失败"，计时器更新也不能重新触发上一轮的失败。
  for (const kind of ['too-short', 'too-far', 'failed'] as const) {
    if (newStatusPhrases(NEGATIVE_TEXT[kind], previousStatusText, current.statusText).length > 0) return kind;
  }
  return null;
}

export async function waitForSliderAttemptOutcome(
  before: SliderDomState,
  timeoutMs = 5_500,
  mode: SliderDomMode = 'page',
): Promise<SliderAttemptOutcome> {
  const deadline = Date.now() + timeoutMs;
  let latest = readSliderDomState(before.panel, mode);
  let previous = before;
  let negative: { kind: NegativeOutcomeKind; since: number; phrases: string[] } | undefined;
  let disappearedAt: number | undefined;
  let resetAt: number | undefined;

  while (true) {
    const now = Date.now();
    const kind = classifyState(before, latest, previous.statusText);
    if (kind === 'success') return { kind, state: latest, evidence: 'status' };
    if (kind === 'refreshed') return { kind, state: latest, evidence: 'refresh' };
    if (kind === 'failed' || kind === 'too-short' || kind === 'too-far') {
      negative = {
        kind,
        since: now,
        phrases: newStatusPhrases(NEGATIVE_TEXT[kind], previous.statusText, latest.statusText),
      };
    }

    if (!latest.visible && before.visible) {
      // 持续轮询收尾状态，既能接住短暂成功提示，也给换题重新挂载留出时间。
      disappearedAt ??= now;
      if (now - disappearedAt >= DISAPPEARANCE_SETTLE_MS) {
        // 本轮已出现明确失败时，面板关闭本身不能把失败改判为成功。
        return negative
          ? { kind: negative.kind, state: latest, evidence: 'status' }
          : { kind: 'success', state: latest, evidence: 'disappearance' };
      }
    } else {
      disappearedAt = undefined;
      if (negative) {
        const currentPhrases = statusPhrases(NEGATIVE_TEXT[negative.kind], latest.statusText);
        if (!negative.phrases.some((phrase) => currentPhrases.includes(phrase))) negative = undefined;
      }
      if (negative && now - negative.since >= NEGATIVE_SETTLE_MS) {
        return { kind: negative.kind, state: latest, evidence: 'status' };
      }
    }

    if (latest.visible && classifyByGeometry(before, latest) === 'failed') resetAt ??= now;
    else resetAt = undefined;

    if (now >= deadline) {
      // 几何不是站点的明确反馈。等完整个验收窗口仍持续复位才使用此兜底，
      // 不再抢在成功动画、服务端回调或关闭面板之前结束本轮。
      const reset = resetAt != null && now - resetAt >= NEGATIVE_SETTLE_MS;
      return reset
        ? { kind: 'failed', state: latest, evidence: 'geometry' }
        : { kind: 'unchanged', state: latest };
    }

    previous = latest;
    await sleep(Math.min(220, Math.max(0, deadline - Date.now())));
    latest = readSliderDomState(latest.panel ?? before.panel, mode);
  }
}

function refreshScore(element: Element, mode: SliderDomMode): number {
  if (!(element instanceof HTMLElement) || !isVisibleSliderElement(element)) return -Infinity;
  const text = [
    element.id,
    element.className,
    element.getAttribute('aria-label'),
    element.getAttribute('title'),
    element.textContent,
  ].filter(Boolean).join(' ');
  if (!REFRESH_TEXT.test(text) || CLOSE_TEXT.test(text)) return -Infinity;
  const rect = element.getBoundingClientRect();
  let score = 0;
  if (mode !== 'page' && element.matches(TENCENT_SLIDER_SELECTORS.refresh)) score += 10;
  if (element.matches('button, [role="button"], a')) score += 4;
  if (/refresh|reload|刷新|换一张/i.test(text)) score += 6;
  if (rect.width <= 100 && rect.height <= 80) score += 2;
  return score;
}

export async function requestSliderRefresh(mode: SliderDomMode = 'page'): Promise<boolean> {
  const match = findSliderDomMatch(mode);
  if (!match && mode === 'page') return false;
  // 通用入口只操作当前面板；腾讯适配器继续支持位于面板旁的自身工具栏。
  const candidates = [
    ...(match?.panel.querySelectorAll('button, [role="button"], a, [class], [id]') ?? []),
    ...(mode !== 'page' ? document.querySelectorAll(TENCENT_SLIDER_SELECTORS.refresh) : []),
  ];
  const candidate = candidates
    .sort((left, right) => refreshScore(right, mode) - refreshScore(left, mode))[0];
  if (!(candidate instanceof HTMLElement) || refreshScore(candidate, mode) < 4) return false;

  try {
    await realClick(candidate);
    return true;
  } catch {
    return false;
  }
}

export async function waitForSliderRefresh(
  previousChallengeKey: string | undefined,
  timeoutMs = 3_500,
  mode: SliderDomMode = 'page',
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readSliderDomState(undefined, mode);
    if (!state.visible || (previousChallengeKey && state.challengeKey && state.challengeKey !== previousChallengeKey)) {
      return true;
    }
    await sleep(180);
  }
  return false;
}

export function nextSliderCorrection(
  currentPx: number,
  outcome: SliderAttemptOutcomeKind,
  handleRange: number,
): number {
  const unit = Math.min(3, Math.max(1, handleRange * 0.008));
  const limit = Math.min(10, Math.max(3, handleRange * 0.04));
  let next = currentPx;

  if (outcome === 'too-short') next += unit;
  else if (outcome === 'too-far') next -= unit;
  // A generic failure or a new image provides no direction information.
  // Alternating -1/+1/-2/+2 across refreshed challenges manufactured the
  // exact misalignment it was meant to correct.
  else next = 0;

  return Math.max(-limit, Math.min(limit, Math.round(next * 10) / 10));
}
