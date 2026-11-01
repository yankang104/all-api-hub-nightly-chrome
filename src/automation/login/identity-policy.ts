/**
 * 「已登录状态下该不该继续签到」的决策。
 *
 * 从 engine 的主管线里抽出来，因为这段判断是**多账号安全的核心**：判错的代价
 * 不是签到失败，而是给错账号签了到 —— 界面显示 B 已签到，B 实际一天没签，
 * 而用户没有任何线索能发现。这种错误必须被单元测试锁住，而 engine 依赖
 * 真实 DOM、chrome API 和跨页跳转，测不了。
 */
import type { LoginMethod } from '@/types';
import type { IdentityVerdict } from '@/automation/login/identity';

/** 第三方身份登录；其中 GitHub 在保存了专用凭据时仍可由扩展受控切号。 */
export function isExternalIdentityLogin(method: LoginMethod): boolean {
  return method === 'oauth' || method === 'github' || method === 'passkey';
}

export type IdentityAction =
  /** 身份已确认，继续签到 */
  | { action: 'proceed'; reason: 'confirmed' }
  /**
   * 读不到身份，但本站只配了这一个账号 —— 不存在记错账的可能，继续。
   * 多账号时绝不能走这条。
   */
  | { action: 'proceed'; reason: 'single-account' }
  /** 本轮自己刚登录过，登录态就是本任务账号，无需再核对 */
  | { action: 'proceed'; reason: 'already-confirmed-this-run' }
  /**
   * 当前页读不到身份，但签到页读得到 —— 先过去再判，别在证据最少的地方拍板。
   *
   * 新版 new-api 界面（1412 等）把 JWT 只放在内存里，落地页的 localStorage 和
   * 接口都拿不到身份；而 `/profile` 上明明白白印着「用户 ID 436」。旧逻辑在
   * 落地页就把闸门关了：单账号站靠 `single-account` 放行（结论碰巧对，理由是空的），
   * 多账号站直接 `handoff` 停下来要人工确认 —— 而跳一页就能自动答上来。
   *
   * 延后是安全的：导航本身是只读的，签到页那道核对不符即失败。
   */
  | { action: 'defer-to-checkin-page'; reason: 'identity-visible-on-checkin-page' }
  /** 交给用户在浏览器里处理，不做破坏性操作也不盲签 */
  | { action: 'handoff'; reason: 'mismatch-external' | 'unknown-multi-account' }
  /** 退出当前账号后重新登录（只对扩展持有凭据的方式有意义） */
  | { action: 'switch-account'; reason: 'mismatch' | 'unknown' };

export interface IdentityDecisionInput {
  /** 本次实际使用的登录方式 */
  loginMethod: LoginMethod;
  /** 身份核对结论 */
  verdict: IdentityVerdict['match'];
  /** 本站点配置的账号总数；未知时按保守处理（视为可能多账号） */
  siteAccountCount?: number;
  /** 本轮任务是否已经亲自完成过登录 */
  identityConfirmedThisRun?: boolean;
  /** 扩展是否具备完整且受限的自动切号能力（目前仅保存了凭据的 GitHub 登录）。 */
  canSwitchAccount?: boolean;
  /**
   * 还有一个「同源、且不是当前页」的签到页可以去。
   *
   * 由 engine 计算（checkin.url 存在、同源、与当前地址不同）。只有为 true 时
   * 才可能延后判断 —— 否则延后就是原地打转。
   */
  checkinPageAvailable?: boolean;
}

/**
 * 决定已登录状态下的下一步。
 *
 * 三条不可违反的规则，也是三类历史 bug 的防线：
 *
 *  1. `unknown` 不等于「可以签」。读不到身份就直接签，等于关掉身份核对；
 *     只有「本站仅此一个账号」才能安全继续，否则必须停下来、重登或先去核对。
 *  2. 没有受控切号能力的第三方登录不得走 switch-account；保存了专用凭据的
 *     GitHub 登录可以先退出站点与 GitHub，再用目标账号重新授权。
 *  3. 扩展持有凭据的方式（form/auto/token/受管 GitHub）遇到**明确对不上**就重登。
 *
 * ── `unknown` 分支的策略顺序（本次修复的核心）─────────────────────────────
 *
 * 顺序按「先核对、再决定是否退出」排，破坏性从小到大：
 *
 *  1. `defer-to-checkin-page`：还有专门的签到页可去 → 先过去核对。
 *     导航是只读的，签到页那道核对不符即失败，所以多花一页换一个**有证据的**
 *     结论永远划算。这一条必须最先，因为它对「任何登录方式 × 任何账号数」都成立。
 *  2. `canSwitchAccount`：受管的 GitHub 会话可以在签到页之外确认换号能力 → 重登。
 *     留着它是因为它比下面两条更**确定**：扩展知道自己能退站点 + 退 GitHub 再授权。
 *  3. `single-account`：本站只配了这一个账号 → 不存在记错账的可能，继续。
 *     只取决于账号数，不取决于登录方式：外部登录早就靠它放行，而 form/auto/token
 *     若在这里反而清 Cookie 重登同一个账号，就是白付一轮登录（还可能被验证码、
 *     退出接口卡住）。这是本次唯一的行为放宽，且不触碰下面的底线。
 *  4. `switch-account`（非外部登录）：确实可能给错账号签到 → 清会话重登。
 *  5. `handoff`（外部登录且无受控切号能力）：宁可要用户确认一步，也不冒险。
 *
 * 旧顺序把 4 放在了 1/2/3 前面，于是对 form/auto/token **无条件**先毁灭会话：
 * 用户日志里那句「无法确认当前登录身份（读不到当前登录身份），按切换账号处理」
 * 后面紧跟「已清除本站浏览器 Cookie 2 项（含 HttpOnly）」，而几步之后「进入签到页:
 * /profile」 —— 身份本可以在签到页读出来，会话却已经被销毁，既白费一轮完整登录，
 * 也可能把本来对得上的账号判成错的。
 *
 * 底线没有因此变松：**「读不到身份就给可能错误的账号签到」在任何登录方式、任何
 * 账号数下都不可能发生**。`proceed` 只有三个出口 —— 明确 `confirmed`、本轮亲自
 * 登录过（`already-confirmed-this-run`）、以及 `siteAccountCount === 1`
 * （只有**恰好一个**才成立，0 和 undefined 都按多账号处理）。
 */
export function decideIdentityAction(input: IdentityDecisionInput): IdentityAction {
  if (input.identityConfirmedThisRun && input.verdict !== 'mismatch') {
    return { action: 'proceed', reason: 'already-confirmed-this-run' };
  }

  const external = isExternalIdentityLogin(input.loginMethod);

  if (input.verdict === 'confirmed') {
    return { action: 'proceed', reason: 'confirmed' };
  }

  if (input.verdict === 'mismatch') {
    return !external || input.canSwitchAccount
      ? { action: 'switch-account', reason: 'mismatch' }
      : { action: 'handoff', reason: 'mismatch-external' };
  }

  // ── verdict === 'unknown'：先核对，再决定是否退出 ──────────────────────

  /**
   * 1. 读不到身份，但还有专门的签到页 —— 先过去再说。
   *
   * 这一条必须排在所有退出/放行分支之前，且与登录方式无关：
   *  - 单账号站：不必为了一个空理由（或为了重登同一个账号）先销毁有效会话；
   *  - 多账号站：答案往往就印在签到页上（`/profile` 写着「用户 ID 436」），
   *    跳一页就能自动答上来，而不是停下来要人工确认；
   *  - form/auto/token 站：能真的切号 ≠ 应该先切号。先把会话销毁等于拿一轮完整
   *    登录换一个「也许根本不需要换号」的结论 —— 这正是用户日志里的那次误伤。
   *
   * 排在 mismatch 之后是刻意的：已经确认是别人的账号时不能延后，那是明确结论，
   * 跳一页也不会变。
   *
   * 延后不等于放行：签到页自身仍必须用 userId 或严格账号名核对，首次读到的身份
   * 也不能直接认领；核对不符即失败。
   */
  if (input.checkinPageAvailable) {
    return { action: 'defer-to-checkin-page', reason: 'identity-visible-on-checkin-page' };
  }

  /** 2. 没有签到页可去，但扩展确认自己能受控换号（受管 GitHub）→ 重登。 */
  if (input.canSwitchAccount) return { action: 'switch-account', reason: 'unknown' };

  /**
   * 3. 本站只配了这一个账号 —— 不存在记错账的可能，用最轻的手段继续。
   *
   * 账号数未知时按「可能有多个」处理：宁可让用户确认一步，也不要冒记错账的风险。
   * 严格判 `=== 1`，因此 0 / undefined 都落到下面的保守分支。
   */
  if (input.siteAccountCount === 1) return { action: 'proceed', reason: 'single-account' };

  /**
   * 4/5. 确实可能给错账号签到：
   *  - 扩展持有凭据（form/auto/token）→ 清会话重登本账号；
   *  - 第三方身份登录且无受控切号能力 → 绝不能清会话（只会毁掉有效会话），
   *    也不能当「可以签」，交给用户在浏览器里处理。
   */
  return external
    ? { action: 'handoff', reason: 'unknown-multi-account' }
    : { action: 'switch-account', reason: 'unknown' };
}
