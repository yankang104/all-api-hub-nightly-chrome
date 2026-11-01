/**
 * 可持久化的签到工作流 DSL。
 *
 * 这是给白标站点和多步弹窗流程的扩展口。它只描述有限的浏览器动作，
 * 不允许保存 JavaScript，因此站点配置不会获得任意脚本执行能力。
 */
export type CheckinWorkflowCondition =
  | {
      type: 'text';
      /** 页面正文包含任一/全部关键词。 */
      words: string[];
      match?: 'any' | 'all';
    }
  | {
      type: 'selector';
      /** 页面上存在可见或已挂载的元素。 */
      selector: string;
    }
  | {
      type: 'path';
      /** 当前 pathname，末尾 `*` 表示前缀匹配。 */
      pattern: string;
    };

/**
 * 控件内的一次指针落点，用**宽高比例**而不是像素。
 *
 * 学习模式按**录制时的真实坐标**换算成比例存下来，回放时还原成
 * `rect.left + rect.width * rx`。这是「用户点的是这个控件的哪个位置」的唯一载体：
 * 存比例而不是 clientX/clientY，与视口大小、浏览器缩放、页面滚动位置全部无关。
 */
export interface WorkflowPointerAnchor {
  /** 0..1，0 = 元素左边缘，1 = 元素右边缘 */
  rx: number;
  /** 0..1，0 = 元素上边缘，1 = 元素下边缘 */
  ry: number;
}

/**
 * 录制时控件的「身份指纹」——「这个选择器当初指的是哪个元素」。
 *
 * 选择器本身在站点改版后常会命中**另一个**元素（class 重排、同文案按钮增多）。
 * 回放只按选择器命中就把错误元素当成目标点了，表现是「点了一下但什么都没发生」，
 * 极难排查。指纹把「当初那个元素长什么样」存成一组稳定的可见/语义特征，回放时
 * 逐条比对：任何一条对不上即视为失配，不把这个元素当成命中。
 *
 * 全部字段可选：采集侧只写有把握的特征；回放只核验**步骤上写了的**字段，
 * 没写的字段一律不比对（向后兼容：没有指纹的老步骤维持原行为）。
 */
export interface WorkflowElementFingerprint {
  /** 元素标签名（小写，如 `button`）。 */
  tag?: string;
  /** `aria-label`。 */
  aria?: string;
  /** `name` 属性。 */
  name?: string;
  /** `data-testid`。 */
  testId?: string;
  /** 输入类控件的 `type`（text/password/checkbox/...）。 */
  inputType?: string;
  /** 规范化后的可见文本（折叠空白）。 */
  text?: string;
  /** `role` 属性。 */
  role?: string;
}

/**
 * 学习到的手势语义。缺省（不写）等价于单击左键，旧流程行为不变。
 *
 * - `double`：双击（间隔短于系统双击阈值）；
 * - `right`：右键（回放派发右键上下文菜单事件）；
 * - `long-press`：长按（按住超过阈值再松开，移动端菜单常用）。
 */
export type WorkflowGesture = 'click' | 'double' | 'right' | 'long-press';

/**
 * 允许回放的**非打印**键。
 *
 * 只收功能键，绝不收可打印字符：可打印字符会泄露输入内容，且真正的文本填写
 * 必须走 `fill` + 站点配置，而不是回放击键。
 */
export type WorkflowKey =
  | 'Enter'
  | 'Space'
  | 'Escape'
  | 'Tab'
  | 'ArrowUp'
  | 'ArrowDown'
  | 'ArrowLeft'
  | 'ArrowRight';

/** 表单控件的种类；缺省 `text` 表示文本框，与旧流程一致。 */
export type WorkflowFormControl = 'text' | 'select' | 'checkbox' | 'radio';

export type CheckinWorkflowStep =
  | {
      type: 'if';
      /** 根据页面证据选择一条受限分支，不执行任意脚本。 */
      condition: CheckinWorkflowCondition;
      then: CheckinWorkflowStep[];
      else?: CheckinWorkflowStep[];
    }
  | {
      type: 'navigate';
      /** 同源相对地址或本站绝对地址 */
      url: string;
    }
  | {
      type: 'click';
      /** CSS 或 text= 选择器 */
      selector: string;
      /** 点击后必须出现的元素，可选 */
      waitFor?: string;
      /** 等待元素的最长时间，默认 10 秒 */
      timeoutMs?: number;
      /**
       * 元素内的相对落点 —— 「用户点的是这个控件的哪个位置」。
       *
       * 学习模式按录制时的真实坐标换算成宽高比例存下来；回放时用
       * `rect.left + rect.width * rx` 还原。缺省时按元素中心点击（旧流程行为不变）。
       */
      anchor?: WorkflowPointerAnchor;
      /** 手势语义；缺省单击左键。 */
      gesture?: WorkflowGesture;
      /** 用键盘触发而不是鼠标；只允许非打印键。 */
      key?: WorkflowKey;
      /** `gesture === 'long-press'` 时按住的毫秒数；缺省由执行器决定。 */
      holdMs?: number;
      /** 录制时控件的身份指纹；回放时逐条核验，不一致即失配。 */
      fingerprint?: WorkflowElementFingerprint;
      /**
       * 点击前先把目标滚进视口。
       *
       * 学习模式在「用户先滚动页面才够得着这个控件」时写下它。用相对量而不是录制时的
       * 绝对像素：页面高度、字体、公告都会让像素对不上，而 `scrollIntoView` 始终有效。
       */
      scrollIntoView?: boolean;
      /** 学习时滚动的内层面板；目标尚未挂载时在此面板内逐屏查找。 */
      scrollContainer?: string;
    }
  | {
      type: 'fill';
      /** input / textarea 的 CSS 或 text= 选择器 */
      selector: string;
      /** 固定文本，支持 {{claimText}} 占位符 */
      value: string;
      /** 等待输入框的最长时间，默认 10 秒 */
      timeoutMs?: number;
      /**
       * 控件种类；缺省 `text`（文本框，行为与旧流程一致）。
       *
       * - `select`：用 `choice` 选第 N 项（**存序号不存选项文本**，站点改文案也不失效）；
       * - `checkbox` / `radio`：用 `checked` 指定目标选中态，而不是「点一下翻转」——
       *   翻转式回放会在「已经勾上了」的页面上把勾取消掉。
       */
      control?: WorkflowFormControl;
      /** `select` 专用：选中项序号（0 起）。 */
      choice?: number;
      /** `checkbox` / `radio` 专用：期望的选中态。 */
      checked?: boolean;
      /** 录制时控件的身份指纹；回放时逐条核验，不一致即失配。 */
      fingerprint?: WorkflowElementFingerprint;
      /** 填写前先把输入框滚进视口；语义同 click 的同名字段。 */
      scrollIntoView?: boolean;
      scrollContainer?: string;
    }
  | {
      /**
       * 滚动步骤 —— 「用户滑到了哪里」。
       *
       * 用**比例**而不是录制时的像素：页面高度、字体、公告条都会变，比例在同一站点
       * 的不同时刻仍指向大致同一处。回放时按 `ratio * (scrollHeight - clientHeight)`
       * 换算成实际像素。`ratio` 为 1 表示滚到底，用于触发无限滚动/懒加载。
       */
      type: 'scroll';
      /** 0..1，0 = 顶部，1 = 底部。 */
      ratio: number;
      /** 内层滚动容器的稳定选择器；缺省滚页面本身。 */
      container?: string;
      /** 滚动后等待界面稳定的时间（毫秒）；缺省由执行器决定。 */
      settleMs?: number;
      /** 等待懒加载内容出现的最长时间，默认由执行器决定。 */
      timeoutMs?: number;
    }
  | {
      /**
       * 拖拽步骤 —— 「用户把控件拖到了哪里」。
       *
       * 学习模式在位移达到阈值时写下它；回放用 `realDrag` 原语把起点控件拖到
       * 终点控件内同一处（按落点比例还原）。起点/终点选择器都可能指向同一控件
       * （滑块把手拖完弹回原位），那也是真实的拖拽。
       */
      type: 'drag';
      /** 起点控件（把手）选择器。 */
      selector: string;
      /** 终点控件选择器。 */
      toSelector: string;
      /** 起点落点（按下时在把手内的相对位置）。 */
      anchor?: WorkflowPointerAnchor;
      /** 终点落点（松开时在目标内的相对位置）。 */
      toAnchor?: WorkflowPointerAnchor;
      /** 回放时拖拽经过的中间步数；缺省由执行器决定。 */
      steps?: number;
      /** 拖拽前先把起点控件滚进视口；语义同 click 的同名字段。 */
      scrollIntoView?: boolean;
      /** 学习时滚动的内层面板；起点控件尚未挂载时在此面板内逐屏查找。 */
      scrollContainer?: string;
      timeoutMs?: number;
    }
  | {
      type: 'wait';
      /** 等待毫秒数；与 selector 二选一，默认 500ms */
      ms?: number;
      /** 等待元素出现；与 ms 二选一 */
      selector?: string;
      timeoutMs?: number;
    }
  | {
      type: 'assert';
      /** 页面上可见的元素选择器，与 text 至少提供一个 */
      selector?: string;
      /** 页面正文包含任一词，与 selector 至少提供一个；两者同时存在时任一命中即可 */
      text?: string[];
      /** 命中后结束工作流并返回对应终态；不填则仅作为前置断言 */
      result?: 'success' | 'already';
      /** 断言未命中时是否继续执行后续步骤 */
      optional?: boolean;
      timeoutMs?: number;
    }
  | {
      /** 一梦五千年：每日签到后进入浮梦引光并完成一次抽奖。 */
      type: 'leilei-daily';
    };

export interface CheckinWorkflowConfig {
  steps: CheckinWorkflowStep[];
  /**
   * 学习模式记录的页面路线（同源 pathname[#hash]，按访问顺序）。
   *
   * 这是「学会网址」的载体：用户手动签到一次后，扩展记住经过的页面顺序，
   * 之后按这条路线逐页推进到签到页，不再要求用户手填签到页地址。
   *
   * 最后一项是执行签到动作的目标页；运行时会先沿路线导航，到达目标页后
   * 才执行 steps。路线为空时退回只执行 steps 的老行为。
   */
  route?: string[];
  /**
   * 身份核对页（学会「我是谁」那一页）。
   *
   * 学习模式从路线里识别出「能证明登录身份」的页面（个人中心/账号设置），
   * 回放时先打开它核对当前账号与录制账号一致，再进入签到页，避免拿 A 的
   * 登录态去做 B 的签到。缺省退回不核对的老行为。
   */
  identityPath?: string;
}

/**
 * 手动学习模式采集的安全事件。
 *
 * 只保存控件选择器、有限长度的可见标签和脱敏后的页面证据，
 * 绝不保存 input value、密码、token 或完整页面正文。
 */
export type WorkflowLearningEvent =
  | {
      type: 'navigation';
      path: string;
      at: number;
    }
  | {
      /**
       * 一次「连续滚动」的最终落点 —— 纯滚动也是用户真实做过的一步。
       *
       * 旧实现只在滚动之后紧跟点击/输入时才顺带记下位置，用户「滚下去看内容再
       * 慢慢找按钮」这一类操作会整段丢失，回放时停在首屏找不到控件。
       */
      type: 'scroll';
      path: string;
      /** 0..1 的相对滚动位置。 */
      ratio: number;
      /** 内层滚动容器选择器；页面自身滚动时不带。 */
      container?: string;
      at: number;
    }
  | {
      type: 'click';
      selector: string;
      label: string;
      path: string;
      href?: string;
      evidence?: { kind: 'success' | 'already'; words: string[] };
      /** 「这一步之后界面出现了什么」的有限片段，见 automation/learning.ts。 */
      afterText?: string[];
      /** 这个动作**之前**页面停在哪一像素：编译成步骤上的 `scrollIntoView`。 */
      scrollBeforeY?: number;
      /** 页面本身没动、但滚动容器滚过：像素不可信，只标记「滚过」。 */
      scrollPageTop?: boolean;
      /** 实际滚动面板的安全 CSS 选择器，不保存像素轨迹。 */
      scrollContainer?: string;
      /** 用户点的是控件内哪个位置；缺省按中心点击。 */
      anchor?: WorkflowPointerAnchor;
      /** 手势语义：单击（缺省）/ 双击 / 右键 / 长按。 */
      gesture?: WorkflowGesture;
      /** 录制时控件的身份指纹；回放时逐条核验，不一致即失配。 */
      fingerprint?: WorkflowElementFingerprint;
      /** 这次动作用键盘触发时记下的非打印键。 */
      key?: WorkflowKey;
      /**
       * 长按或拖拽的实际按住时长（毫秒）。仅 `gesture === 'long-press'` 时写入，
       * 回放按同一量级复现，避免「按太短没出菜单」。
       */
      holdMs?: number;
      /** 拖拽终点控件选择器；只有真正发生位移的手势才写。 */
      dragToSelector?: string;
      /** 拖拽终点在目标控件内的相对落点。 */
      dragToAnchor?: WorkflowPointerAnchor;
      /** 登录学习阶段对点击的有限分类；签到学习不设置。 */
      loginAction?: 'entry' | 'submit' | 'oauth';
      at: number;
    }
  | {
      /**
       * 一次真实的拖拽：按下在起点控件内，松开在终点控件内。
       *
       * 回放按「起点/终点选择器 + 各自相对落点」重建指针轨迹（真实按下 → 逐步移动 → 松开）。
       * 拖拽把手的噪声（滑块验证、页面装饰）不产生它：那类交互由回放侧的自动破解
       * 管线接管，录成业务步骤只会让回放去拖一个不存在的把手。
       */
      type: 'drag';
      selector: string;
      toSelector: string;
      label: string;
      path: string;
      /** 按下点落在起点控件内的相对位置（0..1）。 */
      anchor?: WorkflowPointerAnchor;
      /** 松开点落在终点控件内的相对位置（0..1）。 */
      toAnchor?: WorkflowPointerAnchor;
      /** 拖拽发生前用户把页面滚到了哪里；编译成步骤上的 scrollIntoView。 */
      scrollBeforeY?: number;
      scrollPageTop?: boolean;
      scrollContainer?: string;
      /** 「这一步之后界面出现了什么」的有限片段（与 click 同一套内容闸门）。 */
      afterText?: string[];
      /** 拖拽后页面给出的成功/已完成证据（与 click 同一套固定词表）。 */
      evidence?: { kind: 'success' | 'already'; words: string[] };
      at: number;
    }
  | {
      type: 'fill';
      selector: string;
      label: string;
      path: string;
      /**
       * 用户是否真的输入了内容。
       *
       * **绝不保存输入值本身** —— 里面可能是验证码、邀请码、理由文本甚至被误填的密码。
       * 编译成步骤时统一落成 `{{claimText}}` 占位符，由站点配置提供实际文本。
       */
      hasValue: boolean;
      /** 登录学习只记字段角色和选择器，不记任何输入内容。 */
      fieldRole?: 'username' | 'password';
      /**
       * 在输入框里按下的非打印功能键（如 Enter 提交）。
       *
       * 登录框里按 Enter 不会派发 click，但它是真实的一次登录提交；只记键名，
       * 绝不记可打印字符。判据见 automation/learning/learning-stage.ts。
       */
      key?: WorkflowKey;
      /**
       * 本次登录学习期间**出现过**验证码/OTP/二次验证字段。
       *
       * 只记布尔「出现过」，绝不记字段值、字段选择器或验证码内容：这类字段
       * 有意不学习，回放时必须由用户人工处理。该标记只用于学习结束后的明确提示。
       */
      challengeSeen?: boolean;
      /** 控件种类；缺省文本框。 */
      control?: WorkflowFormControl;
      /** 录制时控件的身份指纹；回放时逐条核验，不一致即失配。 */
      fingerprint?: WorkflowElementFingerprint;
      /** `select` 专用：选中项序号（0 起），**不存选项文本**。 */
      choice?: number;
      /** `checkbox` / `radio` 专用：操作之后的选中态。 */
      checked?: boolean;
      afterText?: string[];
      scrollBeforeY?: number;
      scrollPageTop?: boolean;
      scrollContainer?: string;
      at: number;
    };

/**
 * 已录内容的**人类可读摘要** —— 用户在管理页上看到的「扩展到底学会了什么」。
 *
 * 不是事件流本身（那是内部数据结构），而是编译器从事件里提炼出的
 * 关键动作：比如「滚动到 80%」「点击 立即签到（双击）」「填写 理由」。
 * 只读展示用，不影响回放。
 */
export interface WorkflowLearningPreview {
  kind: 'navigation' | 'scroll' | 'click' | 'drag' | 'fill';
  /** 一行可读文案，如「点击 立即签到（双击）」。 */
  text: string;
  path: string;
  at: number;
}

export interface WorkflowLearningSession {
  runId: string;
  accountId: string;
  siteId: string;
  /** 缺省兼容旧会话：视为签到学习（含融合学习的 `both`）。 */
  kind?: LearningKind;
  tabId: number;
  createdAt: number;
  events: WorkflowLearningEvent[];
  /**
   * 已录内容的**人类可读摘要** —— 用户在管理页上看到的「扩展到底学会了什么」。
   *
   * 不是事件流本身（那是内部数据结构），而是编译器从事件里提炼出的
   * 关键动作：比如「滚动到 80%」「点击 立即签到（双击）」「填写 理由」。
   * 只读展示用，不影响回放。
   */
  preview?: WorkflowLearningPreview[];
  /**
   * 本次登录学习是否出现过验证码/OTP/二次验证字段。
   *
   * 只保存布尔值；验证码字段不学习、值绝不采集。结束时用它明确提示用户，
   * 避免用户误以为验证码步骤也被学会了。
   */
  challengeSeen?: boolean;
  /**
   * 结束学习时已经提示过一次「这次演示保存后可能不按预期签到」
   * （登录成功但没录到签到；或编出的回放流程里没有签到证据）。
   *
   * 只问一次；用户看过提示后再结束，按当时能保存的内容照常保存。
   */
  endLearningPrompted?: boolean;
  /**
   * 演示账号自己的名字（登录名、站点用户名、邮箱等），只在会话期间存在 session 存储里。
   *
   * 采集侧据此**不用名字当选择器**：流程属于站点、站内所有账号共用，`text=alice`
   * 这种选择器在别的账号页面上必然找不到。名字本身从不写进事件或站点配置。
   */
  personalTexts?: string[];
}

export const CHECKIN_WORKFLOW_STEP_TYPES = [
  'if',
  'navigate',
  'click',
  'fill',
  'scroll',
  'drag',
  'wait',
  'assert',
  'leilei-daily',
] as const;

export type CheckinWorkflowStepType = (typeof CHECKIN_WORKFLOW_STEP_TYPES)[number];

/**
 * 学习会话的种类。
 *
 * - `login`：只学「怎么登」——采集凭据字段的 fieldRole 与入口/提交/OAuth 动作，
 *   绝不保存账号或密码值；
 * - `checkin`：学「怎么领」——沿用完整动作流。**同时**记录凭据字段语义，因此一次
 *   `checkin` 学习就能同时编译出登录配置与签到流程（见 `buildLearnedArtifacts`）。
 *   这样旧调用方（只发 `checkin`）无需改动就获得融合学习；
 * - `both`：显式的融合学习，采集与编译语义和 `checkin` 完全一致，只是把「一次学两样」
 *   的意图写进会话，便于 UI 与新旧调用方区分。
 *
 * 缺省视为签到学习（兼容旧会话与旧调用方）；`login` 保持「只学登录、不产出签到流程」
 * 的旧行为，旧调用方行为一字不变。
 */
export type LearningKind = 'checkin' | 'login' | 'both';

/** 一次学习最终写回站点的产物种类。 */
export type LearnedArtifactKind = 'login' | 'checkin';