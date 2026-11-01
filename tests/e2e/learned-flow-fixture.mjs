/**
 * 学习流程真实浏览器验收的虚构站点（localhost）。
 *
 * 与既有 tests/e2e/server.mjs 完全独立：纯虚构账号、只在 127.0.0.1 上监听，
 * 页面结构是为「学习登录 → 学习签到 → 回放」这条链路设计的最小站点：
 *
 *   /login   账密表单（#username / #password / #login-submit），已登录访问会跳 /console
 *   /console 控制台（#logged-in 登录证据 + 「个人资料」「去签到」入口）
 *   /profile 个人资料页（显示当前账号与用户 ID —— 身份核验页）
 *   /checkin 签到页 —— **长页面**：签到区在 ~1600px 处（1280×960 视口首屏看不到，需滚动）。
 *            签到按钮是**纯图标按钮** `<button aria-label="签到">`（无 id/name/data-testid、
 *            无可见文字），按钮上方有一个可拖拽把手 #pull-knob（按下→移动→松开，
 *            松手后浏览器会对把手补发一次合成 click；把手跟随指针，模拟滑块手感）。
 *            页面导航里另有一个可见文字正好是「签到」的链接（#nav-self）——与按钮
 *            aria-label 重名，用于核实学习选择器最终指向哪个元素。
 *            点击按钮 POST /api/checkin（带当前 scrollY，供「先滚后点」断言），
 *            结果文本写入 #checkin-result（「签到成功」/「今日已签到」）。
 *            页面上另有 __fixtureDebug 计数器（knobClicks / checkinClicks），只做观测。
 *
 * 额外提供 /api/user/self（身份接口）与 /api/checkin（签到接口），
 * 并把每一次请求按时间顺序记进 events，供断言「签到发生在资料页核验之后」。
 * 服务器把当前登录用户印在 /profile 页面上，浏览器 Cookie 是唯一会话载体。
 *
 * 工作方 E（aria-label 图标按钮场景）扩展（向后兼容，不改变既有元素/接口）：
 *  - /login 增加「Sign in with Example SSO」纯图标按钮：没有可见文字（innerText 为空）、
 *    名称只在 aria-label 上，且勾选协议 checkbox 前 disabled（复刻 orevx 的第三方登录区）；
 *    勾选会 POST /api/consent（协议勾选的请求证据），随后按钮解除 disabled；
 *  - 点击该图标按钮跳 /oauth/start → /oauth/callback（本地假 OAuth 环路，回落
 *    sentinel_a44f9 会话）→ /console，供「学习 → 保存 → 回放点击」全链路断言；
 *  - /oauth/start、/oauth/callback、/api/consent 的每次请求同样进入 events，供
 *    「协议勾选先于 OAuth 点击」「OAuth 点击真实发生」的顺序断言。
 */
import { createServer } from 'node:http';

/** 虚构账号表。sentinel 值用于断言「学习产物不得包含输入值」。 */
export const FIXTURE_USERS = {
  sentinel_a44f9: { id: 101, password: 'sentinel_pw_zz77' },
  alice_fixture: { id: 202, password: 'alice_pw_88' },
};

export const FIXTURE_SENTINEL_USERNAME = 'sentinel_a44f9';
export const FIXTURE_SENTINEL_PASSWORD = 'sentinel_pw_zz77';
export const FIXTURE_ALICE_USERNAME = 'alice_fixture';
export const FIXTURE_ALICE_PASSWORD = 'alice_pw_88';

/** 纯图标 SSO 按钮的 aria-label（多词、含空格 —— 这正是要学的 text= 选择器素材）。 */
export const FIXTURE_SSO_LABEL = 'Sign in with Example SSO';
/** 假 OAuth 环路的一次性授权码（回调必须原样带回）。 */
export const FIXTURE_OAUTH_CODE = 'fixture-sso-code';

/** 签到图标按钮的 aria-label（纯图标：无可见文字，名称只在 aria-label 上）。 */
export const FIXTURE_CHECKIN_LABEL = '签到';
/** 签到按钮旁的拖拽把手（松手后浏览器会补发 click；该 click 不得进工作流）。 */
export const FIXTURE_KNOB_ID = 'pull-knob';
export const FIXTURE_KNOB_LABEL = '向右拉动';

function cookieUser(req) {
  const cookie = req.headers.cookie ?? '';
  const match = /(?:^|;\s*)fixture_user=([^;]+)/.exec(cookie);
  return match ? decodeURIComponent(match[1]) : null;
}

function html(body) {
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>学习验收站</title><body>${body}</body></html>`;
}

/**
 * 登录页。
 *
 * 账密表单保持原样（既有 learned-flow.mjs 依赖 #username/#password/#login-submit）。
 * 新增的「第三方登录」区复刻 orevx 的图案按钮形态：
 *  - 图标按钮**没有任何可见文字**（innerText 为空），名称只在 aria-label；
 *  - 勾选协议 checkbox 之前按钮 disabled；勾选（click/change）后解除；
 *  - 点击按钮跳本地假 OAuth：/oauth/start → /oauth/callback → /console。
 * 按钮刻意不带 id/name/data-testid —— 这样学习侧只能回落到 aria-label 生成
 * `text=Sign in with Example SSO`，正是本次要验证修复的选择器形态。
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
      <button type="button" aria-label="Sign in with Example SSO" disabled>
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
      var sso = document.querySelector('button[aria-label="Sign in with Example SSO"]');
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
        location.href = '/oauth/start?client=example-sso&state=aria';
      });
    })();
  </script>
`);

function consolePage(user) {
  return html(`
    <div id="logged-in">已登录</div>
    <p>当前账号：<b id="current-user">${user}</b></p>
    <nav>
      <a id="nav-profile" href="/profile">个人资料</a>
      <a id="nav-checkin" href="/checkin">去签到</a>
    </nav>
  `);
}

function profilePage(user, id) {
  return html(`
    <h1>个人资料</h1>
    <p>当前账号：<span id="profile-account">${user}</span></p>
    <p>用户 ID：<span id="profile-uid">${id}</span></p>
    <nav><a id="nav-checkin" href="/checkin">去签到</a></nav>
  `);
}

function checkinPage(user, claimed) {
  const feed = Array.from({ length: 14 }, (_, index) => `<p>内容 ${index + 1}：虚构长页面占位（签到区还在下面）</p>`).join('\n    ');
  return html(`
    <h1>每日签到</h1>
    <nav id="page-nav">
      <a id="nav-console" href="/console">控制台</a>
      <a id="nav-profile" href="/profile">个人资料</a>
      <a id="nav-self" href="/checkin">签到</a>
    </nav>
    <div id="long-feed" style="min-height:1500px">
    ${feed}
    </div>
    <section id="checkin-card">
      <p>当前账号：<span id="checkin-account">${user}</span></p>
      <div id="pull-track" style="position:relative;width:260px;height:44px;background:#ececec;border-radius:22px">
        <div id="pull-knob" role="button" tabindex="0" aria-label="向右拉动"
             style="position:absolute;left:0;top:0;width:44px;height:44px;border-radius:22px;background:#bdbdbd;text-align:center;line-height:44px;cursor:grab;user-select:none">→</div>
      </div>
      <p>
        <button type="button" aria-label="签到" ${claimed ? 'disabled' : ''} style="width:44px;height:44px">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" style="display:block;margin:0 auto">
            <path d="M12 2a10 10 0 1 0 10 10H12z" fill="#34a853"></path>
          </svg>
        </button>
      </p>
      <p id="checkin-result">${claimed ? '签到成功' : ''}</p>
    </section>
    <script>
      // 可拖拽把手：把手跟随指针（滑块手感）；松手后浏览器会对把手补发一次合成 click。
      (function () {
        var knob = document.getElementById('pull-knob');
        var track = document.getElementById('pull-track');
        var dragging = false, startX = 0, base = 0, offset = 0;
        function maxOffset() { return Math.max(0, track.clientWidth - knob.offsetWidth); }
        knob.addEventListener('mousedown', function (e) {
          dragging = true; startX = e.clientX; base = offset; e.preventDefault();
        });
        window.addEventListener('mousemove', function (e) {
          if (!dragging) return;
          offset = Math.max(0, Math.min(maxOffset(), base + (e.clientX - startX)));
          knob.style.transform = 'translateX(' + offset + 'px)';
        });
        window.addEventListener('mouseup', function () { dragging = false; });
      })();

      // 观测计数器：只记录真实收到的 click，不改变任何页面行为（供 E2E 断言用）。
      window.__fixtureDebug = { knobClicks: 0, checkinClicks: 0 };
      document.getElementById('pull-knob').addEventListener('click', function () {
        window.__fixtureDebug.knobClicks += 1;
      });

      var checkinBtn = document.querySelector('button[aria-label="签到"]');
      checkinBtn.addEventListener('click', async function () {
        window.__fixtureDebug.checkinClicks += 1;
        var res = await fetch('/api/checkin?scrollY=' + Math.round(window.scrollY || 0), { method: 'POST', credentials: 'include' });
        var data = await res.json().catch(function () { return {}; });
        checkinBtn.disabled = true;
        document.getElementById('checkin-result').textContent = data.message || '签到成功';
      });
    </script>
  `);
}

/**
 * 启动虚构站点。
 * @returns {Promise<{origin: string, port: number, close: () => Promise<void>,
 *   reset: () => void, events: () => Array, claimCount: () => number,
 *   loginCount: () => number, checked: () => boolean}>}
 */
export async function startFixture({ nestedLogin = false } = {}) {
  let claimed = false;
  /** 全部请求按发生顺序记录：{ t, method, path, user }。 */
  const events = [];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const user = cookieUser(req);
    const record = (method = req.method) => {
      const entry = { t: Date.now(), method, path, user: cookieUser(req) };
      // 签到 POST 会带 ?scrollY=<点击时代页面滚动位置>：断言「先滚后点」的请求级证据。
      const scrollY = url.searchParams.get('scrollY');
      if (scrollY !== null && Number.isFinite(Number(scrollY))) entry.scrollY = Number(scrollY);
      events.push(entry);
    };
    const redirect = (target) => { res.writeHead(303, { Location: target }); res.end(); };
    const json = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };

    if (path === '/api/user/self') {
      record();
      if (!user || !FIXTURE_USERS[user]) return json(401, { success: false, message: '请先登录' });
      return json(200, { success: true, data: { id: FIXTURE_USERS[user].id, username: user, quota: 1000, used_quota: 0 } });
    }

    if (path === '/api/checkin') {
      record('POST');
      if (req.method !== 'POST') return json(405, { success: false, message: '方法不允许' });
      if (!user || !FIXTURE_USERS[user]) return json(401, { success: false, message: '请先登录' });
      if (claimed) return json(200, { success: true, message: '今日已签到', data: { already: true } });
      claimed = true;
      return json(200, { success: true, message: '签到成功', data: { already: false } });
    }

    if (path === '/api/user/info' || path === '/api/v1/auth/me') {
      record();
      return json(404, { success: false, message: 'not found' });
    }

    /** 协议勾选（登录学习/回放时由页面脚本发出）——「勾选先于 OAuth 点击」的请求证据。 */
    if (path === '/api/consent') {
      record('POST');
      return json(200, { success: true, message: '协议已记录' });
    }
    if (path === '/record/reveal-more' || path === '/record/reveal-form') {
      record();
      return json(200, { success: true });
    }

    /** 假 OAuth：开始跳转（图标按钮被真实点击时才会发生）。 */
    if (path === '/oauth/start') {
      record('GET');
      res.writeHead(303, { Location: `/oauth/callback?code=${FIXTURE_OAUTH_CODE}&state=aria` });
      return res.end();
    }

    /** 假 OAuth 回调：校验一次性 code/state 后建立 sentinel 会话，回到 /console。 */
    if (path === '/oauth/callback') {
      record('GET');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (code !== FIXTURE_OAUTH_CODE || state !== 'aria') {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html('<p id="oauth-error">OAuth 回调参数不正确</p>'));
      }
      res.writeHead(303, {
        'Set-Cookie': `fixture_user=${encodeURIComponent(FIXTURE_SENTINEL_USERNAME)}; Path=/; HttpOnly; SameSite=Lax`,
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
      const account = FIXTURE_USERS[username];
      if (!account || account.password !== password) {
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
      if (user && FIXTURE_USERS[user]) return redirect('/console');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      const page = nestedLogin ? LOGIN_PAGE
        .replace('<form method=', '<button id="reveal-more" type="button">其他登录方式</button><button id="reveal-form" type="button" hidden>使用账号密码登录</button><form hidden method=')
        .replace('</body>', `<script>
          document.getElementById('reveal-more').onclick = function () {
            fetch('/record/reveal-more', { method: 'POST' });
            document.getElementById('reveal-form').hidden = false;
          };
          document.getElementById('reveal-form').onclick = function () {
            fetch('/record/reveal-form', { method: 'POST' });
            document.getElementById('login-form').hidden = false;
          };
        </script></body>`)
        : LOGIN_PAGE;
      return res.end(page);
    }

    if (!user || !FIXTURE_USERS[user]) {
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
      return res.end(profilePage(user, FIXTURE_USERS[user].id));
    }

    if (path === '/checkin') {
      record('GET');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(checkinPage(user, claimed));
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
    /** 清空请求记录并复位签到状态（保留用户会话由浏览器 Cookie 决定）。 */
    reset: () => { claimed = false; events.length = 0; },
    events: () => events.map((event) => ({ ...event })),
    claimCount: () => events.filter((event) => event.method === 'POST' && event.path === '/api/checkin').length,
    loginCount: () => events.filter((event) => event.method === 'POST' && event.path === '/session').length,
    checked: () => claimed,
  };
}
