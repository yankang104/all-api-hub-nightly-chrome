/**
 * 同源 iframe 的真实浏览器验收：**只执行一次签到** + **iframe 内容被真实回放命中**。
 *
 * 存在的理由（核心智能体实测的真实事故风险）：
 *   content script 打开 `allFrames: true` 后，主文档和每个 iframe 都会各跑一遍
 *   main()。若子框架也走 `GET_TASK → runTask`，同一份流程会并发执行多次 ——
 *   重复填表、重复点击、**重复提交签到 POST**。对按次计费或幂等性差的接口，
 *   这是真实事故，不是理论问题。
 *
 * 本脚本用真实扩展 + 真实 Chromium 把两件事钉死：
 *   1) 页面主体是**同源 iframe**（签到按钮在 iframe 内、由 iframe 自己 POST），
 *      跑完一次回放后服务端记录到的签到 POST **恰好一次**；
 *   2) 回放确实**穿透 iframe** 命中了里面的控件（而不是在主文档里瞎点），
 *      且 iframe 内的点击事件 `isTrusted === true`。
 *
 * 用本地虚构站点，不做截图驱动；断言来源 = 服务端请求日志 + 扩展存储 + iframe DOM。
 *
 * 运行：node tests/e2e/same-origin-iframe-frames.mjs
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
const PROFILE_ROOT = join(REPO, 'output', 'same-origin-iframe-frames', 'profiles');
const HEADLESS = process.env.E2E_HEADLESS !== '0';

const SITE_ID = 'iframe-frame-fixture';
const ACCOUNT_ID = 'iframe-frame-account';
const USERNAME = 'sentinel_iframe';

/** 服务端观测：签到 POST 的次数与来源 frame（靠 header 区分不了 frame，只记次数与时间）。 */
let checkinPosts = [];
let iframeClickReports = [];

function outerPage(origin) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>outer</title>
  <style>body{margin:0;font:16px sans-serif}#host{width:900px;height:400px;border:0}</style></head>
  <body>
    <h1>外层页面</h1>
    <div id="logged-in">当前账号 ${USERNAME}</div>
    <button id="outer-decoy">外层诱饵按钮</button>
    <iframe id="host" src="/inner.html" title="inner"></iframe>
    <script>
      // 外层没有任何签到入口：只有 iframe 内部有。任何签到 POST 都只能来自 iframe。
      window.__outerClicks = 0;
      document.getElementById('outer-decoy').addEventListener('click', () => { window.__outerClicks += 1; });
    </script>
  </body></html>`;
}

function innerPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>inner</title>
  <style>body{margin:16px;font:16px sans-serif}button{padding:14px 26px;font-size:16px}</style></head>
  <body>
    <p>iframe 内部</p>
    <button id="inner-claim" aria-label="签到">签到</button>
    <p id="inner-result"></p>
    <script>
      const button = document.getElementById('inner-claim');
      button.addEventListener('click', async (event) => {
        // 事件必须来自真实浏览器输入（isTrusted），而不是脚本 dispatchEvent。
        fetch('/api/iframe-click-report', { method: 'POST', keepalive: true,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ trusted: event.isTrusted }) }).catch(() => {});
        if (!event.isTrusted) return;
        await fetch('/api/checkin', { method: 'POST', keepalive: true }).catch(() => {});
        document.getElementById('inner-result').textContent = '签到成功';
        button.disabled = true;
        // 回放结束后页面可能已经导航、iframe 被重建，事后从外面读文本会读到空壳；
        // 所以在**命中的那一刻**由 iframe 自己把结果文本上报给服务端。
        fetch('/api/iframe-click-report', { method: 'POST', keepalive: true,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ trusted: event.isTrusted,
            resultText: document.getElementById('inner-result').textContent }) }).catch(() => {});
      });
    </script>
  </body></html>`;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture.test');
  const path = url.pathname;

  if (path === '/api/iframe-click-report') {
    let body = '';
    for await (const chunk of req) body += chunk;
    iframeClickReports.push(JSON.parse(body || '{}'));
    res.setHeader('Content-Type', 'application/json');
    res.end('{}');
    return;
  }
  if (path === '/api/checkin') {
    for await (const _ of req) { /* drain */ }
    checkinPosts.push({ at: Date.now(), referer: req.headers.referer ?? '' });
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
  // 演示/回放两次读到的 HTML 必须是最新的，不能被启发式缓存糊弄成假阳性。
  res.setHeader('Cache-Control', 'no-store');
  if (path === '/inner.html') {
    res.end(innerPage());
    return;
  }
  if (path === '/dashboard' || path === '/') {
    res.end(outerPage());
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
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
    ],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 20_000 });
  const extensionId = new URL(worker.url()).hostname;

  const app = await context.newPage();
  await app.goto(`chrome-extension://${extensionId}/options.html`);
  await app.evaluate(async ({ origin, siteId, accountId, username }) => {
    await chrome.storage.local.set({
      sites: [{
        id: siteId,
        name: '同源 iframe 仿真站',
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

  // ── 1. 学习：用户在 iframe 内点击签到按钮，采集器必须录到 iframe 里的这一步 ──
  const seat = await context.newPage();
  await seat.goto(`${ORIGIN}/dashboard`);
  await seat.waitForSelector('#host');
  const frame = seat.frameLocator('#host');
  await frame.locator('#inner-claim').waitFor();

  const started = await message({ type: 'TOGGLE_LEARNING', accountId: ACCOUNT_ID, kind: 'checkin' });
  check('学习会话能启动', started?.ok === true, JSON.stringify(started));
  await pause(500);

  await frame.locator('#inner-claim').click();
  await frame.locator('#inner-result').filter({ hasText: '签到成功' }).waitFor();
  check('学习演示：iframe 内的签到点击被真实执行', checkinPosts.length === 1, `checkinPosts=${checkinPosts.length}`);
  await pause(400);

  const saved = await message({ type: 'TOGGLE_LEARNING', accountId: ACCOUNT_ID, kind: 'checkin' });
  check('iframe 内的操作被学习并成功保存', saved?.ok === true, JSON.stringify(saved).slice(0, 400));
  const state = await readState();
  const learnedSelectors = flatten(state.workflow?.steps).map((step) => step.selector).filter(Boolean);
  check('学到的工作流里存在指向 iframe 控件的选择器',
    learnedSelectors.some((selector) => selector.includes('inner-claim')),
    JSON.stringify(learnedSelectors));

  // ── 2. 回放：把 iframe 里的按钮恢复成可点，再跑一次真实签到 ──
  checkinPosts = [];
  iframeClickReports = [];
  await app.evaluate(async () => { await chrome.storage.local.set({ results: {}, status: {} }); });

  await seat.goto(`${ORIGIN}/dashboard`);
  await seat.waitForSelector('#host');
  await frame.locator('#inner-claim').waitFor();
  await frame.locator('#inner-claim').evaluate((button) => { button.disabled = false; });

  await message({ type: 'START_LOGIN', accountId: ACCOUNT_ID });
  const after = await waitIdle();

  check('回放结束并落成 done', after?.status === 'done', JSON.stringify({ status: after?.status, result: after?.result })?.slice(0, 400));
  check('【关键】一次签到只产生一次签到 POST（iframe 没有重复执行任务）',
    checkinPosts.length === 1, `checkinPosts=${checkinPosts.length}`);
  check('回放穿透 iframe：点击事件 isTrusted === true',
    iframeClickReports.some((report) => report.trusted === true),
    JSON.stringify(iframeClickReports));
  const outerClicks = await seat.evaluate(() => window.__outerClicks).catch(() => -1);
  check('回放没有误点外层同名/诱饵控件', outerClicks === 0, `outerClicks=${outerClicks}`);
  // 证据取自 iframe 在**被点击那一刻**自己上报的结果文本，不受事后导航影响。
  check('iframe 内的控件确实被命中（iframe 自己的结果文本被更新）',
    iframeClickReports.some((report) => (report.resultText ?? '').includes('签到成功')),
    JSON.stringify(iframeClickReports));
} catch (error) {
  exitCode = 1;
  console.error('SAME-ORIGIN IFRAME E2E FAILED:', error instanceof Error ? error.stack : error);
  console.error('Debug:', JSON.stringify({ checkinPosts, iframeClickReports }, null, 2));
} finally {
  await context?.close().catch(() => {});
  await new Promise((done) => server.close(done));
  rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((row) => !row.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(exitCode || (failed.length ? 1 : 0));