/**
 * 滑块破解相关单元测试。
 *
 * 测试：拖拽轨迹生成、纯 JS 模板匹配（NCC）。
 *
 * 这些测试不依赖浏览器环境（jsdom 即可），可独立运行。
 */

import { describe, expect, it } from 'vitest';
import { buildSliderDragTrack, nccTemplateMatch } from '@/background/slider/slider-crack';

// ---------------------------------------------------------------------------
// buildSliderDragTrack — 轨迹生成
// ---------------------------------------------------------------------------

describe('buildSliderDragTrack', () => {
  it('零距离返回最少点序列', () => {
    const track = buildSliderDragTrack(0, () => 1);
    expect(track.length).toBe(2);
    expect(track.reduce((s, p) => s + p.dx, 0)).toBe(0);
  });

  it('负距离返回最少点序列（负距离按 0 处理）', () => {
    const track = buildSliderDragTrack(-10, () => 0.5);
    const total = track.reduce((s, p) => s + p.dx, 0);
    expect(total).toBe(0);
  });

  it('正距离生成合理轨迹，累积距离精确等于目标', () => {
    const random = () => 0.5; // 固定中间值，无抖动
    const distance = 200;
    const track = buildSliderDragTrack(distance, random);
    const total = track.reduce((s, p) => s + p.dx, 0);
    expect(total).toBe(distance);
  });

  it('轨迹至少包含 10 个点', () => {
    const track = buildSliderDragTrack(100, Math.random);
    expect(track.length).toBeGreaterThanOrEqual(10);
  });

  it('轨迹不超过 28 个点（避免过密）', () => {
    const track = buildSliderDragTrack(500, Math.random);
    expect(track.length).toBeLessThanOrEqual(28);
  });

  it('每步延时在合理范围（0-100ms）', () => {
    const track = buildSliderDragTrack(150, Math.random);
    for (const step of track) {
      expect(step.delayMs).toBeGreaterThanOrEqual(0);
      expect(step.delayMs).toBeLessThanOrEqual(100);
    }
  });

  it('最后一步延时不小于 30ms（模拟人类松手前的确认）', () => {
    const track = buildSliderDragTrack(100, Math.random);
    const last = track[track.length - 1]!;
    expect(last.delayMs).toBeGreaterThanOrEqual(30);
  });

  it('相同距离和随机源，轨迹确定可复现', () => {
    const makeRand = () => {
      let seed = 42;
      return () => {
        seed = (seed * 16807) % 2147483647;
        return (seed - 1) / 2147483646;
      };
    };
    const track1 = buildSliderDragTrack(100, makeRand());
    const track2 = buildSliderDragTrack(100, makeRand());

    expect(track1.length).toBe(track2.length);
    for (let i = 0; i < track1.length; i++) {
      expect(track1[i]!.dx).toBe(track2[i]!.dx);
      expect(track1[i]!.delayMs).toBe(track2[i]!.delayMs);
    }
  });
});

// ---------------------------------------------------------------------------
// 纯 JS NCC 模板匹配
// ---------------------------------------------------------------------------

describe('nccTemplateMatch', () => {
  function makeImage(
    w: number,
    h: number,
    fill: (x: number, y: number) => [number, number, number, number],
  ) {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const [r, g, b, a] = fill(x, y);
        const i = (y * w + x) * 4;
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = a;
      }
    }
    return { width: w, height: h, data };
  }

  it('模板完全匹配搜索图时返回正确位置', () => {
    // 100×50 搜索图，全灰背景 + 白色方块在 (20, 10)，大小 30×30
    const search = makeImage(100, 50, (x, y) => {
      if (x >= 20 && x < 50 && y >= 10 && y < 40) return [255, 255, 255, 255];
      return [128, 128, 128, 255];
    });
    // 模板 = 白色方块
    const template = makeImage(30, 30, () => [255, 255, 255, 255]);

    const result = nccTemplateMatch(search, template);
    expect(result).not.toBeNull();
    expect(result!.x).toBe(20);
    expect(result!.y).toBe(10);
    expect(result!.confidence).toBeGreaterThan(0.9);
  });

  it('模板比搜索图大时返回 null', () => {
    const search = makeImage(10, 10, () => [128, 128, 128, 255]);
    const template = makeImage(20, 20, () => [255, 255, 255, 255]);
    const result = nccTemplateMatch(search, template);
    expect(result).toBeNull();
  });

  it('纯色模板返回 null（方差为 0，无法匹配）', () => {
    const search = makeImage(50, 30, () => [128, 128, 128, 255]);
    const template = makeImage(10, 10, () => [128, 128, 128, 255]);
    const result = nccTemplateMatch(search, template);
    expect(result).toBeNull();
  });

  it('含透明像素的模板正确处理', () => {
    // 搜索图：全白
    const search = makeImage(60, 40, () => [255, 255, 255, 255]);
    // 模板：左半不透明，右半透明
    const template = makeImage(20, 20, (x, y) => {
      if (x < 10) return [128, 128, 128, 255];
      return [0, 0, 0, 0]; // 完全透明
    });

    const result = nccTemplateMatch(search, template, 0.3);
    // 透明像素被跳过，只有左半参与匹配，confidence 可能较低
    expect(result).not.toBeNull();
  });

  it('带透明轮廓的纹理模板仍精确命中', () => {
    const left = 27;
    const top = 9;
    const template = makeImage(14, 12, (x, y) => {
      const opaque = x >= 2 && x <= 11 && y >= 1 && y <= 10 && !(x < 5 && y < 4);
      if (!opaque) return [0, 0, 0, 0];
      return [40 + x * 9, 70 + y * 7, 90 + (x + y) * 4, 255];
    });
    const search = makeImage(70, 35, (x, y) => {
      const templateX = x - left;
      const templateY = y - top;
      if (templateX >= 0 && templateY >= 0 && templateX < template.width && templateY < template.height) {
        const offset = (templateY * template.width + templateX) * 4;
        if (template.data[offset + 3]! >= 32) {
          return [template.data[offset]!, template.data[offset + 1]!, template.data[offset + 2]!, 255];
        }
      }
      const noise = (x * 17 + y * 11) % 37;
      return [145 + noise, 120 + noise, 100 + noise, 255];
    });

    const result = nccTemplateMatch(search, template, 0.5);

    expect(result).not.toBeNull();
    expect(result!.x).toBe(left);
    expect(result!.y).toBe(top);
    expect(result!.confidence).toBeGreaterThan(0.99);
  });
});
