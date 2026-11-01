import { describe, expect, it } from 'vitest';
import type { CheckinWorkflowStep } from '@/types';
import {
  describeWorkflowStep,
  removeRoutePage,
  withWorkflowRoute,
  withWorkflowSteps,
} from '@/lib/workflow/workflow-form';

const steps: CheckinWorkflowStep[] = [{ type: 'click', selector: 'button.checkin' }];

describe('withWorkflowSteps', () => {
  it('编辑步骤时保留学习到的 route', () => {
    // 用户手动签到学会的路线不能因为改一个步骤就丢掉 ——
    // 丢了之后自动签到再也找不到签到页，而界面上完全看不出来。
    const result = withWorkflowSteps({ steps: [], route: ['/dashboard', '/check-in'] }, steps);

    expect(result.steps).toEqual(steps);
    expect(result.route).toEqual(['/dashboard', '/check-in']);
  });

  it('工作流原本不存在时只产出 steps', () => {
    expect(withWorkflowSteps(undefined, steps)).toEqual({ steps });
  });

  it('不修改传入的 workflow 对象', () => {
    const current = { steps: [], route: ['/check-in'] };
    withWorkflowSteps(current, steps);

    expect(current.steps).toEqual([]);
    expect(current.route).toEqual(['/check-in']);
  });
});

describe('withWorkflowRoute 与 removeRoutePage', () => {
  it('改路线时保留已配置的步骤', () => {
    // 用户学会之后手调过步骤，改路线不能把步骤清掉。
    const result = withWorkflowRoute({ steps, route: ['/a', '/b'] }, ['/a']);

    expect(result.steps).toEqual(steps);
    expect(result.route).toEqual(['/a']);
  });

  it('路线删空时整个字段消失，而不是留空数组', () => {
    // 留空数组会被校验器判成「至少需要一个步骤」式的失败；字段消失才能退回
    // 「只执行 steps」的老行为。
    expect(withWorkflowRoute({ steps, route: ['/a'] }, [])).toEqual({ steps });
    expect(withWorkflowRoute({ steps }, undefined)).toEqual({ steps });
  });

  it('删掉学错的一页后其余顺序不变', () => {
    // 「学习录进了不该走的一页」是真实故障，用户必须能删。
    expect(removeRoutePage(['/sign-in', '/dashboard', '/check-in'], 0))
      .toEqual(['/dashboard', '/check-in']);
    expect(removeRoutePage(['/dashboard', '/check-in'], 1)).toEqual(['/dashboard']);
  });
});

describe('describeWorkflowStep', () => {
  it('把 text= 选择器还原成用户看得懂的可见文字', () => {
    // 学习模式产出的是 text=个人资料 这类选择器，直接显示等于没解释。
    expect(describeWorkflowStep({ type: 'click', selector: 'text=个人资料' })).toBe('点击「个人资料」');
  });

  it('点击、填写、跳转都有明确说法，不出现类型名', () => {
    expect(describeWorkflowStep({ type: 'click', selector: '#checkin' })).toBe('点击「#checkin」');
    expect(describeWorkflowStep({ type: 'fill', selector: 'textarea', value: '{{claimText}}' }))
      .toBe('在「textarea」填写内容');
    expect(describeWorkflowStep({ type: 'navigate', url: '/check-in' })).toBe('进入页面 /check-in');
  });

  it('区分成功与已完成的断言，用户能看懂结论', () => {
    expect(describeWorkflowStep({ type: 'assert', text: ['签到成功'], result: 'success' }))
      .toBe('确认签到成功：文字 签到成功');
    expect(describeWorkflowStep({ type: 'assert', text: ['今日已签到'], result: 'already' }))
      .toBe('确认今日已完成：文字 今日已签到');
  });

  it('条件分支说明成立条件', () => {
    expect(describeWorkflowStep({
      type: 'if',
      condition: { type: 'text', words: ['今日已签到'] },
      then: [{ type: 'assert', text: ['今日已签到'], result: 'already' }],
    })).toBe('如果 页面出现 今日已签到');
  });
});
