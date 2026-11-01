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
  waitUntil: 'domcontentloaded',
  timeout: 60_000,
});
await page.waitForTimeout(5_000);

const storage = await page.evaluate(() => {
  const safe = (storage) => {
    const out = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key) continue;
      const value = storage.getItem(key) ?? '';
      // 只输出与身份相关的键；token 值只报长度，绝不打印内容
      if (!/user|account|profile|login|auth|token|name|email|uid/i.test(key)) continue;
      const sensitive = /token|auth|password|secret|key/i.test(key);
      out.push({ key, value: sensitive ? `[敏感值 ${value.length} 字符]` : value.slice(0, 500) });
    }
    return out;
  };
  return { local: safe(localStorage), session: safe(sessionStorage) };
});
console.log('── storage 身份候选（敏感值已隐藏）──');
console.log(JSON.stringify(storage, null, 2));

const bodyCandidates = await page.evaluate(() => {
  const patterns = [/fzk520/i, /用户(?:名)?[：:]?\s*([^\s]{2,50})/i, /账号[：:]?\s*([^\s]{2,50})/i];
  const text = document.body?.innerText ?? '';
  const matches = [];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) matches.push({ pattern: String(pattern), value: match[1] ?? match[0] });
  }
  const elements = [...document.querySelectorAll('[class*="user" i], [class*="account" i], [class*="profile" i], [class*="avatar" i]')]
    .map((element) => ({
      tag: element.tagName.toLowerCase(),
      className: String(element.className).slice(0, 100),
      text: (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100),
    }))
    .filter((item) => item.text);
  return { matches, elements: elements.slice(0, 40) };
});
console.log('\n── 页面身份候选 ──');
console.log(JSON.stringify(bodyCandidates, null, 2));

const paths = [
  '/api/user/info', '/api/user/self', '/api/profile', '/api/auth/user', '/api/v1/user/info',
  '/list/api/user/info', '/list/api/user/self', '/list/api/profile', '/list/api/auth/user',
];
console.log('\n── 身份端点探测 ──');
for (const path of paths) {
  const result = await page.evaluate(async (path) => {
    try {
      const response = await fetch(path, { credentials: 'include', headers: { Accept: 'application/json' } });
      const type = response.headers.get('content-type') ?? '';
      const text = (await response.text()).slice(0, 800);
      return { status: response.status, type, text };
    } catch (error) {
      return { error: String(error) };
    }
  }, path);
  if (result.error) console.log(`${path} → ${result.error}`);
  else if (result.type.includes('json') || result.status !== 200) {
    // 避免打印 token；常见身份字段保留，其余 token 形态打码
    const safe = result.text.replace(/("(?:token|accessToken|refreshToken|apiKey)"\s*:\s*")[^"]+/gi, '$1[隐藏]');
    console.log(`${path} → HTTP ${result.status} ${result.type}\n  ${safe}`);
  }
}

await context.close();
