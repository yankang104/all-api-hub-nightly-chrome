import { describe, expect, it } from 'vitest';
import {
  anchorX,
  anchorXExpression,
  anchorY,
  anchorYExpression,
  type PointerAnchor,
} from './pointer';

/**
 * 这两组函数是同一份落点算法的两种形态：content script 直接调 anchorX/anchorY，
 * 后台只能把表达式字符串塞进 CDP Runtime.evaluate。两者一旦不一致，就会重现
 * 「调试红点位置对、点击却落空」——X 会偏，Y 同样会偏。
 */
describe('落点规则', () => {
  const rect = { left: 323, top: 128, width: 382, height: 96 };

  const evalExpression = (expression: string, r: Record<string, number>): number => {
    // 用 Function 模拟后台在页面里 eval 表达式的行为
    return new Function('rect', `return ${expression};`)(r) as number;
  };

  it('center 取元素中心', () => {
    expect(anchorX(rect, { kind: 'center' })).toBe(514);
    expect(anchorY(rect, { kind: 'center' })).toBe(176);
  });

  it('inset-left 按左边缘绝对内缩，不随容器宽度放大', () => {
    // Turnstile 复选框距左边缘固定约 24px；容器变宽落点不能跟着右移
    expect(anchorX({ left: 323, width: 382 }, { kind: 'inset-left', px: 24 })).toBe(347);
    expect(anchorX({ left: 323, width: 900 }, { kind: 'inset-left', px: 24 })).toBe(347);
    expect(anchorY(rect, { kind: 'inset-left', px: 24 })).toBe(176);
  });

  it('内缩量超过半宽时收敛到中心，不会越过元素', () => {
    expect(anchorX({ left: 100, width: 40 }, { kind: 'inset-left', px: 500 })).toBe(120);
  });

  it('relative 按 rx/ry 还原元素内落点，并钳制到 0..1', () => {
    expect(anchorX(rect, { kind: 'relative', rx: 0, ry: 0 })).toBe(323);
    expect(anchorY(rect, { kind: 'relative', rx: 0, ry: 0 })).toBe(128);
    expect(anchorX(rect, { kind: 'relative', rx: 1, ry: 1 })).toBe(705);
    expect(anchorY(rect, { kind: 'relative', rx: 1, ry: 1 })).toBe(224);
    expect(anchorX(rect, { kind: 'relative', rx: -2, ry: -2 })).toBe(323);
    expect(anchorY(rect, { kind: 'relative', rx: -2, ry: -2 })).toBe(128);
    expect(anchorX(rect, { kind: 'relative', rx: 1.5, ry: 1.5 })).toBe(705);
    expect(anchorY(rect, { kind: 'relative', rx: 1.5, ry: 1.5 })).toBe(224);
  });

  it('relative 的 NaN/Infinity 回到中心，不产生 NaN 坐标', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(anchorX(rect, { kind: 'relative', rx: value, ry: value })).toBe(514);
      expect(anchorY(rect, { kind: 'relative', rx: value, ry: value })).toBe(176);
    }
  });

  it('X/Y 表达式形态与函数形态结果一致（含边界和非法值）', () => {
    const ratios = [0, 0.25, 1, -0.7, 1.7, Number.NaN, Number.POSITIVE_INFINITY];
    for (const ratio of ratios) {
      const anchor: PointerAnchor = { kind: 'relative', rx: ratio, ry: ratio };
      expect(evalExpression(anchorXExpression(anchor), rect)).toBe(anchorX(rect, anchor));
      expect(evalExpression(anchorYExpression(anchor), rect)).toBe(anchorY(rect, anchor));
    }
  });

  it('center/inset-left 的表达式形态也与函数形态一致', () => {
    const anchors: PointerAnchor[] = [
      { kind: 'center' },
      { kind: 'inset-left', px: 24 },
      { kind: 'inset-left', px: 999 },
    ];
    for (const anchor of anchors) {
      expect(evalExpression(anchorXExpression(anchor), rect)).toBe(anchorX(rect, anchor));
      expect(evalExpression(anchorYExpression(anchor), rect)).toBe(anchorY(rect, anchor));
    }
  });
});
