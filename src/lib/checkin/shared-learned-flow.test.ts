import { describe, expect, it } from 'vitest';
import type { SiteConfig } from '@/types';
import {
  inheritSameOriginRecognition,
  learnedCheckinForSameOriginCard,
  resolveSharedLearnedCheckin,
} from '@/lib/checkin/shared-learned-flow';
import { VSLLM_SITE_PRESET } from '@/sites';

const learned = {
  method: 'workflow' as const,
  workflow: {
    steps: [{ type: 'click' as const, selector: '#daily' }],
    route: ['/profile'],
    identityPath: '/profile',
  },
};

function card(id: string, overrides: Partial<SiteConfig> = {}): SiteConfig {
  return {
    id,
    name: id,
    loginUrl: 'https://same.example/login',
    selectors: { username: '#u', password: '#p', submit: '#s' },
    closeModalSelectors: [],
    checkin: { method: 'auto' },
    ...overrides,
  };
}

describe('同一域名的多张站点卡共用一份学到的流程', () => {
  it('没学过的卡片借用同域卡片上学到的流程，登录配置仍用自己的', () => {
    const donor = card('donor', { checkin: learned, selectors: { username: '#a', password: '#b', submit: '#c' } });
    const target = card('target');

    const resolved = resolveSharedLearnedCheckin(target, [donor, target]);

    expect(resolved.sharedFrom?.id).toBe('donor');
    expect(resolved.site.checkin).toEqual(learned);
    expect(resolved.site.selectors).toEqual(target.selectors);
    expect(resolved.site.id).toBe('target');
  });

  it('自己学过的卡片永远用自己的', () => {
    const own = { ...learned, workflow: { ...learned.workflow, steps: [{ type: 'click' as const, selector: '#mine' }] } };
    const target = card('target', { checkin: own });

    const resolved = resolveSharedLearnedCheckin(target, [card('donor', { checkin: learned }), target]);

    expect(resolved.sharedFrom).toBeUndefined();
    expect(resolved.site.checkin).toBe(own);
  });

  it.each([
    ['按钮签到', { method: 'button' as const, buttonSelector: '#btn' }],
    ['登录即签到', { method: 'none' as const }],
    ['显式切回自动识别（停用回放）', { method: 'auto' as const, workflowReplayDisabled: true }],
  ])('用户明确选了别的方式（%s）时不借', (_label, checkin) => {
    const target = card('target', { checkin });
    expect(resolveSharedLearnedCheckin(target, [card('donor', { checkin: learned }), target]).sharedFrom).toBeUndefined();
  });

  it('同域卡片学到的是「登录即签到」时同样共用', () => {
    const loginAsCheckin = { method: 'none' as const, learnedLoginAsCheckin: true };
    const target = card('target');
    const resolved = resolveSharedLearnedCheckin(target, [card('donor', { checkin: loginAsCheckin }), target]);
    expect(resolved.site.checkin).toEqual(loginAsCheckin);
  });

  it('不同域名、或同域卡片的流程已停用时不借', () => {
    const otherOrigin = card('other', { loginUrl: 'https://other.example/login', checkin: learned });
    const disabled = card('disabled', { checkin: { ...learned, method: 'auto', workflowReplayDisabled: true } });
    const target = card('target');

    expect(resolveSharedLearnedCheckin(target, [otherOrigin, disabled, target]).sharedFrom).toBeUndefined();
  });
});

describe('学完一张卡后，同域其它卡跟着换成新流程', () => {
  const fresh = {
    method: 'workflow' as const,
    workflow: { steps: [{ type: 'click' as const, selector: '#new' }], route: ['/checkin'], identityPath: '/checkin' },
    workflowReplayDisabled: false,
  };

  it('也在回放旧学习流程的卡：换成新流程，清掉旧入口', () => {
    const stale = card('stale', { checkin: { ...learned, url: '/old', entry: { steps: [{ selector: '#x' }], readySelector: '#y' } } });
    const next = learnedCheckinForSameOriginCard(stale, fresh);
    expect(next).toEqual({ method: 'workflow', workflow: fresh.workflow, workflowReplayDisabled: false });
  });

  it('原来是学到的登录即签到、这次学成回放：一起改成回放', () => {
    const next = learnedCheckinForSameOriginCard(card('x', { checkin: { method: 'none', learnedLoginAsCheckin: true } }), fresh);
    expect(next?.method).toBe('workflow');
    expect(next?.workflow).toEqual(fresh.workflow);
  });

  it('这次学到的是登录即签到：整块替换', () => {
    const loginAsCheckin = { method: 'none' as const, learnedLoginAsCheckin: true };
    expect(learnedCheckinForSameOriginCard(card('x', { checkin: learned }), loginAsCheckin)).toEqual(loginAsCheckin);
  });

  it.each([
    ['还在自动识别（运行时会借用，不必写）', { method: 'auto' as const }],
    ['用户选的按钮签到', { method: 'button' as const, buttonSelector: '#btn' }],
    ['显式停用回放', { ...learned, method: 'auto' as const, workflowReplayDisabled: true }],
    ['模板写死的专用复合流程', VSLLM_SITE_PRESET.checkin!],
  ])('%s：不动', (_label, checkin) => {
    expect(learnedCheckinForSameOriginCard(card('x', { checkin }), fresh)).toBeNull();
  });
});

describe('同一域名的重复卡片补齐站点识别信息', () => {
  const adapter = { siteType: 'new-api' as const, family: 'new-api' as const, checkinPath: '/console/personal', userId: '42' };

  it('空白卡片借用同域卡片的登录成功标志与站点系统，不带账号级 userId', () => {
    const donor = card('donor', { name: '模板卡', successIndicator: 'a[href="/console/token"]', adapter });
    const target = card('target', { loginUrl: 'https://same.example/console' });

    const resolved = inheritSameOriginRecognition(target, [donor, target]);

    expect(resolved.site.successIndicator).toBe('a[href="/console/token"]');
    expect(resolved.site.adapter).toEqual({ siteType: 'new-api', family: 'new-api', checkinPath: '/console/personal' });
    expect(resolved.site.adapter).not.toHaveProperty('userId');
    expect(resolved.site.id).toBe('target');
    expect(resolved.site.selectors).toEqual(target.selectors);
    expect(resolved.borrowed.map((item) => [item.field, item.from.id])).toEqual([
      ['successIndicator', 'donor'],
      ['adapter', 'donor'],
    ]);
  });

  it('已填的值一律不覆盖', () => {
    const donor = card('donor', { successIndicator: '#donor', adapter });
    const target = card('target', { successIndicator: '#mine', adapter: { checkinPath: '' } });

    const resolved = inheritSameOriginRecognition(target, [donor]);

    expect(resolved.site).toBe(target);
    expect(resolved.borrowed).toEqual([]);
  });

  it('只看同一 origin：别的域名的卡片不借', () => {
    const other = card('other', { loginUrl: 'https://other.example/login', successIndicator: '#other', adapter });
    const resolved = inheritSameOriginRecognition(card('target'), [other]);

    expect(resolved.site.successIndicator).toBeUndefined();
    expect(resolved.site.adapter).toBeUndefined();
    expect(resolved.borrowed).toEqual([]);
  });

  it('同域卡片也没有可借的值：原样返回', () => {
    const target = card('target');
    const resolved = inheritSameOriginRecognition(target, [card('blank', { successIndicator: '  ', adapter: { checkinPath: '/x' } })]);

    expect(resolved.site).toBe(target);
    expect(resolved.borrowed).toEqual([]);
  });
});
