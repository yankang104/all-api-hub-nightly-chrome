/**
 * 功能消息的汇总出口。
 *
 * 每个功能域一个文件、各自独占，避免多方同时改一个联合类型。
 * 新增功能域时在这里加一行 import + 一个联合成员。
 */

import type { BalanceMessage, BalanceResponse } from './balance';
import type { ClashConfigMessage, ClashConfigResponse } from './clash-config';
import type { ClashControllerMessage, ClashControllerResponse } from './clash-controller';
import type { ClaimMessage } from './claim';
import type { ControlMessage, ControlResponse } from './control';
import type { NotifyMessage, NotifyResponse } from './notify';
import type { ProbeMessage, ProbeResponse } from './probe';
import type { SessionMessage, SessionResponse } from './session';
import type { LiveMessage, LiveResponse } from './live';
import type { LearningMessage, LearningResponse } from './learning';
import type { PointerMessage, PointerResponse } from './pointer';
import type { SyncMessage, SyncResponse } from './sync';
import type { SliderCrackMessage, SliderCrackResult, SliderFrameMessage, SliderFrameStatus } from './slider';
import type { SubscriptionMessage, SubscriptionResponse } from './subscription';
import type { PortScanMessage, PortScanResponse } from './port-scan';
import type { SiteCookieMessage, SiteCookieResponse } from './site-cookies';

export type FeatureMessage =
  | BalanceMessage
  | ClashConfigMessage
  | ClashControllerMessage
  | ClaimMessage
  | ControlMessage
  | NotifyMessage
  | ProbeMessage
  | SessionMessage
  | LiveMessage
  | LearningMessage
  | PointerMessage
  | SliderCrackMessage
  | SliderFrameMessage
  | SubscriptionMessage
  | PortScanMessage
  | SiteCookieMessage
  | SyncMessage;

/** 功能消息的响应，统一挂在 MessageResponse.feature 槽位下 */
export type FeatureResponse = BalanceResponse
  & ClashConfigResponse
  & ClashControllerResponse
  & ControlResponse
  & NotifyResponse
  & ProbeResponse
  & SessionResponse
  & SubscriptionResponse
  & PortScanResponse
  & SiteCookieResponse
  & SyncResponse
  & LiveResponse
  & LearningResponse
  & PointerResponse
  & { slider?: SliderCrackResult; sliderFrame?: SliderFrameStatus };

export type { SliderCrackMessage, SliderCrackResult };
