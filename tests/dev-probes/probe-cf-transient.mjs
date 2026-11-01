/**
 * 抓 Cloudflare 误判的瞬时窗口。
 *
 * 稳定态复现不出来，所以从导航开始高频采样标题与选择器，
 * 找出「哪一刻」isManagedCloudflarePage() 会成立。
 */
import { chromium } from 'playwright';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MANAGED = ['#challenge-running', '#cf-challenge-running', '.cf-challenge-running', '#challenge-stage', 'form#challenge-form'];
const FINGERPRINTS = ['script[src*="/cdn-cgi/challenge-platform/"]', 'link[href*="/cdn-cgi/challenge-platform/"]', 'iframe[src*="/cdn-cgi/challenge-platform/"]', '#cf-wrapper', '[data-ray]'];
const TITLE_PARTS = ['just a moment', 'checking your browser', 'performing security verification', 'attention required', '请稍候', '请稍等', '正在检查您的浏览器', '浏览器检查'];

// 1) 静态 HTML 里的初始标题 —— SPA 启动前浏览器显示的就是它
const raw = await fetch('https://new.sharedchat.cc/list/', { headers: { 'User-Agent': 'Mozilla/5.0' } });
const html = await raw.text();
console.log('── 静态 HTML ──');
console.log(`  HTTP ${raw.status}`);
console.log(`  <title>: ${html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? '(无)'}`);
console.log(`  含 cdn-cgi/challenge-platform: ${/cdn-cgi\/challenge-platform/.test(html)}`);
console.log(`  含 data-ray: ${/data-ray/.test(html)}`);
console.log(`  cf 响应头: ${['cf-ray', 'cf-cache-status', 'server'].map((key) => `${key}=${raw.headers.get(key) ?? '-'}`).join(' ')}`);

const profile = join(homedir(), '.checkin-e2e-profiles', 'sharedchat-claim2');
// 用 Playwright 自己解析浏览器路径：硬编码 %LOCALAPPDATA%/ms-playwright/<版本> 会同时
// 写死目录与版本号，而 PLAYWRIGHT_BROWSERS_PATH 可以把浏览器装到别处、版本号也随
// playwright 升级变化。executablePath() 读的是同一套解析规则，永远与安装位置一致。
const executablePath = chromium.executablePath();
const context = await chromium.launchPersistentContext(profile, {
  executablePath, headless: true,
  args: ['--no-first-run', '--no-default-browser-check'],
});
const page = context.pages()[0] ?? await context.newPage();

// 2) 在文档创建前注入采样器，记录每一帧的判定输入
await page.addInitScript(({ managed, fingerprints, titleParts }) => {
  const samples = [];
  const visible = (element) => {
    if (!element.isConnected || element.getClientRects().length === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const sample = () => {
    const title = (document.title || '').trim().toLowerCase();
    const titleHit = titleParts.filter((part) => title.includes(part));
    const managedHit = managed.filter((selector) => {
      try { return [...document.querySelectorAll(selector)].some(visible); } catch { return false; }
    });
    const fpHit = fingerprints.filter((selector) => {
      try { return document.querySelector(selector) != null; } catch { return false; }
    });
    const wouldDetect = managedHit.length > 0 || (titleHit.length > 0 && fpHit.length > 0);
    samples.push({ t: Math.round(performance.now()), title: document.title, titleHit, managedHit, fpHit, wouldDetect });
  };
  sample();
  const timer = setInterval(sample, 100);
  setTimeout(() => clearInterval(timer), 12_000);
  Object.defineProperty(window, '__cfSamples', { get: () => samples });
}, { managed: MANAGED, fingerprints: FINGERPRINTS, titleParts: TITLE_PARTS });

await page.goto('https://new.sharedchat.cc/list/#/login', { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForTimeout(10_000);

const samples = await page.evaluate(() => window.__cfSamples ?? []);
console.log(`\n── 加载过程采样（${samples.length} 帧）──`);
const detecting = samples.filter((item) => item.wouldDetect);
if (!detecting.length) {
  console.log('  全程都不会判为托管检查');
  // 打印几帧标题变化，便于观察
  const titles = [];
  for (const item of samples) {
    if (!titles.length || titles[titles.length - 1].title !== item.title) titles.push(item);
  }
  console.log('  标题变化序列:');
  for (const item of titles) console.log(`    ${item.t}ms  "${item.title}"  fp=${JSON.stringify(item.fpHit)}`);
} else {
  console.log(`  会判为托管检查的帧: ${detecting.length} / ${samples.length}`);
  console.log(`  首次: ${detecting[0].t}ms  末次: ${detecting[detecting.length - 1].t}ms`);
  for (const item of detecting.slice(0, 6)) {
    console.log(`    ${item.t}ms  title="${item.title}"  titleHit=${JSON.stringify(item.titleHit)}  managed=${JSON.stringify(item.managedHit)}  fp=${JSON.stringify(item.fpHit)}`);
  }
}

await context.close();
