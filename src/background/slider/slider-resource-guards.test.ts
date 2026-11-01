/**
 * 滑块 CV 的两道资源护栏。
 *
 * 1. **解压炸弹** —— decodeBlob 只用 blob.size 挡压缩后的字节，一张 ~200KB 的
 *    PNG 能合法解码成 15000×15000，随后的 OffscreenCanvas + getImageData 会照
 *    width×height×4 分配 >900MB，OOM 掉 MV3 service worker，连带打断所有在跑的
 *    签到。解码尺寸校验（validBackgroundImage 等）要到 prepareSliderImages 才跑，
 *    太晚了 —— 护栏必须在建 canvas 之前按解码尺寸拦下。
 * 2. **操作数上限** —— holeSilhouetteMatch 等逐候选双层扫描原本没有上限，一张
 *    4000×4000、又拿不到 pieceRect 的背景会驱动上百亿次同步运算，把 worker 冻住
 *    几十秒。护栏用与 outlineProfileMatch 同一套 ~90M 预算提前返回 null。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodePngBase64,
  holeSilhouetteMatch,
  type SimpleImageData,
  type TemplateDescriptor,
} from '@/background/slider/slider-image';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('decodeBlob · 解压炸弹护栏', () => {
  it('解码后尺寸超过像素上限时，在分配 canvas 之前就抛错', async () => {
    const close = vi.fn();
    // 一张小体积「PNG」解码成 15000×15000 —— 225M 像素，远超 16M 上限
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 15_000, height: 15_000, close })));
    const constructed = vi.fn();
    // 一旦构造就记账；护栏若失效，模块会走到这里，测试立刻能发现
    class FakeOffscreenCanvas {
      constructor() {
        constructed();
      }
    }
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);

    await expect(decodePngBase64('AAAA')).rejects.toThrow('解码尺寸');
    // 关键断言：拦截发生在分配之前 —— OffscreenCanvas 从未被构造，>900MB 从未申请
    expect(constructed).not.toHaveBeenCalled();
    // 已解码的 bitmap 仍被 finally 释放，不泄漏
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('正常尺寸的解码图不被误杀，照常返回像素数据', async () => {
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 120, height: 80, close })));
    const data = new Uint8ClampedArray(120 * 80 * 4);
    const getImageData = vi.fn(() => ({ width: 120, height: 80, data }));
    const constructed = vi.fn();
    class FakeOffscreenCanvas {
      constructor(width: number, height: number) {
        constructed(width, height);
      }

      getContext() {
        return { drawImage: vi.fn(), getImageData };
      }
    }
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);

    const image = await decodePngBase64('AAAA');

    expect(image.width).toBe(120);
    expect(image.height).toBe(80);
    expect(image.data).toBe(data);
    expect(constructed).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

/** 内容无关的大背景：护栏在评分之前返回，只有尺寸参与预算估算。 */
function largeBackground(width: number, height: number): SimpleImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(150);
  return { width, height, data };
}

/**
 * alpha 内实心方块 + 透明留边的形状模板。
 *
 * inside / outside / boundary 采样都远超各自下限（24 / 12 / 20），于是能一路走到
 * 操作数护栏，而不是因采样点不足在更早的分支提前返回 —— 这样 null 才确实归因于护栏。
 */
function shapedTemplate(size: number): TemplateDescriptor {
  const inset = Math.round(size * 0.1);
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const solid = x >= inset && x < size - inset && y >= inset && y < size - inset;
      data[offset] = 90;
      data[offset + 1] = 90;
      data[offset + 2] = 96;
      data[offset + 3] = solid ? 255 : 0;
    }
  }
  return {
    image: { width: size, height: size, data },
    originalWidth: size,
    originalHeight: size,
    bounds: { x: 0, y: 0, width: size, height: size },
    shapedAlpha: true,
  };
}

describe('holeSilhouetteMatch · 操作数上限护栏', () => {
  it('背景过大导致 columns×rows×采样点数超预算时提前返回 null，不冻死 worker', () => {
    // 2000×2000 背景 + 200×200 形状模板、搜全部行：预算估算约 3×10^10 >> 90M。
    // 没有护栏时这里会同步跑上百亿次（几十秒，测试直接超时）；有护栏则毫秒级 null。
    const background = largeBackground(2_000, 2_000);
    const template = shapedTemplate(200);

    const result = holeSilhouetteMatch(background, template, 0, 0, true);

    expect(result).toBeNull();
  });
});
