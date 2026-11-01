/** Proxy workspace regression. Storage mutations use the real background; connection tests are mocked. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const extensionPath = resolve('.output/chrome-mv3');
const screenshots = resolve('tests/shots');
const temporaryRoot = realpathSync(tmpdir());
const profile = mkdtempSync(join(temporaryRoot, 'proxy-network-page-'));
mkdirSync(screenshots, { recursive: true });
let context;

async function mockProbes(page) {
  await page.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (message, ...args) => {
      if (message.type === 'TEST_PROXY') {
        const response = {
          ok: true,
          test: message.proxy.id === 'p2'
            ? { ok: false, ms: 0, message: '测试出口不可用', listenerProbe: 'closed' }
            : { ok: true, ms: 24, message: '连通正常 · 24ms' },
        };
        const callback = args.find((argument) => typeof argument === 'function');
        if (callback) {
          setTimeout(() => callback(response), 150);
          return;
        }
        return new Promise((done) => setTimeout(() => done(response), 150));
      }
      return original(message, ...args);
    };
  });
}

try {
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: 'chromium',
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  const worker = context.serviceWorkers().find((item) => item.url().startsWith('chrome-extension://'))
    ?? await context.waitForEvent('serviceworker', { timeout: 30000 });
  const extensionId = new URL(worker.url()).hostname;
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.evaluate(async () => {
    await chrome.storage.local.set({
      sites: [{
        id: 'network-test', name: '网络测试站', loginUrl: 'https://example.test/login', loginMethod: 'form',
        selectors: { username: '#username', password: '#password', submit: 'button' }, closeModalSelectors: [], checkin: { method: 'auto' },
      }],
      accounts: [
        { id: 'a1', siteId: 'network-test', username: '未分配账号', password: 'fixture' },
        { id: 'a2', siteId: 'network-test', username: '手动绑定账号', password: 'fixture', proxyMode: 'pool', proxyId: 'p2', proxyPinned: true },
        { id: 'a3', siteId: 'network-test', username: '第二个未分配账号', password: 'fixture' },
      ],
      proxies: [
        { id: 'p1', name: '日本出口', scheme: 'http', host: '127.0.0.1', port: 11001 },
        { id: 'p2', name: '美国出口', scheme: 'socks5', host: '127.0.0.1', port: 11002 },
        { id: 'names', name: '待补充端口的节点', scheme: 'http', host: '-', port: 0, nameOnly: true },
      ],
    });
  });
  await page.reload();
  await page.getByRole('button', { name: '代理 (2)', exact: true }).waitFor();
  const initialPageCount = context.pages().length;
  await page.getByRole('button', { name: '代理 (2)', exact: true }).click();
  await page.getByRole('heading', { name: '代理与网络', exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.getByRole('button', { name: '测活并分配', exact: true }).isVisible(), true);
  assert.equal(await page.getByRole('button', { name: '全部测活', exact: true }).isVisible(), true);
  assert.equal(await page.getByRole('radio', { name: '保留手动绑定', exact: true }).isChecked(), true);
  assert.equal(await page.getByRole('radio', { name: '全部重新分配', exact: true }).isVisible(), true);
  assert.deepEqual(await page.getByLabel('选择绑定代理', { exact: true }).locator('option').evaluateAll((options) => options.map((option) => option.value)), ['', 'p1', 'p2']);
  const proxyBounds = await page.locator('#proxy-management').boundingBox();
  const accountBounds = await page.locator('#account-proxy-binding').boundingBox();
  assert.ok(accountBounds.x > proxyBounds.x + proxyBounds.width);
  assert.equal(accountBounds.y, proxyBounds.y);
  await mockProbes(page);
  await page.getByRole('button', { name: '测活并分配', exact: true }).click();
  await page.getByText('已为 2 个账号绑定节点', { exact: false }).waitFor();
  const afterDefault = await page.evaluate(async () => (await chrome.storage.local.get('accounts')).accounts);
  assert.equal(afterDefault.find((account) => account.id === 'a1').proxyId, 'p1');
  assert.equal(afterDefault.find((account) => account.id === 'a3').proxyId, 'p1');
  assert.equal(afterDefault.find((account) => account.id === 'a2').proxyId, 'p2');
  assert.equal(afterDefault.find((account) => account.id === 'a2').proxyPinned, true);
  await page.getByRole('radio', { name: '全部重新分配', exact: true }).check();
  await page.getByRole('button', { name: '测活并分配', exact: true }).click();
  await page.getByText('已为 3 个账号绑定节点', { exact: false }).waitFor();
  const afterOverwrite = await page.evaluate(async () => (await chrome.storage.local.get('accounts')).accounts);
  assert.ok(afterOverwrite.every((account) => account.proxyId === 'p1' && account.proxyPinned !== true));
  console.log('PASS both assignment modes persist and exclude failed proxies');

  const bindingMessages = [];
  await page.exposeFunction('recordProxyMessage', (type) => bindingMessages.push(type));
  await page.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (message, ...args) => {
      if (message.type === 'TEST_PROXY') void window.recordProxyMessage(message.type);
      return original(message, ...args);
    };
  });
  await page.getByRole('checkbox', { name: '选择 未分配账号', exact: true }).check();
  await page.getByRole('checkbox', { name: '选择 第二个未分配账号', exact: true }).check();
  await page.getByRole('button', { name: '绑定账号到 美国出口', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('select[aria-label="选择绑定代理"]')?.value === 'p2');
  assert.equal(await page.getByLabel('选择绑定代理', { exact: true }).inputValue(), 'p2');
  assert.equal(await page.getByRole('checkbox', { name: '选择 未分配账号', exact: true }).isChecked(), true);
  await page.getByRole('button', { name: '保存绑定', exact: true }).click();
  await page.getByText('已为 2 个账号绑定到“美国出口”。', { exact: true }).waitFor();
  const afterManual = await page.evaluate(async () => (await chrome.storage.local.get('accounts')).accounts);
  assert.equal(afterManual.find((account) => account.id === 'a1').proxyId, 'p2');
  assert.equal(afterManual.find((account) => account.id === 'a1').proxyPinned, true);
  assert.equal(afterManual.find((account) => account.id === 'a3').proxyId, 'p2');
  assert.equal(afterManual.find((account) => account.id === 'a3').proxyPinned, true);
  assert.equal(afterManual.find((account) => account.id === 'a2').proxyId, 'p1');
  assert.equal(await page.getByRole('checkbox', { name: '选择 未分配账号', exact: true }).isChecked(), false);
  assert.deepEqual(bindingMessages, []);
  console.log('PASS explicit account binding persists without running connection tests');

  await page.reload();
  await page.getByRole('button', { name: '代理 (2)', exact: true }).click();
  await page.getByLabel('选择绑定代理', { exact: true }).selectOption('p2');
  assert.equal(await page.getByRole('checkbox', { name: '选择 未分配账号', exact: true }).isChecked(), false);
  assert.equal(await page.getByRole('button', { name: '取消 未分配账号 的绑定', exact: true }).isVisible(), true);
  await page.getByRole('button', { name: '取消 未分配账号 的绑定', exact: true }).click();
  await page.getByText('未分配账号 已取消绑定，将跟随站点设置。', { exact: true }).waitFor();
  const afterUnbind = await page.evaluate(async () => (await chrome.storage.local.get('accounts')).accounts);
  assert.equal(afterUnbind.find((account) => account.id === 'a1').proxyMode, 'inherit');
  assert.equal(afterUnbind.find((account) => account.id === 'a1').proxyId, undefined);
  assert.equal(afterUnbind.find((account) => account.id === 'a1').proxyPinned, undefined);
  console.log('PASS manual binding and unbinding persist through the real app store');

  await mockProbes(page);
  await page.getByRole('button', { name: '全部测活', exact: true }).click();
  await page.getByText('测试完成，1/2 个连接正常。', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(async () => (await chrome.storage.local.get('accounts')).accounts), afterUnbind);
  console.log('PASS optional connection tests do not change account bindings');

  await page.getByRole('checkbox', { name: '选择 未分配账号', exact: true }).check();
  const beforeImportBounds = await page.locator('#account-proxy-binding').boundingBox();
  await page.getByRole('button', { name: '添加代理', exact: true }).click();
  const importDialog = page.getByRole('dialog', { name: '添加代理', exact: true });
  await importDialog.waitFor();
  assert.deepEqual(await page.locator('#account-proxy-binding').boundingBox(), beforeImportBounds);
  await page.getByText('直接粘贴代理地址', { exact: true }).click();
  await page.getByLabel('代理地址列表', { exact: true }).fill('http://127.0.0.1:11003');
  await page.getByRole('button', { name: '导入这些地址', exact: true }).click();
  await importDialog.getByText('新增 1 个', { exact: true }).waitFor();
  await page.screenshot({ path: join(screenshots, 'proxy-network-add-dialog.png'), fullPage: true });
  assert.equal(context.pages().length, initialPageCount);
  await importDialog.getByRole('button', { name: '完成', exact: true }).click();
  await importDialog.waitFor({ state: 'hidden' });
  await page.getByRole('article', { name: '代理 127.0.0.1:11003', exact: true }).waitFor();
  assert.equal(await page.getByRole('checkbox', { name: '选择 未分配账号', exact: true }).isChecked(), true);
  await page.getByRole('button', { name: '添加代理', exact: true }).click();
  await importDialog.waitFor();
  await page.keyboard.press('Escape');
  await importDialog.waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('button', { name: '添加代理', exact: true }).evaluate((element) => element === document.activeElement), true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(screenshots, 'proxy-network-workspace.png'), fullPage: true });
  console.log('PASS import dialog updates the list, preserves selection, and restores focus on Escape');

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: join(screenshots, 'proxy-network-workspace-dark.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.getByRole('button', { name: '代理 (3)', exact: true }).click();
  await page.getByRole('heading', { name: '代理与网络', exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.equal(await page.getByRole('button', { name: '测活并分配', exact: true }).isVisible(), true);
  assert.equal(await page.locator('#account-proxy-binding').isVisible(), true);
  await page.getByRole('checkbox', { name: '选择 未分配账号', exact: true }).check();
  await page.getByRole('button', { name: '代理列表 · 4', exact: true }).click();
  assert.equal(await page.locator('#proxy-management').isVisible(), true);
  await page.getByRole('button', { name: '绑定账号到 日本出口', exact: true }).click();
  assert.equal(await page.locator('#account-proxy-binding').isVisible(), true);
  assert.equal(await page.getByRole('checkbox', { name: '选择 未分配账号', exact: true }).isChecked(), true);
  await page.getByRole('button', { name: '保存绑定', exact: true }).click();
  await page.getByText('已为 1 个账号绑定到“日本出口”。', { exact: true }).waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(screenshots, 'proxy-network-workspace-sidepanel.png'), fullPage: true });
  await page.getByRole('button', { name: '添加代理', exact: true }).click();
  await importDialog.waitFor();
  assert.equal(await importDialog.evaluate((element) => element.scrollWidth <= element.clientWidth), true);
  await page.screenshot({ path: join(screenshots, 'proxy-network-add-dialog-sidepanel.png'), fullPage: true });
  await importDialog.getByRole('button', { name: '关闭添加代理', exact: true }).click();
  await page.getByRole('button', { name: '返回总览', exact: true }).click();
  await page.getByRole('heading', { name: '签到管理台', exact: false }).waitFor();
  assert.deepEqual(pageErrors, []);
  console.log('PASS narrow sidepanel navigation, layout, and no page errors');

  // Check realistic list density with synthetic data in this isolated browser profile.
  await page.evaluate(async () => {
    const { sites: existingSites } = await chrome.storage.local.get('sites');
    const sites = ['研发平台', '模型服务', '备用站点'].map((name, index) => ({ ...existingSites[0], id: `demo-site-${index}`, name }));
    const names = ['日本 · 东京 01', '日本 · 东京 02', '新加坡 · 01', '美国 · 洛杉矶 01', '香港 · 01', '本机代理'];
    const proxies = names.map((name, index) => ({ id: `demo-proxy-${index}`, name, scheme: 'http', host: '127.0.0.1', port: 11001 + index }));
    const accounts = Array.from({ length: 18 }, (_, index) => ({
      id: `demo-account-${index}`, siteId: sites[Math.floor(index / 6)].id, username: `account${index + 1}@example.test`,
      label: `账号 ${String(index + 1).padStart(2, '0')}`, password: 'fixture',
      ...(index % 4 === 0 ? {} : { proxyMode: 'pool', proxyId: proxies[index % proxies.length].id, proxyPinned: index % 3 === 0 }),
    }));
    await chrome.storage.local.set({ sites, accounts, proxies });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.getByRole('button', { name: '代理 (6)', exact: true }).click();
  await page.getByRole('button', { name: '绑定账号到 日本 · 东京 01', exact: true }).click();
  await page.getByRole('checkbox', { name: '选择 账号 01', exact: true }).check();
  await page.getByRole('checkbox', { name: '选择 账号 02', exact: true }).check();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.ok(await page.locator('#account-proxy-binding').evaluate((element) => [...element.querySelectorAll('div')].some((item) => item.scrollHeight > item.clientHeight && getComputedStyle(item).overflowY === 'auto')));
  const saveBounds = await page.getByRole('button', { name: '保存绑定', exact: true }).boundingBox();
  assert.ok(saveBounds.y + saveBounds.height <= 1000, 'Binding action remains in the desktop viewport with long lists');
  await page.screenshot({ path: join(screenshots, 'proxy-network-layout-preview.png'), fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: join(screenshots, 'proxy-network-layout-preview-dark.png'), fullPage: true });
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.getByRole('button', { name: '代理 (6)', exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.getByRole('button', { name: '添加代理', exact: true }).click();
  await importDialog.waitFor();
  assert.equal(await importDialog.evaluate((element) => element.scrollWidth <= element.clientWidth), true);
  await page.screenshot({ path: join(screenshots, 'proxy-network-dialog-320.png'), fullPage: false });
  assert.deepEqual(pageErrors, []);
  console.log('PASS larger account lists, desktop layout, and 320px dialog fit');
} finally {
  if (context) await context.close();
  if (dirname(profile) !== temporaryRoot || !basename(profile).startsWith('proxy-network-page-')) throw new Error('Unexpected temporary profile path');
  rmSync(profile, { recursive: true, force: true });
}
