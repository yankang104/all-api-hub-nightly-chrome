/**
 * SPA 内层滚动面板的学习与回放验收（重建版）。
 *
 * 覆盖三件事：
 *  1. 学习：SPA 路由跳转 + 内层滚动面板内的控件，学到的步骤要带 scrollContainer；
 *  2. 回放：在不同面板高度下都能靠真实滚轮把控件扫出来并点到；
 *  3. 落盘：workflow.route / identityPath / scrollIntoView / anchor / fingerprint 都要在。
 *
 * 运行：node tests/e2e/learned-spa-scroll.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

let spacer = 1600;
let actions = [];
let claimCount = 0;
let changedLayout = false;

const server = (await import('node:http')).createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture.test');
  const path = url.pathname;
  res.setHeader('Cache-Control', 'no-store');
  const authed = String(req.headers.cookie ?? '').includes('spa=1');
  if (path === '/api/login' && req.method === 'POST') {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { 'Set-Cookie': 'spa=1; Path=/; SameSite=Lax', 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (path === '/api/claim' && req.method === 'POST') {
    for await (const _ of req) { /* drain */ }
    claimCount += 1;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (path.startsWith('/api/')) { res.writeHead(404); res.end('{}'); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // 登录页永远渲染登录表单：任务流程会重新打开 loginUrl 完成登录，
  // 若这里因为「已有 Cookie」就直接给 SPA，扩展会看不到账密框。
  if (path === '/login' || !authed) {
    res.end(`<!doctype html><meta charset="utf-8">
      <h1>登录</h1>
      <form id="login-form">
        <input id="username" name="username" autocomplete="username">
        <input id="password" name="password" type="password" autocomplete="current-password">
        <button id="submit" type="submit">登录</button>
      </form>
      <script>
        document.getElementById('login-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          await fetch('/api/login', { method: 'POST' });
          location.href = '/dashboard/overview';
        });
      </script>`);
    return;
  }
  const panelId = changedLayout ? 'current-panel' : 'panel';
  const claimId = changedLayout ? 'current-claim' : 'claim';
  const claimLabel = changedLayout ? '领取今日额度' : '立即签到';
  res.end(`<!doctype html><meta charset="utf-8">
    <style>
      body{margin:20px;font:16px sans-serif}
      button{padding:15px}
      #${panelId}{height:380px;width:650px;overflow-y:auto;border:1px solid #ccc}
      #${claimId}{margin:20px}
    </style>
    <div id="app"></div>
    <script>
      window.__spaActions = [];
      window.__spaSpacer = ${spacer};
      function render() {
        const path = location.pathname;
        const app = document.getElementById('app');
        if (path === '/dashboard/overview') {
          app.innerHTML = '<h1>控制台</h1><a href="/profile" id="open-profile">个人资料</a>';
        } else if (path === '/profile') {
          app.innerHTML = '<h1>个人资料</h1><p>用户：spa-user</p><a href="/checkin" id="open-checkin">去签到</a>';
        } else if (path === '/checkin') {
          app.innerHTML = '<h1>每日签到</h1><div id="${panelId}"><div style="height:' + window.__spaSpacer + 'px"></div>'
            + '<button id="${claimId}">${claimLabel}</button><p id="result"></p></div>';
          document.getElementById('${claimId}').addEventListener('click', async (e) => {
            window.__spaActions.push('claim');
            if (!e.isTrusted) { document.getElementById('result').textContent = '非可信点击被拒绝'; return; }
            await fetch('/api/claim', { method: 'POST' });
            document.getElementById('result').textContent = '签到成功';
          });
        }
      }
      document.addEventListener('click', (e) => {
        const link = e.target.closest && e.target.closest('a[href^="/"]');
        if (!link) return;
        e.preventDefault();
        window.__spaActions.push(link.id);
        history.pushState({}, '', link.getAttribute('href'));
        render();
      });
      window.addEventListener('popstate', render);
      render();
    </script>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const output = resolve('output/learned-spa-scroll');
mkdirSync(output, { recursive: true });
const profile = mkdtempSync(resolve(output, 'profile-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: 'chromium',
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${resolve('.output/chrome-mv3')}`, `--load-extension=${resolve('.output/chrome-mv3')}`],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).hostname;
  const app = await context.newPage();
  await app.goto(`chrome-extension://${extensionId}/options.html`);
  await app.evaluate(async (origin) => {
    await chrome.storage.local.set({
      sites: [{
        id: 'spa-site', name: 'SPA 验收站', loginUrl: origin + '/login', loginMethod: 'form',
        selectors: { username: '#username', password: '#password', submit: '#submit' },
        closeModalSelectors: [],
      }],
      accounts: [{ id: 'spa-account', siteId: 'spa-site', username: 'spa-user', password: 'spa-pass' }],
      results: {}, status: {},
    });
  }, origin);

  const message = (msg) => app.evaluate((m) => chrome.runtime.sendMessage(m), msg);

  const learningPage = await context.newPage();
  await learningPage.goto(origin + '/login');
  await learningPage.fill('#username', 'spa-user');
  await learningPage.fill('#password', 'spa-pass');
  await learningPage.click('#submit');
  await learningPage.waitForURL('**/dashboard/overview');

  const started = await message({ type: 'TOGGLE_LEARNING', accountId: 'spa-account', kind: 'checkin' });
  assert.equal(started.ok, true, JSON.stringify(started));

  // 学习标签页由 background 打开，切到它
  const learningTab = context.pages().find((p) => p.url().includes('/dashboard/overview') && p !== learningPage) ?? learningPage;
  await learningTab.bringToFront();
  await learningTab.waitForTimeout(500);

  await learningTab.click('#open-profile');
  await learningTab.waitForURL('**/profile');
  await learningTab.click('#open-checkin');
  await learningTab.waitForURL('**/checkin');
  // 内层面板滚动到按钮
  await learningTab.evaluate(() => { const p = document.getElementById('panel'); if (p) p.scrollTop = p.scrollHeight; });
  await learningTab.waitForTimeout(300);
  await learningTab.locator('#claim').scrollIntoViewIfNeeded();
  await learningTab.click('#claim');
  await learningTab.waitForTimeout(600);

  const saved = await message({ type: 'TOGGLE_LEARNING', accountId: 'spa-account', kind: 'checkin' });
  assert.equal(saved.ok, true, JSON.stringify(saved));

  const workflow = await app.evaluate(async () => (await chrome.storage.local.get('sites')).sites[0].checkin.workflow);
  console.log('route:', JSON.stringify(workflow.route));
  console.log('identityPath:', workflow.identityPath);
  assert.deepEqual(workflow.route, ['/dashboard/overview', '/profile', '/checkin']);
  assert.equal(workflow.identityPath, '/profile');

  const flatten = (list) => list.flatMap((s) => [s, ...(s.then ? flatten(s.then) : []), ...(s.else ? flatten(s.else) : [])]);
  const clicks = flatten(workflow.steps).filter((s) => s.type === 'click');
  assert.deepEqual(clicks.map((s) => s.selector), ['#open-profile', '#open-checkin', '#claim']);

  const claimStep = clicks.find((s) => s.selector === '#claim');
  assert.equal(claimStep.scrollIntoView, true, JSON.stringify(claimStep));
  assert.equal(claimStep.scrollContainer, '#panel', JSON.stringify(claimStep));
  assert.ok(claimStep.anchor, `缺少落点 anchor: ${JSON.stringify(claimStep)}`);
  assert.ok(claimStep.fingerprint, `缺少控件指纹: ${JSON.stringify(claimStep)}`);
  assert.ok(flatten(workflow.steps).some((s) => s.type === 'assert' && s.text?.includes('签到成功')));
  console.log('PASS 学习：SPA 路由 + 内层滚动面板 + 落点/指纹都在产物里');
  await learningPage.close().catch(() => {});

  // 回放：不同面板高度都要能扫到并点到
  for (const variant of [{ height: 1600, drift: false }, { height: 2600, drift: false }, { height: 2600, drift: true }]) {
    const { height, drift } = variant;
    spacer = height;
    changedLayout = drift;
    actions = [];
    claimCount = 0;
    if (drift) {
      // 复现旧产物：OAuth/登录落点不在 route 中，按钮/面板选择器与文案均已改变。
      const stale = structuredClone(workflow);
      stale.route = ['/profile', '/checkin'];
      const claimIndex = stale.steps.findIndex((step) => step.type === 'click' && step.selector === '#claim');
      assert.ok(claimIndex >= 0);
      stale.steps[claimIndex].selector = 'text=立即签到';
      stale.steps[claimIndex].fingerprint = { tag: 'button', text: '立即签到' };
      stale.steps.splice(claimIndex, 0,
        { type: 'scroll', container: '#panel', ratio: 0.21 },
        { type: 'scroll', container: '#panel', ratio: 0.43 });
      await app.evaluate(async (workflow) => {
        const { sites } = await chrome.storage.local.get('sites');
        sites[0].checkin.workflow = workflow;
        await chrome.storage.local.set({ sites });
      }, stale);
    }
    /*
     * 先建立登录态（Cookie 记在 context 上，回放标签页共享）。
     *
     * 用**独立页面**登录，绝不能拿 app（扩展 options 页）去跳站点：
     * 那样 chrome.runtime 会失效，后面的 message() 直接报 undefined。
     * 也要先 clearCookies，否则 /login 被服务端判为已登录，没有表单可填。
     */
    await context.clearCookies();
    const loginPage = await context.newPage();
    await loginPage.goto(origin + '/login');
    await loginPage.waitForSelector('#username', { timeout: 10_000 });
    await loginPage.fill('#username', 'spa-user');
    await loginPage.fill('#password', 'spa-pass');
    await loginPage.click('#submit');
    await loginPage.waitForURL('**/dashboard/overview');
    await loginPage.close();
    const start = await message({ type: 'START_LOGIN', accountId: 'spa-account' });
    assert.equal(start.ok, true, JSON.stringify(start));
    const deadline = Date.now() + 60_000;
    let state;
    while (Date.now() < deadline) {
      state = await app.evaluate(async () => {
        const { results, status } = await chrome.storage.local.get(['results', 'status']);
        const { checkinQueue } = await chrome.storage.session.get('checkinQueue');
        return {
          result: results?.['spa-account'],
          status: Object.entries(status ?? {}).find(([k]) => k.startsWith('spa-account:'))?.[1],
          busy: !!checkinQueue?.active,
        };
      });
      if (state.result && !state.busy) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    assert.equal(state?.status, 'done', `panel height ${height}: ${JSON.stringify(state)}`);
    assert.equal(claimCount, 1, `panel height ${height}: claim POST 应恰好 1 次，实际 ${claimCount}`);
    if (drift) {
      assert.ok(state.result.steps.some((line) => line.includes('工作流接入学习路线:')), JSON.stringify(state));
      assert.ok(state.result.steps.some((line) => line.includes('页面控件快照命中签到动作')), JSON.stringify(state));
      assert.ok(!state.result.steps.some((line) => /向[上下]查找 text=立即签到|到 (?:21|43)%/.test(line)), JSON.stringify(state));
    }
    console.log(`PASS 回放 @ panel height ${height}${drift ? ' + 路线/面板/文案漂移' : ''}（claim POST=1）`);
  }
} finally {
  await context?.close();
  await new Promise((r) => server.close(r));
  rmSync(profile, { recursive: true, force: true });
}
