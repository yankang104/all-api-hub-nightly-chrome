/**
 * 选择器漂移的**容错**回归：跨选择器回退（`workflow.ts` 的 rescueByFingerprint）。
 *
 * 用户原话：「我最终要实现完美的学习功能，后实现自动化签到，适配任何站点。」
 * 站点改版后选择器常常**一个都命不中**（class 哈希变了、id 重命名、`:nth-of-type`
 * 因列表增删而错位）。旧行为是直接报「找不到可点击元素」——检测到了漂移，却没有自救。
 *
 * 本文件锁定回退层的**安全边界**，而不只是「能找回来」：
 *  1. 选择器全落空 + 指纹带**强身份字段**（testId/name/aria）且唯一 → 找回该元素；
 *  2. 指纹只有 `tag + text` 时允许严格匹配的唯一交互控件回退；只有种类仍拒绝；
 *  3. 多个候选同时满分匹配 → **拒绝**回退（绝不按文档顺序猜），并且**一个都不点**；
 *  4. 页面里根本没有匹配元素 → **拒绝**回退，且**一个都不点**；
 *  5. 回退命中仍要过共享的指纹核验，选择器还有效时**永远不会**走到回退（正常路径零影响）。
 *
 * mock 口径与 workflow-replay-click-audit.test.ts 一致：importActual 保留**真实**的
 * 选择器解析与指纹比对，只把 `sleep` 换成同步实现（回退重试有界但不真等 3 秒）、
 * `waitFor` 换成「立刻按真实 queryFirst 判一次」。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/automation/shared/dom-utils', async () => {
  const actual = await vi.importActual<typeof import('@/automation/shared/dom-utils')>(
    '@/automation/shared/dom-utils',
  );
  return {
    // 保留真实的选择器解析与指纹比对（被测逻辑就在这里），只替换副作用与等待。
    ...actual,
    sleep: vi.fn().mockResolvedValue(undefined),
    // 不空等元素超时：每次探测都按真实解析判定一次。
    waitFor: vi.fn(async (selector: string) => actual.queryFirst(selector)),
    // 点击/填写的副作用换成 spy：本文件断言的是「回退层选中了哪个元素」，
    // 不是真实指针派发（那由 dom-utils 自己的测试覆盖）。
    realClick: vi.fn().mockResolvedValue('dom'),
    fillEditable: vi.fn(),
  };
});

vi.mock('@/automation/shared/click-safety', () => ({
  clearClickBlocker: vi.fn().mockResolvedValue(null),
}));

import * as domUtils from '@/automation/shared/dom-utils';
import { realClick, fillEditable } from '@/automation/shared/dom-utils';
import { clearClickBlocker } from '@/automation/shared/click-safety';
import { runCheckinWorkflow } from '@/automation/learning/workflow';
import type { SiteConfig, WorkflowElementFingerprint } from '@/types';

/**
  * 遮挡校验用的 elementFromPoint 替身容器。
  *
  * 用对象包一层而不是裸变量：裸变量在整个文件里只被读取时，TS 会把它的类型
  * 收窄成 never，闭包里调用会报「not callable」。
  */
 const elementFromPointStub: { impl: ((x: number, y: number) => Element | null) | null } = { impl: null };

const site: SiteConfig = {
  id: 'hostile',
  name: '对抗性站点',
  loginUrl: `${window.location.origin}/hostile`,
  selectors: { username: '#user', password: '#pass', submit: '#submit' },
  closeModalSelectors: [],
};

/** 只收集日志的 StepLog 桩，断言按「有没有这一行」做。 */
function makeLog(): { lines: string[]; push: (line: string) => void } {
  const lines: string[] = [];
  return { lines, push: (line: string) => { lines.push(line); } };
}

beforeAll(() => {
  // jsdom 没有布局引擎：给所有元素非零矩形，让 isVisible 按真实逻辑判可见。
  Element.prototype.getBoundingClientRect = function rect(): DOMRect {
    return {
      x: 0, y: 0, width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20,
      toJSON: () => ({}),
    } as DOMRect;
  };
  // jsdom 不实现 innerText（恒为 undefined），而指纹的 text 读的就是它。
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true,
    get(this: HTMLElement) { return this.textContent ?? ''; },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: () => {},
  });
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: (x: number, y: number) => elementFromPointStub.impl?.(x, y) ?? null,
  });
});

beforeEach(() => {
  window.history.replaceState({}, '', '/hostile');
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

afterEach(() => {
  document.body.innerHTML = '';
});

/* ------------------------------------------------------------------ *
 * 一、选择器全落空 → 指纹回退把控件找回来
 * ------------------------------------------------------------------ */

describe('选择器漂移回退：找回当初录到的那个控件', () => {
  it('class 哈希改名 + tag/文案唯一匹配：允许回退到真实按钮', async () => {
    // 录制时 `.claim_a1b2c3` 指向「立即签到」按钮；站点改版后 class 哈希整体改名。
    // 没有 testId/name/aria 的真实站点也应能恢复，但仍要求唯一且所有已录字段匹配。
    document.body.innerHTML = `
      <div id="panel">
        <button class="claim_9f8e7a">立即签到</button>
        <button class="help_9f8e7a">帮助</button>
      </div>`;
    const log = makeLog();

    const result = await runCheckinWorkflow(site, {
      steps: [{
        type: 'click',
        selector: '.claim_a1b2c3',
        timeoutMs: 0,
        fingerprint: { tag: 'button', text: '立即签到' } satisfies WorkflowElementFingerprint,
      }],
    }, log);

    expect(realClick).toHaveBeenCalledWith(document.querySelector('.claim_9f8e7a'), { mayNavigate: false });
    expect(result.status).not.toBe('failed');
    expect(log.lines.some((line) => line.includes('原选择器失效，已按指纹回退到'))).toBe(true);
  });

  it('class 哈希改名 + data-testid 唯一匹配：按强身份字段回退命中并点击', async () => {
    // 与上一条同一漂移形态，但录制时留下了 data-testid —— 强身份字段全字段匹配后才允许回退。
    document.body.innerHTML = `
      <div id="panel">
        <button class="claim_9f8e7a" data-testid="claim-btn">立即签到</button>
        <button class="help_9f8e7a">帮助</button>
      </div>`;
    const target = document.querySelector<HTMLButtonElement>('[data-testid="claim-btn"]')!;
    const log = makeLog();

    const result = await runCheckinWorkflow(site, {
      steps: [{
        type: 'click',
        selector: '.claim_a1b2c3',
        timeoutMs: 0,
        fingerprint: { tag: 'button', testId: 'claim-btn', text: '立即签到' } satisfies WorkflowElementFingerprint,
      }],
    }, log);

    expect(realClick).toHaveBeenCalledTimes(1);
    expect(realClick).toHaveBeenCalledWith(target, { mayNavigate: false });
    expect(log.lines.some((line) => line.includes('原选择器失效，已按指纹回退到'))).toBe(true);
    expect(result).not.toEqual({ status: 'failed', message: '工作流找不到可点击元素: .claim_a1b2c3' });
  });

  it('没有 testId、只有 aria 强字段唯一匹配：同样允许回退并点击', async () => {
    document.body.innerHTML = `
      <div id="panel">
        <button aria-label="立即签到">立即签到</button>
        <button aria-label="查看帮助">查看帮助</button>
      </div>`;
    const target = document.querySelector<HTMLButtonElement>('[aria-label="立即签到"]')!;
    const log = makeLog();

    const result = await runCheckinWorkflow(site, {
      steps: [{
        type: 'click',
        selector: '.claim_a1b2c3',
        timeoutMs: 0,
        fingerprint: { tag: 'button', aria: '立即签到', text: '立即签到' } satisfies WorkflowElementFingerprint,
      }],
    }, log);

    expect(realClick).toHaveBeenCalledTimes(1);
    expect(realClick).toHaveBeenCalledWith(target, { mayNavigate: false });
    expect(result).not.toEqual({ status: 'failed', message: '工作流找不到可点击元素: .claim_a1b2c3' });
  });

  it(':nth-of-type 因列表增删错位：选择器命中了**别人**，指纹把它纠正回当初那一项', async () => {
    // 录制时列表是 [目标, 帮助]，学习产物是位置路径 `#slots > button:nth-of-type(1)`；
    // 回放时前面**插入**了一项，同一个位置路径现在指向新插入的那一项。
    document.body.innerHTML = `
      <div id="slots">
        <button>新插入的项</button>
        <button data-testid="target">目标</button>
        <button>帮助</button>
      </div>`;
    const target = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.dataset.testid === 'target',
    )!;
    const misplaced = document.querySelector<HTMLButtonElement>('#slots > button:nth-of-type(1)')!;
    // 前置断言：位置路径确实指到了别人（这就是「漂移」本身）
    expect(misplaced).not.toBe(target);
    const log = makeLog();

    const result = await runCheckinWorkflow(site, {
      steps: [{
        type: 'click',
        selector: '#slots > button:nth-of-type(1)',
        timeoutMs: 0,
        fingerprint: { tag: 'button', testId: 'target', text: '目标' } satisfies WorkflowElementFingerprint,
      }],
    }, log);

    expect(realClick).toHaveBeenCalledTimes(1);
    expect(realClick).toHaveBeenCalledWith(target, { mayNavigate: false });
    expect(log.lines.some((line) => line.includes('指纹失配'))).toBe(true);
    expect(log.lines.some((line) => line.includes('原选择器失效，已按指纹回退到'))).toBe(true);
    expect(result).not.toEqual({ status: 'failed', message: expect.stringContaining('命中了错误的元素') });
  });

  it('长文案（>80 字符、含动态日期）在强字段匹配时：文本按前缀/包含容忍，回退仍成功', async () => {
    // 采集侧把 text 截到 80 字符，回放时站点把倒计时/日期插进文案，实际文本更长。
    const actualText = '每日签到第 12 天 · 2026-10-17 · 连续签到可领取更多奖励 · 立即签到领取今日积分和成长值 · 请勿错过 · 奖励会随连续天数增长 · 还有更多说明文字保证超过八十个字符长度';
    const recordedText = actualText.slice(0, 80);
    expect(actualText.length).toBeGreaterThan(80);
    expect(actualText).not.toBe(recordedText);
    expect(actualText.startsWith(recordedText)).toBe(true);

    document.body.innerHTML = `<button data-testid="daily-claim" aria-label="每日签到">${actualText}</button>`;
    const target = document.querySelector<HTMLButtonElement>('[data-testid="daily-claim"]')!;
    const log = makeLog();

    const result = await runCheckinWorkflow(site, {
      steps: [{
        type: 'click',
        selector: '#old-daily-claim',
        timeoutMs: 0,
        fingerprint: {
          tag: 'button', testId: 'daily-claim', aria: '每日签到', text: recordedText,
        } satisfies WorkflowElementFingerprint,
      }],
    }, log);

    expect(realClick).toHaveBeenCalledTimes(1);
    expect(realClick).toHaveBeenCalledWith(target, { mayNavigate: false });
    expect(log.lines.some((line) => line.includes('原选择器失效，已按指纹回退到'))).toBe(true);
    expect(result).not.toEqual({ status: 'failed', message: '工作流找不到可点击元素: #old-daily-claim' });
  });

  it('填充漂移：选择器落空时按指纹回退到正确的输入框并写入', async () => {
    document.body.innerHTML = `
      <form>
        <input type="text" name="nickname">
        <textarea name="claim-reason-v2"></textarea>
      </form>`;
    const target = document.querySelector<HTMLTextAreaElement>('textarea')!;
    const log = makeLog();

    await runCheckinWorkflow({
      ...site,
      checkin: { method: 'workflow', claimText: '感谢站点' },
    }, {
      steps: [{
        type: 'fill',
        selector: '[name="claim-reason"]',
        value: '{{claimText}}',
        timeoutMs: 0,
        fingerprint: {
          tag: 'textarea', name: 'claim-reason-v2', inputType: 'textarea',
        } satisfies WorkflowElementFingerprint,
      }],
    }, log);

    expect(fillEditable).toHaveBeenCalledWith(target, '感谢站点');
    expect(log.lines.some((line) => line.includes('原选择器失效，已按指纹回退到'))).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 二、负例：宁可报找不到，也绝不乱点
 * ------------------------------------------------------------------ */

describe('回退的安全边界：找不到/不唯一时绝不下手', () => {
  it('指纹只有 tag（弱字段）：拒绝回退，一个都不点', async () => {
    document.body.innerHTML = '<button class="x1">开始</button><button class="x2">结束</button>';
    const log = makeLog();

    const result = await runCheckinWorkflow(site, {
      steps: [{
        type: 'click',
        selector: '.gone',
        timeoutMs: 0,
        fingerprint: { tag: 'button' } satisfies WorkflowElementFingerprint,
      }],
    }, log);

    expect(realClick).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'failed', message: '工作流找不到可点击元素: .gone' });
    expect(log.lines.some((line) => line.includes('无法确认是同一个控件，不做跨选择器回退'))).toBe(true);
  });

  it('多个同名候选同时满分匹配：拒绝按文档顺序猜，一个都不点', async () => {
    document.body.innerHTML = `
      <button data-testid="check-in">签到</button><button data-testid="check-in">签到</button><button data-testid="check-in">签到</button>`;
    const log = makeLog();

    const result = await runCheckinWorkflow(site, {
      steps: [{
        type: 'click',
        selector: '.gone',
        timeoutMs: 0,
        fingerprint: { tag: 'button', testId: 'check-in', text: '签到' } satisfies WorkflowElementFingerprint,
      }],
    }, log);

    expect(realClick).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(log.lines.some((line) => line.includes('无法确定唯一目标'))).toBe(true);
  });

  it('页面里根本没有匹配元素：如实报找不到，一个都不点', async () => {
    document.body.innerHTML = '<button>删除账号</button><button>退出登录</button>';
    const log = makeLog();

    const result = await runCheckinWorkflow(site, {
      steps: [{
        type: 'click',
        selector: '.gone',
        timeoutMs: 0,
        fingerprint: { tag: 'button', testId: 'claim-now', text: '立即签到' } satisfies WorkflowElementFingerprint,
      }],
    }, log);

    expect(realClick).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'failed', message: '工作流找不到可点击元素: .gone' });
    expect(log.lines.some((line) => line.includes('按指纹回退搜索没有找到匹配元素'))).toBe(true);
  });

  it('指纹写的字段必须全部匹配：只对上文字、对不上 tag 的候选不算命中', async () => {
    // 页面里有同文案的元素，但强身份字段对不上；回退只扫可交互元素，且全部写了的字段一致才算命中。
    document.body.innerHTML = '<div role="none">立即签到</div><a href="/help" data-testid="help-link">立即签到</a>';
    const log = makeLog();

    const result = await runCheckinWorkflow(site, {
      steps: [{
        type: 'click',
        selector: '.gone',
        timeoutMs: 0,
        fingerprint: { tag: 'button', testId: 'claim-now', text: '立即签到' } satisfies WorkflowElementFingerprint,
      }],
    }, log);

    expect(realClick).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
  });

  it('回退命中的元素仍要过共享的遮挡校验：清不掉的遮挡照样停下', async () => {
    document.body.innerHTML = '<button data-testid="claim-now">立即签到</button>';
    const blocker = document.createElement('div');
    vi.mocked(clearClickBlocker).mockResolvedValueOnce(blocker);
    const log = makeLog();

    const result = await runCheckinWorkflow(site, {
      steps: [{
        type: 'click',
        selector: '.gone',
        timeoutMs: 0,
        fingerprint: { tag: 'button', testId: 'claim-now', text: '立即签到' } satisfies WorkflowElementFingerprint,
      }],
    }, log);

    expect(realClick).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'failed',
      message: '工作流点击目标仍被遮挡，可能有未关闭的公告弹窗',
    });
  });
});

/* ------------------------------------------------------------------ *
 * 三、正常路径零影响：选择器还指得到时永远走不到回退
 * ------------------------------------------------------------------ */

describe('回退只在失败路径上发生', () => {
  it('选择器有效时直接命中，不进回退层', async () => {
    document.body.innerHTML = '<button id="claim">立即签到</button>';
    const querySpy = vi.spyOn(document, 'querySelectorAll');
    const target = document.querySelector<HTMLButtonElement>('#claim')!;
    const log = makeLog();

    await runCheckinWorkflow(site, {
      steps: [{
        type: 'click',
        selector: '#claim',
        timeoutMs: 0,
        fingerprint: { tag: 'button', text: '立即签到' } satisfies WorkflowElementFingerprint,
      }],
    }, log);

    expect(realClick).toHaveBeenCalledWith(target, { mayNavigate: false });
    // 选择器有效 → 绝不进回退层。回退层成功时必写「原选择器失效，已按指纹回退到」，
    // 用日志判定比 spy document.querySelectorAll 精确：queryFirst/queryAll 内部本来
    // 就要用 querySelectorAll，spy 它只会误报。
    expect(log.lines.some((line) => line.includes('原选择器失效，已按指纹回退到'))).toBe(false);
    expect(log.lines.some((line) => line.includes('无法确认是同一个控件'))).toBe(false);
    querySpy.mockRestore();
  });

  it('没有指纹的老步骤完全维持原语义（只按选择器命中）', async () => {
    document.body.innerHTML = '<button id="claim">立即签到</button>';
    const log = makeLog();

    await runCheckinWorkflow(site, {
      steps: [{ type: 'click', selector: '#claim', timeoutMs: 0 }],
    }, log);

    expect(realClick).toHaveBeenCalledTimes(1);
    expect(log.lines.some((line) => line.includes('回退'))).toBe(false);
    expect(domUtils.queryAll).toBeTypeOf('function');
  });
});
