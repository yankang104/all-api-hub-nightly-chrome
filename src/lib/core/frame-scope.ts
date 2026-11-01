/**
 * 框架作用域判定：标签页的顶层框架 vs. iframe 子框架。
 *
 * 为什么单独抽成模块：content script 现在注入所有 frame（`allFrames: true`），
 * 但「执行签到任务」这件事**只属于标签页主文档**。子框架一旦也去取任务并
 * runTask，同一份流程会在主文档和每个 iframe 里并发跑一遍 —— 重复填表、
 * 重复点击、重复提交签到 POST。对按次计费或幂等性差的接口，这是真实事故。
 *
 * 判定必须同时存在于两侧（纵深防御）：
 * - 页面侧：子框架直接不进入任务执行路径；
 * - 后台侧：`GET_TASK` 只向主框架下发 task，子框架只允许领取同源学习会话。
 *
 * 这里是两侧共用的**纯函数**，便于单测把「子框架绝不拿任务」这条不变量钉死。
 */

/**
 * 当前 content script 是不是运行在标签页顶层框架？
 *
 * `window.top === window` 在跨域 iframe 里同样可用：比较的是 WindowProxy 身份，
 * 不需要读取顶层文档的任何跨域属性，因此不会抛安全异常。
 *
 * 默认参数直接读全局 `window`，调用点只写 `isTopFrame()`；测试可注入替身。
 */
export function isTopFrame(
  win: Pick<Window, 'top' | 'self'> = window,
): boolean {
  return win.top === win.self;
}

/**
 * 这条后台消息是不是来自标签页主框架？
 *
 * `chrome.runtime.MessageSender.frameId` 在主文档上的值恒为 `0`。类型上它是
 * 可选的（扩展页面发来的消息没有 frameId），所以这里**只有严格等于 0 才认主框架**：
 * 拿不准时一律按「不是主框架」处理。宁可少下发一个任务（用户重试即可），
 * 也绝不能让 iframe 拿到 task 重复执行签到。
 */
export function isTopFrameSender(frameId: number | undefined): boolean {
  return frameId === 0;
}