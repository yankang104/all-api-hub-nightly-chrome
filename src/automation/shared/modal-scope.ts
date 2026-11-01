/**
 * 弹窗归属判别：这个弹窗是公告，还是「必须操作它」的功能弹窗？
 *
 * 起因是一个真实的失败：有的站点签到按钮**就在弹窗里**（进签到页后弹出，
 * 点里面的按钮才算签到）。而关公告的逻辑跑在签到之前，还带 waitForAppear ——
 * 等着签到弹窗出现，然后把它关掉，接着去找签到按钮，找不到。
 *
 * 更糟的一种：公告词表里曾有 `.semi-modal-footer button`，匹配弹窗底部
 * **任意** button。footer 是 `[签到][关闭]` 时，它点中的是「签到」，
 * 而 closeVisibleNow 会点掉一个就重扫、循环到预算耗尽 —— 于是签到按钮被
 * 反复点击。dom-utils.ts 的 realClick 注释里写过这个后果：
 * 重复提交会让站点回「今日已签到」，把本来成功的结果盖成重复签到。
 *
 * 判别的核心不是「看关闭按钮长什么样」，而是**从关闭按钮上溯到它所属的
 * 弹窗，再看那个弹窗里有没有签到证据**。有就别动它。
 *
 * ⚠️ 误判方向必须偏向「保留」，因为两个方向的代价差得很远：
 *  - 留着公告：遮罩挡住签到按钮时 elementBlocking 会报出带元素描述的失败，
 *    诊断系统归类为不可重试，用户看得见。而且只在遮罩真压住按钮中心点时才付。
 *  - 关掉功能弹窗：日志写着「关闭了 1 个公告」，然后签到静默失败 ——
 *    或者更坏，在「登录即签到」路径上直接返回假成功。这种最难查。
 */

import {
  ALREADY_WORDS,
  CHECKIN_ACTION,
  NON_ACTION_WORDS,
  checkinControls,
  controlDisabled,
  controlText,
  hit,
  isVisibleElement,
} from '@/automation/checkin/checkin-vocab';

/**
 * 弹窗根的选择器。
 *
 * 只收**有语义**的和主流框架的固定类名。刻意不收 `[class*="modal" i]`
 * 这类宽泛匹配：它会把 `.modal-wrapper` 这种外层容器也算成弹窗根，
 * 于是里面两个并列的弹窗被合并成一个作用域 —— A 弹窗（公告）会因为
 * B 弹窗里有签到按钮而被误保留，多层叠加就再也关不掉了。
 */
export const MODAL_ROOT_SELECTORS = [
  'dialog[open]',
  '[role="dialog"]',
  '[aria-modal="true"]',
  '.semi-modal-mask',
  '.semi-modal-wrap',
  '.semi-modal',
  '.ant-modal-mask',
  '.ant-modal-wrap',
  '.ant-modal',
  '.MuiDialog-root',
  '.modal',
];

const MODAL_ROOT_QUERY = MODAL_ROOT_SELECTORS.join(', ');

/**
 * 明确表示「这是个可以关掉的通知」的按钮文案。
 *
 * 只在归属判不出来时当 tiebreaker 用 —— 带这种字样的按钮几乎不可能是
 * 功能弹窗的主操作。
 */
const DISMISS_WORDS = /(?:关闭公告|今日关闭|关闭通知|标记已读|不再提示|不再显示|我已知悉|已知悉|我已了解|已了解|我已阅读|已阅读并同意|我知道了|知道了|稍后再说|以后再说|mark(?:ed)?\s+(?:as\s+)?read|don'?t show|got it|dismiss)/i;

/** 按钮文案是否明确表示关闭、确认或标记公告已读。 */
export function isDismissText(text: string): boolean {
  return DISMISS_WORDS.test(text);
}

/**
 * 只写着「关闭」两个字的按钮文案（归一化后**全等**才算）。
 *
 * 为什么单独一档：上面的 DISMISS_WORDS 要求「关闭公告 / 关闭通知」这类
 * 复合词，而实测（2026-08-26，nova.vcrauo.com 系统公告）站点的公告弹窗
 * 底部**只有一个写着「关闭」的按钮** —— 没有右上角 X、没有 aria-label、
 * 没有任何 close 类名。于是 CSS 词表和语义词表同时扑空，日志一路写着
 * 「未发现公告弹窗」，公告却一直盖在签到按钮上。
 *
 * 必须全等匹配、不能用子串：「关闭自动签到」「关闭订阅」这类设置项也含
 * 「关闭」，子串匹配会把它们当公告关闭按钮点掉。
 *
 * 与 DISMISS_WORDS 的另一个区别是**判定权重**：这一档不足以跳过
 * 「弹窗里有没有签到证据」的检查（见 judgeCloseCandidate），
 * 因为功能弹窗的取消/关闭按钮也长这样。
 */
const BARE_CLOSE_LABELS = new Set([
  '关闭', '关掉', '关闭窗口', '关闭弹窗', '关闭对话框',
  'close', 'closedialog', 'closemodal', 'closewindow', 'closepopup',
  '×', '✕', '✖', '╳', 'x',
]);

/**
 * 控件的文案是不是**只写着**「关闭」这类词。
 *
 * 逐个来源单独判定，而不是像 controlText 那样拼成一串再匹配：拼接后
 * 「关闭」会和 aria-label 的英文连成「关闭close」，全等匹配就再也不命中了。
 *
 * 调用方要自己再加一道门槛（页面上确实有弹窗），见 announcements.ts ——
 * 普通页面上的「关闭」按钮多半是折叠面板或消息条，不该当公告点掉。
 */
export function isBareCloseLabel(element: HTMLElement): boolean {
  return [
    element.innerText,
    element.textContent,
    element.getAttribute('value'),
    element.getAttribute('aria-label'),
    element.getAttribute('title'),
  ]
    .map((value) => (typeof value === 'string' ? value.replace(/\s+/g, '').toLowerCase() : ''))
    .filter(Boolean)
    .some((text) => BARE_CLOSE_LABELS.has(text));
}

/**
 * 找出元素所属的**最外层**弹窗根。
 *
 * 取最外层而不是最近的：内层 `.semi-modal` 套在外层 `[role=dialog]` 里时，
 * 只取内层会让作用域漏掉 footer 或正文，判据就不准了。
 *
 * 返回 null 表示「归属不明」—— 调用方要按更保守的路子处理。
 */
export function ownerModal(el: Element): HTMLElement | null {
  const nearest = el.closest<HTMLElement>(MODAL_ROOT_QUERY);
  if (!nearest) return null;

  let hitEl: HTMLElement = nearest;
  for (;;) {
    const parent: HTMLElement | null = hitEl.parentElement;
    const outer: HTMLElement | null = parent ? parent.closest<HTMLElement>(MODAL_ROOT_QUERY) : null;
    if (!outer || outer === document.body) break;
    hitEl = outer;
  }
  return hitEl;
}

/** 弹窗里找到的签到证据类型 */
export type CheckinEvidence =
  /** 可点的签到按钮 —— 关掉这个弹窗就等于放弃签到 */
  | { kind: 'target'; text: string }
  /** 禁用的「已签到」按钮 —— 关掉它会让干净的 already 退化成失败 */
  | { kind: 'already'; text: string }
  /** 必须填的表单（强制绑定邮箱、首次设密码）—— 关掉也进行不下去 */
  | { kind: 'form'; text: string };

/**
 * 这个容器里有没有「不能关」的证据。
 *
 * 四格都要判：只判可点按钮的话，弹窗里已经是禁用的「已签到」态时会被当成
 * 公告关掉，本该干净返回的 already 就变成了「签到页未找到明确按钮」。
 */
export function holdsCheckinEvidence(
  root: ParentNode,
  alreadyWords: string[] = ALREADY_WORDS,
): CheckinEvidence | null {
  for (const el of checkinControls(root)) {
    const text = controlText(el);

    if (
      !controlDisabled(el)
      && CHECKIN_ACTION.test(text)
      && !NON_ACTION_WORDS.test(text)
      && !hit(text, alreadyWords)
    ) {
      return { kind: 'target', text };
    }

    if (controlDisabled(el) && hit(text, alreadyWords)) {
      return { kind: 'already', text };
    }
  }

  // 强制交互的表单：关掉它站点也不会让你继续
  if ((root as Element).querySelector?.('input[type="password"], input[autocomplete="one-time-code"]')) {
    return { kind: 'form', text: '' };
  }

  const claim = holdsClaimForm(root);
  if (claim) return claim;

  return null;
}

/** 领取弹窗里要填内容的输入框；密码/验证码框已由上面那格覆盖 */
const CLAIM_INPUT_QUERY = 'textarea, input[type="text"], input:not([type]), [contenteditable="true"]';

/**
 * 「填一段文本才能领取」式的功能弹窗（如 chaiai 的领取权益）。
 *
 * 为什么上面三格都盖不住它：这类弹窗的提交按钮在输入框填够字数前是
 * **禁用**的。第一格要求按钮可点 —— 禁用的漏掉；第二格要求按钮文案含
 * 「已签到」这类词 —— 一个空表单当然没有。于是弹窗被当成公告关掉，
 * 紧接着 claim 流程去找输入框，找不到。
 *
 * 判据刻意要求「输入框 **和** 动作词按钮同时在场」。只看输入框会把
 * 页面上任何带输入框的弹窗都判成功能弹窗 —— 搜索框、邮件订阅、
 * 反馈入口都算，那公告就再也关不掉了。
 */
function holdsClaimForm(root: ParentNode): CheckinEvidence | null {
  if (!(root as Element).querySelector?.(CLAIM_INPUT_QUERY)) return null;

  for (const el of checkinControls(root)) {
    const text = controlText(el);
    // 这里不筛禁用态：禁用的提交按钮正是本格要救的那种情况
    if (CHECKIN_ACTION.test(text) && !NON_ACTION_WORDS.test(text)) {
      return { kind: 'form', text };
    }
  }
  return null;
}

/** 页面上任一可见弹窗里是否有签到证据 */
export function anyVisibleModalHoldsEvidence(alreadyWords: string[] = ALREADY_WORDS): boolean {
  let modals: HTMLElement[];
  try {
    modals = [...document.querySelectorAll<HTMLElement>(MODAL_ROOT_QUERY)];
  } catch {
    return false;
  }
  return modals.some((modal) => isVisibleElement(modal) && !!holdsCheckinEvidence(modal, alreadyWords));
}

/**
 * 页面上还有没有签到线索（弹窗里的，或页面级的）。
 *
 * 用于关闭动作前后各测一次：关之前有、关之后没了，说明刚才关掉的
 * 大概是功能弹窗。这一条救不回已经关掉的弹窗，但能把静默失败变成
 * 日志里一句能 grep 的告警 —— 补的是 ownerModal 返回 null（归属不明）
 * 和「判定时签到控件还没渲染出来」这两个盲区。
 */
export function pageHasCheckinEvidence(alreadyWords: string[] = ALREADY_WORDS): boolean {
  if (anyVisibleModalHoldsEvidence(alreadyWords)) return true;
  return !!holdsCheckinEvidence(document, alreadyWords);
}

export type CloseVerdict =
  | { verdict: 'close' }
  | { verdict: 'keep'; reason: string };

/**
 * 该不该点这个「关闭按钮」候选。
 *
 * @param button 词表命中的关闭按钮候选
 * @param alreadyWords 站点自定义的已签到词表
 * @param scopedModal 已按实际遮挡关系定位的弹窗，避免把外层登录容器当作公告归属。
 */
export function judgeCloseCandidate(
  button: HTMLElement,
  alreadyWords: string[] = ALREADY_WORDS,
  scopedModal?: HTMLElement,
): CloseVerdict {
  // (a) 这个「关闭按钮」自己就是签到动作 —— 绝不能点。
  // 直接对应 `.semi-modal-footer button` 点中「签到」那条硬伤。
  const text = controlText(button);
  if (CHECKIN_ACTION.test(text) && !NON_ACTION_WORDS.test(text)) {
    return { verdict: 'keep', reason: `候选关闭按钮自身是签到动作「${text.slice(0, 20)}」` };
  }

  const owner = scopedModal ?? ownerModal(button);

  // 明确的公告动作优先于容器内的泛化签到词。部分站点把公告挂在
  // 全页 modal wrapper 上，wrapper 会包含背景的「获取密钥」等入口；
  // 若先看整块容器就会把“关闭公告”错误保留，遮罩永远不会消失。
  if (isDismissText(text)) return { verdict: 'close' };

  // (b) 归属明确 —— 只看它自己那个弹窗里有没有签到证据
  if (owner) {
    const evidence = holdsCheckinEvidence(owner, alreadyWords);
    if (evidence) {
      const detail = evidence.text ? `「${evidence.text.slice(0, 20)}」` : '';
      return { verdict: 'keep', reason: `弹窗内含签到${evidence.kind}${detail}` };
    }
    return { verdict: 'close' };
  }

  // (c) 归属不明 —— 从严：页面上任一弹窗有签到证据就整体保留。
  // 例外是按钮自带「不再提示」这类强公告信号，那可以放它过去。
  if (anyVisibleModalHoldsEvidence(alreadyWords) && !isDismissText(text)) {
    return { verdict: 'keep', reason: '关闭按钮归属不明，且页面存在含签到控件的弹窗' };
  }
  return { verdict: 'close' };
}
