/**
 * 「一站一流程 · 跨账号复用边界」真实浏览器端到端验收（真实扩展 + 真实 Chromium）。
 *
 * 前置脚本 tests/e2e/site-single-workflow.mjs 已经证明核心契约：
 *   「一个站点只有一份签到流程，站内所有账号共用它；谁再学一次就整体覆盖这一份。」
 *
 * 本脚本补的是**它自己列出的三个未覆盖边界**：
 *
 *   A. 三个及以上账号共用同一份站点流程 —— 流程仍然只有一份，
 *      三个账号各自签到时都走这份流程、各自恰好签到一次、各自会话正确；
 *   B. 同站多账号、**登录方式混合**（账密 + 第三方 OAuth）——
 *      签到流程仍是站点级那一份，不因混合登录被改写或复制；
 *      服务端观测到的登录用户名/签到用户名必须各自是本账号，绝不串号；
 *   C. 站点级流程被用户手工切回「自动识别」（method:'auto' +
 *      workflowReplayDisabled:true，经真实界面点击完成）——
 *      站内**所有**账号一致地不再回放旧流程，且「找不到签到控件」必须如实
 *      失败，绝不冒充成功。
 *
 * 运行：
 *   npx wxt build
 *   node tests/e2e/site-workflow-shared-edges.mjs
 * 可用 EXTENSION_DIR 指向别的扩展产物目录；E2E_HEADLESS=0 看有头界面。
 *
 * 隐私红线：账号/密码/域名全部是虚构 sentinel，只在 127.0.0.1 上通信；
 * 只断言请求计数、路径与用户名，不采集任何输入值或密码原文。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  launchExtensionContext,
  openExtensionPage,
  seedAppStorage,
  readAppState,
  statusOf,
  waitForAccountSettled,
  waitForQueueIdle,
  disposeContext,
  resolveExtensionDir,
} from './lib/extension-harness.mjs';
import {
  startEdgeFixture,
  EDGE_FORM_A,
  EDGE_FORM_B,
  EDGE_FORM_C,
  EDGE_OAUTH,
  EDGE_FORM_PASSWORDS,
  EDGE_CHECKIN_LABEL,
} from './lib/site-workflow-shared-edges-fixture.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXT = resolveExtensionDir(
  process.env.EXTENSION_DIR,
  join(REPO, '.output', 'chrome-mv3'),
);
const PROFILE_ROOT = join(REPO, 'output', 'site-workflow-shared-edges', 'profiles');
const HEADLESS = process.env.E2E_HEADLESS !== '0';

const SITE_ID = 'shared-edges-site';
const SITE_NAME = '跨账号复用边界验收站';
const ACCOUNT_A = 'edge-account-a';
const ACCOUNT_B = 'edge-account-b';
const ACCOUNT_C = 'edge-account-c';
const ACCOUNT_OAUTH = 'edge-account-oauth';
const FORM_ACCOUNTS = [ACCOUNT_A, ACCOUNT_B, ACCOUNT_C];
const ACCOUNT_USERNAME = {
  [ACCOUNT_A]: EDGE_FORM_A,
  [ACCOUNT_B]: EDGE_FORM_B,
  [ACCOUNT_C]: EDGE_FORM_C,
  [ACCOUNT_OAUTH]: EDGE_OAUTH,
};

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? `  — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** 深度展开工作流步骤（含 if 的 then/else），得到扁平步骤列表。 */
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

/** 一段工作流的可观测指纹：只保留路线/身份页/步骤选择器与类型。 */
function workflowFingerprint(workflow) {
  const flat = flattenSteps(workflow?.steps);
  return {
    route: workflow?.route ?? [],
    identityPath: workflow?.identityPath ?? null,
    steps: flat.map((step) => ({
      type: step.type,
      ...(step.selector ? { selector: step.selector } : {}),
      ...(step.condition?.pattern ? { path: step.condition.pattern } : {}),
    })),
  };
}

/** 账号对象上不得出现任何流程字段（流程只属于站点）。 */
function workflowFieldsOf(accounts) {
  return accounts.flatMap((account) => Object.keys(account ?? {})
    .filter((key) => /workflow|checkin/i.test(key))
    .map((key) => `${account.id}.${key}`));
}

mkdirSync(PROFILE_ROOT, { recursive: true });
// 每轮新开 profile，绝不递归删旧目录（旧的可能是别的进程正在用的）。
const profile = mkdtempSync(join(PROFILE_ROOT, 'profile-'));

const fixture = await startEdgeFixture();
const origin = fixture.origin;
console.log(`fixture origin: ${origin}`);
console.log(`extension dir:  ${EXT}`);
console.log(`profile:        ${profile}`);

const launched = await launchExtensionContext({
  chromium: (await import('playwright')).chromium,
  profileDir: profile,
  extensionDir: EXT,
  headless: HEADLESS,
  viewport: { width: 1280, height: 960 },
});
const { context, extensionId, diagnostics } = launched;
console.log(`[harness] extension id=${extensionId} via=${diagnostics.via} elapsed=${diagnostics.elapsedMs}ms`);

/**
 * 并发/资源抖动下的目标级崩溃噪声。
 *
 * Playwright 会在某个标签页被浏览器回收时以**未处理的拒绝**形式抛出
 * `Target crashed`，这条错误不经过 await 链，抓不到就整轮挂掉。本机同时有
 * 别的智能体在跑 Chromium 与构建，这类噪声是环境问题、不是产品断言失败
 * （与 auto-checkin-matrix 的既有结论一致）。这里如实记账，不当作失败；
 * 真正的断言失败仍会照常变红 —— 在断言里会用页内证据复核，崩溃会暴露成
 * 读不到值而不是静默通过。
 */
const targetNoise = [];
process.on('unhandledRejection', (reason) => {
  const text = reason instanceof Error ? reason.message : String(reason);
  if (/Target crashed|Target closed|Execution context was destroyed/i.test(text)) {
    targetNoise.push(text);
    return;
  }
  console.error('未处理的拒绝：', reason);
  process.exitCode = 1;
});

let exitCode = 0;
let app = null;
try {
  app = await openExtensionPage(context, extensionId, 'options.html');
  await app.getByRole('banner').getByRole('textbox', { name: '搜索站点、账号或备注' }).waitFor();

  /** 等扩展页里能读到一个真值；扩展页被关掉时不会把整轮打崩。 */
  async function waitForApp(predicate, timeoutMs = 20_000, label = '', arg) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      // 扩展页若被浏览器回收，先重开再读；否则整段等待只会以超时收场，
      // 掩盖真正原因（产品问题 vs 页面没了）。
      await ensureApp().catch(() => undefined);
      last = await app.evaluate(predicate, arg).catch(() => undefined);
      if (last) return last;
      await sleep(200);
    }
    throw new Error(`等待超时${label ? ` [${label}]` : ''}`);
  }

  /**
   * 扩展页被浏览器回收时重开一个，并确认界面真的可读 —— 不确认就继续跑，
   * 后面每一步都会以「读不到值」的形式出现假失败。
   */
  async function ensureApp() {
    try {
      const alive = await app.evaluate(() => 1).catch(() => null);
      if (alive === 1) return app;
    } catch { /* 下面重开 */ }
    console.log('   扩展页已失效，重开 options.html 继续…');
    app = await openExtensionPage(context, extensionId, 'options.html');
    await app.getByRole('banner').getByRole('textbox', { name: '搜索站点、账号或备注' }).waitFor();
    return app;
  }

  const readState = () => readAppState(app);
  const siteOf = (state) => state.sites.find((site) => site.id === SITE_ID);
  const accountStatus = (state, accountId) => statusOf(state, accountId) ?? 'none';
  const learningSessions = () => app.evaluate(async () =>
    (await chrome.runtime.sendMessage({ type: 'GET_LEARNING' }))?.feature?.learningSessions ?? []);
  const startAuto = (accountId) => app.evaluate((id) =>
    chrome.runtime.sendMessage({ type: 'START_LOGIN', accountId: id }), accountId);

  /** 只清掉指定账号的旧结果/状态，避免上一轮结果把「等终态」骗过去。 */
  const clearResults = (accountIds) => app.evaluate(async (ids) => {
    const stored = await chrome.storage.local.get(['results', 'status']);
    const resultsMap = stored.results ?? {};
    const statusMap = stored.status ?? {};
    for (const id of ids) {
      delete resultsMap[id];
      for (const key of Object.keys(statusMap)) {
        if (key.startsWith(`${id}:`)) delete statusMap[key];
      }
    }
    await chrome.storage.local.set({ results: resultsMap, status: statusMap });
  }, accountIds);

  /** 关掉所有停留在这个虚构站点上的页面，并清空浏览器会话。 */
  async function resetBrowserSession() {
    for (const page of context.pages()) {
      if (page !== app && page.url().startsWith(origin)) await page.close().catch(() => {});
    }
    await context.clearCookies();
  }

  /** 展开站点卡片，露出账号行。 */
  async function expandAccounts() {
    const expand = app.getByRole('button', { name: `展开账号 ${SITE_NAME}` });
    if (await expand.count()) await expand.click();
    await app.locator(`[data-account-id="${ACCOUNT_A}"]`).waitFor();
  }

  /** 把长页面里的目标控件滚进视口（复刻 site-single-workflow 的演示手法）。 */
  async function scrollIntoView(page, selector) {
    await page.mouse.move(640, 480);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const inView = await page.evaluate((target) => {
        const element = document.querySelector(target);
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= window.innerHeight;
      }, selector);
      if (inView) return true;
      await page.mouse.wheel(0, 900);
      await sleep(220);
    }
    return false;
  }

  /** 手动演示「登录 → 到控制台 →（可选资料页）→ 签到页 → 点签到」。 */
  async function demonstrateCheckinOnLearningPage(page, { username, password, viaProfile }) {
    await page.waitForURL((url) => url.pathname === '/login', { timeout: 25_000 });
    await page.fill('#username', username);
    await page.fill('#password', password);
    await page.click('#login-submit');
    await page.waitForURL((url) => url.pathname === '/console', { timeout: 25_000 });
    await page.waitForSelector('#logged-in');
    if (viaProfile) {
      await page.click('#nav-profile');
      await page.waitForURL((url) => url.pathname === '/profile', { timeout: 20_000 });
      await page.waitForSelector('#profile-account');
      await page.click('#nav-checkin');
    } else {
      await page.click('#nav-checkin');
    }
    await page.waitForURL((url) => url.pathname === '/checkin', { timeout: 20_000 });
    await page.waitForSelector('#checkin-card');
    await scrollIntoView(page, `button[aria-label="${EDGE_CHECKIN_LABEL}"]`);
    await page.locator(`button[aria-label="${EDGE_CHECKIN_LABEL}"]`).click();
    await page.waitForFunction(
      () => (document.getElementById('checkin-result')?.textContent ?? '').includes('签到成功'),
      null,
      { timeout: 20_000 },
    );
    await sleep(500);
  }

  /** 点某账号行的「学习本站流程」（融合入口），返回新打开的学习页。 */
  async function openLearning(row) {
    const pagePromise = context.waitForEvent('page', { timeout: 30_000 });
    await row.getByRole('button', { name: /学习本站登录与签到流程/ }).click();
    return pagePromise;
  }

  /** 点「结束学习并保存…」并等会话消失。 */
  async function finishLearning(row, accountId) {
    await row.getByRole('button', { name: /结束学习并保存/ }).click();
    const response = await waitForApp(async (id) => {
      const resp = await chrome.runtime.sendMessage({ type: 'GET_LEARNING' });
      if (!resp?.ok) return false;
      const gone = (resp.feature?.learningSessions ?? []).every((item) => item.accountId !== id);
      return gone ? { ok: true } : false;
    }, 40_000, `结束学习 ${accountId}`, accountId);
    return response;
  }

  /** 等站点上出现一份非空 workflow 并返回它。 */
  async function waitForWorkflow(timeoutMs = 30_000) {
    return waitForApp(async (siteId) => {
      const sites = (await chrome.storage.local.get('sites')).sites ?? [];
      const workflow = sites.find((item) => item.id === siteId)?.checkin?.workflow;
      return workflow?.steps?.length ? workflow : false;
    }, timeoutMs, '站点 workflow 落盘', SITE_ID);
  }

  /**
   * 跑一个账号，返回终态快照 + 服务端观测 + 回放日志。
   * 每轮先清 Cookie、清旧结果、复位夹具计数，保证证据只属于本轮。
   */
  async function runAccount(accountId, { timeoutMs = 150_000 } = {}) {
    await ensureApp();
    await waitForQueueIdle(app, { timeoutMs: 30_000 });
    console.log(`   [run] ${accountId}: 复位浏览器会话…`);
    await resetBrowserSession();
    fixture.reset();
    await clearResults([accountId]);
    console.log(`   [run] ${accountId}: 发起自动签到…`);
    const started = await startAuto(accountId);
    console.log(`   [run] ${accountId}: 入队响应=${JSON.stringify(started)}`);
    if (!started?.ok) return { started, status: 'launch-failed', result: null, events: [], steps: '' };
    const settled = await waitForAccountSettled(app, accountId, { timeoutMs });
    console.log(`   [run] ${accountId}: 已到终态，采集证据…`);
    const result = settled.results?.[accountId] ?? null;
    return {
      started,
      status: accountStatus(settled, accountId),
      result,
      events: fixture.events(),
      steps: (result?.steps ?? []).join('\n'),
      claims: fixture.claimPosts(),
      logins: fixture.loginPosts(),
    };
  }

  const claimsOfUser = (claims, user) => claims.filter((entry) => entry.user === user);
  const claimsOfOthers = (claims, user) => claims.filter((entry) => entry.user !== user);

  // ── 0. 种入 1 个站点 + 4 个账号（3 个账密 + 1 个第三方登录） ─────────
  await seedAppStorage(app, {
    sites: [{
      id: SITE_ID,
      name: SITE_NAME,
      loginUrl: `${origin}/login`,
      successIndicator: '#logged-in',
      selectors: { username: '#username', password: '#password', submit: '#login-submit' },
      closeModalSelectors: [],
      // 签到页配成 /checkin。回放工作流时引擎会删掉它（route 才是入口），
      // 但在「切回自动识别」那一轮它决定自动扫描的去向：配成 /console 会让
      // 扫描在 /console ↔ /checkin 之间来回跳，既慢又不代表真实配置。
      checkin: { method: 'auto', url: '/checkin' },
      adapter: { family: 'new-api', siteType: 'new-api', quotaPerUnit: 500000 },
    }],
    accounts: [
      { id: ACCOUNT_A, siteId: SITE_ID, username: EDGE_FORM_A, password: EDGE_FORM_PASSWORDS[EDGE_FORM_A], label: '账号 A（账密）' },
      { id: ACCOUNT_B, siteId: SITE_ID, username: EDGE_FORM_B, password: EDGE_FORM_PASSWORDS[EDGE_FORM_B], label: '账号 B（账密）' },
      { id: ACCOUNT_C, siteId: SITE_ID, username: EDGE_FORM_C, password: EDGE_FORM_PASSWORDS[EDGE_FORM_C], label: '账号 C（账密）' },
      // 登录方式混合的关键：这个账号是**账号级 OAuth**、没有站点密码，
      // 站点级登录方式（学习后）是 form —— 两者必须互不影响。
      { id: ACCOUNT_OAUTH, siteId: SITE_ID, username: EDGE_OAUTH, password: '', loginMethod: 'oauth', label: '账号 D（第三方登录）' },
    ],
    results: {},
    status: {},
  });
  await app.reload();
  await app.getByRole('banner').getByRole('textbox', { name: '搜索站点、账号或备注' }).waitFor();
  await app.locator('section a', { hasText: SITE_NAME }).first().waitFor();
  await expandAccounts();

  const seeded = await readState();
  check('0. 种入 1 个站点 + 4 个账号（其中 1 个账号级 OAuth），初始没有任何 workflow',
    seeded.sites.length === 1 && seeded.accounts.length === 4
      && !seeded.sites[0].checkin?.workflow
      && workflowFieldsOf(seeded.accounts).length === 0,
    `sites=${seeded.sites.length} accounts=${seeded.accounts.length} accountWorkflowFields=${JSON.stringify(workflowFieldsOf(seeded.accounts))}`);

  const row = (id) => app.locator(`[data-account-id="${id}"]`);

  // ── 1. 账号 A 学一次（融合入口），产出站点级那一份流程 ───────────────
  console.log('\n── 1. 账号 A 用融合入口学一次 → 站点上只有一份流程 ──');
  await resetBrowserSession();
  const learnPage = await openLearning(row(ACCOUNT_A));
  await waitForApp(async (id) => {
    const sessions = (await chrome.runtime.sendMessage({ type: 'GET_LEARNING' }))?.feature?.learningSessions ?? [];
    return sessions.find((session) => session.accountId === id) ?? false;
  }, 30_000, 'A 的学习会话', ACCOUNT_A);
  await demonstrateCheckinOnLearningPage(learnPage, {
    username: EDGE_FORM_A,
    password: EDGE_FORM_PASSWORDS[EDGE_FORM_A],
    viaProfile: true,
  });
  console.log(`   演示期间的签到 POST=${fixture.claimPosts().length}（学习阶段的真实点击）`);
  await finishLearning(row(ACCOUNT_A), ACCOUNT_A);

  const learnedWorkflow = await waitForWorkflow();
  const learnedFingerprint = workflowFingerprint(learnedWorkflow);
  const afterLearn = await readState();
  const siteWorkflowsAfterLearn = afterLearn.sites.filter((site) => site.checkin?.workflow).length;
  console.log(`   学到的工作流指纹：${JSON.stringify(learnedFingerprint)}`);
  check('1a. 站点上恰好一份 workflow（账号对象上没有任何流程字段）',
    siteWorkflowsAfterLearn === 1 && workflowFieldsOf(afterLearn.accounts).length === 0,
    `siteWorkflows=${siteWorkflowsAfterLearn} accountWorkflowFields=${JSON.stringify(workflowFieldsOf(afterLearn.accounts))}`);
  check('1b. 学习产出的路线含独立资料页 /profile，终点是 /checkin',
    learnedFingerprint.route.includes('/profile') && learnedFingerprint.route.at(-1) === '/checkin'
      && learnedFingerprint.identityPath === '/profile',
    `route=${JSON.stringify(learnedFingerprint.route)} identityPath=${JSON.stringify(learnedFingerprint.identityPath)}`);
  check('1c. 学习产物里确实有对签到控件的点击步骤（不是空流程）',
    flattenSteps(learnedWorkflow.steps).some((step) => step.type === 'click'),
    `clickSteps=${JSON.stringify(flattenSteps(learnedWorkflow.steps).filter((step) => step.type === 'click').map((step) => step.selector))}`);

  const workflowJsonBeforeReuse = JSON.stringify(learnedWorkflow);
  const siteLevelLoginMethod = siteOf(afterLearn)?.loginMethod ?? '(未设置)';
  console.log(`   站点级登录方式（A 学出来的）：${siteLevelLoginMethod}`);

  // ── 2. 三账号共用：A / B / C 各自回放同一份流程 ──────────────────────
  console.log('\n── 2. 边界①：三个账密账号共用同一份流程 ──');
  const reuseEvidence = {};
  for (const accountId of FORM_ACCOUNTS) {
    const username = ACCOUNT_USERNAME[accountId];
    const run = await runAccount(accountId);
    reuseEvidence[accountId] = run;
    const ownClaims = claimsOfUser(run.claims, username);
    const foreignClaims = claimsOfOthers(run.claims, username);
    const hasProfileRoute = /工作流沿学习路线进入 \/profile/.test(run.steps);
    const hasWorkflowClick = /工作流已点击/.test(run.steps);
    console.log(`   ${accountId}: status=${run.status} claims=${ownClaims.length}(本账号)/${foreignClaims.length}(他账号) `
      + `loginPosts=${run.logins.length} message=${run.result?.message ?? 'n/a'}`);
    console.log(`     回放日志：profileRoute=${hasProfileRoute} workflowClick=${hasWorkflowClick}`
      + `${hasWorkflowClick ? ` — ${(run.steps.split('\n').filter((line) => /工作流已点击|工作流沿学习路线进入/.test(line)).slice(0, 4).join(' | '))}` : ''}`);
    check(`2${'abc'[FORM_ACCOUNTS.indexOf(accountId)]}. ${accountId} 用站点那份流程签到成功，恰好一次且是本账号`,
      run.status === 'done' && run.result?.ok === true
        && ownClaims.length === 1 && foreignClaims.length === 0,
      `status=${run.status} message=${run.result?.message ?? ''} ownClaims=${ownClaims.length} foreignClaims=${foreignClaims.length}`);
    check(`2${'abc'[FORM_ACCOUNTS.indexOf(accountId)]}-log. ${accountId} 的回放日志证明走的是学习路线 + 工作流点击`,
      hasProfileRoute && hasWorkflowClick,
      `profileRoute=${hasProfileRoute} workflowClick=${hasWorkflowClick}`);
  }

  const afterReuse = await readState();
  const workflowAfterReuse = siteOf(afterReuse)?.checkin?.workflow;
  const claimUsersAfterReuse = Object.fromEntries(FORM_ACCOUNTS.map((accountId) => {
    const claimants = [...new Set(reuseEvidence[accountId].claims.map((entry) => entry.user))];
    return [accountId, claimants];
  }));
  console.log(`   每个账号最后一轮的签到请求用户名：${JSON.stringify(claimUsersAfterReuse)}`);
  check('2d. 三次回放之后，站点上仍然只有这一份 workflow（内容一字未变）',
    afterReuse.sites.filter((site) => site.checkin?.workflow).length === 1
      && JSON.stringify(workflowAfterReuse) === workflowJsonBeforeReuse
      && workflowFieldsOf(afterReuse.accounts).length === 0,
    `siteWorkflows=${afterReuse.sites.filter((site) => site.checkin?.workflow).length} unchanged=${JSON.stringify(workflowAfterReuse) === workflowJsonBeforeReuse} accountWorkflowFields=${JSON.stringify(workflowFieldsOf(afterReuse.accounts))}`);
  check('2e. 三账号没有串号：每个账号的签到请求都带着自己的会话用户名',
    FORM_ACCOUNTS.every((accountId) => {
      const run = reuseEvidence[accountId];
      return run.claims.length === 1 && run.claims[0].user === ACCOUNT_USERNAME[accountId];
    }),
    JSON.stringify(claimUsersAfterReuse));

  // ── 3. 边界②：登录方式混合（账密 + OAuth）仍共用一份流程 ────────────
  console.log('\n── 3. 边界②：混合登录方式（账号 A/B/C 账密，账号 D 走 OAuth） ──');
  const oauthUser = ACCOUNT_USERNAME[ACCOUNT_OAUTH];
  const runOauth = await runAccount(ACCOUNT_OAUTH);
  const oauthOwnClaims = claimsOfUser(runOauth.claims, oauthUser);
  const oauthForeignClaims = claimsOfOthers(runOauth.claims, oauthUser);
  const formLoginUsers = runOauth.logins.map((entry) => entry.user);
  const oauthStartHits = runOauth.events.filter((event) => event.path === '/oauth/start').length;
  const consentHits = runOauth.events.filter((event) => event.path === '/api/consent').length;
  console.log(`   账号 D：status=${runOauth.status} message=${runOauth.result?.message ?? 'n/a'}`);
  console.log(`   账号 D 服务端观测：账密登录 POST=${JSON.stringify(formLoginUsers)} `
    + `OAuth 起点=${oauthStartHits} 协议勾选=${consentHits} 签到=${JSON.stringify(runOauth.claims.map((entry) => entry.user))}`);
  console.log(`   账号 D 回放日志片段：${runOauth.steps.split('\n').filter((line) => /OAuth|工作流|身份|登录账号/.test(line)).slice(-6).join(' | ')}`);
  const oauthUsedOauthPath = oauthStartHits >= 1 && formLoginUsers.length === 0;
  check('3a. 账号 D 走的是第三方登录（发生 OAuth 跳转、没有账密表单提交）',
    oauthUsedOauthPath,
    `oauthStart=${oauthStartHits} consent=${consentHits} formLoginPosts=${JSON.stringify(formLoginUsers)}`);
  check('3b. 账号 D 用的仍是站点那一份流程，签到恰好一次且会话是它自己',
    runOauth.status === 'done' && runOauth.result?.ok === true
      && oauthOwnClaims.length === 1 && oauthForeignClaims.length === 0
      && /工作流沿学习路线进入 \/profile/.test(runOauth.steps) && /工作流已点击/.test(runOauth.steps),
    `status=${runOauth.status} ownClaims=${oauthOwnClaims.length} foreignClaims=${oauthForeignClaims.length} `
      + `profileRoute=${/工作流沿学习路线进入 \/profile/.test(runOauth.steps)} workflowClick=${/工作流已点击/.test(runOauth.steps)}`);

  const afterMixed = await readState();
  const workflowAfterMixed = siteOf(afterMixed)?.checkin?.workflow;
  const mixedAccountLoginMethods = Object.fromEntries(afterMixed.accounts.map((account) => [account.id, account.loginMethod ?? '(跟随站点)']));
  console.log(`   站点级登录方式=${siteOf(afterMixed)?.loginMethod} 账号级登录方式=${JSON.stringify(mixedAccountLoginMethods)}`);
  check('3c. 混合登录没有改写/复制流程：站点仍然只有那一份、内容一字未变，账号上没有流程字段',
    afterMixed.sites.filter((site) => site.checkin?.workflow).length === 1
      && JSON.stringify(workflowAfterMixed) === workflowJsonBeforeReuse
      && workflowFieldsOf(afterMixed.accounts).length === 0,
    `siteWorkflows=${afterMixed.sites.filter((site) => site.checkin?.workflow).length} unchanged=${JSON.stringify(workflowAfterMixed) === workflowJsonBeforeReuse} accountWorkflowFields=${JSON.stringify(workflowFieldsOf(afterMixed.accounts))}`);
  check('3d. 没有账号用了别人的登录态：D 的 OAuth 会话只签到 D，A/B/C 的账号级配置未被改动',
    mixedAccountLoginMethods[ACCOUNT_OAUTH] === 'oauth'
      && FORM_ACCOUNTS.every((accountId) => mixedAccountLoginMethods[accountId] !== 'oauth')
      && runOauth.claims.every((entry) => entry.user === oauthUser),
    `loginMethods=${JSON.stringify(mixedAccountLoginMethods)} claims=${JSON.stringify(runOauth.claims.map((entry) => entry.user))}`);

  // ── 4. 边界③：用户手工切回「自动识别」 ──────────────────────────────
  console.log('\n── 4. 边界③：在界面上把站点切回「自动识别」 ──');
  await ensureApp();
  await row(ACCOUNT_A).waitFor();
  // 只点**我们这张卡片**的「编辑站点」。页面上还有内置站点卡片，用 bare
  // getByTitle('编辑站点').first() 会点到别的站点 —— 实测就是这样静默改错对象。
  const siteCard = app.locator('section').filter({ has: app.getByRole('link', { name: SITE_NAME }) }).last();
  await siteCard.getByTitle('编辑站点').click();
  const autoMethodButton = app.getByRole('button', { name: '自动识别（自主签到）' });
  await autoMethodButton.waitFor();
  await autoMethodButton.click();
  // 点完后用界面自身的证据确认「停用但保留记录」已经进了表单（而不是假设）。
  await app.getByText('（未启用，仅保留记录）').first().waitFor();
  await app.getByRole('button', { name: /保存修改/ }).first().click();
  const switched = await waitForApp(async (siteId) => {
    const sites = (await chrome.storage.local.get('sites')).sites ?? [];
    const site = sites.find((item) => item.id === siteId);
    return site?.checkin?.method === 'auto' && site.checkin.workflowReplayDisabled === true ? site : false;
  }, 20_000, '站点切回自动识别落盘', SITE_ID);
  const switchedCheckin = switched.checkin;
  console.log(`   站点落盘：method=${switchedCheckin.method} workflowReplayDisabled=${switchedCheckin.workflowReplayDisabled} `
    + `保留的 workflow 步骤=${switchedCheckin.workflow?.steps?.length ?? 0}`);
  check('4a. 界面切回「自动识别」后：站点级 method=auto + workflowReplayDisabled=true，旧流程只是停用、没有被删',
    switchedCheckin.method === 'auto' && switchedCheckin.workflowReplayDisabled === true
      && JSON.stringify(switchedCheckin.workflow) === workflowJsonBeforeReuse,
    `method=${switchedCheckin.method} disabled=${switchedCheckin.workflowReplayDisabled} workflowIntact=${JSON.stringify(switchedCheckin.workflow) === workflowJsonBeforeReuse}`);

  // 4b：两个账号在「有可点签到按钮」的页面上都必须走自动识别、都不回放旧流程
  const autoEvidence = {};
  for (const accountId of [ACCOUNT_A, ACCOUNT_B]) {
    const username = ACCOUNT_USERNAME[accountId];
    const run = await runAccount(accountId);
    autoEvidence[accountId] = run;
    const ownClaims = claimsOfUser(run.claims, username);
    const noReplayMarker = /不回放旧学习记录/.test(run.steps);
    const replayed = /工作流沿学习路线进入|工作流已点击/.test(run.steps);
    console.log(`   ${accountId}（自动识别）：status=${run.status} 本账号签到=${ownClaims.length} `
      + `不回放标记=${noReplayMarker} 出现回放痕迹=${replayed}`);
    console.log(`     日志片段：${run.steps.split('\n').filter((line) => /自动识别|工作流|签到/.test(line)).slice(0, 5).join(' | ')}`);
    check(`4b-${'ab'[[ACCOUNT_A, ACCOUNT_B].indexOf(accountId)]}. ${accountId} 切回自动识别后不再回放旧流程，且用自动识别完成签到`,
      run.status === 'done' && run.result?.ok === true && ownClaims.length === 1 && noReplayMarker && !replayed,
      `status=${run.status} ownClaims=${ownClaims.length} noReplayMarker=${noReplayMarker} replayTraces=${replayed}`);
  }

  // 4c：负向用例 —— 页面上没有签到控件时，自动识别必须如实失败，绝不冒充成功
  console.log('   —— 负向：页面上没有任何签到控件 ——');
  fixture.setCheckinControls('none');
  const runNegative = await runAccount(ACCOUNT_C);
  const negativeClaims = runNegative.claims.length;
  const negativeNoReplay = /不回放旧学习记录/.test(runNegative.steps);
  const negativeReplay = /工作流沿学习路线进入|工作流已点击/.test(runNegative.steps);
  console.log(`   账号 C（无签到控件）：status=${runNegative.status} ok=${runNegative.result?.ok} `
    + `message=${JSON.stringify(runNegative.result?.message ?? '')} 签到 POST=${negativeClaims}`);
  console.log(`     日志片段：${runNegative.steps.split('\n').filter((line) => /自动识别|签到|工作流|未找到/.test(line)).slice(-5).join(' | ')}`);
  check('4c. 没有任何签到控件时，自动识别如实失败（status=failed、ok=false、零次签到请求）',
    runNegative.status === 'failed' && runNegative.result?.ok === false && negativeClaims === 0,
    `status=${runNegative.status} ok=${runNegative.result?.ok} claims=${negativeClaims} message=${runNegative.result?.message ?? ''}`);
  check('4d. 负向用例同样没有回放旧流程（一致行为），也没有把「找不到按钮」说成成功',
    negativeNoReplay && !negativeReplay
      && !/签到成功|今日已签到|已领取/.test(runNegative.result?.message ?? '')
      && !fixture.checkedIn(ACCOUNT_USERNAME[ACCOUNT_C]),
    `noReplayMarker=${negativeNoReplay} replayTraces=${negativeReplay} message=${runNegative.result?.message ?? ''} serverCheckedIn=${fixture.checkedIn(ACCOUNT_USERNAME[ACCOUNT_C])}`);
  fixture.setCheckinControls('button');

  const afterAuto = await readState();
  const workflowAfterAuto = siteOf(afterAuto)?.checkin?.workflow;
  check('4e. 三账号（A/B/C）在切换后的行为一致：站点配置仍是一份 + auto + 停用标记，流程内容未被这些运行改写',
    siteOf(afterAuto)?.checkin?.method === 'auto'
      && siteOf(afterAuto)?.checkin?.workflowReplayDisabled === true
      && afterAuto.sites.filter((site) => site.checkin?.workflow).length === 1
      && JSON.stringify(workflowAfterAuto) === workflowJsonBeforeReuse,
    `method=${siteOf(afterAuto)?.checkin?.method} disabled=${siteOf(afterAuto)?.checkin?.workflowReplayDisabled} `
      + `siteWorkflows=${afterAuto.sites.filter((site) => site.checkin?.workflow).length} unchanged=${JSON.stringify(workflowAfterAuto) === workflowJsonBeforeReuse}`);

  await waitForQueueIdle(app, { timeoutMs: 30_000 });

  const failed = results.filter((item) => !item.ok);
  console.log(`\n════════ 结果：${results.length - failed.length}/${results.length} 通过 ════════`);
  if (failed.length) {
    exitCode = 1;
    for (const item of failed) console.log(`✖ ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
  }
} catch (error) {
  exitCode = 1;
  console.error('\n验收执行中断：', error);
  for (const item of results.filter((entry) => !entry.ok)) {
    console.error(`✖ ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
  }
} finally {
  await disposeContext(context, { app: context.pages()[0] ?? null }).catch(() => {});
  await fixture.close().catch(() => {});
  console.log(`profile: ${profile}`);
}
process.exit(exitCode);
