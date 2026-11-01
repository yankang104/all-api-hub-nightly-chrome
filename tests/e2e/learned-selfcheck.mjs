/**
 * 自检：复刻 CottonAPI 形态（控制台 → 个人资料 → 长页面懒加载签到按钮）验证三件事。
 *
 * 1. 演示只点了导航项（没点签到）时，结束学习必须**拒绝保存**，而不是存出一份
 *    回放必然找不到签到按钮的流程（用户现场：学到的流程以「点击 个人资料」收尾）；
 * 2. 被拒后会话仍在，用户接着滚到按钮点签到、再结束学习，能正常保存；
 *    保存的产物里导航点击必须带页面守卫（只在自己的页面执行），签到步骤带 scrollIntoView；
 * 3. 回放：签到按钮懒渲染在首屏下方时靠滚动找到并点击；当天已签到时按「已完成」
 *    收尾且状态落成 done（不是 pending），不重复点击。
 *
 * 只访问本地虚构站点，加载真实 WXT 构建产物（.output/chrome-mv3），断言来源=扩展存储
 * + 页面 DOM + 虚构站请求日志，不做截图驱动。
 * node tests/e2e/learned-selfcheck.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const USERNAME = 'sentinel_cotton';
const SITE_ID = 'selfcheck-fixture';
const ACCOUNT_ID = 'selfcheck-account';
let checkedIn = false;
let quota = 1_030_000;
let claimPosts = [];
let navClicks = [];

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture.test');
  const path = url.pathname;
  if (path === '/api/checkin') {
    for await (const _ of req) { /* drain */ }
    checkedIn = true;
    quota += 210_000;
    claimPosts.push({ scrollY: Number(req.headers['x-fixture-scroll'] ?? 0), at: Date.now() });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true, message: '签到成功' }));
    return;
  }
  if (path === '/record/nav') {
    let body = '';
    for await (const chunk of req) body += chunk;
    navClicks.push(JSON.parse(body || '{}'));
    res.setHeader('Content-Type', 'application/json');
    res.end('{}');
    return;
  }
  if (path === '/api/user/self') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      success: true,
      data: { id: 77, username: USERNAME, quota, used_quota: 0 },
    }));
    return;
  }
  if (path.startsWith('/api/')) {
    res.writeHead(404);
    res.end('{}');
    return;
  }
  if (path !== '/dashboard/overview' && path !== '/profile') {
    res.writeHead(302, { Location: '/dashboard/overview' });
    res.end();
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // 没有 no-store 时 Chromium 会启发式缓存演示阶段的 HTML，回放拿到的是
  // 「按钮还在」的旧页面 —— 自检会产生假阳性（已签到却又能点到按钮）。
  res.setHeader('Cache-Control', 'no-store');
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>selfcheck</title>
    <style>body{margin:20px;font:16px sans-serif}#claim{padding:16px 28px;font-size:18px}</style></head>
    <body><div id="logged-in">当前账号 ${USERNAME}</div><div id="app"></div><script>
    const onNav = (event) => {
      fetch('/record/nav', { method: 'POST', keepalive: true,
        body: JSON.stringify({ path: location.pathname, trusted: event.isTrusted }) }).catch(() => {});
    };
    const app = document.getElementById('app');
    if (location.pathname === '/profile') {
      app.innerHTML = '<h1>个人资料</h1><p>用户名：${USERNAME}</p>'
        + '<div style="height:2400px">页面很长，签到控件在下方</div>'
        + '<div id="slot"></div><div style="height:800px"></div>';
      const signed = ${checkedIn};
      const reveal = () => {
        if (signed || document.getElementById('claim')) return;
        const button = document.createElement('button');
        button.id = 'claim';
        button.textContent = '立即签到';
        button.addEventListener('click', async (event) => {
          if (!event.isTrusted) return;
          await fetch('/api/checkin', { method: 'POST', keepalive: true,
            headers: { 'x-fixture-scroll': String(Math.round(window.scrollY)) } });
          document.getElementById('slot').innerHTML = '<p>签到成功，已签到</p>';
        });
        document.getElementById('slot').append(button);
      };
      let guard = 0;
      const timer = setInterval(() => {
        guard += 1;
        if (signed || guard > 60) { clearInterval(timer); return; }
        if (window.scrollY > 1600) { clearInterval(timer); reveal(); }
      }, 100);
      window.addEventListener('scroll', () => { if (!signed && window.scrollY > 1600) reveal(); });
      if (signed) document.getElementById('slot').innerHTML = '<p>今日已签到</p>';
    } else {
      app.innerHTML = '<h1>控制台</h1><a id="nav-profile" href="/profile">个人资料</a>';
      const nav = document.getElementById('nav-profile');
      nav.addEventListener('click', (event) => { onNav(event); event.preventDefault(); location.href = '/profile'; });
    }
    </script></body></html>`);
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;

const dir = resolve('output/learned-selfcheck');
mkdirSync(dir, { recursive: true });
const profile = mkdtempSync(resolve(dir, 'profile-'));
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const flatten = (steps) => (steps ?? []).flatMap((step) => (
  step.type === 'if' ? [...flatten(step.then), ...flatten(step.else)] : [step]
));

let context;
let exitCode = 0;
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: 'chromium',
    viewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${resolve('.output/chrome-mv3')}`,
      `--load-extension=${resolve('.output/chrome-mv3')}`,
    ],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionId = new URL(worker.url()).hostname;

  const app = await context.newPage();
  await app.goto(`chrome-extension://${extensionId}/options.html`);
  await app.evaluate(async ({ origin, siteId, accountId, username }) => {
    await chrome.storage.local.set({
      sites: [{
        id: siteId,
        name: '自检仿真站',
        loginUrl: `${origin}/dashboard/overview`,
        successIndicator: '#logged-in',
        selectors: { username: '#fixture-user', password: '#fixture-password', submit: '#fixture-submit' },
        closeModalSelectors: [],
        checkin: { method: 'auto', url: '/dashboard/overview' },
        adapter: { family: 'new-api', siteType: 'new-api', quotaPerUnit: 500000 },
      }],
      accounts: [{ id: accountId, siteId, username, password: 'sentinel-unused-password' }],
      status: {},
      results: {},
    });
  }, { origin, siteId: SITE_ID, accountId: ACCOUNT_ID, username: USERNAME });

  const message = (payload) => app.evaluate((value) => chrome.runtime.sendMessage(value), payload);
  const readState = () => app.evaluate(async () => {
    const stored = await chrome.storage.local.get(['sites', 'status', 'results']);
    return {
      workflow: stored.sites?.[0]?.checkin?.workflow,
      status: Object.entries(stored.status ?? {}).find(([key]) => key.startsWith('selfcheck-account'))?.[1],
      result: stored.results?.['selfcheck-account'],
      key: Object.keys(stored.status ?? {}).find((key) => key.startsWith('selfcheck-account')),
    };
  });

  const seat = await context.newPage();
  await seat.goto(`${origin}/dashboard/overview`);
  await seat.waitForSelector('#logged-in');

  // ── 1. 只点导航的演示必须被拒绝 ────────────────────────────────────
  const started = await message({ type: 'TOGGLE_LEARNING', accountId: ACCOUNT_ID, kind: 'checkin' });
  assert.equal(started.ok, true, JSON.stringify(started));
  await pause(400);
  await seat.click('#nav-profile');
  await seat.waitForURL((url) => url.pathname === '/profile');
  await seat.waitForSelector('#logged-in');
  await pause(400);
  const refused = await message({ type: 'TOGGLE_LEARNING', accountId: ACCOUNT_ID, kind: 'checkin' });
  assert.equal(refused.ok, false, `只点导航的演示竟被保存: ${JSON.stringify(refused)}`);
  assert.match(refused.error, /没录到|签到/, refused.error);
  assert.equal((await readState()).workflow, undefined, '被拒绝的演示不应写入任何工作流');
  console.log(`PASS 只点导航的演示被拒绝保存：${refused.error}`);

  // ── 2. 继续同一场演示：滚到按钮点签到 → 保存 ────────────────────────
  await seat.mouse.move(640, 450);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await seat.mouse.wheel(0, 900);
    await pause(200);
    if (await seat.locator('#claim').count()) break;
  }
  await seat.locator('#claim').click();
  await seat.waitForSelector('text=签到成功');
  assert.equal(claimPosts.length, 1, '演示阶段的签到请求应当恰好一次');
  await pause(200);
  const saved = await message({ type: 'TOGGLE_LEARNING', accountId: ACCOUNT_ID, kind: 'checkin' });
  assert.equal(saved.ok, true, `拒绝后继续演示仍应能保存: ${JSON.stringify(saved)}`);
  const state = await readState();
  const workflow = state.workflow;
  assert.deepEqual(workflow.route, ['/dashboard/overview', '/profile'], JSON.stringify(workflow));
  assert.equal(workflow.identityPath, '/profile');
  // 导航点击必须被它自己页面的守卫包住：回放到 /profile 时不能重放这一下。
  const guardedNav = workflow.steps.find((step) => step.type === 'if'
    && step.condition?.pattern === '/dashboard/overview'
    && flatten(step.then).some((inner) => inner.selector === '#nav-profile'));
  assert.ok(guardedNav, `导航点击缺少页面守卫: ${JSON.stringify(workflow.steps)}`);
  const claimStep = flatten(workflow.steps).find((step) => step.selector === '#claim');
  assert.deepEqual(claimStep, { type: 'click', selector: '#claim', scrollIntoView: true });
  assert.ok(!JSON.stringify(workflow).includes('2400'), '不得把学习时的滚动像素写进配置');
  console.log(`PASS 继续演示后保存成功：route=${workflow.route.join(' → ')} identity=${workflow.identityPath}`);

  // ── 3. 当天已签到再回放：按已完成收尾，状态必须是 done ──────────────
  checkedIn = true;
  claimPosts = [];
  navClicks = [];
  // 模拟用户从控制台开始：已有标签页停在 /profile 时引擎可能直接复用，
  // 这里把起点摆回控制台，让「导航 → 签到页」这条路线真的被走一遍。
  await seat.goto(`${origin}/dashboard/overview`);
  await seat.waitForSelector('#logged-in');
  await message({ type: 'START_LOGIN', accountId: ACCOUNT_ID });
  const waitIdle = async (timeout = 90_000) => {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      const queue = await app.evaluate(async () => (await chrome.storage.session.get('checkinQueue')).checkinQueue);
      last = await readState();
      if (!queue?.active && last.result) return last;
      await pause(250);
    }
    const debug = await app.evaluate(async () => {
      const session = await chrome.storage.session.get(null);
      return Object.entries(session).filter(([key]) => /task|queue/i.test(key)).map(([key, value]) => ({
        key, stage: value?.stage, tabId: value?.tabId, steps: value?.steps,
        active: value?.active, pendingAccountIds: value?.pendingAccountIds,
      }));
    });
    console.error('Selfcheck timeout:', JSON.stringify({ debug, claimPosts, navClicks, pages: context.pages().map((page) => page.url()) }, null, 2));
    return last;
  };
  let after = await waitIdle();
  assert.equal(after.status, 'done', `已签到回放后状态应为 done，实际 ${after.status}: ${JSON.stringify(after)}`);
  assert.match(after.result?.message ?? '', /已完成|已签到/, JSON.stringify(after.result));
  assert.equal(claimPosts.length, 0, `已签到时不应再次点击签到按钮: ${JSON.stringify({ claimPosts, steps: after.result?.steps })}`);
  assert.deepEqual(navClicks.map((click) => click.path), ['/dashboard/overview'], JSON.stringify(navClicks));
  assert.ok(navClicks.every((click) => click.trusted), JSON.stringify(navClicks));
  console.log(`PASS 已签到回放：status=${after.status} message=${after.result?.message}`);

  // ── 4. 新的一天再回放：滚动找到懒加载按钮、可信点击一次 ─────────────
  checkedIn = false;
  claimPosts = [];
  navClicks = [];
  await app.evaluate(async () => {
    await chrome.storage.local.set({ results: {}, status: {} });
  });
  await seat.goto(`${origin}/dashboard/overview`);
  await seat.waitForSelector('#logged-in');
  await message({ type: 'START_LOGIN', accountId: ACCOUNT_ID });
  after = await waitIdle();
  assert.equal(after.status, 'done', JSON.stringify(after));
  assert.equal(claimPosts.length, 1, `应恰好签到一次: ${JSON.stringify({ claimPosts, result: after.result })}`);
  assert.ok(claimPosts[0].scrollY > 0, `签到请求应发生在滚过页面之后: ${JSON.stringify(claimPosts)}`);
  assert.deepEqual(navClicks.map((click) => click.path), ['/dashboard/overview'], JSON.stringify(navClicks));
  const steps = after.result?.steps ?? [];
  const logs = steps.join('\n');
  assert.match(logs, /工作流回放中间页点击 #nav-profile/, logs);
  assert.match(logs, /工作流沿学习路线进入 \/profile/, logs);
  assert.match(logs, /工作流已点击 #claim/, logs);
  assert.ok(!logs.includes('找不到可点击元素'), `回放不应报找不到控件:\n${logs}`);
  console.log('PASS 新的一天回放：导航页 → 滚动 → 点击 #claim，日志顺序与录制一致');
} catch (error) {
  exitCode = 1;
  console.error('SELF-CHECK FAILED:', error instanceof Error ? error.message : error);
} finally {
  await context?.close().catch(() => {});
  await new Promise((done) => server.close(done));
  rmSync(profile, { recursive: true, force: true });
}
process.exitCode = exitCode;
