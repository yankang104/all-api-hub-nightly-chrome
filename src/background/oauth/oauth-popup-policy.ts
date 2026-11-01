import type { LoginTask } from '@/types';
import type { OAuthProvider } from '@/background/oauth/oauth-popups';
import {
  isGithubAuthUrl,
  isGithubCredentialStage,
  isGoogleAuthUrl,
  isLikelyOAuthUrl,
  isSameSiteUrl,
} from '@/lib/site/site-security';

/** 第三方登录方式都可能通过 window.open 打开认证弹窗。 */
export function isExternalOAuthTask(task: LoginTask): boolean {
  const method = task.effectiveLoginMethod ?? task.site.loginMethod;
  // `auto` 站点可能在运行时识别出 OAuth 按钮；引擎会在点击前把阶段写成
  // verify-oauth/relogin-verify。不能只看 loginMethod，否则自定义站点的
  // LinuxDO、企业 SSO 等弹窗会漏掉代理接管。
  return isGithubCredentialStage(task.stage)
    && (
      method === 'oauth'
      || method === 'github'
      || method === 'passkey'
      || task.stage === 'verify-oauth'
      || task.stage === 'relogin-verify'
    );
}

/** provider 只用于日志和持久化排查，不参与凭据派发。 */
export function oauthProviderForTask(task: LoginTask, url?: string): OAuthProvider {
  if (isGithubAuthUrl(url)) return 'github';
  if (isGoogleAuthUrl(url)) return 'google';
  if (task.effectiveLoginMethod === 'github') return 'github';
  return 'generic';
}

/** about:blank 是 window.open 的初始页；真正导航后才视作 OAuth 弹窗。 */
export function isOAuthPopupUrl(task: LoginTask, url: string): boolean {
  if (!url || /^about:blank(?:$|#)/i.test(url) || /^chrome-(?:extension|error):/i.test(url)) return false;
  if (isGithubAuthUrl(url) || isGoogleAuthUrl(url) || isLikelyOAuthUrl(task.site, url)) return true;

  // 在 verify-oauth/relogin-verify 阶段，任意 HTTP(S) 外部窗口都视为本次
  // 授权链的一部分。未知提供商常用完全自定义的路径，单靠 URL 关键词会漏掉；
  // 这里仍只转移浏览器级代理，不会向该窗口派发凭据。
  const authStage = task.stage === 'verify-oauth' || task.stage === 'relogin-verify';
  if (!authStage) return false;
  try {
    const parsed = new URL(url, task.site.loginUrl);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * opener 关闭或 Worker 恢复时，确认登记的子标签确实属于授权链。
 *
 * Chrome 的 OAuth `window.open` 常先产生 about:blank，再异步导航。这个空白页
 * 只在已经落盘 verify-oauth/relogin-verify 阶段时接受；其它普通新窗口必须
 * 命中实际授权 URL，避免 OAuth 站点里的帮助链接错误接管账号代理。
 */
export function isOAuthPopupCandidate(task: LoginTask, tab: chrome.tabs.Tab): boolean {
  const candidate = tab.pendingUrl ?? tab.url ?? '';
  if (/^about:blank(?:$|#)/i.test(candidate)) {
    return task.stage === 'verify-oauth' || task.stage === 'relogin-verify';
  }
  return isOAuthPopupUrl(task, candidate);
}

/**
 * GitHub OAuth 的任务是否应该搬到这个弹窗继续执行。
 *
 * 第二次授权时 GitHub 已有会话，`github.com` 可能只停留几十毫秒，Chrome 的
 * onUpdated 来不及观察到它；下一个可见 URL 已经是本站 `/oauth/github` 回调。
 * 只认已落盘的验证阶段 + 本站同源的明确 OAuth URL，避免普通控制台弹窗接管
 * 任务，也避免把账号任务搬到未知外域。
 */
export function isGithubTaskContinuation(task: LoginTask, url: string): boolean {
  if (task.effectiveLoginMethod !== 'github') return false;
  if (isGithubAuthUrl(url)) return true;
  if (task.stage !== 'verify-oauth' && task.stage !== 'relogin-verify') return false;
  if (/^about:blank(?:$|#)/i.test(url)) return true;
  return isSameSiteUrl(task.site, url) && isLikelyOAuthUrl(task.site, url);
}
