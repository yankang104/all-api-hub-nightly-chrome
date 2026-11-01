import type { WorkflowGesture } from '@/types/workflow';

/**
 * 落点规则。后台在鼠标移动结束后会重新采样目标位置（控件可能因 hover 或
 * 布局动画位移），必须按同一规则重算，否则内缩落点会被改回元素中心。
 */
export type PointerAnchor =
  | { kind: 'center' }
  | { kind: 'inset-left'; px: number }
  | { kind: 'relative'; rx: number; ry: number };

/**
 * 把相对落点钳到 0..1。
 *
 * `relative` 的 rx/ry 来自学习产物或站点配置，可能是 NaN、负数或超过 1 的越界值；
 * 直接参与计算会让鼠标落到元素外，且 NaN 会被后续 `Math.max/min` 静默放大成
 * 「点到别处」。前台函数与后台表达式必须用同一份钳制，所以两边都写进同一规则里。
 */
function clampAnchorRatio(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5;
}

/**
 * 按落点规则算水平坐标。
 *
 * content script 与后台必须用同一个规则：曾经后台无条件取元素中心，把 content
 * script 算好的内缩坐标改回中心，表现为「调试红点位置对、点击却落空」。anchorX /
 * anchorY 与 anchorXExpression / anchorYExpression 是同一份算法的两种形态，
 * 改一个必须改另一个（含钳制规则）。
 */
export function anchorX(rect: { left: number; width: number }, anchor: PointerAnchor): number {
  if (anchor.kind === 'inset-left') return rect.left + Math.min(anchor.px, rect.width / 2);
  if (anchor.kind === 'relative') return rect.left + rect.width * clampAnchorRatio(anchor.rx);
  return rect.left + rect.width / 2;
}

/**
 * 按落点规则算垂直坐标。
 *
 * 与 anchorX 对称：center / inset-left 取垂直中心，relative 按 ry 还原。
 * 后台重采样必须与前台算出同一个 y，否则「调试红点位置对、点击却落空」会从
 * 水平坐标复刻到垂直坐标。
 */
export function anchorY(rect: { top: number; height: number }, anchor: PointerAnchor): number {
  if (anchor.kind === 'relative') return rect.top + rect.height * clampAnchorRatio(anchor.ry);
  return rect.top + rect.height / 2;
}

/**
 * 生成与 anchorX 等价的 JS 表达式，供后台的 CDP Runtime.evaluate 用
 * （那边只能传字符串进页面，没法直接调函数）。
 */
export function anchorXExpression(anchor: PointerAnchor, rectVar = 'rect'): string {
  if (anchor.kind === 'inset-left') return `${rectVar}.left + Math.min(${anchor.px}, ${rectVar}.width / 2)`;
  if (anchor.kind === 'relative') {
    return `${rectVar}.left + ${rectVar}.width * ${ratioExpression(anchor.rx)}`;
  }
  return `${rectVar}.left + ${rectVar}.width / 2`;
}

/**
 * 生成与 anchorY 等价的 JS 表达式。规则与 anchorXExpression 完全对称。
 */
export function anchorYExpression(anchor: PointerAnchor, rectVar = 'rect'): string {
  if (anchor.kind === 'relative') {
    return `${rectVar}.top + ${rectVar}.height * ${ratioExpression(anchor.ry)}`;
  }
  return `${rectVar}.top + ${rectVar}.height / 2`;
}

/** 钳制逻辑的表达式形态；非有限值走 0.5，与 clampAnchorRatio 一致。 */
function ratioExpression(value: number): string {
  return `(Number.isFinite(${value}) ? Math.min(1, Math.max(0, ${value})) : 0.5)`;
}

/** 浏览器级鼠标点击消息。 */
export interface TrustedPointerClick {
  type: 'TRUSTED_POINTER_CLICK';
  runId: string;
  x: number;
  y: number;
  viewportWidth: number;
  viewportHeight: number;
  targetToken: string;
  /** 仅为本轮验证码 iframe 自身的刷新等控件开放，不授权第三方业务点击。 */
  frameSessionId?: string;
  /** 省略时按中心点击，与历史行为一致。 */
  anchor?: PointerAnchor;
  /** Turnstile 外层宿主第一次出现的时间；后台据此计算通用成熟窗口。 */
  targetSeenAt?: number;
  /** 绝对截止时间（Date.now() 毫秒）；到期后禁止开始派发鼠标按压。 */
  deadline?: number;
  /**
   * 手势语义；缺省单击左键。
   *
   * 学习侧会记录双击/右键/长按，可信指针通道必须按同一份语义派发 ——
   * 只传坐标的话，三种手势都会静默退化成普通单击（学到 ≠ 回放对）。
   */
  gesture?: WorkflowGesture;
  /** `long-press` 的按住时长（毫秒）；缺省 600ms。 */
  holdMs?: number;
}

/** Turnstile 首击前由浏览器协议完成的内部就绪诊断。 */
export interface TurnstileReadinessDiagnostics {
  /** 内部验证 frame/checkbox 可观测，或不可观测时走满安全窗口。 */
  signal: 'inner-frame' | 'interactive-control' | 'safety-window';
  /** 本次后台调用为成熟检查额外等待的时间。 */
  waitedMs: number;
  /** 点击前该宿主从首次出现算起的存活时间。 */
  widgetAgeMs: number;
}

/** 点击按下前由后台重新采样到的真实目标几何。 */
export interface PointerTargetDiagnostics {
  x: number;
  y: number;
  rect: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  /** 落点直接命中被标记的目标或其后代。 */
  hit: boolean;
  /** 落点与目标互为包含关系；closed shadow host 场景可能只有这个信号。 */
  withinHost: boolean;
}

/** 浏览器级鼠标拖拽消息。 */
export interface TrustedPointerDrag {
  type: 'TRUSTED_POINTER_DRAG';
  runId: string;
  startX: number;
  startY: number;
  points: Array<{ x: number; y: number; delayMs: number }>;
  viewportWidth: number;
  viewportHeight: number;
  /** 拖拽按下点所在的控件标记（可选：纯坐标拖拽不带标记）。 */
  fromTargetToken?: string;
  /**
   * 拖拽松开点所在控件标记。
   *
   * 与 fromTargetToken 一起给出时，后台会在按下前按各自 anchor 重新采样起点，
   * 并把整条轨迹平移到「实时起点」上 —— 控件在鼠标移动过程中位移后，
   * 松开点仍落在学习时那个目标的同一相对位置。
   */
  toTargetToken?: string;
  /** 起点落点；缺省中心。 */
  fromAnchor?: PointerAnchor;
  /** 终点落点；缺省中心。 */
  toAnchor?: PointerAnchor;
  deadline?: number;
}

/** 浏览器级鼠标滚轮消息。 */
export interface TrustedPointerScroll {
  type: 'TRUSTED_POINTER_SCROLL';
  runId: string;
  x: number;
  y: number;
  viewportWidth: number;
  viewportHeight: number;
  deltaY: number;
  steps?: number;
}

export type PointerMessage = TrustedPointerClick | TrustedPointerScroll | TrustedPointerDrag;

export interface PointerResponse {
  pointer?: {
    mode: 'trusted';
    pathPoints: number;
    clickObserved: boolean | null;
    /** 鼠标按下前的最终落点与目标矩形；点击路径中的布局变化已计入。 */
    target?: PointerTargetDiagnostics;
    /** 仅 Turnstile 外层宿主点击返回。 */
    turnstileReadiness?: TurnstileReadinessDiagnostics;
    /** 滚轮事件使用时的实际总滚动量与分段数 */
    scroll?: { deltaY: number; steps: number };
    /** 拖拽事件使用时的实际移动点数与总距离 */
    drag?: { points: number; totalDistance: number };
    /**
     * 事件坐标偏移诊断。screenX-clientX 应等于窗口左边距，screenY-clientY 应等于
     * 浏览器界面高度；Turnstile 会核对这个偏移。调试器信息栏会抬高界面，若 CDP
     * 仍按旧值填充就会出现不一致 —— 这是目前唯一未排除的拒发原因。
     */
    screenOffset?: {
      actual: { dx: number; dy: number };
      expected: { dx: number; dy: number };
      matches: boolean;
    };
  };
}
