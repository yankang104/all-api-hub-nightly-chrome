import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';
import {
  launchExtensionContext, openExtensionPage, seedAppStorage, readAppState,
  statusOf, startAccount, waitForAccountSettled, waitForQueueIdle, disposeContext,
} from './lib/extension-harness.mjs';
import { startRuntimeFixture } from './lib/workflow-runtime-fixture.mjs';
import { FIXTURE_SENTINEL_USERNAME, FIXTURE_SENTINEL_PASSWORD, FIXTURE_ALICE_USERNAME } from './learned-flow-fixture.mjs';

const root = resolve('output/workflow-runtime-acceptance');
mkdirSync(root, { recursive: true });
const fixture = await startRuntimeFixture();
const origin = fixture.origin;
const accountId = 'runtime-target';
const siteId = 'runtime-fixture';
let context;
let app;
let assertions = 0;
let scenarios = 0;
function check(label, value, detail = '') {
  assert.ok(value, label + (detail ? ': ' + detail : ''));
  assertions += 1;
  console.log('✔ ' + label);
}
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(read, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await pause(150);
  }
  throw new Error('等待超时：' + label);
}
try {
  const launched = await launchExtensionContext({ chromium,
    profileDir: mkdtempSync(join(root, 'profile-')),
    extensionDir: resolve(process.env.EXTENSION_DIR || '.output/chrome-mv3'),
    headless: process.env.E2E_HEADLESS !== '0',
  });
  context = launched.context;
  app = await openExtensionPage(context, launched.extensionId);
  await seedAppStorage(app, {
    sites: [{ id: siteId, name: '运行时防护验收站', loginUrl: origin + '/login',
      successIndicator: '#logged-in', closeModalSelectors: [], checkin: { method: 'auto', url: '/console' },
      adapter: { family: 'new-api', siteType: 'new-api', quotaPerUnit: 500000 } }],
    accounts: [{ id: accountId, siteId, username: FIXTURE_SENTINEL_USERNAME, password: FIXTURE_SENTINEL_PASSWORD }],
  });
  await app.reload();
  console.log('── 干净页面：真实学习登录到签到 ──');
  const learningPage = context.waitForEvent('page');
  const toggled = await app.evaluate((id) => chrome.runtime.sendMessage({ type: 'TOGGLE_LEARNING', accountId: id, kind: 'both' }), accountId);
  check('融合学习已启动', toggled.ok, JSON.stringify(toggled));
  const page = await learningPage;
  await page.waitForURL(origin + '/login');
  await page.waitForSelector('[data-checkin-learning-guide]');
  await page.fill('#username', FIXTURE_SENTINEL_USERNAME);
  await page.fill('#password', FIXTURE_SENTINEL_PASSWORD);
  await page.click('#login-submit');
  await page.waitForURL(origin + '/console');
  await page.waitForSelector('[data-checkin-learning-guide]');
  await page.click('#nav-profile');
  await page.waitForURL(origin + '/profile');
  await page.waitForSelector('[data-checkin-learning-guide]');
  await page.click('#nav-checkin');
  await page.waitForURL(origin + '/checkin');
  await page.waitForSelector('[data-checkin-learning-guide]');
  await page.click('#open-checkin');
  await page.click('#claim');
  await page.waitForFunction(() => document.querySelector('#checkin-result')?.textContent === '签到成功');
  await until(() => app.evaluate(async () => Object.values(await chrome.storage.session.get(null))
    .some((value) => value?.events?.filter((event) => event.type === 'click' && event.path === '/checkin').length >= 2)), '录制两个业务步骤');
  await app.evaluate((id) => chrome.runtime.sendMessage({ type: 'TOGGLE_LEARNING', accountId: id, kind: 'both' }), accountId);
  const learned = await until(async () => (await readAppState(app)).sites.find((site) => site.id === siteId && site.checkin?.workflow?.steps?.length), '统一保存学习产物');
  const workflow = learned.checkin.workflow;
  console.log('学习路线：' + JSON.stringify(workflow.route));
  console.log('学习步骤：' + JSON.stringify(workflow.steps));
  check('学到独立身份核验页', workflow.identityPath === '/profile');
  check('学到打开面板和签到两个业务动作', workflow.steps.filter((step) => step.type === 'click').length >= 2);
  const serialized = JSON.stringify(learned);
  check('学习产物不含示范账号密码', !serialized.includes(FIXTURE_SENTINEL_USERNAME) && !serialized.includes(FIXTURE_SENTINEL_PASSWORD));
  check('学习产物不依赖公告或验证码步骤', !/notice-closed|challenge-solved|captcha/.test(serialized));
  await app.evaluate((id) => {
    globalThis.__workflowRuntimeStatuses = [];
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.status) return;
      for (const [key, value] of Object.entries(changes.status.newValue || {})) {
        if (key.startsWith(id + ':')) globalThis.__workflowRuntimeStatuses.push(value);
      }
    });
  }, accountId);

  async function replay(label, options = {}, session = FIXTURE_SENTINEL_USERNAME) {
    scenarios += 1;
    console.log('\n── ' + label + ' ──');
    const idle = await waitForQueueIdle(app);
    check(label + '：队列初始空闲', !idle.queue.active && idle.queue.pendingAccountIds.length === 0);
    for (const tab of context.pages()) if (tab.url().startsWith(origin)) await tab.close();
    await context.clearCookies();
    if (session) await context.addCookies([{ name: 'fixture_user', value: session, url: origin, httpOnly: true, sameSite: 'Lax' }]);
    fixture.reset(options);
    await app.evaluate(async () => {
      globalThis.__workflowRuntimeStatuses = [];
      await chrome.storage.local.set({ status: {}, results: {} });
    });
    const started = await startAccount(app, accountId);
    check(label + '：任务入队', started?.ok === true, JSON.stringify(started));
    const state = await waitForAccountSettled(app, accountId, { timeoutMs: 120000 });
    const result = state.results[accountId];
    const events = fixture.events();
    console.log(JSON.stringify({ status: statusOf(state, accountId), result, queue: state.queue, liveTasks: state.liveTasks, events }, null, 2));
    check(label + '：终态 done', statusOf(state, accountId) === 'done', result?.message);
    const statuses = await app.evaluate(() => globalThis.__workflowRuntimeStatuses);
    check(label + '：全程没有转成人工处理', !statuses.includes('attention'), JSON.stringify(statuses));
    check(label + '：任务释放队列', !state.queue.active && state.liveTasks.length === 0);
    const claims = events.filter((event) => event.path === '/api/checkin' && event.method === 'POST');
    check(label + '：只签到一次', claims.length === 1, JSON.stringify(claims));
    check(label + '：绝不给其他账号签到', claims.every((event) => event.user === FIXTURE_SENTINEL_USERNAME));
    const claimIndex = events.findIndex((event) => event === claims[0]);
    const previousIdentity = events.slice(0, claimIndex).filter((event) => event.path === '/api/user/self').at(-1);
    check(label + '：操作前最后一次服务端核验属于目标账号', previousIdentity?.user === FIXTURE_SENTINEL_USERNAME);
    const logins = events.filter((event) => event.path === '/session').length;
    check(label + '：登录次数符合会话场景', options.mutation || session !== FIXTURE_SENTINEL_USERNAME ? logins >= 1 : logins === 0, String(logins));
    if (options.notices) check(label + '：自动关闭未演示的多处公告', events.filter((event) => event.path === '/runtime/notice-closed').length >= 3);
    if (options.challenge) check(label + '：自动处理未演示的算术验证', events.some((event) => event.path === '/runtime/challenge-solved'));
    if (options.challengeDelayMs) {
      const advances = events.filter((event) => event.path === '/runtime/advance');
      const mounted = events.find((event) => event.path === '/runtime/challenge-mounted');
      check(label + '：验证确实晚于点击后快照窗口出现', mounted?.t - advances[0]?.t >= options.challengeDelayMs - 100);
      check(label + '：等待恢复不重复打开业务面板', advances.length === 1);
    }
    if (options.mutation === 'swap') check(label + '：检测到中途串号',
      events.some((event) => event.path === '/api/user/self' && event.user === FIXTURE_ALICE_USERNAME)
        || (result?.steps || []).some((step) => step.includes('学习流程中检测到账号变化')));
    if (options.mutation === 'expire') check(label + '：有界恢复重新登录', (result?.steps || []).some((step) => step.startsWith('学习流程恢复登录:')));
  }
  await replay('已登录正确账号直接签到');
  await replay('未登录＋多处公告＋临时验证', { notices: true, challenge: true }, null);
  await replay('错误账号退出重登＋公告验证', { notices: true, challenge: true }, FIXTURE_ALICE_USERNAME);
  await replay('进入签到页时会话过期', { notices: true, challenge: true, mutateAt: 'enter', mutation: 'expire' });
  await replay('执行步骤间会话过期', { notices: true, challenge: true, mutateAt: 'open', mutation: 'expire' });
  await replay('执行步骤间会话串号', { notices: true, challenge: true, mutateAt: 'open', mutation: 'swap' });
  await replay('页面未跳转但服务端会话已失效', { notices: true, challenge: true, mutateAt: 'open', mutation: 'expire', silentExpired: true });
  await replay('验证完成时暗中串号且页面仍显示原账号', { notices: true, challenge: true, mutateAt: 'challenge', mutation: 'swap' });
  await replay('等待元素期间迟到的算术验证', { notices: true, challenge: true, challengeDelayMs: 3800 });

  console.log('\n全部通过：' + assertions + ' 项断言，' + scenarios + ' 个真实扩展回放场景');
} catch (error) {
  console.error(error);
  if (app) console.error(JSON.stringify(await readAppState(app).catch(() => null), null, 2));
  process.exitCode = 1;
} finally {
  await disposeContext(context, { app });
  await fixture.close();
}
