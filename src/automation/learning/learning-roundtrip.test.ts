import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SiteConfig, WorkflowLearningEvent } from '@/types';
import { createLearningWriteQueue } from '@/background/learning/learning-queue';
import { createLearningRecorder } from './learning-recorder';
import { LearningCapture, buildLearnedWorkflow, sanitizeLearningEvent, verifyLearnedWorkflowStored } from './learning';
import { validateCheckinWorkflow } from '@/lib/workflow/workflow-validation';

const site: SiteConfig = {
  id: 'fixture', name: 'fixture', loginUrl: `${location.origin}/login`,
  selectors: { username: '', password: '', submit: '' }, closeModalSelectors: [],
};

beforeEach(() => {
  document.body.innerHTML = '';
  history.replaceState({}, '', '/dashboard/overview');
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 100, height: 30 } as DOMRect);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); document.body.innerHTML = ''; });

describe('学习事件不丢失', () => {
  it('并发导航/点击/补报的存储读改写全部串行保留，失败不阻塞后续写入', async () => {
    const queue = createLearningWriteQueue();
    let stored: number[] = [];
    const append = (value: number) => queue.run(async () => {
      const snapshot = [...stored];
      await Promise.resolve();
      stored = [...snapshot, value];
    });
    await Promise.all(Array.from({ length: 25 }, (_, index) => append(index)));
    expect(stored).toEqual(Array.from({ length: 25 }, (_, index) => index));
    await expect(queue.run(async () => { throw new Error('fixture failure'); })).rejects.toThrow();
    await append(25);
    expect(stored).toHaveLength(26);
  });

  it('结束学习 flush 等待末尾证据真正写入，不只等待点击已发送', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button id="claim">立即签到</button>';
    const persisted: WorkflowLearningEvent[] = [];
    const recorder = createLearningRecorder('checkin', async (event) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      persisted.push(event);
      return { ok: true };
    });
    recorder.start();
    document.querySelector<HTMLElement>('#claim')!.click();
    document.body.append(document.createTextNode('签到成功'));
    let flushed = false;
    const done = recorder.flush().then(() => { flushed = true; });
    expect(flushed).toBe(false);
    await vi.advanceTimersByTimeAsync(30);
    await done;
    recorder.stop();
    expect(persisted.some((event) => event.type === 'click' && event.evidence?.kind === 'success')).toBe(true);
  });

  it('写入失败时不能宣称已学会', async () => {
    const recorder = createLearningRecorder('checkin', async () => ({ ok: false, error: '存储失败' }));
    recorder.start();
    await expect(recorder.flush()).rejects.toThrow('存储失败');
    recorder.stop();
  });

  it('主世界或预先绑定的 history 不经过包装时，也记录 SPA 中间页', async () => {
    vi.useFakeTimers();
    const unwrappedPush = history.pushState.bind(history);
    const events: WorkflowLearningEvent[] = [];
    const capture = new LearningCapture({ onEvent: (event) => events.push(event) });
    capture.attach();
    unwrappedPush({}, '', '/profile');
    await vi.advanceTimersByTimeAsync(210);
    unwrappedPush({}, '', '/checkin');
    // 后一个跳转还没轮询到，点击前也必须同步补记。
    document.body.innerHTML = '<button id="claim">立即签到</button>';
    document.querySelector<HTMLElement>('#claim')!.click();
    capture.detach();
    expect(events.filter((event) => event.type === 'navigation').map((event) => event.path))
      .toEqual(['/dashboard/overview', '/profile', '/checkin']);
    expect(buildLearnedWorkflow(site, events)?.workflow.route).toEqual(['/dashboard/overview', '/profile', '/checkin']);
  });
});

describe('滚动面板与保存读回', () => {
  it('采集 → 净化 → 编译保留目标的滚动容器，不把窗口像素写进回放配置', () => {
    document.body.innerHTML = '<aside id="sidebar" style="overflow-y:auto"></aside><main id="panel" style="overflow-y:auto"><button id="claim">立即签到</button></main>';
    document.querySelector<HTMLElement>('#sidebar')!.scrollTop = 200;
    const panel = document.querySelector<HTMLElement>('#panel')!;
    panel.scrollTop = 1200;
    const events: WorkflowLearningEvent[] = [];
    const capture = new LearningCapture({ onEvent: (event) => {
      const safe = sanitizeLearningEvent(event);
      if (safe) events.push(safe);
    } });
    capture.attach();
    document.querySelector<HTMLElement>('#claim')!.click();
    capture.detach();
    expect(events.find((event) => event.type === 'click')).toMatchObject({ scrollPageTop: true, scrollContainer: '#panel' });
    const workflow = buildLearnedWorkflow(site, events)!.workflow;
    expect(workflow.steps[0]).toEqual({ type: 'click', selector: '#claim', scrollIntoView: true, scrollContainer: '#panel', fingerprint: { tag: 'button', text: '立即签到' } });
    expect(validateCheckinWorkflow(site, workflow)).toEqual([]);
    // Chrome storage 会重排对象键；这不算内容丢失。
    const reordered = JSON.parse(JSON.stringify(workflow, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).reverse()) : value));
    expect(verifyLearnedWorkflowStored(workflow, { method: 'workflow', workflow: reordered }).ok).toBe(true);
    expect(JSON.stringify(workflow)).not.toContain('1200');
    const modified = structuredClone(workflow);
    Reflect.deleteProperty(modified.steps[0]!, 'scrollContainer');
    expect(verifyLearnedWorkflowStored(workflow, { method: 'workflow', workflow: modified }).ok).toBe(false);
  });

  it('不能把另一区域的滚动附到没有滚动的目标上', () => {
    document.body.innerHTML = '<aside style="overflow-y:auto"></aside><button id="claim">立即签到</button>';
    document.querySelector('aside')!.scrollTop = 400;
    const events: WorkflowLearningEvent[] = [];
    const capture = new LearningCapture({ onEvent: (event) => events.push(event) });
    capture.attach();
    document.querySelector<HTMLElement>('#claim')!.click();
    capture.detach();
    expect(events.find((event) => event.type === 'click')).not.toHaveProperty('scrollContainer');
    expect(events.find((event) => event.type === 'click')).not.toHaveProperty('scrollPageTop');
  });
});
