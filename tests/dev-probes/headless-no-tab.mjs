/**
 * 验证混合签到的核心承诺：**直连成功时不开标签页。**
 *
 * headless-cookie-proof.mjs 证明了后台 fetch 带 cookie；这里证明整条链
 * 真的因此省掉了标签页 —— 这是用户提出需求的原话（"打开的窗口太多了"）。
 *
 * 断言的是标签页数量，而不是"直连是否被调用"：省窗口是用户能感知的目标，
 * 内部走了哪条分支只是手段。同时验证回退路径仍会开标签页，
 * 否则"不开窗"可能只是因为整条流程根本没跑起来。
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXT = process.env.EXTENSION_DIR
  ? resolve(ROOT, process.env.EXTENSION_DIR)
  : join(ROOT, '.output', 'chrome-mv3');

const PORT = 8232;
const ORIGIN = `http://localhost:${PORT}`;
/**
 * 第二个站点必须是**独立 origin**。
 *
 * 端点路径是绝对的（`/api/user/checkin`），用 `new URL` 对 loginUrl 解析时
 * 会丢掉 `/nosupport` 这类路径前缀，最终打到同一个站点的真实接口上 ——
 * 那样根本测不到"无接口站点"。换端口才是真的换站。
 */
const PORT_NO_API = 8233;
const ORIGIN_NO_API = `http://localhost:${PORT_NO_API}`;
const HEADLESS = process.env.E2E_HEADLESS === '1';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? `  — ${detail}` : ''}`);
};

/** 站点状态：quota 会因签到增加，让守恒差分能确认奖励 */
let quota = 100_000;
let checkinCount = 0;
const hits = [];

const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  hits.push(url);
  const json = (status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  if (url === '/login') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': 'session=LIVE-SESSION; Path=/; HttpOnly; SameSite=Strict',
    });
    res.end(`<!doctype html><html><body><form>
      <input name="username"><input type="password"><button type="submit">登录</button>
    </form></body></html>`);
    return;
  }

  const authed = (req.headers.cookie ?? '').includes('LIVE-SESSION');

  // 余额端点：守恒差分的两次快照都打它
  if (url === '/api/user/self') {
    if (!authed) return json(401, { success: false, message: '未登录' });
    return json(200, { success: true, data: { quota, used_quota: 0 } });
  }

  // 签到端点：成功并真的发额度，让差分判定为 rewarded
  if (url === '/api/user/checkin') {
    if (!authed) return json(401, { success: false, message: '未登录' });
    checkinCount += 1;
    quota += 50_000;
    return json(200, { success: true, message: '签到成功' });
  }

  json(404, {});
});

/**
 * 第二个站点：有登录页，但**没有任何签到接口**（一律 404）。
 * 用来验证直连判定 unsupported 后确实回退到浏览器自动化。
 */
const serverNoApi = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  if (url === '/login') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><title>无接口站</title></head><body><form>
      <input name="username"><input type="password"><button type="submit">登录</button>
    </form></body></html>`);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{}');
});

await new Promise((done) => server.listen(PORT, done));
await new Promise((done) => serverNoApi.listen(PORT_NO_API, done));

const profile = mkdtempSync(join(tmpdir(), 'headless-no-tab-'));
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

try {
  // 找到扩展 ID
  let extId = null;
  for (let round = 0; round < 20 && !extId; round += 1) {
    const worker = ctx.serviceWorkers().find((item) => item.url().startsWith('chrome-extension://'));
    if (worker) extId = new URL(worker.url()).hostname;
    else await new Promise((done) => setTimeout(done, 400));
  }
  check('扩展已加载', !!extId, extId ?? '');
  if (!extId) throw new Error('无法确定扩展 ID');

  const ext = await ctx.newPage();
  await ext.goto(`chrome-extension://${extId}/options.html`);
  await ext.waitForLoadState('domcontentloaded');
  await new Promise((done) => setTimeout(done, 800));

  // 先在普通标签页登录，建立浏览器侧会话（真实用法：用户手动登录一次）
  const loginPage = await ctx.newPage();
  await loginPage.goto(`${ORIGIN}/login`);
  await loginPage.waitForLoadState('domcontentloaded');
  await loginPage.close();

  /**
   * 写入站点与账号配置。
   *
   * 每个场景用独立的 accountId：results 按 accountId 存，复用同一个
   * 会让第二轮立刻读到上一轮的旧结果就返回，断言等于没跑。
   */
  async function seed(siteId, accountId, origin) {
    await ext.evaluate(async ({ siteId, accountId, origin }) => {
      await chrome.storage.local.set({
        sites: [{
          id: siteId,
          name: '直连测试站',
          loginUrl: `${origin}/login`,
          pointerMode: 'dom',
          selectors: {
            username: 'input[name="username"]',
            password: 'input[type="password"]',
            submit: 'button[type="submit"]',
          },
          closeModalSelectors: [],
          checkin: { method: 'auto' },
          adapter: { siteType: 'new-api', family: 'new-api', quotaPerUnit: 500000 },
        }],
        accounts: [{
          id: accountId,
          siteId,
          username: 'user@example.com',
          password: 'pw',
          identity: { userId: '42' },
        }],
        status: {},
        results: {},
        headlessStats: {},
      });
    }, { siteId, accountId, origin });
  }

  /** 触发签到并等结果落库 */
  async function runAndWait(accountId, timeoutMs = 30_000) {
    const before = ctx.pages().length;
    let peak = before;
    await ext.evaluate(async (id) => new Promise((done) => {
      chrome.runtime.sendMessage({ type: 'START_BATCH', accountIds: [id] }, done);
    }), accountId);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      peak = Math.max(peak, ctx.pages().length);
      const state = await ext.evaluate(async () => {
        const stored = await chrome.storage.local.get(['status', 'results']);
        return { status: stored.status ?? {}, results: stored.results ?? {} };
      });
      const result = state.results[accountId];
      if (result) return { result, peakTabs: peak, baseTabs: before };
      await new Promise((done) => setTimeout(done, 250));
    }
    return { result: null, peakTabs: peak, baseTabs: before };
  }

  // ── 场景一：站点有签到接口 → 应当零标签页完成 ──
  await seed('site-direct', 'acc-direct', ORIGIN);
  const direct = await runAndWait('acc-direct');

  check('直连场景已产出结果', !!direct.result, direct.result?.message ?? '无结果');
  check(
    '结果标记为 API 直连',
    direct.result?.via === 'headless',
    `via=${direct.result?.via ?? '<空>'}`,
  );
  check('直连结果为成功', direct.result?.ok === true, direct.result?.message ?? '');
  check(
    '守恒差分确认奖励到账',
    direct.result?.metrics?.verdict === 'rewarded',
    `verdict=${direct.result?.metrics?.verdict ?? '<空>'}`,
  );
  check(
    '全程没有新开标签页',
    direct.peakTabs <= direct.baseTabs,
    `标签页 ${direct.baseTabs} → 峰值 ${direct.peakTabs}`,
  );
  check('签到接口确实被调用了一次', checkinCount === 1, `count=${checkinCount}`);

  // ── 场景二：站点无签到接口 → 必须回退并开标签页 ──
  // 这条同样重要：否则"不开窗"可能只是流程压根没跑。
  hits.length = 0;
  await seed('site-nosupport', 'acc-nosupport', ORIGIN_NO_API);
  const fallback = await runAndWait('acc-nosupport', 45_000);

  check(
    '无接口站点回退到浏览器流程（确实开了标签页）',
    fallback.peakTabs > fallback.baseTabs,
    `标签页 ${fallback.baseTabs} → 峰值 ${fallback.peakTabs}`,
  );
  check(
    '回退结果未被标记为直连',
    fallback.result?.via !== 'headless',
    `via=${fallback.result?.via ?? '<空>'}`,
  );
} finally {
  await ctx.close();
  server.close();
  serverNoApi.close();
  rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
if (failed.length) {
  console.error('\n未通过：');
  for (const item of failed) console.error(`  - ${item.name} ${item.detail}`);
  process.exit(1);
}
console.log('混合签到已实测：直连成功零标签页，不支持的站点正确回退。');
