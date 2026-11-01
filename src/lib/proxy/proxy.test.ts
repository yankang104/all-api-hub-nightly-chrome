import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProxyConfig } from '@/types';
import { applyProxy, loopbackNavigationFailureMessage, readAppliedProxyEndpoint, testProxy } from '@/lib/proxy/proxy';

/**
 * 代理管理的两条用户可见行为：
 *
 * 1. 回读「当前生效的代理端点」—— 失败文案要靠它点名端口；
 * 2. 测活遇到本地端口无人监听时，说清是内核没跑，而不是笼统的「超时」或原始报错。
 */
function stubChrome(control: string, single: unknown) {
  vi.stubGlobal('chrome', {
    proxy: {
      settings: {
        get: vi.fn().mockResolvedValue({ levelOfControl: control, value: { rules: { singleProxy: single } } }),
        set: vi.fn().mockResolvedValue(undefined),
        clear: vi.fn().mockResolvedValue(undefined),
      },
    },
    webRequest: { onAuthRequired: { addListener: vi.fn() } },
  });
}

const loopbackProxy = (): ProxyConfig => ({
  id: 'p1',
  name: '节点A',
  scheme: 'http',
  host: '127.0.0.1',
  port: 7901,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * 认证监听器整个模块只绑定一次（`authListenerBound`），所以这里把首次绑定的
 * 回调留下，后续用例直接复用它 —— 那正是运行时的真实形态：设置换一条代理，
 * 应答的仍然是同一个监听器，变的是内存里的凭据。
 */
let boundAuthListener: ((details: { isProxy?: boolean }, callback: (response: unknown) => void) => unknown) | null = null;

function stubChromeWithAuth(): void {
  vi.stubGlobal('chrome', {
    proxy: {
      settings: {
        get: vi.fn().mockResolvedValue({
          levelOfControl: 'controlled_by_this_extension',
          value: { rules: { singleProxy: { scheme: 'http', host: '127.0.0.1', port: 7901 } } },
        }),
        set: vi.fn().mockResolvedValue(undefined),
        clear: vi.fn().mockResolvedValue(undefined),
      },
    },
    webRequest: {
      onAuthRequired: {
        addListener: vi.fn((listener: typeof boundAuthListener) => {
          boundAuthListener = listener;
        }),
      },
    },
  });
}

/** 触发一次认证挑战，返回监听了给出的应答。 */
function answerAuth(details: { isProxy?: boolean } = { isProxy: true }): unknown {
  const callback = vi.fn();
  boundAuthListener?.(details, callback);
  return callback.mock.calls[0]?.[0];
}

describe('applyProxy 的代理认证登记', () => {
  it('只填用户名也要应答挑战（旧实现要求用户名与密码同时非空，必吃 407）', async () => {
    stubChromeWithAuth();
    await applyProxy({ ...loopbackProxy(), username: 'only-user' });

    expect(answerAuth()).toEqual({ authCredentials: { username: 'only-user', password: '' } });
  });

  it('只填密码也要应答挑战', async () => {
    stubChromeWithAuth();
    await applyProxy({ ...loopbackProxy(), password: 'only-pass' });

    expect(answerAuth()).toEqual({ authCredentials: { username: '', password: 'only-pass' } });
  });

  it('完全没有凭据时不代答，交回浏览器默认处理', async () => {
    stubChromeWithAuth();
    await applyProxy(loopbackProxy());

    expect(answerAuth()).toEqual({});
  });

  it('站点自身的 401 不代答（只应答代理挑战）', async () => {
    stubChromeWithAuth();
    await applyProxy({ ...loopbackProxy(), username: 'u', password: 'p' });

    expect(answerAuth({ isProxy: false })).toEqual({});
  });
});

describe('readAppliedProxyEndpoint', () => {
  it('本扩展接管时返回实际端点', async () => {
    stubChrome('controlled_by_this_extension', { scheme: 'http', host: '127.0.0.1', port: 7901 });
    expect(await readAppliedProxyEndpoint()).toEqual({ host: '127.0.0.1', port: 7901 });
  });

  it('不是本扩展接管时返回 null（另有专门报错，不编造端口）', async () => {
    stubChrome('controlled_by_other_extensions', { scheme: 'http', host: '127.0.0.1', port: 7901 });
    expect(await readAppliedProxyEndpoint()).toBeNull();
  });

  it('读不到设置或缺字段时返回 null', async () => {
    stubChrome('controlled_by_this_extension', undefined);
    expect(await readAppliedProxyEndpoint()).toBeNull();

    vi.stubGlobal('chrome', {
      proxy: { settings: { get: vi.fn().mockRejectedValue(new Error('boom')) } },
    });
    expect(await readAppliedProxyEndpoint()).toBeNull();
  });
});

describe('testProxy 对本地端口的失败说法', () => {
  /*
   * 这条原先是「不能凭 Failed to fetch 断言内核没在跑」。现在内部会再做一次
   * TCP 级探测(probeListener)才下结论 —— 有证据时可以直说,没有证据时不能。
   * 所以拆成两条:探测确认无人监听 → 可以说;探测不出来 → 保持原来的克制说法。
   */
  it('探测确认端口无人监听时，明确指出脚本/配置这一层的问题', async () => {
    stubChrome('controlled_by_this_extension', { scheme: 'http', host: '127.0.0.1', port: 7901 });
    // 出站请求与端口探测都失败 → 有 TCP 级证据表明没有任何程序在监听
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const result = await testProxy(loopbackProxy());

    expect(result.ok).toBe(false);
    expect(result.message).toContain('127.0.0.1:7901');
    expect(result.message).toContain('没有任何程序在监听');
    expect(result.listenerProbe).toBe('closed');
  });

    it('端口探测超时时按「无法判断」处理（不能编造在监听或未监听）', async () => {
    stubChrome('controlled_by_this_extension', { scheme: 'http', host: '127.0.0.1', port: 7901 });
    /*
     * 模拟探测超时:探测请求挂起,直到 probeListener 自己的 2.5s abort 触发。
     * fetch 超时有两种成因，浏览器侧无法区分：TCP 已握上只是没回 HTTP（端口在
     * 监听），或 SYN 被防火墙 DROP（端口没回任何东西）。所以超时只能算「未知」，
     * 绝不能编造成 listening 把用户引去排查错误方向。
     */
    vi.stubGlobal('fetch', vi.fn((input: unknown, init?: { signal?: AbortSignal }) => {
      const url = String(input);
      if (url.startsWith('http://127.0.0.1:')) {
        return new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        });
      }
      return Promise.reject(new TypeError('Failed to fetch'));
    }));

    vi.useFakeTimers();
    const promise = testProxy(loopbackProxy());
    await vi.advanceTimersByTimeAsync(400);   // 代理设置生效的等待
    await vi.advanceTimersByTimeAsync(3_000); // 触发探测超时
    const result = await promise;
    vi.useRealTimers();

    expect(result.ok).toBe(false);
    expect(result.listenerProbe).toBeUndefined();
    expect(result.message).toContain('无法判断');
    expect(result.message).not.toContain('在监听');
    expect(result.message).not.toContain('没有任何程序在监听');
  });

  it('代理设置被其它扩展占用时保留真实原因，不能包装成内核没启动', async () => {
    stubChrome('controlled_by_other_extensions', { scheme: 'http', host: '127.0.0.1', port: 7901 });
    vi.stubGlobal('fetch', vi.fn());
    const result = await testProxy(loopbackProxy());
    expect(result.ok).toBe(false);
    expect(result.message).toContain('其他扩展占用');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('内核在跑但节点不通时，按状态码如实报（不能推给「没监听」）', async () => {
    stubChrome('controlled_by_this_extension', { scheme: 'http', host: '127.0.0.1', port: 7901 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 502 }));

    const result = await testProxy(loopbackProxy());

    expect(result.ok).toBe(false);
    expect(result.message).toBe('返回 502');
  });

  it('远程代理连不上时保留原始报错，不套本地端口文案', async () => {
    const remote: ProxyConfig = { id: 'p2', name: '远端', scheme: 'socks5', host: '203.0.113.9', port: 1080 };
    stubChrome('controlled_by_this_extension', { scheme: 'socks5', host: '203.0.113.9', port: 1080 });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const result = await testProxy(remote);

    expect(result.ok).toBe(false);
    expect(result.message).toBe('Failed to fetch');
  });
});

/**
 * 导航停在空白页时的最终说法。
 *
 * 只写「仍未离开空白页」是误诊：本地内核没启动时浏览器就是这个形状。但也不能
 * 反过来乱说 —— 远程代理或直连时编造一个本机端口，用户会去启动一个根本没用的
 * 内核，而真正的问题（节点挂了 / 域名解析失败）被盖掉。
 */
describe('loopbackNavigationFailureMessage 死端口代理的诊断', () => {
  it('回环端点：换成点名端口的说法（用户据此知道要启动内核）', () => {
    const message = loopbackNavigationFailureMessage('标签页导航后仍未离开空白页', { host: '127.0.0.1', port: 7897 });
    expect(message).toContain('127.0.0.1:7897');
    expect(message).toContain('没有程序在监听');
    expect(message).toContain('Clash Verge');
    expect(message).not.toContain('仍未离开空白页');
  });

  it('localhost / ::1 同样按回环处理', () => {
    expect(loopbackNavigationFailureMessage('fallback', { host: 'localhost', port: 7897 })).toContain('没有程序在监听');
    expect(loopbackNavigationFailureMessage('fallback', { host: '::1', port: 7897 })).toContain('没有程序在监听');
  });

  it('远程代理端点：保留原文，绝不编造本机端口', () => {
    const message = loopbackNavigationFailureMessage('标签页导航后仍未离开空白页', { host: '203.0.113.9', port: 1080 });
    expect(message).toBe('标签页导航后仍未离开空白页');
    expect(message).not.toContain('没有程序在监听');
  });

  it('读不到端点（直连/不是本扩展接管）：同样保留原文', () => {
    expect(loopbackNavigationFailureMessage('原文', null)).toBe('原文');
    expect(loopbackNavigationFailureMessage('原文', undefined)).toBe('原文');
  });
});
