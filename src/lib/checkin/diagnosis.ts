/**
 * 失败诊断码表。
 *
 * 现状是失败只给一句话，用户看到「签到页未找到明确按钮或已签到状态」
 * 也不知道该改选择器、该重登、还是该等站点恢复。
 *
 * 这里把失败归成有限几类，每类配上「为什么」和「怎么办」。**结论必须是结构化的**
 * ——「标题 + 说明 + 下一步」三件套，而不是拼成一句话：
 *
 *   title       一句话结论，UI 直接当小标题渲染
 *   detail      为什么会这样，讲清机制而不是重复标题
 *   nextActions 可照做的一步或多步，按优先级排序；能点的一步排最前
 *
 * 拼字符串的写法看着省事，代价是 UI 没法只拿标题做折叠摘要、也没法给
 * 「下一步」挂按钮或复制功能，最后又会退回「一句笼统的失败」。
 *
 * 自动化侧只负责判定归到哪一类（automation/shared/diagnostics.ts），
 * 界面侧负责展示（components/DiagnosisHint.tsx），码表放在 lib/ 供双方共用。
 */

export const DIAGNOSIS = {
  /** 页面结构对不上：选择器需要调整 */
  SELECTOR_MISMATCH: 'selector-mismatch',
  /** 命中了元素但指纹失配：选择器指向的已经不是当初那个控件 */
  ELEMENT_MISMATCH: 'element-mismatch',
  /** 学习流程配置不完整，不是登录失败 */
  WORKFLOW_CONFIG: 'workflow-config',
  /** 无法确认当前登录的是这个账号（站点显示的身份与账号对不上，且扩展没法自己换号） */
  IDENTITY_UNCONFIRMED: 'identity-unconfirmed',
  /** 登录态失效：cookie 过期或被踢下线 */
  AUTH_EXPIRED: 'auth-expired',
  /** 多账号切换失败：无法确认清除了旧账号的 Cookie / 会话 */
  SESSION_SWITCH_FAILED: 'session-switch-failed',
  /** 站点不可用：5xx、限流、网关错误 */
  SITE_UNAVAILABLE: 'site-unavailable',
  /** 站点明确拒绝：业务规则不允许（余额不足、活动结束、账号被封） */
  SITE_REJECTED: 'site-rejected',
  /** 访问被拒：403 / 站点限制地区 */
  ACCESS_DENIED: 'access-denied',
  /** 需要人工完成：验证码、二次验证、OAuth 授权 */
  MANUAL_REQUIRED: 'manual-required',
  /** 该站点没有可自动化的签到入口 */
  NO_CHECKIN_ENTRY: 'no-checkin-entry',
  /** 页面加载不出来：空白页、源站无响应、代理慢 */
  PAGE_TIMEOUT: 'page-timeout',
  /** 控件被遮挡：公告 / 弹窗没关掉 */
  OBSCURED: 'obscured',
  /**
   * 登录即签到站点没能确认奖励到账：页面上既没有签到控件、也没有完成提示，
   * 且没有可用的登录前余额基线可做差分 —— 不能给出无法核实的绿色对勾。
   */
  CHECKIN_UNVERIFIED: 'checkin-unverified',
  /** 控件存在但处于禁用态：站点状态没拉回来，或该账号今日已满 */
  CONTROL_DISABLED: 'control-disabled',
  /** 本地代理端口没人监听：内核没启动 */
  PROXY_UNREACHABLE: 'proxy-unreachable',
  /** 网络层失败：DNS、出口不通、连接被拒 */
  NETWORK_FAILURE: 'network-failure',
  /** 当天已经签过 —— 不是失败 */
  ALREADY_DONE: 'already-done',
  /** 归不了类 */
  UNKNOWN: 'unknown',
} as const;

export type DiagnosisCode = (typeof DIAGNOSIS)[keyof typeof DIAGNOSIS];

export interface DiagnosisEntry {
  /** 一句话说清结论，UI 用小标题渲染 */
  title: string;
  /** 为什么会这样。讲机制，不重复标题 */
  detail: string;
  /** 用户可以照着做的几步，按优先级排序 */
  nextActions: string[];
}

/**
 * 下一步：去账号行重新演示一遍。
 *
 * 选择器失效是用户自己就能修的少数几类之一 —— 只要告诉他点哪里。
 * 文案统一从这里取，避免各条诊断各写一遍又写得不一样。
 */
const RELEARN = '在账号行点「学习本站流程」重新演示一遍：登录入口/字段不对就重演登录，签到控件不对就演到完成一次签到';
const RELEARN_CHECKIN = '在账号行点「学习本站流程」重新演示一遍（先过一遍资料页再进签到页）';

export const DIAGNOSIS_TABLE: Record<DiagnosisCode, DiagnosisEntry> = {
  [DIAGNOSIS.SELECTOR_MISMATCH]: {
    title: '页面上找不到要操作的控件',
    detail: '登录页或签到页的结构与保存的选择器对不上，通常是站点改版了（class 变了、按钮改名、控件挪了位置）。',
    nextActions: [
      RELEARN,
      '展开账号详情，看最后一步卡在找什么元素；日志里的「页面可点元素」列出的是页面上真实存在的按钮',
    ],
  },
  [DIAGNOSIS.ELEMENT_MISMATCH]: {
    title: '命中了错误的元素',
    detail: '保存的选择器还在，但它现在指向的已经不是当初学习的那个控件 —— 同文案按钮变多、列表增删导致位置错位，都可能是原因。',
    nextActions: [
      RELEARN,
      '展开账号详情，对比日志里的「期望指纹 / 实际指纹」，能看出站点把哪个字段改掉了',
    ],
  },
  [DIAGNOSIS.WORKFLOW_CONFIG]: {
    title: '已保存的学习流程配置不完整',
    detail: '流程本身缺少必要环节（例如没有记录到能显示当前账号的资料页）。这不是登录状态失效，重试也不会变好。',
    nextActions: [
      '在账号行点「学习本站流程」重录一遍：先访问能显示当前账号的个人资料页，再完成签到，最后点「结束学习」',
      '若不想用录制流程：编辑本站，把签到方式切回「自动识别」',
    ],
  },
  [DIAGNOSIS.IDENTITY_UNCONFIRMED]: {
    title: '无法确认当前登录的是这个账号',
    detail: '站点显示的身份和扩展里的账号对不上，扩展也没法自己换号。GitHub / 第三方登录的站点常只显示第三方句柄或 github_123 这类名字，与扩展里填的账号名天然不同。扩展停在这里是为了不把签到记到别的账号上。',
    nextActions: [
      'GitHub 登录的账号：编辑账号，填好该账号的 GitHub 用户名或邮箱和密码。扩展会自动退出当前 GitHub、用这个账号重新登录，并记住它在站点上的用户 ID，以后直接按 ID 核对',
      '其它第三方登录：先在浏览器里切换到这个账号，再点「执行」',
    ],
  },
  [DIAGNOSIS.AUTH_EXPIRED]: {
    title: '登录状态已失效',
    detail: '站点不再认这个会话（cookie 过期、被别处登录顶下线，或站点主动清退了会话）。',
    nextActions: [
      '直接再点一次执行，扩展会自动重新走登录',
      '若反复失效，编辑账号核对密码是否仍然有效',
    ],
  },
  [DIAGNOSIS.SESSION_SWITCH_FAILED]: {
    title: '无法安全切换到目标账号',
    detail: '站点 cookie 没清干净，或当前会话仍是别的账号。扩展在这里停下是故意的：确认不了身份就继续签到，会把奖励记到错账号上。',
    nextActions: [
      '确认当前加载的是最新版扩展（需要 Cookie 权限），然后在扩展管理页点一次「重新加载」',
      '展开账号详情，看 Log 里是「清理失败」还是「仍有残留」，两者处理方式不同',
      '关掉该站点的其它标签页后重试 —— 活着的页面会不断重建会话',
    ],
  },
  [DIAGNOSIS.SITE_UNAVAILABLE]: {
    title: '站点暂时不可用',
    detail: '站点源服务器返回了 5xx 或限流响应（网关错误、Cloudflare 源站故障）。这是站点侧的问题，与你的配置无关。',
    nextActions: [
      '稍后重试，通常几分钟到几十分钟会自行恢复',
      '确认在浏览器里直接打开该站点也是同样结果；如果你能打开、扩展不能，检查代理设置',
    ],
  },
  [DIAGNOSIS.SITE_REJECTED]: {
    title: '站点明确拒绝了这次操作',
    detail: '这是站点的业务规则（余额不足、活动结束、账号被封禁、理由与历史重复等），不是网络或配置问题。重试结果不会变。',
    nextActions: [
      '展开账号详情，读站点返回的原话，通常会说明具体原因',
      '按站点提示处理后（例如换一条领取理由、补充余额）再重试',
    ],
  },
  [DIAGNOSIS.ACCESS_DENIED]: {
    title: '访问被站点拒绝（403）',
    detail: '站点返回了 403 Forbidden。常见原因是出口 IP 所在地区被限制，或站点对你的 IP 做了风控拦截。',
    nextActions: [
      '在账号行把代理换成与站点同地区的节点，再执行一次',
      '确认该站点在浏览器里直接访问是否同样被拒；若直连正常，说明是代理出口被站点拉黑了',
      '换一个浏览器配置（账号）访问对比，判断是站点风控还是账号问题',
    ],
  },
  [DIAGNOSIS.MANUAL_REQUIRED]: {
    title: '需要你在页面上完成一步',
    detail: '站点弹出了验证码、滑块或二次验证，扩展不会替你绕过。任务会停在这里等你，不会自动跳过。',
    nextActions: [
      '切到扩展打开的站点标签页，按页面提示完成验证',
      '完成后回到扩展页，点该账号的「执行」继续；扩展会接着往下跑',
    ],
  },
  [DIAGNOSIS.NO_CHECKIN_ENTRY]: {
    title: '没找到可用的签到入口',
    detail: '当前站点页面上没有可点击的签到控件，也没有能自动发现的签到入口链接。有的站点登录即算签到。',
    nextActions: [
      '若该站点登录即算签到：编辑本站，把签到方式改为「登录即签到」',
      '若签到入口在特定页面：编辑本站，手动指定签到页地址和按钮选择器',
      RELEARN_CHECKIN,
    ],
  },
  [DIAGNOSIS.PAGE_TIMEOUT]: {
    title: '页面长时间没有加载出来',
    detail: '等待页面或页面里的元素超时。可能是站点响应慢、网络/代理慢，或者页面把自己渲染成了空白。',
    nextActions: [
      '在浏览器里直接打开该站点，确认页面本身能打开；打不开说明是站点或网络问题',
      '若用了代理，换一个节点再试 —— 慢节点会让每个请求都吃满超时',
      '展开账号详情，看日志停在「打开页面」还是「等待控件」，据此判断是页面没来还是控件没来',
    ],
  },
  [DIAGNOSIS.OBSCURED]: {
    title: '控件被弹窗挡住了',
    detail: '页面上有公告或弹窗盖住了签到控件，扩展清完遮挡仍然点不到目标。',
    nextActions: [
      '先手动把站点的公告/弹窗关掉，再重新执行一次',
      '若每次都被同一个弹窗挡住：编辑本站，在「关闭弹窗选择器」里补上它的关闭按钮',
      RELEARN_CHECKIN,
    ],
  },
  [DIAGNOSIS.CHECKIN_UNVERIFIED]: {
    title: '登录即签到尚未确认',
    detail: '本站配置为「登录即签到」：登录本身就算签到，页面上没有签到按钮。但这一轮扩展没能证明奖励真的到账 —— 打开时可能已经是登录态（本轮没有发生登录动作），或者任务开始前 36 小时内没有一次成功的余额快照可当基线；页面既没有可点的签到控件，也没有「已签到 / 签到成功」之类的完成提示。为了不给你一个无法核实的绿色对勾，扩展没有把它记成已完成。',
    nextActions: [
      '切到本站标签页确认今天的额度/余额是否已经增加；增加了就说明站点确实按「登录即签到」发过奖励',
      '想每轮都强制拿到奖励：编辑本站，把签到方式改成「退出再登录」（配好退出接口或退出按钮），每轮都重新走一次登录',
      '若本站其实是登录后仍需点一次签到按钮的站点：在账号行点「学习本站流程」重录一遍（先过一遍资料页再进签到页）',
    ],
  },
  [DIAGNOSIS.CONTROL_DISABLED]: {
    title: '签到控件存在但当前不可点',
    detail: '按钮在页面上，但处于禁用态。常见两种原因：站点还没把签到状态拉回来（渲染早于接口返回），或这个账号今天已经完成、被限制。',
    nextActions: [
      '在浏览器里打开该签到页，看按钮旁边写了什么 —— 写着「今日已签到」就无需再处理',
      '若页面上没有已完成字样：等一分钟再执行一次，站点状态接口回来后按钮通常会解禁',
      '若长期禁用：在账号行点「学习本站流程」重录一遍，录下真正可点的那个控件',
    ],
  },
  [DIAGNOSIS.PROXY_UNREACHABLE]: {
    title: '本机代理端口没有程序在监听',
    detail: '扩展把流量发到了本机代理端口，但那里没有任何程序接住它 —— 内核（Clash Verge / mihomo）没启动，或该节点的本地端口还没生效。',
    nextActions: [
      '启动 Clash Verge（或其它内核），确认它正在运行且监听日志里能看到对应端口',
      '在「代理管理」里重新同步 / 扫描本机出口，确认端口号是当前内核真实监听的那个',
      '如果不用代理：编辑账号，把代理改为「不使用代理（直连）」',
    ],
  },
  [DIAGNOSIS.NETWORK_FAILURE]: {
    title: '网络请求失败',
    detail: '请求没能到达站点：DNS 解析不了、出口不通、连接被重置，或请求超时。',
    nextActions: [
      '检查本机网络与站点是否可达（在浏览器里直接打开一次）',
      '账号配了代理时：去「代理管理」测一次该出口，不通就换节点',
      '若只有这个站点失败，多半是站点侧或该出口被墙，换一个节点再试',
    ],
  },
  [DIAGNOSIS.ALREADY_DONE]: {
    title: '今天已经签到过了',
    detail: '站点明确显示今日已完成。这不是失败，重复签到一般也不会再发奖励。',
    nextActions: [
      '无需处理：这就是「今天已经签到」的结论，扩展已把该账号记为今日完成',
      '若站点显示的不是你的账号，说明登录态串了 —— 重新执行一次，扩展会先核对身份',
    ],
  },
  [DIAGNOSIS.UNKNOWN]: {
    title: '没能归类的失败',
    detail: '日志里的线索不足以判断属于哪一类。',
    nextActions: [
      '展开账号详情，把最后几步日志读完 —— 关键线索通常在最后两行',
      '若仍看不出原因，去站点编辑里核对登录页和签到页地址是否还正确',
    ],
  },
};



