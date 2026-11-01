import { describe, expect, it } from 'vitest';
import type { LastResult } from '@/types';
import type { CheckinVerdict } from '@/types/metrics';
import { describeEvidence, evidenceOf, isEvidenceBacked } from '@/lib/checkin/checkin-evidence';

function result(patch: Partial<LastResult> = {}): LastResult {
  return { accountId: 'a', ok: true, message: '签到成功', steps: [], at: 0, ...patch };
}

const withVerdict = (verdict: CheckinVerdict) => result({ metrics: { verdict } });

describe('evidenceOf', () => {
  it('额度变多 → verified，这是唯一的硬证据', () => {
    expect(evidenceOf(withVerdict('rewarded'))).toBe('verified');
  });

  it('页面新显示奖励但余额未同步 → reported，不冒充额度差分', () => {
    expect(evidenceOf(result({ metrics: {
      verdict: 'rewarded', reward: 2_975_000, source: 'visible-reward',
    } }))).toBe('reported');
  });

  it('读到了额度但没变多 → observed（今天已签过就是这样）', () => {
    expect(evidenceOf(withVerdict('unchanged'))).toBe('observed');
    expect(evidenceOf(withVerdict('already-used'))).toBe('observed');
  });

  it('没读到额度 → unverified，「成功」只是站点文案说的', () => {
    expect(evidenceOf(withVerdict('unknown'))).toBe('unverified');
    // relogin 方式和认不出族的站点走的就是这条：压根没有 metrics
    expect(evidenceOf(result())).toBe('unverified');
    expect(evidenceOf(result({ metrics: {} }))).toBe('unverified');
  });

  it('手动标记 → manual，且优先于任何残留 metrics', () => {
    expect(evidenceOf(result({ manual: true }))).toBe('manual');
    // 手动标记时扩展没跑，上一轮的 metrics 跟这次无关，不能拿来充当证据
    expect(evidenceOf(result({ manual: true, metrics: { verdict: 'rewarded' } }))).toBe('manual');
  });

  it('失败和 attention 不分级 —— 失败本身就是信息', () => {
    expect(evidenceOf(result({ ok: false }))).toBeNull();
    expect(evidenceOf(result({ ok: false, message: '需要人工验证' }))).toBeNull();
  });

  it('没有结果时返回 null，不假设任何证据', () => {
    expect(evidenceOf(undefined)).toBeNull();
  });
});

describe('isEvidenceBacked', () => {
  it('只有实际读到额度的两级算有证据支撑', () => {
    expect(isEvidenceBacked('verified')).toBe(true);
    expect(isEvidenceBacked('observed')).toBe(true);
    expect(isEvidenceBacked('reported')).toBe(false);
    expect(isEvidenceBacked('unverified')).toBe(false);
    expect(isEvidenceBacked('manual')).toBe(false);
    expect(isEvidenceBacked(null)).toBe(false);
  });
});

describe('describeEvidence', () => {
  it('每个级别都有解释，否则界面上的提示会是空的', () => {
    for (const evidence of ['verified', 'reported', 'observed', 'unverified', 'manual'] as const) {
      expect(describeEvidence(evidence)).toBeTruthy();
    }
    expect(describeEvidence(null)).toBeNull();
  });

  it('明确已签到的台账证据使用重复执行说明', () => {
    const value = describeEvidence('observed', result({
      metrics: { verdict: 'unchanged', source: 'checkin-ledger' },
    }));
    expect(value).toBe('站点明确显示今日已签到，本次未重复点击，余额未变化');
  });

  it('当天奖励台账不是余额守恒硬证据', () => {
    const value = result({ metrics: {
      verdict: 'rewarded', reward: 6_040_000, source: 'checkin-ledger',
    } });
    expect(evidenceOf(value)).toBe('reported');
    expect(describeEvidence('reported', value)).toBe('签到卡记录了今天的奖励，余额差分未确认本轮增加');
  });
});
