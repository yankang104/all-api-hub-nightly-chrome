import { describe, expect, it } from 'vitest';
import type { AccountBalance } from '@/types';
import { describeAge, displayBalanceOf, formatBalanceTotal, formatQuota, formatQuotaChange, quotaDivisor, sumBalances, toDollars } from '@/lib/balance/balance-format';

const balance = (quota: number, extra: Partial<AccountBalance> = {}): AccountBalance =>
  ({ quota, usedQuota: 0, at: Date.now(), ...extra });

describe('quotaDivisor', () => {
  it('显式 quotaPerUnit 优先', () => {
    expect(quotaDivisor({ quotaPerUnit: 250_000, family: 'new-api' })).toBe(250_000);
  });

  it('没配时 new-api 按 500000 折算', () => {
    expect(quotaDivisor({ family: 'new-api' })).toBe(500_000);
  });

  it('Sub2API 的 balance 本身就是美元，不能套 new-api 系数', () => {
    // 套错的话 $6.5 会显示成 $0.00 —— 用户看着像余额被清零了
    expect(quotaDivisor({ family: 'sub2api' })).toBe(1);
    expect(formatQuota(6.5, { family: 'sub2api' })).toBe('$6.5000');
  });

  it('0 和负数当作没配 —— 除以 0 会得到 Infinity', () => {
    expect(quotaDivisor({ quotaPerUnit: 0, family: 'new-api' })).toBe(500_000);
    expect(quotaDivisor({ quotaPerUnit: -1, family: 'new-api' })).toBe(500_000);
  });
});

describe('formatQuota', () => {
  it('new-api 的原始 quota 换算成美元', () => {
    expect(formatQuota(500_000, { family: 'new-api' })).toBe('$1.0000');
    expect(formatQuota(335_536_714, { family: 'new-api' })).toBe('$671.0734');
  });

  it('家族未知时按 1:1 显示，不猜系数', () => {
    expect(formatQuota(12.5, {})).toBe('$12.5000');
  });

  it('奖励可以保留页面人民币符号，不改变换算规则', () => {
    expect(formatQuota(10.31, { family: 'sub2api' }, '¥')).toBe('¥10.3100');
    expect(formatQuota(5_155_000, { family: 'new-api' }, '¥')).toBe('¥10.3100');
  });

  it('积分余额和积分差值使用各自的自然语序', () => {
    expect(formatQuota(1_476, { quotaPerUnit: 500_000 }, '积分')).toBe('积分 1476');
    expect(formatQuotaChange(42, { quotaPerUnit: 500_000 }, '积分')).toBe('42 积分');
  });
});

describe('sumBalances 跨站点求和', () => {
  /**
   * 这是整个功能最容易写错、且错了看不出来的地方：new-api 的 quota 是
   * 五十万级的整数，Sub2API 的 balance 是个位数美元。直接把原始值相加
   * 会得到 1000006.5 这种数，除以任何一个系数都是错的。
   */
  it('必须先各自换算再相加', () => {
    const total = sumBalances([
      { balance: balance(1_000_000), scale: { family: 'new-api' } },  // $2.00
      { balance: balance(6.5), scale: { family: 'sub2api' } },        // $6.50
    ]);

    expect(total.dollars).toBeCloseTo(8.5, 10);
    expect(total.counted).toBe(2);
    expect(total.missing).toBe(0);
    expect(total.currencies).toEqual([{ symbol: '$', amount: 8.5, counted: 2 }]);
  });

  it('同站多账号直接累加', () => {
    const scale = { family: 'new-api' as const, quotaPerUnit: 500_000 };
    const total = sumBalances([
      { balance: balance(500_000), scale },
      { balance: balance(250_000), scale },
    ]);

    expect(total.dollars).toBeCloseTo(1.5, 10);
    expect(total.counted).toBe(2);
  });

  it('没有余额记录的账号计入 missing，不当 0 算', () => {
    const total = sumBalances([
      { balance: balance(500_000), scale: { family: 'new-api' } },
      { balance: undefined, scale: { family: 'new-api' } },
    ]);

    expect(total.dollars).toBeCloseTo(1, 10);
    expect(total.counted).toBe(1);
    expect(total.missing).toBe(1);
  });

  it('读失败的记录不计入总额 —— 那个 quota 是上次的旧值', () => {
    // 把过期数字算进总额，等于把历史值当现值报给用户
    const stale = balance(500_000, { error: '登录态已失效' });
    const total = sumBalances([{ balance: stale, scale: { family: 'new-api' } }]);

    expect(total.dollars).toBe(0);
    expect(total.counted).toBe(0);
    expect(total.missing).toBe(1);
  });

  it('空列表得到零，不是 NaN', () => {
    expect(sumBalances([])).toEqual({ dollars: 0, counted: 0, missing: 0, currencies: [] });
  });

  it('人民币余额保留币种，不能伪装成美元', () => {
    const total = sumBalances([
      { balance: balance(319.63, { symbol: '¥' }), scale: { family: 'sub2api' } },
    ]);

    expect(total.dollars).toBe(0);
    expect(formatBalanceTotal(total)).toBe('¥319.6300');
  });

  it('跨站点混合币种分别展示，不静默相加', () => {
    const total = sumBalances([
      { balance: balance(12.5, { symbol: '$' }), scale: { family: 'sub2api' } },
      { balance: balance(319.63, { symbol: '￥' }), scale: { family: 'sub2api' } },
    ]);

    expect(formatBalanceTotal(total)).toBe('$12.5000 + ￥319.6300');
  });

  it('积分独立求和，不与美元或人民币混算', () => {
    const total = sumBalances([
      { balance: balance(1_476, { symbol: '积分' }), scale: { quotaPerUnit: 500_000 } },
      { balance: balance(319.63, { symbol: '¥' }), scale: { family: 'sub2api' } },
      { balance: balance(12.5, { symbol: '$' }), scale: { family: 'sub2api' } },
    ]);

    expect(total.dollars).toBe(12.5);
    expect(formatBalanceTotal(total)).toBe('$12.5000 + ¥319.6300 + 积分 1476');
  });
});

describe('toDollars', () => {
  it('不四舍五入，保留精度供求和', () => {
    // 先 toFixed 再相加会累积舍入误差，所以求和走的是这条路
    expect(toDollars(1, { quotaPerUnit: 3 })).toBeCloseTo(1 / 3, 12);
  });
});

describe('describeAge', () => {
  const now = Date.parse('2026-08-18T12:00:00Z');

  it('一分钟内说「刚刚更新」', () => {
    expect(describeAge(now - 5_000, now)).toBe('刚刚更新');
  });

  it('分钟、小时、天各自的量级', () => {
    expect(describeAge(now - 3 * 60_000, now)).toBe('3 分钟前');
    expect(describeAge(now - 5 * 3_600_000, now)).toBe('5 小时前');
    expect(describeAge(now - 2 * 86_400_000, now)).toBe('2 天前');
  });

  it('时钟回拨导致的未来时间戳不显示负数', () => {
    expect(describeAge(now + 10_000, now)).toBe('刚刚更新');
  });
});

/**
 * 展示层回落：账号行、站点卡片、顶部合计必须对同一个账号给出同一句话。
 *
 * 真实故障：卡皮巴拉 4 个账号，账号行都显示着余额（$7.91 / $7.53 / $7.78 /
 * $8.11），站点标题却写着「本站余额 未获取 · 4 个未获取」。原因是存储里只有
 * saveCheckinReward 写的带 error 占位记录，而站点卡片只认存储、没有回落 ——
 * 账号行有回落，两边读的不是同一份数据。
 */
describe('displayBalanceOf 展示层回落', () => {
  const stored = (extra: Partial<AccountBalance> = {}): AccountBalance => ({
    quota: 7_910_000,
    usedQuota: 0,
    at: 1_700_000_000_000,
    ...extra,
  });

  it('存储里有正常余额：直接用存储，并标记不是回落值', () => {
    const got = displayBalanceOf(stored(), undefined, 42);
    expect(got.fromCheckinResult).toBe(false);
    expect(got.balance?.quota).toBe(7_910_000);
    expect(got.balance?.at).toBe(1_700_000_000_000);
  });

  it('存储里是带 error 的占位记录、本次签到读到了余额：回落到签到结果', () => {
    // 这正是卡皮巴拉的现场：saveCheckinReward 写了 quota=0 + error 占位，
    // 真实余额在本次签到的 metrics 里。
    const got = displayBalanceOf(
      stored({ quota: 0, error: '余额尚未读取' }),
      { metrics: { quotaAfter: 7_910_000, balanceSymbol: '$' } },
      42,
    );
    expect(got.fromCheckinResult).toBe(true);
    expect(got.balance?.quota).toBe(7_910_000);
    expect(got.balance?.symbol).toBe('$');
    expect(got.balance?.error).toBeUndefined();
  });

  it('存储缺失但签到结果有余额：同样回落（老用户升级后的首轮）', () => {
    const got = displayBalanceOf(undefined, { metrics: { quotaAfter: 500 } }, 42);
    expect(got.fromCheckinResult).toBe(true);
    expect(got.balance?.quota).toBe(500);
  });

  it('两边都没有余额：不编数字，如实返回 undefined', () => {
    expect(displayBalanceOf(undefined, undefined).balance).toBeUndefined();
    expect(displayBalanceOf(undefined, { metrics: {} }).balance).toBeUndefined();
    expect(displayBalanceOf(stored({ error: '读取失败' }), { metrics: {} }).balance?.quota).toBe(7_910_000);
  });

  it('回落值优先用签到结果的币种，没有才退回存储里的', () => {
    const withStoredSymbol = displayBalanceOf(
      stored({ symbol: '¥', error: 'x' }),
      { metrics: { quotaAfter: 1 } },
      42,
    );
    expect(withStoredSymbol.balance?.symbol).toBe('¥');
    const withResultSymbol = displayBalanceOf(
      stored({ symbol: '¥', error: 'x' }),
      { metrics: { quotaAfter: 1, balanceSymbol: '$' } },
      42,
    );
    expect(withResultSymbol.balance?.symbol).toBe('$');
  });
});

/**
 * 端到端口径一致性：存储里是占位记录时，站点卡片和账号行必须算出同一个数。
 *
 * 这是卡皮巴拉那个真实故障的回归锁：4 个账号的账号行都显示着余额，站点标题
 * 却写着「本站余额 未获取 · 4 个未获取」。修复后两处都走 displayBalanceOf，
 * 站点合计应当把这些余额算进去，不再是 0 个计数、4 个未获取。
 */
describe('站点合计与账号行口径一致（卡皮巴拉现场）', () => {
  const placeholder = (): AccountBalance => ({
    quota: 0,
    usedQuota: 0,
    at: 1_700_000_000_000,
    error: '余额尚未读取',
  });

  it('4 个账号都只有占位记录 + 签到结果时，站点合计把它们全部计入', () => {
    // 4 个账号各自的真实余额在 metrics.quotaAfter 里（原始 quota 单位，
    // 卡皮巴拉是 sub2api 家族，1:1 即美元）。
    const entries = [
      { stored: placeholder(), after: 7.91, symbol: '$' as const },
      { stored: placeholder(), after: 7.53, symbol: '$' as const },
      { stored: placeholder(), after: 7.78, symbol: '$' as const },
      { stored: placeholder(), after: 8.11, symbol: '$' as const },
    ].map(({ stored, after, symbol }) => ({
      balance: displayBalanceOf(stored, { metrics: { quotaAfter: after, balanceSymbol: symbol } }, 42).balance,
      scale: { family: 'sub2api' as const },
    }));

    const total = sumBalances(entries);
    // 修好之前：counted=0、missing=4、显示「未获取」。
    expect(total.counted).toBe(4);
    expect(total.missing).toBe(0);
    expect(total.dollars).toBeCloseTo(7.91 + 7.53 + 7.78 + 8.11, 6);
    expect(formatBalanceTotal(total)).not.toContain('未获取');
  });

  it('已有成功快照的账号不会被回落值覆盖（接口值更权威）', () => {
    const real: AccountBalance = { quota: 7_910_000, usedQuota: 0, at: 1_700_000_000_000 };
    const got = displayBalanceOf(real, { metrics: { quotaAfter: 999 } }, 42);
    expect(got.fromCheckinResult).toBe(false);
    expect(got.balance?.quota).toBe(7_910_000);
  });
});
