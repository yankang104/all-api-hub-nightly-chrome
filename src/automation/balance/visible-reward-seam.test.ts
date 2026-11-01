/**
 * 页面「今日奖励」作为成功证据的接缝测试。
 *
 * 用户实测（站点「卡皮巴拉API」）：签到确实成功 —— 页面写着「已签到」「今天 +$0.3449」
 * 「累计签到 29 天」—— 但站点把余额显示到**一位小数**（$4.3），
 * $0.3449 小于显示步长，前后两次正文一字不差，守恒差分只能判「额度无变化」，
 * 于是扩展回一句「额度无变化，当前余额 $4.30」，用户看到的就是「我签到了，你显示没有变化」。
 *
 * 这里贴着那张截图的真实文案复刻，锁住修复：差分读不出增长时，页面证据必须能翻案。
 */
import { describe, expect, it } from 'vitest';
import { withVisibleTodayRewardEvidence } from '@/automation/balance/balance';
import type { CheckinMetrics } from '@/types';

/** 截图上那张签到卡的真实文案（余额显示到一位小数）。 */
const CARD_BEFORE = '每日签到 立即签到 累计签到 28 本月获得 $4 累计获得 $9 余额 $4.30';
const CARD_AFTER = '每日签到 已签到 今天 +$0.3449 累计签到 29 本月获得 $4 累计获得 $9 余额 $4.30';

describe('页面今日奖励作为成功证据', () => {
  it('余额显示精度看不出 $0.3449 时，页面证据把结论提升为 rewarded', () => {
    // 差分结论：显示步长吞掉了这次奖励
    const metrics: CheckinMetrics = { verdict: 'unchanged', quotaAfter: 4.3, balanceSymbol: '$' };

    const result = withVisibleTodayRewardEvidence(metrics, { before: CARD_BEFORE, after: CARD_AFTER }, 500_000);

    expect(result.verdict).toBe('rewarded');
    expect(result.source).toBe('visible-reward');
    expect(result.reward).toBeGreaterThan(0);
  });

  it('守恒差分已经看到增长时不改写：那是更硬的证据', () => {
    const metrics = { verdict: 'rewarded' as const, reward: 99, source: 'balance-diff' as const };

    const result = withVisibleTodayRewardEvidence(metrics, { before: CARD_BEFORE, after: CARD_AFTER }, 500_000);

    expect(result).toEqual(metrics);
  });

  it('金额在动作前就已存在时只记为台账，不当作本轮新增', () => {
    /*
     * 「今天 +$0.3449」在动作前后都在页面上（SPA 提前画好的奖励卡）。
     * 它是「今天确实到账了」的可信台账，却**不是**「这一下点击到账了」的证据，
     * 所以来源标为 `checkin-ledger`，界面据此说明「未确认本轮增加」
     * （见 lib/checkin-evidence.ts）。判成 visible-reward 会把历史奖励算成本次战果。
     */
    const metrics: CheckinMetrics = { verdict: 'unchanged' };

    const result = withVisibleTodayRewardEvidence(metrics, { before: CARD_AFTER, after: CARD_AFTER }, 500_000);

    expect(result.source).toBe('checkin-ledger');
  });

  it('只有「已签到」状态、没有金额时不得翻案', () => {
    const metrics = { verdict: 'unchanged' as const };

    const result = withVisibleTodayRewardEvidence(
      metrics,
      { before: '每日签到 立即签到 余额 $4.30', after: '每日签到 已签到 累计签到 29 余额 $4.30' },
      500_000,
    );

    expect(result.verdict).toBe('unchanged');
  });

  it('价格表里的金额不会被误当成奖励', () => {
    const metrics = { verdict: 'unchanged' as const };

    const result = withVisibleTodayRewardEvidence(
      metrics,
      { before: '每日签到 余额 $4.30', after: '每日签到 已签到 标准套餐 +$5.95 余额 $4.30' },
      500_000,
    );

    expect(result.verdict).toBe('unchanged');
  });
});
