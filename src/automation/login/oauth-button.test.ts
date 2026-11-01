import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findAutomaticOAuthButton } from '@/automation/login/steps';

describe('automatic external login button selection', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 10,
      top: 10,
      right: 210,
      bottom: 50,
      width: 200,
      height: 40,
      x: 10,
      y: 10,
      toJSON: () => ({}),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('selects a plain Passkey button even when a higher-scoring GitHub button exists', () => {
    document.body.innerHTML = `
      <button id="github">使用 GitHub 继续</button>
      <button id="passkey">使用 Passkey 登录</button>
    `;

    expect(findAutomaticOAuthButton('passkey')?.id).toBe('passkey');
  });

  it('selects the GitHub provider in GitHub mode', () => {
    document.body.innerHTML = `
      <button id="google">使用 Google 继续</button>
      <button id="github">Sign in with GitHub</button>
      <button id="passkey">使用通行密钥登录</button>
    `;

    expect(findAutomaticOAuthButton('github')?.id).toBe('github');
  });

  it('recognizes Chinese Passkey wording', () => {
    document.body.innerHTML = '<button id="passkey-cn">使用通行密钥登录</button>';

    expect(findAutomaticOAuthButton('passkey')?.id).toBe('passkey-cn');
  });
});
