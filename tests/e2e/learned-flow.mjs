/**
 * 真实隔离浏览器端到端验收：一次融合学习登录与签到 → 统一保存 → 回放。
 *
 * 加载 WXT 构建产物（默认 output/learned-flow-acceptance/wxt-out/chrome-mv3），
 * 在纯虚构的 localhost 站点（learned-flow-fixture.mjs）上完整走一遍：
 *
 *   1) UI 入口：每个账号行用「学习本站流程」一次开始 kind=both；
 *   2) 同一学习标签页里手动演示账密登录、资料页身份核验与签到，不在登录后提前结束或保存；
 *   3) 签到页是**长页面**，签到按钮（纯图标 `<button aria-label="签到">`，无可见文字）
 *      在首屏之外，演示流程 = 滚动到按钮 → 拖拽把手（松手后浏览器补发 click，必须被过滤）
 *      → 点击按钮 → 在同一账号行点「结束学习」一次 → 断言登录配置和工作流一起保存，route 含签到页、
 *      且没有任何步骤指向拖拽把手（选择器在真实 DOM 上核实指向图标按钮）；
 *   4) 回放 S1 已登录复用：不再登录，直接核验资料页后签到；
 *   5) 回放 S2 从未登录：自动登录 → 资料页核验 → 签到；
 *   6) 回放 S3 错号重登：浏览器里是别人的会话 → 退出重登 → 资料页核验 → 签到。
 *
 * 断言来源：扩展存储（sites/results/status）、页面 DOM 文本、虚构站请求日志
 * （签到 POST 必须出现在资料页身份读取之后）。不做截图驱动。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  startFixture,
  FIXTURE_USERS,
  FIXTURE_SENTINEL_USERNAME,
  FIXTURE_SENTINEL_PASSWORD,
  FIXTURE_ALICE_USERNAME,
  FIXTURE_ALICE_PASSWORD,
  FIXTURE_CHECKIN_LABEL,
  FIXTURE_KNOB_ID,
  FIXTURE_KNOB_LABEL,
} from './learned-flow-fixture.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ACCEPTANCE = join(REPO, 'output', 'learned-flow-acceptance');
const EXT = process.env.EXTENSION_DIR
  ? resolve(REPO, process.env.EXTENSION_DIR)
  : join(ACCEPTANCE, 'wxt-out', 'chrome-mv3');
const PROFILE_ROOT = join(ACCEPTANCE, 'profiles');
const HEADLESS = process.env.E2E_HEADLESS !== '0';
const SITE_ID = 'learn-fixture';

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

/** 学习到的「签到点击」步骤选择器：回放断言与 DOM 核实共同引用。 */
let learnedButtonSelector = null;

// 只清理本脚本自己创建的 profile（前缀 learned-flow-）。
mkdirSync(PROFILE_ROOT, { recursive: true });
for (const name of readdirSync(PROFILE_ROOT)) {
  if (name.startsWith('learned-flow-')) rmSync(join(PROFILE_ROOT, name), { recursive: true, force: true });
}
const profile = mkdtempSync(join(PROFILE_ROOT, 'learned-flow-'));

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

  async function waitForQueueIdle(timeout = 12000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const queue = await app.evaluate(async () => (await chrome.storage.session.get('checkinQueue')).checkinQueue).catch(() => null);
      if (!queue?.active && !(queue?.pendingAccountIds?.length > 0)) return true;
      await new Promise((done) => setTimeout(done, 150));
    }
    return false;
  }

  async function learningSessions() {
    return app.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'GET_LEARNING' }))?.feature?.learningSessions ?? []);
  }

  // ── 0. 种入站点与账号 ──────────────────────────────────────────────
  await app.evaluate(async ({ origin, siteId }) => {
    await chrome.storage.local.set({
      sites: [{
        id: siteId,
        name: '学习验收站',
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
        label: '验收账号',
      }],
      proxies: [],
      status: {},
      results: {},
      balances: {},
    });
  }, { origin, siteId: SITE_ID });
  await app.reload();
  await app.getByPlaceholder('搜索站点、账号或备注').waitFor();
  await app.locator('section a', { hasText: '学习验收站' }).first().waitFor();
  const beforeLearn = await readState();
  check('学习前站点没有已保存的签到流程', !beforeLearn.sites.find((site) => site.id === SITE_ID)?.checkin?.workflow);

  // ── 1. UI 入口：只通过统一融合按钮开始一次登录+签到学习 ─────────────
  await app.getByRole('button', { name: '展开账号 学习验收站' }).click();
  const bob = app.locator('[data-account-id="bob"]');
  await bob.waitFor();
  // 用 button 的可见文本定位；不依赖正在演进中的 aria-label/title 细节。
  const fusedEntry = bob.locator('button').filter({ hasText: '学习本站流程' });
  const fusedTitle = await fusedEntry.getAttribute('title') ?? '';
  check('账号行有且只有一个「学习本站流程」融合入口', (await fusedEntry.count()) === 1);
  check('融合入口说明一次演示登录后继续完成签到并统一结束',
    /先手动登录/.test(fusedTitle) && /完成一次签到/.test(fusedTitle) && /结束学习/.test(fusedTitle));
  check('融合入口说明两份产物共用站点且不保存账号密码内容',
    /本站账号共用/.test(fusedTitle) && /不保存账号或密码内容/.test(fusedTitle));
  check('融合学习入口有可见文字（不是纯图标）', (await fusedEntry.textContent())?.includes('学习本站流程') === true);

  // ── 2. 融合学习：一次启动，同一会话先登录 ───────────────────────────
  console.log('\n── 融合学习（同一会话：手动登录 → 资料页核验 → 签到）──');
  const learningTabPromise = context.waitForEvent('page');
  await fusedEntry.click();
  const fusedLearning = await waitForApp(async () => {
    const sessions = (await chrome.runtime.sendMessage({ type: 'GET_LEARNING' }))?.feature?.learningSessions ?? [];
    return sessions.find((session) => session.kind === 'both') ?? false;
  }, 15000, '登录与签到融合学习会话');
  const learnPage = await learningTabPromise;
  await learnPage.waitForURL((url) => url.pathname === '/login', { timeout: 15000 });
  await learnPage.fill('#username', FIXTURE_SENTINEL_USERNAME);
  await learnPage.fill('#password', FIXTURE_SENTINEL_PASSWORD);
  await learnPage.click('#login-submit');
  await learnPage.waitForURL((url) => url.pathname === '/console', { timeout: 15000 });
  await learnPage.waitForSelector('#logged-in');
  check('学习页已按站点地址打开且完成一次手动登录', learnPage.url().startsWith(origin), learnPage.url());

  await waitForApp(async () => {
    const values = Object.values(await chrome.storage.session.get(null));
    return values.some((value) => value?.events?.some((event) => event.type === 'fill' && event.fieldRole === 'username'))
      && values.some((value) => value?.events?.some((event) => event.type === 'fill' && event.fieldRole === 'password'));
  }, 15000, '登录填充事件');
  const loginSession = (await learningSessions()).find((session) => session.kind === 'both');
  check('同一次融合学习真实录制到登录动作', fusedLearning?.kind === 'both' && loginSession?.kind === 'both'
    && (loginSession?.eventCount ?? 0) >= 3,
  `kind=${loginSession?.kind} eventCount=${loginSession?.eventCount}`);

  // ── 3. 同一融合会话继续学习签到（长页面 + 纯图标按钮 + 拖拽把手） ─
  console.log('\n── 同一融合会话继续签到（长页面滚动 + 纯图标按钮 + 拖拽把手）──');
  const fixtureTab = context.pages().find((page) => page.url().startsWith(origin));
  assert.ok(fixtureTab, '学习登录后的站点标签页仍然存在');
  const activeFusedSession = (await learningSessions()).find((session) => session.accountId === 'bob');
  check('登录后仍在原学习标签页继续演示且融合会话没有提前结束或保存',
    fixtureTab === learnPage && fixtureTab.url().startsWith(origin) && activeFusedSession?.kind === 'both',
    `sameTab=${fixtureTab === learnPage} url=${fixtureTab.url()} kind=${activeFusedSession?.kind}`);

  // 演示：控制台 → 个人资料页（核验身份）→ 签到页（长页面）
  await fixtureTab.click('#nav-profile');
  await fixtureTab.waitForURL((url) => url.pathname === '/profile', { timeout: 10000 });
  await fixtureTab.waitForSelector('#profile-account');
  await fixtureTab.click('#nav-checkin');
  await fixtureTab.waitForURL((url) => url.pathname === '/checkin', { timeout: 10000 });
  await fixtureTab.waitForSelector('#checkin-card');

  const checkinButton = fixtureTab.locator(`button[aria-label="${FIXTURE_CHECKIN_LABEL}"]`);
  check('签到按钮是纯图标按钮（无可见文字，名称只在 aria-label）',
    await checkinButton.evaluate((el) => (el.innerText ?? '').trim() === '' && el.getAttribute('aria-label') === '签到'));

  // 真实几何：首屏看不到签到按钮（按钮在页面 ~1600px 处）。
  const initialGeometry = await fixtureTab.evaluate((label) => {
    const rect = document.querySelector(`button[aria-label="${label}"]`).getBoundingClientRect();
    return {
      top: Math.round(rect.top),
      bottom: Math.round(rect.bottom),
      innerHeight: window.innerHeight,
      scrollY: Math.round(window.scrollY),
    };
  }, FIXTURE_CHECKIN_LABEL);
  check('签到按钮首屏不可见（真实几何：需滚动才可见）',
    initialGeometry.top >= initialGeometry.innerHeight,
    `top=${initialGeometry.top} innerHeight=${initialGeometry.innerHeight} scrollY=${initialGeometry.scrollY}`);

  // 演示第一步：用户滚动到按钮（真实滚轮输入），直到按钮完整进入视口。
  await fixtureTab.mouse.move(640, 480);
  let buttonInView = false;
  for (let attempt = 0; attempt < 6 && !buttonInView; attempt += 1) {
    await fixtureTab.mouse.wheel(0, 900);
    await fixtureTab.waitForTimeout(250);
    buttonInView = await fixtureTab.evaluate((label) => {
      const rect = document.querySelector(`button[aria-label="${label}"]`).getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= window.innerHeight;
    }, FIXTURE_CHECKIN_LABEL);
  }
  const scrollAfterWheel = await fixtureTab.evaluate(() => Math.round(window.scrollY));
  check('滚动后签到按钮进入视口', buttonInView, `scrollY=${scrollAfterWheel}`);
  check('演示中页面确实被滚过（scrollY>0）', scrollAfterWheel > 0, `scrollY=${scrollAfterWheel}`);
  await fixtureTab.waitForTimeout(350); // 等录制侧滚动去抖（200ms）结算

  // 演示第二步：拖拽把手（按下 → 移动，把手跟随 → 松开）；浏览器随后会补发一次合成 click。
  const knobBox = await fixtureTab.locator(`#${FIXTURE_KNOB_ID}`).boundingBox();
  const knobX = knobBox.x + knobBox.width / 2;
  const knobY = knobBox.y + knobBox.height / 2;
  await fixtureTab.mouse.move(knobX, knobY);
  await fixtureTab.mouse.down();
  await fixtureTab.mouse.move(knobX + 40, knobY, { steps: 4 });
  await fixtureTab.mouse.move(knobX + 80, knobY, { steps: 4 });
  await fixtureTab.mouse.up();
  await fixtureTab.waitForTimeout(250);
  const debugAfterDrag = await fixtureTab.evaluate(() => window.__fixtureDebug);
  check('浏览器在拖拽松手后对把手补发了 click（页面实测，防止空测）',
    debugAfterDrag.knobClicks >= 1, JSON.stringify(debugAfterDrag));

  // 演示第三步：点击纯图标签到按钮（真实指针点击）。
  const buttonBox = await checkinButton.boundingBox();
  await fixtureTab.mouse.click(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2);
  await fixtureTab.waitForFunction(
    () => (document.getElementById('checkin-result')?.textContent ?? '').includes('签到成功'),
    null,
    { timeout: 10000 },
  );
  const debugAfterClick = await fixtureTab.evaluate(() => window.__fixtureDebug);
  check('演示点击落在图标按钮上（页面实测 click 计数）', debugAfterClick.checkinClicks >= 1, JSON.stringify(debugAfterClick));

  await waitForApp(async () => {
    const values = Object.values(await chrome.storage.session.get(null));
    // 注意：本函数在扩展页上下文执行，不能用 Node 侧闭包变量，只能内联字面量。
    return values.some((value) => (value?.events ?? []).some((event) => event?.type === 'click'
      && event?.path === '/checkin'
      && String(event?.selector ?? '').length > 0
      && !String(event.selector).includes('pull-knob')));
  }, 20000, '签到点击事件');

  // 对照实验 B：同一形状的拖拽，但只派发 mouse 事件（无 pointer 族）——单元测试用的正是这种序列。
  // 若它被过滤、而 A（真实输入，pointer+mouse 双族）被录下，差异就指向双族事件处理本身。
  await fixtureTab.evaluate(({ knobId }) => {
    const knob = document.getElementById(knobId);
    const rect = knob.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const fire = (target, type, clientX) => target.dispatchEvent(new MouseEvent(type, {
      bubbles: true, composed: true, clientX, clientY: y,
    }));
    fire(knob, 'mousedown', x);
    fire(window, 'mousemove', x + 120);
    fire(knob, 'mouseup', x + 120);
    fire(knob, 'click', x + 120);
  }, { knobId: FIXTURE_KNOB_ID });
  await fixtureTab.waitForTimeout(400);
  const debugAfterSynthetic = await fixtureTab.evaluate(() => window.__fixtureDebug);
  check('对照实验：两次拖拽都让页面收到了 click（计数=2：A 真实输入 + B 纯 mouse 合成）',
    debugAfterSynthetic.knobClicks === 2, JSON.stringify(debugAfterSynthetic));

  // 原始事件证据（写进报告）：本次学习会话录到的全部 click 事件的 selector / path。
  const rawClickEvents = await app.evaluate(async () => {
    const all = await chrome.storage.session.get(null);
    const out = [];
    for (const value of Object.values(all)) {
      for (const event of value?.events ?? []) {
        if (event?.type === 'click') {
          out.push({
            path: event.path ?? null,
            selector: event.selector ?? null,
            scrollBeforeY: event.scrollBeforeY ?? null,
            scrollPageTop: event.scrollPageTop ?? null,
          });
        }
      }
    }
    return out;
  });
  console.log(`   录到的 click 事件（原始）: ${JSON.stringify(rawClickEvents)}`);
  const checkinSession = (await learningSessions()).find((session) => session.kind === 'both');
  console.log(`   同一融合学习会话 eventCount=${checkinSession?.eventCount}`);
  const knobRecorded = rawClickEvents.filter((event) => String(event.selector ?? '').includes('pull-knob'));
  check('同一融合会话继续真实录制签到动作', checkinSession?.kind === 'both' && (checkinSession?.eventCount ?? 0) >= 6,
    `kind=${checkinSession?.kind} eventCount=${checkinSession?.eventCount}`);
  check('原始事件里录到了对图标按钮的 click（/checkin 页、不是拖拽把手）',
    rawClickEvents.some((event) => event.path === '/checkin' && String(event.selector ?? '').length > 0 && !String(event.selector).includes('pull-knob')),
    JSON.stringify(rawClickEvents.filter((event) => event.path === '/checkin')));
  check('原始事件里没有任何对拖拽把手的 click（真实拖拽的尾巴必须被过滤）',
    knobRecorded.length === 0,
    `#pull-knob 记录数=${knobRecorded.length}；raw=${JSON.stringify(rawClickEvents.map((event) => event.selector))}`);

  // 结束前仍只有一个统一会话；同一个账号行按钮此时显示「结束学习」。
  const finishLearning = bob.locator('button').filter({ hasText: '结束学习' });
  await finishLearning.click();
  await waitForApp(async () => {
    const sites = (await chrome.storage.local.get('sites')).sites ?? [];
    const site = sites.find((item) => item.id === 'learn-fixture');
    return site?.loginMethod === 'form' && site?.checkin?.workflow?.steps?.length > 0 ? site : false;
  }, 15000, '融合学习一次性保存登录配置与签到流程');
  const afterLearn = await readState();
  const learnedSite = afterLearn.sites.find((site) => site.id === SITE_ID);
  const learnedLoginSite = learnedSite;
  const loginSerialized = JSON.stringify(learnedLoginSite);
  const workflow = learnedSite.checkin?.workflow ?? {};
  const route = workflow.route ?? [];
  const steps = workflow.steps ?? [];
  const clickSteps = flattenSteps(steps).filter((step) => step.type === 'click');
  console.log(`   saved route: ${JSON.stringify(route)}`);
  console.log(`   identityPath: ${JSON.stringify(workflow.identityPath)}`);
  console.log(`   steps: ${JSON.stringify(steps)}`);
  console.log(`   click steps: ${JSON.stringify(clickSteps.map((step) => ({ selector: step.selector, scrollIntoView: step.scrollIntoView ?? false })))}`);
  check('一次结束同时保存登录配置、真实学到的账密选择器与签到流程',
    learnedSite.loginMethod === 'form' && /username/.test(learnedLoginSite.selectors?.username ?? '')
      && /password/.test(learnedLoginSite.selectors?.password ?? '') && steps.length > 0,
    `loginMethod=${learnedSite.loginMethod} username=${learnedLoginSite.selectors?.username} password=${learnedLoginSite.selectors?.password} steps=${steps.length}`);
  check('登录学习产物不含输入值 sentinel', !loginSerialized.includes(FIXTURE_SENTINEL_USERNAME) && !loginSerialized.includes(FIXTURE_SENTINEL_PASSWORD));
  check('保存的 route 含签到页 /checkin 且为末项', route.includes('/checkin') && route.at(-1) === '/checkin', JSON.stringify(route));
  check('保存的 route 含个人资料页 /profile', route.includes('/profile'), JSON.stringify(route));
  check('identityPath 指向独立资料页 /profile', workflow.identityPath === '/profile', JSON.stringify(workflow.identityPath));

  // ── 断言（录制侧）：没有任何步骤指向拖拽把手；签到点击步骤指向图标按钮 ──
  const workflowSerialized = JSON.stringify(workflow);
  check('工作流里没有任何步骤指向拖拽把手（pull-knob / 向右拉动）',
    !workflowSerialized.includes(FIXTURE_KNOB_ID) && !workflowSerialized.includes(FIXTURE_KNOB_LABEL),
    workflowSerialized.includes(FIXTURE_KNOB_ID)
      ? `发现指向把手的步骤：${JSON.stringify(clickSteps.map((step) => step.selector))}`
      : '');

  const terminalClick = [...clickSteps].reverse().find((step) => typeof step.selector === 'string' && step.selector.trim() !== '');
  learnedButtonSelector = terminalClick?.selector ?? null;
  console.log(`   学到的签到点击选择器: ${JSON.stringify(learnedButtonSelector)}`);

  // 用与回放侧一致的口径在真实 DOM 上核实：该选择器解析到的就是图标按钮（而不是导航链接/把手）。
  const resolveInfo = await fixtureTab.evaluate(({ selector, iconLabel, knobId }) => {
    function isVisible(el) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }
    function matchText(el, needle) {
      const texts = [
        (el.innerText ?? '').trim(),
        el.getAttribute('aria-label')?.trim() ?? '',
        el.getAttribute('title')?.trim() ?? '',
      ];
      return texts.some((text) => text && text.toLowerCase().includes(needle));
    }
    /** 命中的文本（用于重名候选清单）：返回第一个命中的文本本身，未命中返回 null。 */
    function matchTextValue(el, needle) {
      const texts = [
        (el.innerText ?? '').trim(),
        el.getAttribute('aria-label')?.trim() ?? '',
        el.getAttribute('title')?.trim() ?? '',
      ];
      return texts.find((text) => text && text.toLowerCase().includes(needle)) ?? null;
    }
    const iconButton = document.querySelector(`button[aria-label="${iconLabel}"]`);
    const knob = document.getElementById(knobId);
    const navLink = document.getElementById('nav-self');
    let matches = [];
    if (String(selector).startsWith('text=')) {
      const needle = String(selector).slice('text='.length).trim().toLowerCase();
      const scope = 'button, a, [role="button"], input[type="submit"]';
      matches = [...document.querySelectorAll(scope)].filter(isVisible).filter((el) => matchText(el, needle));
    } else {
      matches = [...document.querySelectorAll(String(selector))].filter(isVisible);
    }
    const first = matches[0] ?? null;
    const describe = (el) => (el ? {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      ariaLabel: el.getAttribute('aria-label'),
      text: (el.innerText ?? '').trim().slice(0, 24),
    } : null);

    // 重名核实：`text=签到`（aria-label 素材）在页面上的全部候选，以及回放排序（折叠控件排后、
    // 同层比文字长度、稳定排序）下的第一顺位——若不跳过不唯一的 text= 档，回放会点到谁。
    function disclosureRank(el) {
      if (el.hasAttribute('aria-expanded')) return 1;
      const state = el.getAttribute('data-state');
      if (state === 'open' || state === 'closed') return 1;
      if (el.querySelector('button, [role="button"], input[type="submit"]')) return 1;
      return 0;
    }
    const textHitList = [...document.querySelectorAll('button, a, [role="button"], input[type="submit"]')]
      .filter(isVisible)
      .map((el) => ({ el, value: matchTextValue(el, iconLabel.toLowerCase()) }))
      .filter((hit) => hit.value !== null)
      .sort((a, b) => (disclosureRank(a.el) - disclosureRank(b.el)) || (a.value.length - b.value.length));

    return {
      selector,
      matchCount: matches.length,
      first: describe(first),
      isIconButton: first === iconButton,
      isKnob: first === knob,
      isNavLink: first === navLink,
      all: matches.map(describe),
      textCandidates: textHitList.map((hit) => describe(hit.el)),
      textWouldPick: describe(textHitList[0]?.el ?? null),
      textWouldPickIsIconButton: textHitList.length > 0 && textHitList[0].el === iconButton,
      textWouldPickIsNavLink: textHitList.length > 0 && textHitList[0].el === navLink,
    };
  }, { selector: learnedButtonSelector, iconLabel: FIXTURE_CHECKIN_LABEL, knobId: FIXTURE_KNOB_ID });

  check('学到的签到点击选择器在真实 DOM 上解析到图标按钮（DOM 同一性核实）',
    resolveInfo.isIconButton === true, JSON.stringify(resolveInfo));
  check('学到的签到点击选择器不是拖拽把手',
    resolveInfo.isKnob !== true && !String(learnedButtonSelector ?? '').includes(FIXTURE_KNOB_ID),
    `selector=${JSON.stringify(learnedButtonSelector)}`);
  check('签到点击步骤带 scrollIntoView（学到「先滚后点」）',
    terminalClick?.scrollIntoView === true, JSON.stringify(terminalClick));

  // ── 重名核实（写进报告）：aria-label「签到」与导航链接文字重名时，选择器实际指向哪个元素 ──
  check('重名核实：text=签到 在页面上确实重名（候选 ≥2：导航链接 + 图标按钮）',
    resolveInfo.textCandidates.length >= 2, JSON.stringify(resolveInfo.textCandidates));
  check('重名核实：录到的选择器跳过了不唯一的 text= 档（未采用 text=签到）',
    !String(learnedButtonSelector ?? '').startsWith('text='),
    `selector=${JSON.stringify(learnedButtonSelector)} textWouldPick=${JSON.stringify(resolveInfo.textWouldPick)}`);
  check('重名核实：若采用 text=签到，回放排序首选将是导航链接（错误元素）——回退档避免了这次误点',
    resolveInfo.textWouldPickIsNavLink === true, JSON.stringify(resolveInfo.textWouldPick));
  console.log('   重名核实: text=签到 候选=' + JSON.stringify(resolveInfo.textCandidates)
    + ` 回放排序首选=${JSON.stringify(resolveInfo.textWouldPick)}`
    + ` 录到的选择器=${JSON.stringify(learnedButtonSelector)} 解析=${JSON.stringify(resolveInfo.first)}`
    + ` matchCount=${resolveInfo.matchCount}`);

  const checkinSerialized = JSON.stringify(learnedSite);
  check('签到学习产物不含输入值 sentinel', !checkinSerialized.includes(FIXTURE_SENTINEL_USERNAME) && !checkinSerialized.includes(FIXTURE_SENTINEL_PASSWORD));
  // 登录与签到是在同一份事件流里学到的；签到工作流仍不得包含登录表单字段。
  check('签到工作流不含账密字段（只录登录后的步骤）', !workflowSerialized.includes('#password') && !workflowSerialized.includes('#username'));

  // ── 4-6. 回放 ──────────────────────────────────────────────────────
  async function closeOriginTabs() {
    for (const page of context.pages()) {
      if (page.url().startsWith(origin)) await page.close().catch(() => {});
    }
  }

  const cookieUser = async () => (await context.cookies(origin)).find((cookie) => cookie.name === 'fixture_user')?.value;

  async function replay(label, { before } = {}) {
    console.log(`\n── 回放：${label} ──`);
    await waitForQueueIdle();
    await closeOriginTabs();
    if (before) await before();
    fixture.reset();
    await app.evaluate(async () => { await chrome.storage.local.set({ status: {}, results: {} }); });

    const started = await app.evaluate(() => chrome.runtime.sendMessage({ type: 'START_LOGIN', accountId: 'bob' }));
    check(`[${label}] START_LOGIN 入队`, started?.ok === true && started?.queued === 1, JSON.stringify(started));

    const deadline = Date.now() + 120000;
    let state = await readState();
    while (Date.now() < deadline) {
      state = await readState();
      if (['done', 'failed', 'attention'].includes(accountStatus(state, 'bob'))) break;
      await new Promise((done) => setTimeout(done, 300));
    }
    await new Promise((done) => setTimeout(done, 800));
    state = await readState();
    await waitForQueueIdle();

    const status = accountStatus(state, 'bob');
    const result = state.results?.bob;
    const stepsJoined = (result?.steps ?? []).join('\n');
    console.log(`   状态=${status}`);
    console.log(`   说明=${result?.message ?? 'n/a'}`);
    for (const [index, step] of (result?.steps ?? []).entries()) console.log(`   ${index + 1}. ${step}`);

    // 未达终态时输出诊断：跨页任务的实时步骤存在 storage.session 的 task:<tabId> 信箱里。
    if (status !== 'done') {
      const diag = await app.evaluate(async () => {
        const all = await chrome.storage.session.get(null);
        const tasks = Object.entries(all)
          .filter(([key]) => key.startsWith('task:'))
          .map(([key, value]) => ({ key, stage: value?.stage ?? null, steps: (value?.steps ?? []).slice(-8) }));
        return { tasks, queue: all.checkinQueue ?? null };
      }).catch(() => null);
      console.log('   诊断（未达 done）: storage.session 任务信箱:');
      for (const task of diag?.tasks ?? []) console.log(`   ${task.key} stage=${task.stage} steps=${JSON.stringify(task.steps)}`);
      console.log(`   诊断：队列=${JSON.stringify(diag?.queue ?? null)}`);
      console.log(`   诊断：标签页=${context.pages().map((page) => page.url()).join(' | ')}`);
    }

    const events = fixture.events();
    const profileSeenIdx = events.findIndex((event) => event.method === 'GET' && event.path === '/profile');
    const identitySelfIdx = events.findIndex((event) => event.path === '/api/user/self' && event.user === FIXTURE_SENTINEL_USERNAME);
    const checkinIdx = events.findIndex((event) => event.method === 'POST' && event.path === '/api/checkin');

    check(`[${label}] 终态 done`, status === 'done', `status=${status}`);
    check(`[${label}] 恰好签到一次`, fixture.claimCount() === 1, `claims=${fixture.claimCount()}`);
    check(`[${label}] 经过了个人资料页`, profileSeenIdx >= 0);
    check(`[${label}] 签到发生在资料页身份读取之后（请求顺序）`, identitySelfIdx >= 0 && checkinIdx > identitySelfIdx,
      `identitySelf#${identitySelfIdx} checkin#${checkinIdx}`);
    check(`[${label}] 回放日志含个人资料页身份核验步骤`, /个人资料页/.test(stepsJoined));
    // ── 断言2（回放侧）：fixture 请求日志出现签到 POST；没有任何步骤/日志指向拖拽把手 ──
    const checkinEvent = events.find((event) => event.method === 'POST' && event.path === '/api/checkin');
    check(`[${label}] fixture 请求日志出现签到 POST`, !!checkinEvent,
      checkinEvent ? `POST /api/checkin user=${checkinEvent.user}` : '未记录到签到 POST');
    check(`[${label}] 签到 POST 带真实滚动位置（先滚后点：scrollY>0）`,
      Number(checkinEvent?.scrollY) > 0, `scrollY=${checkinEvent?.scrollY}`);
    check(`[${label}] 回放日志点击了学到的按钮选择器`,
      !!learnedButtonSelector && (result?.steps ?? []).some((step) => step.includes('工作流已点击') && step.includes(learnedButtonSelector)),
      `selector=${JSON.stringify(learnedButtonSelector)}`);
    check(`[${label}] 回放日志没有点击拖拽把手`,
      !(result?.steps ?? []).some((step) => step.includes('工作流已点击') && step.includes(FIXTURE_KNOB_ID)),
      '不应出现「工作流已点击 #pull-knob」');
    const confirmIdx = (result?.steps ?? []).findIndex((step) => step.includes('个人资料页已核对账号身份'));
    const clickIdx = (result?.steps ?? []).findIndex((step) => step.includes('工作流已点击'));
    check(`[${label}] 日志顺序：资料页核验先于签到点击`, confirmIdx >= 0 && clickIdx > confirmIdx,
      `核验#${confirmIdx} 点击#${clickIdx}`);
    return { status, result, events };
  }

  // S1：正常账号复用（浏览器里仍是 bob 会话，不应再登录）
  await replay('S1 已登录复用');
  check('[S1 已登录复用] 复用了已有会话，没有再次登录', fixture.loginCount() === 0, `logins=${fixture.loginCount()}`);
  check('[S1 已登录复用] 会话仍是验收账号', (await cookieUser()) === FIXTURE_SENTINEL_USERNAME);

  // S2：从未登录（清掉所有 Cookie）
  await replay('S2 从未登录', { before: async () => { await context.clearCookies(); } });
  check('[S2 从未登录] 回放前确实没有会话', true);
  check('[S2 从未登录] 自动完成了一次登录', fixture.loginCount() === 1, `logins=${fixture.loginCount()}`);
  check('[S2 从未登录] 签到后会话属于验收账号', (await cookieUser()) === FIXTURE_SENTINEL_USERNAME);

  // S3：错号重登（浏览器里是 alice 的会话）
  await replay('S3 错号重登', {
    before: async () => {
      await context.clearCookies();
      const alicePage = await context.newPage();
      await alicePage.goto(`${origin}/login`);
      await alicePage.fill('#username', FIXTURE_ALICE_USERNAME);
      await alicePage.fill('#password', FIXTURE_ALICE_PASSWORD);
      await alicePage.click('#login-submit');
      await alicePage.waitForURL((url) => url.pathname === '/console', { timeout: 10000 });
      await alicePage.waitForFunction((expected) => document.querySelector('#current-user')?.textContent === expected, FIXTURE_ALICE_USERNAME);
      console.log(`   预置会话：${FIXTURE_ALICE_USERNAME}`);
    },
  });
  check('[S3 错号重登] 明确识别到的是别人的账号（资料页读到 alice）',
    fixture.events().some((event) => event.path === '/api/user/self' && event.user === 'alice_fixture')
      || fixture.events().some((event) => event.method === 'GET' && event.path === '/profile' && event.user === 'alice_fixture'),
    'alice 会话上的身份读取已记录');
  check('[S3 错号重登] 检出错号后重新登录为验收账号', fixture.loginCount() >= 1, `logins=${fixture.loginCount()}`);
  check('[S3 错号重登] 结束时浏览器会话是验收账号', (await cookieUser()) === FIXTURE_SENTINEL_USERNAME);

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
