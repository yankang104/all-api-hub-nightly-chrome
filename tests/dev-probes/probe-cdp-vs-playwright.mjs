/**
 * 判定 Turnstile 是否因「调试器附加」而拒发令牌。
 *
 * 已确认：坐标正确、等够 15s、事件 isTrusted=true、webdriver=false，
 * 但扩展（chrome.debugger + Input.dispatchMouseEvent）仍拿不到令牌，
 * 而 Playwright 的 page.mouse 在同样条件下拿到过。两者唯一的差别是
 * 点击瞬间有没有 CDP 调试会话附着在这个标签页上。
 *
 * 两组各用独立浏览器（widget 一旦被点过就废，不能复用页面）：
 *   A. page.mouse —— Playwright 内部通道
 *   B. Input.dispatchMouseEvent —— 扩展用的通道，附加 CDP 会话后发送
 */
import { chromium } from 'playwright';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const URL_LOGIN = 'https://k40.shengqainbang.cn/login';
const TOKEN_SEL = 'input[name="cf-turnstile-response"]';
const INSET = 24;
const WAIT_BEFORE_CLICK_MS = 18_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 系统 Chrome 优先，回落到 Playwright 自带的 Chromium。
 *
 * 回落项不能硬编码 %LOCALAPPDATA%/ms-playwright/<版本>：PLAYWRIGHT_BROWSERS_PATH 可以
 * 把浏览器装到别处，版本号也随 playwright 升级变化。executablePath() 用同一套解析
 * 规则，永远指向真实安装位置；解析失败（未安装）时返回空串，由下面的候选过滤跳过。
 */
function playwrightChromium() {
  try {
    return chromium.executablePath();
  } catch {
    return '';
  }
}

const CHROME_CANDIDATES = [
  join(process.env['ProgramFiles'] ?? 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
  join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
  join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
  playwrightChromium(),
];
const chromeBin = CHROME_CANDIDATES.find((p) => p && existsSync(p)) ?? '';
if (!chromeBin) { console.error('找不到 Chrome'); process.exit(1); }

/** 自己 spawn，不传 --enable-automation，保证 webdriver=false */
async function launch(port) {
  const profile = mkdtempSync(join(tmpdir(), `ts-ch-${port}-`));
  const proc = spawn(chromeBin, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-component-extensions-with-background-pages',
  ], { stdio: 'ignore' });
  proc.unref();

  let browser = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break; } catch {}
  }
  if (!browser) { proc.kill(); throw new Error('CDP 连接失败'); }
  return { browser, proc, profile };
}

async function cleanup({ browser, proc, profile }) {
  await browser.close().catch(() => {});
  proc.kill();
  await sleep(600);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}

async function widgetPoint(page) {
  return page.evaluate((ins) => {
    const w = document.querySelector('.turnstile-wrapper, .cf-turnstile');
    if (!w) return null;
    const r = w.getBoundingClientRect();
    if (r.width < 50 || r.height < 20) return null;
    return {
      x: Math.round(r.left + Math.min(ins, r.width / 2)),
      y: Math.round(r.top + r.height / 2),
      w: Math.round(r.width), h: Math.round(r.height),
    };
  }, INSET);
}

async function preparePage(browser) {
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] ?? await ctx.newPage();
  await page.goto(URL_LOGIN, { waitUntil: 'domcontentloaded' });

  const wd = await page.evaluate(() => navigator.webdriver);
  let pt = null;
  for (let i = 0; i < 50; i++) {
    pt = await widgetPoint(page);
    if (pt) break;
    await sleep(400);
  }
  if (!pt) throw new Error('widget 未出现');
  return { page, wd, pt };
}

async function waitToken(page, sec = 22) {
  for (let i = 0; i < sec * 2; i++) {
    await sleep(500);
    const v = await page.locator(TOKEN_SEL).first().inputValue().catch(() => '');
    if (v) return v;
  }
  return '';
}

function bezier(s, c1, c2, e, t) {
  const m = 1 - t;
  return {
    x: m ** 3 * s.x + 3 * m ** 2 * t * c1.x + 3 * m * t ** 2 * c2.x + t ** 3 * e.x,
    y: m ** 3 * s.y + 3 * m ** 2 * t * c1.y + 3 * m * t ** 2 * c2.y + t ** 3 * e.y,
  };
}

function humanPath(start, end) {
  const dx = end.x - start.x, dy = end.y - start.y;
  const dist = Math.max(1, Math.hypot(dx, dy));
  const steps = Math.min(30, Math.max(12, Math.round(dist / 24) + 10));
  const nx = -dy / dist, ny = dx / dist;
  const bend = (Math.random() - 0.5) * Math.min(120, dist * 0.42);
  const c1 = { x: start.x + dx * 0.32 + nx * bend, y: start.y + dy * 0.32 + ny * bend };
  const c2 = { x: start.x + dx * 0.72 - nx * bend * 0.35, y: start.y + dy * 0.72 - ny * bend * 0.35 };
  const path = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const p = bezier(start, c1, c2, end, t);
    const j = (1 - t) * 0.7;
    path.push({ x: p.x + (Math.random() - 0.5) * j, y: p.y + (Math.random() - 0.5) * j });
  }
  path[path.length - 1] = { ...end };
  return path;
}

const groups = [
  {
    name: 'A. page.mouse（Playwright 通道）',
    port: 9401,
    async click(page, pt) {
      await page.mouse.move(pt.x - 130, pt.y - 70);
      await sleep(130);
      await page.mouse.move(pt.x, pt.y, { steps: 20 });
      await sleep(200);
      await page.mouse.down();
      await sleep(75);
      await page.mouse.up();
    },
  },
  {
    name: 'B. Input.dispatchMouseEvent（扩展通道，CDP 会话附加）',
    port: 9402,
    async click(page, pt) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Page.bringToFront');
      await cdp.send('Input.setIgnoreInputEvents', { ignore: false });
      const start = {
        x: Math.max(1, pt.x + (90 + Math.random() * 230) * (Math.random() < 0.5 ? -1 : 1)),
        y: Math.max(1, pt.y + (55 + Math.random() * 170) * (Math.random() < 0.5 ? -1 : 1)),
      };
      for (const p of humanPath(start, pt)) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, buttons: 0, pointerType: 'mouse' });
        await sleep(6 + Math.round(Math.random() * 9));
      }
      await sleep(25 + Math.round(Math.random() * 55));
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
      await sleep(45 + Math.round(Math.random() * 65));
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
      await sleep(120);
    },
  },
];

console.log(`浏览器: ${chromeBin}`);
console.log(`两组均等 ${WAIT_BEFORE_CLICK_MS / 1000}s 后点击，落点为左边缘内缩 ${INSET}px\n`);

const outcome = {};
for (const g of groups) {
  let session = null;
  try {
    session = await launch(g.port);
    const { page, wd, pt } = await preparePage(session.browser);
    console.log(g.name);
    console.log(`     webdriver=${wd}  widget ${pt.w}×${pt.h}  落点 (${pt.x},${pt.y})`);
    await sleep(WAIT_BEFORE_CLICK_MS);
    const now = (await widgetPoint(page)) ?? pt;
    await g.click(page, now);
    const tok = await waitToken(page);
    outcome[g.name[0]] = !!tok;
    console.log(`     结果: ${tok ? '✔ TOKEN ' + tok.slice(0, 32) + '…' : '✖ 无 token'}\n`);
  } catch (e) {
    outcome[g.name[0]] = null;
    console.log(`${g.name}\n     出错: ${String(e).slice(0, 140)}\n`);
  } finally {
    if (session) await cleanup(session);
  }
}

console.log('── 判读 ──');
if (outcome.A && outcome.B) {
  console.log('  两条通道都能拿到令牌 → 调试器附加不是原因，扩展方向正确，可直接端到端复测。');
} else if (outcome.A && outcome.B === false) {
  console.log('  只有扩展通道失败 → Turnstile 检测到调试器附加，可信指针这条路对 Turnstile 走不通。');
  console.log('  → 扩展应对 Turnstile 直接转人工，不再尝试自动点击。');
} else if (outcome.A === false && outcome.B === false) {
  console.log('  两条都失败 → 18s 仍不够，或该站点风控已收紧；需要再拉长等待时间复测。');
} else {
  console.log(`  结果不完整：A=${outcome.A} B=${outcome.B}`);
}
