/**
 * 多站点公开登录页只读烟雾测试。
 *
 * 只导航公开页面并检查响应、最终地址、盾页和选择器。测试不会加载扩展，
 * 不使用持久化浏览器数据，也不会输入、点击、登录、截图或发送非只读请求。
 */
import { readFileSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';

const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_TARGETS = 100;
const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const SENSITIVE_QUERY_KEY = /password|passwd|pwd|token|secret|api[_-]?key|authorization|credential/i;
const DEFAULT_SELECTORS = {
  username: 'input[name="username"]',
  password: 'input[name="password"]',
  submit: 'button.semi-button-primary.w-full',
};
const DEFAULT_TARGETS = [
  {
    name: '可萌中转站',
    url: 'https://api456.me/login',
    expectedHosts: ['api456.me'],
    selectors: DEFAULT_SELECTORS,
  },
];

const CHALLENGE_DOM_MARKERS = [
  ['Cloudflare challenge', '#challenge-running, #challenge-stage, .cf-challenge-running'],
  ['Cloudflare Turnstile', '.cf-turnstile, [name="cf-turnstile-response"]'],
  ['Cloudflare challenge iframe', 'iframe[src*="challenges.cloudflare.com"]'],
  ['reCAPTCHA', '.g-recaptcha, iframe[src*="recaptcha"]'],
  ['hCaptcha', '.h-captcha, iframe[src*="hcaptcha.com"]'],
  ['captcha control', 'input[name*="captcha" i], input[id*="captcha" i]'],
];
const CHALLENGE_TEXT_MARKERS = [
  ['Just a moment', 'just a moment'],
  ['Attention required', 'attention required'],
  ['Verify you are human', 'verify you are human'],
  ['Security verification', 'security verification'],
  ['正在验证', '正在验证您是否是真人'],
  ['安全验证', '请完成安全验证'],
  ['人机验证', '人机验证'],
  ['异常流量', '检测到异常流量'],
];

function parseArgs(argv) {
  let targetsFile = '';
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--targets') {
      targetsFile = argv[index + 1] ?? '';
      index += 1;
      if (!targetsFile) throw new Error('--targets 需要一个 JSON 文件路径');
      continue;
    }
    if (arg.startsWith('--targets=')) {
      targetsFile = arg.slice('--targets='.length);
      if (!targetsFile) throw new Error('--targets 需要一个 JSON 文件路径');
      continue;
    }
    throw new Error(`未知参数: ${arg}`);
  }

  return { targetsFile, help };
}

function printHelp() {
  console.log(`用法:
  node tests/real-site-smoke.mjs
  node tests/real-site-smoke.mjs --targets tests/site-smoke-targets.example.json

目标来源（只能使用一种）:
  --targets <file>                指定 JSON 目标文件
  SITE_SMOKE_TARGETS_FILE         通过环境变量指定 JSON 目标文件
  SITE_SMOKE_TARGETS_JSON         通过环境变量直接传入 JSON

可选环境变量:
  SITE_SMOKE_TIMEOUT_MS           单站导航超时，默认 45000
  SITE_SMOKE_SETTLE_MS            DOM 加载后的等待时间，默认 2500
  SITE_SMOKE_HEADLESS             默认 true；设为 false 可显示浏览器`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertNoUnknownKeys(value, allowedKeys, label) {
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknown.length) throw new Error(`${label} 含不允许字段: ${unknown.join(', ')}`);
}

function normalizeHost(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 必须是非空字符串`);
  const trimmed = value.trim();
  if (/[\/@?#]/.test(trimmed)) throw new Error(`${label} 只能填写主机名，不能包含路径或凭据`);

  let parsed;
  try {
    parsed = new URL(`https://${trimmed}`);
  } catch {
    throw new Error(`${label} 不是有效主机名`);
  }
  return parsed.hostname.toLowerCase();
}

function normalizeTarget(raw, index) {
  const label = `targets[${index}]`;
  if (!isPlainObject(raw)) throw new Error(`${label} 必须是对象`);
  assertNoUnknownKeys(raw, new Set(['name', 'url', 'expectedHosts', 'selectors']), label);

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name || name.length > 80 || /[\r\n\0]/.test(name)) {
    throw new Error(`${label}.name 必须是 1-80 个字符的单行文本`);
  }
  if (typeof raw.url !== 'string' || raw.url.length > 2048) {
    throw new Error(`${label}.url 必须是长度不超过 2048 的字符串`);
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(raw.url);
  } catch {
    throw new Error(`${label}.url 不是有效 URL`);
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error(`${label}.url 只允许 http/https`);
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw new Error(`${label}.url 禁止包含用户名或密码`);
  }
  for (const key of parsedUrl.searchParams.keys()) {
    if (SENSITIVE_QUERY_KEY.test(key)) {
      throw new Error(`${label}.url 禁止包含疑似凭据参数: ${key}`);
    }
  }

  const rawHosts = raw.expectedHosts ?? [parsedUrl.hostname];
  if (!Array.isArray(rawHosts) || rawHosts.length === 0 || rawHosts.length > 10) {
    throw new Error(`${label}.expectedHosts 必须是包含 1-10 个主机名的数组`);
  }
  const expectedHosts = [...new Set(rawHosts.map((host, hostIndex) => normalizeHost(host, `${label}.expectedHosts[${hostIndex}]`)))];

  if (!isPlainObject(raw.selectors) || Object.keys(raw.selectors).length === 0) {
    throw new Error(`${label}.selectors 必须是非空对象`);
  }
  if (Object.keys(raw.selectors).length > 20) {
    throw new Error(`${label}.selectors 最多配置 20 项`);
  }
  const selectors = {};
  for (const [selectorName, selector] of Object.entries(raw.selectors)) {
    if (!selectorName.trim() || selectorName.length > 40 || /[\r\n\0]/.test(selectorName)) {
      throw new Error(`${label}.selectors 的名称必须是 1-40 个字符的单行文本`);
    }
    if (typeof selector !== 'string' || !selector.trim() || selector.length > 500 || /[\r\n\0]/.test(selector)) {
      throw new Error(`${label}.selectors.${selectorName} 必须是 1-500 个字符的单行选择器`);
    }
    selectors[selectorName] = selector.trim();
  }

  return {
    name,
    url: parsedUrl.href,
    expectedHosts,
    selectors,
  };
}

function parseTargetDocument(rawText, source) {
  if (Buffer.byteLength(rawText, 'utf8') > MAX_CONFIG_BYTES) {
    throw new Error(`${source} 超过 ${MAX_CONFIG_BYTES} 字节限制`);
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new Error(`${source} 不是有效 JSON: ${firstLine(error)}`);
  }

  let rawTargets;
  if (Array.isArray(parsed)) {
    rawTargets = parsed;
  } else if (isPlainObject(parsed)) {
    assertNoUnknownKeys(parsed, new Set(['targets']), source);
    rawTargets = parsed.targets;
  }
  if (!Array.isArray(rawTargets) || rawTargets.length === 0 || rawTargets.length > MAX_TARGETS) {
    throw new Error(`${source} 必须包含 1-${MAX_TARGETS} 个 targets`);
  }

  const targets = rawTargets.map(normalizeTarget);
  const duplicateNames = targets.filter((target, index) => targets.findIndex((item) => item.name === target.name) !== index);
  if (duplicateNames.length) throw new Error(`${source} 含重复站点名称: ${duplicateNames[0].name}`);
  return targets;
}

function readTargetFile(filePath) {
  const absolutePath = resolve(process.cwd(), filePath);
  if (extname(absolutePath).toLowerCase() !== '.json') {
    throw new Error('目标文件必须使用 .json 扩展名');
  }
  const stats = statSync(absolutePath);
  if (!stats.isFile()) throw new Error('目标文件路径不是普通文件');
  if (stats.size > MAX_CONFIG_BYTES) throw new Error(`目标文件超过 ${MAX_CONFIG_BYTES} 字节限制`);
  return { text: readFileSync(absolutePath, 'utf8'), source: absolutePath };
}

function loadTargets(cliFile) {
  const envFile = process.env.SITE_SMOKE_TARGETS_FILE?.trim() ?? '';
  const envJson = process.env.SITE_SMOKE_TARGETS_JSON?.trim() ?? '';
  const sources = [
    cliFile && { type: 'file', value: cliFile, label: '--targets' },
    envFile && { type: 'file', value: envFile, label: 'SITE_SMOKE_TARGETS_FILE' },
    envJson && { type: 'json', value: envJson, label: 'SITE_SMOKE_TARGETS_JSON' },
  ].filter(Boolean);

  if (sources.length > 1) {
    throw new Error(`目标来源冲突，只能指定一种: ${sources.map((source) => source.label).join(', ')}`);
  }
  if (sources.length === 0) {
    return {
      targets: DEFAULT_TARGETS.map(normalizeTarget),
      source: '内置默认目标（api456.me）',
    };
  }

  const source = sources[0];
  if (source.type === 'file') {
    const file = readTargetFile(source.value);
    return { targets: parseTargetDocument(file.text, file.source), source: file.source };
  }
  return { targets: parseTargetDocument(source.value, source.label), source: source.label };
}

function parseIntegerEnv(name, fallback, min, max) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min}-${max} 之间的整数`);
  }
  return value;
}

function parseBooleanEnv(name, fallback) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes'].includes(raw)) return true;
  if (['0', 'false', 'no'].includes(raw)) return false;
  throw new Error(`${name} 只能是 true/false`);
}

function firstLine(error) {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0];
}

function publicUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return value.split(/[?#]/, 1)[0];
    if (url.pathname.startsWith('/cdn-cgi/challenge-platform/')) {
      return `${url.origin}/cdn-cgi/challenge-platform/[redacted]`;
    }
    const path = url.pathname.length > 160 ? `${url.pathname.slice(0, 157)}...` : url.pathname;
    return `${url.origin}${path}`;
  } catch {
    return '(不可用)';
  }
}

async function detectChallenge(page, response) {
  const markers = await page.evaluate(
    ({ domMarkers, textMarkers }) => {
      const found = [];
      for (const [name, selector] of domMarkers) {
        if (document.querySelector(selector)) found.push(`DOM:${name}`);
      }

      const title = document.title.toLowerCase();
      const body = (document.body?.innerText ?? '').slice(0, 20_000).toLowerCase();
      for (const [name, needle] of textMarkers) {
        if (title.includes(needle) || body.includes(needle)) found.push(`TEXT:${name}`);
      }
      if (location.pathname.includes('/cdn-cgi/challenge-platform/')) {
        found.push('URL:Cloudflare challenge');
      }
      return found;
    },
    { domMarkers: CHALLENGE_DOM_MARKERS, textMarkers: CHALLENGE_TEXT_MARKERS },
  );

  if (response && [403, 429, 503].includes(response.status())) {
    const headers = await response.allHeaders().catch(() => ({}));
    if (headers.server?.toLowerCase().includes('cloudflare') || headers['cf-ray']) {
      markers.push(`HTTP:${response.status()} Cloudflare`);
    }
  }
  return [...new Set(markers)];
}

async function inspectSelector(page, name, selector) {
  try {
    const locator = page.locator(selector);
    const count = await locator.count();
    const visible = await locator.evaluateAll((elements) =>
      elements.filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      }).length,
    );
    return { name, selector, count, visible, ok: count === 1 && visible === 1, error: '' };
  } catch (error) {
    return { name, selector, count: 0, visible: 0, ok: false, error: firstLine(error) };
  }
}

function printReport(report, index, total) {
  console.log(`\n[${index + 1}/${total}] ${report.target.name}`);
  console.log(`  目标 URL: ${publicUrl(report.target.url)}`);
  console.log(
    `  ${report.httpOk ? 'PASS' : 'FAIL'} HTTP: ${report.httpStatus ?? '无响应'}${report.navigationError ? ` (${report.navigationError})` : ''}`,
  );
  console.log(
    `  ${report.hostOk ? 'PASS' : 'FAIL'} 最终 URL: ${report.finalUrl ? publicUrl(report.finalUrl) : '(不可用)'} ` +
      `(期望主机: ${report.target.expectedHosts.join(', ')})`,
  );

  if (report.challengeDetected === null) {
    console.log('  FAIL 盾页: 无法检查');
  } else if (report.challengeDetected) {
    console.log(`  FAIL 盾页: 检测到 ${report.challengeMarkers.join(', ')}`);
  } else {
    console.log('  PASS 盾页: 未检测到已知挑战页');
  }

  for (const selector of report.selectors) {
    const detail = selector.error
      ? selector.error
      : `${selector.selector} -> count=${selector.count}, visible=${selector.visible}`;
    console.log(`  ${selector.ok ? 'PASS' : 'FAIL'} 选择器 ${selector.name}: ${detail}`);
  }

  if (report.domLoadError) console.log(`  WARN DOM 加载: ${report.domLoadError}`);
  if (report.blockedRequestCount) {
    console.log(`  PASS 只读保护: 已阻止 ${report.blockedRequestCount} 个非只读请求`);
    for (const blocked of report.blockedRequests) {
      console.log(`       ${blocked.method} ${blocked.url}`);
    }
  } else {
    console.log('  PASS 只读保护: 未发现非只读请求');
  }
  if (report.blockedWebSocketCount) {
    console.log(`  PASS 实时通道保护: 已阻止 ${report.blockedWebSocketCount} 个 WebSocket 连接`);
    for (const url of report.blockedWebSockets) console.log(`       WS ${url}`);
  } else {
    console.log('  PASS 实时通道保护: 未发现 WebSocket 连接');
  }
  if (report.runtimeError) console.log(`  FAIL 执行错误: ${report.runtimeError}`);
  console.log(`  站点结果: ${report.ok ? 'PASS' : 'FAIL'}`);
}

async function auditTarget(browser, target, index, total, options) {
  const report = {
    target,
    httpStatus: null,
    httpOk: false,
    finalUrl: '',
    hostOk: false,
    challengeDetected: null,
    challengeMarkers: [],
    selectors: [],
    navigationError: '',
    domLoadError: '',
    blockedRequestCount: 0,
    blockedRequests: [],
    blockedWebSocketCount: 0,
    blockedWebSockets: [],
    runtimeError: '',
    ok: false,
  };

  let context;
  try {
    context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: 'block',
      viewport: { width: 1280, height: 800 },
    });
    await context.route('**/*', async (route) => {
      const request = route.request();
      const method = request.method().toUpperCase();
      if (READ_ONLY_METHODS.has(method)) {
        await route.continue();
        return;
      }

      report.blockedRequestCount += 1;
      if (report.blockedRequests.length < 10) {
        report.blockedRequests.push({ method, url: publicUrl(request.url()) });
      }
      await route.abort('blockedbyclient');
    });
    await context.routeWebSocket(/.*/, async (webSocket) => {
      report.blockedWebSocketCount += 1;
      if (report.blockedWebSockets.length < 10) {
        report.blockedWebSockets.push(publicUrl(webSocket.url()));
      }
      await webSocket.close({ code: 1008, reason: 'Read-only smoke test' });
    });

    const page = await context.newPage();
    page.setDefaultTimeout(Math.min(options.timeoutMs, 15_000));

    let response = null;
    try {
      response = await page.goto(target.url, { waitUntil: 'commit', timeout: options.timeoutMs });
    } catch (error) {
      report.navigationError = firstLine(error);
    }

    try {
      await page.waitForLoadState('domcontentloaded', { timeout: Math.min(options.timeoutMs, 20_000) });
    } catch (error) {
      report.domLoadError = firstLine(error);
    }
    if (!page.isClosed() && options.settleMs > 0) {
      await page.waitForTimeout(options.settleMs).catch(() => {});
    }

    report.httpStatus = response?.status() ?? null;
    report.httpOk = report.httpStatus !== null && report.httpStatus >= 200 && report.httpStatus < 400;
    report.finalUrl = page.isClosed() ? '' : page.url();
    try {
      report.hostOk = target.expectedHosts.includes(new URL(report.finalUrl).hostname.toLowerCase());
    } catch {
      report.hostOk = false;
    }

    const canInspectDocument = !page.isClosed() && (response !== null || /^https?:/i.test(report.finalUrl));
    if (canInspectDocument) {
      try {
        report.challengeMarkers = await detectChallenge(page, response);
        report.challengeDetected = report.challengeMarkers.length > 0;
      } catch (error) {
        report.runtimeError = `盾页检查失败: ${firstLine(error)}`;
      }

      for (const [name, selector] of Object.entries(target.selectors)) {
        report.selectors.push(await inspectSelector(page, name, selector));
      }
    }
  } catch (error) {
    report.runtimeError = firstLine(error);
  } finally {
    await context?.close().catch(() => {});
  }

  for (const [name, selector] of Object.entries(target.selectors)) {
    if (!report.selectors.some((item) => item.name === name)) {
      report.selectors.push({ name, selector, count: 0, visible: 0, ok: false, error: '页面不可用，未执行检查' });
    }
  }
  report.ok =
    report.httpOk &&
    report.hostOk &&
    report.challengeDetected === false &&
    report.selectors.every((selector) => selector.ok) &&
    !report.runtimeError;

  printReport(report, index, total);
  return report;
}

let args;
let loaded;
let options;
try {
  args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  loaded = loadTargets(args.targetsFile);
  options = {
    timeoutMs: parseIntegerEnv('SITE_SMOKE_TIMEOUT_MS', 45_000, 1_000, 120_000),
    settleMs: parseIntegerEnv('SITE_SMOKE_SETTLE_MS', 2_500, 0, 30_000),
    headless: parseBooleanEnv('SITE_SMOKE_HEADLESS', true),
  };
} catch (error) {
  console.error(`配置错误: ${firstLine(error)}`);
  process.exit(2);
}

console.log('多站点公开登录页只读烟雾测试');
console.log(`目标来源: ${loaded.source}`);
console.log(`目标数量: ${loaded.targets.length}`);
console.log('安全策略: 无持久化数据、无扩展、无输入、无点击、无登录、无截图；仅允许 GET/HEAD/OPTIONS');

const reports = [];
let browser;
try {
  browser = await chromium.launch({ headless: options.headless });
  for (let index = 0; index < loaded.targets.length; index += 1) {
    reports.push(await auditTarget(browser, loaded.targets[index], index, loaded.targets.length, options));
  }
} catch (error) {
  console.error(`浏览器启动失败: ${firstLine(error)}`);
  process.exitCode = 2;
} finally {
  await browser?.close().catch(() => {});
}

if (reports.length) {
  const passed = reports.filter((report) => report.ok).length;
  console.log(`\n汇总: ${passed}/${reports.length} 个站点通过`);
  for (const report of reports) console.log(`  ${report.ok ? 'PASS' : 'FAIL'} ${report.target.name}`);
  process.exitCode = passed === reports.length ? 0 : 1;
}
