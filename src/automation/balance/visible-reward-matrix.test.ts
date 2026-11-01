import { describe, expect, it } from 'vitest';
import { withVisibleTodayRewardEvidence } from '@/automation/balance/balance';
import type { CheckinMetrics } from '@/types';

const m = (): CheckinMetrics => ({ verdict: 'unchanged', quotaAfter: 4.3, balanceSymbol: '$' });

/** 真实站点措辞 + 「同页还有价格表」这类污染场景的矩阵。 */
const CASES: Array<{ name: string; before: string; after: string; expectReward: boolean }> = [
  { name: '卡皮巴拉API: 今天 +$0.3449', before: '每日签到\n立即签到', after: '每日签到\n已签到\n今天 +$0.3449', expectReward: true },
  { name: '百倍: 今日可得 $1.00', before: '签到', after: '已签到\n今日可得 $1.00', expectReward: true },
  { name: 'new-api: 今日 +CNY 10.31', before: '签到', after: '已签到\n今日 +CNY 10.31', expectReward: true },
  { name: '今日收益 +¥10.31', before: '签到', after: '已签到\n今日收益 +¥10.31', expectReward: true },
  { name: 'Hvoy: 签到成功，已获得 10 积分', before: '签到', after: '签到成功，已获得 10 积分', expectReward: true },
  { name: 'Hvoy: 恭喜获取10积分', before: '签到', after: '签到成功，恭喜获取10积分', expectReward: true },
  // ↓ 污染场景：同页既有签到奖励又有价格表
  { name: '污染A: 今天 +$0.3449 且同页有 标准套餐 +$5.95', before: '立即签到', after: '已签到\n今天 +$0.3449\n标准套餐 +$5.95', expectReward: true },
  { name: '污染B: 积分站同页有 价格表', before: '签到', after: '签到成功，已获得 10 积分\n套餐价格 +$5.95', expectReward: true },
  // ↓ 必须拒绝：金额只是价格，不是奖励
  { name: '必须拒绝: 只有价格没有奖励', before: '立即签到', after: '每日签到\n标准套餐 +$5.95\n余额 $4.30', expectReward: false },
];

describe('页面奖励解析的真实措辞矩阵', () => {
  for (const c of CASES) {
    it(`${c.name} → ${c.expectReward ? '应识别为奖励' : '必须不识别'}`, () => {
      const result = withVisibleTodayRewardEvidence(m(), { before: c.before, after: c.after }, 500_000);
      const got = result.verdict === 'rewarded';
      expect(got, `实际 verdict=${result.verdict} reward=${result.reward ?? '无'}`).toBe(c.expectReward);
    });
  }
});
