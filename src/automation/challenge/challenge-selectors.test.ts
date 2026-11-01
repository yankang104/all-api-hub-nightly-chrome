/**
 * reveal 候选选择器的防漂移测试。
 *
 * `challenge-click.ts` 的候选列表刻意比 `challenge.ts` 的客观判定更宽，但至少要覆盖
 * captcha / Turnstile / hCaptcha / reCAPTCHA / slider 这些会让真实验证控件待在视口
 * 下方、需要先滚动揭露的类型。重复项断言则防止后续维护时把同一选择器回填两次。
 */
import { describe, expect, it } from 'vitest';
import { REVEAL_CANDIDATE_SELECTORS } from '@/automation/challenge/challenge-click';

const REQUIRED_REVEAL_SELECTORS: ReadonlyArray<readonly [type: string, selector: string]> = [
  ['captcha', 'iframe[src*="captcha" i]'],
  ['turnstile', 'iframe[src*="turnstile" i]'],
  ['hcaptcha', '[class*="hcaptcha" i]'],
  ['recaptcha', '[class*="recaptcha" i]'],
  ['slider', '[class*="slider" i]'],
];

describe('REVEAL_CANDIDATE_SELECTORS', () => {
  it('包含所有必需验证类型的候选选择器', () => {
    for (const [type, selector] of REQUIRED_REVEAL_SELECTORS) {
      expect(REVEAL_CANDIDATE_SELECTORS, `${type} 必须至少有一条 reveal 候选选择器`).toContain(selector);
    }
  });

  it('是字符串数组且没有重复项', () => {
    expect(Array.isArray(REVEAL_CANDIDATE_SELECTORS)).toBe(true);
    expect(REVEAL_CANDIDATE_SELECTORS.every((selector) => typeof selector === 'string' && selector.trim().length > 0)).toBe(true);
    expect(new Set(REVEAL_CANDIDATE_SELECTORS).size).toBe(REVEAL_CANDIDATE_SELECTORS.length);
  });
});
