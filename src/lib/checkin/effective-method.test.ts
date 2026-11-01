import { describe, expect, it } from 'vitest';
import { classifyFailure, DIAGNOSIS, isSymptom } from '@/automation/shared/diagnostics';
import {
  describeEffectiveMethods,
  loginCredentialNeeds,
  resolveEffectiveMethods,
} from '@/lib/checkin/effective-method';
import type { Account, CheckinMethod, LoginMethod, SiteConfig } from '@/types';

function account(over: Partial<Account> = {}): Pick<Account, 'loginMethod'> {
  return { loginMethod: over.loginMethod };
}

function site(
  loginMethod?: LoginMethod,
  checkinMethod?: CheckinMethod,
): Pick<SiteConfig, 'loginMethod' | 'checkin'> {
  return {
    loginMethod,
    checkin: checkinMethod ? { method: checkinMethod } : undefined,
  };
}

describe('resolveEffectiveMethods', () => {
  it('账号级登录方式覆盖站点级，签到方式仍由站点决定', () => {
    const methods = resolveEffectiveMethods(account({ loginMethod: 'token' }), site('form', 'button'));
    expect(methods.loginMethod).toBe('token');
    expect(methods.loginMethodSource).toBe('账号级');
    expect(methods.checkinMethod).toBe('button');
  });

  it('GitHub 账号登录成功后仍执行站点配置的按钮签到', () => {
    const methods = resolveEffectiveMethods(
      { loginMethod: 'github', githubUsername: 'demo104', githubPassword: 'secret' },
      site('auto', 'button'),
    );
    expect(methods.loginMethod).toBe('github');
    expect(methods.loginMethodSource).toBe('账号级');
    expect(methods.checkinMethod).toBe('button');
  });

  it('账号没配时使用站点登录方式与签到流程', () => {
    const methods = resolveEffectiveMethods(account(), site('oauth', 'relogin'));
    expect(methods.loginMethod).toBe('oauth');
    expect(methods.loginMethodSource).toBe('站点默认');
    expect(methods.checkinMethod).toBe('relogin');
  });

  it('两级都没配时使用 form / auto 兜底', () => {
    const methods = resolveEffectiveMethods(account(), site());
    expect(methods.loginMethod).toBe('form');
    expect(methods.loginMethodSource).toBe('内置默认');
    expect(methods.checkinMethod).toBe('auto');
  });

  it('历史账号里的签到覆盖字段不会参与运行时解析', () => {
    const legacyAccount = { loginMethod: 'auto', checkinMethod: 'none' } as unknown as Account;
    const methods = resolveEffectiveMethods(legacyAccount, site('form', 'button'));
    expect(methods.loginMethod).toBe('auto');
    expect(methods.checkinMethod).toBe('button');
  });

  it('空字符串登录方式按没配处理', () => {
    const methods = resolveEffectiveMethods({ loginMethod: '' as LoginMethod }, site('token', 'claim'));
    expect(methods.loginMethod).toBe('token');
    expect(methods.loginMethodSource).toBe('站点默认');
    expect(methods.checkinMethod).toBe('claim');
  });

  it('站点侧空字符串签到方式回退到 auto', () => {
    const methods = resolveEffectiveMethods(account(), {
      loginMethod: '' as LoginMethod,
      checkin: { method: '' as CheckinMethod },
    });
    expect(methods.loginMethod).toBe('form');
    expect(methods.checkinMethod).toBe('auto');
  });
});

describe('loginCredentialNeeds', () => {
  it('OAuth 不要密码也不要 token', () => {
    expect(loginCredentialNeeds('oauth')).toEqual({
      password: false,
      token: false,
      sessionCounts: false,
      github: false,
      passkey: false,
    });
  });

  it('账密表单和 auto 都需要站点密码', () => {
    expect(loginCredentialNeeds('form').password).toBe(true);
    expect(loginCredentialNeeds('auto').password).toBe(true);
  });

  it('token 要 token，且抓来的登录态可以顶替', () => {
    expect(loginCredentialNeeds('token')).toEqual({
      password: false,
      token: true,
      sessionCounts: true,
      github: false,
      passkey: false,
    });
  });

  it('每种方式都有明确答案，且不会同时要密码和 token', () => {
    const logins: LoginMethod[] = ['form', 'oauth', 'github', 'passkey', 'auto', 'token'];
    for (const method of logins) {
      const needs = loginCredentialNeeds(method);
      expect(needs.password && needs.token, method).toBe(false);
      expect(needs.password && needs.github, method).toBe(false);
      expect(needs.token && needs.github, method).toBe(false);
      if (needs.sessionCounts) expect(needs.token, method).toBe(true);
    }
  });

  it('GitHub 和 Passkey 模式各自要求正确凭据', () => {
    expect(loginCredentialNeeds('github').github).toBe(true);
    expect(loginCredentialNeeds('passkey').passkey).toBe(true);
  });
});

describe('describeEffectiveMethods', () => {
  it('说明账号登录方式与站点签到流程', () => {
    const line = describeEffectiveMethods(resolveEffectiveMethods(account({ loginMethod: 'token' }), site('form', 'claim')));
    expect(line).toBe('登录方式：token（账号级）；签到方式：claim（站点配置）');
  });

  it('每种组合都被 diagnostics 排除在症状之外', () => {
    const logins: LoginMethod[] = ['form', 'oauth', 'auto', 'token'];
    const checkins: CheckinMethod[] = ['auto', 'none', 'button', 'api', 'relogin', 'claim', 'workflow'];
    for (const loginMethod of logins) {
      for (const checkinMethod of checkins) {
        const line = describeEffectiveMethods(resolveEffectiveMethods(account({ loginMethod }), site(undefined, checkinMethod)));
        expect(isSymptom(line), line).toBe(false);
      }
    }
  });

  it('排除方式说明后仍能识别真正的症状', () => {
    const line = describeEffectiveMethods(resolveEffectiveMethods(account({ loginMethod: 'token' }), site('form', 'relogin')));
    expect(classifyFailure('找不到签到按钮', [line, '找不到签到按钮'])).toBe(DIAGNOSIS.SELECTOR_MISMATCH);
  });
});
