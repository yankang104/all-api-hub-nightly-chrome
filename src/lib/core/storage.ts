/**
 * chrome.storage 的极薄封装。
 *
 * ⚠️ 安全提示：本期账号密码以明文存于 chrome.storage.local。
 * 该数据仅存在于用户本地浏览器配置目录，不上传任何服务器，
 * 但同机其他有文件访问权限的程序理论上可读取。
 * TODO(加密)：后续用 Web Crypto (PBKDF2 派生 + AES-GCM) 以用户主密码加密存储。
 */

export const local = {
  async get<T>(key: string, fallback: T): Promise<T> {
    const r = await chrome.storage.local.get(key);
    return (r[key] ?? fallback) as T;
  },
  async set(key: string, value: unknown): Promise<void> {
    await chrome.storage.local.set({ [key]: value });
  },
  async setMany(values: Record<string, unknown>): Promise<void> {
    await chrome.storage.local.set(values);
  },
  async remove(key: string): Promise<void> {
    await chrome.storage.local.remove(key);
  },
};

export const session = {
  async get<T>(key: string, fallback: T): Promise<T> {
    const r = await chrome.storage.session.get(key);
    return (r[key] ?? fallback) as T;
  },
  async set(key: string, value: unknown): Promise<void> {
    await chrome.storage.session.set({ [key]: value });
  },
  async remove(key: string): Promise<void> {
    await chrome.storage.session.remove(key);
  },
};

export const KEYS = {
  sites: 'sites',
  accounts: 'accounts',
  status: 'status',
  results: 'results',
  proxies: 'proxies',
  /** 每个站点 headless API 直连熔断统计 */
  headlessStats: 'headlessStats',
  /**
   * 每个账号最近一次读到的余额，见 types/balance.ts。
   *
   * 与 results 分开存：余额是账号的持久属性，签到成功与否都该有值 ——
   * 挂在签到结果里会让「从没签到过」「签到失败」「relogin 方式」这三种
   * 情况永远显示不出余额。
   */
  balances: 'balances',
  launchMode: 'launchMode',
  schedule: 'checkinSchedule',
  /** 用户在内置清单里删除过的站点 ID；BUILTIN_SITES 是常量，删除需持久化标记 */
  removedBuiltinSiteIds: 'removedBuiltinSiteIds',
  /**
   * 节点名 → 本机 listener 端口的映射（含 listenerName）。
   *
   * 端口按「名字」锁定而不是按订阅顺序：机场每 10 分钟自动更新、顺序会变，
   * 按下标分配端口会让同一账号悄悄换出口，站点按异地登录风控。换电脑时
   * 这份映射随账号备份一起走，新机器上粘同一段 Script 就能拿到同样的端口。
   */
  listenerPlan: 'listenerPlan',
  /** 自动更新订阅源：URL、开关、上次检查结果。URL 含 token，仅存本地。 */
  subscriptionSource: 'subscriptionSource',
} as const;
