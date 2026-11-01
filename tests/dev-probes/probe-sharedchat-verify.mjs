/**
 * 核验 SharedChat 权益是否真的领到了。
 *
 * 为什么需要：claim 的终态判据「弹窗已关闭且页面已更新」是弱证据 ——
 * 点了取消、或提交被拒后弹窗关闭，都会满足它。真正的证据是套餐状态
 * 从「已过期」变成生效，以及站点自己的接口返回的到期时间。
 *
 * 用法：先让 real-site-e2e.mjs --keep 把浏览器留着，再跑这个。
 */
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const pages = browser.contexts().flatMap((context) => context.pages());
const page = pages.find((item) => item.url().includes('sharedchat')) ?? pages[0];
if (!page) {
  console.error('没有找到 sharedchat 标签页');
  process.exit(2);
}

console.log(`目标页: ${page.url()}\n`);

// 刷新一次，确保读到服务端的最新状态而不是领取前的缓存
const refresh = page.locator('button.refresh-btn').first();
if (await refresh.count()) {
  await refresh.click().catch(() => {});
  await page.waitForTimeout(3_000);
}

const state = await page.evaluate(() => {
  const text = document.body?.innerText ?? '';
  const pick = (pattern) => text.match(pattern)?.[1]?.trim() ?? null;

  return {
    // 「已过期」应在领取成功后消失
    expired: /已过期/.test(text),
    active: /生效中|已生效|有效期/.test(text),
    planName: pick(/当前套餐 - Codex\s*\n\s*刷新\s*\n\s*(.+)/),
    total: pick(/总额度\s*\$?([\d.]+)/),
    used: pick(/已使用\s*\$?([\d.]+)/),
    remain: pick(/剩余\s*\$?([\d.]+)/),
    nextReset: pick(/下次重置\s*[：:]\s*([\d/\s:]+)/),
    // 领取按钮还在说明尚未领取；变成禁用或消失才是领过了
    claimButton: (() => {
      const button = [...document.querySelectorAll('button')]
        .find((element) => /领取\s*Codex\s*权益/.test(element.innerText || ''));
      if (!button) return { present: false };
      return {
        present: true,
        disabled: button.disabled,
        text: (button.innerText || '').trim(),
      };
    })(),
    // 弹窗残留说明提交没被接受
    dialogOpen: !!document.querySelector('[role="dialog"] textarea, .el-dialog textarea'),
    // 站点的提示条（成功/失败都走这里）
    messages: [...document.querySelectorAll('.el-message, .el-notification, [class*="toast" i]')]
      .map((element) => (element.innerText || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean),
  };
});

console.log('── 页面状态 ──');
console.log(`  套餐: ${state.planName ?? '(未识别)'}`);
console.log(`  已过期标记: ${state.expired ? '仍在 ✗' : '已消失 ✓'}`);
console.log(`  生效标记: ${state.active ? '出现 ✓' : '未出现'}`);
console.log(`  总额度=${state.total} 已使用=${state.used} 剩余=${state.remain}`);
console.log(`  下次重置: ${state.nextReset ?? '(未识别)'}`);
console.log(`  领取按钮: ${JSON.stringify(state.claimButton)}`);
console.log(`  弹窗残留: ${state.dialogOpen ? '是 ✗' : '否 ✓'}`);
if (state.messages.length) console.log(`  站点提示: ${state.messages.join(' | ')}`);

// 站点自己的接口是最权威的证据
const api = await page.evaluate(async () => {
  const paths = [
    '/api/vibe/subscription',
    '/api/vibe/plan',
    '/api/user/subscription',
    '/api/vibe-code/dashboard',
  ];
  const out = [];
  for (const path of paths) {
    try {
      const response = await fetch(path, { credentials: 'include' });
      const body = (await response.text()).slice(0, 600);
      out.push({ path, status: response.status, body });
    } catch (error) {
      out.push({ path, error: String(error).slice(0, 80) });
    }
  }
  return out;
});

console.log('\n── 接口探测 ──');
for (const item of api) {
  if (item.error) {
    console.log(`  ${item.path} → 出错 ${item.error}`);
    continue;
  }
  console.log(`  ${item.path} → HTTP ${item.status}`);
  if (item.status === 200) console.log(`     ${item.body.replace(/\s+/g, ' ').slice(0, 400)}`);
}

console.log('\n── 判读 ──');
if (!state.expired && (state.active || state.claimButton.present === false || state.claimButton.disabled)) {
  console.log('  ✔ 权益已到账：过期标记消失，且领取入口不再可用');
} else if (state.expired && state.claimButton.present && !state.claimButton.disabled) {
  console.log('  ✖ 仍显示已过期、领取按钮依旧可点 —— 这次提交很可能没被接受');
  console.log('    （claim 的「弹窗已关闭」判据不足以证明成功，需要更强的成功标志）');
} else {
  console.log('  ? 状态不明确，需人工确认页面');
}

await browser.close();
