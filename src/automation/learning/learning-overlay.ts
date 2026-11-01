/**
 * 学习时的实时引导浮层（**不阻挡点击**）。
 *
 * 三条硬约束，缺一条都会变成事故：
 *  1. `pointer-events: none`：浮层绝不能吃掉页面上的点击 —— 这个项目最恨
 *     「点错元素 / 假成功」。宿主要素、内部容器与样式表三层都显式关掉，
 *     站点样式也盖不回来（`:host` 与 `*` 上的 `!important`）。
 *  2. **closed shadow DOM**：采集器读的是站点文档的 `body.innerText` 与
 *     `collectVisibleSnippets()`（`document.body.querySelectorAll('*')`）。
 *     浮层文本一旦被它们读到，就会被当成「界面出现了什么」编译进流程、
 *     甚至让「签到成功」这类证据词凭空出现在录制里。Shadow DOM 把浮层
 *     从文档树里隔离出去，两个采集口径都看不到它。
 *  3. 只有**主框架**渲染：子框架里挂浮层既看不见，又会多一份 DOM。
 *
 * 浮层文案只来自 `learning-stage.ts` 的固定字符串（不含任何页面内容、选择器、
 * 输入值），因此即便被站点读到也不构成隐私泄漏；被隔离只是为了不污染证据。
 */
import type { LearningKind, WorkflowLearningEvent } from '@/types';
import { isTopFrame } from '@/lib/core/frame-scope';
import { analyzeLearningEvents, guideViewOf, type LearningGuideView } from './learning-stage';

/** 浮层宿主元素上的标记，便于排查「页面上那行提示是谁加的」。 */
export const LEARNING_OVERLAY_ATTRIBUTE = 'data-checkin-learning-guide';

const OVERLAY_STYLE = `
:host {
  all: initial;
  position: fixed;
  z-index: 2147483647;
  left: 12px;
  bottom: 12px;
  display: block;
  max-width: min(360px, 70vw);
  pointer-events: none !important;
}
* { pointer-events: none !important; box-sizing: border-box; }
.card {
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  font-size: 12px;
  line-height: 1.5;
  color: #f8fafc;
  background: rgba(15, 23, 42, .92);
  border: 1px solid rgba(148, 163, 184, .45);
  border-radius: 10px;
  padding: 8px 10px;
  box-shadow: 0 6px 20px rgba(15, 23, 42, .35);
  user-select: none;
}
.title { font-weight: 600; }
.steps { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 5px; }
.step {
  border: 1px solid rgba(148, 163, 184, .35);
  border-radius: 999px;
  padding: 0 6px;
  color: #94a3b8;
  white-space: nowrap;
}
.step-done { color: #86efac; border-color: rgba(134, 239, 172, .45); }
.step-current { color: #0f172a; background: #fbbf24; border-color: #fbbf24; font-weight: 600; }
.step-number { opacity: .7; margin-right: 2px; }
.hint { margin-top: 2px; color: #cbd5e1; }
.warning { margin-top: 4px; color: #fde68a; }
`;

export interface LearningOverlayHandle {
  /** 宿主要素（挂在 document.body 上） */
  host: HTMLElement;
  /** 浮层根节点（shadow root 内的容器；closed 模式下外部拿不到，这里显式给出） */
  root: HTMLElement;
  /** 样式表节点（closed shadow root 内部，外部只能通过它检查实际生效的规则） */
  styleElement: HTMLStyleElement;
  /** 当前渲染出来的全部可见文字（测试与排查用） */
  text(): string;
  update(view: LearningGuideView): void;
  destroy(): void;
}

/** 把浮层挂到当前文档；重复挂载前请先 destroy 上一份。 */
export function mountLearningOverlay(doc: Document, view: LearningGuideView): LearningOverlayHandle {
  const host = doc.createElement('div');
  host.setAttribute(LEARNING_OVERLAY_ATTRIBUTE, view.title);
  host.style.setProperty('position', 'fixed');
  host.style.setProperty('z-index', '2147483647');
  host.style.setProperty('pointer-events', 'none');
  // closed：站点脚本拿不到我们的 shadow root，也就删不掉/改不掉浮层里的文字。
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = OVERLAY_STYLE;
  const root = doc.createElement('div');
  root.className = 'card';
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  root.style.setProperty('pointer-events', 'none');
  const title = doc.createElement('div');
  title.className = 'title';
  const steps = doc.createElement('div');
  steps.className = 'steps';
  const hint = doc.createElement('div');
  hint.className = 'hint';
  const warning = doc.createElement('div');
  warning.className = 'warning';
  root.append(steps, title, hint, warning);
  shadow.append(style, root);
  (doc.body ?? doc.documentElement)?.append(host);

  function render(next: LearningGuideView): void {
    title.textContent = next.title;
    hint.textContent = next.hint;
    warning.textContent = next.warning ?? '';
    steps.replaceChildren(...next.steps.map((step, index) => {
      const chip = doc.createElement('span');
      chip.className = `step step-${step.state}`;
      const number = doc.createElement('span');
      number.className = 'step-number';
      number.textContent = `${index + 1}`;
      const label = doc.createElement('span');
      label.textContent = step.label;
      chip.append(number, label);
      return chip;
    }));
    host.setAttribute(LEARNING_OVERLAY_ATTRIBUTE, next.title);
  }
  render(view);

  return {
    host,
    root,
    styleElement: style,
    text: () => [
      ...Array.from(steps.children).map((chip) => chip.textContent ?? ''),
      title.textContent ?? '',
      hint.textContent ?? '',
      warning.textContent ?? '',
    ].filter((line) => line.trim().length > 0).join(' '),
    update: render,
    destroy: () => host.remove(),
  };
}

export interface LearningGuideOptions {
  doc?: Document;
  /** 是否允许在当前框架渲染（测试可注入）；缺省用 `isTopFrame()` */
  canRender?: () => boolean;
}

export interface LearningGuide {
  /** 学习开始（或页面刚加载并领到会话）时调用；重复调用同一会话只更新，不重复挂载 */
  begin(session: Pick<{ kind?: LearningKind; events: readonly WorkflowLearningEvent[] }, 'kind' | 'events'>): void;
  /** 每上报一个事件调用一次（包含当前页面的一次性事件） */
  push(event: WorkflowLearningEvent): void;
  /** 学习结束（或取消）时调用：移除浮层，不残留任何 DOM */
  end(): void;
}

/**
 * 浮层的生命周期控制器：事件进、文案出。
 *
 * 只依赖「会话里已有的全部事件」（`GET_TASK` 的 `feature.learningSession.events`
 * 跨页带回本页之前的历史）+ 本页新产生的事件，因此不需要新的消息类型，
 * 也不需要后台持续推送。
 */
export function createLearningGuide(options: LearningGuideOptions = {}): LearningGuide {
  const doc = options.doc ?? document;
  const canRender = options.canRender ?? isTopFrame;
  let kind: LearningKind = 'checkin';
  let events: WorkflowLearningEvent[] = [];
  let overlay: LearningOverlayHandle | null = null;

  function view(): LearningGuideView {
    return guideViewOf(analyzeLearningEvents(events, kind));
  }

  function ensureOverlay(): LearningOverlayHandle | null {
    if (!canRender()) return null;
    overlay ??= mountLearningOverlay(doc, view());
    return overlay;
  }

  return {
    begin(session) {
      kind = session.kind ?? 'checkin';
      events = [...session.events];
      const mounted = ensureOverlay();
      mounted?.update(view());
    },
    push(event) {
      events.push(event);
      ensureOverlay()?.update(view());
    },
    end() {
      overlay?.destroy();
      overlay = null;
      events = [];
    },
  };
}
