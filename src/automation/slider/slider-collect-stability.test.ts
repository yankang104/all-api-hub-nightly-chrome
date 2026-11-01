// @vitest-environment jsdom
/**
 * 采集滑块挑战前的几何稳定等待。
 *
 * 拖动是按采集到的坐标算的，所以采集必须发生在几何稳定之后 —— 面板还在滑入时
 * 读到的矩形，下一帧就作废了。但等待也必须**有界且够长**：
 *
 *  - 原来是固定「最多 3 帧」（60fps 下约 50ms）。面板带 300–400ms 入场动画时
 *    每一帧几何都在变，于是直接 return null —— 滑块明明能识别，却因为还在动
 *    被丢掉，上层报「没有找到同时满足把手、轨道和背景几何关系的滑块控件」。
 *  - 反过来也不能无限等：有些验证码带持续的呼吸/闪烁动画，永远等不到完全静止，
 *    必须到点放弃而不是挂住整个签到流程。
 *
 * 这里的动画**按读取次数驱动，不用墙钟定时器**。用 setInterval 去和生产代码自己
 * 的 50ms 轮询赛跑时，单独跑能过、全量跑就崩：jsdom 在多文件下变慢，动画在采样
 * 开始前就跑完了。按次数驱动与调度节奏彻底无关。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { collectSliderChallenge } from '@/automation/slider/slider-dom';

/** 1×1 透明 PNG —— 只需要它是个合法的 data URL，不读像素。 */
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

/** 稳定后的面板左边缘；背景图比它右移 12px。 */
const SETTLED_LEFT = 40;

function domRect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    width,
    height,
    top: y,
    left: x,
    right: x + width,
    bottom: y + height,
    toJSON() {
      return this;
    },
  } as DOMRect;
}

/**
 * jsdom 不做布局，所有几何都要自己接管。
 *
 * 顺带把元素登记进命中表：`document.elementFromPoint` 的桩只认这张表，
 * 漏登记的元素等于「点不到」，把手会被 `scoreHandle` 判 -Infinity 丢掉。
 * 调用顺序即层叠顺序（外层先、内层后）。
 */
function stubGeometry(element: Element, read: () => DOMRect): void {
  Object.defineProperty(element, 'getBoundingClientRect', { value: read, configurable: true });
  Object.defineProperty(element, 'getClientRects', { value: () => [read()], configurable: true });
  // jsdom 没有实现 scrollIntoView；面板部分超出视口时采集会调它。
  Object.defineProperty(element, 'scrollIntoView', { value: () => {}, configurable: true });
  hitTargets.push({ element, read });
}

/**
 * jsdom 默认不加载资源，`<img>` 的 complete 恒为 false、naturalWidth 恒为 0，
 * 而 `sliderMediaReady` 要求两者都就绪才肯把这一帧算进稳定采样。不接管的话
 * 稳定计数永远到不了 2，四个用例都会以「验证码图片还没有加载完成」失败 ——
 * 与几何一样，这是 jsdom 缺的浏览器能力，得由测试自己补上。
 */
function stubLoadedImage(image: HTMLImageElement, width: number, height: number): void {
  Object.defineProperty(image, 'complete', { value: true, configurable: true });
  Object.defineProperty(image, 'naturalWidth', { value: width, configurable: true });
  Object.defineProperty(image, 'naturalHeight', { value: height, configurable: true });
}

/** 命中测试用的矩形表，注册顺序由外层到内层。 */
let hitTargets: Array<{ element: Element; read: () => DOMRect }> = [];

/**
 * 补上 `document.elementFromPoint`。
 *
 * `scoreHandle` 与 `scoreGeometryHandle` 用它确认把手中心真的能接收按压 ——
 * 被公告或蒙层盖住的控件不能拖。jsdom 没有实现，调用会直接抛
 * `not a function`，把整次采集打断。
 *
 * 这里按已打桩的矩形做最小命中测试：取最后一个（也就是最深的）包含该点的元素。
 */
function installElementFromPoint(): void {
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: (x: number, y: number): Element | null => {
      let hit: Element | null = null;
      for (const target of hitTargets) {
        const rect = target.read();
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) hit = target.element;
      }
      return hit;
    },
  });
}

interface Scene {
  /**
   * 前 N 次采样期间面板持续移动，之后永久定在 SETTLED_LEFT。
   *
   * 生产代码要求连续两次采样几何一致，所以只要 N 之后不再动，它一定会稳定 ——
   * 与 jsdom 的调度快慢无关。
   */
  setMovingPasses: (passes: number) => void;
  /** 永不静止：每次采样都换位置，用于验证到点放弃。 */
  setNeverSettles: () => void;
}

/**
 * 搭一个能被 findSliderDomMatch 认出的最小滑块 DOM。
 *
 * 语义词是必需的：`captcha`/`verify` 提供挑战上下文，`拖动…拼图` 提供提示词，
 * `slider-track` / `slider-btn` 提供轨道与把手 —— 打分器靠这些定位。
 */
function buildSlider(): Scene {
  document.body.innerHTML = '';
  hitTargets = [];
  installElementFromPoint();
  let movingPasses = 0;
  let neverSettles = false;
  let passes = 0;
  let cachedLeft = SETTLED_LEFT;

  /*
   * 一次稳定采样会把 match 里的五个元素各读一次矩形（见 slider-dom 的
   * geometrySnapshot）。位置必须在**同一次采样内保持一致**，否则整块看起来
   * 自相矛盾，稳定判定永远不成立。所以只有面板推进计数并缓存，另外四个复用
   * 缓存值 —— geometrySnapshot 总是先读面板。
   */
  const advance = (): number => {
    passes += 1;
    /*
     * 永不静止用**单调递增**而不是奇偶交替。
     *
     * `findSliderDomMatch` 在打分阶段也会读矩形（面板/轨道/背景各自的评分器），
     * 每轮采样推进的次数不固定。用奇偶的话两次采样可能恰好落回同一相位而被
     * 判成稳定 —— 单调递增让「相邻两次一定不同」成为算术事实。
     */
    if (neverSettles) cachedLeft = SETTLED_LEFT + passes * 7;
    else if (passes <= movingPasses) cachedLeft = -260 + passes * 60;
    else cachedLeft = SETTLED_LEFT;
    return cachedLeft;
  };
  const reuse = () => cachedLeft;

  const panel = document.createElement('div');
  panel.className = 'captcha-panel verify-slider';
  const prompt = document.createElement('div');
  prompt.textContent = '拖动下方滑块完成拼图';
  const background = document.createElement('img');
  background.className = 'captcha-background';
  background.src = TINY_PNG;
  stubLoadedImage(background, 300, 150);
  const track = document.createElement('div');
  track.className = 'slider-track';
  const handle = document.createElement('div');
  handle.className = 'slider-btn';
  handle.setAttribute('role', 'slider');

  track.appendChild(handle);
  panel.append(prompt, background, track);
  document.body.appendChild(panel);

  stubGeometry(panel, () => domRect(advance(), 40, 320, 220));
  stubGeometry(prompt, () => domRect(reuse() + 12, 44, 300, 16));
  stubGeometry(background, () => domRect(reuse() + 12, 62, 300, 150));
  stubGeometry(track, () => domRect(reuse() + 12, 220, 300, 30));
  stubGeometry(handle, () => domRect(reuse() + 12, 220, 44, 30));

  return {
    setMovingPasses: (value) => { movingPasses = value; passes = 0; },
    setNeverSettles: () => { neverSettles = true; passes = 0; },
  };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('collectSliderChallenge · 几何稳定等待', () => {
  it('几何一开始就稳定时直接采集', async () => {
    buildSlider();

    const collected = await collectSliderChallenge();

    expect(collected).not.toBeNull();
    expect(collected!.info.backgroundRect.width).toBe(300);
    expect(collected!.info.handleRect.width).toBe(44);
    collected!.releaseHandleMarker();
  });

  it('面板带入场动画时等它停下来再采集，而不是立刻放弃', async () => {
    const scene = buildSlider();
    // 前 4 次采样一直在移动（相当于 ~200ms 的滑入），之后定住。
    scene.setMovingPasses(4);

    const collected = await collectSliderChallenge();

    // 修复前：3 帧内几何仍在变 → 直接 null，滑块被白白丢掉。
    expect(collected).not.toBeNull();
    // 采到的必须是**停稳后**的坐标，不是动画中途的某一帧。
    expect(collected!.info.backgroundRect.x).toBe(SETTLED_LEFT + 12);
    collected!.releaseHandleMarker();
  });

  it('几何持续变化时到点放弃，不挂住流程', async () => {
    const scene = buildSlider();
    scene.setNeverSettles();

    const started = Date.now();
    const collected = await collectSliderChallenge();
    const elapsed = Date.now() - started;

    expect(collected).toBeNull();
    // 有界：约 1.2 秒的上限，留足余量但不能无限等。
    expect(elapsed).toBeLessThan(4_000);
  }, 15_000);

  it('采集后释放把手标记，不在页面上留下调试属性', async () => {
    buildSlider();

    const collected = await collectSliderChallenge();
    expect(collected).not.toBeNull();

    const handle = collected!.match.handle;
    // 采集期间挂着标记，供后台按下前重新定位把手
    expect(handle.getAttribute('data-aah-pointer-target')).toBe(collected!.info.handleToken);

    collected!.releaseHandleMarker();
    expect(handle.hasAttribute('data-aah-pointer-target')).toBe(false);
    // 幂等：重复释放不应抛错、也不应把别人的标记删掉
    collected!.releaseHandleMarker();
    expect(handle.hasAttribute('data-aah-pointer-target')).toBe(false);
  });
});
