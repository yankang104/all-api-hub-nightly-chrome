import { describe, expect, it } from 'vitest';
import type { WorkflowLearningEvent } from '@/types/workflow';
import { buildLearningPreview } from '@/automation/learning/learning-preview';

type ClickEvent = Extract<WorkflowLearningEvent, { type: 'click' }>;
type FillEvent = Extract<WorkflowLearningEvent, { type: 'fill' }>;
type ScrollEvent = Extract<WorkflowLearningEvent, { type: 'scroll' }>;

function clickEvent(overrides: Partial<ClickEvent> = {}): ClickEvent {
  return {
    type: 'click',
    selector: 'text=立即签到',
    label: '立即签到',
    path: '/check-in',
    at: 101,
    ...overrides,
  };
}

function fillEvent(overrides: Partial<FillEvent> = {}): FillEvent {
  return {
    type: 'fill',
    selector: 'text=签到理由',
    label: '签到理由',
    path: '/check-in',
    hasValue: true,
    at: 102,
    ...overrides,
  };
}

function scrollEvent(overrides: Partial<ScrollEvent> = {}): ScrollEvent {
  return {
    type: 'scroll',
    path: '/check-in',
    ratio: 0.876,
    at: 103,
    ...overrides,
  };
}

describe('buildLearningPreview', () => {
  it('navigation 翻译为进入页面并保留 path 和 at', () => {
    const event: WorkflowLearningEvent = { type: 'navigation', path: '/dashboard#today', at: 1 };

    expect(buildLearningPreview([event])).toEqual([
      { kind: 'navigation', text: '进入页面 /dashboard#today', path: '/dashboard#today', at: 1 },
    ]);
  });

  it.each([
    ['单击', undefined, '点击「立即签到」'],
    ['双击', 'double', '双击「立即签到」'],
    ['右键', 'right', '右键「立即签到」'],
    ['长按', 'long-press', '长按「立即签到」'],
  ] as const)('click 的 %s前缀正确', (_name, gesture, expected) => {
    expect(buildLearningPreview([clickEvent({ gesture })])[0]?.text).toBe(expected);
  });

  it('click 带键盘键时使用按键前缀', () => {
    expect(buildLearningPreview([clickEvent({ key: 'Enter' })])[0]?.text).toBe('按 Enter 键「立即签到」');
  });

  it('click 带 anchor 时显示四舍五入后的落点百分比', () => {
    expect(buildLearningPreview([clickEvent({ anchor: { rx: 0.123, ry: 0.567 } })])[0]?.text)
      .toBe('点击「立即签到」（落点 12%, 57%）');
  });

  it('click 带 dragToSelector 时翻译为拖拽并归类为 drag', () => {
    expect(buildLearningPreview([
      clickEvent({ selector: 'text=奖励卡片', dragToSelector: 'text=空位' }),
    ])).toEqual([
      { kind: 'drag', text: '把「奖励卡片」拖到「空位」', path: '/check-in', at: 101 },
    ]);
  });

  it('drag 事件翻译为拖拽文案', () => {
    const event = {
      type: 'drag',
      selector: 'text=起点',
      toSelector: 'text=终点',
      path: '/board',
      at: 42,
    } as unknown as WorkflowLearningEvent;

    expect(buildLearningPreview([event])).toEqual([
      { kind: 'drag', text: '把「起点」拖到「终点」', path: '/board', at: 42 },
    ]);
  });

  it('select 翻译选中项序号且不暴露选项文字', () => {
    expect(buildLearningPreview([fillEvent({
      selector: 'text=套餐',
      control: 'select',
      choice: 2,
      hasValue: false,
    })])[0]?.text).toBe('在「套餐」选择第 3 项');
  });

  it('checkbox 和 radio 分别翻译勾选与取消勾选', () => {
    expect(buildLearningPreview([fillEvent({
      selector: 'text=同意协议',
      control: 'checkbox',
      checked: true,
    })])[0]?.text).toBe('勾选「同意协议」');

    expect(buildLearningPreview([fillEvent({
      selector: 'text=每日提醒',
      control: 'radio',
      checked: false,
    })])[0]?.text).toBe('取消勾选「每日提醒」');
  });

  it('缺省 fill 只说明填写内容', () => {
    expect(buildLearningPreview([fillEvent()])[0]?.text).toBe('在「签到理由」填写内容');
  });

  it('scroll 带容器时显示容器名和百分比', () => {
    expect(buildLearningPreview([scrollEvent({
      ratio: 0.333,
      container: 'text=任务列表',
    })])[0]?.text).toBe('滚动「任务列表」到 33%');
  });

  it('scroll 不带容器时显示页面滚动', () => {
    expect(buildLearningPreview([scrollEvent()])[0]?.text).toBe('滚动页面到 88%');
  });

  it('选择器标签剥掉 text= 前缀并截断到 20 个字符', () => {
    const longLabel = '一二三四五六七八九十'.repeat(3);
    expect(buildLearningPreview([clickEvent({ selector: `text=${longLabel}` })])[0]?.text)
      .toBe(`点击「${longLabel.slice(0, 20)}」`);
  });

  it('超过 20 条时只保留最近的 20 条并保持顺序', () => {
    const events = Array.from({ length: 25 }, (_, index): WorkflowLearningEvent => ({
      type: 'navigation',
      path: `/page-${index}`,
      at: index,
    }));

    const preview = buildLearningPreview(events);

    expect(preview).toHaveLength(20);
    expect(preview[0]?.path).toBe('/page-5');
    expect(preview[19]?.path).toBe('/page-24');
    expect(preview.map((item) => item.path)).toEqual(
      Array.from({ length: 20 }, (_, index) => `/page-${index + 5}`),
    );
  });

  it('fill 摘要不包含伪事件携带的输入值或密码', () => {
    const secretValue = 'SECRET-VALUE-7f31';
    const secretPassword = 'SECRET-PASSWORD-9a20';
    const event = {
      ...fillEvent({ fieldRole: 'password' }),
      value: secretValue,
      password: secretPassword,
      afterText: [secretValue, secretPassword],
    } as unknown as WorkflowLearningEvent;

    const preview = buildLearningPreview([event]);
    const serialized = JSON.stringify(preview);

    expect(preview[0]?.text).toBe('在「签到理由」填写内容');
    expect(serialized).not.toContain(secretValue);
    expect(serialized).not.toContain(secretPassword);
  });

  it('scroll 的 ratio 边界 0 和 1 分别显示 0% 与 100%', () => {
    expect(buildLearningPreview([scrollEvent({ ratio: 0 })])[0]?.text).toBe('滚动页面到 0%');
    expect(buildLearningPreview([scrollEvent({ ratio: 1 })])[0]?.text).toBe('滚动页面到 100%');
  });

  it('select 的 choice 为 0 时显示第 1 项且没有 off-by-one', () => {
    expect(buildLearningPreview([fillEvent({
      selector: 'text=套餐',
      control: 'select',
      choice: 0,
      hasValue: false,
    })])[0]?.text).toBe('在「套餐」选择第 1 项');
  });

  it('click 的长按加 anchor 同时体现长按与落点百分比', () => {
    expect(buildLearningPreview([clickEvent({
      gesture: 'long-press',
      anchor: { rx: 0.25, ry: 0.75 },
    })])[0]?.text).toBe('长按「立即签到」（落点 25%, 75%）');
  });

  it('空数组返回空结果且不抛错', () => {
    expect(buildLearningPreview([])).toEqual([]);
  });

  it('只有一条 navigation 时返回一条 navigation', () => {
    const event: WorkflowLearningEvent = { type: 'navigation', path: '/only', at: 7 };
    expect(buildLearningPreview([event])).toEqual([
      { kind: 'navigation', text: '进入页面 /only', path: '/only', at: 7 },
    ]);
  });
});