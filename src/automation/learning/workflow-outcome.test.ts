import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALREADY_WORDS, SUCCESS_WORDS } from '@/automation/checkin/checkin-vocab';
import {
  readWorkflowOutcomeEvidence,
  readWorkflowOutcomeEvidenceIn,
  settleWorkflowOutcome,
} from '@/automation/learning/workflow-outcome';

const log = { push: vi.fn() };

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('readWorkflowOutcomeEvidence', () => {
  it('页面显示签到成功时判为 success', () => {
    document.body.innerText = '每日签到 签到成功，今日 +$0.3449';
    expect(readWorkflowOutcomeEvidence()).toMatchObject({ kind: 'success' });
  });

  it('与 checkin-vocab 共用同一套词表，并集里的每个词都能识别', () => {
    // 这两个词是学习侧原来有、checkin-vocab 原来没有的；「已领取」也一样要能识别。
    expect(SUCCESS_WORDS).toEqual(expect.arrayContaining(['奖励到账', '已生效']));
    expect(ALREADY_WORDS).toContain('已领取');

    // 逐个词验证时必须**先清空再设置**：jsdom 的 innerText 是普通属性，
    // 只赋值不清空会把上一轮的文本叠加进来（单独跑碰巧过、全量跑时因别的
    // 用例留下的文本而失败）。同时只断言「包含该词」，不要求 words 恰好
    // 只有它 —— 词表里存在互为子串/同时命中的词时，数组长度本就不该被写死。
    for (const word of SUCCESS_WORDS) {
      document.body.textContent = '';
      document.body.innerText = word;
      expect(readWorkflowOutcomeEvidence()).toMatchObject({ kind: 'success' });
      expect(readWorkflowOutcomeEvidence()).toMatchObject({ words: expect.arrayContaining([word]) });
    }
    for (const word of ALREADY_WORDS) {
      document.body.textContent = '';
      document.body.innerText = word;
      expect(readWorkflowOutcomeEvidence()).toMatchObject({ kind: 'already' });
      expect(readWorkflowOutcomeEvidence()).toMatchObject({ words: expect.arrayContaining([word]) });
    }
  });

  it('范围读取只认给定子树里的证据，侧栏的「今日已签到」不算目标区域的证据', () => {
    document.body.innerHTML = [
      '<aside><span>今日已签到</span></aside>',
      '<main><section id="card"><button>签到</button></section></main>',
    ].join('');
    // jsdom 没有 innerText：与既有用例一致，直接给出整页可见文本。
    document.body.innerText = '今日已签到 签到';
    const card = document.querySelector('#card')!;

    expect(readWorkflowOutcomeEvidenceIn(card)).toEqual({ kind: 'unknown' });
    // 不传范围时仍是整页语义，既有调用方行为不变。
    expect(readWorkflowOutcomeEvidence()).toMatchObject({ kind: 'already' });
  });

  it('范围读取在目标卡片内读到 already 证据时仍然判 already', () => {
    document.body.innerHTML = [
      '<aside><span>今日已签到</span></aside>',
      '<main><section id="card"><div>今日已签到 奖励 190</div></section></main>',
    ].join('');
    const card = document.querySelector('#card')!;

    expect(readWorkflowOutcomeEvidenceIn(card)).toMatchObject({ kind: 'already' });
  });

  it('范围读取同样先判 success 再判 already', () => {
    document.body.innerHTML = '<section id="card">签到成功 已签到</section>';
    const card = document.querySelector('#card')!;

    expect(readWorkflowOutcomeEvidenceIn(card)).toMatchObject({ kind: 'success' });
  });

  it('页面同时出现成功提示与「已签到」按钮时，优先判成功', () => {
    // 真实站点签完会同时出现两者。先判 already 会把这次成功降级成「之前就签过了」，
    // 奖励归因就错了。
    document.body.innerText = '签到成功 已签到 今天 +$0.3449';
    expect(readWorkflowOutcomeEvidence()).toMatchObject({ kind: 'success' });
  });

  it('只有「已签到」时判为 already', () => {
    document.body.innerText = '每日签到 已签到 累计签到 29';
    expect(readWorkflowOutcomeEvidence()).toMatchObject({ kind: 'already' });
  });

  it('页面上没有任何结果证据时判为 unknown，不猜', () => {
    document.body.innerText = '控制台 概览 个人资料 退出登录';
    expect(readWorkflowOutcomeEvidence()).toEqual({ kind: 'unknown' });
  });
});

describe('settleWorkflowOutcome', () => {
  it('读不到证据时返回 unknown，绝不假装成功', () => {
    // 这是用户报的「一直卡在核对」：步骤跑完就宣告「工作流步骤已完成」，
    // 而页面其实什么都没发生。假装成功会掩盖真正的失败。
    const result = settleWorkflowOutcome({ kind: 'unknown' }, log);

    expect(result.status).toBe('unknown');
    expect(result.message).not.toContain('成功');
    expect(log.push).toHaveBeenCalledWith(expect.stringContaining('没有出现签到成功或已签到的证据'));
  });

  it('有成功证据时如实报告成功', () => {
    const result = settleWorkflowOutcome({ kind: 'success', words: ['签到成功'] }, log);

    expect(result.status).toBe('success');
    expect(result.message).toContain('成功');
  });

  it('有已完成证据时报告 already 而不是 success', () => {
    const result = settleWorkflowOutcome({ kind: 'already', words: ['已签到'] }, log);

    expect(result.status).toBe('already');
  });
});
