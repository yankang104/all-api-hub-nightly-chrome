/**
 * 公告清理的 DOM 回归测试。
 *
 * 起点是一次真实失败（2026-08-26，nova.vcrauo.com「系统公告」）：
 * 弹窗底部只有一个写着「关闭」的按钮，既没有右上角 X、也没有 aria-label
 * 或 close 类名。CSS 词表和语义词表同时扑空，日志一路写「未发现公告弹窗」，
 * 公告却一直盖在签到按钮上 —— 用户报的就是「识别不到公告，也无法关闭公告」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dismissAnnouncements } from '@/automation/shared/announcements';
import type { SiteConfig } from '@/types';

const site: SiteConfig = {
  id: 'site-1',
  name: 'Orbelis',
  loginUrl: 'https://nova.vcrauo.com/sign-in',
  selectors: { username: 'input[name="username"]', password: 'input[name="password"]', submit: 'button[type="submit"]' },
  closeModalSelectors: [],
};

/** jsdom 的 getBoundingClientRect 恒返回 0，可见性判定必须自己喂尺寸 */
function stubRect(el: Element, rect: Partial<DOMRect>): void {
  // 只喂 width/height 时，right/bottom 也要跟着算出来 ——
  // isExposedLayer / elementBlocking 用 rect.right/bottom 判遮挡，
  // 留 0 会把 480px 的弹窗当成「宽度为 0」直接判无遮挡。
  const width = rect.width ?? 0;
  const height = rect.height ?? 0;
  const left = rect.left ?? 0;
  const top = rect.top ?? 0;
  el.getBoundingClientRect = () => ({
    x: left, y: top, top, left,
    right: rect.right ?? left + width,
    bottom: rect.bottom ?? top + height,
    width, height,
    toJSON: () => ({}),
  }) as DOMRect;
}

/** 整棵子树都给一个非零尺寸，免得每个节点单独打桩 */
function stubVisibleTree(root: Element, rect: Partial<DOMRect>): void {
  stubRect(root, rect);
  for (const el of root.querySelectorAll('*')) stubRect(el, { width: 80, height: 32 });
}
/**
 * 补上 `document.elementFromPoint`。
 *
 * 落点校验（`usableCloseButton`、`catchesPointer`）会问「这个坐标上实际
 * 是谁」，用来确认按钮没被别的层盖住。jsdom 没有实现这个 API，直接调用会
 * 抛 `not a function` 并中断整次清理。
 *
 * 这里的实现按「后插入的元素在上层」做命中：取所有已打桩矩形的元素，
 * 从后往前找第一个包含该点的。这正好对应测试里「弹窗盖在签到按钮上」的
 * DOM 顺序，也符合浏览器里最内层优先的语义。
 *
 * 注意 `stubRect` 只保证 `width/height`，`left/top/right/bottom` 默认是 0，
 * 所以这里必须用 `left + width` 自己算右边界，不能直接读 `rect.right`。
 */
function stubElementFromPoint(): void {
  const hit = (x: number, y: number): Element | null => {
    const all = [...document.querySelectorAll('*')].reverse();
    for (const el of all) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const right = rect.left + rect.width;
      const bottom = rect.top + rect.height;
      if (x >= rect.left && x <= right && y >= rect.top && y <= bottom) return el;
    }
    return null;
  };
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    writable: true,
    value: hit,
  });
}

function makeLog(): { push: (msg: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { push: (msg: string) => { lines.push(msg); }, lines };
}

beforeEach(() => {
  document.body.innerHTML = '';
  Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  // jsdom 未实现 scrollIntoView；realClick 会调用它（滚动到目标再点），
  // 不桩会抛 not a function。这里 no-op 即可：
  // 目标本来就在视口内的测试场景，滚动不影响后续坐标判定。
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value() {},
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  delete (Element.prototype as Partial<Element>).scrollIntoView;
});
beforeEach(() => {
  stubElementFromPoint();
});

describe('dismissAnnouncements — 只有「关闭」按钮的公告', () => {
  it('关掉底部只写「关闭」的公告按钮', async () => {
    document.body.innerHTML = `
      <button id="checkin">立即签到</button>
      <div id="mask" class="fixed inset-0 bg-black/50">
        <div role="dialog" aria-modal="true" id="dialog">
          <h2>系统公告</h2>
          <p>本站所有的福利和通知以及售后服务都在以上三群进行处理</p>
          <button id="close">关闭</button>
        </div>
      </div>`;

    const mask = document.getElementById('mask')!;
    stubVisibleTree(mask, { width: 1280, height: 800 });
    stubRect(document.getElementById('dialog')!, { width: 480, height: 620 });
    stubRect(document.getElementById('checkin')!, { width: 120, height: 36 });

    // 站点的关闭按钮真会移除弹窗；这里照样模拟，否则「没消失」会中断清理
    document.getElementById('close')!.addEventListener('click', () => mask.remove());

    const log = makeLog();
    const result = await dismissAnnouncements(site, log);
    
    expect(result.closed).toBe(1);
    expect(result.blocked).toBe(false);
    expect(document.getElementById('mask')).toBeNull();
    expect(log.lines).toContain('关闭了 1 个公告/弹窗');
    expect(log.lines).not.toContain('未发现公告弹窗');
  });

  it('「关闭」按钮点了没反应时按 Esc 兜底', async () => {
    document.body.innerHTML = `
      <button id="checkin">立即签到</button>
      <div id="mask" class="fixed inset-0">
        <div role="dialog" aria-modal="true" id="dialog">
          <h2>系统公告</h2>
          <button id="close">关闭</button>
        </div>
      </div>`;

    const mask = document.getElementById('mask')!;
    stubVisibleTree(mask, { width: 1280, height: 800 });
    stubRect(document.getElementById('dialog')!, { width: 480, height: 620 });
    stubRect(document.getElementById('checkin')!, { width: 120, height: 36 });

    // Radix 的默认行为：document 上的 Esc 关闭对话框
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') mask.remove();
    });

    const log = makeLog();
    const result = await dismissAnnouncements(site, log);
    
    expect(result.blocked).toBe(false);
    expect(document.getElementById('mask')).toBeNull();
    // 新文案把「为什么改用 Esc」说清楚了：按钮点过但没生效，不是词表没命中。
    expect(log.lines.some((line) => line.includes('尝试一次 Esc'))).toBe(true);
    expect(log.lines).toContain('已用 Esc 关闭挡住页面的公告弹窗');
  });

  it('签到按钮在弹窗里时既不点「关闭」也不按 Esc', async () => {
    document.body.innerHTML = `
      <div id="mask" class="fixed inset-0">
        <div role="dialog" aria-modal="true" id="dialog">
          <h2>每日签到</h2>
          <button id="checkin">立即签到</button>
          <button id="close">关闭</button>
        </div>
      </div>`;

    const mask = document.getElementById('mask')!;
    stubVisibleTree(mask, { width: 1280, height: 800 });
    stubRect(document.getElementById('dialog')!, { width: 480, height: 400 });

    const escaped = vi.fn();
    document.addEventListener('keydown', escaped);
    const pressEscapeSpy = vi.spyOn(await import('@/automation/shared/dom-utils'), 'pressEscape');
    const log = makeLog();
    const result = await dismissAnnouncements(site, log);

    expect(result.closed).toBe(0);
    expect(result.keptFunctional).toBeGreaterThan(0);
    expect(document.getElementById('mask')).not.toBeNull();
    expect(escaped).not.toHaveBeenCalled();
    expect(log.lines.some((line) => line.includes('含登录/签到控件的弹窗'))).toBe(true);
  });

  it('普通页面上的「关闭」按钮不当公告点掉', async () => {
    // 折叠面板、消息条上的「关闭」到处都有；页面没有弹窗时一个都不该动
    document.body.innerHTML = `
      <button id="collapse">关闭</button>
      <button id="checkin">立即签到</button>`;
    stubRect(document.getElementById('collapse')!, { width: 80, height: 32 });
    stubRect(document.getElementById('checkin')!, { width: 120, height: 36 });

    const clicked = vi.fn();
    document.getElementById('collapse')!.addEventListener('click', clicked);

    const log = makeLog();
    const result = await dismissAnnouncements(site, log);
    
    expect(result.closed).toBe(0);
    expect(clicked).not.toHaveBeenCalled();
    expect(log.lines).toContain('未发现公告弹窗');
  });

  it('pointer-events: none 的铺满层不算遮罩', async () => {
    // toast 容器、装饰性渐变、Radix 的 portal 根都写成 `fixed inset-0`，
    // 但它们挡不住点击。误判会反复报遮罩并白按 Esc。
    document.body.innerHTML = `
      <div id="toast" class="fixed inset-0" style="pointer-events: none"></div>
      <button id="checkin">立即签到</button>`;
    stubRect(document.getElementById('toast')!, { width: 1280, height: 800 });
    stubRect(document.getElementById('checkin')!, { width: 120, height: 36 });

    const escaped = vi.fn();
    document.addEventListener('keydown', escaped);

    const log = makeLog();
    const result = await dismissAnnouncements(site, log);
    
    expect(result.blocked).toBe(false);
    expect(escaped).not.toHaveBeenCalled();
    expect(log.lines).toContain('未发现公告弹窗');
  });

  it('把只占三分之一视口的 aria-modal 弹窗也算作遮挡', async () => {
    // 旧实现要求铺满 60% 宽 × 40% 高才算遮罩：480px 的公告卡片在 1280px
    // 视口里只占 37%，于是「有遮罩」这件事整个漏判。
    document.body.innerHTML = `
      <div role="dialog" aria-modal="true" id="dialog">
        <h2>系统公告</h2>
        <p>最新平台更新和通知</p>
      </div>
      <button id="checkin">立即签到</button>`;
    stubVisibleTree(document.getElementById('dialog')!, { width: 480, height: 620 });
    stubRect(document.getElementById('checkin')!, { width: 120, height: 36 });

    const log = makeLog();
    const result = await dismissAnnouncements(site, log);
    expect(result.blocked).toBe(true);
    // 新文案聚焦「关不掉」的动作事实：没有可用按钮、Esc 也没用。
    // 「签到会被挡住」的后果提示已上移到 click-safety 的调用方日志。
    expect(log.lines.some((line) => line.includes('Esc 也未解除遮挡'))).toBe(true);
  });

  it('整页外壳被判成遮罩时不按 Esc', async () => {
    // 不少 SPA 把应用外壳写成 `fixed inset-0 overflow-auto`：铺满视口、
    // 也接收点击，但页面本来就长这样。对着它按 Esc 关不掉任何东西，
    // 反而可能把站点自己打开的下拉菜单收起来。
    document.body.innerHTML = `
      <div id="shell" class="fixed inset-0 overflow-auto">
        <button id="checkin">立即签到</button>
      </div>`;
    stubVisibleTree(document.getElementById('shell')!, { width: 1280, height: 800 });

    const escaped = vi.fn();
    document.addEventListener('keydown', escaped);

    const log = makeLog();
    await dismissAnnouncements(site, log);

    expect(escaped).not.toHaveBeenCalled();
    expect(log.lines.some((line) => line.includes('Esc'))).toBe(false);
    // 整页外壳里含签到按钮，会被当成功能弹窗保留 —— 这正是「不按 Esc」的原因，
    // 比旧文案「不像可关闭的弹窗」更直接地说出了判据。
    expect(log.lines.some((line) => line.includes('含登录/签到控件的弹窗'))).toBe(true);
  });
});

describe('dismissAnnouncements — Motomoto 无语义标记的 Tailwind 自定义弹窗', () => {
  // 复刻 motomoto.lol「系统公告」：遮罩是 `fixed inset-0 bg-black/50`，
  // 内容卡片没有任何 dialog/role/aria-modal/框架类名标记，右上角「×」、
  // 右下角「今日不再显示」「我已知悉」。签到按钮在遮罩之外、被遮罩盖住。
  it('内容卡片是遮罩的兄弟层时也能收集并关闭公告', async () => {
    document.body.innerHTML = `
      <button id="checkin">立即签到</button>
      <div id="mask" class="fixed inset-0 bg-black/50"></div>
      <div id="card">
        <h2>系统公告</h2>
        <p>频繁 502 是违规请求触发官网限流</p>
        <button id="x">×</button>
        <button id="later">今日不再显示</button>
        <button id="known">我已知悉</button>
      </div>`;

    const mask = document.getElementById('mask')!;
    const card = document.getElementById('card')!;
    stubRect(mask, { width: 1280, height: 800 });
    stubRect(document.getElementById('checkin')!, { left: 20, top: 20, width: 120, height: 36 });
    // 卡片盖在遮罩中心，被 elementFromPoint 命中 → 认出它是「盖在遮罩之上的内容层」
    stubRect(card, { left: 400, top: 150, width: 480, height: 460 });
    stubRect(document.getElementById('x')!, { left: 840, top: 160, width: 32, height: 32 });
    stubRect(document.getElementById('later')!, { left: 460, top: 540, width: 150, height: 40 });
    stubRect(document.getElementById('known')!, { left: 660, top: 540, width: 150, height: 40 });

    // 站点关公告会把整层弹窗（遮罩+卡片）一起移除
    const teardown = () => { mask.remove(); card.remove(); };
    document.getElementById('later')!.addEventListener('click', teardown);
    document.getElementById('known')!.addEventListener('click', teardown);
    document.getElementById('x')!.addEventListener('click', teardown);

    const log = makeLog();
    const result = await dismissAnnouncements(site, log);

    expect(result.closed).toBeGreaterThanOrEqual(1);
    expect(result.blocked).toBe(false);
    expect(document.getElementById('mask')).toBeNull();
    expect(log.lines).not.toContain('未发现公告弹窗');
    expect(log.lines.some((line) => line.includes('没有可安全点击的公告关闭按钮'))).toBe(false);
  });

  it('内容卡片是遮罩的后代时也能收集并关闭公告', async () => {
    document.body.innerHTML = `
      <button id="checkin">立即签到</button>
      <div id="mask" class="fixed inset-0 bg-black/50">
        <div id="card">
          <h2>系统公告</h2>
          <p>频繁 502 是违规请求触发官网限流</p>
          <button id="x">×</button>
          <button id="later">今日不再显示</button>
          <button id="known">我已知悉</button>
        </div>
      </div>`;

    const mask = document.getElementById('mask')!;
    stubRect(mask, { width: 1280, height: 800 });
    stubRect(document.getElementById('checkin')!, { left: 20, top: 20, width: 120, height: 36 });
    stubRect(document.getElementById('card')!, { left: 400, top: 150, width: 480, height: 460 });
    stubRect(document.getElementById('x')!, { left: 840, top: 160, width: 32, height: 32 });
    stubRect(document.getElementById('later')!, { left: 460, top: 540, width: 150, height: 40 });
    stubRect(document.getElementById('known')!, { left: 660, top: 540, width: 150, height: 40 });

    document.getElementById('later')!.addEventListener('click', () => mask.remove());
    document.getElementById('known')!.addEventListener('click', () => mask.remove());
    document.getElementById('x')!.addEventListener('click', () => mask.remove());

    const log = makeLog();
    const result = await dismissAnnouncements(site, log);

    expect(result.closed).toBeGreaterThanOrEqual(1);
    expect(result.blocked).toBe(false);
    expect(document.getElementById('mask')).toBeNull();
    expect(log.lines).not.toContain('未发现公告弹窗');
    expect(log.lines.some((line) => line.includes('没有可安全点击的公告关闭按钮'))).toBe(false);
  });

  it('无标记卡片里含签到按钮时保留功能弹窗、不关不按 Esc', async () => {
    // 同样是无语义标记的自定义弹窗，但卡片里有签到按钮 → 必须保留
    document.body.innerHTML = `
      <div id="mask" class="fixed inset-0 bg-black/50"></div>
      <div id="card">
        <h2>每日签到</h2>
        <button id="checkin">立即签到</button>
        <button id="close">关闭</button>
      </div>`;

    const mask = document.getElementById('mask')!;
    stubRect(mask, { width: 1280, height: 800 });
    stubRect(document.getElementById('card')!, { left: 400, top: 200, width: 480, height: 320 });
    stubRect(document.getElementById('checkin')!, { left: 460, top: 440, width: 150, height: 40 });
    stubRect(document.getElementById('close')!, { left: 820, top: 210, width: 60, height: 32 });

    const escaped = vi.fn();
    document.addEventListener('keydown', escaped);
    const closed = vi.fn();
    document.getElementById('close')!.addEventListener('click', closed);

    const log = makeLog();
    const result = await dismissAnnouncements(site, log);

    expect(result.closed).toBe(0);
    expect(result.keptFunctional).toBeGreaterThan(0);
    expect(closed).not.toHaveBeenCalled();
    expect(escaped).not.toHaveBeenCalled();
    expect(document.getElementById('mask')).not.toBeNull();
    expect(log.lines.some((line) => line.includes('含登录/签到控件的弹窗'))).toBe(true);
  });

  it('无标记卡片的关闭按钮点了没反应时按 Esc 兜底', async () => {
    document.body.innerHTML = `
      <button id="checkin">立即签到</button>
      <div id="mask" class="fixed inset-0 bg-black/50"></div>
      <div id="card">
        <h2>系统公告</h2>
        <button id="known">我已知悉</button>
      </div>`;

    const mask = document.getElementById('mask')!;
    const card = document.getElementById('card')!;
    stubRect(mask, { width: 1280, height: 800 });
    stubRect(document.getElementById('checkin')!, { left: 20, top: 20, width: 120, height: 36 });
    stubRect(card, { left: 400, top: 200, width: 480, height: 320 });
    stubRect(document.getElementById('known')!, { left: 560, top: 440, width: 150, height: 40 });

    // 点「我已知悉」不生效（无 handler）；Esc 才真正关闭
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { mask.remove(); card.remove(); }
    });

    const log = makeLog();
    const result = await dismissAnnouncements(site, log);

    expect(result.blocked).toBe(false);
    expect(document.getElementById('mask')).toBeNull();
    expect(log.lines).toContain('已用 Esc 关闭挡住页面的公告弹窗');
  });
});
