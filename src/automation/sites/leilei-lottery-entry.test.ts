/**
 * 一梦五千年：从个人资料页进抽奖页。
 *
 * 修的是一个实测卡死：日志停在「页面显示今日已签到，继续进入浮梦引光」，
 * 后面什么都没有。两个原因叠在一起：
 *
 *  1. **入口在顶部导航栏**（用户截图确认，与「主页 / 控制台 / 模型广场」并列），
 *     而 `findDreamLink` 只认「href 解析到 /lottery 的锚点」加一条
 *     `checkinControls()` 兜底 —— 后者收集签到类控件，导航栏项不在其中，两条都扑空；
 *  2. 找不到就 `throw`，而 `/lottery` 是**固定的同源地址**，直接导航必定到得了 ——
 *     非要先找到元素才肯走，等于给一条不会失败的路凭空加一个失败点。
 *
 * 另外把会跳转的点击改成「先写日志再点」：整页跳转瞬间销毁 content script，
 * 动作之后 push 的日志永远进不了信箱，这正是日志断在那里、看不出点击有没有
 * 发生的原因（README「日志的写入顺序有讲究」）。
 */

import { describe, expect, it, vi } from 'vitest';
import type { SiteConfig } from '@/types';

const realClick = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@/automation/shared/dom-utils', () => ({
  isVisible: () => true,
  realClick,
  sleep: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/automation/shared/click-safety', () => ({
  clearClickBlocker: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/automation/checkin/checkin-vocab', () => ({
  // 只收集按钮类控件 —— 与真实实现一致，导航栏链接不在其中
  checkinControls: () => [...document.querySelectorAll<HTMLElement>('button')],
  controlDisabled: (el: HTMLElement) => el.hasAttribute('disabled'),
  controlText: (el: HTMLElement) => el.textContent ?? '',
}));

const { runLeileiDaily } = await import('@/automation/sites/leilei-daily');

const ORIGIN = 'https://fapi.leileihog.top';

function site(): SiteConfig {
  return {
    id: 'site-leilei',
    name: '一梦五千年',
    loginUrl: `${ORIGIN}/sign-in`,
    selectors: { username: 'input[name="username"]', password: 'input[name="password"]', submit: 'button' },
    closeModalSelectors: [],
    checkin: { method: 'workflow', workflow: { steps: [{ type: 'leilei-daily' }] } },
  };
}

/** 把 location 指到指定路径 —— 流程按 pathname 分派 */
function atPath(pathname: string) {
  vi.stubGlobal('location', new URL(`${ORIGIN}${pathname}`));
}

describe('浮梦引光入口', () => {
  it('入口在顶部导航栏（非 /lottery 锚点）时也能识别并点击', async () => {
    atPath('/profile');
    document.body.innerHTML = `
      <nav>
        <a href="/">主页</a>
        <a href="/console">控制台</a>
        <a href="/models">模型广场</a>
        <span role="link" class="cursor-pointer">浮梦引光</span>
      </nav>
      <button disabled>已签到</button>
    `;
    const log = { push: vi.fn() };
    realClick.mockClear();

    const result = await runLeileiDaily(site(), log);

    // 点了导航栏那个 span，而不是抛「未找到入口」
    expect(realClick).toHaveBeenCalledOnce();
    expect((realClick.mock.calls[0]![0] as HTMLElement).textContent).toBe('浮梦引光');
    // 点击后路径没变（测试环境不会真跳），改为直接导航
    expect(result).toEqual({ status: 'navigate', url: `${ORIGIN}/lottery` });
  });

  it('优先用 href 指向 /lottery 的锚点', async () => {
    atPath('/profile');
    document.body.innerHTML = `
      <nav>
        <a href="/lottery">浮梦引光</a>
        <span role="link">浮梦引光</span>
      </nav>
      <button disabled>今日已签到</button>
    `;
    const log = { push: vi.fn() };
    realClick.mockClear();

    await runLeileiDaily(site(), log);

    expect((realClick.mock.calls[0]![0] as HTMLElement).tagName).toBe('A');
  });

  it('完全找不到入口时直接导航到 /lottery，不再当成失败', async () => {
    atPath('/profile');
    // 页面上没有任何「浮梦引光」字样 —— 站点改版的情形
    document.body.innerHTML = `
      <nav><a href="/">主页</a></nav>
      <button disabled>今日已签到</button>
    `;
    const log = { push: vi.fn() };
    realClick.mockClear();

    const result = await runLeileiDaily(site(), log);

    expect(realClick).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'navigate', url: `${ORIGIN}/lottery` });
    // 日志要说清「没找到、改为直接进入」，并列出页面上实际有什么
    expect(log.push).toHaveBeenCalledWith(expect.stringContaining('未在页面上找到'));
    expect(log.push).toHaveBeenCalledWith(expect.stringContaining('/lottery'));
  });

  it('不点击包含这四个字的大容器（祖先重复子节点文字）', async () => {
    atPath('/profile');
    document.body.innerHTML = `
      <div id="shell">
        <nav id="bar"><a id="entry" href="#">浮梦引光</a></nav>
      </div>
      <button disabled>今日已签到</button>
    `;
    const log = { push: vi.fn() };
    realClick.mockClear();

    await runLeileiDaily(site(), log);

    expect((realClick.mock.calls[0]![0] as HTMLElement).id).toBe('entry');
  });

  it('会跳转的点击先写日志再点 —— 否则跳转销毁脚本后日志永远丢失', async () => {
    atPath('/profile');
    document.body.innerHTML = `
      <nav><a href="/lottery">浮梦引光</a></nav>
      <button disabled>今日已签到</button>
    `;
    const pushed: string[] = [];
    const log = { push: (message: string) => { pushed.push(message); } };
    realClick.mockClear();
    // 记录点击发生时日志已经有几条
    let logCountAtClick = -1;
    realClick.mockImplementation(async () => { logCountAtClick = pushed.length; });

    await runLeileiDaily(site(), log);

    // 点击那一刻，「即将点击」必须已经在日志里
    expect(logCountAtClick).toBeGreaterThan(0);
    expect(pushed.slice(0, logCountAtClick).join('|')).toContain('即将点击');
    realClick.mockResolvedValue(undefined);
  });
});

/**
 * 站点改版：现在只有抽奖，个人页没有签到入口（2026-08-26 用户确认）。
 *
 * 原来签到是必经步骤 —— 找不到签到按钮就 throw，于是整轮死在
 * 「未找到可用的每日签到按钮」，抽奖压根跑不到。
 */
describe('站点只有抽奖时', () => {
  it('个人页没有签到入口也继续走抽奖，不再判失败', async () => {
    atPath('/profile');
    document.body.innerHTML = `
      <nav>
        <a href="/">主页</a>
        <a href="/lottery">浮梦引光</a>
      </nav>
      <div>账户额度 $12.30</div>
    `;
    const log = { push: vi.fn() };
    realClick.mockClear();

    const result = await runLeileiDaily(site(), log);

    // 点的是浮梦引光入口，而不是抛「未找到签到按钮」
    expect(result).toEqual({ status: 'navigate', url: `${ORIGIN}/lottery` });
    expect(log.push).toHaveBeenCalledWith(expect.stringContaining('没有签到入口'));
  }, 10_000);

  it('从其它页面进来直接去 /lottery，不再绕 /profile', async () => {
    atPath('/console');
    document.body.innerHTML = '<nav><a href="/">主页</a></nav>';
    const log = { push: vi.fn() };

    const result = await runLeileiDaily(site(), log);

    expect(result).toEqual({ status: 'navigate', url: `${ORIGIN}/lottery` });
    expect(log.push).toHaveBeenCalledWith(expect.stringContaining('直接进入浮梦引光'));
  });

  it('签到入口还在时仍会顺手点一下（站点日后加回来不用改代码）', async () => {
    atPath('/profile');
    document.body.innerHTML = `
      <nav><a href="/lottery">浮梦引光</a></nav>
      <button id="daily">立即签到</button>
    `;
    const log = { push: vi.fn() };
    realClick.mockClear();
    // 点了签到就把按钮换成已签到态
    document.getElementById('daily')!.addEventListener('click', () => {
      document.getElementById('daily')!.outerHTML = '<button disabled>今日已签到</button>';
    });
    realClick.mockImplementation(async (el: HTMLElement) => { el.click(); });

    await runLeileiDaily(site(), log);

    expect(log.push).toHaveBeenCalledWith(expect.stringContaining('每日签到已确认完成'));
    realClick.mockResolvedValue(undefined);
  }, 10_000);
});

describe('抽奖页', () => {
  it('已抽过时直接返回 already，不重复点击', async () => {
    atPath('/lottery');
    document.body.innerHTML = '<div>今日已抽奖</div>';
    const log = { push: vi.fn() };
    realClick.mockClear();

    const result = await runLeileiDaily(site(), log);

    expect(result).toMatchObject({ status: 'already' });
    expect(realClick).not.toHaveBeenCalled();
  });

  it('找不到抽奖方块时，失败原因里列出页面上实际有什么', async () => {
    atPath('/lottery');
    document.body.innerHTML = `
      <nav><a href="/profile">个人资料</a></nav>
      <button>抽奖记录</button>
    `;
    const log = { push: vi.fn() };

    const result = await runLeileiDaily(site(), log);

    expect(result.status).toBe('failed');
    // 只说「未找到」帮不上忙 —— 必须列出候选
    expect(result.status === 'failed' && result.message).toContain('抽奖记录');
    // 这条走的是真实的 12 秒 ACTION_TIMEOUT_MS 等待（墙钟，mock sleep 绕不过），
    // 给足超时；它锁的正是"等满超时后错误信息是否可用"。
  }, 20_000);
});

describe('同源门禁', () => {
  it('非 fapi.leileihog.top 上拒绝执行', async () => {
    vi.stubGlobal('location', new URL('https://evil.example.com/profile'));
    const log = { push: vi.fn() };

    const result = await runLeileiDaily(site(), log);

    expect(result).toMatchObject({ status: 'failed' });
    expect(result.status === 'failed' && result.message).toContain('仅允许在 fapi.leileihog.top');
  });
});
