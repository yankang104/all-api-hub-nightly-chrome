/**
 * 公告 / 弹窗清理。
 *
 * 为什么独立成一个模块：公告不是「登录前点一下」就完事的一步。
 * 实测（2026-08-11）站点的公告出现在三个不同时机：
 *
 *   1. 打开登录页时就有（老站点，服务端渲染）
 *   2. 登录成功跳到仪表盘后才弹（SPA 拉完接口才渲染，最常见）
 *   3. 进入签到页时又弹一次（活动公告、每日提示）
 *
 * 其中第 2 种最麻烦：登录后立刻扫一遍页面必然扑空，因为公告组件
 * 还在等接口返回。旧实现「第一轮没命中就 break」，8 秒预算形同虚设，
 * 于是日志写着「未发现公告弹窗」，几百毫秒后公告才盖上来，
 * 接着签到按钮就被它挡住了。
 *
 * 所以这里的核心是两件事：
 *  - 真的等（轮询到超时），而不是扫一次就走
 *  - 关不掉要说出来（返回遮罩状态），而不是假装没事
 */
import type { SiteConfig } from '@/types';
import { COMMON_CLOSE_SELECTORS } from '@/sites';
import { describeElement, elementBlocking, isVisible, pressEscape, queryAll, realClick, sleep } from '@/automation/shared/dom-utils';
import type { StepLog } from '@/automation/shared/log';
import { ALREADY_WORDS, checkinControls, controlDisabled, controlText } from '@/automation/checkin/checkin-vocab';
import {
  MODAL_ROOT_SELECTORS,
  anyVisibleModalHoldsEvidence,
  holdsCheckinEvidence,
  isBareCloseLabel,
  isDismissText,
  judgeCloseCandidate,
  ownerModal,
  pageHasCheckinEvidence,
} from '@/automation/shared/modal-scope';

/**
 * 登录后等公告出现的时长。
 *
 * 2.5 秒是权衡：实测站点公告在接口返回后几百毫秒内渲染，2.5 秒足够；
 * 再往上加会拖慢每一个账号的总耗时（批量签到时按账号数放大），
 * 而公告没等到的代价只是少关一个弹窗，不是签到失败 ——
 * 真正兜底的是点击前的遮挡检查（elementBlocking）。
 */
const APPEAR_WAIT_MS = 2_500;
/** 清理阶段的总预算，防止站点无限弹 */
const CLEANUP_BUDGET_MS = 6_000;
/** 关掉一个公告后等它消失的时长：动画通常 200-300ms，1 秒够了 */
const GONE_WAIT_MS = 1_000;
const POLL_INTERVAL_MS = 250;

/**
 * 判定「页面被遮罩盖住」的选择器。
 *
 * 遮罩层是公告没关干净的可靠信号。这一点必须显式检查，因为
 * 签到等主操作现在走浏览器级坐标输入；这里仍显式检查遮罩，防止站点
 * 在清理结束后又迟到渲染一层公告，把后续真实鼠标点击截走。
 */
const OVERLAY_SELECTORS = [
  '.semi-modal-mask',
  '.ant-modal-mask',
  '.ant-modal-wrap',
  '.modal-backdrop',
  '[class*="overlay" i][class*="modal" i]',
  '[class*="mask" i][class*="modal" i]',
  '.MuiBackdrop-root',
  'dialog[open]',
  '[role="dialog"]',
  '[aria-modal="true"]',
  /*
   * Radix / shadcn 的遮罩层与弹窗容器（Orbelis 系实测）。
   *
   * 它们没有任何 mask / overlay 类名 —— 只有 `data-slot` 和一串
   * Tailwind 原子类（`fixed inset-0 bg-black/50`）。上面那两条要求
   * class 里同时出现 overlay/mask 和 modal，一条都命中不了。
   */
  '[data-slot="dialog-overlay"]',
  '[data-slot="dialog-content"]',
  // Tailwind 铺满视口的定位层：`fixed inset-0` 是遮罩的通用写法。
  // 用 ~= 按 class token 精确匹配，不会误伤 `inset-0.5` 之类的变体。
  // 刻意不收 `[data-radix-popper-content-wrapper]`：那是下拉菜单/tooltip 的
  // 定位容器，它们不接管页面，收进来只会制造假遮罩。
  '[class~="fixed"][class~="inset-0"]',
];

/**
 * 语义上「页面已被弹窗接管」的选择器 —— 不看尺寸就算遮挡。
 *
 * `aria-modal="true"` 和 `<dialog open>` 的定义就是「弹窗之外的内容不可交互」，
 * 尺寸再小也一样。而 OVERLAY_SELECTORS 里的其它条目要过尺寸门槛：
 * 一个 480px 宽的公告卡片在 1280px 视口里只占 37%，卡在 0.6 的门槛外 ——
 * 这正是遮罩明明盖着签到按钮、日志却说「未发现公告弹窗」的那一半原因。
 */
const MODAL_SEMANTICS_SELECTORS = ['dialog[open]', '[aria-modal="true"]'];

const OVERLAY_QUERY = OVERLAY_SELECTORS.join(', ');
/** 内容面板包括正文和操作区，不使用可能同时包着登录页的最外层 wrapper。 */
const MODAL_CONTENT_QUERY = [
  'dialog[open]', '[role="dialog"]', '[aria-modal="true"]', '[data-slot="dialog-content"]',
  '.semi-modal', '.ant-modal', '.MuiDialog-paper', '.modal',
].join(', ');
const BACKDROP_QUERY = [
  '.semi-modal-mask', '.ant-modal-mask', '.modal-backdrop', '.MuiBackdrop-root',
  '[data-slot="dialog-overlay"]', '[class*="overlay" i][class*="modal" i]',
  '[class*="mask" i][class*="modal" i]', '[class~="fixed"][class~="inset-0"]',
].join(', ');
const SIBLING_DIALOG_QUERY = `${MODAL_CONTENT_QUERY}, .semi-modal-wrap, .ant-modal-wrap, .MuiDialog-container`;

/** 只在同一次点击前的短重试之间共享；不能跨任务永久屏蔽关闭按钮。 */
export interface AnnouncementCleanupState {
  failedButtons: Set<HTMLElement>;
  escapedOverlays: Set<HTMLElement>;
}

export interface AnnouncementOptions {
  waitForAppear?: boolean;
  blockedElement?: HTMLElement;
  cleanupState?: AnnouncementCleanupState;
}

export interface AnnouncementResult {
  /** 本次关掉了几个 */
  closed: number;
  /** 清理后是否仍有遮罩挡着页面 */
  blocked: boolean;
  /** 判定为功能弹窗（含签到控件）而刻意保留的个数 */
  keptFunctional: number;
}

/**
 * 找出挡着页面的那个遮罩 / 弹窗，找不到返回 null。
 *
 * 返回元素而不是布尔值，是为了让 Esc 兜底能把事件也派发给它，
 * 并在日志里说清到底是什么挡住了页面。
 */
function findBlockingOverlay(blockedElement?: HTMLElement): HTMLElement | null {
  if (blockedElement) {
    if (!blockedElement.isConnected) return null;
    const blocker = elementBlocking(blockedElement);
    const overlay = blocker?.closest<HTMLElement>(OVERLAY_QUERY);
    return overlay && isRendered(overlay) && catchesPointer(overlay) ? overlay : null;
  }

  const overlays = queryAll<HTMLElement>(OVERLAY_QUERY).filter((element) => {
    if (!isRendered(element) || !catchesPointer(element)) return false;
    if (element.matches(MODAL_SEMANTICS_SELECTORS.join(', '))) return true;
    const rect = element.getBoundingClientRect();
    return rect.width >= window.innerWidth * 0.6 && rect.height >= window.innerHeight * 0.4;
  });
  // 通过实际命中位置筛掉被上层盖住的旧弹窗；同一分支优先内容层而非外壳。
  return overlays.reverse().find((overlay) => overlayRoots(overlay).some(isExposedLayer)) ?? null;
}

/** 可见性要沿祖先检查，否则 opacity:0 的旧公告中仍能找到“可见”按钮。 */
function isRendered(element: HTMLElement): boolean {
  if (!element.isConnected || !isVisible(element)) return false;
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    const style = window.getComputedStyle(current);
    if (current.hidden || style.display === 'none' || style.visibility === 'hidden'
      || style.visibility === 'collapse' || style.opacity === '0') return false;
  }
  return true;
}

/** 背景和内容可能是兄弟节点，只关联相邻的弹窗容器，绝不把整个 body 当公告。 */
function overlayRoots(overlay: HTMLElement): HTMLElement[] {
  const roots = new Set<HTMLElement>([overlay]);
  if (overlay.matches(BACKDROP_QUERY)) {
    for (const sibling of [overlay.previousElementSibling, overlay.nextElementSibling]) {
      if (sibling instanceof HTMLElement && sibling.matches(SIBLING_DIALOG_QUERY) && isRendered(sibling)) {
        roots.add(sibling);
      }
    }
    // 无语义标记的 Tailwind 自定义弹窗（Motomoto 系实测）：遮罩是 `fixed inset-0`
    // 铺满层，装按钮的内容卡片是它的兄弟层且同样没有 dialog/role/aria-modal 标记，
    // 上一段的 SIBLING_DIALOG_QUERY 命中不了。这里靠「盖在遮罩之上的那层」把它找回来。
    for (const layer of bareMaskContentRoots(overlay)) roots.add(layer);
  }
  return [...roots];
}

/**
 * 当遮罩是无语义标记的铺满层时，找出真正盖在它之上的内容卡片。
 *
 * 判据是命中位置：遮罩压暗全页，页面主体被它盖住 → elementFromPoint 命不中；
 * 而公告卡片画在遮罩之上 → 命得中。把命中元素上溯到「与遮罩同级」的那一层，
 * 就是内容层。遮罩自身的后代已在作用域内（collectCloseCandidates 会扫遮罩本身），
 * 这里只补「盖在遮罩之上的兄弟卡片」这一个盲区。
 *
 * 仅当遮罩本身没有框架弹窗标记时才启用 —— 有标记时原有 SIBLING_DIALOG_QUERY
 * 已经够用，不必再靠命中猜。是否真的关掉纳入的卡片仍由 judgeCloseCandidate +
 * holdsCheckinEvidence 决定：即便把功能卡片收进作用域，也只会被判定为「保留」。
 */
function bareMaskContentRoots(overlay: HTMLElement): HTMLElement[] {
  // 遮罩自己或其后代已经是框架弹窗 → 走原有作用域，别再靠命中猜内容层。
  if (overlay.matches(MODAL_CONTENT_QUERY) || overlay.querySelector(MODAL_CONTENT_QUERY)) return [];
  const parent = overlay.parentElement;
  if (!parent) return [];

  const rect = overlay.getBoundingClientRect();
  const left = Math.max(0, rect.left);
  const right = Math.min(window.innerWidth, rect.right);
  const top = Math.max(0, rect.top);
  const bottom = Math.min(window.innerHeight, rect.bottom);
  if (right <= left || bottom <= top) return [];

  const found = new Set<HTMLElement>();
  for (let row = 1; row <= 3; row += 1) {
    for (let col = 1; col <= 3; col += 1) {
      const x = left + ((right - left) * col) / 4;
      const y = top + ((bottom - top) * row) / 4;
      let hit: Element | null = document.elementFromPoint(x, y);
      // 命中遮罩自身或它的后代都不算内容层（后代已在作用域内）；只收盖在它之上的。
      if (!(hit instanceof HTMLElement) || hit === overlay || overlay.contains(hit)) continue;
      // 上溯到与遮罩同级的那一层 —— 它才是「盖在遮罩之上」的完整卡片。
      let layer: HTMLElement = hit;
      while (layer.parentElement && layer.parentElement !== parent) layer = layer.parentElement;
      if (layer.parentElement === parent && layer !== overlay && isRendered(layer)) found.add(layer);
    }
  }
  return [...found];
}

function isExposedLayer(root: HTMLElement): boolean {
  const rect = root.getBoundingClientRect();
  const left = Math.max(0, rect.left);
  const right = Math.min(window.innerWidth, rect.right);
  const top = Math.max(0, rect.top);
  const bottom = Math.min(window.innerHeight, rect.bottom);
  if (right <= left || bottom <= top) return false;
  const insetX = Math.min(8, (right - left) / 2);
  const insetY = Math.min(8, (bottom - top) / 2);
  const points: [number, number][] = [
    [(left + right) / 2, (top + bottom) / 2],
    [left + insetX, top + insetY],
    [right - insetX, bottom - insetY],
  ];
  return points.some(([x, y]) => {
    const hit = document.elementFromPoint(x, y);
    return !!hit && (hit === root || root.contains(hit));
  });
}

/**
 * 这一层会不会真的接住点击？
 *
 * `pointer-events: none` 的铺满层挡不住任何东西 —— toast 容器、装饰性渐变、
 * Radix 的 portal 根节点都是这么写的，而它们和真遮罩一样匹配
 * `fixed inset-0`。不排掉就会反复报「检测到遮罩层」并白按 Esc。
 */
function catchesPointer(element: HTMLElement): boolean {
  try {
    return window.getComputedStyle(element).pointerEvents !== 'none';
  } catch {
    return true;
  }
}

/** 页面上是否还有明显的模态遮罩 */
function hasBlockingOverlay(blockedElement?: HTMLElement): boolean {
  if (blockedElement?.isConnected) return !!elementBlocking(blockedElement);
  return !!findBlockingOverlay();
}

/**
 * 站点自己配的选择器优先，再兜上通用词表。
 *
 * COMMON_CLOSE_SELECTORS 一直定义在 sites/index.ts 里却没人用 ——
 * 旧实现只读 site.closeModalSelectors，站点没配就整段跳过。
 * 大多数 new-api / semi-ui 系站点的关闭按钮长得一样，通用词表能直接覆盖。
 */
function closeSelectors(site: SiteConfig): string[] {
  const configured = site.closeModalSelectors ?? [];
  return [...new Set([...configured, ...COMMON_CLOSE_SELECTORS])];
}

interface CleanupResult {
  closed: number;
  /** 判定为功能弹窗、刻意没关的候选数 */
  kept: number;
  /** 关掉某个弹窗后页面失去了签到线索，疑似误关 */
  lostEvidence: boolean;
}

interface CloseCandidate {
  /** 保留命中来源供日志说明；语义候选没有稳定选择器。 */
  selector: string | null;
  element: HTMLElement;
  scope: HTMLElement;
}

/** 语义候选的扫描范围：带点击语义、且可能是关闭按钮的元素 */
const CLICKABLE_QUERY = 'button, [role="button"], input[type="button"], input[type="submit"], a[href="#"], a:not([href]), [onclick]';

function visibleCenter(element: HTMLElement): { x: number; y: number } | null {
  if (!element.isConnected || !isVisible(element)) return null;
  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  return x >= 0 && x < window.innerWidth && y >= 0 && y < window.innerHeight ? { x, y } : null;
}

function usableCloseButton(element: HTMLElement): boolean {
  if (!isRendered(element) || !catchesPointer(element) || controlDisabled(element)) return false;
  if (element.matches(':disabled') || element.closest('[inert], [aria-hidden="true"], [aria-disabled="true"]')) return false;
  const point = visibleCenter(element);
  // 内容区可滚动时按钮可能在视口外，交给 realClick 滚动后再次确认落点。
  if (!point) return true;
  const hit = document.elementFromPoint(point.x, point.y);
  return !!hit && (hit === element || element.contains(hit));
}

function closeScope(element: HTMLElement, roots: HTMLElement[]): HTMLElement {
  const root = roots.find((candidate) => candidate.contains(element));
  const content = element.closest<HTMLElement>(MODAL_CONTENT_QUERY);
  if (content && (!root || root.contains(content))) {
    // semi/ant 的内容类有时只覆盖正文，外侧同一 dialog 还含 footer/表单。
    // 在当前遮挡层内补齐它，不能为了缩小作用域而丢掉功能弹窗保护证据。
    const semanticQuery = 'dialog[open], [role="dialog"], [aria-modal="true"], [data-slot="dialog-content"]';
    if (!content.matches(semanticQuery)) {
      const semantic = content.parentElement?.closest<HTMLElement>(semanticQuery);
      if (semantic && root?.contains(semantic)) return semantic;
    }
    return content;
  }
  return root ?? ownerModal(element) ?? element;
}

/**
 * 除站点/框架选择器外，也识别「标记已读」「我知道了」「关闭」这类公告动作。
 *
 * 百倍的公告只有主按钮文案，没有 close 类名或 aria-label；Orbelis 系更极端 ——
 * 公告底部**只有一个写着「关闭」的按钮**（实测 2026-08-26，nova.vcrauo.com
 * 的「系统公告」）。单靠 CSS 词表两家都会漏掉，日志一路写「未发现公告弹窗」。
 *
 * 两档语义候选的门槛不同：
 *  - 「标记已读 / 不再提示」是强信号，出现在哪都算公告动作；
 *  - 只写「关闭」的按钮**必须确实在弹窗里**才算。普通页面上的「关闭」多半是
 *    折叠面板、消息条或某个设置项，无条件收进来会去点页面上不该点的东西。
 *
 * 是否真的点下去仍由 judgeCloseCandidate 决定，这里只负责把候选收全。
 *
 * @param overlay 当前挡住页面的遮罩。custom Tailwind 弹窗没有 role/aria 标记，
 *   ownerModal 认不出来，只能靠「在遮罩里面」这个事实兜住。
 */
function collectCloseCandidates(selectors: string[], overlay: HTMLElement | null = null): CloseCandidate[] {
  const modalRoots = overlay
    ? overlayRoots(overlay)
    : queryAll<HTMLElement>(`${MODAL_ROOT_SELECTORS.join(', ')}, ${MODAL_CONTENT_QUERY}`).filter(isRendered);
  const searchRoots: ParentNode[] = overlay ? modalRoots : [document];
  // 同一个选择器的旧节点可以继续挂在 DOM；必须枚举全部匹配再按作用域和可达性筛选。
  const candidates = selectors.flatMap((selector) => searchRoots.flatMap((root) => (
    queryAll<HTMLElement>(selector, root).map((element) => ({ selector, element }))
  )));

  // Some sites render the action as a styled div/span rather than button/role=button.
  // checkinControls already understands class/onclick/cursor:pointer semantics; scope it
  // to the active overlay/modal so ordinary page text cannot become a close candidate.
  const scopedSemantic = [...new Set(
    modalRoots.flatMap((root) => checkinControls(root)),
  )];

  // 禾维这类页面有时把「我知道了」渲染成没有 button/role/class/onclick
  // 的普通 div。只在当前遮罩或弹窗内部扫描短文本叶节点：这样能覆盖这类
  // 自定义控件，又不会把整页普通内容里的「关闭」当成公告按钮。
  const scopedPlainText = [...new Set(
    modalRoots.flatMap((root) => [...root.querySelectorAll<HTMLElement>('div, span')])
      .filter((element) => {
        if (!isRendered(element)) return false;
        const raw = (element.innerText || element.textContent || '').trim().replace(/\s+/g, ' ');
        if (!raw || raw.length > 40) return false;
        // 有文字子节点时让最内层节点负责点击；只有图标等非文字子节点时，
        // 外层普通 div 仍可能是实际的 click 处理器承载者。
        if ([...element.children].some((child) => (child.textContent || '').trim())) return false;
        return isDismissText(raw) || isBareCloseLabel(element);
      }),
  )];
  const semantic = [
    ...searchRoots.flatMap((root) => [...root.querySelectorAll<HTMLElement>(CLICKABLE_QUERY)]),
    ...scopedSemantic,
    ...scopedPlainText,
  ].filter((element) => {
    if (!isRendered(element)) return false;
    if (isDismissText(controlText(element))) return true;
    if (!isBareCloseLabel(element)) return false;
    return !!ownerModal(element) || modalRoots.some((root) => root.contains(element));
  });

  const seen = new Set<HTMLElement>();
  return [...candidates, ...semantic.map((element) => ({ selector: null, element }))]
    .map(({ selector, element }) => {
      // 文本 span / X 图标与所属 button 是同一次点击，不能作为两个重试候选。
      const control = element.closest<HTMLElement>(CLICKABLE_QUERY) ?? element;
      return { selector, element: control, scope: closeScope(control, modalRoots) };
    })
    .filter(({ element }) => {
      if (seen.has(element)) return false;
      seen.add(element);
      if (overlay && !modalRoots.some((root) => root.contains(element))) return false;
      return usableCloseButton(element);
    })
    .sort((a, b) => (
      Number(!visibleCenter(a.element)) - Number(!visibleCenter(b.element))
      || Number(!isDismissText(controlText(a.element))) - Number(!isDismissText(controlText(b.element)))
    ));
}

async function waitAnnouncementDismissed(
  scope: HTMLElement,
  blockedElement: HTMLElement | undefined,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isRendered(scope)) return true;
    // 外层登录容器可以一直存在，只要原操作目标确实恢复可点击就不再等错容器。
    // 目标脱离 DOM 或滚出视口时不能用 elementBlocking(null) 的结果冒充成功。
    if (blockedElement && visibleCenter(blockedElement) && !elementBlocking(blockedElement)) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await sleep(Math.min(50, remaining));
  }
}

/**
 * 关掉当前页面上能关的公告。
 *
 * 每轮只关一个再重扫，而不是把所有选择器都走一遍：通用词表有 9 个选择器，
 * 逐个 waitGone 会白等好几秒 —— 批量签到时这个开销按账号数放大。
 * 关掉一个就重扫，既能处理多层叠加的公告，又不为没命中的选择器付等待代价。
 *
 * 与旧实现的关键差别：不再「取第一个命中的就点」，而是**枚举全部候选、
 * 逐个判定归属**，只点被判为公告的那个。签到按钮在弹窗里的站点上，
 * 旧实现会把签到弹窗关掉（甚至把签到按钮当关闭按钮反复点）。
 *
 * 一个容器被判为「保留」不能中断整轮清理 —— 上层的功能弹窗不该
 * 保护下层的公告，继续看下一个候选。
 */
async function closeVisibleNow(
  selectors: string[],
  alreadyWords: string[],
  log: StepLog,
  blockedElement: HTMLElement | undefined,
  cleanupState: AnnouncementCleanupState,
): Promise<CleanupResult> {
  let closed = 0;
  let kept = 0;
  let lostEvidence = false;
  const deadline = Date.now() + CLEANUP_BUDGET_MS;
  const explained = new Set<string>();

  while (Date.now() < deadline) {
    // 每轮重新取遮罩：关掉一层后下面可能还压着一层，遮罩元素本身也会换。
    const overlay = findBlockingOverlay(blockedElement);
    // 有明确目标时只处理挡住它的那一层，不能在已解除遮挡后继续扫全页。
    if (blockedElement && !overlay) break;
    const candidates = collectCloseCandidates(selectors, overlay).filter(({ element }) => (
      ![...cleanupState.failedButtons].some((failed) => (
        failed === element || failed.contains(element) || element.contains(failed)
      ))
    ));
    if (candidates.length === 0) break;

    let target: CloseCandidate | null = null;
    let keptThisRound = 0;

    for (const candidate of candidates) {
      const judged = judgeCloseCandidate(
        candidate.element,
        alreadyWords,
        candidate.scope === candidate.element ? undefined : candidate.scope,
      );
      if (judged.verdict === 'close') {
        target = candidate;
        break;
      }
      keptThisRound += 1;
      // 同一个理由只说一次，免得多轮扫描把日志刷满
      if (!explained.has(judged.reason)) {
        explained.add(judged.reason);
        log.push(`保留弹窗：${judged.reason}`);
      }
    }

    kept = keptThisRound;
    if (!target) break;

    // 关之前先记下页面有没有签到线索，关完再看一次 —— 判据失效时
    // 至少能响亮地失败，而不是留下一句「关闭了 1 个公告」了事
    const hadEvidence = pageHasCheckinEvidence(alreadyWords);

    const label = controlText(target.element).replace(/\s+/g, ' ').slice(0, 40) || describeElement(target.element);
    const source = target.selector ?? '文字识别';
    const detail = `「${label}」（${describeElement(target.scope)}，${source}）`;
    let clickError: string | null = null;
    try {
      // 与登录/签到共用经过落点校验的输入通道；不在可信点击失败后盲目补发 DOM 点击。
      const mode = await realClick(target.element, { deadline });
      log.push(`公告关闭按钮已收到${mode === 'trusted' ? '浏览器可信' : 'DOM'}点击：${detail}`);
    } catch (error) {
      clickError = error instanceof Error ? error.message : String(error);
    }
    // 回执丢失也先看页面结果，防止已关掉的公告被误判失败后重复操作。
    const disappeared = await waitAnnouncementDismissed(
      target.scope,
      blockedElement,
      Math.max(0, Math.min(GONE_WAIT_MS, deadline - Date.now())),
    );
    if (!disappeared) {
      cleanupState.failedButtons.add(target.element);
      log.push(clickError
        ? `公告关闭操作未确认：${detail}，${clickError}；当前遮挡仍在，尝试其他关闭按钮`
        : `公告关闭按钮未能解除当前遮挡：${detail}；跳过该按钮，尝试其他候选`);
      continue;
    }
    log.push(clickError
      ? `公告关闭点击回执未确认，但已确认对应弹窗消失或目标遮挡解除：${detail}`
      : `已确认对应公告消失或目标遮挡解除：${detail}`);
    closed += 1;
    await sleep(120);

    if (hadEvidence && !pageHasCheckinEvidence(alreadyWords)) {
      lostEvidence = true;
    }
  }

  return { closed, kept, lostEvidence };
}

/**
 * 作用域里有没有「明显是用来关闭公告」的控件。
 *
 * 用于 escapeBlockingOverlay 的兜底判定：无框架标记的自定义弹窗挑不出 modal 根，
 * 但只要作用域里确有 dismiss 文案或纯「关闭 / ×」按钮，就说明这是个可关公告，
 * 值得按一次 Esc。判据与 collectCloseCandidates 收候选时一致，不引入新语义。
 */
function rootHasCloseAffordance(root: HTMLElement): boolean {
  const controls = [
    ...root.querySelectorAll<HTMLElement>(CLICKABLE_QUERY),
    ...checkinControls(root),
  ];
  return controls.some((el) => (
    isRendered(el) && (isDismissText(controlText(el)) || isBareCloseLabel(el))
  ));
}

/**
 * 词表全部扑空时的最后一招：按 Esc。
 *
 * 为什么值得单独兜一层：关闭按钮的长相是站点自己定的，词表永远追不完 ——
 * 站点可以把右上角的 X 整个去掉，只留一个自定义按钮，甚至只留点遮罩关闭。
 * 而 Esc 关闭是 Radix / semi-ui / antd / MUI 的**默认行为**，与长相无关。
 *
 * ⚠️ 只在「页面上没有任何含签到控件的弹窗」时才按。Esc 会连功能弹窗一起
 * 关掉 —— 签到按钮就在弹窗里的站点上，这一下就等于放弃签到。这个前置检查
 * 与 modal-scope 的整体取向一致：宁可留着公告让遮挡检查响亮失败，
 * 也不要静默关掉功能弹窗。
 *
 * @returns `absent` 本来就没遮罩；`functional` 有功能弹窗、刻意没按；
 *   `skipped` 页面上没有可关的弹窗根，按 Esc 无从生效也可能误伤；
 *   `gone` 按了 Esc 且遮罩消失；`failed` 按了没用
 */
async function escapeBlockingOverlay(
  alreadyWords: string[],
  log: StepLog,
  blockedElement: HTMLElement | undefined,
  cleanupState: AnnouncementCleanupState,
): Promise<'absent' | 'functional' | 'skipped' | 'gone' | 'failed'> {
  const overlay = findBlockingOverlay(blockedElement);
  if (!overlay) return 'absent';
  if (anyVisibleModalHoldsEvidence(alreadyWords)) return 'functional';
  const roots = overlayRoots(overlay);
  if (roots.some((root) => holdsCheckinEvidence(root, alreadyWords))) return 'functional';

  /*
   * 要求页面上真的有一个框架弹窗根才按 Esc。
   *
   * 判成遮罩的层不一定是弹窗：不少 SPA 把整个应用外壳写成
   * `fixed inset-0 overflow-auto`，它铺满视口、也接收点击，但页面本来就长这样。
   * 对着外壳按 Esc 关不掉任何东西，还可能把站点自己打开的下拉菜单收起来。
   */
  const modalQuery = `${MODAL_ROOT_SELECTORS.join(', ')}, ${MODAL_CONTENT_QUERY}`;
  const modals = [...new Set(roots.flatMap((root) => [
    ...(root.matches(modalQuery) ? [root] : []),
    ...queryAll<HTMLElement>(modalQuery, root),
  ]))].filter(isRendered);
  // 无框架标记的自定义弹窗（Tailwind `fixed inset-0` + 无标记卡片）挑不出 modal 根，
  // 但只要作用域里确有「关闭/知悉/×」这类关闭控件，就说明这确是个可关公告，
  // 值得按一次 Esc 兜底 —— 而不是像整页外壳那样直接放弃。整页外壳因含签到证据，
  // 已在上面的 functional 分支拦下，不会走到这里。
  if (modals.length === 0 && !roots.some((root) => rootHasCloseAffordance(root))) return 'skipped';
  if (cleanupState.escapedOverlays.has(overlay)) return 'failed';
  cleanupState.escapedOverlays.add(overlay);

  const reason = cleanupState.failedButtons.size > 0 ? '已尝试的公告关闭按钮未生效' : '当前公告没有可用的关闭按钮';
  log.push(`${reason}（${describeElement(overlay)}），尝试一次 Esc`);
  const active = document.activeElement;
  const escapeTarget = active && modals.some((modal) => modal.contains(active))
    ? active
    : modals[modals.length - 1] ?? overlay;
  // 从当前弹窗冒泡到 document 一次；不能给每层各发一次，导致同一 Esc 被重复处理。
  pressEscape([escapeTarget]);
  return await waitAnnouncementDismissed(overlay, blockedElement, GONE_WAIT_MS) ? 'gone' : 'failed';
}

/**
 * 关闭公告，必要时先等它出现。
 *
 * @param waitForAppear 是否等公告出现。登录成功后、进入签到页后要等
 *   （公告此刻还没渲染）；登录页打开时不用等（要么已经在，要么没有），
 *   免得每个站点白等几秒。
 */
export async function dismissAnnouncements(
  site: SiteConfig,
  log: StepLog,
  {
    waitForAppear = false,
    blockedElement,
    cleanupState = { failedButtons: new Set<HTMLElement>(), escapedOverlays: new Set<HTMLElement>() },
  }: AnnouncementOptions = {},
): Promise<AnnouncementResult> {
  const selectors = closeSelectors(site);
  const alreadyWords = site.checkin?.alreadyText?.length ? site.checkin.alreadyText : ALREADY_WORDS;

  let result = await closeVisibleNow(selectors, alreadyWords, log, blockedElement, cleanupState);

  // 关键的一段：登录后公告往往迟到几百毫秒到几秒。
  // 已经关掉过就不必再等 —— 那说明公告早就在了。
  if (result.closed === 0 && waitForAppear) {
    const deadline = Date.now() + APPEAR_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      // 语义候选（只写「关闭」的按钮）没有稳定选择器，必须一起探 ——
      // 只探 CSS 词表会在「公告已经渲染出来但词表命中不了」时白等到超时。
      const overlay = findBlockingOverlay(blockedElement);
      if (
        overlay
        || (!blockedElement && collectCloseCandidates(selectors).length > 0)
      ) {
        const second = await closeVisibleNow(selectors, alreadyWords, log, blockedElement, cleanupState);
        result = {
          closed: second.closed,
          kept: second.kept || result.kept,
          lostEvidence: result.lostEvidence || second.lostEvidence,
        };
        break;
      }
    }
  }

  const { closed, kept, lostEvidence } = result;
  // 词表点不掉的遮罩再按一次 Esc；还留着功能弹窗时它自己会拒绝动手
  const escape = await escapeBlockingOverlay(alreadyWords, log, blockedElement, cleanupState);
  const blocked = hasBlockingOverlay(blockedElement);

  if (closed > 0) {
    log.push(blocked ? `关闭了 ${closed} 个公告，但页面仍有遮罩` : `关闭了 ${closed} 个公告/弹窗`);
  } else if (escape === 'gone') {
    log.push('已用 Esc 关闭挡住页面的公告弹窗');
  } else if (kept > 0 || escape === 'functional') {
    // 有遮罩但都是功能弹窗：这不是「选择器不对」，别让诊断把用户
    // 指向改选择器。措辞刻意避开 diagnostics 的「未找到/找不到/选择器」等触发词。
    log.push(`保留了 ${Math.max(kept, 1)} 个含登录/签到控件的弹窗，未作为公告关闭`);
  } else if (blocked) {
    // 有遮罩却一个都没关掉。必须说出来 —— 否则签到点击会被遮罩
    // 静默吞掉，日志还显示已点击。区分「Esc 也试过了」和「没有弹窗可按」，
    // 后者多半是整页外壳被判成了遮罩，改选择器解决不了。
    if (escape === 'failed') {
      log.push(cleanupState.failedButtons.size > 0
        ? '已尝试的公告关闭按钮未生效，Esc 也未解除遮挡，后续操作仍被挡住'
        : '当前遮挡层没有可用的公告关闭按钮，Esc 也未解除遮挡');
    } else {
      log.push(cleanupState.failedButtons.size > 0
        ? '公告关闭按钮未能解除遮挡，未对归属不明的浮层继续按 Esc'
        : '当前遮挡层没有可安全点击的公告关闭按钮，未对归属不明的浮层按 Esc');
    }
  } else {
    log.push('未发现公告弹窗');
  }

  // 单独一句：这是「判据失效」的信号，比上面任何一句都值得注意
  if (lostEvidence) {
    log.push('关闭弹窗后页面失去签到线索，疑似误关功能弹窗');
  }

  return { closed, blocked, keptFunctional: Math.max(kept, escape === 'functional' ? 1 : 0) };
}
