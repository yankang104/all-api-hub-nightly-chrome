/**
 * 签到成功的证据分级。
 *
 * 为什么需要它：`ok: true` 这一个布尔值里其实混了三种完全不同的东西 ——
 *
 *   1. 额度确实变多了（守恒差分给出增长）→ 这是硬证据
 *   2. 前后额度都读到了但没变多 → 有观测，只是没看到增长（今天已签过就是这样）
 *   3. 压根没读到额度 → 「成功」只是站点文案说的，扩展没有任何独立证据
 *
 * 第 3 种以前和第 1 种在界面上长得一模一样：都是绿色「已签到」。
 * 这很危险，因为它恰恰是最不可信的一种 —— `sites/index.ts:19` 记的那个
 * 已修 bug 就是活例子：按位置赌的选择器点中签到按钮，站点回「今日已签到」，
 * 本来成功的签到被盖成重复签到。只看文案就会被这种情况骗过去。
 *
 * 哪些情况会落到第 3 种（无证据）：
 *   - `relogin` 方式：`checkin.ts:106` 显式跳过采样（退出登录后查必然 401）
 *   - 认不出族的站点：`balance.ts` 只认 new-api / Sub2API 两族的端点
 *   - 余额接口超时或返回 HTML（SPA 兜底）
 *
 * 分级只做展示用，不改判定 —— 状态该是 done 还是 done，
 * 这里只负责让界面说实话。
 */

import type { LastResult } from '@/types';

export type CheckinEvidence =
  /** 守恒差分看到额度变多，成功有硬证据 */
  | 'verified'
  /** 页面签到卡显示了本次奖励，但余额接口还没有同步 */
  | 'reported'
  /** 前后快照都读到了，但额度没变多（今天已签过，或本次没领到） */
  | 'observed'
  /** 没有前后快照，成功与否只能听站点文案 */
  | 'unverified'
  /** 用户手动断言，扩展没有参与 */
  | 'manual';

/**
 * 判定一条结果的证据级别。
 *
 * 只给成功的结果分级 —— 失败本身就是信息，不需要再谈证据强弱，
 * 所以失败（含 attention，它也是 `ok: false`）一律返回 null。
 */
export function evidenceOf(result: LastResult | undefined): CheckinEvidence | null {
  if (!result?.ok) return null;
  // 手动标记优先：即使附带历史余额差值，它也不是一次自动流程的前后快照。
  if (result.manual) return 'manual';

  const verdict = result.metrics?.verdict;
  if (verdict === 'rewarded') {
    return result.metrics?.source === 'visible-reward' || result.metrics?.source === 'checkin-ledger'
      ? 'reported'
      : 'verified';
  }
  if (verdict === 'unchanged' || verdict === 'already-used') return 'observed';

  // verdict 是 'unknown'、或压根没有 metrics
  return 'unverified';
}

/** 这条成功有没有独立于站点文案的证据支撑 */
export function isEvidenceBacked(evidence: CheckinEvidence | null): boolean {
  return evidence === 'verified' || evidence === 'observed';
}

/** 给界面用的一句话解释，说明这条「已签到」的可信度从哪来 */
export function describeEvidence(evidence: CheckinEvidence | null, result?: LastResult): string | null {
  if (evidence === 'verified') return '额度确实增加了，签到成功可确认';
  if (evidence === 'reported' && result?.metrics?.source === 'checkin-ledger') {
    return '签到卡记录了今天的奖励，余额差分未确认本轮增加';
  }
  if (evidence === 'reported') return '签到卡显示本次奖励，余额接口尚未同步';
  if (evidence === 'observed' && result?.metrics?.source === 'checkin-ledger') {
    return '站点明确显示今日已签到，本次未重复点击，余额未变化';
  }
  if (evidence === 'observed') return '读到了签到前后的额度，但额度没有变化';
  if (evidence === 'unverified') return '读不到额度变化，「成功」仅来自站点提示，扩展无法确认';
  if (evidence === 'manual' && result?.metrics?.verdict === 'rewarded') {
    return '你手动标记的；增加量按已保存余额的总额度差值估算，可能包含同期间其它入账';
  }
  if (evidence === 'manual' && result?.metrics) {
    return '你手动标记的；已比较历史余额，但总额度没有增加';
  }
  if (evidence === 'manual') return '你手动标记的；没有历史余额基线，无法计算增加量';
  return null;
}
