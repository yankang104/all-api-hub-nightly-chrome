import { describe, expect, it } from 'vitest';
import { detectPageAvailabilityIssue } from '@/automation/shared/page-health';

/**
 * 页面级故障识别。
 *
 * 这段判断决定用户拿到的是「站点/地区问题」还是「选择器问题」—— 判错时
 * 用户会拿着答案去修一个根本不存在的问题（把 403 当选择器失效去重学流程）。
 */
function page(title: string, body: string): void {
  document.title = title;
  document.body.innerHTML = `<pre>${body}</pre>`;
}

describe('detectPageAvailabilityIssue', () => {
  it('识别 403 Forbidden，且标记为不可重试', () => {
    page('403 Forbidden', 'Access denied. This site is not available in your region.');
    const issue = detectPageAvailabilityIssue();
    expect(issue?.message).toContain('403');
    expect(issue?.retryable).toBe(false);
  });

  it('识别地区限制的拒绝页（Cloudflare block 形态）', () => {
    page('Access denied', 'Error 1020\nAccess denied\nThis website is using a security service. You are not available in your region.');
    const issue = detectPageAvailabilityIssue();
    expect(issue?.message).toContain('访问被拒绝');
    expect(issue?.retryable).toBe(false);
  });

  it('不会把普通页面里出现的「地区」误判成封锁', () => {
    page('控制台', '支持地区：中国大陆、香港。当前账号余额充足。');
    expect(detectPageAvailabilityIssue()).toBeNull();
  });

  it('5xx 仍按站点不可用处理，且可重试', () => {
    page('502 Bad Gateway', 'nginx');
    const issue = detectPageAvailabilityIssue();
    expect(issue?.message).toContain('502');
    expect(issue?.retryable).toBe(true);
  });

  it('Cloudflare Host Error 判为站点不可用', () => {
    page('Example', 'Error 1016\nCloudflare\nOrigin DNS error\nHost Error');
    expect(detectPageAvailabilityIssue()?.retryable).toBe(true);
  });

  it('正常登录页不误报', () => {
    page('登录', '用户名 密码 登录');
    expect(detectPageAvailabilityIssue()).toBeNull();
  });
});
