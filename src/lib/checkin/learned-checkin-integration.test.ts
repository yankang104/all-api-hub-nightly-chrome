import { describe, expect, it } from 'vitest';
import type { CheckinWorkflowConfig, SiteConfig } from '@/types';
import { migrateLegacySiteDefaults } from '@/data/app-repository';
import { usesCheckinWorkflow } from '@/lib/checkin/learned-checkin';
import { BUILTIN_SITES, mergeBuiltinSite } from '@/sites';
import { validateSiteConfig } from '@/lib/site/site-security';

const workflow: CheckinWorkflowConfig = {
  route: ['/console', '/console/personal'],
  steps: [{ type: 'click', selector: '#daily' }, { type: 'assert', text: ['签到成功'] }],
};
const site: SiteConfig = {
  id: 'learned-site', name: '已学习站点', loginUrl: 'https://example.com/login',
  selectors: { username: '#u', password: '#p', submit: '#submit' },
  closeModalSelectors: [],
  checkin: { method: 'auto', workflow },
};

const learnedWorkflow: CheckinWorkflowConfig = {
  route: ['/profile'],
  identityPath: '/profile',
  steps: [{ type: 'click', selector: '#daily' }, { type: 'assert', text: ['签到成功'] }],
};

describe('旧版 auto + 学习流程兼容迁移', () => {
  it('完整学习流程从 auto 迁到 workflow，升级后仍按学习路线回放', () => {
    const legacy: SiteConfig = {
      ...site,
      checkin: { method: 'auto', workflow: learnedWorkflow },
    };
    const [migrated] = migrateLegacySiteDefaults([legacy]);
    expect(migrated?.checkin?.method).toBe('workflow');
    expect(migrated?.checkin?.workflow).toEqual(learnedWorkflow);
    expect(usesCheckinWorkflow(migrated!)).toBe(true);
  });

  it('用户明确选择自动识别后，兼容迁移不覆盖该选择', () => {
    const explicitAuto: SiteConfig = {
      ...site,
      checkin: {
        method: 'auto',
        workflow: learnedWorkflow,
        workflowReplayDisabled: true,
      },
    };
    const [migrated] = migrateLegacySiteDefaults([explicitAuto]);
    expect(migrated?.checkin?.method).toBe('auto');
    expect(usesCheckinWorkflow(migrated!)).toBe(false);
  });

  it('缺少身份页或空步骤的历史记录保持 auto，避免迁移后无法回放', () => {
    const noIdentity: SiteConfig = {
      ...site,
      checkin: {
        method: 'auto',
        workflow: { steps: learnedWorkflow.steps, route: ['/profile'] },
      },
    };
    const emptySteps: SiteConfig = {
      ...site,
      checkin: { method: 'auto', workflow: { ...learnedWorkflow, steps: [] } },
    };
    expect(migrateLegacySiteDefaults([noIdentity])[0]?.checkin?.method).toBe('auto');
    expect(migrateLegacySiteDefaults([emptySteps])[0]?.checkin?.method).toBe('auto');
  });

  it('内置站点上的学习流程优先保留，不会被旧模板迁移覆盖', () => {
    const custom: SiteConfig = {
      ...site,
      id: 'builtin-futurehub',
      loginUrl: 'https://api.futureppo.top/login',
      checkin: { method: 'auto', workflow: learnedWorkflow },
    };
    const [migrated] = migrateLegacySiteDefaults([custom]);
    expect(migrated?.checkin?.method).toBe('workflow');
    expect(migrated?.checkin?.workflow).toEqual(learnedWorkflow);
  });
});

describe('显式启用已保存签到流程', () => {
  it('启用回放时拒绝空流程与跨站路线；自动识别不执行也不受旧记录影响', () => {
    expect(validateSiteConfig(site)).toEqual([]);
    for (const broken of [{ steps: [] }, { ...workflow, route: ['https://other.example/checkin'] }]) {
      expect(validateSiteConfig({ ...site, checkin: { method: 'workflow', workflow: broken } }).length).toBeGreaterThan(0);
      expect(validateSiteConfig({ ...site, checkin: { method: 'auto', workflow: broken } })).toEqual([]);
    }
  });

  it('仅显式回放可忽略旧入口；自动模式仍需校验自己的入口', () => {
    const entry = { readySelector: '', steps: [] };
    expect(validateSiteConfig({ ...site, checkin: {
      method: 'workflow', workflow, entry,
    } })).toEqual([]);
    expect(validateSiteConfig({ ...site, checkin: {
      method: 'auto', workflow, entry,
    } }).length).toBeGreaterThan(0);
  });

  it('旧手工工作流没有路线时仍校验其签到入口', () => {
    expect(validateSiteConfig({ ...site, checkin: {
      method: 'workflow', workflow: { steps: workflow.steps },
      entry: { readySelector: '', steps: [] },
    } }).some((error) => error.includes('签到入口'))).toBe(true);
  });

  it.each([
    ['builtin-futurehub', 'https://api.futureppo.top/login'],
    ['builtin-anyrouter', 'https://anyrouter.top/login'],
  ])('%s 的内置合并和旧数据迁移保留新学习流程', (id, loginUrl) => {
    const custom: SiteConfig = { ...site, id, loginUrl };
    const builtin = BUILTIN_SITES.find((item) => item.id === id)!;
    const merged = mergeBuiltinSite(builtin, custom);
    expect(merged.checkin?.method).toBe('auto');
    expect(merged.checkin?.workflow).toEqual(workflow);

    const [migrated] = migrateLegacySiteDefaults([{ ...custom, id: `user-${id}` }]);
    expect(migrated).toBeDefined();
    if (!migrated) throw new Error('迁移丢失了已学习的站点');
    expect(migrated.checkin?.method).toBe('auto');
    expect(migrated.checkin?.workflow).toEqual(workflow);

    const corrupt = { ...custom, checkin: { method: 'auto' as const, workflow: null as unknown as CheckinWorkflowConfig } };
    expect(mergeBuiltinSite(builtin, corrupt).checkin?.workflow).toBeNull();
    expect(migrateLegacySiteDefaults([corrupt])[0]?.checkin?.workflow).toBeNull();
  });
});
