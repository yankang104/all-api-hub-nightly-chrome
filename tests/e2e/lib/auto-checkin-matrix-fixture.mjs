/**
 * 「自动签到可靠性矩阵」的虚构站点服务器。
 *
 * 与 tests/e2e/auto-checkin-mode.mjs 的内联 fixture 分工不同：那一个只验证
 * 「两站各一个账号、简单表单」这条主路径；本文件把真实站点会遇到的分支
 * 全部建模成可观测的服务器状态，供 auto-checkin-matrix.mjs 逐项断言。
 *
 * 设计原则：**所有断言都基于服务端观测**（请求日志、计数、会话归属），
 * 而不是页面上的自报。页面自报正是「把点到了按钮当成签到成功」的来源。
 *
 * 每个站点都提供：
 *   - GET  /api/matrix/state     只读观测：签到 POST 次数、登录 POST 次数、
 *                                当前会话账号、各账号是否已签、经过的代理标签
 *   - 会话只靠 HttpOnly Cookie 承载（站点真实形态），因此多账号串号会
 *     直接从观测里暴露出来。
 */
import { createServer } from 'node:http';

const SESSION_COOKIE = 'matrix_session';

function html(body) {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>矩阵验收站</title></head><body>${body}</body></html>`;
}

function readCookie(req, name) {
  const raw = req.headers.cookie ?? '';
  const match = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(raw);
  return match ? decodeURIComponent(match[1]) : null;
}

function readProxyTag(req) {
  const value = req.headers['x-matrix-proxy'];
  return typeof value === 'string' && value ? value : 'direct';
}

async function readBody(req) {
  return new Promise((resolve) => {
    let text = '';
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => resolve(text));
  });
}

async function drain(req) {
  for await (const _chunk of req) { /* 只消费、不记录 */ }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * @param {object} options
 * @param {string} options.id            站点标识（账号名与身份都由它派生）
 * @param {string} [options.checkinPath] 签到页路径
 * @param {string} [options.loginPath]   登录页路径
 * @param {number} [options.accountPool] 该站点配置的账号数量（1 或 2）
 * @param {object} [options.behaviour]   站点行为开关，逐个对应矩阵条目
 */
export async function startMatrixSite(options) {
  const {
    id,
    checkinPath = '/checkin',
    loginPath = '/login',
    accountPool = 1,
    behaviour = {},
  } = options;

  const {
    /** 登录后必须先经过资料页核对身份（条目 g） */
    requireProfile = false,
    /** 签到按钮需要滚动才进入视口（条目 d） */
    needsScroll = false,
    /** 打开签到页时就有公告遮罩盖住按钮，需要先关掉（条目 e） */
    announceOnLoad = false,
    /** 签到接口第一次返回 503，第二次成功（条目 h） */
    failFirstCheckin = false,
    /** 站点幂等：重复调用不会重复记一笔 */
    idempotentCheckin = true,
    /** 点击后什么都不显示 —— 用于验证「点到按钮 ≠ 签到成功」 */
    silentClick = false,
    /** 服务端初始就标记为已签到（条目 c） */
    preCheckedIn = false,
    /** 每个响应前的人为延迟，用于制造「跑到一半」的窗口（条目 i / j） */
    responseDelayMs = 0,
    /** 登录页／签到页的额外延迟 */
    pageDelayMs = 0,
  } = behaviour;

  /** 每个账号一份服务端状态；Cookie 里只放 username，其余按 username 索引。 */
  const users = new Map();
  for (let index = 0; index < accountPool; index += 1) {
    const username = accountPool === 1 ? `sentinel_${id}` : `sentinel_${id}_${index + 1}`;
    users.set(username, {
      username,
      userId: `${index + 1}${(id.length * 7 + 13).toString().padStart(2, '0')}`,
      checkedIn: preCheckedIn,
      checkinPosts: 0,
      checkinRejected: 0,
      loginPosts: 0,
      profileHits: 0,
      checkinPageHits: 0,
      announcementsClosed: 0,
      requestTags: [],
    });
  }
  const firstUser = users.values().next().value;
  const allEvents = [];
  let totalCheckinPosts = 0;
  let totalLoginPosts = 0;
  const unauthenticatedCheckinAttempts = [];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture.test');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const sessionUser = readCookie(req, SESSION_COOKIE);
    const user = sessionUser ? users.get(sessionUser) : null;
    const proxyTag = readProxyTag(req);
    allEvents.push({ method, path, authenticated: !!user, user: user?.username ?? null, proxyTag });
    res.setHeader('Cache-Control', 'no-store');

    const json = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
    };
    const page = (body) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html(body));
    };
    const redirect = (location, headers = {}) => {
      res.writeHead(302, { Location: location, ...headers });
      res.end();
    };

    /** 只读观测接口：e2e 用它取代页面自报。 */
    if (path === '/api/matrix/state') {
      return json(200, {
        id,
        totalCheckinPosts,
        totalLoginPosts,
        unauthenticatedCheckinAttempts: [...unauthenticatedCheckinAttempts],
        sessionUser: sessionUser ?? null,
        sessionKnown: !!user,
        users: [...users.values()].map((entry) => ({
          ...entry,
          requestTags: [...new Set(entry.requestTags)],
        })),
        proxyTagsSeen: [...new Set(allEvents.map((event) => event.proxyTag))],
      });
    }

    if (responseDelayMs > 0) await sleep(responseDelayMs);

    /** 身份 + 余额端点，沿用 new-api 家族的约定路径。 */
    if (path === '/api/user/self' || path === '/api/user/info' || path === '/api/v1/auth/me') {
      if (!user) return json(401, { success: false, message: '请先登录' });
      user.requestTags.push(proxyTag);
      return json(200, {
        success: true,
        data: {
          id: user.userId,
          username: user.username,
          // 额度只认「服务端真的记为已签到」这一件事。被拒绝的写请求（5xx/401）
          // 一律不改变余额；否则扩展的守恒差分会把一次失败的写请求认证成成功 ——
          // 这是本矩阵里最需要钉死的一条：假成功的入口就在协议台本身。
          quota: user.checkedIn ? 600_000 : 500_000,
          used_quota: 0,
        },
      });
    }

    if (path === '/api/matrix/checkin' && method === 'POST') {
      await drain(req);
      if (!user) {
        unauthenticatedCheckinAttempts.push({ proxyTag, at: Date.now() });
        return json(401, { success: false, message: '请先登录' });
      }
      user.requestTags.push(proxyTag);
      user.checkinPosts += 1;
      totalCheckinPosts += 1;
      if (failFirstCheckin && user.checkinPosts === 1) {
        // 偶发站点故障：写请求被明确拒绝，既不改余额也不改签到状态。
        user.checkinRejected += 1;
        // 文案带上 HTTP 状态码，与真实站点把后端错误原样渲染到页面上的形态一致。
        return json(503, { success: false, message: '服务暂不可用（HTTP 503）' });
      }
      if (idempotentCheckin && user.checkedIn) {
        return json(200, { success: true, message: '今日已签到', data: { already: true } });
      }
      user.checkedIn = true;
      return json(200, { success: true, message: '签到成功', data: { already: false } });
    }

    if (path === '/api/matrix/announcement-closed' && method === 'POST') {
      await drain(req);
      if (user) {
        user.announcementsClosed += 1;
        user.requestTags.push(proxyTag);
      }
      return json(200, { success: true });
    }

    if (path === '/api/matrix/login' && method === 'POST') {
      const body = await readBody(req);
      totalLoginPosts += 1;
      const form = new URLSearchParams(body);
      const username = form.get('username') ?? '';
      const password = form.get('password') ?? '';
      const account = users.get(username);
      if (!account || password !== `sentinel-pw-${id}`) {
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html('<p id="login-error">用户名或密码错误</p>'));
      }
      account.loginPosts += 1;
      account.requestTags.push(proxyTag);
      return redirect(requireProfile ? '/profile' : '/console', {
        'Set-Cookie': `${SESSION_COOKIE}=${encodeURIComponent(username)}; Path=/; HttpOnly; SameSite=Lax`,
      });
    }

    if (path === loginPath) {
      if (user) return redirect('/console');
      if (pageDelayMs > 0) await sleep(pageDelayMs);
      return page(`
  <h1>登录</h1>
  <form action="/api/matrix/login" method="POST">
    <input id="username" name="username" autocomplete="username">
    <input id="password" name="password" type="password" autocomplete="current-password">
    <button id="submit" type="submit">登录</button>
  </form>`);
    }

    /** 需要会话的页面：没有有效 Cookie 一律回登录页。 */
    const requireUser = () => {
      if (user) return false;
      redirect(loginPath);
      return true;
    };

    if (path === '/profile') {
      if (requireUser()) return undefined;
      user.profileHits += 1;
      user.requestTags.push(proxyTag);
      return page(`
  <div id="logged-in">已登录</div>
  <h1>个人资料</h1>
  <p>当前账号：<span id="profile-account">${user.username}</span></p>
  <p>用户 ID：<span id="profile-uid">${user.userId}</span></p>
  <nav>
    <a id="nav-console" href="/console">控制台</a>
    <a id="nav-checkin" href="${checkinPath}">每日签到</a>
  </nav>`);
    }

    if (path === '/console') {
      if (requireUser()) return undefined;
      user.requestTags.push(proxyTag);
      return page(`
  <div id="logged-in">已登录</div>
  <p>当前账号：<b id="current-user">${user.username}</b></p>
  <nav>
    <a id="nav-profile" href="/profile">个人资料</a>
    <a id="nav-checkin" href="${checkinPath}">每日签到</a>
  </nav>`);
    }

    if (path === '/' || path === '') {
      if (!user) return page('<h1>首页</h1><a id="nav-login" href="' + loginPath + '">去登录</a>');
      user.requestTags.push(proxyTag);
      return page(`
  <div id="logged-in">已登录</div>
  <p>当前账号：<b id="current-user">${user.username}</b></p>
  <nav><a id="nav-profile" href="/profile">个人资料</a><a id="nav-checkin" href="${checkinPath}">每日签到</a></nav>`);
    }

    if (path === checkinPath) {
      if (requireUser()) return undefined;
      if (pageDelayMs > 0) await sleep(pageDelayMs);
      user.checkinPageHits += 1;
      user.requestTags.push(proxyTag);
      const already = user.checkedIn;
      const filler = needsScroll
        ? Array.from({ length: 24 }, (_, index) => `<p>内容 ${index + 1}：虚构长页面占位（签到区还在下面）</p>`).join('')
        : '';
      const style = needsScroll
        ? '<style>#long{min-height:2200px}button#claim{padding:14px 22px}</style>'
        : '<style>button#claim{padding:14px 22px}</style>';
      return page(`${style}
  <div id="logged-in">已登录</div>
  <h1>每日签到</h1>
  <p>当前账号：<span id="checkin-account">${user.username}</span></p>
  <div id="long">${filler}</div>
  <section id="checkin-panel">
    <button id="claim" ${already ? 'disabled' : ''} aria-label="${already ? '今日已签到' : '立即签到'}">${already ? '今日已签到' : '立即签到'}</button>
    <p id="result">${already ? '今日已签到' : ''}</p>
  </section>
  ${announceOnLoad ? `<div id="announcement" role="dialog" aria-modal="true" style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:50">
    <div class="modal-card" style="margin:120px auto;background:#fff;padding:24px;width:420px">
      <h2>活动公告</h2>
      <p>本站今日有新的额度发放规则，请阅读后关闭。</p>
      <button id="announcement-close" aria-label="关闭公告">关闭</button>
    </div>
  </div>` : ''}
  <script>
    window.__matrixClicks = 0;
    (function () {
      var btn = document.getElementById('claim');
      var result = document.getElementById('result');
      var close = document.getElementById('announcement-close');
      if (close) {
        close.addEventListener('click', function (event) {
          if (!event.isTrusted) return;
          document.getElementById('announcement').hidden = true;
          fetch('/api/matrix/announcement-closed', { method: 'POST', body: '{}' }).catch(function () {});
        });
      }
      if (!btn) return;
      btn.addEventListener('click', async function (event) {
        if (!event.isTrusted) return;
        window.__matrixClicks += 1;
        btn.disabled = true;
        var ok = false;
        var message = '';
        try {
          var resp = await fetch('/api/matrix/checkin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          });
          var payload = await resp.json();
          ok = resp.ok && payload && payload.success === true;
          message = (payload && payload.message) || '';
        } catch (error) {
          ok = false;
          message = String(error);
        }
        ${silentClick ? `
        // 点击后什么都不显示：用于验证「点到按钮 ≠ 签到成功」。
        btn.disabled = false;
        result.textContent = '';
        return;` : `
        if (ok) {
          result.textContent = message.indexOf('已签到') >= 0 ? '今日已签到' : '签到成功';
          btn.disabled = true;
          btn.textContent = '今日已签到';
        } else {
          result.textContent = '签到失败：' + message;
          btn.disabled = false;
        }`}
      });
    })();
  </script>`);
    }

    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html('<p>404</p>'));
  });

  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  const siteOrigin = `http://127.0.0.1:${port}`;

  return {
    id,
    origin: siteOrigin,
    port,
    checkinPath,
    loginPath,
    usernames: [...users.keys()],
    username: firstUser.username,
    userId: firstUser.userId,
    password: `sentinel-pw-${id}`,
    close: () => new Promise((done) => server.close(() => done())),
    /** 服务端观测：所有断言的事实来源。 */
    state: async () => {
      const response = await fetch(`${siteOrigin}/api/matrix/state`);
      return response.json();
    },
    events: () => allEvents.map((event) => ({ ...event })),
    resetEvents: () => { allEvents.length = 0; },
  };
}

/** 一次性起多个站点；失败时保证已经起来的都被关掉。 */
export async function startMatrixSites(specs) {
  const started = [];
  try {
    for (const spec of specs) started.push(await startMatrixSite(spec));
    return started;
  } catch (error) {
    await Promise.all(started.map((site) => site.close().catch(() => {})));
    throw error;
  }
}

/** 打一个 CONNECT + 转发代理，用来证明「账号走的是自己那条出口」。 */
export async function startTaggedProxy(tag) {
  const { request: httpRequest } = await import('node:http');
  const { connect: netConnect } = await import('node:net');
  const server = createServer((req, res) => {
    let target;
    try { target = new URL(req.url); } catch {
      res.writeHead(400);
      return res.end('bad request');
    }
    const upstream = httpRequest({
      hostname: target.hostname,
      port: target.port || 80,
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers: { ...req.headers, host: target.host, 'x-matrix-proxy': tag },
    }, (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode ?? 502, { ...upstreamResponse.headers, 'x-matrix-proxy': tag });
      upstreamResponse.pipe(res);
    });
    upstream.on('error', (error) => {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(String(error));
    });
    req.pipe(upstream);
  });
  // 探活用的 HTTPS 走 CONNECT；矩阵只用明文 HTTP，但保留以免误报。
  server.on('connect', (req, clientSocket, head) => {
    const [host, rawPort] = (req.url ?? '').split(':');
    const upstream = netConnect(Number(rawPort) || 443, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return {
    tag,
    host: '127.0.0.1',
    port: server.address().port,
    close: () => new Promise((done) => server.close(() => done())),
  };
}
