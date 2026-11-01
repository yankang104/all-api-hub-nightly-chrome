import type { LearningKind, WorkflowLearningEvent, WorkflowLearningSession } from '@/types';
import type { LearningGuideView } from '@/automation/learning/learning-stage';

export type LearningMessage =
  /**
   * 管理页 → background：开始录制；已有录制时再次点击则完成并保存。
   *
   * `kind` 缺省为 `checkin`（旧行为）；`checkin` 与 `both` 都是**融合学习**
   * （登录配置 + 签到流程一次录完），`login` 保持只学登录的旧语义。
   */
  | {
      type: 'TOGGLE_LEARNING';
      accountId: string;
      kind?: LearningKind;
      /**
       * 用户点了「登录即签到」而不是普通「结束学习」。
       *
       * 语义：本站登录成功后即算签到、页面上没有签到按钮，按「登录即签到」
       * 收尾并保存完整流程（登录配置 + 站点级 `checkin.method = 'none'`）。
       * 后台会先过保守判据（登录已生效、没点过退出登录、也没录到签到动作），
       * 不满足时拒绝并保留会话。
       */
      loginAsCheckin?: boolean;
    }
  /** 管理页 → background：读取学习状态；不传 accountId 时返回全部在录会话。 */
  | { type: 'GET_LEARNING'; accountId?: string }
  /** 管理页 → background：取消录制且不保存。 */
  | { type: 'CANCEL_LEARNING'; accountId: string }
  /** background → content：结算末尾动作并等待所有事件落盘后，才允许编译保存。 */
  | { type: 'FLUSH_LEARNING'; runId: string }
  /** content → background：上报一次脱敏后的页面动作。 */
  | { type: 'LEARN_EVENT'; runId: string; event: WorkflowLearningEvent }
  /**
   * background → content：进入/退出录制模式。
   *
   * `learning` 为空表示**停止录制**：结束学习或取消学习后必须让页面立刻停手，
   * 否则页面会继续把用户后续的操作上报成「还在学习」的动作。
   */
  | { type: 'LEARN_MODE'; learning: WorkflowLearningSession | null };

export interface LearningResponse {
  learning?: {
    active: boolean;
    eventCount: number;
    tabId?: number;
    saved?: boolean;
    kind?: LearningKind;
    /**
     * 这一轮**实际写回站点**的产物。
     *
     * 融合学习允许只完成一半：只完成了登录就是 `['login']`，只有签到步骤就是
     * `['checkin']`。管理页据此如实提示「哪一半没录到」，而不是笼统地说「已保存」。
     */
    savedKinds?: Array<'login' | 'checkin'>;
    /**
     * 本次学习**本来要录哪些产物**（'login' 只学登录；'both' 融合学习要两份）。
     *
     * 与 `kind` 的区别：`kind` 由实际存下的产物反推，`intent` 才是用户点的那件事。
     * 缺省（旧后台）时管理页按 `kind` 推断意图。
     */
    intent?: 'login' | 'both';
    /** 已录内容的可读摘要；与 WorkflowLearningSession.preview 同一份数据。 */
    preview?: Array<{ kind: 'click' | 'fill' | 'scroll' | 'drag' | 'navigation'; text: string; path: string; at: number }>;
    /**
     * 这次演示能不能按「登录即签到」保存（「登录已生效、没点退出登录、也没录到签到动作」）。
     *
     * 为 true 时管理页在学习面板里给出「登录即签到」出口；服务端在保存路径上
     * 用同一判据复核，界面拿到的是提示、不是权限。
     */
    loginAsCheckinAvailable?: boolean;
    /**
     * 签到那一半最终以什么形态落盘。
     *
     * - `workflow`：录到真实签到动作，保存为可回放的流程；
     * - `login-as-checkin`：按用户确认保存为站点级「登录即签到」（method none）。
     *
     * 缺省（旧后台或未保存签到那一半）时不要猜，按普通文案渲染。
     */
    checkinSavedAs?: 'workflow' | 'login-as-checkin';
    /**
     * 学习结束时必须让用户看到的明确提示（如「验证码不会被学习，回放需人工处理」）。
     *
     * 只放固定文案，绝不回传录制到的页面内容或输入值。
     */
    warnings?: string[];
    /**
     * 完整性自检结论（可选）。
     *
     * 由 utomation/learning/learning-report.ts 的 uildLearningReport() 产出：
     * 结论（complete / partial / incomplete）+ 逐行固定文案。管理页优先渲染它；
     * 没有这个字段时回落渲染 warnings。同样只允许固定文案。
     */
    report?: {
      verdict: 'complete' | 'partial' | 'incomplete';
      lines: Array<{ status: 'ok' | 'warn' | 'missing'; text: string }>;
    };
  };
  /**
   * 全部在录会话。
   *
   * 管理页拿不到录制期间的状态广播（用户是在另一个标签页手动签到），
   * 只能靠 `GET_LEARNING` 轮询，因此这里返回列表而不是单个会话。
   */
  learningSessions?: Array<{
    accountId: string;
    tabId: number;
    eventCount: number;
    kind: LearningKind;
    active: true;
    /** 已录内容的可读摘要；与 WorkflowLearningSession.preview 同一份数据。 */
    preview?: Array<{ kind: 'click' | 'fill' | 'scroll' | 'drag' | 'navigation'; text: string; path: string; at: number }>;
    /**
     * 当前进度对应的引导（与页面浮层同一份判定：learning-stage.ts）。
     *
     * 管理页拿它画「① 登录 → ② 账号页 → ③ 签到 → ④ 结束」的步骤条与
     * 当前该做什么的提示；全部是固定文案，不含页面内容与输入值。
     */
    guide?: LearningGuideView;
    /** 这份演示能不能按「登录即签到」保存；见 LearningResponse.learning 上的同名字段。 */
    loginAsCheckinAvailable?: boolean;
  }>;
  /**
   * content → background 的 `FLUSH_LEARNING` 结算回执：结束学习那一刻，页面上
   * 是否存在**可见、可点**的签到动作控件。
   *
   * 这是「登录即签到」自动判定的证据之一（automation/learning/learning.ts 的
   * shouldAutoSaveLoginAsCheckin）：`false` 表示结束那一刻页面上没有可点的签到控件。
   * 只允许回一个布尔 —— 控件文案、属性、标签、选择器一律不出页面，与 challengeSeen
   * 同一口径。
   *
   * 可选字段：旧 content（升级前打开的标签页）不返回它，此时是 `undefined`（未观测），
   * 与 `false`（观测到「确实没有」）语义不同，消费方按自己的保守程度取舍。
   */
  checkinControlSeen?: boolean;
  /** content script → 当前标签页的录制状态。 */
  learningSession?: WorkflowLearningSession;
}

export type LearningSnapshot = WorkflowLearningSession;
