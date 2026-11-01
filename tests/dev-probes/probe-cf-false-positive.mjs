/**
 * 定位 Cloudflare 托管检查的误判来源。
 *
 * 现场：SharedChat 登录页标题是「用户登录」、表单完整渲染、无任何验证控件，
 * 但扩展判成「Cloudflare 托管式安全检查」，干等 120 秒超时。
 * isManagedCloudflarePage() 只有两条路径成立，这里把两条的每个选择器
 * 逐个查出来，看究竟谁命中。
 */
import { chromium } from 'playwright';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MANAGED_CLOUDFLARE_SELECTORS = [
  '#challenge-running',
  '#cf-challenge-running',
  '.cf-challenge-running',
  '#challenge-stage',
  'form#challenge-form',
];
const CLOUDFLARE_FINGERPRINT_SELECTORS = [
  'script[src*="/cdn-cgi/challenge-platform/"]',
  'link[href*="/cdn-cgi/challenge-platform/"]',
  'iframe[src*="/cdn-cgi/challenge-platform/"]',
  '#cf-wrapper',
  '[data-ray]',
];
const MANAGED_TITLE_PARTS = [
  'just a moment', 'checking your browser', 'performing security verification',
  'attention required', '请稍候', '请稍等', '正在检查您的浏览器', '浏览器检查',
];

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
await page.goto('https://new.sharedchat.cc/list/#/login', { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForTimeout(5_000);

const report = await page.evaluate(({ managed, fingerprints, titleParts }) => {
  const isActuallyVisible = (element) => {
    if (!element.isConnected || element.getClientRects().length === 0) return false;
    let current = element;
    while (current) {
      const style = window.getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
        || style.opacity === '0' || current.getAttribute('aria-hidden') === 'true'
        || (current instanceof HTMLElement && current.hidden)) return false;
      current = current.parentElement;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const describe = (element) => {
    const id = element.id ? `#${element.id}` : '';
    const cls = String(element.className || '').trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.');
    const rect = element.getBoundingClientRect();
    return `${element.tagName.toLowerCase()}${id}${cls ? '.' + cls : ''} ${Math.round(rect.width)}x${Math.round(rect.height)}`;
  };

  const managedHits = [];
  for (const selector of managed) {
    for (const element of document.querySelectorAll(selector)) {
      managedHits.push({ selector, element: describe(element), visible: isActuallyVisible(element) });
    }
  }
  const fingerprintHits = [];
  for (const selector of fingerprints) {
    for (const element of document.querySelectorAll(selector)) {
      fingerprintHits.push({ selector, element: describe(element) });
    }
  }
  const title = document.title.trim().toLowerCase();
  return {
    title: document.title,
    titleMatches: titleParts.filter((part) => title.includes(part)),
    managedHits,
    fingerprintHits,
  };
}, {
  managed: MANAGED_CLOUDFLARE_SELECTORS,
  fingerprints: CLOUDFLARE_FINGERPRINT_SELECTORS,
  titleParts: MANAGED_TITLE_PARTS,
});

console.log(`标题: ${report.title}`);
console.log(`标题命中托管词: ${JSON.stringify(report.titleMatches)}`);
console.log('\n── 托管选择器命中（可见即判为托管检查）──');
if (!report.managedHits.length) console.log('  （无命中）');
for (const hit of report.managedHits) {
  console.log(`  ${hit.selector} → ${hit.element}  可见=${hit.visible}${hit.visible ? '  ← 这条造成误判' : ''}`);
}
console.log('\n── Cloudflare 指纹命中（需与标题同时成立）──');
if (!report.fingerprintHits.length) console.log('  （无命中）');
for (const hit of report.fingerprintHits) console.log(`  ${hit.selector} → ${hit.element}`);

const visibleManaged = report.managedHits.some((hit) => hit.visible);
console.log('\n── 判读 ──');
if (visibleManaged) {
  console.log('  误判来源：站点自己用了 Cloudflare 挑战页的同名 id/class，被当成托管检查。');
} else if (report.titleMatches.length && report.fingerprintHits.length) {
  console.log('  误判来源：标题词 + 指纹同时命中。');
} else {
  console.log('  当前不该判为托管检查 —— 说明误判发生在页面早期（元素后来被移除），需要在检测里加二次确认。');
}

await context.close();
