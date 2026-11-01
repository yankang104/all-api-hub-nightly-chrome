/**
 * 把可萌中转站（api456.me）的配置预注入到扩展 storage，
 * 不需要手动填表单。运行后在扩展界面添加账号即可直接测试。
 */
import { chromium } from 'playwright';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXT = join(ROOT, '.output', 'chrome-mv3');

const SITE = {
  id: 'api456-keimeng',
  name: '可萌中转站',
  loginUrl: 'https://api456.me/login',
  selectors: {
    username: '#username, input[name="username"]',
    password: '#password, input[name="password"]',
    submit: 'button.semi-button-primary.w-full',
  },
  closeModalSelectors: [
    '.semi-modal-close',
    '.semi-modal-footer button',
    '[aria-label="close"]',
    '[aria-label="关闭"]',
    '.ant-modal-close',
  ],
  // 登录后调签到接口：同源请求会自动带上登录 cookie
  checkin: {
    method: 'api',
    apiUrl: '/api/user/checkin',
    apiMethod: 'POST',
    // 站点可能回 {"message":"签到成功","reward":xxx} 或 "每日已经签到"
    successText: ['签到成功', '领取成功', '奖励'],
    alreadyText: ['已经签到', '重复签到', '已签到', 'already'],
  },
};

const profile = mkdtempSync(join(tmpdir(), 'seed-'));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-first-run',
    '--no-default-browser-check',
  ],
});

// chrome://extensions 页偶尔需要稍长时间枚举插件，加重试
const probe = await ctx.newPage();
let extId = null;
for (let attempt = 0; attempt < 5 && !extId; attempt++) {
  await probe.goto('chrome://extensions');
  await probe.waitForTimeout(1800 + attempt * 800);
  extId = await probe.evaluate(() => {
    const mgr = document.querySelector('extensions-manager');
    const items =
      mgr?.shadowRoot?.querySelector('extensions-item-list')?.shadowRoot?.querySelectorAll('extensions-item') ?? [];
    return items[0]?.id ?? null;
  });
}
await probe.close();

if (!extId) { console.error('扩展未加载'); await ctx.close(); process.exit(1); }

const page = await ctx.newPage();
await page.goto(`chrome-extension://${extId}/options.html`);
await page.waitForLoadState('domcontentloaded');

await page.evaluate(async (site) => {
  const existing = await chrome.storage.local.get('sites');
  const sites = (existing.sites ?? []).filter((s) => s.id !== site.id);
  sites.unshift(site); // 放最前面
  await chrome.storage.local.set({ sites });
  console.log('站点配置已写入');
}, SITE);

await page.reload();
await page.waitForTimeout(1500);

console.log(`✔ 可萌中转站配置已注入（id=${extId}）`);
console.log(`  · 扩展界面已打开，请在「可萌中转站」卡片里点「+ 添加账号」`);
console.log(`  · 填入你的用户名/密码，然后点「待签到」测试`);
console.log(`  · 按 Ctrl+C 关闭浏览器`);

// 等用户手动操作，不自动关闭
await page.waitForTimeout(120_000).catch(() => {});
await ctx.close();
