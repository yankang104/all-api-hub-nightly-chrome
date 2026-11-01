/**
 * 学习结果展示层纯函数的回归测试。
 *
 * 这里锁三件事：空输入安静降级、超长流程只显示最近 N 条并如实说「还有几条」、
 * 以及渲染结构里**只有** text / kind 允许成为动态内容。
 */
import { describe, expect, it } from 'vitest';
import type { WorkflowLearningPreview } from '@/types/workflow';
import { LEARNING_PREVIEW_VISIBLE, learningPreviewLabel, learningPreviewViewSet } from './learning-preview-view';

function step(overrides: Partial<WorkflowLearningPreview> = {}): WorkflowLearningPreview {
  return {
    kind: 'click',
    text: '点击「立即签到」',
    path: '/checkin',
    at: 1_700_000_000_000,
    ...overrides,
  };
}

describe('learningPreviewViewSet', () => {
  it('没有预览时返回空列表而不是占位条目', () => {
    expect(learningPreviewViewSet(undefined)).toEqual({ items: [], hidden: 0, total: 0 });
    expect(learningPreviewViewSet([])).toEqual({ items: [], hidden: 0, total: 0 });
  });

  it('输入不是数组时安静降级（旧后台 / 脏响应）', () => {
    expect(learningPreviewViewSet(null as unknown as undefined)).toEqual({ items: [], hidden: 0, total: 0 });
    expect(learningPreviewViewSet({} as unknown as undefined)).toEqual({ items: [], hidden: 0, total: 0 });
  });

  it('过滤掉没有可读文案的损坏条目（不显示空白行）', () => {
    const set = learningPreviewViewSet([
      step(),
      { kind: 'click', text: '   ' } as unknown as WorkflowLearningPreview,
      null as unknown as WorkflowLearningPreview,
    ]);

    expect(set.items.map((item) => item.text)).toEqual(['点击「立即签到」']);
    expect(set.total).toBe(1);
  });

  it('超过上限时保留最近几条，并给出「还有 N 个动作」的准确条数', () => {
    const preview = Array.from({ length: 12 }, (_, index) => step({ text: `第 ${index + 1} 步` }));
    const set = learningPreviewViewSet(preview);

    expect(set.items).toHaveLength(LEARNING_PREVIEW_VISIBLE);
    expect(set.items.map((item) => item.text)).toEqual(['第 8 步', '第 9 步', '第 10 步', '第 11 步', '第 12 步']);
    expect(set.hidden).toBe(7);
    expect(set.total).toBe(12);
    // 序号沿用原始下标：用户不会以为前面的动作没录到
    expect(set.items.map((item) => item.index)).toEqual([8, 9, 10, 11, 12]);
  });

  it('恰好等于上限时不显示「还有」提示', () => {
    // 五个**不同**动作：同一次动作的补报会被去重，这里要测的是截断而不是去重。
    const set = learningPreviewViewSet(
      Array.from({ length: LEARNING_PREVIEW_VISIBLE }, (_, index) => step({ text: `动作 ${index + 1}`, at: 1_700_000_000_000 + index })),
    );

    expect(set.items).toHaveLength(LEARNING_PREVIEW_VISIBLE);
    expect(set.hidden).toBe(0);
  });

  it('同一次点击的补报副本只显示一条，并保留信息更全的那条', () => {
    // 真实形状（浏览器端实测）：同一次点击先报带落点、再补报不带落点，at 完全相同。
    const set = learningPreviewViewSet([
      { kind: 'click', text: '点击「#checkin-card > p:nt」（落点 50%, 48%）', path: '/checkin', at: 1_791_402_612_672 },
      { kind: 'click', text: '点击「#checkin-card > p:nt」', path: '/checkin', at: 1_791_402_612_672 },
    ]);

    expect(set.total).toBe(1);
    expect(set.items).toHaveLength(1);
    expect(set.items[0]?.text).toContain('落点');
  });

  it('同一毫秒里的两次不同位置点击不会被误合并', () => {
    const set = learningPreviewViewSet([
      { kind: 'click', text: '点击「A」', path: '/checkin', at: 1_000 },
      { kind: 'click', text: '点击「B」', path: '/profile', at: 1_000 },
    ]);

    expect(set.total).toBe(2);
  });

  it('没有时间戳的条目不做判重（宁可多显示也不误删）', () => {
    const set = learningPreviewViewSet([
      { kind: 'click', text: '点击「A」' },
      { kind: 'click', text: '点击「A」' },
    ]);

    expect(set.total).toBe(2);
  });

  it('每类动作都有中文标签，未知类型退回通用标签而不是空白', () => {
    expect(learningPreviewLabel('click')).toBe('点击');
    expect(learningPreviewLabel('scroll')).toBe('滚动');
    expect(learningPreviewLabel('fill')).toBe('填写');
    expect(learningPreviewLabel('drag')).toBe('拖动');
    expect(learningPreviewLabel('navigation')).toBe('打开');
    expect(learningPreviewLabel('something-new')).toBe('动作');
    expect(learningPreviewLabel(undefined)).toBe('动作');
    // 原型链上的键不是合法 kind：曾经用 `kind in LABEL` 会把 'toString' 当成已知类型
    expect(learningPreviewLabel('toString')).toBe('动作');
    expect(learningPreviewLabel('constructor')).toBe('动作');
  });

  it('数据结构不携带 path / at：只输出 label + text + index', () => {
    const item = learningPreviewViewSet([step({ path: '/secret/path', at: 42 })]).items[0]!;

    expect(Object.keys(item).sort()).toEqual(['index', 'kind', 'label', 'text']);
    expect(JSON.stringify(item)).not.toContain('/secret/path');
    expect(JSON.stringify(item)).not.toContain('42');
  });

  it('即使输入对象夹带敏感字段，输出里也不会带上', () => {
    const polluted = {
      ...step(),
      password: 'sentinel-secret-value',
      value: 'sentinel-secret-value',
      clientX: 321,
      clientY: 654,
      selector: '#private-selector',
    };
    const set = learningPreviewViewSet([polluted as unknown as WorkflowLearningPreview]);
    const serialized = JSON.stringify(set);

    expect(serialized).not.toContain('sentinel-secret-value');
    expect(serialized).not.toContain('clientX');
    expect(serialized).not.toContain('clientY');
    expect(serialized).not.toContain('#private-selector');
    expect(set.items).toHaveLength(1);
  });
});
