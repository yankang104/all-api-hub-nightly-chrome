import { describe, expect, it } from 'vitest';
import type { CheckinWorkflowConfig } from '@/types';
import { validateCheckinWorkflow } from '@/lib/workflow/workflow-validation';

const site = { loginUrl: 'https://example.com/login' };

describe('validateCheckinWorkflow', () => {
  it('接受单次同源入口跳转和当前页动作', () => {
    const workflow: CheckinWorkflowConfig = {
      steps: [
        { type: 'navigate', url: '/rewards' },
        { type: 'click', selector: 'button.checkin', waitFor: '.dialog' },
        { type: 'fill', selector: 'textarea', value: '{{claimText}}' },
        { type: 'assert', text: ['领取成功'], result: 'success' },
      ],
    };

    expect(validateCheckinWorkflow(site, workflow)).toEqual([]);
  });

  it('拒绝跨站地址和第二个 navigate', () => {
    const errors = validateCheckinWorkflow(site, {
      steps: [
        { type: 'navigate', url: '/first' },
        { type: 'navigate', url: 'https://evil.example/second' },
      ],
    });

    expect(errors.some((error) => error.includes('只能把 navigate 放在第一步'))).toBe(true);
    expect(errors.some((error) => error.includes('必须与登录站点同源'))).toBe(true);
  });

  it('拒绝空工作流和超出上限的等待', () => {
    expect(validateCheckinWorkflow(site, { steps: [] })).toEqual(['工作流至少需要一个步骤']);
    const errors = validateCheckinWorkflow(site, {
      steps: [
        { type: 'wait', ms: 31_000 },
      ],
    });
    expect(errors.some((error) => error.includes('ms 超出范围'))).toBe(true);
  });

  it('接受条件分支但禁止分支内跳转', () => {
    const errors = validateCheckinWorkflow(site, {
      steps: [{
        type: 'if',
        condition: { type: 'selector', selector: '.already' },
        then: [{ type: 'assert', text: ['今日已签到'], result: 'already' }],
        else: [{ type: 'navigate', url: '/rewards' }],
      }],
    });
    expect(errors).toContain('工作流第 1.else.1只能把 navigate 放在第一步');
  });

  it('拒绝过深的条件嵌套', () => {
    const nested = (depth: number): any => depth === 0
      ? { type: 'assert', text: ['签到成功'], result: 'success' }
      : {
          type: 'if',
          condition: { type: 'text', words: ['继续'] },
          then: [nested(depth - 1)],
        };
    const errors = validateCheckinWorkflow(site, { steps: [nested(5)] });
    expect(errors.some((error) => error.includes('条件嵌套超过 4 层'))).toBe(true);
  });

  it('接受学习路线，且不再要求 steps 里有 navigate', () => {
    // 学习模式把导航放进 route，steps 里只有动作步骤 —— 这是正常形态
    const workflow: CheckinWorkflowConfig = {
      route: ['/dashboard', '/check-in'],
      steps: [
        { type: 'click', selector: 'button.checkin' },
        { type: 'assert', text: ['签到成功'], result: 'success' },
      ],
    };

    expect(validateCheckinWorkflow(site, workflow)).toEqual([]);
  });

  it('identityPath 必须位于学习路线中；与签到终点同址是合法形态', () => {
    const steps = [{ type: 'click', selector: '#checkin' }] as const;
    // 独立资料页：仍在签到终点之前 —— 经典形态
    expect(validateCheckinWorkflow(site, {
      route: ['/profile', '/daily'],
      identityPath: '/profile',
      steps: [...steps],
    })).toEqual([]);

    // 签到页本身就是资料页：与终点同址合法（引擎到页后先核对账号再签到）
    expect(validateCheckinWorkflow(site, {
      route: ['/daily'],
      identityPath: '/daily',
      steps: [...steps],
    })).toEqual([]);

    // 不在路线里的身份页仍然必须拒绝
    expect(validateCheckinWorkflow(site, {
      route: ['/dashboard', '/daily'],
      identityPath: '/profile',
      steps: [...steps],
    })).toContain('工作流身份核验路径必须位于学习路线中');
  });

  it('接受带 hash 的单页应用路线', () => {
    expect(validateCheckinWorkflow(site, {
      route: ['/#/home', '/#/checkin'],
      steps: [{ type: 'click', selector: '#checkin' }],
    })).toEqual([]);
  });

  it('拒绝跨站学习路线', () => {
    const errors = validateCheckinWorkflow(site, {
      route: ['/dashboard', 'https://evil.example/claim'],
      steps: [{ type: 'click', selector: '#checkin' }],
    });

    expect(errors).toContain('工作流学习路线第 2 项必须与登录站点同源');
  });

  it('拒绝非数组、空字符串项和超过 12 项的路线', () => {
    const steps = [{ type: 'click', selector: '#checkin' } as const];

    expect(validateCheckinWorkflow(site, {
      route: '/check-in' as unknown as string[],
      steps: [...steps],
    })).toEqual(['工作流学习路线必须是字符串数组']);

    expect(validateCheckinWorkflow(site, {
      route: ['/dashboard', '   '],
      steps: [...steps],
    })).toContain('工作流学习路线第 2 项必须是非空地址');

    const tooLong = Array.from({ length: 13 }, (_, index) => `/step-${index + 1}`);
    expect(validateCheckinWorkflow(site, { route: tooLong, steps: [...steps] }))
      .toEqual(['工作流学习路线最多 12 个页面']);
  });

  it('scroll 步骤要求 ratio 是 0..1 的有限数', () => {
    // 越界（>1 / <0 / NaN）一律拒绝：比例会被真实执行器换算成像素。
    expect(validateCheckinWorkflow(site, { steps: [{ type: 'scroll', ratio: 1.5 }] }))
      .toContain('工作流第 1的 ratio 必须是 0..1 的数字');
    expect(validateCheckinWorkflow(site, { steps: [{ type: 'scroll', ratio: -0.1 }] }))
      .toContain('工作流第 1的 ratio 必须是 0..1 的数字');
    expect(validateCheckinWorkflow(site, { steps: [{ type: 'scroll', ratio: Number.NaN }] }))
      .toContain('工作流第 1的 ratio 必须是 0..1 的数字');

    // 边界合法：0（顶部）与 1（底部）都允许。
    expect(validateCheckinWorkflow(site, { steps: [{ type: 'scroll', ratio: 0 }] })).toEqual([]);
    expect(validateCheckinWorkflow(site, { steps: [{ type: 'scroll', ratio: 1, container: '.feed', settleMs: 300 }] })).toEqual([]);
  });

  it('drag 步骤拒绝非法 anchor、缺失终点和跨站地址', () => {
    const errors = validateCheckinWorkflow(site, {
      steps: [{
        type: 'drag',
        selector: '.handle',
        anchor: { rx: 1.2, ry: 0.5 },
        toSelector: '',
      }],
    });
    expect(errors).toContain('工作流第 1的 anchor 必须是 rx/ry 均在 0..1 的坐标');
    expect(errors).toContain('工作流第 1缺少 toSelector');

    expect(validateCheckinWorkflow(site, {
      steps: [{
        type: 'drag',
        selector: '.handle',
        toSelector: 'https://evil.example/target',
      }],
    })).toContain('工作流第 1的 toSelector 不能包含跨站地址');

    // 合法拖拽通过；带非法 steps 时拒绝。
    expect(validateCheckinWorkflow(site, {
      steps: [{
        type: 'drag',
        selector: '.handle',
        anchor: { rx: 0, ry: 0.5 },
        toSelector: '.track-end',
        toAnchor: { rx: 1, ry: 0.5 },
        steps: 20,
      }],
    })).toEqual([]);
    expect(validateCheckinWorkflow(site, {
      steps: [{ type: 'drag', selector: '.handle', toSelector: '.track-end', steps: 500 }],
    })).toContain('工作流第 1的 steps 必须是 0-200 的整数');
  });

  it('click 的 key 只允许白名单内的非打印键', () => {
    // 可打印字符（含单个字母）会泄露击键内容，必须拒绝。
    for (const key of ['a', 'A', '1', 'Enter ', 'F1', 'Backspace']) {
      const errors = validateCheckinWorkflow(site, { steps: [{ type: 'click', selector: '#submit', key: key as never }] });
      expect(errors).toContain('工作流第 1的 key 只允许非打印功能键');
    }
    expect(validateCheckinWorkflow(site, {
      steps: [{ type: 'click', selector: '#submit', key: 'Enter', gesture: 'double', anchor: { rx: 0.9, ry: 0.5 } }],
    })).toEqual([]);
    expect(validateCheckinWorkflow(site, {
      steps: [{ type: 'click', selector: '#submit', gesture: 'triple' as never }],
    })).toContain('工作流第 1的 gesture 无效');
  });

  it('fill 的 control 与 choice/checked 必须配套', () => {
    // select 必须给 choice；序号只能配 select。
    expect(validateCheckinWorkflow(site, {
      steps: [{ type: 'fill', selector: 'select.part', value: '{{claimText}}', control: 'select' }],
    })).toContain('工作流第 1的 select 步骤必须指定 choice');
    expect(validateCheckinWorkflow(site, {
      steps: [{ type: 'fill', selector: 'select.part', value: '{{claimText}}', choice: 1 }],
    })).toContain('工作流第 1的 choice 只能用于 control 为 select 的填写步骤');

    // checkbox/radio 必须给 checked；checked 不能配文本框或下拉框。
    expect(validateCheckinWorkflow(site, {
      steps: [{ type: 'fill', selector: '.agree', value: '', control: 'checkbox' }],
    })).toContain('工作流第 1的 checkbox 步骤必须指定 checked');
    expect(validateCheckinWorkflow(site, {
      steps: [{ type: 'fill', selector: '.agree', value: '', control: 'text', checked: true }],
    })).toContain('工作流第 1的 checked 只能用于 control 为 checkbox/radio 的填写步骤');

    // 合法配套全部通过。
    expect(validateCheckinWorkflow(site, {
      steps: [
        { type: 'fill', selector: 'select.part', value: '{{claimText}}', control: 'select', choice: 2 },
        { type: 'fill', selector: '.agree', value: '', control: 'checkbox', checked: true },
        { type: 'fill', selector: '.plan', value: '', control: 'radio', checked: false },
      ],
    })).toEqual([]);
    // choice 负数 / checked 非布尔直接拒绝。
    expect(validateCheckinWorkflow(site, {
      steps: [{ type: 'fill', selector: 'select.part', value: '', control: 'select', choice: -1 }],
    })).toContain('工作流第 1的 choice 必须是 10000 以内的非负整数');
    expect(validateCheckinWorkflow(site, {
      steps: [{ type: 'fill', selector: '.agree', value: '', control: 'checkbox', checked: 1 as never }],
    })).toContain('工作流第 1的 checked 必须是布尔值');
  });

  it('scroll/drag 可以放进条件分支并被校验', () => {
    expect(validateCheckinWorkflow(site, {
      steps: [{
        type: 'if',
        condition: { type: 'selector', selector: '.lazy' },
        then: [
          { type: 'scroll', ratio: 1 },
          { type: 'drag', selector: '.handle', toSelector: '.track-end' },
        ],
      }],
    })).toEqual([]);
  });

  it('route 未定义时校验结论与老配置完全一致', () => {
    const legacy: CheckinWorkflowConfig = {
      steps: [
        { type: 'navigate', url: '/rewards' },
        { type: 'assert', text: ['领取成功'], result: 'success' },
      ],
    };

    expect(validateCheckinWorkflow(site, legacy)).toEqual([]);
    expect(validateCheckinWorkflow(site, { ...legacy, route: undefined })).toEqual([]);
    // 老配置里不该出现的 navigate 仍然照旧报错，没有被 route 支持顺手放宽
    expect(validateCheckinWorkflow(site, {
      steps: [{ type: 'click', selector: 'button' }, { type: 'navigate', url: '/rewards' }],
    })).toContain('工作流第 2只能把 navigate 放在第一步');
  });
});
