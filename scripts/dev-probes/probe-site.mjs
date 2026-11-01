/**
 * 探测中转站登录页结构，自动推断表单选择器与签到方式。
 * 只读公开登录页，不做任何登录尝试。
 */
import { chromium } from 'playwright';

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.log('用法: node scripts/probe-site.mjs <登录页URL> [更多URL...]');
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });

for (const url of targets) {
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  });
  const page = await ctx.newPage();

  /** 记录公开页面发出的 fetch/XHR；只保留 origin + path，避免记录查询参数。 */
  const apiCalls = [];
  page.on('request', (r) => {
    const u = r.url();
    if (/\/api\//.test(u) && ['fetch', 'xhr'].includes(r.resourceType())) {
      const parsed = new URL(u);
      apiCalls.push(`${r.method()} ${parsed.origin}${parsed.pathname}`);
    }
  });

  console.log(`\n${'='.repeat(70)}\n▸ ${url}`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(4000); // 等 SPA 渲染

    const info = await page.evaluate(() => {
      const vis = (el) => {
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      };
      const desc = (el) => {
        const parts = [el.tagName.toLowerCase()];
        if (el.type) parts.push(`type=${el.type}`);
        if (el.name) parts.push(`name=${el.name}`);
        if (el.id) parts.push(`id=${el.id}`);
        if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
        if (el.autocomplete) parts.push(`autocomplete=${el.autocomplete}`);
        if (el.className && typeof el.className === 'string') parts.push(`class="${el.className.slice(0, 90)}"`);
        return parts.join(' ');
      };

      const inputs = [...document.querySelectorAll('input')].filter(vis).map(desc);
      const buttons = [...document.querySelectorAll('button, [role="button"], a.btn')]
        .filter(vis)
        .map((b) => `${b.tagName.toLowerCase()} "${(b.innerText || '').trim().slice(0, 24)}" class="${(b.className || '').toString().slice(0, 80)}"`);

      const modals = [...document.querySelectorAll('[class*="modal"],[class*="dialog"],[role="dialog"]')]
        .filter(vis)
        .map((m) => `${m.tagName.toLowerCase()} class="${(m.className || '').toString().slice(0, 90)}"`);

      const html = document.documentElement.outerHTML;
      const ui = [];
      if (/semi-/.test(html)) ui.push('Semi Design (new-api)');
      if (/\bant-/.test(html)) ui.push('Ant Design');
      if (/MuiButton|MuiInput/.test(html)) ui.push('MUI');
      if (/chakra-/.test(html)) ui.push('Chakra');
      if (/semantic/i.test(html)) ui.push('Semantic UI (one-api)');

      return { title: document.title, url: location.href, inputs, buttons, modals, ui };
    });

    console.log(`  标题: ${info.title}`);
    if (info.url !== url) console.log(`  实际地址: ${info.url}`);
    console.log(`  UI 框架: ${info.ui.join(', ') || '未识别'}`);
    console.log(`  输入框 (${info.inputs.length}):`);
    info.inputs.forEach((i) => console.log(`    · ${i}`));
    console.log(`  按钮 (${info.buttons.length}):`);
    info.buttons.slice(0, 12).forEach((b) => console.log(`    · ${b}`));
    if (info.modals.length) {
      console.log(`  弹窗容器 (${info.modals.length}):`);
      info.modals.slice(0, 6).forEach((m) => console.log(`    · ${m}`));
    }
    if (apiCalls.length) {
      console.log(`  页面 API 调用:`);
      [...new Set(apiCalls)].slice(0, 10).forEach((a) => console.log(`    · ${a}`));
    }
  } catch (e) {
    console.log(`  探测失败: ${e.message.split('\n')[0]}`);
  }
  await ctx.close();
}

await browser.close();
