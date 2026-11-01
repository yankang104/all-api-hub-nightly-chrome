import { describe, expect, it } from 'vitest';
import type { LoginMethod, LoginTask, TaskStage } from '@/types';
import {
  isExternalOAuthTask,
  isGithubTaskContinuation,
  isOAuthPopupCandidate,
  isOAuthPopupUrl,
  oauthProviderForTask,
} from '@/background/oauth/oauth-popup-policy';

function task(method: LoginMethod, stage: TaskStage = 'verify-oauth'): LoginTask {
  return {
    tabId: 11,
    runId: 'run-1',
    accountId: 'account-1',
    siteId: 'site-1',
    username: 'user',
    password: '',
    site: {
      id: 'site-1',
      name: 'Site',
      loginUrl: 'https://site.example/login',
      loginMethod: method,
      selectors: { username: '#u', password: '#p', submit: '#submit' },
      closeModalSelectors: [],
    },
    effectiveLoginMethod: method,
    effectiveCheckinMethod: 'api',
    usesExtensionProxy: true,
    createdAt: Date.now(),
    stage,
  };
}

describe('OAuth popup policy for all sites', () => {
  it.each(['oauth', 'github', 'passkey'] satisfies LoginMethod[])(
    'treats %s login as an external authentication task',
    (method) => expect(isExternalOAuthTask(task(method))).toBe(true),
  );

  it('also covers runtime-detected OAuth on an auto site', () => {
    expect(isExternalOAuthTask(task('auto', 'verify-oauth'))).toBe(true);
    expect(isExternalOAuthTask(task('auto', 'relogin-verify'))).toBe(true);
  });

  it('does not upgrade ordinary form/token tasks or post-login stages', () => {
    expect(isExternalOAuthTask(task('form', 'login'))).toBe(false);
    expect(isExternalOAuthTask(task('token', 'login'))).toBe(false);
    expect(isExternalOAuthTask(task('oauth', 'checkin'))).toBe(false);
  });

  it('accepts known and unknown provider URLs during an OAuth stage', () => {
    const oauth = task('oauth');
    expect(isOAuthPopupUrl(oauth, 'https://accounts.google.com/signin/v2/identifier')).toBe(true);
    expect(isOAuthPopupUrl(oauth, 'https://github.com/login/oauth/authorize')).toBe(true);
    expect(isOAuthPopupUrl(oauth, 'https://auth.company.test/custom-entry')).toBe(true);
    expect(isOAuthPopupUrl(oauth, 'chrome-extension://example/options.html')).toBe(false);
  });

  it('does not treat an ordinary child link as OAuth before the click stage', () => {
    const oauth = task('oauth', 'login');
    expect(isOAuthPopupUrl(oauth, 'https://docs.example.test/help')).toBe(false);
    expect(isOAuthPopupCandidate(oauth, { id: 22, url: 'about:blank' } as chrome.tabs.Tab)).toBe(false);
  });

  it('keeps a transitional about:blank only after the OAuth stage is persisted', () => {
    expect(isOAuthPopupCandidate(
      task('oauth', 'verify-oauth'),
      { id: 22, url: 'about:blank' } as chrome.tabs.Tab,
    )).toBe(true);
  });

  it('labels providers without widening the credential allowlist', () => {
    expect(oauthProviderForTask(task('oauth'), 'https://accounts.google.com/signin/v2/identifier')).toBe('google');
    expect(oauthProviderForTask(task('github'), 'https://github.com/login')).toBe('github');
    expect(oauthProviderForTask(task('oauth'), 'https://id.example.test/authorize')).toBe('generic');
  });

  it('keeps a fast GitHub OAuth callback in the popup task chain', () => {
    const relogin = task('github', 'relogin-verify');
    expect(isGithubTaskContinuation(relogin, 'about:blank')).toBe(true);
    expect(isGithubTaskContinuation(relogin, 'https://site.example/oauth/github?code=done')).toBe(true);
    expect(isGithubTaskContinuation(task('github'), 'https://github.com/login/oauth/authorize')).toBe(true);
  });

  it('does not let ordinary pages or foreign callbacks take over a GitHub task', () => {
    expect(isGithubTaskContinuation(
      task('github', 'relogin-verify'),
      'https://site.example/console',
    )).toBe(false);
    expect(isGithubTaskContinuation(
      task('github', 'relogin-verify'),
      'https://attacker.example/oauth/github',
    )).toBe(false);
    expect(isGithubTaskContinuation(
      task('github', 'relogin'),
      'https://site.example/oauth/github',
    )).toBe(false);
  });
});
