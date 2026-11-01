import type { RewardSymbol } from './metrics';

/**
 * 账号余额（`KEYS.balances` 存储槽）。
 *
 * 与 `TaskTontext.balanceBefore/After`（签到期间的前后快照，用于守恒差分）
 * 是两件事：那两个是**过程量**，只在一次签到内有意义；这个是**账号状态**，
 * 跨签到存活，界面上随时要显示。
 */

export type BalanceSource = 'api' | 'visible';

/** 某一天内的一次余额采样。 */
export interface BalancePoint {
  quota: number;
  usedQuota: number;
  /** 页面明确显示的余额币种；接口未提供币种时可沿用最近一次已知值。 */
  symbol?: RewardSymbol;
  at: number;
  source: BalanceSource;
}

/** 按本地日期保存的余额台账。 */
export interface DailyBalanceRecord {
  /** 当天第一次成功采样，和 latest 的差额可核对当天发生的变化。 */
  first?: BalancePoint;
  /** 当天最近一次成功采样。 */
  latest?: BalancePoint;
  /** 页面或接口明确给出的当天签到奖励。 */
  checkinReward?: number;
  /** 当天签到奖励在页面上的显示符号；不改变余额原始单位。 */
  checkinRewardSymbol?: RewardSymbol;
  checkinRewardAt?: number;
}

/** 某个账号最近一次读到的余额 */
export interface AccountBalance {
  /**
   * 剩余额度，**站点原始单位，不做换算**。
   *
   * 为什么不存换算后的美元：换算要 `quotaPerUnit` 和适配器 family，
   * 那两个值属于站点配置、用户随时能改。存换算结果的话，用户改完
   * quotaPerUnit 之后界面会一直显示按旧系数算出来的历史错值，
   * 而它看起来跟正常数字一模一样。原始值 + 展示时换算不会有这个问题。
   */
  quota: number;
  /**
   * 累计已用额度。
   *
   * 页面正文兜底读到的余额没有这一项，如实记 0（见 balance.ts 的
   * readVisibleBalance）—— 不编数字。
   */
  usedQuota: number;
  /** 页面明确显示的余额币种；旧数据和无币种接口可以没有该字段。 */
  symbol?: RewardSymbol;
  /** 采样时刻，界面显示「几分钟前更新」 */
  at: number;
  /** 最新快照来自结构化接口还是页面可见文本。 */
  source?: BalanceSource;
  /** YYYY-MM-DD → 当日余额；最多保留最近 90 个日期。 */
  daily?: Record<string, DailyBalanceRecord>;
  /** Page check-in ledger reward in the site's raw quota unit. */
  checkinReward?: number;
  /** Display symbol of the page check-in ledger reward. */
  checkinRewardSymbol?: RewardSymbol;
  /** Local date (YYYY-MM-DD) for checkinReward. */
  checkinRewardDay?: string;
  /** When the page ledger reward was last observed. */
  checkinRewardAt?: number;
  /**
   * 这次没读到余额的原因。
   *
   * 必须存下来：站点没有余额接口、登录态失效、被代理挡住，对用户是
   * 三种完全不同的处置。界面留空只会让人以为是扩展坏了。
   * 有 error 时 quota/usedQuota 是上一次成功的值（若从未成功则为 0）。
   */
  error?: string;
}
