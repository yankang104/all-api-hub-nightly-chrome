/**
 * 手势保真端到端验收（真实扩展 + 真实 Chromium）。
 *
 * 主张：**用户真的拖了一下**之后
 *   1) 学习产物里出现一步 drag（起点/终点选择器 + 相对落点），
 *   2) 自动签到的回放会真的派发浏览器级按下 → 逐步移动 → 释放
 *      （页面实测收到 pointerdown/pointermove/pointerup 且 isTrusted === true），
 *   3) 相对落点被用上：回放落点与学习时一致（不是元素中心）。
 *
 * 与 learning-fidelity.mjs 的分工：那个脚本证明「采集侧认识拖拽」，本脚本证明
 * 「保存 → 回放」这条链路真的把拖拽当拖拽执行。
 *
 * 运行：node tests/e2e/learned-drag-replay.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXT = process.env.EXTENSION_DIR ? resolve(REPO, process.env.EXTENSION_DIR) : join(REPO, '.output', 'chrome-mv3');
const PROFILE_ROOT = join(REPO, 'output', 'learned-drag-replay');
const HEADLESS = process.env.E2E_HEADLESS !== '0';
const SITE_ID = 'drag-fixture';
const ACCOUNT_ID = 'drag-account';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? `  — ${detail}` : ''}`);
}

function flattenSteps(list) {
  const out = [];
  for (const step of list ?? []) {
    if (!step || typeof step !== 'object') continue;
    out.push(step);
    if (Array.isArray(step.then)) out.push(...flattenSteps(step.then));
    if (Array.isArray(step.else)) out.push(...flattenSteps(step.else));
  }
  return out;
}

/**
 * 验收站：一枚必须**拖到目标槽**才算完成的签到控件。
 *
 * 页面只承认「真实拖动」——按下→移动→在目标槽内释放；任何一次普通单击都
 * 只记点击、不产出签到成功。这样回放只要退化成单击就会被本脚本抓住。
 */
/**
 * 验收站：一个**拖放排序**式控件 —— 必须把卡片拖到目标卡片上，签到按钮才出现。
 *
 * 为什么不用滑块把手：验证码把手由回放侧的自动破解管线接管，学习侧有意不录
 * （rule: LEARNING 里的「把手噪声」）；真正的业务拖拽（排序/拖放）才是要学的。
 */
const PAGE = (claimed) => `<!doctype html><html lang="zh"><meta charset="utf-8"><title>拖拽验收站</title>
<style>
  body{margin:0;font:14px sans-serif}
  #list{display:flex;gap:12px;margin:40px;list-style:none;padding:0}
  .card{width:140px;height:90px;border:2px solid #ccd;border-radius:12px;display:flex;
        align-items:center;justify-content:center;cursor:grab;user-select:none;background:#f8fbff}
  .card.over{border-color:#4a8;background:#eefaf3}
  #claim{margin:40px;padding:12px 20px;display:none}
  #done{margin:40px;font-weight:700;color:#175}
</style>
<body>
  <p id="logged-in" style="margin:40px">当前账号：<span id="account-name">drag_user</span></p>
  <ul id="list">
    <li class="card" id="item-a" role="button" tabindex="0">把这张卡拖走</li>
    <li class="card" id="item-b" role="button" tabindex="0">目标卡片</li>
  </ul>
  <button id="claim" type="button">立即签到</button>
  <p id="result">${claimed ? '签到成功' : ''}</p>
  <script>
    window.__debug = { pointerdown: 0, pointermove: 0, pointerup: 0, trusted: 0, dropX: null, dropTarget: null, drops: 0, claims: 0,
      dragDownAt: null, dragUpAt: null, dragFromRect: null, dragToRect: null };
    var a = document.getElementById('item-a');
    var b = document.getElementById('item-b');
    var dragging = false;
    function note(type, event) {
      window.__debug[type] = (window.__debug[type] || 0) + 1;
      if (event && event.isTrusted) window.__debug.trusted += 1;
    }
    // 自定义指针式拖拽：按下即开始拖动，不依赖 HTML5 原生 drag 事件。
    document.addEventListener('pointerdown', function (e) {
      note('pointerdown', e);
      if (window.__debug.dragDownAt === null && (e.target === a || a.contains(e.target))) {
        var rect = a.getBoundingClientRect();
        var rectB = b.getBoundingClientRect();
        window.__debug.dragDownAt = { x: Math.round(e.clientX), y: Math.round(e.clientY) };
        window.__debug.dragFromRect = { left: rect.left, top: rect.top, w: rect.width, h: rect.height };
        window.__debug.dragToRect = { left: rectB.left, top: rectB.top, w: rectB.width, h: rectB.height };
        dragging = true;
        e.preventDefault();
      }
    });
    document.addEventListener('pointermove', function (e) {
      note('pointermove', e);
      if (!dragging) return;
      var rect = b.getBoundingClientRect();
      var inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
      b.classList.toggle('over', inside);
    });
    document.addEventListener('pointerup', function (e) {
      note('pointerup', e);
      if (dragging && window.__debug.dragUpAt === null) {
        window.__debug.dragUpAt = { x: Math.round(e.clientX), y: Math.round(e.clientY) };
      }
      if (!dragging) return;
      dragging = false;
      var rect = b.getBoundingClientRect();
      var inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
      b.classList.remove('over');
      if (!inside) return;
      window.__debug.drops += 1;
      window.__debug.dropX = rect.left + rect.width / 2;
      window.__debug.dropTarget = 'item-b';
      a.remove();
      document.getElementById('claim').style.display = 'inline-block';
    });
    document.getElementById('claim').addEventListener('click', async function () {
      window.__debug.claims += 1;
      await fetch('/api/drag-claim', { method: 'POST', credentials: 'include' }).catch(function () {});
      document.getElementById('result').textContent = '签到成功';
    });
  </script>
</body></html>`;

let claimCount = 0;
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  // 身份接口：回放的身份核验闸门要能读到当前账号（与真实站点同一形状）。
  // 配额随签到递增 —— 引擎用它做守恒差分，确认签到真的生效。
  if (url.pathname === '/api/user/self') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      success: true,
      data: { id: 101, username: 'drag_user', quota: 500000 + claimCount * 500000, used_quota: 0 },
    }));
    return;
  }
  if (url.pathname === '/api/drag-claim') {
    claimCount += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  // 站点把签到页放在 /checkin：学习侧的「身份核验页」推断依赖路径语义。
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE(claimCount > 0));
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;

mkdirSync(PROFILE_ROOT, { recursive: true });
for (const name of readdirSync(PROFILE_ROOT)) {
  if (!name.startsWith('drag-')) continue;
  try { rmSync(join(PROFILE_ROOT, name), { recursive: true, force: true }); } catch { /* 改名保留 */ }
}
const profile = mkdtempSync(join(PROFILE_ROOT, 'drag-'));

const context = await chromium.launchPersistentContext(profile, {
  headless: HEADLESS,
  ...(HEADLESS ? { channel: 'chromium' } : {}),
  viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

let exitCode = 0;
try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionId = new URL(worker.url()).hostname;
  const app = await context.newPage();
  await app.goto(`chrome-extension://${extensionId}/options.html`);
  await app.getByPlaceholder('搜索站点、账号或备注').waitFor();

  const waitForApp = async (predicate, timeoutMs = 20000, label = '') => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await app.evaluate(predicate).catch(() => undefined);
      if (value) return value;
      await new Promise((done) => setTimeout(done, 200));
    }
    throw new Error(`等待超时${label ? ` [${label}]` : ''}`);
  };

  await app.evaluate(async ({ origin, siteId }) => {
    await chrome.storage.local.set({
      sites: [{
        id: siteId,
        name: '拖拽验收站',
        loginUrl: `${origin}/checkin`,
        loginMethod: 'form',
        successIndicator: '#logged-in',
        adapter: { family: 'new-api', siteType: 'new-api', quotaPerUnit: 500000 },
        selectors: { username: '#username', password: '#password', submit: '#login-submit' },
        closeModalSelectors: [],
        checkin: { method: 'auto', url: '/checkin' },
      }],
      accounts: [{ id: 'drag-account', siteId, username: 'drag_user', password: 'drag_pw' }],
      proxies: [],
      status: {},
      results: {},
      balances: {},
    });
  }, { origin, siteId: SITE_ID });
  await app.reload();
  await app.getByPlaceholder('搜索站点、账号或备注').waitFor();

  // ── 学习：拖拽滑轨把手到目标槽内释放 ─────────────────────────────
  console.log('\n── 学习：拖拽 ──');
  const learnTabPromise = context.waitForEvent('page');
  await app.getByRole('button', { name: '展开账号 拖拽验收站' }).click();
  const row = app.locator(`[data-account-id="${ACCOUNT_ID}"]`);
  await row.waitFor();
  await row.getByRole('button', { name: /学习本站登录与签到流程/ }).first().click();

  const session = await waitForApp(async () => {
    const sessions = (await chrome.runtime.sendMessage({ type: 'GET_LEARNING' }))?.feature?.learningSessions ?? [];
    return sessions.find((item) => item.accountId === 'drag-account') ?? false;
  }, 30000, '学习会话');
  check('学习会话启动', !!session, `kind=${session?.kind}`);

  const learnPage = await learnTabPromise;
  await learnPage.waitForLoadState('domcontentloaded');

  await learnPage.waitForSelector('#item-a');
  const itemA = await learnPage.locator('#item-a').boundingBox();
  const itemB = await learnPage.locator('#item-b').boundingBox();
  // 起点从卡片左侧按下（相对落点 ≈ 0.25），终点落在目标卡右侧（相对落点 ≈ 0.75）：
  // 回放若忽略 anchor 只按中心拖，本脚本能看出来。
  await learnPage.mouse.move(itemA.x + itemA.width * 0.25, itemA.y + itemA.height / 2);
  await learnPage.mouse.down();
  await learnPage.mouse.move(itemA.x + 80, itemA.y + itemA.height / 2, { steps: 5 });
  await learnPage.mouse.move(itemB.x + itemB.width * 0.75, itemB.y + itemB.height / 2, { steps: 8 });
  await learnPage.mouse.up();
  await learnPage.waitForSelector('#claim', { state: 'visible', timeout: 10000 });
  await learnPage.waitForTimeout(400);

  const debugAfterLearn = await learnPage.evaluate(() => window.__debug);
  check('学习时页面真的收到了拖动（按下/移动/释放 + 落在目标卡片上）',
    debugAfterLearn.pointerdown >= 1 && debugAfterLearn.pointermove >= 1 && debugAfterLearn.pointerup >= 1
      && debugAfterLearn.dropTarget === 'item-b',
    JSON.stringify(debugAfterLearn));

  await learnPage.locator('#claim').click();
  await learnPage.waitForFunction(() => document.getElementById('result')?.textContent?.includes('签到成功'), null, { timeout: 15000 });
  await learnPage.waitForTimeout(400);
  check('学习演示完成了签到（页面出现「签到成功」）', claimCount === 1, `claims=${claimCount}`);

  // 用管理页同一条消息结束学习 —— 失败原因可以从回执直接读到。
  const endResult = await app.evaluate(() => chrome.runtime.sendMessage({ type: 'TOGGLE_LEARNING', accountId: 'drag-account' }));
  console.log('   结束学习回执 =', JSON.stringify(endResult).slice(0, 700));
  const saved = await waitForApp(async () => {
    const sites = (await chrome.storage.local.get('sites')).sites ?? [];
    const site = sites.find((item) => item.id === 'drag-fixture');
    const steps = site?.checkin?.workflow?.steps ?? [];
    return steps.length > 0 ? steps : false;
  }, 30000, '签到流程保存');

  const allSteps = JSON.stringify(saved);
  check('保存的流程里出现了 drag 步骤（不是点击）',
    /\"type\":\"drag\"/.test(allSteps), allSteps.slice(0, 300));
  check('drag 步骤带起点/终点选择器', /\"toSelector\"/.test(allSteps));

  // ── 回放：清空会话后自动签到，必须真的拖动 ───────────────────────
  console.log('\n── 回放：自动签到 ──');
  for (const page of context.pages()) {
    if (page.url().startsWith(origin)) await page.close().catch(() => {});
  }
  await context.clearCookies();
  claimCount = 0;

  const started = await app.evaluate(() => chrome.runtime.sendMessage({ type: 'START_LOGIN', accountId: 'drag-account' }));
  check('START_LOGIN 入队', started?.ok === true, JSON.stringify(started));

  const deadline = Date.now() + 120000;
  let status = 'none';
  while (Date.now() < deadline) {
    const state = await app.evaluate(async () => (await chrome.storage.local.get(['status', 'results'])));
    status = Object.entries(state.status ?? {}).find(([key]) => key.startsWith('drag-account:'))?.[1] ?? 'none';
    if (['done', 'failed', 'attention'].includes(status)) break;
    await new Promise((done) => setTimeout(done, 400));
  }
  check('自动签到以成功收尾（todo 状态变成已完成）', status === 'done', `status=${status}`);

  const runPage = context.pages().find((page) => page.url().startsWith(origin));
  const debugAfterReplay = runPage ? await runPage.evaluate(() => window.__debug).catch(() => null) : null;
  check('回放走了浏览器级拖拽（受信 pointerdown/move/up 都到了页面）',
    !!debugAfterReplay && debugAfterReplay.trusted >= 3 && debugAfterReplay.drops >= 1,
    JSON.stringify(debugAfterReplay));
  check('回放的拖放命中了学习时那个目标卡片（toSelector 被真正用上）',
    !!debugAfterReplay && debugAfterReplay.dropTarget === 'item-b', JSON.stringify(debugAfterReplay));
  // 落点保真：按下点在学习时那次按下点的同一相对位置（rx=0.25），而不是元素中心。
  const fromRect = debugAfterReplay?.dragFromRect;
  const toRect = debugAfterReplay?.dragToRect;
  const expectedDownX = fromRect ? fromRect.left + fromRect.w * 0.25 : null;
  const expectedUpX = toRect ? toRect.left + toRect.w * 0.75 : null;
  check('回放的按下点用了学习到的相对落点（不是元素中心盲按）',
    !!debugAfterReplay?.dragDownAt && expectedDownX !== null && Math.abs(debugAfterReplay.dragDownAt.x - expectedDownX) <= 3,
    `dragDownAt=${JSON.stringify(debugAfterReplay?.dragDownAt)} expectedX=${expectedDownX}`);
  check('回放的松开点落在学习时那个终点卡片的同一相对位置（不是中心）',
    !!debugAfterReplay?.dragUpAt && expectedUpX !== null && Math.abs(debugAfterReplay.dragUpAt.x - expectedUpX) <= 3,
    `dragUpAt=${JSON.stringify(debugAfterReplay?.dragUpAt)} expectedX=${expectedUpX}`);
  check('回放后完成了签到（拖动之后按钮被点到、只提交一次）',
    claimCount === 1, `claims=${claimCount}`);

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`拖拽回放验收：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) for (const item of failed) console.log(`  ✖ ${item.name}`);
  console.log('='.repeat(60));
  exitCode = failed.length ? 1 : 0;
} catch (error) {
  console.error('未捕获错误：', error);
  exitCode = 1;
} finally {
  await context.close().catch(() => {});
  await new Promise((done) => server.close(done));
}
process.exitCode = exitCode;
