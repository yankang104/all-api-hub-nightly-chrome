import type { RewardSymbol } from './metrics';

/**
 * 任务上下文（`LoginTask.context` 槽位）。
 *
 * content script 每次整页跳转都会被销毁重建，内存里的东西全丢。
 * 需要跨阶段存活的数据必须写进这里，随 `SET_STAGE` 一起落进
 * `storage.session` 的任务信箱，并受 `runId` 保护。
 *
 * 阶段三起由守恒差分任务独占。
 */

/** 某一时刻的额度快照，单位是站点原始 quota，不做换算 */
export interface BalanceSnapshot {
  /** 剩余额度 */
  quota: number;
  /** 累计已用额度 */
  usedQuota: number;
  /** 页面明确显示的余额币种；接口未提供币种时留空。 */
  symbol?: RewardSymbol;
  /** 采样时间戳 */
  at: number;
  /**
   * 这个快照读自**页面正文**，不是额度接口。
   *
   * 两者的更新时机差很远，决定了签到后要等多久才值得再读一次：
   *  - 接口：签到请求一返回，服务端的数就是新的，等 1 秒足够；
   *  - 正文：页面上那个数字要等 SPA 重新拉一次账户接口才会变，明显更慢。
   *
   * 不区分的话，正文路径会在数字还没刷新时就把三次采样用完，读到的全是
   * 签到前的旧值，于是差分判成「额度无变化」—— 而奖励其实已经到账。
   * 也用于提示 `usedQuota` 是填的 0（正文不显示累计消耗），守恒公式在这条
   * 路径上退化成「余额有没有变多」。
   */
  fromVisibleText?: boolean;
  /**
   * 这个快照读自哪个页面路径。
   *
   * ⚠️ **跨页面的正文余额不能相减。**
   *
   * 实测事故（海獭 AI）：候选路由降级让流程在 `/dashboard/overview` 和
   * `/profile` 之间跳，两页正文印的数字不是同一个口径（一个 $3.00、
   * 一个 $52.58）。基线取自前者、终值取自后者，守恒差分算出「签到获得
   * $49.58」并写进了记录 —— 而站点实际只发了 $3.06。
   *
   * 这比签到失败严重得多：错的收益数字看起来和对的一模一样，用户没有
   * 任何线索能发现。`diffBalance` 必须先核对两个快照来自同一路径，
   * 不同就判 unknown（缺少可比基线），绝不相减。
   *
   * 只对 `fromVisibleText` 的快照要求这个一致性 —— 接口读数是账号级的，
   * 与在哪一页请求无关。
   */
  visiblePath?: string;
}

export interface TaskContext {
  /**
   * 签到前的额度快照。
   *
   * ⚠️ relogin 方式必须在**点退出之前、仍处于登录态时**采集。
   * 退出后再查必然是 401 或 0，会让差值算成 0，
   * 把本来成功的签到误判成「无变化」。
   */
  balanceBefore?: BalanceSnapshot;
  /**
   * `balanceBefore` 的跨页用途。
   *
   * button 只有在真实签到按钮点击前成功落盘后才写 pending 标记。新页面
   * 必须看到这个标记才能把“已完成”页面与旧快照做差，避免普通首次打开
   * 已签到页面时把任务外的余额变化误算成本轮奖励。
   *
   * 旧版 relogin 任务没有该字段；relogin 收尾仍直接读取 `balanceBefore`，
   * 因而升级过程中不会丢失已有基线。
   */
  buttonCheckinPending?: true;
  /**
   * 登录本身会发放签到奖励时，账号上一次成功保存的余额。
   *
   * `none` 方式进入签到模块时登录已经完成，届时再采集 before 会同时读到
   * 登录后的新余额，永远算不出增加量。该字段在任务启动时按 accountId 写入，
   * 只允许本轮明确完成登录后的 `none` 流程消费，不能与 button/relogin 共用。
   */
  loginCheckinBalanceBefore?: BalanceSnapshot;
  /** 签到后的额度快照 */
  balanceAfter?: BalanceSnapshot;
}
