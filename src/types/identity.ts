/**
 * 账号身份信息（`Account.identity` 槽位）。
 *
 * 存的是登录后才能知道、且后续请求需要复用的东西。
 * 典型是 new-api 系的数字用户 ID —— 它必须作为
 * `New-API-User` 请求头发出去，否则接口返回 401。
 *
 * 参考项目让用户自己去 F12 的 Network 面板里翻这个值。
 * 扩展跑在真实浏览器里，登录成功后直接从
 * `/api/user/self` 的 `data.id` 读出来存下即可。
 *
 * 阶段三起由账号身份任务独占。
 */
export interface AccountIdentity {
  /** 上游用户 ID，new-api 系的 user-id 请求头要用 */
  userId?: string;
  /** 站点返回的用户名，用于下次执行时辅助核对身份 */
  username?: string;
  /** 站点返回的用户名，可能与登录名不同 */
  displayName?: string;
  /** 站点返回的邮箱，用于核对登录的是不是本账号 */
  email?: string;
  /** 身份字段最后一次读取来源；只有站点 API 可建立第三方登录的长期名称映射。 */
  source?: 'api' | 'storage' | 'visible';
  /**
   * 这个用户 ID 是扩展**亲自用该账号保存的 GitHub 凭据登录后**在站点上读到的。
   *
   * 第三方登录的站点常只在页面上显示用户 ID（没有可调用的身份接口），`source` 只能是
   * `visible`；但会话是扩展在 github.com 上用这个账号的凭据提交出来的，ID 归属有据可查。
   * 有它时这个 ID 可以作为以后的核对基准（与 `source === 'api'` 同等对待）。
   */
  verifiedByManagedLogin?: boolean;
  /** 用户所属分组，影响可用模型和倍率 */
  group?: string;
  /** 最后一次成功读取身份的时间戳 */
  fetchedAt?: number;
  /** 抓取到的登录会话，见下 */
  session?: CapturedAuthSession;
}

/**
 * 从站点页面抓下来的登录会话。
 *
 * 为什么要存这个：有些站点（Sub2API 系、只能第三方登录的站点）没有
 * 可自动填的账密表单，或者登录要过人机验证。让用户手动登录一次、
 * 把会话抓下来，之后签到就不用再登录 —— 这是「GitHub 账号登录的站点
 * 设置起来麻烦」的解法。
 *
 * ⚠️ 关键设计：**accessToken 是短命的，refreshToken 才是要长期保存的那个。**
 * Sub2API 的 access token 由前端在到期前约 2 分钟用 refresh token 换新
 * （见 automation/token-refresh.ts）。所以只存 access token 的话，
 * 用户抓完过几分钟就失效了。
 */
export interface CapturedAuthSession {
  /** 短命的访问令牌，签到时先看它过没过期 */
  accessToken?: string;
  /** 长命的刷新令牌，真正让会话能活下去的东西 */
  refreshToken?: string;
  /** accessToken 的到期时间戳（毫秒） */
  tokenExpiresAt?: number;
  /** 抓取时间，用于界面显示「多久前抓的」 */
  capturedAt: number;
  /** 抓取时页面所属的站点系统，防止把 A 站的会话用到 B 站 */
  siteType?: string;
}
