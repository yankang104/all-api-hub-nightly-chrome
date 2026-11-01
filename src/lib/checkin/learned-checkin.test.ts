import { describe, expect, it } from 'vitest';
import type { CheckinConfig } from '@/types';
import { usesCheckinWorkflow, usesSiteSpecificCheckin } from '@/lib/checkin/learned-checkin';
import { LEILEI_SITE_PRESET, VSLLM_SITE_PRESET } from '@/sites';

describe('自动识别与学习回放显式分流', () => {
  it('缺少流程时继续自动识别，旧 workflow 仍交给回放器', () => {
    expect(usesCheckinWorkflow({})).toBe(false);
    expect(usesCheckinWorkflow({ checkin: { method: 'auto' } })).toBe(false);
    expect(usesCheckinWorkflow({ checkin: { method: 'workflow' } })).toBe(true);
  });

  it('自动识别不受旧学习记录影响；只有显式回放才校验/执行它', () => {
    for (const workflow of [{ steps: [{ type: 'click', selector: '#daily' }] }, { steps: [] }, null, {}]) {
      expect(usesCheckinWorkflow({ checkin: { method: 'auto', workflow } as CheckinConfig })).toBe(false);
      expect(usesCheckinWorkflow({ checkin: { workflow } as CheckinConfig })).toBe(false);
      expect(usesCheckinWorkflow({ checkin: { method: 'workflow', workflow } as CheckinConfig })).toBe(true);
    }
  });

  it('旧内部策略不因残留 workflow 字段改变行为', () => {
    for (const method of ['none', 'button', 'api', 'relogin', 'claim'] as const) {
      expect(usesCheckinWorkflow({ checkin: { method, workflow: { steps: [] } } })).toBe(false);
    }
  });
});

describe('专用复合签到流程（学习不能替换）', () => {
  it('一梦五千年模板的签到是专用流程', () => {
    expect(usesSiteSpecificCheckin({ checkin: LEILEI_SITE_PRESET.checkin })).toBe(true);
  });

  /**
   * VSLLM 的专用执行器已删除：读题算答案、按次数循环翻牌、解析充能计数这三项
   * 学习流程都表达不了，也不再需要。模板改成普通按钮流程，因此它不再是
   * 「学习不能替换的专用流程」—— 用户学到的流程应当能正常接管。
   */
  it('VSLLM 已改成普通按钮流程，学习到的流程可以接管', () => {
    expect(usesSiteSpecificCheckin({ checkin: VSLLM_SITE_PRESET.checkin })).toBe(false);
    expect(VSLLM_SITE_PRESET.checkin?.method).toBe('button');
  });

  it('藏在条件分支里的专用步骤同样识别', () => {
    expect(usesSiteSpecificCheckin({
      checkin: {
        method: 'workflow',
        workflow: { steps: [{ type: 'if', condition: { type: 'path', pattern: '/x' }, then: [{ type: 'leilei-daily' }] }] },
      },
    })).toBe(true);
  });

  it('普通学到的流程、或已经不再回放的专用流程不算', () => {
    expect(usesSiteSpecificCheckin({ checkin: { method: 'workflow', workflow: { steps: [{ type: 'click', selector: '#daily' }] } } })).toBe(false);
    expect(usesSiteSpecificCheckin({ checkin: { ...VSLLM_SITE_PRESET.checkin!, method: 'auto' } })).toBe(false);
    expect(usesSiteSpecificCheckin({})).toBe(false);
  });
});
