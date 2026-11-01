/**
 * 验证整条 headless 直连唯一没实测过的环节：
 * **background service worker 的 fetch 到底带不带站点 cookie。**
 *
 * Chrome 文档说「扩展有 host permissions 时，对第三方的请求按 same-site 处理」。
 * 这句话是整条快路径的地基 —— 但它只是文档。这里用真实浏览器 + 真实扩展
 * 打一次真实请求，让服务端说出它收到了什么。
 *
 * 同时验证两条已知限制：
 *  1. HttpOnly cookie 也能带上（签到接口靠的就是它）
 *  2. SameSite=Strict 也能带上（文档明确说会）
 *
 * 单独成脚本而不并入 e2e.mjs：这是一次性的地基确认，
 * 关心的是浏览器行为而非扩展逻辑，混进去只会让那份用例更难读。
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

const PORT = 8231;
const ORIGIN = `http://localhost:${PORT}`;
const HEADLESS = process.env.E2E_HEADLESS === '1';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? `  — ${detail}` : ''}`);
};

/** 服务端记录每个请求实际收到的 cookie 与请求头 */
const seen = [];

const server = createServer((req, res) => {
  const url = req.url ?? '/';
  seen.push({
    url,
    cookie: req.headers.cookie ?? '',
    userIdHeader: req.headers['new-api-user'] ?? '',
    origin: req.headers.origin ?? '',
  });

  // 登录：下发一个 HttpOnly + SameSite=Strict 的会话 cookie。
  // 这两个属性正是「后台 fetch 能不能用」的关键 —— 脚本读不到它，
  // 只能靠浏览器自动附带。
  if (url === '/login') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': 'session=SECRET-SESSION-VALUE; Path=/; HttpOnly; SameSite=Strict',
    });
    res.end('<!doctype html><html><body>logged in</body></html>');
    return;
  }

  // 签到接口：只有带对 cookie 才算成功，模拟真实站点的鉴权
  if (url === '/api/user/checkin') {
    const ok = (req.headers.cookie ?? '').includes('SECRET-SESSION-VALUE');
    res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ok
      ? { success: true, message: '签到成功' }
      : { success: false, message: '未登录' }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{}');
});

await new Promise((done) => server.listen(PORT, done));

const profile = mkdtempSync(join(tmpdir(), 'headless-cookie-'));
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
  // 1. 在普通标签页登录，让浏览器存下 HttpOnly cookie
  const page = await ctx.newPage();
  await page.goto(`${ORIGIN}/login`);
  await page.waitForLoadState('domcontentloaded');

  const loginRequest = seen.find((item) => item.url === '/login');
  check('站点已下发 HttpOnly + SameSite=Strict 会话 cookie', !!loginRequest);

  // 2. 拿到 service worker —— 必须在 worker 上下文里发请求，
  //    content script 里发是同源请求，证明不了任何事。
  let worker = ctx.serviceWorkers()[0];
  if (!worker) worker = await ctx.waitForEvent('serviceworker', { timeout: 15_000 });
  check('已取得扩展 service worker', !!worker, worker?.url() ?? '');

  // 3. 关键一步：在 service worker 里 fetch 签到接口。
  //    此时没有任何该站点的标签页参与，凭据只可能来自浏览器 cookie jar。
  await page.close();

  const outcome = await worker.evaluate(async (url) => {
    try {
      const response = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json', 'New-API-User': '42' },
        redirect: 'error',
      });
      return { status: response.status, body: await response.text() };
    } catch (error) {
      return { status: -1, body: String(error) };
    }
  }, `${ORIGIN}/api/user/checkin`);

  const checkinRequest = seen.find((item) => item.url === '/api/user/checkin');

  check(
    'service worker 的 fetch 带上了 HttpOnly 会话 cookie',
    !!checkinRequest?.cookie.includes('SECRET-SESSION-VALUE'),
    `服务端收到 Cookie: ${checkinRequest?.cookie || '<空>'}`,
  );
  check(
    'SameSite=Strict 未阻止扩展请求（文档所述 same-site 待遇）',
    !!checkinRequest?.cookie.includes('SECRET-SESSION-VALUE'),
  );
  check(
    '自定义身份头一并送达',
    checkinRequest?.userIdHeader === '42',
    `New-API-User: ${checkinRequest?.userIdHeader || '<空>'}`,
  );
  check(
    '签到接口返回成功（无标签页参与）',
    outcome.status === 200 && outcome.body.includes('签到成功'),
    `HTTP ${outcome.status} ${outcome.body}`,
  );
} finally {
  await ctx.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
if (failed.length) {
  console.error('\n后台直连的地基假设不成立，headless 快路径需要改设计：');
  for (const item of failed) console.error(`  - ${item.name} ${item.detail}`);
  process.exit(1);
}
console.log('后台 fetch 携带站点 cookie 已实测确认，headless 直连地基成立。');
