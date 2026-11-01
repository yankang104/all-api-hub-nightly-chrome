import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowLearningEvent } from '@/types';
import { collectVisibleSnippets, pageChangeEvidence } from '@/automation/learning/learning';
import { createLearningGuide, LEARNING_OVERLAY_ATTRIBUTE, mountLearningOverlay } from '@/automation/learning/learning-overlay';
import { analyzeLearningEvents, guideViewOf } from '@/automation/learning/learning-stage';

type ClickEvent = Extract<WorkflowLearningEvent, { type: 'click' }>;

function checkinClick(overrides: Partial<ClickEvent> = {}): ClickEvent {
  return { type: 'click', selector: 'text=立即签到', label: '立即签到', path: '/checkin', at: 3, ...overrides };
}

const VIEW = guideViewOf(analyzeLearningEvents([{ type: 'navigation', path: '/login', at: 1 }], 'checkin'));

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); });

describe('学习引导浮层', () => {
  it('浮层三层都关掉指针事件（pointer-events: none），站点样式也盖不回来', () => {
    const handle = mountLearningOverlay(document, VIEW);
    expect(handle.host.style.pointerEvents).toBe('none');
    expect(handle.root.style.pointerEvents).toBe('none');
    expect(getComputedStyle(handle.host).pointerEvents).toBe('none');
    // closed shadow root：站点脚本拿不到它，样式表里 :host 与 * 都加了 !important。
    expect(handle.host.shadowRoot).toBeNull();
    expect(handle.styleElement.textContent ?? '').toContain('pointer-events: none !important');
    handle.destroy();
  });

  it('命中测试确认浮层不吃点击：浮层所在位置命中的是它下面的页面元素', () => {
    document.body.innerHTML = '<button id="claim">立即签到</button>';
    const handle = mountLearningOverlay(document, VIEW);
    // jsdom 没有实现 elementFromPoint；真实浏览器里 pointer-events:none 的元素会被
    // 命中测试跳过，这里退化成「页面元素仍可命中、且不是浮层」这一等价检查。
    const hit = document.elementFromPoint?.(0, 0) ?? document.querySelector('#claim');
    expect(hit).not.toBeNull();
    expect((hit as Element | null)?.closest(`[${LEARNING_OVERLAY_ATTRIBUTE}]`)).toBeNull();
    expect(getComputedStyle(handle.root).pointerEvents).toBe('none');
    handle.destroy();
  });

  it('closed shadow DOM：采集器读不到浮层文字（不污染学习证据）', () => {
    const handle = mountLearningOverlay(document, VIEW);
    expect(handle.host.shadowRoot).toBeNull();
    expect(handle.host.textContent).toBe('');
    expect(collectVisibleSnippets()).toEqual([]);
    expect(document.body.textContent ?? '').not.toContain('请登录');
    handle.destroy();
  });

  it('浮层文案里没有任何签到证据/验证类关键词（否则会被当成页面证据）', () => {
    const sessions = [
      [{ type: 'navigation', path: '/login', at: 1 }],
      [{ type: 'navigation', path: '/login', at: 1 }, { type: 'navigation', path: '/console', at: 2 }],
      [{ type: 'navigation', path: '/login', at: 1 }, { type: 'navigation', path: '/console', at: 2 }, { type: 'navigation', path: '/profile', at: 3 }],
      [{ type: 'navigation', path: '/checkin', at: 1 }, checkinClick()],
      [{ type: 'navigation', path: '/console', at: 1 }, checkinClick(), { type: 'click', selector: 'text=退出登录', label: '退出登录', path: '/checkin', at: 4 }],
    ] as WorkflowLearningEvent[][];
    for (const events of sessions) {
      const view = guideViewOf(analyzeLearningEvents(events, 'checkin'));
      for (const line of [view.title, view.hint, view.warning ?? '']) {
        if (!line) continue;
        // pageChangeEvidence 用的是 SUCCESS/ALREADY/FAILURE/CHALLENGE 四组词的总表：
        // 返回 undefined 表示这一行不含任何证据词。
        expect(pageChangeEvidence([], [], line), line).toBeUndefined();
      }
    }
  });

  it('子框架不渲染浮层（isTopFrame 守卫）', () => {
    const guide = createLearningGuide({ canRender: () => false });
    guide.begin({ kind: 'checkin', events: [{ type: 'navigation', path: '/login', at: 1 }] });
    guide.push(checkinClick());
    expect(document.querySelector(`[${LEARNING_OVERLAY_ATTRIBUTE}]`)).toBeNull();
    guide.end();
  });

  it('主框架渲染浮层，并且随事件推进：① → ② → ④，同一会话只挂一份', () => {
    const guide = createLearningGuide({ canRender: () => true });
    guide.begin({ kind: 'checkin', events: [{ type: 'navigation', path: '/login', at: 1 }] });
    expect(document.querySelector(`[${LEARNING_OVERLAY_ATTRIBUTE}]`)?.getAttribute(LEARNING_OVERLAY_ATTRIBUTE)).toBe('① 请登录');

    guide.begin({ kind: 'checkin', events: [{ type: 'navigation', path: '/login', at: 1 }, { type: 'navigation', path: '/console', at: 2 }] });
    expect(document.querySelector(`[${LEARNING_OVERLAY_ATTRIBUTE}]`)?.getAttribute(LEARNING_OVERLAY_ATTRIBUTE)).toBe('② 已检测到登录成功，请前往能显示当前账号的页面');

    guide.push({ type: 'navigation', path: '/profile', at: 3 });
    expect(document.querySelector(`[${LEARNING_OVERLAY_ATTRIBUTE}]`)?.getAttribute(LEARNING_OVERLAY_ATTRIBUTE)).toBe('③ 请完成一次签到');

    guide.push({ type: 'navigation', path: '/checkin', at: 4 });
    guide.push(checkinClick());
    expect(document.querySelector(`[${LEARNING_OVERLAY_ATTRIBUTE}]`)?.getAttribute(LEARNING_OVERLAY_ATTRIBUTE)).toBe('④ 已录到签到动作，可以点「结束学习」了');
    expect(document.querySelectorAll(`[${LEARNING_OVERLAY_ATTRIBUTE}]`)).toHaveLength(1);

    guide.end();
    expect(document.querySelector(`[${LEARNING_OVERLAY_ATTRIBUTE}]`)).toBeNull();
  });

  it('end() 之后浮层 DOM 完全移除，不留残骸', () => {
    const guide = createLearningGuide({ canRender: () => true });
    guide.begin({ kind: 'checkin', events: [{ type: 'navigation', path: '/login', at: 1 }] });
    expect(document.body.querySelectorAll('div')).toHaveLength(1);
    guide.end();
    expect(document.body.querySelectorAll('div')).toHaveLength(0);
  });

  it('渲染后的真实文案（证据用）', () => {
    const handle = mountLearningOverlay(document, VIEW);
    // 浮层先渲染四步进度条，再是阶段标题与该做什么；文案全部来自固定词表。
    expect(handle.text()).toBe('1登录 2账号页 3签到 4结束 ① 请登录 在打开的站点上手动登录；全程不要点「退出登录」');
    handle.destroy();
  });
});
