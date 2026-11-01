/**
 * 隔离 Chrome 中验证控制器检测；可选 REAL_CLASH_PORT=7897 测本机已运行的代理。
 * 不读取密钥、不改 Clash 配置、不切节点；代理设置只作用于临时浏览器 profile。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const requests = [];
const server = createServer((req, res) => {
  requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization });
  if (req.headers.authorization !== 'Bearer sentinel-controller-secret') {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end('{"message":"Unauthorized"}'); return;
  }
  res.setHeader('Content-Type', 'application/json');
  res.end('{"meta":true,"version":"v1.fixture"}');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = `http://127.0.0.1:${server.address().port}`;
const output = resolve('output/clash-local-check');
mkdirSync(output, { recursive: true });
const profile = mkdtempSync(resolve(output, 'profile-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${resolve('.output/chrome-mv3')}`, `--load-extension=${resolve('.output/chrome-mv3')}`],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).hostname;
  const app = await context.newPage();
  await app.goto(`chrome-extension://${extensionId}/options.html`);
  const message = (payload) => app.evaluate((payload) => chrome.runtime.sendMessage(payload), payload);
  const protectedResult = await message({ type: 'DETECT_CLASH_CONTROLLER', controller: { address } });
  assert.equal(protectedResult.ok, true, JSON.stringify(protectedResult));
  assert.deepEqual(protectedResult.feature.clashControllerDetect, { status: 'found', address, needsSecret: true, verified: false });
  const authenticated = await message({ type: 'DETECT_CLASH_CONTROLLER', controller: { address, secret: 'sentinel-controller-secret' } });
  assert.equal(authenticated.ok, true, JSON.stringify(authenticated));
  assert.deepEqual(authenticated.feature.clashControllerDetect, { status: 'found', address, needsSecret: false, verified: true });
  assert.deepEqual(requests.map(({ method, path }) => ({ method, path })), [
    { method: 'GET', path: '/version' }, { method: 'GET', path: '/version' },
  ]);
  console.log('PASS real extension: custom controller port, authentication, GET-only detection');

  const realPort = Number(process.env.REAL_CLASH_PORT);
  if (Number.isInteger(realPort) && realPort > 0 && realPort <= 65535) {
    const detection = await message({ type: 'DETECT_CLASH_CONTROLLER' });
    assert.equal(detection.ok, true, JSON.stringify(detection));
    console.log('Local HTTP controller status:', detection.feature.clashControllerDetect.status);
    if (detection.feature.clashControllerDetect.status === 'not-found') {
      assert.ok(detection.feature.clashControllerDetect.message.includes('这不代表'));
    }
    const probe = await message({ type: 'SCAN_LOCAL_PORTS', host: '127.0.0.1', ports: [realPort], scheme: 'http', withExit: false });
    assert.equal(probe.ok, true, JSON.stringify(probe));
    const entry = probe.feature.portScan.entries[0];
    console.log(`Local proxy 127.0.0.1:${realPort}:`, JSON.stringify({ ok: entry.ok, ms: entry.ms, message: entry.message }));
    assert.equal(entry.ok, true, '真实本机代理未通过浏览器出站测试，不能宣称代理可用');
    const proxyAfter = await app.evaluate(() => chrome.proxy.settings.get({ incognito: false }));
    assert.notEqual(proxyAfter.levelOfControl, 'controlled_by_this_extension', '测试后必须释放临时浏览器代理设置');
  }
} finally {
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
  rmSync(profile, { recursive: true, force: true });
}
