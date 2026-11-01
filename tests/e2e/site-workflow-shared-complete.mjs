/**
 * 「一站一流程」补全验收（真实扩展 + 真实 Chromium）。
 *
 * 前两个脚本（site-single-workflow / site-workflow-shared-edges）证明了核心契约。
 * 本脚本补齐之前列为「已知缺口」的三件事：
 *
 *   A. 演示时点了**印着自己名字的头像菜单**：学出的流程里不能出现演示账号的名字，
 *      别的账号（页面上印的是自己的名字）照样能回放、签到恰好一次且是本账号；
 *   B. 用**第三方登录账号**演示学习：站点默认登录方式被改成 OAuth 时，原来「跟随
 *      站点」的账密账号被固定为账密，之后仍按账密登录签到；
 *   C. 同一域名被导入成**两张站点卡**：只在第一张上学过，第二张卡下的账号也直接
 *      回放这份流程；第二张卡自己没有被写入任何流程字段。第二张卡是书签导入的空白
 *      形态（没有登录成功标志、没有站点系统），运行时从第一张卡借用，同样不写回。
 *
 * 运行：
 *   npx wxt build
 *   node tests/e2e/site-workflow-shared-complete.mjs
 *
 * 隐私红线：账号/密码/域名全部是虚构 sentinel，只在 127.0.0.1 上通信。
 */
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
  EDGE_SSO_BUTTON_CSS,
  EDGE_CHECKIN_LABEL,
} from './lib/site-workflow-shared-edges-fixture.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXT = resolveExtensionDir(process.env.EXTENSION_DIR, join(REPO, '.output', 'chrome-mv3'));
const PROFILE_ROOT = join(REPO, 'output', 'site-workflow-shared-complete', 'profiles');
const HEADLESS = process.env.E2E_HEADLESS !== '0';

const SITE_ID = 'shared-complete-site';
const SITE_NAME = '一站一流程补全验收站';
const DUP_SITE_ID = 'shared-complete-dup';
const DUP_SITE_NAME = '一站一流程补全验收站（重复导入）';
const ACCOUNT_A = 'complete-account-a';
const ACCOUNT_B = 'complete-account-b';
const ACCOUNT_OAUTH = 'complete-account-oauth';
const ACCOUNT_DUP = 'complete-account-dup';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? `  — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

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

mkdirSync(PROFILE_ROOT, { recursive: true });
const profile = mkdtempSync(join(PROFILE_ROOT, 'profile-'));
const fixture = await startEdgeFixture();
const origin = fixture.origin;
console.log(`fixture origin: ${origin}`);
console.log(`extension dir:  ${EXT}`);

const { context, extensionId } = await launchExtensionContext({
  chromium: (await import('playwright')).chromium,
  profileDir: profile,
  extensionDir: EXT,
  headless: HEADLESS,
  viewport: { width: 1280, height: 960 },
});

process.on('unhandledRejection', (reason) => {
  const text = reason instanceof Error ? reason.message : String(reason);
  if (/Target crashed|Target closed|Execution context was destroyed/i.test(text)) return;
  console.error('未处理的拒绝：', reason);
  process.exitCode = 1;
});

let exitCode = 0;
let app = null;
try {
  app = await openExtensionPage(context, extensionId, 'options.html');
  const searchBox = () => app.getByRole('banner').getByRole('textbox', { name: '搜索站点、账号或备注' });
  await searchBox().waitFor();

  async function waitForApp(predicate, timeoutMs, label, arg) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await app.evaluate(predicate, arg).catch(() => undefined);
      if (value) return value;
      await sleep(200);
    }
    throw new Error(`等待超时 [${label}]`);
  }

  async function resetBrowserSession() {
    for (const page of context.pages()) {
      if (page !== app && page.url().startsWith(origin)) await page.close().catch(() => {});
    }
    await context.clearCookies();
  }

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

  /** 演示：登录 → 控制台 →（点头像菜单 → 我的资料）→ 签到页 → 点签到。 */
  async function demonstrate(page, { login }) {
    await page.waitForURL((url) => url.pathname === '/login', { timeout: 25_000 });
    await login(page);
    await page.waitForURL((url) => url.pathname === '/console', { timeout: 25_000 });
    await page.waitForSelector('#logged-in');
    await page.click('.avatar-menu');
    await page.waitForSelector('.menu-profile', { state: 'visible' });
    await page.click('.menu-profile');
    await page.waitForURL((url) => url.pathname === '/profile', { timeout: 20_000 });
    await page.waitForSelector('#profile-account');
    await page.click('#nav-checkin');
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

  const formLogin = (username) => async (page) => {
    await page.fill('#username', username);
    await page.fill('#password', EDGE_FORM_PASSWORDS[username]);
    await page.click('#login-submit');
  };
  const oauthLogin = async (page) => {
    await page.check('#agree-terms');
    await page.locator(EDGE_SSO_BUTTON_CSS).click();
  };

  /** 通过后台消息开始/结束学习（与界面按钮走同一个入口）。 */
  async function learnAs(accountId, login) {
    await waitForQueueIdle(app, { timeoutMs: 30_000 });
    await resetBrowserSession();
    const pagePromise = context.waitForEvent('page', { timeout: 30_000 });
    const started = await app.evaluate((id) => chrome.runtime.sendMessage({ type: 'TOGGLE_LEARNING', accountId: id, kind: 'both' }), accountId);
    if (!started?.ok) throw new Error(`开始学习失败：${JSON.stringify(started)}`);
    const tabId = started.feature?.learning?.tabId;
    // 学习会沿用已经停在本站的标签页；没有新开页面时按 tabId 找回它。
    const page = await pagePromise.catch(async () => {
      for (const candidate of context.pages()) {
        if (candidate === app) continue;
        const id = await app.evaluate((url) => chrome.tabs.query({}).then((tabs) => tabs.find((tab) => tab.url === url)?.id), candidate.url()).catch(() => undefined);
        if (id === tabId) return candidate;
      }
      throw new Error(`学习页面未出现（tabId=${tabId}）`);
    });
    if (!page.url().endsWith('/login')) await page.goto(`${origin}/login`);
    await demonstrate(page, { login });
    const finished = await app.evaluate((id) => chrome.runtime.sendMessage({ type: 'TOGGLE_LEARNING', accountId: id, kind: 'both' }), accountId);
    return finished;
  }

  async function runAccount(accountId) {
    await waitForQueueIdle(app, { timeoutMs: 30_000 });
    await resetBrowserSession();
    fixture.reset();
    await app.evaluate(async (id) => {
      const stored = await chrome.storage.local.get(['results', 'status']);
      const resultsMap = stored.results ?? {};
      const statusMap = stored.status ?? {};
      delete resultsMap[id];
      for (const key of Object.keys(statusMap)) if (key.startsWith(`${id}:`)) delete statusMap[key];
      await chrome.storage.local.set({ results: resultsMap, status: statusMap });
    }, accountId);
    const started = await app.evaluate((id) => chrome.runtime.sendMessage({ type: 'START_LOGIN', accountId: id }), accountId);
    if (!started?.ok) return { started, status: 'launch-failed', result: null, steps: '', claims: [], logins: [] };
    const settled = await waitForAccountSettled(app, accountId, { timeoutMs: 150_000 });
    const result = settled.results?.[accountId] ?? null;
    return {
      started,
      status: statusOf(settled, accountId) ?? 'none',
      result,
      steps: (result?.steps ?? []).join('\n'),
      claims: fixture.claimPosts(),
      logins: fixture.loginPosts(),
      events: fixture.events(),
    };
  }

  const baseSite = (id, name) => ({
    id,
    name,
    loginUrl: `${origin}/login`,
    successIndicator: '#logged-in',
    selectors: { username: '#username', password: '#password', submit: '#login-submit' },
    closeModalSelectors: [],
    checkin: { method: 'auto', url: '/checkin' },
    adapter: { family: 'new-api', siteType: 'new-api', quotaPerUnit: 500000 },
  });

  await seedAppStorage(app, {
    sites: [baseSite(SITE_ID, SITE_NAME)],
    accounts: [
      { id: ACCOUNT_A, siteId: SITE_ID, username: EDGE_FORM_A, password: EDGE_FORM_PASSWORDS[EDGE_FORM_A], label: '账号 A（账密）' },
      { id: ACCOUNT_B, siteId: SITE_ID, username: EDGE_FORM_B, password: EDGE_FORM_PASSWORDS[EDGE_FORM_B], label: '账号 B（账密）' },
      { id: ACCOUNT_OAUTH, siteId: SITE_ID, username: EDGE_OAUTH, password: '', loginMethod: 'oauth', label: '账号 D（第三方登录）' },
    ],
    results: {},
    status: {},
  });
  await app.reload();
  await searchBox().waitFor();

  // ── A. 账号 A 演示时点了印着自己名字的头像菜单 ──────────────────────
  console.log('\n── A. 演示经过印着自己名字的头像菜单 ──');
  const learnedA = await learnAs(ACCOUNT_A, formLogin(EDGE_FORM_A));
  check('A0. 学习保存成功', learnedA?.ok === true, JSON.stringify(learnedA?.feature?.learning?.savedKinds ?? learnedA?.error));
  const afterA = await readAppState(app);
  const workflowA = afterA.sites.find((site) => site.id === SITE_ID)?.checkin?.workflow;
  const workflowJson = JSON.stringify(workflowA ?? {});
  check('A1. 学出的流程里没有演示账号的名字（选择器、指纹、断言都不含）',
    !!workflowA && !workflowJson.includes(EDGE_FORM_A),
    `clickSelectors=${JSON.stringify(flattenSteps(workflowA?.steps).filter((step) => step.type === 'click').map((step) => step.selector))}`);
  const runB = await runAccount(ACCOUNT_B);
  const ownB = runB.claims.filter((entry) => entry.user === EDGE_FORM_B).length;
  const otherB = runB.claims.filter((entry) => entry.user !== EDGE_FORM_B).length;
  check('A2. 账号 B（页面上印的是 B 的名字）用这份流程签到成功，恰好一次且是本账号',
    runB.status === 'done' && runB.result?.ok === true && ownB === 1 && otherB === 0,
    `status=${runB.status} message=${runB.result?.message ?? ''} own=${ownB} other=${otherB}`);
  check('A3. B 的回放经过了身份核对页 /profile',
    /个人资料身份已核验|已核对账号身份/.test(runB.steps) && /\/profile/.test(runB.steps),
    runB.steps.split('\n').filter((line) => /profile|中间页|核验/.test(line)).slice(0, 4).join(' | '));

  // ── B. 第三方登录账号演示学习，不能把账密账号改成走 OAuth ─────────────
  console.log('\n── B. 第三方登录账号重新学习 ──');
  const learnedOauth = await learnAs(ACCOUNT_OAUTH, oauthLogin);
  check('B0. 第三方登录账号学习保存成功', learnedOauth?.ok === true, JSON.stringify(learnedOauth?.feature?.learning?.savedKinds ?? learnedOauth?.error));
  const afterOauth = await readAppState(app);
  const siteAfterOauth = afterOauth.sites.find((site) => site.id === SITE_ID);
  const methods = Object.fromEntries(afterOauth.accounts.map((account) => [account.id, account.loginMethod ?? '(跟随站点)']));
  console.log(`   站点级登录方式=${siteAfterOauth?.loginMethod} 账号级=${JSON.stringify(methods)}`);
  check('B1. 站点默认改成 OAuth 后，原来跟随站点的账密账号被固定为账密',
    siteAfterOauth?.loginMethod === 'oauth' && methods[ACCOUNT_A] === 'form' && methods[ACCOUNT_B] === 'form',
    `site=${siteAfterOauth?.loginMethod} accounts=${JSON.stringify(methods)}`);
  const runA = await runAccount(ACCOUNT_A);
  const ownA = runA.claims.filter((entry) => entry.user === EDGE_FORM_A).length;
  check('B2. 账号 A 之后仍按账密登录（有表单提交、没有 OAuth 跳转），签到恰好一次且是本账号',
    runA.status === 'done' && runA.logins.some((entry) => entry.user === EDGE_FORM_A)
      && !runA.events.some((event) => event.path === '/oauth/start') && ownA === 1,
    `status=${runA.status} message=${runA.result?.message ?? ''} formLogins=${runA.logins.length} own=${ownA}`);

  // ── C. 同一域名的第二张站点卡 ───────────────────────────────────────
  console.log('\n── C. 同一域名的第二张站点卡 ──');
  await app.evaluate(async ({ dup, account }) => {
    const stored = await chrome.storage.local.get(['sites', 'accounts']);
    await chrome.storage.local.set({
      sites: [...(stored.sites ?? []), dup],
      accounts: [...(stored.accounts ?? []), account],
    });
  }, {
    // 书签导入 / 探测没认出来时的重复卡形态：没有登录成功标志，也没有站点系统。
    dup: (() => {
      const { successIndicator: _indicator, adapter: _adapter, ...blank } = baseSite(DUP_SITE_ID, DUP_SITE_NAME);
      return blank;
    })(),
    account: { id: ACCOUNT_DUP, siteId: DUP_SITE_ID, username: EDGE_FORM_C, password: EDGE_FORM_PASSWORDS[EDGE_FORM_C], label: '账号 C（重复卡）' },
  });
  await app.reload();
  await searchBox().waitFor();
  const dupCard = app.locator('section').filter({ has: app.getByRole('link', { name: DUP_SITE_NAME, exact: true }) }).last();
  await dupCard.waitFor();
  const dupCardText = await dupCard.innerText();
  check('C1. 重复卡片的界面显示「学习流程回放」并说明共用的是哪张卡',
    dupCardText.includes('学习流程回放') && dupCardText.includes(SITE_NAME),
    dupCardText.split('\n').filter((line) => /回放|流程/.test(line)).slice(0, 3).join(' | '));
  const runDup = await runAccount(ACCOUNT_DUP);
  const ownDup = runDup.claims.filter((entry) => entry.user === EDGE_FORM_C).length;
  check('C2. 重复卡下没学过的账号直接回放同域流程，签到恰好一次且是本账号',
    runDup.status === 'done' && runDup.result?.ok === true && ownDup === 1
      && /共用同一域名站点/.test(runDup.steps) && /工作流已点击/.test(runDup.steps),
    `status=${runDup.status} message=${runDup.result?.message ?? ''} own=${ownDup}`);
  const afterDup = await readAppState(app);
  const dupStored = afterDup.sites.find((site) => site.id === DUP_SITE_ID);
  check('C3. 回放没有往重复卡里写入任何流程字段（仍是自动识别，流程只存一份）',
    dupStored?.checkin?.method === 'auto' && !dupStored?.checkin?.workflow,
    JSON.stringify(dupStored?.checkin));
  check('C4. 空白重复卡运行时借用了同域卡片的登录成功标志与站点系统（日志如实说明来源）',
    /本站卡片没有登录成功标志，借用同一域名站点「/.test(runDup.steps)
      && /本站卡片没有站点系统信息，借用同一域名站点「/.test(runDup.steps),
    runDup.steps.split('\n').filter((line) => /借用/.test(line)).join(' | '));
  check('C5. 借用只在运行时生效，不写回重复卡的存储',
    !!dupStored && !dupStored.successIndicator && !dupStored.adapter,
    `successIndicator=${dupStored?.successIndicator ?? ''} adapter=${JSON.stringify(dupStored?.adapter ?? null)}`);

} catch (error) {
  exitCode = 1;
  console.error('\n验收执行中断：', error);
  console.error(`profile: ${profile}`);
} finally {
  await disposeContext(context, { app }).catch(() => {});
  await fixture.close();
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n════════ 结果：${results.length - failed.length}/${results.length} 通过 ════════`);
if (failed.length || exitCode) process.exitCode = 1;
