/**
 * 真实扩展 e2e 的共享启动辅助。
 *
 * 存在的理由（长跑 10 次里唯一那次失败，2026-10-08 实测）：
 *
 *   browserContext.waitForEvent: Timeout 30000ms exceeded while waiting for
 *   event "serviceworker"
 *
 * 旧写法 `context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')`
 * 有一个必然的竞态：**先检查、后注册**。持久化上下文刚启动时 Service Worker
 * 可能还没注册（首查为空），而当它随后启动时，`waitForEvent` 的监听器可能
 * 还没挂上 —— 事件已经错过，于是永远等不到，30 秒后超时。这是测试基础设施
 * 缺陷，不是产品缺陷：扩展本身加载正常，只是我们没拿到 worker 句柄。
 *
 * 正确顺序是：**先注册监听、再查一次快照**。这能同时覆盖「事件已错过」
 * （快照里有）与「事件还没到」（监听器已就绪）两种时序。
 *
 * 仍然拿不到时按顺序回退，每一步都有明确上限：
 *   1. serviceWorkers() 快照；
 *   2. 注册 waitForEvent 后再查一次快照；
 *   3. backgroundPages()（MV2 形态）；
 *   4. 从 chrome://extensions 的 shadow DOM 读出扩展 id，打开扩展页把
 *      Service Worker 唤醒，再等一次（这同时避免了对 `chrome://` 页面的
 *      能力做任何假设 —— 读不到就走第 5 步）；
 *   5. 抛出带完整诊断的超时错误，而不是让调用方看到一句没有上下文的
 *      "Timeout 30000ms exceeded"。
 *
 * 本文件不依赖任何测试框架，只依赖 playwright 与 node 标准库。
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** 默认给 Service Worker 注册的时间上限，单独放出来便于测试与调参。 */
export const DEFAULT_SW_TIMEOUT_MS = 30_000;
export const DEFAULT_PAGE_TIMEOUT_MS = 20_000;

export function resolveExtensionDir(envValue, fallback) {
  return envValue ? resolve(envValue) : resolve(fallback);
}

/**
 * 等一个扩展 Service Worker，并如实记录「它是怎么被拿到的」。
 *
 * 返回值里的 `via` 是诊断信息，会被打印进每一轮 e2e 的输出：
 *   - 'snapshot'        启动后立刻就在（最理想）
 *   - 'event'           注册监听后由事件送达
 *   - 'snapshot-retry'  注册监听后发现它其实已经在了（旧写法漏掉的正是这一种）
 *   - 'woken'           靠打开扩展页唤醒
 */
export async function waitForExtensionWorker(context, options = {}) {
  const {
    timeoutMs = DEFAULT_SW_TIMEOUT_MS,
    log = () => {},
    wake = null,
  } = options;
  const startedAt = Date.now();
  const initial = context.serviceWorkers();
  if (initial.length > 0) {
    return { worker: initial[0], via: 'snapshot', elapsedMs: Date.now() - startedAt, initialCount: initial.length };
  }

  /*
   * 关键修复：**先注册监听、再查一次快照**。
   *
   * 旧写法 `serviceWorkers()[0] ?? await waitForEvent(...)` 是先查后注册：
   * 若 Worker 在两步之间启动完成，事件已经错过，之后永远等不到 —— 30 秒超时。
   * 注册在前时，「事件已错过」（快照里有）与「事件还没到」（监听器已就绪）
   * 两种时序都被覆盖。
   */
  let fromEvent = null;
  let eventError = null;
  const eventPromise = context
    .waitForEvent('serviceworker', { timeout: timeoutMs })
    .then((worker) => { fromEvent = worker; return worker; })
    .catch((error) => { eventError = error; return null; });

  const afterRegister = context.serviceWorkers();
  if (afterRegister.length > 0) {
    void eventPromise;
    return {
      worker: afterRegister[0],
      via: 'snapshot-retry',
      elapsedMs: Date.now() - startedAt,
      initialCount: initial.length,
    };
  }

  const backgroundPage = context.backgroundPages()[0];
  if (backgroundPage) {
    void eventPromise;
    return {
      worker: backgroundPage,
      via: 'background-page',
      elapsedMs: Date.now() - startedAt,
      initialCount: 0,
    };
  }

  log('Service Worker 尚未注册，等待 serviceworker 事件…');

  /*
   * 事件在手时也可能等不到（机器负载高时整台浏览器都在慢慢启动）。
   * 这里按固定节奏**有界**地补两件事，而不是干等：
   *   - 复查一次快照（事件可能在检查之后才送达）；
   *   - 用扩展页唤醒后台（MV3 的 Worker 会在扩展页被打开时启动）。
   *
   * 每一步都在 deadline 之内；到点就抛带完整诊断的错误，绝不无限等。
   */
  let wakeAttempts = 0;
  let lastWakeError = null;
  while (Date.now() - startedAt < timeoutMs) {
    if (fromEvent) {
      return { worker: fromEvent, via: 'event', elapsedMs: Date.now() - startedAt, initialCount: 0 };
    }
    const snapshot = context.serviceWorkers();
    if (snapshot.length > 0) {
      void eventPromise;
      return {
        worker: snapshot[0],
        via: 'snapshot-during-wait',
        elapsedMs: Date.now() - startedAt,
        initialCount: 0,
      };
    }
    // 唤醒是有代价的（会多开一个页面），所以按间隔做，不每轮都做。
    const shouldWake = wake
      && wakeAttempts < MAX_WAKE_ATTEMPTS
      && Date.now() - startedAt >= (wakeAttempts + 1) * WAKE_INTERVAL_MS;
    if (shouldWake) {
      wakeAttempts += 1;
      log(`未收到 serviceworker 事件，第 ${wakeAttempts} 次尝试唤醒后台…`);
      try {
        const extensionId = await wake();
        if (extensionId) {
          const revived = context.serviceWorkers();
          if (revived.length > 0) {
            void eventPromise;
            return {
              worker: revived[0],
              via: 'woken',
              elapsedMs: Date.now() - startedAt,
              initialCount: 0,
              extensionId,
              wakeAttempts,
            };
          }
        } else {
          lastWakeError = '无法从 chrome://extensions 读到扩展 id';
        }
      } catch (error) {
        lastWakeError = error instanceof Error ? error.message : String(error);
      }
    }
    await new Promise((done) => setTimeout(done, WAKE_POLL_MS));
  }

  void eventPromise;
  throw new Error(
    `扩展 Service Worker 未在 ${timeoutMs}ms 内注册：serviceWorkers=${context.serviceWorkers().length} `
    + `backgroundPages=${context.backgroundPages().length}；唤醒尝试 ${wakeAttempts} 次`
    + `${lastWakeError ? `，最后一次唤醒失败：${lastWakeError}` : ''}`
    + `${eventError ? `；事件等待结果：${String(eventError).split('\n')[0]}` : ''}。`
    + '请确认 manifest 使用 background.service_worker，且扩展未被 Chromium 拒绝加载'
    + '（也可临时用 E2E_HEADLESS=0 观察浏览器里的扩展列表）。',
  );
}

/** 唤醒尝试的上限与节奏：既给慢机器留出时间，又保证总时长有界。 */
const MAX_WAKE_ATTEMPTS = 4;
const WAKE_INTERVAL_MS = 3_000;
const WAKE_POLL_MS = 150;

/**
 * 从 chrome://extensions 的 shadow DOM 里读出唯一加载的扩展 id。
 *
 * 只作为**兜底**使用：正常路径永远走 serviceworker 事件。读不到就返回 null，
 * 由调用方如实报错，不在这里抛。
 */
export async function discoverExtensionIdFromChromeExtensions(context, { timeoutMs = 10_000 } = {}) {
  const page = await context.newPage().catch(() => null);
  if (!page) return null;
  try {
    await page.goto('chrome://extensions/', { timeout: timeoutMs }).catch(() => {});
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ids = await page.evaluate(() => {
        const manager = document.querySelector('extensions-manager');
        const list = manager?.shadowRoot?.querySelector('extensions-item-list');
        const items = list?.shadowRoot?.querySelectorAll('extensions-item') ?? [];
        return [...items].map((item) => item.id).filter(Boolean);
      }).catch(() => []);
      if (ids.length > 0) return ids[0];
      await new Promise((done) => setTimeout(done, 200));
    }
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * 启动带扩展的持久化上下文，并保证拿到可用的 Service Worker。
 *
 * 返回的 diagnostics 会被 e2e 打印出来 —— 「扩展是怎么起来的」本身就是
 * 可靠性的证据，不能只留在失败时的堆栈里。
 */
export async function launchExtensionContext(options) {
  const {
    chromium,
    profileDir,
    extensionDir,
    headless = true,
    args = [],
    viewport = { width: 1280, height: 900 },
    channel = 'chromium',
    swTimeoutMs = DEFAULT_SW_TIMEOUT_MS,
    log = (msg) => console.log(msg),
  } = options;
  if (!existsSync(extensionDir)) {
    throw new Error(`扩展构建产物不存在: ${extensionDir}（先运行 npx wxt build）`);
  }
  const launchArgs = [
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    ...args,
  ];
  const context = await chromium.launchPersistentContext(profileDir, {
    headless,
    ...(headless ? { channel } : {}),
    viewport,
    args: launchArgs,
  });

  /**
   * 目标级噪声的观测记录（供调用方在收尾前后区分阶段）。
   *
   * 不加这一段时，Chromium 里某个标签页崩溃只会以 Playwright 内部的
   * `Error: Target crashed` 冒出来，既没有 URL 也没有上下文 —— 无法判断是
   * 产品把页面搞崩了，还是测试基础设施（多开 / profile 回收）出了问题。
   */
  const crashes = [];
  const noteTargetProblem = (url, kind, detail) => {
    crashes.push({ url, kind, detail: String(detail).slice(0, 240), at: Date.now() });
    log(`[harness] 目标${kind}：${url} — ${String(detail).slice(0, 160)}`);
  };
  context.on('page', (page) => {
    page.on('crash', () => noteTargetProblem(page.url(), '崩溃', 'page crash'));
    page.on('pageerror', (error) => noteTargetProblem(page.url(), '脚本异常', error?.message ?? error));
  });
  for (const page of context.pages()) {
    page.on('crash', () => noteTargetProblem(page.url(), '崩溃', 'page crash'));
  }
  context.on('serviceworker', (worker) => {
    worker.on('close', () => noteTargetProblem(worker.url(), 'Worker 关闭', 'service worker stopped'));
  });

  try {
    const { worker, via, elapsedMs, initialCount } = await waitForExtensionWorker(context, {
      timeoutMs: swTimeoutMs,
      log,
      wake: async () => {
        const id = await discoverExtensionIdFromChromeExtensions(context);
        if (!id) return null;
        // 打开扩展页即可把 MV3 的 background worker 唤醒。
        const page = await context.newPage();
        await page.goto(`chrome-extension://${id}/options.html`).catch(() => {});
        return id;
      },
    });
    const extensionId = new URL(worker.url()).hostname;
    const diagnostics = {
      via,
      elapsedMs,
      initialServiceWorkers: initialCount,
      extensionId,
      extensionDir,
      userAgentArgs: launchArgs.length,
    };
    return { context, worker, extensionId, diagnostics: { ...diagnostics, crashes } };
  } catch (error) {
    await context.close().catch(() => {});
    throw new Error(
      `扩展启动失败: ${error instanceof Error ? error.message : String(error)}\n`
      + `扩展目录: ${extensionDir}\n启动参数: ${launchArgs.join(' ')}`,
    );
  }
}

/** 打开扩展自身的某个页面（options / sidepanel），并等到 DOM 就绪。 */
export async function openExtensionPage(context, extensionId, path = 'options.html') {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${path}`);
  await page.waitForLoadState('domcontentloaded');
  return page;
}

/** 一次性灌入 storage.local 的站点/账号/结果/状态。 */
export async function seedAppStorage(app, { sites = [], accounts = [], proxies = [], results = {}, status = {} }) {
  await app.evaluate(async (payload) => {
    await chrome.storage.local.set({
      sites: payload.sites,
      accounts: payload.accounts,
      proxies: payload.proxies,
      results: payload.results,
      status: payload.status,
    });
  }, { sites, accounts, proxies, results, status });
}

/** 读界面依赖的全部状态：状态台账、结果、队列、任务信箱。 */
export async function readAppState(app) {
  return app.evaluate(async () => {
    const local = await chrome.storage.local.get(['status', 'results', 'sites', 'accounts']);
    const session = await chrome.storage.session.get(null);
    const queue = session.checkinQueue ?? { pendingAccountIds: [] };
    const liveTasks = Object.entries(session)
      .filter(([key]) => key.startsWith('task:'))
      .map(([key, value]) => ({
        key,
        tabId: value?.tabId,
        accountId: value?.accountId,
        runId: value?.runId,
        stage: value?.stage,
        steps: Array.isArray(value?.steps) ? value.steps : [],
      }));
    return {
      status: local.status ?? {},
      results: local.results ?? {},
      sites: local.sites ?? [],
      accounts: local.accounts ?? [],
      queue: { active: queue.active ?? null, pendingAccountIds: queue.pendingAccountIds ?? [] },
      liveTasks,
    };
  });
}

export function statusOf(state, accountId) {
  return Object.entries(state.status ?? {})
    .find(([key]) => key.startsWith(`${accountId}:`))?.[1];
}

export function queueBusy(state) {
  return Boolean(state.queue?.active) || (state.queue?.pendingAccountIds?.length ?? 0) > 0;
}

/**
 * 等一个账号走到终态（有结果且队列不再占用它）。
 *
 * 返回最后快照，不抛错 —— 由调用方决定怎么断言，失败时能打印真实状态。
 */
export async function waitForAccountSettled(app, accountId, { timeoutMs = 90_000, pollMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = await readAppState(app);
  while (Date.now() < deadline) {
    const result = last.results?.[accountId];
    const ownedByQueue = last.queue?.active?.accountId === accountId
      || (last.queue?.pendingAccountIds ?? []).includes(accountId);
    const stillHasTask = last.liveTasks.some((task) => task.accountId === accountId);
    const status = statusOf(last, accountId);
    if (result && status && status !== 'running' && status !== 'pending'
      && !ownedByQueue && !stillHasTask) return last;
    await new Promise((done) => setTimeout(done, pollMs));
    last = await readAppState(app);
  }
  return last;
}

/** 等一个账号真的开始跑（队列占用它，且有任务信箱）。用于「跑到一半再打断」的用例。 */
export async function waitForAccountRunning(app, accountId, { timeoutMs = 60_000, pollMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = await readAppState(app);
  while (Date.now() < deadline) {
    const active = last.queue?.active?.accountId === accountId;
    const hasTask = last.liveTasks.some((task) => task.accountId === accountId);
    if (active && hasTask) return last;
    await new Promise((done) => setTimeout(done, pollMs));
    last = await readAppState(app);
  }
  return last;
}

/** 等队列彻底空下来（每个用例收尾都要断言，避免「看着结束其实卡着」）。 */
export async function waitForQueueIdle(app, { timeoutMs = 30_000, pollMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = await readAppState(app);
  while (Date.now() < deadline) {
    if (!queueBusy(last)) return last;
    await new Promise((done) => setTimeout(done, pollMs));
    last = await readAppState(app);
  }
  return last;
}

export async function startAccount(app, accountId) {
  return app.evaluate((id) => chrome.runtime.sendMessage({ type: 'START_LOGIN', accountId: id }), accountId);
}

export async function stopAccounts(app, accountIds) {
  return app.evaluate((ids) => chrome.runtime.sendMessage({ type: 'CANCEL_CHECKIN', accountIds: ids }), accountIds);
}

/**
 * 按固定间隔采样「当前生效的扩展代理」与「队列正在跑哪个账号」。
 *
 * 为什么要这样断言「各自代理」：`applyProxy` 的 bypassList 里永远包含
 * `localhost` / `127.0.0.1` / `<local>` —— 这是扩展的**正确**行为（否则扩展页
 * 自身的请求也会被绕进代理），但也意味着**用回环地址搭的虚构站点永远测不到
 * 代理转发**。硬要观测转发就得给虚构站点配一个非回环域名 + 可信证书，
 * 那测的是证书链而不是代理归属。
 *
 * 所以这里换一个更直接、也更贴近用户诉求的观测对象：**扩展真正下发给浏览器
 * 的那条全局代理**，以及它当时正在给哪个账号跑任务。两者配对记录，就能回答
 * 「A 跑的时候挂的是 A 的出口吗」——「各自代理」的本体就在这里。
 *
 * 返回 stop()：停止采样并交付记录。
 */
export function startProxyAttributionSampler(app, { intervalMs = 120 } = {}) {
  const samples = [];
  let stopped = false;
  let inFlight = null;
  const tick = async () => {
    if (stopped) return;
    try {
      const [proxy, state] = await Promise.all([readProxyState(app), readAppState(app)]);
      samples.push({
        at: Date.now(),
        activeAccountId: state.queue?.active?.accountId ?? null,
        activeTabId: state.queue?.active?.tabId ?? null,
        levelOfControl: proxy.levelOfControl,
        mode: proxy.mode,
        port: proxy.singleProxy?.port ?? null,
        host: proxy.singleProxy?.host ?? null,
      });
    } catch {
      // 页面正在导航或已被关闭：跳过这一拍，不把采样失败算成产品失败。
    }
  };
  const loop = async () => {
    while (!stopped) {
      inFlight = tick();
      await inFlight;
      if (stopped) break;
      await new Promise((done) => setTimeout(done, intervalMs));
    }
  };
  const running = loop();
  return {
    async stop() {
      stopped = true;
      await running.catch(() => {});
      await inFlight?.catch(() => {});
      return samples;
    },
  };
}

/** 从归因采样里抽出「某账号活跃期间，扩展下发的代理端口集合」。 */
export function proxyPortsForAccount(samples, accountId) {
  const ports = new Set();
  for (const sample of samples) {
    if (sample.activeAccountId !== accountId) continue;
    if (sample.levelOfControl !== 'controlled_by_this_extension') continue;
    if (sample.port != null) ports.add(sample.port);
  }
  return [...ports];
}

/** 读浏览器当前生效的扩展代理；任务结束后必须是「没人接管」。 */
export async function readProxyState(app) {
  return app.evaluate(async () => {
    const settings = await new Promise((resolve) => chrome.proxy.settings.get({ incognito: false }, resolve));
    return {
      levelOfControl: settings?.levelOfControl,
      mode: settings?.value?.mode,
      singleProxy: settings?.value?.rules?.singleProxy ?? null,
    };
  });
}

/** 读某个站点当前会话里的 Cookie（只看名字与存在性，不落任何值）。 */
export async function readSiteCookieNames(app, url) {
  return app.evaluate(async (target) => {
    const cookies = await chrome.cookies.getAll({ url: target });
    return cookies.map((cookie) => ({ name: cookie.name, httpOnly: cookie.httpOnly, domain: cookie.domain }));
  }, url);
}

/**
 * 从**扩展页**读虚构站点的观测快照。
 *
 * 必须走浏览器而不是 Node：站点会话是 HttpOnly Cookie，只有浏览器带得上。
 * 用 Node 的 fetch 读 `/api/matrix/state` 永远得到 `sessionUser: null`，
 * 于是「会话属于谁」这条断言会永远为假 —— 那是观测方法错，不是产品错。
 */
export async function readMatrixState(app, site) {
  return app.evaluate(async (origin) => {
    const response = await fetch(`${origin}/api/matrix/state`, { credentials: 'include', cache: 'no-store' });
    return response.json();
  }, site.origin);
}

/**
 * 关闭上下文前先把页面收干净。
 *
 * 直接 `context.close()` 时，若还有页面正处于导航中，Chromium 会在
 * 「渲染进程仍在拆页面」与「浏览器进程已在退出」之间打架，Playwright 侧报
 * `Error: Target crashed`。这个错误出现在用例断言**之后**、收尾阶段，看起来
 * 像产品崩溃，实际是测试收尾时序 —— 必须在观测上与真正的崩溃区分开。
 *
 * 顺序：等队列空闲 → 关掉除扩展页之外的全部页面 → 让出一拍 → 关上下文。
 * 扩展页留到最后一起关，避免中途 Service Worker 被回收打断收尾。
 */
export async function disposeContext(context, { app = null, timeoutMs = 15_000 } = {}) {
  if (!context) return { closedPages: 0 };
  let closedPages = 0;
  try {
    const deadline = Date.now() + timeoutMs;
    while (app && Date.now() < deadline) {
      try {
        const state = await readAppState(app);
        if (!queueBusy(state) && state.liveTasks.length === 0) break;
      } catch {
        break;
      }
      await new Promise((done) => setTimeout(done, 150));
    }
    for (const page of context.pages()) {
      if (page === app) continue;
      await page.close({ runBeforeUnload: false }).catch(() => {});
      closedPages += 1;
    }
    await new Promise((done) => setTimeout(done, 300));
  } finally {
    await context.close().catch(() => {});
  }
  return { closedPages };
}

/** 关掉上下文与临时 profile；profile 目录保留还是删除由调用方决定。 */






