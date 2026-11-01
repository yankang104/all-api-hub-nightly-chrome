import { sendMessage } from '@/lib/core/messaging';
import { isTencentCaptchaFrameUrl, SLIDER_FRAME_CONNECT_EVENT, SLIDER_FRAME_LIFETIME_MS } from '@/lib/core/slider-frame';
import type { SliderSolveResult } from '@/types/slider';
import { getActiveClickRunId, sleep } from '@/automation/shared/dom-utils';
import { findVisibleSliderFrame, isVisibleSliderFrame } from '@/automation/slider/slider-frame-dom';
import type { StepLog } from '@/automation/login/steps';

let activeFrameSolve: { runId: string; promise: Promise<SliderSolveResult> } | undefined;

/** 主页面只调度验证码助手；图片、把手和反馈都在各自的验证码文档内采集。 */
async function runSliderInFrame(log: StepLog, runId: string, outerDeadline?: number): Promise<SliderSolveResult> {
  const deadline = Math.min(outerDeadline ?? Infinity, Date.now() + SLIDER_FRAME_LIFETIME_MS);
  let lastError = '腾讯验证码内嵌页面未就绪';
  log.push('检测到腾讯验证码 iframe，正在连接本轮验证码助手');

  for (let connection = 0; connection < 3 && Date.now() < deadline; connection += 1) {
    if (getActiveClickRunId() !== runId) return { solved: false, error: '签到任务已停止' };
    let frame = findVisibleSliderFrame();
    if (!frame) {
      await sleep(Math.min(1_200, Math.max(0, deadline - Date.now())));
      if (getActiveClickRunId() !== runId) return { solved: false, error: '签到任务已停止' };
      frame = findVisibleSliderFrame();
      if (!frame) return { solved: false, dismissed: true };
    }
    const sessionId = `sf-${crypto.randomUUID()}`;
    const frameToken = `p-frame-${crypto.randomUUID()}`;
    const previousMarker = frame.getAttribute('data-aah-pointer-target');
    frame.setAttribute('data-aah-pointer-target', frameToken);
    let prepared = false;
    let frameUrl = '';
    let copiedSteps = 0;
    let disappearedAt: number | undefined;
    let reconnect = false;
    try {
      const loadingDeadline = Math.min(deadline, Date.now() + 8_000);
      while (Date.now() < loadingDeadline && getActiveClickRunId() === runId) {
        frameUrl = frame.src;
        if (isTencentCaptchaFrameUrl(frameUrl)) {
          const response = await sendMessage({
            type: 'SLIDER_FRAME_PREPARE', runId, sessionId, frameToken, frameUrl,
          });
          if (response.ok) { prepared = true; break; }
          lastError = response.error;
        }
        if (!frame.isConnected) { reconnect = true; break; }
        await sleep(350);
      }
      if (!prepared) {
        if (reconnect) continue;
        log.push(`滑块尚未开始拖动：${lastError}`);
        return { solved: false, error: lastError };
      }

      const connectedAt = Date.now();
      let connectedLogged = false;
      while (Date.now() < deadline && getActiveClickRunId() === runId) {
        const visibleFrame = findVisibleSliderFrame();
        if (visibleFrame && (visibleFrame !== frame || frame.src !== frameUrl)) {
          reconnect = true;
          break;
        }
        if (!isVisibleSliderFrame(frame) && !visibleFrame) disappearedAt ??= Date.now();
        else disappearedAt = undefined;

        const response = await sendMessage({ type: 'SLIDER_FRAME_STATUS', runId, sessionId });
        if (response.ok && response.feature?.sliderFrame) {
          const status = response.feature.sliderFrame;
          if (status.state !== 'connecting' && !connectedLogged) {
            log.push('已进入腾讯验证码内嵌页面，等待图片和真实滑块把手就绪');
            connectedLogged = true;
          }
          if (status.steps.length > copiedSteps) {
            for (const step of status.steps.slice(copiedSteps)) log.push(step);
            copiedSteps = status.steps.length;
          }
          if (status.result && (status.result.solved || status.result.dismissed || disappearedAt == null)) {
            return status.result;
          }
          if (status.state === 'connecting') {
            // postMessage 只携带一次性连接号，并且只发给选中的 contentWindow。
            // 后台据助手的真实 sender.frameId 绑定，避免同 URL 的隐藏预加载 iframe 抢占任务。
            frame.contentWindow?.postMessage({ type: SLIDER_FRAME_CONNECT_EVENT, sessionId }, new URL(frameUrl).origin);
            if (Date.now() - connectedAt > 7_000) {
              lastError = '验证码助手未能连接当前 iframe，请重新加载扩展后新开任务页';
              break;
            }
          }
        } else if (disappearedAt == null) {
          lastError = response.ok ? '后台没有返回验证码会话状态' : response.error;
          break;
        }
        if (disappearedAt != null && Date.now() - disappearedAt >= 1_200) {
          // 关闭也可能是取消，不能把它记录成验证码/签到成功。
          return { solved: false, dismissed: true };
        }
        await sleep(400);
      }
      if (!reconnect) {
        if (Date.now() >= deadline) lastError = '腾讯验证码求解达到本轮时限';
        else if (getActiveClickRunId() !== runId) lastError = '签到任务已停止';
        log.push(`腾讯验证码未完成：${lastError}`);
        return { solved: false, error: lastError };
      }
      log.push('验证码 iframe 已重建，正在重新连接新挑战');
    } finally {
      void sendMessage({ type: 'SLIDER_FRAME_CANCEL', runId, sessionId });
      if (frame.getAttribute('data-aah-pointer-target') === frameToken) {
        if (previousMarker == null) frame.removeAttribute('data-aah-pointer-target');
        else frame.setAttribute('data-aah-pointer-target', previousMarker);
      }
    }
  }
  return { solved: false, error: lastError };
}

/** iframe 自己维护会话锁，不再占用或修改主页面滑块求解器的状态。 */
export function solveSliderInFrame(log: StepLog, runId: string, outerDeadline?: number): Promise<SliderSolveResult> {
  if (activeFrameSolve?.runId === runId) return activeFrameSolve.promise;
  const promise = runSliderInFrame(log, runId, outerDeadline).finally(() => {
    if (activeFrameSolve?.promise === promise) activeFrameSolve = undefined;
  });
  activeFrameSolve = { runId, promise };
  return promise;
}
