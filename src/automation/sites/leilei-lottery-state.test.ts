import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SiteConfig } from '@/types';

const pointer = vi.hoisted(() => ({
  realClick: vi.fn(),
  clearClickBlocker: vi.fn(),
}));

vi.mock('@/automation/shared/dom-utils', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/automation/shared/dom-utils')>(),
  realClick: pointer.realClick,
}));
vi.mock('@/automation/shared/click-safety', () => ({ clearClickBlocker: pointer.clearClickBlocker }));

import { runLeileiDaily } from '@/automation/sites/leilei-daily';

const ORIGIN = 'https://fapi.leileihog.top';
const site: SiteConfig = {
  id: 'leilei-lottery-state',
  name: '一梦五千年',
  loginUrl: `${ORIGIN}/sign-in`,
  pointerMode: 'trusted',
  selectors: { username: 'input', password: 'input', submit: 'button' },
  closeModalSelectors: [],
  checkin: { method: 'workflow', workflow: { steps: [{ type: 'leilei-daily' }] } },
};

type BoardState = 'loading' | 'ready' | 'drawing' | 'done';

/**
 * Mirrors the public /lottery component published on 2026-09-10:
 * /static/js/async/8639.93c28114fe.js (no account data or live draw requests).
 * Before /api/lottery/status resolves, `remaining = data?.remaining ?? 0`
 * makes the center button show "Draw completed", even for an eligible user.
 */
function renderBoard(state: BoardState = 'ready', english = false) {
  document.body.innerHTML = `
    <main class="lottery-page" data-width="1000" data-height="800">
      <div class="lottery-page-heading" data-width="900" data-height="60">
        <div><span>浮梦引光</span><h2>Take your luck with you</h2></div>
        <span id="draw-status">${english ? 'Ready to draw' : '等待开奖'}</span>
      </div>
      <section class="lottery-stage" data-width="500" data-height="500">
        <div class="lottery-board-frame" data-width="460" data-height="460">
          <div class="lottery-board" data-width="422" data-height="422">
            <div class="lottery-prize-cell" data-width="134" data-height="134">谢谢参与</div>
            <button type="button" class="lottery-board-center"
              data-width="134" data-height="134"></button>
          </div>
          <span class="lottery-corner lottery-corner-sw">${english ? 'Draw' : '抽奖'}</span>
        </div>
        <p class="lottery-notice" aria-live="polite">签筒已备，且看今日梦火花落谁家。</p>
      </section>
      <aside class="lottery-sidebar"><button>我的历史</button></aside>
    </main>`;

  const center = () => document.querySelector<HTMLButtonElement>('.lottery-board-center')!;
  const setState = (next: BoardState) => {
    const button = center();
    button.disabled = next !== 'ready';
    const label = next === 'ready' ? (english ? 'Start draw' : '开始抽奖')
      : next === 'drawing' ? (english ? 'Drawing' : '开奖中')
        : (english ? 'Draw completed' : '今日已抽');
    const hint = next === 'ready' ? (english ? 'Remaining draws: 1' : '剩余抽奖次数：1')
      : next === 'drawing' ? (english ? 'Please wait' : '请稍候')
        : (english ? 'No draws left today' : '今日抽奖次数已用完');
    button.innerHTML = `<span>${label}</span><small>${hint}</small>`;
  };
  const finish = () => {
    setState('done');
    document.getElementById('draw-status')!.textContent = 'Won 谢谢参与';
    document.querySelector('.lottery-notice')!.textContent = english
      ? 'This draw is complete. Come back tomorrow for another.'
      : '今日梦火抽签次数已耗尽，明日再赴千年旧梦。';
  };
  const replaceCenter = () => {
    const replacement = center().cloneNode(true) as HTMLButtonElement;
    center().replaceWith(replacement);
    replacement.addEventListener('click', finish);
    return replacement;
  };
  setState(state);
  center().addEventListener('click', finish);
  return { center, setState, finish, replaceCenter };
}

async function run(hooks: Parameters<typeof runLeileiDaily>[2] = {}) {
  const log = { push: vi.fn() };
  const pending = runLeileiDaily(site, log, hooks);
  await vi.runAllTimersAsync();
  const result = await pending;
  if (result.status === 'navigate') throw new Error(`抽奖页不应再次导航到 ${result.url}`);
  return { result, log };
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-09-10T05:00:00Z') });
  vi.stubGlobal('location', new URL(`${ORIGIN}/lottery`));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (!this.isConnected || this.hidden) return new DOMRect(0, 0, 0, 0);
    return new DOMRect(320, 240, Number(this.dataset.width ?? 24), Number(this.dataset.height ?? 20));
  });
  pointer.clearClickBlocker.mockReset().mockResolvedValue(null);
  pointer.realClick.mockReset().mockImplementation(async (element: HTMLElement) => {
    if (!element.isConnected) throw new Error('点击了已被重绘移除的旧节点');
    element.click();
    return 'trusted';
  });
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('一梦五千年真实抽奖状态', () => {
  it('公告处理后最终会话核验未通过时不消耗抽奖机会', async () => {
    renderBoard();
    const beforeDispatch = vi.fn().mockResolvedValue(false);
    const result = await runLeileiDaily(site, { push: vi.fn() }, { beforeDispatch });
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(result.status).toBe('failed');
    expect(pointer.realClick).not.toHaveBeenCalled();
  });

  it.each([2_000, 11_500])('状态接口延迟 %i ms 时，不把初始“今日已抽”当成已完成', async (delay) => {
    const board = renderBoard('loading');
    setTimeout(() => board.setState('ready'), delay);

    const { result } = await run();

    expect(result.status).toBe('success');
    expect(pointer.realClick).toHaveBeenCalledExactlyOnceWith(board.center(), { mayNavigate: false });
  });

  it('状态始终没有加载成功时，不谎报已抽，也不点击禁用按钮', async () => {
    renderBoard('loading');

    const { result } = await run();

    expect(result.status).toBe('failed');
    expect(result.message).toContain('抽奖状态');
    expect(pointer.realClick).not.toHaveBeenCalled();
  });

  it('历史/规则里有“今日已抽”也不会覆盖当前可用的中央按钮', async () => {
    const board = renderBoard();
    document.querySelector('.lottery-sidebar')!.insertAdjacentHTML('beforeend',
      '<p>抽奖规则：完成后按钮显示今日已抽，不可重复抽奖。</p>');

    const { result } = await run();

    expect(result.status).toBe('success');
    expect(pointer.realClick).toHaveBeenCalledExactlyOnceWith(board.center(), { mayNavigate: false });
  });

  it('本账号已有中奖记录时不重复抽奖，包括未获得额度的“谢谢参与”', async () => {
    renderBoard('done');
    document.getElementById('draw-status')!.textContent = 'Won 谢谢参与';

    const { result } = await run();

    expect(result.status).toBe('already');
    expect(pointer.realClick).not.toHaveBeenCalled();
  });

  it('截图中的中文“抽中：晚舟裁月 +$2”与禁用的今日已抽按钮一起确认已完成', async () => {
    renderBoard('done');
    document.getElementById('draw-status')!.textContent = '抽中：晚舟裁月 +$2';

    const { result } = await run();

    expect(result.status).toBe('already');
    expect(pointer.realClick).not.toHaveBeenCalled();
  });

  it('右侧他人的“抽中”记录不能代替本账号状态加载完成', async () => {
    renderBoard('loading');
    document.querySelector('.lottery-sidebar')!.insertAdjacentHTML('beforeend',
      '<p>sx5731@qq.com 抽中：晚舟裁月 +$2</p>');

    const { result } = await run();

    expect(result.status).toBe('failed');
    expect(pointer.realClick).not.toHaveBeenCalled();
  });

  it('加载后确认今日已抽时直接结束，不等找按钮超时', async () => {
    renderBoard('loading');
    const start = Date.now();
    setTimeout(() => { document.getElementById('draw-status')!.textContent = 'Won 每日额度 +1'; }, 600);

    const { result } = await run();

    expect(result.status).toBe('already');
    expect(Date.now() - start).toBeLessThan(1_000);
    expect(pointer.realClick).not.toHaveBeenCalled();
  });

  it('站点切到英文时仍使用同一个中央抽奖按钮', async () => {
    const board = renderBoard('ready', true);

    const { result } = await run();

    expect(result.status).toBe('success');
    expect(pointer.realClick).toHaveBeenCalledExactlyOnceWith(board.center(), { mayNavigate: false });
  });

  it('优先中央真实按钮，不点击写有“抽奖”的方形祖先容器', async () => {
    const board = renderBoard();
    const decoy = document.createElement('div');
    decoy.className = 'cursor-pointer';
    decoy.dataset.width = '100';
    decoy.dataset.height = '100';
    decoy.textContent = '抽奖';
    document.querySelector('.lottery-board-frame')!.appendChild(decoy);

    const { result } = await run();

    expect(result.status).toBe('success');
    expect(pointer.realClick).toHaveBeenCalledExactlyOnceWith(board.center(), { mayNavigate: false });
  });

  it('正在开奖时不点击文字子节点或补发第二次抽奖', async () => {
    const board = renderBoard('drawing');
    setTimeout(board.finish, 600);

    const { result } = await run();

    expect(result.status).toBe('already');
    expect(pointer.realClick).not.toHaveBeenCalled();
  });

  it('只有中奖记录而没有已抽按钮状态时，不能提前认为本轮已完成', async () => {
    const board = renderBoard();
    document.getElementById('draw-status')!.textContent = 'Won 昨日额度 +1';

    const { result } = await run();

    expect(result.status).toBe('success');
    expect(pointer.realClick).toHaveBeenCalledExactlyOnceWith(board.center(), { mayNavigate: false });
  });

  it('只有页面明确完成提示时，才在点击后确认抽奖成功', async () => {
    renderBoard();
    pointer.realClick.mockResolvedValue('trusted');

    const { result } = await run();

    expect(result.status).toBe('failed');
    expect(result.message).toContain('抽奖后未出现');
    expect(pointer.realClick).toHaveBeenCalledOnce();
  });
});

describe('一梦五千年抽奖前重定位', () => {
  it('前置验证导致重绘时，点击新的中央按钮', async () => {
    const board = renderBoard();
    const old = board.center();

    const { result } = await run({ beforeAction: async () => { board.replaceCenter(); return true; } });

    expect(result.status).toBe('success');
    expect(old.isConnected).toBe(false);
    expect(pointer.realClick).toHaveBeenCalledExactlyOnceWith(board.center(), { mayNavigate: false });
  });

  it('关闭公告导致重绘时，重新检查新按钮的遮挡后才点击', async () => {
    const board = renderBoard();
    const old = board.center();
    pointer.clearClickBlocker.mockImplementationOnce(async () => { board.replaceCenter(); return null; });

    const { result } = await run();

    expect(result.status).toBe('success');
    expect(old.isConnected).toBe(false);
    expect(pointer.clearClickBlocker).toHaveBeenCalledTimes(2);
    expect(pointer.clearClickBlocker.mock.calls[1]![0]).toBe(board.center());
    expect(pointer.realClick).toHaveBeenCalledExactlyOnceWith(board.center(), { mayNavigate: false });
  });

  it('持续重绘无法稳定定位时，有限退出，不点击旧节点或循环重试抽奖', async () => {
    const board = renderBoard();
    pointer.clearClickBlocker.mockImplementation(async () => { board.replaceCenter(); return null; });

    const { result } = await run();

    expect(result.status).toBe('failed');
    expect(result.message).toContain('重绘');
    expect(pointer.clearClickBlocker.mock.calls.length).toBeLessThanOrEqual(3);
    expect(pointer.realClick).not.toHaveBeenCalled();
  });

  it('清理后仍有遮挡时保持失败，不绕过可信点击的安全检查', async () => {
    renderBoard();
    pointer.clearClickBlocker.mockResolvedValue(document.createElement('div'));

    const { result } = await run();

    expect(result.status).toBe('failed');
    expect(result.message).toContain('遮挡');
    expect(pointer.realClick).not.toHaveBeenCalled();
  });

  it('保留旧版无专用 class 的方块识别', async () => {
    document.body.innerHTML = '<div class="cursor-pointer" data-width="120" data-height="120">抽奖</div>';
    const tile = document.querySelector<HTMLElement>('.cursor-pointer')!;
    tile.addEventListener('click', () => { document.body.innerHTML = '<div>今日已抽</div>'; });

    const { result } = await run();

    expect(result.status).toBe('success');
    expect(pointer.realClick).toHaveBeenCalledExactlyOnceWith(tile, { mayNavigate: false });
  });
});
