import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 签到后的余额采样窗口，要按「快照来自接口还是页面正文」区别对待。
 *
 * 这是 1412 上实测到的一个真实矛盾：日志先写「页面出现签到成功提示」，
 * 紧跟着却是「额度无变化，当前余额 $455.70」—— 奖励其实已经到账，只是
 * 页面上那个数字要等 SPA 重新拉一次账户接口才会变，而旧实现在成功路径上
 * 只读 3 轮（约 2.8 秒），窗口内读到的全是签到前的旧值。
 *
 * 接口路径不需要加长：签到请求一返回服务端就是新数，3 轮足够。所以这里锁的
 * 是「两条路径的轮数不同」，而不是笼统地把窗口调大 —— 后者会让每次签到都
 * 白等十秒。
 */

vi.mock('@/automation/shared/dom-utils', async () => {
  const actual = await vi.importActual<typeof import('@/automation/shared/dom-utils')>('@/automation/shared/dom-utils');
  return {
    ...actual,
    sleep: vi.fn().mockResolvedValue(undefined),
    realClick: vi.fn().mockResolvedValue('dom'),
  };
});

vi.mock('@/automation/shared/click-safety', () => ({
  clearClickBlocker: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/automation/balance/balance', async () => {
  const actual = await vi.importActual<typeof import('@/automation/balance/balance')>('@/automation/balance/balance');
  return {
    ...actual,
    captureBalance: vi.fn(),
    diffBalance: vi.fn(),
    describeMetrics: vi.fn().mockReturnValue(''),
  };
});

import { realClick } from '@/automation/shared/dom-utils';
import { captureBalance, diffBalance } from '@/automation/balance/balance';
import { performCheckin } from '@/automation/checkin/checkin';
import type { BalanceSnapshot, SiteConfig } from '@/types';

const site = (): SiteConfig => ({
  id: 'builtin-kid1412',
  name: "1412's API",
  loginUrl: `${window.location.origin}/sign-in`,
  loginMethod: 'github',
  selectors: { username: 'input[name="username"]', password: 'input[name="password"]', submit: 'button[type="submit"]' },
  closeModalSelectors: [],
  checkin: {
    method: 'button',
    buttonSelector: 'button >> text=立即签到, button >> text=签到',
    alreadySelector: 'button >> text=已签到',
    successText: ['签到成功', '今天 +'],
    alreadyText: ['已签到', '今日已签到'],
  },
  adapter: { family: 'new-api', checkinPath: '/profile', quotaPerUnit: 500_000 },
});

const log = { push: vi.fn() };

const snapshot = (overrides: Partial<BalanceSnapshot> = {}): BalanceSnapshot => ({
  quota: 227_850_000,
  usedQuota: 0,
  at: Date.now(),
  ...overrides,
});

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 96, height: 36, top: 0, left: 0, right: 96, bottom: 36, x: 0, y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true,
    get(this: HTMLElement) {
      return this.textContent ?? '';
    },
  });
  window.history.replaceState({}, '', '/profile');

  vi.mocked(diffBalance).mockReturnValue({ verdict: 'unchanged' });
  document.body.innerHTML = `
    <div class="card">
      <button aria-expanded="true">每日签到</button>
      <button class="act">立即签到</button>
    </div>
  `;

  /**
   * 让 realClick 像真站点那样改 DOM。
   *
   * 不能用 addEventListener：realClick 在本文件里被打桩了，它不会真的派发
   * DOM 事件，监听器永远不触发 —— 页面上不出现成功文案，终态就是 failed，
   * 于是走的是失败分支的轮数（8/12），测不到成功路径的窗口。
   */
  vi.mocked(realClick).mockImplementation(async (el: HTMLElement) => {
    el.textContent = '已签到';
    (el as HTMLButtonElement).disabled = true;
    const hit = document.createElement('div');
    hit.textContent = '签到成功 今天 +$5.9500';
    document.querySelector('.card')?.appendChild(hit);
    return 'dom';
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

/** 数出签到之后（即第一次前置采样之后）又读了几轮 */
async function countAfterReads(before: BalanceSnapshot): Promise<number> {
  let calls = 0;
  vi.mocked(captureBalance).mockImplementation(async () => {
    calls += 1;
    return before;
  });
  await performCheckin(site(), log);
  // 第一次是签到前的快照，其余都是签到后的重试
  return calls - 1;
}

describe('签到后的余额采样窗口', () => {
  it('前置快照来自页面正文时读满 10 轮 —— 那个数字要等 SPA 刷新', async () => {
    // 关键回归：旧实现在成功路径上只读 3 轮，窗口内数字还没变，
    // 于是「页面出现签到成功提示」后面紧跟一条「额度无变化」。
    const reads = await countAfterReads(snapshot({ fromVisibleText: true }));
    expect(reads).toBe(10);
  });

  it('前置快照来自接口时仍然只读 3 轮，不白等十秒', async () => {
    // 接口路径不需要加长：签到一返回服务端就是新数。
    // 笼统调大窗口会让每次签到都多等七秒。
    const reads = await countAfterReads(snapshot({ fromVisibleText: false }));
    expect(reads).toBe(3);
  });

  it('没有来源标记的旧快照按接口路径处理，保持原有行为', async () => {
    // 升级前存下的快照没有这个字段，不能因此突然变成十秒窗口
    const reads = await countAfterReads(snapshot());
    expect(reads).toBe(3);
  });

  it('一旦读到额度增加就立刻收工，不把轮数用满', async () => {
    // 正文路径的 10 轮是上限而非固定开销：奖励一到账就该停
    vi.mocked(diffBalance).mockReturnValue({ verdict: 'rewarded', reward: 2_973_248 });
    const reads = await countAfterReads(snapshot({ fromVisibleText: true }));
    expect(reads).toBe(1);
  });

  it('余额前后不变但签到卡出现「今天 +$X」时仍记录本次奖励', async () => {
    const before = snapshot({ quota: 234_265_000, fromVisibleText: true });
    vi.mocked(captureBalance).mockResolvedValue(before);
    vi.mocked(diffBalance).mockReturnValue({
      verdict: 'unchanged',
      reward: 0,
      balanceDelta: 0,
      usageDelta: 0,
      quotaAfter: before.quota,
    });

    const outcome = await performCheckin(site(), log);

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      expect(outcome.metrics?.verdict).toBe('rewarded');
      expect(outcome.metrics?.reward).toBe(5.95 * 500_000);
    }
    expect(log.push).toHaveBeenCalledWith(expect.stringContaining('页面显示本次签到奖励 $5.9500'));
    expect(log.push).not.toHaveBeenCalledWith(expect.stringContaining('额度无变化，当前余额'));
  });

  it('已经显示今日已签到时只采一轮，且不把外部余额增加算成本次奖励', async () => {
    document.body.innerHTML = '<button disabled>已签到</button>';
    const before = snapshot({ quota: 234_265_000, fromVisibleText: true });
    vi.mocked(captureBalance).mockResolvedValue(before);
    vi.mocked(diffBalance).mockReturnValue({
      verdict: 'rewarded',
      reward: 5.95 * 500_000,
      usageDelta: 0,
      quotaAfter: before.quota + 5.95 * 500_000,
    });

    const outcome = await performCheckin(site(), log);

    expect(outcome.status).toBe('already');
    if (outcome.status === 'already') {
      expect(outcome.metrics?.verdict).toBe('unchanged');
      expect(outcome.metrics?.reward).toBe(0);
      expect(outcome.metrics?.source).toBe('checkin-ledger');
    }
    expect(captureBalance).toHaveBeenCalledTimes(2);
    expect(log.push).toHaveBeenCalledWith('命中「已签到」标志，本次不重复点击');
  });

  it('已签到卡片记录「今天 +$X」时展示当天奖励台账', async () => {
    document.body.innerHTML = '<button disabled>已签到</button><div>今天 +$12.0800</div>';
    const before = snapshot({ quota: 240_310_000, fromVisibleText: true });
    vi.mocked(captureBalance).mockResolvedValue(before);
    vi.mocked(diffBalance).mockReturnValue({
      verdict: 'unchanged',
      reward: 0,
      usageDelta: 0,
      quotaAfter: before.quota,
    });

    const outcome = await performCheckin(site(), log);

    expect(outcome.status).toBe('already');
    if (outcome.status === 'already') {
      expect(outcome.metrics?.verdict).toBe('rewarded');
      expect(outcome.metrics?.reward).toBe(12.08 * 500_000);
      expect(outcome.metrics?.source).toBe('checkin-ledger');
    }
    expect(log.push).toHaveBeenCalledWith('页面记录今日签到奖励 $12.0800（本轮未重复点击）');
  });

  it('签到前后都读不到余额时仍返回已签到页面的人民币奖励台账', async () => {
    document.body.innerHTML = '<button disabled>已签到</button><div>今天 +¥10.3100</div>';
    vi.mocked(captureBalance).mockResolvedValue(null);

    const outcome = await performCheckin(site(), log);

    expect(outcome.status).toBe('already');
    if (outcome.status === 'already') {
      expect(outcome.metrics).toMatchObject({
        verdict: 'rewarded',
        reward: 10.31 * 500_000,
        rewardSymbol: '¥',
        source: 'checkin-ledger',
      });
    }
    expect(log.push).toHaveBeenCalledWith('页面记录今日签到奖励 ¥10.3100（本轮未重复点击）');
  });
});

/**
 * 余额落库。界面上「本站余额 未获取」只有一个来源：`KEYS.balances` 里没有值，
 * 而这条路唯一的写入口就是 `hooks.saveBalance`。
 *
 * 这一组锁的都是**曾经真的漏掉过**的情形 —— 之前没有任何测试覆盖这个钩子，
 * 于是签到成功、日志里余额也读到了，界面却一直显示未获取。
 */
describe('签到后余额落库', () => {
  it('读到余额就交给 saveBalance', async () => {
    const after = snapshot({ quota: 230_823_248 });
    vi.mocked(captureBalance).mockResolvedValue(after);
    const saveBalance = vi.fn().mockResolvedValue(undefined);
    await performCheckin(site(), log, { saveBalance });
    expect(saveBalance).toHaveBeenCalledWith(after);
  });

  it('后一轮读失败不能覆盖前一轮读到的值', async () => {
    /**
     * 关键回归。旧实现是 `after = await captureBalance(site)`，最后一轮
     * 返回 null 就把前面读到的值冲掉，`if (after)` 不成立、落库整个跳过 ——
     * 明明日志里写着读到 $455.70，界面上还是「未获取」。
     * 页面正在跳转或 SPA 重渲染时读一次失败很常见。
     */
    const good = snapshot({ quota: 230_823_248, fromVisibleText: true });
    let call = 0;
    vi.mocked(captureBalance).mockImplementation(async () => {
      call += 1;
      // 第一次是签到前快照，第二次读到，之后全部失败
      if (call <= 2) return good;
      return null;
    });
    const saveBalance = vi.fn().mockResolvedValue(undefined);
    await performCheckin(site(), log, { saveBalance });
    expect(saveBalance).toHaveBeenCalledWith(good);
  });

  it('签到前读不到余额，签到后读到了也要落库', async () => {
    /**
     * 另一条关键回归。整段落库原先挂在 `if (... && before && ...)` 里，
     * 签到前读不到就连签到后的值一起跳过。而签到前读不到是常事：
     * 落地页上没有余额、接口还缺 user-id 头而 401 —— 偏偏签到页上读得到。
     */
    const after = snapshot({ quota: 230_823_248 });
    let call = 0;
    vi.mocked(captureBalance).mockImplementation(async () => {
      call += 1;
      return call === 1 ? null : after;
    });
    const saveBalance = vi.fn().mockResolvedValue(undefined);
    await performCheckin(site(), log, { saveBalance });
    expect(saveBalance).toHaveBeenCalledWith(after);
  });

  it('签到前读不到时，一读到就收工，不白等剩下几轮', async () => {
    let calls = 0;
    vi.mocked(captureBalance).mockImplementation(async () => {
      calls += 1;
      return calls === 1 ? null : snapshot();
    });
    await performCheckin(site(), log, { saveBalance: vi.fn() });
    // 1 次前置（null）+ 1 次读到就停
    expect(calls).toBe(2);
  });

  it('签到前读不到时仍可用新出现的奖励文案确认，不冒充余额差分', async () => {
    let call = 0;
    vi.mocked(captureBalance).mockImplementation(async () => {
      call += 1;
      return call === 1 ? null : snapshot();
    });
    const outcome = await performCheckin(site(), log, { saveBalance: vi.fn() });
    // 差分压根没跑，但点击后明确出现了「今天 +$5.95」，这是一条独立的
    // 成功证据，应该记录奖励而不是把它误报成额度无变化。
    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      expect(outcome.metrics?.verdict).toBe('rewarded');
      expect(outcome.metrics?.reward).toBe(5.95 * 500_000);
    }
  });

  it('签到前后余额始终读不到时仍保留点击后出现的人民币奖励', async () => {
    vi.mocked(captureBalance).mockResolvedValue(null);
    vi.mocked(realClick).mockImplementation(async (el: HTMLElement) => {
      el.textContent = '已签到';
      (el as HTMLButtonElement).disabled = true;
      const hit = document.createElement('div');
      hit.textContent = '签到成功 今天 +¥10.3100';
      document.querySelector('.card')?.appendChild(hit);
      return 'dom';
    });

    const outcome = await performCheckin(site(), log, { saveBalance: vi.fn() });

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      expect(outcome.metrics).toMatchObject({
        verdict: 'rewarded',
        reward: 10.31 * 500_000,
        rewardSymbol: '¥',
        source: 'visible-reward',
      });
    }
    expect(log.push).toHaveBeenCalledWith('页面显示本次签到奖励 ¥10.3100');
  });

  it('始终读不到余额时说明原因，不留一个光秃秃的「未获取」', async () => {
    vi.mocked(captureBalance).mockResolvedValue(null);
    const saveBalance = vi.fn();
    await performCheckin(site(), log, { saveBalance });
    expect(saveBalance).not.toHaveBeenCalled();
    expect(log.push).toHaveBeenCalledWith(expect.stringContaining('未能读到余额'));
  });
});
