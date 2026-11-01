/**
 * 手势保真：拖拽必须被录成「一步」，而不是整条丢弃。
 *
 * 用户反馈「学习太死板，没有学到真实的每一步」。上一轮只读分析确认两个真实缺陷：
 *  1. 采集侧识别出拖拽尾巴后**直接 return**，拖拽整条消失，用户还以为学到了；
 *  2. 回放侧默认走可信指针通道，但那条通道只承载普通单击 —— 双击/右键/长按
 *     静默退化成单击，学到 ≠ 回放对。
 *
 * 本文件锁定修复后的行为：
 *  - 真实拖拽（可交互端点）→ 一条 drag 事件，带起终点相对落点；
 *  - 滑块把手/验证控件上的拖拽 → **明确记入「没学到」清单**，不产生步骤；
 *  - 端点不可稳定回放（拖到空白处）→ 同样明确记录，绝不写垃圾步骤；
 *  - click 事件上的 dragToSelector 旧形态仍然按 drag 编译（历史产物兼容）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckinWorkflowStep, SiteConfig, WorkflowLearningEvent } from '@/types';
import {
  LearningCapture,
  buildLearnedWorkflow,
} from '@/automation/learning/learning';

const site: SiteConfig = {
  id: 'site-drag',
  name: '拖拽站',
  loginUrl: 'https://example.com/login',
  selectors: { username: '#user', password: '#pass', submit: '#submit' },
  closeModalSelectors: [],
};

function flattenSteps(steps: CheckinWorkflowStep[]): CheckinWorkflowStep[] {
  return steps.flatMap((step) => (
    step.type === 'if' && step.condition.type === 'path' ? flattenSteps(step.then) : [step]
  ));
}

describe('学习采集真实拖拽', () => {
  function stubLayout(): void {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 200, height: 40, top: 100, left: 50, right: 250, bottom: 140, x: 50, y: 100,
      toJSON: () => ({}),
    } as DOMRect);
    Object.defineProperty(HTMLElement.prototype, 'innerText', {
      configurable: true,
      get(this: HTMLElement) { return this.textContent ?? ''; },
    });
  }

  beforeEach(() => {
    stubLayout();
    document.body.innerHTML = '';
    window.history.replaceState({}, '', '/sort');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  function startCapture() {
    const events: WorkflowLearningEvent[] = [];
    const capture = new LearningCapture({ settleMs: 0, scrollStopMs: 0, onEvent: (event) => events.push(event) });
    return { events, capture };
  }

  /** 真实浏览器序列：pointer/mouse 双族 + 松手后补发的 click。 */
  function dragBetween(from: Element, to: Element, fromPoint = { x: 80, y: 120 }, toPoint = { x: 300, y: 220 }): void {
    const init = { bubbles: true, composed: true };
    from.dispatchEvent(new PointerEvent('pointerdown', { ...init, clientX: fromPoint.x, clientY: fromPoint.y }));
    from.dispatchEvent(new MouseEvent('mousedown', { ...init, clientX: fromPoint.x, clientY: fromPoint.y }));
    document.dispatchEvent(new PointerEvent('pointermove', { ...init, clientX: toPoint.x, clientY: toPoint.y }));
    document.dispatchEvent(new MouseEvent('mousemove', { ...init, clientX: toPoint.x, clientY: toPoint.y }));
    to.dispatchEvent(new PointerEvent('pointerup', { ...init, clientX: toPoint.x, clientY: toPoint.y }));
    to.dispatchEvent(new MouseEvent('mouseup', { ...init, clientX: toPoint.x, clientY: toPoint.y }));
    // 浏览器向两者的公共祖先（这里用 body）补发一次 click —— 这就是过去被整条丢弃的那一下。
    document.body.dispatchEvent(new MouseEvent('click', { ...init, clientX: toPoint.x, clientY: toPoint.y }));
  }

  it('拖拽可交互端点 → 录成一步 drag，带起终点选择器与相对落点', () => {
    document.body.innerHTML = [
      '<ul id="list">',
      '  <li id="item-a" draggable="true" tabindex="0">A</li>',
      '  <li id="item-b" draggable="true" tabindex="0">B</li>',
      '</ul>',
    ].join('');
    const { events, capture } = startCapture();
    capture.attach();
    dragBetween(document.getElementById('item-a')!, document.getElementById('item-b')!);
    capture.flushPending();
    capture.detach();

    const drag = events.find((event) => event.type === 'drag') as Record<string, unknown> | undefined;
    expect(drag).toBeDefined();
    expect(drag!.selector).toBe('#item-a');
    expect(drag!.toSelector).toBe('#item-b');
    // 隐私红线：只落相对比例，绝不落原始坐标
    expect(JSON.stringify(events)).not.toMatch(/clientX|clientY|screenX|screenY/);
  });

  it('拖拽把手（role=slider / 命名含 knob）不算业务步骤，但会明确告知「没学到」', () => {
    document.body.innerHTML = '<div id="pull-knob" role="slider" tabindex="0">→</div>';
    const { events, capture } = startCapture();
    capture.attach();
    dragBetween(document.getElementById('pull-knob')!, document.getElementById('pull-knob')!);
    capture.flushPending();
    capture.detach();

    expect(events.filter((event) => event.type === 'drag')).toHaveLength(0);
    expect(capture.unlearnedNotes.length).toBeGreaterThan(0);
    // 报告文案是固定字符串：不携带页面内容/坐标。
    expect(capture.unlearnedNotes.join(' ')).not.toMatch(/clientX|clientY|#pull-knob/);
  });

  it('拖到不可回放的空白处 → 不写垃圾步骤，明确记录未学到', () => {
    document.body.innerHTML = '<button id="claim">立即签到</button><div id="void" style="position:fixed;left:0;top:0;width:100%;height:100%"></div>';
    const { events, capture } = startCapture();
    capture.attach();
    dragBetween(document.getElementById('claim')!, document.getElementById('void')!);
    capture.flushPending();
    capture.detach();

    expect(events.filter((event) => event.type === 'drag')).toHaveLength(0);
    expect(capture.unlearnedNotes.join(' ')).toContain('未写进流程');
  });

  it('站点在 pointerdown 上 preventDefault（浏览器不补发 click）时仍录到拖拽', () => {
    document.body.innerHTML = [
      '<ul id="list">',
      '  <li class="card" id="item-a" role="button" tabindex="0">A</li>',
      '  <li class="card" id="item-b" role="button" tabindex="0">B</li>',
      '</ul>',
    ].join('');
    const { events, capture } = startCapture();
    capture.attach();
    const a = document.getElementById('item-a')!;
    const b = document.getElementById('item-b')!;
    const init = { bubbles: true, composed: true };
    // 排序库/自定义滑轨的标准写法：按下即 preventDefault，浏览器不会补发 click。
    a.addEventListener('pointerdown', (event) => event.preventDefault());
    a.dispatchEvent(new PointerEvent('pointerdown', { ...init, cancelable: true, clientX: 80, clientY: 120 }));
    document.dispatchEvent(new PointerEvent('pointermove', { ...init, clientX: 300, clientY: 120 }));
    b.dispatchEvent(new PointerEvent('pointerup', { ...init, clientX: 300, clientY: 120 }));
    capture.flushPending();
    capture.detach();

    const drag = events.find((event) => event.type === 'drag') as Record<string, unknown> | undefined;
    expect(drag).toBeDefined();
    expect(drag!.selector).toBe('#item-a');
    expect(drag!.toSelector).toBe('#item-b');
    // 且只记一条（pointerup 当场结算 + 无 click 也不该重复）
    expect(events.filter((event) => event.type === 'drag')).toHaveLength(1);
  });

  it('位移不足的按-松仍是普通点击，不会被误记成拖拽', () => {
    document.body.innerHTML = '<button id="claim">立即签到</button>';
    const { events, capture } = startCapture();
    capture.attach();
    const button = document.getElementById('claim')!;
    const init = { bubbles: true, composed: true };
    button.dispatchEvent(new MouseEvent('mousedown', { ...init, clientX: 100, clientY: 120 }));
    button.dispatchEvent(new MouseEvent('mouseup', { ...init, clientX: 104, clientY: 122 }));
    button.dispatchEvent(new MouseEvent('click', { ...init, clientX: 104, clientY: 122 }));
    capture.flushPending();
    capture.detach();

    expect(events.filter((event) => event.type === 'drag')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'click')).toHaveLength(1);
  });
});

describe('拖拽编译成可回放的步骤', () => {
  const siteWithClaim: SiteConfig = { ...site, checkin: { method: 'workflow', claimText: '签' } };

  it('drag 事件编译成 drag 步骤（不是退回点击起点）', () => {
    const events: WorkflowLearningEvent[] = [
      { type: 'navigation', path: '/sort', at: 1 },
      {
        type: 'drag',
        selector: '#item-a',
        toSelector: '#item-b',
        label: 'A',
        path: '/sort',
        anchor: { rx: 0.5, ry: 0.5 },
        toAnchor: { rx: 0.2, ry: 0.8 },
        at: 2,
      },
      {
        type: 'click',
        selector: '#claim',
        label: '立即签到',
        path: '/sort',
        evidence: { kind: 'success', words: ['签到成功'] },
        at: 3,
      },
    ];
    const learned = buildLearnedWorkflow(siteWithClaim, events);
    expect(learned).not.toBeNull();
    const drag = flattenSteps(learned!.workflow.steps).find((step) => step.type === 'drag');
    expect(drag).toMatchObject({
      type: 'drag',
      selector: '#item-a',
      toSelector: '#item-b',
      anchor: { rx: 0.5, ry: 0.5 },
      toAnchor: { rx: 0.2, ry: 0.8 },
    });
  });

  it('旧产物里的 click+dragToSelector 仍按 drag 编译（历史兼容）', () => {
    const events: WorkflowLearningEvent[] = [
      { type: 'navigation', path: '/sort', at: 1 },
      {
        type: 'click',
        selector: '#item-a',
        label: 'A',
        path: '/sort',
        dragToSelector: '#item-b',
        dragToAnchor: { rx: 0.3, ry: 0.4 },
        at: 2,
      },
      {
        type: 'click',
        selector: '#claim',
        label: '立即签到',
        path: '/sort',
        evidence: { kind: 'success', words: ['签到成功'] },
        at: 3,
      },
    ];
    const learned = buildLearnedWorkflow(siteWithClaim, events);
    const drag = flattenSteps(learned!.workflow.steps).find((step) => step.type === 'drag');
    expect(drag).toMatchObject({ type: 'drag', selector: '#item-a', toSelector: '#item-b' });
  });
});
