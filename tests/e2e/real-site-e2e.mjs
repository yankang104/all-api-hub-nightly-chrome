/**
 * 真实站点端到端测试（会真的登录、真的签到）。
 *
 * 与 e2e.mjs 的区别：e2e.mjs 打的是 tests/fixture 里我们自己造的假站点，
 * 页面结构完全符合预期，所以它只能证明「没写坏原有逻辑」，
 * 证明不了真站点能签上 —— 真站点的 SPA 渲染时机、按钮文案、盾页
 * 都不受我们控制。这个脚本补的正是这一段。
 *
 * 安全约定：
 *  - 凭据只从项目外的 CSV 读（见 credentials.mjs），密码永不进日志
 *  - 密码只经 chrome.storage.local 交给扩展，不进命令行参数
 *  - --profile 复用的目录含登录 cookie，放在项目外且已在 .gitignore
 *
 * 关于浏览器：默认用你本机的**真 Chrome**（--real，推荐）。
 *
 * 原因是实测出来的：Playwright 自带的 Chromium 会带 --enable-automation，
 * navigator.webdriver 为 true。Turnstile 评的是运行环境而不是点击动作，
 * 一看见自动化标记就拒发令牌 —— 表现为「人工点了也验证失败」，
 * 而同一个账号在你自己的 Chrome 里点一下就过。这与点击速度无关。
 *
 * --real 模式下由 Chrome 自己启动并开调试端口，脚本只通过 CDP 连上去
 * 读状态、发消息，不改动浏览器指纹。默认仍由用户完成验证码；只有显式
 * 传入 --human-mouse-challenge（且用户已授权）时，才用真实 mouse 事件沿
 * 缓动轨迹点击可见控件，不注入令牌、不改验证脚本、不伪造通过结果。
 *
 * 用法：
 *   node tests/real-site-e2e.mjs --site 100x --real            # 真 Chrome（推荐）
 *   node tests/real-site-e2e.mjs --site 100x --real --keep     # 跑完不关，便于人工接管
 *   node tests/real-site-e2e.mjs --site 100x                   # Playwright Chromium（会被 Turnstile 拒）
 */
import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, homedir } from 'node:os';
import { credentialsFor } from './credentials.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXT = join(ROOT, '.output', 'chrome-mv3');
const CDP_PORT_BASE = 9222;

/** 每个持久 profile 使用独立调试端口，避免新测试连到残留浏览器。 */
function debugPortFor(profileName) {
  let hash = 0;
  for (const char of profileName) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return CDP_PORT_BASE + 1 + (hash % 500);
}

/** 本机真 Chrome 的常见安装位置 */
const CHROME_CANDIDATES = [
  join(process.env['ProgramFiles'] ?? 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
  join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
  join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
];

function findChrome() {
  return CHROME_CANDIDATES.find((p) => p && existsSync(p)) ?? '';
}

function cubicBezier(start, control1, control2, end, t) {
  const mt = 1 - t;
  return {
    x: mt ** 3 * start.x + 3 * mt ** 2 * t * control1.x + 3 * mt * t ** 2 * control2.x + t ** 3 * end.x,
    y: mt ** 3 * start.y + 3 * mt ** 2 * t * control1.y + 3 * mt * t ** 2 * control2.y + t ** 3 * end.y,
  };
}

/** 用真实 Playwright mouse 事件沿缓动曲线移动并单击一次。 */
async function humanMouseClick(page, target) {
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const direction = Math.random() < 0.5 ? -1 : 1;
  const start = {
    x: Math.max(16, Math.min(viewport.width - 16, target.x + direction * (140 + Math.random() * 180))),
    y: Math.max(16, Math.min(viewport.height - 16, target.y + (Math.random() - 0.5) * 220)),
  };
  const control1 = {
    x: start.x + (target.x - start.x) * 0.3,
    y: start.y + (Math.random() - 0.5) * 90,
  };
  const control2 = {
    x: start.x + (target.x - start.x) * 0.75,
    y: target.y + (Math.random() - 0.5) * 55,
  };
  const steps = 28 + Math.floor(Math.random() * 15);

  await page.mouse.move(start.x, start.y);
  await page.waitForTimeout(90 + Math.floor(Math.random() * 130));
  for (let index = 1; index <= steps; index += 1) {
    const t = index / steps;
    const eased = t * t * (3 - 2 * t);
    const point = cubicBezier(start, control1, control2, target, eased);
    const jitter = index === steps ? 0 : (Math.random() - 0.5) * 1.4;
    await page.mouse.move(point.x + jitter, point.y - jitter);
    await page.waitForTimeout(7 + Math.floor(Math.random() * 12));
  }
  await page.waitForTimeout(180 + Math.floor(Math.random() * 220));
  await page.mouse.down();
  await page.waitForTimeout(70 + Math.floor(Math.random() * 90));
  await page.mouse.up();
}

async function viewportToScreenPoint(page, target) {
  return page.evaluate(({ x, y }) => {
    const sideBorder = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
    const topChrome = Math.max(0, window.outerHeight - window.innerHeight - sideBorder);
    return {
      x: Math.round(window.screenX + sideBorder + x),
      y: Math.round(window.screenY + topChrome + y),
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
    };
  }, target);
}

function runWindowsMouseClick(target) {
  const direction = Math.random() < 0.5 ? -1 : 1;
  const start = {
    x: Math.max(8, Math.min(target.screenWidth - 8, target.x + direction * (120 + Math.random() * 160))),
    y: Math.max(8, Math.min(target.screenHeight - 8, target.y + (Math.random() - 0.5) * 160)),
  };
  const control1 = {
    x: start.x + (target.x - start.x) * 0.3,
    y: start.y + (Math.random() - 0.5) * 70,
  };
  const control2 = {
    x: start.x + (target.x - start.x) * 0.78,
    y: target.y + (Math.random() - 0.5) * 45,
  };
  const points = [];
  const steps = 34 + Math.floor(Math.random() * 12);
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    const eased = t * t * (3 - 2 * t);
    const point = cubicBezier(start, control1, control2, target, eased);
    points.push([Math.round(point.x), Math.round(point.y)]);
  }

  const psPoints = points.map(([x, y]) => `@(${x},${y})`).join(',');
  const script = `
Add-Type -Namespace Win32 -Name NativeMouse -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetCursorPos(int X, int Y);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, System.UIntPtr dwExtraInfo);
"@
$points = @(${psPoints})
foreach ($p in $points) {
  [Win32.NativeMouse]::SetCursorPos([int]$p[0], [int]$p[1]) | Out-Null
  Start-Sleep -Milliseconds 11
}
Start-Sleep -Milliseconds 160
[Win32.NativeMouse]::mouse_event(0x0002, 0, 0, 0, [System.UIntPtr]::Zero)
Start-Sleep -Milliseconds 90
[Win32.NativeMouse]::mouse_event(0x0004, 0, 0, 0, [System.UIntPtr]::Zero)
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `powershell exited ${result.status}`).trim());
  }
}

async function osMouseClick(page, target) {
  if (process.platform !== 'win32') return false;
  const screenTarget = await viewportToScreenPoint(page, target);
  if (
    screenTarget.x < 0 ||
    screenTarget.y < 0 ||
    screenTarget.x > screenTarget.screenWidth ||
    screenTarget.y > screenTarget.screenHeight
  ) {
    return false;
  }
  runWindowsMouseClick(screenTarget);
  return true;
}

async function turnstileCompletionState(page) {
  return page.evaluate(() => {
    const token = document.querySelector('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]');
    const tokenValue = token && 'value' in token ? String(token.value ?? '').trim() : '';
    const submit = document.querySelector('button[type="submit"], input[type="submit"]');
    const submitDisabled = submit && 'disabled' in submit ? Boolean(submit.disabled) : null;
    const visibleWidget = [...document.querySelectorAll('.cf-turnstile, .turnstile-wrapper, [class*="turnstile" i]')]
      .some((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      });
    return {
      token: tokenValue.length > 0,
      submitEnabled: submitDisabled === false,
      visibleWidget,
    };
  }).catch(() => ({ token: false, submitEnabled: false, visibleWidget: false }));
}

async function waitForTurnstileCompletion(page, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await turnstileCompletionState(page);
    if (last.token || last.submitEnabled || !last.visibleWidget) return { ok: true, state: last };
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return { ok: false, state: last };
}

/** 找到页面上可见的 Turnstile，并点击其复选框区域。 */
async function completeTurnstileWithHumanMouse(page) {
  await page.bringToFront();
  const candidates = [
    'iframe[src*="challenges.cloudflare.com"]',
    'iframe[title*="Cloudflare" i]',
    'iframe[title*="challenge" i]',
    '.cf-turnstile',
    '.turnstile-wrapper',
  ];

  for (const selector of candidates) {
    const matches = page.locator(selector);
    for (let index = 0; index < await matches.count(); index += 1) {
      const element = matches.nth(index);
      if (!await element.isVisible().catch(() => false)) continue;
      const box = await element.boundingBox().catch(() => null);
      if (!box || box.width < 20 || box.height < 20) continue;

      const targetPoints = [
        { x: box.x + Math.min(34, Math.max(22, box.width * 0.11)), y: box.y + box.height / 2 },
        { x: box.x + Math.min(48, Math.max(30, box.width * 0.16)), y: box.y + box.height / 2 },
        { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      ];

      for (let attempt = 0; attempt < targetPoints.length; attempt += 1) {
        const target = targetPoints[attempt];
        console.log(`   [模拟鼠标] 沿缓动轨迹移动到 Turnstile（${selector}）并单击 ${attempt + 1}/${targetPoints.length}`);
        await humanMouseClick(page, target);
        const completed = await waitForTurnstileCompletion(page);
        if (completed.ok) {
          console.log(
            `   [模拟鼠标] Turnstile 状态: token=${completed.state.token} submitEnabled=${completed.state.submitEnabled} visible=${completed.state.visibleWidget}`,
          );
          return true;
        }

        const osClicked = await osMouseClick(page, target).catch((error) => {
          console.log(`   [系统鼠标] 执行失败: ${String(error).split('\n')[0]}`);
          return false;
        });
        if (osClicked) {
          console.log('   [系统鼠标] 已用 Windows 原生鼠标事件单击同一位置');
          const osCompleted = await waitForTurnstileCompletion(page, 10_000);
          if (osCompleted.ok) {
            console.log(
              `   [系统鼠标] Turnstile 状态: token=${osCompleted.state.token} submitEnabled=${osCompleted.state.submitEnabled} visible=${osCompleted.state.visibleWidget}`,
            );
            return true;
          }
        }
      }
    }
  }

  return false;
}

/**
 * 从 profile 的 Preferences 里按安装目录反查扩展 id。
 *
 * 不用 chrome://extensions 的 shadow DOM，也不用 service worker URL：
 * 前者在 CDP 下未必可读，后者认不出是哪个扩展（同名文件太多）。
 * Preferences 里记的是「id → 安装路径」，按路径匹配才是确定的。
 */
function findExtensionId(profileDir, extDir) {
  const prefs = join(profileDir, 'Default', 'Preferences');
  if (!existsSync(prefs)) return null;
  let data;
  try {
    data = JSON.parse(readFileSync(prefs, 'utf8'));
  } catch {
    return null;
  }
  const settings = data?.extensions?.settings ?? {};
  const want = extDir.replace(/[\\/]+/g, '\\').toLowerCase();
  for (const [id, info] of Object.entries(settings)) {
    const path = String(info?.path ?? '').replace(/[\\/]+/g, '\\').toLowerCase();
    if (path === want) return id;
  }
  return null;
}

function valuesForKey(value, wanted, out = []) {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    value.forEach((item) => valuesForKey(item, wanted, out));
    return out;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === wanted) out.push(item);
    valuesForKey(item, wanted, out);
  }
  return out;
}

function firstBoolean(value, key) {
  return valuesForKey(value, key).find((item) => typeof item === 'boolean');
}

function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const parsed = Number(value.replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function firstNumber(value, key) {
  for (const item of valuesForKey(value, key)) {
    const parsed = asNumber(item);
    if (parsed != null) return parsed;
  }
  return null;
}

function firstString(value, key) {
  return valuesForKey(value, key).find((item) => typeof item === 'string') ?? null;
}

function responseClaimsSuccess(value) {
  const successes = valuesForKey(value, 'success').filter((item) => typeof item === 'boolean');
  if (successes.includes(false) && !successes.includes(true)) return false;
  if (successes.includes(true)) return true;

  const codes = valuesForKey(value, 'code');
  if (codes.some((code) => code === 0 || code === 200 || String(code).toLowerCase() === 'success')) return true;

  const messages = [...valuesForKey(value, 'message'), ...valuesForKey(value, 'msg')]
    .filter((item) => typeof item === 'string');
  return messages.some((message) => /签到成功|check[\s-]?in\s+success|checked\s+in\s+successfully/i.test(message));
}

function collectHistoryRecords(value, out = []) {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const entries = Object.entries(item);
        const date = entries.find(([key, field]) => /(?:check.?in.?date|date|created_at)/i.test(key) && typeof field === 'string')?.[1];
        const rewardRaw = entries.find(([key]) => /(?:reward|amount|bonus)/i.test(key))?.[1];
        const reward = asNumber(rewardRaw);
        if (typeof date === 'string' && reward != null) out.push({ date, reward });
      }
      collectHistoryRecords(item, out);
    }
    return out;
  }
  Object.values(value).forEach((item) => collectHistoryRecords(item, out));
  return out;
}

/** new-api 系通用选择器（semi-ui 皮肤） */
const NEW_API_SELECTORS = {
  username: '#username, input[name="username"]',
  password: '#password, input[name="password"]',
  submit: 'button.semi-button-primary.w-full, button[type="submit"]',
};

/**
 * Sub2API 系选择器（Tailwind 皮肤）。
 * 2026-08-11 实测 sub.100xlabs.space：登录框是 #email 而非 #username，
 * 提交按钮是 .btn.btn-primary，标题「登录 - Sub2API」，登录页带 Turnstile。
 */
const SUB2API_SELECTORS = {
  username: '#email, input[type="email"], input[name="email"]',
  password: '#password, input[type="password"]',
  submit: 'button.btn.btn-primary, button[type="submit"]',
};

const NEW_API_MODALS = [
  '.semi-modal-close',
  '.semi-modal-footer button.semi-button-tertiary',
  '[aria-label="close" i]',
  '[aria-label*="关闭"]',
  '.ant-modal-close',
  '.ant-modal-close-x',
  '.modal-close',
  'button.close',
  '.close-btn',
];

/** 站点表：credentialPattern 用于在 CSV 里定位账号 */
const SITES = {
  '100x': {
    credentialPattern: '100xlabs',
    family: 'sub2api',
    site: {
      id: 'real-100x',
      name: '百倍',
      loginUrl: 'https://sub.100xlabs.space/login',
      loginMethod: 'auto',
      selectors: SUB2API_SELECTORS,
      closeModalSelectors: NEW_API_MODALS,
      // 关键：用 auto 让扩展自己找签到页和按钮，这正是本轮要验证的那条路
      checkin: { method: 'auto', url: '/check-in' },
      adapter: { siteType: 'sub2api' },
    },
  },
  keimeng: {
    credentialPattern: 'api456',
    family: 'new-api',
    site: {
      id: 'real-keimeng',
      name: '可萌中转站',
      loginUrl: 'https://api456.me/login',
      loginMethod: 'auto',
      selectors: NEW_API_SELECTORS,
      closeModalSelectors: NEW_API_MODALS,
      checkin: { method: 'auto', url: '/console/personal' },
      adapter: { siteType: 'new-api' },
    },
  },
  '1412': {
    credentialPattern: null,
    family: 'new-api',
    site: {
      id: 'real-1412',
      name: "1412's API",
      loginUrl: 'https://napi.kid1412.qzz.io/sign-in?redirect=%2Fprofile',
      loginMethod: 'oauth',
      oauthButtonSelector: 'text=GitHub',
      // 实测（2026-08-18）：输入框 id 是 React 动态生成的 #_r_2_-form-item，
      // 只能按 name 选；账密表单在登录页直接可见，不需要前置展开点击。
      selectors: {
        username: 'input[name="username"]',
        password: 'input[name="password"]',
        submit: 'button[type="submit"]',
      },
      closeModalSelectors: NEW_API_MODALS,
      successIndicator: 'a[href="/keys"], a[href="/wallet"]',
      // 签到入口和终态文案尚未在真实页面确认，先用 auto 让引擎自己发现，
      // 由本轮日志回写确切选择器，避免继续沿用猜测值。
      checkin: { method: 'auto', url: '/profile' },
      adapter: { siteType: 'new-api', family: 'new-api', checkinPath: '/profile', quotaPerUnit: 500_000 },
    },
  },
  k40: {
    credentialPattern: 'shengqainbang',
    family: 'sub2api',
    site: {
      id: 'real-k40',
      name: '盛淇帮K40',
      loginUrl: 'https://k40.shengqainbang.cn/login',
      loginMethod: 'auto',
      selectors: SUB2API_SELECTORS,
      closeModalSelectors: NEW_API_MODALS,
      checkin: { method: 'auto', url: '/check-in' },
      adapter: { siteType: 'sub2api' },
    },
  },
  sharedchat: {
    credentialPattern: 'sharedchat',
    family: 'new-api',
    site: {
      id: 'real-sharedchat',
      name: 'SharedChat Codex 权益',
      loginUrl: 'https://new.sharedchat.cc/list/#/login',
      pointerMode: 'trusted',
      loginMethod: 'auto',
      selectors: {
        username: 'input[placeholder*="用户名"], input[placeholder*="邮箱"]',
        password: 'input[type="password"]',
        submit: 'button.submit-btn, button >> text=用户登录',
      },
      closeModalSelectors: NEW_API_MODALS,
      // 登录页没有这些控制台专属控件，命中任一即确认已登录
      successIndicator: 'button.refresh-btn, button.invite-entry-button, button.el-button--primary.el-button--large',
      checkin: {
        method: 'claim',
        url: '/list/#/vibe-code/dashboard?activeMenu=dashboard&service=codex',
        claimEntrySelector: 'button >> text=领取 Codex 权益',
        claimInputSelector: 'textarea, .modal textarea, [role="dialog"] textarea',
        claimSubmitSelector: 'button >> text=领取',
        claimMinLength: 10,
        claimUniqueText: true,
        // 实测：领取成功后卡片从「已过期」变「生效中」、领取按钮消失
        successText: ['领取成功', '权益已领取', '已生效', '生效中'],
        alreadyText: ['已领取', '今日已领取'],
      },
      adapter: { siteType: 'new-api' },
    },
  },
  agentrouter: {
    credentialPattern: null,
    family: 'new-api',
    site: {
      id: 'real-agentrouter',
      name: 'Agent Router',
      loginUrl: 'https://agentrouter.org/',
      // 站点用 window.open 打开 GitHub 授权页，只有可信指针算用户手势
      pointerMode: 'trusted',
      loginMethod: 'github',
      oauthButtonSelector: 'text=GitHub',
      selectors: {
        username: '#username, input[name="username"]',
        password: '#password, input[name="password"]',
        submit: 'button[type="submit"]',
      },
      closeModalSelectors: [
        'button >> text=关闭公告',
        'button >> text=今日关闭',
        ...NEW_API_MODALS,
      ],
      successIndicator: 'a[href="/console/token"], a[href="/console/topup"]',
      checkin: {
        method: 'relogin',
        url: '/console',
        logoutApiUrl: '/api/user/logout',
        logoutMenuSelector: '.semi-navigation-footer .semi-avatar, .semi-navigation-footer .semi-dropdown',
        logoutSelector: 'text=退出',
      },
      adapter: { siteType: 'new-api' },
    },
  },
  /**
   * AnyRouter：登录即签到，站点上没有签到按钮。
   *
   * 这份配置刻意与 src/sites/index.ts 的 ANYROUTER_TEMPLATE 保持一致 ——
   * 真实站点测试的意义就是验证**实际发出去的那份配置**。以前这里测的是
   * oauth + relogin，而内置卡片走的是账密 + 登录即签到，跑通了也证明不了
   * 用户手上那条路能用。
   *
   * 想验证「每轮都强制拿奖励」那条更强的路径，把 checkin 换成
   * `{ method: 'relogin', url: '/console', logoutApiUrl: '/api/user/logout' }`
   * 单独跑一次 —— 那是站点编辑里可选的配置，不是默认。
   */
  anyrouter: {
    credentialPattern: 'anyrouter',
    family: 'new-api',
    site: {
      id: 'real-anyrouter',
      name: 'AnyRouter',
      loginUrl: 'https://anyrouter.top/login',
      loginMethod: 'auto',
      selectors: NEW_API_SELECTORS,
      closeModalSelectors: NEW_API_MODALS,
      successIndicator: 'a[href="/console/token"], a[href="/console/topup"]',
      checkin: { method: 'none' },
      // checkinPath 空串关掉 new-api 家族默认的 /console/personal 兜底跳转
      adapter: { siteType: 'anyrouter', family: 'new-api', checkinPath: '', quotaPerUnit: 500_000 },
    },
  },
  futurehub: {
    credentialPattern: 'futureppo',
    family: 'new-api',
    site: {
      id: 'real-futurehub',
      name: 'Future Hub',
      loginUrl: 'https://api.futureppo.top/login',
      loginMethod: 'auto',
      selectors: NEW_API_SELECTORS,
      closeModalSelectors: NEW_API_MODALS,
      // 真实流程：个人设置的「每日签到」卡片必须点击右侧按钮，成功后才变为「今日已签到」。
      checkin: {
        method: 'button',
        url: '/console/personal',
        buttonSelector: 'button >> text=立即签到',
        alreadySelector: 'button >> text=今日已签到',
        alreadyText: ['今日已签到'],
      },
      adapter: { siteType: 'new-api' },
    },
  },
  denxio: {
    credentialPattern: 'denxio',
    family: 'new-api',
    site: {
      id: 'real-denxio',
      name: '登仙公益站',
      loginUrl: 'https://api.denxio.top/login',
      loginMethod: 'form',
      // 实测登录页：input[type=email] + #password + button[type=submit]（非 semi 皮肤）
      selectors: {
        username: 'input[type="email"], #email, input[name="email"]',
        password: '#password, input[type="password"]',
        submit: 'button[type="submit"]',
      },
      closeModalSelectors: NEW_API_MODALS,
      // 真实入口是不带连字符的 /checkin；签到后还要等「赞助人鸣谢」弹窗解锁领取按钮。
      checkin: {
        method: 'auto',
        url: '/checkin',
        buttonSelector: 'button >> text=立即签到',
        alreadySelector: 'button >> text=今日已签到, button >> text=今天已签到, button >> text=已签到',
        claimConfirmSelector: 'button >> text=领取奖励',
      },
      // 实测是 sub2api 系（localStorage auth_token/auth_user，/api/v1/auth/me 返回 balance）
      adapter: {
        siteType: 'sub2api',
        family: 'sub2api',
        checkinPath: '/checkin',
        quotaPerUnit: 1,
      },
    },
  },
  agentrouter: {
    // GitHub OAuth 登录，凭据在浏览器 profile 里，不从 CSV 取
    credentialPattern: null,
    family: 'new-api',
    site: {
      id: 'real-agentrouter',
      name: 'Agent Router',
      loginUrl: 'https://agentrouter.org/login',
      pointerMode: 'trusted',
      loginMethod: 'oauth',
      oauthButtonSelector: 'text=GitHub',
      selectors: NEW_API_SELECTORS,
      closeModalSelectors: NEW_API_MODALS,
      successIndicator: 'a[href="/console"], a[href="/console/token"], a[href="/console/topup"]',
      // 奖励靠退出再登录发放；GET /api/user/logout 实测返回 {"success":true}
      checkin: {
        method: 'relogin',
        url: '/console',
        logoutApiUrl: '/api/user/logout',
        logoutMenuSelector: '.semi-navigation-footer .semi-avatar, .semi-navigation-footer .semi-dropdown',
        logoutSelector: 'text=退出',
      },
      adapter: { siteType: 'new-api' },
    },
  },
};

function parseArgs(argv) {
  const out = {
    site: '100x',
    waitMs: 180_000,
    proxy: '',
    keep: false,
    profile: false,
    real: false,
    systemChrome: false,
    humanMouseChallenge: false,
    credentialIndex: 0,
    profileName: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--site') (out.site = argv[i + 1] ?? ''), (i += 1);
    else if (a === '--wait') (out.waitMs = Number(argv[i + 1]) || out.waitMs), (i += 1);
    else if (a === '--proxy') (out.proxy = argv[i + 1] ?? ''), (i += 1);
    else if (a === '--keep') out.keep = true;
    else if (a === '--profile') out.profile = true;
    else if (a === '--real') out.real = true;
    else if (a === '--system-chrome') (out.systemChrome = true), (out.real = true);
    else if (a === '--human-mouse-challenge') out.humanMouseChallenge = true;
    else if (a === '--credential-index') (out.credentialIndex = Number(argv[i + 1])), (i += 1);
    else if (a === '--profile-name') (out.profileName = argv[i + 1] ?? ''), (i += 1);
    else throw new Error(`未知参数: ${a}`);
  }
  if (out.profileName && !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(out.profileName)) {
    throw new Error('--profile-name 只允许 1-80 位字母、数字、点、下划线和连字符');
  }
  // 独立 profile 目录启动，不会附到你已开着的浏览器上
  if (out.real) out.profile = true;
  return out;
}

const args = parseArgs(process.argv.slice(2));
const entry = SITES[args.site];
if (!entry) {
  console.error(`未知站点 ${args.site}，可选: ${Object.keys(SITES).join(', ')}`);
  process.exit(2);
}

const creds = entry.credentialPattern
  ? credentialsFor(entry.credentialPattern)
  : [{ username: 'GitHub OAuth', password: '' }];
if (!creds.length) {
  console.error(`凭据库里没有匹配 "${entry.credentialPattern}" 的账号`);
  process.exit(2);
}
if (!Number.isInteger(args.credentialIndex) || args.credentialIndex < 0 || args.credentialIndex >= creds.length) {
  console.error(`凭据序号 ${args.credentialIndex} 无效；该站点共有 ${creds.length} 个凭据（从 0 开始）`);
  process.exit(2);
}
const cred = creds[args.credentialIndex];

const SITE = entry.site;
const ACCOUNT = {
  id: 'acc-real',
  siteId: SITE.id,
  username: cred.username,
  password: cred.password,
  label: cred.username,
  ...(args.site === 'agentrouter'
    ? {
        githubUsername: process.env.AGENTROUTER_GITHUB_USERNAME ?? '',
        githubPassword: process.env.AGENTROUTER_GITHUB_PASSWORD ?? '',
      }
    : {}),
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? `  — ${detail}` : ''}`);
};

console.log('真实站点端到端测试');
console.log(`站点: ${SITE.name}  ${SITE.loginUrl}`);
console.log(entry.credentialPattern
  ? `账号: ${ACCOUNT.username}（密码来自本机凭据库，不会输出）`
  : `账号: ${ACCOUNT.username}（浏览器 OAuth 登录态）`);
console.log(`登录方式: ${SITE.loginMethod}   签到方式: ${SITE.checkin.method}`);
if (args.proxy) console.log(`代理: ${args.proxy}`);

// 复用 profile 时目录放在项目外：里面有真实登录 cookie，不能进仓库。
// 真 Chrome 与 Playwright Chromium 版本不同，共用一个 profile 目录会互相
// 升级/拒绝，所以分开放。
const PERSISTENT_PROFILE = join(
  homedir(),
  '.checkin-e2e-profiles',
  args.profileName || (args.real ? `${args.site}-chrome` : args.site),
);
const profile = args.profile ? PERSISTENT_PROFILE : mkdtempSync(join(tmpdir(), 'real-site-e2e-'));
const CDP_PORT = debugPortFor(args.profileName || (args.real ? `${args.site}-chrome` : args.site));
if (args.profile) {
  mkdirSync(profile, { recursive: true });
  console.log(`登录态目录: ${profile}`);
}

let ctx;
let browser = null;
let chromeProc = null;

async function connectRealController(attempts = 30) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 500));
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`).catch(() => null);
    if (browser) {
      ctx = browser.contexts()[0];
      return true;
    }
  }
  return false;
}

if (args.real) {
  // ── 干净指纹模式 ──
  //
  // 实测结论（2026-08-11）：
  //  1. Playwright 用 launchPersistentContext 启动时会加 --enable-automation
  //     等参数，navigator.webdriver 变 true，Turnstile 直接拒发令牌 ——
  //     表现为「人工点了也验证失败」，与点击速度无关。
  //  2. 本机 Chrome 151 已彻底忽略 --load-extension，连
  //     DisableLoadExtensionCommandLineSwitch 这个 feature 开关也救不回来，
  //     扩展装不上。
  //
  // 所以两者都不用：自己 spawn Playwright 自带的 Chromium 二进制，
  // 但不传任何自动化参数。它认 --load-extension（原有 e2e 就靠它装扩展），
  // 而 webdriver 标记来自启动参数而非浏览器本身，不传就没有。
  // 这样扩展能自动装上、指纹也是干净的，无需人工介入。
  const chromePath = args.systemChrome ? findChrome() : chromium.executablePath();
  if (!chromePath) {
    console.error('找不到可用的浏览器二进制');
    process.exit(2);
  }
  console.log(`浏览器: ${chromePath}`);
  if (args.systemChrome) {
    console.log('⚠ 系统 Chrome 151 不认 --load-extension，需要人工装一次扩展');
  }

  const chromeArgs = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    // 关键：不加 --enable-automation，navigator.webdriver 才是 false
    ...(args.systemChrome
      ? []
      : [
          `--load-extension=${EXT}`,
          `--disable-extensions-except=${EXT}`,
          // 实测必需（tests/probe-flags.mjs）：Chromium 自带 3 个组件扩展
          // 也跑 background，不关掉的话它们的 service worker 混在列表里，
          // 按 URL 认 id 会认成组件扩展。关掉后只剩我们这一个。
          '--disable-component-extensions-with-background-pages',
        ]),
    ...(args.proxy ? [`--proxy-server=${args.proxy}`] : []),
    'about:blank',
  ];

  chromeProc = spawn(chromePath, chromeArgs, { detached: false, stdio: 'ignore' });

  // 等调试端口起来
  if (!await connectRealController()) {
    chromeProc.kill();
    // 用的是独立 --user-data-dir，正常不会附到你已开着的 Chrome 上；
    // 真连不上一般是端口被占，换 --port 即可。
    console.error(`无法连接 Chrome 调试端口 ${CDP_PORT}（可能被占用）`);
    process.exit(2);
  }
  // 确认指纹真的是干净的 —— 这是本模式存在的全部意义，值得当场验一下
  const fpPage = await ctx.newPage();
  const fp = await fpPage
    .evaluate(() => ({ webdriver: navigator.webdriver, ua: navigator.userAgent }))
    .catch(() => null);
  await fpPage.close().catch(() => {});
  if (fp) {
    console.log(`navigator.webdriver = ${fp.webdriver}${fp.webdriver ? '  ⚠ 仍带自动化标记' : '  ✓ 干净'}`);
  }
} else {
  try {
    ctx = await chromium.launchPersistentContext(profile, {
      headless: false,
      ...(args.proxy ? { proxy: { server: args.proxy } } : {}),
      args: [
        `--disable-extensions-except=${EXT}`,
        `--load-extension=${EXT}`,
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });
  } catch (error) {
    if (!args.profile) rmSync(profile, { recursive: true, force: true });
    throw error;
  }
  console.log('⚠ 使用 Playwright 自带 Chromium：带自动化标记，Turnstile 大概率拒绝放行');
}

try {
  let extId = null;

  if (args.real) {
    // 先查 Preferences 里记录的安装目录（人工装的一定在这里）
    for (let i = 0; i < 10 && !extId; i += 1) {
      extId = findExtensionId(profile, EXT);
      if (!extId) await new Promise((r) => setTimeout(r, 500));
    }

    // 命令行装的扩展不一定写进 Preferences，改用「能否打开我们自己的
    // options.html」来认。靠 service worker 文件名（background.js）会
    // 撞上 Chromium 内置组件扩展，抓到的 id 是别人的。
    if (!extId) {
      const probe = await ctx.newPage();
      for (let round = 0; round < 12 && !extId; round += 1) {
        const ids = new Set(
          ctx.serviceWorkers?.()
            .filter((w) => w.url().startsWith('chrome-extension://'))
            .map((w) => new URL(w.url()).hostname) ?? [],
        );
        for (const id of ids) {
          const ok = await probe
            .goto(`chrome-extension://${id}/options.html`, { timeout: 5000 })
            .then(() => probe.evaluate(() => document.title))
            .then((title) => title.includes('签到') || title.includes('中转'))
            .catch(() => false);
          if (ok) {
            extId = id;
            break;
          }
        }
        if (!extId) await new Promise((r) => setTimeout(r, 1000));
      }
      await probe.close().catch(() => {});
    }

    // 只有系统 Chrome 才需要人工装（它不认 --load-extension）
    if (!extId && args.systemChrome) {
      const guide = await ctx.newPage();
      await guide.goto('chrome://extensions').catch(() => {});
      console.log('\n' + '─'.repeat(64));
      console.log('需要先在这个 Chrome 里手动装一次扩展（只需一次，之后复用）：');
      console.log('  1. 已经帮你打开 chrome://extensions');
      console.log('  2. 右上角打开「开发者模式」');
      console.log('  3. 点「加载已解压的扩展程序」，选择目录：');
      console.log(`     ${EXT}`);
      console.log('装好后本脚本会自动继续。');
      console.log('─'.repeat(64) + '\n');

      const installDeadline = Date.now() + 300_000;
      while (Date.now() < installDeadline && !extId) {
        await new Promise((r) => setTimeout(r, 2000));
        extId = findExtensionId(profile, EXT);
      }
      await guide.close().catch(() => {});
      if (!extId) throw new Error('等待安装超时');
      console.log('检测到扩展已安装，继续。');
    }
    if (!extId) throw new Error('扩展未加载：--load-extension 未生效');

    // 人工装的扩展会一直是当时那份代码，需要显式重载才能跑到新构建；
    // 命令行装的每次启动就是磁盘上的最新版本，不必重载。
    if (args.systemChrome) {
      const reloader = await ctx.newPage();
      const reloadOk = await reloader
        .goto(`chrome-extension://${extId}/options.html`)
        .then(() => reloader.evaluate(() => { chrome.runtime.reload(); return true; }))
        .catch(() => false);
      await reloader.close().catch(() => {});
      if (reloadOk) {
        console.log('已让扩展从磁盘重载，确保跑的是最新构建');
        await new Promise((r) => setTimeout(r, 2500));
      }
    }
  } else {
    // Playwright Chromium：命令行装的，从 service worker 拿 id
    for (let i = 0; i < 20 && !extId; i += 1) {
      const sw = ctx.serviceWorkers?.().find((w) => w.url().endsWith('/background.js'));
      if (sw) extId = new URL(sw.url()).hostname;
      else await new Promise((r) => setTimeout(r, 500));
    }
  }

  check('扩展加载成功', !!extId, `id=${extId}`);
  if (!extId) throw new Error('无法确定扩展 ID');

  let ext = await ctx.newPage();
  await ext.goto(`chrome-extension://${extId}/options.html`);
  await ext.waitForLoadState('domcontentloaded');

  const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const detachedTitlePrefix = `__real_site_e2e_${Date.now()}__:`;
  const detachedStartKey = '__realSiteE2EStart';

  async function ensureExtensionPage() {
    if (ext && !ext.isClosed()) return ext;
    ext = ctx.pages().find((page) => page.url().startsWith(`chrome-extension://${extId}/options.html`));
    if (!ext) {
      ext = await ctx.newPage();
      await ext.goto(`chrome-extension://${extId}/options.html`);
      await ext.waitForLoadState('domcontentloaded');
    }
    return ext;
  }

  async function readAutomationState() {
    try {
      const page = await ensureExtensionPage();
      return await page.evaluate(async () => {
        const r = await chrome.storage.local.get(['status', 'results']);
        return { status: r.status ?? {}, results: r.results ?? {} };
      });
    } catch (error) {
      console.log(`   [状态] 读取扩展状态失败: ${String(error).split('\n')[0]}`);
      return null;
    }
  }

  async function readStartReceipt() {
    const page = await ensureExtensionPage();
    return page.evaluate(async (key) => {
      const value = (await chrome.storage.local.get(key))[key] ?? null;
      await chrome.storage.local.remove(key);
      return value;
    }, detachedStartKey);
  }

  async function disconnectRealController() {
    if (!args.real || !browser?.isConnected()) return;
    await browser.close();
    browser = null;
    ext = null;
  }

  async function reconnectRealController() {
    if (!args.real) return;
    if (!await connectRealController(20)) throw new Error('真实浏览器仍在运行，但无法重新连接调试端口');
    ext = null;
  }

  async function detachedSignal() {
    const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      .then((response) => response.ok ? response.json() : [])
      .catch(() => []);
    const target = targets.find((item) => (
      typeof item?.url === 'string'
      && item.url.startsWith(`chrome-extension://${extId}/options.html`)
      && typeof item?.title === 'string'
      && item.title.startsWith(detachedTitlePrefix)
    ));
    return target?.title.slice(detachedTitlePrefix.length) ?? '';
  }

  async function waitForDetachedSignal(deadline) {
    let lastSignal = '';
    while (Date.now() < deadline) {
      const signal = await detachedSignal();
      if (signal && signal !== lastSignal) {
        console.log(`   [无控制器状态] ${lastSignal || '(等待启动)'} → ${signal}`);
        lastSignal = signal;
      }
      if (signal === 'attention' || signal === 'done' || signal === 'failed' || signal === 'start-failed') {
        return signal;
      }
      await sleepMs(750);
    }
    return 'timeout';
  }

  function sitePages() {
    return ctx.pages().filter((page) => {
      if (page.isClosed()) return false;
      try {
        return new URL(page.url()).hostname === host;
      } catch {
        return false;
      }
    });
  }

  function activeSitePage(fallback) {
    const pages = sitePages();
    return pages.at(-1) ?? (!fallback?.isClosed?.() ? fallback : null);
  }

  await ext.evaluate(
    async ({ site, account }) => {
      /**
       * 保留上一轮积累的领取理由历史。
       *
       * 直接整体覆盖 sites 会把扩展落盘的 claimUsedTexts 冲掉 —— 于是每轮都从
       * 候选池第一条开始，而站点要求「理由不能与之前重复」，第二轮起必然被拒。
       * 那不是扩展的问题，是载具把状态清干净造成的假失败。
       */
      const previous = await chrome.storage.local.get('sites');
      // 测试临时 ID（real-sharedchat）与扩展正式内置 ID（builtin-chatai-codex）
      // 不同，但它们是同一 ChatAI 权益页。按 ID 只取一种会在 e2e 启动时清掉
      // 已被站点拒过的理由，下一轮又提交第一条而必然失败。合并同源权益站的历史。
      const related = (previous.sites ?? []).filter((item) => (
        item.id === site.id
        || (site.id === 'real-sharedchat' && item.id === 'builtin-chatai-codex')
      ));
      const usedTexts = [...new Set(related.flatMap((item) => item.checkin?.claimUsedTexts ?? []))];
      const merged = usedTexts.length
        ? { ...site, checkin: { ...site.checkin, claimUsedTexts: usedTexts } }
        : site;

      await chrome.storage.local.set({ sites: [merged], accounts: [account], status: {}, results: {} });
      return { keptClaimTexts: usedTexts?.length ?? 0 };
    },
    { site: SITE, account: ACCOUNT },
  ).then((info) => {
    if (info?.keptClaimTexts) console.log(`   已保留 ${info.keptClaimTexts} 条历史领取理由（站点要求不可重复）`);
  });
  check('站点与账号写入成功', true);
  await ext.reload();
  await sleepMs(1200);

  console.log('\n── 触发自动登录签到 ──');
  const host = new URL(SITE.loginUrl).hostname;
  const siteOrigin = new URL(SITE.loginUrl).origin;
  const checkinTraffic = [];
  const trafficTasks = [];
  let trafficSequence = 0;

  const authResponses = [];
  const observedContexts = new WeakSet();

  function observeContextTraffic() {
    if (observedContexts.has(ctx)) return;
    observedContexts.add(ctx);
    ctx.on('response', (response) => {
      let parsed;
      try {
        parsed = new URL(response.url());
      } catch {
        return;
      }
      if (parsed.hostname !== host || !/check-?in/i.test(parsed.pathname)) return;

      const sequence = trafficSequence++;
      const task = (async () => {
        const contentType = response.headers()['content-type']?.toLowerCase() ?? '';
        const body = contentType.includes('json') ? await response.json().catch(() => null) : null;
        checkinTraffic.push({
          sequence,
          method: response.request().method(),
          path: parsed.pathname,
          status: response.status(),
          body,
        });
      })();
      trafficTasks.push(task);
    });
  }

  function observeAuthResponses(page) {
    if (!page) return;
    page.on('response', async (response) => {
      const request = response.request();
      let parsed;
      try {
        parsed = new URL(response.url());
      } catch {
        return;
      }
      if (
        parsed.hostname !== host
        || request.method() === 'GET'
        || !/(?:login|auth|session|token)/i.test(parsed.pathname)
      ) return;

      const record = {
        method: request.method(),
        path: parsed.pathname,
        status: response.status(),
      };
      try {
        const body = await response.json();
        if (body && typeof body === 'object' && !Array.isArray(body)) {
          for (const key of ['success', 'code', 'message', 'error']) {
            const value = body[key];
            if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
              record[key] = String(value).slice(0, 300);
            }
          }
        }
      } catch {
        // 非 JSON 登录响应只保留状态与路径，避免输出页面或令牌内容。
      }
      authResponses.push(record);
    });
  }

  console.log(`等待执行结果（最多 ${Math.round(args.waitMs / 1000)} 秒）...`);

  let finalState = null;
  let lastStatus = '';
  let lastPrompt = '';
  let challengeMouseAttempted = false;
  const deadline = Date.now() + args.waitMs;
  let loginTab = null;

  if (args.real) {
    const scheduled = await ext.evaluate(
      ({ accountId, delayMs, startKey, titlePrefix }) => {
        const publish = (value) => { document.title = `${titlePrefix}${value}`; };
        const statusForAccount = (status) => {
          const entry = Object.entries(status ?? {}).find(([key]) => key.startsWith(`${accountId}:`));
          return entry?.[1] ?? Object.values(status ?? {})[0] ?? '';
        };
        chrome.storage.onChanged.addListener((changes, areaName) => {
          if (areaName !== 'local') return;
          if (changes.status) {
            const value = statusForAccount(changes.status.newValue);
            if (value) publish(value);
          } else if (changes.results) {
            chrome.storage.local.get('status').then(({ status }) => {
              const value = statusForAccount(status);
              if (value === 'attention') publish(value);
            });
          }
        });
        publish('scheduled');
        setTimeout(async () => {
          try {
            const response = await new Promise((resolve) => {
              chrome.runtime.sendMessage({ type: 'START_LOGIN', accountId }, resolve);
            });
            await chrome.storage.local.set({
              [startKey]: {
                ok: response?.ok === true,
                error: response?.ok === true ? '' : String(response?.error ?? 'rejected').slice(0, 200),
              },
            });
            if (response?.ok !== true) publish('start-failed');
          } catch (error) {
            await chrome.storage.local.set({
              [startKey]: { ok: false, error: String(error).slice(0, 200) },
            });
            publish('start-failed');
          }
        }, delayMs);
        return true;
      },
      {
        accountId: 'acc-real',
        delayMs: 3000,
        startKey: detachedStartKey,
        titlePrefix: detachedTitlePrefix,
      },
    );
    check('START_LOGIN 已安排', scheduled === true);
    await disconnectRealController();
    console.log('   [真实浏览器] Playwright/CDP 已断开，扩展独占可信鼠标通道');

    let startChecked = false;
    while (Date.now() < deadline) {
      const signal = await waitForDetachedSignal(deadline);
      await reconnectRealController();
      observeContextTraffic();
      finalState = await readAutomationState();
      if (!startChecked) {
        const started = await readStartReceipt().catch(() => null);
        const terminalStatus = Object.entries(finalState?.status ?? {})
          .find(([key]) => key.startsWith('acc-real:'))?.[1] ?? '';
        // 真实 Chrome 下扩展可能在写入 receipt 前已完成短流程；终态本身
        // 已证明 START_LOGIN 被后台接受，不能把这个正常时序判成启动失败。
        check('START_LOGIN 被接受', started?.ok === true || ['done', 'failed', 'attention'].includes(terminalStatus), started?.error || terminalStatus);
        startChecked = true;
      }

      const value = Object.values(finalState?.status ?? {})[0] ?? signal;
      if (value === 'attention') {
        const msg = finalState?.results?.['acc-real']?.message ?? '';
        if (msg && msg !== lastPrompt) {
          lastPrompt = msg;
          console.log(`   ⚠ 需要人工介入：${msg}`);
          console.log('   → 控制器将再次断开，请在浏览器窗口完成验证；完成后脚本会自动继续。');
          const steps = finalState?.results?.['acc-real']?.steps ?? [];
          const tail = steps.slice(-3);
          if (tail.length) console.log(`     最近步骤：${tail.join(' | ')}`);
        }
        if (
          args.humanMouseChallenge
          && !challengeMouseAttempted
          && /turnstile|cloudflare|验证/i.test(msg)
        ) {
          challengeMouseAttempted = true;
          loginTab = activeSitePage(null);
          const clicked = loginTab
            ? await completeTurnstileWithHumanMouse(loginTab).catch((error) => {
              console.log(`   [模拟鼠标] 执行失败: ${String(error).split('\n')[0]}`);
              return false;
            })
            : false;
          if (!clicked) console.log('   [模拟鼠标] 未找到可见的 Turnstile 点击区域');
        }
        await (await ensureExtensionPage()).evaluate((titlePrefix) => {
          document.title = `${titlePrefix}waiting-manual`;
        }, detachedTitlePrefix).catch(() => {});
        await disconnectRealController();
        continue;
      }
      break;
    }

    if (!browser?.isConnected()) {
      await reconnectRealController();
      observeContextTraffic();
      finalState = await readAutomationState();
    }
    loginTab = activeSitePage(null);
  } else {
    observeContextTraffic();
    // 监听器必须在 START_LOGIN 之前注册：background 先开 about:blank 再导航
    const pagePromise = ctx.waitForEvent('page', { timeout: 30_000 });
    const started = await ext.evaluate(
      () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'START_LOGIN', accountId: 'acc-real' }, resolve)),
    );
    check('START_LOGIN 被接受', started?.ok === true, JSON.stringify(started));
    loginTab = await pagePromise;
    observeAuthResponses(loginTab);
    await loginTab.waitForURL(new RegExp(host.replace(/\./g, '\\.')), { timeout: 30_000 }).catch(() => {});

    while (Date.now() < deadline) {
      const snapshot = await readAutomationState();
      if (snapshot) finalState = snapshot;
      if (!finalState) {
        await sleepMs(1000);
        continue;
      }
      const value = Object.values(finalState.status)[0] ?? '';
      if (value !== lastStatus) {
        console.log(`   [状态] ${lastStatus || '(初始)'} → ${value}`);
        lastStatus = value;
      }
      if (value === 'attention') {
        const msg = finalState.results?.['acc-real']?.message ?? '';
        if (msg && msg !== lastPrompt) {
          lastPrompt = msg;
          console.log(`   ⚠ 需要人工介入：${msg}`);
          console.log('   → 请切到打开的浏览器窗口完成，完成后本脚本会自动继续。');
          const steps = finalState.results?.['acc-real']?.steps ?? [];
          const tail = steps.slice(-3);
          if (tail.length) console.log(`     最近步骤：${tail.join(' | ')}`);
        }
        if (
          args.humanMouseChallenge
          && !challengeMouseAttempted
          && /turnstile|cloudflare|验证/i.test(msg)
        ) {
          challengeMouseAttempted = true;
          const targetPage = activeSitePage(loginTab);
          const clicked = targetPage
            ? await completeTurnstileWithHumanMouse(targetPage).catch((error) => {
              console.log(`   [模拟鼠标] 执行失败: ${String(error).split('\n')[0]}`);
              return false;
            })
            : false;
          if (!clicked) console.log('   [模拟鼠标] 未找到可见的 Turnstile 点击区域');
        }
      }
      if (value === 'done' || value === 'failed') break;
      await sleepMs(1000);
    }
  }

  const openedUrl = loginTab?.isClosed() ? '(标签页已关闭)' : loginTab?.url() ?? '(未找到站点标签页)';
  check('自动打开了登录标签页', openedUrl.includes(host), openedUrl);

  const finalStatus = Object.values(finalState?.status ?? {})[0] ?? 'timeout';
  const result = finalState?.results?.['acc-real'];

  console.log('\n── 执行详情 ──');
  console.log(`  结果: ${result?.message ?? '无'}`);
  (result?.steps ?? []).forEach((s, i) => console.log(`  ${String(i + 1).padStart(2)}. ${s}`));

  check('任务跑到终态（未卡死）', finalStatus === 'done' || finalStatus === 'failed', `status=${finalStatus}`);
  check('签到成功', finalStatus === 'done', `status=${finalStatus}`);

  if (entry.family === 'sub2api') {
    // 扩展终态不能作为唯一证据。重新打开签到页，让站点前端自己请求最新
    // status/history，再用网络响应核对奖励、余额和历史记录。
    await new Promise((resolve) => setTimeout(resolve, 800));
    await Promise.allSettled(trafficTasks);
    const orderedBeforeAudit = [...checkinTraffic].sort((a, b) => a.sequence - b.sequence);
    const postResponse = orderedBeforeAudit.find((item) => item.method === 'POST');
    const statusBefore = orderedBeforeAudit
      .filter((item) => item.method === 'GET' && firstBoolean(item.body, 'checked_in_today') != null)
      .filter((item) => !postResponse || item.sequence < postResponse.sequence)
      .at(-1);

    const auditStartSequence = trafficSequence;
    const pages = ctx.pages().filter((page) => {
      try {
        return new URL(page.url()).hostname === host;
      } catch {
        return false;
      }
    });
    const target = pages.at(-1);
    if (target) {
      await target.goto(`${siteOrigin}/check-in`, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
      await target.waitForTimeout(6_000);
    }
    await Promise.allSettled(trafficTasks);

    const ordered = [...checkinTraffic].sort((a, b) => a.sequence - b.sequence);
    const statusAfter = ordered
      .filter((item) => item.sequence >= auditStartSequence)
      .filter((item) => item.method === 'GET' && firstBoolean(item.body, 'checked_in_today') != null)
      .at(-1);
    const afterBodies = ordered
      .filter((item) => item.sequence >= auditStartSequence && item.method === 'GET' && item.body)
      .map((item) => item.body);

    const checkedBefore = firstBoolean(statusBefore?.body, 'checked_in_today');
    const checkedAfter = firstBoolean(statusAfter?.body, 'checked_in_today');
    const checkinDate = firstString(statusAfter?.body, 'check_in_date');
    const reward = firstNumber(statusAfter?.body, 'today_reward') ?? firstNumber(postResponse?.body, 'reward');
    const balanceBefore = firstNumber(statusBefore?.body, 'free_balance');
    const balanceAfter = firstNumber(statusAfter?.body, 'free_balance');
    const daysBefore = firstNumber(statusBefore?.body, 'total_check_in_days');
    const daysAfter = firstNumber(statusAfter?.body, 'total_check_in_days');
    const history = afterBodies.flatMap((body) => collectHistoryRecords(body));
    const historyMatch = history.find((item) => (
      checkinDate
      && item.date.startsWith(checkinDate)
      && reward != null
      && Math.abs(item.reward - reward) < 0.01
    ));

    console.log('\n── 百倍权威接口核验 ──');
    console.log(`  签到前: checked=${checkedBefore} balance=${balanceBefore} days=${daysBefore}`);
    console.log(`  签到后: checked=${checkedAfter} balance=${balanceAfter} days=${daysAfter}`);
    console.log(`  日期=${checkinDate} reward=${reward} 历史匹配=${historyMatch ? '是' : '否'}`);

    const firstCheckinToday = checkedBefore === false;
    if (firstCheckinToday) {
      check(
        '百倍: POST 签到接口明确返回成功',
        !!postResponse && postResponse.status >= 200 && postResponse.status < 300 && responseClaimsSuccess(postResponse.body),
        postResponse ? `${postResponse.method} ${postResponse.path} HTTP ${postResponse.status}` : '未捕获 POST',
      );
      check('百倍: 签到前权威状态为未签到', true, `checked=${checkedBefore}`);
      check('百倍: 签到后权威状态为已签到', checkedAfter === true, `checked=${checkedAfter}`);
      check(
        '百倍: 免费余额按奖励金额增加',
        balanceBefore != null && balanceAfter != null && reward != null
          && Math.abs((balanceAfter - balanceBefore) - reward) < 0.01,
        `${balanceBefore} → ${balanceAfter}，reward=${reward}`,
      );
      check(
        '百倍: 累计签到天数增加 1',
        daysBefore != null && daysAfter === daysBefore + 1,
        `${daysBefore} → ${daysAfter}`,
      );
    } else {
      // 真站每天只能发一次奖励。当天首次实测已领取后，复测不能为了
      // “让数字再涨一次”伪造状态；正确的幂等证据是不重复 POST，且余额/天数不变。
      check('百倍: 复测前权威状态已签到', checkedBefore === true, `checked=${checkedBefore}`);
      check('百倍: 已签到时不重复调用 POST', !postResponse, postResponse ? `${postResponse.method} ${postResponse.path}` : '未发出 POST');
      check('百倍: 复测后权威状态仍为已签到', checkedAfter === true, `checked=${checkedAfter}`);
      check(
        '百倍: 幂等复测不重复增加余额',
        balanceBefore != null && balanceAfter != null && Math.abs(balanceAfter - balanceBefore) < 0.01,
        `${balanceBefore} → ${balanceAfter}`,
      );
      check(
        '百倍: 幂等复测不重复增加累计天数',
        daysBefore != null && daysAfter === daysBefore,
        `${daysBefore} → ${daysAfter}`,
      );
    }
    check(
      '百倍: 历史新增本次日期与奖励',
      !!historyMatch,
      historyMatch ? `${historyMatch.date} / ${historyMatch.reward}` : `date=${checkinDate}, reward=${reward}`,
    );
  }

  // 未成功时把现场结构 dump 出来 —— 这才是能改代码的信息
  if (finalStatus !== 'done') {
    if (authResponses.length) {
      console.log('\n── 登录接口响应（已脱敏）──');
      authResponses.forEach((item) => console.log(`  ${JSON.stringify(item)}`));
    }
    const pages = ctx.pages().filter((p) => p.url().includes(host));
    const target = pages[pages.length - 1];
    if (target) {
      console.log('\n── 现场：页面实际结构 ──');
      console.log(`  当前地址: ${target.url()}`);
      const dump = await target
        .evaluate(() => {
          const vis = (el) => {
            const s = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
          };
          const desc = (el) => {
            const id = el.id ? `#${el.id}` : '';
            const cls = (el.className || '').toString().trim().split(/\s+/).slice(0, 3).join('.');
            return `${el.tagName.toLowerCase()}${id}${cls ? '.' + cls : ''}`;
          };
          return {
            title: document.title,
            clickable: [
              ...document.querySelectorAll('button, [role="button"], a[href], [class*="btn"], [onclick]'),
            ]
              .filter(vis)
              .map((el) => `${desc(el)} :: "${(el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40)}"`)
              .slice(0, 40),
            links: [...document.querySelectorAll('a[href]')]
              .filter(vis)
              .map((el) => `${el.getAttribute('href')} :: "${(el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 30)}"`)
              .slice(0, 40),
            // 关键：验证码几乎都跑在跨源 iframe 里，只查 button/a 会得出
            // 「页面上没有验证控件」的错误结论
            iframes: [...document.querySelectorAll('iframe')].map(
              (el) => `${vis(el) ? '可见' : '隐藏'} src=${(el.getAttribute('src') || '(无)').slice(0, 100)} title="${el.getAttribute('title') || ''}"`,
            ),
            challengeMarkers: [
              ['cf-turnstile', '.cf-turnstile, [class*="turnstile" i]'],
              ['turnstile-response', '[name="cf-turnstile-response"]'],
              ['cf-challenge', '#challenge-running, #challenge-stage, form#challenge-form'],
              ['recaptcha', '.g-recaptcha, [class*="recaptcha" i]'],
              ['hcaptcha', '.h-captcha, [class*="hcaptcha" i]'],
              ['generic-captcha', '[class*="captcha" i], [id*="captcha" i]'],
            ]
              .filter(([, sel]) => document.querySelector(sel))
              .map(([name, sel]) => {
                const el = document.querySelector(sel);
                const val = el && 'value' in el ? String(el.value ?? '') : '';
                return `${name}${vis(el) ? '(可见)' : '(隐藏)'}${val ? ' 已有token' : ''}`;
              }),
            disabledSubmits: [...document.querySelectorAll('button[type="submit"], button')]
              .filter((el) => el.disabled)
              .map((el) => `${desc(el)} :: "${(el.innerText || '').trim().slice(0, 30)}"`),
            bodyText: (document.body?.innerText ?? '').replace(/\n{2,}/g, '\n').slice(0, 1500),
          };
        })
        .catch((e) => ({ error: String(e) }));

      if (dump.error) {
        console.log(`  取页面结构失败: ${dump.error}`);
      } else {
        console.log(`  标题: ${dump.title}`);
        if (dump.challengeMarkers.length) {
          console.log(`  ⚠ 验证控件: ${dump.challengeMarkers.join(', ')}`);
        }
        if (dump.iframes.length) {
          console.log('  iframe:');
          dump.iframes.forEach((t) => console.log(`    ${t}`));
        }
        if (dump.disabledSubmits.length) {
          console.log('  被禁用的提交按钮:');
          dump.disabledSubmits.forEach((t) => console.log(`    ${t}`));
        }
        console.log('  可点元素:');
        dump.clickable.forEach((t) => console.log(`    ${t}`));
        console.log('  链接:');
        dump.links.forEach((t) => console.log(`    ${t}`));
        console.log(`  正文:\n${dump.bodyText.split('\n').map((l) => '    ' + l).join('\n')}`);
      }
    }
  }

  if (args.keep) {
    console.log('\n--keep 已开启，浏览器保持打开。按 Ctrl+C 结束。');
    await new Promise((resolve) => {
      const keepAlive = setInterval(() => {}, 60_000);
      const stop = () => {
        clearInterval(keepAlive);
        resolve();
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  }
} finally {
  if (!args.keep) {
    // CDP 连接下 ctx.close() 会关掉整个浏览器，所以真 Chrome 走 kill 进程
    if (args.real) {
      await ctx.browser()?.close().catch(() => {});
      chromeProc?.kill();
    } else {
      await ctx.close().catch(() => {});
    }
    // 复用模式下必须留着：里面是过盾换来的登录 cookie
    if (!args.profile) rmSync(profile, { recursive: true, force: true });
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length === 0 ? 0 : 1);
