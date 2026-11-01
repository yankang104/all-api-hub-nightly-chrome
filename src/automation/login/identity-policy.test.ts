import { describe, expect, it } from 'vitest';
import type { LoginMethod } from '@/types';
import { decideIdentityAction, isExternalIdentityLogin } from '@/automation/login/identity-policy';

const ALL_METHODS: LoginMethod[] = ['form', 'auto', 'token', 'oauth', 'github', 'passkey'];
const EXTERNAL: LoginMethod[] = ['oauth', 'github', 'passkey'];
const OWNED: LoginMethod[] = ['form', 'auto', 'token'];

describe('isExternalIdentityLogin', () => {
  it('oauth / github / passkey 的凭据都在扩展之外', () => {
    for (const method of EXTERNAL) expect(isExternalIdentityLogin(method), method).toBe(true);
  });

  it('账密与 token 由扩展持有凭据', () => {
    for (const method of OWNED) expect(isExternalIdentityLogin(method), method).toBe(false);
  });
});

describe('decideIdentityAction', () => {
  it('本轮旧确认不能覆盖新的明确错号', () => {
    expect(decideIdentityAction({ loginMethod: 'form', verdict: 'mismatch', identityConfirmedThisRun: true }))
      .toEqual({ action: 'switch-account', reason: 'mismatch' });
    expect(decideIdentityAction({ loginMethod: 'oauth', verdict: 'mismatch', identityConfirmedThisRun: true }))
      .toEqual({ action: 'handoff', reason: 'mismatch-external' });
  });
  it('本轮已亲自登录过时直接继续，不再核对', () => {
    // SharedChat 只有 HttpOnly cookie，页面/接口都读不到用户名；没有这条捷径
    // 会在登录页与领取页之间来回重登，永远走不到领取那一步。
    for (const method of ALL_METHODS) {
      const decision = decideIdentityAction({ loginMethod: method, verdict: 'unknown', identityConfirmedThisRun: true });
      expect(decision, method).toEqual({ action: 'proceed', reason: 'already-confirmed-this-run' });
    }
  });

  it('身份确认一致时所有登录方式都继续', () => {
    for (const method of ALL_METHODS) {
      expect(decideIdentityAction({ loginMethod: method, verdict: 'confirmed' }), method)
        .toEqual({ action: 'proceed', reason: 'confirmed' });
    }
  });

  describe('账号不符', () => {
    it('没有受控切号能力的第三方身份登录交给用户', () => {
      for (const method of EXTERNAL) {
        expect(decideIdentityAction({ loginMethod: method, verdict: 'mismatch' }), method)
          .toEqual({ action: 'handoff', reason: 'mismatch-external' });
      }
    });

    it('保存了专用凭据的 GitHub 登录自动退出并切换账号', () => {
      expect(decideIdentityAction({
        loginMethod: 'github', verdict: 'mismatch', canSwitchAccount: true,
      })).toEqual({ action: 'switch-account', reason: 'mismatch' });
    });

    it('扩展持有凭据时退出重登', () => {
      for (const method of OWNED) {
        expect(decideIdentityAction({ loginMethod: method, verdict: 'mismatch' }), method)
          .toEqual({ action: 'switch-account', reason: 'mismatch' });
      }
    });
  });

  /**
   * 「先去签到页再核对」。
   *
   * 修的是一个真实矛盾：新版 new-api 界面（1412）的落地页读不到身份，日志写
   * 「读不到可核对的身份，但本站只有该账号，继续签到」，两步之后到了 /profile
   * 却写「已核对账号身份：用户 ID 436 一致」—— 闸门开在了信息最少的那一页。
   * 单账号站因此靠空理由放行，多账号站更糟：白白停下来要人工确认。
   */
  describe('读不到身份，但签到页读得到', () => {
    const deferrable = {
      verdict: 'unknown' as const,
      checkinPageAvailable: true,
    };

    it('先去签到页再判，不在落地页用弱规则拍板', () => {
      for (const method of EXTERNAL) {
        expect(decideIdentityAction({ loginMethod: method, ...deferrable, siteAccountCount: 1 }), method)
          .toEqual({ action: 'defer-to-checkin-page', reason: 'identity-visible-on-checkin-page' });
      }
    });

    it('多账号站点同样先去签到页，而不是停下来要人工确认', () => {
      // 这是延后带来的实际收益：以前这里直接 handoff，而答案就在签到页上
      for (const method of EXTERNAL) {
        expect(decideIdentityAction({ loginMethod: method, ...deferrable, siteAccountCount: 5 }), method)
          .toEqual({ action: 'defer-to-checkin-page', reason: 'identity-visible-on-checkin-page' });
      }
    });

    it('从没存过 userId 时也先去签到页，但签到页必须按账号名核对', () => {
      // 旧签到页逻辑会把首次看到的身份直接绑定，因此过去也不安全；现在签到页
      // 自身有严格闸门，可以安全导航过去读取更多证据。
      expect(decideIdentityAction({
        loginMethod: 'github', verdict: 'unknown', checkinPageAvailable: true, siteAccountCount: 5,
      })).toEqual({ action: 'defer-to-checkin-page', reason: 'identity-visible-on-checkin-page' });
    });

    it('没有别的签到页可去时不延后，否则原地打转', () => {
      expect(decideIdentityAction({
        loginMethod: 'github', verdict: 'unknown', checkinPageAvailable: false, siteAccountCount: 5,
      })).toEqual({ action: 'handoff', reason: 'unknown-multi-account' });
    });

    it('受管 GitHub 在签到页仍读不到身份时自动切号', () => {
      expect(decideIdentityAction({
        loginMethod: 'github',
        verdict: 'unknown',
        checkinPageAvailable: false,
        siteAccountCount: 5,
        canSwitchAccount: true,
      })).toEqual({ action: 'switch-account', reason: 'unknown' });
    });

    it('已确认是别人的账号时绝不延后 —— 那是明确结论，跳一页也不会变', () => {
      for (const method of EXTERNAL) {
        expect(decideIdentityAction({ loginMethod: method, verdict: 'mismatch', checkinPageAvailable: true }), method)
          .toEqual({ action: 'handoff', reason: 'mismatch-external' });
      }
    });

    it('扩展持有凭据的方式同样先去签到页核对，不再先销毁会话', () => {
      // 旧版这里断言 switch-account（读不到身份就立刻清 Cookie 重登），理由是
      // 「form/auto/token 能真的切账号」。能切 ≠ 该切：先把有效会话销毁，等于拿
      // 一轮完整登录换一个「也许根本不需要换号」的结论 —— 用户日志里被清掉的
      // 正是一个紧接着就在 /profile 上核对成功的会话。
      // 现在改为先跳签到页（纯只读导航）。安全结论没有被跳过：签到页那道硬核对
      // 仍会挡住不符的会话，真不匹配时在那里给出 switch-account / handoff。
      for (const method of OWNED) {
        for (const count of [1, 3]) {
          expect(
            decideIdentityAction({ loginMethod: method, ...deferrable, siteAccountCount: count }),
            `${method}/${count}`,
          ).toEqual({ action: 'defer-to-checkin-page', reason: 'identity-visible-on-checkin-page' });
        }
      }
    });

    it('多账号 + 有签到页 → 先去核对，但「延后」绝不等于放行', () => {
      // 锁死安全底线：延后只是把判断挪到证据更多的那一页，任何登录方式、
      // 任何账号数下都不允许变成 proceed。
      for (const method of ALL_METHODS) {
        const decision = decideIdentityAction({
          loginMethod: method, verdict: 'unknown', checkinPageAvailable: true, siteAccountCount: 4,
        });
        expect(decision, method)
          .toEqual({ action: 'defer-to-checkin-page', reason: 'identity-visible-on-checkin-page' });
        expect(decision.action, method).not.toBe('proceed');
      }
    });

    it('用户日志场景：form 登录 + 有签到页 → 先核对，不许无条件清会话重登', () => {
      // 日志原文：「命中登录成功证据，已处于登录状态 / 无法确认当前登录身份
      // （读不到当前登录身份），按切换账号处理 / 已清除本站浏览器 Cookie 2 项」，
      // 而末尾「进入签到页: /profile」——说明身份本可以在签到页核对。
      expect(decideIdentityAction({
        loginMethod: 'form', verdict: 'unknown', checkinPageAvailable: true, siteAccountCount: 2,
      })).toEqual({ action: 'defer-to-checkin-page', reason: 'identity-visible-on-checkin-page' });
    });

    it('本轮已亲自登录过时优先走捷径，不延后', () => {
      expect(decideIdentityAction({ loginMethod: 'github', ...deferrable, identityConfirmedThisRun: true }))
        .toEqual({ action: 'proceed', reason: 'already-confirmed-this-run' });
    });
  });

  describe('读不到身份', () => {
    it('多账号站点必须交给用户确认，不得盲签', () => {
      // 这是本次修复的核心：读不到身份就直接签，等于把身份核对关掉，
      // 浏览器里登着别的账号时会把签到记到错的账号头上。
      for (const method of EXTERNAL) {
        expect(decideIdentityAction({ loginMethod: method, verdict: 'unknown', siteAccountCount: 2 }), method)
          .toEqual({ action: 'handoff', reason: 'unknown-multi-account' });
      }
    });

    it('本站只有一个账号时继续 —— 不存在记错账的可能', () => {
      for (const method of EXTERNAL) {
        expect(decideIdentityAction({ loginMethod: method, verdict: 'unknown', siteAccountCount: 1 }), method)
          .toEqual({ action: 'proceed', reason: 'single-account' });
      }
    });

    it('账号数未知时按「可能有多个」保守处理', () => {
      // background 没下发这个数（旧版本任务、字段丢失）时不能默认放行
      for (const method of EXTERNAL) {
        expect(decideIdentityAction({ loginMethod: method, verdict: 'unknown' }), method)
          .toEqual({ action: 'handoff', reason: 'unknown-multi-account' });
      }
    });

    it('零账号也不放行 —— 只有恰好一个才安全', () => {
      expect(decideIdentityAction({ loginMethod: 'github', verdict: 'unknown', siteAccountCount: 0 }))
        .toEqual({ action: 'handoff', reason: 'unknown-multi-account' });
    });

    it('本站只有一个账号时，扩展持有凭据的方式也不折腾', () => {
      // 旧版这里断言 form/auto/token 在单账号站也 switch-account。改的理由不是
      // 「放宽」，而是与第三方登录用**同一把尺子**：`single-account` 的语义是
      // 「本站只配了这一个账号，不存在记错账的可能」，它只取决于账号数，不取决于
      // 登录方式。外部登录早就靠它放行（见上一条），而 form/auto/token 却要先清
      // Cookie 再重登同一个账号 —— 白付一轮登录，还可能被验证码/退出接口卡住。
      // 下面那条测试锁死底线：账号数不是「恰好一个」时一律不 proceed。
      for (const method of OWNED) {
        expect(decideIdentityAction({ loginMethod: method, verdict: 'unknown', siteAccountCount: 1 }), method)
          .toEqual({ action: 'proceed', reason: 'single-account' });
      }
    });

    it('多账号或账号数未知时，扩展持有凭据的方式仍保守重登', () => {
      // 这才是「确实可能给错账号签到」的情形：清会话重登是对的，保留不动。
      for (const method of OWNED) {
        for (const count of [undefined, 0, 2]) {
          expect(
            decideIdentityAction({ loginMethod: method, verdict: 'unknown', siteAccountCount: count }),
            `${method}/${count}`,
          ).toEqual({ action: 'switch-account', reason: 'unknown' });
        }
      }
    });
  });

  it('未保存受管凭据的第三方身份登录不会走 switch-account', () => {
    const verdicts = ['confirmed', 'mismatch', 'unknown'] as const;
    for (const method of EXTERNAL) {
      for (const verdict of verdicts) {
        for (const count of [undefined, 0, 1, 3]) {
          const decision = decideIdentityAction({ loginMethod: method, verdict, siteAccountCount: count });
          expect(decision.action, `${method}/${verdict}/${count}`).not.toBe('switch-account');
        }
      }
    }
  });

  it('受管切号能力只改变不匹配或最终未知的决策，不绕过身份确认', () => {
    expect(decideIdentityAction({
      loginMethod: 'github', verdict: 'confirmed', canSwitchAccount: true,
    })).toEqual({ action: 'proceed', reason: 'confirmed' });
    expect(decideIdentityAction({
      loginMethod: 'github', verdict: 'unknown', siteAccountCount: 3, canSwitchAccount: true,
    })).toEqual({ action: 'switch-account', reason: 'unknown' });
    expect(decideIdentityAction({
      loginMethod: 'oauth', verdict: 'mismatch', canSwitchAccount: false,
    })).toEqual({ action: 'handoff', reason: 'mismatch-external' });
    expect(decideIdentityAction({
      loginMethod: 'passkey', verdict: 'mismatch', canSwitchAccount: false,
    })).toEqual({ action: 'handoff', reason: 'mismatch-external' });
  });

  it('多账号站点读不到身份时，任何登录方式都不会静默继续', () => {
    for (const method of ALL_METHODS) {
      const decision = decideIdentityAction({ loginMethod: method, verdict: 'unknown', siteAccountCount: 4 });
      expect(decision.action, method).not.toBe('proceed');
    }
  });

  /**
   * 底线的不变量：把输入笛卡尔积全跑一遍，`proceed` 只允许出现在三个出口 ——
   * 1) 明确 confirmed；2) 本轮亲自登录过；3) `siteAccountCount === 1`
   * （不存在记错账的可能）。除此之外，读不到身份时在任何登录方式、任何账号数、
   * 任何可用手段下都不许放行 —— 这是本次重排策略顺序时唯一被放宽的地方
   * （single-account 现在也覆盖 form/auto/token），其余全部保持或更保守。
   */
  it('不变量：读不到身份时，只有「恰好一个账号」才可能继续', () => {
    for (const method of ALL_METHODS) {
      for (const count of [undefined, 0, 1, 2, 4]) {
        for (const checkinPageAvailable of [false, true]) {
          for (const canSwitchAccount of [false, true]) {
            const decision = decideIdentityAction({
              loginMethod: method, verdict: 'unknown', siteAccountCount: count,
              checkinPageAvailable, canSwitchAccount,
            });
            const label = `${method}/${count}/${checkinPageAvailable}/${canSwitchAccount}`;
            if (decision.action === 'proceed') {
              expect(decision.reason, label).toBe('single-account');
              expect(count, label).toBe(1);
              expect(checkinPageAvailable, label).toBe(false);
              expect(canSwitchAccount, label).toBe(false);
            } else {
              // 不能继续时必须是「停下/重登/先去核对」，不存在第四种结果。
              expect(['switch-account', 'handoff', 'defer-to-checkin-page'], label)
                .toContain(decision.action);
            }
          }
        }
      }
    }
  });

  it('不变量：confirmed 永远继续，mismatch 永远不继续', () => {
    for (const method of ALL_METHODS) {
      for (const count of [undefined, 0, 1, 2, 4]) {
        for (const checkinPageAvailable of [false, true]) {
          for (const canSwitchAccount of [false, true]) {
            const label = `${method}/${count}/${checkinPageAvailable}/${canSwitchAccount}`;
            expect(decideIdentityAction({
              loginMethod: method, verdict: 'confirmed', siteAccountCount: count,
              checkinPageAvailable, canSwitchAccount,
            }), label).toEqual({ action: 'proceed', reason: 'confirmed' });

            const mismatch = decideIdentityAction({
              loginMethod: method, verdict: 'mismatch', siteAccountCount: count,
              checkinPageAvailable, canSwitchAccount,
            });
            expect(mismatch.action, label).not.toBe('proceed');
            expect(mismatch.action, label).not.toBe('defer-to-checkin-page');
          }
        }
      }
    }
  });
});
