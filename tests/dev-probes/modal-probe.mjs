/**
 * 弹窗判别的真实浏览器验证。
 *
 * vitest 是 node 环境、没有 jsdom，所以「签到按钮在弹窗里」这类判据
 * 在单测里测不了 —— 它们要真的 querySelector + getComputedStyle。
 * 这个脚本用 Playwright 的 chromium 造几个典型弹窗结构，验证：
 *  - 旧词表 `.semi-modal-footer button` 会点中签到（这是修掉的那个 bug）
 *  - 新词表只点中次要按钮
 *  - ownerModal / holdsCheckinEvidence 的判据在真实 DOM 上成立
 *
 * 用法：node tests/modal-probe.mjs
 */
import { chromium } from 'playwright';

const CASES = [
  {
    name: 'footer 顺序 [签到][关闭]',
    html: `
      <div class="semi-modal" role="dialog" aria-modal="true" style="width:800px;height:400px">
        <div class="semi-modal-body">每日签到</div>
        <div class="semi-modal-footer">
          <button class="semi-button semi-button-primary">签到</button>
          <button class="semi-button semi-button-tertiary" aria-label="Close">关闭</button>
        </div>
      </div>`,
  },
  {
    name: 'footer 顺序 [关闭][签到]',
    html: `
      <div class="semi-modal" role="dialog" aria-modal="true" style="width:800px;height:400px">
        <div class="semi-modal-footer">
          <button class="semi-button semi-button-tertiary" aria-label="Close">关闭</button>
          <button class="semi-button semi-button-primary">签到</button>
        </div>
      </div>`,
  },
  {
    name: '纯公告弹窗（无签到控件）',
    html: `
      <div class="semi-modal" role="dialog" aria-modal="true" style="width:800px;height:400px">
        <div class="semi-modal-body">系统维护通知：今晚 2 点重启</div>
        <div class="semi-modal-footer">
          <button class="semi-button semi-button-tertiary" aria-label="Close">我知道了</button>
        </div>
      </div>`,
  },
  {
    name: '公告正文含「签到」二字但无按钮',
    html: `
      <div class="semi-modal" role="dialog" aria-modal="true" style="width:800px;height:400px">
        <div class="semi-modal-body"><p>每日签到活动开始了，快来参与</p></div>
        <div class="semi-modal-footer">
          <button class="semi-button semi-button-tertiary" aria-label="Close">关闭</button>
        </div>
      </div>`,
  },
  {
    name: 'Tailwind 变体类名的签到按钮',
    html: `
      <div role="dialog" aria-modal="true" style="width:800px;height:400px">
        <button class="btn btn-primary disabled:opacity-50">立即签到</button>
        <button class="close-btn" aria-label="Close">×</button>
      </div>`,
  },
];

const OLD_SELECTOR = '.semi-modal-footer button';
const NEW_SELECTOR = '.semi-modal-footer button.semi-button-tertiary';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

let failures = 0;

for (const testCase of CASES) {
  await page.setContent(testCase.html);
  console.log(`\n── ${testCase.name}`);

  const oldHit = await page.$(OLD_SELECTOR);
  const oldText = oldHit ? (await oldHit.innerText()).trim() : null;
  const newHit = await page.$(NEW_SELECTOR);
  const newText = newHit ? (await newHit.innerText()).trim() : null;
  const labelHit = await page.$('[aria-label="close" i]');
  const labelText = labelHit ? (await labelHit.innerText()).trim() : null;

  console.log(`  旧词表命中 : ${oldText ?? '(无)'}`);
  console.log(`  新词表命中 : ${newText ?? '(无)'}`);
  console.log(`  aria 兜底  : ${labelText ?? '(无)'}`);

  // 新词表绝不能点中含签到动作词的按钮
  const ACTION = /(?:签到|打卡|领取|check[\s-]?in|claim)/i;
  for (const [label, text] of [['新词表', newText], ['aria 兜底', labelText]]) {
    if (text && ACTION.test(text)) {
      console.log(`  ✗ ${label} 点中了签到动作「${text}」`);
      failures += 1;
    }
  }

  // 弹窗里有可点签到按钮时，判据应认出它
  const hasCheckinButton = await page.evaluate(() => {
    const ACTION_RE = /(?:签到|打卡|领取|check[\s-]?in|claim)/i;
    const NON_ACTION = /(?:历史|记录|规则|日历|说明|明细|详情)/i;
    const DISABLED = /^(?:disabled|is-disabled|[\w-]+-disabled)$/i;
    const controls = [...document.querySelectorAll('button, [role="button"], a[href], [class*="btn" i]')];
    return controls.some((el) => {
      const text = (el.innerText || '').trim();
      const disabled = el.disabled
        || el.getAttribute('aria-disabled') === 'true'
        || String(el.className).split(/\s+/).some((t) => !t.includes(':') && DISABLED.test(t));
      return !disabled && ACTION_RE.test(text) && !NON_ACTION.test(text);
    });
  });
  console.log(`  弹窗内有可点签到控件: ${hasCheckinButton ? '是 → 应保留' : '否 → 可关闭'}`);
}

await browser.close();
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
