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

const root = resolve('output/learning-lottery-acceptance');
mkdirSync(root, { recursive: true });
const fixture = await startRuntimeFixture();
const origin = fixture.origin;
const siteId = 'lottery-fixture';
const accountId = 'lottery-target';
let context;
let app;
let assertions = 0;
function check(label, value, detail = '') {
  assert.ok(value, label + (detail ? ': ' + detail : ''));
  assertions += 1;
  console.log('PASS ' + label);
}
async function until(read, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await new Promise((done) => setTimeout(done, 150));
  }
  throw new Error('等待超时：' + label);
}
try {
  fixture.reset({ lotteryMode: true });
  const launched = await launchExtensionContext({
    chromium, profileDir: mkdtempSync(join(root, 'profile-')),
    extensionDir: resolve(process.env.EXTENSION_DIR || '.output/chrome-mv3'),
    headless: process.env.E2E_HEADLESS !== '0',
  });
  context = launched.context;
  app = await openExtensionPage(context, launched.extensionId);
  await seedAppStorage(app, {
    sites: [{
      id: siteId, name: '抽奖学习验收站', loginUrl: origin + '/lottery', loginMethod: 'form',
      selectors: { username: '#username', password: '#password', submit: '#login-submit' },
      successIndicator: '#logged-in', closeModalSelectors: [],
      checkin: { method: 'workflow', workflow: { steps: [{ type: 'leilei-daily' }] } },
      adapter: { family: 'new-api', siteType: 'new-api', quotaPerUnit: 500000, checkinPath: '/lottery' },
    }],
    accounts: [{ id: accountId, siteId, username: FIXTURE_SENTINEL_USERNAME, password: FIXTURE_SENTINEL_PASSWORD }],
  });
  await context.addCookies([{ name: 'fixture_user', value: FIXTURE_SENTINEL_USERNAME, url: origin, httpOnly: true, sameSite: 'Lax' }]);
  await app.reload();
  const pageEvent = context.waitForEvent('page');
  const started = await app.evaluate((id) => chrome.runtime.sendMessage({ type: 'TOGGLE_LEARNING', accountId: id, kind: 'both' }), accountId);
  check('已登录时开始融合学习', started.ok, JSON.stringify(started));
  const page = await pageEvent;
  await page.waitForURL(origin + '/lottery');
  await page.waitForSelector('[data-checkin-learning-guide]');
  const navigationOnly = await app.evaluate((id) => chrome.runtime.sendMessage({ type: 'TOGGLE_LEARNING', accountId: id, kind: 'both' }), accountId);
  console.log('只有导航的结束响应：' + JSON.stringify(navigationOnly));
  check('只有进入抽奖页不能宣称学完', navigationOnly.ok === false);
  check('只有导航不会把站点保存成登录即签到', (await readAppState(app)).sites.find((site) => site.id === siteId).checkin.method !== 'none');
  check('缺少动作时学习会话仍保留', await app.evaluate(async () => Object.values(await chrome.storage.session.get(null)).some((value) => value?.events)));
  await page.waitForFunction(() => document.querySelector('#draw')?.textContent === '开始抽奖' && !document.querySelector('#draw')?.disabled);
  await page.click('#draw');
  await page.waitForFunction(() => document.querySelector('#lottery-result')?.textContent === '抽奖成功');
  const finished = await app.evaluate((id) => chrome.runtime.sendMessage({ type: 'TOGGLE_LEARNING', accountId: id, kind: 'both' }), accountId);
  check('真正抽奖后能保存学习产物', finished.ok, JSON.stringify(finished));
  check('报告已录到抽奖结果', finished.feature?.learning?.report?.verdict === 'complete', JSON.stringify(finished.feature?.learning));
  const saved = (await readAppState(app)).sites.find((site) => site.id === siteId);
  console.log('保存的真实步骤：' + JSON.stringify(saved.checkin));
  check('保存的是工作流', saved.checkin.method === 'workflow');
  check('学到的步骤含抽奖点击', saved.checkin.workflow.steps.some((step) => step.type === 'click' && /draw/.test(step.selector)));
  check('真实学习动作替换了原模板执行器', !JSON.stringify(saved.checkin).includes('leilei-daily'));
  check('记录实际抽奖路线和身份页', saved.checkin.workflow.route.at(-1) === '/lottery' && saved.checkin.workflow.identityPath === '/lottery');
  check('站点流程不含演示账号密码', !JSON.stringify(saved).includes(FIXTURE_SENTINEL_USERNAME) && !JSON.stringify(saved).includes(FIXTURE_SENTINEL_PASSWORD));
  await app.evaluate((id) => {
    globalThis.__lotteryStatuses = [];
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.status) return;
      for (const [key, value] of Object.entries(changes.status.newValue || {})) {
        if (key.startsWith(id + ':')) globalThis.__lotteryStatuses.push(value);
      }
    });
  }, accountId);
  for (const [label, session] of [['正确账号直接抽奖', FIXTURE_SENTINEL_USERNAME], ['未登录自动登录再抽奖', null], ['错误账号换号再抽奖', FIXTURE_ALICE_USERNAME]]) {
    check(label + '：队列已空闲', !(await waitForQueueIdle(app)).queue.active);
    for (const tab of context.pages()) if (tab.url().startsWith(origin)) await tab.close();
    await context.clearCookies();
    if (session) await context.addCookies([{ name: 'fixture_user', value: session, url: origin, httpOnly: true, sameSite: 'Lax' }]);
    fixture.reset({ lotteryMode: true, loadingMs: 1800, drawResultDelayMs: 3200, notices: true, lotteryNoticeOnly: !session });
    await app.evaluate(async () => {
      globalThis.__lotteryStatuses = [];
      await chrome.storage.local.set({ status: {}, results: {} });
    });
    check(label + '：任务入队', (await startAccount(app, accountId)).ok);
    const state = await waitForAccountSettled(app, accountId, { timeoutMs: 120000 });
    const result = state.results[accountId];
    const events = fixture.events();
    console.log(JSON.stringify({ label, status: statusOf(state, accountId), result, events }, null, 2));
    check(label + '：完成', statusOf(state, accountId) === 'done', result?.message);
    check(label + '：全程没有转人工', !(await app.evaluate(() => globalThis.__lotteryStatuses)).includes('attention'));
    const draws = events.filter((event) => event.path === '/api/draw' && event.method === 'POST');
    check(label + '：只抽一次', draws.length === 1);
    check(label + '：只为目标账号抽奖', draws.every((event) => event.user === FIXTURE_SENTINEL_USERNAME));
    check(label + '：执行了学习点击', result?.steps?.some((step) => /工作流已点击.*draw/.test(step)));
    check(label + '：自动处理没有演示过的公告', events.some((event) => event.path === '/runtime/notice-closed'));
    const logins = events.filter((event) => event.path === '/session').length;
    check(label + '：登录行为符合身份状态', session === FIXTURE_SENTINEL_USERNAME ? logins === 0 : logins >= 1);
  }
  console.log('全部通过：' + assertions + ' 项断言，3 个真实扩展抽奖回放场景');
} catch (error) {
  console.error(error);
  if (app) console.error(JSON.stringify(await readAppState(app).catch(() => null), null, 2));
  process.exitCode = 1;
} finally {
  await disposeContext(context, { app });
  await fixture.close();
}
