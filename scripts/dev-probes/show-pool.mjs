/**
 * 打开浏览器看代理池：自动导入你的订阅节点，然后停住不关。
 *
 * 用法：node show-pool.mjs
 *
 * 不碰 Clash Verge：只是本地起个服务把已抓下的订阅文本喂给扩展，
 * 再开一个独立配置的 Chrome 点几个按钮。不读、不写、不切换 Clash。
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = dirname(fileURLToPath(import.meta.url));
const EXT = join(ROOT, '.output', 'chrome-mv3');

let subText;
try {
  subText = readFileSync(join(ROOT, '.tmp', 'sub.txt'), 'utf8');
} catch {
  console.error('找不到 .tmp/sub.txt');
  process.exit(1);
}

const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(subText);
});
const subUrl = await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/sub`));
});
console.log('[1/6] 订阅服务已起:', subUrl);

const profile = mkdtempSync(join(tmpdir(), 'pool-'));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  viewport: { width: 1100, height: 900 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
console.log('[2/6] 浏览器已打开');

let extId = null;
const probe = await ctx.newPage();
for (let i = 0; i < 24 && !extId; i += 1) {
  for (const w of ctx.serviceWorkers()) {
    const id = new URL(w.url()).hostname;
    const ok = await probe.goto(`chrome-extension://${id}/options.html`, { timeout: 4000 })
      .then(() => probe.title())
      .then((t) => t.includes('签到') || t.includes('中转'))
      .catch(() => false);
    if (ok) { extId = id; break; }
  }
  if (!extId) await new Promise((r) => setTimeout(r, 500));
}
await probe.close().catch(() => {});
if (!extId) {
  console.error('扩展没加载起来，先跑 pnpm build');
  await ctx.close();
  process.exit(1);
}
console.log('[3/6] 扩展已加载:', extId);

const page = await ctx.newPage();
await page.goto(`chrome-extension://${extId}/options.html`);
await page.waitForTimeout(1200);

await page.evaluate(async () => {
  await chrome.storage.local.set({
    sites: [{
      id: 's1', name: '示例站点', loginUrl: 'https://example.com/login',
      selectors: { username: '#u', password: '#p', submit: 'button' },
      closeModalSelectors: [], checkin: { method: 'auto' },
    }],
    accounts: [1, 2, 3, 4, 5].map((n) => ({
      id: `a${n}`, siteId: 's1', username: `demo${n}@example.com`, label: `账号${n}`, password: 'x',
    })),
  });
});
await page.reload();
await page.waitForTimeout(1000);
console.log('[4/6] 已造 5 个示例账号');

await page.getByRole('button', { name: /^代理/ }).click();
await page.waitForTimeout(600);
await page.getByLabel('订阅地址').fill(subUrl);
await page.getByRole('button', { name: '拉取并解析' }).click();
await page.waitForTimeout(2500);
console.log('[5/6] 已解析订阅');

await page.getByRole('button', { name: /批量加入名称池/ }).click();
await page.waitForTimeout(1500);
await page.getByRole('button', { name: /保存分配|保存手动分配/ }).click();
await page.waitForTimeout(1500);
console.log('[6/6] 已入池并分配');

const result = await page.evaluate(async () => {
  const { proxies = [], accounts = [] } = await chrome.storage.local.get(['proxies', 'accounts']);
  return {
    total: proxies.length,
    names: proxies.map((p) => p.name),
    bindings: accounts.map((a) => ({
      account: a.label,
      node: proxies.find((p) => p.id === a.proxyId)?.name ?? '未绑定',
    })),
  };
});

console.log('\n========== 结果 ==========');
console.log('池内节点数:', result.total);
console.log('\n节点名（前 12 个）:');
result.names.slice(0, 12).forEach((n, i) => console.log(`  ${i + 1}. ${n}`));
if (result.names.length > 12) console.log(`  ...另有 ${result.names.length - 12} 个`);
console.log('\n账号绑定:');
result.bindings.forEach((b) => console.log(`  ${b.account} -> ${b.node}`));
const notices = result.names.filter((n) => /剩余流量|套餐到期|过滤掉/.test(n));
console.log('\n公告行残留:', notices.length ? notices.join(', ') : '无');
console.log('==========================');
console.log('\n浏览器停在代理面板，自己滚动看。看完按 Ctrl+C 退出。');

await new Promise(() => {});
