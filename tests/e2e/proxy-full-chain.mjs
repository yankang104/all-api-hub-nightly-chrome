/**
 * 代理全链路回归：学习 / 任务真的经代理出站，结束后全局代理被还原，
 * 且不同账号走不同出口。
 *
 * 为什么必须走真实浏览器：`chrome.proxy` 是**浏览器级**设置，它的生效、
 * 回读与控制权判定都只有真实 Chrome 才有；jsdom 里 `chrome.proxy.settings.set`
 * 是个空壳，连「设下去没生效」这种情况都复现不出来。
 *
 * 站点的 host 用只有代理才认识的名字（*.test），本地 DNS 解析不了 ——
 * 所以「页面能打开」这件事本身就证明请求是经代理出站，而不是本机直连：
 *   1. 代理收到 `CONNECT main.test:PORT`（HTTPS 隧道）；
 *   2. 代理内部把它映射到本机的真实站点端口；
 *   3. 站点服务器只监听 127.0.0.1，直连只会得到 ERR_NAME_NOT_RESOLVED。
 *
 * 断言分四组：
 *   A. 学习会话期间全局代理 = 账号配置的代理；结束时被还原；
 *   B. 签到任务期间走配置的代理，任务结束后全局代理被还原；
 *   C. 不同账号 → 不同代理，两个代理各自收到对应账号的请求；
 *   D. 余额刷新不再绕过账号代理（站点上开着标签页也一样）。
 */
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import net from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const TESTS = dirname(fileURLToPath(import.meta.url));
const EXT = resolve('.output/chrome-mv3');
if (!readFileSync(resolve(EXT, 'manifest.json'), 'utf8').includes('"manifest_version"')) {
  console.error('缺少构建产物 .output/chrome-mv3，先运行 npx wxt build');
  process.exit(1);
}

const checks = [];
const check = (name, pass, detail = '') => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

/*
 * 崩溃诊断。
 *
 * 真实浏览器里扩展的后台任务会结束标签页、切全局代理；如果 Chrome 的某个
 * 渲染进程在这一串操作里崩掉，Playwright 抛出来的是干巴巴的「Target crashed」，
 * 看不出当时在跑哪一段。这里的 step() 把「出事前最后一步」打出来，并把
 * 崩溃转成一条明确的 FAIL（而不是让整个脚本不体面地抛栈）。
 */
let currentStep = '(启动)';
const step = (name) => { currentStep = name; };
const crashNotes = [];
function noteCrash(what, detail) {
  crashNotes.push(`${what}: ${detail}`);
  console.log(`[诊断] ${what} — ${detail}（当前步骤：${currentStep}）`);
}
process.on('uncaughtException', (error) => {
  console.log(`\n[失败] 未捕获异常，当前步骤：${currentStep}`);
  if (crashNotes.length) console.log(`[诊断] ${crashNotes.join(' | ')}`);
  console.log(String(error?.stack ?? error));
  process.exit(1);
});

/* ------------------------------------------------------------------ *
 * 测试用 TLS 证书（自签，仅覆盖 .test 名字）
 *
 * 站点配置要求 HTTPS（`site-security` 的校验只对 localhost 放行明文），
 * 所以这里必须有证书。Chrome 侧用 `--ignore-certificate-errors` 放行自签。
 * ------------------------------------------------------------------ */
const TLS_KEY = readFileSync(join(TESTS, 'fixtures', 'proxy-chain.key'), 'utf8');
const TLS_CERT = readFileSync(join(TESTS, 'fixtures', 'proxy-chain.crt'), 'utf8');

/* ------------------------------------------------------------------ *
 * 最小 HTTP CONNECT 代理
 *
 * 记录每一次隧道建立（这就是「哪条代理承载了这个页面」的直接证据）。
 * 伪造域名（*.test）在内部分辨到本地站点端口，实现「只有代理才认识的
 * host」；其余一律拒绝，免得测试把真实外网流量也悄悄代理出去。
 * ------------------------------------------------------------------ */
async function startProxy(label, hostRoutes) {
  const requests = [];

  const server = createHttpServer((req, res) => {
    // 明文转发不是本 e2e 的路径（站点配置要求 HTTPS），如实拒绝即可。
    requests.push({ host: '(plain)', path: req.url ?? '', method: req.method });
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('proxy-test: only CONNECT is proxied');
  });

  server.on('connect', (req, clientSocket, head) => {
    const [requestedHost, requestedPort] = String(req.url).split(':');
    requests.push({ host: requestedHost, port: Number(requestedPort) || 443, method: 'CONNECT' });

    const sitePort = hostRoutes[requestedHost];
    if (!sitePort) {
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      return;
    }
    const upstream = net.connect(sitePort, '127.0.0.1', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    label,
    port: server.address().port,
    requests,
    hits: (host) => requests.filter((entry) => entry.host === host).length,
    hosts: () => [...new Set(requests.map((entry) => entry.host))],
    seenHost: (host) => requests.some((entry) => entry.host === host),
    close: () => new Promise((r) => server.close(r)),
  };
}

/* ------------------------------------------------------------------ *
 * 虚构站点
 *
 * 一个 host 一个「账号」，站点自己按 Cookie 判断登录态：
 *  - /login  账密表单
 *  - /       登录后的落地页（同时是签到页：按钮就是「立即签到」）
 *  - /api/user/self     新 API 风格的余额接口（余额刷新走这里）
 *  - /api/checkin       POST 签到
 *
 * 每个请求都记进 log，带上 Host 头 —— 断言用它区分「哪个账号从哪个出口来」。
 * ------------------------------------------------------------------ */
function makeSite(users) {
  const log = [];
  const server = createHttpsServer({ key: TLS_KEY, cert: TLS_CERT }, async (req, res) => {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const host = String(req.headers.host).split(':')[0];
    const user = users[host];
    log.push({ host, path: url.pathname, method: req.method });
    res.setHeader('Cache-Control', 'no-store');

    if (!user) { res.writeHead(404); res.end('unknown host'); return; }

    const authed = String(req.headers.cookie ?? '').includes(`sess=${user.id}`);
    const html = (body) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><meta charset="utf-8"><title>${host}</title>${body}`);
    };

    if (url.pathname === '/login' && req.method === 'POST') {
      for await (const _ of req) { /* 只消耗虚构表单，不记录凭据 */ }
      res.writeHead(302, {
        'Set-Cookie': `sess=${user.id}; Path=/; SameSite=Lax`,
        Location: '/',
      });
      res.end();
      return;
    }
    if (url.pathname === '/api/user/self') {
      res.setHeader('Content-Type', 'application/json');
      if (!authed) { res.writeHead(401); res.end(JSON.stringify({ success: false })); return; }
      res.end(JSON.stringify({
        success: true,
        data: { id: user.id, username: user.name, quota: 500000, used_quota: 0 },
      }));
      return;
    }
    if (url.pathname === '/api/checkin' && req.method === 'POST') {
      for await (const _ of req) { /* drain */ }
      res.setHeader('Content-Type', 'application/json');
      if (!authed) { res.writeHead(401); res.end(JSON.stringify({ success: false })); return; }
      user.claims += 1;
      res.end(JSON.stringify({ success: true }));
      return;
    }
    if (url.pathname.startsWith('/api/')) { res.writeHead(404); res.end('{}'); return; }

    if (!authed) {
      html('<form method="POST" action="/login">'
        + '<input id="username" name="username">'
        + '<input id="password" name="password" type="password">'
        + '<button id="submit" type="submit">登录</button></form>');
      return;
    }
    html(`<div id="logged-in">已登录</div><div id="account">${user.name}</div>`
      + `<h1>每日签到</h1><button id="claim">立即签到</button>`
      + `<p id="result"></p><script>document.getElementById('claim').onclick=async()=>{`
      + `await fetch('/api/checkin',{method:'POST'});`
      + `document.getElementById('result').textContent='签到成功';};</script>`);
  });
  return {
    server,
    log,
    listen: async () => {
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      return server.address().port;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

const ACCOUNTS = [
  { key: 'alpha', host: 'alpha.test', id: '1001', name: '阿尔法', claims: 0 },
  { key: 'beta', host: 'beta.test', id: '1002', name: '贝塔', claims: 0 },
];
const users = Object.fromEntries(ACCOUNTS.map((a) => [a.host, a]));

const site = makeSite(users);
const sitePort = await site.listen();
const hostRoutes = Object.fromEntries(ACCOUNTS.map((a) => [a.host, sitePort]));
// 余额刷新也走同一个站点（同一 host），所以两个代理都能路由它
const proxyA = await startProxy('A', hostRoutes);
const proxyB = await startProxy('B', hostRoutes);

const output = resolve('output/proxy-full-chain');
mkdirSync(output, { recursive: true });
const profile = mkdtempSync(join(output, 'profile-'));

let ctx;
try {
  ctx = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: 'chromium',
    viewport: { width: 1280, height: 900 },
    // 证书是自签的：测试里必须放行，否则站点根本打不开。
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--ignore-certificate-errors',
    ],
  });

  const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker', { timeout: 30000 });
  const extId = new URL(sw.url()).host;
  const app = await ctx.newPage();
  // 页面崩溃时把「当时正在等什么」记下来，便于区分是扩展把标签页搞崩了、
  // 还是机器上并发跑着别的重活导致资源不够。
  ctx.on('page', (page) => page.on('crash', () => noteCrash('页面进程崩溃', page.url())));
  app.on('crash', () => noteCrash('options 页崩溃', app.url()));
  ctx.on('close', () => { if (currentStep !== '(完成)') noteCrash('浏览器提前关闭', currentStep); });
  step('打开管理页');
  await app.goto(`chrome-extension://${extId}/options.html`);
  await app.waitForLoadState('domcontentloaded');

  /* ---------------------------------------------------------------- *
   * 种子数据：两个账号各绑一条代理
   * ---------------------------------------------------------------- */
  await app.evaluate(async ({ accounts, proxies, sitePort: port }) => {
    await chrome.storage.local.set({
      proxies,
      sites: accounts.map((account) => ({
        id: `site-${account.key}`,
        name: `代理链路 ${account.key}`,
        loginUrl: `https://${account.host}:${port}/login`,
        loginMethod: 'form',
        selectors: { username: '#username', password: '#password', submit: '#submit' },
        closeModalSelectors: [],
        adapter: { family: 'new-api', checkinPath: '' },
        checkin: { method: 'button', buttonSelector: '#claim', successSelector: '#result' },
      })),
      accounts: accounts.map((account) => ({
        id: account.key,
        siteId: `site-${account.key}`,
        alias: account.name,
        username: account.name,
        password: 'sentinel-password',
        enabled: true,
        proxyMode: 'pool',
        proxyId: `px-${account.key}`,
        proxyPinned: true,
      })),
      results: {},
      status: {},
      balances: {},
    });
  }, {
    accounts: ACCOUNTS,
    sitePort,
    proxies: [
      { id: 'px-alpha', name: '代理 A', scheme: 'http', host: '127.0.0.1', port: proxyA.port },
      { id: 'px-beta', name: '代理 B', scheme: 'http', host: '127.0.0.1', port: proxyB.port },
    ],
  });

  const readProxy = () => app.evaluate(async () => {
    const s = await chrome.proxy.settings.get({ incognito: false });
    const single = s?.value?.rules?.singleProxy;
    return {
      mode: s?.value?.mode,
      control: s?.levelOfControl,
      host: single?.host,
      port: single?.port,
    };
  });

  const waitForProxyPort = async (port, timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs;
    let seen = null;
    while (Date.now() < deadline) {
      seen = await readProxy();
      if (seen.mode === 'fixed_servers' && seen.port === port) return seen;
      await new Promise((r) => setTimeout(r, 150));
    }
    return seen;
  };

  const waitForProxyRestored = async (timeoutMs = 60000) => {
    const deadline = Date.now() + timeoutMs;
    let seen = null;
    while (Date.now() < deadline) {
      seen = await readProxy();
      const holders = await app.evaluate(async () => {
        const s = await chrome.storage.session.get(['proxyHolderTabId', 'checkinQueue']);
        const learn = Object.keys(s).filter((k) => k.startsWith('learn:'));
        return { holder: s.proxyHolderTabId ?? null, busy: !!s.checkinQueue?.active, learn };
      });
      if (seen.mode !== 'fixed_servers' && holders.holder == null && !holders.busy && holders.learn.length === 0) {
        return { ...seen, ...holders };
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return seen;
  };

  /* ---------------------------------------------------------------- *
   * A. 学习会话走账号代理，结束后还原

   * ---------------------------------------------------------------- */
  step("A. 学习会话代理");
  const beforeLearning = await readProxy();
  check(
    'A0. 起点：扩展没有在接管全局代理',
    beforeLearning.mode !== 'fixed_servers',
    `mode=${beforeLearning.mode}`,
  );

  const learningStarted = await app.evaluate(async () => (
    chrome.runtime.sendMessage({ type: 'TOGGLE_LEARNING', accountId: 'alpha', kind: 'checkin' })
  ));

  const learningProxy = await waitForProxyPort(proxyA.port);

  check(
    'A1. 学习会话期间，全局代理 = 该账号配置的代理 A',
    learningProxy?.mode === 'fixed_servers'
      && learningProxy?.port === proxyA.port
      && learningProxy?.host === '127.0.0.1',
    `mode=${learningProxy?.mode} endpoint=${learningProxy?.host}:${learningProxy?.port} 期望 127.0.0.1:${proxyA.port}`,
  );

  // 学习页面的首个请求就必须经代理：这正是「先建空白页、代理生效后再导航」要保的。
  const learningOpened = await app.evaluate(() => chrome.tabs.query({}));
  check(
    'A2. 学习页真的经代理出站（代理 A 收到了 alpha.test 的请求）',
    proxyA.seenHost('alpha.test'),
    `代理 A 见到的主机=${JSON.stringify(proxyA.hosts())}；标签页=${JSON.stringify(learningOpened.map((t) => t.url))}`,
  );

  const learningUrl = learningOpened.find((tab) => (tab.url ?? '').includes('alpha.test'))?.url ?? '';
  check(
    'A3. 学习页加载成功（不是 chrome-error 页）',
    learningUrl.startsWith('https://alpha.test:'),
    `学习标签页 URL=${learningUrl || '(没找到)'}`,
  );

  /**
   * 这里没有真的演示签到动作，所以「结束学习」会被流程编译器如实拒绝。
   * 这是**故意**的：会话继续留着，用户可以接着演示；把那一步当成成功收尾
   * 反而会（a）丢掉后半段录制，(b) 直接释放代理、让页面在错误出口上继续。
   * 断言两件事：拒绝是明确的、会话与租约都还在。
   */
  const learningRefused = await app.evaluate(async () => (
    chrome.runtime.sendMessage({ type: 'TOGGLE_LEARNING', accountId: 'alpha', kind: 'checkin' })
  ));
  check(
    'A4. 没录到签到动作时，结束学习被明确拒绝（不假装保存成功，也不撤掉租约）',
    learningRefused?.ok === false && typeof learningRefused?.error === 'string' && learningRefused.error.length > 0,
    `返回=${JSON.stringify(learningRefused).slice(0, 200)}`,
  );

  const stillHeld = await readProxy();
  check(
    'A4b. 被拒绝之后学习会话与代理租约都还在（用户可以接着演示）',
    stillHeld.mode === 'fixed_servers' && stillHeld.port === proxyA.port,
    `mode=${stillHeld.mode} port=${stillHeld.port} 期望 ${proxyA.port}`,
  );

  const learningCancelled = await app.evaluate(async () => (
    chrome.runtime.sendMessage({ type: 'CANCEL_LEARNING', accountId: 'alpha' })
  ));
  check(
    'A5. 放弃学习被接受',
    learningCancelled?.ok === true,
    `返回=${JSON.stringify(learningCancelled).slice(0, 200)}`,
  );

  const afterLearning = await waitForProxyRestored();
  check(
    'A6. 学习结束后全局代理被还原',
    afterLearning.mode !== 'fixed_servers' && afterLearning.holder == null,
    `mode=${afterLearning.mode} holder=${afterLearning.holder} 学习会话=${JSON.stringify(afterLearning.learn ?? [])}`,
  );

  /* ---------------------------------------------------------------- *
   * B. 签到任务走配置的代理，结束后还原

   * ---------------------------------------------------------------- */
  step("B. 单任务代理");
  const alphaBefore = { connects: proxyA.requests.length, claims: users['alpha.test'].claims };
  const startedAlpha = await app.evaluate(() => (
    chrome.runtime.sendMessage({ type: 'START_LOGIN', accountId: 'alpha' })
  ));
  check('B1. 账号 alpha 的签到任务已入队', startedAlpha?.ok === true, JSON.stringify(startedAlpha));

  const taskProxy = await waitForProxyPort(proxyA.port);
  check(
    'B2. 任务执行期间全局代理 = 账号配置的代理 A',
    taskProxy?.mode === 'fixed_servers' && taskProxy?.port === proxyA.port,
    `mode=${taskProxy?.mode} port=${taskProxy?.port} 期望 ${proxyA.port}`,
  );

  const alphaResult = await app.evaluate(async () => {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const { results } = await chrome.storage.local.get('results');
      const result = results?.alpha;
      const { checkinQueue } = await chrome.storage.session.get('checkinQueue');
      if (result && !checkinQueue?.active) return result;
      await new Promise((r) => setTimeout(r, 200));
    }
    return null;
  });
  check('B3. 账号 alpha 签到成功', alphaResult?.ok === true, JSON.stringify(alphaResult).slice(0, 400));
  check(
    'B4. 任务请求确实经代理 A 出站（代理侧建起了 alpha.test 的隧道）',
    proxyA.requests.length > alphaBefore.connects,
    `代理 A 承载的 alpha.test 隧道 ${alphaBefore.connects} → ${proxyA.requests.length}`,
  );
  check(
    'B5. 站点侧真的收到了 alpha 的签到请求',
    users['alpha.test'].claims > alphaBefore.claims,
    `claims ${alphaBefore.claims} → ${users['alpha.test'].claims}`,
  );

  const afterTask = await waitForProxyRestored();
  check(
    'B6. 任务结束后全局代理被还原',
    afterTask.mode !== 'fixed_servers' && afterTask.holder == null,
    `mode=${afterTask.mode} holder=${afterTask.holder}`,
  );

  /* ---------------------------------------------------------------- *
   * C. 不同账号走不同出口

   * ---------------------------------------------------------------- */
  step("C. 多账号不同出口");
  const betaBefore = { a: proxyA.requests.length, b: proxyB.requests.length };
  const startedBeta = await app.evaluate(() => (
    chrome.runtime.sendMessage({ type: 'START_LOGIN', accountId: 'beta' })
  ));
  check('C1. 账号 beta 的签到任务已入队', startedBeta?.ok === true, JSON.stringify(startedBeta));

  const betaProxy = await waitForProxyPort(proxyB.port);
  check(
    'C2. 账号 beta 用的是代理 B（不是 alpha 的 A）',
    betaProxy?.mode === 'fixed_servers' && betaProxy?.port === proxyB.port,
    `mode=${betaProxy?.mode} port=${betaProxy?.port} 期望 ${proxyB.port}`,
  );

  const betaResult = await app.evaluate(async () => {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const { results } = await chrome.storage.local.get('results');
      const result = results?.beta;
      const { checkinQueue } = await chrome.storage.session.get('checkinQueue');
      if (result && !checkinQueue?.active) return result;
      await new Promise((r) => setTimeout(r, 200));
    }
    return null;
  });
  check('C3. 账号 beta 签到成功', betaResult?.ok === true, JSON.stringify(betaResult).slice(0, 400));

  const alphaOnB = site.log.filter((entry) => entry.via === "B" && entry.host === "alpha.test").length;
  const betaOnA = site.log.filter((entry) => entry.via === "A" && entry.host === "beta.test").length;
  check(
    'C4. 代理 B 确实承载了 beta 的流量',
    proxyB.requests.length > betaBefore.b && proxyB.seenHost('beta.test'),
    `代理 B 承载的 beta.test 隧道 ${betaBefore.b} → ${proxyB.requests.length}，主机=${JSON.stringify(proxyB.hosts())}`,
  );
  check(
    'C5. 两条出口没有串号：alpha 不出现在代理 B，beta 不出现在代理 A',
    alphaOnB === 0 && betaOnA === 0,
    `代理 B 上的 alpha.test=${alphaOnB} 次；代理 A 上的 beta.test=${betaOnA} 次`,
  );

  const afterBeta = await waitForProxyRestored();
  check(
    'C6. beta 任务结束后全局代理被还原',
    afterBeta.mode !== 'fixed_servers' && afterBeta.holder == null,
    `mode=${afterBeta.mode} holder=${afterBeta.holder}`,
  );

  /* ---------------------------------------------------------------- *
   * D. 余额刷新不绕过账号代理

   *
   * 本轮修的缺陷之一：站点上开着标签页时，旧实现**无条件**借它读余额、不动代理。
   * 结果是余额走用户当前标签页的网络路径（通常直连），而签到走账号代理 ——
   * 同一账号两个出口，站点侧表现为「余额 401/404，签到却正常」，用户查不出来。
   *
   * 复现这个形状需要一个「开着、但已经不在账号出口上」的站点标签页：
   *   1. 先手工把全局代理指到代理 A，让 alpha 的页面能加载出来（伪造域名只有
   *      代理认识），并拿到登录 Cookie；
   *   2. 再把全局代理清掉 —— 那个标签页现在脱离了账号出口，但仍开在站点上；
   *   3. 此时刷新余额。旧实现会借它直连（伪造域名直接解析失败，余额读不到），
   *      新实现必须自己挂上代理 A，站点的记录里会出现 via=A 的新请求。
   * ---------------------------------------------------------------- */

  // 1) 借代理 A 打开并登录 alpha 的页面。
  step("D. 余额刷新出口");
  const opened = { a: proxyA.hits('alpha.test'), b: proxyB.hits('alpha.test') };
  await app.evaluate(async ({ pp, sp }) => {
    await chrome.proxy.settings.set({
      value: {
        mode: 'fixed_servers',
        rules: {
          singleProxy: { scheme: 'http', host: '127.0.0.1', port: pp },
          bypassList: ['localhost', '127.0.0.1', '<local>'],
        },
      },
      scope: 'regular',
    });
    const tab = await chrome.tabs.create({ url: `https://alpha.test:${sp}/login`, active: false });
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const current = await chrome.tabs.get(tab.id).catch(() => null);
      if (current?.status === 'complete' && (current.url ?? '').includes('alpha.test')) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    // 登录：填表提交后站点会种下 sess Cookie 并回到落地页。
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const name = document.querySelector('#username');
        const pass = document.querySelector('#password');
        const submit = document.querySelector('#submit');
        if (name && pass && submit) {
          name.value = '阿尔法';
          pass.value = 'sentinel-password';
          submit.form.submit();
        }
      },
    }).catch(() => {});
    const loginDeadline = Date.now() + 15000;
    while (Date.now() < loginDeadline) {
      const cookies = await chrome.cookies.getAll({ domain: 'alpha.test' });
      if (cookies.some((c) => c.name === 'sess')) break;
      await new Promise((r) => setTimeout(r, 200));
    }
  }, { pp: proxyA.port, sp: sitePort });

  const cookiesOnSite = await app.evaluate(async () => (
    (await chrome.cookies.getAll({ domain: 'alpha.test' })).map((c) => c.name)
  ));
  check(
    'D0. 站点标签页已登录并留在浏览器里（这正是旧实现会去复用的那个页）',
    cookiesOnSite.includes('sess')
      && proxyA.hits('alpha.test') > opened.a
      && proxyB.hits('alpha.test') === opened.b,
    `alpha.test 的 Cookie=${JSON.stringify(cookiesOnSite)}；via=A 的 alpha 请求 ${opened.a} → ${proxyA.hits('alpha.test')}`,
  );

  // 2) 清掉全局代理 —— 那个标签页现在脱离了账号出口。
  await app.evaluate(async () => chrome.proxy.settings.clear({ scope: 'regular' }));
  const detached = await readProxy();
  check(
    'D1. 那个标签页此刻不再经过账号代理（出口不一致的现场已就绪）',
    detached.mode !== 'fixed_servers',
    `mode=${detached.mode}`,
  );

  /*
   * 3) 刷新余额：必须自己挂上代理 A，而不是借那个直连标签页。
   *
   * 判据是「刷新期间全局代理确实被切到了账号代理 A」——
   * 不能改成数新增隧道：Chrome 的 socket 池是 profile 级的，先前经代理 A
   * 建立的那条 TLS 连接在代理 A 重新生效后仍然合法，会被直接复用。
   * （那条连接本身就只可能在代理 A 下存在，但「没有新 CONNECT」会让
   * 计数断言误判。）旧实现根本不碰代理，所以底下这段采样一条 A 都看不到。
   */
  const sampled = await app.evaluate(async () => {
    const seen = [];
    let running = true;
    const poll = (async () => {
      while (running) {
        const s = await chrome.proxy.settings.get({ incognito: false });
        const single = s?.value?.rules?.singleProxy;
        seen.push(s?.value?.mode === 'fixed_servers' && single ? `${single.host}:${single.port}` : null);
        await new Promise((r) => setTimeout(r, 40));
      }
    })();
    const response = await chrome.runtime.sendMessage({ type: 'REFRESH_BALANCE', accountIds: ['alpha'] });
    running = false;
    await poll;
    return { response, seen };
  });

  const sawProxyA = sampled.seen.filter((entry) => entry === `127.0.0.1:${proxyA.port}`).length;
  const sawProxyB = sampled.seen.filter((entry) => entry === `127.0.0.1:${proxyB.port}`).length;
  const sawDirect = sampled.seen.filter((entry) => entry == null).length;

  check(
    'D2. 余额刷新没有复用那个直连标签页，而是把全局代理切到了账号代理 A',
    sawProxyA > 0 && sawProxyB === 0 && sawDirect > 0,
    `刷新期间采样 ${sampled.seen.length} 次：代理 A ${sawProxyA} 次、代理 B ${sawProxyB} 次、`
      + `无扩展代理 ${sawDirect} 次；返回=${JSON.stringify(sampled.response)}`,
  );

  const balance = await app.evaluate(async () => (
    (await chrome.storage.local.get('balances')).balances?.alpha ?? null
  ));
  check(
    'D3. 余额真的读到了（出口正确才有这一步）',
    balance?.quota === 500000,
    `balances.alpha=${JSON.stringify(balance)?.slice(0, 220)}`,
  );

  const afterBalance = await waitForProxyRestored();
  check(
    'D4. 余额刷新结束后全局代理被还原（用户那个标签页不受影响）',
    afterBalance.mode !== 'fixed_servers' && afterBalance.holder == null,
    `mode=${afterBalance.mode} holder=${afterBalance.holder}`,
  );

  /* ---------------------------------------------------------------- *
   * 汇总：站点确实只经代理可达，且每个账号的流量都能归到自己的出口
   * ---------------------------------------------------------------- */
  check(
    'E1. 站点只经代理可达：页面确实打开过，且流量全部落在两条代理上',
    site.log.length > 0
      && proxyA.requests.length + proxyB.requests.length > 0
      && proxyA.requests.every((entry) => entry.method === 'CONNECT')
      && proxyB.requests.every((entry) => entry.method === 'CONNECT'),
    `站点收到 ${site.log.length} 个请求；代理 A 隧道 ${proxyA.requests.length} 次、代理 B 隧道 ${proxyB.requests.length} 次`,
  );
  check(
    'E2. 两个账号的流量各自归到自己的出口，没有串号',
    proxyB.hits('alpha.test') === 0 && proxyA.hits('beta.test') === 0,
    `代理 B 上的 alpha.test=${proxyB.hits('alpha.test')} 次；代理 A 上的 beta.test=${proxyA.hits('beta.test')} 次`,
  );

  step('(完成)');
} finally {
  /*
   * 先关 context，再关服务器，最后删 profile。
   *
   * Windows 上 profile 目录被还活着的 Chrome 子进程占着时删不掉（EBUSY），
   * 残留目录会累积；而 close() 本身也可能因为渲染进程已经崩掉而抛错，
   * 所以每步都独立 catch，保证后面的清理照常执行。
   */
  await ctx?.close().catch(() => {});
  await proxyA.close().catch(() => {});
  await proxyB.close().catch(() => {});
  await site.close().catch(() => {});
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(profile, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}

const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length) {
  console.log(`失败: ${failed.map((f) => f.name).join('、')}`);
  process.exit(1);
}
console.log('结果: PASS');
