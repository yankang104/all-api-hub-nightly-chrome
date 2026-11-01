/**
 * 融合学习端到端验收（真实扩展 + 真实 Chromium）。
 *
 * 验收的唯一主张：**一次学习**之后，站点上同时存在
 *   1) 站点级登录配置（loginMethod + selectors），以及
 *   2) 站点级签到流程（checkin.workflow + route + identityPath），
 * 并且随后真的自动签到能跑通（未登录 → 自动登录 → 资料页核验 → 签到一次）。
 *
 * 与 learned-flow.mjs 的分工：那个脚本走的是**两个分立入口**（学习登录 → 学习签到），
 * 它必须继续 74/74 通过；本脚本走**融合入口**（账号行上的一次「学习本站流程」），
 * 断言用户不再需要点两次。
 *
 * 加载 WXT 构建产物：默认 .output/chrome-mv3，可用 EXTENSION_DIR 覆盖。
 * 运行：node tests/e2e/learned-unified.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  startFixture,
  FIXTURE_SENTINEL_USERNAME,
  FIXTURE_SENTINEL_PASSWORD,
  FIXTURE_CHECKIN_LABEL,
} from './learned-flow-fixture.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXT = process.env.EXTENSION_DIR
  ? resolve(REPO, process.env.EXTENSION_DIR)
  : join(REPO, '.output', 'chrome-mv3');
const PROFILE_ROOT = join(REPO, 'output', 'learned-unified');
const HEADLESS = process.env.E2E_HEADLESS !== '0';
const SITE_ID = 'learn-fixture';
const ACCOUNT_ID = 'bob';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? `  — ${detail}` : ''}`);
}

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

mkdirSync(PROFILE_ROOT, { recursive: true });
// 只清理本脚本自己创建的 profile（前缀 learned-unified-）。
for (const name of readdirSync(PROFILE_ROOT)) {
  if (!name.startsWith('learned-unified-')) continue;
  try {
    rmSync(join(PROFILE_ROOT, name), { recursive: true, force: true });
  } catch {
    // 上一轮浏览器还没退干净时目录会被占用；改名保留，绝不递归删别的东西。
    const stale = `stale-${Date.now()}-${name}`;
    try { rmSync(join(PROFILE_ROOT, name), { recursive: true, force: true }); } catch { void stale; }
  }
}
const profile = mkdtempSync(join(PROFILE_ROOT, 'learned-unified-'));

const fixture = await startFixture();
const origin = fixture.origin;
console.log(`fixture origin: ${origin}`);
console.log(`extension dir:  ${EXT}`);

const context = await chromium.launchPersistentContext(profile, {
  headless: HEADLESS,
  ...(HEADLESS ? { channel: 'chromium' } : {}),
  viewport: { width: 1280, height: 960 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

let exitCode = 0;
try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionId = new URL(worker.url()).hostname;
  check('扩展加载成功', !!extensionId, `id=${extensionId}`);

  const app = await context.newPage();
  await app.goto(`chrome-extension://${extensionId}/options.html`);
  await app.waitForLoadState('domcontentloaded');
  await app.getByPlaceholder('搜索站点、账号或备注').waitFor();

  /** 等待扩展页可读的断言函数；防止扩展页被关掉时崩掉整轮。 */
  async function waitForApp(predicate, timeoutMs = 15000, label = '') {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await app.evaluate(predicate).catch(() => undefined);
      if (last) return last;
      await new Promise((done) => setTimeout(done, 200));
    }
    throw new Error(`等待超时${label ? ` [${label}]` : ''}`);
  }

  const readState = () => app.evaluate(async () => {
    const stored = await chrome.storage.local.get(['status', 'results', 'sites', 'accounts']);
    return {
      status: stored.status ?? {},
      results: stored.results ?? {},
      sites: stored.sites ?? [],
      accounts: stored.accounts ?? [],
    };
  });

  const accountStatus = (state, accountId) =>
    Object.entries(state.status ?? {}).find(([key]) => key.startsWith(`${accountId}:`))?.[1] ?? 'none';

  async function waitForQueueIdle(timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const queue = await app.evaluate(async () => (await chrome.storage.session.get('checkinQueue')).checkinQueue).catch(() => null);
      if (!queue?.active && !(queue?.pendingAccountIds?.length > 0)) return true;
      await new Promise((done) => setTimeout(done, 150));
    }
    return false;
  }

  const learningSessions = () => app.evaluate(async () =>
    (await chrome.runtime.sendMessage({ type: 'GET_LEARNING' }))?.feature?.learningSessions ?? []);

  // ── 0. 种入站点与账号 ──────────────────────────────────────────────
  await app.evaluate(async ({ origin, siteId }) => {
    await chrome.storage.local.set({
      sites: [{
        id: siteId,
        name: '融合学习验收站',
        loginUrl: `${origin}/login`,
        successIndicator: '#logged-in',
        closeModalSelectors: [],
        checkin: { method: 'auto', url: '/console' },
        adapter: { family: 'new-api', siteType: 'new-api', quotaPerUnit: 500000 },
      }],
      accounts: [{
        id: 'bob',
        siteId,
        username: 'sentinel_a44f9',
        password: 'sentinel_pw_zz77',
        label: '融合验收账号',
      }],
      proxies: [],
      status: {},
      results: {},
      balances: {},
    });
  }, { origin, siteId: SITE_ID });
  await app.reload();
  await app.getByPlaceholder('搜索站点、账号或备注').waitFor();
  await app.locator('section a', { hasText: '融合学习验收站' }).first().waitFor();

  const beforeLearn = await readState();
  const beforeSite = beforeLearn.sites.find((site) => site.id === SITE_ID);
  check('学习前站点既没有登录方式也没有签到流程',
    !beforeSite?.loginMethod && !beforeSite?.checkin?.workflow);

  // ── 1. 融合入口：一次学习同时录登录与签到 ───────────────────────────
  console.log('\n── 融合学习（一次演示：登录 → 签到）──');
  await app.getByRole('button', { name: '展开账号 融合学习验收站' }).click();
  const row = app.locator('[data-account-id="bob"]');
  await row.waitFor();

  const fusedEntry = [...await row.locator('button').all()]
    .find(async (button) => (await button.textContent())?.includes('学习本站流程'));
  check('账号行有融合入口「学习本站流程」', (await row.getByText('学习本站流程', { exact: true }).count()) === 1);
  // 单一入口：旧的两个按钮已从界面移除，只保留融合入口。
  check('账号行不再出现旧的「学习登录」「学习签到」入口',
    (await row.getByRole('button', { name: /学习本站通用登录流程/ }).count()) === 0
    && (await row.getByRole('button', { name: /学习本站签到流程/ }).count()) === 0);
  check('融合入口的引导覆盖两段（先登录、再签到、然后结束）',
    /先手动登录/.test(await row.getByRole('button', { name: /学习本站登录与签到流程/ }).getAttribute('title') ?? '')
    && /完成一次签到/.test(await row.getByRole('button', { name: /学习本站登录与签到流程/ }).getAttribute('title') ?? ''));
  void fusedEntry;

  const learningTabPromise = context.waitForEvent('page');
  await row.getByRole('button', { name: /学习本站登录与签到流程/ }).click();
  const session = await waitForApp(async () => {
    const sessions = (await chrome.runtime.sendMessage({ type: 'GET_LEARNING' }))?.feature?.learningSessions ?? [];
    return sessions.find((item) => item.kind === 'both' || item.kind === 'checkin') ?? false;
  }, 20000, '融合学习会话');
  check('一次点击发起的融合学习会话', !!session, `kind=${session?.kind}`);

  const learnPage = await learningTabPromise;
  await learnPage.waitForURL((url) => url.pathname === '/login', { timeout: 20000 });
  await learnPage.fill('#username', FIXTURE_SENTINEL_USERNAME);
  await learnPage.fill('#password', FIXTURE_SENTINEL_PASSWORD);
  await learnPage.click('#login-submit');
  await learnPage.waitForURL((url) => url.pathname === '/console', { timeout: 20000 });
  await learnPage.waitForSelector('#logged-in');
  console.log('   手动登录完成');

  // 进入能显示当前账号的资料页，再进签到页签一次
  await learnPage.click('#nav-profile');
  await learnPage.waitForURL((url) => url.pathname === '/profile', { timeout: 15000 });
  await learnPage.waitForSelector('#profile-account');
  await learnPage.click('#nav-checkin');
  await learnPage.waitForURL((url) => url.pathname === '/checkin', { timeout: 15000 });
  await learnPage.waitForSelector('#checkin-card');

  const checkinButton = learnPage.locator(`button[aria-label="${FIXTURE_CHECKIN_LABEL}"]`);
  await learnPage.mouse.move(640, 480);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const inView = await learnPage.evaluate((label) => {
      const rect = document.querySelector(`button[aria-label="${label}"]`).getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= window.innerHeight;
    }, FIXTURE_CHECKIN_LABEL);
    if (inView) break;
    await learnPage.mouse.wheel(0, 900);
    await learnPage.waitForTimeout(250);
  }
  await checkinButton.click();
  await learnPage.waitForFunction(
    () => (document.getElementById('checkin-result')?.textContent ?? '').includes('签到成功'),
    null,
    { timeout: 15000 },
  );
  check('演示阶段真的完成了签到（页面出现「签到成功」）', fixture.claimCount() === 1, `claims=${fixture.claimCount()}`);
  await learnPage.waitForTimeout(400);

  // 中途进度必须能看出「学到了什么」
  const midSession = (await learningSessions()).find((item) => item.accountId === 'bob');
  check('学习中的进度带着可读动作预览', (midSession?.preview?.length ?? 0) > 0,
    `preview=${JSON.stringify(midSession?.preview?.slice(-3))}`);
  await row.getByRole('button', { name: '结束学习' }).click();

  // ── 2. 一份事件流、两份产物 ────────────────────────────────────────
  const afterLearn = await waitForApp(async () => {
    const sites = (await chrome.storage.local.get('sites')).sites ?? [];
    const site = sites.find((item) => item.id === 'learn-fixture');
    return site?.loginMethod === 'form' && site?.checkin?.workflow?.steps?.length > 0 ? site : false;
  }, 20000, '融合学习保存');
  const loginSerialized = JSON.stringify(afterLearn);
  const workflow = afterLearn.checkin?.workflow ?? {};
  const route = workflow.route ?? [];
  const steps = workflow.steps ?? [];
  const clickSteps = flattenSteps(steps).filter((step) => step.type === 'click');

  console.log(`   loginMethod=${afterLearn.loginMethod} selectors=${JSON.stringify(afterLearn.selectors)}`);
  console.log(`   route=${JSON.stringify(route)} identityPath=${JSON.stringify(workflow.identityPath)}`);
  console.log(`   clickSteps=${JSON.stringify(clickSteps.map((step) => step.selector))}`);

  check('一次学习同时写入登录配置（loginMethod=form）', afterLearn.loginMethod === 'form');
  check('一次学习同时写入真实学到的账密字段选择器',
    /username/.test(afterLearn.selectors?.username ?? '') && /password/.test(afterLearn.selectors?.password ?? ''),
    `username=${afterLearn.selectors?.username} password=${afterLearn.selectors?.password}`);
  check('一次学习同时写入签到流程（workflow.steps 非空）', steps.length > 0);
  check('签到流程的 route 以签到页收尾', route.at(-1) === '/checkin', JSON.stringify(route));
  check('route 含个人资料页 /profile（身份核验）', route.includes('/profile'), JSON.stringify(route));
  check('identityPath 指向 /profile', workflow.identityPath === '/profile', JSON.stringify(workflow.identityPath));
  check('签到流程不含登录页（认证页不进路线）', !route.includes('/login'), JSON.stringify(route));
  check('签到流程不含账密字段与登录提交动作（两份产物互不污染）',
    !JSON.stringify(workflow).includes('#username')
    && !JSON.stringify(workflow).includes('#password')
    && !JSON.stringify(workflow).includes('#login-submit'));
  check('融合学习产物不含输入值 sentinel',
    !loginSerialized.includes(FIXTURE_SENTINEL_USERNAME) && !loginSerialized.includes(FIXTURE_SENTINEL_PASSWORD));
  check('保存后的会话已结束', (await learningSessions()).length === 0);

  // ── 2b. 只完成一半（只登录、没签到）时必须部分保存并如实提示 ────────
  console.log('\n── 部分保存：只完成登录、没点到签到 ──');
  for (const page of context.pages()) {
    if (page.url().startsWith(origin)) await page.close().catch(() => {});
  }
  await context.clearCookies();
  await app.reload();
  await app.getByPlaceholder('搜索站点、账号或备注').waitFor();
  await app.locator('section a', { hasText: '融合学习验收站' }).first().waitFor();
  await app.getByRole('button', { name: '展开账号 融合学习验收站' }).click();
  const partialRow = app.locator('[data-account-id="bob"]');
  await partialRow.waitFor();

  const partialTabPromise = context.waitForEvent('page');
  await partialRow.getByRole('button', { name: /学习本站登录与签到流程/ }).click();
  await waitForApp(async () => {
    const sessions = (await chrome.runtime.sendMessage({ type: 'GET_LEARNING' }))?.feature?.learningSessions ?? [];
    return sessions.some((item) => item.accountId === 'bob') ? true : false;
  }, 20000, '部分保存学习会话');
  const partialPage = await partialTabPromise;
  await partialPage.waitForURL((url) => url.pathname === '/login', { timeout: 20000 });
  await partialPage.fill('#username', FIXTURE_SENTINEL_USERNAME);
  await partialPage.fill('#password', FIXTURE_SENTINEL_PASSWORD);
  await partialPage.click('#login-submit');
  await partialPage.waitForURL((url) => url.pathname === '/console', { timeout: 20000 });
  await partialPage.waitForSelector('#logged-in');
  await partialPage.waitForTimeout(300);
  check('部分演示：只完成了登录，没有点签到', fixture.claimCount() === 1, `claims=${fixture.claimCount()}（仍是第 1 阶段的 1 次）`);

  const workflowBeforePartial = JSON.stringify((await readState()).sites.find((site) => site.id === SITE_ID)?.checkin?.workflow);
  await partialRow.getByRole('button', { name: '结束学习' }).click();
  const partialToast = await app.getByText(/本次演示没录全|没有录到登录之后的签到动作/).first().textContent({ timeout: 20000 }).catch(() => '');
  await waitForApp(async () => {
    const sessions = (await chrome.runtime.sendMessage({ type: 'GET_LEARNING' }))?.feature?.learningSessions ?? [];
    return sessions.length === 0;
  }, 20000, '部分保存完成');
  const afterPartial = await readState();
  const partialSite = afterPartial.sites.find((site) => site.id === SITE_ID);

  check('只完成登录时仍然保存了登录配置（不是整场丢弃）', partialSite?.loginMethod === 'form', `loginMethod=${partialSite?.loginMethod}`);
  check('只完成登录时如实提示「签到步骤没录到，请重新演示签到」',
    /没有录到登录之后的签到动作/.test(partialToast ?? '') && /重新演示/.test(partialToast ?? ''),
    JSON.stringify(partialToast));
  check('部分保存没有谎报「登录与签到都学会」', !/登录与签到流程（录到/.test(partialToast ?? ''), JSON.stringify(partialToast));
  check('部分保存没有把已有签到流程改坏（原流程原样保留）',
    JSON.stringify(partialSite?.checkin?.workflow) === workflowBeforePartial);

  // ── 3. 随后自动签到必须跑通（未登录 → 自动登录 → 核验 → 签到一次） ──
  console.log('\n── 回放：用这一次学到的两份产物自动签到 ──');
  await waitForQueueIdle();
  for (const page of context.pages()) {
    if (page.url().startsWith(origin)) await page.close().catch(() => {});
  }
  await context.clearCookies();
  fixture.reset();
  await app.evaluate(async () => { await chrome.storage.local.set({ status: {}, results: {} }); });

  const started = await app.evaluate(() => chrome.runtime.sendMessage({ type: 'START_LOGIN', accountId: 'bob' }));
  check('START_LOGIN 入队', started?.ok === true && started?.queued === 1, JSON.stringify(started));

  const deadline = Date.now() + 120000;
  let state = await readState();
  while (Date.now() < deadline) {
    state = await readState();
    if (['done', 'failed', 'attention'].includes(accountStatus(state, ACCOUNT_ID))) break;
    await new Promise((done) => setTimeout(done, 300));
  }
  await new Promise((done) => setTimeout(done, 800));
  state = await readState();
  const status = accountStatus(state, ACCOUNT_ID);
  const result = state.results?.[ACCOUNT_ID];
  const stepsJoined = (result?.steps ?? []).join('\n');
  console.log(`   状态=${status} 说明=${result?.message ?? 'n/a'}`);

  const events = fixture.events();
  const identityIdx = events.findIndex((event) => event.path === '/api/user/self' || (event.method === 'GET' && event.path === '/profile'));
  const checkinIdx = events.findIndex((event) => event.method === 'POST' && event.path === '/api/checkin');

  check('自动签到终态 done', status === 'done', `status=${status} message=${result?.message ?? ''}`);
  check('自动登录用上了刚学到的登录配置', fixture.loginCount() === 1, `logins=${fixture.loginCount()}`);
  check('恰好签到一次', fixture.claimCount() === 1, `claims=${fixture.claimCount()}`);
  check('签到发生在身份核验之后（请求顺序）', identityIdx >= 0 && checkinIdx > identityIdx,
    `identity#${identityIdx} checkin#${checkinIdx}`);
  check('回放日志含个人资料页身份核验步骤', /个人资料页/.test(stepsJoined));
  const cookieUser = (await context.cookies(origin)).find((cookie) => cookie.name === 'fixture_user')?.value;
  check('结束时浏览器会话属于验收账号', cookieUser === FIXTURE_SENTINEL_USERNAME, `user=${cookieUser}`);

  const failed = results.filter((item) => !item.ok);
  console.log(`\n════════ 结果：${results.length - failed.length}/${results.length} 通过 ════════`);
  if (failed.length) {
    exitCode = 1;
    for (const item of failed) console.log(`✖ ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
  }
} catch (error) {
  exitCode = 1;
  console.error('\n验收执行中断：', error);
  for (const item of results.filter((entry) => !entry.ok)) console.error(`✖ ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
} finally {
  await context.close().catch(() => {});
  await fixture.close().catch(() => {});
  console.log(`profile: ${profile}`);
}
process.exit(exitCode);
