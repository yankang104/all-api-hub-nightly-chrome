import React, { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProxyConfig } from '@/types';

/** motion 在 jsdom 里没有布局引擎，渲染成普通标签即可；这里只关心交互与文案。 */
vi.mock('motion/react', async () => {
  const ReactModule = await vi.importActual<typeof import('react')>('react');
  const element = (tag: string) => ({
    children,
    initial: _initial,
    animate: _animate,
    exit: _exit,
    transition: _transition,
    whileHover: _whileHover,
    whileTap: _whileTap,
    ...props
  }: Record<string, unknown>) => ReactModule.createElement(tag, props, children as ReactNode);
  return {
    AnimatePresence: ({ children }: { children?: ReactNode }) => ReactModule.createElement(ReactModule.Fragment, null, children),
    motion: { button: element('button'), div: element('div'), span: element('span') },
  };
});

import { SubscriptionImport } from './SubscriptionImport';

/**
 * 「导入机场订阅失败」这个缺陷的回归。
 *
 * 机场订阅的默认形态就是 vmess/vless/trojan/hysteria2 —— `chrome.proxy` 一个都
 * 用不了。旧实现在这里 throw，界面红字写「没有可导入的 HTTP/SOCKS 出口」，
 * 用户看到的结论是「这个功能坏了」，但节点名其实已经被解析出来了，只差
 * 让内核为每个节点开一个本地端口这一步。
 *
 * 所以这里锁两条契约：
 *  1. 全是不可用协议时**不报错**，要给出下一步（生成 listeners 配置）；
 *  2. 节点名照样交给上层，否则生成面板永远拿不到数据、用户无路可走。
 */
const importSpy = (result = { added: 1, skipped: 0, upgraded: 0 }) =>
  vi.fn(async (_inputs: Omit<ProxyConfig, 'id'>[]) => result);

/** 与真实订阅同形：hysteria2 占多数，另有一条浏览器能直连的出口 */
const HY2_SUBSCRIPTION = [
  'proxies:',
  '  - { name: 新加坡01aws, server: sg01.example.com, port: 8443, type: hysteria2, password: x }',
  '  - { name: 美国02aws, server: us02.example.com, port: 8443, type: hysteria2, password: x }',
  '  - { name: 日本03aws, server: jp03.example.com, port: 8443, type: vmess, uuid: x }',
].join('\n');

describe('订阅导入：全是浏览器不能直连的协议时', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  /** 走「直接粘贴代理地址」这条路，避开真实的网络拉取 */
  async function paste(text: string, props: Partial<{
    onNamesParsed: (names: string[]) => void;
  }> = {}) {
    const onImport = importSpy();
    const onNamesParsed = props.onNamesParsed ?? vi.fn();
    await act(async () => root.render(createElement(SubscriptionImport, { onImport, onNamesParsed })));

    const area = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      // React 受控组件：走原生 setter 再派发 input，否则 state 不收更新
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(area, text);
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const button = [...container.querySelectorAll('button')]
      .find((item) => item.textContent?.includes('导入这些地址'))!;
    await act(async () => button.click());
    return { onImport, onNamesParsed };
  }

  it('不报错，改为说明下一步并把节点名交给生成面板', async () => {
    const { onImport, onNamesParsed } = await paste(HY2_SUBSCRIPTION);

    // 不写任何没有出口的假条目
    expect(onImport).not.toHaveBeenCalled();
    // 关键：节点名必须传上去，否则 listeners 面板无数据可生成
    expect(onNamesParsed).toHaveBeenCalledWith(['新加坡01aws', '美国02aws', '日本03aws']);
    // 不再出现「没有可导入的出口」这种把正常形态说成故障的结论
    expect(container.textContent).not.toContain('没有可导入的 HTTP/SOCKS 出口');
    expect(container.textContent).toContain('都是浏览器不能直连的协议');
    expect(container.textContent).toContain('hysteria2');
    expect(container.textContent).toContain('vmess');
    // 给出可执行的下一步，而不只是描述现状
    expect(container.textContent).toContain('加入代理池');
    expect(container.textContent).toContain('7897');
    // 这是提示不是错误：不能染成失败态的红色
    expect(container.querySelector('.bg-rose-50')).toBeNull();
  });

  it('内容里确实没有代理地址时才报错', async () => {
    const { onImport, onNamesParsed } = await paste('这不是代理地址');

    expect(onImport).not.toHaveBeenCalled();
    expect(onNamesParsed).toHaveBeenCalledWith([]);
    expect(container.textContent).toContain('没有识别到代理地址');
    expect(container.querySelector('.bg-rose-50')).not.toBeNull();
  });

  it('有真实 HTTP/SOCKS 出口时照常入池', async () => {
    const { onImport, onNamesParsed } = await paste([
      '127.0.0.1:7897',
      'socks5://127.0.0.1:7891',
    ].join('\n'));

    expect(onNamesParsed).toHaveBeenCalledWith([]);
    expect(onImport).toHaveBeenCalledTimes(1);
    const inputs = onImport.mock.calls[0]![0];
    expect(inputs.map((item) => `${item.scheme}://${item.host}:${item.port}`)).toEqual([
      'http://127.0.0.1:7897',
      'socks5://127.0.0.1:7891',
    ]);
    // 本机端口标成 Clash Verge 来源，后面的「按端口补名称」才认得出这些条目
    expect(inputs.every((item) => item.sourceLabel === 'Clash Verge')).toBe(true);
    expect(container.textContent).toContain('新增 1 个');
  });
});
