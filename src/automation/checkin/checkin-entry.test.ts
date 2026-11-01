import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/automation/shared/dom-utils', () => ({
  queryFirst: vi.fn(),
  realClick: vi.fn().mockResolvedValue('trusted'),
  waitFor: vi.fn(),
}));

vi.mock('@/automation/shared/click-safety', () => ({
  clearClickBlocker: vi.fn().mockResolvedValue(null),
}));

import type { SiteConfig } from '@/types';
import { clearClickBlocker } from '@/automation/shared/click-safety';
import { prepareCheckinEntry } from '@/automation/checkin/checkin-entry';
import { queryFirst, realClick, waitFor } from '@/automation/shared/dom-utils';

const READY = 'button >> text=立即签到, button >> text=已签到';
const site: SiteConfig = {
  id: 'tabiai-test',
  name: 'TaBiAI',
  loginUrl: `${window.location.origin}/sign-in`,
  selectors: { username: '#username', password: '#password', submit: '#submit' },
  closeModalSelectors: [],
  checkin: {
    method: 'button',
    url: '/profile',
    buttonSelector: 'button >> text=立即签到',
    entry: {
      readySelector: READY,
      steps: [
        { selector: '#avatar', waitFor: 'text=个人资料' },
        { selector: 'text=个人资料', waitFor: READY, mayNavigate: true },
      ],
    },
  },
};

const log = { push: vi.fn() };

beforeEach(() => {
  window.history.replaceState({}, '', '/dashboard/overview');
  vi.mocked(queryFirst).mockReset();
  vi.mocked(waitFor).mockReset();
  vi.mocked(realClick).mockResolvedValue('trusted');
  vi.mocked(clearClickBlocker).mockResolvedValue(null);
});

afterEach(() => vi.clearAllMocks());

describe('prepareCheckinEntry', () => {
  it('资料页已就绪时不重复点击头像', async () => {
    vi.mocked(queryFirst).mockReturnValue(document.createElement('button'));

    await expect(prepareCheckinEntry(site, log)).resolves.toEqual({ status: 'ready' });
    expect(waitFor).not.toHaveBeenCalled();
    expect(realClick).not.toHaveBeenCalled();
  });

  it('按头像和个人资料顺序执行，并在每次点击前重新通过挑战钩子', async () => {
    const avatar = document.createElement('button');
    const avatarAfterChallenge = document.createElement('button');
    const profile = document.createElement('a');
    const profileAfterChallenge = document.createElement('a');
    const ready = document.createElement('button');
    const beforeAction = vi.fn().mockResolvedValue(true);

    vi.mocked(queryFirst).mockReturnValue(null);
    vi.mocked(waitFor)
      .mockResolvedValueOnce(avatar)
      .mockResolvedValueOnce(avatarAfterChallenge)
      .mockResolvedValueOnce(profile)
      .mockResolvedValueOnce(profile)
      .mockResolvedValueOnce(profileAfterChallenge)
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce(ready)
      .mockResolvedValue(ready);

    await expect(prepareCheckinEntry(site, log, { beforeAction })).resolves.toEqual({ status: 'ready' });
    expect(beforeAction).toHaveBeenCalledTimes(2);
    expect(realClick).toHaveBeenNthCalledWith(1, avatarAfterChallenge, { mayNavigate: false });
    expect(realClick).toHaveBeenNthCalledWith(2, profileAfterChallenge, { mayNavigate: true });
  });

  it('入口不存在时只回退到同源 /profile', async () => {
    vi.mocked(queryFirst).mockReturnValue(null);
    vi.mocked(waitFor).mockResolvedValue(null);

    await expect(prepareCheckinEntry(site, log)).resolves.toEqual({
      status: 'navigate',
      url: `${window.location.origin}/profile`,
    });
  });

  it('已经在 /profile 但内容未渲染时明确失败，不形成自重载循环', async () => {
    window.history.replaceState({}, '', '/profile');
    vi.mocked(queryFirst).mockReturnValue(null);
    vi.mocked(waitFor).mockResolvedValue(null);

    const result = await prepareCheckinEntry(site, log);
    expect(result.status).toBe('failed');
    expect(result).toMatchObject({ message: expect.stringContaining('页面未完成渲染') });
  });

  it('头像已点击但资料页仍未就绪时停止，不绕过入口直达 /profile', async () => {
    const avatar = document.createElement('button');
    const profile = document.createElement('a');
    vi.mocked(queryFirst).mockReturnValue(null);
    vi.mocked(waitFor)
      .mockResolvedValueOnce(avatar)
      .mockResolvedValueOnce(profile)
      .mockResolvedValueOnce(profile)
      .mockResolvedValueOnce(profile)
      .mockResolvedValue(null);

    const result = await prepareCheckinEntry(site, log);
    expect(result).toEqual({
      status: 'failed',
      message: expect.stringContaining('签到资料页未就绪'),
    });
  });
});
