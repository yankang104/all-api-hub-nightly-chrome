import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  captureBalance,
  crossOriginBalanceProbe,
  decodeCrossOriginPayload,
  describeMetrics,
  diffBalance,
  extractBalance,
  extractCrossOriginBalance,
  extractTodayCheckinReward,
  extractTodayCheckinRewardObservation,
  mergeCheckinRewardObservations,
  readNewVisibleCheckinReward,
  readNewVisibleCheckinRewardObservation,
  readVisibleBalance,
  readVisibleCheckinReward,
  readVisibleCheckinRewardObservation,
  withVisibleTodayRewardEvidence,
} from '@/automation/balance/balance';
import type { CheckinMetrics, SiteConfig } from '@/types';

const snap = (quota: number, usedQuota: number, symbol?: '$' | '¥' | '￥' | '积分') => ({
  quota,
  usedQuota,
  at: Date.now(),
  ...(symbol ? { symbol } : {}),
});

describe('diffBalance 守恒差分', () => {
  it('总额度变多判为领到奖励', () => {
    const metrics = diffBalance(snap(100, 50), snap(200, 50));
    expect(metrics.verdict).toBe('rewarded');
    expect(metrics.reward).toBe(100);
  });

  it('签到期间有消耗也能算出真实收益', () => {
    // 领了 100，同时被调用花掉 30：剩余只 +70，但总额度 +100
    const metrics = diffBalance(snap(100, 50), snap(170, 80));
    expect(metrics.verdict).toBe('rewarded');
    expect(metrics.reward).toBe(100);
    expect(metrics.usageDelta).toBe(30);
    expect(metrics.balanceDelta).toBe(70);
  });

  it('领多少就花多少时仍判为领到（只看剩余会误判成没领）', () => {
    const metrics = diffBalance(snap(100, 50), snap(100, 100));
    expect(metrics.balanceDelta).toBe(0);
    expect(metrics.verdict).toBe('rewarded');
    expect(metrics.reward).toBe(50);
  });

  it('总额度没变但有消耗判为今日已签', () => {
    const metrics = diffBalance(snap(100, 50), snap(70, 80));
    expect(metrics.verdict).toBe('already-used');
    expect(metrics.reward).toBe(0);
  });

  it('完全没变判为无变化', () => {
    expect(diffBalance(snap(100, 50), snap(100, 50)).verdict).toBe('unchanged');
  });

  it('缺快照时判为未知，不编造数字', () => {
    expect(diffBalance(undefined, snap(100, 50)).verdict).toBe('unknown');
    expect(diffBalance(snap(100, 50), undefined).verdict).toBe('unknown');
    expect(diffBalance(undefined, undefined).reward).toBeUndefined();
  });

  it('浮点余额（Sub2API 的美元）不因精度误差误判', () => {
    // 0.1 + 0.2 !== 0.3 这类误差不该被当成领到奖励
    const metrics = diffBalance(snap(0.3, 0), snap(0.1 + 0.2, 0));
    expect(metrics.verdict).toBe('unchanged');
  });

  it('Sub2API 缺 usedQuota 时退化为只看余额变化', () => {
    // 没有累计消耗字段，判不出「今日已签到」，只能判有无变化
    const metrics = diffBalance(snap(5.0, 0), snap(6.5, 0));
    expect(metrics.verdict).toBe('rewarded');
    expect(metrics.reward).toBeCloseTo(1.5);
  });

  it('把签到后余额币种传入度量结果', () => {
    expect(diffBalance(snap(300, 0, '¥'), snap(319.63, 0, '¥')).balanceSymbol).toBe('¥');
  });

  it('积分前后快照计算原始积分差值并保留单位', () => {
    expect(diffBalance(snap(1_434, 0, '积分'), snap(1_476, 0, '积分'))).toMatchObject({
      verdict: 'rewarded',
      reward: 42,
      quotaAfter: 1_476,
      balanceSymbol: '积分',
    });
  });
});

describe('describeMetrics 文案', () => {
  it('按换算率把 quota 转成美元', () => {
    const text = describeMetrics(
      { verdict: 'rewarded', reward: 2_500_000, quotaAfter: 5_000_000 },
      500_000,
    );
    expect(text).toContain('$5.0000');
    expect(text).toContain('$10.0000');
  });

  it('Sub2API 的美元余额不做换算', () => {
    const text = describeMetrics({ verdict: 'rewarded', reward: 1.5, quotaAfter: 6.5 });
    expect(text).toContain('$1.5000');
    expect(text).toContain('$6.5000');
  });

  it('new-api 缺少显式换算率时按标准 500000 折算', () => {
    const text = describeMetrics({ verdict: 'unchanged', quotaAfter: 335_536_714 }, undefined, 'new-api');
    expect(text).toContain('$671.0734');
  });

  it('显式传入自定义换算率时优先使用自定义值', () => {
    const text = describeMetrics({ verdict: 'unchanged', quotaAfter: 1_000_000 }, 250_000);
    expect(text).toContain('$4.0000');
  });

  it('Sub2API 指定家族时缺少换算率仍按美元处理', () => {
    const text = describeMetrics({ verdict: 'unchanged', quotaAfter: 6.5 }, undefined, 'sub2api');
    expect(text).toContain('$6.5000');
  });

  it('未知家族缺少换算率保持兼容的美元展示', () => {
    const text = describeMetrics({ verdict: 'unchanged', quotaAfter: 6.5 });
    expect(text).toContain('$6.5000');
  });

  it('未知结论不产生文案', () => {
    expect(describeMetrics({ verdict: 'unknown' })).toBeNull();
    expect(describeMetrics({})).toBeNull();
  });

  it('没有签到后余额时不编造当前余额 $0.0000', () => {
    expect(describeMetrics({ verdict: 'rewarded', reward: 2_975_000 }, 500_000))
      .toBe('签到获得 $5.9500');
  });

  it('页面或台账已明确显示今日已签到时使用明确的重复执行文案', () => {
    expect(describeMetrics({
      verdict: 'unchanged',
      source: 'checkin-ledger',
      quotaAfter: 240_310_000,
    }, 500_000)).toBe('今日已签到，额度未变化，当前余额 $480.6200');
  });

  it('页面台账有当天奖励时展示记录金额而不是伪装成余额差分', () => {
    expect(describeMetrics({
      verdict: 'rewarded',
      source: 'checkin-ledger',
      reward: 12.08 * 500_000,
      quotaAfter: 240_310_000,
    }, 500_000)).toBe('今日签到记录奖励 $12.0800，当前余额 $480.6200');
  });

  it('页面奖励保留人民币符号，但当前余额仍按余额口径显示', () => {
    expect(describeMetrics({
      verdict: 'rewarded',
      source: 'checkin-ledger',
      reward: 10.31,
      rewardSymbol: '¥',
      quotaAfter: 28.63,
    }, 1, 'sub2api')).toBe('今日签到记录奖励 ¥10.3100，当前余额 $28.6300');
  });

  it('余额快照带人民币符号时奖励差分和当前余额都按人民币展示', () => {
    expect(describeMetrics({
      verdict: 'rewarded',
      reward: 10.31,
      quotaAfter: 319.63,
      balanceSymbol: '¥',
    }, 1, 'sub2api')).toBe('签到获得 ¥10.3100，当前余额 ¥319.6300');
  });

  it('积分差值使用后置单位，当前积分使用余额口径', () => {
    expect(describeMetrics({
      verdict: 'rewarded',
      reward: 42,
      quotaAfter: 1_476,
      balanceSymbol: '积分',
    })).toBe('签到获得 42 积分，当前余额 积分 1476');
  });
});

describe('extractBalance Sub2API 快照', () => {
  it('同时累加免费与付费余额', () => {
    expect(extractBalance({
      data: { free_balance: 2_792.95169, paid_balance: 5 },
    })).toEqual({ quota: 2_797.95169, usedQuota: 0 });
  });

  it('百倍状态接口同时带 free_balance 与旧 balance 时把后者作为付费池', () => {
    expect(extractBalance({
      data: { free_balance: 1_866.75, balance: -0.13 },
    })).toEqual({ quota: 1_866.62, usedQuota: 0 });
  });

  it('只返回其中一个余额池时不丢失快照', () => {
    expect(extractBalance({ data: { free_balance: '40.5' } }))
      .toEqual({ quota: 40.5, usedQuota: 0 });
  });
});

describe('extractTodayCheckinReward 读取结构化当日奖励', () => {
  it('百倍状态接口明确已签到时读取 today_reward', () => {
    expect(extractTodayCheckinReward({
      data: { checked_in_today: true, today_reward: 1 },
    })).toBe(1);
  });

  it('尚未签到时不把预计奖励当成到账金额', () => {
    expect(extractTodayCheckinReward({
      data: { checked_in_today: false, today_reward: 1 },
    })).toBeNull();
  });

  it('结构化字符串奖励识别 CNY 与全角人民币符号', () => {
    expect(extractTodayCheckinRewardObservation({
      data: { checked_in_today: true, today_reward: 'CNY 10.31' },
    })).toEqual({ reward: 10.31, symbol: '¥' });
    expect(extractTodayCheckinRewardObservation({
      data: { checked_in_today: true, today_reward: '￥10.3100' },
    })).toEqual({ reward: 10.31, symbol: '￥' });
  });
});

/**
 * 页面可见余额兜底。
 *
 * 这是修一个真实故障：1412's API 走 GitHub OAuth，首次签到时账号里还没有
 * userId，new-api 的余额端点缺 user-id 兼容头一律 401 —— 守恒差分退化成
 * unknown，界面只能写「读不到额度变化，成功仅来自站点提示」。而 /profile
 * 页上明明印着「当前余额 $456.75」。
 */
describe('readVisibleBalance 读页面上显示的余额', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('按换算率把页面上的美元余额还原成原始 quota', () => {
    const text = 'demo-user 用户 ID 436\n@demo-github · SVIP\n当前余额 $456.7500';
    expect(readVisibleBalance(text, 500_000)).toEqual({ quota: 456.75 * 500_000, usedQuota: 0, symbol: '$' });
  });

  it('没有换算率时按美元原样返回（Sub2API 那样的站点）', () => {
    expect(readVisibleBalance('余额：$40.5000')).toEqual({ quota: 40.5, usedQuota: 0, symbol: '$' });
  });

  it('百倍页面同时显示免费与付费余额时读取两者合计', () => {
    expect(readVisibleBalance('当前余额：免费 $1866.7500 · 付费 $-0.13'))
      .toEqual({ quota: 1_866.62, usedQuota: 0, symbol: '$' });
  });

  it('识别人民币符号与 CNY/RMB 文本并保留币种', () => {
    expect(readVisibleBalance('当前余额 ¥319.6300', 500_000))
      .toEqual({ quota: 319.63 * 500_000, usedQuota: 0, symbol: '¥' });
    expect(readVisibleBalance('当前余额 ￥319.6300'))
      .toEqual({ quota: 319.63, usedQuota: 0, symbol: '￥' });
    expect(readVisibleBalance('当前余额 CNY 319.63'))
      .toEqual({ quota: 319.63, usedQuota: 0, symbol: '¥' });
    expect(readVisibleBalance('Current Balance RMB 319.63'))
      .toEqual({ quota: 319.63, usedQuota: 0, symbol: '¥' });
  });

  it('把全角美元符号和 USD 标准化成美元符号', () => {
    expect(readVisibleBalance('当前余额 ＄12.50'))
      .toEqual({ quota: 12.5, usedQuota: 0, symbol: '$' });
    expect(readVisibleBalance('Balance USD 12.50'))
      .toEqual({ quota: 12.5, usedQuota: 0, symbol: '$' });
  });

  it('读取 Linux.SB 侧栏的明确账户积分，不套用货币换算率', () => {
    expect(readVisibleBalance('袁天罡\n饼友 · 积分 1476\n我的主题', 500_000))
      .toEqual({ quota: 1_476, usedQuota: 0, symbol: '积分' });
  });

  it('不把帖子正文或积分明细里的普通积分数字当成账户余额', () => {
    expect(readVisibleBalance('每日签到\n+42 积分\n累计签到 14')).toBeNull();
  });

  it('支持中文冒号、英文 Balance 和千位分隔符', () => {
    expect(readVisibleBalance('账户余额：1,234.56 元')?.quota).toBeCloseTo(1_234.56);
    expect(readVisibleBalance('Balance: $12.0000')?.quota).toBeCloseTo(12);
  });

  it('逗号不在千位上时宁可读不到，也不报一个放大 10 倍的余额', () => {
    // 「1,5」在部分区域是 1.5，当成千位分隔符去掉逗号会变成 15
    expect(readVisibleBalance('余额：1,5')).toBeNull();
  });

  it('不把签到奖励或价格表里的美元数字当成余额', () => {
    // 「今天 +$5.95」是本次奖励，不是账户余额；猜错比读不到更糟
    expect(readVisibleBalance('每日签到 今天 +$5.9500 累计签到 38 天', 500_000)).toBeNull();
  });

  it('没有正文时返回 null —— 页面读不到和字段缺失都走这条', () => {
    expect(readVisibleBalance(undefined)).toBeNull();
    expect(readVisibleBalance('')).toBeNull();
  });
});

describe('readVisibleCheckinReward 读页面上新出现的签到奖励', () => {
  it('识别 1412 的「今天 +$X」并换算成原始 quota', () => {
    expect(readVisibleCheckinReward('每日签到\n已签到\n今天 +$5.9500', 500_000))
      .toBe(5.95 * 500_000);
  });

  it('支持英文 today、中文金额和千位分隔符', () => {
    expect(readVisibleCheckinReward('Today reward earned +$1,234.5600', 1)).toBe(1_234.56);
    expect(readVisibleCheckinReward('今日 +＄2.5', 1)).toBe(2.5);
  });

  it('识别 Zynk 的人民币奖励并保留页面符号', () => {
    expect(readVisibleCheckinRewardObservation('每日签到\n已签到\n今天 +¥10.3100', 1))
      .toEqual({ reward: 10.31, symbol: '¥' });
    expect(readVisibleCheckinRewardObservation('今日 +CNY 10.31', 1))
      .toEqual({ reward: 10.31, symbol: '¥' });
  });

  it('识别 Hvoy 签到成功弹窗中的积分增加量且不套美元换算率', () => {
    expect(readVisibleCheckinRewardObservation(
      '恭喜获取10积分\n签到成功，已获得 10 积分',
      500_000,
    )).toEqual({ reward: 10, symbol: '积分' });
    expect(readVisibleCheckinRewardObservation('签到成功，已获得 10 积分', 500_000))
      .toEqual({ reward: 10, symbol: '积分' });
    expect(readVisibleCheckinRewardObservation('每日签到\n+10 积分\n立即签到', 500_000))
      .toBeNull();
  });

  it('跳过同页较早的零奖励预览，继续读取真实签到奖励', () => {
    expect(readVisibleCheckinRewardObservation(
      '今日 +0.00\n每日签到\n已签到\n今天 +¥10.3100',
      1,
    )).toEqual({ reward: 10.31, symbol: '¥' });
  });

  it('没有签到上下文时不把普通今日收益当作签到奖励', () => {
    expect(readVisibleCheckinRewardObservation('今日收益 +¥10.3100', 1)).toBeNull();
  });

  it('百倍显示今日已签到时读取「今日可得 $X」', () => {
    expect(readVisibleCheckinReward('每日签到\n今日可得\n$1.0000\n免费\n今日已签到', 1))
      .toBe(1);
  });

  it('百倍尚未签到时不把预计可得金额当成已到账奖励', () => {
    expect(readVisibleCheckinReward('每日签到\n今日可得\n$1.0000\n免费\n立即签到', 1))
      .toBeNull();
  });

  it('不把普通价格或负号数字当成签到奖励', () => {
    expect(readVisibleCheckinReward('套餐价格 +$5.9500')).toBeNull();
    expect(readVisibleCheckinReward('今天 -$5.9500')).toBeNull();
    expect(readVisibleCheckinReward('今天 +$0.0000')).toBeNull();
  });

  it('同一条旧奖励前后都存在时不重复确认本次签到', () => {
    expect(readNewVisibleCheckinReward(
      '每日签到 今天 +$5.9500',
      '每日签到 已签到 今天 +$5.9500',
      500_000,
    )).toBeNull();
  });

  it('同金额但页面新增人民币符号时保留新的明确观测', () => {
    expect(readNewVisibleCheckinRewardObservation(
      '每日签到 今天 +10.31',
      '每日签到 已签到 今天 +¥10.3100',
      1,
    )).toEqual({ reward: 10.31, symbol: '¥' });
  });

  it('点击后新出现奖励时返回它，即使余额数字没变', () => {
    expect(readNewVisibleCheckinReward(
      '当前余额 $468.5300\n立即签到',
      '当前余额 $468.5300\n已签到\n今天 +$5.9500',
      500_000,
    )).toBe(5.95 * 500_000);
  });

  it('同金额的无符号接口数据不会擦掉页面识别到的人民币符号', () => {
    expect(mergeCheckinRewardObservations(
      { reward: 10.31, symbol: '¥' },
      { reward: 10.31 },
    )).toEqual({ reward: 10.31, symbol: '¥' });
  });

  it('奖励金额变化且新数据无符号时不沿用上一笔币种', () => {
    expect(mergeCheckinRewardObservations(
      { reward: 10.31, symbol: '¥' },
      { reward: 12.5 },
    )).toEqual({ reward: 12.5 });
  });
});

describe('withVisibleTodayRewardEvidence 把页面宣告的今日奖励当一等证据', () => {
  /**
   * 用户报的真故障：「我签到了，你显示没有变化」。
   *
   * 站点「卡皮巴拉API」（new-api 族，quotaPerUnit=500000）额度接口读不到，只能读
   * 页面上的余额；而页面把余额显示到一位小数（$4.3）。$0.3449 的奖励在**显示精度**
   * 上根本看不出来，于是守恒差分判成 unchanged，界面回一句「额度无变化」——
   * 而同一张卡片上站点自己写着「已签到」「今天 +$0.3449」。
   *
   * 站点明说发了多少，比一个被四舍五入掉的余额差分更直接、更精确。
   */
  const userCaseMetrics: CheckinMetrics = {
    verdict: 'unchanged',
    reward: 0,
    usageDelta: 0,
    balanceDelta: 0,
    // 页面显示的 $4.3（一位小数）在 new-api 单位下就是这个数
    quotaAfter: 4.3 * 500_000,
    balanceSymbol: '$',
  };
  // 截图上的原文
  const userCaseAfterText = '每日签到\n已签到\n今天 +$0.3449\n累计签到 29\n本月获得 $4';
  const userCaseBeforeText = '每日签到\n立即签到\n累计签到 28';

  it('差分说无变化、页面写着「今天 +$0.3449」时判为已到账，不再报额度无变化', () => {
    const metrics = withVisibleTodayRewardEvidence(
      userCaseMetrics,
      { before: userCaseBeforeText, after: userCaseAfterText },
      500_000,
    );

    expect(metrics.verdict).toBe('rewarded');
    expect(metrics.reward).toBeCloseTo(0.3449 * 500_000, 3);
    expect(metrics.rewardSymbol).toBe('$');
    // 来源标成页面证据，不是余额差分 —— 不许冒充守恒差分
    expect(metrics.source).toBe('visible-reward');
    // 差分读到的余额照旧带回去，界面仍要显示当前余额
    expect(metrics.quotaAfter).toBe(4.3 * 500_000);
    expect(metrics.balanceSymbol).toBe('$');

    const summary = describeMetrics(metrics, 500_000, 'new-api');
    expect(summary).not.toContain('额度无变化');
    expect(summary).toContain('$0.3449');
    expect(summary).toContain('$4.3000');
    // 别忘了 checkin.ts 已经推过一句「页面显示本次签到奖励 $0.34」；
    // 紧跟一句同样开头的文案就是结巴，这里锁住不重复。
    expect(summary).not.toContain('页面显示本次签到奖励');
    expect(summary).toContain('余额差分未体现增长');
  });

  it('奖励文案在基线里就已渲染（SPA 提前画好）时按今日台账记录，仍不报额度无变化', () => {
    // 上一份文档/SPA 已经画出「今天 +$0.3449」，只有「已签到」是这次动作之后才出现的。
    // 金额不是本次新出现 → 只能记成站点台账，不能说成「本次点击的证据」。
    const before = '每日签到\n今天 +$0.3449\n立即签到';
    const after = '每日签到\n已签到\n今天 +$0.3449';

    const metrics = withVisibleTodayRewardEvidence(
      userCaseMetrics,
      { before, after },
      500_000,
    );

    expect(metrics.verdict).toBe('rewarded');
    expect(metrics.reward).toBeCloseTo(0.3449 * 500_000, 3);
    expect(metrics.source).toBe('checkin-ledger');
    expect(describeMetrics(metrics, 500_000, 'new-api')).not.toContain('额度无变化');
  });

  it('页面先前的旧奖励与本次相同、且已签到状态前后都在时，只记台账不冒充本轮增长', () => {
    // 真·重复点击：站点自己写着今天已到账，这是可信的**今日**证据；
    // 但它不是本轮新增，来源只能是台账（界面据此说明「未确认本轮增加」）。
    const text = '每日签到\n已签到\n今天 +$12.0800';

    const metrics = withVisibleTodayRewardEvidence(
      userCaseMetrics,
      { before: text, after: text },
      500_000,
    );

    expect(metrics.verdict).toBe('rewarded');
    expect(metrics.source).toBe('checkin-ledger');
    expect(metrics.reward).toBeCloseTo(12.08 * 500_000, 3);
  });

  it('累计已用导致的 already-used 不再盖过页面明确宣告的今日奖励', () => {
    const metrics = withVisibleTodayRewardEvidence(
      { ...userCaseMetrics, verdict: 'already-used', usageDelta: 30 },
      { before: userCaseBeforeText, after: userCaseAfterText },
      500_000,
    );

    expect(metrics.verdict).toBe('rewarded');
    expect(metrics.reward).toBeCloseTo(0.3449 * 500_000, 3);
    // 消耗量照旧保留，账目不能被页面文案抹掉
    expect(metrics.usageDelta).toBe(30);
  });

  it('人民币与积分奖励保留原符号，换算率不套在积分上', () => {
    const rmb = withVisibleTodayRewardEvidence(
      userCaseMetrics,
      { before: '每日签到\n立即签到', after: '每日签到\n已签到\n今天 +¥10.3100' },
      1,
    );
    expect(rmb).toMatchObject({ verdict: 'rewarded', reward: 10.31, rewardSymbol: '¥', source: 'visible-reward' });

    const points = withVisibleTodayRewardEvidence(
      userCaseMetrics,
      { before: '每日签到\n立即签到', after: '签到成功，已获得 10 积分' },
      500_000,
    );
    expect(points).toMatchObject({ verdict: 'rewarded', reward: 10, rewardSymbol: '积分', source: 'visible-reward' });
  });

  it('页面没有明确宣告今日奖励时原样返回，不凭空提高结论等级', () => {
    const cases: Array<{ before?: string; after?: string; why: string }> = [
      { before: '每日签到\n立即签到', after: '每日签到\n立即签到', why: '按钮还在，说明还没签到' },
      { before: undefined, after: '每日签到\n签到失败，请稍后重试', why: '失败提示' },
      { before: '', after: '', why: '读不到正文' },
      { before: undefined, after: '今日收益 +¥10.3100', why: '普通今日收益，不是签到奖励' },
      { before: undefined, after: '套餐价格 +$5.9500', why: '价格表' },
      { before: undefined, after: '今天 -$5.9500', why: '负号不是奖励' },
      { before: undefined, after: '已签到\n今天 +$0.0000', why: '零奖励不是「发了奖励」的证据' },
      // 已签到但今天没有奖励金额：只说今天签过，没说发了多少 —— 不做金额结论
      { before: undefined, after: '每日签到\n已签到\n累计签到 29', why: '只有状态没有金额' },
    ];

    for (const { before, after, why } of cases) {
      const metrics = withVisibleTodayRewardEvidence(userCaseMetrics, { before, after }, 500_000);
      expect(metrics, why).toBe(userCaseMetrics);
    }
  });

  it('已签到状态断言必须出现在动作之后的正文里', () => {
    // 「今日可得」这类预览卡必须配合明确的已签到状态才认账（沿用现有解析器的保守性）
    const preview = withVisibleTodayRewardEvidence(
      userCaseMetrics,
      { before: undefined, after: '每日签到\n今日可得\n$1.0000\n立即签到' },
      1,
    );
    expect(preview).toBe(userCaseMetrics);

    const checked = withVisibleTodayRewardEvidence(
      userCaseMetrics,
      { before: undefined, after: '每日签到\n今日可得\n$1.0000\n今日已签到' },
      500_000,
    );
    expect(checked.verdict).toBe('rewarded');
    expect(checked.reward).toBeCloseTo(1 * 500_000, 3);
  });

  it('余额差分已经确认增长时不改写更硬的结论', () => {
    const fromDiff: CheckinMetrics = {
      verdict: 'rewarded',
      reward: 5.95 * 500_000,
      quotaAfter: 900 * 500_000,
    };

    const metrics = withVisibleTodayRewardEvidence(
      fromDiff,
      { before: userCaseBeforeText, after: userCaseAfterText },
      500_000,
    );

    // 差分的金额与来源都不能被页面文案顶掉
    expect(metrics).toBe(fromDiff);
    expect(metrics.source).toBeUndefined();
  });

  it('没有前后快照（unknown）时，只有页面明确宣告已签到且今日到账才提升等级', () => {
    const unknown: CheckinMetrics = { verdict: 'unknown', quotaAfter: 4.3 * 500_000 };

    expect(withVisibleTodayRewardEvidence(
      unknown,
      { before: userCaseBeforeText, after: userCaseAfterText },
      500_000,
    ).verdict).toBe('rewarded');

    // 只有状态、没有金额 → 保持 unknown，不编一个金额出来
    expect(withVisibleTodayRewardEvidence(
      unknown,
      { before: undefined, after: '每日签到\n已签到\n累计签到 29' },
      500_000,
    )).toBe(unknown);
  });
});

describe('captureBalance 端点全失败时的兜底与告知', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const newApiSite = (): SiteConfig => ({
    id: 'kid1412',
    name: "1412's API",
    loginUrl: 'https://napi.kid1412.qzz.io/sign-in',
    loginMethod: 'github',
    selectors: { username: 'input[name="username"]', password: 'input[name="password"]', submit: 'button[type="submit"]' },
    closeModalSelectors: [],
    adapter: { siteType: 'new-api', family: 'new-api', quotaPerUnit: 500_000 },
  });

  const linuxSbSite = (): SiteConfig => ({
    id: 'linux-sb',
    name: 'Linux.SB',
    loginUrl: 'https://linux.sb/login',
    loginMethod: 'form',
    selectors: { username: 'input[name="username"]', password: 'input[type="password"]', submit: 'button[type="submit"]' },
    closeModalSelectors: [],
    adapter: { siteType: 'unknown', family: 'unsupported' },
  });

  const stubPage = (bodyText: string) => {
    vi.stubGlobal('location', new URL('https://napi.kid1412.qzz.io/profile'));
    vi.stubGlobal('localStorage', {
      getItem: () => null,
    } as unknown as Storage);
    vi.stubGlobal('document', { body: { innerText: bodyText } });
  };

  it('接口 401 时改用页面余额，并说明差分被降级', async () => {
    stubPage('demo-user 用户 ID 436\n当前余额 $456.7500\n已签到');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, headers: { get: () => null } }));

    const lines: string[] = [];
    const snapshot = await captureBalance(newApiSite(), { push: (m) => lines.push(m) });

    expect(snapshot?.quota).toBeCloseTo(456.75 * 500_000);
    expect(snapshot?.symbol).toBe('$');
    expect(lines.join('\n')).toContain('额度接口读不到');
  });

  it('接口和页面都读不到时明确写进日志，而不是静默返回 null', async () => {
    stubPage('每日签到');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, headers: { get: () => null } }));

    const lines: string[] = [];
    expect(await captureBalance(newApiSite(), { push: (m) => lines.push(m) })).toBeNull();
    expect(lines.join('\n')).toContain('未能读到额度快照');
  });

  it('轮换令牌站点：先用会话 cookie 换 Bearer，再读额度接口', async () => {
    // 一梦五千年：页面把令牌放在内存里，扩展直接读 /api/user/self 必然 401。
    vi.stubGlobal('location', new URL('https://fapi.leileihog.top/lottery'));
    vi.stubGlobal('localStorage', { getItem: () => null } as unknown as Storage);
    vi.stubGlobal('document', { body: { innerText: '浮梦引光' } });
    const calls: { url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      if (url.includes('/api/user/auth/refresh')) {
        return {
          ok: true,
          headers: { get: () => 'application/json' },
          json: async () => ({ data: { access_token: 'lottery-access-token-abcdefghijkl' } }),
        };
      }
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ data: { quota: 123456, used_quota: 1000 } }),
      };
    }));
    const site: SiteConfig = {
      ...newApiSite(),
      id: 'fapi-leilei-bootstrap',
      loginUrl: 'https://fapi.leileihog.top/login',
      authBootstrap: { endpoint: '/api/user/auth/refresh' },
    };

    const snapshot = await captureBalance(site);

    expect(snapshot?.quota).toBe(123456);
    const selfCall = calls.find((call) => call.url.includes('/api/user/self'));
    expect(selfCall?.headers.Authorization).toBe('Bearer lottery-access-token-abcdefghijkl');
  });

  it('已有 localStorage 令牌时引导不覆盖它（新机制不顶掉本来能用的凭据）', async () => {
    vi.stubGlobal('location', new URL('https://napi.kid1412.qzz.io/profile'));
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => (key === 'auth_token' ? 'sentinel-stored-token-abcdefghij' : null),
    } as unknown as Storage);
    vi.stubGlobal('document', { body: { innerText: '' } });
    const calls: { url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
      if (String(input).includes('/api/user/auth/refresh')) {
        return {
          ok: true,
          headers: { get: () => 'application/json' },
          json: async () => ({ data: { access_token: 'bootstrap-token-abcdefghijklmnop' } }),
        };
      }
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ data: { quota: 7, used_quota: 0 } }),
      };
    }));
    const site: SiteConfig = {
      ...newApiSite(),
      id: 'stored-token-wins',
      authBootstrap: { endpoint: '/api/user/auth/refresh' },
    };

    await captureBalance(site);

    const selfCall = calls.find((call) => call.url.includes('/api/user/self'));
    expect(selfCall?.headers.Authorization).toBe('Bearer sentinel-stored-token-abcdefghij');
  });

  it('Linux.SB 接口不可用时从侧栏采集原始积分快照', async () => {
    vi.stubGlobal('location', new URL('https://linux.sb/daily_checkin'));
    vi.stubGlobal('localStorage', { getItem: () => null } as unknown as Storage);
    vi.stubGlobal('document', { body: { innerText: '袁天罡\n饼友 · 积分 1476\n我的积分' } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, headers: { get: () => null } }));

    expect(await captureBalance(linuxSbSite())).toMatchObject({
      quota: 1_476,
      usedQuota: 0,
      symbol: '积分',
      fromVisibleText: true,
    });
  });
});

/*
 * orevx 形态：SPA 在 orevx.ai，真实 API 在跨域 server.orevx.ai/api。
 * 总积分在 GET /api/user/me 的 points 字段（CBOR-only），前端货币名
 * 「积分」（locale 的 wallet.currency_name）。全部用虚构 sentinel 值。
 */

/** 内存版 Storage（vitest 是 node 环境，不引 jsdom） */
const memoryStorage = (): Storage => {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  } as Storage;
};

/** 最小 CBOR 编码器（map / 短文本 / 小整数），独立于被测解码器 */
function cborFixture(value: Record<string, string | number>): Uint8Array {
  const head = (major: number, n: number): number[] => {
    if (n < 24) return [(major << 5) | n];
    if (n < 0x100) return [(major << 5) | 24, n];
    return [(major << 5) | 25, (n >> 8) & 0xff, n & 0xff];
  };
  const text = (item: string): number[] => {
    const utf8 = Array.from(new TextEncoder().encode(item));
    return [...head(3, utf8.length), ...utf8];
  };
  const entries = Object.entries(value);
  const out: number[] = [...head(5, entries.length)];
  for (const [key, item] of entries) {
    out.push(...text(key));
    out.push(...(typeof item === 'number' ? head(0, item) : text(item)));
  }
  return Uint8Array.from(out);
}

/** 假 CBOR Response：arrayBuffer 返回给定字节 */
function cborResponse(bytes: Uint8Array) {
  return {
    ok: true,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/cbor' : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

/** 假 JSON Response */
function jsonResponse(payload: unknown, ok = true) {
  return {
    ok,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => payload,
  };
}

const orevxSite = (): SiteConfig => ({
  id: 'orevx',
  name: 'Orevx',
  loginUrl: 'https://orevx.ai/login',
  loginMethod: 'oauth',
  selectors: { username: '', password: '', submit: '' },
  closeModalSelectors: [],
  identitySource: {
    storageKey: 'auth-user',
    endpoint: 'https://server.orevx.ai/api/user/me',
    tokenKey: 'auth-token',
  },
} as SiteConfig);

/** 干净的 orevx 页面环境；token 传 null 表示存储里没有 */
const stubOrevxEnv = (bodyText = '', token: string | null = 'sentinel-token') => {
  const local = memoryStorage();
  if (token) local.setItem('auth-token', token);
  vi.stubGlobal('location', new URL('https://orevx.ai/user'));
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('sessionStorage', memoryStorage());
  vi.stubGlobal('document', { body: { innerText: bodyText } });
  return { local };
};

/** 同源端点全部失败，只有跨域接口按给定响应返回 */
const fetchOrevx = (crossOriginResponse: unknown) => vi.fn().mockImplementation((url: unknown) => (
  String(url).includes('server.orevx.ai')
    ? Promise.resolve(crossOriginResponse)
    : Promise.resolve({ ok: false, headers: { get: () => null } })
));

describe('extractCrossOriginBalance 跨域接口余额', () => {
  it('points 字段就是余额，符号按站点货币「积分」', () => {
    expect(extractCrossOriginBalance({ points: 456, username: 'sentinel' }))
      .toEqual({ quota: 456, usedQuota: 0, symbol: '积分' });
  });

  it('0 积分是合法余额，不是读不到', () => {
    expect(extractCrossOriginBalance({ points: 0 })?.quota).toBe(0);
  });

  it('没有 points 字段就返回 null（不拿别的数字当余额）', () => {
    expect(extractCrossOriginBalance({ balance: 12, quota: 34 })).toBeNull();
    expect(extractCrossOriginBalance({ points: 'abc' })).toBeNull();
    expect(extractCrossOriginBalance(null)).toBeNull();
    expect(extractCrossOriginBalance('points')).toBeNull();
  });

  it('数字字符串形式的 points 也接受（JSON 变体可能发字符串）', () => {
    expect(extractCrossOriginBalance({ points: '789' })?.quota).toBe(789);
  });
});

describe('captureBalance 跨域接口（identitySource.endpoint）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('同源端点读不到时，带 Bearer token + cbor 协商读跨域接口的积分余额', async () => {
    stubOrevxEnv();
    const fetchMock = fetchOrevx(cborResponse(cborFixture({ points: 456 })));
    vi.stubGlobal('fetch', fetchMock);

    const lines: string[] = [];
    const snapshot = await captureBalance(orevxSite(), { push: (m) => lines.push(m) });

    expect(snapshot).toMatchObject({ quota: 456, usedQuota: 0, symbol: '积分' });
    // 不是正文兜底来源
    expect(snapshot?.fromVisibleText).toBeUndefined();
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes('server.orevx.ai'));
    expect(call).toBeTruthy();
    const init = call![1] as { method: string; credentials: string; headers: Record<string, string> };
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('omit');
    expect(init.headers.Authorization).toBe('Bearer sentinel-token');
    expect(String(init.headers.Accept)).toContain('application/cbor');
    expect(lines.join('\n')).toContain('跨域接口');
    expect(lines.join('\n')).toContain('积分 456');
  });

  it('同源接口已有余额时不再打跨域接口', async () => {
    stubOrevxEnv();
    const site = {
      ...orevxSite(),
      adapter: { siteType: 'new-api', family: 'new-api', quotaPerUnit: 500_000 },
    } as SiteConfig;
    const fetchMock = vi.fn().mockImplementation((url: unknown) => {
      if (String(url).includes('server.orevx.ai')) return Promise.resolve(cborResponse(cborFixture({ points: 999 })));
      return Promise.resolve(jsonResponse({ success: true, data: { quota: 123, used_quota: 5 } }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const snapshot = await captureBalance(site);

    expect(snapshot).toMatchObject({ quota: 123, usedQuota: 5 });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('server.orevx.ai'))).toBe(false);
  });

  it('跨域接口 401 时静默回退，不抛异常', async () => {
    stubOrevxEnv();
    const fetchMock = fetchOrevx({ ok: false, headers: { get: () => null } });
    vi.stubGlobal('fetch', fetchMock);

    const lines: string[] = [];
    expect(await captureBalance(orevxSite(), { push: (m) => lines.push(m) })).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('server.orevx.ai'))).toBe(true);
    expect(lines.join('\n')).toContain('未能读到额度快照');
  });

  it('CBOR 响应损坏时按读不到处理，不抛异常', async () => {
    stubOrevxEnv();
    vi.stubGlobal('fetch', fetchOrevx({
      ok: true,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/cbor' : null) },
      arrayBuffer: async () => Uint8Array.from([0x9f, 0xff]).buffer,
    }));

    expect(await captureBalance(orevxSite())).toBeNull();
  });

  it('端点不在本站域名内时一个请求都不发（安全门）', async () => {
    stubOrevxEnv();
    const site = {
      ...orevxSite(),
      identitySource: { ...orevxSite().identitySource, endpoint: 'https://evil.example.com/api/user/me' },
    } as SiteConfig;
    const fetchMock = fetchOrevx(cborResponse(cborFixture({ points: 1 })));
    vi.stubGlobal('fetch', fetchMock);

    expect(await captureBalance(site)).toBeNull();
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('evil.example.com'))).toBe(true);
  });

  it('没有 token 时不发跨域请求', async () => {
    stubOrevxEnv('', null);
    const fetchMock = fetchOrevx(cborResponse(cborFixture({ points: 1 })));
    vi.stubGlobal('fetch', fetchMock);

    expect(await captureBalance(orevxSite())).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('server.orevx.ai'))).toBe(false);
  });
});

describe('decodeCrossOriginPayload 解注入带回的跨域响应', () => {
  it('CBOR 字节（base64 包装）解成对象', () => {
    const base64 = Buffer.from(cborFixture({ points: 789 })).toString('base64');
    expect(decodeCrossOriginPayload('application/cbor', base64)).toMatchObject({ points: 789 });
  });

  it('JSON 字节按 content-type 解析', () => {
    const base64 = Buffer.from(JSON.stringify({ points: 321 }), 'utf8').toString('base64');
    expect(decodeCrossOriginPayload('application/json; charset=utf-8', base64)).toMatchObject({ points: 321 });
  });

  it('坏 base64 / 坏 CBOR / 未知 content-type 都返回 null，不抛', () => {
    expect(decodeCrossOriginPayload('application/cbor', '!!!not-base64!!!')).toBeNull();
    expect(decodeCrossOriginPayload('application/cbor', Buffer.from([0x9f, 0xff]).toString('base64'))).toBeNull();
    expect(decodeCrossOriginPayload('text/html', Buffer.from('<html></html>', 'utf8').toString('base64'))).toBeNull();
  });
});

describe('crossOriginBalanceProbe 注入用的跨域读取描述', () => {
  it('orevx 形态：返回接口地址与 token 存储键', () => {
    expect(crossOriginBalanceProbe(orevxSite())).toEqual({
      url: 'https://server.orevx.ai/api/user/me',
      tokenKey: 'auth-token',
    });
  });

  it('token 存储位置与头部覆盖原样带入', () => {
    const site = {
      ...orevxSite(),
      identitySource: {
        ...orevxSite().identitySource,
        tokenStorageType: 'sessionStorage',
        tokenHeader: 'X-API-Token',
        tokenPrefix: 'Token ',
      },
    } as SiteConfig;
    expect(crossOriginBalanceProbe(site)).toMatchObject({
      tokenStorageType: 'sessionStorage',
      tokenHeader: 'X-API-Token',
      tokenPrefix: 'Token ',
    });
  });

  it('空字符串前缀（显式不加前缀）也会带上', () => {
    const site = {
      ...orevxSite(),
      identitySource: { ...orevxSite().identitySource, tokenPrefix: '' },
    } as SiteConfig;
    expect(crossOriginBalanceProbe(site)?.tokenPrefix).toBe('');
  });

  it('端点越界 / 缺 tokenKey / 没配身份扩展都返回 null', () => {
    const evil = {
      ...orevxSite(),
      identitySource: { ...orevxSite().identitySource, endpoint: 'https://evil.example.com/api/user/me' },
    } as SiteConfig;
    expect(crossOriginBalanceProbe(evil)).toBeNull();

    const noTokenKey = {
      ...orevxSite(),
      identitySource: { storageKey: 'auth-user', endpoint: 'https://server.orevx.ai/api/user/me' },
    } as SiteConfig;
    expect(crossOriginBalanceProbe(noTokenKey)).toBeNull();

    const none = { ...orevxSite(), identitySource: undefined } as SiteConfig;
    expect(crossOriginBalanceProbe(none)).toBeNull();
  });
});
