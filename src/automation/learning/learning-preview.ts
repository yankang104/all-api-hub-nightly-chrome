import type { WorkflowLearningEvent, WorkflowLearningPreview } from '@/types/workflow';

/**
 * 学习事件的人类可读摘要。
 *
 * 这里只翻译「用户做了什么」，不翻译任何页面内容或输入值。旧事件缺少新字段时，
 * 缺省文案保持可用；未来若事件联合类型补上 `drag`，这里也已经能识别。
 */
const PREVIEW_LIMIT = 20;
const SELECTOR_LABEL_MAX_CHARS = 20;

interface DragLikeLearningEvent {
  type: 'drag';
  selector: string;
  toSelector: string;
  path: string;
  at: number;
}

/**
 * `workflow-form.ts` 里的同名规则尚未导出；为避免跨 UI 模块建立新耦合，这里
 * 复制同一规则并按预览要求截断到 20 个字符。
 */
function selectorLabel(selector: string): string {
  const trimmed = selector.trim();
  const visible = trimmed.startsWith('text=') ? trimmed.slice('text='.length).trim() : trimmed;
  return Array.from(visible).slice(0, SELECTOR_LABEL_MAX_CHARS).join('');
}

function isDragLikeEvent(event: unknown): event is DragLikeLearningEvent {
  const candidate = event as Partial<DragLikeLearningEvent> | null;
  return !!candidate
    && candidate.type === 'drag'
    && typeof candidate.selector === 'string'
    && typeof candidate.toSelector === 'string'
    && typeof candidate.path === 'string'
    && typeof candidate.at === 'number'
    && Number.isFinite(candidate.at);
}

function clickPreviewText(event: Extract<WorkflowLearningEvent, { type: 'click' }>): string {
  if (event.dragToSelector) {
    return `把「${selectorLabel(event.selector)}」拖到「${selectorLabel(event.dragToSelector)}」`;
  }

  const action = event.gesture === 'double'
    ? '双击'
    : event.gesture === 'right'
      ? '右键'
      : event.gesture === 'long-press'
        ? '长按'
        : event.key
          ? `按 ${event.key} 键`
          : '点击';
  const where = event.anchor
    ? `（落点 ${Math.round(event.anchor.rx * 100)}%, ${Math.round(event.anchor.ry * 100)}%）`
    : '';
  return `${action}「${selectorLabel(event.selector)}」${where}`;
}

function previewOf(event: WorkflowLearningEvent): WorkflowLearningPreview | null {
  // `drag` 目前是预留事件形态；真实点击拖拽也会先落入 click 事件的 dragToSelector。
  // 用结构判断保持向前兼容，等类型联合补上它时无需改动这里。
  const raw = event as unknown;
  const drag = isDragLikeEvent(raw) ? raw : undefined;
  if (drag) {
    return {
      kind: 'drag',
      text: `把「${selectorLabel(drag.selector)}」拖到「${selectorLabel(drag.toSelector)}」`,
      path: drag.path,
      at: drag.at,
    };
  }

  switch (event.type) {
    case 'navigation':
      return { kind: 'navigation', text: `进入页面 ${event.path}`, path: event.path, at: event.at };
    case 'click':
      return {
        kind: event.dragToSelector ? 'drag' : 'click',
        text: clickPreviewText(event),
        path: event.path,
        at: event.at,
      };
    case 'fill': {
      const what = selectorLabel(event.selector);
      const text = event.control === 'select'
        ? `在「${what}」选择第 ${(event.choice ?? 0) + 1} 项`
        : event.control === 'checkbox' || event.control === 'radio'
          ? `${event.checked ? '勾选' : '取消勾选'}「${what}」`
          : `在「${what}」填写内容`;
      return { kind: 'fill', text, path: event.path, at: event.at };
    }
    case 'drag': {
      return {
        kind: 'drag',
        text: `把「${selectorLabel(event.selector)}」拖到「${selectorLabel(event.toSelector)}」`,
        path: event.path,
        at: event.at,
      };
    }
    case 'scroll': {
      const percent = Math.round(event.ratio * 100);
      const text = event.container
        ? `滚动「${selectorLabel(event.container)}」到 ${percent}%`
        : `滚动页面到 ${percent}%`;
      return { kind: 'scroll', text, path: event.path, at: event.at };
    }
    default:
      return null;
  }
}

/**
 * 把安全学习事件流翻译成管理页可读的动作摘要。
 *
 * 顺序保持事件流顺序；超过 20 条时只保留最后 20 条，避免管理页被长会话撑爆。
 */
export function buildLearningPreview(events: readonly WorkflowLearningEvent[]): WorkflowLearningPreview[] {
  return events
    .map(previewOf)
    .filter((preview): preview is WorkflowLearningPreview => preview !== null)
    .slice(-PREVIEW_LIMIT);
}
