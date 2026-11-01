/**
 * 拖拽轨迹的单调性与终点精度。
 *
 * 原来的轨迹先冲过目标 1–3px 再修正回来。两个代价：
 *  1. WAF 滑块普遍校验轨迹单调性，往回退是明确的机器特征；
 *  2. 控件可能在回退完成前就采样了释放位置，读到冲过头的坐标 ——
 *     缺口算得再准也白费。
 *
 * 这里锁住「只前进、精确停在目标」这两条。
 */

import { describe, expect, it } from 'vitest';
import { buildSliderDragTrack } from '@/background/slider/slider-track';

/** 线性同余随机源，让轨迹可复现 */
function seededRandom(seed = 7) {
  let state = seed;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

function positions(track: ReturnType<typeof buildSliderDragTrack>): number[] {
  const result: number[] = [];
  let current = 0;
  for (const point of track) {
    current += point.dx;
    result.push(current);
  }
  return result;
}

describe('buildSliderDragTrack · 单调逼近', () => {
  const distances = [12, 45, 88, 175, 260];

  it('任何一步都不后退（dx 恒 ≥ 0）', () => {
    for (const distance of distances) {
      const track = buildSliderDragTrack(distance, seededRandom());
      for (const point of track) {
        expect(point.dx).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('全程不越过目标位置', () => {
    for (const distance of distances) {
      const track = buildSliderDragTrack(distance, seededRandom());
      for (const position of positions(track)) {
        // 允许浮点误差，但不允许实质越过
        expect(position).toBeLessThanOrEqual(distance + 1e-6);
      }
    }
  });

  it('累积位移精确等于目标距离', () => {
    for (const distance of distances) {
      const track = buildSliderDragTrack(distance, seededRandom());
      const total = track.reduce((sum, point) => sum + point.dx, 0);
      expect(total).toBeCloseTo(distance, 6);
    }
  });

  it('小数距离也精确落点（亚像素补偿后的值常带小数）', () => {
    const track = buildSliderDragTrack(174.93, seededRandom());
    const total = track.reduce((sum, point) => sum + point.dx, 0);
    expect(total).toBeCloseTo(174.93, 6);
  });

  it('收尾步长递减：最后一步比中段小', () => {
    const track = buildSliderDragTrack(200, seededRandom());
    const midStep = track[Math.floor(track.length / 2)]!.dx;
    const lastStep = track[track.length - 1]!.dx;
    expect(lastStep).toBeLessThan(midStep);
  });

  it('收尾停顿递增：最后一步等得最久', () => {
    const track = buildSliderDragTrack(200, seededRandom());
    const last = track[track.length - 1]!;
    const earlier = track[Math.floor(track.length / 3)]!;
    expect(last.delayMs).toBeGreaterThan(earlier.delayMs);
  });

  it('maximumDistance 生效时仍不越界', () => {
    const track = buildSliderDragTrack(300, seededRandom(), 250);
    const total = track.reduce((sum, point) => sum + point.dx, 0);
    expect(total).toBeLessThanOrEqual(250 + 1e-6);
    for (const position of positions(track)) {
      expect(position).toBeLessThanOrEqual(250 + 1e-6);
    }
  });

  it('不同随机源下单调性都成立', () => {
    for (let seed = 1; seed <= 12; seed += 1) {
      const track = buildSliderDragTrack(160, seededRandom(seed));
      for (const point of track) expect(point.dx).toBeGreaterThanOrEqual(0);
      const total = track.reduce((sum, point) => sum + point.dx, 0);
      expect(total).toBeCloseTo(160, 6);
    }
  });
});
