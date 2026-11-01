import type { TrustedPointerDragPoint } from '@/background/slider/trusted-pointer';

export interface DragTrackPoint {
  dx: number;
  delayMs: number;
}

export type TrackRandom = () => number;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/** Build a bounded acceleration/deceleration path with a small final correction. */
export function buildSliderDragTrack(
  distance: number,
  random: TrackRandom = Math.random,
  maximumDistance = Number.POSITIVE_INFINITY,
): DragTrackPoint[] {
  if (!Number.isFinite(distance) || distance <= 0) {
    return [
      { dx: 0, delayMs: 20 },
      { dx: 0, delayMs: 20 },
    ];
  }

  // Keep the planned displacement fractional all the way to the release point.
  // Only intermediate motion samples are rounded below.
  const finalDistance = Math.min(distance, maximumDistance);
  const pointCount = clamp(14 + Math.round(finalDistance / 45) + Math.round(random() * 3), 14, 23);
  /*
   * 单调逼近目标，**不冲过再退回**。
   *
   * 原来会先冲过目标 1–3px 再修正回来。两个代价：
   *  1. WAF 滑块普遍校验轨迹单调性，往回退是明确的机器特征；
   *  2. 控件可能在回退动作完成前就采样了释放位置，读到的是冲过头的坐标 ——
   *     算得再准也白费。
   *
   * 人手拖滑块同样是「快速接近 → 减速 → 停住」，不需要越过再拉回。
   * 减速段用最后几个点密集小步长实现，观感与人手一致。
   */
  const settlePoints = finalDistance >= 45 ? 3 : 2;
  const forwardPoints = pointCount - settlePoints;
  /** 减速段起点：停在目标前一小段，剩下的距离由 settle 段走完。 */
  const approachRatio = finalDistance >= 45 ? 0.965 : 0.93;
  const forwardTarget = finalDistance * approachRatio;
  const track: DragTrackPoint[] = [];
  let previous = 0;

  for (let index = 1; index <= forwardPoints; index += 1) {
    const progress = index / forwardPoints;
    const eased = progress < 0.5
      ? 4 * progress ** 3
      : 1 - (-2 * progress + 2) ** 3 / 2;
    const target = Math.min(forwardTarget, Math.max(previous, Math.round(forwardTarget * eased)));
    track.push({
      dx: target - previous,
      // Keep the early movement from becoming a burst of near-zero-delay
      // events.  The widget still receives the same coordinates; only the
      // cadence is made a little easier for its drag state machine to follow.
      delayMs: progress < 0.7
        ? 14 + Math.round(random() * 14)
        : 22 + Math.round(random() * 24),
    });
    previous = target;
  }

  /*
   * 减速收尾：剩下的距离分成越来越小的几步走完，最后一步落在目标上。
   * 全程 dx ≥ 0，任何一步都不会越过 finalDistance。
   */
  for (let index = 1; index <= settlePoints; index += 1) {
    const remaining = finalDistance - previous;
    // 最后一步吃掉全部余量，中间步按半数逼近 —— 步长自然递减。
    const step = index === settlePoints ? remaining : remaining * 0.5;
    const target = index === settlePoints ? finalDistance : previous + step;
    track.push({
      dx: target - previous,
      // 越接近目标停顿越长，模拟人手确认位置后才松开。
      delayMs: 34 + index * 12 + Math.round(random() * 26),
    });
    previous = target;
  }

  const accumulated = track.reduce((sum, point) => sum + point.dx, 0);
  track[track.length - 1]!.dx += finalDistance - accumulated;
  return track;
}

export function buildSliderDragPoints(
  startX: number,
  startY: number,
  track: DragTrackPoint[],
  viewportWidth: number,
  viewportHeight: number,
  random: TrackRandom = Math.random,
): TrustedPointerDragPoint[] {
  const points: TrustedPointerDragPoint[] = [];
  let currentX = startX;
  const arc = (random() - 0.5) * 2.4;
  const endX = clamp(startX + track.reduce((sum, step) => sum + step.dx, 0), 1, viewportWidth - 1);
  let previousX = clamp(startX, 1, viewportWidth - 1);

  for (let index = 0; index < track.length; index += 1) {
    const step = track[index]!;
    currentX += step.dx;
    const progress = (index + 1) / track.length;
    const settling = 1 - progress;
    const jitter = index === track.length - 1 ? 0 : (random() - 0.5) * 1.5 * settling;
    const y = startY + Math.sin(progress * Math.PI) * arc + jitter;
    const x = Math.min(endX, Math.max(previousX, Math.round(clamp(currentX, 1, viewportWidth - 1))));
    points.push({
      x,
      y: Math.round(clamp(y, 1, viewportHeight - 1)),
      delayMs: step.delayMs,
    });
    previousX = x;
  }

  const last = points[points.length - 1];
  if (last) {
    // Intermediate events may stay integral for broad browser compatibility,
    // but the release event must represent the exact planned displacement.
    // Keeping the fractional center avoids a final ±0.5px error after the
    // image-to-track conversion and remains relative to the live handle when
    // trustedPointerDrag resamples the marker.
    const totalDx = track.reduce((sum, step) => sum + step.dx, 0);
    last.x = clamp(startX + totalDx, 1, viewportWidth - 1);
    last.y = clamp(startY, 1, viewportHeight - 1);
  }
  return points;
}
