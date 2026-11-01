import { describe, expect, it } from 'vitest';
import { COMMON_CLOSE_SELECTORS } from './index';

describe('公告关闭选择器词表', () => {
  it('不含 .semi-modal-footer button —— 它会点中签到而不是关闭', () => {
    // 这条选择器匹配弹窗底部任意 button。footer 是 [签到][关闭] 时点中签到，
    // 而清理逻辑关掉一个就重扫，于是签到按钮被反复点击 ——
    // 站点回「今日已签到」，本来成功的签到被盖成重复签到。
    expect(COMMON_CLOSE_SELECTORS).not.toContain('.semi-modal-footer button');
  });

  it('按位置兜底时只匹配次要按钮，不匹配主操作', () => {
    const footerRules = COMMON_CLOSE_SELECTORS.filter((s) => s.includes('footer'));
    for (const rule of footerRules) {
      expect(rule, rule).not.toMatch(/footer\s+button\s*$/);
    }
  });

  it('覆盖 aria-label="Close" 的大小写', () => {
    // CSS 属性值匹配对非枚举属性大小写敏感，Tailwind/Headless UI 普遍写 Close
    const hasCaseInsensitive = COMMON_CLOSE_SELECTORS.some(
      (s) => /aria-label/i.test(s) && /\si\]/.test(s),
    );
    expect(hasCaseInsensitive).toBe(true);
  });

  it('每条都是合法的 CSS 选择器', () => {
    for (const selector of COMMON_CLOSE_SELECTORS) {
      // node 环境没有 document，用括号配平和基本形状做静态检查
      expect(selector.trim(), selector).not.toBe('');
      const opens = (selector.match(/\[/g) ?? []).length;
      const closes = (selector.match(/\]/g) ?? []).length;
      expect(opens, selector).toBe(closes);
    }
  });
});
