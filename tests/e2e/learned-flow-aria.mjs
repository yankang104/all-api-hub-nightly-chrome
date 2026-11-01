/**
 * 工作方 E：图标按钮（名称只在 aria-label）的 `text=` 选择器修复 —— 真实浏览器端到端验收。
 *
 * 背景：orevx.ai 的三个第三方登录按钮是**纯图标按钮**（innerText 为空），名称只在
 * `aria-label="Sign in with Google"` 上。学习侧从 aria-label 生成 `text=` 选择器，
 * 而回放侧旧版 `queryByText` 只匹配 innerText → 学到的选择器永远解析不到。
 * 修复后 dom-utils 的匹配文本按「可见文字 → aria-label → title」依次取值。
 *
 * 本脚本在纯虚构的 localhost 站点（learned-flow-fixture.mjs，本批新增纯图标 SSO 场景）上，
 * 用隔离构建的 WXT 产物（output/learned-flow-acceptance/aria-e2e/wxt-out）真实走一遍：
 *
 *   1) 账号行只有一个「学习本站流程」入口（kind=both），录制中同一按钮动态变为「结束学习」；
 *   2) 不结束会话：先勾选协议并点击 aria-label-only SSO 图标，沿本地假 OAuth
 *      （/oauth/start → /oauth/callback → /console）登录，确认 OAuth 事件已录入但还未保存；
 *   3) 在同一个学习会话里继续演示 /console → /profile → /checkin 并点签到图标，
 *      最后只点一次动态「结束学习」按钮，同时保存 loginMethod=oauth 与站点签到 workflow；
 *   4) 回放：清空全部 Cookie 后 START_LOGIN。引擎必然走 OAuth 分支：
 *      先由 ensureLoginConsent 勾选协议（解除图标按钮 disabled），再由回放侧
 *      `queryFirst('text=Sign in with Example SSO')` 在**真实 DOM** 上解析到该图标按钮并
 *      真实点击 —— 证据为引擎日志 + fixture 请求记录（/api/consent → /oauth/start →
 *      /oauth/callback → 会话建立），最后沿学习路线完成签到。
 *
 * 隔离措施：独立 outDir 构建、独立 profile 前缀（aria-learned-flow-）、仅 127.0.0.1
 * 虚构站点与虚构账号（sentinel_…），不访问任何真实站点。断言来源=扩展存储 + 页面 DOM +
 * 虚构站请求日志，无截图驱动。
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
  FIXTURE_SSO_LABEL,
  FIXTURE_CHECKIN_LABEL,
} from './learned-flow-fixture.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ACCEPTANCE = join(REPO, 'output', 'learned-flow-acceptance');
const ARIA_ROOT = join(ACCEPTANCE, 'aria-e2e');
const EXT = process.env.EXTENSION_DIR
  ? resolve(REPO, process.env.EXTENSION_DIR)
  : join(ARIA_ROOT, 'wxt-out', 'chrome-mv3');
const PROFILE_ROOT = join(ARIA_ROOT, 'profiles');
const PROFILE_PREFIX = 'aria-learned-flow-';
const HEADLESS = process.env.E2E_HEADLESS !== '0';
const SITE_ID = 'aria-fixture';
const SITE_NAME = 'ARIA 图标按钮验收站';
// 期望的学习产物：多词、含空格的 text= 选择器（来自 aria-label —— 修复的核心场景）
const SSO_SELECTOR = `text=${FIXTURE_SSO_LABEL}`;
const SSO_BUTTON_CSS = `button[aria-label="${FIXTURE_SSO_LABEL}"]`;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? `  — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// 只清理本脚本自己创建的 profile（前缀 aria-learned-flow-）。
mkdirSync(PROFILE_ROOT, { recursive: true });
for (const name of readdirSync(PROFILE_ROOT)) {
  if (name.startsWith(PROFILE_PREFIX)) rmSync(join(PROFILE_ROOT, name), { recursive: true, force: true });
}
const profile = mkdtempSync(join(PROFILE_ROOT, PROFILE_PREFIX));

const fixture = await startFixture();
const origin = fixture.origin;
console.log(`fixture origin: ${origin}`);
console.log(`extension dir:  ${EXT}`);

const context = await chromium.launchPersistentContext(profile, {
  headless: HEADLESS,
  // 与 tests/e2e/e2e.mjs 相同：headless 下用 chromium 通道，扩展才会真正加载。
  ...(HEADLESS ? { channel: 'chromium' } : {}),
  viewport: { width: 1280, height: 960 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

// 收集页面 console / 未捕获错误，仅在回放未达终态时打印，便于定位环境级抖动。
const pageLogs = [];
context.on('page', (page) => {
  page.on('console', (message) => pageLogs.push(`[console:${message.type()}] ${message.text()}`));
  page.on('pageerror', (error) => pageLogs.push(`[pageerror] ${error.message}`));
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
      await sleep(200);
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

  async function waitForQueueIdle(timeout = 12000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const queue = await app.evaluate(async () => (await chrome.storage.session.get('checkinQueue')).checkinQueue).catch(() => null);
      if (!queue?.active && !(queue?.pendingAccountIds?.length > 0)) return true;
      await sleep(150);
    }
    return false;
  }

  const learningSessions = async () =>
    app.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'GET_LEARNING' }))?.feature?.learningSessions ?? []);

  /** 在扩展的录制信箱（storage.session）里找 loginAction=oauth 的 click 学习事件（页面侧谓词）。 */
  const findOAuthLearningClick = async () => {
    const values = Object.values(await chrome.storage.session.get(null));
    for (const value of values) {
      for (const event of value?.events ?? []) {
        if (event?.type === 'click' && event?.loginAction === 'oauth') {
          return {
            type: event.type,
            selector: event.selector ?? null,
            label: event.label ?? null,
            loginAction: event.loginAction ?? null,
            path: event.path ?? null,
            href: event.href ?? null,
          };
        }
      }
    }
    return false;
  };

  // ── 0. 种入站点与账号 ──────────────────────────────────────────────
  await app.evaluate(async ({ origin, siteId, siteName }) => {
    await chrome.storage.local.set({
      sites: [{
        id: siteId,
        name: siteName,
        loginUrl: `${origin}/login`,
        successIndicator: '#logged-in',
        // 与 UI 新建站点（blankSite）一致：selectors 始终是对象。
        // 这里故意用与页面不匹配的 #seed- 前缀占位值（等价于用户配置了过时选择器）：
        // 既贴近真实站点形态，也让「OAuth 学习不得改写既有 selectors」的断言可判别。
        selectors: { username: '#seed-username', password: '#seed-password', submit: '#seed-submit' },
        closeModalSelectors: [],
        checkin: { method: 'auto', url: '/console' },
        adapter: { family: 'new-api', siteType: 'new-api', quotaPerUnit: 500000 },
      }],
      accounts: [{
        id: 'bob',
        siteId,
        username: 'sentinel_a44f9',
        password: 'sentinel_pw_zz77',
        label: '验收账号',
      }],
      proxies: [],
      status: {},
      results: {},
      balances: {},
    });
  }, { origin, siteId: SITE_ID, siteName: SITE_NAME });
  await app.reload();
  await app.getByPlaceholder('搜索站点、账号或备注').waitFor();
  await app.locator('section a', { hasText: SITE_NAME }).first().waitFor();
  const beforeLearn = await readState();
  check('学习前站点没有已保存的登录方式与签到流程',
    !beforeLearn.sites.find((site) => site.id === SITE_ID)?.loginMethod
    && !beforeLearn.sites.find((site) => site.id === SITE_ID)?.checkin?.workflow);

  // ── 1. 单一融合入口：同一会话先学 OAuth 登录，再学签到 ──────────────
  console.log('\n── 单一「学习本站流程」入口：OAuth 登录 + 签到同一会话 ──');
  await app.getByRole('button', { name: `展开账号 ${SITE_NAME}` }).click();
  const bob = app.locator('[data-account-id="bob"]');
  await bob.waitFor();
  const learnEntry = bob.getByRole('button', { name: /学习本站登录与签到流程/ });
  const legacyLoginEntry = bob.getByRole('button', { name: /学习本站通用登录流程/ });
  const legacyCheckinEntry = bob.getByRole('button', { name: '学习本站签到流程' });
  check('账号行只有一个「学习本站流程」融合主入口，没有分开的登录/签到入口',
    (await learnEntry.count()) === 1
    && (await bob.getByText('学习本站流程', { exact: true }).count()) === 1
    && (await legacyLoginEntry.count()) === 0
    && (await legacyCheckinEntry.count()) === 0);
  const learnEntryElement = await learnEntry.elementHandle();
  assert.ok(learnEntryElement, '融合学习主按钮必须存在');
  // 在扩展页里保留按钮节点引用，之后既核对动态名称，也证明录制/结束是同一 DOM 按钮。
  await learnEntryElement.evaluate((button) => { window.__ariaUnifiedLearnEntry = button; });

  const learningTabPromise = context.waitForEvent('page');
  await learnEntry.click();
  const learningSession = await waitForApp(async () => {
    const sessions = (await chrome.runtime.sendMessage({ type: 'GET_LEARNING' }))?.feature?.learningSessions ?? [];
    return sessions.find((session) => session.kind === 'both') ?? false;
  }, 15000, '融合登录与签到学习会话');
  const learnPage = await learningTabPromise;
  await learnPage.waitForURL((url) => url.pathname === '/login', { timeout: 15000 });
  const endButtonDuringLearning = bob.getByRole('button', { name: '结束学习并保存登录与签到流程' });
  const activeButtonState = await endButtonDuringLearning.evaluate((button) => ({
    text: button.textContent?.trim() ?? '',
    ariaLabel: button.getAttribute('aria-label') ?? '',
    sameNode: button === window.__ariaUnifiedLearnEntry,
  })).catch(() => null);
  check('kind=both 会话打开学习页，原主按钮动态变为「结束学习」',
    learnPage.url().startsWith(origin)
    && learningSession.kind === 'both'
    && (await endButtonDuringLearning.count()) === 1
    && activeButtonState?.text === '结束学习'
    && activeButtonState?.ariaLabel === '结束学习并保存登录与签到流程'
    && activeButtonState?.sameNode === true,
    `kind=${learningSession.kind} button=${JSON.stringify(activeButtonState)} url=${learnPage.url()}`);

  // 图标按钮的形态：无可见文字、名称只在 aria-label、协议勾选前 disabled。
  const ssoInfo = await learnPage.evaluate((selector) => {
    const btn = document.querySelector(selector);
    if (!btn) return null;
    return {
      tag: btn.tagName,
      innerText: btn.innerText,
      textContent: btn.textContent,
      ariaLabel: btn.getAttribute('aria-label'),
      disabled: btn.disabled,
      id: btn.id,
      nameAttr: btn.getAttribute('name'),
      testid: btn.getAttribute('data-testid'),
    };
  }, SSO_BUTTON_CSS);
  assert.ok(ssoInfo, '图标按钮必须存在于学习页');
  check('图标按钮没有可见文字（innerText/textContent 为空）',
    ssoInfo.innerText.trim() === '' && ssoInfo.textContent.trim() === '',
    `innerText=${JSON.stringify(ssoInfo.innerText)}`);
  check('图标按钮名称只在 aria-label（无 id/name/data-testid）',
    ssoInfo.ariaLabel === FIXTURE_SSO_LABEL && ssoInfo.id === '' && ssoInfo.nameAttr === null && ssoInfo.testid === null,
    `aria-label=${JSON.stringify(ssoInfo.ariaLabel)} id=${JSON.stringify(ssoInfo.id)}`);
  check('勾选协议前图标按钮 disabled', ssoInfo.disabled === true);

  // 对照证据：旧实现（只匹配 innerText）在真实页面上 0 命中 → 修复针对的缺口复现。
  const legacyHits = await learnPage.evaluate((label) => {
    const scope = 'button, a, [role="button"], input[type="submit"]';
    const needle = label.toLowerCase();
    return [...document.querySelectorAll(scope)]
      .filter((el) => (el.innerText ?? '').trim().toLowerCase().includes(needle)).length;
  }, FIXTURE_SSO_LABEL);
  const fixedSourceHits = await learnPage.evaluate((label) => {
    const scope = 'button, a, [role="button"], input[type="submit"]';
    const needle = label.toLowerCase();
    return [...document.querySelectorAll(scope)].filter((el) => {
      const texts = [
        (el.innerText ?? '').trim(),
        el.getAttribute('aria-label')?.trim() ?? '',
        el.getAttribute('title')?.trim() ?? '',
      ];
      return texts.some((text) => text && text.toLowerCase().includes(needle));
    }).length;
  }, FIXTURE_SSO_LABEL);
  check('对照：旧匹配源（innerText）0 命中，新匹配源（innerText→aria-label→title）1 命中',
    legacyHits === 0 && fixedSourceHits === 1, `legacyHits=${legacyHits} fixedSourceHits=${fixedSourceHits}`);

  await learnPage.click('#agree-terms');
  await learnPage.waitForFunction(
    (selector) => document.querySelector(selector)?.disabled === false,
    SSO_BUTTON_CSS,
    { timeout: 5000 },
  );
  check('勾选协议后图标按钮解除 disabled', true);

  await learnPage.click(SSO_BUTTON_CSS);
  await learnPage.waitForURL((url) => url.pathname === '/console', { timeout: 15000 });
  await learnPage.waitForSelector('#logged-in');
  check('点击图标按钮完成例示登录（假 OAuth 环路 → /console）', true, learnPage.url());

  const oauthEvent = await waitForApp(findOAuthLearningClick, 15000, '融合学习会话中的 OAuth 事件');
  assert.ok(oauthEvent, '学习会话中必须有 loginAction=oauth 的点击事件');
  console.log(`   学习事件: ${JSON.stringify(oauthEvent)}`);
  check('学习阶段录到 text= 选择器（来自 aria-label，多词含空格）',
    oauthEvent.selector === SSO_SELECTOR, oauthEvent.selector);
  const sessionAfterOAuth = await waitForApp(async () => {
    const sessions = (await chrome.runtime.sendMessage({ type: 'GET_LEARNING' }))?.feature?.learningSessions ?? [];
    return sessions.find((session) => session.kind === 'both' && session.eventCount > 0) ?? false;
  }, 15000, 'OAuth 后仍在录制的融合会话');
  const storedDuringLearning = (await readState()).sites.find((site) => site.id === SITE_ID);
  check('OAuth 点击录为 loginAction=oauth；同一 kind=both 会话仍在，且登录/签到均未提前保存',
    oauthEvent.loginAction === 'oauth'
    && sessionAfterOAuth.kind === 'both'
    && !storedDuringLearning?.loginMethod
    && !storedDuringLearning?.checkin?.workflow,
    `event=${oauthEvent.loginAction} kind=${sessionAfterOAuth.kind} storedLogin=${storedDuringLearning?.loginMethod ?? 'none'} workflow=${!!storedDuringLearning?.checkin?.workflow}`);

  // ── 2. 不结束/不另开会话，继续在同一标签页演示签到 ───────────────────
  console.log('\n── 同一融合会话继续演示签到 ──');
  const fixtureTab = context.pages().find((page) => page.url().startsWith(origin));
  assert.ok(fixtureTab, 'OAuth 登录后的融合学习标签页仍然存在');

  await fixtureTab.click('#nav-profile');
  await fixtureTab.waitForURL((url) => url.pathname === '/profile', { timeout: 10000 });
  await fixtureTab.waitForSelector('#profile-account');
  await fixtureTab.click('#nav-checkin');
  await fixtureTab.waitForURL((url) => url.pathname === '/checkin', { timeout: 10000 });
  await fixtureTab.waitForSelector('#checkin-card');
  // 新版签到页是长页面、底部为纯图标按钮（aria-label=签到）：先滚动到按钮再点击。
  await fixtureTab.mouse.move(640, 480);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const inView = await fixtureTab.evaluate((label) => {
      const rect = document.querySelector(`button[aria-label="${label}"]`).getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= window.innerHeight;
    }, FIXTURE_CHECKIN_LABEL);
    if (inView) break;
    await fixtureTab.mouse.wheel(0, 900);
    await fixtureTab.waitForTimeout(250);
  }
  await fixtureTab.locator(`button[aria-label="${FIXTURE_CHECKIN_LABEL}"]`).click();
  await fixtureTab.waitForFunction(() => document.body.textContent.includes('签到成功'), null, { timeout: 10000 });

  // 此处才结束学习：通过录制中动态可访问名称定位同一融合主按钮，整场只保存一次。
  const endLearningButton = bob.getByRole('button', { name: '结束学习并保存登录与签到流程' });
  const endLearningButtonState = await endLearningButton.evaluate((button) => ({
    text: button.textContent?.trim() ?? '',
    ariaLabel: button.getAttribute('aria-label') ?? '',
    sameNode: button === window.__ariaUnifiedLearnEntry,
  })).catch(() => null);
  const endLearningButtonCount = await endLearningButton.count();
  await endLearningButton.click();
  const siteAfterLearned = await waitForApp(async () => {
    const sites = (await chrome.storage.local.get('sites')).sites ?? [];
    const site = sites.find((item) => item.id === 'aria-fixture');
    return site?.loginMethod === 'oauth' && site?.checkin?.method === 'workflow'
      && site?.checkin?.workflow?.steps?.length > 0 ? site : false;
  }, 15000, '融合学习一次性保存登录与签到流程');
  const sessionsAfterSave = await learningSessions();
  const workflow = siteAfterLearned.checkin?.workflow ?? {};
  const route = workflow.route ?? [];
  const steps = workflow.steps ?? [];
  console.log(`   saved route: ${JSON.stringify(route)}`);
  console.log(`   identityPath: ${JSON.stringify(workflow.identityPath)}`);
  console.log(`   saved loginMethod=${siteAfterLearned.loginMethod} checkinMethod=${siteAfterLearned.checkin?.method} activeLearningSessions=${sessionsAfterSave.length}`);
  console.log(`   end button: ${JSON.stringify(endLearningButtonState)} count=${endLearningButtonCount}`);
  console.log(`   OAuth selectors: oauth=${JSON.stringify(siteAfterLearned.oauthButtonSelector)} preLogin=${JSON.stringify(siteAfterLearned.preLoginClickSelector)}`);
  check('动态「结束学习」主按钮唯一且与开始按钮相同；一次保存 OAuth 登录和签到流程',
    endLearningButtonCount === 1
    && endLearningButtonState?.text === '结束学习'
    && endLearningButtonState?.ariaLabel === '结束学习并保存登录与签到流程'
    && endLearningButtonState?.sameNode === true
    && siteAfterLearned.loginMethod === 'oauth'
    && siteAfterLearned.checkin?.method === 'workflow'
    && steps.length > 0
    && sessionsAfterSave.length === 0,
    `login=${siteAfterLearned.loginMethod} checkin=${siteAfterLearned.checkin?.method} steps=${steps.length} sessions=${sessionsAfterSave.length}`);
  check('学习产物 oauthButtonSelector 正是 text=Sign in with Example SSO（多词含空格）',
    siteAfterLearned.oauthButtonSelector === SSO_SELECTOR, JSON.stringify(siteAfterLearned.oauthButtonSelector));
  check('协议勾选未被误学成前置入口（preLoginClickSelector 为空）',
    (siteAfterLearned.preLoginClickSelector ?? '') === '', JSON.stringify(siteAfterLearned.preLoginClickSelector));
  check('OAuth 学习未改写既有账密选择器（仍是种入的占位值）',
    siteAfterLearned.selectors?.username === '#seed-username'
    && siteAfterLearned.selectors?.password === '#seed-password'
    && siteAfterLearned.selectors?.submit === '#seed-submit',
    JSON.stringify(siteAfterLearned.selectors ?? null));
  check('融合学习产物不含输入值 sentinel',
    !JSON.stringify(siteAfterLearned).includes(FIXTURE_SENTINEL_PASSWORD));
  check('保存的 route 末项是签到页 /checkin', route.at(-1) === '/checkin', JSON.stringify(route));
  check('identityPath 指向独立资料页 /profile', workflow.identityPath === '/profile', JSON.stringify(workflow.identityPath));
  // 学到的签到点击步骤：选择器在真实 DOM 上解析到图标按钮（旧版 #checkin-btn 已随长页面改版移除）。
  const flatSteps = (function flatten(list) {
    const out = [];
    for (const step of list ?? []) {
      if (!step || typeof step !== 'object') continue;
      out.push(step);
      if (Array.isArray(step.then)) out.push(...flatten(step.then));
      if (Array.isArray(step.else)) out.push(...flatten(step.else));
    }
    return out;
  })(steps);
  const terminalClick = flatSteps.filter((step) => step.type === 'click').at(-1);
  const resolvesToIconButton = await fixtureTab.evaluate(({ selector, label }) => {
    function isVisible(el) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }
    function matchText(el, needle) {
      const texts = [(el.innerText ?? '').trim(), el.getAttribute('aria-label')?.trim() ?? '', el.getAttribute('title')?.trim() ?? ''];
      return texts.some((text) => text && text.toLowerCase().includes(needle));
    }
    const icon = document.querySelector(`button[aria-label="${label}"]`);
    const matched = String(selector).startsWith('text=')
      ? [...document.querySelectorAll('button, a, [role="button"], input[type="submit"]')].filter(isVisible).filter((el) => matchText(el, String(selector).slice('text='.length).trim().toLowerCase()))
      : [...document.querySelectorAll(String(selector))].filter(isVisible);
    return matched[0] === icon;
  }, { selector: terminalClick?.selector ?? '', label: FIXTURE_CHECKIN_LABEL });
  check('步骤来自真实演示（签到点击步骤选择器解析到图标按钮）',
    resolvesToIconButton === true, `selector=${JSON.stringify(terminalClick?.selector)}`);
  check('融合签到流程步骤只来自学习演示且没有输入值 sentinel',
    !JSON.stringify(workflow).includes(FIXTURE_SENTINEL_PASSWORD));

  // ── 3. 回放：清空 Cookie 后必须走「勾选协议 → 点击图标按钮」─────────
  async function closeOriginTabs() {
    for (const page of context.pages()) {
      if (page.url().startsWith(origin)) await page.close().catch(() => {});
    }
  }
  const cookieUser = async () =>
    (await context.cookies(origin)).find((cookie) => cookie.name === 'fixture_user')?.value;

  console.log('\n── 回放：OAuth 图标按钮 ──');
  await waitForQueueIdle();
  await closeOriginTabs();
  await context.clearCookies();
  fixture.reset();
  await app.evaluate(async () => { await chrome.storage.local.set({ status: {}, results: {} }); });
  check('回放前浏览器无本站会话（确保必须重新走 OAuth 登录）', (await context.cookies(origin)).length === 0);

  const started = await app.evaluate(() => chrome.runtime.sendMessage({ type: 'START_LOGIN', accountId: 'bob' }));
  check('START_LOGIN 入队', started?.ok === true && started?.queued === 1, JSON.stringify(started));

  const deadline = Date.now() + 150000;
  let state = await readState();
  while (Date.now() < deadline) {
    state = await readState();
    if (['done', 'failed', 'attention'].includes(accountStatus(state, 'bob'))) break;
    await sleep(300);
  }
  await sleep(800);
  state = await readState();
  await waitForQueueIdle();

  const status = accountStatus(state, 'bob');
  const result = state.results?.bob;
  const replaySteps = result?.steps ?? [];
  console.log(`   状态=${status}`);
  console.log(`   说明=${result?.message ?? 'n/a'}`);
  for (const [index, step] of replaySteps.entries()) console.log(`   ${index + 1}. ${step}`);

  // 未达终态时输出诊断：跨页任务的实时步骤存在 storage.session 的 task:<tabId> 信箱里。
  if (status !== 'done') {
    const diag = await app.evaluate(async () => {
      const all = await chrome.storage.session.get(null);
      const tasks = Object.entries(all)
        .filter(([key]) => key.startsWith('task:'))
        .map(([key, value]) => ({ key, stage: value?.stage ?? null, steps: value?.steps ?? [] }));
      return { tasks, queue: all.checkinQueue ?? null };
    }).catch(() => null);
    console.log('   诊断：storage.session 任务信箱:');
    for (const task of diag?.tasks ?? []) {
      console.log(`   ${task.key} stage=${task.stage} steps=${JSON.stringify(task.steps)}`);
    }
    console.log(`   诊断：队列=${JSON.stringify(diag?.queue ?? null)}`);
    console.log(`   诊断：标签页=${context.pages().map((page) => page.url()).join(' | ')}`);
    if (pageLogs.length) {
      console.log('   诊断：页面 console/错误日志:');
      for (const line of pageLogs.slice(-30)) console.log(`   ${line}`);
    }
  }

  const events = fixture.events();
  console.log('   fixture 请求顺序: ' + events
    .map((event) => `${event.method} ${event.path}${event.user ? `(user=${event.user})` : ''}`)
    .join(' → '));
  const loginIdx = events.findIndex((event) => event.method === 'GET' && event.path === '/login');
  const consentIdx = events.findIndex((event) => event.method === 'POST' && event.path === '/api/consent');
  const oauthStartIdx = events.findIndex((event) => event.method === 'GET' && event.path === '/oauth/start');
  const oauthCbIdx = events.findIndex((event) => event.method === 'GET' && event.path === '/oauth/callback' && !event.user);
  const consoleIdx = events.findIndex((event) => event.method === 'GET' && event.path === '/console' && event.user === FIXTURE_SENTINEL_USERNAME);
  const identityIdx = events.findIndex((event) => event.path === '/api/user/self' && event.user === FIXTURE_SENTINEL_USERNAME);
  const checkinIdx = events.findIndex((event) => event.method === 'POST' && event.path === '/api/checkin');
  const consentStepIdx = replaySteps.findIndex((step) => step.includes('已勾选登录协议与隐私政策'));
  const oauthClickStepIdx = replaySteps.findIndex((step) => step.includes('已点击 OAuth 按钮'));

  check('[回放] 协议勾选请求先于 OAuth 按钮点击（/login → /api/consent → /oauth/start）',
    loginIdx >= 0 && consentIdx >= 0 && oauthStartIdx > consentIdx && consentIdx > loginIdx,
    `login#${loginIdx} consent#${consentIdx} oauthStart#${oauthStartIdx}`);
  check('[回放] 回放侧 queryFirst 用学到的 text= 选择器在真实 DOM 解析到图标按钮（引擎日志）',
    oauthClickStepIdx >= 0 && replaySteps[oauthClickStepIdx].includes(FIXTURE_SSO_LABEL),
    replaySteps[oauthClickStepIdx] ?? '无「已点击 OAuth 按钮」日志行');
  check('[回放] 图标按钮 onclick 真实执行（fixture 记录 GET /oauth/start，该请求无会话 Cookie）',
    oauthStartIdx >= 0 && !events[oauthStartIdx]?.user, `oauthStart#${oauthStartIdx}`);
  check('[回放] 假 OAuth 环路完成：callback 通过校验并建立 sentinel 会话',
    oauthCbIdx >= 0 && consoleIdx > oauthCbIdx, `callback#${oauthCbIdx} console#${consoleIdx}`);
  check('[回放] 引擎日志顺序：先勾选协议、后点击 OAuth 按钮',
    consentStepIdx >= 0 && oauthClickStepIdx > consentStepIdx,
    `勾选#${consentStepIdx} 点击#${oauthClickStepIdx}`);
  check('[回放] OAuth 授权完成并跳回本站（引擎日志）',
    replaySteps.some((step) => step.includes('OAuth 授权完成，已跳回本站')),
    replaySteps.find((step) => step.includes('OAuth 授权完成')) ?? '无该日志行');
  check('[回放] 终点前经过个人资料页身份核验（引擎日志）',
    replaySteps.some((step) => step.includes('个人资料页已核对账号身份'))
    && replaySteps.some((step) => step.includes('工作流已点击')),
    replaySteps.find((step) => step.includes('个人资料页已核对账号身份')) ?? '无核验日志行');
  check('[回放] 终态 done', status === 'done', `status=${status}`);
  check('[回放] 恰好签到一次', fixture.claimCount() === 1, `claims=${fixture.claimCount()}`);
  check('[回放] 签到发生在资料页身份读取之后（请求顺序）',
    identityIdx >= 0 && checkinIdx > identityIdx, `identitySelf#${identityIdx} checkin#${checkinIdx}`);
  check('[回放] 回放结束时浏览器会话是验收账号',
    (await cookieUser()) === FIXTURE_SENTINEL_USERNAME, `cookie=${await cookieUser()}`);

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
