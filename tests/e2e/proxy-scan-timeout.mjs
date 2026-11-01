/**
 * 回归：端口扫描的消息预算必须够后台串行跑完。
 *
 * 修的是「代理功能不可用 —— 节点全部测不通/超时」：`chrome.proxy` 是浏览器
 * 全局设置，端口只能一个一个试。一个**在监听但不回应**的端口要等满 8 秒，
 * 而 UI 侧 sendMessage 原来固定 45 秒就放弃 —— 第 6 个端口就到点。
 * 后台还在扫，UI 已经把结果显示成「全部不通」，看起来就是代理整个坏了。
 *
 * 这条必须走真实扩展：预算是否够用取决于 chrome.proxy 切换 + fetch 超时的
 * 真实耗时，jsdom 打桩测不出来。
 *
 * 用法: node tests/proxy-scan-timeout.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { chromium } from 'playwright';

const EXT = path.resolve('.output/chrome-mv3');
if (!fs.existsSync(path.join(EXT, 'manifest.json'))) {
  console.error('缺少构建产物 .output/chrome-mv3，先运行 pnpm build');
  process.exit(1);
}

const checks = [];
const check = (name, pass, detail = '') => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

/**
 * 起 N 个「接受连接但永不回应」的监听端口。
 *
 * 这是最坏但真实的情况：本地内核端口还在监听，上游却已经不通。
 * 端口直接关闭反而会立刻 ECONNREFUSED，测不出超时预算的问题。
 */
async function startBlackholes(count) {
  const servers = [];
  for (let i = 0; i < count; i += 1) {
    const server = net.createServer((socket) => {
      // 收下连接，什么都不回 —— 让客户端等到超时
      socket.on('error', () => {});
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
  }
  return {
    ports: servers.map((s) => s.address().port),
    close: () => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))),
  };
}

// 6 个黑洞端口 × 8 秒 = 48 秒，刚好越过旧的 45 秒固定预算
const blackholes = await startBlackholes(6);
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-scan-'));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

try {
  const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker', { timeout: 30000 });
  const extId = new URL(sw.url()).host;
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/options.html`);
  await page.waitForLoadState('domcontentloaded');

  const started = Date.now();
  const scan = await page.evaluate(async (ports) => {
    const resp = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'SCAN_LOCAL_PORTS', host: '127.0.0.1', ports, scheme: 'http' },
        (r) => resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : r),
      );
    });
    return resp;
  }, blackholes.ports);
  const elapsed = Date.now() - started;

  check(
    '6 个挂死端口的扫描没有被 UI 侧超时掐断',
    scan?.ok === true,
    scan?.ok ? `耗时 ${(elapsed / 1000).toFixed(1)}s` : `error=${scan?.error}`,
  );

  check(
    '后台确实跑满了串行耗时（证明这不是个假的快速失败）',
    elapsed > 45_000,
    `耗时 ${(elapsed / 1000).toFixed(1)}s，旧预算 45s`,
  );

  const entries = scan?.feature?.portScan?.entries ?? [];
  check(
    '每个端口都有明确结论而不是整体失败',
    entries.length === blackholes.ports.length,
    `返回 ${entries.length} 条，期望 ${blackholes.ports.length}`,
  );

  check(
    '挂死端口被判为不通',
    entries.length > 0 && entries.every((entry) => entry.ok === false),
    entries.map((entry) => `${entry.port}:${entry.message}`).slice(0, 2).join(' / '),
  );

  // 收尾：扫描必须把全局代理还原，否则浏览器留在 fixed_servers 上
  const after = await page.evaluate(async () => {
    const s = await new Promise((r) => chrome.proxy.settings.get({ incognito: false }, r));
    return { mode: s?.value?.mode, control: s?.levelOfControl };
  });
  check('扫描收尾已还原全局代理', after.mode !== 'fixed_servers', `mode=${after.mode}`);
} finally {
  await ctx.close().catch(() => {});
  await blackholes.close().catch(() => {});
  fs.rmSync(userDataDir, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
console.log(`结果: ${failed.length ? 'FAIL' : 'PASS'}`);
process.exit(failed.length ? 1 : 0);
