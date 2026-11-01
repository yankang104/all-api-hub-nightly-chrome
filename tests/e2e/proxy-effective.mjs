/**
 * 回归：代理必须真的生效，不生效必须报错。
 *
 * 背景：`chrome.proxy.settings.set` 在设置被别的扩展占用时**照样 resolve**，
 * 不抛错。旧实现设完就当成功，浏览器实际明文出站，任务却显示成功。
 * 用户侧的症状是站点报 ERR_SSL_VERSION_OR_CIPHER_MISMATCH（直连握不上手的
 * 站点尤其明显），完全看不出是代理没套上。
 *
 * 同类问题还有名称条目（订阅里 vmess/vless 等 Chrome 用不了的协议）：
 * 旧实现按直连放行，等于「用户指定了美国出口，实际走直连」还报成功。
 *
 * 这两条都不能只靠单测 —— 它们依赖 chrome.proxy 的真实行为，
 * jsdom 打桩验证不了 levelOfControl 与回读一致性。
 *
 * 用法: node tests/proxy-effective.mjs
 *   PROXY_PORT=10016  指定一个本机可用的代理端口；不设则起一个假的 HTTP 代理。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { chromium } from 'playwright';

const EXT = path.resolve('.output/chrome-mv3');
if (!fs.existsSync(path.join(EXT, 'manifest.json'))) {
  console.error('缺少构建产物 .output/chrome-mv3，先运行 pnpm build');
  process.exit(1);
}

const checks = [];
const check = (name, pass, detail = '') => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

/** 起一个最小 HTTP 代理，支持 CONNECT，用来当「真实存在的出口」 */
async function startProxy() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('proxy-ok');
  });
  server.on('connect', (req, clientSocket, head) => {
    const [host, port] = req.url.split(':');
    const upstream = net.connect(Number(port) || 443, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

const own = process.env.PROXY_PORT ? null : await startProxy();
const PORT = Number(process.env.PROXY_PORT || own.port);

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-eff-'));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

try {
  const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker', { timeout: 30000 });
  const extId = new URL(sw.url()).host;
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/options.html`);
  await page.waitForLoadState('domcontentloaded');

  // ---- 1. 真实代理：设下去必须回读一致，且被本扩展接管 ----
  const applied = await page.evaluate(async (port) => {
    await new Promise((r) => chrome.proxy.settings.set({
      value: {
        mode: 'fixed_servers',
        rules: {
          singleProxy: { scheme: 'http', host: '127.0.0.1', port },
          bypassList: ['localhost', '127.0.0.1', '<local>'],
        },
      },
      scope: 'regular',
    }, r));
    const s = await new Promise((r) => chrome.proxy.settings.get({ incognito: false }, r));
    const sp = s?.value?.rules?.singleProxy;
    await new Promise((r) => chrome.proxy.settings.clear({ scope: 'regular' }, r));
    return { control: s?.levelOfControl, mode: s?.value?.mode, host: sp?.host, port: sp?.port };
  }, PORT);

  check(
    '真实代理设下去后由本扩展接管',
    applied.control === 'controlled_by_this_extension',
    `levelOfControl=${applied.control}`,
  );
  check(
    '回读到的端口与设下去的一致',
    applied.mode === 'fixed_servers' && applied.port === PORT,
    `mode=${applied.mode} port=${applied.port} 期望 ${PORT}`,
  );

  // ---- 2. 名称条目绑定：必须报错，绝不能静默直连 ----
  const nameOnly = await page.evaluate(async () => {
    const g = (k) => new Promise((r) => chrome.storage.local.get([k], (o) => r(o[k] ?? [])));
    const s = (k, v) => new Promise((r) => chrome.storage.local.set({ [k]: v }, r));

    const pxId = 'px_reg_nameonly';
    const proxies = (await g('proxies')).filter((p) => p.id !== pxId);
    proxies.push({ id: pxId, name: 'vmess香港01', scheme: 'http', host: '0.0.0.0', port: 1, nameOnly: true });
    await s('proxies', proxies);

    const siteId = 'site_reg_nameonly';
    const sites = (await g('sites')).filter((x) => x.id !== siteId);
    sites.push({
      id: siteId, name: 'reg-site', loginUrl: 'https://anyrouter.top/login', loginMethod: 'auto',
      selectors: { username: '#username', password: '#password', submit: 'button[type="submit"]' },
      closeModalSelectors: [], checkin: { method: 'none' },
      adapter: { family: 'new-api', checkinPath: '', quotaPerUnit: 500000 }, enabled: true,
    });
    await s('sites', sites);

    const accId = 'acc_reg_nameonly';
    const accounts = (await g('accounts')).filter((a) => a.id !== accId);
    accounts.push({
      id: accId, siteId, alias: '名称条目账号', username: 'u', password: 'p',
      enabled: true, proxyMode: 'pool', proxyId: pxId, proxyPinned: true,
    });
    await s('accounts', accounts);

    await new Promise((r) => chrome.runtime.sendMessage({ type: 'START_LOGIN', accountId: accId }, () => r()));

    // 等结果落盘
    const deadline = Date.now() + 20000;
    let res = null;
    while (Date.now() < deadline) {
      const all = await new Promise((r) => chrome.storage.local.get(['results'], (o) => r(o.results ?? {})));
      if (all[accId]) { res = all[accId]; break; }
      await new Promise((r) => setTimeout(r, 200));
    }
    const cur = await new Promise((r) => chrome.proxy.settings.get({ incognito: false }, r));
    return { res, mode: cur?.value?.mode };
  });

  check(
    '名称条目绑定被判为失败（不静默直连）',
    nameOnly.res?.ok === false,
    `结果=${JSON.stringify(nameOnly.res?.ok)} 原因=${nameOnly.res?.message ?? '无'}`,
  );
  check(
    '失败原因说清了是节点名没有真实出口',
    /只是订阅里的节点名|没有浏览器能用的出口/.test(nameOnly.res?.message ?? ''),
    nameOnly.res?.message ?? '无',
  );
  check(
    '名称条目没有把假地址设进浏览器代理',
    nameOnly.mode !== 'fixed_servers',
    `mode=${nameOnly.mode}`,
  );

  // ---- 3. 名称条目升级：导入带真实出口的同名节点后，原绑定必须自动生效 ----
  // 这是用户实际遇到的场景：账号早就绑在订阅导入的「日本-优化」上（只有名字），
  // 后来导入了 Clash listeners 那份带端口的清单，绑定必须自己接上，
  // 不能要求用户手动逐个改绑。
  const upgrade = await page.evaluate(async (port) => {
    const g = (k) => new Promise((r) => chrome.storage.local.get([k], (o) => r(o[k] ?? [])));
    const s = (k, v) => new Promise((r) => chrome.storage.local.set({ [k]: v }, r));

    const pxId = 'px_reg_upgrade';
    const proxies = (await g('proxies')).filter((p) => p.id !== pxId);
    proxies.push({ id: pxId, name: '日本-优化', scheme: 'http', host: '0.0.0.0', port: 1, nameOnly: true });
    await s('proxies', proxies);

    const accId = 'acc_reg_upgrade';
    const accounts = (await g('accounts')).filter((a) => a.id !== accId);
    accounts.push({
      id: accId, siteId: 'site_reg_nameonly', alias: '升级验证账号', username: 'u', password: 'p',
      enabled: true, proxyMode: 'pool', proxyId: pxId, proxyPinned: true,
    });
    await s('accounts', accounts);

    // 走真实的批量导入链路，名字带国家前缀（导入清单就是这个格式）
    const resp = await new Promise((r) => chrome.runtime.sendMessage({
      type: 'MUTATE_APP',
      mutation: {
        action: 'add-proxies',
        inputs: [{ name: '[JP] 日本-优化', scheme: 'http', host: '127.0.0.1', port, nameOnly: false }],
      },
    }, (x) => r(x ?? { lastError: chrome.runtime.lastError?.message })));

    const after = await g('proxies');
    const mine = after.find((p) => p.id === pxId);
    const acc = (await g('accounts')).find((a) => a.id === accId);
    return { resp, entry: mine, boundProxyId: acc?.proxyId, poolSize: after.length };
  }, PORT);

  check(
    '导入返回里报告了升级数量',
    upgrade.resp?.upgraded === 1,
    `返回=${JSON.stringify(upgrade.resp)}`,
  );
  check(
    '原条目已补上真实出口且不再是节点名',
    upgrade.entry?.nameOnly !== true && upgrade.entry?.host === '127.0.0.1' && upgrade.entry?.port === PORT,
    `条目=${JSON.stringify(upgrade.entry)}`,
  );
  check(
    '账号绑定的 id 没变（不需要手动改绑）',
    upgrade.boundProxyId === 'px_reg_upgrade',
    `账号 proxyId=${upgrade.boundProxyId}`,
  );

  // 升级后再跑一次任务，代理必须真的套上
  const afterUpgrade = await page.evaluate(async () => {
    await new Promise((r) => chrome.runtime.sendMessage({ type: 'START_LOGIN', accountId: 'acc_reg_upgrade' }, () => r()));
    let seen = null;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const s = await new Promise((r) => chrome.proxy.settings.get({ incognito: false }, r));
      const sp = s?.value?.rules?.singleProxy;
      if (s?.value?.mode === 'fixed_servers' && sp) { seen = { host: sp.host, port: sp.port, control: s.levelOfControl }; break; }
      await new Promise((r) => setTimeout(r, 150));
    }
    return seen;
  });

  check(
    '升级后该账号任务真的套上了代理',
    afterUpgrade?.port === PORT && afterUpgrade?.control === 'controlled_by_this_extension',
    afterUpgrade ? `${afterUpgrade.host}:${afterUpgrade.port} (${afterUpgrade.control})` : '任务期间代理从未生效',
  );

  // ---- 4. 同步内核出口不得解绑正在使用的出口 ----
  // 用户实际遇到的场景：账号早就绑在某条 Clash 出口上，内核换订阅/重载配置后
  // 出口集合变了，再点一次「同步节点」。旧实现会把不在本次清单里的条目整批删掉，
  // 并把绑定它的账号改成 inherit、删掉 proxyId —— 账号静默变直连，站点若只能
  // 经代理访问，签到当场连不上，用户只能逐个重新绑定。
  const syncKeepsBinding = await page.evaluate(async () => {
    const g = (k) => new Promise((r) => chrome.storage.local.get([k], (o) => r(o[k] ?? [])));
    const s = (k, v) => new Promise((r) => chrome.storage.local.set({ [k]: v }, r));

    const pxId = 'px_reg_keepsync';
    const proxies = (await g('proxies')).filter((p) => p.id !== pxId);
    proxies.push({
      id: pxId, name: '内核里已经消失的旧出口', scheme: 'http', host: '127.0.0.1', port: 65500,
      sourceLabel: 'Clash Verge',
    });
    await s('proxies', proxies);

    const accId = 'acc_reg_keepsync';
    const accounts = (await g('accounts')).filter((a) => a.id !== accId);
    accounts.push({
      id: accId, siteId: 'site_reg_nameonly', alias: '同步保绑账号', username: 'u', password: 'p',
      enabled: true, proxyMode: 'pool', proxyId: pxId, proxyPinned: true,
    });
    await s('accounts', accounts);

    // 同步一份完全不同的出口集合：旧出口不在里面，但它仍被账号绑定
    const resp = await new Promise((r) => chrome.runtime.sendMessage({
      type: 'SYNC_CLASH_PROXIES',
      inputs: [{ name: '全新的出口', scheme: 'http', host: '127.0.0.1', port: 65501, sourceLabel: 'Clash Verge' }],
    }, (x) => r(x ?? { lastError: chrome.runtime.lastError?.message })));

    const afterProxies = await g('proxies');
    const acc = (await g('accounts')).find((a) => a.id === accId);
    return {
      kept: afterProxies.some((p) => p.id === pxId),
      keptInUse: resp?.feature?.clashConfigSync?.keptInUse,
      removed: resp?.feature?.clashConfigSync?.removed,
      proxyId: acc?.proxyId,
      mode: acc?.proxyMode,
    };
  });

  check(
    '同步内核出口后，仍被账号绑定的旧出口没有被删掉',
    syncKeepsBinding.kept === true,
    `kept=${syncKeepsBinding.kept} keptInUse=${syncKeepsBinding.keptInUse} removed=${syncKeepsBinding.removed}`,
  );
  check(
    '同步后账号仍绑定原出口，不会被静默改成直连',
    syncKeepsBinding.proxyId === 'px_reg_keepsync' && syncKeepsBinding.mode === 'pool',
    `proxyId=${syncKeepsBinding.proxyId} mode=${syncKeepsBinding.mode}`,
  );
  check(
    '同步结果里如实回报了保留数量',
    syncKeepsBinding.keptInUse === 1,
    `keptInUse=${syncKeepsBinding.keptInUse}`,
  );

  /*
   * 代理已经在真实 Chrome 里确认生效，随后主动关闭测试任务页来触发收尾。
   *
   * 旧测试等待 anyrouter.top 自己在 60 秒内完成登录；外站或本地代理偶尔变慢
   * 时，任务会按产品规则继续持有代理 10 分钟，却被测试误报成“没有还原”。
   * 主动关闭页面验证的是同一条 tabs.onRemoved -> finalize -> release 链路，
   * 同时消除了与代理生命周期无关的公网响应时间依赖。
   */
  await page.evaluate(async () => {
    const sess = await new Promise((r) => chrome.storage.session.get(['checkinQueue'], r));
    const tabId = sess?.checkinQueue?.active?.tabId;
    if (Number.isInteger(tabId) && tabId > 0) {
      await new Promise((r) => chrome.tabs.remove(tabId, () => r()));
    }
  });

  /*
   * 等任务真正收尾，再断言还原。
   *
   * 不能只看 proxy mode —— 任务启动前它本来就不是 fixed_servers，
   * 采样窗口稍早就会误判成「已收尾」，下一步断言反而抓到代理还挂着。
   * 必须以队列自身的状态为准：没有活动任务、也没有排队的账号。
   */
  await page.evaluate(async () => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const sess = await new Promise((r) => chrome.storage.session.get(['checkinQueue', 'proxyHolderTabId'], r));
      const q = sess?.checkinQueue;
      const idle = !q?.active && !(q?.pendingAccountIds?.length) && sess?.proxyHolderTabId == null;
      if (idle) {
        const s = await new Promise((r) => chrome.proxy.settings.get({ incognito: false }, r));
        if (s?.value?.mode !== 'fixed_servers') return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  });

  // ---- 5. 收尾必须还原，否则影响用户正常上网 ----
  const final = await page.evaluate(async () => {
    const s = await new Promise((r) => chrome.proxy.settings.get({ incognito: false }, r));
    const sess = await new Promise((r) => chrome.storage.session.get(null, r));
    const tabs = await new Promise((r) => chrome.tabs.query({}, r));
    return {
      mode: s?.value?.mode,
      port: s?.value?.rules?.singleProxy?.port,
      session: JSON.stringify(sess),
      tabs: tabs.map((t) => `${t.id}:${(t.url || '').slice(0, 48)}`),
    };
  });
  check('收尾已还原为非 fixed_servers', final.mode !== 'fixed_servers',
    `mode=${final.mode} port=${final.port}
      session=${final.session}
      tabs=${JSON.stringify(final.tabs)}`);
} finally {
  await ctx.close().catch(() => {});
  fs.rmSync(userDataDir, { recursive: true, force: true });
  if (own) await new Promise((r) => own.server.close(r));
}

const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length) {
  console.log(`失败: ${failed.map((f) => f.name).join('、')}`);
  process.exit(1);
}
console.log('结果: PASS');
