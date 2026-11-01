export interface PointerPoint {
  x: number;
  y: number;
}

import {
  anchorXExpression,
  type PointerAnchor,
  type PointerTargetDiagnostics,
  type TurnstileReadinessDiagnostics,
} from '@/lib/messages/pointer';

export type { PointerAnchor };
import { readFramePointerTarget, type FramePointerTarget } from '@/background/slider/frame-target';
import type { WorkflowGesture } from '@/types/workflow';

export interface TrustedPointerClick {
  x: number;
  y: number;
  viewportWidth: number;
  viewportHeight: number;
  targetToken: string;
  frameTarget?: FramePointerTarget;
  anchor?: PointerAnchor;
  targetSeenAt?: number;
  deadline?: number;
  /** 后台按下前必须仍成立的输入框值；只由可信 background 依据当前任务附加。 */
  inputAssertions?: readonly { selector: string; value: string }[];
  /** 手势语义；缺省单击左键。双击/右键/长按必须由 CDP 按同一语义派发。 */
  gesture?: WorkflowGesture;
  /** `long-press` 的按住时长（毫秒）；缺省 600ms。 */
  holdMs?: number;
}

export interface TrustedPointerClickHooks {
  /** 完整点击已派发且探针未明确判定失败后执行；用于记录受管凭据提交。 */
  afterClick?: () => Promise<void>;
}

type RandomSource = () => number;

const lastPointerByTab = new Map<number, PointerPoint>();

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function cubicBezier(
  start: PointerPoint,
  control1: PointerPoint,
  control2: PointerPoint,
  end: PointerPoint,
  t: number,
): PointerPoint {
  const inverse = 1 - t;
  const a = inverse ** 3;
  const b = 3 * inverse ** 2 * t;
  const c = 3 * inverse * t ** 2;
  const d = t ** 3;
  return {
    x: a * start.x + b * control1.x + c * control2.x + d * end.x,
    y: a * start.y + b * control1.y + c * control2.y + d * end.y,
  };
}

/**
 * 生成一条轻微弯曲、逐步收敛到目标中心的指针轨迹。
 * 随机源可注入，单元测试因此不依赖 Math.random 的具体输出。
 */
export function buildHumanPointerPath(
  start: PointerPoint,
  end: PointerPoint,
  random: RandomSource = Math.random,
): PointerPoint[] {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const steps = clamp(Math.round(distance / 24) + 10, 12, 30);
  const normalX = -dy / distance;
  const normalY = dx / distance;
  const bend = (random() - 0.5) * Math.min(120, distance * 0.42);
  const control1 = {
    x: start.x + dx * 0.32 + normalX * bend,
    y: start.y + dy * 0.32 + normalY * bend,
  };
  const control2 = {
    x: start.x + dx * 0.72 - normalX * bend * 0.35,
    y: start.y + dy * 0.72 - normalY * bend * 0.35,
  };

  const path: PointerPoint[] = [];
  for (let index = 1; index <= steps; index += 1) {
    const t = index / steps;
    const point = cubicBezier(start, control1, control2, end, t);
    const jitter = (1 - t) * 0.7;
    path.push({
      x: point.x + (random() - 0.5) * jitter,
      y: point.y + (random() - 0.5) * jitter,
    });
  }
  path[path.length - 1] = { ...end };
  return path;
}

function initialPointer(input: TrustedPointerClick, random: RandomSource): PointerPoint {
  const horizontal = (90 + random() * 230) * (random() < 0.5 ? -1 : 1);
  const vertical = (55 + random() * 170) * (random() < 0.5 ? -1 : 1);
  return {
    x: clamp(input.x + horizontal, 1, input.viewportWidth - 1),
    y: clamp(input.y + vertical, 1, input.viewportHeight - 1),
  };
}

function validateInput(input: TrustedPointerClick): void {
  const values = [input.x, input.y, input.viewportWidth, input.viewportHeight];
  if (!values.every(Number.isFinite)) throw new Error('鼠标坐标不是有效数字');
  if (input.viewportWidth < 2 || input.viewportHeight < 2) throw new Error('页面视口尺寸无效');
  if (input.x < 0 || input.y < 0 || input.x > input.viewportWidth || input.y > input.viewportHeight) {
    throw new Error('目标坐标不在当前视口内');
  }
  if (!/^p-[a-z0-9-]{8,80}$/i.test(input.targetToken)) throw new Error('目标控件标记无效');
  if (input.targetSeenAt != null && (!Number.isFinite(input.targetSeenAt) || input.targetSeenAt < 0)) {
    throw new Error('目标控件出现时间无效');
  }
  if (input.deadline != null && (!Number.isFinite(input.deadline) || input.deadline < 0)) {
    throw new Error('可信点击截止时间无效');
  }
  normalizeClickGesture(input);
  if (input.inputAssertions) {
    if (input.inputAssertions.length > 4) throw new Error('点击前输入核对项过多');
    for (const assertion of input.inputAssertions) {
      if (!assertion.selector || assertion.selector.length > 256 || typeof assertion.value !== 'string') {
        throw new Error('点击前输入核对项无效');
      }
    }
  }
}

/**
 * Chrome debugger 的 Promise 在页面导航或 Service Worker 回收的边界上偶尔
 * 不会 settle。**本文件里所有** CDP 调用都必须经过这个有界包装 —— 点击、滚动、
 * 一次性拖拽、以及按住不放的拖拽会话，一个都不能漏。
 *
 * 曾经只有点击路径包了，拖拽与滚动全是裸 `sendCommand`。代价不对称：拖拽
 * 挂住的时候左键**正按着**，页面停在拖拽态，调试器挂着，`slider-crack.ts` 的
 * `activeCracks` 条目也永久驻留（`.finally()` 永不执行），该标签页之后每次
 * SLIDER_CRACK 只能拿到 busy。而全仓库没有 `chrome.debugger.onDetach`
 * 也没有按 tabId 的兜底 detach，只能靠 content 侧 45 秒超时草草收场。
 */
const TRUSTED_POINTER_CLICK_MAX_MS = 30_000;
/** long-press 的缺省按住时长；与 dom-utils 的 DEFAULT_LONG_PRESS_HOLD_MS 同一量级。 */
const DEFAULT_LONG_PRESS_HOLD_MS_TRUSTED = 600;
/** 长按允许的最大按住时长：超过它就不是「长按」而是卡死。 */
const MAX_LONG_PRESS_HOLD_MS = 5_000;
/** 双击两次按压之间的间隔。 */
const DOUBLE_CLICK_INTERVAL_MS = 90;
const TRUSTED_GESTURES = new Set<WorkflowGesture>(['click', 'double', 'right', 'long-press']);

/**
 * 校验并规整手势参数。未知手势直接拒绝 —— 静默退化成普通单击正是
 * 「学到双击、回放成单击」这类假成功的来源。
 */
function normalizeClickGesture(input: TrustedPointerClick): { gesture: WorkflowGesture; holdMs: number } {
  const gesture = input.gesture ?? 'click';
  if (!TRUSTED_GESTURES.has(gesture)) throw new Error(`未知手势 ${String(input.gesture)}`);
  const raw = input.holdMs;
  const holdMs = raw != null && Number.isFinite(raw)
    ? Math.min(MAX_LONG_PRESS_HOLD_MS, Math.max(0, Math.round(raw)))
    : DEFAULT_LONG_PRESS_HOLD_MS_TRUSTED;
  return { gesture, holdMs };
}
const CDP_COMMAND_TIMEOUT_MS = 4_000;
const DEBUGGER_CLEANUP_TIMEOUT_MS = 1_000;
/** 一次滚动/一次性拖拽的总预算。 */
const TRUSTED_POINTER_GESTURE_MAX_MS = 30_000;
/**
 * 一个「按住不放」的拖拽会话的总预算。
 *
 * 比单次手势宽：会话中途要截图、算距离、再继续拖，而 `crackByMeasuredDrag`
 * 一次会话里就有两次 `Page.captureScreenshot`。仍然必须有上限 ——
 * 会话挂住的代价是左键按住 + 调试器挂着 + `activeCracks` 永久占位。
 */
const TRUSTED_DRAG_SESSION_MAX_MS = 45_000;
/**
 * 单次 CDP 截图的预算。
 *
 * 比普通命令宽：`fromSurface: true` 要等一帧真正合成出来，窗口被遮挡或
 * 最小化时本来就慢。但不能不设 —— 它正是拖拽会话里最容易不 settle 的一步。
 */
const CDP_SCREENSHOT_TIMEOUT_MS = 8_000;

function timeoutError(label: string): Error {
  return new Error(`可信点击阶段「${label}」超时（点击结果可能未知）`);
}

function boundedOperation<T>(
  operation: () => Promise<T> | T,
  deadline: number,
  label: string,
  maxMs = CDP_COMMAND_TIMEOUT_MS,
): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(timeoutError(label));

  let pending: Promise<T>;
  try {
    pending = Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(timeoutError(label));
    }, Math.min(maxMs, remaining));

    pending.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function debuggerCommand<T>(
  target: chrome.debugger.Debuggee,
  method: string,
  params: Record<string, unknown> | undefined,
  deadline: number,
): Promise<T> {
  return boundedOperation(
    () => (params === undefined
      ? chrome.debugger.sendCommand(target, method)
      : chrome.debugger.sendCommand(target, method, params)) as Promise<T>,
    deadline,
    `CDP ${method}`,
  );
}

/**
 * 收尾用的 detach：只要**发起过** attach 就必须调，不能只在「attach 成功」时调。
 *
 * `boundedOperation` 只是放弃等待，并不取消底层 Promise —— 包装超时 reject 之后
 * `chrome.debugger.attach` 仍可能真的挂上调试器。按「成功才 detach」写的话这种
 * 情况下会话永久泄漏，而本仓库没有 `chrome.debugger.onDetach`、也没有按 tabId
 * 的兜底清理：此后该标签页所有 attach 都被 Chrome 以「Another debugger is
 * already attached」拒绝，可信点击/滚动/拖拽/截图全线失效，页面顶上还一直挂着
 * 调试提示栏。
 *
 * detach 一个并未挂上的 target 只会 reject，被这里吞掉，无害且幂等。
 */
async function bestEffortDebuggerOperation(
  operation: () => Promise<unknown> | unknown,
  label: string,
): Promise<void> {
  try {
    await boundedOperation(
      operation,
      Date.now() + DEBUGGER_CLEANUP_TIMEOUT_MS,
      label,
      DEBUGGER_CLEANUP_TIMEOUT_MS,
    );
  } catch {
    // 页面已经导航/调试器已经断开时，清理失败本身不能再次卡住任务。
  }
}

/** 在 CDP 派发 mousePressed 的前一刻重新读取登录字段，不把任何值写进日志。 */
async function assertInputValues(
  target: chrome.debugger.Debuggee,
  assertions: readonly { selector: string; value: string }[],
  deadline: number,
): Promise<boolean> {
  const encoded = JSON.stringify(assertions);
  const result = await debuggerCommand<{ result?: { value?: boolean } }>(target, 'Runtime.evaluate', {
    expression: `(() => {
      const assertions = ${encoded};
      return assertions.every(({ selector, value }) => {
        const input = document.querySelector(selector);
        return input instanceof HTMLInputElement && input.value === value;
      });
    })()`,
    returnByValue: true,
  }, deadline);
  return result.result?.value === true;
}

function assertBeforeDeadline(deadline?: number): void {
  if (deadline != null && Date.now() >= deadline) {
    throw new Error('可信点击已超过执行截止时间');
  }
}

async function pauseBeforeDeadline(ms: number, deadline?: number): Promise<void> {
  if (deadline != null && Date.now() + ms >= deadline) {
    throw new Error('可信点击剩余时间不足，已取消按压');
  }
  await pause(ms);
  assertBeforeDeadline(deadline);
}

interface LiveTargetPoint extends PointerTargetDiagnostics {}

const POINTER_PROBE_KEY = '__aahTrustedPointerProbes';

async function installClickProbe(
  target: chrome.debugger.Debuggee,
  token: string,
  deadline: number,
): Promise<boolean> {
  const result = await debuggerCommand<{ result?: { value?: boolean } }>(target, 'Runtime.evaluate', {
    expression: `(() => {
      /* 影子根里的目标：document.querySelector 看不到，必须在每个影子根里继续查找。 */
      const findDeep = (root) => {
        const direct = root.querySelector('[data-aah-pointer-target="${token}"]');
        if (direct) return direct;
        for (const host of root.querySelectorAll('*')) {
          if (!host.shadowRoot) continue;
          const found = findDeep(host.shadowRoot);
          if (found) return found;
        }
        return null;
      };
      const el = findDeep(document);
      if (!el) return false;
      const root = globalThis;
      const probes = root.${POINTER_PROBE_KEY} || (root.${POINTER_PROBE_KEY} = Object.create(null));
      const events = [];
      const handler = (event) => {
        /*
           * 影子根里的目标必须看穿透链。
           *
           * 影子树内发生的事件到达 document 监听器时 target 会被**重定向成宿主**：
           * 宿主既不等于目标、也不 contains 目标，于是探针一个事件都收不到，
           * 可信指针通道报「鼠标事件未到达目标控件」—— 而点击其实已经落下。
           * composedPath() 是事件的方法，它还原被重定向掉的真实路径。
           */
        const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
        const eventTarget = event.target;
        if (path.includes(el) || eventTarget === el || (eventTarget instanceof Node && el.contains(eventTarget))) {
          events.push({
            type: event.type,
            trusted: event.isTrusted === true,
            // screenX/screenY 与 clientX/clientY 的差值应等于窗口左边距与浏览器界面
            // 高度。Turnstile 会核对这个偏移；调试器信息栏改变界面高度后，CDP 若按
            // 旧偏移填值就会对不上，这是目前唯一还没排除的拒发原因。
            screenX: event.screenX,
            screenY: event.screenY,
            clientX: event.clientX,
            clientY: event.clientY,
          });
        }
      };
      const types = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'contextmenu'];
      for (const type of types) document.addEventListener(type, handler, true);
      probes['${token}'] = {
        events,
        handler,
        types,
        geometry: {
          screenLeft: window.screenLeft,
          screenTop: window.screenTop,
          outerWidth: window.outerWidth,
          innerWidth: window.innerWidth,
          outerHeight: window.outerHeight,
          innerHeight: window.innerHeight,
          dpr: window.devicePixelRatio,
        },
      };
      return true;
    })()`,
    returnByValue: true,
  }, deadline);
  return result.result?.value === true;
}

export interface ClickProbeReport {
  clickObserved: boolean;
  /**
   * 右键手势的到位证据。
   *
   * 右键在浏览器里**不会**派发 click（只派发 contextmenu），若仍用 clickObserved
   * 判定「事件是否到达目标」，每一次右键回放都会被误判成「鼠标事件未到达目标控件」。
   */
  contextmenuObserved: boolean;
  /** screenX-clientX 与 screenY-clientY 的实测差值，与期望值对比可判断偏移是否被污染 */
  offsetActual?: { dx: number; dy: number };
  offsetExpected?: { dx: number; dy: number };
}

async function finishClickProbe(
  target: chrome.debugger.Debuggee,
  token: string,
  deadline: number,
): Promise<ClickProbeReport | null> {
  const result = await debuggerCommand<{ result?: { value?: ClickProbeReport | null } }>(target, 'Runtime.evaluate', {
    expression: `(() => {
      const probes = globalThis.${POINTER_PROBE_KEY};
      const probe = probes && probes['${token}'];
      if (!probe) return null;
      for (const type of probe.types) document.removeEventListener(type, probe.handler, true);
      delete probes['${token}'];

      const down = probe.events.find((e) => e.type === 'mousedown') || probe.events[0];
      const g = probe.geometry || {};
      const sideBorder = Math.max(0, ((g.outerWidth || 0) - (g.innerWidth || 0)) / 2);
      const topChrome = Math.max(0, (g.outerHeight || 0) - (g.innerHeight || 0) - sideBorder);
      return {
        clickObserved: probe.events.some((e) => e.type === 'click' && e.trusted === true),
        contextmenuObserved: probe.events.some((e) => e.type === 'contextmenu' && e.trusted === true),
        offsetActual: down && down.screenX != null
          ? { dx: down.screenX - down.clientX, dy: down.screenY - down.clientY }
          : undefined,
        offsetExpected: {
          dx: Math.round((g.screenLeft || 0) + sideBorder),
          dy: Math.round((g.screenTop || 0) + topChrome),
        },
      };
    })()`,
    returnByValue: true,
  }, deadline);
  return result.result?.value ?? null;
}

/**
 * 重新采样目标落点。
 *
 * anchor 必须与 content script 计算首发坐标时用的规则一致：Turnstile 的复选框
 * 在容器左边缘往里约 24px，若这里无条件取中心，鼠标会移到复选框、却在容器
 * 中心（「请验证您是真人」文字上）按下 —— 表现为落点看着对但点击无反应。
 *
 * hit 判定对跨 shadow DOM 的目标会失败（elementFromPoint 返回宿主而非内部
 * iframe），所以额外回报宿主是否包含命中元素，由调用方按 allowShadow 放行。
 */
async function liveTargetPoint(
  target: chrome.debugger.Debuggee,
  token: string,
  anchor: PointerAnchor,
  deadline?: number,
  frameTarget?: FramePointerTarget,
): Promise<LiveTargetPoint | null> {
  if (frameTarget && target.tabId != null) {
    return boundedOperation(() => readFramePointerTarget(target.tabId!, frameTarget, token, anchor),
      deadline ?? (Date.now() + CDP_COMMAND_TIMEOUT_MS), '验证码 iframe 目标重采样');
  }
  const anchorExpr = anchorXExpression(anchor);

  const result = await debuggerCommand<{ result?: { value?: LiveTargetPoint | null } }>(target, 'Runtime.evaluate', {
    expression: `(() => {
      /* 影子根里的目标：document.querySelector 看不到，必须在每个影子根里继续查找。 */
      const findDeep = (root) => {
        const direct = root.querySelector('[data-aah-pointer-target="${token}"]');
        if (direct) return direct;
        for (const host of root.querySelectorAll('*')) {
          if (!host.shadowRoot) continue;
          const found = findDeep(host.shadowRoot);
          if (found) return found;
        }
        return null;
      };
      const el = findDeep(document);
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const x = Math.min(innerWidth - 1, Math.max(1, ${anchorExpr}));
      const y = Math.min(innerHeight - 1, Math.max(1, rect.top + rect.height / 2));
      /*
       * 穿透影子根取真实命中元素。
       *
       * elementFromPoint 只返回外部文档树节点：目标在影子根里时拿到的是宿主，
       * 于是 hit / withinHost 双双为 false，可信指针通道直接抛「鼠标移动过程中
       * 发生位移或被遮挡」—— 而目标就在那里、也点得到。逐层进宿主影子根重做命中
       * 测试即可拿到真目标（Element 没有 composedPath，那是 Event 的方法）。
       */
      let hit = document.elementFromPoint(x, y);
      while (hit && hit.shadowRoot) {
        const deeper = hit.shadowRoot.elementFromPoint(x, y);
        if (!deeper || deeper === hit) break;
        hit = deeper;
      }
      return {
        x,
        y,
        rect: {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        },
        hit: !!hit && (hit === el || el.contains(hit) || hit.contains(el)),
        withinHost: !!hit && (hit === el || el.contains(hit) || hit.contains(el)),
      };
    })()`,
    returnByValue: true,
  }, deadline ?? (Date.now() + CDP_COMMAND_TIMEOUT_MS));
  return result.result?.value ?? null;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const TURNSTILE_MIN_MATURE_MS = 10_000;
const TURNSTILE_SAFETY_WINDOW_MS = 15_000;
const TURNSTILE_READY_STABLE_MS = 800;
const TURNSTILE_READY_POLL_MS = 250;

type TurnstileDeepSignal = Extract<
  TurnstileReadinessDiagnostics['signal'],
  'inner-frame' | 'interactive-control'
>;

interface TurnstileDeepObservation {
  signal: TurnstileDeepSignal;
  /** frame/node 重建时必须变化，避免把一串不同占位节点累计成“稳定 800ms”。 */
  identity: string;
}

interface CdpLocatedNode {
  backendNodeId?: number;
  frameId?: string;
}

interface CdpNodeDescription {
  node?: {
    nodeName?: string;
    localName?: string;
    attributes?: string[];
    frameId?: string;
    documentURL?: string;
  };
}

function nodeAttributes(values: string[] | undefined): Map<string, string> {
  const attributes = new Map<string, string>();
  for (let index = 0; index + 1 < (values?.length ?? 0); index += 2) {
    attributes.set(values![index]!.toLowerCase(), values![index + 1] ?? '');
  }
  return attributes;
}

/**
 * 从 DevTools 的“按坐标取最深节点”结果判断 Turnstile 内部是否已经出现。
 * Runtime.evaluate 会被 closed shadow retarget 到宿主；DOM.getNodeForLocation 则能在
 * 支持的 Chrome 版本里返回真正的跨域 frame/checkbox。探测失败只表示不可观测，
 * 之后仍会走满 15 秒安全窗口，不会把失败误当成已就绪。
 */
async function probeTurnstileDeepSignal(
  target: chrome.debugger.Debuggee,
  x: number,
  y: number,
  mainFrameId?: string,
  deadline?: number,
): Promise<TurnstileDeepObservation | null> {
  const commandDeadline = deadline ?? (Date.now() + CDP_COMMAND_TIMEOUT_MS);
  try {
    let located: CdpLocatedNode;
    try {
      located = await debuggerCommand<CdpLocatedNode>(target, 'DOM.getNodeForLocation', {
        x: Math.round(x),
        y: Math.round(y),
        includeUserAgentShadowDOM: true,
      }, commandDeadline);
    } catch {
      // 老版本协议可能不认识 includeUserAgentShadowDOM，保留兼容探测。
      located = await debuggerCommand<CdpLocatedNode>(target, 'DOM.getNodeForLocation', {
        x: Math.round(x),
        y: Math.round(y),
      }, commandDeadline);
    }

    if (located.frameId && mainFrameId && located.frameId !== mainFrameId) {
      return {
        signal: 'inner-frame',
        identity: `frame:${located.frameId}:node:${located.backendNodeId ?? 'unknown'}`,
      };
    }
    if (!located.backendNodeId) return null;

    const described = await debuggerCommand<CdpNodeDescription>(target, 'DOM.describeNode', {
      backendNodeId: located.backendNodeId,
      depth: 0,
      pierce: true,
    }, commandDeadline);
    const node = described.node;
    if (!node) return null;
    if (node.frameId && mainFrameId && node.frameId !== mainFrameId) {
      return {
        signal: 'inner-frame',
        identity: `frame:${node.frameId}:node:${located.backendNodeId}`,
      };
    }

    const name = (node.localName || node.nodeName || '').toLowerCase();
    const attributes = nodeAttributes(node.attributes);
    const source = `${attributes.get('src') ?? ''} ${node.documentURL ?? ''}`;
    // 裸 iframe 可能只是刚插入、尚未加载且仍不可点击的占位节点。只有明确的
    // Cloudflare 来源（或上面的跨 frame 命中）才能作为内部验证帧证据。
    if (/challenges\.cloudflare\.com|turnstile/i.test(source)) {
      return {
        signal: 'inner-frame',
        identity: `frame:${node.frameId ?? 'unknown'}:node:${located.backendNodeId}`,
      };
    }
    if (
      (name === 'input' && attributes.get('type')?.toLowerCase() === 'checkbox')
      || attributes.get('role')?.toLowerCase() === 'checkbox'
    ) {
      return {
        signal: 'interactive-control',
        identity: `node:${located.backendNodeId}`,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Turnstile 通用首击闸门。
 *
 * 10 秒以前绝不点击。之后只有浏览器协议连续观察到内部 frame/checkbox 800ms 才
 * 提前放行；closed shadow 在当前 Chrome 上仍不可观测时，等满 15 秒再按安全窗口
 * 放行。targetSeenAt 来自 content script 对当前宿主的 WeakMap，宿主重绘会重新计时。
 */
async function waitForTurnstileReadiness(
  target: chrome.debugger.Debuggee,
  token: string,
  anchor: PointerAnchor,
  targetSeenAt?: number,
  deadline?: number,
): Promise<TurnstileReadinessDiagnostics> {
  assertBeforeDeadline(deadline);
  const calledAt = Date.now();
  const seenAt = targetSeenAt != null && targetSeenAt <= calledAt + 1_000
    ? targetSeenAt
    : calledAt;
  const matureAt = seenAt + TURNSTILE_MIN_MATURE_MS;
  const safetyAt = seenAt + TURNSTILE_SAFETY_WINDOW_MS;
  const frameTree = await debuggerCommand<{ frameTree?: { frame?: { id?: string } } }>(
    target,
    'Page.getFrameTree',
    undefined,
    deadline ?? (Date.now() + CDP_COMMAND_TIMEOUT_MS),
  ).catch(() => null) as {
    frameTree?: { frame?: { id?: string } };
  } | null;
  assertBeforeDeadline(deadline);
  const mainFrameId = frameTree?.frameTree?.frame?.id;
  let stableSignal: TurnstileDeepSignal | null = null;
  let stableIdentity: string | null = null;
  let stableSince = 0;

  while (true) {
    assertBeforeDeadline(deadline);
    const live = await liveTargetPoint(
      target,
      token,
      anchor,
      deadline ?? (Date.now() + CDP_COMMAND_TIMEOUT_MS),
    );
    assertBeforeDeadline(deadline);
    if (!live) throw new Error('Turnstile 宿主在成熟检查期间已重绘或消失');

    const observation = await probeTurnstileDeepSignal(
      target,
      live.x,
      live.y,
      mainFrameId,
      deadline,
    );
    assertBeforeDeadline(deadline);
    const now = Date.now();
    const observedSignal = observation?.signal ?? null;
    const observedIdentity = observation?.identity ?? null;
    if (observedSignal !== stableSignal || observedIdentity !== stableIdentity) {
      stableSignal = observedSignal;
      stableIdentity = observedIdentity;
      stableSince = observation ? now : 0;
    }
    if (
      observation
      && now >= matureAt
      && stableSince > 0
      && now - stableSince >= TURNSTILE_READY_STABLE_MS
    ) {
      assertBeforeDeadline(deadline);
      return {
        signal: observation.signal,
        waitedMs: now - calledAt,
        widgetAgeMs: Math.max(0, now - seenAt),
      };
    }
    if (now >= safetyAt) {
      assertBeforeDeadline(deadline);
      return {
        signal: 'safety-window',
        waitedMs: now - calledAt,
        widgetAgeMs: Math.max(0, now - seenAt),
      };
    }
    const wakeAt = Math.min(safetyAt, deadline ?? Number.POSITIVE_INFINITY);
    const waitMs = Math.min(TURNSTILE_READY_POLL_MS, Math.max(1, wakeAt - now));
    if (deadline != null && now + waitMs >= deadline) {
      throw new Error('Turnstile 成熟等待已达到执行截止时间');
    }
    await pause(waitMs);
  }
}

/** 使用 Chrome DevTools Protocol 派发浏览器级鼠标事件。 */
export async function trustedPointerClick(
  tabId: number,
  input: TrustedPointerClick,
  random: RandomSource = Math.random,
  hooks: TrustedPointerClickHooks = {},
): Promise<{
  mode: 'trusted';
  pathPoints: number;
  clickObserved: boolean | null;
  target: PointerTargetDiagnostics;
  /** 坐标偏移诊断，便于排查「落点看着对、点击却无效」 */
  screenOffset?: {
    actual: { dx: number; dy: number };
    expected: { dx: number; dy: number };
    matches: boolean;
  };
  turnstileReadiness?: TurnstileReadinessDiagnostics;
}> {
  validateInput(input);
  // 即使调用方没有传 deadline，也不能让 debugger API 的异常 pending 把任务
  // 永久占住。显式 deadline 仍然优先，但最多给一次可信点击 30 秒。
  const deadline = Math.min(
    input.deadline ?? Number.POSITIVE_INFINITY,
    Date.now() + TRUSTED_POINTER_CLICK_MAX_MS,
  );
  assertBeforeDeadline(deadline);

  const target: chrome.debugger.Debuggee = { tabId };
  const sampledEnd = { x: input.x, y: input.y };
  const start = lastPointerByTab.get(tabId) ?? initialPointer(input, random);
  const path = buildHumanPointerPath(start, sampledEnd, random);
  /** 已发起 attach（不代表成功）——决定收尾是否要 detach，见 bestEffortDebuggerOperation。 */
  let attachRequested = false;
  let attached = false;
  let probeInstalled = false;
  let probeFinished = false;
  /**
   * 左键已经按下、但还没派发 mouseReleased。
   *
   * 按下与释放之间还有 `pauseBeforeDeadline`（剩余时间不足会抛）和
   * mouseReleased 自己的 `boundedOperation`（`remaining <= 0` 直接 reject），
   * 两处都能在按下之后中断。不补发释放的话页面只收到 mousedown、永远收不到
   * mouseup/click：目标控件停在 :active，站点侧看到的是「按住不放」，
   * 本轮必然判失败，而下一次点击会在浏览器仍认为左键按下的状态下再次按下，
   * 事件序列直接错乱。
   */
  let pressPending = false;
  /** 真正按下的落点（按下前重采样过），补发释放时必须用它而不是原采样点。 */
  let pressPoint = sampledEnd;
  let turnstileReadiness: TurnstileReadinessDiagnostics | undefined;

  try {
    assertBeforeDeadline(deadline);
    attachRequested = true;
    await boundedOperation(
      () => chrome.debugger.attach(target, '1.3'),
      deadline,
      'debugger.attach',
    );
    attached = true;
    await debuggerCommand(target, 'Page.bringToFront', undefined, deadline);
    await debuggerCommand(target, 'Input.setIgnoreInputEvents', { ignore: false }, deadline);
    const anchor = input.anchor ?? { kind: 'center' };
    if (anchor.kind === 'inset-left') {
      turnstileReadiness = await waitForTurnstileReadiness(
        target,
        input.targetToken,
        anchor,
        input.targetSeenAt,
        deadline,
      );
    }
    assertBeforeDeadline(deadline);
    // 内嵌页的点击不会冒泡到主文档；不能把主文档探针的未命中当成点击失败。
    probeInstalled = !input.frameTarget && await installClickProbe(target, input.targetToken, deadline);
    await pauseBeforeDeadline(45 + Math.round(random() * 35), deadline);

    for (const point of path) {
      assertBeforeDeadline(deadline);
      await debuggerCommand(target, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: point.x,
        y: point.y,
        buttons: 0,
        pointerType: 'mouse',
      }, deadline);
      await pauseBeforeDeadline(6 + Math.round(random() * 9), deadline);
    }

    // 曲线路径经过页面时可能触发 hover、平滑滚动或布局动画。按下前重新读取
    // 被 content script 标记的真实元素落点，确保释放点仍落在同一个控件上。
    // 必须按调用方传入的 anchor 规则重算（Turnstile 复选框在容器左边缘往里固定
    // 距离，不能一律取中心），否则鼠标会移到复选框、却在中心（文字上）按下。
    const live = await liveTargetPoint(target, input.targetToken, anchor, deadline, input.frameTarget);
    assertBeforeDeadline(deadline);
    // Turnstile 等跨 shadow DOM 的目标：withinHost 为真即放行（宿主包含命中元素）
    const allowShadow = anchor.kind === 'inset-left';
    if (!live || (!live.hit && !(allowShadow && live.withinHost))) {
      throw new Error('目标控件在鼠标移动过程中发生位移或被遮挡');
    }
    const end = { x: live.x, y: live.y };
    const correctionDistance = Math.hypot(end.x - sampledEnd.x, end.y - sampledEnd.y);
    const correctionSteps = correctionDistance > 1 ? clamp(Math.ceil(correctionDistance / 12), 3, 10) : 0;
    for (let index = 1; index <= correctionSteps; index += 1) {
      assertBeforeDeadline(deadline);
      const t = index / correctionSteps;
      const point = {
        x: sampledEnd.x + (end.x - sampledEnd.x) * t,
        y: sampledEnd.y + (end.y - sampledEnd.y) * t,
      };
      await debuggerCommand(target, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: point.x,
        y: point.y,
        buttons: 0,
        pointerType: 'mouse',
      }, deadline);
      await pauseBeforeDeadline(8 + Math.round(random() * 7), deadline);
    }

    await pauseBeforeDeadline(25 + Math.round(random() * 55), deadline);
    assertBeforeDeadline(deadline);
    if (input.inputAssertions?.length && !await assertInputValues(target, input.inputAssertions, deadline)) {
      throw new Error('登录输入在鼠标按下前发生变化，已取消点击');
    }
    /*
     * 手势派发：单击/双击/右键/长按都必须走同一条 CDP 通道。
     *
     * 学习侧会记录手势语义，回放侧只传坐标的话三种手势都会静默退化成单击：
     * 用户学到的是「双击展开、右键菜单、长按确认」，回放却只点一下 —— 页面
     * 毫无反应，却记成「已点击」。这里按学习到的语义逐条复现。
     */
    const { gesture, holdMs } = normalizeClickGesture(input);
    const clickCount = gesture === 'double' ? 2 : 1;
    const button: 'left' | 'right' = gesture === 'right' ? 'right' : 'left';
    pressPoint = end;
    const pressOnce = async (count: number): Promise<void> => {
      await debuggerCommand(target, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: end.x,
        y: end.y,
        button,
        buttons: gesture === 'right' ? 2 : 1,
        clickCount: count,
        pointerType: 'mouse',
      }, deadline);
      pressPending = true;
      await pauseBeforeDeadline(gesture === 'long-press'
        ? holdMs
        : 45 + Math.round(random() * 65), deadline);
      await debuggerCommand(target, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: end.x,
        y: end.y,
        button,
        buttons: 0,
        clickCount: count,
        pointerType: 'mouse',
      }, deadline);
      pressPending = false;
    };
    await pressOnce(clickCount);
    if (gesture === 'double') {
      await pauseBeforeDeadline(DOUBLE_CLICK_INTERVAL_MS, deadline);
      await pressOnce(2);
    }
    // React/Vue 的合成事件与状态提交会排到当前输入任务之后；立刻 detach
    // 偶发会让小按钮的 click 尚未完成就失去调试会话。等一小段时间再释放。
    await pause(90 + Math.round(random() * 70));

    const probeReport = probeInstalled
      ? await finishClickProbe(
          target,
          input.targetToken,
          Math.min(deadline, Date.now() + DEBUGGER_CLEANUP_TIMEOUT_MS),
        ).catch(() => null)
      : null;
    probeFinished = true;
    if (probeReport?.clickObserved !== false && hooks.afterClick) {
      await boundedOperation(hooks.afterClick, deadline, '点击后状态写入');
    }

    // 记录坐标偏移诊断信息到 console，让 background devtools 能看到
    if (probeReport?.offsetActual && probeReport?.offsetExpected) {
      const a = probeReport.offsetActual;
      const e = probeReport.offsetExpected;
      const ok = Math.abs(a.dx - e.dx) <= 8 && Math.abs(a.dy - e.dy) <= 8;
      console.log(
        `[TrustedPointer] screenOffset: actual dx=${a.dx} dy=${a.dy}  expected dx=${e.dx} dy=${e.dy}  ${ok ? '✓ match' : '✗ MISMATCH — infobar height shift'}`,
      );
    }

    lastPointerByTab.set(tabId, end);
    const offset = probeReport?.offsetActual && probeReport?.offsetExpected
      ? {
        actual: probeReport.offsetActual,
        expected: probeReport.offsetExpected,
        matches: Math.abs(probeReport.offsetActual.dx - probeReport.offsetExpected.dx) <= 8
          && Math.abs(probeReport.offsetActual.dy - probeReport.offsetExpected.dy) <= 8,
      }
      : undefined;
    /*
     * 到位证据按手势取：
     * - 右键只派发 contextmenu（浏览器不发 click），用 contextmenu 判定；
     * - 其余手势（单击/双击/长按）看 click。
     * 之前统一看 click，导致每一次右键回放都被误判成「鼠标事件未到达目标控件」。
     */
    const gestureObserved = gesture === 'right'
      ? (probeReport?.contextmenuObserved ?? null)
      : (probeReport?.clickObserved ?? null);
    return {
      mode: 'trusted',
      pathPoints: path.length + correctionSteps,
      clickObserved: gestureObserved,
      target: live,
      screenOffset: offset,
      turnstileReadiness,
    };
  } finally {
    /*
     * 按下之后中断（截止时间耗尽、目标校验失败、CDP 超时）必须补发释放。
     *
     * 走 bestEffortDebuggerOperation 而不是 debuggerCommand：这时候 deadline
     * 往往**已经过了**，用原 deadline 的话 `remaining <= 0` 会直接 reject，
     * 补发等于没做。清理动作给自己一个独立的小预算。
     */
    if (attached && pressPending) {
      pressPending = false;
      await bestEffortDebuggerOperation(
        () => chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: pressPoint.x,
          y: pressPoint.y,
          button: 'left',
          buttons: 0,
          clickCount: 1,
          pointerType: 'mouse',
        }),
        '中断后补发 mouseReleased',
      );
    }
    if (attached && probeInstalled && !probeFinished) {
      await finishClickProbe(
        target,
        input.targetToken,
        Date.now() + DEBUGGER_CLEANUP_TIMEOUT_MS,
      ).catch(() => null);
    }
    if (attachRequested) {
      await bestEffortDebuggerOperation(
        () => chrome.debugger.detach(target),
        'debugger.detach',
      );
    }
  }
}

export interface TrustedPointerScrollInput {
  x: number;
  y: number;
  viewportWidth: number;
  viewportHeight: number;
  deltaY: number;
  steps?: number;
}

function validateScrollInput(input: TrustedPointerScrollInput): void {
  const values = [input.x, input.y, input.viewportWidth, input.viewportHeight, input.deltaY];
  if (!values.every(Number.isFinite)) throw new Error('滚动参数不是有效数字');
  if (input.viewportWidth < 2 || input.viewportHeight < 2) throw new Error('页面视口尺寸无效');
  if (input.x < 0 || input.y < 0 || input.x > input.viewportWidth || input.y > input.viewportHeight) {
    throw new Error('滚动坐标不在当前视口内');
  }
  if (Math.abs(input.deltaY) < 1 || Math.abs(input.deltaY) > 20_000) throw new Error('滚动距离超出允许范围');
  if (input.steps != null && (!Number.isInteger(input.steps) || input.steps < 1 || input.steps > 12)) {
    throw new Error('滚动分段数超出允许范围');
  }
}

export async function trustedPointerScroll(
  tabId: number,
  input: TrustedPointerScrollInput,
  random: RandomSource = Math.random,
): Promise<{ mode: 'trusted'; deltaY: number; steps: number }> {
  validateScrollInput(input);
  const steps = input.steps ?? clamp(Math.ceil(Math.abs(input.deltaY) / 240), 3, 8);
  const target: chrome.debugger.Debuggee = { tabId };
  // 与可信点击同一条规则：任何 CDP 调用都要有界，否则一次不 settle 的调用
  // 会把整个签到队列占住。
  const deadline = Date.now() + TRUSTED_POINTER_GESTURE_MAX_MS;
  let attachRequested = false;
  try {
    attachRequested = true;
    await boundedOperation(() => chrome.debugger.attach(target, '1.3'), deadline, 'debugger.attach');
    await debuggerCommand(target, 'Page.bringToFront', undefined, deadline);
    await debuggerCommand(target, 'Input.setIgnoreInputEvents', { ignore: false }, deadline);
    const start = lastPointerByTab.get(tabId) ?? { x: input.x, y: input.y };
    const path = buildHumanPointerPath(start, { x: input.x, y: input.y }, random);
    for (const point of path) {
      await debuggerCommand(target, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: point.x, y: point.y, buttons: 0, pointerType: 'mouse',
      }, deadline);
      await pause(5 + Math.round(random() * 8));
    }
    const base = input.deltaY / steps;
    for (let index = 0; index < steps; index += 1) {
      const delta = index === steps - 1 ? input.deltaY - base * index : base;
      await debuggerCommand(target, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: input.x, y: input.y, deltaX: 0, deltaY: delta,
      }, deadline);
      await pause(20 + Math.round(random() * 40));
    }
    lastPointerByTab.set(tabId, { x: input.x, y: input.y });
    return { mode: 'trusted', deltaY: input.deltaY, steps };
  } finally {
    if (attachRequested) {
      await bestEffortDebuggerOperation(() => chrome.debugger.detach(target), 'debugger.detach');
    }
  }
}

export interface TrustedPointerDragPoint {
  x: number;
  y: number;
  /** 到达该点后的停留毫秒数 */
  delayMs: number;
}

export interface TrustedPointerDragInput {
  /** 按钮按压起点（把手位置） */
  startX: number;
  startY: number;
  /** 拖拽路径点：按下后依次移动 mouseMoved(buttons:1)，最后一个点即释放位置 */
  points: TrustedPointerDragPoint[];
  viewportWidth: number;
  viewportHeight: number;
  /** Optional DOM marker. When present, resample the handle immediately before press. */
  targetToken?: string;
  frameTarget?: FramePointerTarget;
  /**
   * 松开点所在控件的标记。
   *
   * 给了它（以及 toAnchor）时，后台会在按下前同时采样起点与终点：轨迹按
   * 「实时起点 - 录制起点」平移，并收敛到「实时终点 + 录制相对落点」，
   * 保证终点落点仍然落在学习时那个控件的同一相对位置。
   */
  toTargetToken?: string;
  /** 起点落点；缺省中心。 */
  fromAnchor?: PointerAnchor;
  /** 终点落点；缺省中心。 */
  toAnchor?: PointerAnchor;
}

/**
 * 按住不松手的拖拽会话。
 *
 * 存在的理由：滑块的两个关键量 —— **碎片真实轮廓**和**把手位移与碎片位移的比例**
 * —— 靠 DOM 矩形和 `trackRect/pieceRect` 推断都可能错，而错了之后日志看着一切
 * 正常（这正是连续失败却查不出原因的根源）。
 *
 * 唯一可靠的办法是**测**：按下把手、先移一小段不松手、截图，与按下前的截图相减，
 * 变化的那些像素就是碎片的真实形状和真实位移。测完再继续拖到目标位置释放，
 * 整个过程是**同一次手势**，站点看到的是一条连续轨迹。
 */
export interface TrustedDragSession {
  /** 当前指针位置（视口 CSS 像素） */
  readonly current: { x: number; y: number };
  /** 截当前视口，返回 base64 PNG（不解码，避免与图像模块循环依赖） */
  screenshot(): Promise<string>;
  /** 沿给定路径继续移动，保持左键按住 */
  moveBy(points: readonly TrustedPointerDragPoint[]): Promise<void>;
  /** 在当前位置释放左键，结束会话 */
  release(): Promise<void>;
}

export interface TrustedDragSessionInput {
  startX: number;
  startY: number;
  viewportWidth: number;
  viewportHeight: number;
  targetToken?: string;
  frameTarget?: FramePointerTarget;
}

function validateDragPoint(
  point: TrustedPointerDragPoint,
  viewportWidth: number,
  viewportHeight: number,
): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.delayMs)) {
    throw new Error('拖拽路径点坐标或延时不是有效数字');
  }
  if (point.x < 0 || point.y < 0 || point.x > viewportWidth || point.y > viewportHeight) {
    throw new Error('拖拽路径点不在当前视口内');
  }
  if (point.delayMs < 0 || point.delayMs > 5_000) {
    throw new Error('拖拽路径点延时超出允许范围（0-5000ms）');
  }
}

function validateDragInput(input: TrustedPointerDragInput): void {
  const values = [input.startX, input.startY, input.viewportWidth, input.viewportHeight];
  if (!values.every(Number.isFinite)) throw new Error('拖拽参数不是有效数字');
  if (input.viewportWidth < 2 || input.viewportHeight < 2) throw new Error('页面视口尺寸无效');
  if (input.startX < 0 || input.startY < 0 || input.startX > input.viewportWidth || input.startY > input.viewportHeight) {
    throw new Error('拖拽起点不在当前视口内');
  }
  if (!Array.isArray(input.points) || input.points.length < 2) {
    throw new Error('拖拽路径至少需要 2 个点');
  }
  if (input.targetToken && !/^p-[a-z0-9-]{8,80}$/i.test(input.targetToken)) {
    throw new Error('拖拽目标控件标记无效');
  }
  for (const token of [input.toTargetToken]) {
    if (token && !/^p-[a-z0-9-]{8,80}$/i.test(token)) {
      throw new Error('拖拽终点控件标记无效');
    }
  }
  for (const p of input.points) {
    validateDragPoint(p, input.viewportWidth, input.viewportHeight);
  }
}

/**
 * 通过 CDP 派发浏览器级鼠标拖拽（按住左键-移动-释放）。
 *
 * 1. 将指针平滑移动到起点（把手位置）
 * 2. 按下左键（mousePressed, buttons:1）
 * 3. 逐点移动（mouseMoved, buttons:1），每点间按 delayMs 暂停
 * 4. 释放左键（mouseReleased）
 */
export async function trustedPointerDrag(
  tabId: number,
  input: TrustedPointerDragInput,
  random: RandomSource = Math.random,
): Promise<{
  mode: 'trusted';
  dragPoints: number;
  totalDistance: number;
}> {
  validateDragInput(input);

  const target: chrome.debugger.Debuggee = { tabId };
  // 拖拽的每一步同样要有界：轨迹点最多 12 段、每段带停顿，但任何一步
  // 不 settle 都会让左键按住 + 调试器挂着，直到 Service Worker 被回收。
  const deadline = Date.now() + TRUSTED_POINTER_GESTURE_MAX_MS;
  let start = { x: input.startX, y: input.startY };
  let points = input.points;
  let lastPoint = points[points.length - 1]!;
  let attachRequested = false;
  /** 左键已按下、还没派发 mouseReleased。见 trustedPointerClick 里的同名说明。 */
  let pressPending = false;
  let pressPoint = start;

  try {
    attachRequested = true;
    await boundedOperation(() => chrome.debugger.attach(target, '1.3'), deadline, 'debugger.attach');
    await debuggerCommand(target, 'Page.bringToFront', undefined, deadline);
    await debuggerCommand(target, 'Input.setIgnoreInputEvents', { ignore: false }, deadline);

    if (input.targetToken) {
      // 起点按调用方的 anchor 规则重采样（缺省中心）：内缩落点不能在这里被改回中心。
      const live = await liveTargetPoint(
        target,
        input.targetToken,
        input.fromAnchor ?? { kind: 'center' },
        deadline,
        input.frameTarget,
      );
      if (!live?.hit) throw new Error('滑块把手在拖动前已重绘、移位或被遮挡');
      const deltaX = live.x - start.x;
      const deltaY = live.y - start.y;
      start = { x: live.x, y: live.y };
      points = input.points.map((point) => ({
        ...point,
        x: point.x + deltaX,
        y: point.y + deltaY,
      }));
      lastPoint = points[points.length - 1]!;
    }
    if (input.toTargetToken) {
      /*
       * 终点控件同样在按下前重采样：轨迹的尾段线性收敛到「实时终点 + 学习时的
       * 相对落点」。只按起点整体平移的话，起点控件与终点控件位移量不同（排序
       * 列表重排、布局动画）时松开点会落到别的元素上。
       */
      const liveTo = await liveTargetPoint(
        target,
        input.toTargetToken,
        input.toAnchor ?? { kind: 'center' },
        deadline,
        input.frameTarget,
      );
      if (!liveTo?.hit) throw new Error('拖拽终点在拖动前已重绘、移位或被遮挡');
      const targetEnd = { x: liveTo.x, y: liveTo.y };
      const currentEnd = points[points.length - 1]!;
      const count = points.length;
      points = points.map((point, index) => {
        const t = (index + 1) / count;
        return {
          ...point,
          x: point.x + (targetEnd.x - currentEnd.x) * t,
          y: point.y + (targetEnd.y - currentEnd.y) * t,
        };
      });
      lastPoint = points[points.length - 1]!;
    }
    if (points.some((point) => (
      point.x < 0 || point.y < 0 || point.x > input.viewportWidth || point.y > input.viewportHeight
    ))) {
      throw new Error('重采样后的拖动轨迹超出当前视口');
    }

    // 从上次指针位置（或随机起点）平滑移动到把手位置
    const approachStart = lastPointerByTab.get(tabId) ?? {
      x: (1 + random() * (input.viewportWidth - 2)),
      y: (1 + random() * (input.viewportHeight - 2)),
    };
    const approachPath = buildHumanPointerPath(approachStart, start, random);
    for (const pt of approachPath) {
      await debuggerCommand(target, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: pt.x, y: pt.y, buttons: 0, pointerType: 'mouse',
      }, deadline);
      await pause(5 + Math.round(random() * 8));
    }

    // 按压前短暂停顿（模拟人类放上手指的瞬间）
    await pause(80 + Math.round(random() * 70));

    // 按下左键
    await debuggerCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: start.x,
      y: start.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
      pointerType: 'mouse',
    }, deadline);
    pressPending = true;
    pressPoint = start;

    // 拖拽开始后短暂停顿再移动（人类手指按住后反馈延迟）
    await pause(30 + Math.round(random() * 40));

    // 逐点移动（按住左键的状态）
    for (const pt of points) {
      await debuggerCommand(target, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: pt.x,
        y: pt.y,
        button: 'left',
        buttons: 1,
        pointerType: 'mouse',
      }, deadline);
      pressPoint = pt;
      if (pt.delayMs > 0) {
        await pause(pt.delayMs);
      }
    }

    // 释放前留出一个稳定确认窗口；过早释放会让部分滑块在最后一帧
    // 尚未消费时就开始验收，表现为“看似到位但未重合”。
    await pause(45 + Math.round(random() * 35));

    // 释放左键
    await debuggerCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: lastPoint.x,
      y: lastPoint.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
      pointerType: 'mouse',
    }, deadline);
    pressPending = false;

    // 等 React/Vue 合成事件处理完
    await pause(90 + Math.round(random() * 70));

    lastPointerByTab.set(tabId, lastPoint);
    let totalDistance = 0;
    let previous = start;
    for (const point of points) {
      totalDistance += Math.hypot(point.x - previous.x, point.y - previous.y);
      previous = point;
    }
    return {
      mode: 'trusted',
      dragPoints: points.length,
      totalDistance: Math.round(totalDistance * 10) / 10,
    };
  } finally {
    // 按住不放会让页面永久停在拖拽态：中途抛错也必须松手，且要在 detach 之前。
    if (pressPending) {
      pressPending = false;
      await bestEffortDebuggerOperation(
        () => chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: pressPoint.x,
          y: pressPoint.y,
          button: 'left',
          buttons: 0,
          clickCount: 1,
          pointerType: 'mouse',
        }),
        '中断后补发 mouseReleased',
      );
    }
    if (attachRequested) {
      await bestEffortDebuggerOperation(() => chrome.debugger.detach(target), 'debugger.detach');
    }
  }
}

/**
 * 开一个按住左键的拖拽会话，允许中途截图测量。
 *
 * 与 `trustedPointerDrag` 的区别只在于**不预先决定终点**：调用方按下之后可以
 * 截图、算距离、再决定往哪走。debugger 会话在整个过程中保持连接 —— 截图和
 * 指针派发都要 attach 同一个 tabId，分两次 attach 会撞 CDP 的单连接限制。
 *
 * 无论中途抛什么错，`finally` 都会释放左键并 detach：按住不放会让页面永久停在
 * 拖拽态，用户连手动完成都做不到。
 */
export async function openTrustedDragSession(
  tabId: number,
  input: TrustedDragSessionInput,
  random: RandomSource = Math.random,
): Promise<TrustedDragSession> {
  const values = [input.startX, input.startY, input.viewportWidth, input.viewportHeight];
  if (!values.every(Number.isFinite)) throw new Error('拖拽参数不是有效数字');
  if (input.viewportWidth < 2 || input.viewportHeight < 2) throw new Error('页面视口尺寸无效');
  if (input.startX < 0 || input.startY < 0
    || input.startX > input.viewportWidth || input.startY > input.viewportHeight) {
    throw new Error('拖拽起点不在当前视口内');
  }
  if (input.targetToken && !/^p-[a-z0-9-]{8,80}$/i.test(input.targetToken)) {
    throw new Error('拖拽目标控件标记无效');
  }

  const target: chrome.debugger.Debuggee = { tabId };
  /**
   * 整个会话的截止时间。
   *
   * 会话的每一步（按下、移动、截图、释放）都受它约束。没有它的话，一次不 settle
   * 的 `Page.captureScreenshot`（`fromSurface: true` 在窗口被遮挡/最小化时尤其
   * 容易拿不到帧）会让 `finish()` 永远不被调用：左键一直按住、调试器一直挂着，
   * 而 `slider-crack.ts` 的 `activeCracks` 条目也永久驻留 —— 该标签页之后每次
   * SLIDER_CRACK 都只能拿到 busy，滑块子系统对这个 tab 彻底报废。
   */
  const deadline = Date.now() + TRUSTED_DRAG_SESSION_MAX_MS;
  /**
   * 已发起 attach。与 `attached` 分开：后者表示「会话还开着、可以继续派发」，
   * 前者只表示「必须 detach」—— 包装超时但底层 attach 仍可能成功。
   */
  let attachRequested = false;
  let attached = false;
  let released = false;
  let releasePromise: Promise<void> | undefined;
  let current = { x: input.startX, y: input.startY };
  /** 左键已按下、还没派发 mouseReleased。 */
  let pressPending = false;

  const ensureOpen = () => {
    if (released || !attached) throw new Error('拖拽会话已经结束');
    assertBeforeDeadline(deadline);
  };

  const dispatch = (type: string, extra: Record<string, unknown>, stepDeadline = deadline) =>
    debuggerCommand(target, 'Input.dispatchMouseEvent', {
      type, x: current.x, y: current.y, pointerType: 'mouse', ...extra,
    }, stepDeadline);

  try {
    attachRequested = true;
    await boundedOperation(() => chrome.debugger.attach(target, '1.3'), deadline, 'debugger.attach');
    attached = true;
    await debuggerCommand(target, 'Page.bringToFront', undefined, deadline);
    await debuggerCommand(target, 'Input.setIgnoreInputEvents', { ignore: false }, deadline);

    if (input.targetToken) {
      const live = await liveTargetPoint(target, input.targetToken, { kind: 'center' }, deadline, input.frameTarget);
      if (!live?.hit) throw new Error('滑块把手在拖动前已重绘、移位或被遮挡');
      current = { x: live.x, y: live.y };
    }

    const approachStart = lastPointerByTab.get(tabId) ?? {
      x: 1 + random() * (input.viewportWidth - 2),
      y: 1 + random() * (input.viewportHeight - 2),
    };
    for (const point of buildHumanPointerPath(approachStart, current, random)) {
      await debuggerCommand(target, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: point.x, y: point.y, buttons: 0, pointerType: 'mouse',
      }, deadline);
      await pause(5 + Math.round(random() * 8));
    }
    await pause(80 + Math.round(random() * 70));
    await dispatch('mousePressed', { button: 'left', buttons: 1, clickCount: 1 });
    pressPending = true;
    await pause(30 + Math.round(random() * 40));
  } catch (error) {
    // 建立阶段就失败：按下过就要松手，再 detach。
    if (pressPending) {
      pressPending = false;
      await bestEffortDebuggerOperation(
        () => chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: current.x,
          y: current.y,
          button: 'left',
          buttons: 0,
          clickCount: 1,
          pointerType: 'mouse',
        }),
        '中断后补发 mouseReleased',
      );
    }
    attached = false;
    if (attachRequested) {
      await bestEffortDebuggerOperation(() => chrome.debugger.detach(target), 'debugger.detach');
    }
    throw error;
  }

  const finish = (): Promise<void> => {
    if (releasePromise) return releasePromise;
    if (released) return Promise.resolve();
    released = true;
    releasePromise = (async () => {
      try {
        /*
         * 释放走 bestEffort 而不是 dispatch(deadline)：会话可能正是**因为超时**
         * 才走到这里，用原 deadline 的话 `remaining <= 0` 直接 reject，
         * 左键就留在按下态了 —— 而松手是这里最不能省的一步。
         */
        if (pressPending) {
          pressPending = false;
          await bestEffortDebuggerOperation(
            () => chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
              type: 'mouseReleased',
              x: current.x,
              y: current.y,
              button: 'left',
              buttons: 0,
              clickCount: 1,
              pointerType: 'mouse',
            }),
            'CDP Input.dispatchMouseEvent(mouseReleased)',
          );
        }
        await pause(90 + Math.round(random() * 70));
        lastPointerByTab.set(tabId, { ...current });
      } finally {
        attached = false;
        if (attachRequested) {
          await bestEffortDebuggerOperation(() => chrome.debugger.detach(target), 'debugger.detach');
        }
      }
    })();
    return releasePromise;
  };

  return {
    get current() {
      return { ...current };
    },
    async screenshot(): Promise<string> {
      ensureOpen();
      // 截图给自己一个更宽的预算（要等一帧真正合成），但仍不得越过会话截止时间。
      const result = await boundedOperation(
        () => chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
          format: 'png', fromSurface: true, captureBeyondViewport: false,
        }) as Promise<{ data?: string }>,
        Math.min(deadline, Date.now() + CDP_SCREENSHOT_TIMEOUT_MS),
        'CDP Page.captureScreenshot',
        CDP_SCREENSHOT_TIMEOUT_MS,
      );
      if (!result.data) throw new Error('拖拽过程中 CDP 截图返回空数据');
      return result.data;
    },
    async moveBy(points: readonly TrustedPointerDragPoint[]): Promise<void> {
      ensureOpen();
      for (const point of points) {
        validateDragPoint(point, input.viewportWidth, input.viewportHeight);
        current = { x: point.x, y: point.y };
        await dispatch('mouseMoved', { button: 'left', buttons: 1 });
        if (point.delayMs > 0) await pause(Math.min(5_000, point.delayMs));
      }
    },
    release: finish,
  };
}

export function forgetPointer(tabId: number): void {
  lastPointerByTab.delete(tabId);
}
