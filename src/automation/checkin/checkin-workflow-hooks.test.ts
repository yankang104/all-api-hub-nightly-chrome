import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SiteConfig } from '@/types';

vi.mock('@/automation/shared/dom-utils', async () => {
  const actual = await vi.importActual<typeof import('@/automation/shared/dom-utils')>('@/automation/shared/dom-utils');
  return {
    ...actual,
    sleep: vi.fn().mockResolvedValue(undefined),
    realClick: vi.fn().mockResolvedValue('dom'),
  };
});

vi.mock('@/automation/balance/balance', () => ({
  captureBalance: vi.fn().mockResolvedValue(null),
  describeMetrics: vi.fn().mockReturnValue(''),
  diffBalance: vi.fn().mockReturnValue({ verdict: 'unknown' }),
  readNewVisibleCheckinRewardObservation: vi.fn().mockReturnValue(null),
  readVisibleCheckinRewardObservation: vi.fn().mockReturnValue(null),
  withVisibleTodayRewardEvidence: vi.fn((metrics: unknown) => metrics),
}));

vi.mock('@/automation/shared/click-safety', () => ({
  clearClickBlocker: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/automation/learning/workflow', () => ({
  runCheckinWorkflow: vi.fn(),
}));

import { performCheckin } from '@/automation/checkin/checkin';
import { runCheckinWorkflow } from '@/automation/learning/workflow';
import { captureBalance, diffBalance } from '@/automation/balance/balance';

const site: SiteConfig = {
  id: 'workflow-hooks',
  name: '学习回放测试站',
  loginUrl: 'https://example.test/login',
  selectors: { username: '#user', password: '#pass', submit: '#submit' },
  closeModalSelectors: [],
  checkin: {
    method: 'workflow',
    workflow: { steps: [{ type: 'click', selector: '#checkin' }] },
  },
};

describe('学习回放的签到结果等待钩子', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('把 whileWaitingForCheckinResult 透传为 whileWaitingForResult', async () => {
    vi.mocked(runCheckinWorkflow).mockResolvedValue({ status: 'success', message: '签到成功' });
    const whileWaitingForCheckinResult = vi.fn().mockResolvedValue({ detected: false, resolved: true });
    const log = { push: vi.fn() };

    const outcome = await performCheckin(site, log, { whileWaitingForCheckinResult });

    expect(outcome).toEqual({ status: 'success', message: '签到成功' });
    expect(runCheckinWorkflow).toHaveBeenCalledOnce();
    const hooks = vi.mocked(runCheckinWorkflow).mock.calls[0]?.[3];
    expect(hooks?.whileWaitingForResult).toBe(whileWaitingForCheckinResult);
  });

  it('未提供该钩子时不伪造字段', async () => {
    vi.mocked(runCheckinWorkflow).mockResolvedValue({ status: 'success', message: '签到成功' });

    await performCheckin(site, { push: vi.fn() });

    const hooks = vi.mocked(runCheckinWorkflow).mock.calls[0]?.[3];
    expect(hooks?.whileWaitingForResult).toBeUndefined();
  });

  it.each([undefined, true] as const)('环境中断 terminal=%s 不采后置余额，也不能因余额变化改判成功', async (terminal) => {
    const interruption = { status: 'interrupted' as const, message: '环境检查中断', ...(terminal ? { terminal } : {}) };
    vi.mocked(runCheckinWorkflow).mockResolvedValue(interruption);
    const workflowCheckpoint = vi.fn().mockResolvedValue(null);
    const saveBalance = vi.fn();
    const result = await performCheckin(site, { push: vi.fn() }, { workflowCheckpoint, saveBalance });
    expect(result).toEqual(interruption);
    expect(vi.mocked(runCheckinWorkflow).mock.calls[0]?.[3]?.checkpoint).toBe(workflowCheckpoint);
    expect(saveBalance).not.toHaveBeenCalled();
    expect(captureBalance).toHaveBeenCalledOnce();
    expect(diffBalance).not.toHaveBeenCalled();
  });
});
