import { describe, expect, it } from 'vitest';
import { isBlockedFetchHost } from '@/lib/site/url-guard';

describe('isBlockedFetchHost', () => {
  it('放行正常公网主机', () => {
    // 公网订阅/探测地址必须照常可达，闸门只挡本机与内网
    expect(isBlockedFetchHost('sub.example.com')).toBe(false);
    expect(isBlockedFetchHost('8.8.8.8')).toBe(false);
    expect(isBlockedFetchHost('[2606:4700:4700::1111]')).toBe(false);
  });

  it('拦本机与内网的 IPv4 字面量', () => {
    for (const host of [
      '127.0.0.1', // 回环
      '0.0.0.0', // 本网络
      '169.254.169.254', // 链路本地 / 云元数据
      '10.1.2.3', // RFC1918
      '192.168.0.1', // RFC1918
      '172.16.5.5', // RFC1918
      '100.64.0.1', // CGNAT
    ]) {
      expect(isBlockedFetchHost(host)).toBe(true);
    }
  });

  it('172.16.0.0/12 只覆盖 16-31 段，其余 172.x 是公网', () => {
    expect(isBlockedFetchHost('172.15.0.1')).toBe(false);
    expect(isBlockedFetchHost('172.32.0.1')).toBe(false);
    expect(isBlockedFetchHost('172.31.255.255')).toBe(true);
  });

  it('拦本机与内网的 IPv6 字面量（含内嵌 IPv4）', () => {
    for (const host of [
      '[::1]', // 回环
      '[::]', // 未指定
      '[fc00::1]', // 唯一本地
      '[fd12::34]', // 唯一本地
      '[fe80::1]', // 链路本地
      '[::ffff:127.0.0.1]', // IPv4-mapped 回环
      '[::ffff:10.0.0.1]', // IPv4-mapped 内网
    ]) {
      expect(isBlockedFetchHost(host)).toBe(true);
    }
  });

  it('拦本机与内网域名，大小写与 FQDN 末尾点都归一化', () => {
    expect(isBlockedFetchHost('localhost')).toBe(true);
    expect(isBlockedFetchHost('LocalHost')).toBe(true);
    expect(isBlockedFetchHost('localhost.')).toBe(true);
    expect(isBlockedFetchHost('foo.local')).toBe(true);
    expect(isBlockedFetchHost('foo.local.')).toBe(true);
    expect(isBlockedFetchHost('svc.internal')).toBe(true);
  });

  it('内网关键词只按结尾标签判定，不误伤公网域名', () => {
    expect(isBlockedFetchHost('local.example.com')).toBe(false);
    expect(isBlockedFetchHost('internal.example.com')).toBe(false);
    expect(isBlockedFetchHost('mylocalhost.com')).toBe(false);
  });
});
