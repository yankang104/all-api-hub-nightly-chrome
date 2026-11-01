import type { MessageResponse } from '@/lib/core/messaging';
import type { SliderFrameMessage, SliderFrameStatus } from '@/lib/messages/slider';
import { isTaskUrlAllowed } from '@/lib/site/site-security';
import { isTencentCaptchaFrameUrl, SLIDER_FRAME_LIFETIME_MS, SLIDER_FRAME_STOP_EVENT } from '@/lib/core/slider-frame';
import type { SliderChallengeInfo, SliderCrackOptions, SliderCrackResult } from '@/types/slider';
import { taskState } from '@/background/checkin/task-state';
import { crackSliderChallenge } from '@/background/slider/slider-crack';
import { frameScale, mapFrameRect, readFrameEmbedding, type FramePointerTarget } from '@/background/slider/frame-target';

interface FrameSession extends SliderFrameStatus {
  sessionId: string;
  tabId: number;
  runId: string;
  deadline: number;
  frameToken: string;
  frameUrl: string;
  candidateIds: number[];
  frameId?: number;
  documentId?: string;
}

const sessions = new Map<string, FrameSession>();

function closeSession(session: FrameSession): void {
  sessions.delete(session.sessionId);
  if (session.frameId != null) {
    void chrome.tabs.sendMessage(session.tabId, {
      type: SLIDER_FRAME_STOP_EVENT, sessionId: session.sessionId,
    }, { frameId: session.frameId }).catch(() => undefined);
  }
}

function pruneSessions(): void {
  for (const session of sessions.values()) {
    if (Date.now() >= session.deadline) closeSession(session);
  }
}

function statusOf(session: FrameSession): SliderFrameStatus {
  return { state: session.state, steps: session.steps, result: session.result };
}

export async function handleSliderFrameMessage(
  msg: SliderFrameMessage,
  sender: chrome.runtime.MessageSender,
): Promise<MessageResponse> {
  pruneSessions();
  const tabId = sender.tab?.id;
  if (tabId == null || !/^sf-[a-z0-9-]{8,80}$/i.test(msg.sessionId)) {
    return { ok: false, error: '验证码内嵌页会话无效' };
  }
  const task = await taskState.get(tabId);
  if (!task) return { ok: false, error: '签到任务已结束' };

  if (msg.type === 'SLIDER_FRAME_PREPARE') {
    if (sender.frameId !== 0 || msg.runId !== task.runId || !isTaskUrlAllowed(task, sender.url)) {
      return { ok: false, error: '只有当前签到任务的主页面可以启用验证码助手' };
    }
    if (!isTencentCaptchaFrameUrl(msg.frameUrl) || !/^p-[a-z0-9-]{8,80}$/i.test(msg.frameToken)) {
      return { ok: false, error: '不是受支持的腾讯验证码 iframe' };
    }
    await readFrameEmbedding(tabId, msg, [{ x: 0.5, y: 0.5 }]);
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    const candidateIds = (frames ?? []).filter((frame) => (
      frame.parentFrameId === 0 && frame.url === msg.frameUrl && !frame.errorOccurred
    )).map((frame) => frame.frameId).slice(0, 6);
    if (!candidateIds.length) return { ok: false, error: '腾讯验证码内嵌页面仍在加载' };
    for (const existing of sessions.values()) {
      if (existing.tabId === tabId) closeSession(existing);
    }
    const session: FrameSession = { ...msg, tabId, candidateIds, state: 'connecting', steps: [],
      deadline: Date.now() + SLIDER_FRAME_LIFETIME_MS };
    sessions.set(msg.sessionId, session);
    try {
      // 按需注入隔离世界助手；不把自动登录脚本或账号凭据注入第三方页面。
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: candidateIds }, files: ['slider-frame.js'],
      });
    } catch (error) {
      closeSession(session);
      return { ok: false, error: `无法载入验证码助手：${error instanceof Error ? error.message : String(error)}` };
    }
    return { ok: true, feature: { sliderFrame: statusOf(session) } };
  }

  const session = sessions.get(msg.sessionId);
  if (!session || session.tabId !== tabId || session.runId !== task.runId) {
    return { ok: false, error: '验证码内嵌页会话已结束' };
  }
  if (msg.type === 'SLIDER_FRAME_STATUS' || msg.type === 'SLIDER_FRAME_CANCEL') {
    if (sender.frameId !== 0 || msg.runId !== session.runId || !isTaskUrlAllowed(task, sender.url)) {
      return { ok: false, error: '验证码会话不属于当前主页面' };
    }
    const status = statusOf(session);
    if (msg.type === 'SLIDER_FRAME_CANCEL') closeSession(session);
    return { ok: true, feature: { sliderFrame: status } };
  }
  if (sender.frameId == null || sender.frameId === 0 || sender.url !== session.frameUrl
    || !session.candidateIds.includes(sender.frameId)) {
    return { ok: false, error: '验证码助手来自未经授权的内嵌页面' };
  }
  if (msg.type === 'SLIDER_FRAME_CONNECT') {
    if (session.state !== 'connecting') return { ok: false, error: '验证码助手已连接' };
    await readFrameEmbedding(tabId, session, [{ x: 0.5, y: 0.5 }]);
    session.frameId = sender.frameId;
    session.documentId = sender.documentId;
    session.state = 'running';
    return { ok: true, feature: { sliderFrame: {
      ...statusOf(session), runId: session.runId, deadline: session.deadline - 3_000,
    } } };
  }
  if (sender.frameId !== session.frameId || (session.documentId && sender.documentId !== session.documentId)) {
    return { ok: false, error: '验证码文档已重建，旧助手不能继续操作' };
  }
  if (msg.steps.length >= session.steps.length) {
    session.steps = msg.steps.slice(0, 160).map((line) => String(line).slice(0, 1_500));
  }
  if (msg.result) {
    session.result = msg.result;
    session.state = 'finished';
  }
  return { ok: true };
}

export async function authorizedSliderFrameTarget(
  sender: chrome.runtime.MessageSender,
  runId: string,
  sessionId: string | undefined,
): Promise<FramePointerTarget> {
  pruneSessions();
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session || session.state !== 'running' || session.runId !== runId
    || session.tabId !== sender.tab?.id || session.frameId !== sender.frameId
    || sender.url !== session.frameUrl
    || (session.documentId && sender.documentId !== session.documentId)) {
    throw new Error('验证码 iframe 没有有效的本轮拖动会话');
  }
  const task = await taskState.get(session.tabId);
  const tab = await chrome.tabs.get(session.tabId);
  if (!task || task.runId !== runId || !isTaskUrlAllowed(task, tab.url)) {
    closeSession(session);
    throw new Error('签到任务已结束或主页面已离开本站');
  }
  return { frameId: session.frameId!, documentId: session.documentId,
    frameToken: session.frameToken, frameUrl: session.frameUrl };
}

export async function crackSliderFrameChallenge(
  tabId: number,
  info: SliderChallengeInfo,
  options: SliderCrackOptions,
  target: FramePointerTarget,
): Promise<SliderCrackResult> {
  const background = info.backgroundRect;
  const handle = info.handleRect;
  const embedding = await readFrameEmbedding(tabId, target, [
    { x: (handle.x + handle.width / 2) / info.viewportWidth, y: (handle.y + handle.height / 2) / info.viewportHeight },
    ...[0.1, 0.5, 0.9].map((position) => ({
      x: (background.x + background.width * position) / info.viewportWidth,
      y: (background.y + background.height * position) / info.viewportHeight,
    })),
  ]);
  const scale = frameScale(embedding, info.viewportWidth, info.viewportHeight);
  const map = (rect: typeof handle) => mapFrameRect(rect, embedding, scale);
  const mapped: SliderChallengeInfo = { ...info, panelRect: map(info.panelRect),
    backgroundRect: map(background), trackRect: map(info.trackRect), handleRect: map(handle),
    pieceRect: info.pieceRect ? map(info.pieceRect) : undefined,
    viewportWidth: embedding.viewportWidth, viewportHeight: embedding.viewportHeight,
    devicePixelRatio: embedding.devicePixelRatio,
    challengeKey: `${target.frameToken}:${info.challengeKey}` };
  const result = await crackSliderChallenge(tabId, mapped, {
    ...options, correctionPx: options.correctionPx == null ? undefined : options.correctionPx * scale.x,
    excludedGapX: options.excludedGapX?.map((x) => x * scale.x),
  }, Math.random, target);
  // 求解器留在 iframe 的局部 CSS 坐标系，反馈微调、失败位置排除不能混用屏幕像素。
  return { ...result, gapX: result.gapX == null ? undefined : result.gapX / scale.x,
    distance: result.distance == null ? undefined : result.distance / scale.x,
    diagnostics: result.diagnostics ? { ...result.diagnostics,
      imageScaleX: result.diagnostics.imageScaleX * scale.x,
      imageScaleY: result.diagnostics.imageScaleY * scale.y,
      handleRange: result.diagnostics.handleRange / scale.x,
      pieceRange: result.diagnostics.pieceRange / scale.x,
      correctionPx: result.diagnostics.correctionPx / scale.x,
      probeDistance: result.diagnostics.probeDistance == null ? undefined : result.diagnostics.probeDistance / scale.x,
    } : undefined };
}
