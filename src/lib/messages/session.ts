/**
 * 登录会话抓取的消息域。
 *
 * 抓取要读**页面**的 localStorage，只有页面上下文能做到。所以分两步：
 * 管理页发起 → background 用 chrome.scripting 往目标标签页注入一段读取函数。
 */

import type { CapturedAuthSession } from '@/types';

export type SessionMessage =
  /**
   * 管理页 → background：把某个已登录的标签页里的会话抓给这个账号。
   *
   * 用户先手动登录（GitHub OAuth、过人机验证都行），再点按钮。
   * 之后签到直接注入这份会话，不再走登录流程。
   */
  | { type: 'CAPTURE_SESSION'; accountId: string; tabId?: number }
  /** content → background：签到时换到了新令牌，写回账号 */
  | {
      type: 'SESSION_REFRESHED';
      runId: string;
      accountId: string;
      accessToken: string;
      refreshToken: string;
      tokenExpiresAt: number;
    };

export interface SessionResponse {
  /** 抓取结果，抓到什么一并回给界面显示 */
  captured?: {
    session: CapturedAuthSession;
    identity: { userId?: string; username?: string; email?: string };
    /** 抓取方式说明，如「已从 localStorage 读到 auth_token 与 refresh_token」 */
    evidence: string;
  };
}
