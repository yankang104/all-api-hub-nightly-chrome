/**
 * modal-scope 词表与判据的单元测试。
 *
 * 重点覆盖 Motomoto 系公告的「我已知悉」——旧词表只有「我知道了 / 知道了」，
 * 「我已知悉 / 已知悉 / 我已了解 / 我已阅读 / 已阅读并同意」全部漏网，
 * 于是这个金色主按钮既不被识别成关闭动作、也不会被 judgeCloseCandidate 放行。
 */
import { describe, expect, it } from 'vitest';
import { isBareCloseLabel, isDismissText } from '@/automation/shared/modal-scope';

describe('isDismissText — 关闭 / 知悉类公告文案', () => {
  it('命中 Motomoto 系「我已知悉」及其变体', () => {
    for (const text of ['我已知悉', '已知悉', '我已了解', '已了解', '我已阅读', '已阅读并同意']) {
      expect(isDismissText(text)).toBe(true);
    }
  });

  it('仍命中原有的关闭 / 已读文案', () => {
    for (const text of ['我知道了', '知道了', '不再显示', '今日不再显示', '标记已读', 'got it', 'dismiss']) {
      expect(isDismissText(text)).toBe(true);
    }
  });

  it('不误伤签到 / 登录 / 支付这类功能按钮文案', () => {
    for (const text of ['立即签到', '每日签到', '登录', '获取密钥', '确认支付', '提交']) {
      expect(isDismissText(text)).toBe(false);
    }
  });
});

describe('isBareCloseLabel — 只写「关闭 / ×」的按钮', () => {
  it('识别纯「关闭」「×」文案', () => {
    for (const label of ['关闭', '×', '✕', 'close']) {
      const el = document.createElement('button');
      el.textContent = label;
      expect(isBareCloseLabel(el)).toBe(true);
    }
  });

  it('不把「关闭自动签到」这类子串当纯关闭按钮', () => {
    const el = document.createElement('button');
    el.textContent = '关闭自动签到';
    expect(isBareCloseLabel(el)).toBe(false);
  });
});
