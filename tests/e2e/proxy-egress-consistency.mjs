/**
 * 出口一致性守卫的端到端验收。
 *
 * 单测只证明判定函数本身对；这条脚本证明**它真的接在了启动路径上**，
 * 也就是用户点下去会被如实拒绝，而不是静默从别人的出口出站。
 *
 * 为什么必须走真实浏览器：判据读的是 chrome.proxy.settings 的真实回读值，
 * 而「学习会话持有全局代理」这件事只有真实 Chrome 才能复现。
 *
 * 覆盖四个真实窗口（都是此前会静默走错出口、或互相顶掉出口的路径）：
 *   A. 一个账号正在学习（持有全局代理）时，**直连账号**开始签到必须被拒绝；
 *   B. 签到队列在跑时，开始学习必须被拒绝（不抢正在跑的任务的出口）；
 *   C. 一个**直连**账号正在学习时，**带代理**的账号开始学习必须被拒绝
 *      （否则会把前一条学习会话的出口当场改掉）；
 *   D. 不变量回归：任何被拒绝的路径都不得改动正在生效的全局代理端点。
 */
import { createServer as createHttpServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright';

const EXT = resolve('.output/chrome-mv3');
const checks = [];
const check = (name, pass, detail = '') => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

/** 一个最小 HTTP 代理：记录 CONNECT 目标，并把 *.test 转发到本地站点端口 */
async function startProxy(label) {
  const requests = [];
  const server = createHttpServer((req, res) => { res.writeHead(200); res.end('ok'); });
  server.on('connect', (req, clientSocket, head) => {
    const [host, portText] = String(req.url).split(':');
    requests.push({ host });
    const upstream = net.connect(Number(portText), '127.0.0.1', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  console.log(`  代理 ${label}: 127.0.0.1:${port}`);
  return { label, port, requests, hosts: () => [...new Set(requests.map((r) => r.host))], close: () => new Promise((r) => server.close(r)) };
}

/** 极简明文站点（这些用例不真的走完签到，只要能开一个属于该账号的页面即可） */
async function startSite() {
  const server = createHttpServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><meta charset="utf-8"><title>egress</title>'
      + '<form method="POST" action="/login"><input id="username" name="username">'
      + '<input id="password" name="password" type="password">'
      + '<button id="submit" type="submit">登录</button></form>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

const site = await startSite();
const proxyA = await startProxy('A');
const output = resolve('output/proxy-egress-consistency');
mkdirSync(output, { recursive: true });
const profile = mkdtempSync(join(output, 'profile-'));
let ctx;

try {
  ctx = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: 'chromium',
    viewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
    ],
  });

  const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker', { timeout: 30000 });
  const extId = new URL(sw.url()).host;
  const app = await ctx.newPage();
  await app.goto(`chrome-extension://${extId}/options.html`);
  await app.waitForLoadState('domcontentloaded');

  /*
   * 两个账号：proxied 挂代理 A；direct 显式直连（proxyMode: 'none'）。
   * 站点地址用 127.0.0.1 —— 直连真的能打开，这样「出口被换掉」这件事
   * 才只能靠全局代理回读发现，而不是被加载失败掩盖。
   */
  await app.evaluate(async ({ port, proxyPort }) => {
    await chrome.storage.local.set({
      proxies: [{ id: 'px-a', name: '代理 A', scheme: 'http', host: '127.0.0.1', port: proxyPort }],
      sites: [
        {
          id: 'site-egress',
          name: '出口一致性验收站',
          loginUrl: `http://127.0.0.1:${port}/login`,
          loginMethod: 'form',
          selectors: { username: '#username', password: '#password', submit: '#submit' },
          closeModalSelectors: [],
          checkin: { method: 'button', buttonSelector: '#submit', successSelector: '#submit' },
        },
        {
          id: 'site-other',
          name: '另一个站点（跨站学习互斥用）',
          loginUrl: `http://127.0.0.1:${port}/login`,
          loginMethod: 'form',
          selectors: { username: '#username', password: '#password', submit: '#submit' },
          closeModalSelectors: [],
          checkin: { method: 'button', buttonSelector: '#submit', successSelector: '#submit' },
        },
      ],
      accounts: [
        {
          id: 'proxied', siteId: 'site-egress', username: 'proxied-user',
          password: 'sentinel-password', enabled: true,
          proxyMode: 'pool', proxyId: 'px-a', proxyPinned: true,
        },
        {
          id: 'direct', siteId: 'site-egress', username: 'direct-user',
          password: 'sentinel-password', enabled: true, proxyMode: 'none',
        },
        {
          id: 'proxied-other', siteId: 'site-other', username: 'other-user',
          password: 'sentinel-password', enabled: true,
          proxyMode: 'pool', proxyId: 'px-a', proxyPinned: true,
        },
      ],
      results: {}, status: {}, balances: {},
    });
  }, { port: site.port, proxyPort: proxyA.port });

  const readProxy = () => app.evaluate(async () => {
    const s = await chrome.proxy.settings.get({ incognito: false });
    const single = s?.value?.rules?.singleProxy;
    return { mode: s?.value?.mode, control: s?.levelOfControl, host: single?.host, port: single?.port };
  });
  const send = (message) => app.evaluate((m) => chrome.runtime.sendMessage(m), message);
  const waitFor = async (predicate, timeoutMs = 30000, interval = 150) => {
    const deadline = Date.now() + timeoutMs;
    let seen;
    while (Date.now() < deadline) {
      seen = await predicate();
      if (seen) return seen;
      await new Promise((r) => setTimeout(r, interval));
    }
    return seen;
  };

  /* ── A. 学习会话持有全局代理时，直连账号不许开跑 ───────────────── */
  console.log('\n── A. 学习占用出口时，直连账号开始签到必须被拒绝 ──');
  const learnProxied = await send({ type: 'TOGGLE_LEARNING', accountId: 'proxied', kind: 'login' });
  check('A1. 带代理的账号开始学习', learnProxied?.ok === true, JSON.stringify(learnProxied).slice(0, 200));
  const held = await waitFor(async () => {
    const p = await readProxy();
    return p.mode === 'fixed_servers' && p.port === proxyA.port ? p : null;
  });
  check('A2. 学习会话期间全局代理 = 代理 A（现场就绪）',
    held?.mode === 'fixed_servers' && held?.port === proxyA.port,
    `mode=${held?.mode} port=${held?.port} 期望 ${proxyA.port}`);

  const directStart = await send({ type: 'START_LOGIN', accountId: 'direct' });
  check('A3. 直连账号开始签到被拒绝，而不是从代理 A 出站',
    directStart?.ok === false && /代理|出口/.test(directStart?.error ?? ''),
    JSON.stringify(directStart).slice(0, 300));

  const stillHeld = await readProxy();
  check('A4. 被拒绝后，学习会话的全局代理端点没被改动',
    stillHeld.mode === 'fixed_servers' && stillHeld.port === proxyA.port,
    `mode=${stillHeld.mode} port=${stillHeld.port}`);

  /* ── B. 签到队列在跑时，不许开始学习 ──────────────────────────── */
  console.log('\n── B. 签到进行中时开始学习必须被拒绝 ──');
  const cancelLearn = await send({ type: 'CANCEL_LEARNING', accountId: 'proxied' });
  check('B0. 先结束那条学习会话（清场）', cancelLearn?.ok === true, JSON.stringify(cancelLearn).slice(0, 200));

  /*
   * 用一个直连账号启动签到：它不会持租约，所以「队列在跑」这件事只能靠
   * 队列状态本身（而不是租约）被学习路径看见 —— 正是要验的那一条。
   */
  const directTask = await send({ type: 'START_LOGIN', accountId: 'direct' });
  check('B1. 直连账号的签到任务被接受', directTask?.ok === true, JSON.stringify(directTask).slice(0, 200));

  const busySeen = await waitFor(async () => {
    const s = await app.evaluate(() => chrome.storage.session.get('checkinQueue'));
    return s?.checkinQueue?.active || (s?.checkinQueue?.pendingAccountIds ?? []).length > 0 ? s.checkinQueue : null;
  }, 20000);
  check('B2. 队列确实处于忙状态（现场就绪）', !!busySeen, JSON.stringify(busySeen).slice(0, 200));

  const learnWhileBusy = await send({ type: 'TOGGLE_LEARNING', accountId: 'proxied', kind: 'login' });
  check('B3. 队列在跑时开始学习被拒绝',
    learnWhileBusy?.ok === false && /签到|完成后再/.test(learnWhileBusy?.error ?? ''),
    JSON.stringify(learnWhileBusy).slice(0, 300));

  /* ── C. 直连账号正在学习时，带代理的账号不许开学习 ───────────── */
  console.log('\n── C. 直连学习进行中时，带代理的学习必须被拒绝 ──');
  await waitFor(async () => {
    const s = await app.evaluate(() => chrome.storage.session.get('checkinQueue'));
    return !s?.checkinQueue?.active && (s?.checkinQueue?.pendingAccountIds ?? []).length === 0 ? true : null;
  }, 90000, 300);
  await send({ type: 'CANCEL_CHECKIN', accountIds: ['direct'] }).catch(() => {});
  await app.evaluate(async () => { await chrome.storage.session.remove('checkinQueue'); });
  await waitFor(async () => ((await readProxy()).mode !== 'fixed_servers' ? true : null), 30000, 300);

  const learnDirect = await send({ type: 'TOGGLE_LEARNING', accountId: 'direct', kind: 'login' });
  check('C1. 直连账号开始学习（现场就绪）', learnDirect?.ok === true, JSON.stringify(learnDirect).slice(0, 200));

  /*
   * 关键：用**另一个站点**上挂代理的账号来试，才不会撞上既有的「同站互斥」。
   * 这条拒绝必须由「学习会话之间不许抢出口」这条新守卫给出，否则它就会把
   * 前一条直连学习会话的出口当场改掉。
   */
  const learnProxied2 = await send({ type: 'TOGGLE_LEARNING', accountId: 'proxied-other', kind: 'login' });
  check('C2. 另一站点上带代理的学习被拒绝，且原因不是「同站互斥」（是出口互斥）',
    learnProxied2?.ok === false
      && /学习/.test(learnProxied2?.error ?? '')
      && !/同站点只能有一条录制/.test(learnProxied2?.error ?? ''),
    JSON.stringify(learnProxied2).slice(0, 300));

  const afterC = await readProxy();
  check('C3. 被拒绝后全局代理没有被改动（直连学习仍是直连）',
    afterC.mode !== 'fixed_servers' || afterC.port !== proxyA.port,
    `mode=${afterC.mode} port=${afterC.port}`);

  await send({ type: 'CANCEL_LEARNING', accountId: 'direct' }).catch(() => {});
} finally {
  await ctx?.close().catch(() => {});
  await proxyA.close().catch(() => {});
  await site.close().catch(() => {});
  writeFileSync(join(output, 'result.json'), JSON.stringify(checks, null, 2));
}

const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
console.log(`结果: ${failed.length ? 'FAIL' : 'PASS'}`);
process.exit(failed.length ? 1 : 0);
