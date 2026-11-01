/**
 * 消息协议。
 *
 * ⚠️ 本文件已冻结。
 *
 * 新消息一律加到 lib/messages/ 下对应功能域的文件里：
 *   余额 → messages/balance.ts   通知 → messages/notify.ts   同步 → messages/sync.ts
 *
 * 原因同 types/index.ts：多方同时往一个联合类型里加成员必然冲突，
 * 按域拆开之后各改各的文件。
 */

import type {
  Account,
  CheckinSchedule,
  DailyStatus,
  LastResult,
  LaunchMode,
  LoginTask,
  ProxyConfig,
  SiteConfig,
  TaskResult,
} from '@/types';
import type { FeatureMessage, FeatureResponse } from '@/lib/messages';

export type AppMutation =
  | { action: 'add-site'; input: Omit<SiteConfig, 'id'> }
  | { action: 'add-sites'; inputs: Omit<SiteConfig, 'id'>[]; preserveDuplicates?: boolean }
  | { action: 'update-site'; siteId: string; patch: Partial<SiteConfig> }
  | { action: 'move-site'; siteId: string; direction: 'up' | 'down'; orderedIds?: string[] }
  | { action: 'delete-entities'; siteIds: string[]; accountIds: string[] }
  | { action: 'add-account'; input: Omit<Account, 'id'> }
  | { action: 'add-accounts'; inputs: Omit<Account, 'id'>[]; preserveDuplicates?: boolean }
  | { action: 'update-account'; accountId: string; patch: Partial<Account> }
  | { action: 'add-proxy'; input: Omit<ProxyConfig, 'id'> }
  /**
   * 批量入池（订阅导入用）。
   *
   * 不用循环发 add-proxy：那样是 N 次读改写 + N 次 load()，几十个节点会把
   * 管理页刷成幻灯片，而且中途失败会留下半个池子。
   */
  | { action: 'add-proxies'; inputs: Omit<ProxyConfig, 'id'>[] }
  | { action: 'update-proxy'; proxyId: string; patch: Partial<ProxyConfig> }
  | { action: 'remove-proxy'; proxyId: string }
  /** 批量把账号绑到池内节点，同理一次写完 */
  | { action: 'assign-account-proxies'; assignments: { accountId: string; proxyId: string; pinned?: boolean }[] }
  | { action: 'set-status'; accountId: string; value: DailyStatus }
  /**
   * 手动标记签到已完成。
   *
   * 不能用 set-status + 'done' 代替：那样只改状态、不写结果，
   * 上一次的失败原因会留在界面上配着绿徽标显示。见 lib/manual-checkin.ts。
   */
  | { action: 'mark-done'; accountId: string }
  | { action: 'update-schedule'; schedule: CheckinSchedule };

/** 核心消息：登录签到流程本身 */
export type CoreMessage =
  /** 管理页 → background：为某账号开新标签并自动登录签到 */
  | { type: 'START_LOGIN'; accountId: string }
  /** 管理页 → background：交给后台队列串行执行，管理页关闭后仍会继续 */
  | { type: 'START_BATCH'; accountIds: string[] }
  /** 管理页 → background：唯一负责落地工具栏启动行为的控制器 */
  | { type: 'SET_LAUNCH_MODE'; mode: LaunchMode; requestId: number }
  /** 管理页 → background：所有持久化写入统一在后台串行执行 */
  | { type: 'MUTATE_APP'; mutation: AppMutation }
  /** content → background：拉取本 tab 的待执行任务 */
  | { type: 'GET_TASK' }
  /** content → background：推进任务阶段（提交表单前 / 跳转前落地进度） */
  | { type: 'SET_STAGE'; runId: string; stage: LoginTask['stage']; steps: string[] }
  /** GitHub 退出页 → background：GitHub 会话已清除，返回原站点重新登录。 */
  | { type: 'GITHUB_LOGOUT_COMPLETE'; runId: string; steps: string[] }
  /**
   * content → background：本轮已确认当前登录的就是本任务的账号。
   *
   * 只在「本任务亲自用账密登录成功」后发送，让后续页面跳转不必重新核对身份 ——
   * 不暴露用户名的站点否则会被反复判成「读不到身份」而无限重登。
   */
  | { type: 'CONFIRM_IDENTITY'; runId: string }
  /**
   * content → background：把登录后读到的身份（userId / 邮箱 / 用户名）回填到账号。
   *
   * 供下次核对「当前登录的是不是本账号」用 —— 尤其是 OAuth 账号，
   * 它的 userId 只有登录后才知道，记下来才能在复签时判断一致性。
   */
  | {
      type: 'SAVE_IDENTITY';
      runId: string;
      identity: {
        userId?: string;
        username?: string;
        email?: string;
        displayName?: string;
        source?: 'api' | 'storage' | 'visible';
        verifiedByManagedLogin?: boolean;
      };
    }
  /** content → background：安全验证需要用户在当前标签页处理 */
  | { type: 'NEEDS_USER'; runId: string; message: string; steps: string[] }
  /** content → background：本 tab 的任务执行结果 */
  | { type: 'TASK_RESULT'; runId: string; result: TaskResult }
  /** popup → background：测试代理连通性 */
  | { type: 'TEST_PROXY'; proxy: ProxyConfig }
  /** background → 管理页：状态已变更，请刷新 */
  | { type: 'STATUS_CHANGED' };

/** background ↔ 管理页 ↔ content 的消息协议 */
export type Message = CoreMessage | FeatureMessage;

export type MessageResponse =
  | {
      ok: true;
      task?: LoginTask | null;
      /**
       * 代理连通性测试结果。
       *
       * ip/country 是「这个端口的出口在哪」—— 扫描本机端口时全靠它区分
       * 哪个端口通向哪个节点，否则一排 7901..7916 看不出差别。
       * 查不到时留空：地理查询失败不代表端口不通，不能因此判死。
       */
      /**
       * 本机端口有没有在监听(仅失败时有值)。用来把「脚本没生效」和
       * 「节点连不通」分开 —— 两者在浏览器里都只表现为「连不上」。
       */
      test?: {
        ok: boolean;
        ms: number;
        message: string;
        ip?: string;
        country?: string;
        listenerProbe?: 'listening' | 'closed';
      };
      queued?: number;
      skipped?: number;
      added?: number;
      updated?: number;
      /** add-proxies：已有名称条目补上真实出口的数量 */
      upgraded?: number;
      /** assign-account-proxies：实际写入的账号数 */
      assigned?: number;
      /** 功能消息的响应统一走这个槽位，不再往上面加字段 */
      feature?: FeatureResponse;
    }
  | { ok: false; error: string };

/**
 * 消息往返的兜底超时。
 *
 * 为什么必须有：MV3 Service Worker 会被浏览器回收。若恰好在处理某条消息
 * 时被回收，`chrome.runtime.sendMessage` 的回调**永远不会触发**，也不会设置
 * `lastError` —— 于是 content script 静默挂死在那个 await 上。
 *
 * 实测（Orbelis）：日志停在「已保存签到按钮点击前的余额基线」，下一行本该是
 * 「已点击签到按钮」，但一分半钟没有任何输出。卡住的正是点击那一步的
 * `TRUSTED_POINTER_CLICK` 往返，而 `mayNavigate` 的点击不受任何超时保护，
 * 只能等 10 分钟看门狗把整个任务杀掉。用户看到的是「正在签到 1 分 24 秒」。
 *
 * 45 秒足够覆盖最慢的合法处理：可信指针要走完拟人轨迹（含随机停顿）、
 * 滑块要截图 + 模板匹配 + 拖拽。超过就必然是丢了回包，报错比挂死好 ——
 * 至少用户看得见发生了什么，重试也有出口。
 */
const MESSAGE_TIMEOUT_MS = 45_000;

/**
 * 单个端口连通性检查的最坏耗时，与 background 的
 * `PORT_SCAN_CONNECT_TIMEOUT_MS` / `testProxy` 默认值对齐。
 *
 * 查出口那档要额外算两次地理接口请求（各 6 秒），它们串在同一个端口里。
 */
const PORT_PROBE_MS = 8_000;
const PORT_PROBE_WITH_EXIT_MS = 12_000 + 2 * 6_000;
/** Clash listeners 探测、代理设置生效等待这些固定开销 */
const SCAN_FIXED_OVERHEAD_MS = 10_000;

/**
 * 这条消息该给多长时间。
 *
 * 为什么不能一个常数管到底：`chrome.proxy` 是**浏览器全局**设置，
 * 端口扫描只能串行做 —— 16 个端口全不通就是 16×8=128 秒，而固定的
 * 45 秒预算在第 6 个端口就到点了。UI 于是把「后台还在扫」显示成
 * 「所有节点都测不通」，用户看到的是代理功能整个坏了，实际后台跑得好好的。
 *
 * 预算按端口数算出来，比盲目调大一个全局常数好：签到路径上的消息仍然
 * 45 秒就报错（丢回包必须尽早说），慢的只有真正需要慢的那两条。
 */
function timeoutFor(msg: Message): number {
  // 内嵌验证码的连接和状态查询不执行拖动，不能占用一次完整求解的 45 秒预算。
  if (msg.type === 'SLIDER_FRAME_PREPARE') return 8_000;
  if (msg.type === 'SLIDER_FRAME_CONNECT' || msg.type === 'SLIDER_FRAME_REPORT'
    || msg.type === 'SLIDER_FRAME_STATUS' || msg.type === 'SLIDER_FRAME_CANCEL') return 4_000;
  if (msg.type === 'SCAN_LOCAL_PORTS') {
    const per = msg.withExit === true ? PORT_PROBE_WITH_EXIT_MS : PORT_PROBE_MS;
    return msg.ports.length * per + SCAN_FIXED_OVERHEAD_MS;
  }
  // 单个节点点测试：testProxy 默认 12 秒，外加查出口与设置生效的开销
  if (msg.type === 'TEST_PROXY') return PORT_PROBE_WITH_EXIT_MS + SCAN_FIXED_OVERHEAD_MS;
  return MESSAGE_TIMEOUT_MS;
}

export function sendMessage(msg: Message): Promise<MessageResponse> {
  return new Promise((resolve) => {
    const budget = timeoutFor(msg);
    let settled = false;
    const finish = (response: MessageResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(response);
    };
    const timer = setTimeout(() => {
      finish({
        ok: false,
        error: `后台在 ${Math.round(budget / 1000)} 秒内没有响应 ${msg.type}`
          + '（Service Worker 可能已被回收）',
      });
    }, budget);

    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) {
          finish({ ok: false, error: chrome.runtime.lastError.message ?? 'unknown' });
          return;
        }
        finish(resp ?? { ok: true });
      });
    } catch (error) {
      // 扩展上下文失效（重新加载扩展）时 sendMessage 会同步抛错。
      finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}

/** storage.session 中任务信箱的键前缀（按 tabId 索引） */
export const TASK_KEY = (tabId: number) => `task:${tabId}`;

/** 手动学习模式按标签页保存的录制信箱。 */
export const LEARN_KEY = (tabId: number) => `learn:${tabId}`;

export type { LastResult };
