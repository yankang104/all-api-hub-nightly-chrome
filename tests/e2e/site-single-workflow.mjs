/**
 * 「一站一流程」真实浏览器端到端验收（真实扩展 + 真实 Chromium）。
 *
 * 用户硬性要求：**一个站点只有一份签到流程，站内所有账号共用；谁再学一次，就整体覆盖这一份。**
 *
 * 本脚本在同一个虚构站点上配两个账号 A / B，按顺序证明三件事：
 *   a. 只让 A 学一次 → 站点上只有一份 checkin.workflow；B 完全没学过，
 *      清掉浏览器会话后自动签到仍然成功，且恰好一次签到 POST，走的正是 A 学出来的路线。
 *   b. 再让 B 学一次（这次刻意不走资料页）→ 站点上仍然只有一份 workflow，
 *      内容被 B 这次演示整体替换；随后用这份新流程再跑一次 B 的自动签到，
 *      回放日志里出现新路线、不再出现旧路线，签到仍然恰好一次。
 *   c. A 正在学习时，B 发起学习必须被同站互斥拒绝（界面 toast + 后台原始响应两路取证），
 *      A 的学习会话不受影响，仍能正常结束并保存。
 *
 * 运行：node tests/e2e/site-single-workflow.mjs
 * 依赖：先 `npx wxt build`（产物 .output/chrome-mv3），可用 EXTENSION_DIR 覆盖。
 *
 * 隐私红线：账号是虚构 sentinel；只断言请求计数、路径与账号名，不采集任何输入值/密码。
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
  startFixture,
  FIXTURE_SENTINEL_USERNAME,
  FIXTURE_SENTINEL_PASSWORD,
  FIXTURE_ALICE_USERNAME,
  FIXTURE_ALICE_PASSWORD,
  FIXTURE_CHECKIN_LABEL,
} from './learned-flow-fixture.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXT = resolveExtensionDir(process.env.EXTENSION_DIR, join(REPO, '.output', 'chrome-mv3'));
const PROFILE_ROOT = join(REPO, 'output', 'site-single-workflow');
const HEADLESS = process.env.E2E_HEADLESS !== '0';

const SITE_ID = 'single-workflow-site';
const SITE_NAME = '一站一流程验收站';
const ACCOUNT_A = 'account-a';
const ACCOUNT_B = 'account-b';

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

function workflowFieldsOf(accounts) {
  return accounts.flatMap((account) => Object.keys(account ?? {})
    .filter((key) => /workflow|checkin/i.test(key))
    .map((key) => `${account.id}.${key}`));
}

mkdirSync(PROFILE_ROOT, { recursive: true });
// 每轮新开 profile，绝不递归删旧目录（旧的可能是用户/其它进程正在用的）。
const profile = mkdtempSync(join(PROFILE_ROOT, 'profile-'));

const fixture = await startFixture({ nestedLogin: true });
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

let exitCode = 0;
let worker = launched.worker;
try {
  const app = await openExtensionPage(context, extensionId, 'options.html');
  await app.getByRole('banner').getByRole('textbox', { name: '搜索站点、账号或备注' }).waitFor();

  /** 等扩展页里能读到一个真值；扩展页被关掉时不会把整轮打崩。 */
  async function waitForApp(predicate, timeoutMs = 20_000, label = '', arg) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await app.evaluate(predicate, arg).catch(() => undefined);
      if (last) return last;
      await new Promise((done) => setTimeout(done, 200));
    }
    throw new Error(`等待超时${label ? ` [${label}]` : ''}`);
  }

  const readState = () => readAppState(app);
  const sessionState = () => app.evaluate(async () => {
    const session = await chrome.storage.session.get(null);
    return {
      learning: Object.entries(session)
        .filter(([key]) => key.startsWith('learning:'))
        .map(([key, value]) => ({ key, accountId: value?.accountId, kind: value?.kind, runId: value?.runId })),
      queue: session.checkinQueue ?? { active: null, pendingAccountIds: [] },
    };
  });
  const learningSessions = () => app.evaluate(async () =>
    (await chrome.runtime.sendMessage({ type: 'GET_LEARNING' }))?.feature?.learningSessions ?? []);
  const startAuto = (accountId) => app.evaluate((id) =>
    chrome.runtime.sendMessage({ type: 'START_LOGIN', accountId: id }), accountId);

  const siteOf = (state) => state.sites.find((site) => site.id === SITE_ID);
  const accountStatus = (state, accountId) => statusOf(state, accountId) ?? 'none';

  /** 关掉所有停留在这个虚构站点上的页面，并清空浏览器会话。 */
  async function resetBrowserSession() {
    for (const page of context.pages()) {
      if (page !== app && page.url().startsWith(origin)) await page.close().catch(() => {});
    }
    await context.clearCookies();
  }

  async function expandAccounts() {
    const expand = app.getByRole('button', { name: `展开账号 ${SITE_NAME}` });
    if (await expand.count()) await expand.click();
    await app.locator(`[data-account-id="${ACCOUNT_A}"]`).waitFor();
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
      await page.waitForTimeout(220);
    }
    return false;
  }

  /** 走一遍「手动登录 → 选中入口 → 到签到页 → 点击签到按钮」，用于学习演示。 */
  async function demonstrateCheckinOnLearningPage(page, { username, password, viaProfile }) {
    await page.waitForURL((url) => url.pathname === '/login', { timeout: 25_000 });
    await page.click('#reveal-more');
    await page.click('#reveal-form');
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
      // 刻意绕过资料页：这条演示的路线里没有 /profile，
      // 身份页只能由签到页本身承担 —— 用来制造「与上一份流程可观测地不同」。
      await page.click('#nav-checkin');
    }
    await page.waitForURL((url) => url.pathname === '/checkin', { timeout: 20_000 });
    await page.waitForSelector('#checkin-card');
    await scrollIntoView(page, `button[aria-label="${FIXTURE_CHECKIN_LABEL}"]`);
    await page.locator(`button[aria-label="${FIXTURE_CHECKIN_LABEL}"]`).click();
    await page.waitForFunction(
      () => (document.getElementById('checkin-result')?.textContent ?? '').includes('签到成功'),
      null,
      { timeout: 20_000 },
    );
    await page.waitForTimeout(500);
  }

  /** 点某账号行的「学习本站流程」，返回新打开的学习页。 */
  async function openLearning(row) {
    const pagePromise = context.waitForEvent('page', { timeout: 30_000 });
    await row.getByRole('button', { name: /学习本站登录与签到流程/ }).click();
    return pagePromise;
  }

  async function finishLearning(row, accountId) {
    await app.bringToFront();
    await row.getByRole('button', { name: /结束学习并保存/ }).click();
    await waitForApp(async (id) => {
      const resp = await chrome.runtime.sendMessage({ type: 'GET_LEARNING' });
      if (!resp?.ok) return false;
      return (resp.feature?.learningSessions ?? []).every((item) => item.accountId !== id);
    }, 30_000, `结束学习 ${accountId}`, accountId);
  }

  /** 等站点上出现一份非空 workflow 并返回它。 */
  async function waitForWorkflow(timeoutMs = 30_000, previous = null) {
    const previousJson = previous ? JSON.stringify(previous) : null;
    return waitForApp(async ({ siteId, previousJson: expected }) => {
      const sites = (await chrome.storage.local.get('sites')).sites ?? [];
      const site = sites.find((item) => item.id === siteId);
      const workflow = site?.checkin?.workflow;
      if (!workflow?.steps?.length) return false;
      if (expected && JSON.stringify(workflow) === expected) return false;
      return workflow;
    }, timeoutMs, '站点 workflow 落盘（须为新一份）', { siteId: SITE_ID, previousJson });
  }

  // ── 0. 种入一个站点 + 两个账号 ────────────────────────────────────
  await seedAppStorage(app, {
    sites: [{
      id: SITE_ID,
      name: SITE_NAME,
      loginUrl: `${origin}/old-login`,
      preLoginClickSelector: '#old-entry',
      preLoginClickSelectors: ['#old-entry'],
      successIndicator: '#logged-in',
      closeModalSelectors: [],
      checkin: {
        method: 'auto', url: '/old-checkin',
        entry: { readySelector: '#old-ready', steps: [{ selector: '#old-checkin-entry' }] },
      },
      adapter: { family: 'new-api', siteType: 'new-api', quotaPerUnit: 500000 },
    }],
    accounts: [
      { id: ACCOUNT_A, siteId: SITE_ID, username: FIXTURE_SENTINEL_USERNAME, password: FIXTURE_SENTINEL_PASSWORD, label: '账号 A' },
      { id: ACCOUNT_B, siteId: SITE_ID, username: FIXTURE_ALICE_USERNAME, password: FIXTURE_ALICE_PASSWORD, label: '账号 B' },
    ],
    results: {},
    status: {},
  });
  await app.reload();
  await app.getByRole('banner').getByRole('textbox', { name: '搜索站点、账号或备注' }).waitFor();
  await app.locator('section a', { hasText: SITE_NAME }).first().waitFor();
  await expandAccounts();

  const seeded = await readState();
  check('种入 1 个站点 + 2 个账号，初始没有任何 workflow',
    seeded.sites.length === 1 && seeded.accounts.length === 2
      && !seeded.sites[0].checkin?.workflow
      && workflowFieldsOf(seeded.accounts).length === 0,
    `sites=${seeded.sites.length} accounts=${seeded.accounts.length} accountWorkflowFields=${JSON.stringify(workflowFieldsOf(seeded.accounts))}`);

  const rowA = app.locator(`[data-account-id="${ACCOUNT_A}"]`);
  const rowB = app.locator(`[data-account-id="${ACCOUNT_B}"]`);

  // ── a. 只学 A 一次，B 直接复用 ────────────────────────────────────
  console.log('\n── a. 账号 A 学一次 → 站点一份流程 → 账号 B 直接回放 ──');
  await resetBrowserSession();
  const learnPageA = await openLearning(rowA);
  await waitForApp(async (id) => {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_LEARNING' });
    if (!resp?.ok) return false;
    return (resp.feature?.learningSessions ?? []).find((item) => item.accountId === id) ?? false;
  }, 30_000, 'A 的学习会话', ACCOUNT_A);
  await demonstrateCheckinOnLearningPage(learnPageA, {
    username: FIXTURE_SENTINEL_USERNAME,
    password: FIXTURE_SENTINEL_PASSWORD,
    viaProfile: true,
  });
  console.log(`   演示中签到 POST=${fixture.claimCount()}（学习阶段的真实点击）`);
  const loginEvents = await app.evaluate(async () => {
    const sessions = await chrome.storage.session.get(null);
    return Object.entries(sessions).filter(([key]) => key.startsWith('learn:'))
      .flatMap(([, session]) => session.events ?? [])
      .filter((event) => event.path === '/login')
      .map(({ type, selector, loginAction, fieldRole, at }) => ({ type, selector, loginAction, fieldRole, at }));
  });
  console.log(`   登录录制动作（不含输入值）：${JSON.stringify(loginEvents)}`);
  await finishLearning(rowA, ACCOUNT_A);

  const workflowA = await waitForWorkflow();
  const afterA = await readState();
  const fpA = workflowFingerprint(workflowA);
  const siteWorkflowCountA = afterA.sites.filter((site) => site.checkin?.workflow).length;
  console.log(`   A 学到的 workflow 指纹：${JSON.stringify(fpA)}`);
  check('a1. 站点上恰好一份 workflow（账号上没有）',
    siteWorkflowCountA === 1 && workflowFieldsOf(afterA.accounts).length === 0,
    `siteWorkflows=${siteWorkflowCountA} accountWorkflowFields=${JSON.stringify(workflowFieldsOf(afterA.accounts))}`);
  const clickSelectorsA = flattenSteps(workflowA.steps).filter((step) => step.type === 'click').map((step) => step.selector);
  const clickTargetLabels = await learnPageA.evaluate(
    (selectors) => selectors.map((selector) => {
      try { return document.querySelector(selector)?.getAttribute('aria-label') ?? null; } catch { return null; }
    }),
    clickSelectorsA,
  ).catch(() => []);
  check('a2. A 的演示真的滚到并点击了签到按钮（选择器在真实 DOM 上指向 aria-label=签到）',
    clickTargetLabels.includes(FIXTURE_CHECKIN_LABEL)
      && clickSelectorsA.every((selector) => selector !== '#pull-knob'),
    `clickSelectors=${JSON.stringify(clickSelectorsA)} clickTargetLabels=${JSON.stringify(clickTargetLabels)}`);
  check('a3. A 的路线含独立资料页 /profile（身份核验页）',
    fpA.route.includes('/profile') && fpA.identityPath === '/profile',
    `route=${JSON.stringify(fpA.route)} identityPath=${JSON.stringify(fpA.identityPath)}`);

  // B 从未学过：清掉会话与站点标签页，让它自己登录后再用站点那份流程
  await resetBrowserSession();
  fixture.reset();
  const sessionsBeforeB = await learningSessions();
  check('a4. 触发 B 自动签到时，B 确实没有任何正在学习的会话',
    sessionsBeforeB.length === 0, `sessions=${JSON.stringify(sessionsBeforeB)}`);

  const startedB = await startAuto(ACCOUNT_B);
  check('a5. B 的自动签到成功入队', startedB?.ok === true && startedB?.queued === 1, JSON.stringify(startedB));
  const settledBa = await waitForAccountSettled(app, ACCOUNT_B, { timeoutMs: 120_000 });
  const statusBa = accountStatus(settledBa, ACCOUNT_B);
  const resultBa = settledBa.results?.[ACCOUNT_B];
  const stepsBa = (resultBa?.steps ?? []).join('\n');
  const eventsBa = fixture.events();
  const claimBa = eventsBa.filter((event) => event.method === 'POST' && event.path === '/api/checkin');
  const loginBa = eventsBa.filter((event) => event.method === 'POST' && event.path === '/session');
  console.log(`   B 回放状态=${statusBa} 说明=${resultBa?.message ?? 'n/a'}`);
  console.log(`   B 请求：login=${JSON.stringify(loginBa.map((event) => event.user))} claim=${JSON.stringify(claimBa.map((event) => event.user))}`);
  console.log(`   B 回放日志片段：${stepsBa.split('\n').filter((line) => /工作流|身份/.test(line)).slice(0, 6).join(' | ')}`);
  check('a6. B 的自动签到终态 done，且签到恰好一次',
    statusBa === 'done' && resultBa?.ok === true && claimBa.length === 1,
    `status=${statusBa} claims=${claimBa.length} message=${resultBa?.message ?? ''}`);
  check('a7. 这一次签到真的是账号 B（不是借了 A 的会话）',
    loginBa.length === 1 && loginBa[0].user === FIXTURE_ALICE_USERNAME
      && claimBa[0].user === FIXTURE_ALICE_USERNAME,
    `loginUser=${loginBa[0]?.user ?? 'n/a'} claimUser=${claimBa[0]?.user ?? 'n/a'}`);
  check('a8. B 回放走的是 A 学出来的路线（日志出现 /profile 与工作流点击）',
    /工作流沿学习路线进入 \/profile/.test(stepsBa)
      && /工作流已点击/.test(stepsBa),
    `hasProfileRoute=${/工作流沿学习路线进入 \/profile/.test(stepsBa)} hasWorkflowClick=${/工作流已点击/.test(stepsBa)}`);

  const afterBReplay = await readState();
  check('a9. B 回放后站点还是同一份 workflow（没有被复制/改写）',
    JSON.stringify(siteOf(afterBReplay)?.checkin?.workflow) === JSON.stringify(workflowA),
    `same=${JSON.stringify(siteOf(afterBReplay)?.checkin?.workflow) === JSON.stringify(workflowA)}`);
  check('a10. 学习替换旧登录地址和入口，回放按顺序执行两个前置动作',
    siteOf(afterBReplay)?.loginUrl === `${origin}/login`
      && JSON.stringify(siteOf(afterBReplay)?.preLoginClickSelectors) === JSON.stringify(['#reveal-more', '#reveal-form'])
      && JSON.stringify(eventsBa.filter((event) => event.path.startsWith('/record/reveal-')).map((event) => event.path))
        === JSON.stringify(['/record/reveal-more', '/record/reveal-form'])
      && !eventsBa.some((event) => event.path === '/old-login'),
    `loginUrl=${siteOf(afterBReplay)?.loginUrl} entries=${JSON.stringify(siteOf(afterBReplay)?.preLoginClickSelectors)}`);
  check('a11. 学习启用回放并清除旧签到入口，执行期间没有访问旧签到页',
    siteOf(afterBReplay)?.checkin?.method === 'workflow'
      && !siteOf(afterBReplay)?.checkin?.url && !siteOf(afterBReplay)?.checkin?.entry
      && !eventsBa.some((event) => event.path === '/old-checkin'));

  // ── b. B 再学一次 → 覆盖，仍然只有一份 ─────────────────────────────
  console.log('\n── b. 账号 B 再学一次（刻意不走资料页）→ 覆盖站点那一份 ──');
  fixture.reset();
  await resetBrowserSession();
  const learnPageB = await openLearning(rowB);
  await waitForApp(async (id) => {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_LEARNING' });
    if (!resp?.ok) return false;
    return (resp.feature?.learningSessions ?? []).find((item) => item.accountId === id) ?? false;
  }, 30_000, 'B 的学习会话', ACCOUNT_B);
  await demonstrateCheckinOnLearningPage(learnPageB, {
    username: FIXTURE_ALICE_USERNAME,
    password: FIXTURE_ALICE_PASSWORD,
    viaProfile: false,
  });
  await finishLearning(rowB, ACCOUNT_B);

  const workflowB = await waitForWorkflow(30_000, workflowA);
  const afterBLearn = await readState();
  const fpB = workflowFingerprint(workflowB);
  const siteWorkflowCountB = afterBLearn.sites.filter((site) => site.checkin?.workflow).length;
  console.log(`   B 学到的 workflow 指纹：${JSON.stringify(fpB)}`);
  console.log(`   覆盖前 route=${JSON.stringify(fpA.route)} steps=${fpA.steps.length}；覆盖后 route=${JSON.stringify(fpB.route)} steps=${fpB.steps.length}`);
  check('b1. 再学一次后站点上仍然只有一份 workflow（账号上没有）',
    siteWorkflowCountB === 1 && workflowFieldsOf(afterBLearn.accounts).length === 0,
    `siteWorkflows=${siteWorkflowCountB} accountWorkflowFields=${JSON.stringify(workflowFieldsOf(afterBLearn.accounts))}`);
  check('b2. 那一份已经被 B 这次学习整体替换（路线/身份页与 A 不同）',
    JSON.stringify(workflowB) !== JSON.stringify(workflowA)
      && !fpB.route.includes('/profile') && fpB.identityPath === '/checkin',
    `changed=${JSON.stringify(workflowB) !== JSON.stringify(workflowA)} route=${JSON.stringify(fpB.route)} identityPath=${JSON.stringify(fpB.identityPath)}`);

  // 用被替换后的新流程再真跑一次 B，证明「替换」是可执行层面的替换，不是只改了配置
  await resetBrowserSession();
  fixture.reset();
  const startedB2 = await startAuto(ACCOUNT_B);
  check('b3. 替换后的流程仍能启动 B 的自动签到', startedB2?.ok === true && startedB2?.queued === 1, JSON.stringify(startedB2));
  const settledBb = await waitForAccountSettled(app, ACCOUNT_B, { timeoutMs: 120_000 });
  const statusBb = accountStatus(settledBb, ACCOUNT_B);
  const resultBb = settledBb.results?.[ACCOUNT_B];
  const stepsBb = (resultBb?.steps ?? []).join('\n');
  const eventsBb = fixture.events();
  const claimBb = eventsBb.filter((event) => event.method === 'POST' && event.path === '/api/checkin');
  console.log(`   B 二次回放状态=${statusBb} 说明=${resultBb?.message ?? 'n/a'} claims=${claimBb.length}`);
  console.log(`   二次回放路线日志：${stepsBb.split('\n').filter((line) => line.includes('工作流沿学习路线进入')).join(' | ') || '（无）'}`);
  check('b4. B 用替换后的新流程签到成功且恰好一次',
    statusBb === 'done' && resultBb?.ok === true && claimBb.length === 1 && claimBb[0].user === FIXTURE_ALICE_USERNAME,
    `status=${statusBb} claims=${claimBb.length} user=${claimBb[0]?.user ?? 'n/a'} message=${resultBb?.message ?? ''}`);
  check('b5. 二次回放真的走了新路线（进 /checkin、不再经 /profile）',
    /工作流沿学习路线进入 \/checkin/.test(stepsBb)
      && !/工作流沿学习路线进入 \/profile/.test(stepsBb),
    `hasCheckin=${/工作流沿学习路线进入 \/checkin/.test(stepsBb)} hasProfile=${/工作流沿学习路线进入 \/profile/.test(stepsBb)}`);

  const afterBReplay2 = await readState();
  check('b6. 二次回放结束后站点仍只有这一份 workflow（内容不变）',
    JSON.stringify(siteOf(afterBReplay2)?.checkin?.workflow) === JSON.stringify(workflowB)
      && afterBReplay2.sites.filter((site) => site.checkin?.workflow).length === 1,
    `unchanged=${JSON.stringify(siteOf(afterBReplay2)?.checkin?.workflow) === JSON.stringify(workflowB)}`);

  // ── c. 同站并发学习互斥 ─────────────────────────────────────────
  console.log('\n── c. A 正在学习时，B 尝试开始学习必须被拒绝 ──');
  await resetBrowserSession();
  fixture.reset();
  const learnPageC = await openLearning(rowA);
  await waitForApp(async (id) => {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_LEARNING' });
    if (!resp?.ok) return false;
    return (resp.feature?.learningSessions ?? []).find((item) => item.accountId === id) ?? false;
  }, 30_000, 'A 的并发学习会话', ACCOUNT_A);

  // 用户真实路径：点 B 行的按钮，读界面 toast
  await rowB.getByRole('button', { name: /学习本站登录与签到流程/ }).click();
  const readToastText = () => app.evaluate(() => {
    const node = [...document.querySelectorAll('div')].find((el) =>
      typeof el.className === 'string' && el.className.includes('z-[60]'));
    return node?.textContent ?? '';
  }).catch(() => '');
  let rejectionToast = '';
  for (let attempt = 0; attempt < 150; attempt += 1) {
    await new Promise((done) => setTimeout(done, 100));
    rejectionToast = await readToastText();
    if (/只能有一条录制/.test(rejectionToast)) break;
  }
  console.log(`   界面拒绝文案：${JSON.stringify(rejectionToast)}`);
  check('c1. 界面明确拒绝 B 的第二条学习，并提到「同站 / 只能有一条」',
    /同站点只能有一条录制/.test(rejectionToast ?? ''),
    JSON.stringify(rejectionToast));

  // 权威路径：直接读后台原始响应（不受 toast 2.6s 自动消失影响）
  const rejectedRaw = await app.evaluate((id) =>
    chrome.runtime.sendMessage({ type: 'TOGGLE_LEARNING', accountId: id, kind: 'both' }), ACCOUNT_B);
  console.log(`   后台原始拒绝响应：${JSON.stringify(rejectedRaw)}`);
  check('c2. 后台原始响应也是 ok:false，并给出同站互斥原因',
    rejectedRaw?.ok === false && /同站点只能有一条录制/.test(rejectedRaw?.error ?? ''),
    JSON.stringify(rejectedRaw));

  const duringC = await learningSessions();
  console.log(`   A 会话预览条数=${duringC[0]?.preview?.length ?? 'n/a'} eventCount=${duringC[0]?.eventCount ?? 'n/a'}`);
  check('c3. 拒绝 B 之后 A 的学习会话原样健在（只有一个、属于 A）',
    duringC.length === 1 && duringC[0].accountId === ACCOUNT_A,
    `sessions=${JSON.stringify(duringC.map((item) => ({ accountId: item.accountId, kind: item.kind })))}`);

  // A 继续正常演示并结束
  await demonstrateCheckinOnLearningPage(learnPageC, {
    username: FIXTURE_SENTINEL_USERNAME,
    password: FIXTURE_SENTINEL_PASSWORD,
    viaProfile: true,
  });
  await finishLearning(rowA, ACCOUNT_A);
  const workflowC = await waitForWorkflow(30_000, workflowB);
  const afterC = await readState();
  const sessionsAfterC = await learningSessions();
  check('c4. A 的学习会话不受影响，正常结束并保存',
    sessionsAfterC.length === 0
      && JSON.stringify(workflowFieldsOf(afterC.accounts)) === '[]'
      && afterC.sites.filter((site) => site.checkin?.workflow).length === 1
      && (workflowC.steps?.length ?? 0) > 0,
    `sessions=${sessionsAfterC.length} siteWorkflows=${afterC.sites.filter((site) => site.checkin?.workflow).length} accountWorkflowFields=${JSON.stringify(workflowFieldsOf(afterC.accounts))}`);

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
