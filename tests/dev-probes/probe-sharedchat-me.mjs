import { chromium } from 'playwright';
import { join } from 'node:path';
import { homedir } from 'node:os';

const profile = join(homedir(), '.checkin-e2e-profiles', 'sharedchat-claim2');
// 用 Playwright 自己解析浏览器路径：硬编码 %LOCALAPPDATA%/ms-playwright/<版本> 会同时
// 写死目录与版本号，而 PLAYWRIGHT_BROWSERS_PATH 可以把浏览器装到别处、版本号也随
// playwright 升级变化。executablePath() 读的是同一套解析规则，永远与安装位置一致。
const executablePath = chromium.executablePath();
const context = await chromium.launchPersistentContext(profile, {
  executablePath,
  headless: true,
  args: ['--no-first-run', '--no-default-browser-check'],
});
const page = context.pages()[0] ?? await context.newPage();
await page.goto('https://new.sharedchat.cc/list/#/vibe-code/dashboard?activeMenu=dashboard&service=codex', {
  waitUntil: 'domcontentloaded', timeout: 60_000,
});
await page.waitForTimeout(3_000);

const before = await page.locator('body').innerText();
console.log('控制台是否含用户名:', /fzk520/i.test(before));

const mine = page.getByText('我的', { exact: true }).first();
console.log('“我的”入口数量:', await mine.count());
if (await mine.count()) {
  await mine.click();
  await page.waitForTimeout(3_000);
  console.log('点击后 URL:', page.url());
  console.log('── 我的页面正文 ──');
  console.log((await page.locator('body').innerText()).slice(0, 3000));

  const candidates = await page.evaluate(() => [...document.querySelectorAll(
    '[class*="user" i], [class*="account" i], [class*="profile" i], input, [class*="name" i], [class*="email" i]'
  )].map((element) => ({
    tag: element.tagName.toLowerCase(),
    cls: String(element.className).slice(0, 100),
    text: (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 150),
    value: 'value' in element ? String(element.value).slice(0, 150) : '',
    placeholder: element.getAttribute('placeholder') || '',
  })).filter((item) => item.text || item.value));
  console.log('── 身份元素候选 ──');
  console.log(JSON.stringify(candidates.slice(0, 60), null, 2));
}

await context.close();
