/**
 * 签到度量（`TaskResult.metrics` 槽位）。
 *
 * 用「余额守恒」判断签到到底成没成：
 *
 *   reward = (after.quota + after.usedQuota) - (before.quota + before.usedQuota)
 *
 * 之所以要加上已用额度，是因为签到期间账号可能正在被调用消耗。
 * 只看剩余额度会把「领了 5 块又花了 5 块」误判成没领到；
 * 加上已用之后，总额度只有签到能让它变大，干扰就被消掉了。
 *
 * 这个判据不依赖站点返回什么文案，对 button / relogin 这两种
 * 拿不到结构化响应的方式尤其重要 —— 那是唯一可靠的成功证据。
 *
 * 阶段三起由守恒差分任务独占。
 */

/** 守恒差分得出的三种结论 */
export type CheckinVerdict =
  /** 总额度变多了：确实领到奖励 */
  | 'rewarded'
  /** 总额度没变但有消耗：今天已经签过，期间在用 */
  | 'already-used'
  /** 完全没变：今天已经签过，或本次没领到 */
  | 'unchanged'
  /** 缺少前后快照，无法判断 */
  | 'unknown';

/** 奖励金额来自哪一种观测。旧结果没有该字段时按余额差分兼容处理。 */
export type CheckinEvidenceSource =
  /** 前后额度守恒差分确认 */
  | 'balance-diff'
  /** 站点签到台账确认（后台直连或页面明确显示已签到） */
  | 'checkin-ledger'
  /** 页面在点击后显示了明确的本次奖励 */
  | 'visible-reward';

/** 页面奖励金额的显示单位；不参与 quota 换算或余额守恒计算。 */
export type RewardSymbol = '$' | '¥' | '￥' | '积分';

export interface CheckinMetrics {
  /** 本次签到实得额度，站点原始 quota 单位 */
  reward?: number;
  /** 页面/台账奖励原本使用的显示符号；余额差分结果没有该字段。 */
  rewardSymbol?: RewardSymbol;
  /** 签到期间的消耗额度 */
  usageDelta?: number;
  /** 剩余额度的变化量（reward - usageDelta） */
  balanceDelta?: number;
  /** 守恒差分的结论 */
  verdict?: CheckinVerdict;
  /** 奖励金额的观测来源；老版本结果没有此字段 */
  source?: CheckinEvidenceSource;
  /** 签到后的剩余额度，用于界面展示 */
  quotaAfter?: number;
  /** 签到后余额原本使用的显示符号；余额接口未提供币种时留空。 */
  balanceSymbol?: RewardSymbol;
}
