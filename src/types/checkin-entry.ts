/**
 * 签到页的站内语义入口。
 *
 * 有些 SPA 的受保护页面不能可靠地用地址栏直接打开，必须先展开用户菜单，
 * 再点击“个人资料”等站内入口。这里只允许声明受限的点击与等待，不执行脚本。
 */
export interface CheckinEntryStep {
  /** 当前步骤要点击的 CSS 或 text= 选择器。 */
  selector: string;
  /** 点击后必须出现的控件；通常是下一步菜单项或签到卡片。 */
  waitFor?: string;
  /** 本步骤等待控件的最长时间，默认 10 秒，最多 30 秒。 */
  timeoutMs?: number;
  /** 点击可能触发整页导航；开启后允许页面销毁导致可信点击回执缺失。 */
  mayNavigate?: boolean;
}

export interface CheckinEntryConfig {
  /** 按顺序执行的站内点击步骤。 */
  steps: CheckinEntryStep[];
  /** 命中后才说明签到/资料页已经完成渲染，可以开始身份核对。 */
  readySelector: string;
  /** 入口不可用时是否回退到 checkin.url；默认 true。 */
  fallbackToUrl?: boolean;
  /** 等待最终资料页就绪的最长时间，默认 12 秒，最多 30 秒。 */
  readyTimeoutMs?: number;
}
