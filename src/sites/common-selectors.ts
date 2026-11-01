/**
 * 大多数 new-api / one-api 系中转站通用的公告弹窗关闭选择器。
 *
 * ⚠️ 这里只放**明确是关闭控件**的选择器。曾经有一条
 * `.semi-modal-footer button` —— 它匹配弹窗底部任意 button，等于「按位置赌」：
 * footer 是 `[签到][关闭]` 时点中的是签到，而清理逻辑关掉一个就重扫，
 * 于是签到按钮被反复点击，站点回「今日已签到」，本来成功的签到被盖成重复签到。
 * 已删除。要按位置兜底请用框架的「次要按钮」变体类名，不要用裸 button。
 */
export const COMMON_CLOSE_SELECTORS = [
  '.semi-modal-close',
  // semi-ui 的「取消/关闭」惯用次要按钮；不匹配主操作按钮
  '.semi-modal-footer button.semi-button-tertiary',
  // 属性值匹配对非枚举属性大小写敏感，Tailwind/Headless UI 普遍写 Close
  '[aria-label="close" i]',
  '[aria-label*="关闭"]',
  '.ant-modal-close',
  '.ant-modal-close-x',
  '.modal-close',
  'button.close',
  '.close-btn',
  /*
   * shadcn/ui + Radix Dialog 这一代（Orbelis 实测）。
   *
   * 它的关闭按钮既没有 `aria-label`，也不带任何 `close` 类名 —— 只有一个
   * `data-state` 属性和内嵌的 X 图标，上面几条一条都命中不了。日志表现是
   * 「未发现公告弹窗」，然后签到按钮被遮罩挡住、点击探针收不到事件。
   *
   * `[data-radix-*]` 只匹配 Radix 自己生成的节点，不会误伤站点按钮。
   */
  '[data-slot="dialog-close"]',
  '[data-radix-dialog-close]',
  '[data-radix-collection-item][aria-label*="Close" i]',
  // Radix/shadcn 的 DialogClose 常渲染成 dialog 内右上角的图标按钮
  '[role="dialog"] > button:has(> svg)',
  '[role="alertdialog"] > button:has(> svg)',
  // 一部分实现把它放在 header 里
  '[role="dialog"] header button:has(> svg)',
];

/** 常见登录页的邮箱/用户名输入框，按语义明确程度排序。 */
export const COMMON_USERNAME_SELECTORS = [
  'input[autocomplete="username"]',
  'input[autocomplete="email"]',
  'input[type="email"]',
  '#username',
  '#email',
  'input[name="username"]',
  'input[name="email"]',
  'input[placeholder*="用户名"]',
  'input[placeholder*="账号"]',
  'input[placeholder*="邮箱"]',
];

/** 常见登录页的密码输入框。 */
export const COMMON_PASSWORD_SELECTORS = [
  'input[autocomplete="current-password"]',
  '#password',
  'input[name="password"]',
  'input[type="password"]',
];

/** 常见的签到按钮选择器，供「点按钮」方式预填 */
export const COMMON_CHECKIN_SELECTORS = [
  'button:has(> span:only-child)',
  '.checkin-btn',
  '#checkin',
  '[data-testid="checkin"]',
].join(', ');

/** 指纹判定用的窄化助手，避免每个 match 里重复写类型守卫 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
