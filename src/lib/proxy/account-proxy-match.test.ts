import { describe, expect, it } from 'vitest';
import type { ProxyConfig } from '@/types';
import { appliedProxyMatchesAccount, egressMismatchReason } from '@/lib/proxy/account-proxy-match';

/**
 * 「这个已经开着的标签页能不能拿来读余额」的判据。
 *
 * 这条判断的失败方式非常隐蔽：不会报错，只会让余额从一个**错误的出口**
 * 读回来，站点侧表现为「余额 401/404，签到却正常」。所以每个分支都要锁住。
 */
const proxy = (over: Partial<ProxyConfig> = {}): ProxyConfig => ({
  id: 'p1',
  name: '节点A',
  scheme: 'http',
  host: '127.0.0.1',
  port: 7897,
  ...over,
});

describe('appliedProxyMatchesAccount', () => {
  it('账号需要代理且实际端点一致 → 可以复用现有标签页', () => {
    expect(appliedProxyMatchesAccount(proxy(), { host: '127.0.0.1', port: 7897 })).toBe(true);
  });

  it('账号需要代理但实际没在走任何扩展代理 → 不可复用（这就是「余额绕过账号代理」）', () => {
    expect(appliedProxyMatchesAccount(proxy(), null)).toBe(false);
  });

  it('端口不同 = 不同出口，不可复用', () => {
    expect(appliedProxyMatchesAccount(proxy(), { host: '127.0.0.1', port: 7898 })).toBe(false);
  });

  it('主机不同 = 不同出口（哪怕端口号相同）', () => {
    expect(appliedProxyMatchesAccount(proxy(), { host: '10.0.0.7', port: 7897 })).toBe(false);
  });

  it('本地 https 会被修正为 http，比对的是修正后的端点', () => {
    // effectiveProxyScheme 把回环上的 https 改成 http；这里比对的是 host/port，
    // 但端点必须来自 effectiveProxyConfig —— 传进来的地址要先规范化。
    expect(appliedProxyMatchesAccount(proxy({ scheme: 'https' }), { host: '127.0.0.1', port: 7897 }))
      .toBe(true);
  });

  it('主机名里的空白与方括号要规范化后再比', () => {
    expect(appliedProxyMatchesAccount(proxy({ host: ' [::1] ' }), { host: '::1', port: 7897 }))
      .toBe(true);
  });

  it('账号走直连、实际也没走代理 → 可以复用', () => {
    expect(appliedProxyMatchesAccount(undefined, null)).toBe(true);
  });

  it('账号走直连、但浏览器此刻正被别的代理接管 → 不可复用（别用别人的出口）', () => {
    expect(appliedProxyMatchesAccount(undefined, { host: '127.0.0.1', port: 7897 })).toBe(false);
  });
});

/**
 * 启动前出口核对的文案必须逐条锁住：这些字符串会直接出现在账号行上，
 * 用户据此判断该结束哪个任务、该不该重新选节点。含糊的措辞等于没有提示。
 */
describe('egressMismatchReason', () => {
  it('账号需要代理、实际端点一致 → 放行（null）', () => {
    expect(egressMismatchReason(proxy(), { host: '127.0.0.1', port: 7897 })).toBeNull();
  });

  it('账号需要代理、实际没走扩展代理 → 点名缺失的端点', () => {
    const reason = egressMismatchReason(proxy(), null);
    expect(reason).toContain('127.0.0.1:7897');
    expect(reason).toContain('没有生效');
  });

  it('账号需要代理、实际是另一条线路 → 两个端点都点名', () => {
    const reason = egressMismatchReason(proxy(), { host: '10.0.0.9', port: 7898 });
    expect(reason).toContain('10.0.0.9:7898');
    expect(reason).toContain('127.0.0.1:7897');
  });

  it('账号走直连、浏览器此刻没被接管 → 放行', () => {
    expect(egressMismatchReason(undefined, null)).toBeNull();
  });

  it('账号走直连、但浏览器正被别的代理接管 → 拒绝，并如实说明是在别人的出口上', () => {
    const reason = egressMismatchReason(undefined, { host: '127.0.0.1', port: 7897 });
    expect(reason).toContain('127.0.0.1:7897');
    expect(reason).toContain('直连');
  });

  it('本地 https 修正为 http 后仍按规范化端点比对 → 一致时放行', () => {
    expect(egressMismatchReason(proxy({ scheme: 'https' }), { host: '127.0.0.1', port: 7897 }))
      .toBeNull();
  });
});
