/** 语言/地区前缀（`/zh`、`/zh-CN`、`/en_us`）：站点常把所有业务页挂在这种前缀下。 */
const LOCALE_PREFIX = /^\/[a-z]{2}(?:[-_][a-z]{2})?(?=\/)/i;

/**
 * 去掉语言/地区前缀后再做路径判定。
 *
 * 中文站点把控制台挂在 `/zh/console` 的情况很常见；不剥前缀时它既不像登录页、
 * 也不像业务页，学习就会一直停在「请登录」，用户明明已经进入站内。
 */
function stripLocalePrefix(path: string): string {
  return path.replace(LOCALE_PREFIX, '') || '/';
}

/** 书签/站点入口可能直接是控制台或资料页，不能仅因它等于 loginUrl 就删掉演示步骤。 */
export function isKnownBusinessLearningPath(path: string): boolean {
  try {
    const url = new URL(path, 'https://learning.invalid');
    const hash = url.hash.slice(1);
    const candidate = stripLocalePrefix(hash.startsWith('/') ? hash : url.pathname);
    // 认证子路由仍由认证判据接管，不能因 /console 前缀而放行登录动作。
    if (/(?:^|\/)(?:login|sign-?in|auth|oauth|register|password)(?:\/|$)/i.test(candidate)) return false;
    // lottery 是具体站点的签到落地页（一梦五千年）：站点只用配置声明，路径
    // 并不叫 check-in。漏掉它会让「打开时已登录」的学习一直停在「请登录」。
    return /^\/(?:dashboard|console|profile|personal|account|user|me|check-?in|daily|rewards?|lottery|draw|prize)(?:\/|$)/i.test(candidate);
  } catch {
    return false;
  }
}

/**
 * 登录成功后的常见落地页（根、首页、工作台…）。
 *
 * 这些路径本身是**歧义的**：`/` 既可能是登录表单所在的页面，也可能是登录后的
 * 仪表盘。因此它只回答「路径形状像不像登录落地页」，只有调用方已经确认
 * **本次演示确实发起了登录**（见 `analyzeLearningEvents`）时才能把它当证据用。
 *
 * 存在的理由：登录即签到站点往往没有签到按钮可录，登录成功后直接落在 `/`、
 * `/home`、`/workspace` 这类页面上；只认 dashboard/console/profile 词表会把
 * 这些站点的整场演示判成「没登录」，用户既看不到「登录即签到」出口，
 * 也不会触发自动保存 —— 正是「登录即签到站点学不到」的那条路径。
 */
export function isLoginLandingPath(path: string): boolean {
  try {
    const url = new URL(path, 'https://learning.invalid');
    const hash = url.hash.slice(1);
    const candidate = stripLocalePrefix(hash.startsWith('/') ? hash : url.pathname);
    return candidate === '/'
      || /^\/(?:home|index|main|app|apps|workspace|panel|overview|portal|hub|center|member|vip|admin)(?:\/|$)/i.test(candidate);
  } catch {
    return false;
  }
}
