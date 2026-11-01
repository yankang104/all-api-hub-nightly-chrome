/** 截图 Dashboard，肉眼验证 UI 与动画落地效果 */
import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXT = join(ROOT, '.output', 'chrome-mv3');
const SHOTS = join(ROOT, 'tests', 'shots');
const HEADLESS = process.env.E2E_HEADLESS === '1';
mkdirSync(SHOTS, { recursive: true });

const profile = mkdtempSync(join(tmpdir(), 'shot-'));
const clashConfigPath = join(profile, 'clash-verge.yaml');
writeFileSync(clashConfigPath, [
  'mixed-port: 7897',
  'proxies:',
  '- name: 日本01',
  '  type: vmess',
  '- name: 美国01',
  '  type: vless',
  '- name: 香港01',
  '  type: hysteria2',
  '- name: 日本02',
  '  type: vmess',
  '- name: 剩余流量：10 GB',
  '  type: hysteria2',
  'proxy-groups:',
  '- name: 自动选择',
  '  type: url-test',
  '  proxies:',
  '  - 日本01',
  'listeners:',
  '- name: listener-jp',
  '  type: mixed',
  '  port: 47901',
  '  listen: 127.0.0.1',
  '  proxy: 日本01',
  '- name: listener-us',
  '  type: socks5',
  '  port: 47902',
  '  listen: 127.0.0.1',
  '  proxy: 美国01',
  '- name: listener-hk',
  '  type: http',
  '  port: 47903',
  '  listen: 127.0.0.1',
  '  proxy: 香港01',
  '- name: listener-group',
  '  type: mixed',
  '  port: 47904',
  '  proxy: 自动选择',
  '- name: listener-stale',
  '  type: mixed',
  '  port: 47905',
  '  proxy: 已删除节点',
].join('\n'), 'utf8');
let ctx;
try {
  ctx = await chromium.launchPersistentContext(profile, {
    headless: HEADLESS,
    ...(HEADLESS ? { channel: 'chromium' } : {}),
    viewport: { width: 900, height: 820 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
} catch (error) {
  rmSync(profile, { recursive: true, force: true });
  throw error;
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? `  — ${detail}` : ''}`);
};

try {
  // Chrome 新版的 chrome://extensions shadow DOM 在 CDP 下可能不可读；
  // 先从 service worker 发现候选，再打开自家 options.html 验证，最后回退到旧 DOM 查询。
  let extId = null;
  const extensionProbe = await ctx.newPage();
  for (let round = 0; round < 12 && !extId; round += 1) {
    const ids = new Set(
      ctx.serviceWorkers?.()
        .filter((worker) => worker.url().startsWith('chrome-extension://'))
        .map((worker) => new URL(worker.url()).hostname) ?? [],
    );
    for (const id of ids) {
      const valid = await extensionProbe
        .goto(`chrome-extension://${id}/options.html`, { timeout: 5000 })
        .then(() => extensionProbe.evaluate(() => document.title))
        .then((title) => title.includes('签到') || title.includes('中转'))
        .catch(() => false);
      if (valid) {
        extId = id;
        break;
      }
    }
    if (!extId) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await extensionProbe.close().catch(() => {});

  if (!extId) {
    const probe = await ctx.newPage();
    await probe.goto('chrome://extensions');
    await probe.waitForTimeout(1500);
    extId = await probe.evaluate(() => {
      const mgr = document.querySelector('extensions-manager');
      const items =
        mgr?.shadowRoot?.querySelector('extensions-item-list')?.shadowRoot?.querySelectorAll('extensions-item') ?? [];
      return items[0]?.id ?? null;
    });
    await probe.close();
  }
  if (!extId) throw new Error('扩展未加载');

  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/options.html`);

  // 1. 空状态
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(SHOTS, '1-empty.png') });
  console.log('1-empty.png  空状态');
  const launchModes = page.getByRole('radiogroup', { name: '扩展打开方式' });
  const sidepanelMode = launchModes.getByRole('radio', { name: '侧边栏模式' });
  const tabMode = launchModes.getByRole('radio', { name: '独立页模式' });
  check('默认使用侧边栏模式', (await sidepanelMode.getAttribute('aria-checked')) === 'true');
  check(
    '默认工具栏点击行为绑定 Side Panel',
    (await page.evaluate(async () => (await chrome.sidePanel.getPanelBehavior()).openPanelOnActionClick)) === true,
  );
  await tabMode.click();
  check('独立页面选项点击后立即更新视觉状态', (await tabMode.getAttribute('aria-checked')) === 'true');
  await page.waitForTimeout(250);
  check('独立页面开关可开启', (await page.evaluate(async () => (await chrome.storage.local.get('launchMode')).launchMode)) === 'tab');
  check(
    '开启后工具栏不再自动打开 Side Panel',
    (await page.evaluate(async () => (await chrome.sidePanel.getPanelBehavior()).openPanelOnActionClick)) === false,
  );
  await sidepanelMode.click();
  check('侧边栏选项点击后立即更新视觉状态', (await sidepanelMode.getAttribute('aria-checked')) === 'true');
  await page.waitForTimeout(250);
  check('独立页面开关可关闭', (await page.evaluate(async () => (await chrome.storage.local.get('launchMode')).launchMode)) === 'sidepanel');
  check(
    '关闭后工具栏重新绑定 Side Panel',
    (await page.evaluate(async () => (await chrome.sidePanel.getPanelBehavior()).openPanelOnActionClick)) === true,
  );
  await tabMode.click();
  await page.waitForFunction(() => document.querySelector('[role="radiogroup"][aria-busy="false"]') !== null);
  await sidepanelMode.click();
  await page.waitForFunction(() => document.querySelector('[role="radiogroup"][aria-busy="false"]') !== null);
  check('连续切换后立即保留最后选择', (await sidepanelMode.getAttribute('aria-checked')) === 'true');
  await page.waitForTimeout(250);
  check(
    '快速双击后后台行为以最后选择为准',
    (await page.evaluate(async () => {
      const mode = (await chrome.storage.local.get('launchMode')).launchMode;
      const behavior = await chrome.sidePanel.getPanelBehavior();
      return mode === 'sidepanel' && behavior.openPanelOnActionClick === true;
    })) === true,
  );

  // 1b. 后台定时签到计划
  await page.getByRole('button', { name: '定时签到' }).click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(SHOTS, '1-schedule.png') });
  console.log('1-schedule.png  定时签到计划');
  check('定时面板显示时间与星期控件', (await page.textContent('body')).includes('执行时间') && (await page.getByRole('button', { name: '星期一' }).count()) === 1);
  await page.locator('input[type="time"]').fill('08:30');
  await page.getByRole('button', { name: '星期六' }).click();
  await page.locator('input[type="checkbox"]').check({ force: true });
  await page.getByRole('button', { name: '保存计划' }).click();
  await page.waitForTimeout(450);
  const scheduleState = await page.evaluate(async () => {
    const { checkinSchedule } = await chrome.storage.local.get('checkinSchedule');
    const alarm = await chrome.alarms.get('checkin-schedule');
    return { checkinSchedule, hasAlarm: Boolean(alarm?.scheduledTime) };
  });
  check(
    '定时计划保存并创建后台闹钟',
    scheduleState.checkinSchedule?.enabled === true
      && scheduleState.checkinSchedule?.time === '08:30'
      && scheduleState.checkinSchedule?.weekdays.includes(6)
      && scheduleState.hasAlarm,
  );
  check('控制台显示已启用的执行时间', (await page.getByRole('button', { name: /定时 08:30/ }).count()) === 1);
  await page.getByRole('button', { name: /定时 08:30/ }).click();
  await page.locator('label[title="关闭定时签到"]').click({ force: true });
  await page.getByRole('button', { name: '保存计划' }).click();
  await page.waitForTimeout(350);
  const disabledSchedule = await page.evaluate(async () => {
    const { checkinSchedule } = await chrome.storage.local.get('checkinSchedule');
    return { checkinSchedule, alarm: await chrome.alarms.get('checkin-schedule') };
  });
  check('关闭定时计划会清理后台闹钟', disabledSchedule.checkinSchedule?.enabled === false && !disabledSchedule.alarm);
  await page.evaluate(async () => {
    if (chrome.sidePanel?.close) {
      await chrome.sidePanel.close({ windowId: chrome.windows.WINDOW_ID_CURRENT }).catch(() => {});
    }
  });
  await page.waitForTimeout(2550);

  // 2. 造数据：两个站点、五个账号、五种状态
  await page.evaluate(async () => {
    const mk = (id, name, host, checkin) => ({
      id,
      name,
      loginUrl: `https://${host}/login`,
      selectors: { username: 'input[name="username"]', password: 'input[type="password"]', submit: 'button[type="submit"]' },
      closeModalSelectors: ['.ant-modal-close'],
      checkin,
    });
    const d = new Date();
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const balanceDay = (daysAgo, hour) => {
      const value = new Date();
      value.setDate(value.getDate() - daysAgo);
      value.setHours(hour, 0, 0, 0);
      return {
        key: `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`,
        at: value.getTime(),
      };
    };
    const fourDaysAgo = balanceDay(4, 18);
    const dayBeforeYesterday = balanceDay(2, 18);
    const yesterdayFirst = balanceDay(1, 9);
    const yesterdayLatest = balanceDay(1, 18);
    const todayFirst = balanceDay(0, 9);
    const todayLatest = balanceDay(0, 18);
    await chrome.storage.local.set({
      sites: [
        mk('s1', 'OneAPI 中转站', 'api.oneapi.pro', { method: 'api', apiUrl: '/api/user/check_in' }),
        mk('s2', 'NewAPI 聚合', 'new-api.example.com', { method: 'button', buttonSelector: '.checkin-btn' }),
      ],
      accounts: [
        { id: 'a1', siteId: 's1', username: 'zhangsan@mail.com', label: '主号', password: 'x' },
        { id: 'a2', siteId: 's1', username: 'lisi@mail.com', label: '小号', password: 'x' },
        { id: 'a3', siteId: 's2', username: 'wangwu@mail.com', password: 'x' },
        { id: 'a4', siteId: 's2', username: 'zhaoliu@mail.com', label: '备用', password: 'x' },
        { id: 'a5', siteId: 's2', username: 'manual@mail.com', label: '需验证', password: 'x' },
      ],
      proxies: [],
      status: { [`a1:${key}`]: 'done', [`a3:${key}`]: 'failed', [`a4:${key}`]: 'running', [`a5:${key}`]: 'attention' },
      results: {
        a1: {
          accountId: 'a1',
          ok: true,
          message: '接口返回签到成功',
          at: Date.now() - 60_000,
          steps: ['关闭了 1 个公告/弹窗', '已填写用户名', '已填写密码', '登录成功', '请求签到接口 POST /api/user/check_in', '接口返回 200: 签到成功'],
        },
        a3: {
          accountId: 'a3',
          ok: false,
          message: '提交后仍停留在登录页，可能凭据有误或需验证码',
          at: Date.now() - 120_000,
          steps: ['关闭了 2 个公告/弹窗', '已填写用户名', '已填写密码', '已点击登录按钮', '跳转后检测到登录表单仍存在'],
        },
        a5: {
          accountId: 'a5',
          ok: false,
          message: 'Cloudflare需要你在当前标签页完成验证',
          at: Date.now() - 30_000,
          steps: ['检测到Cloudflare，等待浏览器完成安全验证'],
        },
      },
      balances: {
        a3: {
          quota: 122,
          usedQuota: 10,
          at: todayLatest.at,
          source: 'api',
          checkinReward: 15,
          checkinRewardDay: todayLatest.key,
          checkinRewardAt: todayLatest.at,
          daily: {
            [fourDaysAgo.key]: {
              first: { quota: 90, usedQuota: 10, at: fourDaysAgo.at, source: 'api' },
              latest: { quota: 90, usedQuota: 10, at: fourDaysAgo.at, source: 'api' },
            },
            [dayBeforeYesterday.key]: {
              first: { quota: 100, usedQuota: 10, at: dayBeforeYesterday.at, source: 'api' },
              latest: { quota: 100, usedQuota: 10, at: dayBeforeYesterday.at, source: 'api' },
            },
            [yesterdayFirst.key]: {
              first: { quota: 102, usedQuota: 10, at: yesterdayFirst.at, source: 'visible' },
              latest: { quota: 107, usedQuota: 10, at: yesterdayLatest.at, source: 'visible' },
            },
            [todayFirst.key]: {
              first: { quota: 107, usedQuota: 10, at: todayFirst.at, source: 'api' },
              latest: { quota: 122, usedQuota: 10, at: todayLatest.at, source: 'api' },
              checkinReward: 15,
              checkinRewardAt: todayLatest.at,
            },
          },
        },
      },
    });
    await chrome.storage.session.set({
      'task:417': {
        tabId: 417,
        runId: 'ui-live-a4',
        accountId: 'a4',
        siteId: 's2',
        createdAt: Date.now() - 19_000,
        stage: 'checkin',
        steps: [
          '已打开站点登录页',
          '已填写用户名',
          '已填写密码',
          '登录成功，正在读取签到前状态',
          '已打开签到页',
          '正在点击立即签到并等待站点确认',
        ],
      },
      checkinQueue: {
        active: { accountId: 'a4', tabId: 417, startedAt: Date.now() - 19_000 },
        pendingAccountIds: ['a2', 'a5'],
      },
    });
  });
  await page.reload();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(SHOTS, '2-dashboard.png') });
  console.log('2-dashboard.png  多站点多账号 + 实时执行台 + 五种状态');
  const liveConsole = page.locator('.live-console');
  check('实时执行台显示当前阶段', await liveConsole.getByText('正在签到', { exact: true }).isVisible());
  check('实时执行台按顺序显示全部步骤', (await liveConsole.locator('ol > li').count()) === 6);
  check(
    '实时执行台高亮最新步骤',
    (await liveConsole.locator('ol > li').last().textContent())?.includes('正在点击立即签到') === true,
  );
  check('接力队列显示排队账号', (await liveConsole.textContent())?.includes('小号') === true);
  check('运行账号自动展开详情', (await page.locator('button[title="收起账号详情"]').count()) >= 1);

  // 2a. 账号列表默认收起，可按站点单独展开；执行中与搜索命中的站点强制展开
  check('默认收起站点账号', await page.locator('[data-account-id="a1"]').isHidden() && await page.locator('[data-account-id="a2"]').isHidden());
  const collapseToggle = page.getByRole('button', { name: '展开账号 OneAPI 中转站' });
  check('展开开关带文字说明账号数', (await collapseToggle.textContent())?.trim() === '展开 2 个账号', await collapseToggle.textContent());
  check('站点排序按钮与展开开关不再同形', (await page.locator('button[title="上移站点"] svg.lucide-arrow-up').count()) >= 1 && (await page.locator('button[title="下移站点"] svg.lucide-arrow-down').count()) >= 1);
  check('执行中站点保持展开', await page.locator('[data-account-id="a4"]').isVisible() && await page.locator('[data-account-id="a3"]').isVisible());
  check('执行中站点不提供收起入口', await page.getByRole('button', { name: '收起账号 NewAPI 聚合' }).isDisabled());
  await page.getByRole('button', { name: '展开账号 OneAPI 中转站' }).click();
  await page.waitForTimeout(700);
  check('展开站点后显示本站账号', await page.locator('[data-account-id="a1"]').isVisible() && await page.locator('[data-account-id="a2"]').isVisible());
  await page.getByRole('button', { name: '收起账号 OneAPI 中转站' }).click();
  await page.waitForTimeout(700);
  check('再次收起隐藏本站账号', await page.locator('[data-account-id="a1"]').isHidden());
  await page.getByLabel('搜索站点、账号或备注').fill('主号');
  await page.waitForTimeout(700);
  check('搜索命中账号时强制展开', await page.locator('[data-account-id="a1"]').isVisible());
  await page.getByRole('button', { name: '清空搜索' }).click();
  await page.waitForTimeout(700);
  check('清空搜索后恢复收起状态', await page.locator('[data-account-id="a1"]').isHidden());

  // 2b. 定时计划按站点/账号筛选：旧配置仍为全选，新配置保存白名单
  await page.getByRole('button', { name: '定时签到' }).click();
  await page.waitForTimeout(300);
  const scheduleBody = await page.textContent('body');
  check('定时面板显示全部站点账号', ['主号', '小号', 'wangwu@mail.com', '备用', '需验证'].every((name) => scheduleBody.includes(name)));
  check('定时面板按站点分组', (await page.getByRole('button', { name: '选择站点 OneAPI 中转站' }).count()) === 1 && (await page.getByRole('button', { name: '选择站点 NewAPI 聚合' }).count()) === 1);
  await page.getByRole('button', { name: '清空账号' }).click();
  check('清空后不再选择账号', (await page.textContent('body')).includes('未选择账号'));
  await page.getByRole('button', { name: '选择站点 OneAPI 中转站' }).click();
  check('按站点可一次选中站内账号', (await page.textContent('body')).includes('已选 2 个账号'));
  await page.locator('label[title="开启定时签到"]').click({ force: true });
  await page.getByRole('button', { name: '保存计划' }).click();
  await page.waitForTimeout(400);
  const scopedSchedule = await page.evaluate(async () => {
    const { checkinSchedule } = await chrome.storage.local.get('checkinSchedule');
    return checkinSchedule;
  });
  check('定时计划只保存选中账号 ID', scopedSchedule.enabled === true && Array.isArray(scopedSchedule.accountIds) && scopedSchedule.accountIds.join(',') === 'a1,a2');
  await page.getByRole('button', { name: /定时 08:30/ }).click();
  await page.getByRole('button', { name: '全选账号' }).click();
  await page.getByRole('button', { name: '保存计划' }).click();
  await page.waitForTimeout(350);
  const allSchedule = await page.evaluate(async () => {
    const { checkinSchedule } = await chrome.storage.local.get('checkinSchedule');
    return checkinSchedule;
  });
  check('全选恢复旧版的全部账号语义', allSchedule.enabled === true && !Object.prototype.hasOwnProperty.call(allSchedule, 'accountIds'));
  await page.getByRole('button', { name: /定时 08:30/ }).click();
  await page.locator('label[title="关闭定时签到"]').click({ force: true });
  await page.getByRole('button', { name: '保存计划' }).click();
  await page.waitForTimeout(350);

  // 3. 展开失败账号的执行详情
  const failedAccountRow = page.locator('[data-account-id="a3"]');
  await failedAccountRow.locator('button[title="查看账号详情"]').click();
  await failedAccountRow.evaluate((row) => row.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(SHOTS, '3-detail.png') });
  console.log('3-detail.png  余额日期台账、失败原因与执行步骤');
  const detailText = await failedAccountRow.textContent();
  check('执行详情可展开并显示失败原因', detailText.includes('跳转后检测到登录表单仍存在'));
  check(
    '余额详情显示相对日期、来源与差额',
    ['余额记录', '今天', '昨天', '前天', 'API', '页面', '当天'].every((value) => detailText.includes(value)),
    detailText,
  );
  check('余额详情显示明确签到奖励', detailText.includes('奖励'));

  await page.setViewportSize({ width: 420, height: 820 });
  await failedAccountRow.evaluate((row) => row.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(450);
  await failedAccountRow.locator('[aria-label="余额历史"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(SHOTS, '3-balance-history-mobile.png') });
  console.log('3-balance-history-mobile.png  窄宽余额日期台账');
  const balanceHistoryFits = await failedAccountRow.evaluate((row) => {
    const historyRows = [...row.querySelectorAll('[data-balance-day]')];
    return row.scrollWidth <= row.clientWidth + 1
      && historyRows.every((item) => item.scrollWidth <= item.clientWidth + 1);
  });
  check('窄宽余额详情没有横向溢出', balanceHistoryFits);
  await page.setViewportSize({ width: 900, height: 820 });
  await page.waitForTimeout(300);

  // 4. 创建真实浏览器书签树，并从与 Chrome 一致的目录结构导入
  const bookmarkRootTitle = await page.evaluate(async () => {
    const root = (await chrome.bookmarks.get('1'))[0];
    const folder = await chrome.bookmarks.create({ parentId: '1', title: '签到站点' });
    await chrome.bookmarks.create({ parentId: folder.id, title: '书签站甲', url: 'https://bookmark-a.example.com/login' });
    await chrome.bookmarks.create({ parentId: folder.id, title: '书签站乙', url: 'https://bookmark-b.example.com/login' });
    return root.title;
  });
  await page.getByRole('button', { name: '从书签导入' }).click();
  await page.waitForTimeout(800);
  await page.getByRole('button').filter({ hasText: bookmarkRootTitle }).first().click();
  await page.waitForTimeout(250);
  await page.getByRole('button').filter({ hasText: '签到站点' }).first().click();
  await page.waitForTimeout(450);
  await page.screenshot({ path: join(SHOTS, '4-bookmark-page.png') });
  console.log('4-bookmark-page.png  Chrome 书签目录与可选书签');
  check('浏览器书签页显示文件夹内链接', (await page.textContent('body')).includes('书签站甲') && (await page.textContent('body')).includes('书签站乙'));
  await page.getByRole('button', { name: /选择当前列表/ }).click();
  await page.getByRole('button', { name: /导入选中站点 \(2\)/ }).click();
  await page.waitForTimeout(900);
  check('浏览器书签可选择并批量导入', (await page.textContent('body')).includes('书签站甲') && (await page.textContent('body')).includes('书签站乙'));

  // 5. 文件书签导入入口与手动站点配置仍可并存
  await page.getByRole('button', { name: '从书签导入' }).click();
  await page.waitForTimeout(600);
  await page.locator('input[type="file"]').setInputFiles(join(ROOT, 'tests', 'e2e', 'fixture', 'bookmarks.html'));
  await page.waitForTimeout(500);
  check('Chrome 导出的书签文件可读取', (await page.textContent('body')).includes('bookmarks.html'));
  await page.getByRole('heading', { name: '从书签导入站点' }).locator('..').getByRole('button').click();
  await page.getByRole('button', { name: '添加站点' }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(SHOTS, '5-site-modal.png') });
  console.log('5-site-modal.png  浏览器/文件书签导入 + 手动配置');
  const modalText = await page.textContent('body');
  check('七种签到方式都可选', ['自动识别', '登录即签到', '点签到按钮', '请求签到接口', '退出再登录', '领取权益', '自定义工作流'].every((t) => modalText.includes(t)));

  // 6. 选「接口签到」后展开参数
  await page.getByRole('button', { name: /请求签到接口/ }).click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(SHOTS, '6-api-fields.png') });
  console.log('6-api-fields.png  接口签到参数');
  check('选择接口方式后出现接口地址字段', (await page.textContent('body')).includes('签到接口地址'));

  // 7. 批量选择一个站点和一个独立账号，确认关联记录会同步删除
  await page.evaluate(async () => {
    await chrome.storage.local.set({ checkinSchedule: { enabled: false, time: '08:30', weekdays: [1, 2, 3, 4, 5], accountIds: ['a1', 'a2', 'a3'] } });
  });
  await page.reload();
  await page.waitForTimeout(700);
  await page.mouse.click(880, 800); // 点弹层外关闭
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: '批量删除' }).click();
  await page.getByRole('button', { name: '选择站点 书签站甲' }).click();
  await page.getByRole('button', { name: '选择账号 小号' }).click();
  await page.waitForTimeout(450);
  await page.screenshot({ path: join(SHOTS, '7-bulk-select.png') });
  console.log('7-bulk-select.png  站点与账号批量选择工具条');
  check('批量工具条显示站点与账号计数', (await page.textContent('body')).includes('1 个站点 · 1 个账号'));
  await page.getByRole('button', { name: '删除选中' }).click();
  check('批量删除有二次确认', (await page.textContent('body')).includes('确认删除所选项目'));
  await page.getByRole('button', { name: '确认删除' }).click();
  await page.waitForTimeout(800);
  const deletionState = await page.evaluate(async () => {
    const { sites = [], accounts = [], status = {}, results = {}, checkinSchedule } = await chrome.storage.local.get(['sites', 'accounts', 'status', 'results', 'checkinSchedule']);
    return {
      hasSite: sites.some((site) => site.name === '书签站甲'),
      hasAccount: accounts.some((account) => account.id === 'a2'),
      hasStatus: Object.keys(status).some((key) => key.startsWith('a2:')),
      hasResult: Boolean(results.a2),
      scheduleAccountIds: checkinSchedule?.accountIds,
    };
  });
  check('批量删除同步清理关联数据', !deletionState.hasSite && !deletionState.hasAccount && !deletionState.hasStatus && !deletionState.hasResult);
  check('批量删除同步清理定时账号范围', deletionState.scheduleAccountIds?.join(',') === 'a1,a3');

  // 8. Chrome 密码 CSV：只自动选择唯一域名匹配项
  await page.getByRole('button', { name: '导入账号' }).click();
  await page.locator('input[type="file"][accept*=".csv"]').setInputFiles(join(ROOT, 'tests', 'e2e', 'fixture', 'chrome-passwords.csv'));
  await page.waitForTimeout(650);
  await page.screenshot({ path: join(SHOTS, '8-password-match.png') });
  console.log('8-password-match.png  Chrome 密码严格匹配预览');
  const passwordPreview = await page.textContent('body');
  check('密码 CSV 仅自动选择唯一匹配项', passwordPreview.includes('已选择 2 个账号'));
  check('未匹配、已有、重复和无效记录被标记', ['未匹配', '已存在', '同账号多条', '无效'].every((label) => passwordPreview.includes(label)));
  check('匹配预览不显示密码', !passwordPreview.includes('test,pw-1') && !passwordPreview.includes('new-value-must-not-overwrite'));
  await page.getByRole('button', { name: '导入匹配账号 (2)' }).click();
  await page.waitForTimeout(800);
  const passwordImportState = await page.evaluate(async () => {
    const { accounts = [] } = await chrome.storage.local.get('accounts');
    return {
      matchedOne: accounts.filter((account) => account.siteId === 's1' && account.username === 'csv-one@example.com').length,
      matchedTwo: accounts.filter((account) => account.siteId === 's2' && account.username === 'csv-new@example.com').length,
      unmatched: accounts.some((account) => account.username === 'unmatched@example.com'),
      invalid: accounts.some((account) => account.username === 'invalid@example.com'),
      existingCount: accounts.filter((account) => account.siteId === 's1' && account.username === 'zhangsan@mail.com').length,
      existingUnchanged: accounts.some((account) => account.siteId === 's1' && account.username === 'zhangsan@mail.com' && account.password === 'x'),
    };
  });
  check(
    '仅写入匹配账号且不覆盖现有密码',
    passwordImportState.matchedOne === 1 &&
      passwordImportState.matchedTwo === 1 &&
      !passwordImportState.unmatched &&
      !passwordImportState.invalid &&
      passwordImportState.existingCount === 1 &&
      passwordImportState.existingUnchanged,
  );
  await page.evaluate(async () => {
    const { accounts = [], proxies = [] } = await chrome.storage.local.get(['accounts', 'proxies']);
    await chrome.storage.local.set({
      accounts: accounts.filter((account) => !['csv-one@example.com', 'csv-new@example.com'].includes(account.username)),
      proxies: proxies.concat({
        id: 'px-stale-name-only',
        name: '旧订阅未配置节点',
        scheme: 'http',
        host: '-',
        port: 0,
        nameOnly: true,
      }),
    });
  });
  await page.reload();
  await page.waitForTimeout(700);

  // 8a. 代理管理：同步 Clash listeners → 真实出口 → 账号固定绑定
  check('顶栏不把旧名称条目计入出口数', (await page.getByRole('button', { name: '代理', exact: true }).count()) === 1);
  await page.getByRole('button', { name: /^代理/ }).click();
  await page.waitForTimeout(400);
  check(
    '代理管理只保留真实出口与账号绑定两个页签',
    (await page.getByRole('button', { name: '全部节点', exact: true }).count()) === 1
      && (await page.getByRole('button', { name: '账号绑定', exact: true }).count()) === 1,
  );
  check(
    '旧 Controller、订阅与端口扫描入口已移除',
    (await page.getByLabel('Clash controller 地址').count()) === 0
      && (await page.getByLabel('订阅地址').count()) === 0
      && (await page.getByLabel('起始端口').count()) === 0
      && (await page.getByRole('button', { name: '导入节点', exact: true }).count()) === 0,
  );
  check('同步配置入口使用 Clash Verge 配置文件', (await page.getByLabel('选择 Clash Verge 配置文件').count()) === 1);

  const firstConfigChooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '同步节点', exact: true }).click();
  await (await firstConfigChooser).setFiles(clashConfigPath);
  await page.waitForFunction(() => document.body.innerText.includes('真实节点 4') && document.body.innerText.includes('可绑定 3/4'));

  const importedPool = await page.evaluate(async () => {
    const { proxies = [] } = await chrome.storage.local.get('proxies');
    return proxies.map((proxy) => ({
      name: proxy.name,
      endpoint: `${proxy.scheme}://${proxy.host}:${proxy.port}`,
      nameOnly: proxy.nameOnly === true,
      sourceLabel: proxy.sourceLabel,
    }));
  });
  const importedExits = importedPool.filter((proxy) => !proxy.nameOnly);
  check(
    'Clash listeners 全部导入为浏览器真实出口',
    importedExits.length === 3
      && importedExits.map((proxy) => proxy.name).join(',') === '日本01,美国01,香港01'
      && importedExits.map((proxy) => proxy.endpoint).join(',') === 'http://127.0.0.1:47901,socks5://127.0.0.1:47902,http://127.0.0.1:47903'
      && importedExits.every((proxy) => proxy.sourceLabel === 'Clash Verge'),
    JSON.stringify(importedPool),
  );
  const proxyModal = page.getByRole('heading', { name: '代理管理' }).locator('..').locator('..');
  const proxyModalText = await proxyModal.textContent();
  check('旧名称条目不出现在 Clash 节点列表', !proxyModalText.includes('旧订阅未配置节点'));
  check('同步结果区分真实节点、固定出口与缺少 listener', proxyModalText.includes('真实节点 4')
    && proxyModalText.includes('可绑定 3/4')
    && proxyModalText.includes('缺 listener 1')
    && proxyModalText.includes('无固定端口：日本02'));
  check('策略组和失效 listener 不进入固定节点池', !proxyModalText.includes('自动选择') && !proxyModalText.includes('已删除节点'));
  check('同步后顶栏统计全部 Clash 真实节点', (await page.getByRole('button', { name: '代理 (4)', exact: true }).count()) === 1);
  check('真实出口列表显示节点名、协议和端口', ['日本01', '美国01', '香港01', 'http://127.0.0.1:47901', 'socks5://127.0.0.1:47902'].every((text) => proxyModalText.includes(text)));
  check('同步后分别统计 4 个 Clash 节点和 3 个固定出口', (await page.getByText('Clash 节点', { exact: true }).locator('..').textContent()).includes('4')
    && (await page.getByText('固定出口', { exact: true }).locator('..').textContent()).includes('3'));
  check('无 listener 节点仍显示但明确不可绑定', proxyModalText.includes('日本02') && proxyModalText.includes('无固定 listener，暂不能绑定'));
  check('固定出口页提供独立全部测活入口', (await page.getByRole('button', { name: '全部测活', exact: true }).count()) === 1
    && (await page.getByText('本次测活', { exact: true }).locator('..').textContent()).includes('--'));

  await page.getByLabel('搜索代理出口').fill('美国');
  await page.waitForTimeout(700);
  const visibleProxyTitles = await page.locator('span[title]').evaluateAll((nodes) => nodes
    .filter((node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    })
    .map((node) => node.getAttribute('title')));
  check('真实出口可按节点名搜索', visibleProxyTitles.includes('美国01')
    && !visibleProxyTitles.includes('日本01')
    && !visibleProxyTitles.includes('香港01'), visibleProxyTitles.join(','));
  await page.getByLabel('搜索代理出口').fill('');
  await page.waitForTimeout(250);

  await page.screenshot({ path: join(SHOTS, '11-real-exits.png') });
  console.log('11-real-exits.png  Clash Verge 真实出口同步与列表');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(SHOTS, '11-real-exits-mobile.png') });
  const realExitsMobile = await page.evaluate(() => ({
    viewport: window.innerWidth,
    pageWidth: document.documentElement.scrollWidth,
  }));
  check('真实出口管理在窄宽无横向溢出', realExitsMobile.pageWidth <= realExitsMobile.viewport + 1);
  await page.setViewportSize({ width: 900, height: 820 });

  // 重复同步同一份配置只报告已存在，不制造重复出口。
  const repeatConfigChooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '同步节点', exact: true }).click();
  await (await repeatConfigChooser).setFiles(clashConfigPath);
  await page.waitForFunction(() => document.body.innerText.includes('真实节点 4') && document.body.innerText.includes('可绑定 3/4'));
  check('重复同步 Clash 配置不产生重复出口', (await page.evaluate(async () => {
    const { proxies = [] } = await chrome.storage.local.get('proxies');
    return proxies.filter((proxy) => !proxy.nameOnly).length === 3 && proxies.filter((proxy) => proxy.nameOnly).length === 2;
  })));

  await page.getByRole('button', { name: '账号绑定', exact: true }).click();
  const assignPanel = await page.textContent('body');
  check('批量分配面板显示真实出口与账号规模', /已配置出口 3 个 · 共 4 个账号/.test(assignPanel));
  check('批量分配面板说明固定绑定策略', assignPanel.includes('一账号一节点固定绑定'));

  // 仪表盘造的数据里签到队列是「忙」的，而 TEST_PROXY 在队列占用网络配置时
  // 会立刻拒绝 —— 那样测活瞬间跑完，进度根本来不及显示。先摘掉队列快照，
  // 让测活真的走一遍 chrome.proxy，测完再放回去（后面侧栏断言还要用）。
  const queueSnapshot = await page.evaluate(async () => {
    const { checkinQueue } = await chrome.storage.session.get('checkinQueue');
    await chrome.storage.session.remove('checkinQueue');
    return checkinQueue ?? null;
  });

  await page.getByRole('button', { name: '测活并分配' }).click();
  // fixture 的高位本机端口在测试环境里没有真代理，测活必然全不通 ——
  // 正好用来验证「全不通就不写绑定」这条保护，而不是把死节点分配下去。
  await page.waitForFunction(
    () => document.body.innerText.includes('全部不通，没有写入任何绑定'),
    null,
    { timeout: 60_000 },
  );
  const deadPoolState = await page.evaluate(async (snapshot) => {
    if (snapshot) await chrome.storage.session.set({ checkinQueue: snapshot });
    const { accounts = [] } = await chrome.storage.local.get('accounts');
    return {
      body: document.body.innerText,
      pooled: accounts.filter((account) => account.proxyMode === 'pool').length,
    };
  }, queueSnapshot);
  check('节点全不通时不写入任何绑定', deadPoolState.pooled === 0);
  check('节点全不通时明确告知', deadPoolState.body.includes('全部不通，没有写入任何绑定'));

  // 绕过真实网络，直接验证分配、拒绝悬空引用与删除后的解绑。
  const assignOutcome = await page.evaluate(async () => {
    const { proxies = [] } = await chrome.storage.local.get('proxies');
    const ids = proxies.filter((proxy) => !proxy.nameOnly).map((proxy) => proxy.id);
    const { accounts = [] } = await chrome.storage.local.get('accounts');
    const targets = accounts.slice(0, 3).map((account) => account.id);
    const assignments = targets.map((accountId, index) => ({ accountId, proxyId: ids[index % ids.length] }));

    const applied = await chrome.runtime.sendMessage({
      type: 'MUTATE_APP',
      mutation: { action: 'assign-account-proxies', assignments },
    });
    const rejected = await chrome.runtime.sendMessage({
      type: 'MUTATE_APP',
      mutation: { action: 'assign-account-proxies', assignments: [{ accountId: targets[0], proxyId: 'px-does-not-exist' }] },
    });
    const { accounts: afterAssign = [] } = await chrome.storage.local.get('accounts');

    await chrome.runtime.sendMessage({
      type: 'MUTATE_APP',
      mutation: { action: 'remove-proxy', proxyId: ids[0] },
    });
    const { accounts: afterRemoval = [] } = await chrome.storage.local.get('accounts');

    const readBinding = (list, accountId) => {
      const account = list.find((item) => item.id === accountId);
      return { mode: account?.proxyMode, proxyId: account?.proxyId };
    };

    return {
      assigned: applied?.assigned,
      rejectedAssigned: rejected?.assigned,
      rotation: targets.map((accountId) => readBinding(afterAssign, accountId).proxyId),
      expectedRotation: assignments.map((item) => item.proxyId),
      firstAfterRemoval: readBinding(afterRemoval, targets[0]),
    };
  });
  check('批量分配按账号写入绑定', assignOutcome.assigned === 3);
  check('轮转分配的节点对应关系正确', assignOutcome.rotation.join(',') === assignOutcome.expectedRotation.join(','));
  check('拒绝写入池外节点，避免造出悬空引用', assignOutcome.rejectedAssigned === 0);
  check(
    '删除被绑定的节点后账号回落直连且不留悬空 proxyId',
    assignOutcome.firstAfterRemoval.mode === 'inherit' && assignOutcome.firstAfterRemoval.proxyId === undefined,
    JSON.stringify(assignOutcome.firstAfterRemoval),
  );
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(SHOTS, '12-proxy-bindings.png') });
  console.log('12-proxy-bindings.png  真实出口账号绑定');

  // 对照表：手动改过的行不被自动分配覆盖，没手动的由自动填。
  const assignTableBody = await page.textContent('body');
  check('对照表列出账号与真实出口规模', /4 个账号 · 已配置出口 2 个/.test(assignTableBody), assignTableBody.includes('个账号 · 已配置出口') ? '' : '未出现对照表');
  check('未绑定的行标记为自动填入', /\d+ 个待自动填入/.test(assignTableBody));

  // 手动给「主号」指定一个出口，其余行留给自动。
  const poolOptions = await page.evaluate(async () => {
    const { proxies = [] } = await chrome.storage.local.get('proxies');
    return proxies.filter((proxy) => !proxy.nameOnly).map((proxy) => ({ id: proxy.id, name: proxy.name }));
  });
  // 标签带站点名：同一邮箱在多个站点各有账号时，只按账号名定位会撞车
  check('对照表按站点分段显示', (await page.textContent('body')).includes('OneAPI 中转站'));
  const mainProxySelect = page.getByLabel(/为 .+ 的 主号 选择节点/);
  const currentMainProxy = await mainProxySelect.inputValue();
  const manualPick = poolOptions.find((proxy) => proxy.id !== currentMainProxy) ?? poolOptions[0];
  await mainProxySelect.selectOption(manualPick.id);
  await page.waitForTimeout(250);
  check('手动改动后出现撤销入口', await page.getByRole('button', { name: '撤销改动' }).isVisible());

  await page.getByRole('button', { name: '保存手动分配' }).click();
  await page.waitForTimeout(900);
  const savedAssign = await page.evaluate(async () => {
    const { accounts = [] } = await chrome.storage.local.get('accounts');
    const main = accounts.find((account) => (account.label || account.username) === '主号');
    // 其余账号都是自动填的：不写死某个 label，前面的批量删除动过账号表
    const others = accounts.filter((account) => account.id !== main?.id);
    return {
      manual: { proxyId: main?.proxyId, pinned: main?.proxyPinned },
      autoBound: others.filter((account) => account.proxyMode === 'pool' && account.proxyId).length,
      autoPinned: others.filter((account) => account.proxyPinned === true).length,
      othersTotal: others.length,
      body: document.body.innerText,
    };
  });
  check('手动指定的行写入并标记固定', savedAssign.manual.proxyId === manualPick.id && savedAssign.manual.pinned === true, JSON.stringify(savedAssign.manual));
  check(
    '其余账号由自动填入且不带固定标记',
    savedAssign.autoBound === savedAssign.othersTotal && savedAssign.autoPinned === 0,
    `绑定 ${savedAssign.autoBound}/${savedAssign.othersTotal}，固定 ${savedAssign.autoPinned}`,
  );
  check('保存后说明哪些是手动指定', savedAssign.body.includes('为手动指定，不会被自动分配覆盖'));

  // 再点一次保存（等价于重跑自动分配）：手动那行必须原样保留
  await page.getByRole('button', { name: '按上表保存分配' }).click();
  await page.waitForTimeout(900);
  const afterRerun = await page.evaluate(async () => {
    const { accounts = [] } = await chrome.storage.local.get('accounts');
    const main = accounts.find((account) => (account.label || account.username) === '主号');
    return { proxyId: main?.proxyId, pinned: main?.proxyPinned };
  });
  check('重跑自动分配不覆盖手动指定的行', afterRerun.proxyId === manualPick.id && afterRerun.pinned === true, JSON.stringify(afterRerun));

  // 账号弹窗把代理改回跟随站点时，固定标记必须一起清掉
  const clearedPin = await page.evaluate(async () => {
    const { accounts = [] } = await chrome.storage.local.get('accounts');
    const main = accounts.find((account) => (account.label || account.username) === '主号');
    await chrome.runtime.sendMessage({
      type: 'MUTATE_APP',
      mutation: { action: 'update-account', accountId: main.id, patch: { proxyMode: 'inherit' } },
    });
    const { accounts: after = [] } = await chrome.storage.local.get('accounts');
    const updated = after.find((account) => account.id === main.id);
    return { mode: updated?.proxyMode, proxyId: updated?.proxyId, pinned: updated?.proxyPinned };
  });
  check('改回跟随站点会清掉固定标记与绑定', clearedPin.mode === 'inherit' && clearedPin.proxyId === undefined && clearedPin.pinned === undefined, JSON.stringify(clearedPin));
  await page.getByRole('heading', { name: '代理管理' }).locator('..').getByRole('button').click();
  await page.reload();
  await page.waitForTimeout(700);

  // 9. 深色模式（账号默认收起，先展开 s1 才能看到账号行与状态徽章）
  const darkModeCollapsedOneApi = page.getByRole('button', { name: '展开账号 OneAPI 中转站' });
  if (await darkModeCollapsedOneApi.count()) await darkModeCollapsedOneApi.click();
  await page.waitForTimeout(700);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(SHOTS, '9-dark.png') });
  console.log('9-dark.png  深色模式');

  const txt = await page.textContent('body');
  check('站点名渲染', txt.includes('OneAPI 中转站') && txt.includes('NewAPI 聚合'));
  check('账号渲染', txt.includes('主号') && txt.includes('wangwu@mail.com'));
  // 同一邮箱常在多个站点各有账号，账号行必须自带站点名才分得清哪行是哪个
  check('账号行标注所属站点', (await page.locator('[data-account-id="a1"]').getAttribute('data-account-status')) !== null
    && (await page.locator('[data-account-id="a1"]').textContent()).includes('OneAPI 中转站'));
  check('状态徽章渲染', ['已签到', '待签到', '签到中', '需处理', '失败'].every((label) => txt.includes(label)));
  check('签到方式标签渲染', txt.includes('接口签到') && txt.includes('点按钮签到'));
  check('统计渲染', /今日\s+\d+\s*\/\s*\d+\s+已完成/.test(txt));
  check('批量签到按钮出现', /全部签到 \(\d+\)/.test(txt));
  check('站点速览已移除', !txt.includes('站点速览'));
  const manifestEntry = await page.evaluate(() => chrome.runtime.getManifest());
  check(
    '工具栏入口使用持久管理页',
    manifestEntry.options_ui?.page === 'options.html' && manifestEntry.options_ui?.open_in_tab === true && !manifestEntry.action?.default_popup,
  );
  check(
    'Chrome Side Panel 清单配置正确',
    manifestEntry.side_panel?.default_path === 'sidepanel.html' && manifestEntry.permissions?.includes('sidePanel'),
  );

  // 10. 真实 Side Panel 入口与窄宽度布局
  const sidepanel = await ctx.newPage();
  await sidepanel.setViewportSize({ width: 390, height: 844 });
  await sidepanel.goto(`chrome-extension://${extId}/sidepanel.html`);
  await sidepanel.waitForTimeout(750);
  await sidepanel.getByRole('button', { name: '展开账号 OneAPI 中转站' }).click();
  await sidepanel.waitForTimeout(700);
  await sidepanel.screenshot({ path: join(SHOTS, '10-sidepanel.png') });
  console.log('10-sidepanel.png  Chrome Side Panel 窄宽度布局');
  const mobileLayout = await sidepanel.evaluate(() => ({
    viewport: window.innerWidth,
    pageWidth: document.documentElement.scrollWidth,
  }));
  check('Side Panel 无横向溢出', mobileLayout.pageWidth <= mobileLayout.viewport + 1);
  const sidepanelText = await sidepanel.textContent('body');
  check('Side Panel 保留账号状态', ['已签到', '失败', '签到中', '需处理'].every((label) => sidepanelText.includes(label)));
  check('Side Panel 保留实时步骤', sidepanelText.includes('实时执行') && sidepanelText.includes('正在点击立即签到'));
  await sidepanel.close();
} finally {
  await ctx.close();
  rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length === 0 ? 0 : 1);
