/**
 * 「一站一流程 · 跨账号复用边界」验收专用的虚构站点。
 *
 * 与既有 tests/e2e/learned-flow-fixture.mjs **互相独立**（不改动那个文件，
 * 免得影响已在用的 learned-flow / learned-flow-aria 脚本）。本夹具只服务
 * tests/e2e/site-workflow-shared-edges.mjs，多出三件既有夹具没有的能力：
 *
 *   1. **四个用户**（三个账密 + 一个只走第三方登录的账号），密码框都在同一张
 *      登录页上 —— 这是「同站多账号共用一份签到流程」与「登录方式混合」两条
 *      边界同时要用的形状；
 *   2. **按用户分别记录签到状态**：谁签过就是谁签过，另一个账号仍然要能签，
 *      这样「给错账号签到」不可能被夹具自己掩盖过去；
 *   3. **可切换的签到控件**（有按钮 / 没有任何签到控件），用来验证切回
 *      「自动识别」后既不会继续回放旧流程，也不会把「找不到按钮」误判成成功。
 *
 * 全部账号、密码、域名均为虚构 sentinel，只在 127.0.0.1 上监听，不访问外网；
 * 服务器只 drain 表单，记录的用户名是用于「哪个账号在操作」的观测值，不是凭据。
 */
import { createServer } from 'node:http';

/** 虚构账号表。三个账密账号 + 一个第三方（假 OAuth）账号。 */
export const EDGE_USERS = {
  sentinel_form_a: { id: 101, password: 'sentinel_pw_a' },
  sentinel_form_b: { id: 202, password: 'sentinel_pw_b' },
  sentinel_form_c: { id: 303, password: 'sentinel_pw_c' },
  sentinel_oauth: { id: 404, password: null },
};

export const EDGE_FORM_A = 'sentinel_form_a';
export const EDGE_FORM_B = 'sentinel_form_b';
export const EDGE_FORM_C = 'sentinel_form_c';
export const EDGE_OAUTH = 'sentinel_oauth';

export const EDGE_FORM_PASSWORDS = {
  [EDGE_FORM_A]: EDGE_USERS[EDGE_FORM_A].password,
  [EDGE_FORM_B]: EDGE_USERS[EDGE_FORM_B].password,
  [EDGE_FORM_C]: EDGE_USERS[EDGE_FORM_C].password,
};

/**
 * 第三方登录按钮的 aria-label（纯图标：名称只在 aria-label 上）。
 *
 * 刻意带上真实供应商词（Google）：回放侧没有存过按钮选择器时要靠页面语义
 * 自动识别，而语义评分只认得出来自真实供应商形态的按钮。这里不访问 Google，
 * 点它走的是本机假 OAuth 环路（/oauth/start → /oauth/callback）。
 */
export const EDGE_SSO_LABEL = 'Sign in with Google';
export const EDGE_SSO_BUTTON_CSS = `button[aria-label="${EDGE_SSO_LABEL}"]`;
export const EDGE_OAUTH_CODE = 'edge-fixture-code';

/** 签到按钮的 aria-label（纯图标按钮：名称只在 aria-label 上）。 */
export const EDGE_CHECKIN_LABEL = '签到';


function cookieUser(req) {
  const cookie = req.headers.cookie ?? '';
  const match = /(?:^|;\s*)fixture_user=([^;]+)/.exec(cookie);
  return match ? decodeURIComponent(match[1]) : null;
}

function html(body) {
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>跨账号复用边界验收站</title><body>${body}</body></html>`;
}

/**
 * 登录页：账密表单（#username / #password / #login-submit）与一个纯图标
 * 第三方登录按钮并存。
 *
 * 第三方按钮在勾选协议前 disabled（复刻真实站点的形态），勾选会 POST
 * /api/consent，点击走本机假 OAuth。
 */
const LOGIN_PAGE = html(`
  <h1>登录</h1>
  <form method="post" action="/session" id="login-form">
    <label>用户名 <input id="username" name="username" autocomplete="username"></label>
    <label>密码 <input id="password" name="password" type="password" autocomplete="current-password"></label>
    <button id="login-submit" type="submit">登录</button>
  </form>
  <section id="sso-section">
    <h2>第三方登录</h2>
    <label id="agree-label"><input type="checkbox" id="agree-terms" name="agree"> I have read and agree to the Example Terms of Service</label>
    <p>
      <button type="button" aria-label="Sign in with Google" disabled>
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" style="display:block">
          <path d="M12 2a10 10 0 1 0 10 10H12z" fill="#4285f4"></path>
        </svg>
      </button>
    </p>
  </section>
  <p id="login-hint">虚构验收站点，仅用于隔离浏览器端到端测试</p>
  <script>
    (function () {
      var agree = document.getElementById('agree-terms');
      var sso = document.querySelector('button[aria-label="Sign in with Google"]');
      var pinged = false;
      function sync() { sso.disabled = !agree.checked; }
      function ping() {
        if (!agree.checked || pinged) return;
        pinged = true;
        fetch('/api/consent', { method: 'POST', credentials: 'include' }).catch(function () {});
      }
      agree.addEventListener('click', sync);
      agree.addEventListener('change', function () { sync(); ping(); });
      sso.addEventListener('click', function () {
        if (sso.disabled) return;
        location.href = '/oauth/start?client=example-google&state=edge';
      });
    })();
  </script>
`);

function consolePage(user) {
  /*
   * 头像菜单：按钮上印着**当前登录账号的名字**，没有 id / data-testid
   * （复刻真实站点的形态）。点开才出现「个人资料」入口。演示账号点它，
   * 采集侧不能把名字写进选择器 —— 别的账号页面上印的是自己的名字。
   */
  return html(`
    <div id="logged-in">已登录</div>
    <p>当前账号：<b id="current-user">${user}</b></p>
    <header>
      <button type="button" class="avatar-menu">${user}</button>
      <div class="avatar-dropdown" hidden>
        <a class="menu-profile" href="/profile">我的资料</a>
      </div>
    </header>
    <nav>
      <a id="nav-profile" href="/profile">个人资料</a>
      <a id="nav-checkin" href="/checkin">去签到</a>
    </nav>
    <script>
      document.querySelector('.avatar-menu').addEventListener('click', function () {
        document.querySelector('.avatar-dropdown').hidden = false;
      });
    </script>
  `);
}

function profilePage(user, id) {
  return html(`
    <div id="logged-in">已登录</div>
    <h1>个人资料</h1>
    <p>当前账号：<span id="profile-account">${user}</span></p>
    <p>用户 ID：<span id="profile-uid">${id}</span></p>
    <nav><a id="nav-checkin" href="/checkin">去签到</a></nav>
  `);
}

/**
 * 签到页。长页面（签到区在首屏之外，需要滚动），按钮是纯图标
 * <button aria-label="签到">（无 id/name/data-testid、无可见文字）。
 *
 * controls='none' 时不渲染任何签到控件与结果文案 —— 用来验证「找不到按钮」
 * 必须如实失败，绝不冒充成功。
 */
function checkinPage(user, claimed, controls) {
  const feed = Array.from({ length: 14 }, (_, index) => `<p>内容 ${index + 1}：虚构长页面占位（签到区还在下面）</p>`).join('\n    ');
  const card = controls === 'none'
    ? '<section id="checkin-card"><p>当前账号：<span id="checkin-account">' + user + '</span></p><p id="checkin-empty">本页暂时没有可用的签到控件</p></section>'
    : `<section id="checkin-card">
      <p>当前账号：<span id="checkin-account">${user}</span></p>
      <p>
        <button type="button" aria-label="签到" ${claimed ? 'disabled' : ''} style="width:44px;height:44px">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" style="display:block;margin:0 auto">
            <path d="M12 2a10 10 0 1 0 10 10H12z" fill="#34a853"></path>
          </svg>
        </button>
      </p>
      <p id="checkin-result">${claimed ? '签到成功' : ''}</p>
    </section>`;
  const script = controls === 'none' ? '' : `
    <script>
      var checkinBtn = document.querySelector('button[aria-label="签到"]');
      if (checkinBtn) {
        checkinBtn.addEventListener('click', async function () {
          var res = await fetch('/api/checkin?scrollY=' + Math.round(window.scrollY || 0), { method: 'POST', credentials: 'include' });
          var data = await res.json().catch(function () { return {}; });
          checkinBtn.disabled = true;
          document.getElementById('checkin-result').textContent = data.message || '签到成功';
        });
      }
    </script>`;
  return html(`
    <div id="logged-in">已登录</div>
    <h1>每日签到</h1>
    <nav id="page-nav">
      <a id="nav-console" href="/console">控制台</a>
      <a id="nav-profile" href="/profile">个人资料</a>
      <a id="nav-self" href="/checkin">签到</a>
    </nav>
    <div id="long-feed" style="min-height:1500px">
    ${feed}
    </div>
    ${card}${script}
  `);
}

/**
 * 启动虚构站点。
 *
 * @returns {Promise<{origin: string, port: number, close: () => Promise<void>,
 *   reset: () => void, events: () => Array, users: string[],
 *   setCheckinControls: (mode: 'button' | 'none') => void,
 *   checkinControls: () => 'button' | 'none',
 *   claimPosts: () => Array, loginPosts: () => Array,
 *   checkedIn: (user: string) => boolean}>}
 */
export async function startEdgeFixture() {
  /** 按用户分别记录「今天签过到没有」。 */
  const claimed = new Set();
  /** 签到页控件形态，可在运行中切换（负向用例用）。 */
  let controls = 'button';
  /** 全部请求按发生顺序记录：{ t, method, path, user }。 */
  const events = [];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const user = cookieUser(req);
    const record = (method = req.method) => {
      events.push({ t: Date.now(), method, path, user: cookieUser(req) });
    };
    const redirect = (target) => { res.writeHead(303, { Location: target }); res.end(); };
    const json = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };

    if (path === '/api/user/self') {
      record();
      if (!user || !EDGE_USERS[user]) return json(401, { success: false, message: '请先登录' });
      return json(200, { success: true, data: { id: EDGE_USERS[user].id, username: user, quota: 1000, used_quota: 0 } });
    }

    if (path === '/api/checkin') {
      record('POST');
      if (req.method !== 'POST') return json(405, { success: false, message: '方法不允许' });
      if (!user || !EDGE_USERS[user]) return json(401, { success: false, message: '请先登录' });
      if (claimed.has(user)) return json(200, { success: true, message: '今日已签到', data: { already: true } });
      claimed.add(user);
      return json(200, { success: true, message: '签到成功', data: { already: false } });
    }

    if (path === '/api/user/info' || path === '/api/v1/auth/me') {
      record();
      return json(404, { success: false, message: 'not found' });
    }

    if (path === '/api/consent') {
      record('POST');
      return json(200, { success: true, message: '协议已记录' });
    }

    if (path === '/oauth/start') {
      record('GET');
      res.writeHead(303, { Location: `/oauth/callback?code=${EDGE_OAUTH_CODE}&state=edge` });
      return res.end();
    }

    if (path === '/oauth/callback') {
      record('GET');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (code !== EDGE_OAUTH_CODE || state !== 'edge') {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html('<p id="oauth-error">OAuth 回调参数不正确</p>'));
      }
      res.writeHead(303, {
        'Set-Cookie': `fixture_user=${encodeURIComponent(EDGE_OAUTH)}; Path=/; HttpOnly; SameSite=Lax`,
        Location: '/console',
      });
      return res.end();
    }

    if (path === '/session' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      const username = form.get('username') ?? '';
      const password = form.get('password') ?? '';
      events.push({ t: Date.now(), method: 'POST', path, user: username });
      const account = EDGE_USERS[username];
      if (!account || !account.password || account.password !== password) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html('<p id="login-error">用户名或密码错误</p><a href="/login">返回登录</a>'));
      }
      res.writeHead(303, {
        'Set-Cookie': `fixture_user=${encodeURIComponent(username)}; Path=/; HttpOnly; SameSite=Lax`,
        Location: '/console',
      });
      return res.end();
    }

    if (path === '/login') {
      record('GET');
      if (user && EDGE_USERS[user]) return redirect('/console');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(LOGIN_PAGE);
    }

    if (!user || !EDGE_USERS[user]) {
      record('GET');
      return redirect('/login');
    }

    if (path === '/' || path === '/console') {
      record('GET');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(consolePage(user));
    }

    if (path === '/profile') {
      record('GET');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(profilePage(user, EDGE_USERS[user].id));
    }

    if (path === '/checkin') {
      record('GET');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(checkinPage(user, claimed.has(user), controls));
    }

    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html('<p>404</p>'));
  });

  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    port,
    close: () => new Promise((done) => server.close(() => done())),
    /** 清空请求记录并复位全部账号的签到状态（浏览器 Cookie 由调用方处理）。 */
    reset: () => { claimed.clear(); events.length = 0; },
    events: () => events.map((event) => ({ ...event })),
    users: Object.keys(EDGE_USERS),
    setCheckinControls: (mode) => {
      if (mode !== 'button' && mode !== 'none') throw new Error(`未知签到控件形态: ${mode}`);
      controls = mode;
    },
    checkinControls: () => controls,
    claimPosts: () => events.filter((event) => event.method === 'POST' && event.path === '/api/checkin').map((event) => ({ ...event })),
    loginPosts: () => events.filter((event) => event.method === 'POST' && event.path === '/session').map((event) => ({ ...event })),
    checkedIn: (target) => claimed.has(target),
  };
}
