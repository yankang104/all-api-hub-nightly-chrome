/**
 * 「学习结果」在账号行里的**展示层**纯函数。
 *
 * 为什么单独成文件：账号行只负责画，截断规则、每类动作的标签、以及
 * 「哪些字段允许进入 DOM」这三件事必须能被单测直接钉死 —— 尤其是隐私那一条，
 * 靠人眼看 JSX 是防不住的。这里不做任何判定与业务逻辑，只做映射和截断。
 *
 * 隐私红线（硬约束）：
 *   1. 输入类型刻意收窄成 `{ kind, text }`：路径、时间戳、原始坐标在**类型层面**
 *      就没有进入渲染管道的入口。事件里本来也不存在输入值（采集侧没有这个通道），
 *      但把「能进来的字段」写死，比指望每个调用方都记得脱敏可靠。
 *   2. 输出只含 label / text / index；`text` 是唯一原样透传的动态内容。
 */
import type { WorkflowLearningPreview } from '@/types/workflow';

/** 账号行里最多直接列几条：再多就把卡片撑得没法看，剩下的用一句「还有 N 个动作」。 */
export const LEARNING_PREVIEW_VISIBLE = 5;

export type LearningPreviewKind = WorkflowLearningPreview['kind'];

/**
 * 渲染管道允许接受的字段。
 *
 * 比 `WorkflowLearningPreview` 窄：后台多传什么字段都进不来。调用方传完整的
 * preview 对象也没问题（多余字段被丢弃），但传进来的敏感字段永远不会被读到。
 */
export interface LearningPreviewLike {
  kind: unknown;
  text: unknown;
  /**
   * 只用于**去重**，绝不参与渲染。
   *
   * 采集侧对同一次点击会补报一条不带落点的副本（拖拽把手松手后浏览器补发的
   * 合成 click 就是这种形状）。两条的时间戳完全一致、文案不同，逐条画出来会让
   * 用户以为自己的动作被记了两遍。时间戳与路径对用户都没有意义，所以只用来判重。
   */
  at?: unknown;
  path?: unknown;
}

export interface LearningPreviewView {
  kind: LearningPreviewKind | 'unknown';
  /** 固定中文标签，用于给出区分度（不参与 aria 名称计算）。 */
  label: string;
  /** 唯一允许渲染的动态内容。 */
  text: string;
  /** 序号：从 1 开始，与「共录到几个动作」的口径一致。 */
  index: number;
}

export interface LearningPreviewViewSet {
  /** 最近若干条（按事件流顺序）。 */
  items: LearningPreviewView[];
  /** 被截掉、只以「还有 N 个动作」呈现的条数。 */
  hidden: number;
  /** 本次可渲染的总条数（= items.length + hidden）。 */
  total: number;
}

const KIND_LABEL: Record<LearningPreviewKind, string> = {
  navigation: '打开',
  scroll: '滚动',
  click: '点击',
  drag: '拖动',
  fill: '填写',
};

/** 未知 kind（旧后台或未来扩展）时的标签：不猜具体动作，也不要空白。 */
const UNKNOWN_KIND_LABEL = '动作';

export function learningPreviewLabel(kind: unknown): string {
  return typeof kind === 'string' && Object.hasOwn(KIND_LABEL, kind)
    ? KIND_LABEL[kind as LearningPreviewKind]
    : UNKNOWN_KIND_LABEL;
}

export function learningPreviewKind(kind: unknown): LearningPreviewKind | 'unknown' {
  return typeof kind === 'string' && Object.hasOwn(KIND_LABEL, kind)
    ? (kind as LearningPreviewKind)
    : 'unknown';
}

/** 只保留真正可展示的条目：判据是 text 为非空字符串。 */
function isRenderable(item: LearningPreviewLike | null | undefined): item is LearningPreviewLike {
  return !!item && typeof item.text === 'string' && item.text.trim().length > 0;
}

/**
 * 把后台预览整理成账号行直接可渲染的结构。
 *
 * 截断方向：保留**最近**的条目 —— 用户关心的是「我刚才那一下有没有被学到」，
 * 而不是流程开头那次已经确认过的点击。序号沿用原始下标，避免截断后出现
 * 「1. 点击提交」这种会让人以为前面什么都没录到的错觉。
 */
export function learningPreviewViewSet(
  preview: readonly LearningPreviewLike[] | undefined,
  visible = LEARNING_PREVIEW_VISIBLE,
): LearningPreviewViewSet {
  const source = Array.isArray(preview) ? preview : [];
  const renderable = source
    .map((item, index) => ({ item, index }))
    .filter((entry): entry is { item: LearningPreviewLike; index: number } => isRenderable(entry.item));

  /**
   * 同一次动作的重复上报只留一条。
   *
   * 采集侧对同一次点击会先报一条带落点的、再补报一条不带落点的；两条的 `at`
   * 完全相同、短文案是长文案的前缀。逐条画出来用户会以为动作被记了两遍。
   *
   * 判据刻意保守 —— 必须同时满足「同 kind」「同 at」「短的一个是长的前缀」，
   * 任一不满足就各自保留。宁可偶尔多显示一条，也不能把用户真实做过两下的
   * 动作（比如真的连点两次）合并成一条。
   */
  const byAction = new Map<string, { item: LearningPreviewLike; index: number }>();
  const deduped: Array<{ item: LearningPreviewLike; index: number }> = [];
  for (const entry of renderable) {
    const at = entry.item.at;
    // 没有可用时间戳的条目无法判重：原样保留，宁可多显示一条也不误删。
    if (typeof at !== 'number' || !Number.isFinite(at)) {
      deduped.push(entry);
      continue;
    }
    const key = `${String(entry.item.kind)}\u0000${at}\u0000${String(entry.item.path ?? '')}`;
    const seen = byAction.get(key);
    const seenText = seen && typeof seen.item.text === 'string' ? seen.item.text : '';
    const entryText = typeof entry.item.text === 'string' ? entry.item.text : '';
    // 只有「同一动作的详略两版」才算重复：一个是另一个的前缀。
    if (!seen || !(entryText.startsWith(seenText) || seenText.startsWith(entryText))) {
      byAction.set(key, entry);
      deduped.push(entry);
      continue;
    }
    // 重复：保留信息更全（更长）的那条。
    if (entryText.length > seenText.length) seen.item = entry.item;
  }

  const limit = Math.max(0, Math.floor(visible));
  const tail = limit > 0 ? deduped.slice(-limit) : [];
  return {
    items: tail.map((entry) => ({
      kind: learningPreviewKind(entry.item.kind),
      label: learningPreviewLabel(entry.item.kind),
      text: entry.item.text as string,
      index: entry.index + 1,
    })),
    // hidden 按「真正会显示的动作」计数：去重后的条数才是用户视角的动作数。
    hidden: deduped.length - tail.length,
    total: deduped.length,
  };
}

/**
 * 账号行标题上的「已记录 N 个动作」该写几。
 *
 * 有可读摘要时用**去重后**的动作数：否则标题说 12、下面列 11 条 + 「还有 6 个」，
 * 用户会以为界面漏了一条。没有摘要（旧后台或刚开始录）时回落到后台的事件数。
 */
export function learningActionCount(
  preview: readonly LearningPreviewLike[] | undefined,
  fallbackCount: number,
): number {
  const total = learningPreviewViewSet(preview).total;
  return total > 0 ? total : Math.max(0, Math.floor(fallbackCount) || 0);
}
