/**
 * 多步领取流程取样 —— 点开入口、把弹窗结构导出来。
 *
 * 和 dump-checkin-page.mjs 的区别：那个只静态看页面，而领取流程的关键结构
 * （输入框、提交按钮）在**点开入口之后**才存在。所以这个脚本会点一下。
 *
 * 它会做的：导航 → 点领取入口 → 等弹窗 → 导出输入框/按钮/建议选择器。
 * 它**不会**做的：填文本、点提交。停在提交之前，不会真的领取。
 *
 * 依赖 real-site-e2e.mjs --profile 留下的登录态目录。
 *
 * 用法：
 *   node tests/dump-claim-flow.mjs --origin https://chaiai.example.com
 *   node tests/dump-claim-flow.mjs --origin https://x.com --path /console
 *   node tests/dump-claim-flow.mjs --origin https://x.com --entry "button.claim"
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function parseArgs(argv) {
  const out = { origin: '', paths: [], entry: '', settle: 5000, profile: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--origin') (out.origin = argv[i + 1] ?? ''), (i += 1);
    else if (a === '--path') (out.paths.push(argv[i + 1] ?? ''), (i += 1));
    else if (a === '--entry') (out.entry = argv[i + 1] ?? ''), (i += 1);
    else if (a === '--settle') (out.settle = Number(argv[i + 1]) || out.settle), (i += 1);
    else if (a === '--profile') (out.profile = argv[i + 1] ?? ''), (i += 1);
    else throw new Error(`未知参数: ${a}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.origin) {
  console.error('必须给 --origin，例如 --origin https://chaiai.example.com');
  process.exit(2);
}

const host = new URL(args.origin).hostname.replace(/^www\./, '');
const profileName = args.profile || host.split('.')[0];
const profile = join(homedir(), '.checkin-e2e-profiles', profileName);
if (!existsSync(profile)) {
  console.error(`登录态目录不存在: ${profile}`);
  console.error(`请先运行: node tests/real-site-e2e.mjs --site ${profileName} --profile --keep`);
  console.error('并在打开的浏览器里完成登录。');
  process.exit(2);
}

const paths = args.paths.length ? args.paths : ['/', '/console', '/dashboard', '/profile'];

/**
 * 在页面上下文里跑的取样函数。
 * 独立于扩展代码 —— 这是「站点实际长什么样」的观测，不是「扩展怎么判定」。
 */
function snapshot() {
  const ACTION = /(?:领取|签到|打卡|claim|redeem|check[\s-]?in)/i;
  const NON_ACTION = /(?:历史|记录|规则|日历|说明|明细|详情|history|rule|record|detail)/i;
  const MODAL_ROOTS = [
    'dialog[open]', '[role="dialog"]', '[aria-modal="true"]',
    '.semi-modal', '.ant-modal', '.MuiDialog-root', '.modal',
  ].join(', ');

  const vis = (el) => {
    if (!el.isConnected || el.getClientRects().length === 0) return false;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  };
  const textOf = (el) =>
    [el.innerText, el.textContent, el.getAttribute('value'), el.getAttribute('aria-label')]
      .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  const isDisabled = (el) =>
    el.disabled || el.getAttribute('aria-disabled') === 'true'
    || String(el.className).split(/\s+/).some((t) => !t.includes(':') && /^(?:disabled|is-disabled|[\w-]+-disabled)$/i.test(t));

  /**
   * 给一个元素建议**稳定**的选择器。
   *
   * Chrome 的 Copy selector 常给 `:nth-child` 长链，页面一重渲染就失效。
   * 这里按稳定度排序找：id → data-testid → name → aria-label → 语义 class。
   * 都没有才退到路径，并明确标记为脆弱。
   */
  const suggest = (el) => {
    const tag = el.tagName.toLowerCase();
    if (el.id && !/^[0-9]/.test(el.id) && !/\d{4,}/.test(el.id)) {
      return { sel: `#${el.id}`, stable: true };
    }
    for (const attr of ['data-testid', 'data-test', 'data-cy']) {
      const v = el.getAttribute(attr);
      if (v) return { sel: `[${attr}="${v}"]`, stable: true };
    }
    const name = el.getAttribute('name');
    if (name) return { sel: `${tag}[name="${name}"]`, stable: true };
    const label = el.getAttribute('aria-label');
    if (label) return { sel: `${tag}[aria-label="${label}"]`, stable: true };

    // 过滤掉 css-1a2b3c / jsx-123456 这类构建期生成的哈希类名
    const semantic = String(el.className || '').trim().split(/\s+/)
      .filter((c) => c && !c.includes(':') && !/^(?:css|jsx|sc|emotion)-/i.test(c) && !/^[a-z]{1,3}[0-9a-f]{5,}$/i.test(c));
    if (semantic.length) {
      return { sel: `${tag}.${semantic.slice(0, 2).join('.')}`, stable: true };
    }

    const parts = [];
    let cur = el;
    for (let depth = 0; cur && depth < 4; depth += 1) {
      const t = cur.tagName.toLowerCase();
      if (t === 'body') break;
      const sibs = cur.parentElement ? [...cur.parentElement.children].filter((c) => c.tagName === cur.tagName) : [];
      parts.unshift(sibs.length > 1 ? `${t}:nth-of-type(${sibs.indexOf(cur) + 1})` : t);
      cur = cur.parentElement;
    }
    return { sel: parts.join(' > '), stable: false };
  };

  const dumpInputs = (root) =>
    [...root.querySelectorAll('input, textarea, [contenteditable="true"], [contenteditable=""]')]
      .filter(vis)
      .map((el) => {
        const s = suggest(el);
        const editable = el.hasAttribute('contenteditable');
        return {
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type') ?? (editable ? 'contenteditable' : ''),
          contenteditable: editable,
          placeholder: el.getAttribute('placeholder') ?? '',
          maxLength: el.getAttribute('maxlength') ?? '',
          selector: s.sel,
          stable: s.stable,
        };
      });

  const dumpButtons = (root) =>
    [...root.querySelectorAll('button, [role="button"], input[type="submit"], [class*="btn" i]')]
      .filter(vis)
      .map((el) => {
        const s = suggest(el);
        const text = textOf(el);
        return {
          text: text.slice(0, 40),
          disabled: isDisabled(el),
          isAction: ACTION.test(text) && !NON_ACTION.test(text),
          selector: s.sel,
          stable: s.stable,
        };
      });

  const modals = [...document.querySelectorAll(MODAL_ROOTS)].filter(vis);
  const body = document.body?.innerText ?? '';

  return {
    url: location.href,
    title: document.title,
    hasModal: modals.length > 0,
    modalCount: modals.length,
    modal: modals.length
      ? { inputs: dumpInputs(modals[0]), buttons: dumpButtons(modals[0]), text: textOf(modals[0]).slice(0, 400) }
      : null,
    // 页面级的领取入口候选
    entries: dumpButtons(document).filter((b) => b.isAction),
    // 正文里的字数要求提示（「不少于 10 字」之类）
    lengthHints: (body.match(/(?:不少于|至少|最少|минимум|at\s+least)\s*(\d+)\s*(?:个?字|字符|characters?)/gi) ?? []).slice(0, 5),
    bodyExcerpt: body.replace(/\n{2,}/g, '\n').slice(0, 1200),
  };
}

const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  args: ['--no-first-run', '--no-default-browser-check'],
});

const fmt = (item) => `${item.stable ? '  ' : '⚠ '}${item.selector}`;

try {
  const page = await ctx.newPage();
  page.setDefaultTimeout(30_000);

  for (const path of paths) {
    const url = args.origin.replace(/\/$/, '') + path;
    console.log(`\n${'='.repeat(72)}\n访问 ${url}\n${'='.repeat(72)}`);
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      console.log(`HTTP ${resp?.status()}`);
    } catch (e) {
      console.log(`导航失败: ${String(e).split('\n')[0]}`);
      continue;
    }
    await page.waitForTimeout(args.settle);

    let snap = await page.evaluate(snapshot).catch((e) => ({ error: String(e) }));
    if (snap.error) { console.log(`取样失败: ${snap.error}`); continue; }

    console.log(`标题: ${snap.title}`);
    if (snap.lengthHints.length) console.log(`正文里的字数要求: ${snap.lengthHints.join(' / ')}`);

    if (snap.hasModal) {
      console.log(`\n[点击前已有弹窗] ${snap.modalCount} 个`);
    }

    console.log(`\n领取入口候选 (${snap.entries.length}):`);
    snap.entries.forEach((b) => console.log(`  ${b.disabled ? '[禁用]' : '[可点]'} "${b.text}"  →${fmt(b)}`));

    // 点开入口，看弹窗里有什么
    const target = args.entry || snap.entries.find((b) => !b.disabled)?.selector;
    if (!target) {
      console.log('  没有可点的领取入口，跳过点击');
      continue;
    }

    console.log(`\n点击 ${target} ...`);
    try {
      await page.click(target, { timeout: 8000 });
    } catch (e) {
      console.log(`  点击失败: ${String(e).split('\n')[0]}`);
      continue;
    }
    await page.waitForTimeout(2500);

    snap = await page.evaluate(snapshot).catch((e) => ({ error: String(e) }));
    if (snap.error) { console.log(`点击后取样失败: ${snap.error}`); continue; }

    if (!snap.hasModal) {
      console.log('  点击后没有出现弹窗 —— 可能是整页跳转，或入口选错了');
      console.log(`  当前地址: ${snap.url}`);
      continue;
    }

    console.log(`\n── 弹窗结构 ──`);
    console.log(`  正文: ${snap.modal.text.slice(0, 200)}`);
    console.log(`\n  输入框 (${snap.modal.inputs.length}):`);
    snap.modal.inputs.forEach((i) => {
      console.log(`   ${i.contenteditable ? '⚠ contenteditable' : `<${i.tag}> type=${i.type || '(无)'}`}`);
      console.log(`     placeholder: "${i.placeholder}"${i.maxLength ? `  maxlength=${i.maxLength}` : ''}`);
      console.log(`     选择器:${fmt(i)}`);
    });
    console.log(`\n  按钮 (${snap.modal.buttons.length}):`);
    snap.modal.buttons.forEach((b) => {
      console.log(`   ${b.disabled ? '[禁用]' : '[可点]'}${b.isAction ? '[动作词]' : ''} "${b.text}"  →${fmt(b)}`);
    });

    // 直接拼一份可以粘进站点表单的配置
    const input = snap.modal.inputs[0];
    const submit = snap.modal.buttons.find((b) => b.isAction && !b.disabled)
      ?? snap.modal.buttons.find((b) => b.isAction);
    console.log(`\n── 建议配置（粘进站点表单的「领取权益」）──`);
    console.log(`  领取页地址        : ${path}`);
    console.log(`  入口按钮选择器    : ${target}`);
    console.log(`  输入框选择器      : ${input?.selector ?? '(没找到)'}`);
    console.log(`  提交按钮选择器    : ${submit?.selector ?? '(没找到)'}`);
    if (snap.lengthHints.length) console.log(`  最少字数          : ${snap.lengthHints[0].match(/\d+/)?.[0] ?? ''}`);

    const fragile = [input, submit].filter((x) => x && !x.stable);
    if (fragile.length) {
      console.log(`\n  ⚠ 有 ${fragile.length} 个选择器只能用位置路径表达，页面重渲染后可能失效。`);
    }
    if (input?.contenteditable) {
      console.log(`\n  ⚠ 输入框是 contenteditable，不是 <input>/<textarea>。`);
      console.log(`    setNativeValue 对它无效，需要改用 execCommand/InputEvent 填值。`);
    }
    break; // 找到弹窗就够了，别在其它路径上重复点击
  }
} finally {
  await ctx.close().catch(() => {});
}
