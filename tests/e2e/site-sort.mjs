/** 站点排序回归：真实扩展、隔离浏览器资料，仅使用虚构站点。先 npm run build。 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratch = resolve(process.env.TMPDIR || join(root, '.tmp'));
mkdirSync(scratch, { recursive: true });
const profile = mkdtempSync(join(scratch, 'site-sort-profile-'));
const extension = join(root, '.output', 'chrome-mv3');
const names = ['Zulu 排序验证', 'Alpha10 排序验证', 'alpha2 排序验证'];
const ascending = [names[2], names[1], names[0]];
const errors = [];
let context;

async function expectNames(page, expected) {
  await page.waitForFunction((values) => {
    const actual = [...document.querySelectorAll('section > header a')].map((el) => el.textContent);
    return JSON.stringify(actual) === JSON.stringify(values);
  }, expected, { timeout: 5000 });
  assert.deepEqual(await page.locator('section > header a').allTextContents(), expected);
}

/** 存储里的虚构站点顺序（按 sortOrder 排） */
async function fixtureOrder(page) {
  return page.evaluate(async () => (await chrome.storage.local.get('sites')).sites
    .filter(({ id }) => id.startsWith('sort-fixture-'))
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map(({ id }) => id));
}

const pillOn = (page, name) => page.getByRole('button', { name, exact: true });
const openPanel = (page) => page.getByRole('button', { name: '排序设置', exact: true }).click();
const closePanel = (page) => page.keyboard.press('Escape');

async function searchable(page) {
  await page.getByRole('textbox', { name: '搜索站点、账号或备注' }).fill('排序验证');
}

async function openPage(url, width) {
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width, height: 900 });
  await page.goto(url);
  await searchable(page);
  return page;
}

try {
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: 'chromium',
    ...(process.env.E2E_CHROMIUM_PATH ? { executablePath: process.env.E2E_CHROMIUM_PATH } : {}),
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const origin = `chrome-extension://${new URL(worker.url()).hostname}`;
  const page = await openPage(`${origin}/options.html`, 1280);
  await page.evaluate(async (siteNames) => {
    const sites = siteNames.map((name, index) => ({
      id: `sort-fixture-${index}`, name, sortOrder: index,
      loginUrl: `https://sort-fixture-${index}.example.invalid/login`,
      loginMethod: 'form',
      selectors: { username: '#username', password: '#password', submit: 'button[type="submit"]' },
      closeModalSelectors: [], checkin: { method: 'none' },
    }));
    await chrome.storage.local.remove('siteSortMode');
    await chrome.storage.local.set({
      sites, accounts: [], proxies: [], status: {}, results: {}, balances: {},
      checkinSchedule: { enabled: false, time: '08:30', weekdays: [1], accountIds: [] },
    });
  }, names);
  await page.reload();
  await searchable(page);
  await page.waitForFunction(() => document.querySelectorAll('section > header a').length === 3);
  // 默认字母排序：用户直接看到 A→Z
  assert.deepEqual(await page.locator('section > header a').allTextContents(), ascending);
  await openPanel(page);
  assert.equal(await pillOn(page, '名称 A→Z').getAttribute('aria-pressed'), 'true');
  await closePanel(page);

  // 字母排序下箭头可用：下移第一张卡片 → 固化手动微调顺序并落盘
  await page.getByRole('button', { name: '下移站点', exact: true }).first().click();
  await expectNames(page, [names[1], names[2], names[0]]);
  assert.deepEqual(await fixtureOrder(page), ['sort-fixture-1', 'sort-fixture-2', 'sort-fixture-0']);
  await page.waitForFunction(async () => {
    const value = await chrome.storage.local.get('siteSortMode');
    return value.siteSortMode === 'manual';
  });
  await openPanel(page);
  assert.equal(await page.locator('[aria-label="站点排序"] button[aria-pressed="true"]').count(), 0);
  assert.equal(((await page.locator('[aria-label="站点排序"]').textContent()) ?? '').includes('手动微调'), true);
  await closePanel(page);
  console.log('PASS: 字母排序 + 箭头微调 → 固化顺序');

  // 重新加载后保留微调顺序；选回字母排序恢复显示且不改写存储
  await page.reload();
  await searchable(page);
  await expectNames(page, [names[1], names[2], names[0]]);
  await openPanel(page);
  await pillOn(page, '名称 A→Z').click();
  await expectNames(page, ascending);
  assert.deepEqual(await fixtureOrder(page), ['sort-fixture-1', 'sort-fixture-2', 'sort-fixture-0']);
  await closePanel(page);
  console.log('PASS: 重载保留微调；字母排序只影响显示');

  // 管理页与侧栏同步
  const sidebar = await openPage(`${origin}/sidepanel.html`, 420);
  await expectNames(sidebar, ascending);
  await openPanel(sidebar);
  await pillOn(sidebar, '名称 Z→A').click();
  await expectNames(sidebar, [names[0], names[1], names[2]]);
  await expectNames(page, [names[0], names[1], names[2]]);
  console.log('PASS: 管理页/侧栏同步');

  const shots = mkdtempSync(join(scratch, 'site-sort-ui-'));
  await page.screenshot({ path: join(shots, 'desktop.png'), fullPage: true });
  for (const width of [420, 360]) {
    await sidebar.setViewportSize({ width, height: 900 });
    await openPanel(sidebar);
    await sidebar.waitForTimeout(150);
    assert.equal(await sidebar.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
      `sidepanel overflows at ${width}px`);
    await closePanel(sidebar);
    await sidebar.screenshot({ path: join(shots, `sidepanel-${width}.png`), fullPage: true });
  }
  await sidebar.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await openPanel(sidebar);
  await pillOn(sidebar, '名称 A→Z').click();
  await expectNames(sidebar, ascending);
  await closePanel(sidebar);
  await sidebar.screenshot({ path: join(shots, 'sidepanel-dark.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: 窄侧栏无溢出、深色/减少动效可用、无未捕获报错');
  console.log(`Screenshots: ${shots}`);
} finally {
  await context?.close();
  rmSync(profile, { recursive: true, force: true });
}
