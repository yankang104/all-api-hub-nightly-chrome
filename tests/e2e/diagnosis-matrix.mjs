/**
 * 失败诊断矩阵（真实扩展 + 真实 Chromium + 本地虚构站点）。
 *
 * 存在的理由：用户抱怨「学不到、跑不通」时只能看到一句笼统的失败，看完还是
 * 不知道该改选择器、该重登、还是该等站点恢复。本脚本为每一类真实失败各造一个
 * **真实场景**，跑完整条扩展链路，然后断言两件事：
 *
 *   1) 扩展实际报出的失败文案 → 被诊断模块归到正确的码（结论正确）；
 *   2) 该码给出的「下一步」真的包含能照做的关键词（提示可用）。
 *
 * 与单测的分工：单测锁分类函数的边界；本脚本锁「真实运行时产生的文案确实落在
 * 这套分类里」。两者之间只要有一步脱节，用户拿到的就是错的指引，而纯单测发现
 * 不了 —— 它自己编的输入永远能通过。
 *
 * 场景（全部本地虚构，不触碰真实站点）：
 *   ① 站点返回 403              → access-denied
 *   ② 签到按钮不存在（改版）     → selector-mismatch
 *   ③ 命中了错误的元素（指纹失配）→ element-mismatch
 *   ④ 页面加载不出来             → page-timeout
 *   ⑤ 本机代理端口没人监听       → proxy-unreachable
 *   ⑥ 当天已签到（不是失败）     → 完成终态
 *
 * 运行：node tests/e2e/diagnosis-matrix.mjs
 *   EXTENSION_DIR=... 指定构建产物；E2E_HEADLESS=0 可看着跑。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

/**
 * 诊断逻辑直接从 **src 源码**加载（经 vite 转译），而不是在脚本里照抄一份。
 *
 * 抄一份的写法会让脚本永远绿：扩展里的规则改了、测试里那份没改，两边各自自洽。
 * 这里复用 learning-fidelity.mjs 已验证过的方式 —— 用 wxt 依赖里的 vite 现场
 * 加载源码模块，`@/` 别名与 TS 语法都由它处理。
 */
const requireWxt = createRequire(import.meta.resolve('wxt'));
const { createServer: createViteServer } = await import(pathToFileURL(requireWxt.resolve('vite')).href);

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TESTS = dirname(fileURLToPath(import.meta.url));
const EXT = process.env.EXTENSION_DIR
  ? resolve(REPO, process.env.EXTENSION_DIR)
  : resolve(REPO, '.output', 'chrome-mv3');
const OUTPUT = join(REPO, 'output', 'diagnosis-matrix');
const HEADLESS = process.env.E2E_HEADLESS !== '0';

/**
 * 死代理端口：刻意用一个本机不会有人监听的端口。
 *
 * 选 127.0.0.1 而不是内网 IP，是为了让诊断文案与真实用户场景一致
 * （「本机 127.0.0.1:<端口> 上没有程序在监听」）。
 */
const DEAD_PROXY_PORT = Number(process.env.DIAGNOSIS_MATRIX_DEAD_PORT || 7897);
/** 站点对外暴露的名字：RFC 6761 保留给测试，公共 DNS 永远解析不了。 */
const PROXY_HOST = 'diag-matrix.test';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? `  — ${detail}` : ''}`);
}

/* ------------------------------------------------------------------ *
 * 虚构站点：同一份逻辑同时挂在 HTTP 与 HTTPS 上。
 *
 *   HTTP  + localhost        → 给「选择器 / 超时 / 已签到 / 403」几个场景用
 *   HTTPS + diag-matrix.test → 给代理场景用
 *
 * 为什么代理场景非得换个地址：Chrome 的内置代理绕过规则会放行
 * localhost / 127.0.0.1，回环地址根本走不到代理，也就测不出「代理没生效」。
 * 用一个普通域名 + HTTPS 就绕开了这条规则，同时**不放宽任何站点安全校验**。
 * ------------------------------------------------------------------ */
function html(title, body) {
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>${title}</title><body>${body}</body></html>`;
}

const LOGIN_FORM = html('登录', `
  <h1>登录</h1>
  <form action="/login" method="POST">
    <input id="username" name="username" autocomplete="username">
    <input id="password" name="password" type="password" autocomplete="current-password">
    <button id="submit" type="submit">登录</button>
  </form>
`);

const consolePage = (user) => html('控制台', `
  <div id="logged-in">已登录</div>
  <p>当前账号：<b id="current-user">${user}</b></p>
  <nav><a id="nav-profile" href="/profile">个人资料</a></nav>
`);

const profilePage = (user, id) => html('个人资料', `
  <h1>个人资料</h1>
  <p>当前账号：<span id="profile-account">${user}</span></p>
  <p>用户 ID：<span id="profile-uid">${id}</span></p>
`);

let hangResponses = 0;

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://fixture.test');
  const path = url.pathname;
  const user = (req.headers.cookie ?? '').includes('diag=1') ? 'diag_user' : null;
  res.setHeader('Cache-Control', 'no-store');

  // ④ 页面加载不出来：TCP 连上了，但永不响应（站点 / 代理慢的真实形态）。
  if (path.startsWith('/hang')) {
    hangResponses += 1;
    return;
  }

  if (path === '/login' && req.method === 'POST') {
    for await (const _ of req) { /* 只消耗虚构表单，不记录凭据 */ }
    res.writeHead(302, { 'Set-Cookie': 'diag=1; Path=/; SameSite=Lax', Location: '/console' });
    res.end();
    return;
  }

  if (path === '/api/user/self') {
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = user ? 200 : 401;
    res.end(JSON.stringify(user
      ? { success: true, data: { username: user, id: 88 } }
      : { success: false }));
    return;
  }

  // ① 403：站点拒绝访问（地区限制 / 风控）。
  if (path === '/forbidden') {
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html('403 Forbidden', '<h1>403 Forbidden</h1><p>Access denied. This site is not available in your region.</p>'));
    return;
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (!user) { res.end(LOGIN_FORM); return; }

  if (path === '/console') { res.end(consolePage('diag_user')); return; }
  if (path === '/profile') { res.end(profilePage('diag_user', 88)); return; }

  // ② 签到按钮不存在：站点改版后旧选择器再也匹配不到任何元素。
  if (path === '/renamed-checkin') {
    res.end(html('每日签到', `
      <h1>每日签到</h1>
      <p>当前账号：<span id="checkin-account">diag_user</span></p>
      <button id="brand-new-claim">全新的签到入口</button>
    `));
    return;
  }

  // ③ 命中了错误的元素：#claim 还在，但它已经从「立即签到」变成「签到记录」。
  if (path === '/drifted-checkin') {
    res.end(html('每日签到', `
      <h1>每日签到</h1>
      <p>当前账号：<span id="checkin-account">diag_user</span></p>
      <button id="claim">签到记录</button>
    `));
    return;
  }

  // ⑥ 当天已签到：按钮变成禁用的「今日已签到」。
  if (path === '/already-checkin') {
    res.end(html('每日签到', `
      <h1>每日签到</h1>
      <p>当前账号：<span id="checkin-account">diag_user</span></p>
      <button id="claim" disabled>今日已签到</button>
    `));
    return;
  }

  res.writeHead(404);
  res.end(html('404', '<p>404</p>'));
}

const server = createServer((req, res) => { void handle(req, res); });
const secureServer = createHttpsServer({
  key: readFileSync(join(TESTS, 'fixtures', 'diag-matrix-key.pem'), 'utf8'),
  cert: readFileSync(join(TESTS, 'fixtures', 'diag-matrix-cert.pem'), 'utf8'),
}, (req, res) => { void handle(req, res); });
await new Promise((done) => server.listen(0, '127.0.0.1', done));
await new Promise((done) => secureServer.listen(0, '127.0.0.1', done));
const PORT = server.address().port;
const SECURE_PORT = secureServer.address().port;
/** 站点安全校验对 localhost 放行明文 HTTP（见 validateSiteConfig）。 */
const ORIGIN = `http://localhost:${PORT}`;
/** 代理场景用：普通域名 + HTTPS，Chrome 不会把它当本地地址绕过代理。 */
const PROXY_ORIGIN = `https://${PROXY_HOST}:${SECURE_PORT}`;

mkdirSync(OUTPUT, { recursive: true });
const profile = mkdtempSync(join(OUTPUT, 'profile-'));

let context;
let vite;
let exitCode = 0;
try {
  console.log(`扩展产物：${EXT}`);
  console.log(`本地站点：${ORIGIN}（直连） / ${PROXY_ORIGIN}（代理场景）`);

  context = await chromium.launchPersistentContext(profile, {
    headless: HEADLESS,
    ...(HEADLESS ? { channel: 'chromium' } : {}),
    viewport: { width: 1280, height: 900 },
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      // 让普通域名解析到本机，从而在「不走代理」时也能真的连上这个虚构站点；
      // 代理场景里浏览器会先走代理，这个映射只作为失败时的兜底。
      `--host-resolver-rules=MAP ${PROXY_HOST} 127.0.0.1`,
      // 站点用自签证书；与既有 proxy-full-chain.mjs 同一做法。
      '--ignore-certificate-errors',
    ],
  });

  /**
   * MV3 的 Service Worker 冷启动时**不一定立刻注册**：persistent context 刚建好时
   * serviceWorkers() 常常还是空的，直接 waitForEvent 会白等到超时。这里给一小段
   * 轮询窗口，再退回事件等待 —— 与其它 e2e 的按需等待保持同一思路。
   */
  const worker = await (async () => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const existing = context.serviceWorkers()[0];
      if (existing) return existing;
      try {
        return await context.waitForEvent('serviceworker', { timeout: 1000 });
      } catch { /* 还没注册，继续轮询 */ }
    }
    throw new Error('扩展 Service Worker 未在 20 秒内注册（构建产物是否存在？）');
  })();
  const extensionId = new URL(worker.url()).hostname;
  check('真实扩展加载成功', !!extensionId, `id=${extensionId}`);

  const app = await context.newPage();
  await app.goto(`chrome-extension://${extensionId}/options.html`);
  await app.waitForLoadState('domcontentloaded');

  /** 诊断逻辑与界面同源：直接加载 src 里的真实实现。 */
  vite = await createViteServer({
    configFile: false,
    root: REPO,
    resolve: { alias: { '@': resolve(REPO, 'src') } },
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
    logLevel: 'error',
  });
  const { classifyFailure, diagnoseFailure } = await vite.ssrLoadModule('/src/automation/shared/diagnostics.ts');
  const { DIAGNOSIS } = await vite.ssrLoadModule('/src/lib/checkin/diagnosis.ts');

  /**
   * 跑一个场景并读回结果。
   *
   * 每轮都重写 storage **并清掉站点 Cookie**：配置或会话一旦从前一个场景泄漏过来，
   * 断言就可能在一个「其实没被触发」的路径上通过 —— 那比测试失败更糟。
   */
  async function runScenario(id, site, account = {}) {
    const siteId = `diag-${id}`;
    const accountId = `diag-${id}-account`;
    await app.evaluate(async ({ siteId, accountId, site, account }) => {
      await chrome.storage.local.set({
        sites: [{ id: siteId, name: `诊断 ${siteId}`, ...site }],
        accounts: [{ id: accountId, siteId, username: 'diag_user', password: 'diag_pw', ...account }],
        proxies: site.proxies ?? [],
        status: {},
        results: {},
      });
      await chrome.storage.session.clear();
      // 清 Cookie：否则上一个场景登录后的会话会让下一个场景跳过登录，直接走到签到页。
      for (const origin of [`http://localhost`, `https://diag-matrix.test`]) {
        const cookies = await chrome.cookies.getAll({ url: origin }).catch(() => []);
        for (const cookie of cookies) {
          await chrome.cookies.remove({
            url: `${cookie.secure ? 'https' : 'http'}://${cookie.domain.replace(/^\./, '')}${cookie.path}`,
            name: cookie.name,
          }).catch(() => {});
        }
      }
    }, { siteId, accountId, site, account });

    const started = await app.evaluate((id) => chrome.runtime.sendMessage({ type: 'START_LOGIN', accountId: id }), accountId);
    assert.equal(started?.ok, true, `${id}: START_LOGIN 应入队 ${JSON.stringify(started)}`);

    const deadline = Date.now() + 120000;
    let state;
    while (Date.now() < deadline) {
      state = await app.evaluate(async ({ accountId }) => {
        const { results, status } = await chrome.storage.local.get(['results', 'status']);
        const queue = (await chrome.storage.session.get('checkinQueue')).checkinQueue;
        return {
          result: results?.[accountId],
          status: Object.entries(status ?? {}).find(([key]) => key.startsWith(`${accountId}:`))?.[1] ?? 'none',
          busy: !!queue?.active,
        };
      }, { accountId });
      if (state.result && !state.busy) break;
      await new Promise((done) => setTimeout(done, 200));
    }
    return state;
  }

  /** 断言：真实运行结果 → 正确的诊断码 + 可照做的下一步。 */
  function expectDiagnosis(label, state, code, actionKeywords) {
    const result = state.result;
    console.log(`\n── ${label} ──`);
    console.log(`   状态=${state.status}`);
    console.log(`   说明=${result?.message ?? 'n/a'}`);

    check(`[${label}] 扩展产出了结果`, !!result, `status=${state.status}`);
    if (!result) return;

    const actual = diagnoseFailure(result.message, result.steps ?? []);
    check(
      `[${label}] 诊断结论正确`,
      actual.code === code,
      `期望 ${code}，实际 ${actual.code}（message=${JSON.stringify(result.message)}）`,
    );
    check(
      `[${label}] 结论是「标题 + 说明 + 下一步」结构`,
      actual.title.trim().length > 0 && actual.detail.trim().length > 0 && actual.nextActions.length > 0,
      `${actual.title} / ${actual.detail.slice(0, 40)}…`,
    );
    const actions = actual.nextActions.join('\n');
    for (const keyword of actionKeywords) {
      check(`[${label}] 下一步包含「${keyword}」`, actions.includes(keyword), actual.nextActions.join(' | '));
    }
    // 界面用 diagnoseFailure，重试策略用 classifyFailure —— 两条入口不能分叉。
    check(
      `[${label}] 两个入口结论一致`,
      classifyFailure(result.message, result.steps ?? []) === actual.code,
      `classifyFailure=${classifyFailure(result.message, result.steps ?? [])} diagnoseFailure=${actual.code}`,
    );
    console.log(`   诊断标题=${actual.title}`);
    for (const [index, action] of actual.nextActions.entries()) console.log(`   下一步 ${index + 1}. ${action}`);
  }

  /** 各场景共用的站点骨架（选择器是虚构登录表单的真实选择器）。 */
  const baseSite = (origin) => ({
    loginUrl: `${origin}/login`,
    loginMethod: 'form',
    successIndicator: '#logged-in',
    selectors: { username: '#username', password: '#password', submit: '#submit' },
    closeModalSelectors: [],
    adapter: { family: 'unsupported', checkinPath: '' },
  });
  const terminalWorkflow = (path, steps) => ({
    route: ['/profile', path],
    identityPath: '/profile',
    steps,
  });

  /* ---------------------------------------------------------------- *
   * ① 站点返回 403
   * ---------------------------------------------------------------- */
  expectDiagnosis('① 站点返回 403', await runScenario('403', {
    ...baseSite(ORIGIN),
    loginUrl: `${ORIGIN}/forbidden`,
  }), DIAGNOSIS.ACCESS_DENIED, ['地区', '节点']);

  /* ---------------------------------------------------------------- *
   * ② 签到按钮不存在（站点改版）
   * ---------------------------------------------------------------- */
  expectDiagnosis('② 签到按钮不存在', await runScenario('selector', {
    ...baseSite(ORIGIN),
    checkin: {
      method: 'workflow',
      url: '/renamed-checkin',
      workflow: terminalWorkflow('/renamed-checkin', [
        { type: 'click', selector: '#old-claim-button', fingerprint: { tag: 'button', text: '立即签到' } },
      ]),
    },
  }), DIAGNOSIS.SELECTOR_MISMATCH, ['学习签到', '重新演示']);

  /* ---------------------------------------------------------------- *
   * ③ 命中了错误的元素（指纹失配）
   * ---------------------------------------------------------------- */
  expectDiagnosis('③ 命中了错误的元素', await runScenario('drift', {
    ...baseSite(ORIGIN),
    checkin: {
      method: 'workflow',
      url: '/drifted-checkin',
      workflow: terminalWorkflow('/drifted-checkin', [
        { type: 'click', selector: '#claim', fingerprint: { tag: 'button', text: '立即签到' } },
      ]),
    },
  }), DIAGNOSIS.ELEMENT_MISMATCH, ['指纹', '重新演示']);

  /* ---------------------------------------------------------------- *
   * ④ 页面加载不出来（TCP 连上但永远不响应）
   * ---------------------------------------------------------------- */
  const hangBefore = hangResponses;
  expectDiagnosis('④ 页面加载不出来', await runScenario('timeout', {
    ...baseSite(ORIGIN),
    loginUrl: `${ORIGIN}/hang-login`,
  }), DIAGNOSIS.PAGE_TIMEOUT, ['直接打开', '代理']);
  check('④ 站点确实收到了这个请求（不是本地短路）', hangResponses > hangBefore, `hang=${hangResponses - hangBefore}`);

  /* ---------------------------------------------------------------- *
   * ⑤ 本机代理端口没人监听
   *
   * 站点走 HTTPS + 普通域名，因此扩展配置的死代理会真正被使用：
   * 浏览器把请求交给 127.0.0.1:7897，那里没有任何程序在监听。
   * ---------------------------------------------------------------- */
  expectDiagnosis('⑤ 本机代理端口没人监听', await runScenario('proxy', {
    ...baseSite(PROXY_ORIGIN),
    checkin: { method: 'none' },
    proxies: [{ id: 'dead', name: '死端口', scheme: 'http', host: '127.0.0.1', port: DEAD_PROXY_PORT }],
  }, {
    proxyMode: 'pool',
    proxyId: 'dead',
    proxyPinned: true,
  }), DIAGNOSIS.PROXY_UNREACHABLE, ['Clash Verge', '端口']);

  /* ---------------------------------------------------------------- *
   * ⑥ 当天已签到 —— 不是失败
   * ---------------------------------------------------------------- */
  {
    const label = '⑥ 当天已签到';
    const state = await runScenario('already', {
      ...baseSite(ORIGIN),
      checkin: {
        method: 'workflow',
        url: '/already-checkin',
        workflow: terminalWorkflow('/already-checkin', [
          { type: 'click', selector: '#claim', fingerprint: { tag: 'button', text: '立即签到' } },
        ]),
      },
    });
    const result = state.result;
    console.log(`\n── ${label} ──`);
    console.log(`   状态=${state.status}`);
    console.log(`   说明=${result?.message ?? 'n/a'}`);

    // 已签到是**完成终态**：既不该报故障，也不该再点一次。
    check(`[${label}] 终态是完成而不是失败`, state.status === 'done' && result?.ok === true,
      `status=${state.status} ok=${result?.ok} message=${JSON.stringify(result?.message)}`);
    check(`[${label}] 说明里写清了是已签到 / 已完成`,
      /已签到|今日签到已完成|今日已完成/.test(result?.message ?? ''), result?.message);
    check(`[${label}] 日志留下了「页面显示今日已完成」这条证据`,
      (result?.steps ?? []).some((step) => /页面显示今日已完成|已签到/.test(step)),
      JSON.stringify((result?.steps ?? []).slice(-4)));

    // 万一这句话被当成失败送进诊断，也必须落在「已签到」而不是某一类故障上。
    const seen = diagnoseFailure(result?.message ?? '', result?.steps ?? []);
    check(`[${label}] 送进诊断时归到「已签到」而不是故障`, seen.code === DIAGNOSIS.ALREADY_DONE,
      `actual=${seen.code} title=${seen.title}`);
    console.log(`   诊断标题=${seen.title}`);
    for (const [index, action] of seen.nextActions.entries()) console.log(`   下一步 ${index + 1}. ${action}`);
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${failed.length ? '✖' : '✔'} 诊断矩阵：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    for (const item of failed) console.log(`   失败：${item.name}${item.detail ? `  — ${item.detail}` : ''}`);
    exitCode = 1;
  }
} catch (error) {
  console.error('诊断矩阵脚本异常：', error);
  exitCode = 1;
} finally {
  await context?.close().catch(() => {});
  await vite?.close().catch(() => {});
  await new Promise((done) => server.close(done));
  await new Promise((done) => secureServer.close(done));
  rmSync(profile, { recursive: true, force: true });
}

process.exit(exitCode);

