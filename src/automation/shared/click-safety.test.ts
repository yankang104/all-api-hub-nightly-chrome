import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/automation/shared/announcements', () => ({
  dismissAnnouncements: vi.fn().mockResolvedValue({ closed: 0, blocked: false, keptFunctional: 0 }),
}));

vi.mock('@/automation/shared/dom-utils', () => ({
  describeElement: vi.fn(),
  elementBlocking: vi.fn(),
  sleep: vi.fn().mockResolvedValue(undefined),
}));

import { dismissAnnouncements } from '@/automation/shared/announcements';
import { describeElement, elementBlocking, sleep } from '@/automation/shared/dom-utils';
import { clearClickBlocker } from '@/automation/shared/click-safety';
import type { SiteConfig } from '@/types';

const site: SiteConfig = {
  id: 'site-1',
  name: '测试站',
  loginUrl: 'https://example.com/login',
  selectors: { username: '#user', password: '#password', submit: '#submit' },
  closeModalSelectors: [],
};

const log = { push: vi.fn() };

function connectedTarget(): HTMLButtonElement {
  const target = document.createElement('button');
  target.scrollIntoView = vi.fn();
  document.body.appendChild(target);
  return target;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('clearClickBlocker', () => {
  it('目标未被遮挡时不进行额外清理', async () => {
    const target = connectedTarget();
    vi.mocked(elementBlocking).mockReturnValue(null);

    await expect(clearClickBlocker(target, site, log)).resolves.toBeNull();

    expect(dismissAnnouncements).not.toHaveBeenCalled();
    expect(target.scrollIntoView).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('发现遮罩后清理公告、重新检测并确认可点击', async () => {
    const target = connectedTarget();
    const blocker = document.createElement('div');
    vi.mocked(elementBlocking)
      .mockReturnValueOnce(blocker)
      .mockReturnValueOnce(null);
    vi.mocked(describeElement).mockReturnValue('div.modal-mask');

    await expect(clearClickBlocker(target, site, log, '工作流控件')).resolves.toBeNull();

    expect(dismissAnnouncements).toHaveBeenCalledExactlyOnceWith(site, log, {
      waitForAppear: false,
      blockedElement: target,
      cleanupState: { failedButtons: new Set(), escapedOverlays: new Set() },
    });
    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    expect(sleep).toHaveBeenCalledExactlyOnceWith(250);
    expect(log.push).toHaveBeenCalledWith('工作流控件被 div.modal-mask 遮挡，尝试关闭遮挡的公告');
    expect(log.push).toHaveBeenCalledWith('遮挡已清除，继续点击');
  });

  it('公告清理后仍有遮挡时把 blocker 交给调用方停止点击', async () => {
    const target = connectedTarget();
    const blocker = document.createElement('div');
    vi.mocked(elementBlocking).mockReturnValue(blocker);
    vi.mocked(describeElement).mockReturnValue('div.modal-mask');

    await expect(clearClickBlocker(target, site, log)).resolves.toBe(blocker);

    expect(dismissAnnouncements).toHaveBeenCalledTimes(2);
    expect(elementBlocking).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 250);
    expect(sleep).toHaveBeenNthCalledWith(2, 450);
    const first = vi.mocked(dismissAnnouncements).mock.calls[0]![2]!;
    const second = vi.mocked(dismissAnnouncements).mock.calls[1]![2]!;
    expect(first.blockedElement).toBe(target);
    expect(second.blockedElement).toBe(target);
    expect(second.cleanupState).toBe(first.cleanupState);
    expect(log.push).not.toHaveBeenCalledWith('遮挡已清除，继续点击');
  });

  it('公告处理期间原目标被重绘移除时，要求调用方重新定位', async () => {
    const target = connectedTarget();
    const blocker = document.createElement('div');
    vi.mocked(elementBlocking).mockReturnValue(blocker);
    vi.mocked(dismissAnnouncements).mockImplementationOnce(async () => {
      target.remove();
      return { closed: 1, blocked: false, keptFunctional: 0 };
    });

    await expect(clearClickBlocker(target, site, log)).resolves.toBeNull();

    expect(target.isConnected).toBe(false);
    expect(elementBlocking).toHaveBeenCalledOnce();
    expect(target.scrollIntoView).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    expect(log.push).toHaveBeenCalledWith('公告处理期间页面已重绘，需要重新定位操作控件');
    expect(log.push).not.toHaveBeenCalledWith('遮挡已清除，继续点击');
  });
});
