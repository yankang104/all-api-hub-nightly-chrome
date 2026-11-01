import { describe, expect, it } from 'vitest';
import { navigationErrorMessage } from '@/lib/proxy/navigation-error';

/**
 * 「代理连接失败」这句文案是用户唯一的线索来源。
 *
 * 用户实测踩过的坑：订阅节点全都不通、界面没有任何红字 —— 其实是本机没跑内核，
 * 所有 `127.0.0.1:<端口>` 都没人监听。说清端口，用户才知道该启动什么。
 *
 * 关键约束：点名端口**不能替代**站点侧的说法。同一个错误码在回环代理后面有两
 * 种成因（内核没起来 / 站点真的有问题），两者都要能看见，否则只是把一种误导换成
 * 另一种。下面的用例逐条锁住这个「补充而非替代」的形状。
 */
describe('导航错误码 → 人话', () => {
  it('回环端点连不上时点名端口，并说清要装/启动什么', () => {
    const message = navigationErrorMessage('net::ERR_PROXY_CONNECTION_FAILED', true, {
      host: '127.0.0.1',
      port: 7901,
    });

    expect(message).toContain('127.0.0.1:7901');
    expect(message).toContain('没有程序在监听');
    expect(message).toContain('内核');
  });

  it('localhost / ::1 同样按回环处理', () => {
    expect(navigationErrorMessage('net::ERR_PROXY_CONNECTION_FAILED', true, { host: 'localhost', port: 7897 }))
      .toContain('localhost:7897');
    expect(navigationErrorMessage('net::ERR_TUNNEL_CONNECTION_FAILED', true, { host: '::1', port: 7897 }))
      .toContain('::1:7897');
  });

  it('远程代理走原来的文案，不编造端口', () => {
    const message = navigationErrorMessage('net::ERR_PROXY_CONNECTION_FAILED', true, {
      host: '203.0.113.9',
      port: 1080,
    });

    expect(message).toBe('扩展代理连接失败，请检查代理协议、主机和端口');
  });

  it('没有端点信息（不是本扩展接管）时保持原样', () => {
    expect(navigationErrorMessage('net::ERR_PROXY_CONNECTION_FAILED', true, null))
      .toBe('扩展代理连接失败，请检查代理协议、主机和端口');
    expect(navigationErrorMessage('net::ERR_PROXY_CONNECTION_FAILED', false))
      .toBe('Chrome/系统网络连接失败，请检查代理协议、主机和端口');
  });

  /**
   * 这一组就是本次修的真实缺陷：经本地代理时，浏览器把同一个「链路后面断了」
   * 报成域名解析失败 / 超时 / 连接重置 —— 它分不清是内核没起来还是站点有问题。
   * 旧文案一律只说站点，用户会去改站点地址、换 DNS，而该做的是启动内核。
   */
  describe('经本地回环代理时，站点侧文案必须补上「本地内核端口」这一支', () => {
    const endpoint = { host: '127.0.0.1', port: 7897 };

    it('ERR_NAME_NOT_RESOLVED 补充点名本地端口，且不是替代', () => {
      const message = navigationErrorMessage('net::ERR_NAME_NOT_RESOLVED', true, endpoint);

      expect(message).toContain('127.0.0.1:7897');
      expect(message).toContain('没有程序在监听');
      // 站点侧说法仍在，只是不再是唯一结论
      expect(message).toContain('站点域名解析失败');
      expect(message).not.toBe('站点域名解析失败');
    });

    it('ERR_CONNECTION_TIMED_OUT / ERR_TIMED_OUT 同样补充', () => {
      for (const code of ['net::ERR_CONNECTION_TIMED_OUT', 'net::ERR_TIMED_OUT']) {
        const message = navigationErrorMessage(code, true, endpoint);
        expect(message).toContain('127.0.0.1:7897');
        expect(message).toContain('没有程序在监听');
        expect(message).toContain('连接站点超时');
      }
    });

    it('ERR_CONNECTION_RESET 同样补充（内核还在、节点已断也会报这个码）', () => {
      const message = navigationErrorMessage('net::ERR_CONNECTION_RESET', true, endpoint);

      expect(message).toContain('127.0.0.1:7897');
      expect(message).toContain('没有程序在监听');
      expect(message).toContain('连接被站点或代理重置');
    });

    it('直连时不编造内核端口（域名解析失败就是域名解析失败）', () => {
      expect(navigationErrorMessage('net::ERR_NAME_NOT_RESOLVED', false, endpoint))
        .toBe('站点域名解析失败');
      expect(navigationErrorMessage('net::ERR_CONNECTION_TIMED_OUT', false, endpoint))
        .toBe('连接站点超时');
      expect(navigationErrorMessage('net::ERR_CONNECTION_RESET', false, endpoint))
        .toBe('连接被站点或代理重置');
      expect(navigationErrorMessage('net::ERR_NAME_NOT_RESOLVED', true, null))
        .toBe('站点域名解析失败');
    });

    it('远程代理端点上不影射本机端口', () => {
      const remote = { host: '203.0.113.9', port: 1080 };
      expect(navigationErrorMessage('net::ERR_NAME_NOT_RESOLVED', true, remote))
        .toBe('站点域名解析失败');
      expect(navigationErrorMessage('net::ERR_CONNECTION_TIMED_OUT', true, remote))
        .toBe('连接站点超时');
      expect(navigationErrorMessage('net::ERR_CONNECTION_RESET', true, remote))
        .toBe('连接被站点或代理重置');
    });
  });

  it('与代理无关的错误码不受影响', () => {
    const endpoint = { host: '127.0.0.1', port: 7901 };
    expect(navigationErrorMessage('net::ERR_CERT_DATE_INVALID', true, endpoint)).toContain('TLS 证书错误');
    expect(navigationErrorMessage('net::ERR_ABORTED', true, endpoint)).toBeNull();
    expect(navigationErrorMessage('net::ERR_SOMETHING_NEW', true, endpoint)).toBeNull();
  });

  it('拒绝连接也算「端口后面没人」', () => {
    expect(navigationErrorMessage('net::ERR_CONNECTION_REFUSED', true, { host: '127.0.0.1', port: 7902 }))
      .toContain('7902');
  });
});
