/**
 * 端到端验证：加载扩展 → 自动登录 → 自动签到 → 断言状态回写。
 *
 * 覆盖签到方式、后台批处理、同源门禁，以及跨整页跳转的阶段接续：
 *   登录页(/login) --整页跳转--> 落地页(/console) --跳转--> 签到页(/checkin)
 *
 * 关键在于断言 React 的 state（而非 DOM value）真的收到了值，
 * 这才能证明 setNativeValue 的原生 setter 技巧有效。
 */
import { chromium } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { startServer } from './server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXT = process.env.EXTENSION_DIR
  ? resolve(ROOT, process.env.EXTENSION_DIR)
  : join(ROOT, '.output', 'chrome-mv3');
const FIXTURE = join(ROOT, 'tests', 'e2e', 'fixture', 'dist');

const PORT = 8123;
const ORIGIN = `http://localhost:${PORT}`;
const HEADLESS = process.env.E2E_HEADLESS === '1';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? `  — ${detail}` : ''}`);
};

const {
  server,
  reset,
  setChecked,
  isChecked,
  getLogoutCount,
  wasRewarded,
  getBatchMaxActive,
  getBatchEvents,
  getRedirectHits,
} = await startServer(FIXTURE, PORT);
const profile = mkdtempSync(join(tmpdir(), 'checkin-e2e-'));

// 用 Playwright 自带的 Chromium：Chrome 151 stable 会忽略 --load-extension
let ctx;
try {
  ctx = await chromium.launchPersistentContext(profile, {
    headless: HEADLESS,
    ...(HEADLESS ? { channel: 'chromium' } : {}),
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
} catch (error) {
  server.close();
  rmSync(profile, { recursive: true, force: true });
  throw error;
}

/** 造一个站点配置 */
function siteWith(checkin, id = 'test-site', extra = {}) {
  return {
    id,
    name: '测试站',
    loginUrl: `${ORIGIN}/login`,
    pointerMode: 'dom',
    selectors: {
      username: 'input[name="username"]',
      password: 'input[type="password"]',
      submit: 'button[type="submit"]',
    },
    closeModalSelectors: ['.ant-modal-close'],
    checkin,
    ...extra,
  };
}

function popupGithubReloginSite() {
  return siteWith(
    {
      method: 'relogin',
      logoutApiUrl: '/api/logout',
      logoutStorageKeys: ['user', 'token', 'access_token'],
    },
    'test-site',
    {
      loginUrl: `${ORIGIN}/login?popup=1`,
      loginMethod: 'github',
      pointerMode: 'trusted',
      oauthButtonSelector: '.oauth-btn',
      successIndicator: '#login-success',
    },
  );
}

try {
  // Chrome 新版的 chrome://extensions shadow DOM 在 CDP 下可能不可读；
  // 先从 service worker 发现候选，再打开自家 options.html 验证，最后才回退到旧 DOM 查询。
  let extId = null;
  const extensionProbe = await ctx.newPage();
  for (let round = 0; round < 12 && !extId; round += 1) {
    const ids = new Set(
      ctx.serviceWorkers?.()
        .filter((worker) => worker.url().startsWith('chrome-extension://'))
        .map((worker) => new URL(worker.url()).hostname) ?? [],
    );
    for (const id of ids) {
      const valid = await extensionProbe
        .goto(`chrome-extension://${id}/options.html`, { timeout: 5000 })
        .then(() => extensionProbe.evaluate(() => document.title))
        .then((title) => title.includes('签到') || title.includes('中转'))
        .catch(() => false);
      if (valid) {
        extId = id;
        break;
      }
    }
    if (!extId) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await extensionProbe.close().catch(() => {});

  if (!extId) {
    const probe = await ctx.newPage();
    await probe.goto('chrome://extensions');
    await probe.waitForTimeout(1500);
    extId = await probe.evaluate(() => {
      const mgr = document.querySelector('extensions-manager');
      const items =
        mgr?.shadowRoot?.querySelector('extensions-item-list')?.shadowRoot?.querySelectorAll('extensions-item') ?? [];
      return items[0]?.id ?? null;
    });
    await probe.close();
  }
  check('扩展加载成功', !!extId, `id=${extId}`);
  if (!extId) throw new Error('无法确定扩展 ID');

  // let 而非 const：轮次中若扩展页被意外关闭，需要就地重开
  let ext = await ctx.newPage();
  await ext.goto(`chrome-extension://${extId}/options.html`);
  await ext.waitForLoadState('domcontentloaded');
  check('扩展页可访问 chrome API', await ext.evaluate(() => typeof chrome?.storage?.local?.set === 'function'));
  // Chromium reports the options page before all declarative content scripts
  // are registered. Under CPU contention the very first task can otherwise
  // open before auto-login is available and remain in running forever.
  await new Promise((resolve) => setTimeout(resolve, 750));

  /**
   * 读扩展的持久化状态。所有断言都靠它，所以必须最稳：
   * 扩展页在轮次之间会被 service worker 重启或标签页清理弄失效，
   * 裸调 evaluate 会抛 "Target page has been closed" 让整轮崩掉。
   * 这里重开页面重试一次，读不到才返回空对象让断言自己失败。
   */
  async function readAutomationState(page) {
    const read = (target) => target.evaluate(async () => {
      const stored = await chrome.storage.local.get(['status', 'results']);
      return { status: stored.status ?? {}, results: stored.results ?? {} };
    });

    if (page) return read(page).catch(() => ({ status: {}, results: {} }));

    try {
      await ensureExtPage();
      return await read(ext);
    } catch {
      await ensureExtPage();
      return read(ext).catch(() => ({ status: {}, results: {} }));
    }
  }

  function accountStatus(state, accountId) {
    return Object.entries(state?.status ?? {}).find(([key]) => key.startsWith(`${accountId}:`))?.[1] ?? 'none';
  }

  /** 扩展页失效时就地重开。service worker 重启或前一轮清理误关都会导致这个。 */
  async function ensureExtPage() {
    if (!ext.isClosed()) return;
    // ctx 本身也可能被关掉（Playwright 进程退出），这里需要防守
    try {
      ext = await ctx.newPage();
      await ext.goto(`chrome-extension://${extId}/options.html`);
      await ext.waitForLoadState('domcontentloaded');
    } catch {
      // ctx 已关闭，不能恢复，让调用方靠超时退出
    }
  }

  /**
   * 轮询到状态落定为止。
   *
   * 不用 ext.waitForTimeout 而用裸 setTimeout：前者在扩展页被关掉后会抛
   * "Target page has been closed"，让整个测试崩掉、后面几十项断言全部
   * 拿不到结果。单页故障不该毁掉整轮。
   */
  async function pollUntilTerminal(timeout) {
    let state = null;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      await ensureExtPage();
      state = await ext
        .evaluate(async () => {
          const r = await chrome.storage.local.get(['status', 'results']);
          return { status: r.status ?? {}, results: r.results ?? {} };
        })
        .catch(() => state);
      // 只看本轮账号的状态。status 的 key 带日期（acc1:2026-08-11），
      // 用 Object.values()[0] 会在 storage 里有残留 key 时取错值 ——
      // 表现为任务明明结束了却一直读到 running。
      const v = accountStatus(state, 'acc1');
      if (v === 'done' || v === 'failed') break;
      await new Promise((r) => setTimeout(r, 600));
    }
    return state;
  }

  async function waitForQueueIdle(timeout = 10_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      await ensureExtPage();
      const queue = await ext
        .evaluate(async () => (await chrome.storage.session.get('checkinQueue')).checkinQueue)
        .catch(() => null);
      if (!queue?.active && !(queue?.pendingAccountIds?.length > 0)) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  async function waitForTerminalAccounts(accountIds, timeout = 60_000) {
    let state = await readAutomationState();
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (accountIds.every((accountId) => ['done', 'failed'].includes(accountStatus(state, accountId)))) {
        await waitForQueueIdle();
        return readAutomationState();
      }
      await new Promise((r) => setTimeout(r, 250));
      state = await readAutomationState();
    }
    return state;
  }

  /** 跑一轮完整流程，返回 {status, result} */
  async function runRound(label, site, { expectPages = [], resetServer = true, account: accountPatch = {} } = {}) {
    if (resetServer) reset();

    // 开跑前确认队列真的空了。上一轮的任务若还挂在队列里，本轮的
    // TASK_RESULT 会被 background 的 requireActive 检查拒掉（它只接受
    // 当前 active 任务的结果），表现为「状态停在 running、results 为空」。
    await waitForQueueIdle(8_000);

    await ext.evaluate(
      async ({ site, accountPatch }) => {
        await chrome.storage.local.set({
          sites: [site],
          accounts: [{ id: 'acc1', siteId: site.id, username: 'demo_user', password: 'demo_pass_123', ...accountPatch }],
          status: {},
          results: {},
        });
      },
      { site, accountPatch },
    );

    const seen = [];
    const onPage = (p) => seen.push(p);
    ctx.on('page', onPage);

    const started = await ext.evaluate(
      () => new Promise((r) => chrome.runtime.sendMessage({ type: 'START_LOGIN', accountId: 'acc1' }, r)),
    );
    if (started?.ok !== true || started.queued !== 1) {
      ctx.off('page', onPage);
      return { fatal: `START_LOGIN 失败: ${JSON.stringify(started)}` };
    }

    // 先等状态落定，再读一次权威快照。
    // pollUntilTerminal 的返回值只用于判断「跑完了没」，最终断言一律用
    // readAutomationState 的结果 —— 后者带重试，不受扩展页瞬时失效影响。
    await pollUntilTerminal(90_000);
    // TASK_RESULT 与最后一次进度同步都经 service worker 异步落盘；
    // 终态很短的轮次可能在第一次快照时仍看到 running。再给一次
    // 小窗口读取，避免把正常完成报告成时序失败。
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await pollUntilTerminal(10_000);
    await waitForQueueIdle();
    const finalState = await readAutomationState();
    const taskPages = seen.filter((p) => !p.url().startsWith('chrome-extension://'));
    const closeDeadline = Date.now() + 3_000;
    while (taskPages.some((p) => !p.isClosed()) && Date.now() < closeDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const taskPagesClosedByBackground = taskPages.length > 0 && taskPages.every((p) => p.isClosed());
    const taskPagesRetainedByBackground = taskPages.length > 0 && taskPages.some((p) => !p.isClosed());
    ctx.off('page', onPage);

    // 关掉这轮开出来的标签页。必须跳过扩展页本身 —— 它在轮次之间要复用，
    // 若被当作本轮页面关掉，下一轮的 ext.evaluate 会直接抛
    // "Target page has been closed"，后面所有断言都拿不到结果。
    for (const p of seen) {
      if (p === ext || p.url().startsWith('chrome-extension://')) continue;
      await p.close().catch(() => {});
    }

    // 关标签页会触发 background 的 tab.onRemoved 清理（撤代理、清信箱、
    // 结束任务）。不等它跑完就开下一轮，下一轮的任务会撞上上一轮的清理，
    // 表现为「标签页被关闭，签到中断」—— 而且只在耗时较长的轮次上偶发，
    // 很像随机失败。等到队列真的空掉，把这个时序钉死。
    await waitForQueueIdle(5_000);

    // 同 pollUntilTerminal：按账号 ID 取，不靠 Object.values 的顺序
    const status = accountStatus(finalState, 'acc1');
    const result = finalState?.results?.acc1;
    console.log(`\n── ${label} ──`);
    console.log(`   状态=${status}  说明=${result?.message ?? 'n/a'}`);
    if (result?.steps) result.steps.forEach((s, i) => console.log(`   ${i + 1}. ${s}`));
    return { status, result, taskPagesClosedByBackground, taskPagesRetainedByBackground };
  }

  if (process.env.E2E_FOCUS === 'none') {
    const focused = await runRound(
      '定点回归：登录即签到并在成功后关闭任务页',
      siteWith({ method: 'none' }),
    );
    check('focus none: 终态为 done', focused.status === 'done', `status=${focused.status}`);
    check('focus none: 成功后自动关闭任务页', focused.taskPagesClosedByBackground === true);
  } else if (process.env.E2E_FOCUS === 'api-success') {
    const focused = await runRound(
      '定点回归：API 成功状态不可被 running 覆盖',
      siteWith({ method: 'api', apiUrl: '/api/checkin', apiMethod: 'POST' }),
    );
    check('focus api: 终态为 done', focused.status === 'done', `status=${focused.status}`);
    check('focus api: 结果已持久化', !!focused.result?.message, focused.result?.message);
  } else if (process.env.E2E_FOCUS === 'api-redirect') {
    const focused = await runRound(
      '定点回归：拒绝跨 origin 重定向',
      siteWith({ method: 'api', apiUrl: '/api/checkin/redirect', apiMethod: 'POST' }),
    );
    const redirectFailure = focused.result?.steps?.find((step) =>
      step.includes('签到请求失败: Failed to fetch'),
    );
    check('focus redirect: 终态为 failed', focused.status === 'failed', `status=${focused.status}`);
    check('focus redirect: 失败后保留任务页供排查', focused.taskPagesRetainedByBackground === true);
    check(
      'focus redirect: 明确记录重定向安全错误',
      !!redirectFailure,
      redirectFailure ?? focused.result?.message,
    );
    check('focus redirect: 目标未收到请求', getRedirectHits() === 0, `hits=${getRedirectHits()}`);
  } else if (process.env.E2E_FOCUS === 'oauth-auto') {
    const focused = await runRound(
      '定点回归：自动识别 GitHub OAuth 按钮',
      siteWith({ method: 'api', apiUrl: '/api/checkin', apiMethod: 'POST' }, 'test-site', {
        loginMethod: 'oauth',
        pointerMode: 'trusted',
      }),
    );
    check('focus oauth: 终态为 done', focused.status === 'done', `status=${focused.status}`);
    check(
      'focus oauth: 自动识别并点击 GitHub 按钮',
      !!focused.result?.steps?.some((s) => s.includes('已自动识别并点击 OAuth 按钮') && s.includes('GitHub')),
      focused.result?.steps?.find((s) => s.includes('OAuth')) ?? focused.result?.message,
    );
    check(
      'focus oauth: 未走账密表单',
      !focused.result?.steps?.some((s) => s.includes('已填写密码')),
      '确认未填表单',
    );
  } else if (process.env.E2E_FOCUS === 'oauth-popup-relogin') {
    const focused = await runRound(
      '定点回归：GitHub 快速弹窗回调后退出重登',
      popupGithubReloginSite(),
      { account: { githubUsername: 'fixture-github-user', githubPassword: 'fixture-github-password' } },
    );
    const oauthClicks = focused.result?.steps?.filter((s) => s.includes('OAuth 按钮')) ?? [];
    check('focus popup relogin: 终态为 done', focused.status === 'done', `status=${focused.status}`);
    check('focus popup relogin: 首次和第二次 OAuth 都已点击', oauthClicks.length >= 2, oauthClicks.join(' | '));
    check(
      'focus popup relogin: 快速回调由第二次登录页继续完成',
      !!focused.result?.steps?.some((s) => s.includes('第二次登录成功')),
      focused.result?.message,
    );
  } else if (process.env.E2E_FOCUS === 'auto-replaced') {
    const focused = await runRound(
      '定点回归：React 替换签到按钮节点',
      siteWith({ method: 'auto', url: `${ORIGIN}/checkin?replace=1` }),
    );
    check('focus auto: 终态为 done', focused.status === 'done', `status=${focused.status}`);
    check('focus auto: 服务端确认发放奖励', isChecked(), `checked=${isChecked()}`);
    check(
      'focus auto: 重新扫描后命中替换节点',
      /替换为今日已签到/.test(focused.result?.message ?? ''),
      focused.result?.message,
    );
  } else if (process.env.E2E_FOCUS === 'auto-already') {
    setChecked(true);
    const focused = await runRound(
      '定点回归：已签到页不点击侧栏签到容器',
      siteWith({ method: 'auto', url: `${ORIGIN}/checkin?alreadyButton=1&navButton=1` }),
      { resetServer: false },
    );
    check('focus already: 终态为 done', focused.status === 'done', `status=${focused.status}`);
    check(
      'focus already: 页面已签到直接完成',
      /已签到/.test(focused.result?.message ?? ''),
      focused.result?.message,
    );
    check(
      'focus already: 没有点击侧栏签到容器',
      !focused.result?.steps?.some((s) => s.includes('已点击自动识别的签到按钮')),
      focused.result?.steps?.filter((s) => s.includes('自动识别')).join(' | '),
    );
  } else {
  // ── 轮次 1：登录即签到 ────────────────────────────
  const r1 = await runRound('方式 none：登录即签到', siteWith({ method: 'none' }));
  check('none: 状态为已签到', r1.status === 'done', `status=${r1.status}`);
  check('none: 成功后自动关闭任务标签页', r1.taskPagesClosedByBackground === true);
  check(
    'none: 跨整页跳转后仍判定成功（verify 阶段接续）',
    !!r1.result?.steps?.some((s) => s.includes('登录结果已确认')),
    r1.result?.message,
  );

  // ── 轮次 2：接口签到 ──────────────────────────────
  const r2 = await runRound(
    '方式 api：请求签到接口',
    siteWith({ method: 'api', apiUrl: '/api/checkin', apiMethod: 'POST' }),
  );
  check('api: 状态为已签到', r2.status === 'done', `status=${r2.status}`);
  check('api: 接口返回签到成功', /签到成功|成功标志/.test(r2.result?.message ?? ''), r2.result?.message);

  // ── 轮次 3：接口签到，重复签到应识别为「已签到」────
  // 不 reset 服务器状态，直接再跑一次
  const rDup = await runRound(
    '方式 api：重复签到',
    siteWith({ method: 'api', apiUrl: '/api/checkin', apiMethod: 'POST' }),
    { resetServer: false },
  );
  check('api: 重复签到被识别为「今日已签到」', /已签到/.test(rDup.result?.message ?? ''), rDup.result?.message);

  // ── 轮次 4：API 明确返回 success:false 必须失败 ───
  const rFalse = await runRound(
    '方式 api：结构化失败响应',
    siteWith({ method: 'api', apiUrl: '/api/checkin/fail', apiMethod: 'POST' }),
  );
  check('api: success:false 不得判为成功', rFalse.status === 'failed', `status=${rFalse.status}`);
  check('api: 失败后保留任务标签页供排查', rFalse.taskPagesRetainedByBackground === true);
  check(
    'api: 失败原因被保留',
    /拒绝|失败/.test(rFalse.result?.message ?? ''),
    rFalse.result?.message,
  );

  const rFalseCodeZero = await runRound(
    '方式 api：显式失败覆盖 code=0',
    siteWith({ method: 'api', apiUrl: '/api/checkin/fail-code-zero', apiMethod: 'POST' }),
  );
  check(
    'api: success:false 与 code=0 冲突时仍失败',
    rFalseCodeZero.status === 'failed',
    rFalseCodeZero.result?.message,
  );

  const rHtml = await runRound(
    '方式 api：拒绝伪装成功的 HTML 登录页',
    siteWith({ method: 'api', apiUrl: '/api/checkin/html', apiMethod: 'POST' }),
  );
  check('api: HTML 中的成功文字不得误报', rHtml.status === 'failed', rHtml.result?.message);

  const rRedirect = await runRound(
    '方式 api：拒绝跨 origin 重定向',
    siteWith({ method: 'api', apiUrl: '/api/checkin/redirect', apiMethod: 'POST' }),
  );
  check('api: 307 跨 origin 重定向被阻止', rRedirect.status === 'failed', rRedirect.result?.message);
  check('api: 重定向目标未收到请求', getRedirectHits() === 0, `hits=${getRedirectHits()}`);

  // ── 轮次 5：自动识别不能把侧栏导航当签到按钮 ─────
  const rAutoCheckin = await runRound(
    '方式 auto：跳转后点击真正的签到按钮',
    siteWith({ method: 'auto', url: `${ORIGIN}/checkin?replace=1` }),
  );
  check('auto checkin: 状态为已签到', rAutoCheckin.status === 'done', `status=${rAutoCheckin.status}`);
  check('auto checkin: 服务端确认已发放签到奖励', isChecked(), `checked=${isChecked()}`);
  check(
    'auto checkin: 点击的是立即签到按钮',
    !!rAutoCheckin.result?.steps?.some((s) => s.includes('自动识别的签到按钮「立即签到')),
    rAutoCheckin.result?.steps?.filter((s) => s.includes('自动识别的签到按钮')).join(' | '),
  );
  check(
    'auto checkin: 没有把侧栏签到链接当动作按钮',
    !rAutoCheckin.result?.steps?.some((s) => s.includes('自动识别的签到按钮「签到」')),
    rAutoCheckin.result?.steps?.filter((s) => s.includes('自动识别的签到按钮')).join(' | '),
  );
  check(
    'auto checkin: React 替换原按钮后仍识别真实终态',
    /替换为今日已签到/.test(rAutoCheckin.result?.message ?? ''),
    rAutoCheckin.result?.message,
  );

  setChecked(true);
  const rAutoAlready = await runRound(
    '方式 auto：已签到页不点击侧栏签到容器',
    siteWith({ method: 'auto', url: `${ORIGIN}/checkin?alreadyButton=1&navButton=1` }),
    { resetServer: false },
  );
  check('auto already: 状态为已签到', rAutoAlready.status === 'done', `status=${rAutoAlready.status}`);
  check(
    'auto already: 页面已签到直接完成',
    /已签到/.test(rAutoAlready.result?.message ?? ''),
    rAutoAlready.result?.message,
  );
  check(
    'auto already: 没有把侧栏签到容器当动作按钮',
    !rAutoAlready.result?.steps?.some((s) => s.includes('已点击自动识别的签到按钮')),
    rAutoAlready.result?.steps?.filter((s) => s.includes('自动识别')).join(' | '),
  );

  // ── 轮次 6：点按钮签到（需先跳转到签到页）────────
  const r4 = await runRound(
    '方式 button：跳转签到页并点按钮',
    siteWith({
      method: 'button',
      url: `${ORIGIN}/checkin`,
      buttonSelector: '.checkin-btn',
      alreadySelector: '#already-checked',
      successSelector: '#checkin-success',
    }),
  );
  check('button: 状态为已签到', r4.status === 'done', `status=${r4.status}`);
  check(
    'button: 走了跳转签到页的分支',
    !!r4.result?.steps?.some((s) => s.includes('准备跳转')),
    r4.result?.steps?.find((s) => s.includes('准备跳转')),
  );
  check(
    'button: 点击按钮并命中成功标志',
    !!r4.result?.steps?.some((s) => s.includes('已点击签到按钮')),
    r4.result?.message,
  );
  // 点击必须只发生一次：重复点击会让服务端认为重复签到
  check('button: 首次签到判定为成功而非重复', /成功/.test(r4.result?.message ?? ''), r4.result?.message);

  // ── 登录后才出现的公告 ──
  // fixture 的 /console 与 /checkin 都会在几百毫秒后盖上一层 modal mask，
  // 模拟真实站点「登录成功 → 前端拉公告接口 → 弹窗」的时序。
  // 旧实现在登录后只扫一次页面，必然扑空后被遮罩挡住签到按钮，
  // 而 realClick 走 el.click() 不受遮挡影响 —— 于是产生一条假的成功记录。
  console.log('\n── 登录后延迟弹出的公告 ──');
  // 断言必须锚定「登录提交之后」的清理。登录后的公告现在会在验证成功证据
  // 之前关闭；若仍从“登录结果已确认”往后切，会漏掉这次最关键的清理。
  // 只检查"存在某一条 关闭了N个"是不够的：登录页那次（步骤 4）总会命中，
  // 会把登录后两处的失败完全掩盖 —— 实测把等待逻辑注掉后断言依然全绿。
  const loginSubmitIndex = (steps) => (steps ?? []).findIndex((s) => (
    s.includes('登录按钮已收到浏览器可信点击')
      || s.includes('登录按钮已通过 DOM 点击')
      || s.includes('已点击登录按钮')
  ));
  const afterLoginSubmit = (steps) => {
    const at = loginSubmitIndex(steps);
    return at < 0 ? [] : steps.slice(at + 1);
  };
  const postLoginSteps = afterLoginSubmit(r4.result?.steps);
  const postLoginClosed = postLoginSteps.filter((s) => /关闭了 \d+ 个公告/.test(s));

  check(
    '公告: 登录之后关掉了迟到的公告',
    postLoginClosed.length > 0,
    postLoginSteps.filter((s) => s.includes('公告') || s.includes('遮罩')).join(' | ') || '(登录后无公告日志)',
  );
  // button 方式会跳签到页，那里也有延迟公告 —— 两处都该关掉
  check(
    '公告: 登录后与签到页两处都清理了',
    postLoginClosed.length >= 2,
    `登录后清理次数=${postLoginClosed.length}`,
  );
  const firstPostSubmitClose = (r4.result?.steps ?? []).findIndex((s, index) => (
    index > loginSubmitIndex(r4.result?.steps)
      && /关闭了 \d+ 个公告/.test(s)
  ));
  const loginConfirmedAt = (r4.result?.steps ?? []).findIndex((s) => s.includes('登录结果已确认'));
  check(
    '公告: 登录成功验证前先关闭登录后公告',
    firstPostSubmitClose >= 0 && loginConfirmedAt >= 0 && firstPostSubmitClose < loginConfirmedAt,
    `公告步骤=${firstPostSubmitClose + 1}, 登录确认步骤=${loginConfirmedAt + 1}`,
  );
  check(
    '公告: 未因遮挡而假成功',
    /*
     * 不能直接 grep 日志里的「遮挡」二字：正常成功后打印的是
     * 「已确认对应公告消失或目标遮挡解除」，那是**成功**措辞，会被这个关键字误伤，
     * 让断言恒假 —— 实测这一项长期显示失败，而功能其实一直是好的。
     *
     * 判据按源码里的**成功措辞**精确排除：只有「……遮挡解除」是成功形态
     * （announcements.ts:470-471）。其余含「遮挡」的都是告警，包括
     * 「当前遮挡仍在」「未能解除当前遮挡」「Esc 也未解除遮挡」（后两条含「解除」二字，
     * 但语义是**没能解除**，用 `!/解除/` 会把它们误判成成功 —— 那是漏报）。
     * 逐条取自源码：
     *   announcements.ts「当前遮挡仍在」「未能解除当前遮挡」「也未解除遮挡」
     *   click-safety.ts「被 X 遮挡，尝试关闭遮挡的公告」
     *   checkin.ts「签到按钮被 X 遮挡」「用户菜单被 X 遮挡」等
     */
    !r4.result?.steps?.some((s) => /遮挡/.test(s) && !/遮挡解除/.test(s)) && r4.status === 'done',
    r4.result?.steps?.find((s) => /遮挡/.test(s) && !/遮挡解除/.test(s)) ?? '无遮挡告警',
  );
  check(
    '公告: 没有把迟到的公告误报为「未发现」',
    !postLoginSteps.some((s) => s === '无公告选择器配置，跳过'),
    postLoginSteps.filter((s) => s.includes('公告')).join(' | '),
  );

  // 站点没配 closeModalSelectors 时必须靠通用词表兜住。
  // 旧实现遇到空数组直接 return「无公告选择器配置，跳过」，
  // COMMON_CLOSE_SELECTORS 定义了却从未被用到。
  const rNoSel = await runRound(
    '公告：站点未配选择器时用通用词表',
    siteWith(
      {
        method: 'button',
        url: `${ORIGIN}/checkin`,
        buttonSelector: '.checkin-btn',
        alreadySelector: '#already-checked',
        successSelector: '#checkin-success',
      },
      'test-site',
      { closeModalSelectors: [] },
    ),
  );
  check('公告: 未配选择器也能签到成功', rNoSel.status === 'done', `status=${rNoSel.status}`);
  const noSelPostLogin = afterLoginSubmit(rNoSel.result?.steps).filter((s) => /关闭了 \d+ 个公告/.test(s));
  check(
    '公告: 未配选择器时靠通用词表关掉了登录后的公告',
    noSelPostLogin.length >= 2,
    `登录后清理次数=${noSelPostLogin.length}`,
  );

  // ── 轮次 6：退出再登录式签到（Agent Router 模式）──
  const r5 = await runRound(
    '方式 relogin：退出后重新登录',
    siteWith({ method: 'relogin', logoutApiUrl: '/api/logout', logoutStorageKeys: ['user', 'token', 'access_token'] }),
  );
  check('relogin: 状态为已签到', r5.status === 'done', `status=${r5.status}`);
  check('relogin: 调用了退出接口', getLogoutCount() > 0, `logoutCount=${getLogoutCount()}`);
  check(
    'relogin: 走了第二次登录',
    !!r5.result?.steps?.some((s) => s.includes('第二次登录')),
    r5.result?.message,
  );
  check('relogin: 服务端确认发放了重登奖励', wasRewarded(), `rewarded=${wasRewarded()}`);
  check(
    'relogin: 清除了本地登录态',
    !!r5.result?.steps?.some((s) => s.includes('已清除') && s.includes('登录态')),
    r5.result?.steps?.find((s) => s.includes('登录态')),
  );

  // Agent Router 使用 window.open；GitHub 已授权时可能 about:blank 后直接回本站，
  // 完全观察不到 github.com。任务必须迁到弹窗，否则旧 opener 会在登录页误判失败。
  const r5Popup = await runRound(
    '方式 relogin：GitHub 快速弹窗回调',
    popupGithubReloginSite(),
    { account: { githubUsername: 'fixture-github-user', githubPassword: 'fixture-github-password' } },
  );
  const popupOAuthClicks = r5Popup.result?.steps?.filter((s) => s.includes('OAuth 按钮')) ?? [];
  check('popup relogin: 状态为已签到', r5Popup.status === 'done', `status=${r5Popup.status}`);
  check('popup relogin: 首次和第二次 OAuth 均已发起', popupOAuthClicks.length >= 2, popupOAuthClicks.join(' | '));
  check(
    'popup relogin: 第二次快速回调继续完成签到',
    !!r5Popup.result?.steps?.some((s) => s.includes('第二次登录成功')),
    r5Popup.result?.message,
  );
  check(
    'popup relogin: 没有误报第二次 OAuth 未确认',
    !r5Popup.result?.steps?.some((s) => s.includes('第二次 OAuth 登录未确认成功')),
    r5Popup.result?.message,
  );

  // ── 轮次 7：relogin 用点按钮退出（无退出接口）──
  const r6 = await runRound(
    '方式 relogin：点退出按钮',
    siteWith({
      method: 'relogin',
      logoutSelector: '#logout-btn, [data-action="logout"]',
      logoutStorageKeys: ['user', 'token', 'access_token'],
    }),
  );
  check('relogin(按钮): 状态为已签到', r6.status === 'done', `status=${r6.status}`);
  check(
    'relogin(按钮): 执行了退出流程',
    !!r6.result?.steps?.some((s) => s.includes('准备点击退出登录') || s.includes('已点击退出登录')),
    r6.result?.message,
  );

  // ── 轮次 8：OAuth 登录方式 ────────────────────────
  const r7 = await runRound(
    '登录方式 oauth：点 OAuth 按钮',
    siteWith({ method: 'api', apiUrl: '/api/checkin', apiMethod: 'POST' }, 'test-site', {
      loginMethod: 'oauth',
      oauthButtonSelector: '.oauth-btn',
    }),
  );
  check('oauth: 状态为已签到', r7.status === 'done', `status=${r7.status}`);
  check(
    'oauth: 点了 OAuth 按钮而非填表单',
    !!r7.result?.steps?.some((s) => s.includes('已点击 OAuth 按钮')),
    r7.result?.steps?.find((s) => s.includes('OAuth')),
  );
  check(
    'oauth: 没有走填账密的分支',
    !r7.result?.steps?.some((s) => s.includes('已填写密码')),
    '确认未填表单',
  );

  const r7Auto = await runRound(
    '登录方式 oauth：自动识别 GitHub 按钮',
    siteWith({ method: 'api', apiUrl: '/api/checkin', apiMethod: 'POST' }, 'test-site', {
      loginMethod: 'oauth',
    }),
  );
  check('oauth auto: 状态为已签到', r7Auto.status === 'done', `status=${r7Auto.status}`);
  check(
    'oauth auto: 自动识别并点击 GitHub 按钮',
    !!r7Auto.result?.steps?.some((s) => s.includes('已自动识别并点击 OAuth 按钮') && s.includes('GitHub')),
    r7Auto.result?.steps?.find((s) => s.includes('OAuth')) ?? r7Auto.result?.message,
  );
  check(
    'oauth auto: 没有走填账密的分支',
    !r7Auto.result?.steps?.some((s) => s.includes('已填写密码')),
    '确认未填表单',
  );

  // ── 轮次 9：auto 方式根据完整账号凭据解析为 form ────
  const r8 = await runRound(
    '登录方式 auto：根据账号凭据使用表单',
    siteWith({ method: 'api', apiUrl: '/api/checkin', apiMethod: 'POST' }, 'test-site', {
      loginMethod: 'auto',
    }),
  );
  check('auto: 状态为已签到', r8.status === 'done', `status=${r8.status}`);
  check(
    'auto: 完整账号凭据解析为 form 登录',
    !!r8.result?.steps?.some((s) => s.includes('登录方式：form（账号凭据）')),
    r8.result?.steps?.find((s) => s.startsWith('登录方式：')),
  );
  check(
    'auto: 确实填写并提交账密表单',
    ['已填写用户名', '已填写密码', '已点击登录按钮']
      .every((step) => r8.result?.steps?.includes(step)),
    r8.result?.steps
      ?.filter((s) => s.includes('填写') || s.includes('登录按钮'))
      .join(' | '),
  );

  // ── 轮次 10：缺少密码应在开页前预检失败 ───────────
  reset();
  await ext.evaluate(
    async ({ site }) => {
      await chrome.storage.local.set({
        sites: [site],
        // 空密码应由后台预检直接拒绝，不创建站点任务页
        accounts: [{ id: 'acc1', siteId: site.id, username: 'demo_user', password: '' }],
        status: {},
        results: {},
      });
    },
    { site: siteWith({ method: 'none' }) },
  );
  const failedTaskPages = [];
  const onFailedTaskPage = (page) => failedTaskPages.push(page);
  ctx.on('page', onFailedTaskPage);
  const bad = await ext.evaluate(
    () => new Promise((r) => chrome.runtime.sendMessage({ type: 'START_LOGIN', accountId: 'acc1' }, r)),
  );
  let badState = null;
  if (bad?.ok) {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      badState = await ext.evaluate(async () => {
        const r = await chrome.storage.local.get(['status', 'results']);
        return { status: r.status ?? {}, results: r.results ?? {} };
      });
      const v = accountStatus(badState, 'acc1');
      if (v === 'done' || v === 'failed') break;
      await new Promise((r) => setTimeout(r, 600));
    }
    await waitForQueueIdle();
    badState = await readAutomationState();
  }
  const badStatus = accountStatus(badState, 'acc1');
  const badMessage = badState?.results?.acc1?.message;
  console.log(`\n── 凭据预检失败 ──\n   状态=${badStatus}  说明=${badMessage}`);
  check('缺少密码被正确标记为 failed', badStatus === 'failed', `status=${badStatus}`);
  check(
    '缺少密码给出准确的配置说明',
    badMessage === '该账号缺少站点密码；请编辑账号并选择「站点账号密码」后填写',
    badMessage,
  );
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const retainedFailurePages = failedTaskPages.filter(
    (page) => !page.isClosed() && !page.url().startsWith('chrome-extension://'),
  );
  check('凭据预检失败不打开任务页', retainedFailurePages.length === 0, `open=${retainedFailurePages.length}`);
  ctx.off('page', onFailedTaskPage);
  for (const page of retainedFailurePages) await page.close().catch(() => {});
  await waitForQueueIdle(5_000);

  // ── 轮次 11：START_BATCH 由后台严格串行 ───────────
  reset();
  const batchSites = [
    siteWith({ method: 'api', apiUrl: '/api/batch/first', apiMethod: 'POST' }, 'batch-site-first'),
    siteWith({ method: 'api', apiUrl: '/api/batch/second', apiMethod: 'POST' }, 'batch-site-second'),
  ];
  const batchAccounts = [
    { id: 'batch-1', siteId: 'batch-site-first', username: 'batch_user_1', password: 'batch_pass_1' },
    { id: 'batch-2', siteId: 'batch-site-second', username: 'batch_user_2', password: 'batch_pass_2' },
  ];
  await ext.evaluate(
    async ({ sites, accounts }) => {
      await chrome.storage.session.remove('checkinQueue');
      await chrome.storage.local.set({ sites, accounts, status: {}, results: {} });
    },
    { sites: batchSites, accounts: batchAccounts },
  );

  // 用临时管理页发起批量后立刻关闭；队列必须继续在 background 中运行。
  const batchStarter = await ctx.newPage();
  await batchStarter.goto(`chrome-extension://${extId}/options.html`);
  await batchStarter.waitForLoadState('domcontentloaded');
  const enqueueStartedAt = Date.now();
  const batchResponse = await batchStarter.evaluate(
    () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'START_BATCH', accountIds: ['batch-1', 'batch-2'] }, resolve)),
  );
  const enqueueMs = Date.now() - enqueueStartedAt;
  await batchStarter.close();

  check('batch: START_BATCH 一次接受两个账号', batchResponse?.ok === true && batchResponse.queued === 2, JSON.stringify(batchResponse));
  check('batch: 入队响应不等待首个慢任务完成', enqueueMs < 2_000, `${enqueueMs}ms`);

  const batchState = await waitForTerminalAccounts(['batch-1', 'batch-2'], 70_000);
  const batchStatuses = ['batch-1', 'batch-2'].map((id) => accountStatus(batchState, id));
  const batchEvents = getBatchEvents();
  check('batch: 发起页面关闭后两个任务仍完成', batchStatuses.every((status) => status === 'done'), batchStatuses.join(', '));
  check('batch: 签到接口最大并发严格为 1', getBatchMaxActive() === 1, `max=${getBatchMaxActive()}`);
  check(
    'batch: 第二个任务只在第一个结束后启动',
    batchEvents.join(',') === 'start:first,end:first,start:second,end:second',
    batchEvents.join(','),
  );
  for (const p of ctx.pages()) {
    if (p.url().startsWith(ORIGIN)) await p.close().catch(() => {});
  }

  // ── 轮次 12：活动任务跨 origin 后不得取得凭据 ─────
  reset();
  const gateSite = siteWith(
    { method: 'none' },
    'gate-site',
    {
      loginUrl: `${ORIGIN}/gate-hold`,
      selectors: {
        username: '#gate-username',
        password: '#gate-password',
        submit: '#gate-submit',
      },
      closeModalSelectors: [],
    },
  );
  await ext.evaluate(
    async ({ site }) => {
      await chrome.storage.session.remove('checkinQueue');
      await chrome.storage.local.set({
        sites: [site],
        accounts: [{ id: 'gate-account', siteId: site.id, username: 'gate_user', password: 'gate_pass' }],
        status: {},
        results: {},
      });
    },
    { site: gateSite },
  );

  const gatePagePromise = ctx.waitForEvent('page', { timeout: 20_000 });
  const gateResponse = await ext.evaluate(
    () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'START_LOGIN', accountId: 'gate-account' }, resolve)),
  );
  const gatePage = await gatePagePromise;
  await gatePage.waitForURL(new RegExp(`localhost:${PORT}/gate-hold`), { timeout: 20_000 });
  check('origin gate: 本站任务已启动', gateResponse?.ok === true, JSON.stringify(gateResponse));

  const gateTarget = `http://127.0.0.1:${PORT}/gate-target`;
  await gatePage.goto(gateTarget, { waitUntil: 'domcontentloaded' });
  await gatePage.waitForTimeout(1_500);
  const gateForm = await gatePage.evaluate(() => ({
    username: document.querySelector('#gate-username')?.value ?? '',
    password: document.querySelector('#gate-password')?.value ?? '',
    inputEvents: Number(document.body.dataset.inputEvents ?? '0'),
  }));
  const gateStorage = await ext.evaluate(async ({ target, accountId }) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((item) => item.url?.startsWith(target));
    const taskKey = tab?.id == null ? '' : `task:${tab.id}`;
    const [task, local] = await Promise.all([
      taskKey ? chrome.storage.session.get(taskKey) : Promise.resolve({}),
      chrome.storage.local.get('status'),
    ]);
    const status = Object.entries(local.status ?? {}).find(([key]) => key.startsWith(`${accountId}:`))?.[1] ?? 'none';
    return { hasTask: !!taskKey && !!task[taskKey], status };
  }, { target: gateTarget, accountId: 'gate-account' });

  check(
    'origin gate: 跨 origin 表单未被填入',
    gateForm.username === '' && gateForm.password === '' && gateForm.inputEvents === 0,
    `inputEvents=${gateForm.inputEvents}`,
  );
  check('origin gate: 后台拒绝派发但保留原任务', gateStorage.hasTask && gateStorage.status === 'running', JSON.stringify(gateStorage));

  // 任务仍挂在信箱里：实时进度接口应能看到这个账号「正在签到」及其阶段
  const liveSnapshot = await ext.evaluate(
    () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'GET_LIVE_TASKS' }, resolve)),
  );
  const liveAccount = (liveSnapshot?.feature?.live ?? []).find((t) => t.accountId === 'gate-account');
  check(
    'origin gate: 实时进度能看到正在签到的账号',
    liveSnapshot?.ok === true && !!liveAccount && liveAccount.stage === 'login' && Array.isArray(liveAccount.steps),
    JSON.stringify(liveSnapshot),
  );
  await gatePage.close();
  const gateFinalState = await waitForTerminalAccounts(['gate-account'], 10_000);
  check('origin gate: 关闭接管页后任务正常清理', accountStatus(gateFinalState, 'gate-account') === 'failed');

  // ── 轮次 13：需处理状态关页终结，旧 runId 不得覆盖 ─
  const attentionSite = { ...gateSite, id: 'attention-site' };
  await ext.evaluate(async ({ site }) => {
    await chrome.storage.session.remove('checkinQueue');
    await chrome.storage.local.set({
      sites: [site],
      accounts: [{ id: 'attention-account', siteId: site.id, username: 'attention_user', password: 'attention_pass' }],
      status: {},
      results: {},
    });
  }, { site: attentionSite });

  const attentionPagePromise = ctx.waitForEvent('page', { timeout: 20_000 });
  await ext.evaluate(
    () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'START_LOGIN', accountId: 'attention-account' }, resolve)),
  );
  const attentionPage = await attentionPagePromise;
  await attentionPage.waitForURL(new RegExp(`localhost:${PORT}/gate-hold`), { timeout: 20_000 });
  const attentionTask = await ext.evaluate(async () => {
    const queue = (await chrome.storage.session.get('checkinQueue')).checkinQueue;
    const tabId = queue?.active?.tabId;
    const task = tabId > 0 ? (await chrome.storage.session.get(`task:${tabId}`))[`task:${tabId}`] : null;
    return { tabId, runId: task?.runId };
  });

  const attentionResponse = await ext.evaluate(async ({ tabId, runId }) => {
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (id) => chrome.runtime.sendMessage({
        type: 'NEEDS_USER',
        runId: id,
        message: '测试需要人工处理',
        steps: ['进入人工处理'],
      }),
      args: [runId],
    });
    return execution.result;
  }, attentionTask);
  const attentionState = await readAutomationState();
  check(
    'lifecycle: NEEDS_USER 立即进入需处理状态',
    attentionResponse?.ok === true && accountStatus(attentionState, 'attention-account') === 'attention',
  );
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  check('lifecycle: 需人工处理时保留任务标签页', !attentionPage.isClosed());

  const staleResponse = await ext.evaluate(async ({ tabId }) => {
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => chrome.runtime.sendMessage({
        type: 'TASK_RESULT',
        runId: 'stale-run-id',
        result: { accountId: 'attention-account', ok: true, message: '迟到成功', steps: [] },
      }),
    });
    return execution.result;
  }, attentionTask);
  const afterStale = await readAutomationState();
  check(
    'lifecycle: 旧 runId 的成功结果被拒绝',
    staleResponse?.ok === false && accountStatus(afterStale, 'attention-account') === 'attention',
    JSON.stringify(staleResponse),
  );

  await attentionPage.close();
  const attentionFinal = await waitForTerminalAccounts(['attention-account'], 10_000);
  check(
    'lifecycle: 需处理标签关闭后终结为失败',
    accountStatus(attentionFinal, 'attention-account') === 'failed',
  );

  // ── 轮次 14：删除运行中与排队账号必须同步取消 ────
  reset();
  const cancelSites = [
    siteWith({ method: 'api', apiUrl: '/api/batch/first', apiMethod: 'POST' }, 'cancel-site-first'),
    siteWith({ method: 'api', apiUrl: '/api/batch/second', apiMethod: 'POST' }, 'cancel-site-second'),
  ];
  const cancelAccounts = [
    { id: 'cancel-1', siteId: 'cancel-site-first', username: 'cancel_user_1', password: 'cancel_pass_1' },
    { id: 'cancel-2', siteId: 'cancel-site-second', username: 'cancel_user_2', password: 'cancel_pass_2' },
  ];
  await ext.evaluate(async ({ sites, accounts }) => {
    await chrome.storage.session.remove('checkinQueue');
    await chrome.storage.local.set({ sites, accounts, status: {}, results: {} });
  }, { sites: cancelSites, accounts: cancelAccounts });
  await ext.evaluate(
    () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'START_BATCH', accountIds: ['cancel-1', 'cancel-2'] }, resolve)),
  );

  const cancelDeadline = Date.now() + 30_000;
  while (!getBatchEvents().includes('start:first') && Date.now() < cancelDeadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  check('delete: 删除前首个任务确实正在运行', getBatchEvents().includes('start:first'), getBatchEvents().join(','));
  const deleteResponse = await ext.evaluate(
    () => new Promise((resolve) => chrome.runtime.sendMessage({
      type: 'MUTATE_APP',
      mutation: { action: 'delete-entities', siteIds: [], accountIds: ['cancel-1', 'cancel-2'] },
    }, resolve)),
  );
  await waitForQueueIdle();
  await new Promise((r) => setTimeout(r, 3_000));
  const deletedState = await ext.evaluate(async () => {
    const local = await chrome.storage.local.get(['accounts', 'status', 'results']);
    const queue = (await chrome.storage.session.get('checkinQueue')).checkinQueue;
    return { ...local, queue };
  });
  check('delete: 后台接受批量删除并取消任务', deleteResponse?.ok === true, JSON.stringify(deleteResponse));
  check('delete: 运行中与排队账号均已删除', (deletedState.accounts ?? []).length === 0);
  check(
    'delete: 迟到响应未重建孤儿状态或结果',
    Object.keys(deletedState.status ?? {}).length === 0 && Object.keys(deletedState.results ?? {}).length === 0,
    JSON.stringify({ status: deletedState.status, results: deletedState.results }),
  );
  check(
    'delete: 队列已清空',
    !deletedState.queue?.active && !(deletedState.queue?.pendingAccountIds?.length > 0),
    JSON.stringify(deletedState.queue),
  );
  for (const p of ctx.pages()) {
    if (p.url().startsWith(ORIGIN)) await p.close().catch(() => {});
  }
  }
} finally {
  await ctx.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length === 0 ? 0 : 1);
