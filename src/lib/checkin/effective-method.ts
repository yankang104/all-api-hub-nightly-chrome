import type { Account, CheckinMethod, LoginMethod, SiteConfig } from '@/types';

/** 两级都没配时的兜底：绝大多数站点就是账密表单 */
export const DEFAULT_LOGIN_METHOD: LoginMethod = 'form';
/** 站点没配签到方式时继续扫描页面；只有显式 none 才能按“登录即签到”收尾。 */
export const DEFAULT_CHECKIN_METHOD: CheckinMethod = 'auto';

/**
 * 方式是从哪一级来的。
 *
 * 区分「站点默认」和「内置默认」而不是笼统说一个：两级都没配时，值来自代码里的
 * 兜底常量，此时说「站点默认」会让人去站点配置里找一个根本不存在的设置。
 */
export type MethodSource = '账号级' | '站点默认' | '账号凭据' | '内置默认';

export interface EffectiveMethods {
  loginMethod: LoginMethod;
  loginMethodSource: MethodSource;
  /** 签到流程始终由站点定义，所有本站账号共用。 */
  checkinMethod: CheckinMethod;
}

/**
 * 空字符串按「没配」处理，不按值处理。
 *
 * 类型上 LoginMethod 不包含 ''，但 storage 里是没校验过的 JSON：界面用 '' 当
 * 「跟随站点」的哨兵值，早期版本或手改过的数据都可能把它落盘。真把 '' 当值用，
 * 引擎里所有 method === 'xxx' 判断全不命中，行为看起来像兜底，日志却显示配了 ——
 * 最难查的那种不一致。取值和来源都走同一个分支，两者就不可能对不上。
 */
function pickLevel<T extends string>(
  accountLevel: T | undefined,
  siteLevel: T | undefined,
  fallback: T,
): { value: T; source: MethodSource } {
  if (accountLevel) return { value: accountLevel, source: '账号级' };
  if (siteLevel) return { value: siteLevel, source: '站点默认' };
  return { value: fallback, source: '内置默认' };
}

type LoginAccount = Pick<Account, 'loginMethod'> & Partial<Pick<
  Account,
  'password' | 'githubUsername' | 'githubPassword'
>>;

/**
 * `auto` 只根据完整且唯一的一组账号凭据选择登录通道。
 *
 * GitHub 凭据与站点密码同时存在通常是旧版本遗留数据。此时返回 null，交给
 * 引擎在确认当前未登录后明确停止，不能擅自选一个入口把账号签到记错。
 */
function loginMethodFromCredentials(account: LoginAccount): Extract<LoginMethod, 'form' | 'github'> | null {
  const hasFormCredentials = !!account.password;
  const hasGithubCredentials = !!account.githubUsername?.trim() && !!account.githubPassword;

  if (hasFormCredentials === hasGithubCredentials) return null;
  return hasGithubCredentials ? 'github' : 'form';
}

/**
 * 按「账号覆盖 → 站点默认 → 内置默认」解析本次实际要用的登录和签到方式。
 *
 * 抽成纯函数的原因：这条优先级同时被 background（投任务前）和界面（显示当前生效
 * 配置）需要，而 content script 只拿到算好的结果。留在 launchAccount 里就得在
 * 自动化层再复制一份判断，两处一旦走偏就会出现「界面显示走 token，实际跑了表单」
 * 这种对不上的账，而且埋在需要 chrome.tabs 的函数里没法测。
 */
export function resolveEffectiveMethods(
  account: LoginAccount,
  site: Pick<SiteConfig, 'loginMethod' | 'checkin'>,
): EffectiveMethods {
  const login = pickLevel(account.loginMethod, site.loginMethod, DEFAULT_LOGIN_METHOD);
  const credentialMethod = login.value === 'auto' ? loginMethodFromCredentials(account) : null;
  return {
    loginMethod: credentialMethod ?? login.value,
    loginMethodSource: credentialMethod ? '账号凭据' : login.source,
    checkinMethod: site.checkin?.method || DEFAULT_CHECKIN_METHOD,
  };
}

/** 某种登录方式下，用户需要手填哪种凭据 */
export interface LoginCredentialNeeds {
  /** 要密码：引擎会把它填进登录表单 */
  password: boolean;
  /** 要 token：引擎会把它注入页面存储 */
  token: boolean;
  /** 抓来的登录态能顶替手填凭据 */
  sessionCounts: boolean;
  /** 需要 GitHub 账号密码（仅 GitHub OAuth 页使用） */
  github: boolean;
  /** 使用浏览器原生 Passkey */
  passkey: boolean;
}

/**
 * 按登录方式说明该账号需要哪些凭据。
 *
 * 为什么要有这个函数：凭据需求是**按登录方式**分四种的，但界面上曾经只分
 * 「token 站点」和「其他」两种，于是 oauth 落进了 else 分支被要求填密码 ——
 * 而 OAuth 账号根本没有密码可填（凭据是浏览器里第三方平台的登录态），
 * 结果保存按钮永远点不亮，OAuth 账号加不进来。
 *
 * 各方式读什么由 automation/engine.ts 决定，这里必须跟它一致：
 *  - form         读 task.password，填进站点表单
 *  - auto         保存界面先收集站点密码；运行时再由 resolveEffectiveMethods
 *                 把唯一的站点密码或 GitHub 凭据解析成具体方式
 *  - oauth        只点按钮，password 和 apiToken 都不读
 *  - token        读 task.session.accessToken 或 task.apiToken
 *
 * 写成对联合类型穷举的 switch：以后往 LoginMethod 加成员，这里会编译不过，
 * 而不是悄悄落进某个分支给出错误的必填项。
 */
export function loginCredentialNeeds(method: LoginMethod): LoginCredentialNeeds {
  switch (method) {
    case 'token':
      return { password: false, token: true, sessionCounts: true, github: false, passkey: false };
    case 'github':
      return { password: false, token: false, sessionCounts: false, github: true, passkey: false };
    case 'passkey':
      return { password: false, token: false, sessionCounts: false, github: false, passkey: true };
    // OAuth 的凭据在浏览器里（GitHub / LinuxDO 等平台的登录态），不在本扩展里
    case 'oauth':
      return { password: false, token: false, sessionCounts: false, github: false, passkey: false };
    case 'form':
    case 'auto':
      return { password: true, token: false, sessionCounts: false, github: false, passkey: false };
  }
}

/**
 * 生成步骤日志里那行方式说明。
 *
 * ⚠️ 开头的「登录方式：」被 automation/diagnostics.ts 的 NON_SYMPTOM_PATTERNS
 * 按前缀排除。改这里的措辞必须同步改那条正则，否则这行会参与失败分类：它每次都
 * 出现，一旦被当成症状，所有失败都会被染成同一类。effective-method.test.ts 里有
 * 一条测试跨过这个接缝锁着，改坏了会红。
 */
export function describeEffectiveMethods(methods: EffectiveMethods): string {
  return `登录方式：${methods.loginMethod}（${methods.loginMethodSource}）`
    + `；签到方式：${methods.checkinMethod}（站点配置）`;
}
