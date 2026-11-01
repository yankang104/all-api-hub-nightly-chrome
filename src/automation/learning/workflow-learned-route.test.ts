import { afterEach, describe, expect, it } from 'vitest';
import type { SiteConfig } from '@/types';
import { atLearnedCheckinPage, hasLearnedRoute, learnedIdentityPageUrl } from '@/automation/learning/workflow';

/**
 * `hasLearnedRoute` / `atLearnedCheckinPage` 是引擎把「进资料页核对账号」这段内含逻辑
 * 接到学习出来的站点上的判据。学习产物是 `method:'workflow'` + `route`，没有 `entry`，
 * 显示账号的资料页藏在 route 末项里。这两个纯函数的契约必须与 `resolveRoute`
 * 对「终点在哪」的判定一致，因此在这里单独锁死。
 */
const ORIGIN = window.location.origin;

function siteWith(
  route: string[] | undefined,
  method: 'workflow' | 'auto' | 'button' = 'workflow',
): SiteConfig {
  return {
    id: 'site-1',
    name: 'Fixture',
    loginUrl: `${ORIGIN}/sign-in`,
    loginMethod: 'form',
    selectors: { username: '#u', password: '#p', submit: '#s' },
    closeModalSelectors: [],
    checkin: {
      method,
      workflow: {
        steps: [{ type: 'click', selector: '#c' }],
        ...(route ? { route } : {}),
      },
    },
  } as SiteConfig;
}

afterEach(() => {
  history.replaceState({}, '', '/');
});

describe('hasLearnedRoute', () => {
  it('登录即签到只采用新保存的身份路线，旧签到动作不重新启用', () => {
    const site = siteWith(['/console', '/profile']);
    site.checkin!.method = 'none';
    site.checkin!.workflow!.identityPath = '/profile';
    expect(hasLearnedRoute(site)).toBe(false);
    site.checkin!.workflow!.steps = [];
    expect(hasLearnedRoute(site)).toBe(true);
    expect(learnedIdentityPageUrl(site)).toBe(`${ORIGIN}/profile`);
    site.checkin!.workflow!.identityPath = '/outside-route';
    expect(learnedIdentityPageUrl(site)).toBeNull();
  });

  it('method=workflow 且 route 非空同源时为 true', () => {
    expect(hasLearnedRoute(siteWith(['/sign-in', '/profile']))).toBe(true);
  });

  it('自动识别和按钮策略均不受残留 route 影响', () => {
    expect(hasLearnedRoute(siteWith(['/sign-in', '/profile'], 'auto'))).toBe(false);
    expect(hasLearnedRoute(siteWith(['/sign-in', '/profile'], 'button'))).toBe(false);
  });

  it('route 缺失或为空时为 false（老的只有 steps 的学习配置行为不变）', () => {
    expect(hasLearnedRoute(siteWith(undefined))).toBe(false);
    expect(hasLearnedRoute(siteWith([]))).toBe(false);
  });

  it('route 含跨站项时整体作废，返回 false（绝不据此产生外域跳转）', () => {
    expect(hasLearnedRoute(siteWith(['/profile', 'https://evil.example.com/x']))).toBe(false);
  });
});

describe('atLearnedCheckinPage', () => {
  it('当前页等于 route 末项时为 true（该在此核对账号再签到）', () => {
    history.replaceState({}, '', '/profile');
    expect(atLearnedCheckinPage(siteWith(['/sign-in', '/profile']))).toBe(true);
  });

  it('当前页是 route 中间页时为 false（先沿路线走，别在中途下结论）', () => {
    history.replaceState({}, '', '/sign-in');
    expect(atLearnedCheckinPage(siteWith(['/sign-in', '/profile']))).toBe(false);
  });

  it('当前页不在 route 上时为 false', () => {
    history.replaceState({}, '', '/dashboard/overview');
    expect(atLearnedCheckinPage(siteWith(['/sign-in', '/profile']))).toBe(false);
  });

  it('比较 pathname+hash：hash 路由末项精确匹配', () => {
    history.replaceState({}, '', '/#/checkin');
    expect(atLearnedCheckinPage(siteWith(['/#/home', '/#/checkin']))).toBe(true);
    history.replaceState({}, '', '/#/home');
    expect(atLearnedCheckinPage(siteWith(['/#/home', '/#/checkin']))).toBe(false);
  });

  it('没有有效学习路线时为 false', () => {
    history.replaceState({}, '', '/profile');
    expect(atLearnedCheckinPage(siteWith(undefined))).toBe(false);
    expect(atLearnedCheckinPage(siteWith(['/profile'], 'button'))).toBe(false);
  });

  it('自动识别不受旧学习终点的身份页要求影响', () => {
    history.replaceState({}, '', '/profile');
    expect(atLearnedCheckinPage(siteWith(['/console', '/profile'], 'auto'))).toBe(false);
  });
});
