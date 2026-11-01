/**
 * 学习忠实度验收（真实 Chromium + 真实 LearningCapture 源码）。
 *
 * 存在的理由：用户实测反馈「没有真实学到我的每一步操作，比如我滑动到哪里、
 * 点击了哪里，太死板了」。修复前用真实浏览器探测，8 类常见操作里只有 2 类
 * 被录到，其余整段丢失；本脚本把「用户真实做的每一步都必须被忠实记录」固化成
 * 可执行断言，任何一处回退都会让它变红。
 *
 * 与既有 e2e 的分工：learned-selfcheck / learned-flow 验收的是「保存与回放」，
 * 本脚本只验收**采集忠实度**，不依赖扩展构建产物，直接加载 src 下的真实模块。
 *
 * 运行：node tests/e2e/learning-fidelity.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';

const requireWxt = createRequire(import.meta.resolve('wxt'));
const { createServer } = await import(pathToFileURL(requireWxt.resolve('vite')).href);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const srcDir = resolve(root, 'src');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? `  — ${detail}` : ''}`);
}

const FIXTURE = `<!doctype html><meta charset="utf-8"><title>fidelity</title>
<style>
  body{margin:0;font:14px sans-serif}
  #panel{height:300px;overflow:auto;border:1px solid #ccc;width:600px}
  .tall{height:2400px}
  #claim{display:block;width:400px;height:120px;margin:30px}
  #next{margin:30px;padding:12px 24px}
  #reason{display:block;margin:30px;width:300px;padding:8px}
</style>
<button id="next">下一步</button>
<button id="claim">立即签到</button>
<input id="reason" placeholder="理由">
<div id="panel"><div class="tall"></div><button id="innerBtn">面板内按钮</button></div>
<div class="tall"></div>`;

const server = await createServer({
  configFile: false,
  root,
  resolve: { alias: { '@': srcDir } },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [{
    name: 'learning-fidelity-fixture',
    configureServer(s) {
      s.middlewares.use('/fidelity', (_req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(FIXTURE);
      });
    },
  }],
});

let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  await page.goto(`${server.resolvedUrls.local[0]}fidelity`);

  await page.evaluate(async () => {
    const learning = await import('/src/automation/learning/learning.ts');
    window.__events = [];
    window.__cap = new learning.LearningCapture({
      kind: 'checkin',
      settleMs: 60,
      scrollStopMs: 60,
      onEvent: (event) => window.__events.push(event),
    });
    window.__cap.attach();
  });

  const take = () => page.evaluate(() => { const e = window.__events.slice(); window.__events.length = 0; return e; });

  // ① 纯滚动：用户滚下去看内容，不点击任何东西
  await page.evaluate(() => window.scrollTo(0, 1500));
  await page.waitForTimeout(300);
  const scrollOnly = await take();
  const scrollEvent = scrollOnly.find((e) => e.type === 'scroll');
  check('① 纯滚动会被记录成一步（而不是整段丢失）', !!scrollEvent,
    scrollEvent ? `ratio=${scrollEvent.ratio}` : '没有任何 scroll 事件');
  if (scrollEvent) {
    check('   滚动位置以 0..1 比例记录，且落在合理区间', Number.isFinite(scrollEvent.ratio) && scrollEvent.ratio > 0 && scrollEvent.ratio <= 1,
      `ratio=${scrollEvent.ratio}`);
  }

  // ② 回顶部再滚到某处：两次滚动都不该凭空消失
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await page.evaluate(() => window.scrollTo(0, 800));
  await page.waitForTimeout(300);
  const scrollTwice = await take();
  check('② 回顶部后再滚，会记录这次真实滚动', scrollTwice.some((e) => e.type === 'scroll'),
    `事件类型：${JSON.stringify(scrollTwice.map((e) => e.type))}`);

  // ③ 点击按钮右侧：落点必须被记录，而不是永远按中心回放
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
  await take();
  const claimBox = await page.locator('#claim').boundingBox();
  await page.mouse.move(claimBox.x + claimBox.width * 0.9, claimBox.y + claimBox.height * 0.5);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(250);
  const rightClick = await take();
  const clickEvent = rightClick.find((e) => e.type === 'click');
  check('③ 点击会被记录', !!clickEvent, clickEvent ? clickEvent.selector : '没有 click 事件');
  if (clickEvent) {
    check('   点击的**落点**被记录成元素内相对比例（不是只记元素）',
      !!clickEvent.anchor && Number.isFinite(clickEvent.anchor.rx) && Number.isFinite(clickEvent.anchor.ry),
      clickEvent.anchor ? `anchor=${JSON.stringify(clickEvent.anchor)}` : '没有 anchor 字段');
    if (clickEvent.anchor) {
      check('   点在按钮右侧 → rx 明显大于 0.5（证明记的是真实落点）', clickEvent.anchor.rx > 0.6,
        `rx=${clickEvent.anchor.rx}`);
    }
    check('   不落原始坐标（隐私红线：不得出现 clientX/clientY/screenX/screenY）',
      !('clientX' in clickEvent) && !('clientY' in clickEvent) && !('screenX' in clickEvent) && !('screenY' in clickEvent),
      `字段：${JSON.stringify(Object.keys(clickEvent))}`);
  }

  // ④ 双击：必须与单击区分开
  await take();
  await page.locator('#next').dblclick();
  await page.waitForTimeout(250);
  const dbl = await take();
  check('④ 双击被识别为双击（而不是两次普通单击）',
    dbl.some((e) => e.type === 'click' && e.gesture === 'double'),
    `gesture 取值：${JSON.stringify(dbl.filter((e) => e.type === 'click').map((e) => e.gesture ?? '(缺省)'))}`);

  // ⑤ 右键
  await take();
  await page.locator('#next').click({ button: 'right' });
  await page.waitForTimeout(250);
  const right = await take();
  check('⑤ 右键操作被记录（而不是完全丢失）',
    right.some((e) => e.type === 'click' && e.gesture === 'right'),
    `事件：${JSON.stringify(right.map((e) => `${e.type}:${e.gesture ?? '-'}`))}`);

  // ⑥ 长按
  await take();
  const nextBox = await page.locator('#next').boundingBox();
  await page.mouse.move(nextBox.x + nextBox.width / 2, nextBox.y + nextBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await page.waitForTimeout(250);
  const longPress = await take();
  check('⑥ 长按被识别为长按（而不是普通单击）',
    longPress.some((e) => e.type === 'click' && e.gesture === 'long-press'),
    `gesture 取值：${JSON.stringify(longPress.filter((e) => e.type === 'click').map((e) => e.gesture ?? '(缺省)'))}`);

  // ⑦ 键盘：Enter 提交必须被记录；可打印字符绝不落盘
  await take();
  await page.locator('#reason').focus();
  await page.keyboard.type('sentinel_text_zz99');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const typed = await take();
  check('⑦ 按 Enter 被记录成键盘动作',
    typed.some((e) => e.key === 'Enter'),
    `事件：${JSON.stringify(typed.map((e) => `${e.type}:${e.key ?? '-'}`))}`);
  check('   可打印字符不被记录成按键（隐私红线）',
    !typed.some((e) => typeof e.key === 'string' && e.key.length === 1),
    '没有单字符 key');
  check('   输入内容本身绝不落盘（只记「有没有内容」）',
    !JSON.stringify(typed).includes('sentinel_text_zz99'),
    '事件流里不含输入文本');

  // ⑧ 内层容器滚动
  await take();
  await page.evaluate(() => { document.querySelector('#panel').scrollTop = 500; });
  await page.waitForTimeout(300);
  const inner = await take();
  const innerScroll = inner.find((e) => e.type === 'scroll' && e.container);
  check('⑧ 内层滚动容器的滚动被记录，且带容器选择器',
    !!innerScroll,
    innerScroll ? `container=${innerScroll.container} ratio=${innerScroll.ratio}` : `事件：${JSON.stringify(inner.map((e) => e.type))}`);

  /*
   * ⑨ 拖拽
   *
   * 期望是「拖拽本身整条不进流程」——这是项目既有契约（见 tests/e2e/learned-flow.mjs：
   * fixture 的拖拽把手是干扰项，真实拖拽松手后浏览器补发的合成 click 必须被过滤掉）。
   *
   * 为什么不做成「drag 步骤」：补发 click 的落点常常仍在把手上，把它录成一步会让回放
   * 去点/拖那个把手，而把手通常不是签到控件 —— 实测就是「学到 #pull-knob、真按钮被挤掉」。
   * 宁可少录一步，也不把噪声写进流程。
   *
   * 同时锁定反面：拖拽之后**用户真正点的那一下**必须照常被记录（过滤不能误伤真实点击）。
   */
  await take();
  const innerBtn = await page.locator('#innerBtn').boundingBox();
  await page.mouse.move(innerBtn.x + 10, innerBtn.y + 10);
  await page.mouse.down();
  await page.mouse.move(innerBtn.x + 140, innerBtn.y + 50, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const drag = await take();
  check('⑨ 拖拽松手补发的合成 click 被整条过滤（不会被录成一步）',
    !drag.some((e) => e.type === 'click' && e.selector === '#innerBtn'),
    `事件：${JSON.stringify(drag.map((e) => `${e.type}:${e.selector ?? '-'}`))}`);

  // 反面：紧接着一次**真实**点击必须照常记录（过滤只针对拖拽尾巴）
  await take();
  await page.locator('#innerBtn').click();
  await page.waitForTimeout(250);
  const afterDragClick = await take();
  check('   拖拽之后的真实点击照常被记录（过滤没有误伤点击）',
    afterDragClick.some((e) => e.type === 'click' && e.selector === '#innerBtn'),
    `事件：${JSON.stringify(afterDragClick.map((e) => `${e.type}:${e.selector ?? '-'}`))}`);

  // 汇总
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`忠实度验收：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('未通过项：');
    for (const f of failed) console.log(`  ✘ ${f.name}`);
  }
  console.log('='.repeat(60));
  process.exitCode = failed.length ? 1 : 0;
} finally {
  if (browser) await browser.close();
  await server.close();
}
