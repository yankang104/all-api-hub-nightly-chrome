import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClashControllerImport } from './ClashControllerImport';
import { sendMessage } from '@/lib/core/messaging';
import { CLASH_CONTROLLER_NOT_FOUND } from '@/lib/clash/clash-controller-detect';

vi.mock('@/lib/core/messaging', () => ({ sendMessage: vi.fn() }));
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('chrome', { storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(sendMessage).mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === text)!;
async function fill(label: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('Clash 控制接口与代理出口分开呈现', () => {
  it('未找到 HTTP 接口给出命名管道说明，并提供无需控制器的当前出口入口', async () => {
    const onUseLocalProxy = vi.fn();
    vi.mocked(sendMessage).mockResolvedValue({ ok: true, feature: { clashControllerDetect: { status: 'not-found', message: CLASH_CONTROLLER_NOT_FOUND } } });
    await act(async () => root.render(createElement(ClashControllerImport, { onUseLocalProxy })));
    await act(async () => button('检测 HTTP 控制接口').click());
    expect(container.querySelector('[role="status"]')?.textContent).toContain('这不代表');
    expect(container.textContent).toContain('命名管道');
    expect(container.textContent).not.toContain('没有检测到正在运行的本机内核');
    await act(async () => button('只使用当前 Clash 出口（无需控制接口）').click());
    expect(onUseLocalProxy).toHaveBeenCalledOnce();
  });

  it('检测传入当前地址/密钥，认证错误不被说成内核未启动', async () => {
    vi.mocked(sendMessage).mockResolvedValue({ ok: true, feature: { clashControllerDetect: {
      status: 'found', address: 'http://127.0.0.1:19097', needsSecret: true, verified: false,
    } } });
    await act(async () => root.render(createElement(ClashControllerImport)));
    await fill('Clash controller 地址', '127.0.0.1:19097');
    await fill('Clash controller 密钥', 'sentinel-secret');
    await act(async () => button('检测 HTTP 控制接口').click());
    expect(sendMessage).toHaveBeenCalledWith({ type: 'DETECT_CLASH_CONTROLLER', controller: { address: '127.0.0.1:19097', secret: 'sentinel-secret' } });
    expect(container.querySelector('[role="status"]')?.textContent).toContain('要求认证');
    expect(container.querySelector<HTMLInputElement>('[aria-label="Clash controller 密钥"]')?.value).toBe('sentinel-secret');
  });

  it('自动发现不同端口后清掉旧密钥，不带给另一个服务', async () => {
    vi.mocked(sendMessage).mockResolvedValue({ ok: true, feature: { clashControllerDetect: {
      status: 'found', address: 'http://127.0.0.1:9090', needsSecret: false, verified: true,
    } } });
    await act(async () => root.render(createElement(ClashControllerImport)));
    await fill('Clash controller 密钥', 'sentinel-secret');
    await act(async () => button('检测 HTTP 控制接口').click());
    expect(container.querySelector<HTMLInputElement>('[aria-label="Clash controller 密钥"]')?.value).toBe('');
    expect(container.querySelector('[role="status"]')?.textContent).toContain('已验证');
  });
});
