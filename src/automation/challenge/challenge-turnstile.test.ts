import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/automation/shared/dom-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/automation/shared/dom-utils')>();
  return {
    ...actual,
    realClick: vi.fn(),
  };
});

import { realClick } from '@/automation/shared/dom-utils';
import { waitForChallenge } from '@/automation/challenge/challenge';

const BASE_TIME = new Date('2026-08-21T00:00:00+08:00');
const TURNSTILE_FIRST_CLICK_MS = 10_000;

interface WidgetFixture {
  response: HTMLInputElement | null;
  widget: HTMLElement;
}

function rect(height = 65): DOMRect {
  return {
    left: 100,
    top: 50,
    width: 382,
    height,
    right: 482,
    bottom: 50 + height,
    x: 100,
    y: 50,
    toJSON: () => ({}),
  } as DOMRect;
}

function installWidget(options: {
  managed?: boolean;
  responseField?: boolean;
  geometry?: () => DOMRect;
} = {}): WidgetFixture {
  const widgetMarkup = '<div class="turnstile-wrapper"></div>';
  const responseMarkup = options.responseField === false
    ? ''
    : '<input type="hidden" name="cf-turnstile-response" value="">';
  document.body.innerHTML = options.managed
    ? `<div id="challenge-stage">${widgetMarkup}${responseMarkup}</div><button type="submit" disabled>登录</button>`
    : `${widgetMarkup}${responseMarkup}<button type="submit" disabled>登录</button>`;

  const widget = document.querySelector<HTMLElement>('.turnstile-wrapper')!;
  vi.spyOn(widget, 'getClientRects').mockReturnValue([rect()] as unknown as DOMRectList);
  vi.spyOn(widget, 'getBoundingClientRect').mockImplementation(options.geometry ?? (() => rect()));
  const stage = document.querySelector<HTMLElement>('#challenge-stage');
  if (stage) {
    vi.spyOn(stage, 'getClientRects').mockReturnValue([rect()] as unknown as DOMRectList);
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue(rect());
  }
  return {
    widget,
    response: document.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]'),
  };
}

function runChallenge() {
  const log = { push: vi.fn() };
  const onNeedsUser = vi.fn(async () => {});
  const result = waitForChallenge(log, onNeedsUser, 60_000);
  return { log, onNeedsUser, result };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE_TIME);
  vi.stubGlobal('location', new URL('https://k40.shengqainbang.cn/login'));
  vi.mocked(realClick).mockReset();
});

afterEach(() => {
  document.body.innerHTML = '';
  document.title = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Turnstile 首次点击时序', () => {
  it('托管式 Cloudflare 中可见的 Turnstile 无需可读提示，直接复用可信点击流程', async () => {
    document.title = 'Just a moment...';
    const { response } = installWidget({ managed: true });
    vi.mocked(realClick).mockImplementation(async () => {
      response!.value = 'token-from-managed-widget';
      return 'trusted';
    });

    const { log, result } = runChallenge();
    setTimeout(() => {
      document.title = '烧饼';
    }, 250);

    await vi.advanceTimersByTimeAsync(TURNSTILE_FIRST_CLICK_MS);
    expect(realClick).toHaveBeenCalledOnce();
    expect(log.push).not.toHaveBeenCalledWith('检测到Cloudflare托管式安全检查，等待页面自然完成并跳转');

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toEqual({ detected: true, resolved: true, kind: 'Turnstile' });
  });

  it('识别 Cloudflare 生成的 closed-shadow 风格 widget 宿主并进入同一点击流程', async () => {
    document.title = 'Just a moment...';
    document.body.innerHTML = `
      <div id="challenge-stage">
        <div id="cf-chl-widget-managed"></div>
        <input type="hidden" name="cf-turnstile-response" id="cf-chl-widget-managed_response" value="">
      </div>
    `;
    const stage = document.querySelector<HTMLElement>('#challenge-stage')!;
    const widget = document.querySelector<HTMLElement>('#cf-chl-widget-managed')!;
    for (const element of [stage, widget]) {
      vi.spyOn(element, 'getClientRects').mockReturnValue([rect()] as unknown as DOMRectList);
      vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect());
    }
    const response = document.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]')!;
    vi.mocked(realClick).mockImplementation(async (target) => {
      expect(target).toBe(widget);
      response.value = 'token-from-closed-shadow-host';
      stage.remove();
      return 'trusted';
    });

    const { result } = runChallenge();
    await vi.advanceTimersByTimeAsync(TURNSTILE_FIRST_CLICK_MS);
    expect(realClick).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toEqual({ detected: true, resolved: true, kind: 'Turnstile' });
  });

  it('从无表单的空响应字段定位 closed-shadow 宿主并调用共享可信点击', async () => {
    document.title = 'Just a moment...';
    document.body.innerHTML = `
      <script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script>
      <main>
        <div data-test="closed-shadow-host">
          <input
            type="hidden"
            id="cf-chl-widget-random_response"
            name="cf-turnstile-response"
            value=""
          >
        </div>
      </main>
    `;
    const host = document.querySelector<HTMLElement>('[data-test="closed-shadow-host"]')!;
    const response = document.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]')!;
    vi.spyOn(host, 'getClientRects').mockReturnValue([rect()] as unknown as DOMRectList);
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(rect());
    vi.mocked(realClick).mockImplementation(async (target) => {
      expect(target).toBe(host);
      response.value = 'token-from-linux-sb-shape';
      return 'trusted';
    });

    expect(document.querySelector('form')).toBeNull();
    expect(document.querySelector('button[type="submit"]')).toBeNull();
    expect(document.querySelector('.cf-turnstile, .turnstile-wrapper, iframe')).toBeNull();

    const { log, onNeedsUser, result } = runChallenge();
    setTimeout(() => {
      document.title = '烧饼';
    }, 250);

    await vi.advanceTimersByTimeAsync(TURNSTILE_FIRST_CLICK_MS - 1);
    expect(realClick).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(realClick).toHaveBeenCalledOnce();
    expect(realClick).toHaveBeenCalledWith(
      host,
      expect.objectContaining({
        shadowTarget: true,
        insetLeftPx: 24,
      }),
    );
    expect(log.push).not.toHaveBeenCalledWith('检测到Cloudflare托管式安全检查，等待页面自然完成并跳转');

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toEqual({ detected: true, resolved: true, kind: 'Turnstile' });
    expect(onNeedsUser).not.toHaveBeenCalled();
  });

  it('标题先恢复但 closed-shadow 宿主稍后挂载时仍等待并进入共享点击流程', async () => {
    document.title = 'Just a moment...';
    document.body.innerHTML = `
      <script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script>
      <div data-test="delayed-host" style="display:none">
        <input type="hidden" id="cf-chl-widget-delayed_response" name="cf-turnstile-response" value="">
      </div>
    `;
    const host = document.querySelector<HTMLElement>('[data-test="delayed-host"]')!;
    const response = document.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]')!;
    vi.spyOn(host, 'getClientRects').mockReturnValue([rect()] as unknown as DOMRectList);
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(rect());
    vi.mocked(realClick).mockImplementation(async (target) => {
      expect(target).toBe(host);
      response.value = 'token-after-delayed-mount';
      return 'trusted';
    });

    const { result } = runChallenge();
    setTimeout(() => {
      document.title = '烧饼';
    }, 250);
    setTimeout(() => {
      host.style.display = 'block';
    }, 3_000);

    await vi.advanceTimersByTimeAsync(2_999);
    expect(realClick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_001);
    expect(realClick).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toEqual({ detected: true, resolved: true, kind: 'Turnstile' });
  });

  it('响应字段与 382×65 尺寸从首帧就稳定时，10 秒前仍绝不点击', async () => {
    const { response } = installWidget();
    vi.mocked(realClick).mockImplementation(async () => {
      response!.value = 'token-after-first-click';
      return 'trusted';
    });

    const { log, onNeedsUser, result } = runChallenge();
    await vi.advanceTimersByTimeAsync(TURNSTILE_FIRST_CLICK_MS - 1);
    expect(realClick).not.toHaveBeenCalled();
    expect(log.push).toHaveBeenCalledWith('验证控件布局已稳定（382×65，响应字段已挂载）');

    await vi.advanceTimersByTimeAsync(1);
    expect(realClick).toHaveBeenCalledOnce();
    expect(realClick).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        shadowTarget: true,
        insetLeftPx: 24,
        debugVisualize: false,
      }),
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toEqual({ detected: true, resolved: true, kind: 'Turnstile' });
    expect(realClick).toHaveBeenCalledOnce();
    expect(onNeedsUser).not.toHaveBeenCalled();
  });

  it('布局稳定耗时计入 10 秒总窗口，不会在布局稳定后再叠加等待', async () => {
    const startedAt = Date.now();
    const { response } = installWidget({
      geometry: () => {
        const elapsed = Date.now() - startedAt;
        if (elapsed < 1_800) return rect(70 + (Math.floor(elapsed / 300) % 2));
        return rect(65);
      },
    });
    const clickedAt: number[] = [];
    vi.mocked(realClick).mockImplementation(async () => {
      clickedAt.push(Date.now() - startedAt);
      response!.value = 'token-after-delayed-layout';
      return 'trusted';
    });

    const { result } = runChallenge();
    await vi.advanceTimersByTimeAsync(TURNSTILE_FIRST_CLICK_MS);
    expect(clickedAt).toEqual([TURNSTILE_FIRST_CLICK_MS]);

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toMatchObject({ resolved: true, kind: 'Turnstile' });
  });

  it('布局等待超时也不能绕过首次点击保护', async () => {
    const { widget } = installWidget({ responseField: false });
    vi.mocked(realClick).mockImplementation(async () => {
      widget.setAttribute('aria-checked', 'true');
      return 'trusted';
    });

    const { log, result } = runChallenge();
    await vi.advanceTimersByTimeAsync(TURNSTILE_FIRST_CLICK_MS - 1);
    expect(realClick).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(log.push).toHaveBeenCalledWith(expect.stringContaining('等待Turnstile布局稳定超时'));
    expect(realClick).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toMatchObject({ resolved: true, kind: 'Turnstile' });
  });

  it('保护窗口内已经出现令牌时取消点击', async () => {
    const { response } = installWidget();
    setTimeout(() => {
      response!.value = 'token-completed-without-click';
    }, 5_000);

    const { log, result } = runChallenge();
    await vi.advanceTimersByTimeAsync(11_000);
    await expect(result).resolves.toMatchObject({ resolved: true, kind: 'Turnstile' });
    expect(realClick).not.toHaveBeenCalled();
    expect(log.push).toHaveBeenCalledWith('Turnstile在首次点击保护期间已自行完成，无需点击');
  });

  it('首次点击无令牌时保留重试，并在第二次点击后完成', async () => {
    const startedAt = Date.now();
    const { response, widget } = installWidget();
    const clickedAt: number[] = [];
    vi.mocked(realClick).mockImplementation(async (target, options) => {
      expect(target).toBe(widget);
      expect(options).toEqual(expect.objectContaining({
        shadowTarget: true,
        insetLeftPx: 24,
      }));
      clickedAt.push(Date.now() - startedAt);
      if (clickedAt.length === 2) response!.value = 'token-after-retry';
      return 'trusted';
    });

    const { result } = runChallenge();
    await vi.advanceTimersByTimeAsync(39_999);
    expect(clickedAt).toEqual([TURNSTILE_FIRST_CLICK_MS]);

    await vi.advanceTimersByTimeAsync(1);
    expect(clickedAt).toEqual([TURNSTILE_FIRST_CLICK_MS, 40_000]);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toMatchObject({ resolved: true, kind: 'Turnstile' });
  });

  it('保护窗口内宿主重绘时按新宿主出现时间重新计算通用策略', async () => {
    const startedAt = Date.now();
    const { response, widget } = installWidget();
    const replacement = document.createElement('div');
    replacement.className = 'turnstile-wrapper';
    vi.spyOn(replacement, 'getClientRects').mockReturnValue([rect()] as unknown as DOMRectList);
    vi.spyOn(replacement, 'getBoundingClientRect').mockReturnValue(rect());
    setTimeout(() => widget.replaceWith(replacement), 9_000);

    const clickedAt: number[] = [];
    vi.mocked(realClick).mockImplementation(async (target) => {
      expect(target).toBe(replacement);
      clickedAt.push(Date.now() - startedAt);
      response!.value = 'token-after-replacement';
      return 'trusted';
    });

    const { result } = runChallenge();
    await vi.advanceTimersByTimeAsync(18_999);
    expect(realClick).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(clickedAt).toHaveLength(1);
    expect(clickedAt[0]).toBeGreaterThanOrEqual(19_000);
    expect(clickedAt[0]).toBeLessThanOrEqual(19_300);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toMatchObject({ resolved: true, kind: 'Turnstile' });
  });

  it('首次点击后宿主重绘时，第二次点击重新定位新宿主', async () => {
    const startedAt = Date.now();
    const { response, widget } = installWidget();
    const replacement = document.createElement('div');
    replacement.className = 'turnstile-wrapper';
    vi.spyOn(replacement, 'getClientRects').mockReturnValue([rect()] as unknown as DOMRectList);
    vi.spyOn(replacement, 'getBoundingClientRect').mockReturnValue(rect());
    setTimeout(() => widget.replaceWith(replacement), 20_000);

    const targets: HTMLElement[] = [];
    vi.mocked(realClick).mockImplementation(async (target) => {
      targets.push(target);
      if (targets.length === 2) response!.value = 'token-after-redraw-retry';
      return 'trusted';
    });

    const { result } = runChallenge();
    await vi.advanceTimersByTimeAsync(34_199);
    expect(targets).toEqual([widget]);

    await vi.advanceTimersByTimeAsync(10_500);
    expect(targets).toEqual([widget, replacement]);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toMatchObject({ resolved: true, kind: 'Turnstile' });
  });

  it('其他站点同样执行通用 10 秒最低成熟窗口', async () => {
    vi.stubGlobal('location', new URL('https://other.example/login'));
    const { response } = installWidget();
    const startedAt = Date.now();
    const clickedAt: number[] = [];
    vi.mocked(realClick).mockImplementation(async () => {
      clickedAt.push(Date.now() - startedAt);
      response!.value = 'token-on-generic-site';
      return 'trusted';
    });

    const { result } = runChallenge();
    await vi.advanceTimersByTimeAsync(TURNSTILE_FIRST_CLICK_MS - 1);
    expect(clickedAt).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(clickedAt).toEqual([TURNSTILE_FIRST_CLICK_MS]);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toMatchObject({ resolved: true, kind: 'Turnstile' });
  });
});
