import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/automation/shared/dom-utils', async () => {
  const actual = await vi.importActual<typeof import('@/automation/shared/dom-utils')>('@/automation/shared/dom-utils');
  return {
    ...actual,
    sleep: vi.fn().mockResolvedValue(undefined),
    waitFor: vi.fn(async (selector: string) => actual.queryFirst(selector)),
    realClick: vi.fn(async (element: HTMLElement) => { element.click(); return 'dom'; }),
  };
});

vi.mock('@/automation/balance/balance', async () => {
  const actual = await vi.importActual<typeof import('@/automation/balance/balance')>('@/automation/balance/balance');
  return { ...actual, captureBalance: vi.fn().mockResolvedValue(null) };
});

vi.mock('@/automation/shared/click-safety', () => ({
  clearClickBlocker: vi.fn().mockResolvedValue(null),
}));

import { performCheckin } from '@/automation/checkin/checkin';
import { realClick } from '@/automation/shared/dom-utils';
import type { CheckinWorkflowConfig, SiteConfig } from '@/types';

const log = { push: vi.fn() };
const site = (workflow: CheckinWorkflowConfig): SiteConfig => ({
  id: 'learned', name: '学习测试站', loginUrl: `${location.origin}/login`,
  selectors: { username: '#user', password: '#pass', submit: '#submit' },
  closeModalSelectors: [],
  checkin: { method: 'workflow', workflow },
});

beforeEach(() => {
  vi.clearAllMocks();
  history.replaceState({}, '', '/daily');
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 100, height: 30, top: 0, left: 0, right: 100, bottom: 30,
  } as DOMRect);
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true,
    get(this: HTMLElement) { return this.textContent ?? ''; },
  });
  document.body.innerHTML = '<button id="generic">立即签到</button><button id="learned">领取今日福利</button>';
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  history.replaceState({}, '', '/');
});

describe('只有显式学习回放才执行学到的签到流程', () => {
  it.each([
    { steps: [] },
    { route: ['/missing-profile'], steps: [{ type: 'click' as const, selector: '#removed' }] },
  ])('自动识别不执行旧记录（含缺身份页/空流程）：点击当前页的自主签到控件', async (workflow) => {
    const generic = document.querySelector<HTMLElement>('#generic')!;
    generic.addEventListener('click', () => {
      document.body.insertAdjacentHTML('beforeend', '<div>签到成功</div>');
    });
    const result = await performCheckin({ ...site(workflow), checkin: { method: 'auto', workflow } }, log);
    expect(result.status).toBe('success');
    expect(realClick).toHaveBeenCalledOnce();
    expect(vi.mocked(realClick).mock.calls[0]?.[0]).toBe(generic);
    expect(log.push).toHaveBeenCalledWith(expect.stringContaining('不回放旧学习记录'));
  });

  it.each([false, true])('自主签到主按钮叫领取奖励时只点一次（重绘=%s）', async (rerender) => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => { now += 200; return now; });
    document.body.innerHTML = '<button id="claim">领取奖励</button>';
    const primary = document.querySelector<HTMLElement>('#claim')!;
    primary.addEventListener('click', () => {
      if (rerender) primary.outerHTML = '<button id="claim">领取奖励</button>';
      document.body.insertAdjacentHTML('beforeend', '<p>签到成功</p>');
    });
    const result = await performCheckin({ ...site({ steps: [] }), checkin: { method: 'auto' } }, log);
    expect(result.status).toBe('success');
    expect(realClick).toHaveBeenCalledOnce();
    expect(log.push).not.toHaveBeenCalledWith(expect.stringContaining('已点击二次确认按钮'));
  });

  it('主按钮和新弹窗都叫领取奖励时，仍能完成真正的二次确认', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => { now += 200; return now; });
    document.body.innerHTML = '<button id="claim">领取奖励</button>';
    document.querySelector<HTMLElement>('#claim')!.addEventListener('click', () => {
      document.body.insertAdjacentHTML('beforeend', '<div role="dialog"><button id="confirm">领取奖励</button></div>');
      document.querySelector<HTMLElement>('#confirm')!.addEventListener('click', () => {
        document.querySelector('[role="dialog"]')!.remove();
        document.body.insertAdjacentHTML('beforeend', '<p>领取成功</p>');
      });
    });
    const result = await performCheckin({ ...site({ steps: [] }), checkin: { method: 'auto' } }, log);
    expect(result.status).toBe('success');
    expect(vi.mocked(realClick).mock.calls.map(([element]) => element.id)).toEqual(['claim', 'confirm']);
  });

  it('点击学习指定的控件并沿用前后验证钩子，不抢点通用签到按钮', async () => {
    const beforeCheckinClick = vi.fn().mockResolvedValue(true);
    const afterCheckinClick = vi.fn().mockResolvedValue(true);
    const learnedButton = document.querySelector<HTMLElement>('#learned')!;
    learnedButton.addEventListener('click', () => {
      document.body.insertAdjacentHTML('beforeend', '<div id="done">签到成功</div>');
    });

    const result = await performCheckin(site({ steps: [
      { type: 'click', selector: '#learned' },
      { type: 'assert', selector: '#done', result: 'success' },
    ] }), log, { beforeCheckinClick, afterCheckinClick });

    expect(result.status).toBe('success');
    expect(realClick).toHaveBeenCalledOnce();
    expect(vi.mocked(realClick).mock.calls[0]?.[0]).toBe(learnedButton);
    expect(beforeCheckinClick).toHaveBeenCalled();
    expect(afterCheckinClick).toHaveBeenCalledOnce();
  });

  it('学习流程验证未通过时停止点击，也不改用通用按钮', async () => {
    const result = await performCheckin(site({ steps: [{ type: 'click', selector: '#learned' }] }), log, {
      beforeCheckinClick: vi.fn().mockResolvedValue(false),
    });
    expect(result.status).toBe('failed');
    expect(realClick).not.toHaveBeenCalled();
  });

  it('学习控件失效时明确失败，不扫描另一个签到按钮重试', async () => {
    const result = await performCheckin(site({ steps: [{ type: 'click', selector: '#removed' }] }), log);
    expect(result.status).toBe('failed');
    expect(realClick).not.toHaveBeenCalled();
  });

  it('空流程仍交回放器报错，不回退扫描', async () => {
    const result = await performCheckin(site({ steps: [] }), log);
    expect(result).toMatchObject({ status: 'failed', message: '工作流没有配置任何步骤' });
    expect(realClick).not.toHaveBeenCalled();
  });
});
