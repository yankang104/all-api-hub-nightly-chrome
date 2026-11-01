import { describe, expect, it } from 'vitest';
import type { CheckinMethod } from '@/types';
import { decideFreshLoginCheckin } from './checkin-policy';

/** 与 checkin.ts 的 CHECKIN_METHODS 保持一致：新增签到方式时这里要一起补。 */
const ALL_METHODS: CheckinMethod[] = ['auto', 'none', 'button', 'api', 'relogin', 'claim', 'workflow'];
/** 除 relogin 外的方式，全新登录后都应照原方式跑。 */
const NON_RELOGIN: CheckinMethod[] = ALL_METHODS.filter((m) => m !== 'relogin');

describe('decideFreshLoginCheckin', () => {
  it('relogin + 本轮全新登录 → 登录即签到（压成 none，不再退出重登）', () => {
    // Agent Router 系的核心修复：奖励靠一次登录发放，本轮已经全新登录过，
    // 再走 relogin 的退出重登就是多余的第二次登录。
    expect(decideFreshLoginCheckin({ checkinMethod: 'relogin', freshLogin: true }))
      .toEqual({ action: 'login-as-checkin', overrideMethod: 'none', reason: 'fresh-login-earned-reward' });
  });

  it('relogin + 非全新登录（打开时本来就已登录）→ 照常退出重登', () => {
    // 这一轮访问不会触发发奖励，必须靠退出重登才能拿到，relogin 正是为此存在。
    expect(decideFreshLoginCheckin({ checkinMethod: 'relogin', freshLogin: false }))
      .toEqual({ action: 'run-configured-method', reason: 'not-fresh-login' });
  });

  describe('非 relogin 的方式不受影响', () => {
    it('全新登录后仍照原方式跑（none/button/api/claim/auto/workflow）', () => {
      // 短路只针对 relogin；其它方式在全新登录后本就该照常执行。
      for (const method of NON_RELOGIN) {
        expect(decideFreshLoginCheckin({ checkinMethod: method, freshLogin: true }), method)
          .toEqual({ action: 'run-configured-method', reason: 'not-relogin' });
      }
    });

    it('非全新登录时也照原方式跑', () => {
      for (const method of NON_RELOGIN) {
        expect(decideFreshLoginCheckin({ checkinMethod: method, freshLogin: false }), method)
          .toEqual({ action: 'run-configured-method', reason: 'not-relogin' });
      }
    });
  });

  it('只有 relogin + freshLogin 这一个组合会短路成登录即签到', () => {
    // 穷举完整决策表：任何其它组合都不得压成 none，否则会漏签或改错别的方式。
    for (const method of ALL_METHODS) {
      for (const freshLogin of [true, false]) {
        const decision = decideFreshLoginCheckin({ checkinMethod: method, freshLogin });
        const shouldShortCircuit = method === 'relogin' && freshLogin;
        expect(decision.action === 'login-as-checkin', `${method}/${freshLogin}`).toBe(shouldShortCircuit);
      }
    }
  });
});
