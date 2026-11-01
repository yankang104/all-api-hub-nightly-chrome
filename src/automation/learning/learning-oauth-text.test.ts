import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SiteConfig, WorkflowLearningEvent } from '@/types';
import { buildLearnedLoginSettings, LearningCapture, learningSelector } from '@/automation/learning/learning';
import { clickOAuthButton, revealExternalLogin } from '@/automation/login/steps';
import { queryAll, queryFirst, realClick } from '@/automation/shared/dom-utils';

const clock = vi.hoisted(() => ({ now: 0 }));
vi.mock('@/automation/shared/dom-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/automation/shared/dom-utils')>();
  return {
    ...actual,
    sleep: vi.fn(async (ms: number) => { clock.now += ms; }),
    realClick: vi.fn(async () => 'trusted' as const),
  };
});
vi.mock('@/automation/shared/announcements', () => ({
  dismissAnnouncements: vi.fn(async () => ({ closed: 0, gone: true })),
}));
vi.mock('@/automation/shared/click-safety', () => ({
  clearClickBlocker: vi.fn(async () => null),
}));

const site: SiteConfig = {
  id: 'oauth-text-fixture',
  name: 'OAuth text fixture',
  loginUrl: 'https://fixture.test/login',
  loginMethod: 'oauth',
  selectors: { username: '', password: '', submit: '' },
  closeModalSelectors: [],
};
const visibleLabel = '使用 GitHub 继续';
const legacySelector = `text=GitHub${visibleLabel}`;

/** 不把 jsdom 的 innerText 简单等同于 textContent：这恰好会掩盖浏览器中的故障。 */
function iconButton(visibleText = visibleLabel): HTMLButtonElement {
  const button = document.createElement('button');
  button.innerHTML = '<svg><title>GitHub</title><path d="M0 0h12v12z"/></svg><span></span>';
  button.querySelector('span')!.textContent = visibleText;
  Object.defineProperty(button, 'innerText', { configurable: true, value: visibleText });
  document.body.append(button);
  return button;
}

beforeEach(() => {
  clock.now = 1_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 100, height: 30, top: 0, left: 0, right: 100, bottom: 30, x: 0, y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  vi.mocked(realClick).mockClear();
  document.body.innerHTML = '';
  window.history.replaceState({}, '', '/login');
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('OAuth 学习与回放的文字语义一致', () => {
  it('SVG title 不进入新选择器，采集 → 编译 → 登录点击真实消费同一个按钮', async () => {
    const button = iconButton();
    expect(button.textContent).toBe(`GitHub${visibleLabel}`);
    const events: WorkflowLearningEvent[] = [];
    const capture = new LearningCapture({ kind: 'login', onEvent: (event) => events.push(event) });
    capture.attach();
    try {
      button.querySelector('span')!.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
      capture.flushPending();
    } finally {
      capture.detach();
    }
    const learned = buildLearnedLoginSettings(site, events);
    expect(learned).toMatchObject({ loginMethod: 'oauth', oauthButtonSelector: `text=${visibleLabel}` });
    expect(queryFirst(learned!.oauthButtonSelector!)).toBe(button);
    const replaySite: SiteConfig = { ...site, ...learned, selectors: { ...site.selectors, ...learned?.selectors } };
    expect(await clickOAuthButton(replaySite, { push: vi.fn() })).toBe(true);
    expect(realClick).toHaveBeenCalledWith(button, { mayNavigate: true });
  });

  it('学习折叠过的空白在回放时同样折叠（换行、多空格、NBSP）', () => {
    const button = iconButton('使用\n GitHub\u00a0  继续');
    expect(learningSelector(button)).toBe(`text=${visibleLabel}`);
    expect(queryFirst(`text=${visibleLabel}`)).toBe(button);
    expect(queryFirst('text= 使用\nGitHub  继续 ')).toBe(button);
  });

  it('无可见文字的 SVG 不会把 title 学成文字选择器', () => {
    const button = iconButton('');
    const selector = learningSelector(button);
    expect(selector).not.toContain('text=');
    expect(queryFirst(selector)).toBe(button);
    expect(queryFirst('text=GitHub')).toBeNull();
  });

  it('按钮文字选择器当场零命中时回落结构路径，不保存不可回放的选择器', () => {
    const button = iconButton('');
    button.setAttribute('aria-label', 'Continue, with GitHub');
    const selector = learningSelector(button);
    expect(queryAll(selector)).toEqual([button]);
    expect(selector).not.toBe('text=Continue with GitHub');
  });
});

describe('兼容已保存的 SVG 元数据拼接选择器', () => {
  it('旧选择器仍可定位，验证重绘后重新定位，且不会误点其他登录方式', async () => {
    document.body.innerHTML = '<button id="other">其他登录方式</button><button>使用 Google 继续</button>';
    let button = iconButton();
    const log = { push: vi.fn() };
    const savedSite = { ...site, oauthButtonSelector: legacySelector, preLoginClickSelector: '#other' };
    expect(queryFirst(legacySelector)).toBe(button);
    expect(queryAll(`button >> ${legacySelector}`)).toEqual([button]);
    await revealExternalLogin(savedSite, log, 'oauth');
    expect(realClick).not.toHaveBeenCalled();
    expect(log.push).toHaveBeenCalledWith('第三方登录入口已可见，无需展开账密表单');
    expect(await clickOAuthButton(savedSite, log, {
      beforeClick: async () => {
        button.remove();
        button = iconButton();
        return true;
      },
    })).toBe(true);
    expect(realClick).toHaveBeenCalledTimes(1);
    expect(realClick).toHaveBeenCalledWith(button, { mayNavigate: true });
  });

  it('不把隐藏 HTML 文案当成旧 SVG 元数据兼容', () => {
    const button = iconButton();
    button.querySelector('svg')!.remove();
    button.insertAdjacentHTML('afterbegin', '<span hidden>GitHub</span>');
    expect(queryFirst(legacySelector)).toBeNull();
    expect(queryFirst(`text=${visibleLabel}`)).toBe(button);
  });

  it('即使存在 SVG，也不能顺带匹配其它隐藏 HTML 文案', () => {
    const button = iconButton();
    button.querySelector('svg')!.insertAdjacentHTML('afterend', '<span hidden>内部提示</span>');
    expect(queryFirst(`text=GitHub内部提示${visibleLabel}`)).toBeNull();
    expect(queryFirst(`text=${visibleLabel}`)).toBe(button);
  });

  it('不能只凭图标标题匹配文字不同的按钮', () => {
    iconButton('使用 Google 继续');
    expect(queryFirst('text=GitHub')).toBeNull();
    expect(queryFirst(legacySelector)).toBeNull();
  });

  it('多个旧拼接候选不按文档顺序猜测，CSS 限定唯一后才兼容', () => {
    iconButton();
    const second = iconButton();
    second.className = 'chosen';
    expect(queryFirst(legacySelector)).toBeNull();
    expect(queryAll(legacySelector)).toEqual([]);
    expect(queryFirst(`.chosen >> ${legacySelector}`)).toBe(second);
  });

  it('正常可见文字命中优先于旧拼接兼容', () => {
    iconButton();
    const direct = document.createElement('button');
    direct.textContent = `GitHub${visibleLabel}`;
    Object.defineProperty(direct, 'innerText', { value: direct.textContent });
    document.body.append(direct);
    expect(queryFirst(legacySelector)).toBe(direct);
    expect(queryAll(legacySelector)).toEqual([direct]);
  });

  it('按钮仍禁用时不因兼容命中而强行点击', async () => {
    iconButton().disabled = true;
    const log = { push: vi.fn() };
    expect(await clickOAuthButton({ ...site, oauthButtonSelector: legacySelector }, log)).toBe(false);
    expect(log.push).toHaveBeenCalledWith(expect.stringContaining('仍处于禁用状态'));
    expect(realClick).not.toHaveBeenCalled();
  });
});
