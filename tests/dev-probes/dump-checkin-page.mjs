/**
 * 签到页结构取样 —— 不加载扩展，只看真站点长什么样。
 *
 * 用途：扩展报「签到页未找到明确按钮」时，光看日志不知道是词表没覆盖、
 * 还是 SPA 没渲染完、还是这站压根没有签到功能。这个脚本直接把签到页
 * 在不同时刻的结构打出来，用事实回答。
 *
 * 依赖 real-site-e2e.mjs --profile 留下的登录态目录，所以要先跑过一次
 * 并在浏览器里完成登录。本脚本只导航和读取，不点击、不提交。
 *
 * 用法：
 *   node tests/dump-checkin-page.mjs --site 100x
 *   node tests/dump-checkin-page.mjs --site 100x --path /check-in
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SITES = {
  '100x': { origin: 'https://sub.100xlabs.space', candidates: ['/', '/dashboard', '/check-in', '/checkin', '/profile'] },
  keimeng: { origin: 'https://api456.me', candidates: ['/', '/console', '/check-in', '/checkin'] },
};

function parseArgs(argv) {
  const out = { site: '100x', paths: [], settle: 6000 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--site') (out.site = argv[i + 1] ?? ''), (i += 1);
    else if (a === '--path') (out.paths.push(argv[i + 1] ?? ''), (i += 1));
    else if (a === '--settle') (out.settle = Number(argv[i + 1]) || out.settle), (i += 1);
    else throw new Error(`未知参数: ${a}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const entry = SITES[args.site];
if (!entry) {
  console.error(`未知站点 ${args.site}，可选: ${Object.keys(SITES).join(', ')}`);
  process.exit(2);
}

const profile = join(homedir(), '.checkin-e2e-profiles', args.site);
if (!existsSync(profile)) {
  console.error(`登录态目录不存在: ${profile}`);
  console.error('请先运行: node tests/real-site-e2e.mjs --site ' + args.site + ' --profile --keep');
  console.error('并在打开的浏览器里完成登录。');
  process.exit(2);
}

const paths = args.paths.length ? args.paths : entry.candidates;

/** 在页面里跑的取样函数，尽量贴近 checkin.ts 的判定口径 */
function sample() {
  const CHECKIN_ACTION =
    /(?:签到|打卡|领取|check[\s-]?in|sign[\s-]?in|claim|daily\s*(?:bonus|reward|credit)|每日(?:奖励|福利|额度))/i;
  const NON_ACTION =
    /(?:历史|记录|规则|日历|说明|明细|详情|history|calendar|rule|record|detail)/i;
  const ALREADY = ['已签到', '已经签到', '今日已', '重复签到', 'already checked', 'already signed', '已打卡', '已领取'];

  const vis = (el) => {
    if (!el.isConnected || el.getClientRects().length === 0) return false;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  };
  const desc = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = (el.className || '').toString().trim().split(/\s+/).slice(0, 4).join('.');
    return `${el.tagName.toLowerCase()}${id}${cls ? '.' + cls : ''}`;
  };
  const textOf = (el) =>
    [el.innerText, el.textContent, el.getAttribute('value'), el.getAttribute('aria-label')]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  const disabled = (el) =>
    el.disabled || el.getAttribute('aria-disabled') === 'true' || String(el.className).includes('disabled');

  // 复刻 checkin.ts 的 checkinControls()
  const selector = [
    'button', '[role="button"]', 'input[type="button"]', 'input[type="submit"]',
    'a[href]', '[class*="btn" i]', '[class*="button" i]', '[onclick]',
  ].join(', ');
  const tagged = [...document.querySelectorAll(selector)];
  const pointer = [...document.querySelectorAll('div, span')].filter((el) => {
    if (el.children.length > 2) return false;
    const t = (el.innerText ?? '').trim();
    if (!t || t.length > 40) return false;
    return getComputedStyle(el).cursor === 'pointer';
  });
  const seen = new Set();
  const controls = [...tagged, ...pointer].filter((el) => {
    if (seen.has(el) || !vis(el)) return false;
    seen.add(el);
    return true;
  });

  const body = document.body?.innerText ?? '';
  return {
    url: location.href,
    title: document.title,
    controlCount: controls.length,
    // 词表命中的（扩展会点这个）
    matched: controls
      .filter((el) => {
        const t = textOf(el);
        return CHECKIN_ACTION.test(t) && !NON_ACTION.test(t) && !ALREADY.some((w) => t.toLowerCase().includes(w.toLowerCase()));
      })
      .map((el) => `${disabled(el) ? '[禁用]' : '[可点]'} ${desc(el)} :: "${textOf(el).slice(0, 50)}"`),
    // 全部可点元素（用来看词表漏了什么）
    allControls: controls.map((el) => `${disabled(el) ? '[禁用]' : '[可点]'} ${desc(el)} :: "${textOf(el).slice(0, 40)}"`).slice(0, 60),
    links: [...document.querySelectorAll('a[href]')]
      .filter(vis)
      .map((el) => `${el.getAttribute('href')} :: "${(el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 30)}"`)
      .slice(0, 50),
    alreadyHit: ALREADY.filter((w) => body.toLowerCase().includes(w.toLowerCase())),
    actionInBody: CHECKIN_ACTION.test(body),
    iframes: [...document.querySelectorAll('iframe')].map(
      (el) => `${vis(el) ? '可见' : '隐藏'} ${(el.getAttribute('src') || '(无src)').slice(0, 90)}`,
    ),
    bodyText: body.replace(/\n{2,}/g, '\n').slice(0, 2000),
  };
}

const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  args: ['--no-first-run', '--no-default-browser-check'],
});

try {
  const page = await ctx.newPage();
  page.setDefaultTimeout(30_000);

  for (const path of paths) {
    const url = entry.origin + path;
    console.log(`\n${'='.repeat(70)}\n访问 ${url}\n${'='.repeat(70)}`);
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      console.log(`HTTP ${resp?.status()}`);
    } catch (e) {
      console.log(`导航失败: ${String(e).split('\n')[0]}`);
      continue;
    }

    // 两次取样：立刻 + 等 SPA 渲染完。差异本身就是结论 ——
    // 若「立刻」找不到而「稍后」找得到，说明必须轮询等待。
    for (const [label, wait] of [['立刻', 300], [`${args.settle}ms 后`, args.settle]]) {
      await page.waitForTimeout(wait);
      const s = await page.evaluate(sample).catch((e) => ({ error: String(e) }));
      if (s.error) {
        console.log(`  [${label}] 取样失败: ${s.error}`);
        continue;
      }
      console.log(`\n  ── ${label} ── (${s.url})`);
      console.log(`  标题: ${s.title}   可点元素总数: ${s.controlCount}`);
      console.log(`  词表命中的签到控件: ${s.matched.length ? '' : '（无）'}`);
      s.matched.forEach((t) => console.log(`     ${t}`));
      if (s.alreadyHit.length) console.log(`  正文含已签到词: ${s.alreadyHit.join(', ')}`);
      if (s.iframes.length) {
        console.log('  iframe:');
        s.iframes.forEach((t) => console.log(`     ${t}`));
      }
      if (label !== '立刻') {
        console.log('  全部可点元素:');
        s.allControls.forEach((t) => console.log(`     ${t}`));
        console.log('  链接:');
        s.links.forEach((t) => console.log(`     ${t}`));
        console.log(`  正文:\n${s.bodyText.split('\n').map((l) => '     ' + l).join('\n')}`);
      }
    }
  }
} finally {
  await ctx.close().catch(() => {});
}
