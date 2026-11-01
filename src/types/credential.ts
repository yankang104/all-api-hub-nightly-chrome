/**
 * 常用凭据（reusable credential presets）数据模型。
 *
 * 背景：同一个 GitHub 账号（或同站点的账号）会在多个站点的账号表单里反复手输。
 * 本模块提供「已保存凭据 → 下拉直接选择」的能力：
 *
 *  - 候选 = 自动收集自已保存账号的凭据 + 手动「存为常用」的预设（CredentialPreset）。
 *  - 自动收集是只读派生，不落盘；手动预设持久化在
 *    chrome.storage.local['credentialPresets']（键名见 lib/credential/credential-store.ts），
 *    账号删除后依然保留。
 *
 * 安全说明与账号密码一致：明文存于本机 chrome.storage.local，不上传任何服务器；
 * 界面下拉只显示用户名与来源，密码只有选中后才进入表单的 password 输入框。
 */

/** 凭据种类：站点账密（按站点/同主机过滤）或 GitHub 账密（跨站点复用） */
export type CredentialKind = 'site' | 'github';

/** 手动保存的常用凭据（持久化条目） */
export interface CredentialPreset {
  id: string;
  kind: CredentialKind;
  username: string;
  password: string;
  /** 用户起的名字，可选；留空时界面显示 username */
  label?: string;
  /** 保存或最近一次更新的时间戳（毫秒） */
  updatedAt: number;
  /** kind='site' 且从某站点保存时记录来源站点，用于该站点的候选优先排序 */
  siteId?: string;
  /** 最近一次被选中回填的时间戳（毫秒），用于排序 */
  lastUsedAt?: number;
  /** 被选中回填的次数 */
  useCount?: number;
}

/**
 * 下拉候选：手动预设与账号派生凭据的统一视图。
 *
 * 密码必然存在 —— 界面绝不能把密码渲染为文本；只允许「选中后写入表单」。
 */
export interface CredentialCandidate {
  /** 稳定标识：手动预设用预设 id；账号来源用 `account:<accountId>:<kind>` */
  id: string;
  kind: CredentialKind;
  username: string;
  password: string;
  /** 界面主标题：预设备注 > 用户名 */
  label: string;
  /** 来源类型 */
  origin: 'manual' | 'account';
  /** origin='manual'，或该凭据同时存在手动预设时非空 */
  presetId?: string;
  /** origin='account' 时的来源账号（去重后保留最新的那个） */
  accountId?: string;
  /** 该凭据首次出现的站点 id（仅 kind='site' 有意义） */
  siteId?: string;
  /** 站点名，界面副标题用 */
  siteName?: string;
  /** 排序用：最近使用/保存时间（毫秒） */
  updatedAt: number;
  lastUsedAt?: number;
  useCount?: number;
  /** 同一凭据被多少个账号使用（界面可显示「已在 N 个账号使用」） */
  accountCount?: number;
}
