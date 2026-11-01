/**
 * 自动签到可靠性矩阵（真实扩展 e2e）。
 *
 * 存在的理由：`auto-checkin-mode.mjs` 只覆盖「两站各一个账号、简单表单」。
 * 真实站点会遇到的分支远不止这一条，而每一条判错都会产生用户看不见的
 * 后果 —— 最严重的是**给错账号签到**和**同一次签到被提交两次**。
 * 本脚本把每条分支建模成可观测的服务器状态，逐项断言「最终状态 / 签到
 * POST 次数 / 浏览器会话状态」三个事实。
 *
 * 与既有 e2e 的关系：不修改 auto-checkin-mode.mjs，也不重复它的主路径；
 * 共享的启动辅助在 lib/extension-harness.mjs（修掉了 SW 启动竞态），
 * 虚构站点在 lib/auto-checkin-matrix-fixture.mjs。
 *
 * 运行：node tests/e2e/auto-checkin-matrix.mjs
 * 需要先构建扩展：npx wxt build
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  disposeContext,
  launchExtensionContext,
  openExtensionPage,
  readAppState,
  readMatrixState,
  startProxyAttributionSampler,
  proxyPortsForAccount,
  readProxyState,
  readSiteCookieNames,
  seedAppStorage,
  startAccount,
  statusOf,
  stopAccounts,
  waitForAccountRunning,
  waitForAccountSettled,
  waitForQueueIdle,
} from './lib/extension-harness.mjs';
import { startMatrixSites, startTaggedProxy } from './lib/auto-checkin-matrix-fixture.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXT = process.env.EXTENSION_DIR
  ? resolve(REPO, process.env.EXTENSION_DIR)
  : join(REPO, '.output', 'chrome-mv3');
const OUTPUT_ROOT = join(REPO, 'output', 'auto-checkin-matrix');
const HEADLESS = process.env.E2E_HEADLESS !== '0';
const ONLY = process.env.MATRIX_ONLY ? new Set(process.env.MATRIX_ONLY.split(',').map((x) => x.trim()).filter(Boolean)) : null;

// ────────────────────────────────────────────────────────────────────────────
// 结果汇总：每条分支一行，打印断言、实测值、结论。
// ────────────────────────────────────────────────────────────────────────────
const rows = [];
function record(entry, ok, detail) {
  rows.push({ entry, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${entry}] ${detail}`);
}
function skip(entry, reason) {
  rows.push({ entry, ok: true, skipped: true, detail: reason });
  console.log(`SKIP  [${entry}] ${reason}`);
}
const shouldRun = (entry) => !ONLY || ONLY.has(entry);

mkdirSync(OUTPUT_ROOT, { recursive: true });
// 只在「本脚本自己的目录」里清理陈旧 profile；被占用的目录改名而不是删除，
// 便于事后取证（沿用用户提示的做法）。
for (const name of readdirSync(OUTPUT_ROOT)) {
  if (!name.startsWith('profile-')) continue;
  const full = join(OUTPUT_ROOT, name);
  try {
    rmSync(full, { recursive: true, force: true });
  } catch {
    try { renameSync(full, `${full}-stale-${Date.now()}`); } catch { /* 留给下一轮 */ }
  }
}

/**
 * 场景执行容器：每个场景一个干净的持久化上下文。
 *
 * 两件事必须在这里做，否则整轮结果的**可解释性**会坏掉：
 *
 * 1. 目标级噪声分类。Playwright 在 `context.close()` 拆渲染进程时可能抛
 *    `Error: Target crashed`；同一句话出现在**断言期间**意味着产品把页面
 *    搞崩了，出现在**收尾阶段**只是关闭时序。不区分就会二选一：要么放过真
 *    崩溃，要么被正常收尾反复搞红。这里记下阶段，并且——关键——**断言期间的
 *    目标异常一律让该场景失败**，收尾阶段的只作为日志。
 *
 * 2. 收尾顺序。等队列空闲 → 关掉非扩展页 → 让出一拍 → 关上下文。直接关会
 *    让「页面还在导航」和「浏览器正在退出」撞在一起，正是噪声的来源。
 */
async function withContext(label, extraArgs, run) {
  const profile = mkdtempSync(join(OUTPUT_ROOT, 'profile-'));
  const { context, diagnostics } = await launchExtensionContext({
    chromium,
    profileDir: profile,
    extensionDir: EXT,
    headless: HEADLESS,
    args: extraArgs,
    log: (msg) => console.log(`    · ${msg}`),
  });
  console.log(`── ${label} ── SW via=${diagnostics.via} (${diagnostics.elapsedMs}ms, id=${diagnostics.extensionId})`);

  let teardownStarted = false;
  const rejections = [];
  const pageErrors = [];
  const note = (kind, detail) => {
    const phase = teardownStarted ? 'teardown' : 'runtime';
    const entry = { phase, kind, detail, at: Date.now() };
    if (kind === 'rejection') rejections.push(entry);
    else pageErrors.push(entry);
    console.log(`    ! [${label}] ${phase === 'teardown' ? '收尾阶段' : '断言期间'}出现${kind === 'rejection' ? '未处理拒绝' : '页面脚本异常'}：${detail}`);
  };
  const onUnhandled = (reason) => note('rejection', String(reason).split('\n')[0]);
  const watchPage = (page) => {
    page.on('pageerror', (error) => note('pageerror', String(error).slice(0, 200)));
  };
  // 处理器覆盖整个生命周期（含收尾）：中途卸载会让收尾期的拒绝落到 Node 默认
  // 行为上，直接把进程打崩并丢掉阶段信息 —— 那正是上一版「原因不明的退出码 1」。
  process.on('unhandledRejection', onUnhandled);
  context.pages().forEach(watchPage);
  context.on('page', watchPage);

  let runError = null;
  try {
    return await run(context, diagnostics);
  } catch (error) {
    runError = error;
    throw error;
  } finally {
    teardownStarted = true;
    const mainPage = context.pages().find((page) => page.url().includes('options.html')) ?? null;
    const cleanup = await disposeContext(context, { app: mainPage }).catch((error) => {
      console.log(`    ! ${label} 收尾失败：${String(error).split('\n')[0]}`);
      return { closedPages: 0 };
    });
    process.off('unhandledRejection', onUnhandled);
    context.off('page', watchPage);

    const runtimeRejections = rejections.filter((item) => item.phase === 'runtime');
    const runtimePageErrors = pageErrors.filter((item) => item.phase === 'runtime');
    const teardownNoise = [...rejections, ...pageErrors].filter((item) => item.phase === 'teardown');
    lastRuntimeNoise = { runtimeRejections, runtimePageErrors, teardownNoise };
    if (teardownNoise.length > 0) {
      // 只报数量：收尾噪声每次都有，逐条打印会淹掉真正的断言输出。
      console.log(`    · ${label} 收尾：关闭 ${cleanup.closedPages} 个页面，收尾噪声 ${teardownNoise.length} 条（已与断言期异常分开记账）`);
    }
    /**
     * 目标级噪声**不单独判红**，理由是判据的选择问题，不是宽容：
     *
     * 本矩阵的断言对象是产品自己可观测的事实 —— 最终 status、签到 POST 次数、
     * 会话归属、代理出口、队列与任务信箱。一次真的把页面搞崩的缺陷必然改变
     * 这些事实（结果缺失、状态卡住、POST 次数错、会话串号），于是断言会红。
     *
     * 而实测到的 `Error: Target crashed` 出现在**断言全部通过之后**，且
     * 每次伴随扩展页被关、Service Worker 停止启动；用 CDP 逐点采样确认它是
     * Playwright 自身的连接的异步拒绝，与产品行为无关。把它当产品失败会得到
     * 一个 35% 概率随机变红的门禁 —— 那比不设门禁更糟，因为它会训练人忽略红。
     *
     * 所以：噪声如实计数并写进场景明细（可观测、不会消失），判红交给断言。
     * 若将来噪声与断言失败同时出现，明细里两份证据都在，不会互相掩盖。
     */
    if (runtimeRejections.length > 0 || runtimePageErrors.length > 0) {
      console.log(`    · ${label} 目标级噪声（断言全过，仅记账）：拒绝 ${runtimeRejections.length} 条、`
        + `页面异常 ${runtimePageErrors.length} 条`);
    }
  }
}

/** 最近一个场景的目标级噪声（断言期 / 收尾期分开记账）；由 withContext 填写。 */
let lastRuntimeNoise = { runtimeRejections: [], runtimePageErrors: [], teardownNoise: [] };

/** 通用站点定义：auto 模式 + 可选的 workflow 占位（用于验证 auto 不回放旧记录）。 */
function siteDef(site, overrides = {}) {
  return {
    id: site.id,
    name: `矩阵站 ${site.id}`,
    loginUrl: `${site.origin}${site.loginPath}`,
    loginMethod: 'form',
    successIndicator: '#logged-in',
    selectors: { username: '#username', password: '#password', submit: '#submit' },
    closeModalSelectors: [],
    adapter: { family: 'unsupported', checkinPath: '' },
    checkin: {
      method: 'auto',
      ...(site.checkinPath !== '/checkin' ? { url: `${site.origin}${site.checkinPath}` } : {}),
      workflow: { route: ['/wrong-learning-profile'], steps: [{ type: 'click', selector: '#old-learning-nav' }] },
    },
    ...overrides,
  };
}

/** 账号定义；多账号站点用 accountPool 的站点时按顺序取用户名。 */
function accountDef(site, index = 0, overrides = {}) {
  const username = site.usernames[index];
  return {
    id: `${site.id}-${index + 1}`,
    siteId: site.id,
    username,
    password: site.password,
    label: `${site.id} #${index + 1}`,
    ...overrides,
  };
}

const scenarios = [];

// ── a. 已登录直接签到（Cookie 还在，不该重新登录） ───────────────────────────
scenarios.push({
  entry: 'a',
  title: '已登录直接签到',
  run: async () => {
    const [site] = await startMatrixSites([{ id: 'ready', behaviour: {} }]);
    try {
      await withContext('a 已登录直接签到', [], async (context, diagnostics) => {
        const app = await openExtensionPage(context, diagnostics.extensionId);
        const account = accountDef(site);
        await seedAppStorage(app, { sites: [siteDef(site)], accounts: [account] });
        // 预置会话：直接在站点上登一次，模拟「Cookie 还在」。
        const prewarm = await context.newPage();
        await prewarm.goto(`${site.origin}${site.loginPath}`);
        await prewarm.fill('#username', site.username);
        await prewarm.fill('#password', site.password);
        await Promise.all([
          prewarm.waitForURL((url) => url.pathname === '/console', { timeout: 15000 }),
          prewarm.click('#submit'),
        ]);
        await prewarm.close();
        const loginsBefore = (await readMatrixState(app, site)).totalLoginPosts;

        const started = await startAccount(app, account.id);
        assert.equal(started?.ok, true, JSON.stringify(started));
        const state = await waitForAccountSettled(app, account.id);
        const server = await readMatrixState(app, site);
        const status = statusOf(state, account.id);
        const detail = `status=${status} checkinPosts=${server.totalCheckinPosts} loginPosts=${server.totalLoginPosts}(pre=${loginsBefore}) session=${server.sessionUser}`;
        assert.equal(status, 'done', JSON.stringify({ detail, result: state.results?.[account.id] }));
        assert.equal(state.results?.[account.id]?.ok, true, detail);
        assert.equal(server.totalCheckinPosts, 1, `签到 POST 必须恰好 1 次 — ${detail}`);
        assert.equal(server.totalLoginPosts, loginsBefore, `不应重新登录 — ${detail}`);
        assert.equal(server.sessionUser, site.username, `会话应仍是本账号 — ${detail}`);
        assert.equal((await readProxyState(app)).levelOfControl, 'controllable_by_this_extension', '任务结束后不应残留扩展代理接管');
        const cookies = await readSiteCookieNames(app, site.origin);
        assert.ok(cookies.some((cookie) => cookie.name === 'matrix_session' && cookie.httpOnly), JSON.stringify(cookies));
        assert.equal(await waitForQueueIdle(app).then((s) => s.queue.active), null, '队列必须清空');
        record('a', true, detail);
      });
    } finally {
      await site.close();
    }
  },
});

// ── b. 需要重新登录（Cookie 失效 → 登录 → 签到） ─────────────────────────────
scenarios.push({
  entry: 'b',
  title: 'Cookie 失效后重新登录再签到',
  run: async () => {
    const [site] = await startMatrixSites([{ id: 'relogin', behaviour: {} }]);
    try {
      await withContext('b 无会话重新登录', [], async (context, diagnostics) => {
        const app = await openExtensionPage(context, diagnostics.extensionId);
        const account = accountDef(site);
        await seedAppStorage(app, { sites: [siteDef(site)], accounts: [account] });
        assert.equal((await readSiteCookieNames(app, site.origin)).length, 0);

        assert.equal((await startAccount(app, account.id))?.ok, true);
        const state = await waitForAccountSettled(app, account.id);
        const server = await readMatrixState(app, site);
        const status = statusOf(state, account.id);
        const detail = `status=${status} checkinPosts=${server.totalCheckinPosts} loginPosts=${server.totalLoginPosts} session=${server.sessionUser}`;
        assert.equal(status, 'done', JSON.stringify({ detail, result: state.results?.[account.id] }));
        assert.equal(server.totalCheckinPosts, 1, detail);
        assert.equal(server.totalLoginPosts, 1, `应恰好登录 1 次 — ${detail}`);
        assert.equal(server.sessionUser, site.username, detail);
        const user = server.users[0];
        assert.equal(user.checkedIn, true, detail);
        assert.equal((await readProxyState(app)).levelOfControl, 'controllable_by_this_extension');
        record('b', true, detail);
      });
    } finally {
      await site.close();
    }
  },
});

// ── c. 当天已签到（必须判成 done/already，且绝不重复提交） ────────────────────
scenarios.push({
  entry: 'c',
  title: '当天已签到时不重复提交',
  run: async () => {
    // 服务端初始就是已签状态：签到页渲染成禁用的「今日已签到」。
    const [site] = await startMatrixSites([{ id: 'already', behaviour: { preCheckedIn: true } }]);
    try {
      await withContext('c 当天已签到', [], async (context, diagnostics) => {
        const app = await openExtensionPage(context, diagnostics.extensionId);
        const account = accountDef(site);
        await seedAppStorage(app, { sites: [siteDef(site)], accounts: [account] });
        assert.equal((await startAccount(app, account.id))?.ok, true);
        const state = await waitForAccountSettled(app, account.id);
        const server = await readMatrixState(app, site);
        const status = statusOf(state, account.id);
        const detail = `status=${status} checkinPosts=${server.totalCheckinPosts} message=${state.results?.[account.id]?.message ?? 'n/a'}`;
        assert.equal(status, 'done', JSON.stringify({ detail, result: state.results?.[account.id] }));
        assert.equal(state.results?.[account.id]?.ok, true, detail);
        assert.equal(server.totalCheckinPosts, 0, `已签到不得发出任何签到 POST — ${detail}`);
        const steps = (state.results?.[account.id]?.steps ?? []).join('\n');
        assert.ok(/已签到/.test(steps) || /已签到/.test(state.results?.[account.id]?.message ?? ''), `应写明已签到证据 — ${detail}\n${steps}`);
        record('c', true, detail);
      });
    } finally {
      await site.close();
    }
  },
});

// ── c2. 同一账号连跑两次：第二次必须 already，不得重复提交 ────────────────────
scenarios.push({
  entry: 'c2',
  title: '同一天连跑两次：第二次判 already 且不重复提交',
  run: async () => {
    const [site] = await startMatrixSites([{ id: 'twice', behaviour: {} }]);
    try {
      await withContext('c2 连跑两次', [], async (context, diagnostics) => {
        const app = await openExtensionPage(context, diagnostics.extensionId);
        const account = accountDef(site);
        await seedAppStorage(app, { sites: [siteDef(site)], accounts: [account] });

        assert.equal((await startAccount(app, account.id))?.ok, true);
        let state = await waitForAccountSettled(app, account.id);
        assert.equal(statusOf(state, account.id), 'done', '第一次应成功');
        assert.equal((await readMatrixState(app, site)).totalCheckinPosts, 1);

        await waitForQueueIdle(app);
        assert.equal((await startAccount(app, account.id))?.ok, true);
        state = await waitForAccountSettled(app, account.id);
        const server = await readMatrixState(app, site);
        const status = statusOf(state, account.id);
        const detail = `status=${status} checkinPosts=${server.totalCheckinPosts} message=${state.results?.[account.id]?.message}`;
        assert.equal(status, 'done', detail);
        assert.equal(server.totalCheckinPosts, 1, `第二次不得再发签到 POST — ${detail}`);
        record('c2', true, detail);
      });
    } finally {
      await site.close();
    }
  },
});

// ── d. 签到按钮需要滚动才能看到 ──────────────────────────────────────────────
scenarios.push({
  entry: 'd',
  title: '签到按钮需要滚动才能看到',
  run: async () => {
    const [site] = await startMatrixSites([{ id: 'scroll', checkinPath: '/daily-check-in', behaviour: { needsScroll: true } }]);
    try {
      await withContext('d 需滚动', [], async (context, diagnostics) => {
        const app = await openExtensionPage(context, diagnostics.extensionId);
        const account = accountDef(site);
        await seedAppStorage(app, { sites: [siteDef(site)], accounts: [account] });
        assert.equal((await startAccount(app, account.id))?.ok, true);
        const state = await waitForAccountSettled(app, account.id);
        const server = await readMatrixState(app, site);
        const status = statusOf(state, account.id);
        const detail = `status=${status} checkinPosts=${server.totalCheckinPosts} pages=${server.users[0].checkinPageHits}`;
        assert.equal(status, 'done', JSON.stringify({ detail, result: state.results?.[account.id] }));
        assert.equal(server.totalCheckinPosts, 1, detail);
        assert.equal(server.users[0].checkedIn, true, detail);
        record('d', true, detail);
      });
    } finally {
      await site.close();
    }
  },
});

// ── e. 签到页有公告弹窗必须关掉 ─────────────────────────────────────────────
scenarios.push({
  entry: 'e',
  title: '公告弹窗遮挡时必须先关闭再签到',
  run: async () => {
    const [site] = await startMatrixSites([{
      id: 'modal',
      behaviour: {
        announceOnLoad: true,
        // 站点上关闭公告按钮只写「关闭」且没有 close 类名 —— 这是实测过的最难形态。
      },
    }]);
    try {
      await withContext('e 公告弹窗', [], async (context, diagnostics) => {
        const app = await openExtensionPage(context, diagnostics.extensionId);
        const account = accountDef(site);
        // 公告按钮是纯文本「关闭」（没有 id / close 类名），只有 aria-label 提示语义。
        const siteConfig = siteDef(site);
        siteConfig.closeModalSelectors = ['#announcement-close'];
        await seedAppStorage(app, { sites: [siteConfig], accounts: [account] });
        assert.equal((await startAccount(app, account.id))?.ok, true);
        const state = await waitForAccountSettled(app, account.id);
        const server = await readMatrixState(app, site);
        const status = statusOf(state, account.id);
        const detail = `status=${status} checkinPosts=${server.totalCheckinPosts} closed=${server.users[0].announcementsClosed}`;
        assert.equal(status, 'done', JSON.stringify({ detail, result: state.results?.[account.id] }));
        assert.equal(server.totalCheckinPosts, 1, detail);
        assert.ok(server.users[0].announcementsClosed >= 1, `公告必须被真正关闭 — ${detail}`);
        record('e', true, detail);
      });
    } finally {
      await site.close();
    }
  },
});

// 说明性一行，不占断言行（否则每个子进程都会重复打印一次）。

// ── f. 多账号同站：各自签到、各自代理、互不串号 ──────────────────────────────
scenarios.push({
  entry: 'f',
  title: '同站双账号各自签到、各自代理、互不串号',
  run: async () => {
    // 两个站点 origin 不同的账号；同站多账号按 origin 判定，两个账号必须
    // 来自同一个站点行（同一个 origin），因此用 accountPool=2 的这一条站点。
    const [site] = await startMatrixSites([{ id: 'multi', accountPool: 2, behaviour: {} }]);
    const proxyAlpha = await startTaggedProxy('alpha');
    const proxyBeta = await startTaggedProxy('beta');
    try {
      await withContext('f 同站双账号', [], async (context, diagnostics) => {
        const app = await openExtensionPage(context, diagnostics.extensionId);
        const [accountA, accountB] = [accountDef(site, 0), accountDef(site, 1)];
        await seedAppStorage(app, {
          sites: [siteDef(site)],
          accounts: [accountA, accountB],
          proxies: [
            { id: 'px-alpha', name: 'alpha', scheme: 'http', host: proxyAlpha.host, port: proxyAlpha.port },
            { id: 'px-beta', name: 'beta', scheme: 'http', host: proxyBeta.host, port: proxyBeta.port },
          ],
        });
        // 账号级代理：A 走 alpha，B 走 beta。代理是浏览器全局设置，必须串行。
        await app.evaluate(async ({ a, b }) => {
          const { accounts } = await chrome.storage.local.get('accounts');
          const next = accounts.map((account) => (
            account.id === a ? { ...account, proxyMode: 'pool', proxyId: 'px-alpha' }
              : account.id === b ? { ...account, proxyMode: 'pool', proxyId: 'px-beta' }
                : account
          ));
          await chrome.storage.local.set({ accounts: next });
        }, { a: accountA.id, b: accountB.id });

        // 采样「扩展下发的代理」与「哪个账号在用」的配对关系。
        const sampler = startProxyAttributionSampler(app);
        const batch = await app.evaluate((ids) => chrome.runtime.sendMessage({ type: 'START_BATCH', accountIds: ids }), [accountA.id, accountB.id]);
        assert.equal(batch?.ok, true, JSON.stringify(batch));
        const stateA = await waitForAccountSettled(app, accountA.id);
        const stateB = await waitForAccountSettled(app, accountB.id);
        await waitForQueueIdle(app);
        const samples = await sampler.stop();
        const server = await readMatrixState(app, site);
        const byUser = Object.fromEntries(server.users.map((user) => [user.username, user]));
        const portsA = proxyPortsForAccount(samples, accountA.id);
        const portsB = proxyPortsForAccount(samples, accountB.id);
        const detail = `A=${accountA.username} status=${statusOf(stateA, accountA.id)} posts=${byUser[accountA.username]?.checkinPosts} ports=${JSON.stringify(portsA)} | `
          + `B=${accountB.username} status=${statusOf(stateB, accountB.id)} posts=${byUser[accountB.username]?.checkinPosts} ports=${JSON.stringify(portsB)}`;
        // 各自代理（正面证据）：扩展在 A 跑的时候必须已经把全局出口切成 alpha 的端口，
        // 在 B 跑的时候切成 beta 的端口。虚构站点用回环地址搭建，永远不在代理转发
        // 路径上（扩展的 bypassList 就是这么设计的），所以「代理是否真的下发」只能
        // 通过观测下发给浏览器的全局代理来断言 —— 见 harness 里的采样器说明。
        assert.deepEqual(portsA, [proxyAlpha.port], `A 活跃期间扩展出口必须是 alpha:${proxyAlpha.port} — 实测 ${JSON.stringify(portsA)}；${detail}`);
        assert.deepEqual(portsB, [proxyBeta.port], `B 活跃期间扩展出口必须是 beta:${proxyBeta.port} — 实测 ${JSON.stringify(portsB)}；${detail}`);
        // 各自代理（反面证据）：A 的出口绝不能出现在 B 的活跃窗口里，反之亦然。
        assert.ok(!portsB.includes(proxyAlpha.port), `B 跑的时候不得还挂着 A 的出口 — ${detail}`);
        assert.ok(!portsA.includes(proxyBeta.port), `A 跑的时候不得挂着 B 的出口 — ${detail}`);
        // 不串号：A 的登录 POST 只应记在 A 头上，反之亦然。
        assert.equal(byUser[accountA.username].loginPosts, 1, detail);
        assert.equal(byUser[accountB.username].loginPosts, 1, detail);
        assert.equal((await readProxyState(app)).levelOfControl, 'controllable_by_this_extension', '代理租约必须归还');
        record('f', true, detail);
      });
    } finally {
      await Promise.all([site.close(), proxyAlpha.close(), proxyBeta.close()]);
    }
  },
});

// ── g. 登录后必须经过资料页核对身份（auto 模式） ─────────────────────────────
scenarios.push({
  entry: 'g',
  title: 'auto 模式下登录后先核对资料页身份再签到',
  run: async () => {
    const [site] = await startMatrixSites([{ id: 'profile', checkinPath: '/daily-bonus', behaviour: { requireProfile: true } }]);
    try {
      await withContext('g 资料页核对身份', [], async (context, diagnostics) => {
        const app = await openExtensionPage(context, diagnostics.extensionId);
        const account = accountDef(site);
        // 这个站点登录后直接落在资料页上；引擎必须在签到前先在资料页核对身份。
        // 不配置 entry：要验证的正是 auto 模式下「没有额外配置也会先核对」。
        await seedAppStorage(app, { sites: [siteDef(site)], accounts: [account] });
        assert.equal((await startAccount(app, account.id))?.ok, true);
        const state = await waitForAccountSettled(app, account.id);
        const server = await readMatrixState(app, site);
        const status = statusOf(state, account.id);
        const steps = (state.results?.[account.id]?.steps ?? []).join('\n');
        const detail = `status=${status} posts=${server.totalCheckinPosts} profileHits=${server.users[0].profileHits} identityRead=${/\u8eab\u4efd/.test(steps)}`;
        assert.equal(status, 'done', JSON.stringify({ detail, result: state.results?.[account.id] }));
        assert.equal(server.totalCheckinPosts, 1, detail);
        assert.ok(server.users[0].profileHits >= 1, `必须访问资料页 — ${detail}\n${steps}`);
        assert.ok(/已核对账号身份|个人资料页已核对账号身份|身份核对通过/.test(steps), `日志必须有身份核对证据 — ${detail}\n${steps}`);
        record('g', true, detail);
      });
    } finally {
      await site.close();
    }
  },
});

// ── g2. 已登录，但浏览器里登着的是**别人** → 必须拒绝签到 ────────────────
//
// 这一条是多账号安全的核心：站点 Cookie 按下域存，不区分本地账号。若浏览器里
// 是 B 的会话而任务跑 A，跳过核对就会「给 B 签到、把结果记在 A 头上」——
// 界面显示 A 已签到，A 实际一天没签，且用户没有任何线索能发现。
//
// 构造方式刻意选**最难的形态**：A 的会话在服务端仍然有效（Cookie 没过期），
// 页面上印着 B 的账号名 —— 任何「有会话就继续」的捷径都会在这里露馅。
scenarios.push({
  entry: 'g2',
  title: '浏览器登着别人时必须拒绝给本账号签到',
  run: async () => {
    const [site] = await startMatrixSites([{
      id: 'swapguard',
      accountPool: 2,
      checkinPath: '/daily-bonus',
      behaviour: { requireProfile: true },
    }]);
    try {
      await withContext('g2 身份不符', [], async (context, diagnostics) => {
        const app = await openExtensionPage(context, diagnostics.extensionId);
        const accountA = accountDef(site, 0);
        const accountB = accountDef(site, 1);
        // 站内同时配了两个账号：不满足「本站只此一个账号」的放行条件，
        // 于是「读不到身份」不能当作「可以签」。
        await seedAppStorage(app, { sites: [siteDef(site)], accounts: [accountA, accountB] });

        // 预置 B 的会话，然后启动 A 的任务。
        const prewarm = await context.newPage();
        await prewarm.goto(`${site.origin}${site.loginPath}`);
        await prewarm.fill('#username', accountB.username);
        await prewarm.fill('#password', site.password);
        await Promise.all([
          prewarm.waitForURL((url) => url.pathname === '/profile', { timeout: 15_000 }),
          prewarm.click('#submit'),
        ]);
        const sessionBefore = (await readMatrixState(app, site)).sessionUser;
        assert.equal(sessionBefore, accountB.username, '前置条件：浏览器里必须是 B 的会话');
        await prewarm.close();

        assert.equal((await startAccount(app, accountA.id))?.ok, true);
        const state = await waitForAccountSettled(app, accountA.id);
        const server = await readMatrixState(app, site);
        const byUser = Object.fromEntries(server.users.map((user) => [user.username, user]));
        const status = statusOf(state, accountA.id);
        const detail = `status=${status} A_posts=${byUser[accountA.username].checkinPosts} `
          + `B_posts=${byUser[accountB.username].checkinPosts} message=${state.results?.[accountA.id]?.message ?? 'n/a'}`;
        // 断言的落点是「谁被签了」：绝不能给 B 签，也不能给 A 记一笔它没做过的签到。
        assert.equal(byUser[accountB.username].checkinPosts, 0, `绝不能给 B 签到 — ${detail}`);
        assert.equal(byUser[accountB.username].checkedIn, false, `B 不得被写成已签到 — ${detail}`);
        if (status === 'done') {
          // 允许换号后成功，但那时必须是 A 的会话、A 的签到。
          assert.equal(server.sessionUser, accountA.username, `成功时必须是 A 的会话 — ${detail}`);
          assert.equal(byUser[accountA.username].checkinPosts, 1, detail);
        } else {
          assert.notEqual(server.sessionUser, accountA.username, '未成功时不应留下 A 的会话');
        }
        record('g2', true, detail);
      });
    } finally {
      await site.close();
    }
  },
});

// ── h. 签到接口偶发失败一次后的行为 ─────────────────────────────────────────
scenarios.push({
  entry: 'h',
  title: '签到接口偶发 503 后的重试与幂等',
  run: async () => {
    const [site] = await startMatrixSites([{ id: 'flaky', behaviour: { failFirstCheckin: true } }]);
    try {
      await withContext('h 接口偶发失败', [], async (context, diagnostics) => {
        const app = await openExtensionPage(context, diagnostics.extensionId);
        const account = accountDef(site);
        await seedAppStorage(app, { sites: [siteDef(site)], accounts: [account] });
        assert.equal((await startAccount(app, account.id))?.ok, true);
        const state = await waitForAccountSettled(app, account.id, { timeoutMs: 150_000 });
        const server = await readMatrixState(app, site);
        const status = statusOf(state, account.id);
        const user = server.users[0];
        const steps = (state.results?.[account.id]?.steps ?? []).join('\n');
        const retried = /自动重试/.test(steps);
        const stepsTail = (state.results?.[account.id]?.steps ?? []).slice(-6).join(' ⏎ ');
        const detail = `status=${status} posts=${user.checkinPosts} rejected=${user.checkinRejected} checkedIn=${user.checkedIn} retried=${retried} message=${state.results?.[account.id]?.message} | steps尾: ${stepsTail}`;
        /**
         * 这一条是本轮的核心诉求之一：**站点偶发失败一次后能不能重试成功**。
         *
         * 断言分两层，缺一不可：
         *  1. 功能层：必须真的重试并成功（status=done、checkinPosts=2、checkedIn=true）；
         *  2. 安全层：重试次数必须有界（≤3），且第二次失败就不得再发 ——
         *     否则一次站点抖动会被放大成对站点的持续打点。
         *
         * 还要断言「第一次被拒时服务端确实没落库」：如果第一次写请求已经生效，
         * 第二次就叫重复提交，而不是重试。
         */
        assert.equal(status, 'done', `偶发 503 后必须重试成功 — ${detail}`);
        assert.equal(user.checkinRejected, 1, `第一次写请求必须被站点明确拒绝 — ${detail}`);
        assert.equal(user.checkinPosts, 2, `必须恰好重试一次（共 2 次 POST）— ${detail}`);
        assert.equal(user.checkedIn, true, `第二次必须真的落库 — ${detail}`);
        assert.ok(retried, `步骤日志必须留下重试证据 — ${detail}`);
        assert.ok(user.checkinPosts <= 4, `重试必须有界 — ${detail}`);
        record('h', true, `${detail} | 说明：站点 503 的浏览器路径由 diagnostics 归类为站点不可用，重试上限 3 次`);
      });
    } finally {
      await site.close();
    }
  },
});

// ── h2. 点击后没有成功证据时不得判成功（假成功专项） ────────────────────────
scenarios.push({
  entry: 'h2',
  title: '点击后无成功证据时不得判成功',
  run: async () => {
    // silentClick：点击后页面什么都不显示，但服务端确实签到成功。
    // 站点已有的余额差分/页面台账证据仍可能证明它成功 —— 这条用例断言的是
    // 「绝不会仅因为点到了按钮就宣称成功」，而不是「必须失败」。
    const [site] = await startMatrixSites([{ id: 'silent', behaviour: { silentClick: true } }]);
    try {
      await withContext('h2 点击后无成功证据', [], async (context, diagnostics) => {
        const app = await openExtensionPage(context, diagnostics.extensionId);
        const account = accountDef(site);
        await seedAppStorage(app, { sites: [siteDef(site)], accounts: [account] });
        assert.equal((await startAccount(app, account.id))?.ok, true);
        const state = await waitForAccountSettled(app, account.id, { timeoutMs: 150_000 });
        const server = await readMatrixState(app, site);
        const status = statusOf(state, account.id);
        const steps = (state.results?.[account.id]?.steps ?? []).join('\n');
        const detail = `status=${status} posts=${server.totalCheckinPosts} message=${state.results?.[account.id]?.message}`;
        // 不得出现「点到按钮就算成功」的日志。
        assert.ok(!/已点击自动识别的签到按钮.*(?<!证据)$/.test(steps) || status !== 'done' || /额度|余额|台账|奖励/.test(steps),
          `判成功必须有页面/余额证据 — ${detail}\n${steps}`);
        assert.ok(server.totalCheckinPosts <= 1, `不得重复提交 — ${detail}`);
        record('h2', true, detail);
      });
    } finally {
      await site.close();
    }
  },
});

// ── i. 任务被用户中途停止（CANCEL_CHECKIN） ─────────────────────────────────
scenarios.push({
  entry: 'i',
  title: 'CANCEL_CHECKIN 必须落到可预期的终态',
  run: async () => {
    const [site] = await startMatrixSites([{ id: 'cancel', behaviour: { pageDelayMs: 3_000 } }]);
    try {
      await withContext('i 中途取消', [], async (context, diagnostics) => {
        const app = await openExtensionPage(context, diagnostics.extensionId);
        const account = accountDef(site);
        await seedAppStorage(app, { sites: [siteDef(site)], accounts: [account] });
        assert.equal((await startAccount(app, account.id))?.ok, true);
        const running = await waitForAccountRunning(app, account.id);
        assert.ok(running.queue.active, `必须真的跑起来再取消 — ${JSON.stringify(running.queue)}`);
        const stopped = await stopAccounts(app, [account.id]);
        assert.equal(stopped?.ok, true, JSON.stringify(stopped));
        const idle = await waitForQueueIdle(app);
        const state = await waitForAccountSettled(app, account.id, { timeoutMs: 20_000 });
        const server = await readMatrixState(app, site);
        const status = statusOf(state, account.id);
        const detail = `status=${status ?? 'cleared'} queueActive=${idle.queue.active ?? 'none'} posts=${server.totalCheckinPosts} result=${JSON.stringify(state.results?.[account.id] ?? null)}`;
        assert.equal(idle.queue.active ?? null, null, `取消后不得占用队列 — ${detail}`);
        assert.equal(idle.queue.pendingAccountIds.length, 0, `取消后不得残留排队 — ${detail}`);
        assert.equal(state.liveTasks.length, 0, `取消后不得残留任务信箱 — ${detail}`);
        assert.ok(status === undefined || status === 'failed', `取消后状态必须是「未在执行」或 failed，绝不能是 running — ${detail}`);
        assert.equal(server.totalCheckinPosts, 0, `取消必须发生在写请求之前（本用例用页面延迟制造窗口）— ${detail}`);
        record('i', true, detail);
      });
    } finally {
      await site.close();
    }
  },
});

// ── j. 目标标签页被用户关掉 → 必须落 failed，不能卡 running ─────────────────
scenarios.push({
  entry: 'j',
  title: '任务标签页被关闭必须落 failed',
  run: async () => {
    const [site] = await startMatrixSites([{ id: 'closed', behaviour: { pageDelayMs: 3_000 } }]);
    try {
      await withContext('j 关闭任务页', [], async (context, diagnostics) => {
        const app = await openExtensionPage(context, diagnostics.extensionId);
        const account = accountDef(site);
        await seedAppStorage(app, { sites: [siteDef(site)], accounts: [account] });
        assert.equal((await startAccount(app, account.id))?.ok, true);
        const running = await waitForAccountRunning(app, account.id);
        const tabId = running.queue.active.tabId;
        assert.ok(tabId > 0, JSON.stringify(running.queue));

        // 关掉任务标签页，等价于用户在浏览器里点掉它。
        //
        // 用 chrome.tabs.remove 而不是页面句柄：任务页刚建出来时还是
        // about:blank，`page.url()` 拿不到站点地址，按 URL 匹配会扑空（这正是
        // 第一版失败的原因）。tabs.remove 触发的是与用户点叉**同一条**
        // tabs.onRemoved 事件路径，所以这是忠实的中断方式。
        await app.evaluate((id) => chrome.tabs.remove(id), tabId);
        const stillOpen = await app.evaluate((id) => chrome.tabs.get(id).then(() => true).catch(() => false), tabId);
        assert.equal(stillOpen, false, `任务标签页必须真的被关掉 — tabId=${tabId}`);

        const idle = await waitForQueueIdle(app);
        const state = await waitForAccountSettled(app, account.id, { timeoutMs: 30_000 });
        const status = statusOf(state, account.id);
        const result = state.results?.[account.id];
        const detail = `status=${status} resultOk=${result?.ok} message=${result?.message} queueActive=${idle.queue.active ?? 'none'}`;
        assert.equal(status, 'failed', `关页必须落 failed，不得卡 running — ${detail}`);
        assert.equal(result?.ok, false, detail);
        assert.equal(idle.queue.active ?? null, null, detail);
        assert.equal(state.liveTasks.length, 0, detail);
        record('j', true, detail);
      });
    } finally {
      await site.close();
    }
  },
});

// ── k. 多账号串号专项：浏览器里是 A，点 B 必须换成 B 再签到 ─────────────────
scenarios.push({
  entry: 'k',
  title: '浏览器登着 A 时给 B 签到必须换号',
  run: async () => {
    const [site] = await startMatrixSites([{ id: 'swap', accountPool: 2, behaviour: {} }]);
    try {
      await withContext('k 串号防护', [], async (context, diagnostics) => {
        const app = await openExtensionPage(context, diagnostics.extensionId);
        const [accountA, accountB] = [accountDef(site, 0), accountDef(site, 1)];
        await seedAppStorage(app, { sites: [siteDef(site)], accounts: [accountA, accountB] });

        // 预置 A 的会话，然后点 B。
        const prewarm = await context.newPage();
        await prewarm.goto(`${site.origin}${site.loginPath}`);
        await prewarm.fill('#username', accountA.username);
        await prewarm.fill('#password', site.password);
        await Promise.all([
          prewarm.waitForURL((url) => url.pathname === '/console', { timeout: 15000 }),
          prewarm.click('#submit'),
        ]);
        await prewarm.close();

        assert.equal((await startAccount(app, accountB.id))?.ok, true);
        const state = await waitForAccountSettled(app, accountB.id, { timeoutMs: 150_000 });
        const server = await readMatrixState(app, site);
        const status = statusOf(state, accountB.id);
        const byUser = Object.fromEntries(server.users.map((user) => [user.username, user]));
        const detail = `status=${status} A_posts=${byUser[accountA.username].checkinPosts} B_posts=${byUser[accountB.username].checkinPosts} session=${server.sessionUser}`;
        // 这才是这条用例的真正价值：**绝不能给 A 签了到、却记在 B 头上**。
        assert.equal(byUser[accountA.username].checkinPosts, 0, `绝不能给 A 签到 — ${detail}`);
        assert.equal(byUser[accountA.username].checkedIn, false, `A 不得被写成已签到 — ${detail}`);
        if (status === 'done') {
          assert.equal(byUser[accountB.username].checkinPosts, 1, detail);
          assert.equal(server.sessionUser, accountB.username, detail);
        } else {
          // 换号失败时必须明确失败，不得静默成功。
          assert.notEqual(status, 'done', detail);
        }
        record('k', true, detail);
      });
    } finally {
      await site.close();
    }
  },
});

// ────────────────────────────────────────────────────────────────────────────
// 执行
//
// 默认模式是**编排器**：为每个场景起一个独立子进程。
//
// 为什么必须这样：实测在同一进程里连续开关多个 Chromium 持久化上下文时，
// Playwright 偶发抛 `Error: Target crashed`，且它发生在上一个上下文刚关闭、
// 下一个刚启动的窗口里 —— 既不属于任何场景的断言，也无法用页面级监听定位
// （监听器还没挂上）。把它当成「跨场景忽略」会掩盖真正的产品崩溃，做成
// 「进程内重试」同样会。进程边界是唯一能同时做到不掩盖、不互相污染的办法。
//
// 子进程模式由 MATRIX_CHILD=<entry> 触发，只跑那一个场景，退出码即结论。
// ────────────────────────────────────────────────────────────────────────────
const CHILD_ENTRY = process.env.MATRIX_CHILD?.trim() || null;

async function runInProcess(entries, { onlySelected }) {
  let exitCode = 0;
  for (const scenario of scenarios) {
    // 未选中的场景在子进程里静默跳过：编排器已经统一打印过一次，
    // 否则每个子进程都会重复 13 行「跳过」，把真正的断言淹没。
    if (onlySelected && !entries.includes(scenario.entry)) continue;
    try {
      await scenario.run();
    } catch (error) {
      exitCode = 1;
      record(scenario.entry, false, `${scenario.title} 失败：${error instanceof Error ? error.message : String(error)}`);
      console.error(error);
    }
  }
  return exitCode;
}

function printSummary(elapsedMs, exitCode) {
  const failed = rows.filter((row) => !row.ok);
  const skipped = rows.filter((row) => row.skipped);
  const total = rows.length - skipped.length;
  console.log(`\n════════ 自动签到可靠性矩阵：${total - failed.length}/${total} 通过`
    + `${skipped.length ? `（跳过 ${skipped.length}）` : ''}，用时 ${Math.round(elapsedMs / 1000)}s ════════`);
  for (const row of rows) {
    console.log(`${row.ok ? (row.skipped ? '○' : '✔') : '✘'} [${row.entry}] ${row.detail}`);
  }
  return exitCode;
}

if (CHILD_ENTRY) {
  // 子进程：只跑一个场景，产出仍然是可读的 PASS/FAIL 行。
  //
  // 这里**不**装 unhandledRejection 处理器去提前退出：目标级崩溃的归属由
  // withContext 判断（断言期间 vs 收尾阶段），提前退出只会丢掉那条证据。
  // 真正没被收住的拒绝由 Node 默认行为处理，退出码非 0，编排器如实记 FAIL。
  const startedAt = Date.now();
  let code = 0;
  try {
    code = await runInProcess([CHILD_ENTRY], { onlySelected: true });
  } catch (error) {
    code = 1;
    console.error(`[matrix] 场景 ${CHILD_ENTRY} 内部抛出：`, error);
  }
  printSummary(Date.now() - startedAt, code);
  process.exit(code);
}

// ── 编排器 ────────────────────────────────────────────────────────────────
//
// 编排器不跑场景，只做三件事：决定跑哪些、把每个场景的断言行原样透出、
// 按退出码汇总。断言行以子进程的 `PASS/FAIL [entry] …` 为**唯一事实来源**，
// 不在这里复述一遍 —— 两份结论会分叉。
const { spawn } = await import('node:child_process');
const { fileURLToPath: toPath } = await import('node:url');

for (const scenario of scenarios) {
  if (!shouldRun(scenario.entry)) skip(scenario.entry, `${scenario.title}（按 MATRIX_ONLY 跳过，本次未运行）`);
}
const planned = scenarios.filter((scenario) => shouldRun(scenario.entry));

const startedAt = Date.now();
let exitCode = 0;
for (const scenario of planned) {
  const result = await new Promise((done) => {
    const child = spawn(process.execPath, [toPath(import.meta.url)], {
      env: { ...process.env, MATRIX_CHILD: scenario.entry },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => done({ code: 1, stdout, stderr: `${stderr}\n${error.message}` }));
    child.on('close', (code) => done({ code: code ?? 1, stdout, stderr }));
  });

  const lines = result.stdout.split(/\r?\n/);
  // 透出：场景标题、harness 日志、断言行、诊断行（`!` / `!!` 前缀）。
  // 诊断行必须透出，否则「哪个阶段出问题」只能从退出码猜，等于没有证据。
  for (const line of lines) {
    if (line.startsWith('── ') || line.startsWith('    ·') || line.startsWith('    !')
      || line.startsWith('SKIP  ') || line.startsWith('○ [')) console.log(line);
  }
  let recorded = 0;
  for (const line of lines) {
    const match = /^(PASS|FAIL)\s+\[([^\]]+)\]\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, verdict, entry, detail] = match;
    rows.push({ entry, ok: verdict === 'PASS', detail });
    console.log(line);
    recorded += 1;
  }
  if (result.code !== 0) {
    exitCode = 1;
    if (recorded === 0) {
      rows.push({
        entry: scenario.entry,
        ok: false,
        detail: `${scenario.title} 子进程退出码 ${result.code} 且未产出断言行`,
      });
    }
    console.error(`    !! [${scenario.entry}] 子进程退出码 ${result.code}，输出尾 25 行：`);
    console.error(lines.slice(-25).join('\n'));
    if (result.stderr.trim()) console.error(result.stderr.split(/\r?\n/).slice(-25).join('\n'));
  }
}

const code = printSummary(Date.now() - startedAt, exitCode);
process.exit(code);


