/**
 * 滑块验证码破解消息。
 *
 * Content script 检测到滑块挑战后，收集 DOM 信息（视口 CSS 坐标），
 * 发给 background 执行 CDP 截图 + 模板匹配 + 拖拽。
 */

import type {
  SliderChallengeInfo,
  SliderCrackOptions,
  SliderCrackResult,
  SliderSolveResult,
} from '@/types/slider';

/** Content script → Background：请求破解滑块 */
export interface SliderCrackMessage {
  type: 'SLIDER_CRACK';
  runId: string;
  slider: SliderChallengeInfo;
  options: SliderCrackOptions;
  /** 仅限后台为本次可见验证码 iframe 创建的短期会话。 */
  frameSessionId?: string;
}

export type SliderFrameMessage =
  | { type: 'SLIDER_FRAME_PREPARE'; runId: string; sessionId: string; frameToken: string; frameUrl: string }
  | { type: 'SLIDER_FRAME_CONNECT'; sessionId: string }
  | { type: 'SLIDER_FRAME_REPORT'; sessionId: string; steps: string[]; result?: SliderSolveResult }
  | { type: 'SLIDER_FRAME_STATUS'; runId: string; sessionId: string }
  | { type: 'SLIDER_FRAME_CANCEL'; runId: string; sessionId: string };

export interface SliderFrameStatus {
  state: 'connecting' | 'running' | 'finished';
  steps: string[];
  result?: SliderSolveResult;
  /** 只在 CONNECT 响应中给验证码助手，不包含账号、密码或站点配置。 */
  runId?: string;
  deadline?: number;
}

export type { SliderChallengeInfo, SliderCrackOptions, SliderCrackResult };
