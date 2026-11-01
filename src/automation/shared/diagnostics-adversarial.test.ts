/**
 * 对抗性复核：否定式自述的排除规则不得吞掉**真实的验证挑战**。
 *
 * 背景：为了修「站点 503 被误判成需要人工验证」，NON_SYMPTOM_PATTERNS 里加了
 * `/未(?:发现|检测到|出现).*(?:人机|安全)?验证/`。这条规则的 `.*` 会跨过句读
 * 吞掉整行 —— 如果同一行里既有「未发现」又有真实的验证要求（例如
 * 「未发现异常，随后弹出安全验证」），真实挑战就被当成不存在，
 * 若结论里还有 5xx 字样，分类会落到**可重试**的站点故障上，
 * 扩展就会对着一个人机验证反复自动点击。这是安全红线，必须钉死。
 *
 * 本文件同时锁住两个方向：
 *   A. 真实验证挑战（含与否定句同行的形态）→ 必须需要人工、不得可重试；
 *   B. 纯否定自述（我们引擎自己的日志）→ 不得把 5xx 染成人工验证。
 */
import { describe, expect, it } from 'vitest';
import { classifyFailure, DIAGNOSIS, isSymptom, planRetry } from '@/automation/shared/diagnostics';

/** 真实的健康检查结论：站点把后端故障渲染到页面上时，我们就是这样措辞的。 */
const SITE_5XX = '站点确认签到失败：签到失败：服务暂不可用（HTTP 503）';

function expectManualRequired(steps: readonly string[], message = '签到失败'): void {
  const code = classifyFailure(message, steps);
  expect(code, `steps=${JSON.stringify(steps)} code=${code}`).toBe(DIAGNOSIS.MANUAL_REQUIRED);
  expect(planRetry(code, 0).retry).toBe(false);
}

function expectSiteUnavailable(steps: readonly string[], message = SITE_5XX): void {
  const code = classifyFailure(message, steps);
  expect(code, `steps=${JSON.stringify(steps)} code=${code}`).toBe(DIAGNOSIS.SITE_UNAVAILABLE);
  expect(planRetry(code, 0).retry).toBe(true);
}

describe('A. 真实验证挑战必须需要人工，绝不能被排除规则吞掉', () => {
  it('肯定证据独立成行：否定句不得把同批日志里的真实挑战一起带走', () => {
    expectManualRequired([
      '未发现可点击的签到按钮',
      '检测到人机验证，等待你在当前标签页完成',
    ]);
  });

  it('同一行「先否定后肯定」：不得整行排除（安全红线）', () => {
    expectManualRequired(['未发现异常，随后弹出安全验证'], SITE_5XX);
  });

  it('同一行「先否定后肯定」且无句读：不得整行排除', () => {
    expectManualRequired(['未发现异常 随后触发人机验证'], SITE_5XX);
  });

  it('「请完成滑块验证」是真实交互式挑战，不得被判成可重试', () => {
    expectManualRequired(['未发现签到按钮，页面提示请完成滑块验证'], SITE_5XX);
  });

  it('站点侧明确的验证失败/验证码错误必须压过 5xx', () => {
    expectManualRequired([
      '签到点击后未发现安全验证证据，继续核对本次签到结果',
      '页面提示：验证失败，请重试',
      '页面提示：验证码错误',
    ], SITE_5XX);
  });
});

describe('B. 纯否定自述不得把 5xx 染成人工验证（原缺陷不回归）', () => {
  it('引擎自己的否定自述 + 站点 503 → 站点不可用、可重试', () => {
    expectSiteUnavailable([
      '签到点击后未发现安全验证证据，继续核对本次签到结果',
      '额度无变化，当前余额 $500000.00',
    ]);
  });

  it.each([
    '未检测到人机验证',
    '未出现安全验证',
    '未见安全验证',
    '没有发现安全验证',
    '没有检测到人机验证',
    '未发现人机校验',
    '本次没有发现验证',
    '无需额外的安全验证',
  ])('否定句变体「%s」不得把 503 挡成人工验证', (line) => {
    expect(isSymptom(line), `isSymptom(${line})`).toBe(false);
    expectSiteUnavailable([line]);
  });

  it('正向证据行仍然算症状（排除规则没有过度扩大）', () => {
    expect(isSymptom('检测到人机验证，等待你在当前标签页完成')).toBe(true);
    expect(isSymptom('页面提示请完成滑块验证')).toBe(true);
  });
});

describe('C. 公告成功关闭的回执不得把「真的还被挡着」也一起排除（原误诊不回归）', () => {
  /**
   * 背景：AnyRouter 那次公告其实关成功了，但日志里的成功回执带着「遮挡」二字，
   * 把后续失败染成了 OBSCURED —— 用户被指去关一个不存在的弹窗。
   *
   * 修复方向是「只排除断言成功的措辞」。这个方向有个天然风险：排除面一旦放宽，
   * 真的还有公告压着签到按钮时也会被吞掉，用户就会看到「找不到控件」去改选择器，
   * 而页面上明明有个关不掉的弹窗。本组同时钉死两个方向。
   */

  /** 站点/引擎报出「仍然被挡着」的真实残留遮挡文案。 */
  const REAL_BLOCKER_STEPS: ReadonlyArray<string> = [
    '签到按钮被div.ant-modal-mask遮挡，可能有未关闭的公告弹窗',
    '公告关闭按钮已收到浏览器可信点击：「今日关闭」（div.semi-modal-content.undefined，文字识别）',
    '已确认对应公告消失或目标遮挡解除：「今日关闭」（div.semi-modal-content.undefined，文字识别）',
  ];

  it('同一轮里先关掉一个公告、之后又有残留遮挡 → OBSCURED（成功回执不掩盖残留）', () => {
    const code = classifyFailure('签到失败', REAL_BLOCKER_STEPS);
    expect(code, JSON.stringify(REAL_BLOCKER_STEPS)).toBe(DIAGNOSIS.OBSCURED);
    expect(planRetry(code, 0).retry).toBe(false);
  });

  it('残留遮挡的常见措辞逐条都算症状', () => {
    for (const line of [
      '签到按钮被div.ant-modal-mask遮挡，可能有未关闭的公告弹窗',
      'VSLLM 签到按钮仍被弹窗遮挡',
      '一梦五千年领取按钮仍被弹窗遮挡',
      '签到按钮被遮挡，可能有未关闭的公告弹窗',
      '用户菜单被div.ant-modal-mask遮挡，无法切换账号',
      '退出登录按钮被div.ant-modal-mask遮挡，无法切换账号',
      '已尝试的公告关闭按钮未生效，Esc 也未解除遮挡，后续操作仍被挡住',
      '公告关闭按钮未能解除遮挡，未对归属不明的浮层继续按 Esc',
      '关闭了 1 个公告，但页面仍有遮罩',
    ]) {
      expect(isSymptom(line), line).toBe(true);
    }
  });

  it('「被 X 遮挡，尝试关闭遮挡的公告」是发现遮挡的那一行，不能被当成成功回执', () => {
    // 这条日志在**关不掉**时同样会写，所以它必须继续参与判定 —— 否则一次
    // 真实残留遮挡会先被排除，最终落到「找不到控件」的选择器误导上。
    expect(isSymptom('签到控件被 div.modal-mask 遮挡，尝试关闭遮挡的公告')).toBe(true);
    expect(classifyFailure('签到失败', ['工作流控件被 div.modal-mask 遮挡，尝试关闭遮挡的公告']))
      .toBe(DIAGNOSIS.OBSCURED);
  });
});
