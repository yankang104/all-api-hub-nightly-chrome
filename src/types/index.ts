/**
 * 全局数据模型定义。
 *
 * ## 加字段的规矩
 *
 * **结构性扩展**（一组相关字段、会继续长大的子系统）挂到下面四个槽位，
 * 各自定义在独立文件里：
 *
 *   SiteConfig.adapter   → types/adapter.ts       站点是什么系统、怎么跟它打交道
 *   Account.identity     → types/identity.ts      登录后才知道的身份信息
 *   LoginTask.context    → types/task-context.ts  需要跨页面跳转存活的数据
 *   TaskResult.metrics   → types/metrics.ts       签到的量化结果
 *
 * 挂槽位的原因：多个功能同时开发时，往同一个 interface 块里加一组字段
 * 必然互相覆盖。槽位把冲突从「同一段代码」隔离到「不同文件」。
 *
 * **单个标量或选择器字段**可以直接加在对应的 interface 上。硬塞进槽位
 * 反而更糟：`Account.loginMethod` 塞进 identity 就得写成
 * `account.identity?.loginMethod` —— 把一个登录**前**要用的配置值
 * 放进了「登录后才知道的身份」容器里，读的人会以为它是登录结果。
 * CheckinConfig 更是根本没有槽位可挂。
 *
 * 判断标准：这个字段以后会带出一整组同类字段吗？会 → 开槽位；
 * 就它自己 → 直接加，把注释写清楚。
 */

import type { SiteAdapterRef } from './adapter';
import type { AccountIdentity, CapturedAuthSession } from './identity';
import type { TaskContext } from './task-context';
import type { CheckinMetrics } from './metrics';

export type { SiteAdapterRef, SiteCheckinCapability, SiteType, AdapterFamily } from './adapter';
export { SITE_TYPES, ADAPTER_FAMILIES } from './adapter';
export type { AccountIdentity, CapturedAuthSession } from './identity';
export type { AccountBalance, BalancePoint, BalanceSource, DailyBalanceRecord } from './balance';
export type { TaskContext, BalanceSnapshot } from './task-context';
export type {
  CheckinWorkflowConfig,
  CheckinWorkflowCondition,
  WorkflowLearningEvent,
  WorkflowLearningSession,
  CheckinWorkflowStep,
  CheckinWorkflowStepType,
  LearningKind,
  LearnedArtifactKind,
} from './workflow';
export type { CheckinEntryConfig, CheckinEntryStep } from './checkin-entry';
export type { CheckinEvidenceSource, CheckinMetrics, CheckinVerdict, RewardSymbol } from './metrics';
export type { CheckinSchedule } from './schedule';

/** 数据结构版本，用于 storage 迁移 */
export const SCHEMA_VERSION = 1;

/** 站点的表单选择器配置 */
export interface SiteSelectors {
  /** 用户名输入框 */
  username: string;
  /** 密码输入框 */
  password: string;
  /** 登录提交按钮 */
  submit: string;
}

/**
 * 签到方式。登录成功之后真正的「打卡」动作，各站形式不同：
 *  - 'auto'     自动寻找同源签到页、按钮和已签到状态
 *  - 'none'     登录即算签到。只看当前页：页面上正好有签到控件就点，没有就直接成功，
 *               **不会**去别处找签到入口（AnyRouter 这类站点登录本身就是签到，
 *               去 /console/personal 找按钮只会等满超时再报「没找到按钮」）
 *  - 'button'   在某个页面上点签到按钮
 *  - 'api'      直接请求站点的签到接口（带登录 cookie）
 *  - 'relogin'  退出再登录一次才发奖励（如 Agent Router）
 *  - 'claim'    多步领取：点入口 → 等弹窗 → 填一段文本 → 点提交（如 chaiai 的领取权益）
 *  - 'workflow' 声明式工作流：按配置执行跳转、点击、填充、等待和结果断言
 */
export type CheckinMethod = 'auto' | 'none' | 'button' | 'api' | 'relogin' | 'claim' | 'workflow';
export type {
  WorkflowElementFingerprint,
  WorkflowFormControl,
  WorkflowGesture,
  WorkflowKey,
  WorkflowPointerAnchor,
} from './workflow';

/** 签到配置 */
export interface CheckinConfig {
  method: CheckinMethod;

  /** 自动识别中的登录后签到流程；兼容旧 workflow 方法，不执行任意脚本。 */
  workflow?: import('./workflow').CheckinWorkflowConfig;

  /**
   * 用户明确选择「自动识别」时置位：保留 workflow 记录，但不再回放。
   *
   * 旧版学习流程曾以 method:'auto' 保存；升级兼容会把这些历史记录迁到
   * workflow，而该标记保证迁移不会覆盖用户之后主动切回自动识别的选择。
   */
  workflowReplayDisabled?: boolean;

  /**
   * 「登录即签到」来自用户的学习演示（method 为 none 时才有意义）。
   *
   * 与内置模板/旧导入里的 `{method:'none'}` 区分开：后者是历史默认值，迁移和
   * 内置合并可以把它换成新模板；前者是用户亲自演示出的流程，必须原样保留，
   * 也不能被 API 直连签到替代（奖励由登录动作本身触发）。
   */
  learnedLoginAsCheckin?: boolean;
  /** 区分用户明确选择与旧版自动推断，便于只修复误判而不覆盖用户策略。 */
  learnedLoginAsCheckinSource?: 'explicit' | 'auto';

  /** 先通过头像/用户菜单等站内入口进入资料页，再进行身份核对和签到。 */
  entry?: import('./checkin-entry').CheckinEntryConfig;

  /** button：签到按钮不在登录后的落地页时，先跳转到这个地址 */
  url?: string;
  /** auto/button：优先使用的签到按钮选择器 */
  buttonSelector?: string;
  /** auto/button：命中即说明今日已签过，不再点击 */
  alreadySelector?: string;
  /** auto/button：点击后出现即视为成功 */
  successSelector?: string;
  /**
   * auto：主签到按钮之后必须完成的二次领取按钮。
   *
   * 配置后，主卡片提前出现“签到成功/今日已签到”不能结束流程；执行器会等待
   * 该按钮从倒计时禁用态解锁，点击后再验证领取终态。
   */
  claimConfirmSelector?: string;

  /** claim：控制台上打开领取弹窗的入口选择器 */
  claimEntrySelector?: string;
  /** claim：弹窗里要填文本的输入框选择器 */
  claimInputSelector?: string;
  /** claim：要填进去的文本。站点常有最少字数要求 */
  claimText?: string;
  /** claim：弹窗里的提交按钮选择器 */
  claimSubmitSelector?: string;
  /**
   * claim：文本最少多少字，留空用 CLAIM_MIN_LENGTH_DEFAULT。
   * 站点会拒收太短的内容，与其提交后失败，不如提交前就报出来。
   */
  claimMinLength?: number;
  /**
   * claim：站点要求每次的理由都不能与历史重复（如 sharedchat 的领取 Codex 权益）。
   *
   * 置为 true 时不使用固定文本，而是每次从预置句式里挑一条没用过的
   * （用过的记在 claimUsedTexts 里）。固定文本在这类站点上第二次就会被拒。
   */
  claimUniqueText?: boolean;
  /**
   * claim：已经用过的理由，由扩展自动维护，用于满足「不能重复」的要求。
   * 只存本站用过的文本，不跨站共享。
   */
  claimUsedTexts?: string[];

  /** api：签到接口地址（需与站点同源，才能带上登录 cookie） */
  apiUrl?: string;
  /** api：请求方法，默认 POST */
  apiMethod?: 'GET' | 'POST';
  /** api：JSON 请求体 */
  apiBody?: string;
  /**
   * api：从 localStorage 读取 token 并加进请求头。
   * 格式：`"headerName=localStorageKey"`
   * 例：`"New-Api-User=user"` → 读 localStorage["user"] 作为 New-Api-User 头的值。
   * 若值是 JSON 对象，再加 `.field` 取子字段：`"New-Api-User=user.id"`
   */
  localStorageToken?: string;

  /** relogin：退出登录的按钮/菜单项选择器，多个用逗号分隔按序尝试 */
  logoutSelector?: string;
  /** relogin：退出前需要先点开的菜单（如头像下拉），可选 */
  logoutMenuSelector?: string;
  /** relogin：站点提供退出接口时优先用它，比点菜单稳 */
  logoutApiUrl?: string;
  /** relogin：退出后需要清理的本站 localStorage 键，仅删除显式配置项 */
  logoutStorageKeys?: string[];

  /** 响应或页面文本含这些词判为成功，留空用内置词表 */
  successText?: string[];
  /** 响应或页面文本含这些词判为「今日已签到」，留空用内置词表 */
  alreadyText?: string[];
}

/**
 * claimMinLength 留空时的下限，多数领取表单卡在 10 字。
 *
 * 放在模型这一层是因为三个地方要用同一个数：保存时的校验、运行时填文本、
 * 界面上的实时字数提示。各自写个 10 的话，将来改门槛必漏一处，
 * 表现是界面说够了、保存也过了、跑起来被站点拒收。
 */
export const CLAIM_MIN_LENGTH_DEFAULT = 10;

/**
 * 代理配置。
 *
 * ⚠️ chrome.proxy 是**浏览器全局**设置，不是按标签页的。
 * 所以签到任务会在开标签前应用代理、任务结束后还原，
 * 且同一时刻只允许一个代理任务运行（background 里排队）。
 */
export interface ProxyConfig {
  id: string;
  name: string;
  scheme: 'http' | 'https' | 'socks4' | 'socks5';
  host: string;
  port: number;
  /** 需要认证的代理才填 */
  username?: string;
  password?: string;
  /**
   * 名称条目标记。
   *
   * `true` 表示这条只是「订阅或 Clash controller 里的节点名」，仅用于界面显示，
   * **没有浏览器可用的出口**（vmess/vless 等协议 chrome.proxy 根本不认）。
   *
   * ⚠️ 这类条目绝不能进 applyProxy / testProxy —— 那会把一个假的 host:port
   * 设成浏览器全局代理，导致签到全部走空。所有网络路径必须先用
   * isNameOnlyProxy 挡掉，且不能写入新的账号/站点代理绑定，见 lib/proxy-config.ts。
   *
   * 旧数据没有这个字段，一律按真实代理处理，向后兼容。
   */
  nameOnly?: boolean;
  /** 导入来源标签，仅用于界面标注来源（例如 Clash Verge） */
  sourceLabel?: string;
}


/**
 * 登录方式。
 *  - 'form'   账密表单（默认）：填用户名密码并提交
 *  - 'oauth'  OAuth/SSO 按钮：点一个授权按钮，等跳回本站
 *  - 'auto'   自动检测：先识别现有登录态；需要登录时，再按账号保存的唯一一组
 *              站点密码或 GitHub 凭据解析成 form / github
 *  - 'token'  API Token 认证：直接注入 token 到 localStorage，跳过登录表单
 */
export type LoginMethod = 'form' | 'oauth' | 'github' | 'passkey' | 'auto' | 'token';

/** 页面交互方式：生产默认使用浏览器级可信指针，DOM 模式仅供明确配置的受控页面。 */
export type PointerMode = 'trusted' | 'dom';

/** 站点配置 */
export interface SiteConfig {
  id: string;
  /**
   * 迁移来源中的站点 id。
   *
   * 只用于重复导入同一份备份时找回原来的站点。两个登录地址相同的站点仍有
   * 不同的来源 id，因此不会在迁移时被错误合并。
   */
  migrationSourceId?: string;
  name: string;
  /** 登录页地址 */
  loginUrl: string;
  /** 站点图标，留空则自动从域名推断 favicon */
  favicon?: string;
  /** 点击方式，默认 'trusted'；'dom' 仅用于受控测试页等不接受 debugger 并发的环境 */
  pointerMode?: PointerMode;
  /**
   * 登录方式，默认 'form'。
   *  - form   账密表单
   *  - oauth  点 OAuth 按钮（可填 oauthButtonSelector；留空时自动识别 GitHub/Google/SSO 按钮）
   *  - auto   先检测是否已登录；需要登录时按账号唯一凭据解析为 form / github
   */
  loginMethod?: LoginMethod;
  /** loginMethod='oauth' 时可选：OAuth 按钮选择器（如 "text=使用 Google 继续"），留空会自动识别 */
  oauthButtonSelector?: string;
  /**
   * 登录表单前置点击（旧字段，单个选择器）。
   *
   * 有些站点（new-api 新版、Agent Router）登录页默认只显示 OAuth 选项，
   * 要先点「使用 邮箱或用户名 登录」才会出现账密表单。
   * 支持 `text=使用 邮箱或用户名 登录` 语法。找不到就跳过，不算失败。
   *
   * 新学习结果写 `preLoginClickSelectors`；读取时把本字段作为最后一步兼容合并。
   */
  preLoginClickSelector?: string;
  /**
   * 登录表单前置点击（有序，多步）。
   *
   * 例如「先点其他登录方式 → 再点展开账密表单」需要两次点击；回放按数组顺序
   * 逐次点击，每一步点击后等待界面变化，再继续下一步。旧配置只有
   * `preLoginClickSelector` 时按单步执行。
   */
  preLoginClickSelectors?: string[];
  selectors: SiteSelectors;
  /** 公告/弹窗的关闭按钮选择器，按顺序尝试 */
  closeModalSelectors: string[];
  /** 登录成功的判定标志（元素选择器），可选 */
  successIndicator?: string;
  /** 签到方式 */
  checkin?: CheckinConfig;
  /** 走哪个代理访问本站，留空则直连 */
  proxyId?: string;
  /** 是否为内置预设站点（不可删除） */
  builtin?: boolean;
  /** 用户手动固定的站点顺序；数值越小越靠前 */
  sortOrder?: number;
  /** 站点系统类型与协议适配，见 types/adapter.ts */
  adapter?: SiteAdapterRef;
  /**
   * Token 认证配置（loginMethod='token' 时必填）
   *
   * 用于直接注入 API Token 到页面存储，跳过登录表单。
   * 适用于使用 localStorage/sessionStorage + Bearer token 认证的站点。
   */
  tokenConfig?: {
    /** Token 存储的键名，如 'auth_token' */
    storageKey: string;
    /** 存储位置，默认 localStorage */
    storageType?: 'localStorage' | 'sessionStorage';
    /** HTTP 请求头名称，如 'Authorization' */
    headerName: string;
    /** 请求头前缀，如 'Bearer ' */
    headerPrefix: string;
    /** 身份验证接口（可选），默认尝试 /api/user/self 等 */
    identityEndpoint?: string;
  };
  /** 退出登录接口（可选），用于切换账号时完全清除服务端会话 */
  logoutApiUrl?: string;
  /**
   * 站点级身份读取扩展（默认关闭，校验见 src/lib/site/site-security.ts）。
   *
   * 仅当用户显式配置时才生效，且只读、绝不写：
   *  - storageKey：身份 JSON 的存储键（如 orevx 的 'auth-user'）；
   *  - endpoint：显式允许的跨域身份接口（仅 https，登录站点域名的自身/子域；
   *    只读 GET，用 tokenKey 指向的存储值拼 Bearer 头，credentials:'omit'）。
   */
  identitySource?: SiteIdentitySourceConfig;

  /**
   * 「用会话 cookie 换短命 Bearer 令牌」的引导配置（新版 new-api 分叉的轮换鉴权）。
   *
   * 这类站点不把令牌落 localStorage：页面用一个会话 cookie 调
   * `/api/user/auth/refresh` 换回 access_token，之后所有接口请求都带
   * `Authorization: Bearer`。扩展默认的「cookie + user-id 兼容头」在它们上
   * 一律 401 —— 余额、签到快照与身份全都读不到（一梦五千年 fapi.leileihog.top 实测）。
   *
   * 显式配置后才生效，且**只调同源地址**（跨域一律拒绝，绝不把会话 cookie 发出去）。
   */
  authBootstrap?: SiteAuthBootstrapConfig;
}

/**
 * 令牌引导：拿会话 cookie 换一枚短命 access token，供后续同源接口使用。
 *
 * 令牌只在本轮任务内内存复用（每站点 60 秒最多换一次），**绝不落盘** —— 它是
 * 会过期又敏感的凭据；轮换还可能让页面正在用的旧令牌失效，所以要少换、复用换到的。
 */
export interface SiteAuthBootstrapConfig {
  /** 同源接口路径（相对登录站点），如 '/api/user/auth/refresh' */
  endpoint: string;
  /** 请求方法，默认 POST（这类接口都是 POST） */
  method?: 'POST';
  /** 响应里 access token 的字段路径；缺省依次尝试 data.access_token、access_token、data.accessToken、accessToken */
  tokenPath?: string[];
  /** 请求头名，默认 'Authorization' */
  header?: string;
  /** 请求头前缀，默认 'Bearer ' */
  prefix?: string;
}

/**
 * 站点级身份读取扩展（默认关闭）：给「身份在跨域接口/自定义存储键」的站点
 * （如 orevx：页面在 orevx.ai、身份在 server.orevx.ai 的 CBOR 接口与
 * localStorage 'auth-user'）提供一条显式配置的只读读取路径。
 */
export interface SiteIdentitySourceConfig {
  /** 身份 JSON 的存储键（只读，JSON 结构交给 extractIdentityFromPayload 解析） */
  storageKey?: string;
  /** 身份存储位置；缺省依次查 localStorage、sessionStorage */
  storageType?: 'localStorage' | 'sessionStorage';
  /** 显式允许的跨域身份接口（仅 https，登录站点域名的自身/子域） */
  endpoint?: string;
  /** 调用 endpoint 时 token 的存储键（如 orevx 的 `auth-token`） */
  tokenKey?: string;
  /** token 的存储位置；缺省依次查 localStorage、sessionStorage */
  tokenStorageType?: 'localStorage' | 'sessionStorage';
  /** token 请求头名；缺省 `Authorization` */
  tokenHeader?: string;
  /** token 前缀；缺省 `Bearer `。显式空字符串表示不加前缀 */
  tokenPrefix?: string;
}

/**
 * 账号级代理模式。
 *  - 'inherit'  跟随站点配置（默认）
 *  - 'none'     不使用代理，直连
 *  - 'pool'     从全局代理池选一个节点（用 proxyId 指定）
 *  - 'custom'   直接配置代理地址（用 customProxy 指定）
 */
export type AccountProxyMode = 'inherit' | 'none' | 'pool' | 'custom';

/** 账号 */
export interface Account {
  id: string;
  /**
   * 迁移来源中的账号 id。只用于识别“这条记录已经导入过”，不参与登录。
   * 同站同用户名但来源 id 不同的账号会完整保留。
   */
  migrationSourceId?: string;
  siteId: string;
  username: string;
  password: string;
  /** 备注名，便于区分同站多账号 */
  label?: string;
  /** 登录后取得的身份信息，见 types/identity.ts */
  identity?: AccountIdentity;
  /**
   * 这个账号自己的登录方式，留空则跟随站点配置。
   *
   * 为什么要能按账号覆盖：同一个站点，有的账号是邮箱密码注册的，
   * 有的是 GitHub OAuth 登录的 —— 登录方式本质上是「这个账号怎么进去」，
   * 不是「这个站点怎么进去」。站点级配置留作默认值。
   */
  loginMethod?: LoginMethod;
  /** GitHub 登录用户名（仅 loginMethod='github' 时使用） */
  githubUsername?: string;
  /** GitHub 登录密码（仅 loginMethod='github' 时使用） */
  githubPassword?: string;
  /** 使用浏览器原生 Passkey（仅 loginMethod='passkey' 时使用） */
  passkey?: boolean;
  /**
   * API Token（站点 loginMethod='token' 时必填）
   *
   * 每个账号有独立的 token，切换账号时会覆盖 localStorage 里的值。
   * 用户需手动从站点获取：F12 → Application → Local Storage
   */
  apiToken?: string;
  /**
   * 代理模式，默认 'inherit'（跟随站点配置）
   *
   * 同站多账号可能需要不同代理（如不同地区的账号），
   * 所以代理配置要能下沉到账号级别。
   */
  proxyMode?: AccountProxyMode;
  /** proxyMode='pool' 时指定全局代理池里的节点 id */
  proxyId?: string;
  /**
   * 这条绑定是用户手动选的。
   *
   * 自动分配只填「没手动指定过」的账号：手动改过一次之后，后续再点自动分配
   * 不会把它覆盖掉。没有这个标记就分不清「用户特意选的」和「上一轮自动填的」——
   * 两者存下来长得一样，自动分配要么谁都不敢动（加了新节点也分不下去），
   * 要么把用户的选择冲掉。
   */
  proxyPinned?: boolean;
  /** proxyMode='custom' 时直接配置代理地址 */
  customProxy?: {
    scheme: 'http' | 'https' | 'socks4' | 'socks5';
    host: string;
    port: number;
    /** 需要认证的代理才填 */
    username?: string;
    password?: string;
  };
}

/** 每日签到状态 */
export type DailyStatus = 'pending' | 'running' | 'attention' | 'done' | 'failed';

/** 点击扩展图标时打开的管理界面 */
export type LaunchMode = 'sidepanel' | 'tab';

/**
 * 任务所处阶段。
 *
 * 站点登录和跳转签到页都会导致整页刷新、content script 被销毁重建，
 * 所以进度必须存在信箱里，靠这个字段决定重新注入后该干什么。
 *
 *  login       填账密并提交
 *  verify      判断登录是否成功，然后执行签到
 *  checkin     执行签到动作（跳转到签到页后的续跑）
 *  github-logout  切换受管 GitHub 账号前，清除当前 GitHub 会话
 *  relogin     退出后回到登录页，第二次登录（relogin 签到方式专用）
 *  relogin-verify  第二次登录后的校验，成功即完成签到
 */
export type TaskStage = 'login' | 'verify' | 'verify-oauth' | 'checkin' | 'github-logout' | 'relogin' | 'relogin-verify';

/** 自动签到任务（写入 storage.session 作为 content script 的「信箱」） */
export interface LoginTask {
  tabId: number;
  /** 每次执行唯一，用于拒绝旧页面迟到的阶段和结果消息 */
  runId: string;
  accountId: string;
  siteId: string;
  username: string;
  password: string;
  /** GitHub OAuth 专用凭据；background 仅在 github.com 授权页派发裁剪副本 */
  githubUsername?: string;
  githubPassword?: string;
  apiToken?: string;
  /** 抓取到的登录会话（常规路径，含 refresh token） */
  session?: CapturedAuthSession;
  site: SiteConfig;
  /**
   * 本次实际使用的登录方式（账号级覆盖 ?? 站点默认）。
   * 由 background 在派发任务时算好，content script 直接用。
   */
  effectiveLoginMethod?: LoginMethod;
  /** 本次实际使用的签到方式（账号级覆盖 ?? 站点默认） */
  effectiveCheckinMethod?: CheckinMethod;
  /** 本轮是否实际取得了扩展代理租约（包含账号级 pool/custom 覆盖）。 */
  usesExtensionProxy?: boolean;
  /** 当前账号曾保存的站点侧用户 ID；与站点级适配器配置分开，便于检测重复绑定。 */
  accountIdentityUserId?: string;
  /** 当前账号上次通过验证后由站点返回的用户名。 */
  accountIdentityUsername?: string;
  /** 当前账号上次通过验证后由站点返回的邮箱。 */
  accountIdentityEmail?: string;
  /**
   * 与本站登录 origin 共享浏览器会话的账号一共有几个。
   *
   * 不能只按 siteId 数：同一站点重复导入后会有不同 ID，但 Cookie 仍按 origin
   * 共享。用于第三方身份登录读不到身份时的决策：只有一个账号时可以继续；
   * 多账号则必须停下来确认。这个数只有 background 知道，所以随任务一起下发。
   */
  siteAccountCount?: number;
  /**
   * 本站**其它**账号的站点侧 userId → 账号名。
   *
   * 只为把身份核对的日志说清楚。「当前登录的是用户 ID 5544，本次要签到的是
   * 5543」这句话用户没法判断是扩展认错了还是浏览器真登着别人；有了这张表就能
   * 写成「用户 ID 5544（本站账号 fzk521）」—— 一眼看出那是自己的另一个账号，
   * 退出重登是对的。只带 id 和账号名，不带任何凭据。
   */
  siteAccountUserIds?: Record<string, string>;
  /**
   * 本轮任务已经确认过「当前登录的就是本任务的账号」。
   *
   * 为什么要跨页记住：判据只在**刚完成表单登录**的那一刻成立 —— 是我们自己
   * 填的账密。之后跳转到签到/领取页会重建 content script，若再从零判断，
   * 遇到不暴露用户名的站点（SharedChat 只有 HttpOnly cookie，页面、
   * localStorage、接口都读不到账号）就会退化成「读不到身份 → 保守重登」，
   * 于是每次跳转都重登一次，永远走不到领取那一步。
   *
   * 只由「本任务亲自登录成功」置为 true；打开时本来就已登录的情况不置位，
   * 仍走完整核对，避免给错账号领取。
   */
  identityConfirmed?: boolean;
  /**
   * 本轮已在 GitHub 官方登录页精确填写该账号保存的凭据，由 background 在
   * 点击前核对字段，并确认可信点击已派发。OAuth 回本站后可据此建立首次映射。
   */
  githubCredentialsSubmitted?: boolean;
  createdAt: number;
  stage: TaskStage;
  /** 跨页面累积的执行日志 */
  steps?: string[];
  /** 需要跨页面跳转存活的数据（如签到前的额度快照），见 types/task-context.ts */
  context?: TaskContext;
}

/** content script 回传给 background 的执行结果 */
export interface TaskResult {
  accountId: string;
  ok: boolean;
  /** 结果说明，失败时是原因 */
  message: string;
  steps: string[];
  /** 签到的量化结果（守恒差分），见 types/metrics.ts */
  metrics?: CheckinMetrics;
  /**
   * 这条结果是用户手动标记的，不是扩展验证出来的。
   *
   * 「用户说签到了」和「扩展拿到了守恒差分证据」必须在数据层分得开：
   * 手动标记不该被当成自动化成功的样本去统计成功率，也不该在界面上和真实
   * 成功长得一模一样。它可以携带余额历史差值供展示，但那只是期间总入账估算，
   * 不是一次自动签到的前后快照证据。见 lib/manual-checkin.ts。
   */
  manual?: boolean;
  /** 结果由后台 API 直连确认，还是浏览器自动化确认 */
  via?: 'headless' | 'browser';
}

/** 每个账号最近一次执行结果，用于界面上排查失败原因 */
export interface LastResult extends TaskResult {
  at: number;
}
