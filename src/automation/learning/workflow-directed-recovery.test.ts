import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/automation/shared/dom-utils', async () => {
  const actual = await vi.importActual<typeof import('@/automation/shared/dom-utils')>('@/automation/shared/dom-utils');
  return {
    ...actual,
    sleep: vi.fn().mockResolvedValue(undefined),
    waitFor: vi.fn(async (selector: string) => actual.queryFirst(selector)),
    realClick: vi.fn().mockResolvedValue('dom'),
  };
});
vi.mock('@/automation/shared/click-safety', () => ({ clearClickBlocker: vi.fn().mockResolvedValue(null) }));

import { realClick, waitFor } from '@/automation/shared/dom-utils';
import { runCheckinWorkflow, snapshotCheckinControls } from './workflow';
import type { CheckinWorkflowStep, SiteConfig } from '@/types';

const site: SiteConfig = {
  id: 'directed', name: '定向定位', loginUrl: `${location.origin}/login`,
  selectors: { username: '#user', password: '#password', submit: '#submit' }, closeModalSelectors: [],
};
const claim: Extract<CheckinWorkflowStep, { type: 'click' }> = {
  type: 'click', selector: 'text=立即签到', timeoutMs: 0, scrollIntoView: true,
  fingerprint: { tag: 'button', text: '立即签到' },
};
const log = { push: vi.fn() };

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    return { x: 0, y: 0, left: 0, top: 0, right: 120, bottom: 30, width: 120, height: 30, toJSON: () => ({}) } as DOMRect;
  };
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true, get(this: HTMLElement) { return this.textContent ?? ''; },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});
beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
  history.replaceState({}, '', '/profile');
  vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ''; });

function scrollPanel(panel: HTMLElement, mount?: () => void): { moves: number[] } {
  panel.style.overflowY = 'auto';
  Object.defineProperties(panel, {
    clientHeight: { configurable: true, value: 200 },
    clientWidth: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, value: 1200 },
  });
  let y = 0;
  const moves: number[] = [];
  Object.defineProperty(panel, 'scrollTop', {
    configurable: true, get: () => y,
    set: (value: number) => { y = Math.min(1000, Math.max(0, value)); moves.push(y); if (y > 0) mount?.(); },
  });
  return { moves };
}

describe('学习回放：先看当前控件，再决定滚哪里', () => {
  it('21%/43% 录制滚动与选择器同时漂移：快照找到新文案，直接滚到目标并点击一次', async () => {
    document.body.innerHTML = '<div id="old-panel"></div><section><button id="current">领取今日额度</button></section>';
    const oldPanel = scrollPanel(document.querySelector<HTMLElement>('#old-panel')!);
    const target = document.querySelector<HTMLElement>('#current')!;
    const intoView = vi.spyOn(target, 'scrollIntoView');
    const result = await runCheckinWorkflow(site, { steps: [
      { type: 'scroll', container: '#old-panel', ratio: 0.21 },
      { type: 'scroll', container: '#old-panel', ratio: 0.43 },
      claim,
    ] }, log);
    expect(result.status).not.toBe('failed');
    expect(realClick).toHaveBeenCalledExactlyOnceWith(target, { mayNavigate: false });
    expect(intoView).toHaveBeenCalledExactlyOnceWith({ block: 'center', inline: 'center' });
    expect(oldPanel.moves).toEqual([]);
    expect(window.scrollBy).not.toHaveBeenCalled();
    expect(log.push).toHaveBeenCalledWith(expect.stringContaining('页面控件快照命中签到动作'));
  });

  it.each(['missing', 'not-scrollable', 'wrong-scrollable'] as const)(
    '录制容器 %s：找到当前实际滚动面板，懒挂载后用新文案快照停止查找', async (kind) => {
      document.body.innerHTML = '<div id="old-panel"></div><main id="current-panel"></main>';
      const old = document.querySelector<HTMLElement>('#old-panel')!;
      const wrong = kind === 'wrong-scrollable' ? scrollPanel(old) : undefined;
      const current = document.querySelector<HTMLElement>('#current-panel')!;
      const actual = scrollPanel(current, () => {
        if (!current.querySelector('button')) current.innerHTML = '<button>领取今日额度</button>';
      });
      const selector = kind === 'missing' ? '#gone-panel' : '#old-panel';
      const result = await runCheckinWorkflow(site, { steps: [
        { type: 'scroll', container: selector, ratio: 0.21 },
        { type: 'scroll', container: selector, ratio: 0.43 },
        { ...claim, timeoutMs: 1000 },
      ] }, log);
      expect(result.status).not.toBe('failed');
      expect(realClick).toHaveBeenCalledExactlyOnceWith(current.querySelector('button'), { mayNavigate: false });
      expect(actual.moves).toHaveLength(1);
      expect(wrong?.moves.length ?? 0).toBeLessThanOrEqual(1);
      expect(window.scrollBy).not.toHaveBeenCalled();
    },
  );

  it('守卫分支内的连续滚动也合并，且验证导致重绘后重新用快照定位', async () => {
    document.body.innerHTML = '<button id="before">领取今日额度</button>';
    const before = document.querySelector('button');
    const beforeAction = vi.fn(async () => {
      document.body.innerHTML = '<button id="after">每日签到</button>';
      return true;
    });
    const result = await runCheckinWorkflow(site, { steps: [{
      type: 'if', condition: { type: 'path', pattern: '/profile' }, then: [
        { type: 'scroll', container: '#gone', ratio: 0.2 },
        { type: 'scroll', container: '#gone', ratio: 0.4 }, claim,
      ],
    }] }, log, { beforeAction });
    expect(result.status).not.toBe('failed');
    // 两个分支内滚动步骤及最终点击都经过验证入口。
    expect(beforeAction).toHaveBeenCalledTimes(3);
    expect(realClick).toHaveBeenCalledExactlyOnceWith(document.querySelector('#after'), { mayNavigate: false });
    expect(before?.isConnected).toBe(false);
    expect(window.scrollBy).not.toHaveBeenCalled();
  });

  it('原选择器仍然有效时优先使用，不因另一个签到动作而改点', async () => {
    document.body.innerHTML = '<button id="original">立即签到</button><button>领取今日额度</button>';
    await runCheckinWorkflow(site, { steps: [{ ...claim, selector: '#original' }] }, log);
    expect(realClick).toHaveBeenCalledExactlyOnceWith(document.querySelector('#original'), { mayNavigate: false });
    expect(log.push).not.toHaveBeenCalledWith(expect.stringContaining('替代失效的选择器'));
  });

  it('快照恢复仍执行点击后验证和 waitFor 契约', async () => {
    document.body.innerHTML = '<button>每日签到</button><div id="result"></div>';
    const afterAction = vi.fn().mockResolvedValue(true);
    await runCheckinWorkflow(site, { steps: [{ ...claim, waitFor: '#result' }] }, log, { afterAction });
    expect(afterAction).toHaveBeenCalledOnce();
    expect(waitFor).toHaveBeenCalledWith('#result', 0);
  });

  it('独立滚动没有后续控件时，旧面板失效后对当前面板恢复比例', async () => {
    document.body.innerHTML = '<main id="current"></main>';
    const panel = document.querySelector<HTMLElement>('#current')!;
    scrollPanel(panel);
    const result = await runCheckinWorkflow(site, { steps: [{
      type: 'scroll', container: '#gone', ratio: 0.43, settleMs: 0, timeoutMs: 1000,
    }] }, log);
    expect(result.status).not.toBe('failed');
    expect(panel.scrollTop).toBe(430);
    expect(window.scrollBy).not.toHaveBeenCalled();
  });
});

describe('恢复候选必须唯一且保留已记录字段', () => {
  it.each([
    '<button>每日签到</button><button>领取今日额度</button>',
    '<button>立即签到</button><button>立即签到</button>',
  ])('失效选择器命中多个恢复候选时停止，不按文档顺序选择', async (html) => {
    document.body.innerHTML = html;
    const result = await runCheckinWorkflow(site, { steps: [{ ...claim, selector: '#gone' }] }, log);
    expect(result).toMatchObject({ status: 'failed', message: expect.stringContaining('无法确定唯一目标') });
    expect(realClick).not.toHaveBeenCalled();
    expect(window.scrollBy).not.toHaveBeenCalled();
  });

  it('文案改变也不能忽略冲突的 testId', async () => {
    document.body.innerHTML = '<button data-testid="unrelated">领取今日额度</button>';
    const result = await runCheckinWorkflow(site, { steps: [{
      ...claim, fingerprint: { ...claim.fingerprint, testId: 'recorded-claim' },
    }] }, log);
    expect(result.status).toBe('failed');
    expect(realClick).not.toHaveBeenCalled();
  });

  it('快照排除菜单、导航、教程和包装容器，只选择实际签到命令', async () => {
    document.body.innerHTML = '<nav><button>签到</button></nav>'
      + '<a href="/other">签到</a><button aria-haspopup="dialog">签到</button>'
      + '<button>签到教程</button><h2>每日签到</h2>'
      + '<div class="button-wrapper"><button id="actual">领取今日额度</button></div>';
    await runCheckinWorkflow(site, { steps: [claim] }, log);
    expect(realClick).toHaveBeenCalledExactlyOnceWith(document.querySelector('#actual'), { mayNavigate: false });
  });

  it('普通中间步骤不能被页面上的签到动作替代', async () => {
    document.body.innerHTML = '<button>领取今日额度</button>';
    const result = await runCheckinWorkflow(site, { steps: [{
      type: 'click', selector: '#gone', timeoutMs: 0, fingerprint: { tag: 'button', text: '个人资料' },
    }] }, log);
    expect(result.status).toBe('failed');
    expect(realClick).not.toHaveBeenCalled();
  });

  it.each(['<button disabled>签到中</button>', '<button disabled>立即签到</button>', '<button aria-busy="true">领取今日额度</button>'])(
    '暂时禁用或处理中不能被快照判成已签到', (html) => {
      document.body.innerHTML = html;
      expect(snapshotCheckinControls()).toEqual({ kind: 'none' });
    },
  );

  it('禁用且明确已签到才收尾，历史文案不参与快照', async () => {
    document.body.innerHTML = '<aside>今日已签到</aside><button disabled>今日已签到</button>';
    const result = await runCheckinWorkflow(site, { steps: [claim] }, log);
    expect(result.status).toBe('already');
    expect(realClick).not.toHaveBeenCalled();
    expect(window.scrollBy).not.toHaveBeenCalled();
    document.body.innerHTML = '<aside>今日已签到</aside><h2>今日已签到</h2>';
    expect(snapshotCheckinControls()).toEqual({ kind: 'none' });
  });
});
