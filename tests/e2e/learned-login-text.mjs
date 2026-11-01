/**
 * 真实 Chromium 回归：SVG title 与 innerText 不同，不能用 jsdom 的 textContent 桩替代。
 * 仅启动本地虚构页面、加载实际 TS 模块；不访问真实站点或账号，不验证扩展可信指针传输。
 * 运行：node tests/e2e/learned-login-text.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

// Vite 是 WXT 的间接依赖，按 WXT 的解析上下文定位，不依赖 pnpm hoist。
const requireWxt = createRequire(import.meta.resolve('wxt'));
const { createServer } = await import(pathToFileURL(requireWxt.resolve('vite')).href);
const root = fileURLToPath(new URL('../../', import.meta.url));
const server = await createServer({
  configFile: false,
  root,
  resolve: { alias: { '@': fileURLToPath(new URL('../../src', import.meta.url)) } },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [{
    name: 'oauth-text-fixture',
    configureServer(server) {
      server.middlewares.use('/oauth-text-fixture', (_req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(`<!doctype html><meta charset="utf-8"><title>OAuth text fixture</title>
          <button class="github"><svg width="20" height="20"><title>GitHub</title><path d="M0 0h12v12z"/></svg><span>使用 GitHub 继续</span></button>
          <button class="google">使用 Google 继续</button>
          <button id="other">其他登录方式</button>`);
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`${server.resolvedUrls.local[0]}oauth-text-fixture`);
  const dom = await page.evaluate(async () => {
    const learning = await import('/src/automation/learning/learning.ts');
    const query = await import('/src/automation/shared/dom-utils.ts');
    const steps = await import('/src/automation/login/steps.ts');
    const button = document.querySelector('.github');
    const events = [];
    const capture = new learning.LearningCapture({ kind: 'login', onEvent: (event) => events.push(event) });
    const site = {
      id: 'fixture', name: 'fixture', loginUrl: location.href, loginMethod: 'oauth',
      selectors: { username: '', password: '', submit: '' }, closeModalSelectors: [],
    };
    const clicks = [];
    document.addEventListener('click', (event) => clicks.push(event.target.closest('button')?.className || event.target.id));
    capture.attach();
    window.fixture = { learning, query, steps, button, events, capture, site, clicks };
    return { innerText: button.innerText, textContent: button.textContent };
  });
  assert.deepEqual(dom, { innerText: '使用 GitHub 继续', textContent: 'GitHub使用 GitHub 继续' });

  // 真鼠标点按钮内部的 span，确认采集记录归属按钮本体。
  await page.locator('.github span').click();
  const learned = await page.evaluate(() => {
    const f = window.fixture;
    f.capture.detach();
    return f.learning.buildLearnedLoginSettings(f.site, f.events);
  });
  assert.equal(learned.oauthButtonSelector, 'text=使用 GitHub 继续');

  for (const selector of [learned.oauthButtonSelector, 'text=GitHub使用 GitHub 继续']) {
    const replay = await page.evaluate(async (selector) => {
      const f = window.fixture;
      f.clicks.length = 0;
      const logs = [];
      const site = { ...f.site, oauthButtonSelector: selector, preLoginClickSelector: '#other' };
      await f.steps.revealExternalLogin(site, { push: (line) => logs.push(line) }, 'oauth');
      const revealedWithoutClick = f.clicks.length === 0;
      const ok = await f.steps.clickOAuthButton(site, { push: (line) => logs.push(line) });
      return { revealedWithoutClick, ok, clicks: [...f.clicks], logs };
    }, selector);
    assert.equal(replay.revealedWithoutClick, true, JSON.stringify(replay));
    assert.equal(replay.ok, true, JSON.stringify(replay));
    assert.deepEqual(replay.clicks, ['github']);
    console.log(`PASS learn/replay: ${selector}`);
  }

  const guards = await page.evaluate(() => {
    const f = window.fixture;
    const old = 'text=GitHub使用 GitHub 继续';
    const duplicate = f.button.cloneNode(true);
    document.body.append(duplicate);
    const ambiguousRejected = f.query.queryFirst(old) === null;
    duplicate.remove();
    f.button.querySelector('svg').remove();
    f.button.insertAdjacentHTML('afterbegin', '<span hidden>GitHub</span>');
    const hiddenRejected = f.query.queryFirst(old) === null;
    f.button.querySelector('[hidden]').remove();
    f.button.querySelector('span').innerHTML = '使用<br>GitHub&nbsp; 继续';
    const normalizedSelector = f.learning.learningSelector(f.button);
    return {
      ambiguousRejected, hiddenRejected, normalizedSelector,
      normalizedMatch: f.query.queryFirst(normalizedSelector) === f.button,
    };
  });
  assert.deepEqual(guards, {
    ambiguousRejected: true, hiddenRejected: true,
    normalizedSelector: 'text=使用 GitHub 继续', normalizedMatch: true,
  });
  console.log('PASS real DOM: whitespace normalization, hidden text exclusion, ambiguous legacy rejection');
} finally {
  await browser?.close();
  await server.close();
}
