import { isTencentCaptchaFrameUrl } from '@/lib/core/slider-frame';

/** 仅供腾讯验证码适配入口显式启用，不加入主页面的通用选择器。 */
export const TENCENT_SLIDER_SELECTORS = {
  widgets: [
    '.tencent-captcha-dy__slider-groove',
    '.tencent-captcha-dy__slider-block',
    '.tencent-captcha-dy__verify-bg',
  ].join(', '),
  success: [
    '.tencent-captcha-dy__slider-groove--success',
    '.tencent-captcha-dy__slider-block--success',
  ].join(', '),
  handle: '.tencent-captcha-dy__slider-block',
  background: '.tencent-captcha-dy__verify-bg',
  backgroundImage: '.tencent-captcha-dy__verify-bg-img',
  piece: '.tencent-captcha-dy__fg-item',
  refresh: '.tencent-captcha-dy__footer-icon--refresh',
} as const;

const TENCENT_FRAME_IDS = new Set(['tcaptcha_iframe_drag', 'tcaptcha_iframe_dy', 'tCaptchaIframeArea', 'tcaptcha_popup']);

export function isVisibleSliderFrame(frame: HTMLIFrameElement): boolean {
  if (!frame.isConnected || !frame.getClientRects().length) return false;
  if (!isTencentCaptchaFrameUrl(frame.src) && !TENCENT_FRAME_IDS.has(frame.id)) return false;
  let element: Element | null = frame;
  while (element) {
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility !== 'visible'
      || Number.parseFloat(style.opacity || '1') <= 0.02) return false;
    element = element.parentElement;
  }
  const rect = frame.getBoundingClientRect();
  return rect.width >= 150 && rect.height >= 90
    && Math.min(rect.right, innerWidth) - Math.max(rect.left, 0) >= 80
    && Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0) >= 60;
}

export function findVisibleSliderFrame(): HTMLIFrameElement | undefined {
  const candidates = [...document.querySelectorAll('iframe')].filter(isVisibleSliderFrame);
  // SDK 可同时预加载登录和签到的文档；优先当前真正显示在最上层的那个。
  return candidates.find((frame) => {
    const rect = frame.getBoundingClientRect();
    return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === frame;
  }) ?? candidates[0];
}
