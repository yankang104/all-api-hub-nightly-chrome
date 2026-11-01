import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SiteFavicon } from './SiteFavicon';

describe('SiteFavicon fallback', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('tries the saved site icon, then its native favicon, then the site initial', async () => {
    await act(async () => {
      root.render(createElement(SiteFavicon, {
        site: { loginUrl: 'https://example.com/login', favicon: '/assets/brand.svg' },
        className: 'site-icon',
        fallback: 'E',
      }));
    });

    const image = container.querySelector('img');
    expect(image?.getAttribute('src')).toBe('https://example.com/assets/brand.svg');

    await act(async () => image?.dispatchEvent(new Event('error')));
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/favicon.ico');

    await act(async () => container.querySelector('img')?.dispatchEvent(new Event('error')));
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('E');
  });

  it('resets a previous failure when the site URL changes', async () => {
    await act(async () => {
      root.render(createElement(SiteFavicon, {
        site: { loginUrl: 'https://first.example/login' },
        className: 'site-icon',
        fallback: 'F',
      }));
    });
    await act(async () => container.querySelector('img')?.dispatchEvent(new Event('error')));
    expect(container.textContent).toBe('F');

    await act(async () => {
      root.render(createElement(SiteFavicon, {
        site: { loginUrl: 'https://second.example/login' },
        className: 'site-icon',
        fallback: 'S',
      }));
    });
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://second.example/favicon.ico');
  });

  it('labels the initial fallback when the site serves no image', async () => {
    await act(async () => {
      root.render(createElement(SiteFavicon, {
        site: { name: 'Agent Router', loginUrl: 'https://agentrouter.org/login' },
        className: 'site-icon',
        fallback: 'A',
      }));
    });

    await act(async () => container.querySelector('img')?.dispatchEvent(new Event('error')));
    const fallback = container.querySelector('[role="img"]');
    expect(fallback?.textContent).toBe('A');
    expect(fallback?.getAttribute('aria-label')).toContain('Agent Router');
  });

  it('advances when Chromium returns a zero-width default favicon without an error event', async () => {
    vi.stubGlobal('chrome', {
      runtime: { getURL: (path: string) => `chrome-extension://extension-id${path}` },
    });

    await act(async () => {
      root.render(createElement(SiteFavicon, {
        site: { loginUrl: 'https://agentrouter.org/login' },
        className: 'site-icon',
        fallback: 'A',
      }));
    });

    expect(container.querySelector('img')?.getAttribute('src'))
      .toContain('chrome-extension://extension-id/_favicon/');
    await act(async () => container.querySelector('img')?.dispatchEvent(new Event('load')));
    expect(container.querySelector('img')?.getAttribute('src'))
      .toBe('https://agentrouter.org/favicon.ico');
  });
});
