/** 只支持已知的腾讯验证码文档，不把普通第三方 iframe 当成签到页面。 */
export function isTencentCaptchaFrameUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && [
      'turing.captcha.qcloud.com',
      'ca.turing.captcha.qcloud.com',
      'turing.captcha.gtimg.com',
      'global.turing.captcha.gtimg.com',
    ].includes(url.hostname);
  } catch {
    return false;
  }
}

export const SLIDER_FRAME_CONNECT_EVENT = 'aah-slider-frame-connect';
export const SLIDER_FRAME_STOP_EVENT = 'aah-slider-frame-stop';
export const SLIDER_FRAME_LIFETIME_MS = 65_000;
