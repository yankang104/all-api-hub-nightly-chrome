/**
 * 测定 Turnstile 接受点击的时间门槛，并验证「过早点击会弄坏 widget」。
 *
 * 背景：probe-timing 的成功组其实只是多等了约 15 秒（它的就绪检查从未通过），
 * 所以真正的变量是首次点击的时刻，不是我先前以为的就绪信号。但扩展在
 * t≈2/15/28/42/55/68s 点了六次全败 —— 若只是"等够时间"，后几次该成功。
 * 故需要分开验证两件事：
 *   (1) 门槛：首次点击距页面加载多久才能拿到令牌；
 *   (2) 污染：先在过早时刻点一次，之后再在足够晚的时刻点，还能否拿到令牌。
 *
 * 本脚本自带浏览器，不依赖 e2e 载具，也不需要装扩展 —— 只驱动鼠标。
 */
import { chromium } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL = 'https://k40.shengqainbang.cn/login';
const TOKEN_SEL = 'input[name="cf-turnstile-response"]';
const INSET = 24;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'turnstile-timing-'));
const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  viewport: null,
  args: ['--no-first-run', '--no-default-browser-check'],
});
const page = context.pages()[0] ?? await context.newPage();

async function wrapperPoint() {
  return page.evaluate((inset) => {
    const w = document.querySelector('.turnstile-wrapper, .cf-turnstile, [class*="turnstile"]');
    if (!w) return null;
    const r = w.getBoundingClientRect();
    if (r.width < 50 || r.height < 20) return null;
    return {
      x: Math.round(r.left + inset),
      y: Math.round(r.top + r.height / 2),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  }, INSET);
}

/** 载入页面并等 widget 占位出现，返回加载完成的时间戳 */
async function freshLoad() {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const loadedAt = Date.now();
  for (let i = 0; i < 60; i++) {
    const pt = await wrapperPoint();
    const tok = await page.locator(TOKEN_SEL).first().inputValue().catch(() => null);
    if (pt && tok === '') return { loadedAt, pt };
    await sleep(300);
  }
  throw new Error('widget 占位未出现或 token 未复位');
}

async function humanClick(pt) {
  await page.mouse.move(pt.x - 140, pt.y - 80);
  await sleep(120);
  await page.mouse.move(pt.x, pt.y, { steps: 22 });
  await sleep(200);
  await page.mouse.down();
  await sleep(75);
  await page.mouse.up();
}

async function waitToken(sec) {
  for (let i = 0; i < sec * 2; i++) {
    await sleep(500);
    const v = await page.locator(TOKEN_SEL).first().inputValue().catch(() => '');
    if (v) return v;
  }
  return '';
}

console.log('── 实验一：首次点击的时间门槛 ──');
console.log('   （每格重新载入页面，只点一次）\n');

const delays = [2, 6, 10, 15, 22, 30];
const results = [];
for (const delay of delays) {
  let loaded;
  try {
    loaded = await freshLoad();
  } catch (e) {
    console.log(`  延迟 ${delay}s：跳过（${e.message}）`);
    continue;
  }
  const elapsed = Date.now() - loaded.loadedAt;
  const remain = delay * 1000 - elapsed;
  if (remain > 0) await sleep(remain);

  const pt = (await wrapperPoint()) ?? loaded.pt;
  const clickAt = ((Date.now() - loaded.loadedAt) / 1000).toFixed(1);
  await humanClick(pt);
  const tok = await waitToken(20);
  results.push({ delay, ok: !!tok });
  console.log(
    `  延迟 ${String(delay).padStart(2)}s（实际 ${clickAt}s，widget ${pt.w}×${pt.h}）→ ${tok ? '✔ TOKEN' : '✖ 无'}`,
  );
}

const firstOk = results.find((r) => r.ok);
console.log(
  `\n  门槛：${firstOk ? `延迟 ≥ ${firstOk.delay}s 可拿到令牌` : '所有延迟均失败（门槛假设不成立）'}`,
);

console.log('\n── 实验二：过早点击是否弄坏 widget ──');
console.log('   （同一次载入内：先在 2s 点一次，再在 25s 点一次）\n');

let poison = null;
try {
  const loaded = await freshLoad();
  const early = (await wrapperPoint()) ?? loaded.pt;
  await humanClick(early);
  console.log(`  第一次点击 @ ${((Date.now() - loaded.loadedAt) / 1000).toFixed(1)}s`);
  const earlyTok = await waitToken(6);
  console.log(`     → ${earlyTok ? '✔ TOKEN（意外，过早点击也成功）' : '✖ 无（预期）'}`);

  if (!earlyTok) {
    while (Date.now() - loaded.loadedAt < 25_000) await sleep(500);
    const late = (await wrapperPoint()) ?? early;
    await humanClick(late);
    console.log(`  第二次点击 @ ${((Date.now() - loaded.loadedAt) / 1000).toFixed(1)}s`);
    const lateTok = await waitToken(20);
    poison = !lateTok;
    console.log(`     → ${lateTok ? '✔ TOKEN（可恢复，未被弄坏）' : '✖ 无（widget 已被首次过早点击弄坏）'}`);
  }
} catch (e) {
  console.log(`  跳过：${e.message}`);
}

console.log('\n── 结论 ──');
if (firstOk && poison === true) {
  console.log(`  首次点击须晚于约 ${firstOk.delay}s；过早点击会永久弄坏 widget，之后补点无效。`);
  console.log('  → 扩展必须「只在足够晚的时刻点第一次」，不能靠重试补救。');
} else if (firstOk && poison === false) {
  console.log(`  首次点击须晚于约 ${firstOk.delay}s；过早点击不会弄坏 widget，重试可以补救。`);
} else if (!firstOk) {
  console.log('  时间门槛不成立，失败另有原因（需继续查）。');
}

await context.close();
rmSync(profile, { recursive: true, force: true });
