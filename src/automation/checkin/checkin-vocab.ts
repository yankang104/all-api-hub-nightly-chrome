/**
 * 签到判定的共享词表与控件识别。
 *
 * 单独成文件是为了避免循环依赖：announcements.ts 要判断「这个弹窗里有没有
 * 签到控件」（免得把签到弹窗当公告关掉），而 checkin.ts 关公告要 import
 * announcements.ts —— 词表留在 checkin.ts 里就成环了。
 * 同 log.ts 里 StepLog 的处理方式。
 *
 * `SUCCESS_WORDS` / `ALREADY_WORDS` 是学习/回放/自动识别共用的唯一词表，
 * 新增词只在这里加。
 */

/** 判定签到成功的常见文案（学习/回放/自动识别共用） */
export const SUCCESS_WORDS = ['签到成功', '打卡成功', '领取成功', '奖励到账', '已生效', 'check-in success', 'checked in successfully'];

/** 判定「今天已经签过」的常见文案（学习/回放/自动识别共用） */
export const ALREADY_WORDS = ['已签到', '已经签到', '今日已', '重复签到', 'already checked', 'already signed', '已打卡', '已领取'];

/** 学习抽奖动作的结果词；不把「0 次」「今日已抽」加载占位或他人中奖金额当结果。 */
export const LOTTERY_SUCCESS_WORDS = ['抽奖成功', '抽奖完成', '开奖成功', 'draw successful'];
export const LOTTERY_ALREADY_WORDS = ['今日梦火抽签次数已耗尽', 'This draw is complete', 'You have already drawn today'];
/** 只用于学习时识别业务控件，不扩大通用扫描器的自动点击范围。 */
export const LEARNING_LOTTERY_ACTION = /抽奖|抽签|翻牌|\b(?:start\s+)?draw\b/i;

/**
 * 站点**明确拒绝**这次签到时的页面文案特征。
 *
 * 为什么必须单独一套：只看成功词表时，站点把「签到失败：服务暂不可用」写在
 * 页面上，扩展读不到成功就报「点击后缺少明确结果」——站点真正说的原因被丢掉，
 * 于是 diagnostics 无法把一次偶发 5xx 识别成「站点暂时不可用」，也就永远不会
 * 重试。用户看到的就是「偶发故障 = 当天签到失败」。
 *
 * 判据刻意保守：只认站点自己写出的失败字样。没有这些字样时（例如点击后页面
 * 毫无反应）结论仍是「响应未知」，那种情况绝不能重试 —— 写请求可能已经落库。
 */
export const FAILURE_WORDS = [
  '签到失败', '打卡失败', '领取失败', '签到时发生错误', '签到出错',
  'check-in failed', 'checkin failed', 'sign-in failed', 'claim failed',
];

/** 页面文本里是否出现站点自己宣告的失败 */
export function failureReasonIn(text: string): string | null {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const lower = collapsed.toLowerCase();

  /** 优先取整行，能带上「服务暂不可用（HTTP 503）」这类具体原因。 */
  const lines = collapsed.split(/(?:\n|。|；)/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (FAILURE_WORDS.some((word) => line.toLowerCase().includes(word.toLowerCase()))) {
      return line.slice(0, 160);
    }
  }
  // 有些站点只写一句无主语的「服务暂不可用」，没有「失败」字样。
  const serverSide = /(?:服务(?:暂)?不可用|server\s+(?:unavailable|error)|bad\s+gateway|网关(?:错误|超时)|too\s+many\s+requests|服务端错误)/i.exec(lower);
  if (serverSide) return collapsed.slice(Math.max(0, serverSide.index - 20), serverSide.index + 80).trim();
  const httpFailure = /\b(?:4\d{2}|5\d{2})\b/.exec(lower);
  if (httpFailure && /(?:失败|错误|error|失败原因)/i.test(lower)) return collapsed.slice(0, 160);
  return null;
}

export const CHECKIN_PATH = /(?:^|\/)(?:check-?in|daily-check-?in|sign-?in|attendance)(?:\/|$)/i;

/**
 * 签到动作词。除了「签到/打卡」，很多站用「领取每日额度」「Claim Daily Bonus」
 * 这类说法，词表太窄会导致按钮就在眼前却识别不到。
 */
export const CHECKIN_ACTION = /(?:签到|打卡|领取|check[\s-]?in|sign[\s-]?in|claim|daily\s*(?:bonus|reward|credit)|每日(?:奖励|福利|额度))/i;

/** 排除同样含动作词但点了没用的入口（签到记录、签到规则、签到日历…） */
export const NON_ACTION_WORDS = /(?:历史|记录|规则|日历|说明|明细|详情|history|calendar|rule|record|detail)/i;

/** 在一段文本里找关键词 */
export function hit(text: string, words: string[]): boolean {
  const lower = text.toLowerCase();
  return words.some((w) => lower.includes(w.toLowerCase()));
}

/** 元素上所有能当作「按钮文字」的来源 */
export function controlText(element: HTMLElement): string {
  const seen = new Set<string>();
  /**
   * `title` 也属于可读名称：纯图标按钮（只有 `<svg>` 没有可见文字）经常把名称只写在
   * `title` 上，不读它就会把「每日签到」这类入口判成「没有控件」，进而误触
   * 「本站是登录即签到」的自动保存。顺序放在 aria-label 之后：a11y 名称优先。
   */
  return [element.innerText, element.textContent, element.getAttribute('value'), element.getAttribute('aria-label'), element.getAttribute('title')]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value) => {
      if (!value) return false;
      const key = value.replace(/\s+/g, ' ');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(' ')
    .trim();
}

/**
 * class 里表示「这个控件被禁用了」的 token。
 *
 * 必须按 token 精确匹配，不能用 `className.includes('disabled')` ——
 * Tailwind 的变体类名 `disabled:opacity-50` 只是**声明禁用时长什么样**，
 * 它出现在每一个正常可点的按钮上。子串匹配会把这些按钮全判成禁用，
 * 于是弹窗里真正的签到按钮压根进不了候选列表。
 */
const DISABLED_TOKENS = /^(?:disabled|is-disabled|[\w-]+-disabled)$/i;

/** 控件是否处于禁用态。参数放宽成鸭子类型，方便在 node 环境测。 */
export function controlDisabled(element: {
  className?: unknown;
  disabled?: boolean;
  getAttribute(name: string): string | null;
}): boolean {
  if (element.disabled === true) return true;
  if (element.getAttribute('aria-disabled') === 'true') return true;

  // Tailwind 变体（含 `:`）一律不算：它们描述的是状态样式，不是当前状态
  return String(element.className ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .some((token) => !token.includes(':') && DISABLED_TOKENS.test(token));
}

export function isVisibleElement(el: Element): boolean {
  const style = window.getComputedStyle(el as HTMLElement);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = (el as HTMLElement).getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * 收集范围内所有「可能是按钮」的元素。
 *
 * 只查 button/[role=button] 会漏掉大量 SPA —— 很多站用 `<div class="btn">`
 * 或 `<a>` 做签到按钮，既没有 role 也不是 button 标签。这里放宽到
 * 带点击语义的元素，再由调用方按文案筛选。
 *
 * @param root 查找范围。默认整个文档；传入弹窗根可以只看那个弹窗里的控件，
 *   这是「判断弹窗是公告还是功能弹窗」的基础。
 */
export function checkinControls(root: ParentNode = document): HTMLElement[] {
  const selector = [
    'button',
    '[role="button"]',
    'input[type="button"]',
    'input[type="submit"]',
    'a[href]',
    '[class*="btn" i]',
    '[class*="button" i]',
    '[onclick]',
  ].join(', ');

  const tagged = [...root.querySelectorAll<HTMLElement>(selector)];

  // 没有任何标记、但 CSS 声明了 cursor:pointer 的 div/span 也可能是按钮。
  // 单独一轮扫描，避免上面的选择器过于宽泛拖慢常规页面。
  const pointer = [...root.querySelectorAll<HTMLElement>('div, span')].filter((element) => {
    if (element.children.length > 2) return false; // 容器不是按钮
    const text = (element.innerText ?? '').trim();
    if (!text || text.length > 40) return false;
    return window.getComputedStyle(element).cursor === 'pointer';
  });

  const seen = new Set<HTMLElement>();
  return [...tagged, ...pointer].filter((element) => {
    if (seen.has(element) || !isVisibleElement(element)) return false;
    if (element.tagName.toLowerCase() === 'p' || element.tagName.toLowerCase() === 'span') {
      const nestedInteractive = element.querySelector('button, a, [role="button"], input[type="button"], input[type="submit"], [onclick]');
      if (!nestedInteractive && !element.matches('[role="button"], [onclick]')) return false;
    }
    seen.add(element);
    return true;
  });
}

