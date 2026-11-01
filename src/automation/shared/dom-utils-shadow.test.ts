import { beforeEach, describe, expect, it } from 'vitest';
import {
  queryAll,
  queryFirst,
  resolveAll,
  resolveElement,
  SelectorResolutionError,
  SHADOW_SELECTOR_COMBINATOR,
} from '@/automation/shared/dom-utils';

/**
 * Shadow DOM 穿透寻址。
 *
 * 用户诉求是「适配任何站点」，而现代组件库（Web Components、Lit、Salesforce
 * Lightning、多数支付控件）把按钮埋在影子根里 —— 普通 querySelector 永远
 * 看不到，学得到却回放不了。这里用 Playwright 惯例的 >>> 逐段穿透。
 *
 * 同时钉住一条硬约束：**闭合影子根必须显式报错**。静默返回空会把「扩展拿不到
 * 这个控件」伪装成「页面上没有这个控件」，用户按提示去改选择器永远是白费力气。
 */

function visible(el: HTMLElement): HTMLElement {
  // jsdom 没有布局引擎，getBoundingClientRect 恒为 0 —— 给 isVisible 一个可测的形状
  el.getBoundingClientRect = () => ({
    width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0,
    toJSON: () => ({}),
  }) as DOMRect;
  return el;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('Shadow DOM 穿透寻址', () => {
  it('用 >>> 穿透开放影子根找到按钮', () => {
    const host = document.createElement('div');
    host.id = 'widget';
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const button = document.createElement('button');
    button.id = 'claim';
    button.textContent = '立即签到';
    shadow.appendChild(button);

    const found = resolveElement<HTMLElement>('div#widget >>> button#claim');
    expect(found).toBe(button);
  });

  it('没有 >>> 时行为与老实现一致（只查当前作用域）', () => {
    const host = document.createElement('div');
    host.id = 'widget';
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const button = document.createElement('button');
    button.id = 'claim';
    shadow.appendChild(button);

    // 影子根里的元素不该被顶层选择器看到
    expect(resolveElement('button#claim')).toBeNull();
    // 但宿主自己是可见的
    expect(resolveElement('div#widget')).toBe(host);
  });

  it('可以连续穿透两层影子根', () => {
    const outer = document.createElement('div');
    outer.id = 'outer';
    document.body.appendChild(outer);
    const inner = document.createElement('section');
    inner.id = 'inner';
    outer.attachShadow({ mode: 'open' }).appendChild(inner);
    const target = document.createElement('a');
    target.id = 'deep';
    inner.attachShadow({ mode: 'open' }).appendChild(target);

    expect(resolveElement('div#outer >>> section#inner >>> a#deep')).toBe(target);
  });

  it('宿主不存在时按未命中处理，不是错误', () => {
    expect(resolveElement('div#nope >>> button')).toBeNull();
    expect(resolveAll('div#nope >>> button')).toEqual([]);
  });

  it('闭合影子根显式报错，绝不伪装成「没找到」', () => {
    const host = document.createElement('div');
    host.id = 'closed-host';
    document.body.appendChild(host);
    host.attachShadow({ mode: 'closed' }).appendChild(document.createElement('button'));

    expect(() => resolveElement('div#closed-host >>> button')).toThrow(SelectorResolutionError);
    expect(() => queryFirst('div#closed-host >>> button')).toThrow(SelectorResolutionError);
    expect(() => queryAll('div#closed-host >>> button')).toThrow(SelectorResolutionError);
  });

  it('>>> 后面的 text= 在影子根内部匹配文字', () => {
    const host = document.createElement('div');
    host.id = 'widget';
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const button = visible(document.createElement('button'));
    button.textContent = '领取奖励';
    shadow.appendChild(button);

    expect(queryFirst<HTMLElement>('div#widget >>> text=领取奖励')).toBe(button);
  });

  it('queryFirst/queryAll 支持 >>>，且可见性过滤照旧生效', () => {
    const host = document.createElement('div');
    host.id = 'widget';
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const hidden = document.createElement('button');
    hidden.className = 'item';
    hidden.style.display = 'none';
    const shown = visible(document.createElement('button'));
    shown.className = 'item';
    shadow.append(hidden, shown);

    expect(queryFirst<HTMLElement>('div#widget >>> button.item')).toBe(shown);
    const all = queryAll<HTMLElement>('div#widget >>> button.item');
    expect(all).toContain(shown);
    expect(all).not.toContain(hidden);
  });

  it('分隔符常量与 Playwright 惯例一致', () => {
    expect(SHADOW_SELECTOR_COMBINATOR).toBe('>>>');
  });

  it('非法选择器仍按未命中处理（不能因为新增 >>> 就改成抛错）', () => {
    expect(resolveElement('>>>')).toEqual(null);
    expect(() => resolveElement('p:has-text(签到)')).not.toThrow();
    expect(resolveElement('p:has-text(签到)')).toBeNull();
  });
});
