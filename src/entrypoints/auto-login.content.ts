import type { LoginTask, TaskStage, WorkflowLearningSession } from '@/types';
import type { BalanceSnapshot } from '@/types';
import { sendMessage } from '@/lib/core/messaging';
import { runTask, type EngineHost } from '@/automation/engine/engine';
import {
  isGithubAuthUrl,
  isGithubLoggedOutUrl,
  isGithubLoginUrl,
  isGithubLogoutUrl,
  isGithubOAuthAuthorizeUrl,
  isSameSiteUrl,
} from '@/lib/site/site-security';
import { setActiveClickRunId, realClick, setNativeValue, sleep } from '@/automation/shared/dom-utils';
import {
  CHECKIN_ACTION,
  LEARNING_LOTTERY_ACTION,
  NON_ACTION_WORDS,
  checkinControls,
  controlText,
} from '@/automation/checkin/checkin-vocab';
import { LearningCapture } from '@/automation/learning/learning';
import { createLearningGuide } from '@/automation/learning/learning-overlay';
import { createLearningRecorder } from '@/automation/learning/learning-recorder';

/**
 * 学习时的实时引导浮层：告诉用户「现在该做什么、是不是可以结束了」。
 *
 * 只在主框架渲染（子框架里既看不见、又多一份 DOM），且必须是
 * pointer-events: none —— 详见 learning-overlay.ts 里的三条硬约束。
 * 阶段判定基于会话里**跨页累积的全部事件**（GET_TASK 的 feature.learningSession
 * 会把本页之前的事件一起带回来），因此不需要新的消息类型。
 */
const learningGuide = createLearningGuide();

/** 当前学习会话的采集器（含 flush 语义：结束学习前必须等事件确认落盘）。 */
let learningRecorder: (ReturnType<typeof createLearningRecorder> & { runId: string }) | null = null;
/**
 * 立刻停止本页采集。
 *
 * 必须真的调用 `recorder.stop()`：只把浮层收掉、把采集器留着继续监听的话，
 * 用户在「结束学习」之后的每次点击都还会走一遍采集与上报，而会话早已被后台
 * 删除 —— 上报必然失败、浮层里显示的也不再是有效录制，页面看起来还在录。
 *
 * 不清空 `learningRecorder` 本身：同一 runId 的重复 LEARN_MODE 靠它保持幂等，
 * 否则后台重发一次会话广播就会让本页重新 attach、补报一次初始导航。
 */
function stopCurrentLearningCapture(): void {
  learningRecorder?.stop();
}

function startLearningCapture(learning: WorkflowLearningSession): void {
  // GET_TASK 与 LEARN_MODE 可能先后到达；同一会话不能重复 attach/补报初始导航。
  if (learningRecorder?.runId === learning.runId) {
    // 结束学习未保存成功时，后台会恢复同一会话；attach 幂等，不重复建采集器。
    learningRecorder.start();
    return;
  }
  learningRecorder?.stop();
  learningGuide.end();
  const recorder = createLearningRecorder(learning.kind ?? 'checkin', (event) => {
    // 浮层只读事件、只画界面，不参与落盘；放在上报之前，提示要立刻跟上用户的操作。
    learningGuide.push(event);
    return sendMessage({ type: 'LEARN_EVENT', runId: learning.runId, event });
  }, learning.personalTexts);
  learningRecorder = { ...recorder, runId: learning.runId };
  recorder.start();
  // 引导浮层是**附加**能力：它只读事件、只画界面，绝不参与落盘。
  learningGuide.begin(learning);
}

/**
 * 当前页面上是否存在**可见的签到入口**（只回布尔）。
 *
 * 结束学习那一刻的页面形态是「登录即签到」自动判定的证据之一（见
 * automation/learning/learning.ts 的 shouldAutoSaveLoginAsCheckin）：页面上还摆着
 * 签到入口时，绝不能替他断言「本站不需要点」。
 *
 * 判据**刻意不看控件是否可点**：当天已签到时按钮常被置灰成「已签到」，而它恰恰
 * 证明了这个站点本来就有签到入口 —— 把它当成「没有控件」，就会在用户「今天已签」
 * 的那次学习里把站点误改成「登录即签到」，明天真正需要点击时反而不会点。
 * 也就是说，只要能看到签到入口（无论此刻能不能点），就不构成「本站没有签到按钮」
 * 的证据。
 *
 * 控件识别与词表复用 checkin-vocab，与关公告、自动签到走同一套判据；
 * checkinControls() 已经滤掉不可见元素。返回值只有真假 —— 控件文案、属性、
 * 选择器一律不出页面。
 */

function hasVisibleCheckinControl(): boolean {
  return checkinControls().some((element) => {
    const text = controlText(element);
    // 命中动作词（签到/打卡/领取…），且不是「签到记录/规则/日历」这类无用入口。
    if (!CHECKIN_ACTION.test(text) && !LEARNING_LOTTERY_ACTION.test(text)) return false;
    return !NON_ACTION_WORDS.test(text);
  });
}

/**
 * 注入所有页面的自动签到 content script。
 *
 * 绝大多数情况下本 tab 并没有待办任务，此时立即退出，几乎零开销。
 * 只有由「待签到」按钮打开的标签页，信箱里才有任务。
 *
 * 一次完整签到会跨越多个页面（登录页 → 落地页 → 可能的签到页），
 * 每次整页跳转本脚本都会被销毁重建，靠信箱里的 stage 接着往下跑。
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  allFrames: true,
  matchAboutBlank: true,

  async main() {
    chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
      if (!message || typeof message !== 'object') return undefined;
      const candidate = message as {
        type?: unknown;
        learning?: WorkflowLearningSession | null;
        runId?: unknown;
      };

      /**
       * 结算本条消息里的采集器，把「末尾动作是否已经落盘」如实回给 background。
       *
       * 必须等 flush 完成再 sendResponse：紧接着的下一句就是后台去编译保存，
       * 早回一句 ok 会让最后一个动作在写入前被丢掉（用户看到的是「明明点了签到，
       * 学到的流程里却没有那一步」）。所以这里返回 true 表示稍后异步回执。
       */
      if (candidate.type === 'FLUSH_LEARNING') {
        const runId = typeof candidate.runId === 'string' ? candidate.runId : '';
        if (learningRecorder?.runId !== runId) {
          // 这个 frame 没有对应的采集器（跨域 iframe、学习开始后新建的 frame、
          // 跨页后本页是新加载的、或已被停止）。未落盘的事件本来就不属于本页，
          // 如实回空结论即可，不算失败。
          // 采集器不在：这一刻的页面形态**无从归属**到本次演示。用 inactive 明确
          // 告诉后台「这个 frame 不参与判定」——不能回 checkinControlSeen:undefined，
          // 后台会按「最保守者胜」把它当成「未观测」，最终让任何带跨域 iframe 的
          // 页面永远无法自动判定「登录即签到」。
          sendResponse({ ok: true, challengeSeen: false, inactive: true });
          return undefined;
        }
        /**
         * 先封口、再结算。
         *
         * 后台收到 FLUSH 回执后立刻用当时的会话快照编译并保存，随后连信箱一起删掉。
         * 如果结算期间监听器还开着，用户在「点了结束学习」这一小段时间里的点击会被
         * 照常上报：它们要么被后台的整体写回覆盖、要么写进马上被删掉的信箱 ——
         * 两种下场都是**静默丢步**，而浮层已经把这一步画出来了（用户看到「学到了
         * 又没了」）。这里先摘监听器，结束窗口内的点击被明确忽略，画面与落盘一致。
         *
         * `recorder.stop()` 只做 detach，不结算 pending；结算仍由下面这次
         * `recorder.flush()` 完成，因此最后一个已发生的动作不会丢。
         */
        /**
         * 「页面上有没有签到控件」在这里**同步**采样一次。
         *
         * 采样必须早于 flush：flush 要等末尾事件落盘，是异步的，等它回来页面可能
         * 已经跳走或重渲染，采到的就不再是用户点「结束学习」那一刻的形态。只取一个
         * 布尔 —— 控件文案、属性、选择器一律不出本页，与 challengeSeen 同一口径。
         */
        const checkinControlSeen = hasVisibleCheckinControl();
        const recorder = learningRecorder;
        recorder.stop();
        recorder.flush().then(
          // 只回传固定文案提示（如「把手拖拽没写进流程」），不含任何页面内容。
          (result) => sendResponse({
            ok: true,
            challengeSeen: result.challengeSeen,
            checkinControlSeen,
            ...(result.unlearnedNotes.length ? { unlearnedNotes: result.unlearnedNotes } : {}),
          }),
          (error: unknown) => sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        return true;
      }

      if (candidate.type !== 'LEARN_MODE') return undefined;

      /**
       * 必须**同步**回执 ok:true。
       *
       * background 的 toggleLearning 靠这条回执确认「采集器已就绪」才会把会话交给
       * UI：拿不到回执它会重试 50 次后把会话撤掉，返回「学习页面尚未准备好」——
       * 用户看到的是学习功能整个不可用。
       *
       * 注意这里不能用 `async` 监听器返回 Promise：Chrome 的消息 API 不认 Promise，
       * 它只看返回值是否 === true（表示稍后 sendResponse）。同步调 sendResponse 之后
       * 返回 undefined 也是合法的 —— 消息通道此时已经带着响应关掉了。
       */
      if (candidate.learning) {
        startLearningCapture(candidate.learning);
      } else {
        // learning 为 null 表示结束/取消录制：页面必须立刻停手上报。
        stopCurrentLearningCapture();
        // 录制结束（保存或放弃）后浮层必须消失，不能留在用户页面上。
        learningGuide.end();
      }
      sendResponse({ ok: true });
      return undefined;
    });
    const resp = await sendMessage({ type: 'GET_TASK' });
    if (!resp.ok) return;
    if (!resp.task) {
      if (resp.feature?.learningSession) startLearningCapture(resp.feature.learningSession);
      return; // 没有任务，正常浏览的页面
    }

    const task = resp.task as LoginTask;

    setActiveClickRunId(task.runId, task.site.pointerMode ?? 'trusted');

    // 给 OAuth/安全验证留出人工确认时间，同时防止旧标签页日后被意外操作。
    if (Date.now() - task.createdAt > 10 * 60_000) return;

    // 受管 GitHub 切号先在精确的 /logout 页面提交官方退出表单，再由 background
    // 把同一个任务带回原站点登录页。这个裁剪副本不包含任何账号密码或站点 token。
    if (task.effectiveLoginMethod === 'github' && task.stage === 'github-logout') {
      if (isGithubLoggedOutUrl(location.href)) {
        await sendMessage({
          type: 'GITHUB_LOGOUT_COMPLETE',
          runId: task.runId,
          steps: task.steps ?? [],
        });
        return;
      }
      if (!isGithubLogoutUrl(location.href)) return;

      const form = document.querySelector<HTMLFormElement>('form[action="/logout"], form[action="https://github.com/logout"]');
      if (!form) {
        await sendMessage({
          type: 'NEEDS_USER',
          runId: task.runId,
          message: 'GitHub 退出页未找到官方退出表单，自动切换账号已停止',
          steps: task.steps ?? [],
        });
        return;
      }

      try {
        const submit = form.querySelector<HTMLButtonElement | HTMLInputElement>('button[type="submit"], input[type="submit"]');
        // 用 GitHub 原生表单提交，保留页面的 CSRF token、cookie 和正确 Origin。
        // 提交后会跳到 GitHub 根页/登录页，新文档再通知 background 返回原站点。
        if (submit) form.requestSubmit(submit);
        else form.requestSubmit();
      } catch (error) {
        await sendMessage({
          type: 'NEEDS_USER',
          runId: task.runId,
          message: `GitHub 自动退出失败（${error instanceof Error ? error.message : String(error)}）`,
          steps: task.steps ?? [],
        });
      }
      return;
    }

    // GitHub 账密模式拿到的是 background 裁剪过的任务副本：只含 GitHub 凭据，
    // 绝不含站点账密/token。只在受限的 GitHub 登录/授权路径处理，随后由 GitHub
    // 回调原站点，原站点页面会重新取得完整任务继续 verify-oauth。
    if (task.effectiveLoginMethod === 'github' && isGithubAuthUrl(location.href)) {
      // /login/oauth/authorize 是 GitHub 自动跳转到登录表单/授权页的中转页，
      // 不要在这里发人工介入通知；等下一次页面注入即可自动填表。
      if (isGithubOAuthAuthorizeUrl(location.href)) return;
      // 真正的授权确认/二次验证页也不需要人工：继续等待 GitHub 自己完成
      // 回调，避免把自动流程提前改成 attention。
      if (!isGithubLoginUrl(location.href)) return;

      const attemptKey = `aah-github-login-attempt:${task.runId}`;
      let attempted = false;
      try { attempted = sessionStorage.getItem(attemptKey) === '1'; } catch { /* 某些隐私模式禁止 sessionStorage */ }

      const expectedGithubUsername = task.githubUsername?.trim();
      const expectedGithubPassword = task.githubPassword;
      const username = document.querySelector<HTMLInputElement>('#login_field, input[name="login"]');
      const password = document.querySelector<HTMLInputElement>('#password, input[type="password"]');
      if (attempted) {
        await sendMessage({
          type: 'NEEDS_USER',
          runId: task.runId,
          message: 'GitHub 登录未自动完成，请手动完成登录或二次验证',
          steps: task.steps ?? [],
        });
        return;
      }
      if (!username || !password || !expectedGithubUsername || !expectedGithubPassword) {
        await sendMessage({
          type: 'NEEDS_USER',
          runId: task.runId,
          message: 'GitHub 登录页未找到完整的账号密码表单，请手动完成登录',
          steps: task.steps ?? [],
        });
        return;
      }

      try { sessionStorage.setItem(attemptKey, '1'); } catch { /* 不影响后续手动流程 */ }

      // GitHub 页面重绘和浏览器密码管理器都可能在首次填写后覆盖输入框。
      // 最多重填一次，并在真实点击前重新查询 DOM、逐值核对；仍不一致时绝不提交。
      let credentialsVerified = false;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const currentUsername = document.querySelector<HTMLInputElement>('#login_field, input[name="login"]');
        const currentPassword = document.querySelector<HTMLInputElement>('#password, input[type="password"]');
        if (!currentUsername || !currentPassword) break;

        setNativeValue(currentUsername, expectedGithubUsername);
        setNativeValue(currentPassword, expectedGithubPassword);
        await sleep(attempt === 0 ? 250 : 400);

        const verifiedUsername = document.querySelector<HTMLInputElement>('#login_field, input[name="login"]');
        const verifiedPassword = document.querySelector<HTMLInputElement>('#password, input[type="password"]');
        credentialsVerified = verifiedUsername?.value.trim() === expectedGithubUsername
          && verifiedPassword?.value === expectedGithubPassword;
        if (credentialsVerified) break;
      }

      const finalUsername = document.querySelector<HTMLInputElement>('#login_field, input[name="login"]');
      const finalPassword = document.querySelector<HTMLInputElement>('#password, input[type="password"]');
      const submit = document.querySelector<HTMLElement>('input[type="submit"][name="commit"], button[type="submit"]');
      if (
        !credentialsVerified
        || !finalUsername
        || !finalPassword
        || finalUsername.value.trim() !== expectedGithubUsername
        || finalPassword.value !== expectedGithubPassword
      ) {
        await sendMessage({
          type: 'NEEDS_USER',
          runId: task.runId,
          message: `GitHub 登录输入被页面或自动填充覆盖，已停止提交；请确认目标账号 ${expectedGithubUsername}`,
          steps: task.steps ?? [],
        });
        return;
      }
      if (!submit) {
        await sendMessage({
          type: 'NEEDS_USER',
          runId: task.runId,
          message: 'GitHub 登录页未找到提交按钮，请手动完成登录',
          steps: task.steps ?? [],
        });
        return;
      }

      // realClick 会稳定采样按钮并移动可信指针。期间把字段设为只读，阻止
      // 密码管理器在最终核对通过后再次自动填充；background 仍会在 mousePressed
      // 前通过 CDP 做最后一次精确核对，二者共同关闭异步点击窗口。
      const usernameReadOnly = finalUsername.readOnly;
      const passwordReadOnly = finalPassword.readOnly;
      finalUsername.readOnly = true;
      finalPassword.readOnly = true;
      try {
        await realClick(submit, { mayNavigate: true });
      } catch (error) {
        await sendMessage({
          type: 'NEEDS_USER',
          runId: task.runId,
          message: `GitHub 登录自动点击失败，请手动完成登录（${error instanceof Error ? error.message : String(error)}）`,
          steps: task.steps ?? [],
        });
      } finally {
        if (finalUsername.isConnected) finalUsername.readOnly = usernameReadOnly;
        if (finalPassword.isConnected) finalPassword.readOnly = passwordReadOnly;
      }
      return;
    }

    // 所有进度消息串行发送。阶段切换和跳转会等待前面的逐步日志落地，
    // 避免旧的异步消息在新页面加载前反向覆盖更新后的步骤。
    let progressQueue: Promise<void> = Promise.resolve();
    const queueProgress = (steps: string[]) => {
      progressQueue = progressQueue.catch(() => {}).then(async () => {
        const response = await sendMessage({ type: 'SYNC_PROGRESS', runId: task.runId, steps });
        // 实时 UI 是辅助能力，管理页未打开或后台瞬时重启不能打断签到本身。
        if (!response.ok && response.error !== '任务已结束') console.debug('[签到助手] 实时进度同步失败', response.error);
      });
      return progressQueue;
    };

    /**
     * 实时日志不能阻塞真正的业务动作。
     *
     * 进度消息是逐条串行发送的；某一条回执若碰上 Service Worker 重启，
     * 后面的队列会暂时排队。按钮签到的余额基线却必须尽快写进任务信箱，
     * 否则点击后页面重载就失去可核对的 before 快照。最多等 2 秒让正常
     * 日志落地，超时就让关键写入自己走后台锁，旧日志由 updateProgress 的
     * 步骤长度保护处理。
     */
    async function flushProgressForCriticalAction(): Promise<void> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        progressQueue.catch(() => {}),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 2_000);
        }),
      ]);
      if (timer) clearTimeout(timer);
    }

    const host: EngineHost = {
      reportProgress(steps: string[]) {
        return queueProgress(steps);
      },
      async markStage(stage: TaskStage, steps: string[]) {
        await progressQueue;
        const response = await sendMessage({ type: 'SET_STAGE', runId: task.runId, stage, steps });
        if (!response.ok) throw new Error(response.error);
      },
      async navigate(url: string, steps: string[], stage: TaskStage) {
        if (!isSameSiteUrl(task.site, url)) {
          throw new Error('任务试图跳转到非本站地址，已停止自动操作');
        }
        // 先把「跳转后该干什么」写进信箱，再真正跳转
        await progressQueue;
        const response = await sendMessage({ type: 'SET_STAGE', runId: task.runId, stage, steps });
        if (!response.ok) throw new Error(response.error);

        /**
         * 只有 hash 不同时（SPA 路由，如 sharedchat 的 `/list/#/...`），
         * location.assign 不会重载文档 —— content script 不会重新注入，
         * 任务就永久停在这里。这种情况必须显式 reload 一次。
         */
        const next = new URL(url, location.href);
        const onlyHashDiffers = next.origin === location.origin
          && next.pathname === location.pathname
          && next.search === location.search
          && next.hash !== location.hash;
        if (onlyHashDiffers) {
          location.hash = next.hash;
          location.reload();
          return;
        }
        location.assign(url);
      },
      async needsUser(message: string, steps: string[]) {
        await progressQueue;
        const response = await sendMessage({ type: 'NEEDS_USER', runId: task.runId, message, steps });
        if (!response.ok && response.error !== '任务已结束') throw new Error(response.error);
      },
      async clearSiteCookies() {
        await progressQueue;
        const response = await sendMessage({ type: 'CLEAR_SITE_COOKIES', runId: task.runId });
        if (!response.ok) throw new Error(response.error);
        const result = response.feature?.siteCookieClear;
        if (!result) throw new Error('后台未返回本站 Cookie 清理结果');
        return result;
      },
      async startGithubLogout(steps: string[]) {
        await progressQueue;
        const response = await sendMessage({
          type: 'SET_STAGE',
          runId: task.runId,
          stage: 'github-logout',
          steps,
        });
        if (!response.ok) throw new Error(response.error);
        location.assign('https://github.com/logout');
      },
      async saveSession(tokens) {
        // 换到的新令牌要落到账号里，否则下次签到又得再换一遍，
        // 而每次换都会轮换 refresh token，白白增加与站点前端抢的机会。
        await sendMessage({
          type: 'SESSION_REFRESHED',
          runId: task.runId,
          accountId: task.accountId,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          tokenExpiresAt: tokens.tokenExpiresAt,
        });
      },
      async confirmIdentity() {
        // 本轮亲自登录成功；跨页记住，避免后续跳转在不暴露账号的站点上反复重登
        await sendMessage({ type: 'CONFIRM_IDENTITY', runId: task.runId });
      },
      async saveIdentity(identity) {
        // 把登录后读到的身份（userId/邮箱等）回填账号，供下次核对「当前登录的是不是本账号」
        await sendMessage({ type: 'SAVE_IDENTITY', runId: task.runId, identity });
      },
      async saveBalance(snapshot: BalanceSnapshot) {
        /**
         * 余额写入失败必须抛出去，不能只看 sendMessage 返回。
         *
         * sendMessage 在后台返回 {ok:false} 时也**不会 reject**（见 lib/core/messaging.ts
         * 的超时/失败回执设计），所以原先那行 `await sendMessage(...)` 对
         * 「账号身份尚未确认，已拒绝写入余额快照」「任务已结束」这类拒绝完全无感：
         * 快照悄悄丢掉，界面上这个账号永远显示「未获取」，日志里也一个字都没有。
         *
         * 抛出去由 engine 的 hook 记录一行日志，用户至少能看到「余额没存上、
         * 为什么没存上」，而不是对着一个空值猜网络问题。
         */
        const response = await sendMessage({ type: 'BALANCE_SNAPSHOT', runId: task.runId, snapshot });
        if (!response.ok) {
          throw new Error(response.error || '后台未写入余额快照');
        }
      },
      async saveReloginBalanceBefore(snapshot: BalanceSnapshot) {
        await sendMessage({
          type: 'BALANCE_SNAPSHOT',
          runId: task.runId,
          snapshot,
          phase: 'relogin-before',
        });
      },
      async saveButtonBalanceBefore(snapshot: BalanceSnapshot) {
        // POST 表单点击后会立即卸载本脚本；只有收到后台写入成功的回执才可点击。
        await flushProgressForCriticalAction();
        const response = await sendMessage({
          type: 'BALANCE_SNAPSHOT',
          runId: task.runId,
          snapshot,
          phase: 'button-before',
        });
        if (!response.ok) throw new Error(response.error);
      },
      async saveClaimText(text: string) {
        // 站点要求领取理由不重复，用过的必须记住，否则下一轮又会挑到同一条
        await sendMessage({
          type: 'CLAIM_TEXT_USED',
          runId: task.runId,
          siteId: task.site.id,
          text,
        });
      },
      /** 把签到页的正文交给后台落盘签到奖励（见 engine.ts 的同名钩子）。 */
      async saveCheckinReward(bodyText: string) {
        void sendMessage({
          type: 'CHECKIN_REWARD_OBSERVATION',
          runId: task.runId,
          siteId: task.site.id,
          bodyText,
        });
      },
    };

    const result = await runTask(task, host);
    // 返回 null 表示页面即将跳转，由新页面的脚本接着跑
    if (result) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await sendMessage({ type: 'TASK_RESULT', runId: task.runId, result });
        if (response.ok || response.error === '任务已结束') break;
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  },
});
