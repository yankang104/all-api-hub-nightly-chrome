/** 两站自主签到回归：各走自己的登录/签到页面，旧 workflow 缺 identityPath 也不能接管 auto。 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

async function fixture(id, terminal, label) {
  let logins = 0;
  let claims = 0;
  const paths = [];
  const username = `sentinel_auto_${id}`;
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://fixture.test').pathname;
    paths.push(path);
    res.setHeader('Cache-Control', 'no-store');
    const authenticated = String(req.headers.cookie ?? '').includes(`fixture=${id}`);
    if (path === '/login' && req.method === 'POST') {
      for await (const _ of req) { /* 仅消耗虚构表单，不记录凭据 */ }
      logins += 1;
      res.writeHead(302, { 'Set-Cookie': `fixture=${id}; Path=/; SameSite=Lax`, Location: '/dashboard' });
      res.end(); return;
    }
    if (path === '/api/user/self') {
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = authenticated ? 200 : 401;
      res.end(JSON.stringify(authenticated ? { success: true, data: { username, id: id === 'one' ? 101 : 202, quota: 500000 + claims * 50000, used_quota: 0 } } : { success: false }));
      return;
    }
    if (path === '/api/claim' && req.method === 'POST') {
      for await (const _ of req) { /* drain */ }
      if (authenticated) claims += 1;
      res.statusCode = authenticated ? 200 : 401;
      res.end(JSON.stringify({ success: authenticated })); return;
    }
    if (path.startsWith('/api/')) { res.writeHead(404); res.end('{}'); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (!authenticated) {
      res.end('<!doctype html><meta charset="utf-8"><form action="/login" method="POST"><input id="username" name="username" autocomplete="username"><input id="password" name="password" type="password" autocomplete="current-password"><button id="submit" type="submit">登录</button></form>');
      return;
    }
    const header = `<div id="logged-in">用户名：${username}</div>`;
    res.end(`<!doctype html><meta charset="utf-8"><style>body{font:16px sans-serif;margin:40px}button{padding:14px}</style>${header}${path === terminal
      ? `<h1>每日签到</h1><button id="claim">${label}</button><p id="result"></p><script>document.getElementById('claim').onclick=async(event)=>{if(!event.isTrusted)return;await fetch('/api/claim',{method:'POST'});document.getElementById('result').textContent='签到成功';};</script>`
      : `<h1>控制台</h1><a href="${terminal}">每日签到</a>`}`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server, origin: `http://127.0.0.1:${server.address().port}`, username, terminal, id,
    stats: () => ({ logins, claims, paths }),
  };
}
const fixtures = [await fixture('one', '/profile', '立即签到'), await fixture('two', '/daily-bonus', '领取奖励')];
const output = resolve('output/auto-checkin-mode');
mkdirSync(output, { recursive: true });
const profile = mkdtempSync(resolve(output, 'profile-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: true, channel: 'chromium', viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${resolve('.output/chrome-mv3')}`, `--load-extension=${resolve('.output/chrome-mv3')}`],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).hostname;
  const app = await context.newPage();
  await app.goto(`chrome-extension://${extensionId}/options.html`);
  await app.evaluate(async (sites) => {
    await chrome.storage.local.set({
      sites: sites.map((site) => ({
        id: site.id, name: `自动签到 ${site.id}`, loginUrl: site.origin + '/login', loginMethod: 'form',
        successIndicator: '#logged-in', selectors: { username: '#username', password: '#password', submit: '#submit' }, closeModalSelectors: [],
        adapter: { family: 'unsupported', checkinPath: '' },
        checkin: { method: 'auto', url: site.terminal, workflow: {
          route: ['/wrong-learning-profile'], steps: [{ type: 'click', selector: '#old-learning-nav' }],
        } },
      })),
      accounts: sites.map((site) => ({ id: site.id, siteId: site.id, username: site.username, password: 'sentinel-password' })),
      results: {}, status: {},
    });
  }, fixtures.map(({ id, origin, username, terminal }) => ({ id, origin, username, terminal })));

  for (const site of fixtures) {
    const started = await app.evaluate((id) => chrome.runtime.sendMessage({ type: 'START_LOGIN', accountId: id }), site.id);
    assert.equal(started.ok, true, JSON.stringify(started));
    const deadline = Date.now() + 90000;
    let state;
    while (Date.now() < deadline) {
      state = await app.evaluate(async (id) => {
        const { results, status } = await chrome.storage.local.get(['results', 'status']);
        const { checkinQueue } = await chrome.storage.session.get('checkinQueue');
        return { result: results?.[id], status: Object.entries(status ?? {}).find(([key]) => key.startsWith(id + ':'))?.[1], busy: !!checkinQueue?.active };
      }, site.id);
      if (state.result && !state.busy) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!state?.result) {
      const debug = await app.evaluate(async () => {
        const session = await chrome.storage.session.get(null);
        return Object.entries(session).filter(([key]) => /task|queue/i.test(key)).map(([key, value]) => ({
          key, stage: value?.stage, tabId: value?.tabId, steps: value?.steps,
          active: value?.active, pendingAccountIds: value?.pendingAccountIds,
        }));
      });
      console.error('Auto replay timeout:', JSON.stringify({ stats: site.stats(), pages: context.pages().map((page) => page.url()), debug }, null, 2));
    }
    assert.equal(state?.status, 'done', JSON.stringify(state));
    assert.equal(state?.result?.ok, true, JSON.stringify(state));
    const { logins, claims, paths } = site.stats();
    assert.equal(logins, 1, JSON.stringify(site.stats()));
    assert.equal(claims, 1, JSON.stringify(site.stats()));
    assert.ok(paths.includes(site.terminal), JSON.stringify(paths));
    assert.ok(!paths.includes('/wrong-learning-profile'), JSON.stringify(paths));
    const log = state.result.steps.join('\n');
    assert.ok(!log.includes('学习签到路线缺少身份核验页'), log);
    assert.ok(!log.includes('工作流已点击'), log);
    assert.ok(log.includes('不回放旧学习记录'), log);
    console.log(`PASS auto ${site.id}: form login -> ${site.terminal} -> one trusted claim, ignores inactive learned route`);
  }
} finally {
  await context?.close();
  await Promise.all(fixtures.map(({ server }) => new Promise((resolve) => server.close(resolve))));
  rmSync(profile, { recursive: true, force: true });
}
