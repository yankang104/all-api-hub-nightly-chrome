import { sendMessage } from '@/lib/core/messaging';
import {
  anchorX,
  anchorY,
  type PointerAnchor,
  type PointerResponse,
} from '@/lib/messages/pointer';
import type { PointerMode } from '@/types';
import type { WorkflowGesture, WorkflowKey, WorkflowPointerAnchor } from '@/types/workflow';

/** content script 用的 DOM 工具集 */

let activeClickRunId: string | null = null;
let activePointerMode: PointerMode = 'trusted';
let activeSliderFrameSessionId: string | undefined;

export function setActiveClickRunId(runId: string | null, pointerMode: PointerMode = 'trusted', frameSessionId?: string): void {
  activeClickRunId = runId;
  activePointerMode = pointerMode;
  activeSliderFrameSessionId = runId ? frameSessionId : undefined;
}

export function getActiveClickRunId(): string | null {
  return activeClickRunId;
}

export function getActiveSliderFrameSessionId(): string | undefined {
  return activeSliderFrameSessionId;
}

interface RealClickOptions {
  /** 点击会触发整页导航；页面销毁时 Chrome 可能来不及把可信点击回执送回 content script。 */
  mayNavigate?: boolean;
  /**
   * 回执超时时仍继续核对页面终态。只用于已经持久化动作上下文、且能从页面
   * 明确判断成功与否的操作；不能给普通登录或退出按钮兜底。
   */
  reconcileAfterLostResponse?: boolean;
  /**
   * 点击目标在 shadow DOM 或跨域 iframe 内，content script 观察不到实际的交互。
   * 用于 Turnstile/reCAPTCHA 等验证控件：点击容器，事件穿透到内部，但 clickObserved 会是 false。
   */
  shadowTarget?: boolean;
  /**
   * 从元素左边缘往右内缩的绝对像素数，用来替代默认的中心点。
   *
   * Turnstile 的复选框距容器左边缘约 24px，与容器总宽无关；用百分比偏移
   * 会随容器变宽而越偏越远（474px 宽的容器上 15% 就是 71px，落到文字上了）。
   */
  insetLeftPx?: number;
  /**
   * 学习到的元素内相对落点（0..1），用来还原「用户点的是控件的哪个位置」。
   *
   * 与 `insetLeftPx` 同时给出时**以 anchor 为准**：相对落点是学习产物，
   * 比 Turnstile 专用的固定内缩更具体。`insetLeftPx` 的历史行为保持不变。
   */
  anchor?: WorkflowPointerAnchor;
  /**
   * 手势语义；缺省单击左键，历史行为不变。
   *
   * - `double`：双击；`right`：右键（contextmenu）；`long-press`：按住超过阈值再松开。
   */
  gesture?: WorkflowGesture;
  /**
   * 用键盘触发而不是鼠标，只接受非打印功能键白名单。
   *
   * 学习侧只采集 Enter/Space/Escape/Tab/方向键；可打印字符永远不会走这条路径，
   * 以免把输入内容用击键重放出去。
   */
  key?: WorkflowKey;
  /** `long-press` 的按住时长（毫秒）；缺省 600ms。 */
  holdMs?: number;
  /**
   * 在点击前显示视觉标记（用于调试点击位置）。
   * 会在目标坐标上绘制一个红色圆点并保持 2 秒。
   */
  debugVisualize?: boolean;
  /** 接收后台按下前重新采样的最终落点，供验证流程写入可审计日志。 */
  onPointerResult?: (result: NonNullable<PointerResponse['pointer']>) => void;
  /** Turnstile 外层宿主首次出现时间，用于后台内部就绪探测与安全窗口。 */
  targetSeenAt?: number;
  /** Absolute time after which this click must not begin pressing the pointer. */
  deadline?: number;
}

/** realDrag 的输入。steps 是**中间点数量**：0 表示直接在起点与终点间松开。 */
export interface RealDragOptions {
  fromAnchor?: WorkflowPointerAnchor;
  toAnchor?: WorkflowPointerAnchor;
  /** 拖动中间点数量；缺省 12，合法范围 0..64。 */
  steps?: number;
  /** 绝对截止时间（Date.now() 毫秒）；到期后禁止开始新的输入派发。 */
  deadline?: number;
}

function rectMoved(a: DOMRect, b: DOMRect): boolean {
  return Math.abs(a.left - b.left) > 1
    || Math.abs(a.top - b.top) > 1
    || Math.abs(a.width - b.width) > 1
    || Math.abs(a.height - b.height) > 1;
}

/** 等待平滑滚动/布局动画结束，避免鼠标沿轨迹移动时目标已经离开采样坐标。 */
function assertBeforeClickDeadline(deadline?: number): void {
  if (deadline != null && Date.now() >= deadline) {
    throw new Error('点击已超过执行截止时间');
  }
}

/**
 * 采样间隔：第一次复采样尽量早，之后只要还没稳定就继续按这个间隔复采样。
 *
 * 安全性不靠「采样慢」实现，靠「连续两次一模一样才放行」：间隔只影响发现稳定的
 * 时刻，不影响判定标准。
 */
const STABLE_RECT_SAMPLE_MS = 34;

/**
 * 等元素几何稳定后再取坐标；已经稳定的元素要**立刻**返回，不空等。
 *
 * 为什么快：旧实现无条件先 `sleep(50)`，于是哪怕元素从来没动过（点了十几次的
 * 常用按钮、静态页面）每次点击也要多付 50ms；再加上 `stableSamples >= 2` 需要
 * 两次复采样，稳定元素最少 100ms、平均更久。现在改成：
 *  1. 先取首发矩形；
 *  2. 复采样一次 —— 与首发一致则**立即返回**（只付一次微任务 + 一个采样间隔）；
 *  3. 不一致（还在动）就按采样间隔继续复采样，直到连续两次一致；
 *  4. 到 1200ms（或被 clickDeadline 提前截断）仍不稳定 → 明确拒绝点击。
 *
 * 安全性不变：仍然是「连续两次采样位置完全一致」才返回；采样点更密只会让
 * 「移动 → 停下」更快被发现，不会让「还在动」被误判成「已稳定」——移动期间
 * 每次采样都对不上，stableSamples 一直清零。连续两次一致仍然要求元素在两个
 * 采样时刻之间确实没有发生任何超过 1px 的位移。
 */
async function stableRect(el: HTMLElement, clickDeadline?: number): Promise<DOMRect> {
  let previous = el.getBoundingClientRect();
  const deadline = Math.min(Date.now() + 1_200, clickDeadline ?? Number.POSITIVE_INFINITY);
  let stableSamples = 0;

  while (Date.now() < deadline) {
    await sleep(Math.min(STABLE_RECT_SAMPLE_MS, Math.max(1, deadline - Date.now())));
    const current = el.getBoundingClientRect();
    // 位置仍在动 → 计数清零，绝不因为「采样够密」而提前放行。
    if (rectMoved(previous, current)) stableSamples = 0;
    else stableSamples += 1;
    previous = current;
    if (stableSamples >= 2) return current;
  }

  assertBeforeClickDeadline(clickDeadline);
  throw new Error('目标控件位置仍在变化，无法可靠点击');
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 元素轮询的起步间隔：一个渲染帧量级。
 *
 * 比旧的固定 200ms 短得多，让「异步挂载」的控件在首个渲染帧之后就被看到；
 * 又不是 0 —— 真按 0 退化成忙等，会把 CPU 吃满、也可能饿死页面自己的渲染任务。
 */
const FAST_POLL_START_MS = 16;
/** 退避上限：无论等多久，探测间隔都不超过它，保证发现新控件仍然及时。 */
const FAST_POLL_MAX_MS = 120;

/**
 * 非打印功能键白名单 —— 与 `workflow.ts` 的 `WorkflowKey` 一一对应。
 *
 * 用运行时集合而不是 `keyof` 类型：`realClick` 入口接收的是学习产物的
 * 原始字段，类型不能挡住被改坏的字符串；且「可打印字符绝不能走击键回放」
 * 是隐私红线，必须在运行时也拦一次（与 workflow-validation 同源不同责）。
 */
const WORKFLOW_KEY_WHITELIST = new Set<string>([
  'Enter',
  'Space',
  'Escape',
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);

const WORKFLOW_GESTURES = new Set<string>(['click', 'double', 'right', 'long-press']);

const KEY_ALIAS: Readonly<Record<string, { key: string; code: string; keyCode: number }>> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  Space: { key: ' ', code: 'Space', keyCode: 32 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
};

/** long-press 的缺省按住时长；与人类「按住出现菜单」的常见阈值一致。 */
const DEFAULT_LONG_PRESS_HOLD_MS = 600;
/** double 的两次点击间隔；短于系统双击阈值，但留出让浏览器合并的窗口。 */
const DOUBLE_CLICK_INTERVAL_MS = 90;
/** 拖拽每步间隔：给页面滑条/排序库一帧处理时间，太快会被合并成跳变。 */
const DRAG_STEP_INTERVAL_MS = 32;

/** 校验 click 语义的新输入，返回规整后的值。 */
function normalizeClickInput(options: RealClickOptions): {
  anchor: PointerAnchor;
  gesture: WorkflowGesture;
  key: WorkflowKey | null;
  holdMs: number;
} {
  if (options.gesture !== undefined && !WORKFLOW_GESTURES.has(options.gesture)) {
    throw new Error(`未知手势 ${String(options.gesture)}；只允许 click/double/right/long-press`);
  }
  const gesture = (options.gesture ?? 'click') as WorkflowGesture;

  let key: WorkflowKey | null = null;
  if (options.key !== undefined) {
    if (!WORKFLOW_KEY_WHITELIST.has(options.key)) {
      // 可打印字符绝不走击键路径：它既是输入内容，也不能冒充用户键盘输入。
      throw new Error(`key 只允许非打印功能键，收到 ${JSON.stringify(options.key)}`);
    }
    key = options.key;
  }

  if (key != null && gesture !== 'click') {
    throw new Error('key 触发与手势互斥：键盘触发不能再叠加 double/right/long-press');
  }

  const anchor: PointerAnchor = options.anchor != null
    ? { kind: 'relative', rx: options.anchor.rx, ry: options.anchor.ry }
    : options.insetLeftPx == null
      ? { kind: 'center' }
      : { kind: 'inset-left', px: options.insetLeftPx };

  const holdMs = options.holdMs != null && Number.isFinite(options.holdMs)
    ? Math.max(0, Math.round(options.holdMs))
    : DEFAULT_LONG_PRESS_HOLD_MS;

  return { anchor, gesture, key, holdMs };
}
/**
 * 学习与回放的 `text=` 候选范围 —— **单一事实源**。
 *
 * 学习侧能录成 `text=` 的可点元素（`learning.ts` 的 CLICKABLE 直接取用本常量）
 * 除语义控件外还包括 ARIA 可点 role；回放侧必须用**同一张表**解析，否则会
 * 「学得到、回放不了」。实测形态：头像下拉菜单里的 `role="menuitem"`「个人资料」，
 * 回放时 `text=个人资料` 一个候选都枚举不到，只能在滚动面板里来回扫掠，最后报
 * 「找不到可点击元素」—— 日志里没有任何点击行，用户以为「点击没实现」。
 *
 * 范围只覆盖「学习侧可能录成 text= 的可点元素」，不扩到任意节点：`*` 会把容器
 * 与纯文本一起纳入，弱锚点容易点到不该点的东西。
 */
export const TEXT_SELECTOR_SCOPE = [
  'button',
  'a',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="tab"]',
  '[role="option"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="treeitem"]',
  'input[type="submit"]',
  'input[type="button"]',
  'label',
].join(', ');

/**
 * 不可见字符：零宽空格/连接符/非连接符、BOM、变体选择符。
 *
 * `\s` 不匹配这些码位，于是「站内文案 `签到 ✅`」与「页面实际渲染 `签到\uFE0F✅`」
 * 看着一模一样、`includes` 却为假 —— 学习时录到的 `text=` 在回放时永远解析不到，
 * 用户只看到「找不到可点击元素」。emoji 变体（U+FE0E/U+FE0F）与零宽连接符在
 * 图标按钮上极其常见，必须与空白一起归一化，而不是当成有意义的文字差异。
 */
const INVISIBLE_CHARS = /[\u200B-\u200D\u2060\uFEFF\uFE0E\uFE0F\u00AD]/g;

/**
 * 选择器文字的规范化：**只抹掉不改变语义的差异**。
 *
 * 归一化两类东西：
 * 1. 空白（含全角空格 U+3000，`\s` 已覆盖）→ 单个半角空格；
 * 2. 上表的不可见字符 → 直接删除。
 *
 * 刻意**不**做全半角字母/数字/括号互换、大小写折叠这类「像但不同」的变换：
 * 那会把页面上两个语义不同的控件（`签到(1)` 与 `签到（1）`）判成同一个，
 * 而这正是本项目最难排查的一类点错元素。大小写由调用方按需 toLowerCase。
 */
function normalizeSelectorText(text: string): string {
  return text.replace(INVISIBLE_CHARS, '').replace(/\s+/g, ' ').trim();
}

/** innerText 为空也不能回退到 textContent，否则会混入 SVG title/隐藏文案。 */
export function selectorVisibleText(element: Element): string {
  return normalizeSelectorText((element as HTMLElement).innerText ?? element.textContent ?? '');
}

/**
 * 兼容旧学习产物（如 GitHub + 使用 GitHub 继续）：仅接受完整文字匹配，且
 * 去掉 SVG title/desc 后恰好是可见文案。不能泛化成匹配任意隐藏 textContent。
 */
function matchesLegacySvgText(element: Element, needle: string): boolean {
  const visible = selectorVisibleText(element).toLowerCase();
  if (!visible || !needle.includes(visible)) return false;
  const raw = normalizeSelectorText(element.textContent ?? '').toLowerCase();
  if (raw !== needle || raw === visible || !element.querySelector('svg title, svg desc')) return false;

  const clone = element.cloneNode(true) as Element;
  for (const metadata of clone.querySelectorAll('svg title, svg desc')) metadata.remove();
  return normalizeSelectorText(clone.textContent ?? '').toLowerCase() === visible;
}

/**
 * 按文字查找元素，支持 `text=...` 和 `css >> text=...` 两种写法。
 *
 * 很多站点的按钮没有可区分的 class —— 比如 new-api 的
 * 「使用 GitHub 继续」「使用 LinuxDO 继续」共用 `semi-button-outline`，
 * 纯 CSS 选不中，只能靠文字。
 *
 *   text=使用 GitHub 继续          → 全页找文字含该串的可点元素
 *   button >> text=使用 GitHub     → 先按 css 缩小范围，再匹配文字
 */
function queryByText<T extends Element = HTMLElement>(spec: string, root: ParentNode = document): T[] {
  const parts = spec.split('>>').map((s) => s.trim());
  const textPart = parts.find((p) => p.startsWith('text='));
  if (!textPart) return [];

  const needle = normalizeSelectorText(textPart.slice('text='.length)).toLowerCase();
  if (!needle) return [];

  const cssPart = parts.filter((p) => !p.startsWith('text=')).join(' ').trim();
  const scope = cssPart || TEXT_SELECTOR_SCOPE;

  let candidates: Element[];
  try {
    candidates = [...root.querySelectorAll(scope)];
  } catch {
    return [];
  }

  // 多个命中时取文字最短的：避免选到包着目标的大容器。
  //
  // 但长度会打平 —— 1412 的签到卡标题「每日签到」是个可折叠 button，
  // 真正的动作按钮写「立即签到」，两个都含「签到」、都是 4 个字。
  // 只按长度排就靠文档顺序决定，标题在前时点到的是折叠开关：卡片收起来了，
  // 签到没发生，8 秒后报「点击签到后未检测到明确结果」。
  // 所以先按「是不是折叠/展开控件」分层，同层内再比长度。
  //
  // 匹配文本不能只看 innerText：图案按钮（只有 Google/GitHub 图标、没有可见
  // 文字）的名称只存在于 aria-label —— 学习侧正是从它生成 `text=` 选择器，
  // 回放侧只读 innerText 的话这类选择器永远解析不到（实测报「找不到 OAuth
  // 按钮: text=Sign in with Google」）。按可见文字 → aria-label → title 顺序
  // 取第一个命中的作为匹配文本；都没有才算未命中。
  const matchText = (el: Element): string | null => {
    const haystacks = [
      selectorVisibleText(el),
      normalizeSelectorText(el.getAttribute('aria-label') ?? ''),
      normalizeSelectorText(el.getAttribute('title') ?? ''),
    ];
    return haystacks.find((text) => text && text.toLowerCase().includes(needle)) ?? null;
  };
  const visibleCandidates = candidates.filter((el) => isVisible(el));
  const hits = visibleCandidates
    .map((el) => ({ el, text: matchText(el) }))
    .filter((hit): hit is { el: Element; text: string } => hit.text !== null)
    .sort((a, b) => (
      disclosureRank(a.el as HTMLElement) - disclosureRank(b.el as HTMLElement)
      || a.text.length - b.text.length
    ));

  if (hits.length) return hits.map(({ el }) => el as T);

  // 正常可见/无障碍名称始终优先；旧拼接文字只有唯一候选时才兼容，绝不猜提供商。
  const legacy = visibleCandidates.filter((el) => matchesLegacySvgText(el, needle));
  return legacy.length === 1 ? [legacy[0] as T] : [];
}

/**
 * 折叠/展开控件排到最后。
 *
 * `aria-expanded` 和 Radix 那套 `data-state="open|closed"` 是折叠控件的
 * 通用标记；带这类属性的按钮点下去只切换可见性，不是页面上的提交动作。
 * 同理，把整张卡片包在里面的控件（内部还有别的按钮）也不是动作按钮。
 */
function disclosureRank(el: HTMLElement): number {
  if (el.hasAttribute('aria-expanded')) return 1;
  const state = el.getAttribute('data-state');
  if (state === 'open' || state === 'closed') return 1;
  // 内部嵌着别的可点控件 → 它是容器，不是那个动作按钮
  if (el.querySelector('button, [role="button"], input[type="submit"]')) return 1;
  return 0;
}

/**
 * 把逗号分隔的多个选择器逐个尝试，返回第一个命中的可见元素。
 * 支持 `text=` 语法，见 queryByText。
 */
/** Shadow DOM 穿透分隔符（Playwright 惯例）。 */
export const SHADOW_SELECTOR_COMBINATOR = '>>>';

/**
 * 闭影子根拿不到时的显式失败。
 *
 * mode: 'closed' 的影子根对外永远返回 null，选择器**无法**解析 —— 这和
 * 「页面上没这个元素」是两件不同的事。前者要如实告诉用户「这个控件在闭合的
 * 影子根里，扩展看不见」，后者只是没找到。
 */
export class SelectorResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SelectorResolutionError';
  }
}

function hasShadowCombinator(selector: string): boolean {
  return selector.includes(SHADOW_SELECTOR_COMBINATOR);
}

function splitShadowSegments(selector: string): string[] {
  return selector
    .split(SHADOW_SELECTOR_COMBINATOR)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/** 在当前作用域里按一条普通选择器取全部匹配（不做可见性过滤）。 */
function matchesInScope<T extends Element>(selector: string, scope: ParentNode): T[] {
  if (selector.includes('text=')) return queryByText<T>(selector, scope);
  try {
    return [...scope.querySelectorAll<T>(selector)];
  } catch {
    // 与既有行为一致：非法选择器（如 Playwright 的 :has-text）不抛，按未命中处理。
    return [];
  }
}

/**
 * 解析可能带 >>> 的选择器，返回最终作用域里的全部匹配。
 *
 * 逐段穿透影子根：host >>> inner 先在当前作用域找 host，再进它的 shadowRoot
 * 找 inner。没有 >>> 时等价于在 root 里直接查（老行为不变）。
 *
 * 闭合影子根**必须**抛出 SelectorResolutionError，绝不静默返回空 —— 那会把
 * 「拿不到文档」伪装成「页面没这个控件」，用户拿到的诊断完全是错的。
 */
export function resolveAll<T extends Element = HTMLElement>(
  selector: string,
  root: ParentNode = document,
): T[] {
  const segments = splitShadowSegments(selector);
  if (segments.length === 0) return [];
  let scope: ParentNode = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const host = matchesInScope<Element>(segments[index]!, scope)[0];
    if (!host) return [];
    const shadow = host.shadowRoot;
    if (!shadow) {
      const segment = segments[index];
      throw new SelectorResolutionError(
        '选择器「' + selector + '」里的「' + segment + '」是闭合的影子根，扩展读不到里面的内容',
      );
    }
    scope = shadow;
  }
  return matchesInScope<T>(segments[segments.length - 1]!, scope);
}

/** 解析出第一个匹配（不做可见性过滤）。闭合影子根会抛错。 */
export function resolveElement<T extends Element = HTMLElement>(
  selector: string,
  root: ParentNode = document,
): T | null {
  return resolveAll<T>(selector, root)[0] ?? null;
}
export function queryFirst<T extends Element = HTMLElement>(selectors: string): T | null {
  // text= 里可能含逗号（"使用 GitHub 继续, 稍后"），所以只在顶层逗号切分
  for (const sel of splitSelectors(selectors)) {
    // 统一走 resolveAll：它把 text= 转给 queryByText，并先识别 >>> 再分段。
    // 若在这里单独拦 text=，'host >>> text=X' 会被 queryByText 按 '>>' 切坏。
    try {
      for (const el of resolveAll<T>(sel)) {
        if (isVisible(el)) return el;
      }
    } catch (error) {
      // 闭合影子根是「拿不到」，必须让调用方看见；其余（如 Playwright 的
      // :has-text 这类非标准语法）沿用旧行为直接跳过。
      if (error instanceof SelectorResolutionError) throw error;
    }
  }
  return null;
}

/** 枚举指定作用域内的全部可见匹配，保留选择器优先级和 text= 语法。 */
export function queryAll<T extends Element = HTMLElement>(selectors: string, root: ParentNode = document): T[] {
  const matches = new Set<T>();
  for (const sel of splitSelectors(selectors)) {
    try {
      const elements = resolveAll<T>(sel, root).filter(isVisible);
      for (const element of elements) matches.add(element);
    } catch (error) {
      // 与 queryFirst 一致：单条非法选择器不能中断其它候选，但闭合影子根是
      // 「拿不到」而不是「没找到」，必须抛给调用方。
      if (error instanceof SelectorResolutionError) throw error;
    }
  }
  return [...matches];
}

/**
 * 逗号后面是不是又开始了一个新选择器？
 *
 * `text=` 里的逗号是文字（「使用 GitHub 继续, 稍后」），不能切；
 * 但 `text=A, button >> text=B` 这种回退列表里的逗号必须切。
 * 区别在于逗号之后是否又出现 `text=`，或以结构符号明确写成 CSS。
 * 普通文字不会被当成 CSS，避免把「使用 GitHub 继续, 稍后」误切开。
 */
function looksLikeExplicitCssSelector(value: string): boolean {
  const next = value.trimStart();
  if (!next) return false;
  if (
    next.startsWith('.')
    || next.startsWith('#')
    || next.startsWith('[')
    || next.startsWith(':')
    || next.startsWith('*')
  ) {
    return true;
  }

  // Tag selectors need an explicit suffix/combinator; a bare word may be prose.
  return /^[a-z][\w-]*\s*(?:[.#:]|\[|[>+~])/i.test(next);
}

function startsNewSelector(rest: string): boolean {
  const next = rest.replace(/^,\s*/, '');
  if (!next) return false;
  if (next.startsWith('text=')) return true;
  // `, button >> text=…`：逗号后是一段 css，再接 text=
  const arrow = next.indexOf('>>');
  if (arrow > 0 && next.slice(arrow + 2).trimStart().startsWith('text=')) {
    // css 部分不能含逗号，否则那个逗号才是真正的边界
    return !next.slice(0, arrow).includes(',');
  }
  return looksLikeExplicitCssSelector(next);
}

/**
 * 按顶层逗号切分选择器。
 *
 * `text=` 之后的逗号默认视为文字的一部分 —— 但**下一个选择器开始时例外**。
 * 之前无条件把首个 `text=` 之后的一切都当文字，于是
 * `button >> text=立即签到, button >> text=签到` 会被当成一个选择器，
 * 去找文字含「立即签到, button >> text=签到」的按钮，必然扑空：
 * 带 `text=` 的回退写法**整个失效**，而配置看着完全合理。
 */
function splitSelectors(spec: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inText = false;
  for (let i = 0; i < spec.length; i++) {
    const rest = spec.slice(i);
    if (!inText && rest.startsWith('text=')) inText = true;
    if (spec[i] === ',' && (!inText || startsNewSelector(rest))) {
      out.push(cur.trim());
      cur = '';
      inText = false;
      continue;
    }
    cur += spec[i];
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

export function isVisible(el: Element): boolean {
  const style = window.getComputedStyle(el as HTMLElement);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = (el as HTMLElement).getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * 等待元素出现。
 *
 * 轮询节奏：**首次立即查** → 短间隔快速探测 → 指数退避（有上限）。命中的那一次
 * 直接返回，不等到下一个 tick。
 *
 * 为什么改：旧实现是「固定 200ms 间隔」——元素在第 201ms 出现，最快的下一次
 * 查询也要等到 400ms 才发出，白等接近一个完整间隔；而首帧就存在的元素（绝大多数
 * 常见路径）也要在循环里先 sleep 一次才查（旧循环条件虽然先判 deadline，但
 * `timeout` 很小时会连一次查询都不做）。现在首查同步完成：首屏就有的控件
 * 零延迟命中；异步渲染的控件最早在短间隔后就被看到，不必等固定 interval。
 *
 * 退避为什么有上限：控件可能在任意时刻挂载，间隔必须一直有界（`FAST` 封顶），
 * 否则一次长等待会在后段变成「几乎不查」。同时退避让长超时（10s/12s）时对
 * 站点样式的读取不再是每 200ms 一次，长等场景的 CPU/布局开销显著下降。
 *
 * 有界：循环条件严格用 `Date.now() < deadline`，`timeout <= 0` 时只做首次查询
 * （与旧实现「不查询」的差异是刻意的：调用方传 0 的语义应是「只查一次」，
 * 见 `locateStepTarget` 对 `probeTimeout = 0` 的处理）。
 */
export async function waitFor<T extends Element = HTMLElement>(
  selectors: string,
  timeout = 10_000,
  interval?: number,
): Promise<T | null> {
  const deadline = Date.now() + Math.max(0, timeout);
  // 首次立即查：元素已经在 DOM 时零等待返回。
  const immediate = queryFirst<T>(selectors);
  if (immediate) return immediate;
  if (timeout <= 0) return null;
  // 初始节奏：显式 interval 优先（旧调用方的语义），否则用短间隔起步。
  const initialInterval = Number.isFinite(interval) && (interval as number) > 0
    ? (interval as number)
    : FAST_POLL_START_MS;
  let wait = Math.min(initialInterval, FAST_POLL_START_MS);
  while (Date.now() < deadline) {
    await sleep(Math.min(wait, Math.max(1, deadline - Date.now())));
    const el = queryFirst<T>(selectors);
    if (el) return el;
    wait = Math.min(Math.round(wait * 1.6) || FAST_POLL_START_MS, FAST_POLL_MAX_MS);
  }
  return null;
}

/** 等待元素消失 */
export async function waitGone(selectors: string, timeout = 3_000, interval = 150): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!queryFirst(selectors)) return true;
    await sleep(interval);
  }
  return false;
}

/**
 * 给 React / Vue 受控输入框赋值的关键技巧。
 *
 * 直接 `input.value = x` 只改 DOM 属性，React 的合成事件系统感知不到，
 * 内部 state 仍是空值 → 提交时表单为空。
 * 必须取 HTMLInputElement.prototype 上的原生 value setter 来赋值，
 * 再手动派发 input/change 事件，React 的 onChange 才会被触发。
 */
export function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  const setter = desc?.set;

  el.focus();
  if (setter) {
    setter.call(el, value);
  } else {
    el.value = value;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * 元素是不是 `contenteditable` 富文本宿主。
 *
 * 只认 `contenteditable=""` / `"true"`；`"false"` 是显式关掉、`"inherit"` 交给父级，
 * 都不算可编辑。富文本编辑器（评论框、理由框）常用它代替 `<textarea>`。
 */
export function isContentEditableHost(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  const attr = el.getAttribute('contenteditable');
  return attr === '' || attr?.toLowerCase() === 'true';
}

/** 可填充控件：`<input>` / `<textarea>` / `contenteditable` 宿主。 */
export function isFillable(el: Element): el is HTMLInputElement | HTMLTextAreaElement | HTMLElement {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || isContentEditableHost(el);
}

/**
 * 往可填充控件写值：`<input>`/`<textarea>` 走原生 setter（见 `setNativeValue`），
 * `contenteditable` 宿主写 `textContent` 并派发 input/change，让 React/Vue 感知到变化。
 *
 * 学习模式能把 `<div contenteditable>` 富文本框采成 fill 步骤，回放就必须能填进去，
 * 否则「学到了却回放失败」等于没学到。
 */
export function fillEditable(el: HTMLInputElement | HTMLTextAreaElement | HTMLElement, value: string): void {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    setNativeValue(el, value);
    return;
  }
  el.focus();
  el.textContent = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * 构造鼠标事件。
 *
 * `view` 带上当前 window 能让少数读 `event.view` 的老站点行为更接近真实点击，
 * 但它也是唯一会让构造函数**抛异常**的字段（跨文档 window、以及 jsdom 下
 * 一律报 "member view is not of type Window"）。抛了就退回不带 view 的版本：
 * 派发本身比这一个可选字段重要得多 —— 少了它 React 的合成事件照样触发。
 */
/** 鼠标事件初始化：真实派发路径无法生成 trusted 标记，但坐标/按键位图完整。 */
function initMouseEvent(el: HTMLElement, x: number, y: number, button = 0, buttons = 0): MouseEventInit {
  return {
    bubbles: true,
    cancelable: true,
    view: el.ownerDocument?.defaultView ?? window,
    button,
    buttons,
    clientX: Math.round(x),
    clientY: Math.round(y),
  };
}

/** 构造带完整鼠标语义的 MouseEvent；view 在孤立 jsdom 环境可能抛错，退回仍可派发。 */
function coordinateMouseEvent(
  type: string,
  el: HTMLElement,
  x: number,
  y: number,
  button = 0,
  buttons = 0,
): MouseEvent {
  const init = initMouseEvent(el, x, y, button, buttons);
  try {
    return new MouseEvent(type, init);
  } catch {
    const { view: _view, ...rest } = init;
    return new MouseEvent(type, rest);
  }
}

/** 非打印功能键的真实 keydown/keyup 派发。 */
function dispatchWorkflowKey(el: HTMLElement, key: WorkflowKey): void {
  const alias = KEY_ALIAS[key];
  if (!alias) throw new Error(`key 只允许非打印功能键，收到 ${JSON.stringify(key)}`);
  if (typeof el.focus === 'function') el.focus();
  const init: KeyboardEventInit = {
    bubbles: true,
    cancelable: true,
    key: alias.key,
    code: alias.code,
    keyCode: alias.keyCode,
    which: alias.keyCode,
  };
  el.dispatchEvent(new KeyboardEvent('keydown', init));
  if (alias.keyCode === 13) el.dispatchEvent(new KeyboardEvent('keypress', init));
  el.dispatchEvent(new KeyboardEvent('keyup', init));
}

/** 当前文档内的手势派发。可信通道未覆盖这些语义时使用，缺省单击仍走 domClick。 */
async function domGesture(
  el: HTMLElement,
  x: number,
  y: number,
  gesture: WorkflowGesture,
  holdMs: number,
): Promise<void> {
  if (gesture === 'double') {
    for (let index = 0; index < 2; index += 1) {
      el.dispatchEvent(coordinateMouseEvent('mousedown', el, x, y, 0, 1));
      el.dispatchEvent(coordinateMouseEvent('mouseup', el, x, y, 0, 0));
      if (typeof el.click === 'function') el.click();
      else el.dispatchEvent(coordinateMouseEvent('click', el, x, y, 0, 0));
      if (index === 0) await sleep(DOUBLE_CLICK_INTERVAL_MS);
    }
    el.dispatchEvent(coordinateMouseEvent('dblclick', el, x, y, 0, 0));
    return;
  }
  if (gesture === 'right') {
    el.dispatchEvent(coordinateMouseEvent('mousedown', el, x, y, 2, 2));
    el.dispatchEvent(coordinateMouseEvent('contextmenu', el, x, y, 2, 2));
    el.dispatchEvent(coordinateMouseEvent('mouseup', el, x, y, 2, 0));
    return;
  }
  if (gesture === 'long-press') {
    el.dispatchEvent(coordinateMouseEvent('mousedown', el, x, y, 0, 1));
    await sleep(holdMs);
    el.dispatchEvent(coordinateMouseEvent('mouseup', el, x, y, 0, 0));
    if (typeof el.click === 'function') el.click();
    else el.dispatchEvent(coordinateMouseEvent('click', el, x, y, 0, 0));
    return;
  }
  domClick(el);
}

function mouseEvent(type: string, el: HTMLElement): MouseEvent {
  const base = { bubbles: true, cancelable: true };
  try {
    return new MouseEvent(type, { ...base, view: el.ownerDocument?.defaultView ?? window });
  } catch {
    return new MouseEvent(type, base);
  }
}

/** 仅用于透明原生控件等无法按可见坐标点击的 DOM 语义切换。 */
export function domClick(el: HTMLElement): void {
  el.dispatchEvent(mouseEvent('mousedown', el));
  el.dispatchEvent(mouseEvent('mouseup', el));
  if (typeof el.click === 'function') {
    el.click();
  } else {
    el.dispatchEvent(mouseEvent('click', el));
  }
}

/**
 * 通过后台的 Chrome debugger API 移动真实浏览器指针并点击元素中心。
 *
 * 普通页面操作与专用挑战求解器都可调用这个可信指针入口；它只派发真实输入，
 * 不写入或伪造验证令牌。只有站点明确配置为 DOM 模式，或没有运行中任务时
 * （例如单元测试），才使用经过可见性与遮挡校验的 DOM 点击。
 */
export async function realClick(el: HTMLElement, options: RealClickOptions = {}): Promise<'trusted' | 'dom'> {
  // Capture the task identity for this click. The module-level value can be cleared by
  // navigation while this async operation is waiting for a stable target rectangle.
  const runId = activeClickRunId;
  const useDomPointer = activePointerMode === 'dom'
    || !runId
    || typeof chrome === 'undefined'
    || !chrome.runtime?.id;
  // DOM 模式无法使用后台 CDP 观察 closed shadow。Turnstile 至少走满与后台一致的
  // 15 秒安全窗口，再重新采样几何与遮挡状态，不能在 10 秒门槛后直接早击。
  if (useDomPointer && options.targetSeenAt != null && Number.isFinite(options.targetSeenAt)) {
    const remainingMs = options.targetSeenAt + 15_000 - Date.now();
    if (remainingMs > 0) {
      if (options.deadline != null && Date.now() + remainingMs >= options.deadline) {
        throw new Error('验证控件安全窗口会超过执行截止时间，已取消点击');
      }
      await sleep(remainingMs);
    }
  }

  assertBeforeClickDeadline(options.deadline);
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const rect = await stableRect(el, options.deadline);
  assertBeforeClickDeadline(options.deadline);
  if (rect.width <= 0 || rect.height <= 0) throw new Error('目标控件当前不可见，无法点击');

  /**
   * 滚进视口之后仍然不可达时必须**明确拒绝**，不能把坐标夹到视口边缘。
   *
   * `scrollIntoView` 并不保证元素真的进了视口：页面可能已经到底、元素被放在
   * 不可滚动的固定容器里、或被父级 `overflow:hidden` 裁掉。以前这里用
   * `Math.min(window.innerHeight - 1, …)` 把纵坐标夹进视口，于是真实指针点在
   * **视口边缘的另一个元素**上，而调用方以为点击成功 —— 用户看到「按钮被点了，
   * 但什么也没发生」，是本项目最难定位的一类假成功。
   *
   * 现在宁可报错：失败至少能落到日志和诊断里，假成功会一路伪装下去。
   */
  const centerY = rect.top + rect.height / 2;
  const centerX = rect.left + rect.width / 2;
  const outOfView = centerY < 0 || centerY > window.innerHeight
    || centerX < 0 || centerX > window.innerWidth;
  if (outOfView) {
    throw new Error(
      `目标控件在视口之外（滚动后位置 ${Math.round(rect.left)},${Math.round(rect.top)} `
      + `超出视口 ${window.innerWidth}x${window.innerHeight}），已取消点击以免点到其它元素`,
    );
  }

  /**
   * 计算点击位置：默认中心；insetLeftPx 按左边缘绝对内缩（Turnstile 复选框）；
   * 学习到的相对落点（anchor）优先级最高，用来还原「用户点的是控件内哪个位置」。
   *
   * 用共享的 anchorX / anchorY，保证前台算出的落点与后台按下前重采样算的是同一个点
   * （否则就是「调试红点位置对、点击却落空」——这个坑同时存在于 X 和 Y）。
   */
  const { anchor, gesture, key, holdMs } = normalizeClickInput(options);
  const useTrustedPointerForGesture = (candidate: WorkflowGesture): boolean => candidate !== 'click';
  const x = Math.min(window.innerWidth - 1, Math.max(1, anchorX(rect, anchor)));
  const y = Math.min(window.innerHeight - 1, Math.max(1, anchorY(rect, anchor)));

  // 可视化调试：在点击位置显示红色圆点
  if (options.debugVisualize) {
    const dot = document.createElement('div');
    dot.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: 20px;
      height: 20px;
      margin: -10px 0 0 -10px;
      background: red;
      border: 3px solid yellow;
      border-radius: 50%;
      z-index: 999999;
      pointer-events: none;
      box-shadow: 0 0 10px rgba(255,0,0,0.8);
    `;
    document.body.appendChild(dot);
    try {
      if (options.deadline != null && Date.now() + 2_000 >= options.deadline) {
        throw new Error('调试标记等待会超过执行截止时间，已取消点击');
      }
      await sleep(2000);
    } finally {
      dot.remove();
    }
    assertBeforeClickDeadline(options.deadline);
  }

  const { hit, blocked } = pointHitsElement(el, x, y);
  if (blocked) {
    throw new Error(`目标控件被 ${hit ? describeElement(hit as HTMLElement) : '未知元素'} 遮挡`);
  }

  if (useDomPointer) {
    assertBeforeClickDeadline(options.deadline);
    if (key != null) {
      dispatchWorkflowKey(el, key);
      return 'dom';
    }
    if (gesture !== 'click') {
      await domGesture(el, x, y, gesture, holdMs);
      return 'dom';
    }
    domClick(el);
    return 'dom';
  }

  /*
   * 手势与键盘在**可信指针通道**下必须由 CDP 真正复现（后台按同一语义派发）。
   *
   * 只允许普通单击在后台缺接线时降级为 DOM 合成点击 —— 那是历史行为。
   * 双击/右键/长按一旦被静默换成一次普通单击，用户学到的语义就丢了，
   * 页面只会「什么也没发生」，而日志照样写「已点击」：这是最难查的假成功。
   * 这里明确拒绝，把问题暴露在日志里而不是伪装成成功。
   */
  if (key != null) {
    // 键盘语义由 DOM 键盘路径承载（可信指针通道只负责鼠标手势）：
    // 这里绝不把「按 Enter 触发」降级成一次鼠标单击。
    assertBeforeClickDeadline(options.deadline);
    dispatchWorkflowKey(el, key);
    return 'dom';
  }
  if (gesture !== 'click' && !useTrustedPointerForGesture(gesture)) {
    throw new Error(
      `${gestureLabel(gesture)}需要浏览器级指针通道，当前页面没有可信指针接线，已取消执行（不降级为普通单击）`,
    );
  }

  const marker = 'data-aah-pointer-target';
  const previousMarker = el.getAttribute(marker);
  const targetToken = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  el.setAttribute(marker, targetToken);

  try {
    assertBeforeClickDeadline(options.deadline);
    const response = await sendMessage({
      type: 'TRUSTED_POINTER_CLICK',
      runId,
      ...(activeSliderFrameSessionId ? { frameSessionId: activeSliderFrameSessionId } : {}),
      x,
      y,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      targetToken,
      // 后台按下前会重新采样落点；不带上同一规则的话内缩点会被改回元素中心
      anchor,
      // 手势/长按时长必须一并透传：只传坐标会让双击/右键/长按退化成普通单击。
      ...(gesture !== 'click' ? { gesture } : {}),
      ...(gesture === 'long-press' ? { holdMs } : {}),
      ...(key != null ? { key } : {}),
      ...(options.targetSeenAt != null ? { targetSeenAt: options.targetSeenAt } : {}),
      ...(options.deadline != null ? { deadline: options.deadline } : {}),
    });
    if (!response.ok) {
      const responseLostAfterDispatch = options.mayNavigate
        && options.reconcileAfterLostResponse
        && (
          response.error.includes('没有响应 TRUSTED_POINTER_CLICK')
          || response.error.includes('点击结果可能未知')
        );
      if (responseLostAfterDispatch) {
        // A navigation or an immediate React reload can destroy the sender after
        // mouseReleased. The persisted button baseline lets the check-in flow
        // reconcile the resulting page without issuing a second blind click.
        return 'trusted';
      }
      throw new Error(`浏览器级鼠标点击失败：${response.error}`);
    }
    if (response.feature?.pointer?.mode !== 'trusted') {
      // mouseReleased 已触发导航时，发送消息的页面会在后台回包到达前销毁。
      // 这里只接受调用方明确声明的导航型动作；后续仍由新页面的登录/签到证据判定终态。
      if (options.mayNavigate) return 'trusted';
      throw new Error('浏览器级鼠标点击没有返回可信执行结果');
    }
    const pointerResult = response.feature.pointer;
    options.onPointerResult?.(pointerResult);
    if (pointerResult.clickObserved === false) {
      // Shadow DOM 或跨域 iframe 内的交互：事件穿透了但 content script 观察不到
      if (options.shadowTarget) return 'trusted';
      throw new Error('浏览器级鼠标事件未到达目标控件');
    }
    if (pointerResult.clickObserved == null && !options.mayNavigate) {
      throw new Error('无法确认目标控件收到浏览器级鼠标事件');
    }
    return 'trusted';
  } finally {
    if (el.getAttribute(marker) === targetToken) {
      if (previousMarker == null) el.removeAttribute(marker);
      else el.setAttribute(marker, previousMarker);
    }
  }
}

function gestureLabel(gesture: WorkflowGesture): string {
  return gesture === 'double' ? '双击' : gesture === 'right' ? '右键' : gesture === 'long-press' ? '长按' : '点击';
}

function normalizeDragAnchor(anchor?: WorkflowPointerAnchor): PointerAnchor {
  return anchor == null ? { kind: 'center' } : { kind: 'relative', rx: anchor.rx, ry: anchor.ry };
}

function normalizeDragSteps(steps?: number): number {
  if (steps == null) return 12;
  if (!Number.isInteger(steps) || steps < 0 || steps > 64) {
    throw new Error('拖拽中间点数量必须是 0-64 的整数');
  }
  return steps;
}

function pointerToken(): string {
  return `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function requireViewportPoint(point: { x: number; y: number }, label: string): { x: number; y: number } {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error(`${label}坐标不是有效数字，已取消拖拽`);
  }
  if (point.x < 0 || point.y < 0 || point.x > window.innerWidth || point.y > window.innerHeight) {
    throw new Error(
      `${label}在视口之外（${Math.round(point.x)},${Math.round(point.y)} 超出 ${window.innerWidth}x${window.innerHeight}），已取消拖拽以免点到其它元素`,
    );
  }
  return { x: Math.min(window.innerWidth - 1, Math.max(1, point.x)), y: Math.min(window.innerHeight - 1, Math.max(1, point.y)) };
}

function assertPointTarget(el: HTMLElement, point: { x: number; y: number }, label: string): void {
  const { hit, blocked } = pointHitsElement(el, point.x, point.y);
  if (blocked) {
    throw new Error(`${label}被 ${hit ? describeElement(hit as HTMLElement) : '未知元素'} 遮挡`);
  }
}

function buildDragPoints(
  start: { x: number; y: number },
  end: { x: number; y: number },
  steps: number,
): Array<{ x: number; y: number; delayMs: number }> {
  const count = Math.max(1, steps);
  const points: Array<{ x: number; y: number; delayMs: number }> = [];
  for (let index = 1; index <= count; index += 1) {
    const t = index / count;
    points.push({
      x: start.x + (end.x - start.x) * t,
      y: start.y + (end.y - start.y) * t,
      delayMs: DRAG_STEP_INTERVAL_MS,
    });
  }
  return points;
}

function initPointerEvent(el: HTMLElement, x: number, y: number, buttons: number): PointerEventInit {
  return {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    buttons,
    button: buttons === 0 ? -1 : 0,
    clientX: Math.round(x),
    clientY: Math.round(y),
  };
}

function coordinatePointerEvent(
  type: string,
  el: HTMLElement,
  x: number,
  y: number,
  buttons: number,
): PointerEvent | Event {
  const init = initPointerEvent(el, x, y, buttons);
  try {
    return new PointerEvent(type, init);
  } catch {
    return coordinateMouseEvent(type, el, x, y, buttons === 0 ? 0 : 0, buttons);
  }
}

/** DOM 拖拽：真实 pointer/mouse 成对序列，起点捕获，末点落在终点元素上。 */
async function domDrag(
  from: HTMLElement,
  to: HTMLElement,
  start: { x: number; y: number },
  end: { x: number; y: number },
  steps: number,
  deadline?: number,
): Promise<void> {
  from.dispatchEvent(coordinatePointerEvent('pointerdown', from, start.x, start.y, 1));
  from.dispatchEvent(coordinateMouseEvent('mousedown', from, start.x, start.y, 0, 1));
  const count = Math.max(1, steps);
  for (let index = 1; index <= count; index += 1) {
    assertBeforeDragDeadline(deadline);
    const t = index / count;
    const point = { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t };
    const target = index === count ? to : from;
    target.dispatchEvent(coordinatePointerEvent('pointermove', target, point.x, point.y, 1));
    target.dispatchEvent(coordinateMouseEvent('mousemove', target, point.x, point.y, 0, 1));
    await sleep(DRAG_STEP_INTERVAL_MS);
  }
  assertBeforeDragDeadline(deadline);
  to.dispatchEvent(coordinatePointerEvent('pointerup', to, end.x, end.y, 0));
  to.dispatchEvent(coordinateMouseEvent('mouseup', to, end.x, end.y, 0, 0));
}

function assertBeforeDragDeadline(deadline?: number): void {
  if (deadline != null && Date.now() >= deadline) {
    throw new Error('拖拽已超过执行截止时间');
  }
}

/**
 * 把起点元素按 anchor 拖到终点元素，产生真实的 pointer/mouse 事件序列。
 *
 * 生产环境优先复用后台已有的 trustedPointerDrag CDP 通道（浏览器级按下/移动/释放）。
 * 由于消息路由与 PointerMessage 契约由其它智能体负责，本原语在消息未接线前会明确
 * 抛错，绝不静默降级成合成事件；DOM 模式/单测环境才派发完整 pointer/mouse 序列。
 */
export async function realDrag(
  from: HTMLElement,
  to: HTMLElement,
  options: RealDragOptions = {},
): Promise<'trusted' | 'dom'> {
  const runId = activeClickRunId;
  const useDomPointer = activePointerMode === 'dom'
    || !runId
    || typeof chrome === 'undefined'
    || !chrome.runtime?.id;
  assertBeforeDragDeadline(options.deadline);
  from.scrollIntoView({ block: 'center', inline: 'center' });
  to.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const fromRect = await stableRect(from, options.deadline);
  assertBeforeDragDeadline(options.deadline);
  const toRect = await stableRect(to, options.deadline);
  assertBeforeDragDeadline(options.deadline);
  if (fromRect.width <= 0 || fromRect.height <= 0) throw new Error('拖拽起点当前不可见，无法开始拖拽');
  if (toRect.width <= 0 || toRect.height <= 0) throw new Error('拖拽终点当前不可见，无法完成拖拽');
  const fromAnchor: PointerAnchor = normalizeDragAnchor(options.fromAnchor);
  const toAnchor: PointerAnchor = normalizeDragAnchor(options.toAnchor);
  const rawStart = { x: anchorX(fromRect, fromAnchor), y: anchorY(fromRect, fromAnchor) };
  const rawEnd = { x: anchorX(toRect, toAnchor), y: anchorY(toRect, toAnchor) };
  const start = requireViewportPoint(rawStart, '拖拽起点');
  const end = requireViewportPoint(rawEnd, '拖拽终点');
  assertPointTarget(from, start, '拖拽起点');
  assertPointTarget(to, end, '拖拽终点');
  const steps = normalizeDragSteps(options.steps);
  if (useDomPointer) {
    await domDrag(from, to, start, end, steps, options.deadline);
    return 'dom';
  }

  const marker = 'data-aah-pointer-target';
  const previousFromMarker = from.getAttribute(marker);
  const previousToMarker = to.getAttribute(marker);
  // 两个 token 必须都满足后台的 p- 形态校验；后台据此在按下前重采样起终点。
  const tokenSuffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  const fromToken = `p-from-${tokenSuffix}`;
  const toToken = `p-to-${tokenSuffix}`;
  from.setAttribute(marker, fromToken);
  to.setAttribute(marker, toToken);
  try {
    const points = buildDragPoints(start, end, steps);
    const response = await sendMessage({
      type: 'TRUSTED_POINTER_DRAG',
      runId,
      startX: start.x,
      startY: start.y,
      points,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      fromTargetToken: fromToken,
      toTargetToken: toToken,
      fromAnchor,
      toAnchor,
      ...(options.deadline != null ? { deadline: options.deadline } : {}),
    });
    if (!response.ok) throw new Error(`浏览器级拖拽失败：${response.error}`);
    const pointer = response.feature?.pointer;
    if (pointer?.mode !== 'trusted') throw new Error('浏览器级拖拽没有返回可信执行结果');
    if (pointer.drag == null) throw new Error('浏览器级拖拽未返回执行统计');    return 'trusted';
  } finally {
    if (from.getAttribute(marker) === fromToken) {
      if (previousFromMarker == null) from.removeAttribute(marker);
      else from.setAttribute(marker, previousFromMarker);
    }
    if (to.getAttribute(marker) === toToken) {
      if (previousToMarker == null) to.removeAttribute(marker);
      else to.setAttribute(marker, previousToMarker);
    }
  }
}

export interface RealScrollOptions {
  /** 单次总滚动距离，正数向下、负数向上 */
  deltaY: number;
  /** 可选分段数；生产通道最多 12 段 */
  steps?: number;
}

/**
 * 通过可信鼠标滚轮在元素中心滚动。
 *
 * 有活动签到任务时走 background/CDP 的 `mouseWheel`，站点收到的是浏览器级滚轮。
 * DOM/单测场景才降级为 window.scrollBy；不用于验证码或随机抽奖操作，调用方必须
 * 在明确需要展开下方控件时显式调用。
 */
export async function realScroll(el: HTMLElement, options: RealScrollOptions): Promise<'trusted' | 'dom'> {
  const rect = await stableRect(el);
  if (rect.width <= 0 || rect.height <= 0) throw new Error('滚动目标当前不可见');
  const x = Math.min(window.innerWidth - 1, Math.max(1, rect.left + rect.width / 2));
  const y = Math.min(window.innerHeight - 1, Math.max(1, rect.top + rect.height / 2));
  if (activePointerMode === 'dom' || !activeClickRunId || typeof chrome === 'undefined' || !chrome.runtime?.id) {
    window.scrollBy({ top: options.deltaY, behavior: 'auto' });
    return 'dom';
  }
  const response = await sendMessage({
    type: 'TRUSTED_POINTER_SCROLL',
    runId: activeClickRunId,
    x,
    y,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    deltaY: options.deltaY,
    ...(options.steps != null ? { steps: options.steps } : {}),
  });
  if (!response.ok || response.feature?.pointer?.scroll == null) {
    throw new Error(`浏览器级鼠标滚动失败：${response.ok ? '未返回可信滚动结果' : response.error}`);
  }
  return 'trusted';
}

/**
 * 为什么需要：realClick 用的是 el.click()，它直接派发到目标元素上，
 * **不受任何遮挡影响**。所以公告遮罩盖住签到按钮时，点击"成功"了、
 * 日志写着「已点击签到按钮」，但站点的 SPA 其实没收到用户交互，
 * 签到静默失败。这种假成功比直接报错难查得多。
 *
 * 用 elementFromPoint 取中心点的实际命中元素：若它既不是目标、
 * 也不是目标的后代，就说明有东西盖在上面。
 */
/**
 * 这个坐标实际点到的元素链里包含目标吗？
 *
 * `elementFromPoint` 只返回**外部文档树**里的节点：目标在影子根里时它给的是宿主，
 * 宿主既不等于目标、也不与目标互相包含（`contains` 不跨影子边界），于是每次都被
 * 误判成「被遮挡」，回放直接失败在「目标控件被 checkin-widget#widget 遮挡」——
 * 而页面上根本没有遮挡物。
 *
 * 用 composedPath() 取真实穿透链，链条上有目标（或目标所在的影子宿主）就说明
 * 点的是目标本身。返回命中元素，供调用方在**真的**被遮挡时报出是谁挡的。
 */
/**
 * 穿透影子根取坐标命中的元素。
 *
 * `document.elementFromPoint` 只返回**外部文档树**节点：目标在影子根里时拿到的是
 * 宿主，宿主既不等于目标、也不与目标互相包含（`contains` 不跨影子边界），于是
 * 每个遮挡判定都会误报「被遮挡」，回放失败在「目标控件被 checkin-widget#widget
 * 遮挡」—— 而页面上根本没有遮挡物。逐层用宿主影子根重做命中测试即可拿到真目标。
 */
export function deepElementFromPoint(x: number, y: number): Element | null {
  let hit = document.elementFromPoint(x, y);
  while (hit?.shadowRoot) {
    const deeper = hit.shadowRoot.elementFromPoint(x, y);
    if (!deeper || deeper === hit) break;
    hit = deeper;
  }
  return hit;
}

/** 目标元素到文档根的祖先链，含穿透影子根的宿主。 */
function elementChain(el: HTMLElement): Element[] {
  const chain: Element[] = [];
  let node: Element | null = el;
  while (node) {
    chain.push(node);
    if (node.parentElement) { node = node.parentElement; continue; }
    const root = node.getRootNode();
    node = root instanceof ShadowRoot ? (root.host as Element) : null;
  }
  return chain;
}

function pointHitsElement(el: HTMLElement, x: number, y: number): { hit: Element | null; blocked: boolean } {
  const hit = deepElementFromPoint(x, y);
  if (!hit) return { hit: null, blocked: true };
  if (hit === el || el.contains(hit) || hit.contains(el)) return { hit, blocked: false };
  // 目标在某个影子树里，命中的是它的宿主 → 目标本身被点到了。
  for (const node of elementChain(el)) {
    if (node === hit) return { hit, blocked: false };
  }
  return { hit, blocked: true };
}

export function elementBlocking(el: HTMLElement): HTMLElement | null {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;

  // 中心点可能落在视口外（元素被滚动出去），此时无法判断，视为未被遮挡
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return null;

  const { hit, blocked } = pointHitsElement(el, x, y);
  if (!blocked) return null;
  return (hit as HTMLElement | null) ?? null;
}

/** 用于日志的简短元素描述 */
export function describeElement(el: HTMLElement): string {
  const id = el.id ? `#${el.id}` : '';
  const cls = String(el.className || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
  return `${el.tagName.toLowerCase()}${id}${cls ? `.${cls}` : ''}`;
}

/** 在输入框内按回车提交 */
export function pressEnter(el: HTMLElement): void {
  const init = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 };
  el.dispatchEvent(new KeyboardEvent('keydown', init));
  el.dispatchEvent(new KeyboardEvent('keypress', init));
  el.dispatchEvent(new KeyboardEvent('keyup', init));
}

/**
 * 按 Esc 关闭弹窗。
 *
 * 为什么需要它：Radix / shadcn、semi-ui、antd、MUI 全都在 **document 上**
 * 监听 Esc 来关闭对话框，而它们的关闭按钮长相各不相同 —— 站点还可以整个
 * 去掉右上角的 X，只留一个自定义的底部按钮。词表命中不了时，Esc 是唯一
 * 与实现无关的关闭通道。
 *
 * 事件同时派发给 document 和弹窗自身：Radix 挂在 document，
 * 而少数实现只在弹窗根节点上 `onKeyDown`。
 */
export function pressEscape(targets: EventTarget[]): void {
  const init = { bubbles: true, cancelable: true, key: 'Escape', code: 'Escape', keyCode: 27, which: 27 };
  const seen = new Set<EventTarget>();
  for (const target of targets) {
    if (!target || seen.has(target)) continue;
    seen.add(target);
    target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
  }
}
