import { describe, expect, it } from 'vitest';
import {
  buildClashControllerAuthHeaders,
  normalizeClashControllerAddress,
  parseClashProxyNames,
} from '@/lib/clash/clash-controller';

describe('normalizeClashControllerAddress', () => {
  it('accepts a port, host:port, and full controller URL', () => {
    expect(normalizeClashControllerAddress(9097)).toBe('http://127.0.0.1:9097');
    expect(normalizeClashControllerAddress('127.0.0.1:9097')).toBe('http://127.0.0.1:9097');
    expect(normalizeClashControllerAddress(' http://localhost:9097/ ')).toBe('http://localhost:9097');
  });

  it('returns an origin so API paths can be appended safely', () => {
    expect(normalizeClashControllerAddress('https://127.0.0.1:9443/ui/?token=x#top'))
      .toBe('https://127.0.0.1:9443');
  });

  it('rejects empty, malformed, remote, credential-bearing, and non-HTTP addresses', () => {
    expect(normalizeClashControllerAddress('')).toBeNull();
    expect(normalizeClashControllerAddress('http://')).toBeNull();
    expect(normalizeClashControllerAddress('https://controller.example:9443')).toBeNull();
    expect(normalizeClashControllerAddress('http://user:pass@127.0.0.1:9097')).toBeNull();
    expect(normalizeClashControllerAddress('unix:///tmp/mihomo.sock')).toBeNull();
  });
});

describe('buildClashControllerAuthHeaders', () => {
  it('sends the configured secret as a Bearer token', () => {
    expect(buildClashControllerAuthHeaders('  actual-secret  ')).toEqual({
      Authorization: 'Bearer actual-secret',
    });
  });

  it('omits Authorization when no secret is configured', () => {
    expect(buildClashControllerAuthHeaders('')).toEqual({});
    expect(buildClashControllerAuthHeaders('   ')).toEqual({});
    expect(buildClashControllerAuthHeaders(undefined)).toEqual({});
  });

  it('does not create a header from a value containing a line break', () => {
    expect(buildClashControllerAuthHeaders('secret\r\nX-Injected: yes')).toEqual({});
  });
});

describe('parseClashProxyNames', () => {
  it('keeps protocol nodes and filters built-ins and policy groups', () => {
    expect(parseClashProxyNames({
      proxies: {
        DIRECT: { name: 'DIRECT', type: 'Direct', history: [] },
        REJECT: { name: 'REJECT', type: 'Reject', history: [] },
        GLOBAL: { name: 'GLOBAL', type: 'Selector', all: ['DIRECT', 'JP-01'] },
        Auto: { name: 'Auto', type: 'URLTest', all: ['JP-01', 'US-01'] },
        Balance: { name: 'Balance', type: 'LoadBalance', all: ['JP-01', 'US-01'] },
        'JP-01': { name: 'JP-01', type: 'VLESS', history: [] },
        'US-01': { name: 'US-01', type: 'Trojan', history: [] },
        'HK-01': { name: 'HK-01', type: 'Shadowsocks', history: [] },
      },
    })).toEqual(['JP-01', 'US-01', 'HK-01']);
  });

  it('uses the map key as a fallback name and retains unknown future leaf types', () => {
    expect(parseClashProxyNames({
      proxies: {
        'Future node': { type: 'Next-Generation-Protocol', history: [] },
        'Known group': { type: 'BrandNewGroup', all: ['Future node'] },
      },
    })).toEqual(['Future node']);
  });

  it('deduplicates names, trims them, and ignores malformed entries', () => {
    expect(parseClashProxyNames({
      proxies: {
        first: { name: ' Node A ', type: 'VMess' },
        second: { name: 'Node A', type: 'VLESS' },
        broken: null,
        primitive: 'Node B',
      },
    })).toEqual(['Node A']);
  });

  it('filters reserved built-ins if an older response omits their type', () => {
    expect(parseClashProxyNames({
      proxies: {
        DIRECT: { name: 'DIRECT' },
        REJECT: {},
        node: { name: 'node' },
      },
    })).toEqual(['node']);
  });

  it('returns an empty list for non-controller response shapes', () => {
    expect(parseClashProxyNames(null)).toEqual([]);
    expect(parseClashProxyNames([])).toEqual([]);
    expect(parseClashProxyNames({ proxies: [] })).toEqual([]);
  });
});
