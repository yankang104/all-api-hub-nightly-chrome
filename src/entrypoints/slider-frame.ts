import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { sendMessage } from '@/lib/core/messaging';
import { isTencentCaptchaFrameUrl, SLIDER_FRAME_CONNECT_EVENT, SLIDER_FRAME_STOP_EVENT } from '@/lib/core/slider-frame';
import { setActiveClickRunId } from '@/automation/shared/dom-utils';
import { trySolveSliderInCurrentFrame } from '@/automation/slider/slider-solve';
import type { StepLog } from '@/automation/login/steps';
import type { SliderSolveResult } from '@/types/slider';

export default defineUnlistedScript(() => {
  if (window === window.top || !isTencentCaptchaFrameUrl(location.href)) return;
  const isolated = globalThis as typeof globalThis & { __aahSliderFrameInstalled?: boolean };
  if (isolated.__aahSliderFrameInstalled) return;
  isolated.__aahSliderFrameInstalled = true;
  let activeSession: string | undefined;

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id === chrome.runtime.id && message?.type === SLIDER_FRAME_STOP_EVENT
      && message.sessionId === activeSession) setActiveClickRunId(null);
  });

  window.addEventListener('message', (event: MessageEvent) => {
    const message = event.data;
    if (event.source !== window.parent || message?.type !== SLIDER_FRAME_CONNECT_EVENT
      || typeof message.sessionId !== 'string' || !/^sf-[a-z0-9-]{8,80}$/i.test(message.sessionId)
      || activeSession) return;
    const sessionId = message.sessionId;
    activeSession = sessionId;
    void (async () => {
      const response = await sendMessage({ type: 'SLIDER_FRAME_CONNECT', sessionId });
      if (!response.ok) return;
      const job = response.feature?.sliderFrame;
      if (!job?.runId || !job.deadline) return;
      setActiveClickRunId(job.runId, 'trusted', sessionId);
      const steps: string[] = [];
      const log: StepLog = {
        push(message) {
          steps.push(message);
          void sendMessage({ type: 'SLIDER_FRAME_REPORT', sessionId, steps: [...steps] });
        },
      };
      let result: SliderSolveResult;
      try {
        result = await trySolveSliderInCurrentFrame(log, sessionId, job.deadline);
      } catch (error) {
        result = { solved: false, error: error instanceof Error ? error.message : String(error) };
      }
      await sendMessage({ type: 'SLIDER_FRAME_REPORT', sessionId, steps: [...steps], result });
    })().finally(() => {
      if (activeSession === sessionId) {
        setActiveClickRunId(null);
        activeSession = undefined;
      }
    }).catch(() => undefined);
  });
});
