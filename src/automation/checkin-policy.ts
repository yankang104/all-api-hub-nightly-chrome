/**
 * 「本轮刚全新登录过，relogin 站点该不该再退出重登」的决策。
 *
 * 从 engine 的 verify / verify-oauth 收尾里抽出来，理由与 identity-policy 相同：
 * 这段判断决定「会不会白白多登一次、把刚到账的奖励流程搅乱」，必须被单元测试
 * 锁住；而 engine 依赖真实 DOM、chrome API 和跨页跳转，测不了。
 *
 * 背景（Agent Router / AnyRouter 系）：这类站点的每日额度是靠**一次登录**发放的，
 * 不是点签到按钮。用户把签到方式配成「退出再登录」(relogin) 是为了在**打开时
 * 本来就已登录**的情况下也能强制拿奖励（退出 → 重登才触发发放）。可是如果本轮
 * 我们**本来就是**从未登录状态全新登录进来的，那这次登录已经把今天的奖励拿到手了 ——
 * 再走 relogin 的退出重登就是多余的第二次登录，正是用户抱怨的「一股脑退出重登」。
 */
import type { CheckinMethod } from '@/types';

export interface FreshLoginCheckinInput {
  /**
   * 本次实际使用的签到方式（账号级覆盖 ?? 站点默认 ?? 内置默认）。
   * 由 engine 解析好再传进来，这里不碰 storage / DOM。
   */
  checkinMethod: CheckinMethod;
  /**
   * 本轮是否刚刚完成了一次**全新登录**。
   *
   * engine 只在 verify / verify-oauth 分支传 true —— 能走到那两个 stage，必然是
   * 本轮自己提交了表单或点了 OAuth（submitLogin / clickOAuthButton 通过 markStage
   * 推进的），也就是「从未登录到已登录」发生在本轮。「打开时本来就已登录」的路径
   * 不传 true，见下方 run-configured-method 的说明。
   */
  freshLogin: boolean;
}

export type FreshLoginCheckinDecision =
  /**
   * 按「登录即签到」收尾：把签到方式压成 none。
   *
   * 登录本身已触发奖励，performCheckin('none') 会照常跑余额守恒差分，登录带来的
   * 额度增长正好被它确认成功 —— 不再退出重登。overrideMethod 带出来而不是让 engine
   * 再写死一次 'none'，让「压成哪种方式」只有这一个来源。
   */
  | { action: 'login-as-checkin'; overrideMethod: 'none'; reason: 'fresh-login-earned-reward' }
  /**
   * 照原方式跑签到（默认路径，不覆盖任何东西）。
   *
   * 覆盖两类情形，对应两个 reason：
   *  - 'not-relogin'      不是 relogin：别的方式（none/button/api/claim/auto/workflow）
   *                       在全新登录后本就该照常执行，短路只针对 relogin。
   *  - 'not-fresh-login'  是 relogin 但**不是**本轮全新登录，即「打开时本来就已登录」——
   *                       我们这次访问不会触发发奖励，必须靠退出重登才能拿到，
   *                       relogin 正是为此存在，不能短路。
   */
  | { action: 'run-configured-method'; reason: 'not-relogin' | 'not-fresh-login' };

/**
 * 决定全新登录确认点（verify / verify-oauth）之后怎么收尾。
 *
 * 唯一会短路成「登录即签到」的组合：relogin + 本轮全新登录。其余一律照原方式跑。
 * 先判「不是 relogin」再判「不是全新登录」，两个不短路的理由就能各自成立、分别测。
 */
export function decideFreshLoginCheckin(input: FreshLoginCheckinInput): FreshLoginCheckinDecision {
  if (input.checkinMethod !== 'relogin') {
    return { action: 'run-configured-method', reason: 'not-relogin' };
  }
  if (!input.freshLogin) {
    return { action: 'run-configured-method', reason: 'not-fresh-login' };
  }
  return { action: 'login-as-checkin', overrideMethod: 'none', reason: 'fresh-login-earned-reward' };
}
