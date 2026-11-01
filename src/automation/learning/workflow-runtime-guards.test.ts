import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SiteConfig } from '@/types';

vi.mock('@/automation/shared/dom-utils', async () => {
  const actual = await vi.importActual<typeof import('@/automation/shared/dom-utils')>('@/automation/shared/dom-utils');
  return {
    ...actual,
    sleep: vi.fn().mockResolvedValue(undefined),
    waitFor: vi.fn(async (selector: string) => actual.queryFirst(selector)),
    realClick: vi.fn(async (element: HTMLElement) => { element.click(); return 'dom'; }),
  };
});
vi.mock('@/automation/shared/click-safety', () => ({ clearClickBlocker: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/core/messaging', () => ({ sendMessage: vi.fn() }));
vi.mock('@/automation/sites/leilei-daily', () => ({ runLeileiDaily: vi.fn() }));

import { queryFirst, realClick, sleep, waitFor } from '@/automation/shared/dom-utils';
import { clearClickBlocker } from '@/automation/shared/click-safety';
import { runLeileiDaily } from '@/automation/sites/leilei-daily';
import { runCheckinWorkflow } from './workflow';

const site: SiteConfig = {
  id: 'runtime', name: '运行时验收', loginUrl: `${location.origin}/login`,
  selectors: { username: '#username', password: '#password', submit: '#submit' }, closeModalSelectors: [],
};
const log = { push: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(waitFor).mockReset().mockImplementation(async (selector: string) => queryFirst(selector));
  vi.mocked(sleep).mockResolvedValue(undefined);
  vi.mocked(clearClickBlocker).mockReset().mockResolvedValue(null);
  history.replaceState({}, '', '/checkin');
  document.body.innerHTML = '';
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true, get(this: HTMLElement) { return this.textContent ?? ''; },
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width: 120, height: 30 } as DOMRect);
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});
afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ''; });

describe('学习回放的逐步环境处理', () => {
  it.each([false, true])('指纹定位 scrollIntoView=%s：长验证之后异步挂载仍保留完整查找预算', async (scrollIntoView) => {
    let now = 0;
    let readyAt = Infinity;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.mocked(sleep).mockImplementation(async (ms) => { now += ms; });
    vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
    document.body.innerHTML = '<main id="panel" style="overflow-y:auto"></main>';
    const panel = document.querySelector<HTMLElement>('#panel')!;
    if (scrollIntoView) {
      Object.defineProperties(panel, {
        clientHeight: { value: 200 }, clientWidth: { value: 400 }, scrollHeight: { value: 12_000 },
      });
    }
    vi.mocked(waitFor).mockImplementation(async (selector, timeoutMs = 0) => {
      now += timeoutMs;
      if (now >= readyAt && !document.querySelector('#reason')) {
        panel.innerHTML = '<textarea id="reason" aria-label="签到理由"></textarea>';
      }
      return queryFirst(selector);
    });
    const result = await runCheckinWorkflow(site, { steps: [{
      type: 'fill', selector: '#reason', value: '正常签到', timeoutMs: 3000, scrollIntoView,
      scrollContainer: scrollIntoView ? '#panel' : undefined,
      fingerprint: { tag: 'textarea', aria: '签到理由' },
    }] }, log, { checkpoint: async ({ phase }) => {
      if (phase === 'waiting' && now >= 400 && readyAt === Infinity) {
        now += 20_000;
        readyAt = now + 1200;
      }
      return null;
    } });
    expect(readyAt).not.toBe(Infinity);
    expect(result.status).not.toBe('failed');
    expect(document.querySelector<HTMLTextAreaElement>('#reason')?.value).toBe('正常签到');
    expect(realClick).not.toHaveBeenCalled();
  });

  it.each(['assert', 'wait', 'click-wait', 'fill-locate'] as const)(
    '%s 等待中迟到的验证由运行时处理，保留业务等待预算且不重复动作', async (kind) => {
      let now = 0;
      let recovered = false;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      vi.mocked(sleep).mockImplementation(async (ms) => { now += ms; });
      vi.mocked(waitFor).mockImplementation(async (selector, timeoutMs = 0) => {
        const initial = queryFirst(selector);
        if (initial) return initial;
        now += timeoutMs;
        return queryFirst(selector);
      });
      document.body.innerHTML = '<button id="open">打开面板</button>';
      const steps = kind === 'assert' ? [{ type: 'assert' as const, selector: '#ready', result: 'success' as const, timeoutMs: 1000 }]
        : kind === 'wait' ? [{ type: 'wait' as const, selector: '#ready', timeoutMs: 1000 }]
          : kind === 'click-wait' ? [{ type: 'click' as const, selector: '#open', waitFor: '#ready', timeoutMs: 1000 }]
            : [{ type: 'fill' as const, selector: '#reason', value: '业务内容', timeoutMs: 1000 }];
      const result = await runCheckinWorkflow(site, { steps }, log, {
        checkpoint: async ({ phase }) => {
          if (phase === 'waiting' && now >= 500 && !recovered) {
            recovered = true;
            now += 20_000;
            document.body.insertAdjacentHTML('beforeend', '<p id="ready">签到成功</p><textarea id="reason"></textarea>');
          }
          return null;
        },
      });
      expect(recovered).toBe(true);
      expect(result.status).toBe('success');
      expect(realClick).toHaveBeenCalledTimes(kind === 'click-wait' ? 1 : 0);
      if (kind === 'fill-locate') expect(document.querySelector<HTMLTextAreaElement>('#reason')?.value).toBe('业务内容');
    },
  );

  it('固定等待中发现会话变化立即中断，不跑后续签到', async () => {
    document.body.innerHTML = '<button id="checkin">签到</button>';
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.mocked(sleep).mockImplementation(async (ms) => { now += ms; });
    const result = await runCheckinWorkflow(site, { steps: [
      { type: 'wait', ms: 2000 }, { type: 'click', selector: '#checkin' },
    ] }, log, { checkpoint: async ({ phase }) => phase === 'waiting' && now >= 500
      ? { status: 'interrupted', message: '已安排恢复会话' } : null });
    expect(result.status).toBe('interrupted');
    expect(now).toBe(500);
    expect(realClick).not.toHaveBeenCalled();
  });

  it('独立滚动中发现验证立即中断，不继续滚动或等待稳定', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.mocked(sleep).mockImplementation(async (ms) => { now += ms; });
    document.body.innerHTML = '<main id="panel" style="overflow-y:auto"></main>';
    const panel = document.querySelector<HTMLElement>('#panel')!;
    Object.defineProperties(panel, {
      clientHeight: { value: 200 }, clientWidth: { value: 400 }, scrollHeight: { value: 2000 },
    });
    const result = await runCheckinWorkflow(site, { steps: [{
      type: 'scroll', container: '#panel', ratio: 1, settleMs: 1000, timeoutMs: 3000,
    }] }, log, { checkpoint: async ({ phase }) => phase === 'waiting' && now >= 150
      ? { status: 'interrupted', message: '需要先完成二次验证' } : null });
    expect(result).toEqual({ status: 'interrupted', message: '需要先完成二次验证' });
    expect(now).toBe(150);
    expect(realClick).not.toHaveBeenCalled();
  });

  it('定位中断不能降级成找不到控件或按路线跳过', async () => {
    const result = await runCheckinWorkflow(site, { steps: [{ type: 'fill', selector: '#missing', value: '不能写入' }] }, log, {
      checkpoint: async ({ phase }) => phase === 'waiting'
        ? { status: 'interrupted', message: '需要先完成验证' } : null,
    });
    expect(result).toEqual({ status: 'interrupted', message: '需要先完成验证' });
    expect(realClick).not.toHaveBeenCalled();
  });

  it('leilei-daily 内部点击被会话闸门中断时保留恢复状态', async () => {
    let changed = false;
    const execute = async (hooks: { beforeAction?: () => Promise<boolean>; beforeDispatch?: () => Promise<boolean> } = {}) => {
      expect(await hooks.beforeAction?.()).toBe(true);
      expect(await hooks.beforeDispatch?.()).toBe(false);
      // 专用执行器会捕获错误；外围必须恢复 interrupted，不能按失败重试业务动作。
      return { status: 'failed' as const, message: '内部动作已停止' };
    };
    vi.mocked(runLeileiDaily).mockImplementation(async (_site, _log, hooks) => execute(hooks));
    const result = await runCheckinWorkflow(site, { steps: [{ type: 'leilei-daily' }] }, log, {
      beforeAction: async () => { changed = true; return true; },
      checkpoint: async ({ phase }) => changed && phase === 'action'
        ? { status: 'interrupted', message: '正在恢复目标会话' } : null,
    });
    expect(result).toEqual({ status: 'interrupted', message: '正在恢复目标会话' });
  });

  it('条件分支内输入前先处理验证，输入后再处理新验证', async () => {
    const beforeAction = vi.fn(async () => {
      document.body.innerHTML = '<textarea id="reason"></textarea>';
      return true;
    });
    const afterAction = vi.fn().mockResolvedValue(true);
    const result = await runCheckinWorkflow(site, { steps: [{
      type: 'if', condition: { type: 'path', pattern: '/checkin' },
      then: [{ type: 'fill', selector: '#reason', value: '签到理由' }],
    }] }, log, { beforeAction, afterAction });
    expect(beforeAction).toHaveBeenCalledOnce();
    expect(afterAction).toHaveBeenCalledOnce();
    expect(document.querySelector<HTMLTextAreaElement>('#reason')?.value).toBe('签到理由');
    expect(result.status).toBe('unknown');
  });

  it('分支内验证未完成时不输入、不执行后续步骤', async () => {
    document.body.innerHTML = '<textarea id="reason"></textarea><button id="checkin">签到</button>';
    const result = await runCheckinWorkflow(site, { steps: [{
      type: 'if', condition: { type: 'path', pattern: '/checkin' },
      then: [{ type: 'fill', selector: '#reason', value: '不能写入' }, { type: 'click', selector: '#checkin' }],
    }] }, log, { beforeAction: async () => false });
    expect(result.status).toBe('failed');
    expect(document.querySelector<HTMLTextAreaElement>('#reason')?.value).toBe('');
    expect(realClick).not.toHaveBeenCalled();
  });

  it('步骤间账号变化时中断，不能被旧的成功提示放行', async () => {
    document.body.innerHTML = '<button id="open">展开</button><button id="checkin">签到</button>';
    let changed = false;
    document.querySelector('#open')!.addEventListener('click', () => { changed = true; });
    const result = await runCheckinWorkflow(site, { steps: [
      { type: 'click', selector: '#open' }, { type: 'click', selector: '#checkin' },
    ] }, log, { checkpoint: async () => changed ? { status: 'interrupted', message: '已安排切号' } : null });
    expect(result).toEqual({ status: 'interrupted', message: '已安排切号' });
    expect(realClick).toHaveBeenCalledOnce();
  });

  it('断言命中后仍核验会话，不能把别人会话中的完成态记到本账号', async () => {
    document.body.innerHTML = '<p>签到成功</p>';
    const result = await runCheckinWorkflow(site, { steps: [
      { type: 'assert', text: ['签到成功'], result: 'success' },
    ] }, log, { checkpoint: async ({ phase }) => phase === 'after'
      ? { status: 'interrupted', message: '会话已变化' } : null });
    expect(result.status).toBe('interrupted');
  });

  it('中间页会话恢复不能降级为直接去下一页', async () => {
    history.replaceState({}, '', '/profile');
    const config = { steps: [{ type: 'if' as const, condition: { type: 'path' as const, pattern: '/profile' },
      then: [{ type: 'click' as const, selector: '#menu' }] }], route: ['/profile', '/checkin'], identityPath: '/profile' };
    const result = await runCheckinWorkflow({ ...site, checkin: { method: 'workflow', workflow: config } }, config, log, {
      checkpoint: async () => ({ status: 'interrupted', message: '正在重新认证' }),
    });
    expect(result.status).toBe('interrupted');
    expect(realClick).not.toHaveBeenCalled();
  });

  it('中间页验证未完成不能绕过验证直接导航', async () => {
    history.replaceState({}, '', '/profile');
    document.body.innerHTML = '<button id="menu">展开菜单</button>';
    const config = { steps: [{ type: 'if' as const, condition: { type: 'path' as const, pattern: '/profile' },
      then: [{ type: 'click' as const, selector: '#menu' }] }], route: ['/profile', '/checkin'], identityPath: '/profile' };
    const result = await runCheckinWorkflow({ ...site, checkin: { method: 'workflow', workflow: config } }, config, log, {
      beforeAction: async () => false,
    });
    expect(result.status).toBe('failed');
    expect(realClick).not.toHaveBeenCalled();
  });

  it('公告关闭触发组件重绘后重新定位，实际点击新控件', async () => {
    document.body.innerHTML = '<button id="checkin">签到</button>';
    const old = document.querySelector('#checkin');
    vi.mocked(clearClickBlocker).mockImplementationOnce(async () => {
      document.body.innerHTML = '<button id="checkin">签到</button>';
      return null;
    });
    await runCheckinWorkflow(site, { steps: [{ type: 'click', selector: '#checkin' }] }, log);
    expect(realClick).toHaveBeenCalledOnce();
    expect(vi.mocked(realClick).mock.calls[0]![0]).not.toBe(old);
    expect(vi.mocked(realClick).mock.calls[0]![0].isConnected).toBe(true);
  });

  it('输入框被公告遮挡且无法关闭时不写入', async () => {
    document.body.innerHTML = '<textarea id="reason"></textarea>';
    vi.mocked(clearClickBlocker).mockResolvedValue(document.createElement('div'));
    const result = await runCheckinWorkflow(site, { steps: [{ type: 'fill', selector: '#reason', value: '不能写入' }] }, log);
    expect(result.status).toBe('failed');
    expect(document.querySelector<HTMLTextAreaElement>('#reason')?.value).toBe('');
  });

  it('验证等待期间账号变化时，最终动作闸门阻止点击', async () => {
    document.body.innerHTML = '<button id="checkin">签到</button>';
    let changed = false;
    const result = await runCheckinWorkflow(site, { steps: [{ type: 'click', selector: '#checkin' }] }, log, {
      beforeAction: async () => { changed = true; return true; },
      checkpoint: async ({ phase }) => changed && phase === 'action'
        ? { status: 'interrupted', message: '验证期间会话已变化' } : null,
    });
    expect(result.status).toBe('interrupted');
    expect(realClick).not.toHaveBeenCalled();
  });

  it('关闭公告期间账号变化时，最终动作闸门阻止输入', async () => {
    document.body.innerHTML = '<textarea id="reason"></textarea>';
    let changed = false;
    vi.mocked(clearClickBlocker).mockImplementationOnce(async () => { changed = true; return null; });
    const result = await runCheckinWorkflow(site, { steps: [{ type: 'fill', selector: '#reason', value: '不能写入' }] }, log, {
      checkpoint: async ({ phase }) => changed && phase === 'action'
        ? { status: 'interrupted', message: '公告期间会话已变化' } : null,
    });
    expect(result.status).toBe('interrupted');
    expect(document.querySelector<HTMLTextAreaElement>('#reason')?.value).toBe('');
  });

  it('结果轮询验证改变会话后必须重查，不能沿用验证前的身份结算', async () => {
    document.body.innerHTML = '<button id="checkin">签到</button>';
    let changed = false;
    const result = await runCheckinWorkflow(site, { steps: [{ type: 'click', selector: '#checkin' }] }, log, {
      checkpoint: async () => changed ? { status: 'interrupted', message: '验证后会话已变化' } : null,
      whileWaitingForResult: async () => {
        changed = true;
        document.body.innerHTML = '<p>签到成功</p>';
        return { detected: true, resolved: true };
      },
    });
    expect(result.status).toBe('interrupted');
    expect(realClick).toHaveBeenCalledOnce();
  });

  it('结果检查中的会话验证耗时不挤占结果渲染预算', async () => {
    document.body.innerHTML = '<button id="checkin">签到</button>';
    let now = 0;
    let reads = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.mocked(sleep).mockImplementation(async (ms) => {
      now += ms;
      if (now >= 20_400) document.body.innerHTML = '<p>签到成功</p>';
    });
    const result = await runCheckinWorkflow(site, { steps: [{ type: 'click', selector: '#checkin' }] }, log, {
      checkpoint: async ({ phase }) => {
        if (phase === 'result' && ++reads === 1) now += 20_000;
        return null;
      },
    });
    expect(result.status).toBe('success');
    expect(reads).toBeGreaterThan(1);
    expect(realClick).toHaveBeenCalledOnce();
    vi.mocked(sleep).mockResolvedValue(undefined);
  });

  it('晚出现的验证耗时不挤占结果渲染预算，也不重复签到', async () => {
    document.body.innerHTML = '<button id="checkin">签到</button>';
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.mocked(sleep).mockImplementation(async (ms) => {
      now += ms;
      if (now >= 20_400) document.body.innerHTML = '<p>签到成功</p>';
    });
    let reads = 0;
    const result = await runCheckinWorkflow(site, { steps: [{ type: 'click', selector: '#checkin' }] }, log, {
      whileWaitingForResult: async () => {
        reads += 1;
        if (reads === 1) { now += 20_000; return { detected: true, resolved: true }; }
        return { detected: false, resolved: true };
      },
    });
    expect(result.status).toBe('success');
    expect(reads).toBeGreaterThan(1);
    expect(realClick).toHaveBeenCalledOnce();
    vi.mocked(sleep).mockResolvedValue(undefined);
  });
});
