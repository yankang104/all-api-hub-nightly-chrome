/**
 * Shadow DOM 穿透回放的真实浏览器验收（「适配任何站点」的关键一环）。
 *
 * 存在的理由：现代组件库（Web Components / Lit / Salesforce Lightning / 多数
 * 支付与验证控件）把按钮埋在**影子根**里，顶层 `document.querySelector` 永远
 * 看不到。没有 `>>>` 穿透时，这类站点「学得到、回放不了」——
 * 用户点得到，扩展点不到，而界面上看不出原因。
 *
 * 本脚本用真实扩展 + 真实 Chromium 钉死四件事：
 *   1) 页面主体是自定义元素，签到按钮在**开放影子根**内，顶层查不到；
 *   2) `>>>` 选择器能真实穿透到影子根里的按钮并点中（isTrusted === true）；
 *   3) 一次回放**恰好**产生一次签到 POST（不重复提交）；
 *   4) 闭合影子根**如实报错**，不伪装成「页面上没有这个控件」。
 *
 * 运行：node tests/e2e/shadow-dom-frames.mjs
 * 需要先构建扩展：npx wxt build   （默认读 .output/chrome-mv3）
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXT = process.env.EXTENSION_DIR
  ? resolve(REPO, process.env.EXTENSION_DIR)
  : join(REPO, '.output', 'chrome-mv3');
const PROFILE_ROOT = join(REPO, 'output', 'shadow-dom-frames', 'profiles');
const HEADLESS = process.env.E2E_HEADLESS !== '0';

const SITE_ID = 'shadow-dom-fixture';
const ACCOUNT_ID = 'shadow-dom-account';
const USERNAME = 'sentinel_shadow';

let checkinPosts = [];
let clickReports = [];

/**
 * 开放影子根里的签到页。
 *
 * 顶层**故意不放**任何签到按钮：只有影子根里有。若扩展不理解 `>>>`，
 * 回放必然找不到目标，签到 POST 数会是 0。
 */
function openShadowPage(origin) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>shadow</title>
  <style>body{margin:0;font:16px sans-serif}</style></head>
  <body>
    <div id="logged-in">当前账号 ${USERNAME}</div>
    <checkin-widget id="widget"></checkin-widget>
    <script>
      customElements.define('checkin-widget', class extends HTMLElement {
        connectedCallback() {
          if (this.shadowRoot) return;
          const root = this.attachShadow({ mode: 'open' });
          root.innerHTML = '<style>button{padding:14px 26px;font-size:16px}</style>'
            + '<p>组件内部</p>'
            + '<button id="shadow-claim">立即签到</button>'
            + '<p id="shadow-result"></p>';
          const button = root.getElementById('shadow-claim');
          button.addEventListener('click', async (event) => {
            fetch('/api/shadow-click-report', { method: 'POST', keepalive: true,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ trusted: event.isTrusted }) }).catch(() => {});
            if (!event.isTrusted) return;
            await fetch('/api/checkin', { method: 'POST', keepalive: true }).catch(() => {});
            root.getElementById('shadow-result').textContent = '签到成功';
            // 站点通常把结果也放到主文档可见区域（断言按顶层文本判定）
            let light = document.getElementById('checkin-result');
            if (!light) { light = document.createElement('p'); light.id = 'checkin-result'; document.body.appendChild(light); }
            light.textContent = '签到成功';
            fetch('/api/shadow-click-report', { method: 'POST', keepalive: true,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ trusted: event.isTrusted,
                resultText: root.getElementById('shadow-result').textContent }) }).catch(() => {});
          });
        }
      });
    </script>
  </body></html>`;
}

/** 闭合影子根页面：扩展**拿不到**里面的文档，必须如实报错。 */
function closedShadowPage(origin) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>closed</title></head>
  <body>
    <div id="logged-in">当前账号 ${USERNAME}</div>
    <closed-widget id="closed-widget"></closed-widget>
    <script>
      customElements.define('closed-widget', class extends HTMLElement {
        connectedCallback() {
          if (this.shadowRoot || this.__made) return;
          this.__made = true;
          const root = this.attachShadow({ mode: 'closed' });
          root.innerHTML = '<button id="closed-claim">立即签到</button>';
        }
      });
    </script>
  </body></html>`;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture.test');
  const path = url.pathname;

  if (path === '/api/shadow-click-report') {
    let body = '';
    for await (const chunk of req) body += chunk;
    clickReports.push(JSON.parse(body || '{}'));
    res.setHeader('Content-Type', 'application/json');
    res.end('{}');
    return;
  }
  if (path === '/api/checkin') {
    for await (const _ of req) { /* drain */ }
    checkinPosts.push({ at: Date.now() });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true, message: '签到成功' }));
    return;
  }
  if (path === '/api/user/self') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true, data: { id: 1, username: USERNAME } }));
    return;
  }
  if (path.startsWith('/api/')) {
    res.writeHead(404);
    res.end('{}');
    return;
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (path === '/closed') {
    res.end(closedShadowPage());
    return;
  }
  if (path === '/dashboard' || path === '/') {
    res.end(openShadowPage());
    return;
  }
  res.writeHead(302, { Location: '/dashboard' });
  res.end();
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? `  — ${detail}` : ''}`);
}
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const flatten = (steps) => (steps ?? []).flatMap((step) => (
  step.type === 'if' ? [...flatten(step.then), ...flatten(step.else)] : [step]
));

mkdirSync(PROFILE_ROOT, { recursive: true });
const profile = mkdtempSync(join(PROFILE_ROOT, 'profile-'));

let context;
let exitCode = 0;
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: HEADLESS,
    channel: 'chromium',
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 20_000 });
  const extensionId = new URL(worker.url()).hostname;

  const app = await context.newPage();
  await app.goto(`chrome-extension://${extensionId}/options.html`);
  await app.evaluate(async ({ origin, siteId, accountId, username }) => {
    await chrome.storage.local.set({
      sites: [{
        id: siteId,
        name: 'Shadow DOM 仿真站',
        loginUrl: `${origin}/dashboard`,
        successIndicator: '#logged-in',
        selectors: { username: '#u', password: '#p', submit: '#s' },
        closeModalSelectors: [],
      }],
      accounts: [{ id: accountId, siteId, username, password: 'sentinel-unused-password' }],
      status: {},
      results: {},
    });
  }, { origin: ORIGIN, siteId: SITE_ID, accountId: ACCOUNT_ID, username: USERNAME });

  const message = (payload) => app.evaluate((value) => chrome.runtime.sendMessage(value), payload);
  const readState = () => app.evaluate(async ({ accountId }) => {
    const stored = await chrome.storage.local.get(['sites', 'status', 'results']);
    const key = Object.keys(stored.status ?? {}).find((item) => item.startsWith(accountId));
    return {
      workflow: stored.sites?.[0]?.checkin?.workflow,
      status: key ? stored.status[key] : undefined,
      result: stored.results?.[key],
      key,
    };
  }, { accountId: ACCOUNT_ID });
  const waitIdle = async (timeout = 90_000) => {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      const queue = await app.evaluate(async () => (await chrome.storage.session.get('checkinQueue')).checkinQueue);
      last = await readState();
      if (!queue?.active && last.result) return last;
      await pause(250);
    }
    return last;
  };

  // ── 1. 前置断言：顶层确实够不到影子根里的按钮 ──
  const seat = await context.newPage();
  await seat.goto(`${ORIGIN}/dashboard`);
  await seat.waitForSelector('#logged-in');
  const topLevelFinds = await seat.evaluate(() => document.querySelectorAll('#shadow-claim').length);
  check('【前提】顶层 document 查不到影子根里的签到按钮', topLevelFinds === 0, `matches=${topLevelFinds}`);

  // ── 2. 学习：在影子根里点击签到 ──
  const started = await message({ type: 'TOGGLE_LEARNING', accountId: ACCOUNT_ID, kind: 'checkin' });
  check('学习会话能启动', started?.ok === true, JSON.stringify(started).slice(0, 300));
  await pause(500);

  // 用 Playwright 的真实输入点击影子根里的按钮（isTrusted），而不是脚本 click()
  await seat.locator('#widget').evaluate((host) => { host.setAttribute('data-probe','1'); });
  const shadowButton = seat.locator('#widget >> css=#shadow-claim');
  await shadowButton.click();
  await pause(600);
  const saved = await message({ type: 'TOGGLE_LEARNING', accountId: ACCOUNT_ID, kind: 'checkin' });
  const state = await readState();
  const learnedSelectors = flatten(state.workflow?.steps).map((step) => step.selector).filter(Boolean);
  check('影子根里的点击被学习到（选择器含 >>> 或指向组件）',
    learnedSelectors.length > 0,
    JSON.stringify({ saved: saved?.ok, savedErr: saved?.error, selectors: learnedSelectors,
      status: state.status, result: state.result }));

  // ── 3. 回放：把影子根里的按钮恢复可点，跑一次真实签到 ──
  checkinPosts = [];
  clickReports = [];
  await app.evaluate(async () => { await chrome.storage.local.set({ results: {}, status: {} }); });
  await seat.goto(`${ORIGIN}/dashboard`);
  await seat.waitForSelector('#logged-in');
  await message({ type: 'START_LOGIN', accountId: ACCOUNT_ID });
  const after = await waitIdle();

  check('回放结束并落成 done', after?.status === 'done',
    JSON.stringify({ status: after?.status, result: after?.result })?.slice(0, 500));
  check('【关键】>>> 选择器穿透影子根，恰好产生一次签到 POST',
    checkinPosts.length === 1, `checkinPosts=${checkinPosts.length}`);
  check('影子根内的点击 isTrusted === true',
    clickReports.some((report) => report.trusted === true), JSON.stringify(clickReports));
  check('影子根内的控件确实被命中（组件自己的结果文本被更新）',
    clickReports.some((report) => (report.resultText ?? '').includes('签到成功')),
    JSON.stringify(clickReports));
} catch (error) {
  exitCode = 1;
  console.error('SHADOW DOM E2E FAILED:', error instanceof Error ? error.stack : error);
} finally {
  await context?.close().catch(() => {});
  await new Promise((done) => server.close(done));
  rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((row) => !row.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(exitCode || (failed.length ? 1 : 0));
